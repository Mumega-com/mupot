# Task 6 Report: Read-Only Marketing Source Adapters

## RED Evidence

- Added adapter tests before production implementation for first-party read-only mapping, exact-ID vault resolution, PostHog and Inkwell secret redaction, bounded read behavior, MCPWP request restrictions, and adapter registration.
- Ran `npx vitest run tests/marketing-monitor-adapters.test.ts tests/cro-sources.test.ts tests/cro-posthog.test.ts tests/executor-mcpwp-s4.test.ts`.
- RED result: 1 failed suite and 3 passed suites; the new adapter suite failed during import because `src/addons/marketing/adapters` did not exist. The 72 existing CRO and MCPWP tests passed.

## Files Changed

- `src/addons/marketing/adapters/first-party.ts`
- `src/addons/marketing/adapters/posthog.ts`
- `src/addons/marketing/adapters/inkwell.ts`
- `src/addons/marketing/adapters/mcpwp.ts`
- `src/addons/marketing/adapters/index.ts`
- `src/connectors/service.ts`
- `tests/marketing-monitor-adapters.test.ts`
- `.superpowers/sdd/task-6-report.md`

## Commands and Results

- `npx vitest run tests/marketing-monitor-adapters.test.ts`
  - Passed: 1 test file and 10 tests.
- `npx vitest run tests/marketing-monitor-adapters.test.ts tests/cro-sources.test.ts tests/cro-posthog.test.ts tests/executor-mcpwp-s4.test.ts tests/connectors.test.ts`
  - Passed: 5 test files and 114 tests.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `npx vitest run --maxWorkers=4 --reporter=dot`
  - Passed: 209 test files and 3,495 tests.
- `git diff --check`
  - Passed with no whitespace errors.
- Staged patch safety scan
  - Only the seven Task 6 implementation/test paths were staged; no unrelated changes were included.

## Commit SHA

Implementation commit: `074f4806ce49f8d1d9323cac98ca399be536f99c`.

## Concerns

No blocking concerns. Inkwell, MCPWP, and PostHog currently report source health with zero numeric observations. PostHog must remain observation-free until a true organic-session query exists.

## Review Fixes

### RED Evidence

- Production default factory: `tests/marketing-monitor-service.test.ts` failed with 1 failed and 50 passed because `runMarketingMonitor()` persisted `sourceCount: 0` and no observations for an active `first_party` binding.
- Exact-ID vault boundary: `tests/marketing-monitor-adapters.test.ts` failed with 3 failed and 10 passed because the callback received a mutable object with a plaintext `secret` field and no revocable call capability.
- Secret-bearing callback errors: the adapter suite failed with 1 failed and 14 passed because `useConnectorById()` propagated an upstream error containing the plaintext secret.
- PostHog metric authority: the adapter suite failed with 1 failed and 12 passed because the unique-user aggregate produced a numeric `seo.organic_sessions` observation with value `56`.
- MCPWP actual-redirect coverage was green immediately: the existing adapter already rejected a real `302` response. The new test closes the review coverage gap without a production-code change.

### Files Changed

- `src/addons/marketing/adapters/inkwell.ts`
- `src/addons/marketing/adapters/mcpwp.ts`
- `src/addons/marketing/adapters/posthog.ts`
- `src/addons/marketing/service.ts`
- `src/connectors/service.ts`
- `tests/marketing-monitor-adapters.test.ts`
- `tests/marketing-monitor-service.test.ts`
- `.superpowers/sdd/task-6-report.md`

### Commands and Results

- `npx vitest run tests/marketing-monitor-adapters.test.ts tests/marketing-monitor-service.test.ts tests/cro-sources.test.ts tests/cro-posthog.test.ts tests/executor-mcpwp-s4.test.ts tests/connectors.test.ts --maxWorkers=1 --reporter=dot`
  - Passed: 6 test files and 170 tests.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `git diff --check`
  - Passed with no whitespace errors.

### Commit SHA

Implementation commit: `14700edc2a2c0b985b6a82381b70beb3c47833d7`.

### Concerns

No blocking concerns. The MCPWP 3xx regression test did not produce a RED phase because the reviewed implementation already rejected 3xx status responses; only the explicit response-level coverage was missing. PostHog intentionally remains availability-only until a channel-correct organic-session query is implemented.
