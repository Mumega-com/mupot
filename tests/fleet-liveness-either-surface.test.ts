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

// Presence TTL is 180s: FRESH is comfortably inside it, STALE comfortably outside.
//
// THE TWO TABLES STORE DIFFERENT FORMATS, and these fixtures must match production exactly:
//   fleet_agents.last_reported_at   'YYYY-MM-DD HH:MM:SS'      (SQLite datetime('now'))
//   module_registry.last_heartbeat  '2026-08-06T03:51:26.358Z' (ISO-8601, toISOString)
//
// The first version of this file wrote BOTH in SQLite format. Every test passed, the fix
// merged and deployed — and production still reported agent_offline, because derivePresence
// could not parse the ISO shape and returned 'stale' for every module row. Real SQL against
// the real schema was not enough: the fixture invented the DATA, so the suite proved the code
// matched my belief rather than production. Verified against live rows before rewriting.
const sqliteStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const isoStamp = (ms: number) => new Date(ms).toISOString()
const FRESH_FLEET = sqliteStamp(NOW - 30_000)
const STALE_FLEET = sqliteStamp(NOW - 7 * 24 * 3600_000)
const FRESH_MODULE = isoStamp(NOW - 30_000)
const STALE_MODULE = isoStamp(NOW - 7 * 24 * 3600_000)

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
    fleetRow(STALE_FLEET)
    moduleRow(FRESH_MODULE)

    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    // Dispatch requires BOTH a live presence and a non-empty runtime — a fix that produced
    // `live` with an empty runtime would be inert, and would look correct here.
    expect(state?.runtime).not.toBe('')
  })

  it('module-registry-only agent (no fleet_agents row at all) is live and carries a runtime', async () => {
    moduleRow(FRESH_MODULE)
    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    expect(state?.runtime).toBe('claude-code') // taken from the module adapter
  })

  it('fleet_agents fresh, module_registry absent -> live (the original path is untouched)', async () => {
    fleetRow(FRESH_FLEET)
    const state = (await liveness()).get(AGENT)
    expect(state?.presence).toBe('live')
    expect(state?.runtime).toBe('claude-code')
  })
})

describe('liveness is NOT weakened — stale still means stale', () => {
  it('BOTH surfaces stale -> not live', async () => {
    // The invariant the change rests on. If this ever passes as `live`, "either surface" has
    // become "no surface", and dispatch would hand work to an agent that is not there.
    fleetRow(STALE_FLEET)
    moduleRow(STALE_MODULE)
    expect((await liveness()).get(AGENT)?.presence).not.toBe('live')
  })

  it('an agent absent from BOTH surfaces is absent from the result', async () => {
    expect((await liveness()).has(AGENT)).toBe(false)
  })

  it('a STALE module row does not mask a FRESH one for the same identity', async () => {
    // Production carries several module rows per agent (project-scoped and unscoped). Reading
    // an arbitrary one would make liveness depend on row order.
    moduleRow(FRESH_MODULE)
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
               'offline', '["build"]', '${STALE_MODULE}', '${STALE_MODULE}')`,
    )
    expect((await liveness()).get(AGENT)?.presence).toBe('live')
  })

  it('a fresh module row for ANOTHER TENANT does not make this agent live', async () => {
    // The tenant fence is the thing that must not be traded away for availability.
    fleetRow(STALE_FLEET)
    harness.sqlite.exec(
      `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status,
                                    capabilities, last_heartbeat, registered_at)
       VALUES ('mod-x', 'other-tenant', 'agent_system', 'claude-code', NULL, '${AGENT}',
               'online', '["build"]', '${FRESH_MODULE}', '${FRESH_MODULE}')`,
    )
    expect((await liveness()).get(AGENT)?.presence).not.toBe('live')
  })
})

describe('last_seen is compared by TIME, not by string (Athena residual on #735)', () => {
  it('a fleet stamp later in the day beats an earlier ISO module stamp', async () => {
    // The two columns use different formats and ' ' (0x20) sorts before 'T' (0x54), so a
    // lexical compare calls the ISO stamp newer even when it is nearly a day older. Both
    // rows are fresh here so liveness is not what is under test — only which stamp is
    // reported as last_seen.
    const base = Date.parse('2026-08-06T03:00:00Z')
    harness.sqlite.exec(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status,
                                 reported_by, agent_type, member_id, host, last_reported_at, updated_at)
       VALUES ('${AGENT}', '${TENANT}', '', 'claude-code', '[]', 'on_demand', 'running',
               'reporter', 'builder', 'member', 'host', '${sqliteStamp(base - 10_000)}', '${sqliteStamp(base - 10_000)}')`,
    )
    moduleRow(isoStamp(base - 120_000))

    const state = await getFleetAgentRuntimeStates(env, [{ agent_id: AGENT, slug: 'kasra' }], base)
    // The fleet stamp is the more recent one; a string compare would have picked the module's.
    expect(state.get(AGENT)?.last_seen).toBe(sqliteStamp(base - 10_000))
  })
})
