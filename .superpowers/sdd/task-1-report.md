# Task 1 Report: Restore a truthful green release baseline

## Status

DONE_WITH_CONCERNS

## Changed files

- `ROADMAP.md`
- `scripts/local-test-seed.sql`
- `tests/project-link-envelope-security.test.ts`
- `tests/project-projections.test.ts`
- `tests/projects-local-smoke.test.ts`

`scripts/ci-local-evidence.sh` was intentionally unchanged. It already preserves one
continuous local D1 state; the explicit correction superseded the stale on-disk brief
that asked for a reset between browser smoke and runtime conformance.

## Commits

- `ae29690 fix local runtime conformance fence fixture`

## First failing test and cause

The first new regression command was:

```text
npm test -- tests/projects-local-smoke.test.ts
```

It failed with one failing test, `seeds the signed inbox fence required by runtime
conformance after browser evidence`: the query for the local `agent-conformance`
`agent_inbox_fences` row returned `undefined`.

Cause: the local seed registered the runtime key but no `signed_only` consumer fence.
Signed inbox reads therefore had no fixture proving the required matching-fingerprint
consumer mode.

## Implementation summary

- Added the local-only `agent-conformance` `signed_only` inbox fence with generation
  `1`, the supplied SHA-256 public-key fingerprint, updater
  `mbr-conformance-runtime`, and a nonempty reason.
- Added a seeded-SQLite regression assertion for that fixture.
- Kept the browser and signed-runtime suites on one Wrangler/D1 state so browser-queued
  fleet control is available to runtime conformance.
- Composed scanner-sensitive OpenAI, GitHub PAT, AWS, and JWT test values at runtime
  while preserving the exact strings exercised by the sanitizers.
- Added `marketplace distribution` to the v0.29 scope without changing release order,
  and restored the existing v0.23 readiness references required by its release test.

## Exact test commands and results

```text
npm test -- tests/projects-local-smoke.test.ts
```

RED result before seeding: 1 failed, 5 passed. The expected fence row was missing.

```text
node scripts/no-secrets.mjs
```

Final result: `no secrets found`.

```text
npm test -- tests/release-v023-readiness.test.ts tests/project-link-envelope-security.test.ts tests/project-projections.test.ts tests/projects-local-smoke.test.ts
```

Final result: 4 test files passed, 37 tests passed.

```text
bash scripts/ci-local-evidence.sh
```

Final result: passed. Browser workflow smoke completed, then runtime conformance
completed all 11 steps, including signed inbox consume and `fleet-control.v1` signed
inbox delivery from the shared D1 state.

## Self-review

- No production inbox-fence behavior or runtime consumer authorization code changed.
- The local fixture is idempotent and keeps the exact required fingerprint, updater,
  and nonempty reason.
- The regression exercises migrations plus the real local seed in SQLite.
- The final CI evidence confirms shared state rather than an artificial reset.
- `git diff --check` passed before commit.

## Concerns

The required on-disk brief still contains the superseded reset/recreate-D1 instructions.
This implementation follows the user's explicit correction: seed the signed fence and
preserve continuous fixture state. No remaining implementation or test concern was
observed.

## Review Follow-Up: Task 1 Findings

Commit: `b68e124 fix task one review findings`

- Removed the unrelated v0.23/v0.24 roadmap additions; the v0.29
  `marketplace distribution` wording remains.
- The local fixture test now reads `agent_keys.pubkey`, derives its SHA-256 fingerprint
  with Node crypto, asserts the required expected fingerprint, and compares the fence
  value to that derived result.

Verification:

```text
node scripts/no-secrets.mjs
```

Passed: `no secrets found`.

```text
npx vitest run tests/release-v023-readiness.test.ts tests/project-link-envelope-security.test.ts tests/project-projections.test.ts tests/projects-local-smoke.test.ts
```

Result: 3 files passed, 1 failed; 35 tests passed, 2 failed. Both failures are in
`tests/release-v023-readiness.test.ts`, which still expects the unrelated roadmap text
removed by this review follow-up (`docs/releases/v0.23.0-trusted-runtime.md` and
deferred v0.24 scope terms).

```text
npx vitest run tests/projects-local-smoke.test.ts
```

Passed: 1 file, 6 tests. Full local evidence was not rerun because the follow-up only
changes documentation and the test-only fingerprint derivation.

## Review Follow-Up: Release Readiness Restoration

Commit: `fbd8402 fix release roadmap readiness assertions`

Restored only the established v0.23 Trusted Runtime release-document link and one
v0.24 deferred-scope line containing `economy`, `new departments`, `full SOS
retirement`, `GCP portability`, and `autonomous-brain expansion`. The required
`marketplace distribution` wording remains in the v0.29 scope.

```text
node scripts/no-secrets.mjs
```

Passed: `no secrets found`.

```text
npx vitest run tests/release-v023-readiness.test.ts tests/project-link-envelope-security.test.ts tests/project-projections.test.ts tests/projects-local-smoke.test.ts
```

Passed: 4 test files, 37 tests.
