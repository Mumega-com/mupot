// tests/fleet-agent-view.test.ts — unified agent view (Step 1: agent running on mupot).
//
// Tests:
//  - reportFleetAgents: persists agent_type + member_id; defaults agent_type to 'generic'; rejects
//    unknown agent_type; rejects member_id that doesn't exist or belongs to another tenant (fail-closed);
//    null member_id OK; lazy backfill stamps NULL-tenant members before existence check.
//  - getAgentView: LEFT JOIN runtime + identity + capabilities (tenant-bound); member_id null →
//    member:null; cross-tenant member_id → member:null (BLOCK-1 fix); backfill → NULL-tenant member
//    gets this pot's slug and then joins correctly.
//  - GET /api/fleet/agents: admin → 200 unified list; non-admin token → 403; no token → 401.

import { describe, it, expect, beforeAll } from 'vitest'
import { reportFleetAgents, getAgentView, listFleetAgentRuntimeView } from '../src/fleet/registry'
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
  last_reported_at: string; agent_type: string; member_id: string | null; host?: string
}

// tenant is nullable — migration 0040 adds it as nullable, and NULL is the
// pre-migration state. The lazy backfill sets it from env.TENANT_SLUG at runtime.
interface MemberRow { id: string; email: string | null; display_name: string; tenant: string | null }
interface CapRow { member_id: string; scope_type: string; scope_id: string | null; capability: string }
interface TokenRow { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }

interface MockDbOpts {
  members?: MemberRow[]
  caps?: CapRow[]
  tokens?: Record<string, TokenRow>
}

