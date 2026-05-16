import type { AgentCall, AgentOpts, JsonSchema, PhaseStatus, ValidationResult, WorkflowContext, WorkflowModule, WorkflowPlan } from "./types.ts";
import { validate as schemaValidate } from "./validator.ts";

let agentCounter = 0;
const agents: AgentCall[] = [];
const phaseOrder: PhaseStatus[] = [];
const stages: string[][] = [];
let currentStage: string[] = [];

function resetState(): void {
  agentCounter = 0;
  agents.length = 0;
  phaseOrder.length = 0;
  stages.length = 0;
  currentStage = [];
}

function agent(prompt: string, opts: AgentOpts): AgentCall {
  const id = `agent_${++agentCounter}`;
  const call: AgentCall = { id, label: opts.label, phase: opts.phase, prompt, schema: opts.schema, agentType: opts.agentType, dependsOn: [] };
  agents.push(call);
  currentStage.push(id);
  return call;
}

function pipeline<T, R>(items: T[], stage: (item: T, index: number) => R | R[]): R[] {
  if (currentStage.length > 0) { stages.push([...currentStage]); currentStage = []; }
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = stage(items[i], i);
    if (Array.isArray(r)) results.push(...r); else results.push(r);
  }
  if (currentStage.length > 0) { stages.push([...currentStage]); currentStage = []; }
  return results;
}

function multiPipeline<T>(items: T[], ...stages_: ((item: unknown, original: T) => unknown)[]): unknown[] {
  let current: unknown[] = items as unknown[];
  for (const stage of stages_) {
    if (currentStage.length > 0) { stages.push([...currentStage]); currentStage = []; }
    const next: unknown[] = [];
    for (let i = 0; i < current.length; i++) { const r = stage(current[i], items[i]); if (r != null) next.push(r); }
    current = next;
    if (currentStage.length > 0) { stages.push([...currentStage]); currentStage = []; }
  }
  return current;
}

function phase(title: string): void { phaseOrder.push({ title, status: "pending", agents: [] }); }
function log(message: string): void { console.log(`[${new Date().toISOString()}] ${message}`); }
function validate(value: unknown, schema: JsonSchema): ValidationResult { return schemaValidate(value, schema); }

export function buildPlan(mod: WorkflowModule, args: Record<string, unknown>): WorkflowPlan {
  resetState();
  if (mod.meta.args_schema) {
    const r = schemaValidate(args, mod.meta.args_schema);
    if (!r.ok) throw new Error(`Invalid args: ${r.errors?.join("; ")}`);
  }
  mod.execute({ args, agent, pipeline, multiPipeline, phase, log, validate });
  if (currentStage.length > 0) stages.push([...currentStage]);
  for (const p of phaseOrder) p.agents = agents.filter((a) => a.phase === p.title).map((a) => a.id);
  for (let i = 1; i < stages.length; i++)
    for (const id of stages[i]) { const c = agents.find((a) => a.id === id); if (c) c.dependsOn = stages[i - 1]; }
  // Return copies — `agents`/`phaseOrder`/`stages` are module-level and reset on
  // the next buildPlan call, which would otherwise corrupt a held-onto plan.
  return { workflow: mod.meta.name, args, phases: [...phaseOrder], agents: [...agents], stages: stages.map((s) => [...s]) };
}

export function formatPlan(plan: WorkflowPlan): string {
  const lines: string[] = [`# Workflow Plan: ${plan.workflow}`, ``, `## Args`, "```json", JSON.stringify(plan.args, null, 2), "```", ``, `## Phases`];
  for (const p of plan.phases) lines.push(`- **${p.title}** (${p.agents.length} agents)`);
  lines.push(``, `## Execution Stages`);
  for (let i = 0; i < plan.stages.length; i++) {
    lines.push(`### Stage ${i + 1} (parallel)`);
    for (const id of plan.stages[i]) { const a = plan.agents.find((ag) => ag.id === id); lines.push(`  - ${a ? `${a.id} (${a.label})` : id}`); }
  }
  lines.push(``, `## Agent Details`);
  for (const a of plan.agents) {
    lines.push(`### ${a.id}: ${a.label}`, `- Phase: ${a.phase}`, `- Depends: ${a.dependsOn?.join(", ") || "none"}`, `- Schema:`, "```json", JSON.stringify(a.schema, null, 2), "```", `- Prompt:`, "```", a.prompt, "```", ``);
  }
  return lines.join("\n");
}

export async function loadWorkflow(path: string): Promise<WorkflowModule> {
  const mod = await import(path);
  if (!mod.meta) throw new Error(`No 'meta' export in ${path}`);
  if (!mod.execute && !mod.default) throw new Error(`No 'execute' or default export in ${path}`);
  return { meta: mod.meta, execute: mod.execute || mod.default };
}
