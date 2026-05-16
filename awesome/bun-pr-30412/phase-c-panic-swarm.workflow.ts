/**
 * phase-c-panic-swarm — link bun-rs, probe N commands, dedup panics, fix, repeat.
 *
 * Faithful TypeScript port of Bun PR #30412's `phase-c-panic-swarm.workflow.js`.
 *
 * Orchestration pattern: ROUND-LOOP-UNTIL-CONVERGENCE.
 *   for round 1..MAX:
 *     Link  -> one agent gets `cargo build -p bun_bin` green
 *     Probe -> N agents in parallel run one CLI command each, report panics
 *     dedup panics by location -> Fix -> one agent per UNIQUE panic, parallel
 *   exit early the first round all probes pass.
 *
 * This shape is only expressible on a live runtime: the loop branches on
 * `link.linked` and `failed.length`, and the number of Fix agents depends on
 * how many distinct panic locations the Probe round actually discovered.
 */
import type { JsonSchema, WorkflowMeta, WorkflowRuntime } from "./runtime.ts";

export const meta: WorkflowMeta = {
  name: "phase-c-panic-swarm",
  description: "Link bun-rs, run N commands in parallel, dedup panics, fix each in parallel, repeat",
  phases: [
    { title: "Link", detail: "workspace->0, cargo build -p bun_bin" },
    { title: "Probe", detail: "run N commands, collect panics" },
    { title: "Fix", detail: "one agent per unique panic location" },
  ],
};

interface ProbeCommand {
  cmd: string[];
  name: string;
  expect_contains?: string;
  expect_exact?: string;
  setup?: string;
}

interface LinkResult {
  linked: boolean;
  errors_fixed?: number;
  regated?: string[];
  notes?: string;
}

interface ProbeResult {
  name: string;
  exit: number;
  stdout: string;
  stderr: string;
  panic_loc: string | null;
  panic_msg: string | null;
  passed: boolean;
}

interface FixResult {
  loc: string;
  fixed: boolean;
  action: "fix-forward" | "re-gate" | "extern" | "logic";
  files?: string[];
  notes?: string;
}

/** A deduped unique failure point passed to a Fix agent. */
interface UniqueFailure {
  loc: string | null;
  cmds: string[];
  sample: ProbeResult;
}

const DEFAULT_COMMANDS: ProbeCommand[] = [
  { cmd: ["--help"], expect_contains: "Usage", name: "help" },
  { cmd: ["--version"], expect_contains: ".", name: "version" },
  { cmd: ["-e", "console.log(1)"], expect_exact: "1", name: "eval-log" },
  { cmd: ["-e", "1+1"], expect_exact: "", name: "eval-expr" },
  { cmd: ["-p", "1+1"], expect_exact: "2", name: "print-expr" },
  {
    cmd: ["run", "/tmp/pc-hello.js"],
    expect_exact: "hello",
    name: "run-js",
    setup: "echo 'console.log(\"hello\")' > /tmp/pc-hello.js",
  },
  {
    cmd: ["run", "/tmp/pc-hello.ts"],
    expect_exact: "42",
    name: "run-ts",
    setup: "echo 'const x: number = 42; console.log(x)' > /tmp/pc-hello.ts",
  },
  { cmd: ["/tmp/pc-hello.js"], expect_exact: "hello", name: "auto-js" },
  {
    cmd: ["run", "/tmp/pc-req.js"],
    expect_exact: "3",
    name: "run-cjs",
    setup:
      "echo 'const {add}=require(\"/tmp/pc-mod.js\");console.log(add(1,2))' > /tmp/pc-req.js && echo 'exports.add=(a,b)=>a+b' > /tmp/pc-mod.js",
  },
  {
    cmd: ["run", "/tmp/pc-imp.mjs"],
    expect_exact: "3",
    name: "run-esm",
    setup:
      "echo 'import {add} from \"/tmp/pc-emod.mjs\";console.log(add(1,2))' > /tmp/pc-imp.mjs && echo 'export const add=(a,b)=>a+b' > /tmp/pc-emod.mjs",
  },
  { cmd: ["-e", 'await Bun.sleep(1);console.log("ok")'], expect_exact: "ok", name: "eval-await" },
  { cmd: ["-e", "console.log(JSON.stringify({a:1}))"], expect_exact: '{"a":1}', name: "eval-json" },
  { cmd: ["build", "--help"], expect_contains: "build", name: "build-help" },
  { cmd: ["install", "--help"], expect_contains: "install", name: "install-help" },
  { cmd: ["test", "--help"], expect_contains: "test", name: "test-help" },
];

