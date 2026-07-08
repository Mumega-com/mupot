// tests/fleet-attach-signed.test.ts — Ed25519 signed attach/detach (the no-bearer cutover path).
//
// Security properties under test:
//   - A VALID signature over the canonical, tenant-bound message → 200 + running row,
//     member_id taken from agent_keys (NOT the body).
//   - REPLAY: re-sending the same signed body (same nonce) → 409 (nonce burned once).
//   - STALE/FUTURE ts (outside ±window) → 401.
//   - NO registered key for the agent → 401 (no key-existence oracle).
//   - TAMPERED field (runtime changed after signing) → 401.
//   - CROSS-TENANT replay (sig made for tenant A, verified on pot B) → 401.
//   - DOWNGRADE block: an agent WITH a registered key is refused on the bearer /attach (403).
//   - body member_id is ignored (identity is key-bound).

import { describe, it, expect } from 'vitest'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import type { Env } from '../src/types'

const SIG_DOMAIN = 'fleet-attach:v1'
const DETACH_SIG_DOMAIN = 'fleet-detach:v1'
const canon = (p: Record<string, string | number>) =>
  [SIG_DOMAIN, p.tenant, p.agent_id, p.type, p.runtime, p.lifecycle, String(p.ts), p.nonce].join('\n')
const canonDetach = (p: Record<string, string | number>) =>
  [DETACH_SIG_DOMAIN, p.tenant, p.agent_id, String(p.ts), p.nonce].join('\n')

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')

// ── mock DB: agent_keys + nonce ledger + fleet upsert + member_tokens (for downgrade) ──

interface KeyRow { pubkey: string; algo: string; member_id: string | null }

function makeDb(opts: {
  keys?: Record<string, KeyRow>            // `${tenant}:${agent_id}` → KeyRow
  tokens?: Record<string, { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }>
} = {}) {
  const keys = opts.keys ?? {}
  const tokens = opts.tokens ?? {}
  const nonces = new Map<string, number>()   // nonce → created_at (faithful: prune applies)
  const fleet = new Map<string, Record<string, unknown>>()
  const meta = { pruneCutoff: -1 }            // last DELETE cutoff (for the retention assertion)

  function first(sql: string, b: unknown[]) {
    if (sql.includes('FROM agent_keys WHERE tenant')) {
      // both the full SELECT (signed verify) and `SELECT 1 AS x` (downgrade check)
      const row = keys[`${b[0]}:${b[1]}`]
      if (sql.includes('SELECT 1')) return row ? { x: 1 } : null
      return row ?? null
    }
    if (sql.includes('FROM member_tokens t')) return tokens[b[0] as string] ?? null
    if (sql.includes('FROM members WHERE id')) return null
    throw new Error('unhandled first: ' + sql)
  }
  function all(sql: string, b: unknown[]) {
    if (sql.includes('LEFT JOIN members m ON m.id')) {
      return [...fleet.values()].filter((r) => r.tenant === b[0]).map((r) => ({
        agent_id: r.agent_id, agent_type: r.agent_type, runtime: r.runtime, status: r.status,
        lifecycle: r.lifecycle, last_reported_at: r.last_reported_at, member_id: r.member_id,
        m_id: null, m_email: null, m_display: null,
      }))
    }
    if (sql.includes('capabilities')) return []
    throw new Error('unhandled all: ' + sql)
  }
  function run(sql: string, b: unknown[]) {
    if (sql.includes('DELETE FROM agent_attach_nonces')) {
      const cutoff = b[0] as number
      meta.pruneCutoff = cutoff
      for (const [n, created] of nonces) if (created < cutoff) nonces.delete(n)
      return { meta: { changes: 0 } }
    }
    if (sql.includes('INSERT OR IGNORE INTO agent_attach_nonces')) {
      const [n, , created] = b as [string, string, number]
      if (nonces.has(n)) return { meta: { changes: 0 } }   // replay
      nonces.set(n, created)
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, runtime, lifecycle, reported_by, agent_type, member_id] = b as Array<string | null>
      fleet.set(`${tenant}:${agent_id}`, {
        agent_id, tenant, runtime, lifecycle, status: 'running',
        reported_by, agent_type, member_id: member_id ?? null, last_reported_at: 'now',
      })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE fleet_agents')) {
      const [tenant, agent_id, member_id] = b as [string, string, string | null]
      const row = fleet.get(`${tenant}:${agent_id}`)
      if (!row) return { meta: { changes: 0 } }
      if (member_id === null ? row.member_id !== null : row.member_id !== member_id) {
        return { meta: { changes: 0 } }
      }
      row.status = 'stopped'
      row.last_reported_at = 'now'
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE members SET tenant')) return { meta: { changes: 0 } }
    throw new Error('unhandled run: ' + sql)
  }
  return {
    _fleet: fleet,
    _meta: meta,
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
}
const makeEnv = (db: ReturnType<typeof makeDb>, tenant = 'mumega'): Env =>
  ({ TENANT_SLUG: tenant, DB: db } as unknown as Env)

// ── helpers: generate a key, register its pubkey, build a signed body ─────────────────

async function genKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { kp, pubX: (pub as JsonWebKey).x as string }
}
async function sign(privKey: CryptoKey, p: Record<string, string | number>) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, new TextEncoder().encode(canon(p)))
  return b64url(sig)
}
async function signDetach(privKey: CryptoKey, p: Record<string, string | number>) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, new TextEncoder().encode(canonDetach(p)))
  return b64url(sig)
}
function freshBody(agent_id: string, tenant: string, over: Record<string, unknown> = {}) {
  return {
    agent_id, type: 'builder', runtime: 'claude-code', lifecycle: 'on_demand',
    ts: Math.floor(Date.now() / 1000),
    nonce: b64url(crypto.getRandomValues(new Uint8Array(32))),
    ...over,
  }
}
function freshDetachBody(agent_id: string, over: Record<string, unknown> = {}) {
  return {
    agent_id,
    ts: Math.floor(Date.now() / 1000),
    nonce: b64url(crypto.getRandomValues(new Uint8Array(32))),
    ...over,
  }
}
const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fleetAttachApp.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, env)

