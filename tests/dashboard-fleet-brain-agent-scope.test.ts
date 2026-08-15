// tests/dashboard-fleet-brain-agent-scope.test.ts — FLIGHT-001 #797.
//
// asha's gate (FLIGHT-001-R item 2) found two more dashboard reads that survived
// the F2 capability FLOOR (#796) unscoped on the DATA: the floor proves a caller
// belongs somewhere in the org, not that they may see THIS squad's rows.
//
//   1. GET /fleet — loadFleet-shaped roster (listFleetAgentRuntimeView +
//      listPresence, src/dashboard/index.ts) had no squad filter: a one-squad
//      member saw the full live-fleet host-agent roster and every checked-in
//      member's presence, not just their own squad's.
//   2. GET /brain — loadBrainView's loop feed (src/dashboard/brain.ts) carries
//      per-squad/per-agent operational detail (OKR, budget cap, kpi target,
//      decisions) with no squad filter: a one-squad member saw every OTHER
//      squad's loop OKR + decision history too.
//
// ALSO (found auditing #796's own GET /agents roster fix): GET /agents/:id let
// any floor-passing caller open ANY agent's console by id/slug, the same shape
// #796 already closed for GET /squads/:id.
//
// End-to-end, real SQL (createSqliteD1 + applyAllMigrations — the #684 ratchet
// rejects hand-built schema): drives the REAL dashboardApp through the REAL
// requireAuth (session cookie -> KV -> email->member bridge -> resolveCapabilities).
//
// DENY matrix:
//   zero-capability member -> 403 at the F2 floor (asserted once; #796 owns the
//                              floor itself, not re-litigated here)
//   squad-scoped member    -> 200, sees ONLY own-squad fleet/presence/loop/agent rows
//   org-scope capability   -> 200, sees every squad
//
// Mutation-check: the same underlying scoped reads (listFleetAgentRuntimeView,
// listPresence, listLoops) are called directly with the resolved squad-id array
// vs. `null` (unrestricted) — proving the scope argument is what changes the
// result set. If the dashboard route ever stopped threading the resolved
// squadIds through (e.g. passed `null` unconditionally, silently reverting to
// "always unrestricted"), the DENY assertions above would go red — the direct
// calls here pin down exactly which argument value is load-bearing.

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import { listFleetAgentRuntimeView } from '../src/fleet/registry'
import { listPresence } from '../src/fleet/presence'
import { createLoop, listLoops } from '../src/loops/service'
import type { Env } from '../src/types'

const NOW = Date.parse('2026-08-07T12:00:00Z')

const VALID_SPEC = {
  okr: '',
  kpi: { signal: 'positive_replies', target: 5 },
  sources: [{ kind: 'queue', name: 'prospects' }],
  channels: [{ kind: 'mcp', url: 'https://ghl.example/mcp', auth_ref: 'GHL_API_KEY' }],
  gate: { require_approval: true, timeout_sec: 86400, on_timeout: 'pause' },
  budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
  cadence: { heartbeat: true },
  stop: { dry_rounds_max: 3 },
}

async function makeHarness(): Promise<SqliteD1Harness> {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-zero', 'zero@drive-by.test', 'Zero Cap', 'active', 'pot-a'),
      ('member-squad-a', 'squad-a@pot.test', 'Squad A Member', 'active', 'pot-a'),
      ('member-squad-b', 'squad-b@pot.test', 'Squad B Member', 'active', 'pot-a'),
      ('member-org', 'org@pot.test', 'Org Member', 'active', 'pot-a');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-a', 'member-squad-a', 'squad', 'squad-a', 'member'),
      ('cap-squad-b', 'member-squad-b', 'squad', 'squad-b', 'member'),
      ('cap-org', 'member-org', 'org', NULL, 'admin');

    -- fleet_agents.squads is a self-reported JSON array of squad SLUGS.
    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at) VALUES
      ('host-a', 'pot-a', 'Host A', 'tmux', '["squad-a"]', 'always_on', 'running', 'daemon', datetime('now'), datetime('now')),
      ('host-b', 'pot-a', 'Host B', 'tmux', '["squad-b"]', 'always_on', 'running', 'daemon', datetime('now'), datetime('now'));

    INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at) VALUES
      ('pot-a', 'member-squad-a', 'Squad A Member', 'claude-code', 'build', 'agent-a', datetime('now'), datetime('now')),
      ('pot-a', 'member-squad-b', 'Squad B Member', 'claude-code', 'build', 'agent-b', datetime('now'), datetime('now'));
  `)
  const env = { DB: harness.db, TENANT_SLUG: 'pot-a' } as unknown as Env
  await createLoop(env, { ...VALID_SPEC, squad_id: 'squad-a', agent_id: null, okr: 'SQUAD-A-ONLY-OKR-TEXT' })
  await createLoop(env, { ...VALID_SPEC, squad_id: 'squad-b', agent_id: null, okr: 'SQUAD-B-ONLY-OKR-TEXT' })
  return harness
}

function envFor(harness: SqliteD1Harness, sessions: Record<string, string>): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'pot-a',
    BRAND: 'Test Pot',
    SESSIONS: {
      get: async (key: string) => sessions[key] ?? null,
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function sessionRecord(email: string, role: 'owner' | 'admin' | 'member' = 'member'): string {
  return JSON.stringify({ userId: `u-${email}`, email, role, createdAt: '2026-01-01T00:00:00Z' })
}

function req(path: string, sessionId: string): Request {
  return new Request(`https://pot.test${path}`, { headers: { Cookie: `mupot_session=${sessionId}` } })
}

