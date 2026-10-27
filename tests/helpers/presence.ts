// Test helpers for human presence (src/approvals/human-presence.ts).
//
// Two ways to give a widening dashboard route the proof it now demands:
//   * realTap()      - the REAL ceremony: GET the secure page, take a challenge, sign it on a software authenticator, POST it.
//                      Used by the presence suite, which also attacks it (replay, wrong decision, no UV, wrong member).
//   * shortcutTap()  - writes the grant's `satisfied` state straight into the DB with a passkey row that is live and bound to a
//                      live login identity. It stands in for realTap in suites that test OTHER behaviour of a route (what it
//                      writes, who may call it) and need to get past the gate. It cannot be used to test the gate itself.
import { expect } from 'vitest'
import type { Env } from '../../src/types'
import { mintEnrolmentToken } from '../../src/secure-moments/store'
import type { D1Database } from '@cloudflare/workers-types'
import { SoftAuthenticator } from './webauthn-authenticator'
import type { createSqliteD1 } from './sqlite-d1'

export const SECURE_HOST = 'secure.example.test'
export const SECURE_ORIGIN = `https://${SECURE_HOST}`
/** The flags a pot needs for presence to be satisfiable (secure moments on, a CSRF key). */
export const PRESENCE_FLAGS = { SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: SECURE_HOST, CONNECTOR_MASTER_KEY: 'a1'.repeat(32) } as const
export const PRESENCE_ENV = { ...PRESENCE_FLAGS, PUBLIC_ORIGIN: 'https://colony.example.test' } as const

/** The raw handle of a harness from createSqliteD1: these helpers run against the real migrated schema, never a double. */
type Sqlite = ReturnType<typeof createSqliteD1>['sqlite']

async function secureHit(env: Env, path: string, init: { json?: unknown; origin?: string | null } = {}): Promise<Response> {
  const headers = new Headers()
  let body: string | undefined
  let method = 'GET'
  if (init.json !== undefined) {
    method = 'POST'
    if (init.origin !== null) headers.set('origin', init.origin ?? SECURE_ORIGIN)
    headers.set('content-type', 'application/json')
    body = JSON.stringify(init.json)
  }
  // Loaded lazily: the secure-moments router pulls in the mcp modules, whose import cycle only resolves from mcp/index (suites that
  // only need seedPasskey/throughGate must not trigger it from here).
  const { momentsApp } = await import('../../src/secure-moments/routes')
  return momentsApp.fetch(new Request(`${SECURE_ORIGIN}${path}`, { method, headers, body }), env)
}

const csrfOf = (html: string): string => {
  const m = /data-csrf="([0-9a-f]{64})"/.exec(html)
  if (!m) throw new Error('no csrf in page')
  return m[1]
}

/** Ensure the member has a live login identity (the dashboard sessions of these suites are dev-login ones) and return its id. */
export function ensureIdentity(sqlite: Sqlite, tenant: string, memberId: string): string {
  const row = sqlite.prepare('SELECT id FROM human_login_identities WHERE tenant = ? AND member_id = ? AND revoked_at IS NULL LIMIT 1').get(tenant, memberId)
  if (row) return String(row.id)
  const id = `hli-${memberId}`
  sqlite.prepare("INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES (?, ?, 'google', ?, NULL, ?)").run(id, tenant, `sub-${memberId}`, memberId)
  return id
}

/** Enrol a software passkey through the REAL enrolment routes. */
export async function enrolPasskey(env: Env, sqlite: Sqlite, memberId: string): Promise<SoftAuthenticator> {
  const a = await SoftAuthenticator.create()
  const identityId = ensureIdentity(sqlite, env.TENANT_SLUG, memberId)
  const { token } = await mintEnrolmentToken(env, memberId, identityId)
  const page = await secureHit(env, `/m/enrol/${token}`)
  expect(page.status).toBe(200)
  const csrf = csrfOf(await page.text())
  const opts = (await (await secureHit(env, `/m/enrol/${token}/options`, { json: { csrf } })).json()) as { publicKey?: { challenge: string } }
  const credential = await a.register({ rpId: SECURE_HOST, origin: SECURE_ORIGIN, challenge: opts.publicKey?.challenge ?? '' })
  const fin = await secureHit(env, `/m/enrol/${token}/finish`, { json: { csrf, credential } })
  expect(fin.status).toBe(200)
  return a
}