// ── tests ─────────────────────────────────────────────────────────────────────────

describe('signed attach', () => {
  it('valid signature → 200, running row, key-bound member_id (not body)', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-kasra' } } })
    const env = makeEnv(db)
    const body = freshBody('kasra', 'mumega', { member_id: 'ATTACKER' })
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })

    const res = await post(env, '/attach-signed', body)
    expect(res.status).toBe(200)
    const row = db._fleet.get('mumega:kasra')!
    expect(row.status).toBe('running')
    expect(row.member_id).toBe('m-kasra')        // from agent_keys, NOT body 'ATTACKER'
    expect(row.runtime).toBe('claude-code')
  })

  it('replay (same nonce) → 409', async () => {
    const { kp, pubX } = await genKey()
    const env = makeEnv(makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } }))
    const body = freshBody('kasra', 'mumega')
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })

    expect((await post(env, '/attach-signed', body)).status).toBe(200)
    const replay = await post(env, '/attach-signed', body)
    expect(replay.status).toBe(409)
  })

  it('stale ts (outside window) → 401', async () => {
    const { kp, pubX } = await genKey()
    const env = makeEnv(makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } }))
    const body = freshBody('kasra', 'mumega', { ts: Math.floor(Date.now() / 1000) - 4000 })
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    expect((await post(env, '/attach-signed', body)).status).toBe(401)
  })

  it('no registered key → 401 (no oracle)', async () => {
    const { kp } = await genKey()
    const env = makeEnv(makeDb({ keys: {} }))
    const body = freshBody('kasra', 'mumega')
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    expect((await post(env, '/attach-signed', body)).status).toBe(401)
  })

  it('tampered runtime after signing → 401', async () => {
    const { kp, pubX } = await genKey()
    const env = makeEnv(makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } }))
    const body = freshBody('kasra', 'mumega')
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    ;(body as Record<string, unknown>).runtime = 'codex'   // change AFTER signing
    expect((await post(env, '/attach-signed', body)).status).toBe(401)
  })

  it('cross-tenant: sig made for mumega, verified on viamar pot → 401', async () => {
    const { kp, pubX } = await genKey()
    // viamar pot has NO key for kasra → 401 regardless; also prove the bytes differ.
    const env = makeEnv(makeDb({ keys: { 'viamar:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } }), 'viamar')
    const body = freshBody('kasra', 'mumega')              // signed FOR mumega
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    // pot is viamar → canonical message uses tenant 'viamar' → signature mismatch
    expect((await post(env, '/attach-signed', body)).status).toBe(401)
  })

  it('downgrade block: agent with a registered key is refused on bearer /attach (403)', async () => {
    const { pubX } = await genKey()
    const tokenHash = await sha256Hex('token-kasra')
    const db = makeDb({
      keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-kasra' } },
      tokens: { [tokenHash]: { member_id: 'm-kasra', display_name: 'Kasra', email: null, status: 'active', bound_agent_id: 'kasra' } },
    })
    const env = makeEnv(db)
    const res = await post(env, '/attach', { agent_id: 'kasra', type: 'builder', runtime: 'claude-code' },
      { authorization: 'Bearer token-kasra' })
    expect(res.status).toBe(403)
    const j = await res.json() as { detail?: string }
    expect(j.detail).toContain('signed attach')
  })

  it('P1: nonce retention horizon is 2×window (covers future-dated ts validity span)', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } })
    const env = makeEnv(db)
    const body = freshBody('kasra', 'mumega')
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    await post(env, '/attach-signed', body)
    const nowSec = Math.floor(Date.now() / 1000)
    // Prune cutoff must be ≈ now − 2*300 = now − 600. A 1*window (now − 300) horizon would
    // reap a nonce while a future-dated signature (ts up to now+300) is still fresh → replay.
    const age = nowSec - db._meta.pruneCutoff
    expect(age).toBeGreaterThanOrEqual(590)
    expect(age).toBeLessThanOrEqual(610)
  })

  it('tampered lifecycle after signing → 401 (lifecycle is signed)', async () => {
    const { kp, pubX } = await genKey()
    const env = makeEnv(makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } }))
    const body = freshBody('kasra', 'mumega')  // signed with lifecycle=on_demand
    ;(body as Record<string, unknown>).sig = await sign(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    ;(body as Record<string, unknown>).lifecycle = 'always_on'   // mutate AFTER signing
    expect((await post(env, '/attach-signed', body)).status).toBe(401)
  })
})

