---
name: workflow
description: |
  Multi-phase agent orchestration system. Bootstraps .claude/workflows/ in any project.
  Commands: init (bootstrap), run (execute), list (show workflows), create (new from template), plan (build plan).
  Use when: "init workflows", "run workflow X", "list workflows", "create workflow".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Agent
  - Glob
  - Grep
---

# Workflow Engine

Portable multi-phase agent orchestration. Bootstraps `.claude/workflows/` in any project.

## Commands

Two kinds. **Skill actions** (`init`, `run`, `create`) are orchestrated by Claude.
**CLI subcommands** are run via `bun run .claude/workflows/cli.ts <subcommand>`:

| CLI subcommand | Purpose |
|----------------|---------|
| `list` | List discoverable workflows |
| `plan <name> '<args>'` | Build plan as JSON |
| `show <name> '<args>'` | Build plan in readable form |
| `validate <name> '<args>'` | Validate args against `args_schema` |
| `meta <name>` | Print workflow metadata |

### `init` — Bootstrap workflow system in current project

Run: `bun run <skill-dir>/skills/workflow/scripts/init.ts`

This generates in the current project:
```
.claude/workflows/
├── cli.ts              # bun run .claude/workflows/cli.ts <command>
├── src/                # Runtime (symlinked to plugin)
│   ├── types.ts
│   ├── runtime.ts
│   └── validator.ts
├── templates/          # Starter workflows (copied, user can customize)
└── README.md
```

Non-destructive: existing files are NEVER overwritten.

### `run <workflow> [args]` — Execute a workflow

1. Build plan: `bun run .claude/workflows/cli.ts show <name> '<args-json>'`
2. Parse plan output
3. Execute stage by stage (agents in same stage run in parallel)
4. Validate each agent output against schema; on failure, retry the agent once with the validation errors fed back
5. Report results

**Adversarial verify** — for `verified-swarm`/`survey-round`, a Verify phase runs
several independent voters per item. Run that item's Fix agent **only if the
majority rejected it**; skip the rest. This catches agents that suppress errors
instead of fixing them.

**Convergence loop** — `survey-round` is the plan for *one round* only. The
static-plan runtime cannot express a round-loop, so drive it yourself: run the
round, read the Survey agent's `remaining`, and repeat until `remaining == 0` or a
`MAX_ROUNDS` cap. The `orchestrate` skill describes the full loop.

Agent invocation:
```
Agent({
  description: "<label>",
  prompt: "<prompt>\n\nIMPORTANT: Return ONLY valid JSON matching this schema:\n<schema>\n\nNo markdown fences, no commentary, only the JSON object.",
})
```

### `list` — List workflows

`bun run .claude/workflows/cli.ts list`

### `plan <workflow> [args]` — Build plan without executing

- Readable: `bun run .claude/workflows/cli.ts show <name> '<args-json>'`
- JSON: `bun run .claude/workflows/cli.ts plan <name> '<args-json>'`

### `create <name> [template]` — Create new workflow from template

1. Pick template:
   - `single-agent` — one agent, schema-validated output
   - `multi-stage` — implement → verify → fix pipeline
   - `parallel-swarm` — N agents in parallel + aggregate
   - `verified-swarm` — parallel implement + 3-vote adversarial verify + conditional fix
   - `survey-round` — one round of a convergence loop (survey → fix → verify)
2. Copy `<skill-dir>/skills/workflow/templates/<template>.workflow.ts` to `.claude/workflows/<name>.workflow.ts`
3. Rewrite the import: `../src/types.ts` → `./src/types.ts` (templates live one dir deeper than root workflows)
4. Prompt user for customization
5. Write with TODO markers

## How to discover <skill-dir>

The skill directory is wherever this plugin is installed. Check:
1. `~/.claude/plugins/claude-workflow-plugin/skills/workflow/`
2. Or the directory containing this SKILL.md file

Use `${CLAUDE_SKILL_DIR}` environment variable if available, or ask the user.

## Workflow File Contract

```typescript
import type { WorkflowMeta, WorkflowContext } from "./src/types.ts";

export const meta: WorkflowMeta = { name, description, phases, args_schema? };
export function execute(ctx: WorkflowContext): Record<string, unknown> { ... }
```

Runtime API in `ctx`:
- `ctx.agent(prompt, { label, phase, schema })` — register agent
- `ctx.pipeline(items, stage)` — parallel stage
- `ctx.multiPipeline(items, ...stages)` — multi-stage
- `ctx.phase(title)` — mark phase
- `ctx.log(msg)` — structured log
- `ctx.validate(value, schema)` — JSON Schema validation
