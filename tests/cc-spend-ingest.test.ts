// cc-spend-ingest.test.ts — POST /api/economy/cc-spend (#179): HMAC + audience +
// freshness-guarded batch upsert + fail-closed row validation.
// The in-memory mock evaluates the same `updated_at` monotonic guard the real D1
// conditional upsert (ON CONFLICT DO UPDATE ... WHERE excluded.updated_at >= …)
// enforces, so a stale/out-of-order push is a per-row no-op.
import { describe, it, expect } from 'vitest'
import { ccSpendApp } from '../src/economy/cc-spend'

const SECRET = 'test-cc-spend-secret'
const TENANT = 'mumega'

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Stored {
  usd_micro: number
  updated_at: string
}
// Mock DB: a map keyed by (date|agent|model_family). prepare().bind() captures the
// row's args; DB.batch() applies each with the freshness guard.
function makeEnv(secret: string | undefined, tenant = TENANT) {
  const store = new Map<string, Stored>()
  const db = {
    prepare(_sql: string) {
      return {
        bind(...a: unknown[]) {
          // arg order matches the INSERT: date, agent, model_family, in, out, cw, cr, usd, turns, updated_at
          return { __row: { key: `${a[0]}|${a[1]}|${a[2]}`, usd_micro: a[7] as number, updated_at: a[9] as string } }
        },
      }
    },
    async batch(stmts: Array<{ __row: { key: string; usd_micro: number; updated_at: string } }>) {
      for (const s of stmts) {
        const r = s.__row
        const ex = store.get(r.key)
        // WHERE excluded.updated_at >= cc_spend_daily.updated_at
        if (!ex || r.updated_at >= ex.updated_at) {
          store.set(r.key, { usd_micro: r.usd_micro, updated_at: r.updated_at })
        }
      }
      return []
    },
  }
  return { env: { CC_SPEND_SECRET: secret, TENANT_SLUG: tenant, DB: db }, store }
}

function row(over: Record<string, unknown> = {}) {
  return {
    date: '2026-06-16',
    agent: 'kasra',
    model_family: 'opus',
    input_tokens: 100,
    output_tokens: 200,
    cache_write_tokens: 50,
    cache_read_tokens: 1000,
    usd_micro: 5_000_000,
    turns: 3,
    ...over,
  }
}
function payload(over: Record<string, unknown> = {}) {
  return JSON.stringify({ tenant: TENANT, generated_at: '2026-06-16T20:00:00Z', rows: [row()], ...over })
}
async function post(body: string, sig: string | null, env: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sig !== null) headers['x-mupot-signature'] = sig
  return ccSpendApp.request('/cc-spend', { method: 'POST', body, headers }, env as never)
}
async function send(env: unknown, over: Record<string, unknown> = {}) {
  const body = payload(over)
  return post(body, await sign(body), env)
}

describe('POST /api/economy/cc-spend — auth + audience + freshness + validation', () => {
  it('503 when unconfigured', async () => {
    const { env } = makeEnv(undefined)
    expect((await send(env)).status).toBe(503)
  })

  it('401 on missing/wrong signature (no write)', async () => {
    const { env, store } = makeEnv(SECRET)
    expect((await post(payload(), null, env)).status).toBe(401)
    expect((await post(payload(), 'deadbeef', env)).status).toBe(401)
    expect(store.size).toBe(0)
  })

  it('413 on oversized body', async () => {
    const { env } = makeEnv(SECRET)
    const big = JSON.stringify({ tenant: TENANT, generated_at: '2026-06-16T20:00:00Z', rows: [row({ agent: 'x'.repeat(300_000) })] })
    expect((await post(big, await sign(big), env)).status).toBe(413)
  })

  it('403 wrong_tenant — a push signed for another pot does not write', async () => {
    const { env, store } = makeEnv(SECRET)
    expect((await send(env, { tenant: 'viamar' })).status).toBe(403)
    expect(store.size).toBe(0)
  })

  it('400 missing generated_at', async () => {
    const { env } = makeEnv(SECRET)
    const body = JSON.stringify({ tenant: TENANT, rows: [row()] })
    expect((await post(body, await sign(body), env)).status).toBe(400)
  })

  it('200 happy path writes the row', async () => {
    const { env, store } = makeEnv(SECRET)
    const res = await send(env)
    expect(res.status).toBe(200)
    expect((await res.json() as { rows: number }).rows).toBe(1)
    expect(store.get('2026-06-16|kasra|opus')?.usd_micro).toBe(5_000_000)
  })

  it('rejects the WHOLE batch on any invalid row (fail-closed, no partial write)', async () => {
    const { env, store } = makeEnv(SECRET)
    const bad = { tenant: TENANT, generated_at: '2026-06-16T20:00:00Z', rows: [row(), row({ usd_micro: -1 })] }
    const body = JSON.stringify(bad)
    expect((await post(body, await sign(body), env)).status).toBe(400)
    expect(store.size).toBe(0) // the valid sibling row must NOT have persisted
  })

  it('rejects an unknown model_family', async () => {
    const { env } = makeEnv(SECRET)
    const body = JSON.stringify({ tenant: TENANT, generated_at: '2026-06-16T20:00:00Z', rows: [row({ model_family: 'gpt' })] })
    expect((await post(body, await sign(body), env)).status).toBe(400)
  })

  it('rejects a non-integer token count', async () => {
    const { env } = makeEnv(SECRET)
    const body = JSON.stringify({ tenant: TENANT, generated_at: '2026-06-16T20:00:00Z', rows: [row({ input_tokens: 1.5 })] })
    expect((await post(body, await sign(body), env)).status).toBe(400)
  })

  it('a fresher push updates; a STALE push is a per-row no-op (freshness guard)', async () => {
    const { env, store } = makeEnv(SECRET)
    // initial @ 20:00 = $5
    await send(env, { generated_at: '2026-06-16T20:00:00Z' })
    // fresher @ 21:00 = $9 → updates
    await send(env, { generated_at: '2026-06-16T21:00:00Z', rows: [row({ usd_micro: 9_000_000 })] })
    expect(store.get('2026-06-16|kasra|opus')?.usd_micro).toBe(9_000_000)
    // stale @ 19:00 = $1 → must NOT regress
    const res = await send(env, { generated_at: '2026-06-16T19:00:00Z', rows: [row({ usd_micro: 1_000_000 })] })
    expect(res.status).toBe(200) // still handled (idempotent no-op)
    expect(store.get('2026-06-16|kasra|opus')?.usd_micro).toBe(9_000_000)
  })

  it('accepts an empty rows array (no-op push)', async () => {
    const { env } = makeEnv(SECRET)
    const res = await send(env, { rows: [] })
    expect(res.status).toBe(200)
  })
})
