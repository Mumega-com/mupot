// tests/fleet-presence-ttl-parity.test.ts — mupot#1494 round 2 adversarial gate (P1-b).
//
// Round 1 fixed per-row TTL resolution ONLY in getFleetAgentLiveness (the dispatch-routing
// reader). Every OTHER fleet_agents presence reader kept computing a single batch-level
// presenceTtlSec(env) window, so a poll-mode agent with a real per-row TTL could read `live`
// for dispatch but `stale`/`offline` on the dashboard fleet view, in a routine's
// `selectAgent`, on its own agent-view row, and in the observatory's runtime-state map — six
// readers of ONE fact, disagreeing. This test seeds exactly that shape against REAL SQLite +
// the full migration chain and asserts all six agree.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getFleetAgentLiveness,
  getFleetAgentRuntimeStates,
  listFleetAgentRuntimeView,
  getAgentView,
} from '../src/fleet/registry'
import { loadAgentRuntimeStates } from '../src/dashboard/observatory'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const AGENT_ID = 'agent-uuid-orca'
const SQUAD_ID = 'squad-1'
const DEPT_ID = 'dept-1'
const MEMBER_ID = 'member-1'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

let harness: SqliteD1Harness
let env: Env

describe('per-row TTL parity across all fleet_agents presence readers (mupot#1494 round 2, P1-b)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'orca-squad', 'Orca Squad');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
        VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'orca-runner', 'Orca Runner', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
      INSERT INTO members (id, display_name, email, status, tenant)
        VALUES ('${MEMBER_ID}', 'Orca Operator', 'orca@example.com', 'active', '${TENANT}');
      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at)
        VALUES ('${TENANT}', '${AGENT_ID}', 'test-pubkey', '${MEMBER_ID}', ${Math.floor(Date.now() / 1000)});
      -- poll-mode row: TTL 7200s (2h), last seen 1h ago — LIVE by its own TTL, but would read
      -- STALE against the 180s global default every batch-level reader used to apply.
      INSERT INTO fleet_agents (
        agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type,
        member_id, host, presence_mode, presence_ttl_sec, last_reported_at, updated_at
      ) VALUES (
        '${AGENT_ID}', '${TENANT}', 'Orca Runner', '', '["orca-squad"]', 'on_demand', 'running',
        '${AGENT_ID}', 'generic', '${MEMBER_ID}', '', 'poll', 7200,
        '${sqliteStamp(Date.now() - 3_600_000)}', '${sqliteStamp(Date.now() - 3_600_000)}'
      );
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  })

  afterEach(() => harness.close())

  it('dispatch (getFleetAgentLiveness) reads live', async () => {
    const result = await getFleetAgentLiveness(env, AGENT_ID)
    expect(result.live).toBe(true)
  })

  it('the dashboard fleet view (listFleetAgentRuntimeView) reads live', async () => {
    const rows = await listFleetAgentRuntimeView(env)
    const row = rows.find((r) => r.agent_id === AGENT_ID)
    expect(row).toBeDefined()
    expect(row!.presence).toBe('live')
  })

  it("a routine's selectAgent read (getFleetAgentRuntimeStates) reads live", async () => {
    const states = await getFleetAgentRuntimeStates(env, [{ agent_id: AGENT_ID, slug: 'orca-runner' }])
    expect(states.get(AGENT_ID)?.presence).toBe('live')
  })

  it('the agent view (getAgentView) reads live', async () => {
    const rows = await getAgentView(env)
    const row = rows.find((r) => r.agent_id === AGENT_ID)
    expect(row).toBeDefined()
    expect(row!.presence).toBe('live')
  })

  it("the observatory's loadAgentRuntimeStates reads live", async () => {
    const states = await loadAgentRuntimeStates(env)
    expect(states.get(AGENT_ID)).toBe('live')
  })

  // The negative control: past its OWN TTL (not the global one), every reader must agree it
  // is NOT live — proving this isn't just "always live" drift.
  it('past its OWN per-row TTL, every reader agrees it is NOT live', async () => {
    harness.sqlite.prepare(
      `UPDATE fleet_agents SET presence_ttl_sec = 120 WHERE tenant = ? AND agent_id = ?`,
    ).run(TENANT, AGENT_ID) // last_reported_at is 1h ago; TTL 120s -> stale

    const liveness = await getFleetAgentLiveness(env, AGENT_ID)
    expect(liveness.live).toBe(false)

    const dashboardRows = await listFleetAgentRuntimeView(env)
    expect(dashboardRows.find((r) => r.agent_id === AGENT_ID)!.presence).not.toBe('live')

    const routineStates = await getFleetAgentRuntimeStates(env, [{ agent_id: AGENT_ID, slug: 'orca-runner' }])
    expect(routineStates.get(AGENT_ID)?.presence).not.toBe('live')

    const agentViewRows = await getAgentView(env)
    expect(agentViewRows.find((r) => r.agent_id === AGENT_ID)!.presence).not.toBe('live')

    const observatoryStates = await loadAgentRuntimeStates(env)
    expect(observatoryStates.get(AGENT_ID)).not.toBe('live')
  })

  // A resident row (no presence_mode) must keep reading the global window exactly as before —
  // this fix must not change behavior for anyone but a poll-mode row.
  it('a resident row (presence_mode unset) is unaffected — still governed by the global TTL', async () => {
    const residentId = 'agent-uuid-resident'
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
        VALUES ('${residentId}', '${SQUAD_ID}', 'resident-agent', 'Resident', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
      INSERT INTO fleet_agents (
        agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type,
        member_id, host, last_reported_at, updated_at
      ) VALUES (
        '${residentId}', '${TENANT}', 'Resident', 'claude-code', '[]', 'on_demand', 'running',
        '${residentId}', 'generic', NULL, '', '${sqliteStamp(Date.now() - 3_600_000)}', '${sqliteStamp(Date.now() - 3_600_000)}'
      );
    `)
    // Same 1h-old heartbeat as the poll agent, but no per-row TTL override -> stale under the
    // 180s global default, exactly as pre-#1494.
    const result = await getFleetAgentLiveness(env, residentId)
    expect(result.live).toBe(false)
    expect(result.presenceMode).toBe('')
  })
})