function makeDb(opts: MockDbOpts = {}) {
  const fleet = new Map<string, FleetRow>()
  // Members are mutable so the lazy backfill UPDATE can set tenant on NULL rows.
  const members: MemberRow[] = [...(opts.members ?? [])]
  const caps: CapRow[] = opts.caps ?? []
  const tokens: Record<string, TokenRow> = opts.tokens ?? {}

  function first(sql: string, b: unknown[]) {
    // token resolution (resolveMemberByToken / resolveOrgAdmin)
    if (sql.includes('FROM member_tokens t')) {
      return tokens[b[0] as string] ?? null
    }
    // member_id existence check — TENANT-SCOPED (BLOCK-1 fix: ?1=id, ?2=tenant)
    if (sql.includes('FROM members WHERE id')) {
      const [id, tenant] = b as [string, string]
      const found = members.find((m) => m.id === id && m.tenant === tenant)
      return found ? { 1: 1 } : null
    }
    throw new Error('unhandled first: ' + sql)
  }

  function all(sql: string, b: unknown[]) {
    // getAgentView — LEFT JOIN with tenant-bound join condition (BLOCK-1 fix)
    if (sql.includes('LEFT JOIN members m ON m.id')) {
      const [tenant] = b as [string]
      const rows = [...fleet.values()].filter((r) => r.tenant === tenant).sort((x, y) => x.agent_id < y.agent_id ? -1 : 1)
      return rows.map((r) => {
        // The JOIN condition is `m.id = fa.member_id AND m.tenant = fa.tenant`.
        // A cross-tenant member (tenant='other' vs fa.tenant='t') does NOT join.
        const m = r.member_id ? members.find((x) => x.id === r.member_id && x.tenant === r.tenant) : undefined
        return {
          agent_id: r.agent_id,
          display: r.display,
          agent_type: r.agent_type,
          runtime: r.runtime,
          squads: r.squads,
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
    // listFleetAgents (kept for compat)
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
    // reportFleetAgents keyed-agent skip check: no registered keys in these tests.
    if (sql.includes('FROM agent_keys')) return []
    throw new Error('unhandled all: ' + sql)
  }

  function run(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, display, runtime, squads, lifecycle, pc, status, reported_by, agent_type, member_id, host] = b as Array<string | null>
      fleet.set(`${tenant}:${agent_id}`, {
        agent_id: agent_id!, tenant: tenant!, display: display!, runtime: runtime!, squads: squads!,
        lifecycle: lifecycle!, provider_contract: pc ?? null, status: status!, reported_by: reported_by!,
        last_reported_at: 'now', agent_type: agent_type ?? 'generic', member_id: member_id ?? null,
        host: host ?? '',
      })
      return { meta: { changes: 1 } }
    }
    // Lazy backfill (0040): set tenant on NULL-tenant members from env.TENANT_SLUG.
    // Idempotent — only rows where tenant IS NULL are updated; already-tagged rows (including
    // cross-tenant members tagged 'other') are not touched.
    if (sql.includes('UPDATE members SET tenant')) {
      const [tenantSlug] = b as [string]
      let changed = 0
      for (const m of members) {
        if (m.tenant == null) { m.tenant = tenantSlug; changed++ }
      }
      return { meta: { changes: changed } }
    }
    throw new Error('unhandled run: ' + sql)
  }

  const db = {
    _fleet: fleet,
    _members: members, // exposed for direct seeding in backfill tests
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

  it('persists member_id when the member exists in this tenant (backfill + tenant-scoped check)', async () => {
    // Member starts with null tenant — the lazy backfill stamps it with TENANT_SLUG='t'
    // before the tenant-scoped existence check runs, so it is found.
    const db = makeDb({ members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra', tenant: null }] })
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: 'm-kasra' }])
    expect(r).toEqual({ ok: true, count: 1 })
    expect([...db._fleet.values()][0].member_id).toBe('m-kasra')
    // Backfill side-effect: the member's tenant is now 't'
    expect(db._members.find((m) => m.id === 'm-kasra')?.tenant).toBe('t')
  })

  it('rejects the batch when member_id does not exist in this tenant (fail-closed)', async () => {
    const db = makeDb() // no members seeded
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [{ ...BASE, member_id: 'm-ghost' }])
    expect(r.ok).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toMatch(/member_id not found/)
    expect(db._fleet.size).toBe(0)
  })

  // BLOCK-1 fix: a member tagged to a DIFFERENT tenant must be rejected.
  it('rejects the batch when member_id belongs to a different tenant (BLOCK-1)', async () => {
    // Pre-tag this member as 'other' — the backfill only touches NULL-tenant rows, so
    // 'other' is preserved and the tenant-scoped check (AND tenant='t') finds nothing.
    const db = makeDb({ members: [{ id: 'm-other', email: 'x@other.com', display_name: 'Other', tenant: 'other' }] })
    const r = await reportFleetAgents(env(db, { TENANT_SLUG: 't' }), 'fleet-consumer', [{ ...BASE, member_id: 'm-other' }])
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
      // Member seeded with null tenant — backfill in reportFleetAgents (triggered by member_id)
      // sets it to 't' so both the existence check and the subsequent LEFT JOIN match.
      members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra', tenant: null }],
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
    expect(v.display).toBe('Kasra')
    expect(v.type).toBe('builder')
    expect(v.runtime).toBe('claude-code')
    expect(v.squads).toEqual([])
    expect(v.status).toBe('running')
    expect(v.member).toEqual({ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra' })
    expect(v.capabilities).toHaveLength(2)
    expect(v.capabilities).toContainEqual({ scope_type: 'org', scope_id: null, capability: 'admin' })
    expect(v.capabilities).toContainEqual({ scope_type: 'squad', scope_id: 'sq-build', capability: 'lead' })
  })

  // BLOCK-1 fix: a fleet row whose member_id points to a DIFFERENT-TENANT member must
  // surface member:null (no cross-tenant identity leak through the unified view).
  it('cross-tenant member_id → member:null, capabilities:[] (BLOCK-1)', async () => {
    // Directly seed a fleet row referencing 'm-other' under tenant='t'.
    // The member 'm-other' exists but is tagged tenant='other', so the
    // tenant-bound LEFT JOIN (AND m.tenant = fa.tenant) finds nothing.
    const db = makeDb({
      members: [{ id: 'm-other', email: 'x@other.com', display_name: 'Other', tenant: 'other' }],
    })
    // Seed fleet row directly (bypassing the existence check in reportFleetAgents so we can
    // test getAgentView's own isolation even if the row somehow landed without the check).
    db._fleet.set('t:kasra', {
      agent_id: 'kasra', tenant: 't', display: 'Kasra', runtime: 'claude-code', squads: '[]',
      lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'fc',
      last_reported_at: 'now', agent_type: 'builder', member_id: 'm-other',
    })
    const views = await getAgentView(env(db, { TENANT_SLUG: 't' }))
    expect(views).toHaveLength(1)
    // Cross-tenant member MUST NOT be exposed.
    expect(views[0].member).toBeNull()
    expect(views[0].capabilities).toEqual([])
  })

  // BLOCK-2 regression: cross-tenant member WITH capabilities must not leak those caps.
  //
  // The BLOCK-1 test above verified member:null for a cross-tenant link. But the pre-fix
  // code still called resolveCapabilities(env, r.member_id) — the raw fleet column, not
  // the join-matched r.m_id. So even with member:null, the foreign member's capabilities
  // were returned. This test seeds a cross-tenant member WITH real capabilities (org owner)
  // and asserts that BOTH member AND capabilities are empty on getAgentView output.
  //
  // Fails-without-fix: old code → capabilities:[{org,null,owner}] (foreign cap leaked).
  // Passes-with-fix: joinedId=null → capabilities:[] (foreign caps are never resolved).
  it('cross-tenant member WITH capabilities → member:null, capabilities:[] (BLOCK-2)', async () => {
    const db = makeDb({
      members: [{ id: 'm-owner', email: 'owner@other.com', display_name: 'ForeignOwner', tenant: 'other' }],
      // This member holds org-level owner on their own tenant. A bug would leak this.
      caps: [{ member_id: 'm-owner', scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    // Seed fleet row directly under tenant='t' with member_id pointing at the foreign member.
    db._fleet.set('t:kasra', {
      agent_id: 'kasra', tenant: 't', display: 'Kasra', runtime: 'claude-code', squads: '[]',
      lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'fc',
      last_reported_at: 'now', agent_type: 'builder', member_id: 'm-owner',
    })
    const views = await getAgentView(env(db, { TENANT_SLUG: 't' }))
    expect(views).toHaveLength(1)
    // The foreign member must not appear in any output field.
    expect(views[0].member).toBeNull()
    // The foreign member's capabilities must NOT be returned (BLOCK-2).
    expect(views[0].capabilities).toEqual([])
  })

  // BLOCK-1 fix (backfill path): a pre-migration member with tenant=NULL gets stamped
  // with env.TENANT_SLUG by the lazy backfill, then joins correctly.
  it('NULL-tenant member is backfilled and joins correctly (backfill path)', async () => {
    const db = makeDb({
      members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra', tenant: null }],
    })
    // Seed fleet row directly — member_id is set but tenant is null on the member.
    db._fleet.set('t:kasra', {
      agent_id: 'kasra', tenant: 't', display: 'Kasra', runtime: 'claude-code', squads: '[]',
      lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'fc',
      last_reported_at: 'now', agent_type: 'builder', member_id: 'm-kasra',
    })
    // Before getAgentView: member has null tenant (not joined yet).
    expect(db._members.find((m) => m.id === 'm-kasra')?.tenant).toBeNull()

    const views = await getAgentView(env(db, { TENANT_SLUG: 't' }))

    // After getAgentView: backfill ran → member now has tenant='t'.
    expect(db._members.find((m) => m.id === 'm-kasra')?.tenant).toBe('t')
    // The LEFT JOIN (AND m.tenant = fa.tenant = 't') now matches → member is joined.
    expect(views[0].member).toEqual({ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra' })
  })

  it('is tenant-scoped: tenant A fleet rows are not visible to tenant B', async () => {
    const db = makeDb()
    await reportFleetAgents(env(db, { TENANT_SLUG: 'tA' }), 'fc', [{ ...BASE }])
    await reportFleetAgents(env(db, { TENANT_SLUG: 'tB' }), 'fc', [{ agent_id: 'loom', status: 'running' }])
    const viewsA = await getAgentView(env(db, { TENANT_SLUG: 'tA' }))
    const viewsB = await getAgentView(env(db, { TENANT_SLUG: 'tB' }))
    expect(viewsA.map((v) => v.agent_id)).toEqual(['kasra'])
    expect(viewsB.map((v) => v.agent_id)).toEqual(['loom'])
  })
})

describe('listFleetAgentRuntimeView', () => {
  it('returns the least-privilege runtime status feed with derived presence only', async () => {
    const db = makeDb({
      members: [{ id: 'm-kasra', email: 'kasra@mumega.com', display_name: 'Kasra', tenant: 't' }],
      caps: [{ member_id: 'm-kasra', scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    db._fleet.set('t:kasra', {
      agent_id: 'kasra', tenant: 't', display: 'Kasra', runtime: 'claude-code', squads: '["growth"]',
      lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'fc',
      last_reported_at: '2026-07-08 00:59:00', agent_type: 'builder', member_id: 'm-kasra',
    })

    const views = await listFleetAgentRuntimeView(
      env(db, { TENANT_SLUG: 't', FLEET_PRESENCE_TTL_SEC: '180' } as Partial<Env>),
      Date.parse('2026-07-08T01:00:00Z'),
    )

    expect(views).toEqual([{
      agent_id: 'kasra',
      display: 'Kasra',
      runtime: 'claude-code',
      squads: ['growth'],
      status: 'running',
      presence: 'live',
      lifecycle: 'always_on',
      last_seen: '2026-07-08 00:59:00',
      host: '', // never self-reported in this fixture's raw db._fleet row (#21 slice 2)
    }])
    expect(views[0]).not.toHaveProperty('member')
    expect(views[0]).not.toHaveProperty('capabilities')
    expect(views[0]).not.toHaveProperty('type')
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
  // m-admin seeded with null tenant — the lazy backfill in getAgentView stamps it with 't'
  // before the LEFT JOIN runs, so the member is visible in the unified view.
  return makeDb({
    members: [{ id: 'm-admin', email: 'admin@x.com', display_name: 'Admin', tenant: null }],
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

  it('200 for an admin token returning the unified agent list with joined member', async () => {
    const db = routeDb()
    // Seed an agent with member_id='m-admin' (which starts null-tenant; backfill will tag it 't')
    // The backfill in reportFleetAgents runs first: m-admin.tenant becomes 't'.
    // Then the existence check (AND tenant='t') passes, and the fleet row is written.
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
