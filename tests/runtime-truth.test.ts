// tests/runtime-truth.test.ts — fca29748 step 1: peers/status read the LIVE attested runtime
// (check_in) first, and label stored values stale. Real SQLite + the full migration chain.
// Reproduces the drift: check_in(claude-code) while fleet_agents says codex.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { loadRuntimeTruth } from '../src/fleet/runtime-truth'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const MEMBER = 'member-kasra'
const SQUAD = 'squad-core'
const AGENT = 'agent-kasra'
const URL_ = 'https://pot.example'

let h: SqliteD1Harness
let env: Env

function auth(): AuthContext {
  return {
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: AGENT,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
  }
}

function seedFleet(runtime: string, model: string | null, reportedAgo = '-1 minutes', agentId = AGENT): void {
  h.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, member_id, model, last_reported_at)
     VALUES (?1, ?2, 'd', ?3, '[]', 'on_demand', 'running', ?1, ?4, ?5, datetime('now', ?6))`,
  ).run(agentId, TENANT, runtime, MEMBER, model, reportedAgo)
}

function seedPresence(harness: string, model: string | null, seenAgo: string, label = 'kasra', tenant = TENANT): void {
  h.sqlite.prepare(
    `INSERT INTO presence (tenant, member_id, display_name, source, label, seat, agent_id, harness, model, last_seen_at)
     VALUES (?1, ?2, 'Kasra', ?3, ?4, ?4, ?5, ?3, ?6, datetime('now', ?7))`,
  ).run(tenant, MEMBER, harness, label, AGENT, model, seenAgo)
}

type Peer = { id: string; model: string | null; live_runtime: {
  harness: string | null; model: string | null; harness_source: string | null; model_source: string | null
  stale: boolean; as_of: string | null; conflicts: Array<{ source: string; harness: string | null; model: string | null }>
} }

async function peerOf(): Promise<Peer> {
  const res = await invokeTool(auth(), env, 'peers', {}, URL_)
  expect(res.ok).toBe(true)
  const peers = (res.result as { peers: Peer[] }).peers
  const p = peers.find((x) => x.id === AGENT)
  if (!p) throw new Error('self peer missing')
  return p
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'squad-core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
      VALUES ('${AGENT}', '${SQUAD}', 'kasra', 'Kasra', 'builder', 'gpt-5.6-terra', 'active', '2026-08-01T00:00:00Z');
    INSERT INTO members (id, display_name, email, status, tenant) VALUES ('${MEMBER}', 'Kasra', 'k@example.com', 'active', '${TENANT}');
  `)
  env = {
    DB: h.db, TENANT_SLUG: TENANT,
    SESSIONS: { get: async () => null, put: async () => {} },
    AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('{}') }) },
  } as unknown as Env
})
afterEach(() => h.close())

