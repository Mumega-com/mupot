# Task 7 Report: One Deduplicated Governed Recommendation

Plan: `docs/superpowers/plans/2026-07-16-marketing-cro-monitor-v1.md`

Implementation commit: `97bde1228fdb3c642aafc47fd6ffcaf29080f7c4`

## RED Evidence

Command:

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts
```

Expected failure: one suite failed before test collection because
`src/addons/marketing/opportunities.ts` did not exist. Vitest reported
`Cannot find module '../src/addons/marketing/opportunities'` at the new test
import, proving the Task 7 ranking and persistence surface was absent.

The dashboard reference test was also observed RED before its renderer change:
one selected test failed because the opportunity panel did not contain
`Owner approval required` or safe `/approvals` and `/flights` references.

## Delivered

- Added deterministic, bounded opportunity ranking and selected only the first
  candidate from the latest immutable completed monitor run.
- Added tenant-, installation-, program-, target-, window-, and kind-bound
  deduplication with one durable preparation claim per evidence window.
- Persisted target, problem, hypothesis, KPI baseline, limiting unavailable
  evidence, evidence digest, task and flight references, approval metadata,
  terminal action, and recommendation receipt digest.
- Resolved the addon-owned Web Operations strategy squad through active addon
  resource ownership rather than accepting a caller-selected squad.
- Created the canonical task directly in `review` with an owner-review gate and
  `skipMirror: true`.
- Created a canonical zero-budget flight whose metadata terminates at
  `recommendation_ready` and explicitly has no executor.
- Rejected disabled and archived installations before creating recommendation,
  task, or flight rows.
- Rendered owner approval plus generic task and flight destinations without
  exposing raw task or flight IDs in the addon console.

## Files Changed

- `migrations/0054_marketing_recommendations.sql`
- `src/addons/marketing/opportunities.ts`
- `src/addons/marketing/service.ts`
- `src/dashboard/marketing-cro-monitor.ts`
- `tests/marketing-monitor-opportunities.test.ts`
- `.superpowers/sdd/task-7-report.md`

## Commands and Results

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts
```

GREEN: 1 test file passed; 8 tests passed.

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts tests/flight-service.test.ts tests/tasks-service.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 26 tests passed.

```text
npx vitest run tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts tests/marketing-monitor-opportunities.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 68 tests passed.

```text
npm run typecheck
```

Passed: `tsc --noEmit` exited successfully.

```text
git diff --check
git diff --cached --check
```

Passed with no whitespace errors.

## Concerns

No blocking concerns. Preparation claims fail closed: if the process is
interrupted after claiming a dedup key but before finalizing task/flight links,
later calls return `recommendation_busy` instead of risking duplicate work.
Automated reconciliation of a stale `preparing` claim is intentionally deferred
because the canonical task and flight services allocate their own identifiers.

---

## Review Fix: Recoverable Preparation and Canonical Flights

Review-fix implementation commit:
`00046f3c6aecb6af53a9f54fe729893568d73154`

### RED Evidence

Command:

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts --maxWorkers=1 --reporter=dot
```

RED: 1 test file failed; 5 tests failed and 6 passed. The failures proved:

- ranking returned four candidates instead of at most one;
- retries after post-persistence task creation failure, post-persistence flight
  creation failure, and recommendation finalization failure returned
  `recommendation_busy` instead of recovering the evidence window; and
- `parseFlightMetaV1()` rejected the created flight metadata because it carried
  the noncanonical `terminal_action` and `executor` keys.

### Delivered

- Added a recommendation ID and dedup key to the canonical task body, plus a
  unique expression index, so retries recover the one task even when task
  creation reports failure after persistence.
- Added a tenant-scoped unique flight `goal_id` index and canonical metadata
  recovery, so retries reuse the one flight after flight creation or
  finalization interruption.
- Reused the original preparation claim ID and timestamp on retry and made a
  raced finalization return the existing ready recommendation idempotently.
- Removed terminal action and executor fields from flight metadata. The
  terminal action remains in the recommendation row and receipt, while tests
  prove the flight parses as exact `FlightMetaV1` and no executor is called.
