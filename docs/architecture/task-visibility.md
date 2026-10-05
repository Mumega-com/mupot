# Task visibility — one chokepoint (mupot#1647, #1645)

Scope: PARTIAL for #1645 — situation slices fixed on all four surfaces; see "Not migrated".
Status: implemented in `src/tasks/visibility.ts`. Seam test: `tests/task-visibility-seam.test.ts`.
File:line references below are against `origin/main` at `418bcf0b` (the base of this change) unless
marked "now".

## Why

"Which tasks may this caller read?" was re-derived in every reader. A new reader built on "show no more
than `task_list` shows" (the closed #1644 verdict projection) leaked four different ways over three gate
rounds — cross-squad, `kind='home'` squads for org-wide callers, observer-vs-member rank, archived tasks —
and a fifth through department-scope grants reaching home squads. Each is a predicate the existing
readers apply in slightly different places. This document enumerates every condition, says where the
readers disagree, and fixes the canonical meaning.

## The conditions and who applies them

Readers (all `origin/main`):

| id | reader | where |
|----|--------|-------|
| R1 | `task_list` (MCP) | `src/mcp/index.ts:1004-1147`, gate = `resolveTaskSquad` 737 -> `resolveScopedSquad` 818 |
| R2 | `task_board` (MCP) | `src/mcp/index.ts:1149-1204`, same gate as R1 |
| R3 | `kanban_board` (MCP) + dashboard kanban | `src/dashboard/kanban-routes.ts:59-270` (`loadKanbanData`) |
| R4 | `GET /tasks` | `src/tasks/index.ts:316-420`, `readableSquadIds` 189, `canReadProjectForTaskList` 231 |
| R5 | `GET /tasks/:id` | `src/tasks/index.ts:542-562`, gate = `canActOnSquad` 141 |
| R6 | `loadProjectSituation` (project_get, project_context, REST `GET /projects/:id`, dashboard project detail, routine scheduler) | `src/projects/situation.ts:451+`, task slices 478-520 and 595-670; feeds `listProjectActivity` (`src/projects/projections.ts:307+`) |

Legend: **A** applied, **M** missing, **D** different (explained below the table).

