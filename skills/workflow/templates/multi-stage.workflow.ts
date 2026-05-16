import type { JsonSchema, WorkflowContext, WorkflowMeta } from "./src/types.ts";

export const meta: WorkflowMeta = {
  name: "multi-stage",
  description: "Pipeline: implement → verify → fix",
  args_schema: {
    type: "object", required: ["items", "instruction"],
    properties: { items: { type: "array", items: { type: "string" } }, instruction: { type: "string" } },
  },
  phases: [{ title: "Implement", detail: "Draft output per item" }, { title: "Verify", detail: "Adversarial check" }, { title: "Fix", detail: "Apply fixes" }],
};

const S1: JsonSchema = { type: "object", required: ["item", "output", "confidence"], properties: { item: { type: "string" }, output: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] } } };
const S2: JsonSchema = { type: "object", required: ["ok", "issues"], properties: { ok: { type: "boolean" }, issues: { type: "array", items: { type: "object", required: ["severity", "detail"], properties: { severity: { type: "string", enum: ["must-fix", "should-fix", "nit"] }, detail: { type: "string" }, fix: { type: "string" } } } } } };
const S3: JsonSchema = { type: "object", required: ["applied", "remaining"], properties: { applied: { type: "integer" }, remaining: { type: "integer" } } };

export function execute({ args, agent, multiPipeline, phase, log }: WorkflowContext) {
  const { items, instruction } = args as { items: string[]; instruction: string };
  if (!items.length) return { error: "no items" };
  log(`multi-stage: ${items.length} items`);
  phase("Implement"); phase("Verify"); phase("Fix");
  multiPipeline(items,
    (item) => agent(`${instruction}\n\nItem: ${item}\n\nReturn ONLY valid JSON:\n${JSON.stringify(S1, null, 2)}`, { label: `impl:${item}`, phase: "Implement", schema: S1 }),
    (r) => agent(`Verify:\n${JSON.stringify(r)}\n\nReturn ONLY valid JSON:\n${JSON.stringify(S2, null, 2)}`, { label: "verify", phase: "Verify", schema: S2 }),
    (v) => agent(`Fix:\n${JSON.stringify(v)}\n\nReturn ONLY valid JSON:\n${JSON.stringify(S3, null, 2)}`, { label: "fix", phase: "Fix", schema: S3 }),
  );
  return { total: items.length };
}
