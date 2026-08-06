// tests/fleet-liveness-either-surface.test.ts — mupot#732.
//
// THE DEFECT: routines could never execute, and nothing said so.
//
// Dispatch selects an agent only when `getFleetAgentRuntimeStates` reports
// `runtime && presence === 'live'` (src/routines/dispatch.ts:246). That read consulted
// `fleet_agents` ONLY — a table written exclusively by POST /api/fleet/attach.
//
// But mupot has a SECOND writer for the same fact: `presence_register` /
// `presence_heartbeat` write `module_registry`. An agent that faithfully heartbeats that
// surface was invisible to dispatch.
//
// Measured on production 2026-08-06: every `fleet_agents` row had been stale since 07-30, so
// every routine run parked in `queued` / `agent_offline` forever, with no alert and no
// diagnostic. Registering presence returned `200 online` and changed nothing — which is
// precisely what made it expensive to find.
//
// These tests execute REAL SQL against the committed migration chain, because the defect is
// in a query. A mock would have answered whatever the author believed, and the belief is the
// thing under test.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { getFleetAgentRuntimeStates } from '../src/fleet/registry'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const AGENT = 'agent-uuid-1'
const NOW = Date.parse('2026-08-06T03:00:00Z')

/** Presence TTL is 180s, so this is comfortably inside it and this is comfortably outside. */
const FRESH = new Date(NOW - 30_000).toISOString().replace('T', ' ').slice(0, 19)
const STALE = new Date(NOW - 7 * 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})

afterEach(() => harness.close())

function fleetRow(lastReportedAt: string, status = 'running', runtime = 'claude-code') {
  harness.sqlite.exec(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status,
                               reported_by, agent_type, member_id, host, last_reported_at, updated_at)
     VALUES ('${AGENT}', '${TENANT}', '', '${runtime}', '[]', 'on_demand', '${status}',
             'reporter', 'builder', 'member', 'host', '${lastReportedAt}', '${lastReportedAt}')`,
  )
}

function moduleRow(lastHeartbeat: string, status = 'online', adapter = 'claude-code') {
  harness.sqlite.exec(
    `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status,
                                  capabilities, last_heartbeat, registered_at)
     VALUES ('mod-1', '${TENANT}', 'agent_system', '${adapter}', NULL, '${AGENT}', '${status}',
             '["build"]', '${lastHeartbeat}', '${lastHeartbeat}')`,
  )
}

const liveness = () => getFleetAgentRuntimeStates(env, [{ agent_id: AGENT, slug: 'kasra' }], NOW)

describe('an agent is live if EITHER presence surface is fresh (mupot#732)', () => {
  it('THE PRODUCTION CASE: fleet_agents stale, module_registry fresh -> live', async () => {
    // Exactly the state found on production: nothing had written fleet_agents for a week,
    // while presence_register was being called successfully. Before the fix this resolved to
    // `stale`/`offline`, selectAgent returned `offline`, and every routine parked forever.
    fleetRow(STALE)
    moduleRow(FRESH)

    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    // Dispatch requires BOTH a live presence and a non-empty runtime — a fix that produced
    // `live` with an empty runtime would be inert, and would look correct here.
    expect(state?.runtime).not.toBe('')
  })

  it('module-registry-only agent (no fleet_agents row at all) is live and carries a runtime', async () => {
    moduleRow(FRESH)
    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    expect(state?.runtime).toBe('claude-code') // taken from the module adapter
  })

  it('fleet_agents fresh, module_registry absent -> live (the original path is untouched)', async () => {
    fleetRow(FRESH)
    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    expect(state?.runtime).toBe('claude-code')
  })
})

describe('liveness is NOT weakened — stale still means stale', () => {
  it('BOTH surfaces stale -> not live', async () => {
    // The invariant the change rests on. If this ever passes as `live`, "either surface" has
    // become "no surface", and dispatch would hand work to an agent that is not there.
    fleetRow(STALE)
    moduleRow(STALE)
    expect((await liveness()).get(AGENT)?.presence).not.toBe('live')
  })

  it('an agent absent from BOTH surfaces is absent from the result', async () => {
    expect((await liveness()).has(AGENT)).toBe(false)
  })

  it('a STALE module row does not mask a FRESH one for the same identity', async () => {
    // Production carries several module rows per agent (project-scoped and unscoped). Reading
    // an arbitrary one would make liveness depend on row order.
    moduleRow(FRESH)
    // A real project row is required — module_registry.project_id carries a live FK, and the
    // first draft of this test invented 'proj-1' and was rejected by the schema. Worth
    // stating: that rejection is the harness doing its job. A mocked DB would have accepted
    // the invented id and the test would have "passed" against a database production has not
    // got, which is #684's defect wearing a test's clothes.
    harness.sqlite.exec(
      `INSERT INTO projects (id, slug, name) VALUES ('proj-1', 'proj-1', 'Proj One');
       INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status,
                                    capabilities, last_heartbeat, registered_at)
       VALUES ('mod-2', '${TENANT}', 'agent_system', 'claude-code', 'proj-1', '${AGENT}',
               'offline', '["build"]', '${STALE}', '${STALE}')`,
    )
    expect((await liveness()).get(AGENT)?.presence).toBe('live')
  })

  it('a fresh module row for ANOTHER TENANT does not make this agent live', async () => {
    // The tenant fence is the thing that must not be traded away for availability.
    fleetRow(STALE)
    harness.sqlite.exec(
      `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status,
                                    capabilities, last_heartbeat, registered_at)
       VALUES ('mod-x', 'other-tenant', 'agent_system', 'claude-code', NULL, '${AGENT}',
               'online', '["build"]', '${FRESH}', '${FRESH}')`,
    )
    expect((await liveness()).get(AGENT)?.presence).not.toBe('live')
  })
})
