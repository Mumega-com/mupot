// tests/fleet-attach.test.ts — agent self-attach / self-detach routes (Step 2a).
//
// Security properties under test:
//  - member_id is ALWAYS auth-derived; a body member_id is ignored (attach).
//  - An agent can only detach its OWN row (detach ownership gate).
//  - No token → 401; unknown type / bad runtime → 400.
//  - attach returns the getAgentView boot-ack shape.
//  - All writes are tenant-scoped; cross-tenant attach/detach is structurally impossible.

import { describe, it, expect, beforeAll } from 'vitest'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import type { Env } from '../src/types'

// ── mock DB ──────────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface FleetRow {
  agent_id: string; tenant: string; display: string; runtime: string; squads: string
  lifecycle: string; provider_contract: string | null; status: string; reported_by: string
  last_reported_at: string; updated_at: string; agent_type: string; member_id: string | null
}

interface TokenRow {
  member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null
}

interface MemberRow { id: string; email: string | null; display_name: string; tenant: string | null }
interface CapRow { member_id: string; scope_type: string; scope_id: string | null; capability: string }

interface MockOpts {
  tokens?: Record<string, TokenRow>
  members?: MemberRow[]
  caps?: CapRow[]
  fleet?: FleetRow[]
}

function makeDb(opts: MockOpts = {}) {
  const tokens: Record<string, TokenRow> = opts.tokens ?? {}
  const members: MemberRow[] = [...(opts.members ?? [])]
  const caps: CapRow[] = opts.caps ?? []
  const fleet = new Map<string, FleetRow>()

  // Seed pre-existing fleet rows.
  for (const r of (opts.fleet ?? [])) {
    fleet.set(`${r.tenant}:${r.agent_id}`, r)
  }

  function first(sql: string, binds: unknown[]) {
    if (sql.includes('FROM member_tokens t')) {
      return tokens[binds[0] as string] ?? null
    }
    if (sql.includes('FROM members WHERE id')) {
      const [id, tenant] = binds as [string, string]
      return members.find((m) => m.id === id && m.tenant === tenant) ? { 1: 1 } : null
    }
    throw new Error('unhandled first: ' + sql)
  }

  function all(sql: string, binds: unknown[]) {
    // getAgentView — LEFT JOIN fleet_agents ↔ members, tenant-bound.
    if (sql.includes('LEFT JOIN members m ON m.id')) {
      const [tenant] = binds as [string]
      const rows = [...fleet.values()]
        .filter((r) => r.tenant === tenant)
        .sort((a, b) => (a.agent_id < b.agent_id ? -1 : 1))
      return rows.map((r) => {
        const m = r.member_id
          ? members.find((x) => x.id === r.member_id && x.tenant === r.tenant)
          : undefined
        return {
          agent_id: r.agent_id, agent_type: r.agent_type, runtime: r.runtime,
          status: r.status, lifecycle: r.lifecycle, last_reported_at: r.last_reported_at,
          member_id: r.member_id, m_id: m?.id ?? null,
          m_email: m?.email ?? null, m_display: m?.display_name ?? null,
        }
      })
    }
    // resolveCapabilities
    if (sql.includes('capabilities')) {
      const [memberId] = binds as [string]
      return caps.filter((c) => c.member_id === memberId)
    }
    throw new Error('unhandled all: ' + sql)
  }

  function run(sql: string, binds: unknown[]) {
    // fleet_agents INSERT ON CONFLICT upsert (attach).
    // The attach SQL uses SQL literals for display='', squads='[]', provider_contract=NULL,
    // status='running'. Only 7 bound params: agent_id(?1), tenant(?2), runtime(?3),
    // lifecycle(?4), reported_by(?5), agent_type(?6), member_id(?7).
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, runtime, lifecycle, reported_by, agent_type, member_id]
        = binds as Array<string | null>
      const key = `${tenant}:${agent_id}`
      const existing = fleet.get(key)
      if (existing) {
        // ON CONFLICT DO UPDATE — mirrors the ON CONFLICT SET list in attach-routes.ts.
        existing.runtime = runtime!
        existing.lifecycle = lifecycle!
        existing.status = 'running'
        existing.reported_by = reported_by!
        existing.agent_type = agent_type!
        existing.member_id = member_id ?? null
        existing.last_reported_at = 'now'
        existing.updated_at = 'now'
      } else {
        fleet.set(key, {
          agent_id: agent_id!, tenant: tenant!, display: '',
          runtime: runtime!, squads: '[]', lifecycle: lifecycle!,
          provider_contract: null, status: 'running', reported_by: reported_by!,
          last_reported_at: 'now', updated_at: 'now',
          agent_type: agent_type!, member_id: member_id ?? null,
        })
      }
      return { meta: { changes: 1 } }
    }

    // fleet_agents UPDATE (detach) — ownership-gated.
    if (sql.includes('UPDATE fleet_agents')) {
      const [tenant, agent_id, member_id] = binds as [string, string, string]
      const key = `${tenant}:${agent_id}`
      const row = fleet.get(key)
      if (!row || row.member_id !== member_id) {
        return { meta: { changes: 0 } }
      }
      row.status = 'stopped'
      row.last_reported_at = 'now'
      row.updated_at = 'now'
      return { meta: { changes: 1 } }
    }

    // Lazy backfill (stamp NULL-tenant members).
    if (sql.includes('UPDATE members SET tenant')) {
      const [slug] = binds as [string]
      let changed = 0
      for (const m of members) {
        if (m.tenant == null) { m.tenant = slug; changed++ }
      }
      return { meta: { changes: changed } }
    }

    throw new Error('unhandled run: ' + sql)
  }

  const db = {
    _fleet: fleet,
    _members: members,
    prepare(sql: string) {
      const bs: unknown[] = []
      const api = {
        bind(...a: unknown[]) { bs.push(...a); return api },
        async first<T>() { return first(sql, bs) as T },
        async all<T>() { return { results: all(sql, bs) as T[] } },
        async run() { return run(sql, bs) },
      }
      return api
    },
  }
  return db
}

