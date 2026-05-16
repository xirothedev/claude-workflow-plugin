import { describe, expect, test } from "bun:test";
import { buildPlan, formatPlan } from "../src/runtime.ts";
import type { WorkflowModule } from "../src/types.ts";
import * as multiStage from "../templates/multi-stage.workflow.ts";
import * as parallelSwarm from "../templates/parallel-swarm.workflow.ts";
import * as singleAgent from "../templates/single-agent.workflow.ts";
import * as surveyRound from "../templates/survey-round.workflow.ts";
import * as verifiedSwarm from "../templates/verified-swarm.workflow.ts";

/** Re-wrap a template's module namespace as a WorkflowModule. */
function asModule(ns: { meta: WorkflowModule["meta"]; execute: WorkflowModule["execute"] }): WorkflowModule {
  return { meta: ns.meta, execute: ns.execute };
}

describe("template: single-agent", () => {
  test("one Execute agent, two phases", () => {
    const plan = buildPlan(asModule(singleAgent), { task: "audit codebase" });
    expect(plan.agents.length).toBe(1);
    expect(plan.phases.map((p) => p.title)).toEqual(["Execute", "Validate"]);
    expect(plan.agents[0]?.schema).toBeDefined();
  });
});

describe("template: multi-stage", () => {
  test("3 stages, 2 agents each for 2 items", () => {
    const plan = buildPlan(asModule(multiStage), { items: ["a", "b"], instruction: "do" });
    expect(plan.stages.length).toBe(3);
    expect(plan.agents.length).toBe(6);
    for (const stage of plan.stages) expect(stage.length).toBe(2);
  });
});

describe("template: parallel-swarm", () => {
  test("N swarm agents + 1 aggregate, 2 stages", () => {
    const plan = buildPlan(asModule(parallelSwarm), { items: ["a", "b", "c"], instruction: "audit" });
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].length).toBe(3);
    expect(plan.stages[1].length).toBe(1);
    expect(plan.agents.length).toBe(4);
  });
});

describe("template: verified-swarm", () => {
  const plan = buildPlan(asModule(verifiedSwarm), { items: ["a", "b"], instruction: "port" });

  test("4 stages: Implement → Verify → Fix → Aggregate", () => {
    expect(plan.stages.length).toBe(4);
    expect(plan.phases.map((p) => p.title)).toEqual(["Implement", "Verify", "Fix", "Aggregate"]);
  });

  test("Verify phase runs 3 independent voters per item", () => {
    const verify = plan.agents.filter((a) => a.phase === "Verify");
    expect(verify.length).toBe(2 * 3);
  });

  test("one Implement and one Fix agent per item", () => {
    expect(plan.agents.filter((a) => a.phase === "Implement").length).toBe(2);
    expect(plan.agents.filter((a) => a.phase === "Fix").length).toBe(2);
    expect(plan.agents.filter((a) => a.phase === "Aggregate").length).toBe(1);
  });

  test("total agent count = items * (1 impl + 3 verify + 1 fix) + 1 aggregate", () => {
    expect(plan.agents.length).toBe(2 * 5 + 1);
  });

  test("empty items short-circuits with no agents", () => {
    const empty = buildPlan(asModule(verifiedSwarm), { items: [], instruction: "x" });
    expect(empty.agents.length).toBe(0);
  });
});

describe("template: survey-round", () => {
  test("with targets → 3 stages: Survey → Fix → Verify", () => {
    const plan = buildPlan(asModule(surveyRound), { targets: ["a", "b"], instruction: "sweep", round: 1 });
    expect(plan.stages.length).toBe(3);
    expect(plan.agents.filter((a) => a.phase === "Survey").length).toBe(1);
    expect(plan.agents.filter((a) => a.phase === "Fix").length).toBe(2);
    expect(plan.agents.filter((a) => a.phase === "Verify").length).toBe(2 * 2);
    expect(plan.agents.length).toBe(1 + 2 + 4);
  });

  test("empty targets → convergence check, Survey agent only", () => {
    const plan = buildPlan(asModule(surveyRound), { targets: [], instruction: "sweep" });
    expect(plan.stages.length).toBe(1);
    expect(plan.agents.length).toBe(1);
    expect(plan.agents[0]?.phase).toBe("Survey");
  });
});

describe("templates — every agent is well-formed", () => {
  const all: Array<[string, WorkflowModule, Record<string, unknown>]> = [
    ["single-agent", asModule(singleAgent), { task: "t" }],
    ["multi-stage", asModule(multiStage), { items: ["a"], instruction: "i" }],
    ["parallel-swarm", asModule(parallelSwarm), { items: ["a"], instruction: "i" }],
    ["verified-swarm", asModule(verifiedSwarm), { items: ["a"], instruction: "i" }],
    ["survey-round", asModule(surveyRound), { targets: ["a"], instruction: "i" }],
  ];

  for (const [name, m, args] of all) {
    test(`${name}: every agent has a label, phase, schema, and prompt`, () => {
      const plan = buildPlan(m, args);
      for (const a of plan.agents) {
        expect(a.label.length).toBeGreaterThan(0);
        expect(a.phase.length).toBeGreaterThan(0);
        expect(a.schema).toBeDefined();
        expect(a.prompt).toContain("JSON");
      }
      // Plan must render without throwing.
      expect(formatPlan(plan).length).toBeGreaterThan(0);
    });
  }
});
