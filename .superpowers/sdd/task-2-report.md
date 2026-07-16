# Task 2 Report: Secret-Free Addon Bindings and Configuration Preflight

## Status

Complete.

Implementation commit: `686ec97bd271fe12b97a6b70286e89ca9d526ff7`

Independent review fix commit: `5268523ef201ef84cd01417a106d2dbdfe2b2366`

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

Independent review RED command:

```text
npx vitest run tests/addon-bindings.test.ts tests/addon-routes.test.ts --maxWorkers=1 --reporter=verbose
```

Result: `9` failed and `47` passed, exit `1`. The failures reproduced the configure/state race, activation generation and connector races, concurrent identical reconfiguration, unbounded chunked body consumption, non-canonical revocation evidence, missing live-generation records, and the missing composite connector foreign key.

## GREEN Evidence

Focused Task 2, migration, and lifecycle receipt coverage:

```text
npx vitest run tests/addon-bindings.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts --maxWorkers=1 --reporter=dot
```

Initial result: `4` files passed, `203` tests passed, `0` failed, exit `0`.

Independent review GREEN result: `4` files passed, `211` tests passed, `0` failed, exit `0`.

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
- Added an explicit empty-capable binding generation head with one-live-generation uniqueness, exact predecessor fencing, configuration digests, and binding counts.
- Added D1 tenant matching for vault connectors and live-binding rejection on archived installations.
- Added a composite `(connector_id, tenant)` foreign key backed by a unique connector identity index, preventing connector tenant mutation or deletion while binding evidence exists.
- Added tenant-scoped safe connector metadata resolution by exact connector ID without selecting credentials.
- Added binding preflight for required slots, adapters, binding kinds, connector availability/type, read-only capability, and manifest drift.
- Added first configuration, normalized idempotency, configured/disabled reconfiguration receipts, active-state rejection, activation preflight, and archive revocation.
- Kept configuration and lifecycle receipts in the same D1 batch. Archive revocation is the first statement in the archive transition batch.
- Reconfiguration now revokes only the observed generation, installs its replacement, writes bindings, and appends its receipt atomically. A stale identical request rolls back and returns idempotently after rereading the winner.
- Activation commits only while the exact preflighted generation remains live and every vault connector remains same-tenant, active, and type-matched.
- Archive revokes the exact observed generation and its bindings before the installation state update in the same batch.
- Added bounded 8 KiB configure parsing, strict object keys/types, duplicate-slot rejection, manifest/absolute count limits, and non-configure body rejection.
- Omitted-length and chunked bodies are read incrementally and cancelled immediately after crossing 8 KiB.
- Generation and binding inserts must start with `revoked_at = NULL`; revocation timestamps must be non-empty canonical JS ISO strings at or after `configured_at`.
- Preserved the empty-body lifecycle flow for zero-requirement fixture addons.

## Self-Review

- Secret leakage: binding rows and responses contain no credential fields; the new connector query explicitly selects safe columns only.
- Tenant isolation: application reads bind `env.TENANT_SLUG`; D1 triggers independently enforce installation and connector tenant identity.
- Transaction correctness: generation replacement and receipts share one D1 batch; unique live-head and predecessor constraints force stale writers to roll back. Activation and archive transition SQL fence the exact observed generation. Archive generation and binding revocation precede the archive update in the same batch.
- Authority: connector requirements are no longer treated as grants; activation separately requires empty rank/surface grants and successful read-only binding preflight.
- Backwards compatibility: zero-requirement configure/activate and the seven-step lifecycle receipt flow remain covered.

## Residual Risks

- Historical vault bindings intentionally prevent hard deletion or tenant reassignment of their connector row; connector soft revocation remains available.
- Race tests use deterministic hooks around the SQLite-backed D1 harness. Production correctness also rests on D1 batch atomicity and SQLite uniqueness/trigger semantics, which are the same primitives exercised by the tests.
