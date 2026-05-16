/**
 * phase-d-todo-sweep — sweep todo!()/unimplemented!() to real implementations.
 *
 * Faithful TypeScript port of Bun PR #30412's `phase-d-todo-sweep.workflow.js`.
 *
 * Orchestration pattern: ROUND-LOOP with an inner VERIFY-UNTIL-DRY sub-loop.
 *   for round 1..MAX:
 *     Survey  -> one agent greps every todo!() site, groups by file
 *     pipeline over files:
 *       Implement -> port real bodies from .zig spec
 *       Verify    -> 2-vote adversarial, looped up to 3x until no NEW bugs
 *       Bugfix    -> apply the deduped bug list
 *   exit early the first round Survey reports 0 todo!() left.
 *
 * The `seen` map biases each round toward files not yet visited (fair sharding
 * across rounds); the inner verify loop dedups bugs by `fn::what` so the
 * 2-vote pass keeps running only while it finds *something new*.
 */
import type { JsonSchema, WorkflowMeta, WorkflowRuntime } from "./runtime.ts";

export const meta: WorkflowMeta = {
  name: "phase-d-todo-sweep",
  description:
    "Find all todo!()/unimplemented!() -> group by file -> implement from .zig -> 2-vote verify-until-dry -> bugfix",
  phases: [
    { title: "Survey", detail: "grep all todo!() -> group by file" },
    { title: "Implement", detail: "port each todo!() body from .zig spec" },
    { title: "Verify", detail: "2-vote spec check, loop until no new bugs" },
    { title: "Bugfix", detail: "apply verified bugs" },
  ],
};

interface TodoSite {
  line: number;
  msg?: string;
  fn?: string;
}

interface TodoFile {
  file: string;
  n: number;
  sites: TodoSite[];
}

interface SurveyResult {
  files: TodoFile[];
  total: number;
}

interface ImplResult {
  file: string;
  before?: number;
  after: number;
  fns_implemented: string[];
  files_touched?: string[];
  notes?: string;
}

interface Bug {
  fn: string;
  what: string;
  fix: string;
  severity?: string;
}

interface VerifyResult {
  file: string;
  bugs: Bug[];
}

interface BugfixResult {
  file: string;
  applied: number;
  notes?: string;
}

/** Value carried out of the Verify stage into the Bugfix stage. */
interface VerifyCarry {
  file: string;
  impl: ImplResult | null;
  bugs: Bug[];
}

const SURVEY_S: JsonSchema = {
  type: "object",
  required: ["files", "total"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "n", "sites"],
        properties: {
          file: { type: "string" },
          n: { type: "number" },
          sites: {
            type: "array",
            items: {
              type: "object",
              required: ["line"],
              properties: { line: { type: "number" }, msg: { type: "string" }, fn: { type: "string" } },
            },
          },
        },
      },
    },
    total: { type: "number" },
  },
};

