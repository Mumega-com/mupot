// tests/fleet-agent-view.test.ts — unified agent view (Step 1: agent running on mupot).
//
// Tests:
//  - reportFleetAgents: persists agent_type + member_id; defaults agent_type to 'generic'; rejects
//    unknown agent_type; rejects member_id that doesn't exist (fail-closed); null member_id OK.
//  - getAgentView: LEFT JOIN runtime + identity + capabilities; member_id null → member:null +
//    capabilities:[]; tenant-scoped (no cross-tenant rows).
//  - GET /api/fleet/agents: admin → 200 unified list; non-admin token → 403; no token → 401.
//
// Existing fleet/registry/control tests remain in fleet-registry.test.ts — this file only covers
// the new unified-view surface.

import { describe, it, expect, beforeAll } from 'vitest'
import { reportFleetAgents, getAgentView } from '../src/fleet/registry'
import { fleetControlApp } from '../src/fleet/control-routes'
import type { Env } from '../src/types'

// ── helpers ──────────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Row shapes used in the mock DB.
interface FleetRow {
  agent_id: string; tenant: string; display: string; runtime: string; squads: string
  lifecycle: string; provider_contract: string | null; status: string; reported_by: string
  last_reported_at: string; agent_type: string; member_id: string | null
}

interface MemberRow { id: string; email: string | null; display_name: string }
interface CapRow { member_id: string; scope_type: string; scope_id: string | null; capability: string }
interface TokenRow { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }

interface MockDbOpts {
  members?: MemberRow[]
  caps?: CapRow[]
  tokens?: Record<string, TokenRow>
}

function makeDb(opts: MockDbOpts = {}) {
  const fleet = new Map<string, FleetRow>()
  const members: MemberRow[] = opts.members ?? []
  const caps: CapRow[] = opts.caps ?? []
  const tokens: Record<string, TokenRow> = opts.tokens ?? {}

  function first(sql: string, b: unknown[]) {
    // token resolution (resolveMemberByToken / resolveOrgAdmin)
    if (sql.includes('FROM member_tokens t')) {
      return tokens[b[0] as string] ?? null
    }
    // member_id existence check
    if (sql.includes('FROM members WHERE id')) {
      const [id] = b as [string]
      const found = members.find((m) => m.id === id)
      return found ? { 1: 1 } : null
    }
    throw new Error('unhandled first: ' + sql)
  }

  function all(sql: string, b: unknown[]) {
    // getAgentView — LEFT JOIN query
    if (sql.includes('LEFT JOIN members m ON m.id')) {
      const [tenant] = b as [string]
      const rows = [...fleet.values()].filter((r) => r.tenant === tenant).sort((x, y) => x.agent_id < y.agent_id ? -1 : 1)
      return rows.map((r) => {
        const m = r.member_id ? members.find((x) => x.id === r.member_id) : undefined
        return {
          agent_id: r.agent_id,
          agent_type: r.agent_type,
          runtime: r.runtime,
          status: r.status,
          lifecycle: r.lifecycle,
          last_reported_at: r.last_reported_at,
          member_id: r.member_id,
          m_id: m?.id ?? null,
          m_email: m?.email ?? null,
          m_display: m?.display_name ?? null,
        }
      })
    }
    // listFleetAgents (used by the /report test path via existing tests — kept for compat)
    if (sql.includes('FROM fleet_agents WHERE tenant')) {
      const [tenant] = b as [string]
      return [...fleet.values()].filter((r) => r.tenant === tenant).sort((x, y) => x.agent_id < y.agent_id ? -1 : 1)
    }
    // resolveCapabilities — UNION ALL of capabilities + channel_capability_grants
    if (sql.includes('capabilities')) {
      const [memberId] = b as [string]
      return caps.filter((c) => c.member_id === memberId).map((c) => ({
        member_id: c.member_id,
        scope_type: c.scope_type,
        scope_id: c.scope_id,
        capability: c.capability,
      }))
    }
    throw new Error('unhandled all: ' + sql)
  }

  function run(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, display, runtime, squads, lifecycle, pc, status, reported_by, agent_type, member_id] = b as Array<string | null>
      fleet.set(`${tenant}:${agent_id}`, {
        agent_id: agent_id!, tenant: tenant!, display: display!, runtime: runtime!, squads: squads!,
        lifecycle: lifecycle!, provider_contract: pc ?? null, status: status!, reported_by: reported_by!,
        last_reported_at: 'now', agent_type: agent_type ?? 'generic', member_id: member_id ?? null,
      })
      return { meta: { changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }

  const db = {
    _fleet: fleet,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return first(sql, binds) as T },
        async all<T>() { return { results: all(sql, binds) as T[] } },
        async run() { return run(sql, binds) },
      }
      return api
    },
  }
  return db
}

function env(db: ReturnType<typeof makeDb>, over: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 't', DB: db, FLEET_CONSUMER_AGENT: 'fleet-consumer', ...over } as unknown as Env
}

// A minimal valid report — no identity fields.
const BASE = { agent_id: 'kasra', display: 'Kasra', runtime: 'claude-code' as const, status: 'running' as const, lifecycle: 'always_on' as const }

// ── reportFleetAgents: new fields ────────────────────────────────────────────────

