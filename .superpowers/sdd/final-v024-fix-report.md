# Mupot v0.24 Final Review Fix Report

**Status:** DONE
**Baseline HEAD:** `374923a3f498d9e98b958aa6c8827b9b37af0bd6`
**Implementation commit:** `e8491a51e0667c1c08c98e5a8cc3ee17f042521a`
**Branch:** `codex/dme-cross-pot-collaboration`
**Date:** 2026-07-19

## Result

All four Important findings in `.superpowers/sdd/final-v024-review.md` are resolved. Existing tenant, capability, mutation, query-bound, sanitization, fresh-state, cleanup, and CI artifact-path behavior is preserved. The auxiliary intrinsic-poison/local-evidence precision commits `cff5a1b` and `5b6ad7e` remain unchanged.

Deployment and version changes were not made.

## RED Record

### I1: org observer parity

Command:

```text
npx vitest run tests/projects-local-smoke.test.ts -t "gives a no-edge org observer the same complete situation across REST, MCP, and dashboard"
```

RED cause: the no-edge org observer received REST `404` where `200` was expected, while MCP allowed the same Project. Dashboard therefore could not provide the same complete situation.

### I2: fleet namespace collision

Command:

```text
npx vitest run tests/fleet-agent-liveness.test.ts tests/dashboard-projects.test.ts
```

RED causes:

- `getFleetAgentLiveness` returned agent A's exact runtime route for agent B when B's unique slug equaled A's canonical ID.
- Project Team attributed the same exact fleet host/runtime row to both agents.

### I3: Project Link event truth and determinism

Commands:

```text
npx vitest run tests/project-projections.test.ts tests/projects-local-smoke.test.ts
npx vitest run tests/projects-migration.test.ts
npx vitest run tests/project-projections.test.ts -t "orders and cursors a Project Link by a failure"
```

RED causes:

- A retained prior success won `occurred_at` and ordering over a later failure or revocation.
- Keyset pagination used the prior success timestamp.
- Unchanged Project Link Activity could change from `healthy` to `stale` between independent surface requests.
- No forward migration existed to replace the already-shipped `0059` index expression.
- Text `MAX` selected an earlier ISO-formatted success over a later SQLite-formatted failure, proving timestamp comparison had to be numeric.

### I4: evidence ownership

Command:

```text
npx vitest run tests/local-evidence-driver.test.ts
```

Initial result: 3 failed tests.

RED causes:

- A preoccupied endpoint did not stop migrations or startup.
- Health from an impostor service was accepted after the spawned process exited.
- The driver ignored isolated artifact-directory inputs and retained failure artifacts into a later successful run.

## Finding Responses

### I1: one Project visibility rule

`src/projects/access.ts` now owns Project read-access derivation and the Project visibility SQL used by REST, MCP, and dashboard. Org observers receive unrestricted Project reads, including no-edge Projects and complete readable situations, while remaining non-admin for all mutations. Squad and department observers still require a matching edge. Existing non-observer denial, tenant denial, explicit-capability denial, CSRF, and admin-only mutation tests remain green.

### I2: globally reserved fleet IDs

Both fleet read paths now refuse slug fallback whenever the candidate slug matches any canonical `agents.id`. Exact ID lookup still wins. The single-agent path adds the reservation check inside its existing cardinality query; the batch path adds it inside its existing slug-cardinality query, so query count remains constant. Tenant filtering, duplicate-slug refusal, the 100-agent bound, and safe in-Worker dispatch fallback remain intact.

### I3: actual latest durable event

Project Link Activity now computes one numeric epoch from the maximum Julian timestamp across creation, success, failure, and revocation. That exact expression drives selected `occurred_at`, SQL ordering, and keyset cursor comparison. A later failure or revocation therefore wins over retained success even when stored timestamp formats differ.

The exact Activity/Situation contract no longer derives Project Link `healthy` versus `stale` from request wall time. It reports durable event state (`unknown`, `healthy`, `failed`, or `revoked`), making unchanged database state deterministic across browser, REST, and MCP. The explicit Project Link status API retains its caller-supplied clock and stale behavior.

Shipped `migrations/0059_project_projection_keysets.sql` is unchanged. New `migrations/0060_project_link_latest_event_index.sql` drops and recreates `idx_project_links_activity_keyset` with the numeric latest-event expression. Migration coverage applies all migrations through `0059`, verifies the old expression, applies `0060` twice, and verifies the replacement expression.

### I4: owned and isolated evidence

The local evidence driver now probes the selected listener before artifact deletion, migrations, or startup and refuses an occupied endpoint. After health succeeds it verifies that the spawned Wrangler PID is still alive, and repeats that check before browser and runtime suites.

Browser and runtime artifact directories are cleared at the start of each run. Default CI paths remain unchanged. Custom paths must either be new or contain the driver marker before deletion; root, repository root, and repository `tmp` are always refused. Fresh temporary D1 state and its path-guarded cleanup remain unchanged. The driver honors custom artifact paths for deterministic isolation tests and local use.

## Changed Files

Implementation:

- `src/projects/access.ts`
- `src/projects/index.ts`
- `src/mcp/projects.ts`
- `src/dashboard/projects.ts`
- `src/fleet/registry.ts`
- `src/projects/projections.ts`
- `migrations/0060_project_link_latest_event_index.sql`
- `scripts/ci-local-evidence.sh`

Tests:

- `tests/projects-local-smoke.test.ts`
- `tests/dashboard-projects.test.ts`
- `tests/fleet-agent-liveness.test.ts`
- `tests/project-projections.test.ts`
- `tests/projects-migration.test.ts`
- `tests/local-evidence-driver.test.ts`

## Verification

Coordinated focused verification from clean implementation commit `e8491a5`:

```text
npx vitest run tests/projects-local-smoke.test.ts tests/projects-routes.test.ts tests/mcp-project-tools.test.ts tests/dashboard-projects.test.ts tests/fleet-agent-liveness.test.ts tests/bus-consumer.test.ts tests/fleet-registry.test.ts tests/projects-migration.test.ts tests/project-projections.test.ts tests/project-situation.test.ts tests/local-evidence-driver.test.ts tests/runtime-adapter-contract.test.ts
```

Result: **12 test files passed; 208 tests passed**.

Additional focused results during TDD:

- I1: 4 files, 93 tests passed.
- I2: 4 files, 107 tests passed.
- I3 migration/projection set: 4 files, 50 tests passed.
- I4 driver plus existing contracts: 3 files, 24 tests passed.

Required clean-HEAD verification:

| Command | Result |
| --- | --- |
| `npm test` | PASS: 230 files, 3,807 tests |
| `npm run typecheck` | PASS: `tsc --noEmit` |
| `node scripts/no-secrets.mjs` | PASS: `no secrets found` |
| `bash scripts/ci-local-evidence.sh` | PASS: fresh D1 through 0060, browser and runtime evidence complete |

Final local evidence details:

- Browser: 31 routes passed without recorded page errors.
- Browser workflows: 7 of 7 passed.
- Browser/REST/MCP Project situation parity: equal.
- Runtime adapter: `ok: true`; 11 of 11 steps passed.
- Artifact directories contain only the current successful run and their ownership markers; no `failure-*` receipts remain.
- Temporary `tmp/local-evidence/state.*` D1 directory was removed by cleanup.

`git diff --check` passed, generated `tmp` artifacts were not staged, and `0059_project_projection_keysets.sql` has no diff.

## Concerns

None within the requested I1-I4 scope.
