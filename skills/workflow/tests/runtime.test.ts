import { describe, expect, test } from "bun:test";
import { buildPlan, formatPlan } from "../src/runtime.ts";
import type { JsonSchema, WorkflowContext, WorkflowMeta, WorkflowModule } from "../src/types.ts";

const S: JsonSchema = { type: "object", required: ["x"], properties: { x: { type: "string" } } };

/** Build a WorkflowModule from a meta + execute pair. */
function mod(meta: WorkflowMeta, execute: WorkflowModule["execute"]): WorkflowModule {
  return { meta, execute };
}

describe("buildPlan — agent registration", () => {
  test("two agents in one phase produce one stage", () => {
    const m = mod(
      { name: "two", description: "", phases: [{ title: "P", detail: "" }] },
      (ctx: WorkflowContext) => {
        ctx.phase("P");
        ctx.agent("first", { label: "a", phase: "P", schema: S });
        ctx.agent("second", { label: "b", phase: "P", schema: S });
        return { ok: true };
      },
    );
    const plan = buildPlan(m, {});
    expect(plan.agents.length).toBe(2);
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0].length).toBe(2);
    expect(plan.phases[0].agents.length).toBe(2);
  });
});

describe("buildPlan — pipeline staging", () => {
  test("pipeline over 3 items yields one stage of 3 agents", () => {
    const m = mod(
      { name: "pipe", description: "", phases: [{ title: "P", detail: "" }] },
      (ctx: WorkflowContext) => {
        ctx.phase("P");
        ctx.pipeline(["a", "b", "c"], (item: string) =>
          ctx.agent(`do ${item}`, { label: item, phase: "P", schema: S }));
        return {};
      },
    );
    const plan = buildPlan(m, {});
    expect(plan.agents.length).toBe(3);
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0].length).toBe(3);
  });
});

describe("buildPlan — multiPipeline chaining + dependency inference", () => {
  test("two stages, stage 2 depends on every agent in stage 1", () => {
    const m = mod(
      { name: "multi", description: "", phases: [{ title: "A", detail: "" }, { title: "B", detail: "" }] },
      (ctx: WorkflowContext) => {
        ctx.phase("A");
        ctx.phase("B");
        ctx.multiPipeline(["i1", "i2"],
          (_item, original) => ctx.agent(`a:${String(original)}`, { label: "a", phase: "A", schema: S }),
          () => ctx.agent("b", { label: "b", phase: "B", schema: S }),
        );
        return {};
      },
    );
    const plan = buildPlan(m, {});
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].length).toBe(2);
    expect(plan.stages[1].length).toBe(2);
    // Every stage-2 agent depends on the full set of stage-1 agent ids.
    for (const id of plan.stages[1]) {
      const a = plan.agents.find((ag) => ag.id === id);
      expect(a?.dependsOn).toEqual(plan.stages[0]);
    }
    // Stage-1 agents depend on nothing.
    for (const id of plan.stages[0]) {
      const a = plan.agents.find((ag) => ag.id === id);
      expect(a?.dependsOn).toEqual([]);
    }
  });
});

describe("buildPlan — args validation", () => {
  const m = mod(
    {
      name: "needs-args",
      description: "",
      args_schema: { type: "object", required: ["task"], properties: { task: { type: "string" } } },
      phases: [{ title: "P", detail: "" }],
    },
    (ctx: WorkflowContext) => {
      ctx.phase("P");
      return {};
    },
  );

  test("valid args build the plan", () => {
    expect(buildPlan(m, { task: "x" }).workflow).toBe("needs-args");
  });

  test("invalid args throw before execute runs", () => {
    expect(() => buildPlan(m, {})).toThrow(/Invalid args/);
  });
});

describe("formatPlan", () => {
  test("renders readable markdown containing the workflow name", () => {
    const m = mod(
      { name: "fmt", description: "", phases: [{ title: "P", detail: "" }] },
      (ctx: WorkflowContext) => {
        ctx.phase("P");
        ctx.agent("go", { label: "go", phase: "P", schema: S });
        return {};
      },
    );
    const out = formatPlan(buildPlan(m, {}));
    expect(out).toContain("# Workflow Plan: fmt");
    expect(out).toContain("Execution Stages");
  });
});