function makeEnv(db: ReturnType<typeof makeDb>, over: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 't', DB: db, ...over } as unknown as Env
}

// ── token fixtures ───────────────────────────────────────────────────────────────

const TOKEN_A = 'token-agent-a'
const TOKEN_B = 'token-agent-b'
let hashA = ''
let hashB = ''

beforeAll(async () => {
  hashA = await sha256Hex(TOKEN_A)
  hashB = await sha256Hex(TOKEN_B)
})

// Members for token fixtures.
const MEMBER_A: MemberRow = { id: 'm-a', email: 'a@x.com', display_name: 'Agent A', tenant: 't' }
const MEMBER_B: MemberRow = { id: 'm-b', email: 'b@x.com', display_name: 'Agent B', tenant: 't' }

function defaultDb(): ReturnType<typeof makeDb> {
  return makeDb({
    members: [MEMBER_A, MEMBER_B],
    tokens: {
      [hashA]: { member_id: 'm-a', display_name: 'Agent A', email: 'a@x.com', status: 'active', bound_agent_id: 'kasra' },
      [hashB]: { member_id: 'm-b', display_name: 'Agent B', email: 'b@x.com', status: 'active', bound_agent_id: 'loom' },
    },
  })
}

// ── request helper ───────────────────────────────────────────────────────────────

function post(path: string, token: string | null, body: unknown, e: Env) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fleetAttachApp.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, e)
}

// ── POST /attach ─────────────────────────────────────────────────────────────────

