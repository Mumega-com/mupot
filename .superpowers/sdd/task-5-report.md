# Task 5 Report: Operational Addon Console

## Review Fix: Lifecycle Fencing, Public DTOs, and Authorization Order

### Tests Added and RED Evidence

- Added deterministic no-run interleaving coverage for both latest and list reads when the bound generation is revoked/replaced. RED returned `{ ok: true, run: null }` or `{ ok: true, runs: [] }` instead of explicit `fence_lost`.
- Added deterministic no-run interleaving coverage for both latest and list reads when the installation is archived and replaced. RED returned valid empty results instead of explicit `fence_lost`.
- Tightened existing stale-scope, binding-count, and live-binding recount assertions. RED showed all invalid lifecycle witnesses still collapsed to empty success.
- Added a dashboard loader regression for an empty binding read with no live generation. RED rendered `monitorState: 'empty'` instead of `unavailable`.
- Added exact public run and receipt DTO key allowlists. RED exposed `observations`, `rawObservationCount`, `programVersion`, `createdAt`, receipt `id`, and `actorId`.
- Added member coverage for a registered and unregistered addon console path. RED returned `404` for the unknown path, revealing wildcard resolution before authorization.
- Initial RED command discovered 140 tests: 128 passed and 12 failed for the expected unimplemented behavior.

### Files Changed

- `src/addons/marketing/service.ts`
- `src/addons/routes.ts`
- `src/dashboard/marketing-cro-monitor.ts`
- `src/dashboard/index.ts`
- `tests/marketing-monitor-service.test.ts`
- `tests/dashboard-marketing-cro-monitor.test.ts`
- `tests/dashboard-addons.test.ts`
- `tests/addon-routes.test.ts`
- `.superpowers/sdd/task-5-report.md`

### Commands and Results

- `npx vitest run tests/marketing-monitor-service.test.ts tests/dashboard-marketing-cro-monitor.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts`
  - RED: 4 files failed; 12 expected failures and 128 passes.
  - GREEN: 4 files passed; 140 tests passed.
- `npm run typecheck`
  - Passed with no TypeScript errors.
- `npm test`
  - Passed: 208 test files and 3,485 tests.
- `git diff --check`
  - Passed with no whitespace errors.

### Commit SHA

Implementation commit: `2f9e40022a87494fc3200ec54283ff9be103d065`.

### Concerns

No blocking concerns. The test suite emits the repository's existing Node experimental SQLite warning; there were no test failures.

## IR-4 Final-Review Fix Wave — 2026-08-29

### Status and exact artifacts

- Local implementation status: `DONE_WITH_CONCERNS`.
- Primary reviewed start: `4004e183d6ad50663d3d159cc6b2508350f1a6e9`.
- Final code commit: `29463de63823188647337e897cf77f8f6066d114`.
- Composition start: `316877c35ca6419124e7e0b6529940c63d2db969`.
- Final composition: `24b17a1a9d3cb644d2529f62f7eb79b2fb9433c4`.
- Receipt: `docs/receipts/pr1236-fix-forward/router-loop-meter-exact-head.md`.
- Receipt SHA-256: `8cabe20cc46b84557beed0ce9f8214149ce0fb2c6ed8cff2f669241693a42689`.

No push, PR action, merge, deploy, credential operation, production mutation,
remote migration, or branch-protection change occurred.

### RED evidence

The exact-head grouped RED command changed tests only and exited `1`: 96 tests,
84 passed and 12 failed for the expected missing behavior.

- Existence oracle: three failures showed missing targets returned `404` while
  existing foreign targets returned `403`.
- Router TOCTOU: four candidate-state and two project-state interleavings still
  assigned and woke after eligibility was revoked.
- Public meter target: defined `agent_id: null` reached canonical self status.
- Estimate validation: `Infinity` and `NaN` normalized instead of failing closed.
- Manifest subject parity was already behaviorally correct; successful agent-owned
  and squad-owned tests passed on the baseline, so its RED evidence used a temporary
  `recordTokens(loop.id, ...)` mutation. Both new tests failed and the mutation was
  restored before implementation.

### Implementation

- Router scope authorization now evaluates the caller's durable and ambient
  requested-squad authority before loading the target squad.
- Bound-agent meter calls pre-deny every foreign ID before D1 access. Unbound lead
  reads use an authorized D1 join over active durable grants, followed by the
  ambient B1 ceiling. Org-admin and canonical-self paths return `404` only after
  authority is established.
- Router claims now repeat task open/unassigned/squad state, candidate active
  same-squad state, live tenant presence, and active-project write/admin access in
  the same conditional `UPDATE`. Wake and assigned count remain conditioned on
  `changes === 1`.
- Public meter status rejects every defined non-string `agent_id`, including
  `null`, before any D1 prepare/read/effect.
- Server-built meter policy rejects non-finite estimates instead of normalizing
  them to zero.
- Successful manifest cycles now prove that `recordTokens` uses the exact
  reservation `meterSubjectId` for both agent and squad ownership.

No migration was added. All D1 regressions use `createSqliteD1()` and
`applyAllMigrations()`.

### Mutation witnesses

- Oracle regression mutation: `3/3` targeted tests failed, exit `1`.
- Candidate eligibility `EXISTS` removal: `4/4` interleavings failed, exit `1`.
- Project eligibility `EXISTS` removal: `2/2` interleavings failed, exit `1`.
- Manifest recording subject substitution: `2/2` successful cycles failed, exit `1`.
- Non-finite validation removal: `2/2` estimate tests failed, exit `1`.

Every mutation was restored before final verification and commit.

### Verification

- Primary focused: 4 files, 98 tests, exit `0`.
- Primary wider affected set: 9 files, 150 tests, exit `0`.
- Primary diff hygiene at `29463de6`: exit `0`.
- Primary typecheck: exit `2`, entirely inherited unrelated main-line errors; no
  changed IR-4 source or test path was named.
- Composition typecheck: exit `0`.
- Composition full suite: 442 files, 6,718 tests, exit `0`.
- Composition literal focused suite: 4 files, 77 tests, exit `0`.
- No-secrets, schema-source tests/check, migration tests/check, reserved bindings,
  operator-count tests/check, branch-staleness tests/check, and design-status
  policy: every command exit `0`.
- Plugin exact commands: compileall exit `0`; pytest 105 passed, exit `0`, using a
  disposable `python` alias to `/usr/bin/python3.12` and removing it afterward.
- Local evidence: exit `0`; local D1 migrations/fixtures, Wrangler browser smoke,
  runtime adapter conformance, and governed Project Routine lifecycle passed at
  exact composition SHA `24b17a1a`.
- Composition `git diff --check origin/main...HEAD`: exit `0`; worktree clean.

### Residuals

Deferred code findings: none. The three previously deferred Minors are resolved.
No independent Athena verdict is bound to the artifact, and the primary worktree
inherits unrelated main-line typecheck failures. Composition is the authoritative
green typecheck/full-suite/guard evidence; this remains local evidence rather than
merge, deploy, or production approval.
