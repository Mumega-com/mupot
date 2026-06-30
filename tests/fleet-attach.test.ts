// tests/fleet-attach.test.ts — agent self-attach / self-detach routes (Step 2a).
//
// Security properties under test:
//   BLOCK-1 (strong): token.boundAgentId MUST equal body.agent_id on BOTH routes.
//     - A token bound to 'loom' can only attach/detach agent_id='loom'.
//     - A pure member token (boundAgentId=null) is rejected (403) on any attach/detach.
//     - member_id is always auth-derived (body member_id silently discarded).
//   WARN-1: body > 8 KB → 413 {error:'payload_too_large'} on both routes.
//   Detach: WHERE member_id=auth clause as defense-in-depth (404 on member mismatch).
//   All writes are tenant-scoped.

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
  member_id: string; display_name: string; email: string | null
  status: string; bound_agent_id: string | null
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

  for (const r of (opts.fleet ?? [])) {
    fleet.set(`${r.tenant}:${r.agent_id}`, r)
  }

  function first(sql: string, binds: unknown[]) {
    if (sql.includes('FROM member_tokens t')) {
      return tokens[binds[0] as string] ?? null
    }
    // Downgrade-block check (hasRegisteredKey): no signed-attach key registered in these
    // bearer-path tests → null → bearer /attach proceeds as before.
    if (sql.includes('FROM agent_keys')) {
      return null
    }
    if (sql.includes('FROM members WHERE id')) {
      const [id, tenant] = binds as [string, string]
      return members.find((m) => m.id === id && m.tenant === tenant) ? { 1: 1 } : null
    }
    throw new Error('unhandled first: ' + sql)
  }

  function all(sql: string, binds: unknown[]) {
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
    if (sql.includes('capabilities')) {
      const [memberId] = binds as [string]
      return caps.filter((c) => c.member_id === memberId)
    }
    throw new Error('unhandled all: ' + sql)
  }

  function run(sql: string, binds: unknown[]) {
    // fleet_agents INSERT ON CONFLICT upsert (attach).
    // Only 7 bound params: agent_id(?1), tenant(?2), runtime(?3),
    // lifecycle(?4), reported_by(?5), agent_type(?6), member_id(?7).
    // SQL literals: display='', squads='[]', provider_contract=NULL, status='running'.
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, runtime, lifecycle, reported_by, agent_type, member_id]
        = binds as Array<string | null>
      const key = `${tenant}:${agent_id}`
      const existing = fleet.get(key)
      if (existing) {
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
      if (!row || row.member_id !== member_id) return { meta: { changes: 0 } }
      row.status = 'stopped'
      row.last_reported_at = 'now'
      row.updated_at = 'now'
      return { meta: { changes: 1 } }
    }

    // Lazy backfill (getAgentView).
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
//
// TOKEN_KASRA is bound to agent_id='kasra'.
// TOKEN_LOOM  is bound to agent_id='loom'.
// TOKEN_UNBOUND is a pure member token (no agent binding).

const TOKEN_KASRA   = 'token-kasra'
const TOKEN_LOOM    = 'token-loom'
const TOKEN_UNBOUND = 'token-unbound'
let hashKasra   = ''
let hashLoom    = ''
let hashUnbound = ''

beforeAll(async () => {
  hashKasra   = await sha256Hex(TOKEN_KASRA)
  hashLoom    = await sha256Hex(TOKEN_LOOM)
  hashUnbound = await sha256Hex(TOKEN_UNBOUND)
})

const MEMBER_KASRA: MemberRow = { id: 'm-kasra', email: 'kasra@x.com', display_name: 'Kasra', tenant: 't' }
const MEMBER_LOOM:  MemberRow = { id: 'm-loom',  email: 'loom@x.com',  display_name: 'Loom',  tenant: 't' }
const MEMBER_X:     MemberRow = { id: 'm-x',     email: 'x@x.com',     display_name: 'X',     tenant: 't' }

