import type { JsonSchema, WorkflowContext, WorkflowMeta } from "../src/types.ts";

/**
 * survey-round — the plan for ONE round of a convergence loop.
 *
 * Bun PR #30412 correctness mechanism: round-loop-until-convergence. A static plan
 * cannot express the loop itself (the agent count of round N+1 depends on what
 * round N discovered). So this workflow models a SINGLE round — Survey -> Fix ->
 * Verify — and Claude Code wraps the loop around it per `orchestrate` SKILL.md:
 *
 *   round = 1
 *   loop:
 *     run survey-round with the current target list
 *     read the Survey agent's `remaining`
 *     if remaining == 0  -> converged, stop
 *     if round >= MAX    -> stop (report non-convergence)
 *     feed the Survey `items` back as `targets`, round++
 *
 * Passing an empty `targets` makes this a pure convergence check (Survey only).
 */
export const meta: WorkflowMeta = {
  name: "survey-round",
  description: "One convergence round: survey -> fix -> verify (multi-vote)",
  args_schema: {
    type: "object", required: ["targets", "instruction"],
    properties: {
      targets: { type: "array", items: { type: "string" } },
      instruction: { type: "string" },
      round: { type: "integer" },
    },
  },
  phases: [
    { title: "Survey", detail: "Inspect actual state, count remaining work units" },
    { title: "Fix", detail: "One agent per target" },
    { title: "Verify", detail: "2 reviewers vote per target" },
  ],
};

const SURVEY: JsonSchema = { type: "object", required: ["remaining", "items"], properties: { remaining: { type: "integer" }, items: { type: "array", items: { type: "string" } } } };
const FIX: JsonSchema = { type: "object", required: ["target", "done"], properties: { target: { type: "string" }, done: { type: "boolean" }, detail: { type: "string" } } };
const VOTE: JsonSchema = { type: "object", required: ["accept"], properties: { accept: { type: "boolean" }, reason: { type: "string" } } };

/** Reviewers per target — verify catches fixes that only suppress the symptom. */
const VOTES = 2;

export function execute({ args, agent, pipeline, phase, log }: WorkflowContext) {
  const { targets, instruction, round } = args as { targets: string[]; instruction: string; round?: number };
  const r = round ?? 1;
  log(`survey-round: round ${r}, ${targets.length} targets`);

  phase("Survey");
  agent(`Inspect the project state. Count the remaining work units for: ${instruction}. List each one.\n\nReturn ONLY valid JSON:\n${JSON.stringify(SURVEY, null, 2)}\n\nCONVERGENCE: if remaining is 0, the loop stops after this round.`,
    { label: `survey:r${r}`, phase: "Survey", schema: SURVEY });

  if (!targets.length) {
    log("survey-round: no targets — pure convergence check (Survey only)");
    return { round: r, targets: 0, convergenceCheck: true };
  }

  phase("Fix");
  pipeline(targets, (t: string) =>
    agent(`${instruction}\n\nTarget: ${t}\n\nReturn ONLY valid JSON:\n${JSON.stringify(FIX, null, 2)}`,
      { label: `fix:${t}`, phase: "Fix", schema: FIX }));

  phase("Verify");
  pipeline(targets, (t: string) =>
    Array.from({ length: VOTES }, (_, v) =>
      agent(`Independently verify the fix for "${t}". REJECT if it suppresses the problem instead of solving it.\n\nReturn ONLY valid JSON:\n${JSON.stringify(VOTE, null, 2)}`,
        { label: `verify:${t}#${v + 1}`, phase: "Verify", schema: VOTE })));

  return { round: r, targets: targets.length, votesPerTarget: VOTES };
}
