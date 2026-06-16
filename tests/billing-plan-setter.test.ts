// billing-plan-setter.test.ts — POST /api/billing/plan (HMAC-authed plan writer).
import { describe, it, expect } from 'vitest'
import { billingAdminApp } from '../src/billing/admin'

const SECRET = 'test-billing-secret'

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Minimal env: a DB whose setSetting write we capture, + the billing secret.
function makeEnv(secret: string | undefined, captured?: { key?: string; value?: string }) {
  return {
    BILLING_PLAN_SECRET: secret,
    DB: {
      prepare: () => ({
        bind: (key: string, value: string) => {
          if (captured) {
            captured.key = key
            captured.value = value
          }
          return { run: async () => ({}) }
        },
      }),
    },
  } as unknown as Parameters<typeof billingAdminApp.request>[2]
}

async function post(body: string, sig: string | null, env: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sig !== null) headers['x-mupot-signature'] = sig
  return billingAdminApp.request('/plan', { method: 'POST', body, headers }, env as never)
}

describe('POST /api/billing/plan', () => {
  it('503 when BILLING_PLAN_SECRET is not configured', async () => {
    const res = await post(JSON.stringify({ tier: 'pro' }), 'x', makeEnv(undefined))
    expect(res.status).toBe(503)
  })

  it('401 when signature is missing', async () => {
    const res = await post(JSON.stringify({ tier: 'pro' }), null, makeEnv(SECRET))
    expect(res.status).toBe(401)
  })

  it('401 when signature is wrong', async () => {
    const res = await post(JSON.stringify({ tier: 'pro' }), 'deadbeef', makeEnv(SECRET))
    expect(res.status).toBe(401)
  })

  it('400 on a valid signature but invalid tier', async () => {
    const body = JSON.stringify({ tier: 'enterprise' }) // not a PotTier
    const res = await post(body, await sign(body), makeEnv(SECRET))
    expect(res.status).toBe(400)
  })

  it('200 + writes plan_tier on a valid signed request', async () => {
    const captured: { key?: string; value?: string } = {}
    const body = JSON.stringify({ tier: 'pro', reason: 'stripe sub active' })
    const res = await post(body, await sign(body), makeEnv(SECRET, captured))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, tier: 'pro' })
    expect(captured.key).toBe('plan_tier')
    expect(captured.value).toBe('pro')
  })

  it('does NOT write when the signature is bad (auth before any write)', async () => {
    const captured: { key?: string; value?: string } = {}
    const body = JSON.stringify({ tier: 'scale' })
    await post(body, 'badbadbad', makeEnv(SECRET, captured))
    expect(captured.key).toBeUndefined() // no setSetting reached
  })
})