describe('reportFleetAgents — agent_type + member_id', () => {
  it('persists agent_type when supplied', async () => {
    const db = makeDb()
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, agent_type: 'builder' }])
    expect(r).toEqual({ ok: true, count: 1 })
    const row = [...db._fleet.values()][0]
    expect(row.agent_type).toBe('builder')
  })

  it('defaults agent_type to "generic" when omitted', async () => {
    const db = makeDb()
    await reportFleetAgents(env(db), 'fleet-consumer', [BASE])
    const row = [...db._fleet.values()][0]
    expect(row.agent_type).toBe('generic')
  })

  it('rejects a batch with an unknown agent_type (fail-closed)', async () => {
    const db = makeDb()
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, agent_type: 'hacker' }])
    expect(r).toEqual({ ok: false, reason: 'invalid agent in batch' })
    expect(db._fleet.size).toBe(0)
  })

  it('accepts null / absent member_id (no member link)', async () => {
    const db = makeDb()
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: null }])
    expect(r).toEqual({ ok: true, count: 1 })
    expect([...db._fleet.values()][0].member_id).toBeNull()
  })

  it('persists member_id when the member exists', async () => {
    const db = makeDb({ members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra' }] })
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: 'm-kasra' }])
    expect(r).toEqual({ ok: true, count: 1 })
    expect([...db._fleet.values()][0].member_id).toBe('m-kasra')
  })

  it('rejects the batch when member_id does not exist (fail-closed)', async () => {
    const db = makeDb() // no members seeded
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: 'm-ghost' }])
    expect(r.ok).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toMatch(/member_id not found/)
    expect(db._fleet.size).toBe(0)
  })

  it('rejects a member_id with an invalid format', async () => {
    const db = makeDb()
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: '../evil' }])
    expect(r).toEqual({ ok: false, reason: 'invalid agent in batch' })
  })
})

// ── getAgentView ─────────────────────────────────────────────────────────────────

describe('getAgentView', () => {
  it('returns an empty array when no agents are registered', async () => {
    const db = makeDb()
    expect(await getAgentView(env(db))).toEqual([])
  })

  it('member_id null → member:null, capabilities:[]', async () => {
    const db = makeDb()
    await reportFleetAgents(env(db), 'fleet-consumer', [BASE])
    const views = await getAgentView(env(db))
    expect(views).toHaveLength(1)
    expect(views[0].member).toBeNull()
    expect(views[0].capabilities).toEqual([])
  })

  it('joins runtime + identity + capabilities when member_id is set', async () => {
    const db = makeDb({
      members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra' }],
      caps: [
        { member_id: 'm-kasra', scope_type: 'org', scope_id: null, capability: 'admin' },
        { member_id: 'm-kasra', scope_type: 'squad', scope_id: 'sq-build', capability: 'lead' },
      ],
    })
    await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: 'm-kasra', agent_type: 'builder' }])
    const views = await getAgentView(env(db))
    expect(views).toHaveLength(1)
    const v = views[0]
    expect(v.agent_id).toBe('kasra')
    expect(v.type).toBe('builder')
    expect(v.runtime).toBe('claude-code')
    expect(v.status).toBe('running')
    expect(v.member).toEqual({ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra' })
    expect(v.capabilities).toHaveLength(2)
    expect(v.capabilities).toContainEqual({ scope_type: 'org', scope_id: null, capability: 'admin' })
    expect(v.capabilities).toContainEqual({ scope_type: 'squad', scope_id: 'sq-build', capability: 'lead' })
  })

  it('is tenant-scoped: tenant A rows are not visible to tenant B', async () => {
    const db = makeDb()
    await reportFleetAgents(env(db, { TENANT_SLUG: 'tA' }), 'fc', [{ ...BASE }])
    await reportFleetAgents(env(db, { TENANT_SLUG: 'tB' }), 'fc', [{ agent_id: 'loom', status: 'running' }])
    const viewsA = await getAgentView(env(db, { TENANT_SLUG: 'tA' }))
    const viewsB = await getAgentView(env(db, { TENANT_SLUG: 'tB' }))
    expect(viewsA.map((v) => v.agent_id)).toEqual(['kasra'])
    expect(viewsB.map((v) => v.agent_id)).toEqual(['loom'])
  })
})

// ── GET /api/fleet/agents route ──────────────────────────────────────────────────

const ADMIN_TOKEN = 'admin-token'
const MEMBER_TOKEN = 'member-token'
let adminHash = ''
let memberHash = ''

beforeAll(async () => {
  adminHash = await sha256Hex(ADMIN_TOKEN)
  memberHash = await sha256Hex(MEMBER_TOKEN)
})

function routeDb() {
  return makeDb({
    members: [{ id: 'm-admin', email: 'admin@x.com', display_name: 'Admin' }],
    caps: [
      { member_id: 'm-admin', scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
    tokens: {
      [adminHash]: { member_id: 'm-admin', display_name: 'Admin', email: 'admin@x.com', status: 'active', bound_agent_id: null },
      [memberHash]: { member_id: 'm-plain', display_name: 'Plain', email: null, status: 'active', bound_agent_id: null },
    },
  })
}

function get(db: ReturnType<typeof makeDb>, token: string | null) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return fleetControlApp.request('/agents', { method: 'GET', headers }, env(db))
}

describe('GET /api/fleet/agents', () => {
  it('401 without a token', async () => {
    expect((await get(routeDb(), null)).status).toBe(401)
  })

  it('403 for a non-admin token', async () => {
    // MEMBER_TOKEN resolves to 'm-plain' which has no caps → not admin → 403
    expect((await get(routeDb(), MEMBER_TOKEN)).status).toBe(403)
  })

  it('200 for an admin token returning the unified agent list', async () => {
    const db = routeDb()
    // Seed an agent
    await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, agent_type: 'builder', member_id: 'm-admin' }])
    const res = await get(db, ADMIN_TOKEN)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; agents: Array<{ agent_id: string; type: string; member: unknown }> }
    expect(json.ok).toBe(true)
    expect(json.agents).toHaveLength(1)
    expect(json.agents[0].agent_id).toBe('kasra')
    expect(json.agents[0].type).toBe('builder')
    expect(json.agents[0].member).toMatchObject({ id: 'm-admin', email: 'admin@x.com' })
  })
})