| condition | R1 task_list | R2 task_board | R3 kanban | R4 GET /tasks | R5 GET /tasks/:id | R6 situation |
|---|---|---|---|---|---|---|
| archived task excluded (`TASK_NOT_ARCHIVED_SQL`, `tasks_archive_state`) | A 1033 | A 1171 | A 108,173,260 | **M** | M by design (explicit history read) | **M** |
| tenant | router/auth gate (MCP auth is pot-bound) | same | same | `inTenantScope` middleware 87 | same 87 | none needed (single-tenant D1) except flights/routines which add `tenant = ?` |
| home squad fence, work/org plane | A (`bypassAppliesHere` 845) | A | A (`s.kind != 'home'` always) | A (NOT EXISTS home 354) | A (`planeCoversScope('role')` 172) | **M** (`null` = unrestricted, #1645) |
| home squad fence, department expansion | A (via `canOnSquad` -> `planeCoversScope`) | A | **D** via `resolveAccessibleSquadIds` -> `resolveReadableSquadIds`: expands a department grant into home squads, saved only by `s.kind != 'home'` | A (`AND kind != 'home'` 221) | A | **M** (list from `resolveReadableSquadIds`, no home filter) |
| exact squad grant on own home squad covers it | A | A | **D** never (kanban hides homes even from their owner) | **D** explicit squad: yes; implicit list: yes via grants, but an org-wide caller's list is "every non-home" so their own home drops out | A | n/a |
| rank floor | member (`resolveTaskSquad` min) | member | **D** observer (`resolveAccessibleSquadIds(env, auth)` default) | member | member | **D** observer (`projectReadAccessFromGrants`, `resolveReadableSquadIds` has no rank) |
| `project_squad_access` edge for a `project_id` filter | A, per squad (`canReadProjectForSquad` 773) | n/a | n/a (project view lists all accessible squads' tasks of a project) | **D** edge to ANY readable squad (`canReadProjectForTaskList` 231) | n/a | project selected by `readableProject` (project-level visibility); rows by squad list |
| legacy role plane (`auth.role` owner/admin) | **only while `capabilities === undefined`** (`hasWorkspaceAdmin` 756) | same | **D** `isOrgAdmin`: always | **D** `legacyOwnerAdmin` 94: always | **D** always (`canActOnSquad` 172) | n/a (callers pass lists) |
| ambient `auth.capabilities`, never `latentCapabilities` | A (`auth.capabilities ?? []`) | A | A (`resolveAccessibleSquadIds`) | A | A | A |
| grants unloaded + `memberId` set (REST owner/admin cookie session) | `[]` (MCP sessions always carry capabilities, so unreachable) | `[]` | resolves from DB | resolves from DB | resolves from DB | n/a |
| revoked grant | capability rows are deleted on revoke; no grant row => no standing (all readers) | | | | | |
| `result` field exposure | full row (`TASK_SELECT_COLUMNS` incl. `result`), no extra rule | full | full (`t.result`) | full | full | `result` excerpt in blockers; title in activity/needs-you |
| assignee-only / gate-owner privacy | none for reads (only `dispatch_receipt_id` is attached to the assignee's own rows) | same | none | none | none | none |
| squad/project status | none (archived squads still readable) | | | | | project `archived` only changes `health` |

## Where the readers disagree, and the canonical answer

The reference reader is **R1 `task_list`** (and its single-squad gate): it is the reader the three gate
rounds on #1644 (kasra-review r2/r3, Athena) named, it is the strictest on the plane/rank/home axes, and
it is the one an agent sees. Every other reader must show no more than R1 shows for the same caller.

| # | disagreement | canonical | classification |
|---|---|---|---|
| F1 | **Archive**: R4 lists archived tasks, R6 shows them (title via `latest_activity`, counts, blockers, needs-you). R1/R2/R3 hide them. `src/hygiene/filters.ts:20` already states listing surfaces exclude archived. | Listings exclude archived. R5 (explicit id) stays archived-inclusive. | bug in R4/R6, not a product question. Task archiving is currently refused (`archive_row` table:'tasks' -> 409, #1571), so the side table is empty in production; the fix is latent-safe. |
| F2 | **Project filter edge**: R1 needs an edge to *that* squad; R4 needs an edge to *any* readable squad. For a caller who may read squad A but A has no edge to project P, `GET /tasks?project_id=P` returns A's tasks of P while `task_list(squad=A, project_id=P)` is `project_not_found`. | Left as is (the matrix pins both). It discloses no row the caller cannot already read through `task_list` without the filter, so it is an inconsistent *selector*, not a leak. **Not resolved here — flagged for a product decision** (does the edge gate a project filter per squad or per caller?). | genuine reader-vs-reader disagreement; no data exposure |
| F3 | **Legacy role plane with loaded capabilities**: R1 honours `auth.role` only while `capabilities === undefined`; R3/R4/R5 honour it always. | R1: the role plane counts only while capabilities are unloaded (the bootstrap owner's real shape). Not reachable in production today: web login assigns `capabilities` only for `role === 'member'` (`src/auth/index.ts:1935-1939`) and MCP `role` is always `member`. | R4/R5 aligned; no reachable behavior change |
| F4 | **Rank**: R3 (kanban list) and R6 (project surfaces) read at observer; R1/R2/R4/R5 need member. A squad observer sees task titles/results through `project_get`/`project_context` and `kanban_board` but is refused by `task_list`. | member. This is what both #1644 gates required. **This is the one deliberate behavior change for existing callers**: an observer-only grant no longer shows task rows inside `project_get`/`project_context`/`GET /projects/:id`/dashboard project detail. Existing tests that used an observer grant to read project tasks were changed to member; the observer expectation is now pinned (the observer callers in the matrix see no tasks). If product wants observers to read project task rows, change `TASK_READ_MINIMUM` consumers for the project surfaces — one line — but then `task_list` must agree. | product-visible; decided by the #1644 gate verdicts, flagged in the PR |
| F5 | **Own home squad for an org-wide caller**: R4's implicit list used "every non-home squad" for org-wide callers and dropped the caller's own exact-grant home. R1 shows it (per squad). | union of the non-home squads and the caller's exact squad grants (member+). The only widening in R4: a home owner who is also org member now sees their OWN home tasks in the implicit list, as `task_list` already showed them. | R4 aligned to R1 |
| F6 | **Kanban**: R3 never shows a home squad even to its owner, and uses observer rank (F4). | Not migrated (follow-up). Narrower than R1 on homes (not a leak), wider on rank (a leak of the F4 class). | follow-up, listed in the PR |

No disagreement needs a product decision *before* the chokepoint can ship: F1, F3, F5 are bugs/dead
branches, F4 is settled by the gate verdicts (and flagged), F2 is data-neutral and parked. The kill
criterion in the brief (stop docs-only if a product decision blocks) did not fire.

## Canonical semantics (what the chokepoint implements)

A caller may read a task iff **all** hold:

1. **Squad plane.** The task's squad is in the caller's readable squad set at rank **member**:
   - legacy role plane (`auth.role` owner/admin) **only while `auth.capabilities === undefined`**:
     every squad with `kind != 'home'`;
   - grants = `auth.capabilities` when loaded; when unloaded and `memberId` is set (a REST owner/admin
     cookie session) the member's rows are loaded from D1 (the old `canActOnSquad` behavior, so the
     owner's exact grant on their OWN home still resolves); no `memberId` -> no grants. Never
     `latentCapabilities`;
   - otherwise ambient grants only: an org-scope grant
     at member+ covers every non-home squad; a department-scope grant covers that department's non-home
     squads; an exact squad-scope grant at member+ covers its own squad — **including a home squad**
     (that is the home's owner, not inheritance);
   - a `kind='home'` squad is never covered by an inherited plane (org, department, role); the
     department expansion is filtered here even though `resolveReadableSquadIds` does not (so a legacy
     or poisoned department grant on a home department grants nothing).
2. **Not archived** (`TASK_NOT_ARCHIVED_SQL`) — except an explicit single-id history read
   (`canReadTask(..., { includeArchived: true })`, used by `GET /tasks/:id`).
3. **Project selection** (only when a listing is filtered by `project_id`): org-admin plane (role plane
   or org-scope admin grant) reads any existing project; anyone else needs a `project_squad_access`
   edge to a squad they may read (to the explicit squad when one is given, else to any squad in scope).
   The edge is a *project selector*, not a row predicate: a task whose squad has lost its edge stays
   readable in the unfiltered list.
4. Tenant is enforced by the surrounding gate (REST `inTenantScope`, MCP auth), not by the chokepoint.

`result`, `title`, `body` have no extra privacy rule: whoever may read the task reads all of it.

## API

- `resolveVisibleTaskScope(env, auth) -> { squadIds }` — explicit, bounded, de-duplicated list. Never
  `null`. (Composes `resolveGrantedSquadIds` and `resolveAllSquadIds({ excludeHome: true })`.)
- `visibleTaskClause(scope, startIndex, alias?) -> { sql, binds }` — squad-in-scope AND not archived,
  numbered placeholders (D1 rejects a bind count that differs from the placeholder count).
- `canReadSquadTasks(env, auth, squadId)` / `canReadTask(env, auth, task, opts)` — single-row twins.
- `hasProjectEdgeBypass(auth)` / `canReadProjectForTasks(env, auth, projectId, candidateSquadIds)`.

A future surface (verdict records at boot, a project projection) is `resolveVisibleTaskScope` + one SQL
clause, never a re-derivation.

## Migrated in this change

R1 `task_list` (gate + row predicate), R4 `GET /tasks` (explicit-squad and implicit list, project
selector, now archive-excluding), R5 `GET /tasks/:id`, R6 `loadProjectSituation` for its four
authenticated callers (`project_get`, `project_context`, REST `GET /projects/:id`, dashboard
`loadProjectDetail`) plus the task rows of `listProjectActivity` (REST `GET /projects/:id/activity`,
dashboard detail). The routine scheduler's `loadProjectSituation` calls pass an already explicit
server-chosen squad list, keep it, and now also exclude archived tasks.

## Not migrated (follow-ups)

- `task_board` `src/mcp/index.ts:1149` (same semantics as `task_list` today; mechanical).
- `kanban_board` / dashboard kanban `src/dashboard/kanban-routes.ts:64` (F4, F6).
- `projectAggregates` `src/projects/index.ts:221-260` and `loadProjectAggregates`
  `src/dashboard/projects.ts` (task counts at observer, archive- and home-blind).
- `listProjectEvidence` (`src/projects/projections.ts`) and dashboard `loadReadableTasks`
  `src/dashboard/projects.ts:~600-660` — task-derived rows still on the old readable list.
- Flights / routines / messages / project-link slices inside `loadProjectSituation` and
  `listProjectActivity` still use the old readable-squad list (home exclusion and rank not applied).
- Project selection itself (`readableProject`, `projectVisibilityClause`) remains an oracle for home
  squad ids through `project_squad_access` (P2 recorded on #1648's gate).
- The ~60 other `FROM tasks` SELECT sites inventoried in #1561.
