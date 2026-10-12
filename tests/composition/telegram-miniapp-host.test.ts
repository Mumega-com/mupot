// tests/composition/telegram-miniapp-host.test.ts — secure moments W4 through the DEPLOYED composition
// (src/index.ts wrapped in OAuthProvider, in workerd): the Mini App routes sit behind the secure-host gate, the flag
// off is a no-op, and Ed25519 initData verification works on the REAL runtime's WebCrypto (not just Node's).
// Contract: docs/architecture/secure-moments.md (W4).
import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { linkLoginIdentity } from '../../src/auth/login-identity'
import { consumeMomentTelegram, mintTgEnrolmentToken } from '../../src/secure-moments/telegram-miniapp-store'
import { tokenHash } from '../../src/secure-moments/store'
import type { Env } from '../../src/types'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const COLONY = 'colony.example.test'
const SECURE = 'secure.example.test'
const BOT = '123456789'
const TG_USER = 7001

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  }
}

const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never }
let keyPair: CryptoKeyPair
let pubHex = ''

beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
  keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  pubHex = [...new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))].map((b) => b.toString(16).padStart(2, '0')).join('')
  await testEnv.MUPOT_DB.exec(
    `INSERT OR IGNORE INTO members (id, email, display_name, status, tenant, telegram_chat_id) VALUES ('mem-tg', 'tg@x.test', 'Tg', 'active', 'mumega', '${TG_USER}')`,
  )
})

function env(over: Record<string, unknown> = {}) {
  return {
    TENANT_SLUG: 'mumega', CONNECTOR_MASTER_KEY: 'a1'.repeat(32), BRAND: 'mupot', IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'c.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 's',
    PUBLIC_ORIGIN: `https://${COLONY}`,
    SESSIONS: kv(), OAUTH_KV: kv(), DB: testEnv.MUPOT_DB,
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: SECURE,
    TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_EXTRA_PUBKEYS: pubHex,
    ...over,
  } as never
}

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function signedInitData(userId: number, over: { key?: CryptoKey; authDate?: number } = {}): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(over.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: userId, first_name: 'Tg' }),
  }
  const dcs = `${BOT}:WebAppData\n${Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')}`
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, over.key ?? keyPair.privateKey, new TextEncoder().encode(dcs)))
  const all = { ...fields, signature: b64u(sig), hash: 'f'.repeat(64) }
  return Object.entries(all).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

