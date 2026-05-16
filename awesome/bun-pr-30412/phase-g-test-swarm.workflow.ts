/**
 * phase-g-test-swarm — per-test-file crash sweep with 2-vote review.
 *
 * Faithful TypeScript port of Bun PR #30412's `phase-g-test-swarm.workflow.js`.
 *
 * Orchestration pattern: ROUND-LOOP + PIPELINE with adversarial review gate.
 *   for round 1..MAX:
 *     Survey -> one agent runs every test file in this shard, categorizes
 *               completing / crashing / hanging, dedups crash signatures
 *     pipeline over unique crash signatures (capped at 12):
 *       Fix    -> root-cause + real fix from .zig spec, commit
 *       Review -> 2-vote adversarial: real fix? semantics preserved? UB?
 *       Refix  -> only runs if review REJECTED, applies reviewer bug list
 *   exit early the first round with 0 crashes and 0 hangs.
 *
 * The Refix stage is data-dependent: it spawns an agent only when the 2-vote
 * review did not unanimously accept — a branch the static-plan model can't take.
 */
import type { JsonSchema, WorkflowMeta, WorkflowRuntime } from "./runtime.ts";

export const meta: WorkflowMeta = {
  name: "phase-g-test-swarm",
  description: "Per-test-file: run -> categorize crash/fail -> fix root cause -> 2-vote review -> loop until completing",
  phases: [
    { title: "Survey", detail: "run all test files, categorize: completing / crashing / hanging" },
    { title: "Fix", detail: "one agent per crash signature: root-cause + REAL fix from .zig spec" },
    { title: "Review", detail: "2-vote adversarial: did fix change semantics? introduce UB?" },
    { title: "Refix", detail: "apply reviewer findings" },
  ],
};

interface CrashEntry {
  file: string;
  signature: string;
  backtrace_top?: string;
}

interface SurveyResult {
  completing: string[];
  crashing: CrashEntry[];
  hanging?: string[];
  total: number;
}

interface FixResult {
  signature: string;
  root_cause: string;
  files_touched?: string[];
  commit: string;
  files_now_completing?: string[];
  notes?: string;
}

interface ReviewBug {
  file: string;
  what: string;
  fix: string;
  severity: string;
}

interface ReviewResult {
  accept: boolean;
  bugs: ReviewBug[];
}

/** A deduped crash signature with the files that hit it. */
interface UniqueSig {
  sig: string;
  files: string[];
  sample: string;
}

/** Value carried out of the Review stage into the Refix stage. */
interface ReviewCarry {
  sig: string;
  fix: FixResult;
  accepted: boolean;
  bugs: ReviewBug[];
}

const SURVEY_S: JsonSchema = {
  type: "object",
  required: ["completing", "crashing", "total"],
  properties: {
    completing: { type: "array", items: { type: "string" } },
    crashing: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "signature"],
        properties: {
          file: { type: "string" },
          signature: { type: "string" },
          backtrace_top: { type: "string" },
        },
      },
    },
    hanging: { type: "array", items: { type: "string" } },
    total: { type: "number" },
  },
};

const FIX_S: JsonSchema = {
  type: "object",
  required: ["signature", "root_cause", "commit"],
  properties: {
    signature: { type: "string" },
    root_cause: { type: "string" },
    files_touched: { type: "array", items: { type: "string" } },
    commit: { type: "string" },
    files_now_completing: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

const REVIEW_S: JsonSchema = {
  type: "object",
  required: ["accept", "bugs"],
  properties: {
    accept: { type: "boolean" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "what", "fix", "severity"],
        properties: {
          file: { type: "string" },
          what: { type: "string" },
          fix: { type: "string" },
          severity: { type: "string" },
        },
      },
    },
  },
};

const HARD = `**HARD RULES:** Work in /root/bun-5 on branch claude/phase-a-port. REAL fixes (port from .zig spec), NOT stubs/suppressions/early-returns. Never git reset/checkout/stash/rebase/pull. **Commit with EXPLICIT paths only:** \`git -c core.hooksPath=/dev/null add 'src/' Cargo.toml Cargo.lock && git commit -q -m "..."\` — NEVER \`git add -A\` or \`git add .\` (sweeps in heapsnapshots/coredumps with env secrets). NO push.`;

