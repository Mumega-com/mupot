# Task 2 Report: Secret-Free Addon Bindings and Configuration Preflight

## Status

Complete.

Implementation commit: `686ec97bd271fe12b97a6b70286e89ca9d526ff7`

## RED Evidence

Initial focused command:

```text
npx vitest run tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts
```

Result: failed as expected (`3` failed suites, exit `1`). The failures were:

- `tests/addon-bindings.test.ts`: missing `src/addons/bindings.ts`.
- `tests/addon-service.test.ts`: missing `src/addons/bindings.ts`.
- `tests/addon-routes.test.ts`: missing `migrations/0052_addon_bindings.sql`.

Revocation hardening RED command:

```text
npx vitest run tests/addon-bindings.test.ts -t "keeps binding evidence append-only" --maxWorkers=1 --reporter=verbose
```

Result: failed as expected (`1` failed test, exit `1`) because `revoked_at = ''` was accepted.

## GREEN Evidence

Focused Task 2, migration, and lifecycle receipt coverage:

```text
npx vitest run tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts --maxWorkers=1 --reporter=dot
```

Result: `4` files passed, `203` tests passed, `0` failed, exit `0`.

Typecheck:

```text
npm run typecheck
```

Result: `tsc --noEmit` passed, exit `0`.

Revocation hardening GREEN result: `1` selected test passed, `11` skipped, exit `0`.

## Files Changed

- `migrations/0052_addon_bindings.sql`
- `src/addons/bindings.ts`
- `src/addons/service.ts`
- `src/addons/routes.ts`
- `src/connectors/service.ts`
- `tests/addon-bindings.test.ts`
- `tests/addon-routes.test.ts`
- `tests/addon-service.test.ts`
- `tests/addon-lifecycle-receipt.test.ts`
- `.superpowers/sdd/task-2-report.md`

## Implemented Behavior

- Added secret-free, append-only binding generations with one-way timestamped revocation.
- Added D1 tenant matching for vault connectors and live-binding rejection on archived installations.
- Added tenant-scoped safe connector metadata resolution by exact connector ID without selecting credentials.
- Added binding preflight for required slots, adapters, binding kinds, connector availability/type, read-only capability, and manifest drift.
- Added first configuration, normalized idempotency, configured/disabled reconfiguration receipts, active-state rejection, activation preflight, and archive revocation.
- Kept configuration and lifecycle receipts in the same D1 batch. Archive revocation is the first statement in the archive transition batch.
- Added bounded 8 KiB configure parsing, strict object keys/types, duplicate-slot rejection, manifest/absolute count limits, and non-configure body rejection.
- Preserved the empty-body lifecycle flow for zero-requirement fixture addons.

## Self-Review

- Secret leakage: binding rows and responses contain no credential fields; the new connector query explicitly selects safe columns only.
- Tenant isolation: application reads bind `env.TENANT_SLUG`; D1 triggers independently enforce installation and connector tenant identity.
- Transaction correctness: binding generation writes and receipts share one D1 batch; receipt/state triggers force rollback on failed lifecycle CAS. Archive revocation precedes the archive update in the same batch.
- Authority: connector requirements are no longer treated as grants; activation separately requires empty rank/surface grants and successful read-only binding preflight.
- Backwards compatibility: zero-requirement configure/activate and the seven-step lifecycle receipt flow remain covered.

## Residual Risks

- A concurrent activation can return the existing public `fence_lost` outcome after the additional preflight read; retry remains safe and covered.
- The migration uses SQLite `julianday()` to reject malformed revocation timestamps; the Node SQLite D1 harness covers the production SQL behavior used here.
