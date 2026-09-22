// tests/poll-mode-round3.test.ts — mupot#1494 round 3 (successor to PR #1501, adversarial
// round 2 pinned head f1c8c54f). Real sqlite D1 + the full migration chain
// (tests/helpers/migrations.ts applyAllMigrations) — no hand-rolled fleet_agents mocks (see
// mcp-check-in-poll-presence.test.ts's own header note on why: a mock that returns whatever
// the test author already believes cannot catch a real ON CONFLICT/JOIN branch being wrong).
//
// Covers:
//   P1-iii — an operator-stopped poll row must not route to inbox, even if presence_mode
//            literally still reads 'poll' on the row.
//   P2-a   — fleet_agents.squads has two writers (daemon report, poll check-in); they must
//            UNION, never overwrite each other.
//   P2-b   — listFleetAgentRuntimeView's home-squad exclusion applies ONLY to a squad-scoped
//            read, never to the unrestricted (org-admin) one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  reportFleetAgents,
  upsertPollFleetPresence,
  getFleetAgentLiveness,
  listFleetAgentRuntimeView,
} from '../src/fleet/registry'
import { resolveDispatchDeliveryMode } from '../src/bus/consumer'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import type { Env } from '../src/types'

const TENANT = 'poll-round3'
const DEPT_ID = 'dept-round3'
const SQUAD_ID = 'squad-round3'
const SQUAD_SLUG = 'round3-squad'
const AGENT_ID = 'agent-round3-uuid'
const MEMBER_ID = 'member-round3'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

let harness: SqliteD1Harness
let env: Env

function fleetRow(): Record<string, unknown> | undefined {
  return harness.sqlite.prepare('SELECT * FROM fleet_agents WHERE tenant = ? AND agent_id = ?')
    .get(TENANT, AGENT_ID) as Record<string, unknown> | undefined
}

describe('mupot#1494 round 3 (P1-iii) — operator-stopped poll row must not route to inbox', () => {
  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const tokenHash = await sha256Hex('tok-round3')
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'round3-dept', 'Round3 Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', '${SQUAD_SLUG}', 'Round3 Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'round3-runner', 'Round3 Runner', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Round3 Member', 'active', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
        VALUES ('token-round3', '${MEMBER_ID}', '${tokenHash}', 'round3', 'workspace', datetime('now'), '${AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => harness.close())

  it('a stopped row does not route as poll even though presence_mode still literally reads \'poll\' on the row', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    expect(fleetRow()!.presence_mode).toBe('poll')

    // Simulate an operator stop WITHOUT going through markStopped, isolating the READ-side
    // gate (isActivePollPresenceMode) from the WRITE-side fix — this is exactly the round-2
    // bug's shape: presence_mode column literally still says 'poll'.
    harness.sqlite.prepare(`UPDATE fleet_agents SET status = 'stopped' WHERE tenant = ? AND agent_id = ?`)
      .run(TENANT, AGENT_ID)
    expect(fleetRow()!.presence_mode).toBe('poll') // column unchanged — the bug's exact shape

    const route = await getFleetAgentLiveness(env, AGENT_ID)
    expect(route.presenceMode).toBe('') // NOT 'poll' — status='stopped' wins
    expect(route.live).toBe(false)

    expect(resolveDispatchDeliveryMode(route, false)).toBe('in_worker')
    expect(resolveDispatchDeliveryMode(route, true)).toBe('in_worker') // force also refused: no registered surface
  })

  it('markStopped (the real /api/fleet/detach route) clears presence_mode/presence_ttl_sec on the row', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    expect(fleetRow()!.presence_mode).toBe('poll')
    expect(fleetRow()!.presence_ttl_sec).toBe(600)

    const res = await fleetAttachApp.request('/detach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-round3', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: AGENT_ID }),
    }, env)
    expect(res.status).toBe(200)

    const row = fleetRow()!
    expect(row.status).toBe('stopped')
    expect(row.presence_mode).toBe('')
    expect(row.presence_ttl_sec).toBeNull()
  })

  it('after a real detach, the agent\'s OWN next poll check-in cannot resurrect routing eligibility — defense in depth even though upsertPollFleetPresence writes presence_mode=\'poll\' unconditionally on a stopped row', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    await fleetAttachApp.request('/detach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-round3', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: AGENT_ID }),
    }, env)
    expect(fleetRow()!.status).toBe('stopped')
    expect(fleetRow()!.presence_mode).toBe('')

    // The agent, unaware it was detached, keeps polling. upsertPollFleetPresence's ON
    // CONFLICT writes presence_mode='poll' UNCONDITIONALLY (only status/last_reported_at are
    // guarded by the stopped-check) — so the column DOES flip back to 'poll' here.
    const result = await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    expect(result.stoppedByOperator).toBe(true)
    expect(fleetRow()!.status).toBe('stopped')
    expect(fleetRow()!.presence_mode).toBe('poll') // the column really does say this

    // But routing must still refuse it — isActivePollPresenceMode reads BOTH columns.
    const route = await getFleetAgentLiveness(env, AGENT_ID)
    expect(route.presenceMode).toBe('')
    expect(resolveDispatchDeliveryMode(route, false)).toBe('in_worker')
  })
})

