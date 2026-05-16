# Bun PR #30412 — agent-orchestration workflows (TypeScript reference port)

A faithful TypeScript reimplementation of a representative subset of the
agent-orchestration workflows shipped in **Bun PR #30412** — *"rewrite Bun in
Rust"* — merged 2026-05-14 at commit `23427dbc12fdcff30c23a96a3d6a66d62fdc091d`.

These files are **reference ports**. They run only against a Bun-style *live*
agent runtime that satisfies the `WorkflowRuntime` contract in `runtime.ts`.
They are deliberately **not** runnable against this plugin's `cli.ts`, whose
static-plan model cannot express their core control flow (see *Runtime model*
below).

---

## What PR #30412 was

PR #30412 ported the Bun JavaScript runtime from **Zig to Rust** in a single
merge. The scale:

- **2188 files changed**, on the order of **+1,000,000 lines** of new Rust.
- The port was driven by **~170 concurrent agent workflows**, all editing the
  same git repo (`/root/bun-5`, branch `claude/phase-a-port`) simultaneously.
- The orchestration lived in `.claude/workflows/` as **53 `.workflow.js`
  files** — plain JavaScript executed by Bun's internal Claude Code harness.

The harness model: each `.workflow.js` file *body is the execution body*
(there is no `export function execute`). The runtime injects six ambient
globals — `args`, `agent`, `pipeline`, `parallel`, `phase`, `log` — and
evaluates the file. `agent()` genuinely spawns a sub-agent, runs it, validates
its JSON output against a supplied JSON Schema, and returns a Promise of that
output. Because the workflow can `await` and then *read* an agent's result, it
can branch, dedup, filter, sort, and loop on real data.

The port proceeded in lettered phases — A (draft translation), B (per-crate
compilation), C (linking + CLI smoke), D (filling `todo!()` stubs), G (test
suite) — plus cross-cutting analysis passes such as lifetime classification.
The six workflows ported here are the **six archetypes** that the other 47
files are variations of.

---

## The six archetypes

### 1. `phase-a-port` — the linear pipeline

**Problem.** Translate a batch of `.zig` source files into draft `.rs` files,
one agent per file, with quality control.

**Phases.** `Implement` -> `Verify` -> `Fix`.

**Pattern — 3-stage pipeline.** `pipeline(FILES, implement, verify, fix)`. Each
stage runs *its* items in parallel; the stages themselves are sequential. The
value an item carries into stage N is whatever stage N-1's thunk resolved to
for that item, plus the original input file.

**Why it's shaped this way.** Translation, adversarial verification, and
surgical fixing are three different agent jobs with different prompts and
schemas. Splitting them keeps each agent's context small and lets a cheap
verifier gate an expensive fixer. The destination `.rs` path is computed
deterministically (`rsPathFor`) and *forced* on the verifier/fixer — agents are
not trusted to pick file paths consistently. The Fix stage *branches on data*:
if the verifier returned zero must-fix issues, the file is marked `clean` and
**no fix agent is spawned at all**.

### 2. `phase-b1-tier` — the single-stage swarm with in-agent loop

**Problem.** Get each Rust crate in a dependency tier to `cargo check` green.

**Phases.** `Check` (one phase).

**Pattern — flat parallel fan-out.** One agent per crate, all in parallel. The
*loop* (`cargo check -> fix -> repeat`, capped at 25 rounds) lives **inside the
agent's prompt**, not in the workflow. The workflow just spawns the swarm and
aggregates `green` vs `failing`.

**Why it's shaped this way.** Crates within one tier are independent, so there
is no pipeline to build — only a fan-out. The compile-fix loop is tight and
local to one crate, so pushing it into the agent avoids round-tripping
compiler output through the orchestrator. This is the simplest archetype: pure
parallelism, no inter-stage data flow.

### 3. `phase-c-panic-swarm` — the round-loop-until-convergence

**Problem.** Once the binary links, run a battery of CLI commands, find every
panic, fix them, and repeat until all commands pass.

**Phases.** `Link` -> `Probe` -> `Fix`, re-entered each round.

