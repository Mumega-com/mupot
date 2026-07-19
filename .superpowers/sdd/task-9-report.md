# Task 9 Report: REST Surface

## Result

Implemented the Project Routine and Needs You REST control-plane surface without adding agent harness or runtime behavior.

## RED Evidence

Before route implementation:

```text
npm test -- tests/routine-routes.test.ts tests/needs-you-routes.test.ts
Failed Suites 2
Cannot find module '/src/routines/routes'
Cannot find module '/src/attention/routes'
```

Before cancellation implementation:

```text
npm test -- tests/routine-actions.test.ts
TypeError: cancelRoutineRun is not a function
```

## Implementation

- Added `src/routines/routes.ts` for the section 11.2 Routine and RoutineRun endpoints.
- Added `src/attention/routes.ts` for GET-only global and Project-scoped Needs You.
- Mounted both apps under `/api` before the dashboard catch-all in `src/index.ts`.
- Added `cancelRoutineRun` in `src/routines/actions.ts`: tenant/read scoped, member-only workspace-admin authority, bounded set-based cancellation, action cancellation, durable audit event, terminal safety, and receipt-backed duplicate handling.
- Added route coverage in `tests/routine-routes.test.ts` and `tests/needs-you-routes.test.ts`; extended `tests/routine-actions.test.ts` for governed cancellation.

Routes use auth-derived principals, shared services, bounded body/cursor validation, no-store responses, session CSRF, member bearer compatibility, public Routine/Run shapes, and command idempotency.

## Verification

```text
npm test -- tests/oauth-dual-auth.test.ts tests/projects-routes.test.ts tests/tasks-project-filter.test.ts tests/routines-service.test.ts tests/routine-actions.test.ts tests/routine-routes.test.ts tests/needs-you.test.ts tests/needs-you-routes.test.ts
8 passed, 102 passed

npm run typecheck
tsc --noEmit: passed

git diff --check
passed
```

## Self-Review

- No route contains domain SQL; routes delegate to Routine, action, and attention services.
- Cancellation is the sole allowed service addition. It cannot cancel an unreadable or cross-tenant run, an agent principal cannot cancel even with broad grants, and duplicate success requires the durable cancelled event.
- Raw `policy_json` and `proposal_json` are excluded from public Run responses.
- Needs You remains GET-only and invokes `listNeedsYou`; no generic resolution endpoint was added.
- No Task 8 Project files, MCP, dashboard implementation, scheduler, migrations, or design docs were changed.

## Commit

`feat: expose routine and attention APIs`
