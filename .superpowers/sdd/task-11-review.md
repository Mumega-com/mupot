# Task 11 Independent Review: Project Routines and Needs You Dashboard

## Verdict

**FAIL**

Finding count: **8** total (**0 Critical, 5 Important, 3 Minor**).

The focused integrated-branch verification run passed 74 tests across `dashboard-routines`, `dashboard-needs-you`, `dashboard-projects`, `dashboard-auth-shell`, and `dashboard-approvals`. Passing tests do not cover several required Task 11 behaviors below. The subsequent typecheck command was interrupted before producing a result and is not counted as evidence.

## Critical

None.

## Important

### I1. Required Routine/run detail views and source-specific Needs You destinations do not exist

Run and event rows emit `?run_id=...` links, and Needs You emits the same link for RoutineRun items, but the GET handler never reads `run_id`; it only handles history cursors and `edit`. Every such link therefore reloads the unchanged aggregate workspace instead of rendering the requested run details. There is likewise no dedicated read-only Routine detail view: `edit` only conditionally fills the admin form. Activity and Evidence links are generic Project anchors rather than links attributable to the selected run/event. For Task sources, Needs You sends every non-approval item to the broad Project `#work` section. This fails the dedicated list/detail/form/history requirement and does not provide source-specific details or safe action entry points.

References: `src/dashboard/index.ts:401`, `src/dashboard/index.ts:409`, `src/dashboard/routines.ts:240`, `src/dashboard/routines.ts:356`, `src/dashboard/routines.ts:362`, `src/dashboard/routines.ts:364`, `src/dashboard/needs-you.ts:35`, `src/dashboard/needs-you.ts:40`, `src/dashboard/needs-you.ts:63`.

### I2. Needs You ignores the authority-owning projection's safe URL and allowed actions

The authoritative `NeedsYouItem` supplies `safe_url` and actor-specific `allowed_actions`, but the dashboard does not consume either field. It invents a destination from `kind`/`source_type` and renders one generic open link. Consequently an item that permits answer, assign-agent, budget change, cancel, approve/reject, or publish does not expose those source-specific safe actions, while a view-only item is visually indistinguishable from an actionable one. The page is read-only and adds no generic resolver, which is correct, but it does not satisfy the required source-specific action surface.

References: `src/dashboard/needs-you.ts:35`, `src/dashboard/needs-you.ts:58`, `src/dashboard/needs-you.ts:63`; dependency contract `src/attention/service.ts:32`, `src/attention/service.ts:45`, `src/attention/service.ts:134`, `src/attention/service.ts:170`.

### I3. The dashboard directly queries Routine domain tables and reimplements event pagination

Task 11 was required to call shared services without direct SQL/domain duplication. The new dashboard loader directly queries `squads`, `agents`, `routine_run_events`, `routine_runs`, and `routines`, and owns a second event cursor/query implementation. This bypasses the shared Routine projection boundary and makes dashboard behavior independently driftable from REST/MCP. There is already observable drift: event continuation compares the fetched row count with the constant `EVENT_PAGE_LIMIT` instead of the requested `limit`, so `event_limit=1` with two events incorrectly reports no next cursor and no truncation.

References: `src/dashboard/routines.ts:185`, `src/dashboard/routines.ts:189`, `src/dashboard/routines.ts:200`, `src/dashboard/routines.ts:207`, `src/dashboard/routines.ts:218`, `src/dashboard/routines.ts:234`.

### I4. Routine list truncation and per-Routine current state are not truthful

Only the first 50 Routines are loaded, archived rows are removed after pagination, and the Routine cursor is discarded. A Project with archived rows in that first page can therefore show an incomplete or empty active list with no truncation notice or continuation. In addition, each Routine's “Previous” and “Current state” values are inferred from the current bounded Project-wide run-history page. A Routine whose latest run falls outside that page is shown with no run/current Routine status; on a continuation page it can be shown using an older run as though it were current. This fails complete enabled/paused/draft listing and truthful current-state/truncation behavior.

References: `src/dashboard/routines.ts:10`, `src/dashboard/routines.ts:231`, `src/dashboard/routines.ts:237`, `src/dashboard/routines.ts:250`, `src/dashboard/routines.ts:334`, `src/dashboard/routines.ts:343`, `src/dashboard/routines.ts:346`.

