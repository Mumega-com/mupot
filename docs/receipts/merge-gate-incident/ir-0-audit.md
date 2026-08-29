# IR-0 Merge-Gate Incident Audit

Status: `AWAITING_ATHENA`

Date: 2026-08-29 UTC

Flight: `e0ba3c5d-765f-41a6-adec-066609704793`

Task: `c209e994-5540-4ff8-aa02-39884dfbdc3d`

Authority: Hadi removed Loom from this recovery lane. Kasra sequences the work, Athena independently gates exact artifacts, and Hadi retains merge, deployment, credential, branch-setting, and production-mutation authority.

## Verdict

The Mupot repository experienced a merge-control incident, not only an oversized-PR failure.

The evidence proves that a persistent red repository state began at PR #1201, widened across later merges, and was repeatedly carried into `main`. Between PRs #1205 and #1232, 26 PRs merged while their reviewed heads had a non-green CI conclusion. Thirteen merged less than 60 seconds after creation, and 21 Codex reviews were submitted only after merge.

The exact current `main` SHA is deployed at the public Mupot endpoint. Deployment of the code does not by itself prove that every new route is enabled, every migration applied, or every reviewed defect reachable; those narrower runtime claims remain `UNPROVEN` until IR-2.

## Scope and counting law

The numeric interval #1205–#1232 contains 28 PR numbers.

- 26 are merged.
- #1211 is an open obsolete draft with no Codex review and no current non-green check.
- #1217 is open, non-draft, red, and has four unresolved P2 threads.
- The phrase “27 audited PRs” means the 28-number interval minus excluded obsolete/no-review draft #1211.
- The 198 count covers unresolved Codex review threads on the 26 merged PRs only. It is not a count of deduplicated current defects.

## Reproduced aggregate facts

| Claim | Reproduced result |
|---|---:|
| PR numbers in #1205–#1232 | 28 |
| Audited after excluding #1211 | 27 |
| Merged | 26 |
| Merged in under 60 seconds | 13 |
| Codex reviews submitted after merge | 21 |
| Merged unresolved P1 threads | 106 |
| Merged unresolved P2 threads | 92 |
| Merged unresolved threads total | 198 |
| #1222–#1232 unresolved threads | 95 |

Every reviewed PR in the 27-PR audit set has a non-green latest-head conclusion. #1211 is the explicit exception excluded from that set.

## Chronology of repository redness

| Point | Evidence-backed state |
|---|---|
| #1201 | Added `migrations/0128_fenced_deliveries.sql`; its reviewed head had 13/14 checks pass and `local-evidence` failed. This is the first persistent red gate in the audited lineage. |
| #1209 | `build` first appears red in the reproduced check ledger; `local-evidence` and `branch-staleness` were also red. |
| #1210 | Merged in 29 seconds with `build` and `local-evidence` red. |
| #1211 | Draft follow-up remains open, has no Codex review, and was not merged. Its unique-commit value must be checked before closure. |
| #1213 | `build` remained red. The exact separation of typecheck versus full-test failure within that job requires historical job-log retention and is not inferred from the check name alone. |
| #1215 | `build`, `no-secrets`, `test-schema-source`, `local-evidence`, and `branch-staleness` were red. |
| #1232 | Merged as `41330115de7304c95654f57949b41c24761b2e8f`; no later merge repaired main. |

The exact historical claim “typecheck became red at #1213” is plausible but remains `UNPROVEN` in this artifact because the historical `build` job logs were not available through `gh run view`. Current clean-main typecheck is independently confirmed red.

## Per-PR ledger

“Non-green” is the latest result per check name on the PR’s current head. “Late review” means the GitHub review `submitted_at` timestamp is later than `merged_at`.

