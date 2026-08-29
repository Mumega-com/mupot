# PR #1236 fix-forward — router / loop / meter exact-head receipt

Date: 2026-08-29 UTC

## Identity and boundary

- Approved source base: `41330115de7304c95654f57949b41c24761b2e8f`.
- Reviewed IR-4 behavior head before final review: `4004e183d6ad50663d3d159cc6b2508350f1a6e9`.
- IR-4 final-fix code head: `29463de63823188647337e897cf77f8f6066d114`.
- IR-1 composition start: `567a8a379abc52e89f990078fdfd39d598a038c7`.
- Pre-fix disposable composition: `316877c35ca6419124e7e0b6529940c63d2db969`.
- Final disposable composition: `24b17a1a9d3cb644d2529f62f7eb79b2fb9433c4` (local cherry-pick of `29463de6`; not a published ref).
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
| Final review fix | `29463de6` | Existence-oracle closure, atomic router eligibility recheck, strict public meter target validation, manifest subject continuity proof, and non-finite estimate refusal. |

## Ledger rulings

1. Task 3 had an already-correct absent baseline. Its proof temporarily registered a dummy public tool to make the new absence test RED; it was then removed. A baseline defect was not fabricated.
2. Current-main red state allowed bounded review only; no publication/merge-ready claim until IR-1 composition gates passed. This receipt records local composition evidence only.
3. Task 4 extended internal `AuthorizedExecution` for durable cost cap/window and prospective estimate semantics; no public field or migration was added.
4. Manifest callers resolve an active canonical agent/home squad or existing canonical squad before metering, fail closed, and preserve meter subject keys.
5. The final fix required no migration. Every new D1 regression uses `createSqliteD1()` plus `applyAllMigrations()`.

## Mutation witnesses

- Scope: removing target-agent/squad authority exposed cross-squad meter status; removing ambient-ceiling intersection widened authority. Each focused run exited `1`.
- Router: removing `AND squad_id = ?4` allowed a moved cross-squad task claim; suppressing mutation presence and removing the `dry_run: null` rejection each failed focused regressions. Each was restored.
- Loop: temporary authenticated `loop_driver_tick` registration appeared in real tools/list discovery; public-boundary test exited `1`; registration removed.
- Meter: bypassed arbitrary-agent scope made meter rows reachable; temporary public `execution_meter_check` accepting caller caps made unknown-tool protection fail. Each mutation was removed.
- Truthful receipts: four dispatch/token/daily-cost/weekly-cost durable cases were RED `4/4` before repair and GREEN `4/4` afterward.
- Schema: `tests/loop-runtime.test.ts` was a new IR-1-composition `mockDb` violation; conversion to `createSqliteD1()` plus `applyAllMigrations()` restored the guard without baseline/guard change.
- Final existence oracle: restoring a router target pre-load, returning `404` from the meter authorized join miss, and removing the bound-agent foreign-ID pre-deny made all three indistinguishability tests fail (`3/3`, exit `1`). The mutations were removed.
- Final router claim: removing the candidate/status/presence `EXISTS` made all four candidate interleavings assign incorrectly (`4/4`, exit `1`); removing the active-project/write-access `EXISTS` made both project interleavings assign incorrectly (`2/2`, exit `1`). Both predicates were restored.
- Final meter boundary: the exact-head RED run caught `agent_id: null` reaching canonical self state, and caught `Infinity`/`NaN` normalizing instead of refusing. Removing the restored non-finite guard made both estimate regressions fail (`2/2`, exit `1`).
- Final manifest continuity: temporarily recording against `loop.id` instead of the reservation subject made the successful agent-owned and squad-owned cycle tests fail (`2/2`, exit `1`). Canonical `meterSubjectId` recording was restored.

## Exact evidence

Composition commands ran at `24b17a1a9d3cb644d2529f62f7eb79b2fb9433c4` unless noted.

| Literal command | Exit | Result |
| --- | ---: | --- |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/loop-driver-public-boundary.test.ts tests/meter-authorization.test.ts` | 0 | 4 files, 77 tests passed |
| `npm run typecheck` | 0 | TypeScript clean |
| `npm test` | 0 | 442 files, 6,718 tests passed |
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
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/meter-authorization.test.ts tests/loop-runtime.test.ts` (primary `29463de6`) | 0 | 4 files, 98 tests passed |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/tasks-cross-squad-assignment.test.ts tests/loop-driver-public-boundary.test.ts tests/loop-driver.test.ts tests/loop-control-tool.test.ts tests/meter-authorization.test.ts tests/execution-meter.test.ts tests/loop-runtime.test.ts` (primary `29463de6`) | 0 | 9 files, 150 tests passed |
| `npm run typecheck` (primary `29463de6`) | 2 | inherited unrelated main-line errors only; no changed IR-4 path was named |
| `git diff --check origin/main...29463de6` | 0 | clean |

The earlier pre-fix local-evidence run was interrupted by the harness and then rerun. The final-fix local-evidence run completed in one invocation at `24b17a1a`, including the browser smoke, runtime adapter conformance, and governed Project Routine lifecycle. No remote endpoint or production database was selected.

The host has `/usr/bin/python3` (resolved target `/usr/bin/python3.12`) but no
`python` name. For the two exact CI-spelled plugin commands only, PATH was
prefixed with a disposable `/tmp/mupot-ir4-python-shim.*` directory, whose sole
`python` symlink pointed to that target; the directory and symlink were then
removed. This is environment-equivalent to GitHub Actions `setup-python`,
which supplies the `python` alias. No repository or runtime code changed.

## Final review disposition

- IMPORTANT — existence oracle: resolved. Unauthorized missing and foreign router/meter targets are indistinguishable `403`; `404` follows established org-admin, canonical-self, or requested-squad authority only.
- IMPORTANT — router TOCTOU: resolved. The conditional claim atomically repeats task, candidate, live-presence, active-project, and write/admin access eligibility.
- MINOR — defined non-string public `agent_id`, including `null`: resolved with `400` before any D1 access.
- MINOR — manifest reservation/recording subject parity: resolved with successful agent-owned and squad-owned cycle regressions.
- MINOR — positive non-finite estimate handling: resolved; `Infinity` and `NaN` fail closed before reservation.

Deferred code findings: none.

## Primary versus composition posture

Primary `29463de6` has green focused/wider and diff-hygiene evidence. Its typecheck remains exit `2` solely on inherited unrelated main-line errors; it is not an independently green full-suite claim. Composition `24b17a1a` is the authoritative full-suite/typecheck/guard evidence and is green across every literal command above. The plugin commands have environment-equivalent PASS evidence through the disposable `setup-python`-equivalent alias described above.

## Gate and Athena posture

No Athena verdict is bound to this artifact: unavailable/stale or queued is not `GREEN`, `BLOCK`, or `RESHAPE`. The final-review code findings and deferred Minors are resolved locally, but this receipt is not an independent gate verdict, merge approval, deployment receipt, or production assertion. The recomputed receipt SHA-256 is recorded in the tracked Task 5 final-fix report; the receipt commit is returned with the handoff.