describe('POST /attach', () => {
  it('401 when no token is supplied', async () => {
    const db = defaultDb()
    const res = await post('/attach', null, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(401)
    expect(db._fleet.size).toBe(0) // no mutation
  })

  it('400 on unknown agent type', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'hacker', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  it('400 on bad runtime', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'elixir' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  it('400 on bad agent_id (path traversal)', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_A, { agent_id: '../evil', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  it('200 on a valid attach — upserts status=running with member_id FROM AUTH', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code', lifecycle: 'always_on' }, makeEnv(db))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; agent: { agent_id: string; type: string; status: string } }
    expect(json.ok).toBe(true)

    const row = db._fleet.get('t:kasra')!
    expect(row).toBeDefined()
    expect(row.status).toBe('running')
    expect(row.agent_type).toBe('builder')
    expect(row.runtime).toBe('claude-code')
    expect(row.lifecycle).toBe('always_on')
    // Keystone: member_id is from auth (m-a), not from any body field.
    expect(row.member_id).toBe('m-a')
  })

  it('SECURITY: body member_id is ignored — stored member is auth-derived', async () => {
    const db = defaultDb()
    // Send a body with member_id='m-b' (agent B's id) while authenticated as TOKEN_A (m-a).
    // The stored member_id must be m-a (auth), never m-b (body).
    const res = await post(
      '/attach',
      TOKEN_A,
      { agent_id: 'kasra', type: 'builder', runtime: 'claude-code', member_id: 'm-b' },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const row = db._fleet.get('t:kasra')!
    // Auth-derived identity wins; body member_id silently discarded.
    expect(row.member_id).toBe('m-a')
  })

  it('returns the getAgentView boot-ack shape for the attached agent', async () => {
    const db = defaultDb()
    const res = await post(
      '/attach',
      TOKEN_A,
      { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      agent: {
        agent_id: string; type: string; runtime: string; status: string
        lifecycle: string; last_seen: string; member: unknown; capabilities: unknown[]
      } | null
    }
    expect(json.ok).toBe(true)
    // Boot-ack shape: agent_id, type, runtime, status, lifecycle, last_seen, member, capabilities.
    const a = json.agent!
    expect(a.agent_id).toBe('kasra')
    expect(a.type).toBe('builder')
    expect(a.runtime).toBe('claude-code')
    expect(a.status).toBe('running')
    expect('last_seen' in a).toBe(true)
    expect('member' in a).toBe(true)
    expect(Array.isArray(a.capabilities)).toBe(true)
  })

  it('upsert updates an existing row (second attach updates status back to running)', async () => {
    const db = defaultDb()
    const e = makeEnv(db)
    // First attach.
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, e)
    // Manually flip to stopped.
    const row = db._fleet.get('t:kasra')!
    row.status = 'stopped'
    // Second attach.
    const res = await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'hermes' }, e)
    expect(res.status).toBe(200)
    expect(db._fleet.get('t:kasra')!.status).toBe('running')
    expect(db._fleet.get('t:kasra')!.runtime).toBe('hermes') // updated
  })

  it('lifecycle defaults to on_demand when omitted', async () => {
    const db = defaultDb()
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'generic', runtime: 'tmux' }, makeEnv(db))
    expect(db._fleet.get('t:kasra')!.lifecycle).toBe('on_demand')
  })

  it('tenant-scoped: two tenants can attach same agent_id without collision', async () => {
    const db = defaultDb()
    const eA = makeEnv(db, { TENANT_SLUG: 'tA' })
    const eB = makeEnv(db, { TENANT_SLUG: 'tB' })
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, eA)
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'reviewer', runtime: 'codex' }, eB)
    expect(db._fleet.get('tA:kasra')!.agent_type).toBe('builder')
    expect(db._fleet.get('tB:kasra')!.agent_type).toBe('reviewer')
    expect(db._fleet.size).toBe(2)
  })
})

// ── POST /detach ─────────────────────────────────────────────────────────────────