| PR | State | Merge seconds | Non-green latest checks | Late review | P1 | P2 |
|---:|---|---:|---|---:|---:|---:|
| [#1205](https://github.com/Mumega-com/mupot/pull/1205) | merged | 2831 | local-evidence, migration-numbering | 0 | 3 | 2 |
| [#1206](https://github.com/Mumega-com/mupot/pull/1206) | merged | 2115 | local-evidence | 0 | 4 | 5 |
| [#1207](https://github.com/Mumega-com/mupot/pull/1207) | merged | 1559 | local-evidence | 0 | 6 | 4 |
| [#1208](https://github.com/Mumega-com/mupot/pull/1208) | merged | 85 | local-evidence | 1 | 3 | 4 |
| [#1209](https://github.com/Mumega-com/mupot/pull/1209) | merged | 153 | branch-staleness, build, local-evidence | 1 | 1 | 6 |
| [#1210](https://github.com/Mumega-com/mupot/pull/1210) | merged | 29 | build, local-evidence | 1 | 1 | 2 |
| [#1211](https://github.com/Mumega-com/mupot/pull/1211) | open draft | — | none on current head | 0 | 0 | 0 |
| [#1212](https://github.com/Mumega-com/mupot/pull/1212) | merged | 883 | build, local-evidence | 1 | 3 | 4 |
| [#1213](https://github.com/Mumega-com/mupot/pull/1213) | merged | 903 | build, local-evidence | 1 | 6 | 4 |
| [#1214](https://github.com/Mumega-com/mupot/pull/1214) | merged | 185 | branch-staleness, build, local-evidence | 1 | 4 | 4 |
| [#1215](https://github.com/Mumega-com/mupot/pull/1215) | merged | 773 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 1 | 7 | 0 |
| [#1216](https://github.com/Mumega-com/mupot/pull/1216) | merged | 50 | build, local-evidence, no-secrets, test-schema-source | 1 | 1 | 5 |
| [#1217](https://github.com/Mumega-com/mupot/pull/1217) | open | — | build, local-evidence, no-secrets, test-schema-source | 0 | 0 | 4 |
| [#1218](https://github.com/Mumega-com/mupot/pull/1218) | merged | 604 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 0 | 4 | 1 |
| [#1219](https://github.com/Mumega-com/mupot/pull/1219) | merged | 943 | build, local-evidence, no-secrets, test-schema-source | 1 | 0 | 2 |
| [#1220](https://github.com/Mumega-com/mupot/pull/1220) | merged | 615 | ten CI jobs cancelled | 0 | 3 | 5 |
| [#1221](https://github.com/Mumega-com/mupot/pull/1221) | merged | 3103 | build, local-evidence, no-secrets, test-schema-source | 1 | 5 | 4 |
| [#1222](https://github.com/Mumega-com/mupot/pull/1222) | merged | 5 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 1 | 5 | 2 |
| [#1223](https://github.com/Mumega-com/mupot/pull/1223) | merged | 7 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 1 | 4 | 8 |
| [#1224](https://github.com/Mumega-com/mupot/pull/1224) | merged | 8 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 1 | 0 | 1 |
| [#1225](https://github.com/Mumega-com/mupot/pull/1225) | merged | 9 | build, local-evidence, no-secrets, test-schema-source | 1 | 1 | 3 |
| [#1226](https://github.com/Mumega-com/mupot/pull/1226) | merged | 52 | branch-staleness, build, local-evidence, no-secrets, test-schema-source | 1 | 7 | 6 |
| [#1227](https://github.com/Mumega-com/mupot/pull/1227) | merged | 9 | build, local-evidence, no-secrets, test-schema-source | 1 | 7 | 6 |
| [#1228](https://github.com/Mumega-com/mupot/pull/1228) | merged | 11 | build, local-evidence, no-secrets, test-schema-source | 1 | 5 | 4 |
| [#1229](https://github.com/Mumega-com/mupot/pull/1229) | merged | 8 | build, local-evidence, no-secrets, test-schema-source | 1 | 8 | 2 |
| [#1230](https://github.com/Mumega-com/mupot/pull/1230) | merged | 51 | build, local-evidence, no-secrets, test-schema-source | 1 | 4 | 4 |
| [#1231](https://github.com/Mumega-com/mupot/pull/1231) | merged | 9 | build, local-evidence, no-secrets, test-schema-source | 1 | 5 | 4 |
| [#1232](https://github.com/Mumega-com/mupot/pull/1232) | merged | 10 | build, local-evidence, no-secrets, test-schema-source | 1 | 9 | 0 |

The merged-thread sums are taken from GraphQL `reviewThreads(first:100)` with `isResolved=false` and a first Codex comment carrying a P1/P2 badge. No PR in the range has more than 100 review threads, so pagination does not truncate the counts.

## Current main evidence

Immutable main:

```text
41330115de7304c95654f57949b41c24761b2e8f
```

Live check conclusions on that SHA:

| Check | Conclusion |
|---|---|
| build | failure |
| no-secrets | failure |
| test-schema-source | failure |
| local-evidence | failure |
| migration-numbering | success |
| branch-staleness | success on the push run; later scheduled staleness runs fail |
| design-status-policy | success |
| reserved-bindings | success |
| operator-counts-source | success |
| plugin | success |
| CodeQL matrices | success |

Clean-main local reproduction:

- `npm run typecheck` exits nonzero with concrete TypeScript errors across existing billing, connectors, studio, presence, MCP, pot provisioning, routines, and type contracts.
- The complete Vitest baseline previously recorded at this same SHA is 6,634 passed and 2 WFP tests failed.
- `node scripts/no-secrets.mjs` exits 1.
- `node scripts/check-test-schema-source.mjs` exits 1 with eight new mock-DB violations.
- Local D1 evidence exits nonzero with `too many terms in compound SELECT`.

Focused tests do not override any of these failures.

## Deployed-state evidence

The public read-only health response at `https://mupot.mumega.com/health` returned:

```json
{
  "ok": true,
  "version": "0.30.0",
  "commit": "41330115de7304c95654f57949b41c24761b2e8f",
  "built_at": "2026-08-26T23:49:28.685Z"
}
```

Therefore:

- `MERGED`: proven for the 26 PRs and exact merge SHAs.
- `DEPLOYED-CODE`: proven for final main SHA `41330115` at the public Mupot health endpoint.
- `MIGRATIONS-APPLIED`: `UNPROVEN`; there is no migration receipt in this artifact.
- `ROUTE-ENABLED`: `UNPROVEN` per reviewed surface.
- `PRODUCTION-DATA-AFFECTED`: `UNPROVEN`.
- `EXPLOITABLE`: `UNPROVEN` until current-head and runtime precondition checks.

GitHub’s deployments API returns no deployment records for the SHA. The health response is the direct deployment receipt; the absence of GitHub deployment records is not evidence of no deployment.

## Current branch-protection posture

The authenticated GitHub branch-protection API currently reports:

| Setting | Current value |
|---|---|
| `main` protected | true |
| required checks | `design-status-policy`, `build`, `no-secrets` |
| strict/up-to-date | false |
| enforce admins | false |
| required PR reviews | absent |
| required conversation resolution | false |
| signed commits | false |
| linear history | false |
| force pushes | false |
| branch deletion | false |
| repository rulesets | none |

This proves the present configuration permits administrators or roles with branch-protection bypass authority to bypass the configured requirements. It also proves `local-evidence` and `test-schema-source` are not currently required contexts.

The organization audit-log endpoint returned HTTP 404 for the available credential. Historical protection settings and the identity/mechanism of each bypass at merge time are therefore `UNPROVEN`; present settings must not be projected backward as if they were an audit log.

## Review findings versus current defects

The reported examples from #1223 and #1226–#1232 are authentic unresolved P1 review threads. They must not be promoted directly to “198 live defects.” Later PRs may overlap, supersede, or partially change the reviewed code.

IR-2 must revalidate each merged P1 against exact current main and classify it:

1. still present and reachable;
2. still present but feature-disabled/unreachable;
3. superseded by a later change;
4. duplicate of another root cause;
5. false positive with concrete counter-evidence;
6. deployment/runtime state `UNPROVEN`.

The first triage order is exposed production surface:

1. authentication/SSO and authorization;
2. billing/payment/entitlement;
3. outbound webhook and connector credential handling;
4. unrestricted data mutation/XSS;
5. provisioning success claims and resumability;
6. scheduler/automation partial effects;
7. remaining internal/admin-only defects.

## Recovery flights

### IR-0 — incident ledger and protection packet

This artifact. Read-only except for its branch/commit, governed task, flight record, and Athena request. No repository setting or runtime mutation.

### IR-1 — clean-main CI foundation

Bounded PR from refreshed `origin/main`. Repair, in evidence order:

1. migration/local-evidence failure;
2. complete Vitest baseline;
3. typecheck/build contract errors;
4. no-secrets fixtures without scanner weakening;
5. test-schema-source conversions using the real migration harness.

Full typecheck, full suite, every repository guard, required GitHub CI, and Athena exact-head gate must be green.

### IR-2 — current-main P1 revalidation

Read-only graph-first/current-source audit of 106 merged P1 threads. Produce a deduplicated ledger with exact current file/line, runtime exposure, deployment preconditions, suggested containment, and owning repair flight.

### IR-3+ — bounded surface repairs

One security boundary per clean-main PR, adversarial regression plus mutation witness, complete repository gate, and Athena exact-head verdict. Hadi separately decides every merge.

### MSG-01

PR #1237 remains draft and blocked until main is green and Athena reviews its immutable head. PR #1235 remains blocked. PR #1236 remains unmerged and is not extended.

## Proposed protection change packet

This is a proposal only. No setting is changed by IR-0.

1. Enable admin enforcement / do not allow bypassing.
2. Require PRs and at least one independent approval.
3. Require approval of the latest reviewable push or dismiss stale approvals.
4. Require conversation resolution.
5. Require exact, app-pinned contexts:
   - `design-status-policy`
   - `build`
   - `no-secrets`
   - `test-schema-source`
   - `local-evidence`
   - `migration-numbering`
   - `branch-staleness`
   - `reserved-bindings`
   - `operator-counts-source`
   - `plugin`
6. Enable strict/up-to-date checking or a merge queue.
7. Retain force-push and deletion prohibitions.
8. Define a narrowly named emergency bypass role with mandatory reason/audit procedure if GitHub plan capabilities require one; ordinary administrators do not receive ambient bypass.
9. Verify the protection with a disposable failing PR before resuming features.

Hadi must explicitly authorize the settings mutation. Athena must gate the proposed packet and the resulting readback if authorized.

## Immediate stop conditions

- No feature merge while main is red.
- No closure of #1211 or #1217 until unique commits are reconciled.
- No #1237 merge based only on focused tests.
- No claim that all 198 threads are distinct or currently exploitable.
- No claim that a route or migration is live solely because the code SHA is deployed.
- No branch-setting change, merge, deploy, credential action, or production mutation without Hadi.

## Reproduction commands

The audit used authenticated, read-only GitHub API/CLI calls and a public health probe:

```bash
gh api 'repos/Mumega-com/mupot/pulls?state=all&per_page=100'
gh api 'repos/Mumega-com/mupot/commits/436d4d2f497d7314d8386edd38d1e5278e48503c/check-runs?per_page=100'
gh api 'repos/Mumega-com/mupot/pulls/1232/reviews?per_page=100'
gh api graphql -f query='query { repository(owner:"Mumega-com", name:"mupot") { pullRequest(number:1232) { reviewThreads(first:100) { nodes { isResolved comments(first:20) { nodes { author { login } body } } } } } } }'
gh api repos/Mumega-com/mupot/branches/main/protection
gh api 'repos/Mumega-com/mupot/rulesets?includes_parents=true'
gh api 'repos/Mumega-com/mupot/deployments?sha=41330115de7304c95654f57949b41c24761b2e8f'
curl -fsS https://mupot.mumega.com/health
```

The examples pin PR #1232; the audit repeated the same check/review/thread queries for every PR in #1205–#1232.

## Athena gate request

Athena must independently verify:

1. the 28/27 scope correction;
2. 26 merges, 13 sub-minute merges, and 21 post-merge reviews;
3. 106 P1 plus 92 P2 merged unresolved threads;
4. the #1222–#1232 total of 95;
5. current-main check conclusions;
6. deployed-code versus route/migration/data distinctions;
7. current protection values and historical-config limitation;
8. recovery sequence and protection packet;
9. concrete misleading-state scenarios.

Required verdict: `GREEN`, `BLOCK`, or `RESHAPE`, naming this exact artifact and its SHA256.
