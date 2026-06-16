// billing-plan-setter.test.ts — POST /api/billing/plan: HMAC + audience + atomic CAS.
// The in-memory mock evaluates the same freshness condition the single conditional
// upsert (ON CONFLICT DO UPDATE ... WHERE) enforces atomically in real D1.
import { describe, it, expect } from 'vitest'
import { billingAdminApp } from '../src/billing/admin'

const SECRET = 'test-billing-secret'
const TENANT = 'mumega'

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Mock org_settings billing_state row + the conditional-upsert semantics.
function makeEnv(secret: string | undefined, tenant = TENANT) {
  const box: { row: { value: string } | null } = { row: null }
  const db = {
    prepare(sql: string) {
      const isInsert = sql.includes('INSERT')
      return {
        bind(...args: string[]) {
          const value = args[1]
          return {
            first: async () => box.row,
            run: async () => {
              if (!isInsert) return { meta: { changes: 0 } }
              if (!box.row) {
                box.row = { value }
                return { meta: { changes: 1 } }
              }
              const ex = JSON.parse(box.row.value)
              const nw = JSON.parse(value)
              if (nw.event_id !== ex.event_id && nw.effective_at > ex.effective_at) {
                box.row = { value }
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 0 } }
            },
          }
        },
      }
    },
  }
  return { env: { BILLING_PLAN_SECRET: secret, TENANT_SLUG: tenant, DB: db }, box }
}

function tierOf(box: { row: { value: string } | null }): string | undefined {
  return box.row ? (JSON.parse(box.row.value).tier as string) : undefined
}

async function post(body: string, sig: string | null, env: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sig !== null) headers['x-mupot-signature'] = sig
  return billingAdminApp.request('/plan', { method: 'POST', body, headers }, env as never)
}

function evt(over: Record<string, unknown> = {}) {
  return JSON.stringify({ tenant: TENANT, tier: 'pro', event_id: 'evt_1', effective_at: 1000, ...over })
}
async function send(env: unknown, over: Record<string, unknown> = {}) {
  const body = evt(over)
  return post(body, await sign(body), env)
}

describe('POST /api/billing/plan — auth + audience + atomic CAS', () => {
  it('503 when unconfigured', async () => {
    const { env } = makeEnv(undefined)
    expect((await send(env)).status).toBe(503)
  })

  it('401 on missing/wrong signature (no write)', async () => {
    const { env, box } = makeEnv(SECRET)
    expect((await post(evt(), null, env)).status).toBe(401)
    expect((await post(evt(), 'deadbeef', env)).status).toBe(401)
    expect(tierOf(box)).toBeUndefined()
  })

  it('413 on oversized body', async () => {
    const { env } = makeEnv(SECRET)
    expect((await send(env, { reason: 'x'.repeat(5000) })).status).toBe(413)
  })

  it('403 wrong_tenant — signed for another pot does not write', async () => {
    const { env, box } = makeEnv(SECRET)
    const res = await send(env, { tenant: 'viamar' })
    expect(res.status).toBe(403)
    expect(tierOf(box)).toBeUndefined()
  })

  it('400 invalid tier / event_id / effective_at', async () => {
    const { env } = makeEnv(SECRET)
    for (const over of [{ tier: 'enterprise' }, { event_id: '' }, { effective_at: 'soon' }]) {
      expect((await send(env, over)).status).toBe(400)
    }
  })

  it('200 + applies on a valid fresh event', async () => {
    const { env, box } = makeEnv(SECRET)
    const res = await send(env, { tier: 'pro', event_id: 'up', effective_at: 2000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, tier: 'pro', applied: true })
    expect(tierOf(box)).toBe('pro')
  })

  it('idempotent — duplicate event_id is a no-op', async () => {
    const { env, box } = makeEnv(SECRET)
    await send(env, { tier: 'pro', event_id: 'dup', effective_at: 2000 })
    const res = await send(env, { tier: 'free', event_id: 'dup', effective_at: 2000 }) // same id
    expect(await res.json()).toMatchObject({ applied: false })
    expect(tierOf(box)).toBe('pro')
  })

  it('stale — older effective_at cannot roll back a newer plan', async () => {
    const { env, box } = makeEnv(SECRET)
    await send(env, { tier: 'pro', event_id: 'new', effective_at: 3000 })
    const res = await send(env, { tier: 'free', event_id: 'old', effective_at: 1000 })
    expect(await res.json()).toMatchObject({ applied: false })
    expect(tierOf(box)).toBe('pro')
  })

  it('interleaving — newer always wins regardless of arrival order', async () => {
    const { env, box } = makeEnv(SECRET)
    // older arrives first → applies
    await send(env, { tier: 'starter', event_id: 'a', effective_at: 1000 })
    expect(tierOf(box)).toBe('starter')
    // newer arrives → applies
    await send(env, { tier: 'pro', event_id: 'b', effective_at: 3000 })
    expect(tierOf(box)).toBe('pro')
    // the older one replayed after the newer → no-op, no rollback
    const res = await send(env, { tier: 'starter', event_id: 'a', effective_at: 1000 })
    expect(await res.json()).toMatchObject({ applied: false })
    expect(tierOf(box)).toBe('pro')
  })
})