### I5. Task 11 tests omit required commands, states, security cases, and pagination assertions

The Routine suite proves rendering, one hidden Project GET, one manual-run success, two member denials, one enable redirect, and one create validation error. It does not exercise create success, edit success/failure, pause, archive, cancel success/terminal handling, control visibility by role, cross-Project IDs, nonce replay, nonce actor/routine binding, unauthorized Run-now POST, CSRF rejection, XSS escaping, run detail, event continuation, Routine-list truncation, or accurate current-state selection. Its bounded event test has only one event and therefore cannot catch I3. The Needs You suite does not verify full ordering, item details, empty state, cursor actor binding/continuation contents, source-cap truncation text, per-item allowed actions, source-specific destinations for every kind, or escaping. No new test verifies the compact Overview's truncation behavior. These omissions are material because the implementation defects above still pass all 74 selected tests.

References: `tests/dashboard-routines.test.ts:117`, `tests/dashboard-routines.test.ts:135`, `tests/dashboard-routines.test.ts:139`, `tests/dashboard-routines.test.ts:156`, `tests/dashboard-routines.test.ts:176`, `tests/dashboard-needs-you.test.ts:80`, `tests/dashboard-needs-you.test.ts:99`, `tests/dashboard-needs-you.test.ts:113`.

## Minor

### M1. Compact Project Overview suppresses Routine/Needs You truncation and terminal outcome data

The Overview prints exact-looking enabled, paused, and Needs You counts even when the Project Situation marks them truncated; it does not append a lower-bound marker or notice. It also omits the available latest terminal run outcome/cost. This makes the compact summary less truthful than the shared Project Situation contract.

References: `src/dashboard/projects.ts:839`, `src/dashboard/projects.ts:875`; dependency contract `src/projects/situation.ts:70`, `src/projects/situation.ts:95`.

### M2. Success rendering trusts an arbitrary query value

Any `status` query string is rendered as a green `role="status"` success message. It is escaped, so this is not XSS, but a direct GET can fabricate an apparent successful command and raw internal status tokens are not mapped to stable user-facing messages.

References: `src/dashboard/index.ts:415`, `src/dashboard/routines.ts:333`, `src/dashboard/routines.ts:372`.

### M3. The Routines destination does not retain Project-tab semantics or local-time display

Project Overview contains a Routines tab link, but the Routines page replaces the Project section navigation with a single “Project overview” link and never marks Routines as the current tab. Schedule cells show raw timestamps plus a timezone name, not a local rendering in that timezone. The route is usable, but the dedicated-tab and UTC/local-time presentation are incomplete.

References: `src/dashboard/projects.ts:1156`, `src/dashboard/projects.ts:1159`, `src/dashboard/routines.ts:341`, `src/dashboard/routines.ts:343`, `src/dashboard/routines.ts:371`, `src/dashboard/routines.ts:374`.

## Verified Requirements

- Global Needs You is read-only, uses the shared bounded projection and opaque server-side cursor, preserves projection ordering, and exposes no generic resolver.
- Exact Project read authority is checked before Routine workspace data loads; unreadable Project GETs render the existing 404 surface.
- Workspace-admin checks gate create/edit/enable/pause/archive and cancellation through shared mutation services.
- Responsible writable-squad authority for Run now is delegated to the shared service; the dashboard mints a server-side, actor/tenant/Routine-bound, one-time nonce and uses it as the idempotency key.
- Successful dashboard mutations use POST-redirect-GET with HTTP 303.
- Dashboard authentication, tenant binding, and Hono CSRF middleware cover the new routes; service calls retain the authenticated member/agent actor plane.
- Hono HTML templates escape dynamic text/attributes; `raw()` usage in the new surfaces is limited to constant layout/select fragments. No XSS issue was found in the reviewed delta.
- Tables use stable grid tracks, labelled table/region roles, focusable horizontal-scroll regions, and fixed minimum widths for desktop/mobile structure. Form controls have associated labels.
- Needs You is placed directly between Work and Approvals in global navigation.
- The Task 11 delta adds no runtime dispatch, proposal execution, session reuse, or other agent-harness behavior.
