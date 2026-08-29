# IR-4 stacked composition exact-head receipt

Date: 2026-08-29 UTC

## Identity and boundary

- Local branch: `fix/router-loop-meter-auth-ir4-stacked-20260829`.
- Amended CI foundation base: `50f33b4ad208f8ce80755cee1e6e41a15f832e62` (`test(migrations): remove Wrangler startup races`).
- Verified rebased IR-4 code head: `3c2ba213ffbaf9eafca4515915098599c4897de2`.
- Verification head before this receipt refresh: `918666a8cc79ddeb5af0aa635d5cf308dd1bd898` (code head plus the replayed documentation-only receipt commit).
- Reviewed IR-4 source head: `da6bb7b9154e689a37c98d05065957109f94a3c8`.
- Reviewed IR-4 behavior/final-fix source head: `29463de63823188647337e897cf77f8f6066d114`.
- Reviewed source receipt SHA-256: `8cabe20cc46b84557beed0ce9f8214149ce0fb2c6ed8cff2f669241693a42689`.
- This receipt records local composition evidence only. It is not remote CI, an independent gate verdict, merge approval, deployment evidence, or a production assertion.

The owned branch was clean before the rebase. `git rebase --onto 50f33b4a... b0008802...` replayed the ten IR-4 code commits and one receipt commit conflict-free. No other worktree or agent-owned branch was changed. No push, PR action, merge, deploy, ACL change, credential mutation, production mutation, or remote migration occurred.

## Ancestry and diff scope

- `git merge-base --is-ancestor 50f33b4ad208f8ce80755cee1e6e41a15f832e62 918666a8cc79ddeb5af0aa635d5cf308dd1bd898` exited `0`.
- The rebased code range contains 10 commits and changes 16 files: 2,477 insertions and 76 deletions.
- Changed code paths are bounded to router, loop, meter, execution-scope integration, and their tests:
  - `src/agents/{execute,loop,meter}.ts`
  - `src/auth/execution-scope.ts`
  - `src/index.ts`
  - `src/loops/runtime.ts`
  - `src/mcp/index.ts`
  - `src/router/{engine,routes}.ts`
  - `tests/{brain-panel,execution-meter,execution-scope,loop-driver-public-boundary,loop-runtime,meter-authorization,router-authorization}.test.ts`
- The seventeenth stacked path is this composition receipt. No migration, workflow, package, configuration, or unrelated production path is in the IR-4 diff.
- The graph was fully rebuilt at provisional receipt head `918666a8...`: 1,142 files, 18,912 nodes, 222,041 edges, 365 flows, 66 communities, zero parse errors, `head_matches_build=true`.
- Graph change detection found 17 files including the receipt, 161 changed functions/classes, and 21 affected flows. The high risk score (`0.90`) is expected for authorization/routing work and is covered by the focused/adversarial evidence below.

## Reviewed-commit patch equivalence

Every reviewed code commit has the same stable patch ID as its rebased commit:

| Reviewed source | Rebased commit | Stable patch ID |
| --- | --- | --- |
| `10fc4c6e` | `62f6a85b` | `23fe6dfefc0f4dd67acd6565dab512ece61cb978` |
| `47ee79c0` | `429a60a4` | `bccf75f2970d1e9ae203eb6a3aaa4f25873b2d83` |
| `98740ead` | `1e1bcb3a` | `303ccb2d4f8ee1b9d7ef9dbe51d4ba6102134dd5` |
| `7a7d0a03` | `732c4e67` | `e8be553ca32ad3f67f2b846f397d8429b5ab6659` |
| `5628d94a` | `3bff88aa` | `b86d6053e0e6a9b3d65e148864f17c46388f526f` |
| `c66e94c3` | `e3604284` | `e8f0489d50af3247912e982d25abbff3949ddc3e` |
| `c7d72db9` | `93d09f9a` | `012b9bc795f479f6f72661a1351d78e6dd3f63b8` |
| `1de2c022` | `ae6ec56b` | `551827f4acac68244827fda12bc04cafec55d1a9` |
| `3d2af417` | `c1a4f3cf` | `94bfce8340f4bca9ad825740d28778baa6fee95e` |
| `29463de6` | `3c2ba213` | `57d37f074206cc071e952ef08e03d7857d1489d0` |

The aggregate source and rebased code diffs, normalized only by removing Git `index` metadata lines, both have SHA-256 `9cfcd15e37eebcde71a68cfc5f3a3a20934406e83f291eb8e5c4260dcd6798a5`. The only raw diff variance is blob index metadata for `src/mcp/index.ts`, expected from the different foundation parent; content is identical.

The reviewed source's context-specific receipt commits were not replayed as code. This composition receipt replaces them.