describe('FLIGHT-001 #797 — /fleet, /brain, /agents/:id squad scoping (real SQL)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  // ── GET /radar?tab=fleet (formerly /fleet) ───────────────────────────────────

  it('zero-capability member: 403 on GET /radar?tab=fleet (F2 floor — asserted once, not re-litigated)', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const res = await dashboardApp.fetch(req('/radar?tab=fleet', 's-zero'), env)
    expect(res.status).toBe(403)
  })

  it('squad-a member: 200 on GET /radar?tab=fleet, sees ONLY Host A + their own presence row', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?tab=fleet', 's-squad-a'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Host A')
    expect(body).not.toContain('Host B')
    expect(body).toContain('Squad A Member')
    expect(body).not.toContain('Squad B Member')
  })

  it('squad-b member: 200 on GET /radar?tab=fleet, sees ONLY Host B + their own presence row', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-b': sessionRecord('squad-b@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?tab=fleet', 's-squad-b'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Host B')
    expect(body).not.toContain('Host A')
    expect(body).toContain('Squad B Member')
    expect(body).not.toContain('Squad A Member')
  })

  it('org-scope capability: 200 on GET /radar?tab=fleet, sees BOTH host agents and BOTH presence rows', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?tab=fleet', 's-org'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Host A')
    expect(body).toContain('Host B')
    expect(body).toContain('Squad A Member')
    expect(body).toContain('Squad B Member')
  })

  it('legacy owner (no fine-grained capabilities row at all): 200, sees every squad', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-owner': sessionRecord('owner@pot.test', 'owner') })
    const res = await dashboardApp.fetch(req('/radar?tab=fleet', 's-owner'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Host A')
    expect(body).toContain('Host B')
  })

  // ── GET /radar & GET /radar?format=json ──────────────────────────────────────

  it('zero-capability member: 403 on GET /radar and GET /radar?format=json', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const resHtml = await dashboardApp.fetch(req('/radar', 's-zero'), env)
    expect(resHtml.status).toBe(403)

    const resJson = await dashboardApp.fetch(req('/radar?format=json', 's-zero'), env)
    expect(resJson.status).toBe(403)
  })

  it('squad-a member: 200 on GET /radar?format=json, JSON returns ONLY Squad A agents and squads', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?format=json', 's-squad-a'), env)
    expect(res.status).toBe(200)
    const data = await res.json() as { agents: Array<{ agent_id: string; display: string }>; squads: Array<{ squad_id: string; name: string }> }
    expect(data.agents.map(a => a.agent_id)).toEqual(['agent-a'])
    expect(data.squads.map(s => s.squad_id)).toEqual(['squad-a'])
  })

  it('squad-b member: 200 on GET /radar?format=json, JSON returns ONLY Squad B agents and squads', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-b': sessionRecord('squad-b@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?format=json', 's-squad-b'), env)
    expect(res.status).toBe(200)
    const data = await res.json() as { agents: Array<{ agent_id: string; display: string }>; squads: Array<{ squad_id: string; name: string }> }
    expect(data.agents.map(a => a.agent_id)).toEqual(['agent-b'])
    expect(data.squads.map(s => s.squad_id)).toEqual(['squad-b'])
  })

  it('org-scope capability: 200 on GET /radar?format=json, JSON returns ALL agents and squads', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    const res = await dashboardApp.fetch(req('/radar?format=json', 's-org'), env)
    expect(res.status).toBe(200)
    const data = await res.json() as { agents: Array<{ agent_id: string }>; squads: Array<{ squad_id: string }> }
    expect(data.agents.map(a => a.agent_id)).toContain('agent-a')
    expect(data.agents.map(a => a.agent_id)).toContain('agent-b')
    expect(data.squads.map(s => s.squad_id)).toContain('squad-a')
    expect(data.squads.map(s => s.squad_id)).toContain('squad-b')
  })

  // ── GET /brain ──────────────────────────────────────────────────────────────

  it('zero-capability member: 403 on GET /brain (F2 floor)', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord('zero@drive-by.test') })
    const res = await dashboardApp.fetch(req('/brain', 's-zero'), env)
    expect(res.status).toBe(403)
  })

  it('squad-a member: 200 on GET /brain, sees ONLY squad A\'s loop OKR', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/brain', 's-squad-a'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SQUAD-A-ONLY-OKR-TEXT')
    expect(body).not.toContain('SQUAD-B-ONLY-OKR-TEXT')
  })

  it('squad-b member: 200 on GET /brain, sees ONLY squad B\'s loop OKR', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-b': sessionRecord('squad-b@pot.test') })
    const res = await dashboardApp.fetch(req('/brain', 's-squad-b'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SQUAD-B-ONLY-OKR-TEXT')
    expect(body).not.toContain('SQUAD-A-ONLY-OKR-TEXT')
  })

  it('org-scope capability: 200 on GET /brain, sees BOTH loop OKRs', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    const res = await dashboardApp.fetch(req('/brain', 's-org'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SQUAD-A-ONLY-OKR-TEXT')
    expect(body).toContain('SQUAD-B-ONLY-OKR-TEXT')
  })

  // ── GET /agents/:id — follow-up gap flagged auditing #796's GET /agents fix ──

  it('squad-a member: 200 on GET /agents/agent-a (their own agent)', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/agents/agent-a', 's-squad-a'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agent Alpha')
  })

  it('squad-a member: 403 on GET /agents/agent-b (a DIFFERENT squad\'s agent)', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-squad-a': sessionRecord('squad-a@pot.test') })
    const res = await dashboardApp.fetch(req('/agents/agent-b', 's-squad-a'), env)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Agent Beta')
  })

  it('org-scope capability: 200 on GET /agents/:id for EVERY agent', async () => {
    harness = await makeHarness()
    const env = envFor(harness, { 'sess:s-org': sessionRecord('org@pot.test') })
    expect((await dashboardApp.fetch(req('/agents/agent-a', 's-org'), env)).status).toBe(200)
    expect((await dashboardApp.fetch(req('/agents/agent-b', 's-org'), env)).status).toBe(200)
  })

  // ── Mutation-check: the scope argument is load-bearing, not decorative ──────
  // Calls the underlying scoped reads directly with the resolved squad-id array
  // vs. `null` (unrestricted). If the route ever passed `null` unconditionally
  // (silently reverting to "always unrestricted"), the DENY assertions above
  // go red — this pins down that `squadIds` (not some other branch) is why.

  it('listFleetAgentRuntimeView: scoped(["squad-a"]) excludes host-b; unrestricted(null) includes it', async () => {
    harness = await makeHarness()
    const env = { DB: harness.db, TENANT_SLUG: 'pot-a' } as unknown as Env
    const scoped = await listFleetAgentRuntimeView(env, NOW, ['squad-a'])
    const unrestricted = await listFleetAgentRuntimeView(env, NOW, null)
    expect(scoped.map((r) => r.agent_id)).toEqual(['host-a'])
    expect(unrestricted.map((r) => r.agent_id).sort()).toEqual(['host-a', 'host-b'])
  })

  it('listPresence: scoped(["squad-a"]) excludes squad-b\'s presence row; unrestricted(null) includes it', async () => {
    harness = await makeHarness()
    const env = { DB: harness.db, TENANT_SLUG: 'pot-a' } as unknown as Env
    const scoped = await listPresence(env, NOW, ['squad-a'])
    const unrestricted = await listPresence(env, NOW, null)
    expect(scoped.map((r) => r.member_id)).toEqual(['member-squad-a'])
    expect(unrestricted.map((r) => r.member_id).sort()).toEqual(['member-squad-a', 'member-squad-b'])
  })

  it('listLoops: scoped(["squad-a"]) excludes squad-b\'s loop; unrestricted(null) includes it', async () => {
    harness = await makeHarness()
    const env = { DB: harness.db, TENANT_SLUG: 'pot-a' } as unknown as Env
    const scoped = await listLoops(env, { squadIds: ['squad-a'] })
    const unrestricted = await listLoops(env, { squadIds: null })
    expect(scoped.map((l) => l.okr)).toEqual(['SQUAD-A-ONLY-OKR-TEXT'])
    expect(unrestricted.map((l) => l.okr).sort()).toEqual(['SQUAD-A-ONLY-OKR-TEXT', 'SQUAD-B-ONLY-OKR-TEXT'])
  })

  it('listFleetAgentRuntimeView/listPresence/listLoops: squadIds=[] returns nothing, not "everything" (fail-closed)', async () => {
    harness = await makeHarness()
    const env = { DB: harness.db, TENANT_SLUG: 'pot-a' } as unknown as Env
    expect(await listFleetAgentRuntimeView(env, NOW, [])).toEqual([])
    expect(await listPresence(env, NOW, [])).toEqual([])
    expect(await listLoops(env, { squadIds: [] })).toEqual([])
  })
})