export async function execute(rt: WorkflowRuntime): Promise<unknown> {
  const { args, agent, pipeline, parallel, phase, log } = rt;

  // Bun's harness sometimes passes args as a JSON string; handle both.
  const A: Record<string, unknown> =
    typeof args === "string" ? (JSON.parse(args as string) as Record<string, unknown>) : args || {};
  const SHARD = (A.shard as number) || 0;
  const NSHARDS = (A.nshards as number) || 1;
  const MAX_ROUNDS = (A.max_rounds as number) || 8;
  const TEST_GLOB = (A.test_glob as string) || "test/js/bun/**/*.test.{js,ts}";

  const history: unknown[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // -- Survey --
    phase("Survey");
    // (prompt condensed from original)
    const survey = await agent<SurveyResult>(
      `Survey test files (shard ${SHARD}/${NSHARDS}, round ${round}). Repo /root/bun-5.

1. List files: \`ls ${TEST_GLOB}\` (or fd/glob). Take every ${NSHARDS}th file starting at ${SHARD}.
2. For each (timeout 30s): \`timeout 30 bun bd test <file> 2>&1\`
3. Categorize:
   - **completing**: exits 0/1 with "X pass / Y fail" line, no crash
   - **crashing**: SIGSEGV/SIGABRT/panic/ASAN/RELEASE_ASSERT — extract signature (top frame + assert message)
   - **hanging**: timeout fired, no output

**Dedup crash signatures**: many files crash on the same root cause. Group by signature.

Return {completing:[files], crashing:[{file,signature,backtrace_top}], hanging:[files], total:N}. DO NOT edit src/.`,
      { label: `survey-s${SHARD}-r${round}`, phase: "Survey", schema: SURVEY_S },
    );

    if (!survey) {
      history.push({ round, error: "survey failed" });
      continue;
    }

    log(
      `r${round}: ${survey.completing.length}/${survey.total} completing, ${survey.crashing.length} crashing, ${(survey.hanging || []).length} hanging`,
    );
    if (survey.crashing.length === 0 && (survey.hanging || []).length === 0) {
      return { rounds: round, done: true, completing: survey.completing.length, total: survey.total, history };
    }

    // Dedup crash signatures -> unique root causes
    const sigs: Record<string, string[]> = {};
    for (const c of survey.crashing) {
      (sigs[c.signature] ||= []).push(c.file);
    }
    const unique: UniqueSig[] = Object.entries(sigs)
      .map(([sig, files]) => ({ sig, files, sample: files[0] }))
      .slice(0, 12);

    // -- Fix per signature, pipelined to review --
    await pipeline<UniqueSig>(
      unique,
      // Stage 1: Fix
      (_input, u) => {
        const affected =
          u.files.slice(0, 10).join(", ") + (u.files.length > 10 ? ` (+${u.files.length - 10} more)` : "");
        // (prompt condensed from original)
        return agent<FixResult>(
          `Fix crash signature in /root/bun-5. ${u.files.length} test files hit this:

**Signature:** ${u.sig}
**Sample:** \`bun bd test ${u.sample} 2>&1\`
**Affected files:** ${affected}

**Process:**
1. Reproduce with the sample file. Get full backtrace.
2. Find the root cause (NOT the symptom). Read .zig spec at the relevant path.
3. Common patterns: stub returning JSValue::default() (check js_class_mod!/webcore.rs:64), missing promiseHandlerID registration (ZigGlobalObject.cpp:3772), Option<*mut> layout mismatch, missing #[no_mangle] export.
4. Port REAL fix. Commit.
5. Re-run sample -> must complete (pass/fail OK, crash NOT OK).

${HARD}

Return {signature:"${u.sig}", root_cause, files_touched, commit, files_now_completing, notes}.`,
          { label: `fix:${u.sig.slice(0, 40)}`, phase: "Fix", schema: FIX_S },
        );
      },
      // Stage 2: Review (2-vote adversarial)
      (input, u) => {
        const fix = input as unknown as FixResult | null;
        if (!fix) return null;
        return parallel<ReviewResult>(
          [0, 1].map(
            (i) => () =>
              // (prompt condensed from original)
              agent<ReviewResult>(
                `Adversarially review fix for crash "${u.sig}". Repo /root/bun-5 @ HEAD.

Fixer claims root_cause: ${fix.root_cause}
Diff: \`git diff ${fix.commit}~1..${fix.commit}\`

**Check:**
1. Does the fix match the .zig spec semantics? Read the .zig.
2. Is it a REAL fix or a suppression (early-return/if-null-skip/allow attr)?
3. UB introduced?
4. Does \`bun bd test ${u.sample}\` actually complete now?

accept:true ONLY if real fix + no UB + test completes. DO NOT edit.

Return {accept, bugs:[{file,what,fix,severity}]}.`,
                { label: `review${i}:${u.sig.slice(0, 30)}`, phase: "Review", schema: REVIEW_S },
              ),
          ),
        ).then((votes): ReviewCarry => {
          const bugs = (votes || []).filter(Boolean).flatMap((v) => v.bugs || []);
          const accepted = (votes || []).filter(Boolean).length >= 2 && votes.every((v) => v && v.accept);
          return { sig: u.sig, fix, accepted, bugs };
        });
      },
      // Stage 3: Refix — only when review rejected
      (input, u) => {
        const vr = input as unknown as ReviewCarry | null;
        if (!(vr && !vr.accepted && vr.bugs.length > 0)) return vr;
        const bugList = vr.bugs
          .map((b, i) => `${i + 1}. [${b.severity}] ${b.file}: ${b.what}\n   FIX: ${b.fix}`)
          .join("\n");
        // (prompt condensed from original)
        return agent<FixResult>(
          `Re-fix "${u.sig}" — review REJECTED.

**${vr.bugs.length} bugs:**
${bugList}

Apply each. Read .zig spec. Re-run sample. Commit.

${HARD}

Return {signature, root_cause, files_touched, commit, files_now_completing, notes}.`,
          { label: `refix:${u.sig.slice(0, 30)}`, phase: "Refix", schema: FIX_S },
        );
      },
    );

    history.push({ round, completing: survey.completing.length, total: survey.total, sigs: unique.length });
  }

  return { rounds: MAX_ROUNDS, done: false, history };
}
