# PR #1236 fix-forward — router / loop / meter exact-head receipt

Date: 2026-08-29 UTC

## Identity and boundary

- Approved source base: `41330115de7304c95654f57949b41c24761b2e8f`.
- Reviewed IR-4 behavior head: `3d2af4172786d0dedefe244bc3bd625322f28a10`.
- IR-1 composition start: `567a8a379abc52e89f990078fdfd39d598a038c7`.
- Disposable composed head: `316877c35ca6419124e7e0b6529940c63d2db969` (local cherry-pick of only `3d2af417`, not a published ref).
- PR #1236 is donor-only and unmerged. No donor commit or migration was cherry-picked.
- This is local evidence, not remote CI, a deployment receipt, merge approval, or production assertion.

Both worktrees were clean at their stated start heads. The primary history was not rewritten. No push, PR action, merge, deploy, credential use, production mutation, remote migration, or branch-protection mutation occurred.

## Reviewed task and commit ledger

| Task | Reviewed commits | Result |
| --- | --- | --- |
| 1 — execution scope | `10fc4c6e`, `47ee79c0` | Server-derived scope and authenticated ambient capability ceiling. |
| 2 — router | `98740ead`, `7a7d0a03`, `5628d94a` | Named-squad router, conditional claim/wake ordering, mutation presence, non-null `dry_run`. |
| 3 — loop public boundary | `c66e94c3` | Public `loop_driver_tick` absence; scheduled internal `runLoopsTick` remains. |
| 4 — meter and integration repair | `c7d72db9`, `1de2c022`, `3d2af417` | Scoped status, server-built reservation, truthful refusals, migration-backed loop runtime. |

## Ledger rulings

1. Task 3 had an already-correct absent baseline. Its proof temporarily registered a dummy public tool to make the new absence test RED; it was then removed. A baseline defect was not fabricated.
2. Current-main red state allowed bounded review only; no publication/merge-ready claim until IR-1 composition gates passed. This receipt records local composition evidence only.
3. Task 4 extended internal `AuthorizedExecution` for durable cost cap/window and prospective estimate semantics; no public field or migration was added.
4. Manifest callers resolve an active canonical agent/home squad or existing canonical squad before metering, fail closed, and preserve meter subject keys.

## Mutation witnesses

- Scope: removing target-agent/squad authority exposed cross-squad meter status; removing ambient-ceiling intersection widened authority. Each focused run exited `1`.
- Router: removing `AND squad_id = ?4` allowed a moved cross-squad task claim; suppressing mutation presence and removing the `dry_run: null` rejection each failed focused regressions. Each was restored.
- Loop: temporary authenticated `loop_driver_tick` registration appeared in real tools/list discovery; public-boundary test exited `1`; registration removed.
- Meter: bypassed arbitrary-agent scope made meter rows reachable; temporary public `execution_meter_check` accepting caller caps made unknown-tool protection fail. Each mutation was removed.
- Truthful receipts: four dispatch/token/daily-cost/weekly-cost durable cases were RED `4/4` before repair and GREEN `4/4` afterward.
- Schema: `tests/loop-runtime.test.ts` was a new IR-1-composition `mockDb` violation; conversion to `createSqliteD1()` plus `applyAllMigrations()` restored the guard without baseline/guard change.

## Exact evidence

Composition commands ran at `316877c35ca6419124e7e0b6529940c63d2db969` unless noted.

| Literal command | Exit | Result |
| --- | ---: | --- |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/loop-driver-public-boundary.test.ts tests/meter-authorization.test.ts` | 0 | 4 files, 59 tests passed |
| `npm run typecheck` | 0 | TypeScript clean |
| `npm test` | 0 | 442 files, 6,698 tests passed |
| `node scripts/no-secrets.mjs` | 0 | no secrets found |
| `node --test tests/test-schema-source.test.mjs` | 0 | 16/16 passed |
| `node scripts/check-test-schema-source.mjs` | 0 | baseline files=26, mockDb=127 |
| `node --test tests/migration-numbering.test.mjs` | 0 | 29/29 passed |
| `BASE_REF=main node scripts/check-migration-numbering.mjs` | 0 | 0133 sorts above main head 132 |
| `node scripts/reserved-bindings.mjs` | 0 | no reserved binding names |
| `npx vitest run tests/check-operator-counts-source.test.ts` | 0 | 7/7 passed |
| `node scripts/check-operator-counts-source.mjs` | 0 | 48 dashboard files, zero duplicate implementations |
| `node --test tests/branch-staleness.test.mjs` | 0 | 10/10 passed |
| `BASE_REF=main node scripts/check-branch-staleness.mjs` | 0 | no contested files, 0 behind origin/main |
| `node scripts/design-status-contract-policy.mjs` | 0 | policy OK |
| `python -m compileall -q plugin` | 0 | PATH shim supplied `python`; exact command unchanged |
| `python -m pytest plugin/tests` | 0 | 105 passed |
| `bash scripts/ci-local-evidence.sh` | 0 | local D1, Wrangler, browser smoke, runtime conformance, routine lifecycle |
| `git diff --check origin/main...HEAD` (composition) | 0 | clean |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/loop-driver-public-boundary.test.ts tests/meter-authorization.test.ts` (primary `3d2af417`) | 0 | 4 files, 59 tests passed |
| `git diff --check origin/main...HEAD` (primary `3d2af417`) | 0 | clean |

The first local-evidence run was interrupted by the harness with its local Wrangler child still alive. The exact local child was stopped, endpoint freedom verified, and the full command rerun to exit `0`; no remote endpoint or production database was selected.

The host has `/usr/bin/python3` (resolved target `/usr/bin/python3.12`) but no
`python` name. For the two exact CI-spelled plugin commands only, PATH was
prefixed with disposable `/tmp/mupot-ir4-python-shim.qp1OoF`, whose sole
`python` symlink pointed to that target; the directory and symlink were then
removed. This is environment-equivalent to GitHub Actions `setup-python`,
which supplies the `python` alias. No repository or runtime code changed.

## Deferred minors

Task 4 deferred: optional `agent_id: null` despite string schema; successful manifest-cycle tests do not assert `recordTokens` subject-key parity; positive non-finite estimates normalize to zero rather than fail closed. These remain Minors, not resolved by this receipt.

## Primary versus composition posture

Primary has focused and diff-hygiene evidence only; it is not independently full-gated here. Its historical pre-composition posture was red: Task 4 recorded 6,685 passing Vitest tests plus two inherited dispatcher failures and typecheck exit `2`. That is not a primary-head green claim. Composition is the only current full-suite/typecheck/guard evidence. Its exact plugin commands now have environment-equivalent PASS evidence through the disposable `setup-python`-equivalent alias described above.

## Gate and Athena posture

No Athena verdict is bound to this artifact: Athena is unavailable/stale, and queued is not `GREEN`, `BLOCK`, or `RESHAPE`. Internal task review has no open Critical/Important finding; the above items are deferred Minors. Receipt SHA-256 and its narrow commit are in the ignored Task 5 report for a future authenticated Athena request.