**Pattern — round loop with mid-round dedup.**
```
for round 1..MAX:
  Link  : 1 agent gets `cargo build -p bun_bin` green
  if not linked -> record and continue/break
  Probe : N agents in parallel, one CLI command each
  if all probes pass -> early return
  dedup failures by panic location
  Fix   : 1 agent per UNIQUE panic location, in parallel
```

**Why it's shaped this way.** Panics are discovered, not known in advance. Many
different commands crash at the *same* source location, so the workflow dedups
`failed` probes by `panic_loc` before spawning fixers — fixing each root cause
once instead of once per symptom. The loop exists because a fix in round *N*
can expose a fresh panic that only surfaces in round *N+1*. The number of Fix
agents per round is **entirely data-dependent**.

### 4. `phase-d-todo-sweep` — the round loop with a verify-until-dry sub-loop

**Problem.** Replace every `todo!()` / `unimplemented!()` left behind by
earlier phases with a real implementation ported from the `.zig` spec.

**Phases.** `Survey` -> `Implement` -> `Verify` -> `Bugfix`, re-entered each
round.

**Pattern — round loop + pipeline + inner convergence loop.** Each round, one
`Survey` agent greps all `todo!()` sites and groups them by file. The files
flow through a 3-stage pipeline. Stage 2 (`Verify`) is itself a loop: it runs a
**2-vote** adversarial check up to 3 times, dedups discovered bugs by
`fn::what`, and stops as soon as an iteration finds *nothing new* — a
"verify-until-dry" convergence. A `seen` map biases each round's file ordering
toward files not yet visited, giving fair coverage across rounds.

**Why it's shaped this way.** `todo!()` count only shrinks as agents work, so
the outer loop runs until `Survey` reports zero. The inner verify-until-dry
loop trades agent budget for confidence: two independent verifiers catch more
than one, and re-running them until dry catches bugs exposed by the first
round's findings. Stage 3 (`Bugfix`) runs **only** for files that actually
have verified bugs.

### 5. `lifetime-classify` — the pipeline with sampled verification

**Problem.** Classify every raw-pointer struct field (`*T`, `?*T`, `*const T`)
in a set of `.zig` files into one of eleven Rust ownership categories
(`OWNED`, `SHARED`, `BORROW_PARAM`, `BACKREF`, `INTRUSIVE`, `FFI`, ...), so
Phase A agents can look up the correct Rust type per field instead of guessing.

**Phases.** `Classify` -> `Verify` -> `Synthesize`.

**Pattern — pipeline + statistically sampled 3-vote verify.** `Classify` runs
one agent per file. `Verify` does **not** check everything: it selects every
`UNKNOWN` / low-confidence field **plus a random 12% sample** of the confident
ones, then caps the selection so the total agent count stays under ~1000 at
scale. Each selected field gets a 3-vote adversarial refute; a field is
overturned only on a >=2/3 refute majority. `Synthesize` merges verdicts back
and emits the `LIFETIMES.tsv` artifact other workflows consume.

**Why it's shaped this way.** Verifying every classification 3x would blow the
agent budget; verifying none would let errors propagate into ~2000 ported
files. The 12%-sample-plus-cap is an explicit cost/confidence tradeoff. The
selection is both *data-dependent* (it reads how many fields came back
`UNKNOWN`) and *randomized* — neither is expressible without a live runtime.

### 6. `phase-g-test-swarm` — the round loop with an adversarial review gate

**Problem.** Run Bun's test suite, fix every crash, and verify each fix is a
*real* fix rather than a suppression.

**Phases.** `Survey` -> `Fix` -> `Review` -> `Refix`, re-entered each round.

