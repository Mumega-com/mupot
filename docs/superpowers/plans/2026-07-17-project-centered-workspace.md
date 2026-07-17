# Project-Centered Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a backward-compatible nested Projects vertical slice with project-scoped squads, tasks, flights, and a project-centered dashboard.

**Architecture:** Add a focused `src/projects` component and D1 schema without replacing the existing org, work, flight, or capability components. Project access is derived from explicit project-to-squad edges plus existing identity-derived squad capabilities. Dashboard pages consume the project service and preserve existing workspace-wide routes.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1/SQLite, server-rendered `hono/html`, Vitest, Wrangler, Playwright.

## Global Constraints

- One D1 database is one pot; do not add request-controlled tenant IDs to project rows.
- The visible hierarchy is limited to root project plus one child-project level.
- Reject self-parenting, cycles, a child receiving children, and archiving a parent with active children.
- Existing tasks and flights without `project_id` remain valid and visible workspace-wide.
- Do not expand the existing capability scope enum in this slice.
- Project squad edges are explicit and do not inherit from parent to child.
- No SOS runtime, schema, or transport dependency.
- No destructive project deletion route.
- Use tests first and observe each new behavior fail before production implementation.

---

### Task 1: Project Persistence and Domain Service

**Files:**
- Create: `migrations/0055_projects.sql`
- Create: `src/projects/service.ts`
- Modify: `src/types.ts`
- Test: `tests/projects-migration.test.ts`
- Test: `tests/projects-service.test.ts`

**Interfaces:**
- Produces: `Project`, `ProjectStatus`, `ProjectAccessLevel` types.
- Produces: `createProject`, `listProjects`, `getProject`, `updateProject`, `listProjectSquads`, `upsertProjectSquadAccess`, `removeProjectSquadAccess`.

- [ ] **Step 1: Write migration tests that apply migrations and assert the project tables, nullable task/flight attribution, foreign keys, checks, and indexes.**
- [ ] **Step 2: Run `npx vitest run tests/projects-migration.test.ts` and confirm failure because migration 0055 is absent.**
- [ ] **Step 3: Add `0055_projects.sql` using the approved SQL from the design, plus nullable text `project_id` columns, fail-closed unknown-project validation triggers, and indexes on `projects(parent_project_id,status)`, `project_squad_access(squad_id,project_id)`, `tasks(project_id,status)`, and `flights(project_id,status)`. Do not use `ALTER TABLE ... ADD COLUMN ... REFERENCES`.**
- [ ] **Step 4: Re-run the migration test and confirm it passes.**
- [ ] **Step 5: Write service tests for slug validation, duplicate slug mapping, root creation, child creation, depth rejection, cycle rejection, archive-with-active-child rejection, immutable archived rows, explicit squad edges, and write receipts.**
- [ ] **Step 6: Run `npx vitest run tests/projects-service.test.ts` and confirm failures because the service does not exist.**
- [ ] **Step 7: Implement the minimal service with parameter-bound queries and this result shape:**

```ts
export type ProjectMutationError =
  | 'invalid_slug' | 'invalid_name' | 'invalid_status' | 'invalid_target_date'
  | 'slug_taken' | 'project_not_found' | 'parent_not_found'
  | 'hierarchy_depth' | 'hierarchy_cycle' | 'active_children'
  | 'archived_project' | 'squad_not_found' | 'invalid_access_level'
  | 'receipt_failed'

export type ProjectMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectMutationError }
```

- [ ] **Step 8: Run both project test files and `npm run typecheck`; confirm green.**
- [ ] **Step 9: Commit with `feat(projects): add nested project domain`.**

### Task 2: Authenticated Project API

