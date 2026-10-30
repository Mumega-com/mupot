# Routine human-review timeout

The flight watchdog evaluates **flights**, not the routine run's waiting reason.
Its execution timeout is 60 minutes by default, or `flight.meta.timeout_ms` clamped
to 5 minutes..24 hours. The clock starts at `resumed_at`, then `started_at`, then
`created_at`. A current proposal-bound decision resumes the execution budget
from `decided_at`; a later actual `resumed_at` takes precedence. Sleeping wake deadlines and ordinary flight waiting/escalation are
separate existing rules.

Proposal acceptance under a human-review policy calls `waitForHuman`: the action
waits at its gate, the control task enters review, the run becomes `waiting/review`,
and an append-only `approval_requested` event records the ask time. The control
flight stays **running**. Migration 0172 deliberately excludes routine-bound
flights from task-driven `running -> waiting` transitions because the routine owns
their eventual landing. The old watchdog therefore used the execution clock while
a human was deciding. The reported 05:12 proposal / 06:16 reap is this mismatch.

Reaping cannot simply be disabled: hung executors and missed wake deadlines still
need bounded failure. The reaper also terminalizes linked routine runs so a dead
flight does not pin every later cron occurrence as `overlap` (#1369).

## Separate review clock

- A current, same-tenant/project review binding uses its server
  `approval_requested` receipt instead of the flight execution age. The current
  proposal/action key, attempt (when recorded), action phase and source task must
  match. The producer must be system `mupot-routines`; ambiguous active flight/run
  bindings, missing/invalid receipts and invalid snapshots grant no exemption.
- The default review window is **24 hours**. An operator may set
  `ROUTINE_REVIEW_WINDOW_MS` from `86400000` through `604800000` (24h..7d). Invalid
  values use 24h. New asks snapshot the absolute `review_deadline_at` in existing
  event metadata. Configuration changes and duplicate submissions cannot extend a
  pending ask. Legacy events without a snapshot get exactly 24h from their recorded
  `occurred_at`; mutable run/task `updated_at` is never the review clock.
- At `now >= deadline`, the paired running control flight/run expires with
  **review_window_expired**. The receipt's predicate and the run failure summary name
  review expiry, even when a direct reaper caller supplies an execution-timeout label.
  Existing exact-attempt task-repair fences block the current deterministic review
  control task with correlated failure/audit evidence. Legacy/ambiguous task IDs are
  not rewritten. No approval or successful landing is manufactured.
- The review clock ends when the current control task has a matching latest,
  unreversed `approved` or `rejected` verdict bound to this exact proposal and
  newer than its creation. Unbound, stale, wrong-task, reversed or superseded
  decisions grant no new clock. The run need not wait for an agent replay to
  stop sheltering an already-decided review. The ordinary execution timeout now
  runs from the later of the decision and the real physical execution baseline.
- Pending reviews are excluded before the bounded reap-candidate LIMIT, so they
  cannot hide a genuinely stuck flight. The UPDATE rechecks the review deadline and
  execution-clock baseline and decision timestamp, preventing review, resume or
  decision races after evaluation.
- Action execution refuses overdue or unproven review authorization. Starting an
  approved action, or queueing fresh observation after a long review, resumes the
  flight's execution clock. A running effect does not retain the human-review grace.
  Other routine waits and non-routine flight timeout rules remain unchanged.
- The deadline gate applies when starting an effect, including its atomic SQL
  claim. An already-running action skips that entry gate so crash replay can
  reconcile the effect and its receipts. A timely bound approval gets the
  normal execution budget from its decision, even across the old review deadline;
  a verdict cast at/after ask expiry does not authorize a late effect. Legacy
  unbound approvals retain the original ask deadline.

## Approver data

Authorized Run reads/list/latest and REST/MCP serialization expose nullable
`review_requested_at` and `review_deadline_at`. Authorized Task reads/list and MCP
`task_get`/`task_list` expose optional `routine_review_deadline_at` only when a current
receipt proves it. Task enrichment rechecks the already-authorized project pair;
ordinary task payloads keep their existing keys. These are derived read facts, not
new task columns or writable input fields.

The existing Needs You approval item and Project Situation projection use the same
review deadline instead of the project's scheduling target. The routine detail page
prints “Review due” (or unavailable when there is no proven ask). Existing visibility,
tenant, gate-holder and independent-verdict checks are preserved.

No migration is needed: existing append-only events, action/run state and the flight
`resumed_at` column hold the facts. Already-failed historical flights are not revived.
The deadline is evaluated by the existing maintenance sweep; this change does not
deploy code, run a sweep against production or change credentials/permissions.

```sh
node scripts/generate-build-info.mjs
npx vitest run tests/routine-review-window.test.ts tests/flight-watchdog.test.ts tests/flight-watchdog-routine-tasks.test.ts tests/routine-reap-overlap.test.ts --maxWorkers=2
node scripts/prove-routine-review-window.mjs
npm run typecheck
node scripts/check-test-schema-source.mjs
node scripts/check-mcp-tool-seam.mjs
node scripts/check-schema-chain-fresh.mjs
git diff --check
```

Tests use the real complete migration chain. They cover the old 70-minute failure,
the exact review boundary, unchanged execution/wake clocks, invalid binding/producer,
candidate starvation, reaper-entry race, expiry/overlap release, late effects,
action/re-observation resumption, immutable snapshots, and deadline read/UI surfaces.
The mutation prover restores source and rejects import/setup failures as evidence.
It also refuses primary checkouts, branch checkouts and uncommitted changes.
Run it only after committing, in a clean dedicated **detached worktree**; a
read-only `node scripts/prove-routine-review-window.mjs --check-worktree` verifies
that precondition. Temporary test repositories for this guard live under the
checkout's ignored `tmp/` directory, not the deployment checkout.