function defaultDb(): ReturnType<typeof makeDb> {
  return makeDb({
    members: [MEMBER_KASRA, MEMBER_LOOM, MEMBER_X],
    tokens: {
      [hashKasra]:   { member_id: 'm-kasra', display_name: 'Kasra', email: 'kasra@x.com', status: 'active', bound_agent_id: 'kasra' },
      [hashLoom]:    { member_id: 'm-loom',  display_name: 'Loom',  email: 'loom@x.com',  status: 'active', bound_agent_id: 'loom'  },
      [hashUnbound]: { member_id: 'm-x',     display_name: 'X',     email: 'x@x.com',     status: 'active', bound_agent_id: null    },
    },
  })
}

// ── request helpers ───────────────────────────────────────────────────────────────

function post(path: string, token: string | null, body: unknown, e: Env) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fleetAttachApp.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, e)
}

function postRaw(path: string, token: string | null, rawBody: string, e: Env) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fleetAttachApp.request(path, { method: 'POST', headers, body: rawBody }, e)
}

// ── POST /attach ─────────────────────────────────────────────────────────────────

describe('POST /attach', () => {

  it('401 when no token is supplied', async () => {
    const db = defaultDb()
    const res = await post('/attach', null, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(401)
    expect(db._fleet.size).toBe(0)
  })

  it('400 on unknown agent type', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'hacker', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  it('400 on bad runtime', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'elixir' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  it('400 on bad agent_id (path traversal)', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_KASRA, { agent_id: '../evil', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(400)
    expect(db._fleet.size).toBe(0)
  })

  // ── BLOCK-1: token binding gate ───────────────────────────────────────────────

  it('BLOCK-1 REGRESSION: token bound to loom cannot attach agent_id=kasra → 403, no mutation', async () => {
    // Token bound to 'loom' attempts to attach as 'kasra'. This is the hijack attempt.
    // Fails-without: old code did a TOFU pre-SELECT, which could still be bypassed on first-claim.
    // Passes-with: boundAgentId check rejects at auth-resolution, before any DB write.
    const db = defaultDb()
    const res = await post('/attach', TOKEN_LOOM, { agent_id: 'kasra', type: 'comms', runtime: 'python' }, makeEnv(db))
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: string; detail: string }
    expect(json.error).toBe('forbidden')
    expect(json.detail).toMatch(/not bound to this agent_id/)
    // No mutation.
    expect(db._fleet.has('t:kasra')).toBe(false)
  })

  it('BLOCK-1: pure member token (boundAgentId=null) cannot attach → 403', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_UNBOUND, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(403)
    expect(db._fleet.size).toBe(0)
  })

  it('BLOCK-1: token bound to kasra CAN attach agent_id=kasra → 200', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code', lifecycle: 'always_on' }, makeEnv(db))
    expect(res.status).toBe(200)
    const row = db._fleet.get('t:kasra')!
    expect(row.status).toBe('running')
    expect(row.agent_type).toBe('builder')
    expect(row.runtime).toBe('claude-code')
    expect(row.lifecycle).toBe('always_on')
    // member_id from auth (not body).
    expect(row.member_id).toBe('m-kasra')
  })

  it('BLOCK-1: token bound to loom CAN attach agent_id=loom → 200', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_LOOM, { agent_id: 'loom', type: 'comms', runtime: 'nous' }, makeEnv(db))
    expect(res.status).toBe(200)
    expect(db._fleet.get('t:loom')!.member_id).toBe('m-loom')
  })

  it('SECURITY: body member_id is silently discarded — stored member is auth-derived', async () => {
    const db = defaultDb()
    // TOKEN_KASRA is bound to kasra; member_id='m-kasra'. Send body member_id='m-loom'.
    const res = await post('/attach', TOKEN_KASRA,
      { agent_id: 'kasra', type: 'builder', runtime: 'claude-code', member_id: 'm-loom' },
      makeEnv(db))
    expect(res.status).toBe(200)
    // Stored member is m-kasra (auth), not m-loom (body).
    expect(db._fleet.get('t:kasra')!.member_id).toBe('m-kasra')
  })

  it('returns the getAgentView boot-ack shape for the attached agent', async () => {
    const db = defaultDb()
    const res = await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      agent: {
        agent_id: string; type: string; runtime: string; status: string
        lifecycle: string; last_seen: string; member: unknown; capabilities: unknown[]
      } | null
    }
    expect(json.ok).toBe(true)
    const a = json.agent!
    expect(a.agent_id).toBe('kasra')
    expect(a.type).toBe('builder')
    expect(a.runtime).toBe('claude-code')
    expect(a.status).toBe('running')
    expect('last_seen' in a).toBe(true)
    expect('member' in a).toBe(true)
    expect(Array.isArray(a.capabilities)).toBe(true)
  })

  it('re-attach by same bound token refreshes an existing row (status back to running)', async () => {
    const db = defaultDb()
    const e = makeEnv(db)
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, e)
    // Manually stop the row.
    db._fleet.get('t:kasra')!.status = 'stopped'
    // Re-attach.
    const res = await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'hermes' }, e)
    expect(res.status).toBe(200)
    expect(db._fleet.get('t:kasra')!.status).toBe('running')
    expect(db._fleet.get('t:kasra')!.runtime).toBe('hermes') // updated
  })

  it('lifecycle defaults to on_demand when omitted', async () => {
    const db = defaultDb()
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'generic', runtime: 'tmux' }, makeEnv(db))
    expect(db._fleet.get('t:kasra')!.lifecycle).toBe('on_demand')
  })

  it('tenant-scoped: same bound token attaches same agent_id on two tenants independently', async () => {
    const db = defaultDb()
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db, { TENANT_SLUG: 'tA' }))
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'reviewer', runtime: 'codex' }, makeEnv(db, { TENANT_SLUG: 'tB' }))
    expect(db._fleet.get('tA:kasra')!.agent_type).toBe('builder')
    expect(db._fleet.get('tB:kasra')!.agent_type).toBe('reviewer')
    expect(db._fleet.size).toBe(2)
  })

  // ── WARN-1: body size cap ─────────────────────────────────────────────────────

  it('WARN-1: 413 when attach body exceeds 8 KB', async () => {
    const db = defaultDb()
    const huge = JSON.stringify({ agent_id: 'kasra', type: 'builder', runtime: 'claude-code', pad: 'x'.repeat(9000) })
    const res = await postRaw('/attach', TOKEN_KASRA, huge, makeEnv(db))
    expect(res.status).toBe(413)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('payload_too_large')
    expect(db._fleet.size).toBe(0) // no mutation before cap check
  })
})

