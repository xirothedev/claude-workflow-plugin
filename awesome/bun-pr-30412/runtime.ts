/**
 * Bun PR #30412 — agent-orchestration runtime contract (TypeScript port).
 * =======================================================================
 *
 * This file models the *live async runtime* that Bun's internal Claude Code
 * harness exposed to the 53 `.workflow.js` files shipped in PR #30412
 * ("rewrite Bun in Rust", merged 2026-05-14).
 *
 * BUN'S MODEL — live async orchestration
 * --------------------------------------
 * In Bun's harness the workflow file body *is* the execution body. There is
 * no `export function execute`; the runtime injects `args`, `agent`,
 * `pipeline`, `parallel`, `phase`, `log` as ambient globals and `eval`s the
 * file. Crucially:
 *
 *   - `agent(prompt, opts)` *actually spawns an agent*, runs it to completion,
 *     validates its JSON output against `opts.schema`, and RETURNS A PROMISE
 *     resolving to that parsed output.
 *   - The workflow can therefore `await` an agent, read its result, and
 *     **branch on the data** — early-return, dedup, filter, sort, loop.
 *   - `for (let round = 1; round <= MAX; round++)` round loops run until the
 *     swarm *converges* (0 panics left, 0 todo!() left, all tests green).
 *     The number of agents spawned is not knowable ahead of time; it depends
 *     on what previous rounds discovered.
 *   - ~170 such workflows ran concurrently against the same git repo.
 *
 * THIS PLUGIN'S MODEL — static plan (contrast)
 * --------------------------------------------
 * The workflow skill in `skills/workflow/src/` uses a *static-plan* runtime:
 * `agent()` there returns a synchronous `AgentCall` descriptor (an id + the
 * prompt + schema), NOT a Promise. Running a workflow produces a `WorkflowPlan`
 * — a DAG of agent calls and stages — which is *then* executed by `cli.ts`.
 * Because `agent()` never yields a value at plan time, that model:
 *
 *   - cannot read an agent's output inside the workflow body,
 *   - cannot branch / dedup / filter on agent results,
 *   - cannot express `round-loop-until-convergence` (the loop bound depends
 *     on data that does not exist until agents have actually run).
 *
 * The ports in this folder are *faithful reference implementations* of Bun's
 * live model. They run only against a Bun-style live runtime that satisfies
 * `WorkflowRuntime` below — not against this plugin's `cli.ts`.
 */

// ---------------------------------------------------------------------------
// Phase + workflow metadata
// ---------------------------------------------------------------------------

export interface Phase {
  title: string;
  detail: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: Phase[];
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------
//
// A superset of the plugin's `JsonSchema`. Bun's workflows use:
//   - `type: "number"` (the plugin only had "integer")
//   - type-unions written as `type: ["string", "null"]`
//   - bare `{ enum: [...] }` with no `type`
//   - nested objects / arrays of objects, arbitrary depth
//   - `oneOf` / `anyOf`
//
// `description` is allowed on every node (Bun annotates fields heavily so the
// agent knows exactly what to emit).

/** Primitive JSON Schema type names accepted by the runtime. */
export type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

/** Common annotations carried by any schema node. */
interface SchemaBase {
  description?: string;
}

export interface ObjectSchema extends SchemaBase {
  type: "object";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
}

export interface StringSchema extends SchemaBase {
  type: "string";
  enum?: string[];
}

export interface NumberSchema extends SchemaBase {
  /** "number" allows fractional; "integer" is whole-only. */
  type: "number" | "integer";
}

export interface BooleanSchema extends SchemaBase {
  type: "boolean";
}

export interface NullSchema extends SchemaBase {
  type: "null";
}

export interface ArraySchema extends SchemaBase {
  type: "array";
  items: JsonSchema;
}

/** A type-union, e.g. `{ type: ["string", "null"] }`. */
export interface UnionSchema extends SchemaBase {
  type: JsonSchemaType[];
  /** carried along for the "array" branch of the union, if present */
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
}

/** Bare enum with no `type` keyword. */
export interface EnumSchema extends SchemaBase {
  enum: Array<string | number | boolean | null>;
}

export interface OneOfSchema extends SchemaBase {
  oneOf: JsonSchema[];
}

export interface AnyOfSchema extends SchemaBase {
  anyOf: JsonSchema[];
}

/** Recursive JSON Schema type covering everything Bun's workflows emit. */
export type JsonSchema =
  | ObjectSchema
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | NullSchema
  | ArraySchema
  | UnionSchema
  | EnumSchema
  | OneOfSchema
  | AnyOfSchema;

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

export interface AgentOpts {
  /** Short human-readable identifier shown in the harness UI / logs. */
  label: string;
  /** Phase this agent belongs to; must match a `phase(title)` call. */
  phase: string;
  /** Schema the agent's JSON output is validated against before resolving. */
  schema: JsonSchema;
  /** Optional sub-agent type override (e.g. a specialised model profile). */
  agentType?: string;
}

// ---------------------------------------------------------------------------
// Runtime contract
// ---------------------------------------------------------------------------

/**
 * One pipeline stage.
 *
 * `pipeline` cannot statically know the shape flowing between stages — the
 * value a stage receives is whatever the *previous* stage's thunk resolved to,
 * and the first stage receives a raw `T`. We type the stage input as `never`
 * so callers are forced to narrow/annotate at each boundary (the workflow
 * ports below annotate their stage parameters explicitly), while `original`
 * is always the untouched item from the input array.
 */
export type PipelineStage<T> = (input: never, original: T) => unknown;

export interface WorkflowRuntime {
  /** Parsed workflow arguments injected by the harness. */
  args: Record<string, unknown>;

  /**
   * Spawn one agent, run it to completion, validate its JSON output against
   * `opts.schema`, and resolve to that output. Rejects (or resolves to a
   * sentinel — workflows defensively handle a falsy result) on failure.
   */
  agent<T = unknown>(prompt: string, opts: AgentOpts): Promise<T>;

  /**
   * Run `items` through one or more stages. Each stage runs ITS items in
   * parallel; stages run sequentially. Stage N receives, per item, the value
   * stage N-1 produced for that item (plus the original input item).
   *
   * Returns the per-item results of the final stage.
   */
  pipeline<T>(items: T[], ...stages: Array<PipelineStage<T>>): Promise<unknown[]>;

  /** Run an array of thunks concurrently; resolve to all their results. */
  parallel<T>(thunks: Array<() => T | Promise<T>>): Promise<T[]>;

  /**
   * Mark/enter a named phase. May be called repeatedly — round loops re-enter
   * the same phases once per round.
   */
  phase(title: string): void;

  /** Structured progress log line. */
  log(message: string): void;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------
//
// Bun's files have no `execute` wrapper — their body runs directly. The ports
// here wrap that body in `export async function execute(rt)` so they are valid
// ES modules and `rt` replaces Bun's ambient globals. A `WorkflowModule` is
// therefore `{ meta, execute }`.

export interface WorkflowModule {
  meta: WorkflowMeta;
  execute(rt: WorkflowRuntime): Promise<unknown>;
}
