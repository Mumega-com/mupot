# Task 8 Report

## Status

DONE

## Commit

Base implementation: `107c455df573bf581e34d20f391aa476b466664a` - `feat: project routine situation and evidence`

Review remediation: `e20f97061a1662eb69320b757cfa460536b20a7e` - `fix: harden project routine projections`

Situation plan coverage: `c14560a45302354be256c6935a236f0f4c229fdd` - `test: cover routine situation keyset plans`

## Changed Files

- `src/projects/situation.ts`
- `src/projects/projections.ts`
- `tests/project-situation.test.ts`
- `tests/project-projections.test.ts`
- `migrations/0061_project_routines.sql` (review remediation)

## RED Evidence

1. `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts`
   - Failed as expected before implementation: 4 failures for missing `routines` / `needs_you` Situation state, Routine next-action priority, and Routine Activity/Evidence sources.
2. `npx vitest run tests/project-projections.test.ts`
   - Failed as expected after adding the control-plane payload regression: raw `proposal` and `prompt` content remained visible in Routine event/action JSON.
3. `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts`
   - Failed as expected for the review findings: a capped Routine wait source chose a later deadline, 101 enabled manual Routines hid the scheduled occurrence, and Routine projection plans lacked the required matching keyset indexes.

## GREEN Evidence

- `npx vitest run tests/project-projections.test.ts`
  - 24/24 passed after stripping Routine proposal/policy/prompt fields before sanitization.
- `npx vitest run tests/routine-dispatch.test.ts tests/routine-actions.test.ts`
  - 31/31 passed after excluding Routine projections from the existing control Task/Flight digest path, preserving stable dispatch/action Situation hashes and statement headroom.
- `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts tests/projects-routes.test.ts tests/mcp-project-tools.test.ts tests/dashboard-projects.test.ts tests/routine-dispatch.test.ts tests/routine-actions.test.ts`
  - 160/160 passed.
- `npx tsc --noEmit`
  - Passed.
- `git diff --check`
  - Passed before commit.

### Review Remediation Verification

- `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts`
  - 44/44 passed. Covers the over-cap urgent Routine deadline, manual-Routine next-occurrence cap, stable source keysets, and no-temp-sort index plans for Routine Activity/Evidence.
- `npx vitest run tests/routines-migration.test.ts tests/migration-d1-compat.test.ts tests/projects-migration.test.ts`
  - 10/10 passed.
- `npx vitest run tests/projects-routes.test.ts tests/mcp-project-tools.test.ts tests/dashboard-projects.test.ts`
  - 88/88 passed.
- `npx vitest run tests/routine-dispatch.test.ts tests/routine-actions.test.ts`
  - Task 8 dispatch coverage passed; 18 Routine action tests passed, while one concurrent Task9 test failed because it attempts to delete append-only `routine_run_events`.
- `npx tsc --noEmit`
  - Blocked by concurrent Task9 route work in `src/routines/routes.ts` (unused declarations and an `unknown` to `string` assignment).
- `git diff --check`
  - Passed before the review remediation commit.
- `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts`
  - 45/45 passed after adding `EXPLAIN QUERY PLAN` coverage for the Situation next-occurrence, active-run, terminal-outcome, and bounded Routine Needs You source scans.
- `npx vitest run tests/routines-migration.test.ts tests/migration-d1-compat.test.ts tests/projects-migration.test.ts`
  - 10/10 passed after adding the Situation plan coverage.

## Self-Review

- Situation adds bounded, tenant/project/squad-filtered Routine counts, next occurrence, active/waiting run, latest terminal outcome/cost, and principal-neutral Needs You summary.
- Existing control snapshots that exclude Routine-owned Task/Flight state retain stable business Situation digests; public callers receive Routine and Needs You state.
- Activity uses immutable `routine_run_events`; Evidence uses terminal runs and gated/action outcomes only.
- Every Routine projection uses tenant, project, and responsible-squad predicates, per-source bounds, current projection keyset rules, and projection sanitization. Routine JSON additionally removes proposal, policy, and prompt fields.
- Tests cover content, priority, visibility filtering, tenant/project isolation, stable Activity keysets, credential/control-field redaction, REST/MCP/dashboard parity, and routine digest compatibility.
- Review remediation orders every capped Needs You source by the shared global priority keys, uses a separate indexed next-occurrence query, and adds migration-backed expression keyset indexes for Routine projection and Situation ordering.
- Situation plan coverage verifies each intended Routine ordering index and confirms the bounded `routine_waits` source has no temp sort; the final cross-source Needs You merge remains separately sorted by design.

## Concerns

The shared worktree contains concurrent Task9 changes. They were not staged or modified by Task8. Those changes currently prevent a clean shared-tree TypeScript run and add one unrelated Routine action test failure; Task8-focused, migration, and Project parity gates are green.
