import type { JsonSchema, WorkflowContext, WorkflowMeta } from "./src/types.ts";

export const meta: WorkflowMeta = {
  name: "parallel-swarm",
  description: "N agents parallel + aggregate",
  args_schema: {
    type: "object", required: ["items", "instruction"],
    properties: { items: { type: "array", items: { type: "string" } }, instruction: { type: "string" } },
  },
  phases: [{ title: "Swarm", detail: "Parallel agents" }, { title: "Aggregate", detail: "Summarize" }],
};

const ITEM: JsonSchema = { type: "object", required: ["item", "status"], properties: { item: { type: "string" }, status: { type: "string", enum: ["ok", "warning", "error"] }, findings: { type: "array", items: { type: "string" } } } };
const AGG: JsonSchema = { type: "object", required: ["total", "summary"], properties: { total: { type: "integer" }, summary: { type: "string" }, actions: { type: "array", items: { type: "string" } } } };

export function execute({ args, agent, pipeline, phase, log }: WorkflowContext) {
  const { items, instruction } = args as { items: string[]; instruction: string };
  if (!items.length) return { error: "no items" };
  log(`parallel-swarm: ${items.length} items`);
  phase("Swarm");
  pipeline(items, (item: string) => agent(`${instruction}\n\nItem: ${item}\n\nReturn ONLY valid JSON:\n${JSON.stringify(ITEM, null, 2)}`, { label: `swarm:${item}`, phase: "Swarm", schema: ITEM }));
  phase("Aggregate");
  agent(`Summarize ${items.length} results.\n\nReturn ONLY valid JSON:\n${JSON.stringify(AGG, null, 2)}`, { label: "aggregate", phase: "Aggregate", schema: AGG });
  return { total: items.length };
}
