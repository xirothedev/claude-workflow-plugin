export type JsonSchema =
  | { type: "object"; required?: string[]; properties?: Record<string, JsonSchema>; additionalProperties?: boolean }
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "integer"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchema; description?: string }
  | { oneOf: JsonSchema[] }
  | { anyOf: JsonSchema[] };

export interface Phase { title: string; detail: string }

export interface WorkflowMeta {
  name: string;
  description: string;
  args_schema?: JsonSchema & { type: "object" };
  phases: Phase[];
}

export interface AgentOpts {
  label: string;
  phase: string;
  schema: JsonSchema;
  agentType?: string;
}

export interface ValidationResult {
  ok: boolean;
  value?: unknown;
  errors?: string[];
}

export interface AgentCall {
  id: string;
  label: string;
  phase: string;
  prompt: string;
  schema: JsonSchema;
  agentType?: string;
  dependsOn?: string[];
}

export interface PhaseStatus {
  title: string;
  status: "pending" | "running" | "done";
  agents: string[];
}

export interface WorkflowPlan {
  workflow: string;
  args: Record<string, unknown>;
  phases: PhaseStatus[];
  agents: AgentCall[];
  stages: string[][];
}

export interface WorkflowContext {
  args: Record<string, unknown>;
  agent: (prompt: string, opts: AgentOpts) => AgentCall;
  pipeline: <T, R>(items: T[], stage: (item: T, index: number) => R | R[]) => R[];
  multiPipeline: <T>(items: T[], ...stages: ((item: unknown, original: T) => unknown)[]) => unknown[];
  phase: (title: string) => void;
  log: (message: string) => void;
  validate: (value: unknown, schema: JsonSchema) => ValidationResult;
}

export interface WorkflowModule {
  meta: WorkflowMeta;
  execute: (ctx: WorkflowContext) => Record<string, unknown> | void;
}