- Changed deterministic opportunity ranking to return either an empty array or
  one candidate.

### Commands and Results

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts tests/flight-service.test.ts tests/tasks-service.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 29 tests passed.

```text
npx vitest run tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts tests/marketing-monitor-opportunities.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 71 tests passed.

```text
npm run typecheck
```

Passed: `tsc --noEmit` exited successfully.

```text
git diff --check
git diff --cached --check
```

Passed with no whitespace errors.

### Concerns

No blocking concerns. The Vitest runs emit Node's existing experimental SQLite
warning; all requested tests pass.

---

## Review Fix: Persisted-Identity Recovery

Review-fix implementation commit:
`a961a57cfee635a35f0213c81ecb92a44e5e350f`

### RED Evidence

Command:

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts --maxWorkers=1 --reporter=dot
```

RED: 1 test file failed; 4 tests failed and 11 passed. The failures proved:

- a preparing claim retry returned `run_not_latest` after a newer completed
  monitor run existed;
- a preparing claim retry returned `run_not_latest` after the live binding
  generation was reconfigured;
- a retry returned `write_failed` after the canonical task transitioned from
  `review` to `approved`; and
- a retry returned `write_failed` after the canonical flight transitioned from
  `preflight` to `running`.

### Delivered

- Split recovery from first-time claiming. A new claim still requires the
  requested run to be the latest completed run in the active live binding
  generation.
- Recovered an existing claim through its persisted installation, run, binding
  generation, evidence, candidate, dedup, squad, and immutable claim fields,
  without consulting current latest-run or live-binding state.
- Reused canonical tasks and flights after lifecycle transitions when their
  squad, gate, body, done-when, goal, and exact `FlightMetaV1` still match.
- Strengthened the finalization fence to validate canonical task body and all
  flight metadata fields while allowing task and flight status transitions.
- Preserved one recommendation, task, and flight across every interrupted retry.

### Commands and Results

```text
npx vitest run tests/marketing-monitor-opportunities.test.ts tests/flight-service.test.ts tests/tasks-service.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 33 tests passed.

```text
npx vitest run tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts tests/marketing-monitor-opportunities.test.ts --maxWorkers=1 --reporter=dot
```

GREEN: 3 test files passed; 75 tests passed.

```text
npm run typecheck
```

Passed: `tsc --noEmit` exited successfully.

```text
git diff --check
git diff --cached --check
```

Passed with no whitespace errors.

### Concerns

No blocking concerns. Vitest emits Node's existing experimental SQLite warning;
all requested tests pass.

---

## Project Routines v0.25 Task 7: Routine Answer Project Access

Parent Task 7 implementation commit:
`9fc069f9045e80b44099adb6c3e80f1022256699`

Follow-up commit message: `fix: enforce routine answer project access`

### RED Evidence

Command:

```text
npx vitest run tests/needs-you.test.ts
```

RED: 1 test file failed; 1 test failed and 10 passed. A member with member+
capability on the responsible squad received `['view', 'answer']` while that
squad had only `read` Project access. The expected actions were `['view']`.

### Delivered

- Added the responsible squad's existing `project_squad_access.access_level` to
  the bounded Routine wait projection.
- Advertised `answer` to non-admin human principals only when the responsible
  Project edge is `write` or `admin` and the principal has squad member+
  capability, including department inheritance.
- Preserved the workspace-admin bypass and all Task verdict action behavior.
- Kept authorization in-memory over source query rows, with no N+1 query and no
  Needs You mutation or resolution path.
- Left Routine REST route mounting deferred to planned Task 9.

### Commands and Results

```text
npx vitest run tests/needs-you.test.ts
```

GREEN: 1 test file passed; 11 tests passed.

```text
npx vitest run tests/needs-you.test.ts tests/tasks-gate.test.ts tests/routines-service.test.ts tests/projects-routes.test.ts tests/project-readable-squads.test.ts
```

GREEN: 5 test files passed; 126 tests passed.

```text
npx tsc --noEmit
git diff --check
```

Passed with no type or whitespace errors.

### Concerns

No blocking concerns. Vitest emits Node's existing experimental SQLite warning;
all requested tests pass.
