# IR-3 credential-rotation stacked exact-head receipt

Date: 2026-08-29 UTC

## Candidate identity

- Amended CI base: `50f33b4ad208f8ce80755cee1e6e41a15f832e62`
- Verified code head: `400a54b5abb6bce97e535a339b250016f737bc05`
- Branch: `fix/credential-rotation-ir3-stacked-20260829`
- Worktree: `/mnt/HC_Volume_104325311/mupot-worktrees/credential-rotation-ir3-stacked`
- Original bounded IR-3 head replayed: `7e1c31e282bc17a5fc4fd8460c27c9095f552676`
- Publication/operations: no push, pull request, merge, deploy, credential action, remote migration, ACL change, or production mutation.

This receipt commit is a documentation-only child of the verified code head. Test claims below bind to `400a54b5abb6bce97e535a339b250016f737bc05`.

## Replay and bounded diff

The eight IR-3 commits replayed in original order without conflict:

1. `3ac33913` — make replacement atomic
2. `a5d4f722` — stage durable replacement handoff
3. `4bec99b1` — reserve replacement before claim creation
4. `7946e95b` — gate audit on claim readiness
5. `e65eead0` — recover stale claims
6. `b7d9b410` — close rotation review gaps
7. `0aa816a9` — recover lost-success and double-failure handoffs
8. `400a54b5` — renumber stacked migrations

`git merge-base --is-ancestor 50f33b4ad208f8ce80755cee1e6e41a15f832e62 HEAD` exited 0. `git rev-list --count 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` returned 8.

`git diff --name-status 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` contained exactly nine bounded files:

- added `migrations/0134_agent_token_rotation_handoffs.sql`
- added `migrations/0135_agent_token_rotation_claim_ready.sql`
- modified `src/auth/credential-claim.ts`
- modified `src/auth/token-lifecycle.ts`
- modified `src/dashboard/index.ts`
- modified `src/mcp/provision.ts`
- modified `src/members/service.ts`
- modified `tests/agent-token-lifecycle.test.ts`
- modified `tests/dashboard-agent-token.test.ts`

Diff size: 2,026 insertions and 76 deletions. `git diff --check 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` exited 0.

## Migration and graph evidence

`node scripts/check-migration-numbering.mjs` exited 0. The composed chain is:

- `0133_source_ack_trigger_d1_compat.sql` — amended CI base
- `0134_agent_token_rotation_handoffs.sql` — IR-3
- `0135_agent_token_rotation_claim_ready.sql` — IR-3

The code-review graph was rebuilt in the actual stacked worktree at `400a54b5abb6bce97e535a339b250016f737bc05`; `head_matches_build=true`. It parsed 1,137 files, produced 18,822 nodes and 222,215 edges, reported risk `0.95`, and identified 40 affected flows. The graph's static coverage gaps remain bounded by the focused real-schema route/concurrency tests and the previously recorded predicate mutation witnesses.

## Verification

| Command | Exit/result |
|---|---|
| pre-replay `npx vitest run tests/dashboard-agent-token.test.ts tests/agent-token-lifecycle.test.ts tests/provision-tools.test.ts tests/provision-real-schema.test.ts` | exit 0; 101/101 |
| post-replay same focused command | exit 0; 142/142 |
| `npx vitest run tests/token-lifecycle-real-schema.test.ts` | exit 0; 14/14 |
| `npm run typecheck` | exit 0 |
| literal `npm test` | exit 0; 438/438 files, 6,678/6,678 tests |
| `python3 -m compileall -q plugin` | exit 0 |
| `python3 -m pytest plugin/tests` | exit 0; 105/105 |
| `node --test tests/test-schema-source.test.mjs tests/migration-numbering.test.mjs tests/branch-staleness.test.mjs` | exit 0; 55/55 |
| `npx vitest run tests/check-operator-counts-source.test.ts` | exit 0; 7/7 |
| `node scripts/no-secrets.mjs` | exit 0; no secrets found |
| `node scripts/reserved-bindings.mjs` | exit 0; no reserved binding names |
| `node scripts/check-test-schema-source.mjs` | exit 0; files 26/26 and mockDb 127/127 baselines unchanged |
| `node scripts/check-operator-counts-source.mjs` | exit 0; 48 dashboard files, zero second implementations |
| `node scripts/check-migration-numbering.mjs` | exit 0 |
| `node scripts/check-branch-staleness.mjs` | exit 0; no contested files, zero behind `origin/main` |
| `node scripts/design-status-contract-policy.mjs` | exit 0 |
| `bash scripts/ci-local-evidence.sh` | exit 0; migrations, browser smoke, runtime conformance, and governed Project Routine lifecycle passed |

The CI workflow spells the plugin executable as `python`; this host has no `python` shim, so that preliminary invocation exited 127. The exact CI operations were rerun with the installed Python 3.12 interpreter as `python3` and passed as recorded above.

## Ruling

The bounded IR-3 stack is locally verified on amended CI head `50f33b4a`. This receipt does not claim remote checks, independent review, Athena Artifact+SHA verdict, PR readiness, merge readiness, deployment, or production parity.
