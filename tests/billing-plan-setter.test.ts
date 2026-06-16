// billing-plan-setter.test.ts — POST /api/billing/plan (HMAC + audience + replay/order).
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

// In-memory org_settings so getJSON/setSetting/setJSON behave realistically.
function makeEnv(secret: string | undefined, tenant = TENANT) {
  const store = new Map<string, string>()
  const db = {
    prepare(sql: string) {
      const isSelect = sql.includes('SELECT')
      return {
        bind(...args: string[]) {
          const key = args[0]
          const value = args[1]
          return {
            first: async () => (store.has(key) ? { value: store.get(key) } : null),
            run: async () => {
              if (!isSelect) store.set(key, value)
              return {}
            },
            all: async () => ({ results: [] }),
          }
        },
      }
    },
  }
  return { env: { BILLING_PLAN_SECRET: secret, TENANT_SLUG: tenant, DB: db }, store }
}

async function post(body: string, sig: string | null, env: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sig !== null) headers['x-mupot-signature'] = sig
  return billingAdminApp.request('/plan', { method: 'POST', body, headers }, env as never)
}

function evt(over: Record<string, unknown> = {}) {
  return JSON.stringify({ tenant: TENANT, tier: 'pro', event_id: 'evt_1', effective_at: 1000, ...over })
}

describe('POST /api/billing/plan — auth + audience + replay', () => {
  it('503 when BILLING_PLAN_SECRET is not configured', async () => {
    const { env } = makeEnv(undefined)
    expect((await post(evt(), 'x', env)).status).toBe(503)
  })

  it('401 on missing or wrong signature (no write)', async () => {
    const { env, store } = makeEnv(SECRET)
    expect((await post(evt(), null, env)).status).toBe(401)
    expect((await post(evt(), 'deadbeef', env)).status).toBe(401)
    expect(store.get('plan_tier')).toBeUndefined()
  })

  it('413 on oversized body', async () => {
    const { env } = makeEnv(SECRET)
    const big = evt({ reason: 'x'.repeat(5000) })
    expect((await post(big, await sign(big), env)).status).toBe(413)
  })

  it('403 wrong_tenant — signed body for another pot does not write', async () => {
    const { env, store } = makeEnv(SECRET, 'mumega')
    const body = evt({ tenant: 'viamar' }) // addressed to a different pot
    const res = await post(body, await sign(body), env)
    expect(res.status).toBe(403)
    expect(store.get('plan_tier')).toBeUndefined()
  })

  it('400 invalid tier / missing event_id / missing effective_at', async () => {
    const { env } = makeEnv(SECRET)
    for (const over of [{ tier: 'enterprise' }, { event_id: '' }, { effective_at: 'soon' }]) {
      const b = evt(over)
      expect((await post(b, await sign(b), env)).status).toBe(400)
    }
  })

  it('200 + writes plan_tier on a valid signed, tenant-bound, fresh event', async () => {
    const { env, store } = makeEnv(SECRET)
    const body = evt({ tier: 'pro', event_id: 'evt_up', effective_at: 2000 })
    const res = await post(body, await sign(body), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, tier: 'pro', applied: true })
    expect(store.get('plan_tier')).toBe('pro')
  })

  it('idempotent — replaying the same event_id does not re-apply', async () => {
    const { env, store } = makeEnv(SECRET)
    const body = evt({ tier: 'pro', event_id: 'evt_dup', effective_at: 2000 })
    await post(body, await sign(body), env)
    const res2 = await post(body, await sign(body), env)
    expect(res2.status).toBe(200)
    expect(await res2.json()).toMatchObject({ applied: false, reason: 'duplicate_event' })
    expect(store.get('plan_tier')).toBe('pro')
  })

  it('stale — an older effective_at cannot roll back a newer plan', async () => {
    const { env, store } = makeEnv(SECRET)
    const up = evt({ tier: 'pro', event_id: 'evt_new', effective_at: 3000 })
    await post(up, await sign(up), env)
    const stale = evt({ tier: 'free', event_id: 'evt_old', effective_at: 1000 }) // older
    const res = await post(stale, await sign(stale), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: false, reason: 'stale_event' })
    expect(store.get('plan_tier')).toBe('pro') // not rolled back to free
  })
})