const IMPL_S: JsonSchema = {
  type: "object",
  required: ["file", "after", "fns_implemented"],
  properties: {
    file: { type: "string" },
    before: { type: "number" },
    after: { type: "number" },
    fns_implemented: { type: "array", items: { type: "string" } },
    files_touched: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

const VERIFY_S: JsonSchema = {
  type: "object",
  required: ["file", "bugs"],
  properties: {
    file: { type: "string" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["fn", "what", "fix"],
        properties: {
          fn: { type: "string" },
          what: { type: "string" },
          fix: { type: "string" },
          severity: { type: "string" },
        },
      },
    },
  },
};

const BUGFIX_S: JsonSchema = {
  type: "object",
  required: ["file", "applied"],
  properties: { file: { type: "string" }, applied: { type: "number" }, notes: { type: "string" } },
};

const HARD = `**HARD RULES:** Never #[cfg(any())]/todo!()/unimplemented!() — port REAL bodies from .zig. Never git reset/checkout/restore/stash. Never edit .zig. DO NOT run cargo. **Commit only (NO push, NO pull):** \`git -c core.hooksPath=/dev/null add -A "src/" && git -c core.hooksPath=/dev/null commit -q -m "phase-d: <what>"\` — orchestrator pushes.`;

export async function execute(rt: WorkflowRuntime): Promise<unknown> {
  const { args, agent, pipeline, parallel, phase, log } = rt;

  const MAX_ROUNDS = (args.max_rounds as number) || 6;
  const MAX_FILES = (args.max_files as number) || 250;
  const PREFIX_RE = (args.prefix as string) || ""; // shard regex e.g. "src/runtime/"

  const history: unknown[] = [];
  const seen: Record<string, number> = {};

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase("Survey");
    // (prompt condensed from original)
    const survey = await agent<SurveyResult>(
      `Survey all todo!()/unimplemented!() sites. Repo /root/bun-5. DO NOT edit.

\`grep -rn 'todo!(\\|unimplemented!(' src/ --include='*.rs'\` -> for each match capture file:line + the message string (if any). Find the enclosing fn name (look upward for \`fn <name>\` / \`pub fn <name>\`).

**SHARD FILTER:** Only include files whose path matches regex \`^(${PREFIX_RE || ".*"})\`.

Group by file. Return {files:[{file, n, sites:[{line, msg, fn}]}], total}. Skip src/bun_bin/phase_c_exports.rs.`,
      { label: `survey-r${round}`, phase: "Survey", schema: SURVEY_S },
    );

    if (!survey || survey.total === 0) {
      log(`round ${round}: 0 todo!() remaining`);
      return { rounds: round, done: true, history };
    }

    const re = PREFIX_RE ? new RegExp("^(" + PREFIX_RE + ")") : null;
    const files = survey.files
      .filter((f) => f.n > 0 && !f.file.includes("phase_c_exports") && (!re || re.test(f.file)))
      .sort((a, b) => {
        const sa = seen[a.file] || 0;
        const sb = seen[b.file] || 0;
        if (sa !== sb) return sa - sb;
        return b.n - a.n;
      })
      .slice(0, MAX_FILES);
    for (const f of files) seen[f.file] = (seen[f.file] || 0) + 1;

    log(`round ${round}: ${survey.total} todo!() across ${files.length} files`);

    const results = await pipeline<TodoFile>(
      files,
      // Stage 1: implement
      (_input, f) => {
        const sitesText = f.sites
          .map((s) => `  L${s.line} ${s.fn ? `(${s.fn})` : ""}: ${s.msg || "(bare)"}`)
          .join("\n");
        // (prompt condensed from original)
        return agent<ImplResult>(
          `Implement ALL ${f.n} todo!()/unimplemented!() in ONE file by porting from .zig spec. Repo /root/bun-5 @ HEAD.

**File:** ${f.file}
**Spec:** \`${f.file.replace(/\.rs$/, ".zig")}\` (or nearest .zig — grep for the fn name)
**Sites:**
${sitesText}
${seen[f.file] > 1 ? `**Seen ${seen[f.file]}x — likely missing upstream symbol or hard port.**` : ""}

**Process:**
1. For each site: find the fn in the .zig spec (same path, or grep src/**/*.zig for fn name).
2. Port the REAL body. Adapt API per docs/PORTING.md (idiom map, §Forbidden patterns).
3. **Missing upstream symbol** (the \`blocked_on:\` pattern): GO ADD that symbol to its crate. If it's a dep-cycle: MOVE the code to the right crate.
4. **codegen todo!()**: implement the proc-macro output or hand-write what it would emit.
5. After: \`grep -c 'todo!(\\|unimplemented!(' ${f.file}\` -> target 0. Commit.

${HARD}

Return {file, before:${f.n}, after:N, fns_implemented:[...], files_touched:[...], notes}.`,
          { label: `impl:${f.file.split("/").slice(-2).join("/")}`, phase: "Implement", schema: IMPL_S },
        );
      },
      // Stage 2: verify-until-dry (2-vote, re-run if new bugs found, max 3 iterations)
      async (input, f) => {
        const impl = input as unknown as ImplResult | null;
        if (!impl || (impl.fns_implemented || []).length === 0) {
          return { file: f.file, impl: null, bugs: [] } satisfies VerifyCarry;
        }
        const allBugs: Bug[] = [];
        const known: Record<string, number> = {};
        for (let iter = 0; iter < 3; iter++) {
          const fnList = (impl.fns_implemented || []).slice(0, 40).join(", ");
          const fnExtra =
            (impl.fns_implemented || []).length > 40 ? ` (+${impl.fns_implemented.length - 40})` : "";
          const votes = await parallel<VerifyResult>(
            [0, 1].map(
              (i) => () =>
                // (prompt condensed from original)
                agent<VerifyResult>(
                  `Adversarially verify ${f.file} against .zig spec. Repo /root/bun-5 @ HEAD.

Implemented fns: ${fnList}${fnExtra}. Read each in .rs + .zig spec at same path. Find: spec divergences (logic-bug), silent-no-ops, aliased-&mut, transmute-to-enum, mem::forget/Box::leak for &'static, missing match arms, ptr::read of Drop type, wrong-discriminant. Check docs/PORTING.md §Forbidden.
${allBugs.length > 0 ? `\nPrior iteration found ${allBugs.length} bugs (already known). Find DIFFERENT ones.` : ""}

DEFAULT TO refuted — cite .zig:line + .rs:line + observable divergence. DO NOT edit. DO NOT run cargo.

Return {file, bugs:[{fn, what, fix, severity}]}.`,
                  {
                    label: `verify${iter}.${i}:${f.file.split("/").pop()}`,
                    phase: "Verify",
                    schema: VERIFY_S,
                  },
                ),
            ),
          );
          const fresh = (votes || []).filter(Boolean).flatMap((v) => v.bugs || []);
          let newCount = 0;
          for (const b of fresh) {
            const k = `${b.fn}::${(b.what || "").slice(0, 80)}`;
            if (!known[k]) {
              known[k] = 1;
              allBugs.push(b);
              newCount++;
            }
          }
          if (newCount === 0) break;
        }
        return { file: f.file, impl, bugs: allBugs } satisfies VerifyCarry;
      },
      // Stage 3: bugfix
      (input) => {
        const vr = input as unknown as VerifyCarry | null;
        if (!(vr && vr.bugs && vr.bugs.length > 0)) return vr;
        const bugList = vr.bugs
          .map((b, i) => `${i + 1}. **${b.fn}** (${b.severity || "logic-bug"}): ${b.what}\n   FIX: ${b.fix}`)
          .join("\n");
        // (prompt condensed from original)
        return agent<BugfixResult>(
          `Apply verified bugs to ${vr.file}. Repo /root/bun-5 @ HEAD.

Verified bugs (2-vote-until-dry against .zig):
${bugList}

Apply each. Read .zig spec to confirm. Edit ${vr.file} (and upstream if a fix requires it). Commit. DO NOT run cargo.

${HARD}

Return {file, applied:N, notes}.`,
          { label: `bugfix:${vr.file.split("/").pop()}`, phase: "Bugfix", schema: BUGFIX_S },
        ).then((bf) => ({ ...vr, bugfix: bf }));
      },
    );

    type Row = { impl?: ImplResult | null; bugs?: Bug[] };
    const rows = results as Row[];
    const after = rows.reduce((s, r) => s + ((r && r.impl && r.impl.after) || 0), 0);
    const bugs = rows.reduce((s, r) => s + ((r && r.bugs && r.bugs.length) || 0), 0);
    history.push({ round, total: survey.total, files: files.length, todos_after: after, bugs_found: bugs });
  }

  return { rounds: MAX_ROUNDS, done: false, history };
}