describe('mupot#1494 round 3 (P2-a) — fleet_agents.squads UNION, never overwrite', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'round3-dept', 'Round3 Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'home', 'Home Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'round3-runner', 'Round3 Runner', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Round3 Member', 'active', '${TENANT}');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => harness.close())

  it('daemon reports ["a","b"], then a poll check-in unions its own home squad rather than overwriting → ["a","b","home"]', async () => {
    const reportRes = await reportFleetAgents(env, AGENT_ID, [
      { agent_id: AGENT_ID, status: 'running', squads: ['a', 'b'] },
    ])
    expect(reportRes.ok).toBe(true)
    expect(JSON.parse(fleetRow()!.squads as string)).toEqual(['a', 'b'])

    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })

    expect(JSON.parse(fleetRow()!.squads as string)).toEqual(['a', 'b', 'home'])
  })

  it('poll check-in registers home FIRST, then a daemon self-report with two other squads unions rather than overwriting → ["a","b","home"]', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round3 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    expect(JSON.parse(fleetRow()!.squads as string)).toEqual(['home'])

    const reportRes = await reportFleetAgents(env, AGENT_ID, [
      { agent_id: AGENT_ID, status: 'running', squads: ['a', 'b'] },
    ])
    expect(reportRes.ok).toBe(true)

    expect(JSON.parse(fleetRow()!.squads as string)).toEqual(['a', 'b', 'home'])
  })
})

describe('mupot#1494 round 3 (P2-b) — home-squad exclusion applies ONLY to a squad-scoped read', () => {
  const HOME_SQUAD_ID = 'squad-round3-home'
  const OTHER_SQUAD_ID = 'squad-round3-other'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'round3-dept', 'Round3 Dept');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES
        ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'round3-home', 'Round3 Home', 'home'),
        ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'round3-other', 'Round3 Other', 'work');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'round3-runner', 'Round3 Runner', 'active');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
    // The agent's ONLY squad membership is its own home squad.
    harness.sqlite.prepare(
      `UPDATE fleet_agents SET squads = ? WHERE tenant = ? AND agent_id = ?`,
    ) // no-op if row absent; the INSERT below creates it
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Round3 Runner', 'claude-code', '["round3-home"]', 'on_demand', 'running', '${AGENT_ID}', 'generic', datetime('now'), datetime('now'));
    `)
  })
  afterEach(() => harness.close())

  it('the unrestricted (org-admin) read still surfaces a home-squad-only agent', async () => {
    const rows = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    expect(rows.map((r) => r.agent_id)).toContain(AGENT_ID)
  })

  it('a squad-SCOPED read hides that same agent — its only membership there is a home squad', async () => {
    const rows = await listFleetAgentRuntimeView(env, Date.now(), [HOME_SQUAD_ID])
    expect(rows.map((r) => r.agent_id)).not.toContain(AGENT_ID)
  })

})
