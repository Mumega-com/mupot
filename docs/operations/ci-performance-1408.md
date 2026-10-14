# CI performance evidence — task bc1f744d / mumega-com#1408

Base: `cec0c0814bee8cfd57c478234a638aaaa4e363f4`.

## Scope and measurement

Keep test-file isolation and all existing suites. Split the default Node Vitest suite into four `--shard` matrix jobs, retain a fail-closed required `build` aggregate, and run the former non-Vitest build checks concurrently. Upload per-shard JSON/blob reports and merge them for counts and the slowest 30 files. Keep the separate real browser/runtime `local-evidence` job unchanged: it does not run Vitest on this base.

Build the real migration chain once per Vitest invocation and distribute its final schema to isolated workers. Keep dedicated uncached migration-chain/equality tests. Preserve schema, constraints, indexes, triggers, empty-data invariant, and independent databases. Use migration-derived DDL replay into private in-memory databases; file-database cloning is outside scope. Tests may increase through regression coverage; no test is silently deleted.

Validation covers targeted helper/fixture tests, typecheck, schema-source ratchet, node:test summary tests and the full suite in real GitHub Actions on the PR. The PR requires Kasra and another independent lens; the author does not provide its own gate verdict. No merge or deployment.

## Before: real CI

[Main run 38452165656](https://github.com/Mumega-com/mupot/actions/runs/38452165656), same pinned base, successful:

| Measurement | Before |
| --- | ---: |
| `build` job / workflow critical path | 739 s |
| Default Vitest Test step | 631 s |
| Vitest reported duration | 629.99 s |
| Default Vitest files | 697 passed |
| Default Vitest tests | 13,260 passed; 2 skipped; 2 todo |
| Total runner time across 18 jobs | 1,095 s |
| Composition (workerd) | 10 files; 116 passed; 19 s step |
| Fleet runtime | 43 s step |
| `local-evidence` job | 151 s |
| Browser/runtime evidence step | 113 s |

These are GitHub runner measurements, not local timings. The task's older 699-file / 17-minute estimate differs from current main. Comparison will distinguish the test step, critical path including aggregation, and total runner time.

## Dependency drift diagnosis

The headerless `OPTIONS /` request passes all 17 signed-out-landing tests on a clean `npm ci` at this base. The lockfile and deploy checkout use Hono 4.13.7, whose CSRF middleware treats GET, HEAD, and OPTIONS as safe methods. The old dirty root checkout uses Hono 4.13.0, whose middleware treats only GET/HEAD as safe, so headerless OPTIONS returns 403 before auth. This is dependency drift, not a worktree source defect. Use the lockfile with `npm ci`; do not weaken CSRF or change an auth expectation to hide stale dependencies.

The task's vacuous `tests/seat-attach.test.ts` examples exist on protected `kasra/w2-seat-attach`, not this base. They are deliberately outside this PR. No source or assertions on PR #1887 were changed.

## Slowest 30 files before changes

Actual default-Vitest file durations from the baseline CI log (file execution durations include hooks; their parallel sum is not wall time).

| File | Tests | Before ms |
| --- | ---: | ---: |
| `tests/agent-self-update.test.ts` | 67 | 55,514 |
| `tests/routine-dispatch.test.ts` | 69 | 53,093 |
| `tests/dashboard-projects.test.ts` | 65 | 47,118 |
| `tests/project-link-addon.test.ts` | 28 | 44,787 |
| `tests/send-target-confinement.test.ts` | 49 | 43,016 |
| `tests/routine-actions.test.ts` | 46 | 40,708 |
| `tests/squad-member-tools.test.ts` | 37 | 30,963 |
| `tests/agent-profile-update.test.ts` | 31 | 26,595 |
| `tests/members-agent-capability-route.test.ts` | 37 | 26,583 |
| `tests/flight-spine-delivery-schema.test.ts` | 32 | 24,053 |
| `tests/routine-scheduler.test.ts` | 27 | 22,287 |
| `tests/projects-routes.test.ts` | 25 | 21,605 |
| `tests/flights-project.test.ts` | 23 | 18,827 |
| `tests/project-projections.test.ts` | 24 | 17,720 |
| `tests/projects-service.test.ts` | 23 | 17,663 |
| `tests/external-source-callsites.test.ts` | 42 | 17,275 |
| `tests/dashboard-project-wiki.test.ts` | 21 | 17,256 |
| `tests/project-start-gate.test.ts` | 24 | 16,663 |
| `tests/pot-provisioner.test.ts` | 142 | 16,487 |
| `tests/channel-central-command.test.ts` | 19 | 16,449 |
| `tests/project-situation.test.ts` | 22 | 16,182 |
| `tests/agent-connection-service.test.ts` | 19 | 15,302 |
| `tests/mcp-project-tools.test.ts` | 21 | 15,248 |
| `tests/concierge-service.test.ts` | 22 | 15,240 |
| `tests/tasks-project-filter.test.ts` | 16 | 14,975 |
| `tests/email-login.test.ts` | 40 | 14,969 |
| `tests/update-squad-tool.test.ts` | 19 | 14,169 |
| `tests/agent-owner-member.test.ts` | 17 | 13,577 |
| `tests/project-lifecycle-p0.test.ts` | 21 | 13,089 |
| `tests/mcp-presence-tools.test.ts` | 19 | 13,055 |

## Implemented safeguards and test cleanup

- Unique, temporary migration snapshot per invocation/shard; workers receive only its path. No persistent cache or cross-worktree reuse. Watch reruns rebuild it; teardown removes it.
- Snapshot creation executes all 200 committed migrations and rejects surviving application rows. Fixtures retain private in-memory databases and their existing foreign-key settings. Restore is atomic via a savepoint. Dedicated uncached-chain tests remain.
- Ordinary fixtures across the slowest files use the canonical helper. Filtered/historical chains remain explicit in project-projections, project-situation, projects-routes, external-source-callsites, and squad-member-tools. The per-test cache reset in flight-spine-delivery-schema was removed; its constraints are still exercised against the real migration-derived schema.
- Four shard artifacts must exist exactly once. The required `build` check requires success from every shard and all retained build checks. The merged report must match a separate unsharded discovery manifest, contain no duplicate/missing/unexpected files, and have consistent terminal assertion counts.
- Three dashboard `resolves.toBeDefined()` assertions were strengthened to literal visibility/detail/capping expectations. A controlled malformed-but-defined `{}` response mutation is rejected by the stronger assertion; the restored real behavior passes. No existing test declarations were removed (TypeScript AST check across the 27 edited test files). Four new Vitest regressions cover the configured snapshot, schema equality/fixture isolation, seeded rows, and atomic rollback; node:test regressions cover CI reporting failure modes.
- No slow test was deleted as redundant: fixture replay was the repeated work. The vacuous seat-attach examples named in the task are confined to protected PR #1887 and remain a separate owner follow-up.

Local diagnostic timings (not CI before/after): full-chain setup 1.51–2.17 s; cached DDL replay about 66–86 ms. Combining DDL into one exec did not show a reliable standalone speedup. The shared snapshot removes full-chain setup from ordinary isolated files; fixture routing removes per-test chain replay. Real CI after measurements are recorded on the PR to avoid triggering a second run solely to commit its own elapsed times.

The CI JSON slow-file table measures the assertion execution window, excluding import/setup time. Before/after wall comparisons use GitHub job/step timestamps, and baseline/changed console file timings use the same Vitest reporter.
