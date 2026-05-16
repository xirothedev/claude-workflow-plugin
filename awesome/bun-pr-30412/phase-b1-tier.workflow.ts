/**
 * phase-b1-tier — per-crate `cargo check` gate-and-stub loop.
 *
 * Faithful TypeScript port of Bun PR #30412's `phase-b1-tier.workflow.js`.
 * Single-stage parallel fan-out: one agent per crate, each runs its own
 * internal `cargo check -> fix -> repeat` loop (up to 25 rounds) inside the
 * agent. The workflow itself just spawns the swarm and aggregates.
 */
import type { JsonSchema, WorkflowMeta, WorkflowRuntime } from "./runtime.ts";

export const meta: WorkflowMeta = {
  name: "phase-b1-tier",
  description: "Per-crate cargo check loop: gate-and-stub until green (one tier at a time)",
  phases: [{ title: "Check", detail: "one agent per crate: cargo check -> fix -> repeat" }],
};

interface CrateArg {
  name: string;
  tier: number;
}

interface CheckResult {
  compiles: boolean;
  error_count: number;
  rounds: number;
  gated_modules?: string[];
  notes?: string;
}

interface CrateResult extends CheckResult {
  crate: string;
  tier: number;
}

const SCHEMA: JsonSchema = {
  type: "object",
  required: ["compiles", "error_count", "rounds"],
  properties: {
    compiles: { type: "boolean" },
    error_count: { type: "integer" },
    rounds: { type: "integer" },
    gated_modules: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

export async function execute(rt: WorkflowRuntime): Promise<unknown> {
  const { args, agent, pipeline, phase, log } = rt;

  const REPO = "/root/bun-5";
  const CRATES = (args.crates as CrateArg[]) || [];
  if (!CRATES.length) return { error: "no crates" };
  log(`B-1 tier ${CRATES[0].tier}: ${CRATES.length} crates`);

  phase("Check");

  const results = (await pipeline<CrateArg>(CRATES, (_input, c) => {
    const bare = c.name.replace(/^bun_/, "");
    // (prompt condensed from original — full gate-and-stub loop preserved.)
    return agent<CheckResult>(
      `Get crate **bun_${bare}** to \`cargo check\` green via gate-and-stub.

**Approach (same as tier-0/1):** preserve Phase-A draft bodies; gate modules that don't compile behind \`#[cfg(any())]\`, expose minimal stub surface (types as opaque newtypes, fns as \`todo!()\`). Un-gating happens in B-2.

**Loop (cap 25 rounds):**
1. \`cd ${REPO} && cargo check -p bun_${bare} 2>&1 | head -200\`
2. If 0 errors -> done.
3. Read errors. Fix patterns:
   - E0432/E0433 unresolved \`bun_X::Y\` -> if X is lower-tier, the symbol is missing from X's stub surface — add a local \`type Y = ();\` or \`// TODO(b1): bun_X::Y missing\` and gate the using code. Do NOT edit X's crate.
   - E0658 nightly feature -> rewrite to stable (inherent assoc type -> regular impl; const generic struct param -> enum/&'static str)
   - E0599/E0277/E0308 in a Phase-A draft fn body -> gate the whole fn body with \`#[cfg(any())] { ... }\` and add \`todo!()\` else-arm, OR gate the whole module in lib.rs.
   - mod path errors in lib.rs -> fix \`pub mod X;\` to match actual filenames.
4. Edit ONLY \`${REPO}/src/${c.name}/\`. Goto 1.

**HARD RULES:** never \`git\`, never edit other crates, never touch \`.zig\`, never delete .rs files, never create new .rs files (only edit existing + lib.rs).

Return structured.`,
      { label: `b1:${c.name}`, phase: "Check", schema: SCHEMA },
    ).then(
      (r): CrateResult => ({
        crate: c.name,
        tier: c.tier,
        ...(r || { compiles: false, error_count: -1, rounds: 0, notes: "agent-null" }),
      }),
    );
  })) as CrateResult[];

  return {
    tier: CRATES[0].tier,
    total: CRATES.length,
    green: results.filter((r) => r.compiles).map((r) => r.crate),
    failing: results
      .filter((r) => !r.compiles)
      .map((r) => ({ crate: r.crate, error_count: r.error_count, notes: r.notes })),
    results,
  };
}
