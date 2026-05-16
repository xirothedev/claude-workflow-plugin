import type { JsonSchema, WorkflowContext, WorkflowMeta } from "./src/types.ts";

export const meta: WorkflowMeta = {
  name: "single-agent",
  description: "One agent, schema-validated output",
  args_schema: {
    type: "object", required: ["task"],
    properties: { task: { type: "string", description: "What the agent does" }, target: { type: "string" } },
  },
  phases: [{ title: "Execute", detail: "Agent performs the task" }, { title: "Validate", detail: "Validate output" }],
};

const SCHEMA: JsonSchema = {
  type: "object", required: ["summary"],
  properties: { summary: { type: "string" }, items: { type: "array", items: { type: "object", required: ["name", "status"], properties: { name: { type: "string" }, status: { type: "string", enum: ["ok", "warning", "error"] }, detail: { type: "string" } } } } },
};

export function execute({ args, agent, phase, log }: WorkflowContext) {
  const { task, target } = args as { task: string; target?: string };
  log(`single-agent: ${task}`);
  phase("Execute");
  agent(`${task}${target ? `\n\nFocus on: ${target}` : ""}\n\nReturn ONLY valid JSON:\n${JSON.stringify(SCHEMA, null, 2)}`, { label: task.substring(0, 40), phase: "Execute", schema: SCHEMA });
  phase("Validate");
  return { ok: true };
}
