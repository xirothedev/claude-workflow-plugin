# E2E trial — orchestrate the Todo API

A guided end-to-end trial of the `orchestrate` skill. It validates the full chain:
intake → interview → library resolution → architecture → workflow synthesis →
confirm → dispatch loop.

The convergence loop is Claude-driven, so this trial **needs an interactive
session** — it is not an automated test. The automated tests live in
`skills/workflow/tests/` (`bun test`).

## Run it

1. In an empty working directory, start Claude Code with this plugin installed.
2. Ask: *"orchestrate a project — the brief is in `examples/todo-api/BRIEF.md`"*.
3. Walk the 7 steps. The skill stops at each STOP gate for your confirmation:
   - **Step 1** — confirm `.claude/orchestrate/CONTEXT.md`.
   - **Steps 2 & 4** — answer the `AskUserQuestion` prompts.
   - **Step 3** — watch it resolve each library via context7.
   - **Step 5** — it bootstraps `.claude/workflows/` and synthesises one workflow
     per phase (`scaffold`, `backend-contract`, `backend-impl`, `frontend-impl`,
     `integrate`, `test-sweep`).
   - **Step 6** — review the per-phase summary, then confirm to start dispatch.
   - **Step 7** — agents build the project; `test-sweep` runs as a `survey-round`
     convergence loop.

## What "passing" looks like

- The 7 steps run in order; every STOP gate waits for you.
- Generated workflows pass `bun run .claude/workflows/cli.ts validate <phase> '<args>'`.
- `test-sweep` loops, and **early-returns the moment the Survey agent reports
  `remaining == 0`** — not after a fixed round count.
- Final state: the success criteria in `BRIEF.md` are met (routes work, frontend
  works, typecheck + tests pass).
