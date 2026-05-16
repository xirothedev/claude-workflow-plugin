# Correctness mechanisms — distilled from Bun PR #30412

Bun rewrote itself Zig→Rust across 6755 commits driven by ~170 concurrent
`.claude/workflows/*.js` files (PR #30412, merged 2026-05-14). The output landed
"without mistakes" not because the agents were perfect, but because the workflows
made wrong output **visible and self-correcting**. These are the 7 mechanisms.
Apply them in `orchestrate` Step 7. Full source: `awesome/bun-pr-30412/`.

---

## 1. Schema-validated agent output

Every `agent()` call carries a `JsonSchema`. Output that does not validate is
**rejected before it is used** — a malformed result never silently flows downstream.

**Apply:** every workflow agent already has a `schema`. Validate, and on failure
retry once with the validation errors fed back.

## 2. Await-and-read branching

The workflow reads an agent's actual result and branches on the data — it does not
follow a fixed script.

**Apply:** read each stage's output before dispatching the next. Skip work the data
says is unnecessary; do not dispatch agents whose input no longer exists.

## 3. Data-dependent agent count

The number of agents in a round is discovered at runtime, not pre-enumerated. Bun's
panic-swarm spawned exactly one Fix agent per **unique** panic location.

**Apply:** per round, derive the target list from the Survey result. Round N+1's
agent count depends on what round N found.

## 4. Verify-until-dry

A verify pass re-runs until an iteration finds **zero new** issues (deduped by
identity). Two independent verifiers catch more than one; re-running catches issues
exposed by earlier fixes. It stops the moment a pass is dry — bounded cost.

**Apply:** inside a round, re-verify until no new issue appears, then move on.

## 5. Adversarial multi-vote review gate

Under pressure to "make it pass", a single agent suppresses errors (early return,
broad `catch`, `#[allow]`, null-skip) instead of fixing them. **Independent
reviewers vote**; majority rule decides. A fix only stands if the majority accepts.

**Apply:** `verified-swarm` runs 3 voters/item, `survey-round` runs 2/target. Run
the Fix agent for an item **only if the majority rejected it**.

## 6. Explicit convergence early-return

A round-loop does not run a fixed count. Each round a Survey agent inspects the
**actual state**; the loop exits the instant the state is empty (0 panics left,
0 `todo!()` left, all tests green). A `MAX_ROUNDS` cap guards non-convergence.

**Apply:** loop on `survey.remaining == 0`, not on a round counter. Cap at
`MAX_ROUNDS` and report if the cap is hit.

## 7. Fair sharding via history

A `seen` map carried across rounds biases each round's ordering toward items not
yet visited — every item gets attention, no manual coordination.

**Apply:** track handled items across rounds; order each round toward the unseen.

---

## Checklist for Step 7

- [ ] Every agent output validated against its schema; one retry on failure.
- [ ] Stage N output read before stage N+1 is dispatched.
- [ ] Targets derived from the Survey result, not hard-coded.
- [ ] Verify re-runs until a pass finds nothing new.
- [ ] Fix dispatched only for items the majority vote rejected.
- [ ] Loop exits on `remaining == 0`; `MAX_ROUNDS` cap enforced.
- [ ] Items deduped by location/signature; unseen items prioritised each round.
