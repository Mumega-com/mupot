# Task 6 v0.24 Report

Status: DONE

## TDD

- RED command: `npx vitest run tests/projects-local-smoke.test.ts`
- Expected RED cause: the seed had no blocked Mupot task and kept the review task outside
  `project-mupot`; the new parity assertion expected both records in the shared situation.
- GREEN command: `npx vitest run tests/projects-local-smoke.test.ts`

## Delivered

- Seeded `project-mupot` with blocked, review, in-progress, and completed work, readable
  squad/agent data, and live, offline, and stale fleet-runtime truth from the existing tables.
- Added executable REST `GET /api/projects/:id`, MCP `project_get`, and dashboard-loader
  parity coverage for the complete shared situation contract.
- Extended local browser smoke with the owner Project lifecycle under Mumega Products:
  create, edit goal, activate, canonical situation, search/filter, pause, archive, and
  restore-to-planned.
- Captured the project ID, lifecycle transitions, observed situation, desktop/mobile
  document-overflow measurements, Team/Squads internal-scroll metrics, and screenshot paths
  in `tmp/local-smoke/report.json`.

## Evidence

- Browser-created project ID: `d7f52b57-5567-45e9-8d6a-5f06b9141b3e`
- Lifecycle: planned/create -> planned/update -> active/activate -> paused -> archived -> planned/restore.
- Observed situation after activation: `ready`, next action `create_task`, with the edited goal.
- Document overflow: `0px` for Mupot and the created Project at 1440px desktop and 390px mobile.
- Team/Squads mobile internal region: `304px` client width, `1120px` scroll width, scroll position advanced to `32px`.
- Browser receipt: `tmp/local-smoke/report.json`.
- Runtime receipt: `tmp/local-runtime-conformance/report.json`.

## Verification

- `npx vitest run tests/projects-local-smoke.test.ts tests/dashboard-projects.test.ts tests/projects-routes.test.ts tests/mcp-project-tools.test.ts` (91 passed)
- `npm run typecheck` (passed)
- `node scripts/no-secrets.mjs` (passed)
- `bash scripts/ci-local-evidence.sh` (passed; browser and runtime conformance receipts recorded)