**Files:**
- Create: `src/projects/index.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/projects-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 service functions.
- Produces: `projectsApp`, mounted at `/api/projects` before `dashboardApp`.

- [ ] **Step 1: Write route tests for tenant rejection, unauthenticated rejection, owner/admin CRUD, member visibility through a readable squad, hidden siblings, parent context visibility, squad-edge administration, and stable 400/403/404/409 errors.**
- [ ] **Step 2: Run `npx vitest run tests/projects-routes.test.ts` and confirm failure because `projectsApp` is absent.**
- [ ] **Step 3: Implement `projectsApp` with `csrf()`, `requireAuth`, the tenant hard guard, and identity-derived capability resolution.**
- [ ] **Step 4: Implement readable-project filtering as `owner/admin => all`; otherwise visible when an explicit project squad edge joins a squad on which the member has `observer+`, plus only the parent rows required as context.**
- [ ] **Step 5: Gate project and hierarchy mutations at workspace `admin+`; gate squad-edge mutations at workspace `admin+`; never accept a member ID from request data.**
- [ ] **Step 6: Mount the router in `src/index.ts` before the dashboard catch-all and add a `ROUTES.projects` constant if the route table uses constants for API components.**
- [ ] **Step 7: Run the route tests, project tests, and `npm run typecheck`; confirm green.**
- [ ] **Step 8: Commit with `feat(projects): expose governed project API`.**

### Task 3: Attribute Tasks and Flights to Projects

**Files:**
- Modify: `src/types.ts`
- Modify: `src/tasks/index.ts`
- Modify: `src/tasks/service.ts`
- Modify: `src/flight/service.ts`
- Modify: `src/flight/routes.ts`
- Test: `tests/tasks-project-filter.test.ts`
- Test: `tests/flights-project.test.ts`
- Modify: `tests/tasks-service.test.ts`

**Interfaces:**
- Consumes: nullable `projects.id` foreign key and project squad-access checks.
- Produces: optional `project_id` on `Task`, `NewFlight`, and `FlightRow`.

- [ ] **Step 1: Write task tests proving `project_id` is optional, a supplied project must exist, the task squad must hold `write|admin` on it, and `GET /api/tasks?project_id=` remains bounded and RBAC-filtered.**
- [ ] **Step 2: Run the task project tests and confirm they fail on missing attribution support.**
- [ ] **Step 3: Add `project_id?: string | null` to task creation, include it in parameter-bound inserts/selects/events, and add project filtering without changing responses when the query is absent.**
- [ ] **Step 4: Update existing task service fixtures for the new insert bind and run all task-focused tests.**
- [ ] **Step 5: Write flight tests proving optional attribution, project existence, list filtering, same-project task references for governed flights, and unchanged legacy flight creation.**
- [ ] **Step 6: Run the flight project tests and confirm they fail.**
- [ ] **Step 7: Extend `NewFlight`, `FlightRow`, insert, list, and route validation with nullable `project_id`; reject inaccessible project attribution before creating a flight.**
- [ ] **Step 8: Run `npx vitest run tests/tasks-project-filter.test.ts tests/flights-project.test.ts tests/tasks-service.test.ts tests/flight-routes.test.ts tests/mcp-flight-tools.test.ts` and `npm run typecheck`; confirm green.**
- [ ] **Step 9: Commit with `feat(projects): attribute work and flights`.**

### Task 4: Project-Centered Dashboard Slice

**Files:**
- Create: `src/dashboard/projects.ts`
- Modify: `src/dashboard/index.ts`
- Test: `tests/dashboard-projects.test.ts`
- Test: `tests/dashboard-auth-shell.test.ts`

**Interfaces:**
- Consumes: Task 1 list/detail service and existing dashboard `shell`, `pageHeader`, `sectionPanel`, `dataTable`, and `emptyState` patterns.
- Produces: `/projects`, `/projects/:id`, project cards/tree, Overview/Work/Squads tabs, and a primary Projects sidebar link.

- [ ] **Step 1: Write renderer tests for nested root/child display, empty state, escaped content, status/goal/target date, aggregate metrics, project-filtered work links, squad edges, and honest Activity/Evidence empty states.**
- [ ] **Step 2: Write route tests for authenticated rendering, member visibility, hidden sibling data, 404, and mobile-safe markup.**
- [ ] **Step 3: Run `npx vitest run tests/dashboard-projects.test.ts` and confirm failure because the renderer and routes are absent.**
- [ ] **Step 4: Implement `src/dashboard/projects.ts` as a focused loader/renderer module; do not add project-specific rendering logic to the 5,499-line dashboard shell.**
- [ ] **Step 5: Register `/projects` and `/projects/:id` before `dashboardBuiltInGetRoutes` is frozen and before the addon wildcard.**
- [ ] **Step 6: Replace the Organization-first sidebar emphasis with direct Home, Projects, Work, and Approvals entries while retaining every existing destination below them.**
- [ ] **Step 7: Run dashboard project tests, dashboard route collision tests, addon console tests, auth shell tests, and `npm run typecheck`; confirm green.**
- [ ] **Step 8: Commit with `feat(dashboard): add project-centered workspace`.**

### Task 5: Local Showcase, Migration, and Browser Verification

**Files:**
- Modify: `scripts/local-test-seed.sql`
- Modify: `scripts/local-browser-smoke.mjs`
- Create: `tests/projects-local-smoke.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: locally reproducible Mumega root/child project showcase and browser receipt.

- [ ] **Step 1: Write a local-smoke test that expects Mumega Products with Inkwell, Mirror, SOS, and Mupot children plus Marketing Infrastructure with MCPWP and MumCP.**
- [ ] **Step 2: Run the smoke test and confirm failure because the local seed contains no projects.**
- [ ] **Step 3: Add idempotent local showcase project rows and project-squad edges without adding them to production migrations.**
- [ ] **Step 4: Extend browser smoke to verify `/projects`, a child project detail page, project-filtered work, no horizontal overflow at 390x844, and all legacy sidebar destinations remaining reachable.**
- [ ] **Step 5: Apply local migrations to a clean D1 database, seed it, start `wrangler dev` on an unused port, and run browser smoke.**
- [ ] **Step 6: Run `npm test`, `npm run typecheck`, and migration replay from empty state; record exact totals.**
- [ ] **Step 7: Update README with the project-centered model, hierarchy limit, provider-neutral boundary, and local verification commands.**
- [ ] **Step 8: Commit with `test(projects): verify local project workspace`.**

### Task 6: Final Review and Delivery Gate

**Files:**
- Review all files changed since the branch merge base.

- [ ] **Step 1: Generate a whole-branch review package from the merge base.**
- [ ] **Step 2: Dispatch an independent code review focused on authorization leakage, hierarchy invariants, migration replay, route collision, SQL bounds, HTML escaping, and mobile overflow.**
- [ ] **Step 3: Resolve every Critical and Important finding with covering tests.**
- [ ] **Step 4: Re-run the full suite, typecheck, clean migration replay, and browser smoke.**
- [ ] **Step 5: Present the diff, test evidence, remaining consolidation roadmap, and deployment decision without deploying or pushing unless explicitly requested.**
