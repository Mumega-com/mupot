// mupot — web_sessions (SENSITIVE). The queryable, listable, revocable D1
// session registry that replaces the previously unlistable KV-only session
// record for any login that resolves to a real members row.
//
// Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
// elevation-design.md, "Human web session". Delivery Sequence step 1 (mupot
// task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
//
// The browser cookie carries ONLY the random opaque session value (unchanged
// from src/auth/index.ts's existing discipline). This module never sees or
// stores that raw value — every function here takes the ALREADY-HASHED id, so
// a caller (src/auth/index.ts) hashes once at the cookie boundary and every
// lookup below is by id_hash. That keeps a stolen D1 row (or a stolen backup)
// worthless for session hijacking, same as member_tokens.token_hash.
//
// EVERY function that reads "now" takes it as an explicit parameter (default
// Date.now()) rather than calling Date.now() internally — a clock read buried
// inside the loader cannot be pinned by a test with a controlled clock (see
// tests/web-sessions.test.ts, and the house rule this follows: a loader that
// reads the clock internally defeats a pinned fixture).

import type { Env } from '../types'
import { sha256Hex } from '../members/service'

// ── tunables (design v1 policy) ──────────────────────────────────────────────

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h inactivity
export const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d hard maximum
export const LAST_SEEN_COALESCE_MS = 5 * 60 * 1000 // write last_seen_at at most every 5 min
export const RECENT_REAUTH_WINDOW_MS = 5 * 60 * 1000 // step-up freshness window

// ── shape ─────────────────────────────────────────────────────────────────────

export interface WebSessionRecord {
  id_hash: string
  tenant: string
  member_id: string
  login_identity_id: string
  created_at: string
  last_seen_at: string
  idle_expires_at: string
  absolute_expires_at: string
  recent_reauth_at: string | null
  revoked_at: string | null
  revoke_reason: string | null
}

/** Cryptographically-random opaque id (URL-safe hex) — same shape as the
 *  cookie value src/auth/index.ts's randomId() already mints. Exported so the
 *  cookie-minting call site and this module agree on one generator. */
export function randomWebSessionId(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}

/** SHA-256 hex of the raw session value. The only form ever persisted. */
export async function hashWebSessionId(raw: string): Promise<string> {
  return sha256Hex(raw)
}

/**
 * isMissingTableError — true iff `err` is exactly "this table does not exist
 * yet", never any other D1/SQLite failure. Migrations 0139/0140 (this
 * module's tables) are deliberately NOT applied by this build — see the
 * task's boundary: schema and code ship on a branch, a human applies the
 * migration separately. Every READ in this module treats a not-yet-migrated
 * environment the SAME as "this session was never registered" (reason:
 * 'not_found') rather than crashing every dashboard request — that is the
 * documented step-1 gap, not new behaviour. The regex is narrow on purpose:
 * a genuine query/connectivity bug must still throw and surface loudly,
 * exactly as the rest of this codebase's fail-closed discipline requires.
 */
function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*(web_sessions|human_login_identities)\b/i.test(message)
}

// ── create ────────────────────────────────────────────────────────────────────

export interface CreateWebSessionInput {
  tenant: string
  memberId: string
  loginIdentityId: string
}

/**
 * createWebSession — persist a new D1 session row for an ALREADY-MINTED raw
 * session id (the same value going into the cookie). Both expiry ceilings are
 * fixed here: idle_expires_at = now + 24h (bumped forward on later use, see
 * touchWebSession), absolute_expires_at = now + 7d (NEVER bumped — the hard
 * ceiling on a continuously-used session).
 */
export async function createWebSession(
  env: Env,
  rawSessionId: string,
  input: CreateWebSessionInput,
  nowMs: number = Date.now(),
): Promise<WebSessionRecord> {
  const idHash = await hashWebSessionId(rawSessionId)
  const nowIso = new Date(nowMs).toISOString()
  const idleExpiresAt = new Date(nowMs + IDLE_TIMEOUT_MS).toISOString()
  const absoluteExpiresAt = new Date(nowMs + ABSOLUTE_TTL_MS).toISOString()

  await env.DB.prepare(
    `INSERT INTO web_sessions
       (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)`,
  )
    .bind(idHash, input.tenant, input.memberId, input.loginIdentityId, nowIso, idleExpiresAt, absoluteExpiresAt)
    .run()

  return {
    id_hash: idHash,
    tenant: input.tenant,
    member_id: input.memberId,
    login_identity_id: input.loginIdentityId,
    created_at: nowIso,
    last_seen_at: nowIso,
    idle_expires_at: idleExpiresAt,
    absolute_expires_at: absoluteExpiresAt,
    recent_reauth_at: null,
    revoked_at: null,
    revoke_reason: null,
  }
}

// ── load + evaluate (fail closed) ────────────────────────────────────────────

export type WebSessionLoadResult =
  | { ok: true; session: WebSessionRecord }
  | { ok: false; reason: 'not_found' | 'member_inactive' | 'revoked' | 'expired_idle' | 'expired_absolute' }

