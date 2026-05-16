# claude-workflow-plugin

Multi-phase agent orchestration plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Inspired by [Bun's migration workflow pattern](https://github.com/oven-sh/bun/pull/30412).

Define workflows as TypeScript modules. The runtime builds an orchestration plan with agents, schemas, and execution stages. Claude Code executes the plan — spawning agents in parallel, validating structured JSON output, and chaining results between stages.

Two skills ship with the plugin: **`workflow`** bootstraps and runs individual workflows; **`orchestrate`** drives a whole project — interviewing you on the stack, resolving libraries via context7, synthesising workflows, and dispatching agents in a convergence loop until the build is done.

## How It Works

```
┌──────────────┐     ┌───────────────┐     ┌──────────────────┐
│  Workflow    │────>│  Plan Builder │────>│  Claude Code     │
│  (*.ts)      │     │  (Bun runtime)│     │  (Agent tool)    │
│              │     │               │     │                  │
│ meta +       │     │ Agents,       │     │ Spawns agents,   │
│ execute()    │     │ schemas,      │     │ validates JSON,  │
│              │     │ stages, deps  │     │ chains results   │
└──────────────┘     └───────────────┘     └──────────────────┘
```

1. **Write** a workflow as a TypeScript module (`*.workflow.ts`)
2. **Build plan** — the runtime parses the module, records agent calls, builds dependency graph
3. **Execute** — Claude Code reads the plan, spawns agents via the Agent tool, validates output against JSON Schema

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### Install as a Claude Code plugin (recommended)

This repo is a Claude Code plugin **marketplace**. From inside Claude Code:

```
/plugin marketplace add github:xirothedev/claude-workflow-plugin
/plugin install claude-workflow-plugin@claude-workflow-plugin
```

`/plugin marketplace add` registers the repo; `/plugin install` adds the plugin.
The `workflow` skill is then available in every session — ask Claude to
"init workflows" to bootstrap a project. Pull updates with:

```
/plugin marketplace update claude-workflow-plugin
```

### Install in a Project

```bash
# Clone this repo (or add as a plugin)
git clone https://github.com/xirothedev/claude-workflow-plugin.git
cd your-project

# Bootstrap — creates .claude/workflows/ with runtime + templates
bun run /path/to/claude-workflow-plugin/skills/workflow/scripts/init.ts
```

This generates:

```
your-project/
└── .claude/workflows/
    ├── cli.ts                 # CLI runner
    ├── src/                   # Runtime (symlinked → single source of truth)
    │   ├── types.ts
    │   ├── runtime.ts
    │   └── validator.ts
    ├── templates/             # Starter workflows (copied — customize freely)
    │   ├── single-agent.workflow.ts
    │   ├── multi-stage.workflow.ts
    │   └── parallel-swarm.workflow.ts
    └── README.md
```

**Non-destructive**: re-running init never overwrites existing files.

### CLI Usage

```bash
# List all discoverable workflows
bun run .claude/workflows/cli.ts list

# Show orchestration plan (readable)
bun run .claude/workflows/cli.ts show single-agent '{"task":"audit codebase"}'

# Show plan as JSON
bun run .claude/workflows/cli.ts plan single-agent '{"task":"audit codebase"}'

# Validate args against workflow schema
bun run .claude/workflows/cli.ts validate single-agent '{"task":"hello"}'

# Show workflow metadata
bun run .claude/workflows/cli.ts meta single-agent
```

## Workflow Templates

### single-agent

One agent, schema-validated structured output.

```bash
bun run .claude/workflows/cli.ts show single-agent '{"task":"Find unused exports"}'
```

Use for: reports, analysis, classification, single-shot tasks.

### multi-stage

Three-stage pipeline: **Implement → Verify → Fix**.

```bash
bun run .claude/workflows/cli.ts show multi-stage '{
  "items": ["src/auth.ts", "src/api.ts"],
  "instruction": "Add error handling"
}'
```

Use for: code changes that need verification, migration tasks, any work that benefits from an adversarial review stage.

### parallel-swarm

N agents run in parallel, results aggregated into a summary.

```bash
bun run .claude/workflows/cli.ts show parallel-swarm '{
  "items": ["src/a.ts", "src/b.ts", "src/c.ts"],
  "instruction": "Audit for security issues"
}'
```

Use for: bulk analysis, reviewing multiple files/PRs, classification across items.

### verified-swarm

Parallel implement → **3-vote adversarial verify** per item → conditional fix → aggregate.

```bash
bun run .claude/workflows/cli.ts show verified-swarm '{
  "items": ["src/a.ts", "src/b.ts"],
  "instruction": "Port to the new API"
}'
```

Use for: any phase where an agent could fake "done" by suppressing errors. Three
independent voters decide; Fix runs only when the majority rejects.

### survey-round

One round of a convergence loop: **Survey → Fix → Verify** (multi-vote).

```bash
bun run .claude/workflows/cli.ts show survey-round '{
  "targets": ["TODO at src/x.ts:12"],
  "instruction": "Replace every TODO with a real implementation",
  "round": 1
}'
```

Use for: sweep-style work (fix every crash, every TODO). The static plan models
one round; the `orchestrate` skill drives the loop until it converges.

## Orchestrate: build a whole project

The `orchestrate` skill turns a project brief into a finished build. It is a
7-step conversation protocol:

1. **Intake** — you dump project context; Claude writes a shared `CONTEXT.md`.
2. **Tech interview** — Claude asks about languages, frameworks, skills, MCP servers, priorities.
3. **Library resolution** — every library is pinned via the context7 MCP server.
4. **Architecture interview** — backend/frontend architecture and the design system.
5. **Workflow synthesis** — one `*.workflow.ts` per project phase, from the archetype templates.
6. **Phase summary + confirm** — Claude summarises each phase; nothing runs until you confirm.
7. **Dispatch loop** — agents are dispatched stage by stage, output validated, results chained, and sweep phases loop until they converge.

Ask Claude to *"orchestrate a project"* (or *"build this project"*) to start it.
The correctness mechanisms it applies — multi-vote verify, verify-until-dry,
explicit convergence — are distilled from Bun PR #30412 in
`skills/orchestrate/references/correctness.md`.

## Dataset: best practices from real runs

The plugin ships a **dataset** of real orchestrate-run records under `dataset/`.
Each entry is one project — its domain, stack, architecture, the workflows used,
the outcome, and the **lessons** that worked. `orchestrate` searches it before
designing architecture and synthesising workflows, so every new project starts
from accumulated experience instead of a blank page.

Search it three ways — all over the same scoring in `dataset/lib.ts`:

```bash
# CLI
bun run dataset/search.ts '{"domain":"rest-api","stack":["bun"],"keywords":["auth"]}'
```

- **MCP** — the plugin registers a `dataset-server` MCP server with the tools
  `dataset_search`, `dataset_get`, `dataset_stats`.
- **`dataset` skill** — tells Claude when and how to search, and helps you
  contribute. Ask *"search the dataset for X"* or *"contribute this to the dataset"*.

### Contributing

The dataset gets richer as people add real runs. After a project ships:

1. Add `dataset/entries/<id>.json` — see `dataset/README.md` and `schema.json`.
2. `bun run dataset/validate.ts` must print `N/N entries valid`.
3. Open a PR, or file a **Dataset contribution** issue
   (`.github/ISSUE_TEMPLATE/`) and let a maintainer add it.

Workflow/archetype improvements have their own issue form. CI typechecks, runs
the tests, and validates every dataset entry on each PR.

## Writing Custom Workflows

Create `.claude/workflows/<name>.workflow.ts`:

```typescript
import type { WorkflowMeta, WorkflowContext, JsonSchema } from "./src/types.ts";

export const meta: WorkflowMeta = {
  name: "my-workflow",
  description: "What this workflow does",
  args_schema: {
    type: "object",
    required: ["files"],
    properties: {
      files: { type: "array", items: { type: "string" } },
    },
  },
  phases: [
    { title: "Analyze", detail: "Analyze each file" },
    { title: "Report", detail: "Aggregate findings" },
  ],
};

const RESULT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["file", "issues"],
  properties: {
    file: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
};

export function execute({ args, agent, pipeline, phase, log }: WorkflowContext) {
  const files = args.files as string[];
  log(`analyzing ${files.length} files`);

  // Phase 1: Analyze each file in parallel
  phase("Analyze");
  pipeline(files, (file: string) =>
    agent(
      `Analyze ${file} for issues. Return ONLY valid JSON:\n${JSON.stringify(RESULT_SCHEMA, null, 2)}`,
      { label: `analyze:${file}`, phase: "Analyze", schema: RESULT_SCHEMA }
    )
  );

  // Phase 2: Aggregate
  phase("Report");
  // agent() calls here would be added to the plan

  return { total: files.length };
}
```

### Runtime API

The `WorkflowContext` passed to `execute()`:

| Method | Description |
|--------|-------------|
| `ctx.agent(prompt, opts)` | Register an agent call. Returns an `AgentCall` object. |
| `ctx.pipeline(items, stage)` | Run a stage function over items. Agents within a stage run in parallel. |
| `ctx.multiPipeline(items, ...stages)` | Multi-stage pipeline. Each stage receives previous stage's output. |
| `ctx.phase(title)` | Mark a phase for progress tracking. |
| `ctx.log(message)` | Structured log with timestamp. |
| `ctx.validate(value, schema)` | JSON Schema validation. Returns `{ ok, value }` or `{ ok, errors }`. |

### Agent Options

```typescript
ctx.agent(prompt, {
  label: "short-label",      // For logging and plan display
  phase: "Phase Name",       // Which phase this agent belongs to
  schema: { ... },           // JSON Schema for structured output
  agentType?: "backend-engineer",  // Optional Claude Code subagent type
});
```

## Architecture

### Single Source of Truth

Runtime files (`types.ts`, `runtime.ts`, `validator.ts`) are **symlinked** from the plugin into each project. Update the plugin once — all projects get the fix.

Templates are **copied** so each project can customize independently.

### Plan Builder

The runtime doesn't execute agents directly. It builds an **orchestration plan**:

1. Workflow's `execute()` is called with a recording context
2. Each `ctx.agent()` call records an `AgentCall` with prompt, schema, phase
3. `ctx.pipeline()` and `ctx.multiPipeline()` group agents into execution stages
4. Dependencies between stages are automatically linked
5. The plan is output as JSON or readable markdown

### Execution

Claude Code reads the plan and acts as the runtime:

1. **Stage by stage**: agents in the same stage spawn in parallel (multiple `Agent` tool calls in one message)
2. **Schema validation**: each agent is instructed to return JSON matching its schema
3. **Chaining**: results from stage N are injected into stage N+1 prompts
4. **Retry**: if validation fails, the agent gets one retry with error feedback

This separation means workflows are **inspectable** before execution and **testable** without Claude Code.

## Installing as a Claude Code Plugin

This repo is also a plugin **marketplace** (`.claude-plugin/marketplace.json`).
Install from inside Claude Code:

```
/plugin marketplace add github:xirothedev/claude-workflow-plugin
/plugin install claude-workflow-plugin@claude-workflow-plugin
```

`/plugin marketplace add` registers the repo; `/plugin install` adds the plugin.
Updates pull through `/plugin marketplace update claude-workflow-plugin`.

### Local development

To run the plugin from a working copy without the marketplace, add it to your
project's `.claude/settings.json`:

```json
{
  "projects": {
    "*": {
      "plugins": ["/path/to/claude-workflow-plugin"]
    }
  }
}
```

Or symlink globally:

```bash
mkdir -p ~/.claude/plugins
ln -s /path/to/claude-workflow-plugin ~/.claude/plugins/workflow
```

## File Structure

```
claude-workflow-plugin/
├── .claude-plugin/
│   ├── plugin.json                    # Plugin manifest
│   └── marketplace.json               # Marketplace manifest (/plugin install)
├── skills/
│   ├── workflow/
│   │   ├── SKILL.md                   # Skill definition (init, run, list, plan, create)
│   │   ├── src/                       # types.ts, runtime.ts, validator.ts
│   │   ├── scripts/init.ts            # Bootstrap script (generates .claude/workflows/)
│   │   ├── templates/                 # 5 archetype templates (*.workflow.ts)
│   │   └── tests/                     # bun test — validator, runtime, templates
│   ├── orchestrate/
│   │   ├── SKILL.md                   # Interactive project builder (7-step protocol)
│   │   └── references/correctness.md  # Bun PR #30412 correctness mechanisms
│   └── dataset/
│       └── SKILL.md                   # Search the dataset; contribute run records
├── dataset/
│   ├── schema.json                    # JSON Schema for a dataset entry
│   ├── entries/                       # one *.json run record per project
│   ├── lib.ts                         # load / validate / search (shared)
│   ├── search.ts                      # CLI: search the dataset
│   ├── validate.ts                    # CLI: validate entries (CI gate)
│   └── lib.test.ts                    # bun test
├── mcp/dataset-server.ts              # stdio MCP server over the dataset
├── .github/                           # issue forms, PR template, CI
├── examples/todo-api/                 # E2E trial spec for the orchestrate flow
├── tsconfig.json                      # strict typecheck config
├── package.json                       # dev tooling (test + typecheck)
└── README.md
```

## Comparison with Bun's Approach

| Aspect | Bun's Workflows | This Plugin |
|--------|----------------|-------------|
| Runtime | Internal JS runtime inside Claude Code | Bun builds plan, Claude Code executes |
| `agent()` | Calls internal API | Records plan, Claude spawns via Agent tool |
| `pipeline()` | Same pattern | Same pattern |
| Schema validation | In-process | Claude validates + one retry |
| File count | 53 workflow files | 5 templates + unlimited custom |
| Scope | Zig→Rust migration | General-purpose |
| Convergence loop | Live-async runtime (`agent()` returns a Promise) | Claude-driven; `survey-round` is the per-round plan |
| Skills | — | `workflow` (run one) + `orchestrate` (whole project) + `dataset` (search/contribute) |
| Learning across runs | One-off migration | Dataset of run records, searched by future runs |

## Requirements

- **Bun** — runtime for CLI and init script
- **Claude Code** — for executing workflow plans

## License

MIT
