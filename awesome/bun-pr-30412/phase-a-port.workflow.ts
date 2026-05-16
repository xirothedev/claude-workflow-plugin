/**
 * phase-a-port — Phase A: draft .rs for a batch of .zig files.
 *
 * Faithful TypeScript port of Bun PR #30412's `phase-a-port.workflow.js`.
 * 3-stage pipeline: Implement -> Verify -> Fix. Each stage runs its batch in
 * parallel; data flows from one stage to the next.
 */
import type { JsonSchema, WorkflowMeta, WorkflowRuntime } from "./runtime.ts";

export const meta: WorkflowMeta = {
  name: "phase-a-port",
  description: "Phase A: draft .rs for a batch of .zig files (implement -> verify -> fix)",
  phases: [
    { title: "Implement", detail: "one agent per .zig writes draft .rs per PORTING.md" },
    { title: "Verify", detail: "adversarial check of .rs against .zig + PORTING.md rules" },
    { title: "Fix", detail: "apply verifier findings to .rs" },
  ],
};

// --- args / result shapes -------------------------------------------------

interface ZigFileArg {
  zig: string;
  loc: number;
}

interface BatchFile extends ZigFileArg {
  /** Deterministic destination .rs path (computed, never agent-chosen). */
  rs: string;
}

interface ImplResult {
  rs_path: string;
  confidence: "high" | "medium" | "low";
  todos: number;
  rs_loc: number;
  skipped?: boolean;
  note?: string;
}

interface VerifyIssue {
  rule: string;
  detail: string;
  fix?: string;
  severity: "must-fix" | "should-fix" | "nit";
}

interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
}

interface FixResult {
  applied: number;
  remaining: number;
  note?: string;
}

/** Value carried out of the Verify stage into the Fix stage. */
interface VerifyCarry extends Partial<VerifyResult> {
  _impl: ImplResult | null;
  _skip?: boolean;
}

// --- schemas --------------------------------------------------------------

const IMPL_SCHEMA: JsonSchema = {
  type: "object",
  required: ["rs_path", "confidence", "todos", "rs_loc"],
  properties: {
    rs_path: { type: "string", description: "absolute path of the .rs file you wrote" },
    confidence: { enum: ["high", "medium", "low"] },
    todos: { type: "integer" },
    rs_loc: { type: "integer" },
    skipped: { type: "boolean", description: "true only if file is generated and you wrote a 3-line stub" },
    note: { type: "string", description: "one line for Phase B, same as trailer notes" },
  },
};

const VERIFY_SCHEMA: JsonSchema = {
  type: "object",
  required: ["ok", "issues"],
  properties: {
    ok: { type: "boolean", description: "true if no MUST-FIX issues found" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["rule", "detail", "severity"],
        properties: {
          rule: { type: "string", description: 'PORTING.md section or rule violated, e.g. "Idiom map: @intCast"' },
          detail: { type: "string", description: "what is wrong and where (fn name or approx line)" },
          fix: { type: "string", description: "exact correction to apply" },
          severity: { enum: ["must-fix", "should-fix", "nit"] },
        },
      },
    },
  },
};

const FIX_SCHEMA: JsonSchema = {
  type: "object",
  required: ["applied", "remaining"],
  properties: {
    applied: { type: "integer" },
    remaining: { type: "integer", description: "must-fix issues you could not resolve" },
    note: { type: "string" },
  },
};