/** `https://secure.host/m/presence/<id>/<token>` -> the path. */
export const presencePath = (approveUrl: string): string => new URL(approveUrl).pathname

export interface TapOver {
  /** Sign with these ceremony flags (uv:false = an assertion without user verification). */
  sign?: { uv?: boolean; up?: boolean; counter?: number; hashRpId?: string }
  /** Use this challenge instead of asking the server for one for THIS grant (cross-decision / replay attacks). */
  challenge?: string
  csrf?: string
}

/** The real ceremony against a presence link. Returns the /decide response. */
export async function realTap(env: Env, a: SoftAuthenticator, approveUrl: string, over: TapOver = {}): Promise<Response> {
  const path = presencePath(approveUrl)
  const csrf = over.csrf ?? csrfOf(await (await secureHit(env, path)).text())
  let challenge = over.challenge
  if (challenge === undefined) {
    const ch = await secureHit(env, `${path}/challenge`, { json: { decision: 'approve', csrf } })
    expect(ch.status).toBe(200)
    challenge = ((await ch.json()) as { publicKey?: { challenge: string } }).publicKey?.challenge ?? ''
  }
  const credential = await a.assert({ rpId: SECURE_HOST, origin: SECURE_ORIGIN, challenge, ...over.sign })
  return secureHit(env, `${path}/decide`, { json: { decision: 'approve', csrf, credential } })
}

/** The CSRF token the secure page embeds for this link (the link must still be live). */
export async function csrfFor(env: Env, approveUrl: string): Promise<string> {
  return csrfOf(await (await secureHit(env, presencePath(approveUrl))).text())
}

/** Ask the secure page for a challenge for this link (without signing it). */
export async function challengeFor(env: Env, approveUrl: string): Promise<string> {
  const path = presencePath(approveUrl)
  const csrf = csrfOf(await (await secureHit(env, path)).text())
  const ch = await secureHit(env, `${path}/challenge`, { json: { decision: 'approve', csrf } })
  expect(ch.status).toBe(200)
  return ((await ch.json()) as { publicKey?: { challenge: string } }).publicKey?.challenge ?? ''
}

/**
 * A live passkey row for the member (bound to a live login identity), with a key nothing can sign for. Suites that use
 * shortcutTap call this for every member that will act, so requestPresence sees "has a passkey" like a real enrolled member.
 */
export function seedPasskey(sqlite: Sqlite, tenant: string, memberId: string): string {
  const identityId = ensureIdentity(sqlite, tenant, memberId)
  const pk = `pk-shortcut-${memberId}`
  sqlite.prepare(
    `INSERT OR IGNORE INTO member_passkeys (id, tenant, member_id, login_identity_id, credential_id, public_key, cose_alg, sign_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'x', -7, 0, datetime('now'))`,
  ).run(pk, tenant, memberId, identityId, `cred-shortcut-${memberId}`)
  return pk
}

/** Stand-in for a tap in suites testing other behaviour: see the header. */
export function shortcutTap(sqlite: Sqlite, tenant: string, grantId: string): void {
  const g = sqlite.prepare('SELECT member_id FROM presence_grants WHERE id = ?').get(grantId)
  if (!g) throw new Error(`no such presence grant ${grantId}`)
  const pk = seedPasskey(sqlite, tenant, String(g.member_id))
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  sqlite.prepare("UPDATE presence_grants SET status = 'satisfied', satisfied_at = ?, satisfied_passkey_id = ?, expires_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), pk, future, grantId)
}

/** True when the response is the presence refusal (403 human_presence_required) and gives the grant id. */
export async function presenceRefusal(res: Response): Promise<{ grantId: string; approveUrl: string | null } | null> {
  const id = res.headers.get('x-presence-grant')
  if (res.status !== 403 || !id) return null
  let approveUrl: string | null = null
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('json')) {
    const j = (await res.clone().json()) as { approve_url?: string }
    approveUrl = j.approve_url ?? null
  } else {
    const m = /href="(https:\/\/[^"]*\/m\/presence\/[^"]+)"/.exec(await res.clone().text())
    approveUrl = m ? m[1].replace(/&amp;/g, '&') : null
  }
  return { grantId: id, approveUrl }
}

