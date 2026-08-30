# IR-3 credential-rotation current-main exact-head receipt

Date: 2026-08-30 UTC

## Candidate identity

- Current main/base: `90bd166e69173b01d1cef3fd48b369270e8bc998`
- Freshly verified exact head: `1221ae1c62ae23da3ae8b27cfb313149b82dcc06`
- Branch: `fix/credential-rotation-ir3-stacked-20260829`
- Worktree: `/mnt/HC_Volume_104325311/mupot-worktrees/credential-rotation-ir3-stacked`
- Pull request: draft PR #1243. At receipt-writing time its remote head was still pre-restack `acfbcd16fbef209d4393a5bce4ff0d2b3ced57de` and its base was still `fix/ci-foundation-ir1-20260829`.
- Operations at receipt-writing time: no rebased force-push, PR retarget, merge, deploy, live credential action, remote migration, ACL change, or production mutation.

This receipt commit is a documentation-only child of verified head `1221ae1c`. Fresh test and graph claims bind to that exact head. Publication must use an exact force-with-lease against remote head `acfbcd16`, retarget PR #1243 to `main`, and obtain new remote CI and Athena evidence. The prior Athena verdict cannot transfer to the new head.

## Current-main restack

The complete bounded IR-3 series rebased without conflict from amended-CI base `50f33b4ad208f8ce80755cee1e6e41a15f832e62` onto current main `90bd166e69173b01d1cef3fd48b369270e8bc998`.

Current commits after main, in order:

1. `ead0c4aa` — make replacement atomic
2. `2ae1ef8c` — stage durable replacement handoff
3. `17acc7ce` — reserve replacement before claim creation
4. `b640c176` — gate audit on claim readiness
5. `5896a122` — recover stale claims
6. `2246f80b` — close rotation review gaps
7. `8e97e32a` — recover lost-success and double-failure handoffs
8. `7dda7eb2` — renumber stacked migrations
9. `f0f739f8` — preserve the prior receipt
10. `d0125923` — enforce org authority and lease stale pending claims
11. `1221ae1c` — preserve the prior final-review refresh

Ancestry and `git diff --check origin/main...HEAD` exited 0. At verified head `1221ae1c`, the candidate was 11 commits ahead of main and changed 12 files: 11 bounded code/test/migration files plus this receipt, with 2,373 insertions and 78 deletions.

## Patch-equivalence proof

Stable patch IDs matched for all 11 pre-restack/current-main commit pairs:

| Pre-restack | Current-main | Stable patch ID |
|---|---|---|
| `3ac33913` | `ead0c4aa` | `b0a365ff86014c23b4874560b2f724b15e2013f7` |
| `a5d4f722` | `2ae1ef8c` | `f88747416dc05798b88fe59d16067fce2e579b37` |
| `4bec99b1` | `17acc7ce` | `9c1b5f893b7e34e62bc563b4a2c0c93fdd157244` |
| `7946e95b` | `b640c176` | `acd5d919e3d81e09ea283c9210e9ee0ae9c91518` |
| `e65eead0` | `5896a122` | `03b5c8366cb8b603984f6d2aa4f6c2f0c89d5e0c` |
| `b7d9b410` | `2246f80b` | `d772f11d22f8dba3e0294dd3cea0e068c2c5ec72` |
| `0aa816a9` | `8e97e32a` | `dd16512e925e238d2038ebb9fdef941e4ea86086` |
| `400a54b5` | `7dda7eb2` | `40c634c3e50dfb32de77ead02a67c1f042f6f482` |
| `f69b1ad5` | `f0f739f8` | `98e1b5419e27beadc0cfff39a0f7651b3adc917e` |
| `8b1d9dc6` | `d0125923` | `7890c1c1da5ccfcb7eec0eb920a76dbcd50f91c7` |
| `acfbcd16` | `1221ae1c` | `421b8ec4c929f0b89df89f1bf240c2d9f344d347` |

The rebase changed ancestry and commit identity, not the reviewed patches. Historical predicate mutation witnesses remain patch-equivalent evidence; fresh executable verification was run in full.

## Security and recovery invariants

- Rotation authorization is server-derived and checked before agent, token, or handoff lookup. Non-org administrators get one uniform `403 forbidden` response for existing, missing, and ambiguous agent references.
- Migration `0136` provides a 60-second claim-put lease and trigger-backed inactive-token cleanup. Missing claims fail closed before expiry; after expiry, one exact DELETE compare-and-swap reclaims the unready reservation.
- Lost-success retries resume the durable active replacement without revoking it or burning its one-time claim.
- Claim-put/mark-ready/cancel double failures preserve resumable claims while late orphan claims are compensated.
- Tenant, member, agent, claim-owner, audit-state, and single-handoff welding remain intact; raw credentials are not persisted.

Patch-equivalent mutation witnesses previously observed RED before restoration: removing the org gate restored target-dependent responses; removing expiry reclaimed pre-expiry state; disabling cleanup left two inactive tokens; removing late-claim compensation left one revealable orphan claim.

## Migration and graph evidence

Migration numbering exited 0. Current main ends at `0133_source_ack_trigger_d1_compat.sql`; IR-3 adds ordered migrations `0134`, `0135`, and `0136`.

The code-review graph received a full rebuild at exact verified head `1221ae1c62ae23da3ae8b27cfb313149b82dcc06`. It reported `head_matches_build=true`, 1,138 parsed files, 18,828 nodes, 222,509 edges, 365 flows, 65 communities, and zero parse errors.

## Fresh current-main verification

| Command | Exit/result |
|---|---|
| focused credential/provision Vitest matrix | exit 0; 4 files, 146/146 |
| adjacent token lifecycle real-schema tests | exit 0; 14/14 |
| `npm run typecheck` | exit 0; exact head `1221ae1c`, clean |
| literal `npm test` | exit 0; 438/438 files, 6,682/6,682 tests |
| plugin compile and `python3 -m pytest plugin/tests` | exit 0; 105/105 tests |
| schema-source, migration-numbering, and branch-staleness self-tests | exit 0; 55/55 |
| operator-count source tests | exit 0; 7/7 |
| no-secrets and reserved-binding guards | exit 0 |
| schema-source baseline guard | exit 0; files 26/26 and mockDb 127/127 |
| operator-count guard | exit 0; 48 dashboard files, zero duplicate implementations |
| migration, branch-staleness, design-status, and diff guards | exit 0; current main `0133`, candidate through `0136`, zero behind |
| `bash scripts/ci-local-evidence.sh` | exit 0; local migrations through `0136`, browser smoke, runtime adapter conformance, and governed Project Routine lifecycle |

Local evidence used only local databases. No remote D1 migration or production mutation occurred.

## Ruling

The current-main restack is locally green and patch-equivalent to the previously reviewed IR-3 series. It is not yet merge-ready. Fresh independent review, exact remote CI on the published head, and a new Athena Artifact+SHA GREEN verdict are mandatory. Even after those gates pass, PR #1243 must remain unmerged until Hadi gives separate explicit merge approval.

## Historical binding

The superseded amended-CI stack used base `50f33b4a`, verified code head `8b1d9dc6`, receipt head `acfbcd16`, and a prior Athena verdict bound to that old artifact. Those receipts remain valid historical evidence only; they do not authorize or gate the current-main head.
