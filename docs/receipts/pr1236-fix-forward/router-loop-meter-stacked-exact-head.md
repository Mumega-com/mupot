# IR-4 router, loop, and meter current-main exact-head receipt

Date: 2026-08-30 UTC

## Candidate identity

- Current main/base: `8be1cac703871ed4886c949a0209233320d77965`.
- Freshly verified code head: `a782e8fca7bf70e9f90d12eb7496418a8defcbc4`.
- Remote pre-restack head: `e148bbca52a19cf28bc5b99f27d1ce5b3aaa281a`.
- Remote PR: #1242, still draft and based on `fix/ci-foundation-ir1-20260829` at receipt-writing time.
- Restack worktree: `/mnt/HC_Volume_104325311/mupot-worktrees/router-loop-meter-ir4-main-restack`.
- Scope: router, loop, and execution-meter authorization plus tests and this receipt; no migration.
- Operations at receipt-writing time: no force-push, PR retarget, merge, deploy, credential action, ACL change, remote migration, or production mutation.

This receipt commit is a documentation-only child of verified code head `a782e8fc`. Fresh executable and graph claims below bind to that exact code head. Remote publication must use an exact force-with-lease against `e148bbca`, retarget PR #1242 to `main`, and obtain fresh remote CI plus independent/Athena verdicts.

## Current-main restack

The complete 13-commit IR-4 series rebased without conflict from amended-CI base `50f33b4ad208f8ce80755cee1e6e41a15f832e62` onto verified main `8be1cac703871ed4886c949a0209233320d77965`.

Current commits after main, in order:

1. `1b18fd88` — resolve execution scope
2. `951bf536` — preserve execution scope ceiling
3. `4b31c7fd` — fence task routing
4. `24f435ff` — preserve router mutation presence
5. `6dab5a6c` — reject nullable dry-run
6. `a8369190` — keep loop driver internal
7. `981604b0` — bind meter status and reservation
8. `f90a7c3e` — persist truthful meter refusal notes
9. `a56634cd` — use migration-backed loop runtime DB
10. `269037d4` — harden scopes and routing claims
11. `60365d2a` — preserve prior stack receipt
12. `5da8ef65` — recheck router claim authority
13. `a782e8fc` — preserve prior TOCTOU repair receipt

`origin/main` is an ancestor, the candidate is 13 commits ahead, and `git diff --check origin/main...HEAD` exited 0. The bounded delta is 17 files, 2,627 insertions, and 76 deletions.

## Patch-equivalence proof

All 13 stable patch IDs match the pre-restack series:

| Pre-restack | Current-main | Stable patch ID |
|---|---|---|
| `62f6a85b` | `1b18fd88` | `23fe6dfefc0f4dd67acd6565dab512ece61cb978` |
| `429a60a4` | `951bf536` | `bccf75f2970d1e9ae203eb6a3aaa4f25873b2d83` |
| `1e1bcb3a` | `4b31c7fd` | `303ccb2d4f8ee1b9d7ef9dbe51d4ba6102134dd5` |
| `732c4e67` | `24f435ff` | `e8be553ca32ad3f67f2b846f397d8429b5ab6659` |
| `3bff88aa` | `6dab5a6c` | `b86d6053e0e6a9b3d65e148864f17c46388f526f` |
| `e3604284` | `a8369190` | `e8f0489d50af3247912e982d25abbff3949ddc3e` |
| `93d09f9a` | `981604b0` | `012b9bc795f479f6f72661a1351d78e6dd3f63b8` |
| `ae6ec56b` | `f90a7c3e` | `551827f4acac68244827fda12bc04cafec55d1a9` |
| `c1a4f3cf` | `a56634cd` | `94bfce8340f4bca9ad825740d28778baa6fee95e` |
| `3c2ba213` | `269037d4` | `57d37f074206cc071e952ef08e03d7857d1489d0` |
| `dd9f8e04` | `60365d2a` | `f2114e5b79d58399a220d5a3ea2286c8643e24f8` |
| `b15524cb` | `5da8ef65` | `ced4c7c7d68757c06f94fd523c5f82c11ee60845` |
| `e148bbca` | `a782e8fc` | `8bdd3e3e253e3f637c51691e14d16ee8a62d5b86` |

The rebase changed ancestry and commit IDs, not the reviewed patches.

## Security invariants

- Server-derived execution scope clamps router, loop, and meter operations to the authenticated tenant, actor, project, squad, and channel boundaries.
- Ambient capability remains a ceiling; durable claim authority is rechecked in the same conditional router task update.
- Revoking lead authority between authorization and claim produces zero assignments and zero wakes.
- Router mutation requires explicit presence and rejects nullable dry-run ambiguity.
- Loop driver remains internal; meter status and reservations preserve scoped, truthful refusal state.
- Caller input cannot widen resolved execution scope or resurrect absent authority.

Historical RED/GREEN/mutation evidence remains patch-equivalent: removing the claim-time authority predicate re-enabled the revoked actor assignment, while the restored exact predicate refused it.

## Exact-head graph

Full graph rebuild at `a782e8fca7bf70e9f90d12eb7496418a8defcbc4`: `head_matches_build=true`, 1,145 parsed files, 18,992 nodes, 224,267 edges, 365 flows, 66 communities, and zero errors. Change detection reports 17 files, 163 changed functions/classes, 21 affected flows, and risk 0.90; focused real-SQL and adversarial tests cover the graph gaps.

## Fresh current-main verification

| Evidence | Result |
|---|---|
| Pre-restack baseline full suite | 442 files / 6,722 tests, exit 0 |
| Focused execution/router/loop/meter matrix | 9 files / 151 tests, exit 0 |
| Typecheck | exit 0 |
| Composed full suite | 442 files / 6,767 tests, exit 0 |
| Production dependency audit | 0 vulnerabilities |
| Dev audit gate and self-tests | gate pass; 51/51 |
| Workerd composition | 2 files / 8 tests |
| Fleet runtime | 659/659 |
| Router rules | 10/10 |
| Plugin | 105/105 |
| Schema/migration/branch guard self-tests | 55/55 |
| Operator-count tests | 7/7 |
| no-secrets, reserved bindings, schema-source, operator-source, migration, staleness, design, diff guards | exit 0 |
| Wrangler dry-run bundle | exit 0 |
| In-memory full migration replay through `0136` | exit 0 |
| `bash scripts/ci-local-evidence.sh` | exit 0; migrations, browser smoke, runtime conformance, and governed Project Routine lifecycle at `a782e8fc` |

Local evidence used only local resources. No remote database or production mutation occurred.

## Ruling

The IR-4 current-main restack is locally green and patch-equivalent to the previously reviewed series. It is not merge-ready. Fresh exact-head internal review, remote CI, and Athena Artifact+SHA verdict are mandatory. Even after those gates pass, PR #1242 must remain unmerged until Hadi gives separate direct merge approval.

## Historical binding

The superseded stack used base `50f33b4a` and head `e148bbca`. Its independent review and Athena evidence remain historical only and cannot gate this new ancestry.