export async function execute(rt: WorkflowRuntime): Promise<unknown> {
  const { args, agent, pipeline, log } = rt;

  const REPO = (args.repo as string) || "/root/bun-5";
  const GUIDE = `${REPO}/docs/PORTING.md`;

  // Deterministic rs path (PORTING.md ground rules) — do NOT let agents pick.
  function rsPathFor(zig: string): string {
    const parts = zig.split("/");
    const file = parts.pop() as string;
    const base = file.replace(/\.zig$/, "");
    const parent = parts[parts.length - 1];
    const area = parts[1];
    if (parts.length === 2 && base === area) return [...parts, "lib.rs"].join("/");
    if (base === parent) return [...parts, "mod.rs"].join("/");
    return [...parts, base + ".rs"].join("/");
  }

  const FILES: BatchFile[] = ((args.files as ZigFileArg[]) || []).map((f) => ({ ...f, rs: rsPathFor(f.zig) }));

  if (FILES.length === 0) return { error: "no files in args.files" };
  log(`batch: ${FILES.length} files, ${FILES.reduce((a, f) => a + f.loc, 0)} zig LOC total`);

  // (prompt condensed from original — verbose prose trimmed, every load-bearing
  //  instruction and the chunked-write protocol preserved.)
  const implementPrompt = (f: BatchFile): string =>
    `
You are a Phase-A porting agent. Your ONLY job: translate one Zig file to a draft Rust file.

1. Read ${GUIDE} — the porting guide. Read the WHOLE file. Every rule is load-bearing.
2. Run: \`grep "^${f.zig}\\b" ${REPO}/docs/LIFETIMES.tsv\` — pre-classified Rust types for every *T/?*T struct field (cols: file, struct, field, zig_type, class, rust_type, evidence). Use the rust_type column verbatim. No rows -> no pointer struct fields.
3. Read ${REPO}/${f.zig} (${f.loc} lines).${f.loc > 1800 ? ` This may exceed Read's default — Read in segments (offset/limit) to get the WHOLE file.` : ""}
4. Write the .rs to EXACTLY this path: ${REPO}/${f.rs}
   (Do not pick a different path. Do not "follow" re-exports to another file.)${
     f.loc > 1000
       ? `
   **CHUNKED WRITE — HARD REQUIREMENT** (${f.loc}-LOC source). The harness kills any tool call emitting >180s of tokens. Write in chunks of <=800 lines: first Write the first ~800 lines (stop at a fn/impl boundary); then loop Edit with old_string = the EXACT last 2 lines you just wrote, new_string = those 2 lines + the next ~800 lines. Final chunk includes the PORT STATUS trailer. NEVER emit more than ~800 lines in one Write/Edit.`
       : ""
   }
5. Match structure, fn names (snake_case), field order, control flow. End with the PORT STATUS trailer.
6. Return structured output with rs_path set to that exact path.

If ${f.zig} is a thin re-export (\`pub const X = @import("./other.zig").X;\`), port it as a thin re-export (\`pub use ...::X;\`). Do NOT inline the target's body.
Do NOT read other .zig files "for context". Do NOT run builds. Do NOT git anything.
If the file matches PORTING.md "Don't translate" generated-file list, write the 3-line stub and set skipped=true.
`.trim();

  // (prompt condensed from original)
  const verifyPrompt = (f: BatchFile, impl: ImplResult): string =>
    `
You are an adversarial Phase-A verifier. Find every place the draft .rs DEVIATES from PORTING.md.

1. Read ${GUIDE}.
2. Read ${REPO}/${f.zig} (source of truth for logic).
3. Read ${impl.rs_path} (the draft).

Check ONLY against PORTING.md rules. High-value targets:
- \`pub fn deinit(&mut self)\` instead of \`impl Drop\`
- \`comptime T: type\` ported as const generic instead of plain \`<T>\`
- \`&dyn Allocator\` outside AST crates, or \`bun_collections::List\` anywhere
- \`String\`/\`&str\`/\`from_utf8\`/\`.to_string()\` for data — must be \`Vec<u8>\`/\`&[u8]\`/\`Box<[u8]>\`
- \`[]const u8\` field as \`&[u8]\` when deinit frees it (should be \`Box<[u8]>\`)
- \`?*T\` field type contradicting docs/LIFETIMES.tsv
- \`errdefer x.deinit()\` on owned local kept (should be deleted)
- \`anyhow::Error\` / \`Box<dyn Error>\` (should be \`bun_core::Error\` NonZeroU16)
- \`ComptimeStringMap\` not ported to \`phf::phf_map!\` or match
- bare \`as\` for narrowing cast (must be \`T::try_from(x).unwrap()\`)
- Vec<JSValue>/JSValue stored in Box/Arc field
- std::collections::HashMap / std::fs / std::net / std::path / async fn / tokio
- missing \`// SAFETY:\` on unsafe blocks; *_jsc alias lines kept; dropped logic / missing fns vs the .zig

Do NOT flag: unresolved imports, lifetimes, things PORTING.md defers to Phase B.
Default to ok=false if you find ANY must-fix. Be specific.
If impl.skipped=true and the stub looks right, return ok=true, issues=[].
`.trim();

  // (prompt condensed from original)
  const fixPrompt = (f: BatchFile, impl: ImplResult, ver: { issues: VerifyIssue[] }): string =>
    `
You are a Phase-A fixer. Apply verifier findings to the draft .rs. Nothing else.

1. Read ${GUIDE} (skim — the rules the issues cite).
2. Read ${impl.rs_path}.
3. Read ${REPO}/${f.zig} ONLY if an issue says logic was dropped.
4. Apply each must-fix and should-fix below using Edit. Update the PORT STATUS trailer.

Issues (JSON):
${JSON.stringify(ver.issues, null, 2)}

Do NOT rewrite the whole file. Surgical edits only. If an issue is wrong, skip it and note in output.
`.trim();

  const results = await pipeline<BatchFile>(
    FILES,
    // -- Implement --
    (_input, f) =>
      agent<ImplResult>(implementPrompt(f), {
        label: `impl:${f.zig.replace(/^src\//, "")}`,
        phase: "Implement",
        schema: IMPL_SCHEMA,
      }),
    // -- Verify --
    (input, f) => {
      const impl = input as unknown as ImplResult | null;
      if (!impl) return { ok: false, issues: [], _impl: null, _skip: true } satisfies VerifyCarry;
      impl.rs_path = `${REPO}/${f.rs}`; // canonical, ignore what impl claimed
      return agent<VerifyResult>(verifyPrompt(f, impl), {
        label: `verify:${f.zig.replace(/^src\//, "")}`,
        phase: "Verify",
        schema: VERIFY_SCHEMA,
      }).then((v): VerifyCarry => ({ ...v, _impl: impl }));
    },
    // -- Fix --
    (input, f) => {
      const ver = input as unknown as VerifyCarry | null;
      const impl = ver && ver._impl;
      if (!impl) return { file: f.zig, status: "impl-failed" };
      if (ver && ver._skip) {
        return {
          file: f.zig,
          rs: impl.rs_path,
          status: "verify-skipped",
          confidence: impl.confidence,
          todos: impl.todos,
        };
      }
      const mustFix = (ver?.issues || []).filter((i) => i.severity !== "nit");
      if (mustFix.length === 0) {
        return {
          file: f.zig,
          rs: impl.rs_path,
          status: "clean",
          confidence: impl.confidence,
          todos: impl.todos,
          rs_loc: impl.rs_loc,
          skipped: !!impl.skipped,
        };
      }
      return agent<FixResult>(fixPrompt(f, impl, { issues: mustFix }), {
        label: `fix:${f.zig.replace(/^src\//, "")}`,
        phase: "Fix",
        schema: FIX_SCHEMA,
      }).then((fx) => ({
        file: f.zig,
        rs: impl.rs_path,
        status: "fixed",
        confidence: impl.confidence,
        todos: impl.todos,
        rs_loc: impl.rs_loc,
        issues_found: mustFix.length,
        applied: fx ? fx.applied : 0,
        remaining: fx ? fx.remaining : mustFix.length,
        skipped: !!impl.skipped,
      }));
    },
  );

  type Row = { status?: string; file?: string; confidence?: ImplResult["confidence"] };
  const rows = results as Row[];
  const ok = rows.filter((r) => r && (r.status === "clean" || r.status === "fixed"));
  const failed = rows.filter((r) => !r || r.status === "impl-failed");
  log(`done: ${ok.length}/${FILES.length} ok, ${failed.length} impl-failed`);

  return {
    total: FILES.length,
    clean: rows.filter((r) => r && r.status === "clean").length,
    fixed: rows.filter((r) => r && r.status === "fixed").length,
    failed: failed.map((r) => r && r.file).filter(Boolean),
    by_confidence: {
      high: ok.filter((r) => r.confidence === "high").length,
      medium: ok.filter((r) => r.confidence === "medium").length,
      low: ok.filter((r) => r.confidence === "low").length,
    },
    results,
  };
}
