---
name: orchestrate
description: |
  Interactive project builder. You give Claude the project context + requirements;
  Claude interviews you on every technology, skill, and MCP server, resolves all
  libraries via context7, asks about backend/frontend architecture and the design
  system, synthesises a full set of workflows, summarises each phase, waits for
  your confirmation, then dispatches agents in a convergence loop until the whole
  project is done.
  Use when: "build this project", "orchestrate a project", "khởi tạo dự án",
  "set up the whole project", "drive this project to completion".
---

# Orchestrate

Drives a project from a context dump to a finished build. Sits **on top of** the
`workflow` skill: `orchestrate` runs the conversation and the convergence loop;
`workflow` bootstraps `.claude/workflows/` and renders the per-phase plans.

This is a **conversation protocol**, not a script. Run the 7 steps in order. Each
step ends with a **STOP gate** — do not advance until the gate is satisfied.

> The correctness mechanisms referenced below (multi-vote verify, verify-until-dry,
> dedup, explicit convergence) are distilled from Bun PR #30412 in
> `references/correctness.md`. Read it before Step 7.

---

## Step 1 — Intake

**Goal:** a written, shared understanding of what is being built.

1. Read every file/repo/spec the user provided (`Read`, `Glob`, `Grep`). Do not
   guess at unread material.
2. Write `.claude/orchestrate/CONTEXT.md`: goal, scope, hard constraints, what is
   explicitly out of scope, success criteria.
3. Echo the summary back to the user. Ask targeted questions for every gap.

**STOP gate:** user confirms `CONTEXT.md` reflects their intent.

---

## Step 2 — Tech & tooling interview

**Goal:** lock the stack and the tooling before any design.

Use `AskUserQuestion` (one topic per question, 2–4 options, recommended option
first). Cover, in order:

1. **Languages & frameworks** — backend, frontend, runtime, package manager.
2. **Skills** — which available skills to use (e.g. `tdd`, `frontend-design`,
   `feature-dev`). List the ones that fit; let the user pick.
3. **MCP servers** — which MCP servers the build will rely on (context7 for docs,
   github for PRs, etc.).
4. **Priorities** — speed vs. correctness vs. coverage; what to build first.

Record answers in `.claude/orchestrate/STACK.md`.

**STOP gate:** stack + skills + MCP + priority order all recorded and confirmed.

---

## Step 3 — Library resolution (context7)

**Goal:** pin every library to real, current docs — never build on guessed APIs.

For **each** library named in Step 2:

1. `context7 resolve-library-id` → get the canonical id.
2. `context7 query-docs` → fetch the APIs/config the project will actually use.
3. Append to `STACK.md`: library, resolved id, pinned version, the specific
   APIs/imports confirmed.

If a library cannot be resolved, flag it to the user — do not silently proceed.

**STOP gate:** every library in `STACK.md` has a resolved id + confirmed API notes.

---

## Step 4 — Architecture interview

**Goal:** a written architecture + design system before workflows are generated.

**First, search the dataset.** Use the `dataset` skill (`dataset_search` MCP tool,
or `bun run dataset/search.ts`) by `domain` + `stack`. Surface the architecture
and `lessons` of similar past projects to the user — let real precedent shape the
questions. Cite the entry ids you drew from.

Then use `AskUserQuestion` + discussion. Cover:

1. **Backend architecture** — layering (e.g. controller/service/repository),
   data model, API style (REST/GraphQL/RPC), auth, error-handling strategy.
2. **Frontend architecture** — routing, state management, data fetching,
   component composition.
3. **Design system** — tokens (color/spacing/typography), component library,
   responsive strategy.

Record in `.claude/orchestrate/ARCHITECTURE.md`. Reference the user's global
structure conventions if the project has a `CLAUDE.md`.

**STOP gate:** user confirms `ARCHITECTURE.md`.

---

## Step 5 — Workflow synthesis

**Goal:** one `.claude/workflows/*.workflow.ts` per project phase.

1. If `.claude/workflows/` does not exist, run the `workflow` skill's `init`.
   Search the dataset by `domain` again — see which archetype each phase used in
   similar projects and how many rounds they took to converge.
2. Split the project into ordered phases. A typical split:
   `scaffold → backend-contract → backend-impl → frontend-impl → integrate → test-sweep`.
3. For each phase, create a workflow from the closest archetype template:
   - **single-agent** — one-shot phase (scaffold, config).
   - **multi-stage** — implement → verify → fix per item.
   - **parallel-swarm** — independent items audited/built in parallel.
   - **verified-swarm** — parallel build + 3-vote adversarial verify + conditional
     fix. Use for any phase where an agent could fake "done".
   - **survey-round** — one round of a convergence loop (survey → fix → verify).
     Use for sweep-style phases (`test-sweep`, fixing every TODO).
   Bake the Step 3 pinned APIs and Step 4 architecture into each workflow's prompts.
4. Write `.claude/orchestrate/PLAN.md`: the phase list, which workflow + archetype
   each uses, the args each will run with, and the dependency order.

**STOP gate:** all phase workflows created; `cli.ts validate` passes for each.

---

## Step 6 — Phase summary + confirm

**Goal:** the user signs off on the build before any agent is dispatched.

For each phase, present: name, archetype, what agents will do, expected output
schema, convergence criterion (for loop phases), and the dependency it waits on.

**STOP gate — mandatory:** do **not** dispatch any agent until the user explicitly
confirms the phase plan. This is the irreversible-action gate.

---

## Step 7 — Dispatch loop

**Goal:** execute every phase to completion.

For each phase, in dependency order:

1. Build the plan: `bun run .claude/workflows/cli.ts show <phase> '<args-json>'`.
2. Execute **stage by stage**. Agents in one stage are dispatched in a single
   message (parallel `Agent` tool calls).
3. **Validate** each agent's JSON against its schema. On failure, retry the agent
   **once** with the validation errors fed back. Still failing → surface to user.
4. **Chain** results: inject stage N output into stage N+1 prompts.
5. **Multi-vote verify gate:** for `verified-swarm`/`survey-round`, read the verify
   votes. Run the Fix agent for an item **only if the majority rejected it**. Skip
   the rest. (Correctness mechanism — see `references/correctness.md`.)

### Convergence loop (sweep phases)

For `survey-round` phases, wrap the loop yourself — the static plan models one
round only:

```
round = 1
loop:
  run survey-round with the current target list
  read the Survey agent's `remaining` and `items`
  if remaining == 0          -> CONVERGED, exit the loop
  if round >= MAX_ROUNDS (8) -> STOP, report non-convergence to the user
  dedup `items` (by location/signature — do not fix the same root cause twice)
  targets = deduped items;  round = round + 1
```

Bias each round's target order toward items not seen in earlier rounds (fair
sharding). Apply verify-until-dry inside a round: re-verify until a pass finds no
new issues.

**STOP gate:** every phase converged (or non-convergence reported). Summarise the
finished build, the per-phase results, and anything left for the user.

---

## Notes

- **Close the loop:** once the build finishes, offer to contribute it to the
  dataset via the `dataset` skill — domain, stack, architecture, the workflows
  used, the outcome, the lessons. That is how the next run starts richer.
- `orchestrate` never edits product code itself — it dispatches agents that do.
- If the user interrupts, the `.claude/orchestrate/*.md` files are the resumable
  state. On resume, re-read them and continue from the last satisfied STOP gate.
- The convergence loop is Claude-driven: the `workflow` runtime is static-plan and
  cannot express round-loops. `survey-round` is the per-round plan; this skill is
  the loop.
