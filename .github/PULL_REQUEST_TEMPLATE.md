<!-- Thanks for contributing to claude-workflow-plugin. -->

## What & why

<!-- What does this PR change, and why? Link any issue. -->

## Type of change

- [ ] Dataset entry — a new run record under `dataset/entries/`
- [ ] Workflow archetype — new or changed template
- [ ] Skill change — `workflow`, `orchestrate`, or `dataset`
- [ ] Runtime / validator / MCP server
- [ ] Docs only

## Checks

<!-- Run these locally before opening the PR. -->

- [ ] `bun test` — all tests pass
- [ ] `bunx tsc --noEmit` — typecheck clean
- [ ] `bun run dataset/validate.ts` — `N/N entries valid` (if a dataset entry changed)

## For a dataset entry

- [ ] File name matches the `id` field
- [ ] `outcome` and `pitfalls` are honest
- [ ] Licensed CC0-1.0

## For a workflow / runtime change

- [ ] Static-plan model preserved (agents enumerable up front; loops are Claude-driven)
- [ ] New control-flow covered by a test in `skills/workflow/tests/`
