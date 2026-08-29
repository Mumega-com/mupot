# IR-4 stacked composition exact-head receipt

Date: 2026-08-29 UTC

## Identity and boundary

- Local branch: `fix/router-loop-meter-auth-ir4-stacked-20260829`.
- Amended CI foundation base: `50f33b4ad208f8ce80755cee1e6e41a15f832e62`.
- Pre-review receipt head: `dd9f8e0475f1d97bae81417e67fedb4c542906b1`.
- Verified authorization-TOCTOU repair code head: `b15524cb490c820f438c2e02e0217385d3a55012`.
- Reviewed IR-4 source head: `da6bb7b9154e689a37c98d05065957109f94a3c8`.
- Reviewed source receipt SHA-256: `8cabe20cc46b84557beed0ce9f8214149ce0fb2c6ed8cff2f669241693a42689`.
- Independent final review at `dd9f8e04...`: `BLOCK — 1 Important, 0 Critical` for authorization-revocation TOCTOU.
- This receipt records local repair and verification evidence. It is not a new independent verdict, remote CI, merge approval, deployment evidence, or a production assertion.

The owned worktree was clean at exact reviewed head `dd9f8e04...` before repair. No push, PR action, merge, deploy, ACL change, credential mutation, production mutation, or remote migration occurred.

## Exact finding and bounded repair

The pre-review engine checked durable and ambient router authority before entering `runRouterTick`, but the later conditional task claim rechecked only task, candidate, presence, and project state. Revoking the actor's durable lead grant between authorization and claim still allowed assignment and wake.

Repair commit `b15524cb...` changes only five existing IR-4 paths (63 insertions, 4 deletions):

- `src/auth/execution-scope.ts`: preserve the existing decision contract while making the server-derived member requirement explicit.
- `src/mcp/index.ts` and `src/router/routes.ts`: pass only the authenticated server-derived `memberId` as claim authority.
- `src/router/engine.ts`: bind that member to the same conditional `UPDATE` and require a current durable lead-or-higher grant through exact org, department-to-squad, squad, or channel-grant semantics.
- `tests/router-authorization.test.ts`: revoke the lead grant after authorization but before claim, then prove zero assignments, zero wakes, and an unassigned task.

Ambient capability semantics are unchanged: the existing pre-call decision remains the ambient ceiling. The claim predicate can only narrow an already-authorized mutation and cannot resurrect directory-clamped or otherwise absent ambient authority. Existing directory-ceiling decision tests and the org-admin REST assignment path remain green.

No migration, package, workflow, config, guard, or unrelated production path changed. Final base-to-code scope remains the original 16 IR-4 code/test paths plus this receipt.

## Patch and graph evidence

- The original ten reviewed/rebased code commits retain matching one-to-one stable patch IDs.
- Original ten-patch normalized aggregate SHA-256: `9cfcd15e37eebcde71a68cfc5f3a3a20934406e83f291eb8e5c4260dcd6798a5`.
- Repair commit stable patch ID: `ced4c7c7d68757c06f94fd523c5f82c11ee60845`.
- Fixed base-to-code normalized aggregate SHA-256, excluding this receipt path: `4aa0ab39b0a6450d71d66a51d332e731e0c2e1a1a3a8b0e33ea14c268e71b4c4`.
- `git merge-base --is-ancestor 50f33b4a... b15524cb...` exited `0`.
- `git diff --check 50f33b4a...b15524cb...` exited `0`.
- Full graph rebuild at clean code head `b15524cb...`: 1,142 files, 18,914 nodes, 222,080 edges, 365 flows, 66 communities, zero parse errors, `head_matches_build=true`.
- Change detection at code head: 17 files including the receipt, 163 changed functions/classes, 21 affected flows, overall risk `0.90`.

## Strict TDD and mutation witness

| Phase | Command/result | Exit | Evidence |
| --- | --- | ---: | --- |
| Baseline RED | targeted router revocation interleaving | 1 | Expected assigned `0`, received `1`; current code reproduced the review finding. |
| GREEN | targeted regression after atomic predicate | 0 | 1/1 passed; full router authorization file 21/21 passed. |
| Mutation RED | remove only authority predicate and sixth bind | 1 | Expected assigned `0`, received `1`; kill witness proved the new predicate is load-bearing. |
| Restored GREEN | restore exact authority predicate and bind | 0 | 1/1 passed; full router authorization file 21/21 passed. |

An intermediate typed-decision prototype produced typecheck exit `2` and then three focused decision-shape failures. It was not committed. The final refactor preserves the prior `ExecutionScopeDecision` shape and passes the server-derived actor separately; final typecheck and focused evidence are green.

## Exact verification at repair code head

| Literal command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | TypeScript clean. |
| `npx vitest run tests/execution-scope.test.ts tests/router-authorization.test.ts tests/tasks-cross-squad-assignment.test.ts tests/loop-driver-public-boundary.test.ts tests/loop-driver.test.ts tests/loop-control-tool.test.ts tests/meter-authorization.test.ts tests/execution-meter.test.ts tests/loop-runtime.test.ts` | 0 | 9 files, 151 tests passed. |
| `npm test` | 0 | 442 files, 6,722 tests passed in 307.67 seconds. |
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
| `BASE_REF=ir4-toctou-exact-50f33b4a node scripts/check-test-schema-source.mjs` | 0 | Baseline unchanged: files=26, mockDb=127. |
| `npx vitest run tests/check-operator-counts-source.test.ts` | 0 | 7/7 passed. |
| `node scripts/check-operator-counts-source.mjs` | 0 | 48 dashboard files; zero duplicate implementations. |
| `node --test tests/migration-numbering.test.mjs` | 0 | 29/29 passed. |
| `BASE_REF=ir4-toctou-exact-50f33b4a node scripts/check-migration-numbering.mjs` | 0 | No migrations added versus exact amended base. |
| `node --test tests/branch-staleness.test.mjs` | 0 | 10/10 passed. |
| `BASE_REF=ir4-toctou-exact-50f33b4a node scripts/check-branch-staleness.mjs` | 0 | No contested files; zero commits behind exact amended base. |
| `node scripts/design-status-contract-policy.mjs` | 0 | Policy passed. |
| `python -m compileall -q plugin` | 0 | CI-spelled command via disposable `/usr/bin/python3` alias. |
| `python -m pytest plugin/tests` | 0 | 105/105 passed via the same disposable alias. |
| `bash scripts/ci-local-evidence.sh` | 0 | Local D1, browser smoke, runtime adapter conformance, and governed Project Routine lifecycle passed at exact code head `b15524cb...`. |

## Exact target-ref materialization

Repository target-aware guards intentionally resolve `BASE_REF` under `origin/`, while no remote-tracking ref in this clone names amended base `50f33b4a...`. A uniquely named local-only proof ref `refs/remotes/origin/ir4-toctou-exact-50f33b4a` was created at that exact object. All three target-aware guards passed, the ref was re-read unchanged, and deletion used the exact old-object precondition. Post-delete readback confirmed the proof ref absent. No network fetch/push occurred and no existing ref moved.

## Disposition

The final review's sole Important is locally repaired with strict red/green/mutation evidence and a fully green verification matrix. The earlier `BLOCK` applies to `dd9f8e04...`; it is not silently converted into a PASS for this new head. Independent re-review is still required before any approved or merge-ready claim.
