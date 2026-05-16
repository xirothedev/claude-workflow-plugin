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
4. Validate each agent output against schema
5. Report results

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

`bun run .claude/workflows/cli.ts show <name> '<args-json>'`

### `create <name> [template]` — Create new workflow from template

1. Pick template: single-agent, multi-stage, parallel-swarm
2. Copy `<skill-dir>/skills/workflow/templates/<template>.workflow.ts` to `.claude/workflows/<name>.workflow.ts`
3. Prompt user for customization
4. Write with TODO markers

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
