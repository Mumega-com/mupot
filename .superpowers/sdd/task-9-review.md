# Task 9 Remediation Re-review

## Verdict

**Changes requested: 3 findings (2 Critical, 1 Important, 0 Minor).**

The remediation closes the prior proposal authorization/oracle, root mounting and selected session/member-bearer auth, CSRF, strict UTF-8, member-only lifecycle, and public Run DTO findings. Cancellation and migration compatibility remain release blockers.

## Findings

### Critical - Existing installations cannot persist the new cancellation receipts

**Files:** `migrations/0061_project_routines.sql:97`, `tests/routines-migration.test.ts:15`

The fix adds `cancellation_requested`, `cancellation_confirmed`, and `cancellation_unconfirmed` by editing the event-kind `CHECK` in the already-shipped `0061_project_routines.sql`. Migration `0061` was introduced in commit `714aa0a` and was already part of the history before both the original Task 9 commit and this remediation.

Changing an applied migration does not update an existing D1 database: the migration runner records `0061` as applied, and `CREATE TABLE IF NOT EXISTS` would not alter the existing table in any case. Such databases retain the old constraint and reject the first insert at `src/routines/actions.ts:1200`. Cancellation therefore fails before a durable request receipt is written.

The migration test only builds a fresh database from the current contents of `0061`; it does not apply the pre-remediation `0061` and then upgrade it. The remediation verification list also omits `tests/routines-migration.test.ts`.

Required correction: restore `0061` and add a forward-only `0062` migration that safely rebuilds or otherwise evolves `routine_run_events` while preserving existing rows, append-only triggers, indexes, foreign-key behavior, and all old event kinds. Add upgrade tests from the exact pre-remediation schema with existing events, plus fresh and repeated migration application.

### Critical - A reported `confirmed` cancellation neither has runtime acknowledgement nor atomically fences new work

**Files:** `src/routines/actions.ts:733`, `src/routines/actions.ts:753`, `src/routines/actions.ts:1091`, `src/routines/actions.ts:1221`, `src/routines/actions.ts:1224`, `src/routines/dispatch.ts:468`, `src/routines/scheduler.ts:309`, `src/flight/service.ts:420`, `tests/routine-actions.test.ts:592`

`cancelControlFlight` calls `failFlight` and treats a reread `status === 'failed'` as confirmed. `failFlight` only updates the Flight database row; there is no runtime cancellation request or acknowledgement in this path. A running runtime can therefore continue after the API reports `outcome: 'confirmed'`.

The database protocol also has an unfenced claim race:

1. `executeRoutineAction` checks `cancellationPending` at line 991.
2. Cancellation writes `cancellation_requested`.
3. Cancellation observes no running action at line 1221.
4. The action claim at lines 1091-1099 can still change `pending` to `running`, because its conditional update does not exclude a pending cancellation request.
5. Cancellation can fail the control Task/Flight and record `cancellation_confirmed`, while the newly claimed action proceeds into Task/Flight creation.

Scheduler/dispatch has the same class of gap. Neither claim nor dispatch checks the durable cancellation request. Dispatch can create a control Task and Flight after cancellation loaded null child IDs; cancellation then confirms against the stale null IDs and cannot stop the newly created children.

The added test pre-seeds an already-running action. It proves conservative classification for that static state, but not the interleaving where an action or dispatch claims after the request and before the terminal batch. No test asserts a real runtime acknowledgement.

Required correction: make the durable request an atomic fence in action claim, scheduler claim, and every dispatch ownership/write condition; re-read correlated children after the fence; and classify confirmed only from an authoritative runtime/Flight cancellation receipt. Add deterministic interleaving tests for request-versus-action claim, dispatch child creation, action side effect, action completion, and terminal completion.

### Important - A crash after `cancellation_requested` permanently prevents retry and can leave a request without an outcome

**File:** `src/routines/actions.ts:1200`

The request event is committed separately from Task/Flight cancellation and the terminal/outcome batch. If the Worker fails after the request insert, a retry cannot resume: the insert writes zero rows, no outcome exists, and lines 1213-1218 return `receipt_failed`. Every later retry follows the same branch. Meanwhile `cancellationPending` fences action execution, leaving the run in an unresolved nonterminal state that requires manual repair.

A terminal race has the same incomplete-receipt shape. The request insert does not require a nonterminal run. If the run becomes terminal after the initial read but before line 1200, the function may append `cancellation_requested`, mutate child state, lose the run update, and return `run_terminal` without appending confirmed or unconfirmed outcome.

The duplicate tests cover only completed outcome receipts and a manually created cancelled run without a receipt. They do not inject failure after request persistence or retry a request-only state.

Required correction: make request-only state resumable and idempotent. A retry must acquire/resume the durable cancellation operation, reconcile child receipts, and append exactly one outcome. The request insert itself must be conditional on current nonterminal state. Add crash injection after request, after Task cancellation, after Flight cancellation, and before/after the outcome batch, plus concurrent duplicate callers.

## Prior Finding Closure

### Closed - Proposal replay authorization and existence hiding

`src/routines/actions.ts:1278-1294` now checks tenant/Project readability and responsible-squad authority before assigned identity, replay, state, or action execution. The revoked succeeded/waiting/running replay and missing-run tests at `tests/routine-actions.test.ts:562` exercise the relevant branches.

### Closed - Root mount, auth selection, and CSRF

`src/index.ts:78-82` mounts only the exact Routine and Needs You route registrations before the Projects wildcard. The apps no longer install a broad `*` middleware. `src/routines/routes.ts:45-79` selects Authorization before a stale session cookie, derives bearer identity from the member token, and applies CSRF only to selected sessions. Missing and foreign Origin are rejected. Root tests at `tests/routine-root-routes.test.ts:74-123` cover Project route families, unrelated-route non-interception, stale-cookie bearer selection, session Origin checks, and rejection of caller-supplied auth context.

### Closed - Strict UTF-8 and byte bounds

`src/routines/routes.ts:119-145` caps raw bytes before a fatal UTF-8 decode. Tests cover malformed UTF-8 and the 8192/8193 multibyte boundary.

### Closed - Member-only Routine lifecycle

`src/routines/service.ts:270`, `src/routines/service.ts:355`, and `src/routines/service.ts:394` require `actor_type === 'member'` in the shared source service. `tests/routines-service.test.ts:116` checks create, update, enable, pause, and archive with an agent-bound workspace administrator.

### Closed - Exact public Run allowlist

`src/routines/public.ts:3-45` is an explicit DTO and omits tenant, policy/proposal JSON, occurrence/idempotency key, lease ownership, retry coordination, and Situation digest. Route tests assert exact keys for create, list, and get responses.

### Partially closed - Cancellation source coordination and durable outcomes

The service now writes attributable request/outcome event types, uses Task and Flight source services, preserves already-terminal runs in the non-racing case, and distinguishes statically pre-claimed or landed children as unconfirmed. The findings above cover the remaining migration, crash, runtime-confirmation, and interleaving gaps.

## Test Assessment

The reported 13-file/147-test gate is useful for normal route and source behavior. It does not prove the cancellation claims because the race tests arrange before-call states rather than control statement interleavings, there is no crash-injection test, no runtime acknowledgement test, and no pre-remediation migration upgrade test.

