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