describe('peers() reads the live attested runtime (fca29748)', () => {
  it('REPRODUCES THE DRIFT: check_in claude-code/opus beats fleet_agents codex/terra and agents.model', async () => {
    seedFleet('codex', 'gpt-5.6-terra')
    const ci = await invokeTool(auth(), env, 'check_in', { seat: 'kasra', harness: 'claude-code', model: 'claude-opus-5' }, URL_)
    expect(ci.ok).toBe(true)
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('claude-code')
    expect(p.live_runtime.model).toBe('claude-opus-5')
    expect(p.live_runtime.harness_source).toBe('check_in')
    expect(p.live_runtime.model_source).toBe('check_in')
    expect(p.live_runtime.stale).toBe(false)
    expect(p.model).toBe('claude-opus-5') // top-level model is the live one, not agents.model
    // the disagreeing stored values are surfaced, not hidden
    expect(p.live_runtime.conflicts).toEqual([{ source: 'fleet_attach', harness: 'codex', model: 'gpt-5.6-terra' }])
  })

  it('an ACTIVE check_in outranks a NEWER fleet report (a daemon touch must not re-assert a stale runtime)', async () => {
    seedPresence('claude-code', 'claude-opus-5', '-5 minutes')
    seedFleet('codex', 'gpt-5.6-terra', '-1 minutes')
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('claude-code')
    expect(p.live_runtime.model).toBe('claude-opus-5')
    expect(p.live_runtime.conflicts).toEqual([{ source: 'fleet_attach', harness: 'codex', model: 'gpt-5.6-terra' }])
  })

  it('equal timestamps between a stale check_in and a fleet report go to the fleet report', async () => {
    h.sqlite.prepare(
      `INSERT INTO presence (tenant, member_id, display_name, source, label, seat, agent_id, harness, model, last_seen_at)
       VALUES (?1, ?2, 'K', 'claude-code', 'kasra', 'kasra', ?3, 'claude-code', 'claude-opus-5', '2026-11-04 00:00:00')`,
    ).run(TENANT, MEMBER, AGENT)
    h.sqlite.prepare(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, member_id, model, last_reported_at)
       VALUES (?1, ?2, 'd', 'codex', '[]', 'on_demand', 'running', ?1, ?3, 'gpt-5.6-terra', '2026-11-04 00:00:00')`,
    ).run(AGENT, TENANT, MEMBER)
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('codex')
    expect(p.live_runtime.stale).toBe(true)
  })

  it('check_in records the model it carried', async () => {
    await invokeTool(auth(), env, 'check_in', { seat: 'kasra', harness: 'claude-code', model: 'claude-opus-5' }, URL_)
    const r = h.sqlite.prepare('SELECT model, harness FROM presence WHERE tenant = ? AND agent_id = ?').get(TENANT, AGENT) as { model: string; harness: string }
    expect(r).toEqual({ model: 'claude-opus-5', harness: 'claude-code' })
  })

  it('a check_in older than the active window no longer outranks a newer fleet report; both labelled by age', async () => {
    seedPresence('claude-code', 'claude-opus-5', '-30 minutes')
    seedFleet('codex', 'gpt-5.6-terra', '-1 minutes')
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('codex')
    expect(p.live_runtime.model).toBe('gpt-5.6-terra')
    expect(p.live_runtime.stale).toBe(false)
  })

  it('with nothing live, stored fleet values are returned labelled stale', async () => {
    seedFleet('codex', 'gpt-5.6-terra', '-3 hours')
    const p = await peerOf()
    expect(p.live_runtime.model).toBe('gpt-5.6-terra')
    expect(p.live_runtime.model_source).toBe('fleet_attach')
    expect(p.live_runtime.stale).toBe(true)
  })

  it('with only the identity profile, agents.model is returned labelled stale', async () => {
    const p = await peerOf()
    expect(p.live_runtime.model).toBe('gpt-5.6-terra')
    expect(p.live_runtime.model_source).toBe('identity_profile')
    expect(p.live_runtime.harness).toBeNull()
    expect(p.live_runtime.stale).toBe(true)
  })

  it('a live check_in with no model falls through to the stored model, labelled with ITS source', async () => {
    seedPresence('claude-code', null, '-1 minutes')
    seedFleet('codex', 'gpt-5.6-terra')
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('claude-code')
    expect(p.live_runtime.harness_source).toBe('check_in')
    expect(p.live_runtime.model).toBe('gpt-5.6-terra')
    expect(p.live_runtime.model_source).toBe('fleet_attach')
  })

  it("an 'unknown' check_in harness is not a claim", async () => {
    seedPresence('unknown', 'claude-opus-5', '-1 minutes')
    seedFleet('codex', null)
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('codex')
    expect(p.live_runtime.harness_source).toBe('fleet_attach')
    expect(p.live_runtime.model).toBe('claude-opus-5')
  })

  it('presence from another tenant is ignored', async () => {
    seedPresence('claude-code', 'claude-opus-5', '-1 minutes', 'kasra', 'other-tenant')
    seedFleet('codex', 'gpt-5.6-terra')
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('codex')
  })

  it('the newest seat wins when an agent has several', async () => {
    seedPresence('codex', 'gpt-5.6-terra', '-5 minutes', 'old-seat')
    seedPresence('claude-code', 'claude-opus-5', '-1 minutes', 'new-seat')
    const p = await peerOf()
    expect(p.live_runtime.model).toBe('claude-opus-5')
  })

  it('a fleet row keyed by slug is found when no id-keyed row exists', async () => {
    seedFleet('codex', 'gpt-5.6-terra', '-1 minutes', 'kasra')
    const p = await peerOf()
    expect(p.live_runtime.harness).toBe('codex')
  })
})

describe('status(agent_id) carries the same live runtime', () => {
  it('returns agent.live_runtime from check_in and keeps the stored model visible', async () => {
    seedFleet('codex', 'gpt-5.6-terra')
    await invokeTool(auth(), env, 'check_in', { seat: 'kasra', harness: 'claude-code', model: 'claude-opus-5' }, URL_)
    const res = await invokeTool(auth(), env, 'status', { agent_id: AGENT }, URL_)
    expect(res.ok).toBe(true)
    const a = (res.result as { agent: { model: string; stored_model: string; live_runtime: Peer['live_runtime'] } }).agent
    expect(a.live_runtime.model).toBe('claude-opus-5')
    expect(a.model).toBe('claude-opus-5')
    expect(a.stored_model).toBe('gpt-5.6-terra')
  })
})

describe('loadRuntimeTruth', () => {
  it('returns an empty map for no ids and never throws on a missing table', async () => {
    expect((await loadRuntimeTruth(env, [])).size).toBe(0)
  })
})

describe('fleet_agent_get carries live_runtime', () => {
  it('shows the check_in runtime next to the stored fleet values', async () => {
    seedFleet('codex', 'gpt-5.6-terra')
    await invokeTool(auth(), env, 'check_in', { seat: 'kasra', harness: 'claude-code', model: 'claude-opus-5' }, URL_)
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: AGENT }, URL_)
    expect(res.ok).toBe(true)
    const r = res.result as { runtime: string; model: string; live_runtime: Peer['live_runtime'] }
    expect(r.runtime).toBe('codex') // the routing/registry view is unchanged
    expect(r.live_runtime.harness).toBe('claude-code')
    expect(r.live_runtime.model).toBe('claude-opus-5')
  })
})