## Exact verification on the rebased composition

| Literal command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | TypeScript clean. |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/tasks-cross-squad-assignment.test.ts tests/loop-driver-public-boundary.test.ts tests/loop-driver.test.ts tests/loop-control-tool.test.ts tests/meter-authorization.test.ts tests/execution-meter.test.ts tests/loop-runtime.test.ts` | 0 | 9 files, 150 tests passed. |
| `npm test` | 0 | 442 files, 6,721 tests passed in 611.79 seconds. |
| `npx vitest run tests/flight-spine-delivery-migration-compat.test.ts` | 0 | 1 file, 2 tests passed in 2.73 seconds; the prior timeout blocker is removed. |
| `npm audit --omit=dev --audit-level=moderate` | 0 | 0 vulnerabilities. |
| `node scripts/audit-gate.mjs` | 0 | No unaccepted high/critical dev advisories. |
| `node --test tests/audit-gate.test.mjs` | 0 | 51/51 passed. |
| `npx vitest run --config vitest.composition.config.ts` | 0 | 2 files, 8 workerd composition tests passed. |
| `node --test 'fleet-runtime/**/*.test.mjs'` | 0 | 659/659 passed. |
| `node --test tests/router.test.mjs` | 0 | 10/10 passed. |
| `npx wrangler deploy --dry-run --config wrangler.example.toml` | 0 | Worker bundle and binding dry-run passed. |
| sequential `sqlite3` replay of `migrations/*.sql` into one fresh temporary database | 0 | 126 migration files applied. |
| `node scripts/no-secrets.mjs` | 0 | No secrets found. |
| `node scripts/reserved-bindings.mjs` | 0 | No reserved binding names. |
| `node --test tests/test-schema-source.test.mjs` | 0 | 16/16 passed. |
| `BASE_REF=ir4-amended-exact-50f33b4a node scripts/check-test-schema-source.mjs` | 0 | Baseline unchanged: files=26, mockDb=127. |
| `npx vitest run tests/check-operator-counts-source.test.ts` | 0 | 7/7 passed. |
| `node scripts/check-operator-counts-source.mjs` | 0 | 48 dashboard files; zero duplicate implementations. |
| `node --test tests/migration-numbering.test.mjs` | 0 | 29/29 passed. |
| `BASE_REF=ir4-amended-exact-50f33b4a node scripts/check-migration-numbering.mjs` | 0 | No migrations added versus exact amended base. |
| `node --test tests/branch-staleness.test.mjs` | 0 | 10/10 passed. |
| `BASE_REF=ir4-amended-exact-50f33b4a node scripts/check-branch-staleness.mjs` | 0 | No contested files; zero commits behind exact amended base. |
| `node scripts/design-status-contract-policy.mjs` | 0 | Policy passed. |
| `python -m compileall -q plugin` | 0 | CI-spelled command via disposable `/usr/bin/python3` alias. |
| `python -m pytest plugin/tests` | 0 | 105/105 passed via the same disposable alias. |
| `bash scripts/ci-local-evidence.sh` | 0 | Local D1, browser smoke, runtime adapter conformance, and governed Project Routine lifecycle passed at exact verification head `918666a8...`. |
| `git diff --check 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` | 0 | Clean before receipt refresh. |

## Exact target-ref materialization

The amended base object and local agent-owned branch existed, but no `origin/*` ref resolved to it. Repository guards intentionally prepend `origin/` to `BASE_REF` and fail closed without one. The first schema-ratchet attempt with the local branch name exited `1` as `target unreadable`; it did not report a schema violation.

For authoritative local guard evidence, a uniquely named local-only proof ref `refs/remotes/origin/ir4-amended-exact-50f33b4a` was created at exact `50f33b4a...`. All three target-aware guards passed, the ref was re-read as exact `50f33b4a...`, and deletion used that exact old-object precondition. Post-delete readback confirmed the proof ref absent. No network fetch or push occurred, and no existing ref was moved.

## Prior timeout blocker disposition

The old base produced one full-suite timeout in `tests/flight-spine-delivery-migration-compat.test.ts`. The amended base adds `test(migrations): remove Wrangler startup races`. At the rebased composition, the literal focused migration-compatibility test passed 2/2 in 2.73 seconds and the literal full suite passed all 6,721 tests. The prior timeout blocker is removed; no IR-4 code or test was changed to obtain this result.

## Disposition

IR-4 composition, exact amended-base ancestry, graph freshness, stable patch equivalence, focused behavior, literal full suite, typecheck, plugin, local evidence, diff hygiene, and every repository guard are locally green. Remaining external prerequisites are authority to push/open the stacked draft and an independent gate verdict. No gate verdict, merge approval, deployment receipt, or production assertion is implied.
