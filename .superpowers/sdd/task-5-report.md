# Task 5 Report: Operational Addon Console

## Review Fix: Lifecycle Fencing, Public DTOs, and Authorization Order

### Tests Added and RED Evidence

- Added deterministic no-run interleaving coverage for both latest and list reads when the bound generation is revoked/replaced. RED returned `{ ok: true, run: null }` or `{ ok: true, runs: [] }` instead of explicit `fence_lost`.
- Added deterministic no-run interleaving coverage for both latest and list reads when the installation is archived and replaced. RED returned valid empty results instead of explicit `fence_lost`.
- Tightened existing stale-scope, binding-count, and live-binding recount assertions. RED showed all invalid lifecycle witnesses still collapsed to empty success.
- Added a dashboard loader regression for an empty binding read with no live generation. RED rendered `monitorState: 'empty'` instead of `unavailable`.
- Added exact public run and receipt DTO key allowlists. RED exposed `observations`, `rawObservationCount`, `programVersion`, `createdAt`, receipt `id`, and `actorId`.
- Added member coverage for a registered and unregistered addon console path. RED returned `404` for the unknown path, revealing wildcard resolution before authorization.
- Initial RED command discovered 140 tests: 128 passed and 12 failed for the expected unimplemented behavior.

### Files Changed

- `src/addons/marketing/service.ts`
- `src/addons/routes.ts`
- `src/dashboard/marketing-cro-monitor.ts`
- `src/dashboard/index.ts`
- `tests/marketing-monitor-service.test.ts`
- `tests/dashboard-marketing-cro-monitor.test.ts`
- `tests/dashboard-addons.test.ts`
- `tests/addon-routes.test.ts`
- `.superpowers/sdd/task-5-report.md`

### Commands and Results

- `npx vitest run tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts`
  - RED: 4 files failed; 12 expected failures and 128 passes.
  - GREEN: 4 files passed; 140 tests passed.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `npm test`
  - Passed: 208 test files and 3,485 tests.
- `git diff --check`
  - Passed with no whitespace errors.

### Commit SHA

Implementation commit: `2f9e40022a87494fc3200ec54283ff9be103d065`.

### Concerns

No blocking concerns. The test suite emits the repository's existing Node experimental SQLite warning; there were no test failures.
