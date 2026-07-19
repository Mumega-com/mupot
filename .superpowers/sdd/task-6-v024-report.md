# Task 6 v0.24 Report

Status: COMPLETE

## TDD

- RED command: `npx vitest run tests/projects-local-smoke.test.ts tests/dashboard-projects.test.ts`
- Expected RED causes: the dashboard had no parseable browser situation projection, seed replay
  retained superseded fleet keys, and the browser/evidence driver lacked authoritative lifecycle,
  surface-parity, and isolated-state behavior.
- Observed RED: 3 failed, 53 passed, matching those expected causes.
- GREEN command: `npx vitest run tests/projects-local-smoke.test.ts tests/dashboard-projects.test.ts`
- Observed GREEN: 56 passed.

## Delivered

- Seeded `project-mupot` with blocked, review, in-progress, and completed work, readable
  squad/agent data, and live, offline, and stale fleet-runtime truth from the existing tables.
- Added a safe JSON browser projection and executable parity evidence for the same seeded
  `project-mupot` situation through the real browser, REST `GET /api/projects/:id`, and MCP
  `project_get`; dashboard-loader equality remains covered by the focused tests.
- The machine receipt labels browser, REST, and MCP values, records equal canonical hashes for
  the full situation, names the compared fields and truncation flags, and records browser Team
  presence labels.
- Extended local browser smoke with the owner Project lifecycle under Mumega Products:
  create, edit goal, activate, canonical situation, search/filter, complete, reopen as active,
  pause, archive, and restore-to-planned.
- Read canonical REST state after every mutation and separated each command, expected transition,
  and observed persisted status in the receipt.
- Runs local evidence against a fresh temporary D1 state directory, removes superseded fleet
  fixture keys, and prove two-seed stability for canonical Project/task/flight/fleet counts.
- Captured the project ID, authoritative lifecycle transitions, observed situation, desktop/mobile
  document-overflow measurements, Team/Squads internal-scroll metrics, and screenshot paths
  in `tmp/local-smoke/report.json`.

## Final Evidence

- Exact integration HEAD before evidence: `a3209845101723dff49dbf96b9e3929179def858`,
  including approved marketing harness corrections `0f45250` and `a320984` after the Task 6
  implementation commit `7cf4943`.
- Browser-created project ID: `5f50b7e6-c134-4a46-ad54-e9115d07112b`.
- Lifecycle observations: create `planned`; edit `planned`; activate `active`; complete `completed`;
  reopen `active`; pause `paused`; archive `archived`; restore `planned`.
- `project-mupot` browser, REST, and MCP canonical situation hash:
  `7f91e8d827b1689641eca3d9b123f5830c4156879af17942260335c68573511b` on all three surfaces.
- Shared situation: `blocked`; 1 blocker; 1 pending review; 3 active work items; 1 active
  flight; no truncation; latest activity `flight-running-local`; next action `review_task`.
- Browser Team presence: Hermes `Live`, Growth `Offline`, Conformance `Stale`, and the
  unattached sender `Not attached`.
- Observed situation after activation: `ready`, next action `create_task`, with the edited goal.
- Document overflow: `0px` for Mupot and the created Project at 1440px desktop and 390px mobile.
- Team/Squads mobile internal region: `304px` client width, `1120px` scroll width, movement
  proved at `32px`, and the screenshot captured the right edge at `816px`.
- Fresh local D1 state: `tmp/local-evidence/state.HV6crH`; the driver cleanup removed the
  temporary state directory after the run.
- Browser receipt: `tmp/local-smoke/report.json`; screenshot paths are recorded under
  `tmp/local-smoke/`, including `project-mupot.png`, `project-mupot-team-mobile.png`, and both
  desktop/mobile created-Project captures.
- Runtime receipt: `tmp/local-runtime-conformance/report.json` (`runtime-adapter/v1`, all 11
  conformance steps passed).

Generated receipts, screenshots, Wrangler logs, and temporary D1 state remain ignored and are
not committed.

## Review Responses

1. Same-Project parity: fixed with a parseable authorized browser projection, real REST and MCP
   reads in the browser run, equal full-contract hashes, named canonical fields, and Team presence.
2. Lifecycle authority: fixed with complete/reopen plus REST-observed persisted status after every
   create, edit, and lifecycle command.
3. Idempotent evidence: fixed with a fresh temporary D1 state per driver run, guarded cleanup,
   deletion of superseded fleet keys, and a two-seed canonical-count regression test.

## Verification

- `npx vitest run tests/projects-local-smoke.test.ts tests/dashboard-projects.test.ts tests/projects-routes.test.ts tests/mcp-project-tools.test.ts`
  (4 files passed, 92 tests passed).
- `npm run typecheck` (passed; `tsc --noEmit`).
- `node scripts/no-secrets.mjs` (passed; `no secrets found`).
- `bash scripts/ci-local-evidence.sh` (passed; fresh isolated D1 migrations/seed, browser workflow,
  31-route crawl, same-Project parity, complete lifecycle, and runtime conformance all completed).