const PROBE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["name", "exit", "stdout", "stderr", "panic_loc", "passed"],
  properties: {
    name: { type: "string" },
    exit: { type: "number" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    panic_loc: { type: ["string", "null"] },
    panic_msg: { type: ["string", "null"] },
    passed: { type: "boolean" },
  },
};

const LINK_SCHEMA: JsonSchema = {
  type: "object",
  required: ["linked"],
  properties: {
    linked: { type: "boolean" },
    errors_fixed: { type: "number" },
    regated: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

const FIX_SCHEMA: JsonSchema = {
  type: "object",
  required: ["loc", "fixed", "action"],
  properties: {
    loc: { type: "string" },
    fixed: { type: "boolean" },
    action: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

const HARD_RULES = `**HARD RULES:** Never \`git reset/checkout/restore/stash/clean\`. Never edit .zig. ~170 wfs editing concurrently — re-read files before edit, retry on race. Commit: \`git -c core.hooksPath=/dev/null add -A 'src/' Cargo.* && git -c core.hooksPath=/dev/null commit -q -m "phase-c: <what>" && git -c core.hooksPath=/dev/null push origin claude/phase-a-port\`.`;

export async function execute(rt: WorkflowRuntime): Promise<unknown> {
  const { args, agent, parallel, phase, log } = rt;

  const COMMANDS = (args.commands as ProbeCommand[]) || DEFAULT_COMMANDS;
  const MAX_ROUNDS = (args.max_rounds as number) || 6;

  const history: unknown[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    phase("Link");
    log(`round ${round}: linking`);
    // (prompt condensed from original)
    const link = await agent<LinkResult>(
      `Get \`cargo build -p bun_bin\` to succeed. Repo /root/bun-5 @ HEAD.

Current: workspace ~65 errs (oscillating). Loop: \`cargo build -p bun_bin 2>&1 | tail -60\` -> if compile error, fix-forward (re-gate broken module ONLY if >50 errs in one crate); commit; repeat. Max 15 cycles. ${round > 1 ? "Prior rounds may have broken things — re-read before edit." : ""}

${HARD_RULES}

Return {linked: bool, errors_fixed: N, regated: [crate/module], notes}.`,
      { label: `link-r${round}`, phase: "Link", schema: LINK_SCHEMA },
    );

    if (!link || !link.linked) {
      history.push({ round, link, probes: [], fixes: [] });
      log(`round ${round}: LINK FAILED — ${link && link.notes}`);
      if (round === MAX_ROUNDS) break;
      continue;
    }

    phase("Probe");
    log(`round ${round}: probing ${COMMANDS.length} commands`);
    const probes = (
      await parallel<ProbeResult>(
        COMMANDS.map((c) => () => {
          const expectClause =
            c.expect_exact !== undefined
              ? `stdout.trim() === ${JSON.stringify(c.expect_exact)}`
              : `stdout.includes(${JSON.stringify(c.expect_contains)})`;
          // (prompt condensed from original)
          return agent<ProbeResult>(
            `Run ONE command against bun-rs and report result. Repo /root/bun-5.

${c.setup ? `Setup: \`${c.setup}\`\n` : ""}Run: \`RUST_BACKTRACE=1 timeout 2 ./target/debug/bun-rs ${c.cmd
              .map((a) => `'${a}'`)
              .join(" ")} 2>&1\`

Capture stdout+stderr (first 4000 chars). Extract panic location (regex \`panicked at '?([^']*)'?, ?([^:]+:[0-9]+:[0-9]+)\` or \`panicked at ([^:]+:[0-9]+:[0-9]+)\` — return file:line:col). If "not yet implemented" or "todo", panic_loc = the file:line. passed = exit==0 && ${expectClause}.

DO NOT edit files. DO NOT commit. Just probe and report.

Return {name:${JSON.stringify(c.name)}, exit, stdout, stderr, panic_loc, panic_msg, passed}.`,
            { label: `probe:${c.name}`, phase: "Probe", schema: PROBE_SCHEMA },
          );
        }),
      )
    ).filter(Boolean);

    const passed = probes.filter((p) => p.passed);
    const failed = probes.filter((p) => !p.passed);
    log(`round ${round}: ${passed.length}/${probes.length} pass — ${passed.map((p) => p.name).join(",")}`);

    if (failed.length === 0) {
      history.push({ round, link, probes, fixes: [], all_pass: true });
      return { rounds: round, all_pass: true, passed: passed.map((p) => p.name), history };
    }

    // Dedup by panic location (or by stderr-head if no panic_loc).
    const byLoc: Record<string, UniqueFailure> = {};
    for (const p of failed) {
      const key = p.panic_loc || `noloc:${(p.stderr || p.stdout || "").slice(0, 200)}`;
      if (!byLoc[key]) byLoc[key] = { loc: p.panic_loc, cmds: [], sample: p };
      byLoc[key].cmds.push(p.name);
    }
    const unique = Object.values(byLoc);
    log(`round ${round}: ${unique.length} unique failure points`);

    phase("Fix");
    const fixes = (
      await parallel<FixResult>(
        unique.map((u) => () => {
          const repro = u.sample.name === "help" ? "--help" : u.cmds[0];
          // (prompt condensed from original)
          return agent<FixResult>(
            `Fix ONE panic/failure in bun-rs. Repo /root/bun-5 @ HEAD.

**Failing commands:** ${u.cmds.join(", ")}
**Panic location:** ${u.loc || "(no panic — see output)"}
**Panic message:** ${u.sample.panic_msg || "(none)"}
**Sample output (${u.sample.name}):**
\`\`\`
${(u.sample.stderr || u.sample.stdout || "").slice(0, 3000)}
\`\`\`

**Decide:**
- If location is in cli/run_command/jsc_hooks/VirtualMachine/ModuleLoader/Transpiler/js_parser/lexer/js_printer/event_loop -> **FIX FORWARD** (port the real body from the .zig spec at the same path).
- If location is in css/install/shell/test_runner/bundler-linker/bake AND none of the failing commands need it -> **RE-GATE the call site** (\`#[cfg(any())]\` or graceful degrade), NOT the body.
- If it's a missing extern symbol -> add to phase_c_exports.rs or find the real C export.
- If output is wrong but no panic -> trace and fix the logic.

Read the .zig spec for the function. Reproduce first: \`RUST_BACKTRACE=full timeout 2 ./target/debug/bun-rs '${repro}'\`. After fix: \`cargo build -p bun_bin && <re-run cmd>\`. Commit.

${HARD_RULES}

Return {loc, fixed: bool, action: "fix-forward"|"re-gate"|"extern"|"logic", files: [...], notes}.`,
            { label: `fix:${u.loc || u.cmds[0]}`, phase: "Fix", schema: FIX_SCHEMA },
          );
        }),
      )
    ).filter(Boolean);

    history.push({
      round,
      link,
      probes_pass: passed.map((p) => p.name),
      probes_fail: failed.map((p) => ({ name: p.name, loc: p.panic_loc })),
      unique_locs: unique.length,
      fixes,
    });
  }

  return { rounds: MAX_ROUNDS, all_pass: false, history };
}