describe('POST /detach', () => {
  it('401 when no token is supplied', async () => {
    const db = defaultDb()
    const res = await post('/detach', null, { agent_id: 'kasra' }, makeEnv(db))
    expect(res.status).toBe(401)
  })

  it('404 when the agent_id does not exist', async () => {
    const db = defaultDb()
    const res = await post('/detach', TOKEN_A, { agent_id: 'ghost' }, makeEnv(db))
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('not_found_or_not_owner')
  })

  it('200 + status=stopped when agent detaches its own row', async () => {
    const db = defaultDb()
    const e = makeEnv(db)
    // Attach first.
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, e)
    expect(db._fleet.get('t:kasra')!.status).toBe('running')

    // Detach.
    const res = await post('/detach', TOKEN_A, { agent_id: 'kasra' }, e)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
    expect(db._fleet.get('t:kasra')!.status).toBe('stopped')
  })

  it('SECURITY: agent B cannot detach agent A row (ownership gate → 404, no mutation)', async () => {
    const db = defaultDb()
    const e = makeEnv(db)
    // Agent A attaches itself.
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, e)
    const rowBefore = { ...db._fleet.get('t:kasra')! }

    // Agent B tries to detach kasra (owned by m-a, not m-b).
    const res = await post('/detach', TOKEN_B, { agent_id: 'kasra' }, e)
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('not_found_or_not_owner')

    // Row must be UNCHANGED — no mutation on ownership mismatch.
    const rowAfter = db._fleet.get('t:kasra')!
    expect(rowAfter.status).toBe(rowBefore.status)
    expect(rowAfter.member_id).toBe(rowBefore.member_id)
  })

  it('SECURITY: 404 is deliberately ambiguous (unknown agent vs wrong owner same response)', async () => {
    // A non-existent agent_id and a cross-member agent_id both return 404 not_found_or_not_owner.
    // This prevents callers from inferring which agent_ids belong to which members.
    const db = makeDb({
      members: [MEMBER_A, MEMBER_B],
      tokens: {
        [hashA]: { member_id: 'm-a', display_name: 'A', email: null, status: 'active', bound_agent_id: null },
        [hashB]: { member_id: 'm-b', display_name: 'B', email: null, status: 'active', bound_agent_id: null },
      },
      fleet: [{
        agent_id: 'owned-by-a', tenant: 't', display: '', runtime: 'claude-code', squads: '[]',
        lifecycle: 'on_demand', provider_contract: null, status: 'running', reported_by: 'm-a',
        last_reported_at: 'now', updated_at: 'now', agent_type: 'builder', member_id: 'm-a',
      }],
    })
    const e = makeEnv(db)
    // Non-existent agent.
    const r1 = await post('/detach', TOKEN_A, { agent_id: 'ghost' }, e)
    expect(r1.status).toBe(404)
    expect(((await r1.json()) as { error: string }).error).toBe('not_found_or_not_owner')
    // Existing agent owned by a different member.
    const r2 = await post('/detach', TOKEN_B, { agent_id: 'owned-by-a' }, e)
    expect(r2.status).toBe(404)
    expect(((await r2.json()) as { error: string }).error).toBe('not_found_or_not_owner')
    // Original row still running.
    expect(db._fleet.get('t:owned-by-a')!.status).toBe('running')
  })

  it('400 on bad agent_id in detach', async () => {
    const db = defaultDb()
    const res = await post('/detach', TOKEN_A, { agent_id: '../escape' }, makeEnv(db))
    expect(res.status).toBe(400)
  })

  it('tenant-scoped: detach by token-A on tA does not touch the same agent_id on tB', async () => {
    const db = defaultDb()
    // Attach kasra on both tenants as different members.
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db, { TENANT_SLUG: 'tA' }))
    await post('/attach', TOKEN_A, { agent_id: 'kasra', type: 'brain', runtime: 'nous' }, makeEnv(db, { TENANT_SLUG: 'tB' }))

    // Detach only on tA.
    const res = await post('/detach', TOKEN_A, { agent_id: 'kasra' }, makeEnv(db, { TENANT_SLUG: 'tA' }))
    expect(res.status).toBe(200)
    expect(db._fleet.get('tA:kasra')!.status).toBe('stopped')
    // tB row is untouched.
    expect(db._fleet.get('tB:kasra')!.status).toBe('running')
  })
})