// ── POST /detach ─────────────────────────────────────────────────────────────────

describe('POST /detach', () => {

  it('401 when no token is supplied', async () => {
    const db = defaultDb()
    expect((await post('/detach', null, { agent_id: 'kasra' }, makeEnv(db))).status).toBe(401)
  })

  it('BLOCK-1 REGRESSION: token bound to loom cannot detach kasra → 403, row unchanged', async () => {
    // Set up kasra row so we can verify no mutation.
    const db = makeDb({
      members: [MEMBER_KASRA, MEMBER_LOOM],
      tokens: {
        [hashKasra]: { member_id: 'm-kasra', display_name: 'Kasra', email: null, status: 'active', bound_agent_id: 'kasra' },
        [hashLoom]:  { member_id: 'm-loom',  display_name: 'Loom',  email: null, status: 'active', bound_agent_id: 'loom'  },
      },
      fleet: [{
        agent_id: 'kasra', tenant: 't', display: 'Kasra', runtime: 'claude-code', squads: '[]',
        lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'm-kasra',
        last_reported_at: 'before', updated_at: 'before', agent_type: 'builder', member_id: 'm-kasra',
      }],
    })
    const res = await post('/detach', TOKEN_LOOM, { agent_id: 'kasra' }, makeEnv(db))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('forbidden')
    // Row completely unchanged.
    const row = db._fleet.get('t:kasra')!
    expect(row.status).toBe('running')
    expect(row.member_id).toBe('m-kasra')
  })

  it('BLOCK-1: pure member token (boundAgentId=null) cannot detach → 403', async () => {
    const db = defaultDb()
    const res = await post('/detach', TOKEN_UNBOUND, { agent_id: 'kasra' }, makeEnv(db))
    expect(res.status).toBe(403)
  })

  it('200 + status=stopped when bound token detaches its own row', async () => {
    const db = defaultDb()
    const e = makeEnv(db)
    // Attach first.
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, e)
    expect(db._fleet.get('t:kasra')!.status).toBe('running')
    // Detach.
    const res = await post('/detach', TOKEN_KASRA, { agent_id: 'kasra' }, e)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(db._fleet.get('t:kasra')!.status).toBe('stopped')
  })

  it('404 when the agent row does not exist (bound token, correct agent_id, missing row)', async () => {
    const db = defaultDb()
    // TOKEN_KASRA is bound to 'kasra' but no row exists.
    const res = await post('/detach', TOKEN_KASRA, { agent_id: 'kasra' }, makeEnv(db))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_found_or_not_owner')
  })

  it('defense-in-depth: 404 when member_id mismatch (re-keying scenario)', async () => {
    // Token is correctly bound to 'kasra' but the row's member_id is a different member
    // (e.g., the agent was re-keyed). The WHERE member_id=auth clause catches this.
    const db = makeDb({
      members: [MEMBER_KASRA, MEMBER_X],
      tokens: {
        // TOKEN_KASRA is now bound to 'kasra' but its member is m-x (re-keyed principal).
        [hashKasra]: { member_id: 'm-x', display_name: 'X', email: null, status: 'active', bound_agent_id: 'kasra' },
      },
      fleet: [{
        agent_id: 'kasra', tenant: 't', display: '', runtime: 'claude-code', squads: '[]',
        lifecycle: 'always_on', provider_contract: null, status: 'running', reported_by: 'm-kasra',
        last_reported_at: 'before', updated_at: 'before', agent_type: 'builder',
        // Row still has the old member_id.
        member_id: 'm-kasra',
      }],
    })
    const res = await post('/detach', TOKEN_KASRA, { agent_id: 'kasra' }, makeEnv(db))
    // Passes token binding (boundAgentId='kasra' == 'kasra'), fails member_id WHERE (m-x != m-kasra).
    expect(res.status).toBe(404)
    // Row is NOT stopped (no mutation on member_id mismatch).
    expect(db._fleet.get('t:kasra')!.status).toBe('running')
  })

  it('400 on bad agent_id in detach body', async () => {
    const db = defaultDb()
    const res = await post('/detach', TOKEN_KASRA, { agent_id: '../escape' }, makeEnv(db))
    expect(res.status).toBe(400)
  })

  it('tenant-scoped: detach on tA does not touch same agent_id on tB', async () => {
    const db = defaultDb()
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' }, makeEnv(db, { TENANT_SLUG: 'tA' }))
    await post('/attach', TOKEN_KASRA, { agent_id: 'kasra', type: 'brain',   runtime: 'nous'       }, makeEnv(db, { TENANT_SLUG: 'tB' }))

    const res = await post('/detach', TOKEN_KASRA, { agent_id: 'kasra' }, makeEnv(db, { TENANT_SLUG: 'tA' }))
    expect(res.status).toBe(200)
    expect(db._fleet.get('tA:kasra')!.status).toBe('stopped')
    expect(db._fleet.get('tB:kasra')!.status).toBe('running') // untouched
  })

  // ── WARN-1: body size cap ─────────────────────────────────────────────────────

  it('WARN-1: 413 when detach body exceeds 8 KB', async () => {
    const db = defaultDb()
    const huge = JSON.stringify({ agent_id: 'kasra', pad: 'x'.repeat(9000) })
    const res = await postRaw('/detach', TOKEN_KASRA, huge, makeEnv(db))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('payload_too_large')
  })
})
