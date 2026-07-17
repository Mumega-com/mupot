# Project-Centered Workspace Design

**Status:** Approved for implementation on 2026-07-17.

## Goal

Make Projects the familiar organizing context inside a pot while preserving Mupot's distinctive execution model: stateful squads, governed flights, approvals, evidence, costs, and provider-neutral integrations.

## Product Model

A pot is the tenant and sovereignty boundary. A project is a durable outcome-bearing context inside that pot. Projects may contain one level of child projects. Work below a child project is represented by goals, milestones, tasks, flights, and evidence rather than deeper project nesting.

```text
Pot
|- Project or program
|  |- Child project
|  |  |- goals, squads, tasks, flights, evidence
|  |- goals, squads, tasks, flights, evidence
|- Workspace-wide work, approvals, team, operations, settings
```

The database represents the hierarchy with an optional recursive `parent_project_id`. The service enforces a two-level visible hierarchy: a root project may have children; a child cannot have children. Cycles and self-parenting are always rejected.

## First Vertical Slice

The first releasable slice includes:

- project creation, listing, detail, update, and archival;
- an optional parent project with depth and cycle validation;
- project-to-squad access edges using `read`, `write`, or `admin`;
- optional project attribution on tasks and flights;
- `/projects` and `/projects/:id` dashboard pages;
- project filtering on the existing task and flight APIs;
- a primary Projects navigation item;
- backward compatibility for rows and callers without a project;
- a local Mumega showcase seed and browser smoke coverage.

It does not yet remove or redirect Fleet, Radar, Control Tower, Economy, or Access surfaces. Consolidation happens after project attribution is deployed and observed, so Mupot never needs a big-bang navigation cutover.

## Persistence

`projects` contains substrate metadata only. Customer content remains in the customer's pot.

```sql
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  goal              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('planned','active','paused','completed','archived')),
  parent_project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  target_date       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (parent_project_id IS NULL OR parent_project_id <> id)
);

CREATE TABLE project_squad_access (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  squad_id     TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'write'
               CHECK (access_level IN ('read','write','admin')),
  granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, squad_id)
);
```

`tasks.project_id` and `flights.project_id` are nullable text columns because this repository does not rely on `ALTER TABLE ... ADD COLUMN ... REFERENCES` for existing SQLite tables. Validation triggers reject unknown project IDs on inserts and attribution updates. Existing work remains valid and appears in the workspace-level Unassigned filter until deliberately classified. Projects have no destructive delete route, so attribution cannot be orphaned through the supported API.

Projects do not carry a tenant column because one D1 database is one pot. API authentication still hard-checks `AuthContext.tenant === env.TENANT_SLUG`.

## Invariants

1. Project slugs use the existing lowercase slug convention and are unique within the pot.
2. Archived projects are immutable except for restoration to `active` by an owner/admin.
3. Parent and child projects belong to the same pot by construction.
4. A root may contain children. A child may not contain another child.
5. Reparenting must not create a cycle or move a parent under one of its children.
6. Archiving a parent does not silently archive children. The API rejects the operation while active children exist.
7. There is no destructive project delete route in v1.
8. Aggregates are computed from children and attributed work; progress and cost are not duplicated onto parent rows.
9. A task or flight may belong to at most one project in v1.
10. A governed flight attributed to a project may reference only tasks attributed to that same project.
11. SOS is neither a dependency nor a transport for this feature. Mupot continues to use its own Cloudflare runtime and pub/sub.

## Authorization

The first slice avoids expanding `capabilities.scope_type`, whose current database constraint is `org|department|squad`.

- Workspace owners and admins can see and administer all projects.
- A member can see a project when they hold `observer+` on at least one squad granted to that project.
- A member can create or mutate work in a project only when they hold `member+` on a granted squad and the project edge is `write` or `admin`.
- Project creation, hierarchy changes, archival, and squad-edge administration require workspace `admin+`.
- Parent visibility is implied when a visible child must be placed in context, but that implication does not grant access to sibling work.
- Child projects do not automatically inherit parent squad edges in v1. Explicit child edges keep authorization auditable and fail closed.

## API

The router is mounted at `/api/projects` before the dashboard catch-all.

- `GET /api/projects?status=&parent_id=` lists visible projects.
- `POST /api/projects` creates a project (`admin+`).
- `GET /api/projects/:id` returns a visible project and aggregate counts.
- `PATCH /api/projects/:id` updates safe fields (`admin+`).
- `GET /api/projects/:id/squads` lists explicit squad edges.
- `PUT /api/projects/:id/squads/:squadId` grants or changes access (`admin+`).
- `DELETE /api/projects/:id/squads/:squadId` removes an edge (`admin+`).
- `GET /api/tasks?project_id=` filters work without changing the default cross-project response.
- flight creation accepts optional `project_id`; flight listing accepts optional `project_id`.

Every caller-supplied identifier is bound as a SQL parameter. Mutation services verify row-change receipts and map uniqueness/foreign-key errors to stable domain errors.

## Interface

The first slice changes the global navigation minimally:

- Home
- Projects
- Work
- Approvals
- existing operational/admin surfaces remain reachable

`/projects` shows root projects with child rows, status, goal, squad count, open-work count, active-flight count, and target date. `/projects/:id` provides tabs for Overview, Work, Squads, Activity, and Evidence. The first slice renders Overview, Work, and Squads; Activity and Evidence may show honest empty states until their project attribution is introduced.

Workspace-level Work and Approvals remain cross-project. A project page applies project context through query parameters and visible breadcrumbs rather than cloning task-management interfaces.

## Provider Boundary

Native Mupot tasks remain the canonical fallback. Linear, GitHub Projects, Jira, or another service may later implement a task-management adapter, but no external provider owns Mupot project identity, authorization, flights, gates, costs, or evidence.

## Graduation

A child project can later graduate into its own pot. Graduation is an explicit export/import workflow that emits a signed lineage receipt containing source pot identity, source project identity, exported schema version, and timestamps. It does not copy secrets, member credentials, private memories, or unrelated project data. Graduation is deliberately outside the first vertical slice, but stable project IDs and non-destructive archival preserve the required lineage.

## Delivery Sequence

1. Project persistence and invariant-tested service.
2. Authenticated API and squad access edges.
3. Optional task and flight attribution with backward compatibility.
4. Project list/detail UI and primary navigation.
5. Mumega local showcase seed, browser checks, and migration verification.
6. Later: Work consolidation, Operations consolidation, Settings consolidation, provider adapters, and graduation receipts.
