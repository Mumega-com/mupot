# Mupot v0.24 Project Operations Implementation Plan

> **Goal:** Make every Mupot Project a truthful operating home where humans and AI teammates can immediately understand the goal, current situation, responsible team, active work, blockers, runtime activity, evidence, and next action, then operate it consistently through both the dashboard and MCP.

**Current stable:** `v0.23.0`

**Target release:** `v0.24.0 Project Operations`

**Branch:** `codex/dme-cross-pot-collaboration`

**Draft PR:** [#393](https://github.com/Mumega-com/mupot/pull/393)

## Global Constraints

- [ ] Use Project, Task, Flight, Squad, Agent, fleet runtime, activity, and evidence tables as canonical truth; do not create a second dashboard-only state store.
- [ ] Compute the Project situation deterministically and expose the same result through REST, MCP, and the dashboard.
- [ ] Preserve tenant and capability filtering. A Project situation must never reveal tasks, squads, agents, flights, activity, or evidence outside the caller's readable scope.
- [ ] Keep project mutations admin-governed and route them through the existing `src/projects/service.ts` mutation rules and receipts.
- [ ] Do not weaken signed inbox fencing, token welding, CSRF, or release gates to make tests pass.
- [ ] Keep DME provisioning, token minting, deployment, and production cutover outside this release unless separately approved by the owner.
- [ ] Add behavior with test-driven development: first write the failing assertion, run it and confirm the expected failure, then implement the minimum production change.

## Task 1: Restore a truthful green release baseline

**Files:**
- Modify: `ROADMAP.md`
- Modify: `tests/project-link-envelope-security.test.ts`
- Modify: `tests/project-projections.test.ts`
- Modify: `scripts/local-test-seed.sql`
- Test: `tests/release-v023-readiness.test.ts`
- Test: `tests/project-link-envelope-security.test.ts`
- Test: `tests/project-projections.test.ts`
- Test: `tests/projects-local-smoke.test.ts`

- [x] Add the explicit phrase `marketplace distribution` to the v0.29 roadmap scope without changing the release order.
- [x] Replace literal credential-shaped security fixtures with runtime-composed strings while preserving the exact values seen by the code under test.
- [x] Add a regression assertion that the local `agent-conformance` fixture has an explicit `signed_only` inbox fence welded to the registered key fingerprint.
- [x] Confirm the regression fails because the seed registers the signed runtime key but omits the required signed-consumer fence.
- [x] Seed the test-only fence with the SHA-256 fingerprint of the fixture public key and the fixture member as updater. Preserve production consumer-fence behavior and keep browser/runtime evidence on one continuous state so queued control messages are exercised.
- [x] Run `node scripts/no-secrets.mjs`, the four focused Vitest files, and `bash scripts/ci-local-evidence.sh`.

## Task 2: Add one shared Project situation contract

**Files:**
- Create: `src/projects/situation.ts`
- Modify: `src/projects/index.ts`
- Modify: `src/mcp/projects.ts`
- Modify: `src/types.ts` only if the shared public type belongs there
- Create: `tests/project-situation.test.ts`
- Modify: `tests/projects-routes.test.ts`
- Modify: `tests/mcp-project-tools.test.ts`

- [x] Define `ProjectSituation` with `health`, `summary`, `blockers`, `pending_reviews`, `active_work_count`, `active_flight_count`, `latest_activity`, and `next_action`.
- [x] Derive health in this order: project lifecycle status (`archived`, `paused`, `completed`), blockers, pending review, active work or flight, then ready.
- [x] Derive next action in this order: review a pending item, unblock a blocked item, continue in-progress work, start open work, monitor an active flight, create the next task for an active project, verify completion evidence for a completed project, or resume/reopen a paused/archived project.
- [x] Bound every query and apply the same readable squad and canonical flight filtering already used by Project REST and dashboard loaders.
- [x] Extend `GET /api/projects/:id` with `situation` from the shared service.
- [x] Extend MCP `project_get` with the same `situation` object rather than duplicating derivation logic.
- [x] Test blocked, review, active, ready, paused, completed, archived, empty, and restricted-squad cases.
- [x] Run the three focused test files and `npm run typecheck`.

## Task 3: Make the Project page the operating home

**Files:**
- Modify: `src/dashboard/projects.ts`
- Modify: `tests/dashboard-projects.test.ts`

- [x] Load `ProjectSituation` through the shared situation service.
- [x] Replace the overview's metric-only emphasis with a compact Situation band showing health, deterministic summary, next action, blockers, pending reviews, active work, active flights, and latest material activity.
- [x] Keep Goal, target date, and direct metrics visible without card nesting.
- [x] Make Work list ordering operational: review, blocked, in progress, open, then terminal work.
- [x] Add stable empty states for projects with no work, team, activity, or evidence.
- [x] Test truthful labels and ordering for blocked, review, active, and empty projects.
- [x] Run `npx vitest run tests/dashboard-projects.test.ts` and `npm run typecheck`.

## Task 4: Add governed Project lifecycle controls

**Files:**
- Modify: `src/dashboard/index.ts`
- Modify: `src/dashboard/projects.ts`
- Modify: `tests/dashboard-projects.test.ts`
- Modify: `tests/projects-routes.test.ts` only if a service behavior gap is found

- [x] Add admin-only create and settings views using the existing dashboard session, CSRF middleware, and Project service.
- [x] Support create, edit metadata, move under one parent, activate, pause, complete, archive, and restore-to-planned while preserving existing hierarchy and active-child rules.
- [x] Show create/settings controls only to workspace admins; return 403 for unauthorized POSTs and 404 for inaccessible projects.
- [x] Redirect successful mutations to the canonical Project detail page with a concise status result; render validation failures without losing submitted values.
- [x] Add status filtering and name/goal search to `/projects` without changing the canonical API pagination contract.
- [x] Test RBAC, CSRF-compatible form actions, validation failures, lifecycle transitions, archive protection, filtering, and search.
- [x] Run focused dashboard and route tests plus `npm run typecheck`.

## Task 5: Show responsible squads, agents, and runtime truth

**Files:**
- Modify: `src/dashboard/projects.ts`
- Modify: `tests/dashboard-projects.test.ts`

- [ ] Extend the Project Team view from squad edges to readable squad members.
- [ ] Join agents to fleet runtime state through the existing identifier bridge semantics; show runtime, stored intent, derived presence, and last seen without claiming an offline runtime is live.
- [ ] Preserve capability filtering so a caller only sees members of readable Project squads.
- [ ] Distinguish `not attached`, `live`, `stale`, and `offline` with text and status styling.
- [ ] Test live, stale, offline, unattached, duplicate-slug/ID bridge, and restricted-squad cases.
- [ ] Run `npx vitest run tests/dashboard-projects.test.ts tests/fleet-registry.test.ts` and `npm run typecheck`.

## Task 6: Prove dashboard/MCP parity and browser operation

**Files:**
- Modify: `scripts/local-test-seed.sql`
- Modify: `scripts/local-browser-smoke.mjs`
- Modify: `scripts/local-runtime-conformance.mjs` only if evidence output needs the shared situation receipt
- Modify: `tests/projects-local-smoke.test.ts`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`

- [ ] Seed blocked, review, active, completed, squad, agent, and runtime examples for `project-mupot`.
- [ ] Extend browser smoke to create a nested Project, edit its goal, activate it, verify the situation, filter/search it, pause it, archive it, restore it, and verify desktop/mobile layout without horizontal overflow.
- [ ] Read the same Project through REST/MCP test harness and assert health, blocker counts, and next action match the browser's canonical situation.
- [ ] Capture screenshots and a machine-readable receipt under `tmp/local-smoke` without committing generated artifacts.
- [ ] Update CHANGELOG and ROADMAP only for behavior proven by tests; leave unimplemented v0.24 items open.
- [ ] Run `npm test`, `npm run typecheck`, `node scripts/no-secrets.mjs`, and `bash scripts/ci-local-evidence.sh`.

## Task 7: Review, publish, and obtain the release gate

**Files:**
- Review all changes since `5284348`
- Update: `.superpowers/sdd/progress.md`
- Update PR: [#393](https://github.com/Mumega-com/mupot/pull/393)

- [ ] Run a task-scoped spec and code-quality review after each implementation task.
- [ ] Run a final whole-branch review focused on tenant isolation, RBAC, truthful runtime presence, mutation receipts, and dashboard/MCP parity.
- [ ] Fix every Critical or Important finding and rerun its covering tests.
- [ ] Commit each coherent task, push the branch, and update PR #393 with exact evidence and remaining owner gates.
- [ ] Request Kasra review through GitHub issue #392 or PR #393; do not rely on a Mupot inbox receipt until its transport is proven.
- [ ] Keep the PR draft until CI is green, Kasra's P0/P1 findings are resolved, and the owner separately approves merge/deploy.

## Release Exit Criteria

- [ ] A permitted user and an MCP client see the same Project health, blockers, pending review, active work, active flights, latest activity, and next action.
- [ ] Workspace admins can complete the full Project lifecycle from the dashboard; non-admins cannot mutate it.
- [ ] The Project Team view reports squad membership and runtime presence truthfully.
- [ ] Browser evidence covers desktop and mobile Project operation, not only page rendering.
- [ ] Unit, integration, typecheck, no-secrets, browser, and runtime conformance checks pass from a clean local evidence state.
- [ ] GitHub CI is green and PR #393 has an explicit reviewer decision before merge.
