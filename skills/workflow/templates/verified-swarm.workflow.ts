import type { JsonSchema, WorkflowContext, WorkflowMeta } from "../src/types.ts";

/**
 * verified-swarm — parallel implement + adversarial multi-vote verify + conditional fix.
 *
 * Bun PR #30412 correctness mechanism: under pressure to "make it pass", a single
 * agent tends to suppress errors rather than fix them. Three independent reviewers
 * voting per item catch that. Fix runs ONLY when >=2 of 3 votes reject (majority
 * rule) — a static plan registers every Fix agent up front; Claude Code skips the
 * Fix agents whose item the vote accepted.
 */
export const meta: WorkflowMeta = {
  name: "verified-swarm",
  description: "Parallel implement + 3-vote adversarial verify + conditional fix",
  args_schema: {
    type: "object", required: ["items", "instruction"],
    properties: { items: { type: "array", items: { type: "string" } }, instruction: { type: "string" } },
  },
  phases: [
    { title: "Implement", detail: "Draft output per item in parallel" },
    { title: "Verify", detail: "3 independent reviewers vote per item" },
    { title: "Fix", detail: "Apply fixes — only for items the majority vote rejected" },
    { title: "Aggregate", detail: "Summarize accepted vs fixed" },
  ],
};

const IMPL: JsonSchema = { type: "object", required: ["item", "output"], properties: { item: { type: "string" }, output: { type: "string" }, notes: { type: "array", items: { type: "string" } } } };
const VOTE: JsonSchema = { type: "object", required: ["accept", "reason"], properties: { accept: { type: "boolean" }, reason: { type: "string" }, severity: { type: "string", enum: ["must-fix", "should-fix", "nit"] } } };
const FIX: JsonSchema = { type: "object", required: ["item", "applied"], properties: { item: { type: "string" }, applied: { type: "integer" }, remaining: { type: "integer" } } };
const AGG: JsonSchema = { type: "object", required: ["total", "summary"], properties: { total: { type: "integer" }, accepted: { type: "integer" }, fixed: { type: "integer" }, summary: { type: "string" } } };

/** Independent reviewers per item. Odd count so majority is unambiguous. */
const VOTES = 3;

export function execute({ args, agent, pipeline, phase, log }: WorkflowContext) {
  const { items, instruction } = args as { items: string[]; instruction: string };
  if (!items.length) return { error: "no items" };
  log(`verified-swarm: ${items.length} items, ${VOTES}-vote verify`);

  phase("Implement");
  pipeline(items, (item: string) =>
    agent(`${instruction}\n\nItem: ${item}\n\nReturn ONLY valid JSON:\n${JSON.stringify(IMPL, null, 2)}`,
      { label: `impl:${item}`, phase: "Implement", schema: IMPL }));

  phase("Verify");
  pipeline(items, (item: string) =>
    Array.from({ length: VOTES }, (_, v) =>
      agent(`Independently review the implementation for "${item}". Vote accept/reject. REJECT if the work suppresses errors (early return, broad catch, #[allow], null-skip) instead of solving the problem.\n\nReturn ONLY valid JSON:\n${JSON.stringify(VOTE, null, 2)}`,
        { label: `verify:${item}#${v + 1}`, phase: "Verify", schema: VOTE })));

  phase("Fix");
  pipeline(items, (item: string) =>
    agent(`Apply fixes for "${item}". RUN THIS AGENT ONLY IF >=2 of ${VOTES} verify votes rejected the item (majority rule); otherwise skip it.\n\nReturn ONLY valid JSON:\n${JSON.stringify(FIX, null, 2)}`,
      { label: `fix:${item}`, phase: "Fix", schema: FIX }));

  phase("Aggregate");
  agent(`Summarize ${items.length} items: how many were accepted by vote, how many needed fixing.\n\nReturn ONLY valid JSON:\n${JSON.stringify(AGG, null, 2)}`,
    { label: "aggregate", phase: "Aggregate", schema: AGG });

  return { total: items.length, votesPerItem: VOTES };
}