const get = (host: string, path: string, e = env()) => worker.fetch(new Request(`https://${host}${path}`), e, ctx)
const postView = async (host: string, initData: string, e = env()) =>
  worker.fetch(new Request(`https://${host}/m/tg/view`, {
    method: 'POST', headers: { origin: `https://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ init_data: initData }),
  }), e, ctx)

describe('telegram miniapp (real worker)', () => {
  it('secure host + /m/tg serves the Mini App page with exactly one extra script source', async () => {
    const res = await get(SECURE, '/m/tg')
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(/script-src ([^;]+)/.exec(csp)?.[1].split(' ').filter((s) => !s.startsWith("'nonce-"))).toEqual(['https://telegram.org/js/telegram-web-app.js'])
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('the colony host and any other host never serve /m/tg (the host gate runs first)', async () => {
    expect((await get(COLONY, '/m/tg')).status).toBe(404)
    expect((await get('mupot.workers.dev', '/m/tg')).status).toBe(404)
    expect((await postView(COLONY, await signedInitData(TG_USER))).status).toBe(404)
  })
  it('flag off: /m/tg is a 404 and the other secure-moments pages are untouched', async () => {
    const e = env({ TELEGRAM_MINIAPP: undefined })
    expect((await get(SECURE, '/m/tg', e)).status).toBe(404)
    expect((await postView(SECURE, await signedInitData(TG_USER), e)).status).toBe(404)
    const other = await get(SECURE, '/m/nope/nope', e)
    expect(other.status).toBe(404)
    expect(other.headers.get('content-security-policy') ?? '').not.toContain('telegram')
  })
  it('Ed25519 initData verifies on the real runtime: a bound user is accepted, a wrong key, a stale payload and an unbound user are refused', async () => {
    const ok = await postView(SECURE, await signedInitData(TG_USER))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, state: 'idle' })
    const wrongKey = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    expect((await postView(SECURE, await signedInitData(TG_USER, { key: wrongKey.privateKey }))).status).toBe(403)
    expect((await postView(SECURE, await signedInitData(TG_USER, { authDate: Math.floor(Date.now() / 1000) - 7200 }))).status).toBe(403)
    const unbound = await postView(SECURE, await signedInitData(424242))
    expect(unbound.status).toBe(403)
    expect(((await unbound.json()) as { title: string }).title).toBe('Telegram account not linked')
  })
  it('production trust: without the extra key configured the same payload is refused', async () => {
    expect((await postView(SECURE, await signedInitData(TG_USER), env({ TELEGRAM_MINIAPP_EXTRA_PUBKEYS: undefined }))).status).toBe(403)
  })
  it('the guarded batches behave on the real D1 (changes() across statements): enrol start/confirm, then ONE consume that records the decision', async () => {
    const e = env()
    const identity = await linkLoginIdentity(e as unknown as Env, { tenant: 'mumega', provider: 'google', providerSubject: 'g-tg', verifiedEmail: 'tg@x.test', memberId: 'mem-tg' })
    if (!identity.ok) throw new Error(`link failed ${JSON.stringify(identity)}`)
    const { token } = await mintTgEnrolmentToken(e as unknown as Env, 'mem-tg', identity.identity.id)
    const call = async (path: string, body: unknown) => worker.fetch(new Request(`https://${SECURE}${path}`, {
      method: 'POST', headers: { origin: `https://${SECURE}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), e, ctx)
    const start = await call(`/m/tg/enrol/${token}/start`, { init_data: await signedInitData(TG_USER) })
    expect(start.status).toBe(200)
    const deviceToken = ((await start.json()) as { device_token: string }).device_token
    // a wrong read-back leaves the link unspent; the right one spends it exactly once
    expect((await call(`/m/tg/enrol/${token}/confirm`, { init_data: await signedInitData(TG_USER), device_token: `${deviceToken.split('.')[0]}.${'A'.repeat(43)}` })).status).toBe(409)
    expect((await call(`/m/tg/enrol/${token}/confirm`, { init_data: await signedInitData(TG_USER), device_token: deviceToken })).status).toBe(200)
    expect((await call(`/m/tg/enrol/${token}/confirm`, { init_data: await signedInitData(TG_USER), device_token: deviceToken })).status).toBe(409)
    const momentId = crypto.randomUUID()
    await testEnv.MUPOT_DB.exec(
      `INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at) VALUES ('${momentId}', 'mumega', 'seed_attach', 'x', '${'e'.repeat(64)}', 'pending', '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')`,
    )
    const input = { momentId, decision: 'approve' as const, memberId: 'mem-tg', telegramUserId: String(TG_USER), deviceId: deviceToken.split('.')[0], secretSha256: await tokenHash(deviceToken.split('.')[1]) }
    expect(await consumeMomentTelegram(e as unknown as Env, { ...input, secretSha256: 'f'.repeat(64) }, Date.now())).toBe(false)
    expect(await consumeMomentTelegram(e as unknown as Env, input, Date.now())).toBe(true)
    expect(await consumeMomentTelegram(e as unknown as Env, input, Date.now())).toBe(false)
    // The decision row exists (inserted in the same batch, only because the consume won): a second INSERT of it collides.
    await expect(testEnv.MUPOT_DB.exec(
      `INSERT INTO tg_miniapp_decisions (moment_id, tenant, member_id, telegram_user_id, device_id, decision, decided_at) VALUES ('${momentId}', 'mumega', 'mem-tg', '${TG_USER}', 'x', 'approve', 'now')`,
    )).rejects.toThrow()
  })
})
