# Task 8 Report: Marketing Monitor Lifecycle Receipt

## Scope

Implemented a reproducible Marketing/CRO monitor lifecycle receipt and a redacted public recommendation preparation endpoint required by the receipt flow.

## RED

Initial focused run failed because `scripts/marketing-monitor-lifecycle-receipt.mjs` did not exist:

```bash
npx vitest run tests/marketing-monitor-lifecycle-receipt.test.ts --maxWorkers=1 --reporter=verbose
```

Result: import failure for the missing verifier module.

## Implementation

- Added `scripts/marketing-monitor-lifecycle-receipt.mjs` with plan/check modes.
- Added `receipt:marketing-monitor:plan` and `receipt:marketing-monitor:check` package commands.
- Added `POST /api/addons/marketing-cro-monitor/recommendation` as an owner/admin-only public route that calls the existing governed recommendation service and returns only redacted recommendation evidence.
- Added receipt tests covering install, configure with `first_party`, activate, monitor, recommendation prep, console proof, disable, archive, reinstall, repeat, and final archive cleanup.
- Updated route tests to prove monitor and recommendation public DTOs exclude raw task/flight/dedup IDs.
- Documented the receipt command and proof contract in the Marketing/CRO monitor design spec.

## Review Fixes

First review found important gaps:

- The checker expected private receipt IDs and actor IDs that the public receipt API intentionally redacts.
- It expected console recommendation evidence after only running the monitor, but recommendation prep was not public.
- Raw UUID task/flight references could leak without detection.
- Unavailable-not-zero was checked only in JSON, not rendered console HTML.
- Second archive cleanup was not verified.
- The HTML console request carried both bearer and session cookie.

Fixes applied:

- Public receipts are now checked by sequence/action/state/digest/version/timestamp only.
- Added redacted public recommendation-prep route and made the receipt call it.
- Console proof rejects `task-*`, `flight-*`, and UUID-like raw IDs.
- Console proof requires unavailable rendering and rejects unavailable revenue rendered as zero.
- Receipt checks first and second archive ownership counts and final archived catalog state.
- Console fetch uses `auth: false` so only the session cookie is sent.

Second review approved with no Critical or Important findings.

## Verification

```bash
npx vitest run tests/marketing-monitor-lifecycle-receipt.test.ts tests/addon-routes.test.ts --maxWorkers=1 --reporter=verbose
```

Result: 2 files / 54 tests passed.

```bash
npx vitest run tests/marketing-monitor-lifecycle-receipt.test.ts tests/addon-lifecycle-receipt.test.ts tests/addon-routes.test.ts tests/marketing-monitor-opportunities.test.ts tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts --maxWorkers=1 --reporter=dot
```

Result: 6 files / 160 tests passed.

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run --maxWorkers=2 --reporter=dot
```

Result: 211 files / 3527 tests passed.

```bash
git diff --check
```

Result: passed.