**Pattern — round loop + pipeline with a conditional 4th stage.** Each round, a
sharded `Survey` agent runs the test files, categorizes them
`completing` / `crashing` / `hanging`, and dedups crash signatures. Unique
signatures (capped at 12) flow through a pipeline: `Fix` ports a real fix from
the `.zig` spec; `Review` runs a **2-vote** adversarial check ("is this a real
fix or an early-return suppression? UB? does the test actually complete?");
`Refix` runs **only when the review did not unanimously accept**, applying the
reviewer's bug list.

**Why it's shaped this way.** Under pressure to make tests pass, agents tend to
"fix" crashes by suppressing them (early returns, `#[allow]`, null-skips). The
adversarial review gate exists specifically to catch that, and `Refix` is a
data-dependent branch — it spawns an agent for a signature only if review
rejected the fix. Crash signatures, like panics in archetype 3, are discovered
per round, so the outer loop runs until a round is clean.

---

## Orchestration patterns at a glance

| Archetype             | Outer shape                    | Inner shape                          | Agent count known ahead? |
|-----------------------|--------------------------------|--------------------------------------|--------------------------|
| `phase-a-port`        | 3-stage pipeline               | conditional Fix stage                | yes (per batch)          |
| `phase-b1-tier`       | flat parallel swarm            | loop inside each agent               | yes                      |
| `phase-c-panic-swarm` | round-loop-until-convergence   | mid-round dedup -> parallel Fix      | no                       |
| `phase-d-todo-sweep`  | round-loop-until-convergence   | pipeline + verify-until-dry sub-loop | no                       |
| `lifetime-classify`   | 3-stage pipeline               | statistically sampled 3-vote verify  | no (sampled)             |
| `phase-g-test-swarm`  | round-loop-until-convergence   | pipeline + conditional Refix stage   | no                       |

---

## Why six ports — coverage of all 53 files

Bun's `.claude/workflows/` holds **53 `.workflow.js` files**, but they are not
53 distinct designs. They are **6 orchestration archetypes** instantiated 53
times — each file differs in its *prompts*, *JSON schemas*, and *target files*
(the Zig→Rust domain detail), not in its *control-flow structure*.

Example: `phase-d-todo-sweep` and `phase-f-accessor-sweep` are the same
"sweep" archetype — `grep survey → pipeline implement → verify` — they only
swap the grep pattern (`todo!()` vs an accessor idiom). Porting both would
duplicate the structure and copy domain prose; it adds no orchestration insight.

The 6 ports here cover the full **structural** surface. Every one of the other
47 files maps onto a ported archetype:

| Archetype (ported)       | Other Bun files sharing the structure |
|--------------------------|----------------------------------------|
| `phase-a-port` — pipeline | `phase-e-body-port`, `phase-e-proper-port`, `phase-d-bundler-perfile`, `phase-d-subtree-batch` |
| `phase-b1-tier` — swarm + in-agent loop | `phase-b0-cyclebreak`, `b0-movein`, `b0-moveout`, `b0-verify`, `b2-cycle`, `b2-fill`, `b2-fill-blocked`, `b2-fix-bugs`, `b2-keystone`, `b2-ungate-tier`, `b2-verify`, `phase-d-crate-shard`, `d-bundler-shard`, `d-build-queue`, `d-recursive-ungate`, `d-blocked-on-resolve`, `phase-e-mass-ungate`, `phase-e-test-bringup`, `phase-h-ci-tasks` |
| `phase-c-panic-swarm` — round-loop convergence | `phase-h-windows-singlefix`, `phase-h-windows-errors` |
| `phase-d-todo-sweep` — sweep (grep → fix sites) | `phase-d-unsafe-audit`, `phase-e-scopeguard-sweep`, `phase-f-accessor-sweep`, `phase-h-unsafe-wrap`, `phase-f-reviewed-refactor` |
| `lifetime-classify` — classify/audit + vote verify | `phase-h-idioms-audit`, `h-libuv-audit`, `h-classify-issues`, `h-dedup`, `h-deep-dive`, `h-diff-review`, `h-main-parity`, `h-portnotes-survey`, `porting-md-zigleakage` |
| `phase-g-test-swarm` — round loop + review gate | `phase-g-test-swarm-isolated`, `g-test-swarm-v3`, `g-mega-swarm`, `phase-f-test-swarm`, `f-probe-swarm`, `phase-h-windows-bughunt`, `h-windows-bughunt-wt`, `h-windows-testfix` |

53 = 6 ported + 47 structural variations. To study the *orchestration* — which
is the point of this folder — six is the complete set. Porting more would only
add Zig→Rust domain content, not new patterns.

---

## Runtime model

### Bun's model — a live async runtime

In Bun's harness, `agent(prompt, opts)` **is an async function**. It spawns the
sub-agent, waits for it to finish, validates the JSON output against
`opts.schema`, and returns a `Promise` resolving to that parsed value. The
workflow body runs as real code:

```ts
const survey = await agent(surveyPrompt, { schema: SURVEY_S, ... });
if (!survey || survey.total === 0) return { done: true };   // branch on data
const files = survey.files.filter(...).sort(...).slice(0, MAX);  // shape data
```

This makes three things possible that define every interesting archetype:

1. **Branching on agent output** — `phase-a-port` skips the Fix agent when the
   verifier found no must-fix issues; `phase-g-test-swarm` skips Refix when the
   review accepted.
2. **Dedup / filter / sample of agent output** — `phase-c` dedups panics by
   location, `lifetime-classify` random-samples which classifications to
   verify.
3. **Round-loop-until-convergence** — `for (let round = 1; round <= MAX; round++)`
   where the body re-spawns whole phases, the per-round work depends on what
   the previous round found, and the loop early-returns when the swarm
   converges (0 panics, 0 `todo!()`, 0 crashes).

### This plugin's model — a static plan

The workflow skill in `skills/workflow/src/` uses a **static-plan** runtime. There,
`agent()` returns a synchronous `AgentCall` *descriptor* — an id, the prompt,
the schema — and **never a value**. Running a workflow produces a
`WorkflowPlan`: a DAG of agent calls grouped into stages. `cli.ts` *then*
executes that plan.

Because `agent()` yields no data at plan time, the static model **cannot**:

- read an agent's result inside the workflow body,
- branch, dedup, filter, or sample on agent output,
- and — most importantly — **express a round-loop-until-convergence**. The loop
  bound (`while there are still panics`) depends on data that does not exist
  until agents have actually run; a static plan must enumerate every agent up
  front. `phase-a-port` and `phase-b1-tier` (fixed-shape pipelines / fan-outs)
  *could* be expressed statically, but `phase-c`, `phase-d`, and `phase-g`
  fundamentally cannot — their agent graph is discovered at runtime.

That is the core reason these ports target the live `WorkflowRuntime` contract
in `runtime.ts` rather than the plugin's `WorkflowContext`.

---

## Files

| File                              | Purpose                                            |
|-----------------------------------|----------------------------------------------------|
| `runtime.ts`                      | Typed live-runtime contract (`WorkflowRuntime`, `JsonSchema`, ...) |
| `phase-a-port.workflow.ts`        | Archetype 1 — linear pipeline                      |
| `phase-b1-tier.workflow.ts`       | Archetype 2 — single-stage swarm                   |
| `phase-c-panic-swarm.workflow.ts` | Archetype 3 — round-loop-until-convergence         |
| `phase-d-todo-sweep.workflow.ts`  | Archetype 4 — round loop + verify-until-dry        |
| `lifetime-classify.workflow.ts`   | Archetype 5 — pipeline + sampled 3-vote verify     |
| `phase-g-test-swarm.workflow.ts`  | Archetype 6 — round loop + adversarial review gate |

### Notes on the ports

- Each workflow `export`s `meta: WorkflowMeta` and
  `export async function execute(rt: WorkflowRuntime)`, destructuring
  `{ args, agent, pipeline, parallel, phase, log }` from `rt` — this replaces
  Bun's ambient globals.
- Phase structure, JSON schemas, round loops, dedup logic, `history`/`seen`
  state, and all data-dependent branching/early returns are preserved faithfully.
- Agent prompt strings are faithful; extremely long prose bodies were condensed.
  Every instruction affecting control flow or output shape is kept; trimmed
  spots are marked `// (prompt condensed from original)`.
- Typechecked clean with `bunx tsc --noEmit --strict`.
