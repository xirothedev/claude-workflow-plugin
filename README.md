# claude-workflow-plugin

Multi-phase agent orchestration plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Inspired by [Bun's migration workflow pattern](https://github.com/oven-sh/bun/pull/30412).

Define workflows as TypeScript modules. The runtime builds an orchestration plan with agents, schemas, and execution stages. Claude Code executes the plan — spawning agents in parallel, validating structured JSON output, and chaining results between stages.

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
├── skills/workflow/
│   ├── SKILL.md                       # Skill definition (init, run, list, plan, create)
│   ├── src/
│   │   ├── types.ts                   # TypeScript type definitions
│   │   ├── runtime.ts                 # Plan builder, formatter, module loader
│   │   └── validator.ts              # Minimal JSON Schema validator
│   ├── scripts/
│   │   └── init.ts                   # Bootstrap script (generates .claude/workflows/)
│   └── templates/
│       ├── single-agent.workflow.ts   # One agent + schema validation
│       ├── multi-stage.workflow.ts    # implement → verify → fix pipeline
│       └── parallel-swarm.workflow.ts # N agents parallel + aggregate
└── README.md
```

## Comparison with Bun's Approach

| Aspect | Bun's Workflows | This Plugin |
|--------|----------------|-------------|
| Runtime | Internal JS runtime inside Claude Code | Bun builds plan, Claude Code executes |
| `agent()` | Calls internal API | Records plan, Claude spawns via Agent tool |
| `pipeline()` | Same pattern | Same pattern |
| Schema validation | In-process | Claude validates + one retry |
| File count | 53 workflow files | 3 templates + unlimited custom |
| Scope | Zig→Rust migration | General-purpose |

## Requirements

- **Bun** — runtime for CLI and init script
- **Claude Code** — for executing workflow plans

## License

MIT
