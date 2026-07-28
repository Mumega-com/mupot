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

## Remediation (2026-07-19)

Code commit: `1b4ab46e28cd12ec090181c26b102c45a3b6488d` (`fix: harden routine control APIs`)

### RED Evidence

The remediation tests failed before the corresponding source changes:

```text
tests/routines-service.test.ts
agent-bound workspace_admin createRoutine returned success instead of { ok: false, error: 'forbidden' }

tests/routine-routes.test.ts
Run DTO exposed lease/retry/situation fields; malformed UTF-8 body returned 201

tests/routine-root-routes.test.ts
src/index.ts did not export the root app and Project wildcard routing captured the new endpoints

tests/routine-actions.test.ts
revoked principals replayed stored succeeded/waiting/running actions; a running action cancellation returned confirmed
```

### Remediation Changes

- Added `src/routines/public.ts` with an exact allowlisted public Run DTO for REST reuse; it intentionally leaves Task 10 MCP untouched.
- Mounted exact Routine and Needs You endpoints before the Project wildcard, with bearer-first member auth and selected-session-only Hono CSRF. Session mutations require a same Origin; bearer is CSRF-exempt even with a stale session cookie.
- Enforced current Project readability and responsible-squad run authority before proposal identity, replay, or state branches.
- Restricted Routine policy lifecycle mutations to member principals, including workspace administrators.
- Made JSON parsing byte-safe: raw byte cap precedes fatal UTF-8 decode, followed by strict object/shape validation.
- Added durable `cancellation_requested`, `cancellation_confirmed`, and `cancellation_unconfirmed` event semantics. Cancellation coordinates the correlated Task and Flight, fences post-request action execution, and reports unconfirmed for an already claimed action or landed Flight. Duplicate success requires a matching durable outcome receipt.
- Added root-composition, CSRF, exact DTO, lifecycle, pagination/path, authorization, and cancellation-race coverage.

### Verification

```text
npm test -- tests/routine-actions.test.ts tests/routines-service.test.ts tests/routine-routes.test.ts tests/routine-root-routes.test.ts tests/needs-you.test.ts tests/needs-you-routes.test.ts tests/routine-dispatch.test.ts tests/routine-scheduler.test.ts tests/flight-service.test.ts tests/flight-routes.test.ts tests/tasks-service.test.ts tests/tasks-project-filter.test.ts tests/mcp-routine-tools.test.ts
13 passed, 147 passed

npm run typecheck
tsc --noEmit: passed

git diff --check
passed
```

### Remediation Self-Review

- No route carries domain SQL or trusts request-supplied actor, tenant, or assigned-agent identity.
- No agent-bound token can create, update, enable, pause, archive, or cancel Routine control-plane work.
- Cancellation never reports a duplicate success without the terminal outcome event, and a previously running action is explicitly unconfirmed rather than assumed cancelled.
- Needs You remains GET-only and project-filtered through `listNeedsYou`; MCP, dashboard, and Task 8 projections remain unmodified.

### Concerns

The `0061` migration was extended because the new durable cancellation receipt kinds are enforced by that migration's event-kind check. No new runtime or agent-harness capability was added.
