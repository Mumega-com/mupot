# Task 8 Report

## Status

DONE

## Commit

`21992cd1edbba0b537d1bbc971e550fb6064be55` - `feat: project routine situation and evidence`

## Changed Files

- `src/projects/situation.ts`
- `src/projects/projections.ts`
- `tests/project-situation.test.ts`
- `tests/project-projections.test.ts`

## RED Evidence

1. `npx vitest run tests/project-situation.test.ts tests/project-projections.test.ts`
   - Failed as expected before implementation: 4 failures for missing `routines` / `needs_you` Situation state, Routine next-action priority, and Routine Activity/Evidence sources.
2. `npx vitest run tests/project-projections.test.ts`
   - Failed as expected after adding the control-plane payload regression: raw `proposal` and `prompt` content remained visible in Routine event/action JSON.

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

## Self-Review

- Situation adds bounded, tenant/project/squad-filtered Routine counts, next occurrence, active/waiting run, latest terminal outcome/cost, and principal-neutral Needs You summary.
- Existing control snapshots that exclude Routine-owned Task/Flight state retain stable business Situation digests; public callers receive Routine and Needs You state.
- Activity uses immutable `routine_run_events`; Evidence uses terminal runs and gated/action outcomes only.
- Every Routine projection uses tenant, project, and responsible-squad predicates, per-source bounds, current projection keyset rules, and projection sanitization. Routine JSON additionally removes proposal, policy, and prompt fields.
- Tests cover content, priority, visibility filtering, tenant/project isolation, stable Activity keysets, credential/control-field redaction, REST/MCP/dashboard parity, and routine digest compatibility.

## Concerns

None.