describe('signed detach', () => {
  it('valid signature → 200 and stopped row for the key-bound member', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-kasra' } } })
    const env = makeEnv(db)
    db._fleet.set('mumega:kasra', {
      agent_id: 'kasra',
      tenant: 'mumega',
      runtime: 'claude-code',
      lifecycle: 'on_demand',
      status: 'running',
      reported_by: 'm-kasra',
      agent_type: 'builder',
      member_id: 'm-kasra',
      last_reported_at: 'before',
    })

    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    const res = await post(env, '/detach-signed', body)
    expect(res.status).toBe(200)
    expect(db._fleet.get('mumega:kasra')!.status).toBe('stopped')
  })

  it('valid signature can stop a null-owned legacy key row', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } })
    const env = makeEnv(db)
    db._fleet.set('mumega:kasra', {
      agent_id: 'kasra',
      tenant: 'mumega',
      runtime: 'claude-code',
      lifecycle: 'on_demand',
      status: 'running',
      reported_by: null,
      agent_type: 'builder',
      member_id: null,
      last_reported_at: 'before',
    })

    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    expect((await post(env, '/detach-signed', body)).status).toBe(200)
    expect(db._fleet.get('mumega:kasra')!.status).toBe('stopped')
  })

  it('replay of the same signed detach body → 409', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: null } } })
    const env = makeEnv(db)
    db._fleet.set('mumega:kasra', {
      agent_id: 'kasra',
      tenant: 'mumega',
      runtime: 'claude-code',
      lifecycle: 'on_demand',
      status: 'running',
      reported_by: null,
      agent_type: 'builder',
      member_id: null,
      last_reported_at: 'before',
    })
    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })

    expect((await post(env, '/detach-signed', body)).status).toBe(200)
    expect((await post(env, '/detach-signed', body)).status).toBe(409)
  })

  it('tampered agent_id after signing → 401 and row unchanged', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({
      keys: {
        'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-kasra' },
        'mumega:loom': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-loom' },
      },
    })
    const env = makeEnv(db)
    db._fleet.set('mumega:loom', {
      agent_id: 'loom',
      tenant: 'mumega',
      runtime: 'codex',
      lifecycle: 'on_demand',
      status: 'running',
      reported_by: 'm-loom',
      agent_type: 'reviewer',
      member_id: 'm-loom',
      last_reported_at: 'before',
    })
    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    ;(body as Record<string, unknown>).agent_id = 'loom'

    expect((await post(env, '/detach-signed', body)).status).toBe(401)
    expect(db._fleet.get('mumega:loom')!.status).toBe('running')
  })

  it('member mismatch returns 404 and does not stop the row', async () => {
    const { kp, pubX } = await genKey()
    const db = makeDb({ keys: { 'mumega:kasra': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-new' } } })
    const env = makeEnv(db)
    db._fleet.set('mumega:kasra', {
      agent_id: 'kasra',
      tenant: 'mumega',
      runtime: 'claude-code',
      lifecycle: 'on_demand',
      status: 'running',
      reported_by: 'm-old',
      agent_type: 'builder',
      member_id: 'm-old',
      last_reported_at: 'before',
    })
    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })

    expect((await post(env, '/detach-signed', body)).status).toBe(404)
    expect(db._fleet.get('mumega:kasra')!.status).toBe('running')
  })

  it('no registered key → 401', async () => {
    const { kp } = await genKey()
    const env = makeEnv(makeDb({ keys: {} }))
    const body = freshDetachBody('kasra')
    ;(body as Record<string, unknown>).sig = await signDetach(kp.privateKey, { ...(body as Record<string, string | number>), tenant: 'mumega' })
    expect((await post(env, '/detach-signed', body)).status).toBe(401)
  })
})