/**
 * evaluateWebSession — pure fail-closed check against a loaded row. Revocation
 * wins over expiry (a revoked-but-not-yet-expired row is still dead); idle and
 * absolute are two INDEPENDENT ceilings — a row that beat one but not the
 * other is still dead. Split out from loadWebSession so a test can assert the
 * exact reason without touching D1.
 */
export function evaluateWebSession(
  session: WebSessionRecord,
  nowMs: number = Date.now(),
): WebSessionLoadResult {
  if (session.revoked_at !== null) return { ok: false, reason: 'revoked' }
  if (nowMs >= Date.parse(session.absolute_expires_at)) {
    return { ok: false, reason: 'expired_absolute' }
  }
  if (nowMs >= Date.parse(session.idle_expires_at)) {
    return { ok: false, reason: 'expired_idle' }
  }
  return { ok: true, session }
}

/**
 * loadWebSession — hash the raw cookie value, look up the D1 row FOR THIS
 * TENANT (never a cross-tenant lookup), and evaluate it. Does NOT touch the
 * row — callers that admit the session should follow up with touchWebSession.
 */
export async function loadWebSession(
  env: Env,
  tenant: string,
  rawSessionId: string,
  nowMs: number = Date.now(),
): Promise<WebSessionLoadResult> {
  const idHash = await hashWebSessionId(rawSessionId)
  let row: (WebSessionRecord & { member_status: string | null }) | null
  try {
    row = await env.DB.prepare(
      `SELECT ws.id_hash AS id_hash, ws.tenant AS tenant, ws.member_id AS member_id,
              ws.login_identity_id AS login_identity_id, ws.created_at AS created_at,
              ws.last_seen_at AS last_seen_at, ws.idle_expires_at AS idle_expires_at,
              ws.absolute_expires_at AS absolute_expires_at,
              ws.recent_reauth_at AS recent_reauth_at, ws.revoked_at AS revoked_at,
              ws.revoke_reason AS revoke_reason,
              m.status AS member_status
         FROM web_sessions ws
         LEFT JOIN members m ON m.id = ws.member_id AND m.tenant = ws.tenant
        WHERE ws.id_hash = ?1 AND ws.tenant = ?2
        LIMIT 1`,
    )
      .bind(idHash, tenant)
      .first<WebSessionRecord & { member_status: string | null }>()
  } catch (err) {
    if (isMissingTableError(err)) return { ok: false, reason: 'not_found' }
    throw err
  }
  if (!row) return { ok: false, reason: 'not_found' }
  const { member_status: _memberStatus, ...session } = row
  const evaluated = evaluateWebSession(session, nowMs)
  if (!evaluated.ok) return evaluated
  if (_memberStatus !== 'active') return { ok: false, reason: 'member_inactive' }
  return evaluated
}

/**
 * touchWebSession — bump idle_expires_at forward on real use. Coalesced: a
 * write only happens when at least LAST_SEEN_COALESCE_MS has passed since
 * last_seen_at, so a chatty session does not turn every request into a D1
 * write. Bumping idle_expires_at can never rescue a session past its
 * absolute_expires_at — that ceiling is fixed at creation and this function
 * never touches it — so a continuously-used session still hard-expires at 7d.
 */
export async function touchWebSession(
  env: Env,
  idHash: string,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT last_seen_at FROM web_sessions WHERE id_hash = ?1`,
    )
      .bind(idHash)
      .first<{ last_seen_at: string }>()
    if (!row) return
    if (nowMs - Date.parse(row.last_seen_at) < LAST_SEEN_COALESCE_MS) return

    const nowIso = new Date(nowMs).toISOString()
    const idleExpiresAt = new Date(nowMs + IDLE_TIMEOUT_MS).toISOString()
    await env.DB.prepare(
      `UPDATE web_sessions SET last_seen_at = ?1, idle_expires_at = ?2
        WHERE id_hash = ?3 AND revoked_at IS NULL`,
    )
      .bind(nowIso, idleExpiresAt, idHash)
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return
    throw err
  }
}

// ── list ──────────────────────────────────────────────────────────────────────

/** listWebSessions — every session (live or not) for a member, newest first.
 *  Callers render revoked/expired rows as history, not as active sessions —
 *  filtering, if wanted, is the caller's concern (evaluateWebSession is the
 *  single source of truth for "is this one live"). */
export async function listWebSessions(
  env: Env,
  tenant: string,
  memberId: string,
): Promise<WebSessionRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at,
            idle_expires_at, absolute_expires_at, recent_reauth_at, revoked_at, revoke_reason
       FROM web_sessions
      WHERE tenant = ?1 AND member_id = ?2
      ORDER BY created_at DESC`,
  )
    .bind(tenant, memberId)
    .all<WebSessionRecord>()
  return rows.results ?? []
}

// ── revoke ────────────────────────────────────────────────────────────────────

/**
 * revokeWebSession — revoke exactly one session BY id_hash, scoped to tenant
 * + owning member (never cross-member, never cross-tenant). Idempotent:
 * revoking an already-revoked row is a no-op (0 rows written), never an
 * error — the caller sees "still not live" either way.
 */