/**
 * Run `call` (which takes the query string to append, '' or 'presence_grant=<id>') through the gate: first with none (must be the
 * presence refusal), then, after a shortcut tap, with the satisfied grant. Returns the second response. For suites whose subject
 * is the route's OTHER behaviour.
 */
export async function throughGate(
  sqlite: Sqlite, tenant: string, call: (qs: string) => Promise<Response>,
): Promise<Response> {
  const first = await call('')
  const refusal = await presenceRefusal(first)
  if (!refusal) return first // not the gate: some other, earlier refusal (or the route needed no presence)
  shortcutTap(sqlite, tenant, refusal.grantId)
  return call(`presence_grant=${encodeURIComponent(refusal.grantId)}`)
}

// ── D1-only variants for suites that build their own env (no raw sqlite handle to pass around) ─────────────────────
/** Every email-bearing member of the env's tenant gets a live shortcut passkey (bound to a live login identity). Idempotent. */
export async function seedPasskeysForHumans(env: Env): Promise<void> {
  const db: D1Database = env.DB
  const rows = (await db.prepare('SELECT id FROM members WHERE tenant = ?1 AND email IS NOT NULL').bind(env.TENANT_SLUG).all<{ id: string }>()).results ?? []
  for (const { id } of rows) {
    await db.prepare("INSERT OR IGNORE INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES (?1, ?2, 'google', ?3, NULL, ?4)")
      .bind(`hli-${id}`, env.TENANT_SLUG, `sub-${id}`, id).run()
    const identity = await db.prepare('SELECT id FROM human_login_identities WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL LIMIT 1').bind(env.TENANT_SLUG, id).first<{ id: string }>()
    if (!identity) continue
    await db.prepare(
      `INSERT OR IGNORE INTO member_passkeys (id, tenant, member_id, login_identity_id, credential_id, public_key, cose_alg, sign_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'x', -7, 0, datetime('now'))`,
    ).bind(`pk-shortcut-${id}`, env.TENANT_SLUG, id, identity.id, `cred-shortcut-${id}`).run()
  }
}

async function shortcutTapD1(env: Env, grantId: string): Promise<void> {
  const db: D1Database = env.DB
  const g = await db.prepare('SELECT member_id FROM presence_grants WHERE id = ?1').bind(grantId).first<{ member_id: string }>()
  if (!g) throw new Error(`no such presence grant ${grantId}`)
  await db.prepare("UPDATE presence_grants SET status = 'satisfied', satisfied_at = ?2, satisfied_passkey_id = ?3, expires_at = ?4 WHERE id = ?1 AND status = 'pending'")
    .bind(grantId, new Date().toISOString(), `pk-shortcut-${g.member_id}`, new Date(Date.now() + 5 * 60 * 1000).toISOString()).run()
}

type FetchApp = {
  fetch(req: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>
  request(path: string, init: RequestInit | undefined, env: Env): Response | Promise<Response>
}

/**
 * Wraps a Hono app so every POST that ends at the presence refusal is satisfied by the DB shortcut and repeated with the grant. Any other
 * response (a CSRF 403, a validation 400, an authority 403) is returned untouched, so the suite still tests those. For suites whose
 * subject is a route's OTHER behaviour; the gate itself is tests/human-presence.test.ts.
 */
export function gatedApp(app: FetchApp): FetchApp {
  const withGrant = (url: string, grantId: string): string => `${url}${url.includes('?') ? '&' : '?'}presence_grant=${encodeURIComponent(grantId)}`
  return {
    async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
      if (req.method !== 'POST') return app.fetch(req, env, ctx)
      await seedPasskeysForHumans(env)
      const retry = req.clone()
      const first = await app.fetch(req, env, ctx)
      const refusal = await presenceRefusal(first)
      if (!refusal) return first
      await shortcutTapD1(env, refusal.grantId)
      return app.fetch(new Request(withGrant(retry.url, refusal.grantId), retry), env, ctx)
    },
    async request(path: string, init: RequestInit | undefined, env: Env): Promise<Response> {
      if (init?.method !== 'POST') return app.request(path, init, env)
      await seedPasskeysForHumans(env)
      const first = await app.request(path, init, env)
      const refusal = await presenceRefusal(first)
      if (!refusal) return first
      await shortcutTapD1(env, refusal.grantId)
      return app.request(withGrant(path, refusal.grantId), init, env)
    },
  }
}
