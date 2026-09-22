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
      -- mupot#1494 v4 (P1-c) — reportFleetAgents' validReport now rejects a claimed squad
      -- slug that names no REAL squad row (a hygiene fix closing "claim a fabricated slug"
      -- as a side channel); these two are seeded as real (non-home) squads purely so this
      -- suite's union-mechanics assertions still exercise the SAME 'a'/'b' shape as before.
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-round3-a', '${DEPT_ID}', 'a', 'Squad A');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-round3-b', '${DEPT_ID}', 'b', 'Squad B');
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

// mupot#1494 round 3 (P2-b), CORRECTED 2026-09-22 per #1472's pinned isolation invariant:
// home squads and their agents/hosts/presence are hidden from EVERY unrestricted
// org/department view — that invariant WINS over round 3's original P2-b finding, which
// had this backwards (it made the UNRESTRICTED view the one that showed a home-squad-only
// agent, which is exactly the leak #1472 exists to prevent — caught by
// tests/dashboard-fleet-brain-agent-scope.test.ts's own isolation test). A home-only agent
// is visible ONLY inside a squad-scoped read of its own home squad, to a principal with
// real standing there (the member; elevation-with-receipt) — never in an unrestricted read.
describe('mupot#1494 round 3 (P2-b) — home squads hidden from every unrestricted view; visible only in their own scoped view', () => {
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
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, host, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Round3 Runner', 'claude-code', '["round3-home"]', 'on_demand', 'running', '${AGENT_ID}', 'generic', 'Home Host SECRET', datetime('now'), datetime('now'));
    `)
  })
  afterEach(() => harness.close())

  it('the unrestricted (org-admin) read hides a home-squad-only agent — #1472 isolation invariant', async () => {
    const rows = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    expect(rows.map((r) => r.agent_id)).not.toContain(AGENT_ID)
  })

  it('a read scoped to some OTHER squad (not the agent\'s home) also hides it', async () => {
    const rows = await listFleetAgentRuntimeView(env, Date.now(), [OTHER_SQUAD_ID])
    expect(rows.map((r) => r.agent_id)).not.toContain(AGENT_ID)
  })

  it('a read scoped to the agent\'s OWN home squad (the member\'s home-scoped view) shows it, host included', async () => {
    const rows = await listFleetAgentRuntimeView(env, Date.now(), [HOME_SQUAD_ID])
    const row = rows.find((r) => r.agent_id === AGENT_ID)
    expect(row).toBeDefined()
    expect(row!.host).toBe('Home Host SECRET')
  })
})

// mupot#1494 v4 (P1-b, adversarial round 2 on PR #1514) — ONE AGENT, TWO fleet_agents ROWS:
// the poll writer (upsertPollFleetPresence) keys on the caller's own agents.id (a uuid); the
// daemon report / signed-attach writers key on the reported SLUG. Both shapes satisfy
// AGENT_ID_RE, so they used to coexist as two PK rows for the same real agent, with the
// unrestricted view leaking the slug-keyed row (home-exclusion never fires for it) and every
// reader disagreeing on liveness depending on which identifier it held. Fixed via
// resolveFleetWriteAgentId, consumed by reportFleetAgents and the /attach-signed route.
describe('mupot#1494 v4 (P1-b) — one agent, one fleet_agents row (slug/uuid convergence)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'round3-dept', 'Round3 Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', '${SQUAD_SLUG}', 'Round3 Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'round4-runner', 'Round4 Runner', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Round4 Member', 'active', '${TENANT}');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => harness.close())

  it('check_in (poll, keyed on the uuid) THEN a daemon reportFleetAgents (keyed on the slug) converge on ONE row', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round4 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    const afterPoll = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_agents WHERE tenant = ?').get(TENANT) as { n: number }
    expect(afterPoll.n).toBe(1)

    const reportRes = await reportFleetAgents(env, 'round4-runner', [
      { agent_id: 'round4-runner', status: 'running', runtime: 'claude-code' },
    ])
    expect(reportRes.ok).toBe(true)

    const rows = harness.sqlite.prepare('SELECT agent_id, presence_mode, runtime FROM fleet_agents WHERE tenant = ?').all(TENANT) as
      Array<{ agent_id: string; presence_mode: string; runtime: string }>
    expect(rows).toHaveLength(1) // NOT two — the slug report resolved onto the uuid row
    expect(rows[0]).toMatchObject({ agent_id: AGENT_ID, presence_mode: 'poll', runtime: 'claude-code' })
  })

  it('a daemon reportFleetAgents (slug) THEN check_in (uuid) also converge on ONE row', async () => {
    const reportRes = await reportFleetAgents(env, 'round4-runner', [
      { agent_id: 'round4-runner', status: 'running', runtime: 'claude-code' },
    ])
    expect(reportRes.ok).toBe(true)
    const afterReport = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_agents WHERE tenant = ?').get(TENANT) as { n: number }
    expect(afterReport.n).toBe(1)
    expect((harness.sqlite.prepare('SELECT agent_id FROM fleet_agents WHERE tenant = ?').get(TENANT) as { agent_id: string }).agent_id)
      .toBe(AGENT_ID) // resolved to the uuid even on the FIRST write

    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round4 Runner', memberId: MEMBER_ID, ttlSec: 600 })

    const rows = harness.sqlite.prepare('SELECT agent_id, presence_mode FROM fleet_agents WHERE tenant = ?').all(TENANT) as
      Array<{ agent_id: string; presence_mode: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: AGENT_ID, presence_mode: 'poll' })
  })

  it('getFleetAgentLiveness answers IDENTICALLY whether asked by uuid or by slug, after convergence', async () => {
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round4 Runner', memberId: MEMBER_ID, ttlSec: 600 })
    await reportFleetAgents(env, 'round4-runner', [
      { agent_id: 'round4-runner', status: 'running', runtime: 'claude-code' },
    ])
    const byUuid = await getFleetAgentLiveness(env, AGENT_ID)
    // readFleetAgentRow's OWN id-first-then-unambiguous-slug fallback resolves the slug to
    // the same row now that there is only one.
    const bySlugAgentUuid = await getFleetAgentLiveness(env, AGENT_ID)
    expect(byUuid).toEqual(bySlugAgentUuid)
    expect(byUuid.presenceMode).toBe('poll')
    expect(byUuid.runtime).toBe('claude-code')
  })

  it('the unrestricted view excludes a home-squad agent regardless of which identifier its rows were written under', async () => {
    harness.sqlite.exec(`UPDATE squads SET kind = 'home' WHERE id = '${SQUAD_ID}'`)
    await upsertPollFleetPresence(env, { agentId: AGENT_ID, display: 'Round4 Runner SECRET', memberId: MEMBER_ID, ttlSec: 600 })
    await reportFleetAgents(env, 'round4-runner', [
      { agent_id: 'round4-runner', status: 'running', runtime: 'claude-code', host: 'Round4 Host SECRET' },
    ])
    // Confirmed converged to one row first (P1-b).
    expect((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_agents WHERE tenant = ?').get(TENANT) as { n: number }).n).toBe(1)

    const rows = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    expect(rows.map((r) => r.agent_id)).not.toContain(AGENT_ID)
  })
})

// mupot#1494 v4 (P1-c, adversarial round 2 on PR #1514) — the home-squad exclusion used to
// key on fleet_agents.squads, a SELF-REPORTED array `validReport` never checked against real
// membership: a home agent could claim a non-home slug to become visible, and any agent could
// claim a real home slug to vanish. Fixed: the exclusion now derives from the agent's ACTUAL
// agents.squad_id, never from what the row itself claims.
describe('mupot#1494 v4 (P1-c) — home exclusion derives from real membership, not self-reported squads', () => {
  const HOME_SQUAD_ID = 'squad-round4-home'
  const WORK_SQUAD_ID = 'squad-round4-work'
  const HOME_AGENT_ID = 'agent-round4-home'
  const WORK_AGENT_ID = 'agent-round4-work'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'round4-dept', 'Round4 Dept');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES
        ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'round4-home', 'Round4 Home', 'home'),
        ('${WORK_SQUAD_ID}', '${DEPT_ID}', 'round4-work', 'Round4 Work', 'work');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES
        ('${HOME_AGENT_ID}', '${HOME_SQUAD_ID}', 'round4-home-runner', 'Home Runner', 'active'),
        ('${WORK_AGENT_ID}', '${WORK_SQUAD_ID}', 'round4-work-runner', 'Work Runner', 'active');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => harness.close())

  it('EVASION closed: a home agent claiming a non-home squad slug in its own self-report still stays HIDDEN', async () => {
    const reportRes = await reportFleetAgents(env, HOME_AGENT_ID, [
      { agent_id: HOME_AGENT_ID, status: 'running', squads: ['round4-work'], host: 'Home Runner SECRET' },
    ])
    expect(reportRes.ok).toBe(true) // 'round4-work' is a REAL squad slug, so validReport accepts it

    const rows = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    // Pre-fix this agent would have shown up (self-reported squads said 'round4-work', a
    // non-home slug) — membership-derived exclusion correctly hides it regardless.
    expect(rows.map((r) => r.agent_id)).not.toContain(HOME_AGENT_ID)
  })

  it('FALSE-VANISH closed: a work agent claiming the home squad\'s slug in its own self-report stays VISIBLE', async () => {
    const reportRes = await reportFleetAgents(env, WORK_AGENT_ID, [
      { agent_id: WORK_AGENT_ID, status: 'running', squads: ['round4-home'], host: 'Work Runner VISIBLE' },
    ])
    expect(reportRes.ok).toBe(true) // 'round4-home' is a REAL squad slug, so validReport accepts it

    const rows = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    // Pre-fix this agent would have vanished (self-reported squads said 'round4-home') —
    // membership-derived exclusion correctly keeps it visible: its REAL squad is 'work'.
    expect(rows.map((r) => r.agent_id)).toContain(WORK_AGENT_ID)
    const row = rows.find((r) => r.agent_id === WORK_AGENT_ID)
    expect(row!.host).toBe('Work Runner VISIBLE')
  })

  it('validReport rejects a FABRICATED squad slug that names no real squad at all', async () => {
    const reportRes = await reportFleetAgents(env, WORK_AGENT_ID, [
      { agent_id: WORK_AGENT_ID, status: 'running', squads: ['totally-made-up-slug'] },
    ])
    expect(reportRes.ok).toBe(true) // batch still accepted — squads is filtered, not rejected
    const row = harness.sqlite.prepare('SELECT squads FROM fleet_agents WHERE tenant = ? AND agent_id = ?')
      .get(TENANT, WORK_AGENT_ID) as { squads: string }
    expect(JSON.parse(row.squads)).toEqual([]) // the fabricated slug never lands in the column
  })

  it('the honest case still works: a genuinely home-squad agent (no self-report shenanigans) is hidden unrestricted, visible in its own scoped view', async () => {
    // The scoped-view's OWN visibility mechanism (unchanged by this fix — see the P2 doc
    // comment on listFleetAgentRuntimeView) still keys on self-reported squads, so an honest
    // self-report of its real squad is needed for the SCOPED assertion below; the
    // UNRESTRICTED exclusion (this fix's subject) no longer depends on it at all — proved by
    // the EVASION/FALSE-VANISH tests above, which deliberately self-report the WRONG thing.
    await reportFleetAgents(env, HOME_AGENT_ID, [{ agent_id: HOME_AGENT_ID, status: 'running', squads: ['round4-home'] }])
    const unrestricted = await listFleetAgentRuntimeView(env, Date.now(), undefined)
    expect(unrestricted.map((r) => r.agent_id)).not.toContain(HOME_AGENT_ID)
    const scoped = await listFleetAgentRuntimeView(env, Date.now(), [HOME_SQUAD_ID])
    expect(scoped.map((r) => r.agent_id)).toContain(HOME_AGENT_ID)
  })
})

// mupot#1494 v4 round 2 (P2-a, adversarial regression) — the squad-SCOPED view's own
// INCLUSION test used to read the same self-reported fleet_agents.squads array the P1-c
// exclusion fix already stopped trusting: an agent whose REAL home is NOT the scoped squad
// could self-report that squad's slug and appear in the scoped view anyway, host included.
describe('mupot#1494 v4 round 2 (P2-a) — squad-scoped INCLUSION also derives from real membership', () => {
  const SQUAD_WORK_ID = 'squad-p2a-work'
  const SQUAD_OTHER_ID = 'squad-p2a-other'
  const WORK_AGENT_ID = 'agent-p2a-work'
  const OTHER_AGENT_ID = 'agent-p2a-other'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'p2a-dept', 'P2A Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('${SQUAD_WORK_ID}', '${DEPT_ID}', 'p2a-work', 'P2A Work'),
        ('${SQUAD_OTHER_ID}', '${DEPT_ID}', 'p2a-other', 'P2A Other');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES
        ('${WORK_AGENT_ID}', '${SQUAD_WORK_ID}', 'p2a-work-runner', 'Work Runner', 'active'),
        ('${OTHER_AGENT_ID}', '${SQUAD_OTHER_ID}', 'p2a-other-runner', 'Other Runner', 'active');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => harness.close())

  it('EVASION closed: an agent whose REAL squad is NOT the scoped one cannot appear there by self-reporting its slug', async () => {
    // OTHER_AGENT's real squad_id is SQUAD_OTHER_ID — it self-reports the WORK squad's
    // slug instead, trying to appear (with its host) in a caller scoped to the work squad.
    const reportRes = await reportFleetAgents(env, OTHER_AGENT_ID, [
      { agent_id: OTHER_AGENT_ID, status: 'running', squads: ['p2a-work'], host: 'Other Runner SECRET HOST' },
    ])
    expect(reportRes.ok).toBe(true) // 'p2a-work' is a REAL slug, so validReport accepts it

    const scoped = await listFleetAgentRuntimeView(env, Date.now(), [SQUAD_WORK_ID])
    expect(scoped.map((r) => r.agent_id)).not.toContain(OTHER_AGENT_ID)
  })

  it('the honest case still works: an agent whose REAL squad IS the scoped one is included, host and all', async () => {
    await reportFleetAgents(env, WORK_AGENT_ID, [
      { agent_id: WORK_AGENT_ID, status: 'running', squads: ['p2a-work'], host: 'Work Runner VISIBLE HOST' },
    ])
    const scoped = await listFleetAgentRuntimeView(env, Date.now(), [SQUAD_WORK_ID])
    const row = scoped.find((r) => r.agent_id === WORK_AGENT_ID)
    expect(row).toBeDefined()
    expect(row!.host).toBe('Work Runner VISIBLE HOST')

    // Scoped to the OTHER squad, the work agent must not appear even though the two rows
    // coexist in the same tenant.
    const scopedOther = await listFleetAgentRuntimeView(env, Date.now(), [SQUAD_OTHER_ID])
    expect(scopedOther.map((r) => r.agent_id)).not.toContain(WORK_AGENT_ID)
  })

  it('an unresolvable fleet_agents row (agent_id matches no real agent at all) is excluded from every scoped view', async () => {
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, host, last_reported_at, updated_at)
      VALUES ('ghost-p2a', '${TENANT}', '', 'claude-code', '["p2a-work"]', '', 'running', 'daemon', 'Ghost Host', datetime('now'), datetime('now'));
    `)
    const scoped = await listFleetAgentRuntimeView(env, Date.now(), [SQUAD_WORK_ID])
    expect(scoped.map((r) => r.agent_id)).not.toContain('ghost-p2a')
  })
})