export async function revokeWebSession(
  env: Env,
  tenant: string,
  memberId: string,
  idHash: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
      WHERE id_hash = ?3 AND tenant = ?4 AND member_id = ?5 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, idHash, tenant, memberId)
    .run()
  const changes = Number(result.meta?.changes ?? 0)
  return { revoked: changes > 0 }
}

/**
 * revokeWebSessionByHash — revoke exactly one session BY id_hash + tenant,
 * with NO member-ownership check. Reserved for the logout route: the caller
 * is revoking the session named by the cookie IT JUST PRESENTED — there is no
 * ambiguity to check against, and requiring a resolved memberId here would
 * make logout fail for a session that never bridged to a members row. Never
 * expose this on a route that takes a caller-supplied id_hash from someone
 * else's session — that path is revokeWebSession, which enforces ownership.
 */
export async function revokeWebSessionByHash(
  env: Env,
  tenant: string,
  idHash: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
      WHERE id_hash = ?3 AND tenant = ?4 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, idHash, tenant)
    .run()
  const changes = Number(result.meta?.changes ?? 0)
  return { revoked: changes > 0 }
}

/**
 * revokeWebSessionsForLoginIdentity — kill every LIVE session bound to one
 * login identity. Used when that identity is revoked: session revoke alone
 * does not unbind the subject, and leaving the sessions live would let the
 * attacker keep using a cookie minted under the stolen binding.
 */
export async function revokeWebSessionsForLoginIdentity(
  env: Env,
  tenant: string,
  memberId: string,
  loginIdentityId: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revokedCount: number }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
      WHERE tenant = ?3 AND member_id = ?4 AND login_identity_id = ?5 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, tenant, memberId, loginIdentityId)
    .run()
  return { revokedCount: Number(result.meta?.changes ?? 0) }
}

/**
 * loadLiveReauthIdentity — the identity a reauth callback must match.
 * Both the session AND the identity must be live: a revoked identity on a
 * still-live session must not satisfy a step-up.
 */
export async function loadLiveReauthIdentity(
  env: Env,
  tenant: string,
  webSessionIdHash: string,
): Promise<{ provider: string; provider_subject: string } | null> {
  const row = await env.DB.prepare(
    `SELECT hli.provider AS provider, hli.provider_subject AS provider_subject
       FROM web_sessions ws
       JOIN human_login_identities hli ON hli.id = ws.login_identity_id
       JOIN members m ON m.id = ws.member_id AND m.tenant = ws.tenant
      WHERE ws.id_hash = ?1 AND ws.tenant = ?2
        AND ws.revoked_at IS NULL
        AND hli.revoked_at IS NULL
        AND m.status = 'active'
      LIMIT 1`,
  )
    .bind(webSessionIdHash, tenant)
    .first<{ provider: string; provider_subject: string }>()
  return row ?? null
}

/**
 * revokeAllWebSessions — "sign out all devices". Revokes every LIVE session
 * for the member; pass exceptIdHash to keep the current session alive (the
 * common "sign out other devices" variant) — omit it for a full sign-out.
 * Returns the count actually revoked (excludes already-dead rows).
 */
export async function revokeAllWebSessions(
  env: Env,
  tenant: string,
  memberId: string,
  reason: string,
  exceptIdHash?: string,
  nowMs: number = Date.now(),
): Promise<{ revokedCount: number }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = exceptIdHash
    ? await env.DB.prepare(
        `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
          WHERE tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL AND id_hash != ?5`,
      )
        .bind(nowIso, reason, tenant, memberId, exceptIdHash)
        .run()
    : await env.DB.prepare(
        `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
          WHERE tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL`,
      )
        .bind(nowIso, reason, tenant, memberId)
        .run()
  return { revokedCount: Number(result.meta?.changes ?? 0) }
}

// ── recent reauth (step-up primitive) ────────────────────────────────────────

/**
 * markRecentReauth — record that THIS session just proved a fresh round-trip
 * through the identity provider. Only ever called from the reauth callback
 * path (src/auth/index.ts /auth/reauth + /auth/callback's reauth branch) —
 * never from ordinary use, never from touchWebSession. A revoked session
 * cannot be marked (WHERE revoked_at IS NULL): reauth cannot resurrect a dead
 * session.
 */
export async function markRecentReauth(
  env: Env,
  idHash: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString()
  await env.DB.prepare(
    `UPDATE web_sessions SET recent_reauth_at = ?1 WHERE id_hash = ?2 AND revoked_at IS NULL`,
  )
    .bind(nowIso, idHash)
    .run()
}

/** hasRecentReauth — pure check, no DB access. True iff recent_reauth_at is
 *  set and within RECENT_REAUTH_WINDOW_MS of now. */
export function hasRecentReauth(
  session: Pick<WebSessionRecord, 'recent_reauth_at'>,
  nowMs: number = Date.now(),
): boolean {
  if (!session.recent_reauth_at) return false
  return nowMs - Date.parse(session.recent_reauth_at) <= RECENT_REAUTH_WINDOW_MS
}
