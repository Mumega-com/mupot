# IR-3 credential-rotation stacked exact-head receipt

Date: 2026-08-29 UTC

## Candidate identity

- Amended CI base: `50f33b4ad208f8ce80755cee1e6e41a15f832e62`
- Verified code head: `8b1d9dc643a076eb8a77fec1dd01c45684c102e7`
- Branch: `fix/credential-rotation-ir3-stacked-20260829`
- Worktree: `/mnt/HC_Volume_104325311/mupot-worktrees/credential-rotation-ir3-stacked`
- Original bounded IR-3 head replayed: `7e1c31e282bc17a5fc4fd8460c27c9095f552676`
- Publication/operations: no push, pull request, merge, deploy, credential action, remote migration, ACL change, or production mutation.

This refreshed receipt commit is a documentation-only child of the verified code head. Test claims below bind to `8b1d9dc643a076eb8a77fec1dd01c45684c102e7`.

## Replay and bounded diff

The eight original IR-3 commits replayed in order without conflict, followed by the first receipt and bounded final-review repair:

1. `3ac33913` — make replacement atomic
2. `a5d4f722` — stage durable replacement handoff
3. `4bec99b1` — reserve replacement before claim creation
4. `7946e95b` — gate audit on claim readiness
5. `e65eead0` — recover stale claims
6. `b7d9b410` — close rotation review gaps
7. `0aa816a9` — recover lost-success and double-failure handoffs
8. `400a54b5` — renumber stacked migrations
9. `f69b1ad5` — record the first stacked exact-head receipt
10. `8b1d9dc6` — enforce org authority and lease stale pending claims

`git merge-base --is-ancestor 50f33b4ad208f8ce80755cee1e6e41a15f832e62 HEAD` exited 0. At the verified code head, `git rev-list --count 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` returned 10.

At the verified code head, `git diff --name-status 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` contained eleven bounded code/test/migration files plus this receipt:

- added `migrations/0134_agent_token_rotation_handoffs.sql`
- added `migrations/0135_agent_token_rotation_claim_ready.sql`
- added `migrations/0136_agent_token_rotation_claim_put_lease.sql`
- modified `src/auth/credential-claim.ts`
- modified `src/auth/token-lifecycle.ts`
- modified `src/dashboard/index.ts`
- modified `src/mcp/provision.ts`
- modified `src/members/service.ts`
- modified `tests/agent-token-lifecycle.test.ts`
- modified `tests/dashboard-agent-token.test.ts`
- modified `tests/provision-tools.test.ts`
- added `docs/receipts/2026-08-29-ir3-credential-rotation-stacked-exact-head.md`

Verified-code-head diff size: 2,344 insertions and 78 deletions. `git diff --check 50f33b4ad208f8ce80755cee1e6e41a15f832e62..HEAD` exited 0.

## Migration and graph evidence

`node scripts/check-migration-numbering.mjs` exited 0. The composed chain is:

- `0133_source_ack_trigger_d1_compat.sql` — amended CI base
- `0134_agent_token_rotation_handoffs.sql` — IR-3
- `0135_agent_token_rotation_claim_ready.sql` — IR-3
- `0136_agent_token_rotation_claim_put_lease.sql` — IR-3 final-review recovery

The code-review graph received a full rebuild in the actual stacked worktree at `8b1d9dc643a076eb8a77fec1dd01c45684c102e7`; `head_matches_build=true`. It parsed 1,138 files and produced 18,828 nodes and 222,505 edges. These are full-build counts after the final code change, not historical incremental counts. The graph's static coverage gaps remain bounded by the focused real-schema route/concurrency tests and predicate mutation witnesses.

## Final-review findings and TDD evidence

- I-1: rotation now checks server-derived `isOrgAdmin(auth)` before agent resolution and every token/handoff lookup. A squad admin receives the same `403 forbidden` with `{ need: 'admin', scope: 'org' }` for existing, missing, and ambiguous agent references; ordinary non-rotation mint semantics remain scoped separately.
- I-2: migration `0136` adds an explicit 60-second claim-put lease and trigger-backed atomic pending-token cleanup. Before expiry, missing claim remains fail-closed and untouched. After expiry, one exact DELETE CAS reclaims the unready reservation; a subsequent retry elects a fresh single winner. A late in-flight claim is burned when mark-ready observes that the exact reservation no longer exists.

RED was observed before implementation:

- scoped-admin rotation returned target-dependent `[503, 404, 409]` instead of uniform 403;
- crash-after-stage, claim-fail plus cancel-fail, and late-put scenarios retained the stale handoff after lease time.

GREEN after implementation:

- authorization witness: 1/1;
- stale/no-claim and late-claim witnesses: 3/3;
- complete focused credential/provision matrix: 146/146.

Mutation witnesses were temporary, observed RED, and restored:

1. remove the early org gate → target-dependent `[503, 404, 409]` returned;
2. remove the lease-expiry comparison → pre-expiry retry deleted the reservation;
3. disable the pending-token cleanup trigger → inactive token count remained 2;
4. remove missing-reservation late-claim compensation → one revealable claim remained.

## Verification

| Command | Exit/result |
|---|---|
| pre-replay `npx vitest run tests/dashboard-agent-token.test.ts tests/agent-token-lifecycle.test.ts tests/provision-tools.test.ts tests/provision-real-schema.test.ts` | exit 0; 101/101 |
| post-final-review same focused command | exit 0; 146/146 |
| `npx vitest run tests/token-lifecycle-real-schema.test.ts` | exit 0; 14/14 |
| `npm run typecheck` | exit 0 |
| literal `npm test` | exit 0; 438/438 files, 6,682/6,682 tests |
| `python3 -m compileall -q plugin` | exit 0 |
| `python3 -m pytest plugin/tests` | exit 0; 105/105 |
| `node --test tests/test-schema-source.test.mjs tests/migration-numbering.test.mjs tests/branch-staleness.test.mjs` | exit 0; 55/55 |
| `npx vitest run tests/check-operator-counts-source.test.ts` | exit 0; 7/7 |
| `node scripts/no-secrets.mjs` | exit 0; no secrets found |
| `node scripts/reserved-bindings.mjs` | exit 0; no reserved binding names |
| `node scripts/check-test-schema-source.mjs` | exit 0; files 26/26 and mockDb 127/127 baselines unchanged |
| `node scripts/check-operator-counts-source.mjs` | exit 0; 48 dashboard files, zero second implementations |
| `node scripts/check-migration-numbering.mjs` | exit 0; `0133` through `0136` ordered |
| `node scripts/check-branch-staleness.mjs` | exit 0; no contested files, zero behind `origin/main` |
| `node scripts/design-status-contract-policy.mjs` | exit 0 |
| `bash scripts/ci-local-evidence.sh` | exit 0; migrations, browser smoke, runtime conformance, and governed Project Routine lifecycle passed |

The CI workflow spells the plugin executable as `python`; this host has no `python` shim, so that preliminary invocation exited 127. The exact CI operations were rerun with the installed Python 3.12 interpreter as `python3` and passed as recorded above.

## Ruling

The two Important findings from the independent final review are repaired and locally verified on amended CI head `50f33b4a`. A fresh independent exact-head re-review is still required. This receipt does not claim remote checks, Athena Artifact+SHA verdict, PR readiness, merge readiness, deployment, or production parity.
