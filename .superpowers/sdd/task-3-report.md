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

Accepted review findings were addressed in seven additional RED/GREEN cycles:

1. Authority derivation and `finance.revenue`: 3 failed, 17 passed. The collector returned
   generic invalid evidence for forged authority and outcomes did not recognize supported CRM
   revenue.
2. Post-read isolation: 1 failed, 20 passed. A throwing snapshot getter escaped the collector
   and prevented later sources from running.
3. Cap precedence and non-available evidence: 3 failed, 21 passed. Failed/unavailable status
   was inspected before source/run caps, and non-available snapshots could carry observations.
4. Collection identity: 3 failed, 24 passed. Collections had no run ID and did not reject
   duplicate observation IDs or mixed run IDs.
5. Immutable evidence: 1 failed, 27 passed. Mutating a source observation after collection
   changed the accepted evidence.
6. Outcome ordering: 2 failed, 28 passed. Last input won instead of latest timestamp with a
   deterministic observation-ID tie-break.
7. Canonical timestamps: 2 failed, 31 passed. Windows and observations without millisecond
   precision were accepted.

## GREEN Evidence

```sh
npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts
```

Result after review fixes: 2 passed files, 33 passed tests.

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
- `.superpowers/sdd/task-3-report.md`

## Implementation Commits

`9f031c72724e247745d99e52323315eff8abe552` (`feat(marketing): normalize monitor evidence`)

`1fec0c676ba7b3382788b2ea7b26a3b8842f7741` (`fix(marketing): harden monitor evidence`)

## Residual Risks

- Task 4 must bind these in-memory snapshots to immutable, tenant-scoped runs and API redaction.
- Task 6 must resolve actual connector credentials behind its adapter boundary; this task only
  accepts safe binding metadata and deterministic test evidence.
- `finance.revenue` is limited to `ghl` and `crm`. Task 6 must prove those adapters derive the
  same canonical authorities from configured bindings before real revenue evidence is enabled.
