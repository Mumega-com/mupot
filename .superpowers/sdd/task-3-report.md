# Task 3 Report: Normalized Source Snapshots and Deterministic Fixtures

## Scope

Implemented normalized Marketing/CRO source contracts, bounded sequential collection,
deterministic fixture evidence, and pure outcome derivation. This task adds no persistence,
routes, real connectors, or UI.

## RED Evidence

Initial command:

```sh
npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts
```

Result: 2 failed suites, 0 tests. Both imports failed as expected because
`src/addons/marketing/sources.ts` and `src/addons/marketing/outcomes.ts` did not exist.

Boundary regressions were then added and run before their fixes. Result: 2 failed tests:

- adapter-supplied unavailable text exposed `Authorization: Bearer top-secret` instead of a
  stable non-secret reason;
- `growth.revenue` with `first_party` authority was incorrectly available.

## GREEN Evidence

```sh
npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts
```

Result: 2 passed files, 17 passed tests.

```sh
npm run typecheck
git diff --check
```

Result: both commands exited successfully.

## Changed Files

- `src/addons/marketing/types.ts`
- `src/addons/marketing/sources.ts`
- `src/addons/marketing/outcomes.ts`
- `tests/fixtures/marketing-monitor.ts`
- `tests/marketing-monitor-sources.test.ts`
- `tests/marketing-monitor-outcomes.test.ts`

## Implementation Commit

`9f031c72724e247745d99e52323315eff8abe552` (`feat(marketing): normalize monitor evidence`)

## Residual Risks

- Task 4 must bind these in-memory snapshots to immutable, tenant-scoped runs and API redaction.
- Task 6 must resolve actual connector credentials behind its adapter boundary; this task only
  accepts safe binding metadata and deterministic test evidence.
- Revenue authorities are limited to `commerce`, `crm`, `ghl`, and `stripe`; a later adapter
  should extend that explicit allowlist only with a corresponding authoritative contract and test.
