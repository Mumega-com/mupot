# GATE VERDICT — mupot PR #1179 @ 165a0ff8e8806a7afe53ce72b3dac767fb9cfb92

VERDICT: [PASS/BLOCK — filled after mutation results]
Gate: Athena (mupot agent a9423609, seat athena) — posted via the owner's gh credential as transport; content attribution is Athena, not the author. Author does not self-gate.
Head verified EXACT: 165a0ff8e8806a7afe53ce72b3dac767fb9cfb92 (unmoved since assignment). Base divergence noted: PR is 1 commit behind main (2c7d078, #1180 merged 2026-08-18T21:08Z); CI ran against 5b0ca738. Re-run CI after syncing main before merge.

## Attack point 1 — Is unlimited-by-default safe?
CODE-VERIFIED (src/agents/execute.ts:192-196, src/agents/loop.ts:294-300): every flight-path model call runs meter.checkAndReserve BEFORE spend, with budgetCapCents = agent.budget_cap_cents. Day caps MAX_DISPATCHES_PER_DAY=200 / MAX_TOKENS_PER_DAY=200_000 are enforced unconditionally; parseCap (meter.ts) only accepts env overrides that parse to a finite number > 0, so the caps cannot be disabled by config — only raised. On THIS path the claim "uncapped in dollars is not unbounded" HOLDS.
CAVEAT (matches bot P1 #3): the flight's REQUESTED budget is NOT enforced during execution — checkAndReserve is never passed a micro cap; the requested budget is checked only at flight_land (src/mcp/index.ts:2107-2111), after spend, against the executor's SELF-REPORTED cost_micro_usd. The PR's code comment "the flight's own requested budget still bounds it" OVERSTATES: it bounds at landing, not during execution. Residual exposure for metered (non-rationed) agents is bounded by the day caps, but a flight can spend past its request and then be unable to land.
Context: pre-existing unmetered model-call surfaces exist (agent-do think(), loops/outreach.ts, loops/cro.ts) — NOT on the flight dispatch path, NOT touched by this PR. Noted, out of scope.
Owner decision (Hadi 2026-08-18) + task body ("explicit HOLD, not the answer") + rationed fleet = the loosening is a deliberate stopgap, not the spend model.

## Attack point 2 — Min computation
- Mixed (one configured, one not): binding = min over CONFIGURED only; unconfigured can never be the binding minimum and never collapses to zero (src/mcp/index.ts:1944-1950). Test covers executor-null/squad-100 with 1_000_001 refused and named.
- All-unconfigured: ceiling = requestedBudget (branch guard is requestedBudget > 0, so never zero). Test covers budget=1 with cap=0 → ok:true.
- Tie diagnosis: reduce uses strict <, so on a tied minimum only ONE row is reported as binding (bot P2). Ceiling number is still correct; this is a diagnostic gap, not a correctness bug.

## Attack point 3 — budget_uncapped observability
- Populated for every source with null/≤0 cap and returned on BOTH success paths (delivered:true line 2065 AND delivered:false line 2068).
- Only computed when requestedBudget > 0 — correct (a budgetless flight asks no dollar question).
- [M6 result: the delivered:false path is exercised by NO new test — pending mutation confirmation]

## Attack point 4 — Mutation check (not trusted, mutated)
Kasra's claimed M1-M5 on commit 1: not re-run by me; I mutated commit 2's NEW code instead:
[M1-M8 table — filled from shell-executor results]

## Attack point 5 — No behaviour change for current passers
All-configured sets (the only callers that currently PASS): identical predicate (valid = number, safe-int, > 0), identical ceiling (min*10_000), identical 409 for over-budget. Changes are additive detail (binding named in the 409) and an extra success field (budget_uncapped = [] for all-configured). Callers with 0/negative/invalid rows previously got 409 and now admit — they were failing, not passing, and the new read matches meter.ts semantics (null/≤0 ⇒ unlimited at the enforcement layer, meter.ts:151-156).

## Other verified claims
- 0009_work_unit.sql:39,49: budget_cap_cents INTEGER nullable, no default, on agents AND squads. ✓
- org/service.ts:195-203, 393-401: create paths leave it null when omitted. ✓
- CI 14/14 green on the ref (verified via check-runs API); mergeable clean. Full-suite/typecheck re-verified locally: [companion results].
- Bot P1 #1 (mock harness): tests extend tests/mcp-flight-tools.test.ts, which sits in the scripts/test-schema-source-baseline.json 'files' baseline (shrink-only ratchet). The new assertions therefore inherit the mock's blind spot (they can pass while production SQL drifts) but the diff adds NO new SQL — the risk is muted for this change. Repo policy does not require converting the whole baselined file in this PR.

## Residual findings (non-blocking, for the record)
R1. PR comment overstates budget enforcement (see point 1). Recommend a one-line comment fix or a note in #1148.
R2. budgetRemainingMicroUsd VALUE on the success payload is asserted nowhere (tests check preflight.go/reasons only) [M7].
R3. Tied-min binding identity is arbitrary + untested [M8, bot P2].
R4. budget_uncapped on the delivered:false path is untested [M6].
R5. PR is 1 commit behind main — CI must be re-run after sync (author's step, not the gate's).
