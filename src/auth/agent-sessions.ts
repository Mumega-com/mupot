// mupot — agent_sessions (SENSITIVE). The queryable, listable, revocable D1
// runtime-session registry for an AGENT's authenticated connection —
// mirroring what src/auth/web-sessions.ts (Delivery Sequence step 1) gave a
// HUMAN's dashboard login.
//
// Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
// elevation-design.md, "Agent runtime session". Delivery Sequence step 2
// (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
//
// WHY THIS EXISTS: a Delivery-Sequence-step-3 elevation grant must bind to
// the EXACT agent session that asked — never to the agent as a whole, or
// sibling tokens/OAuth connections for the same agent would silently inherit
// an elevation they never requested. That requires an agent's authenticated
// connection to have a first-class, listable, independently-expirable,
// revocable row — the same shape web_sessions already gave a human login.
//
// credential_id is NOT a raw secret and is deliberately NOT hashed the way
// web_sessions.id_hash is. See migrations/0141_agent_sessions.sql's comment
// for the full reasoning: it is auth.tokenId, the live member_tokens.id this
// codebase already re-validates on every request (src/mcp/index.ts
// authenticateMember, src/mcp/oauth-authorize.ts buildAuthContext) — never a
// value presented raw by an untrusted client and looked up by hash.
//
// EVERY function that reads "now" takes it as an explicit parameter (default
// Date.now()) rather than calling Date.now() internally — a clock read
// buried inside the loader cannot be pinned by a test with a controlled
// clock (the same house rule web-sessions.ts follows).

import type { AuthContext, ConnectionChannel, Env } from '../types'

// ── tunables (v1 policy — reuses web_sessions' exact defaults; see the
// migration comment for why an agent session needs the same two independent
// ceilings even though nothing here is a browser cookie) ──────────────────
export const AGENT_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h inactivity
export const AGENT_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d hard maximum
export const AGENT_SESSION_LAST_SEEN_COALESCE_MS = 5 * 60 * 1000 // coalesce writes

export type AgentAuthKind = 'workspace_token' | 'oauth'

export interface AgentSessionRecord {
  id: string
  tenant: string
  agent_id: string
  member_id: string
  auth_kind: AgentAuthKind
  credential_id: string
  seat: string | null
  created_at: string
  last_seen_at: string
  idle_expires_at: string
  absolute_expires_at: string
  revoked_at: string | null
  revoke_reason: string | null
}

/**
 * isMissingTableError — true iff `err` is exactly "agent_sessions does not
 * exist yet". Migration 0141 (this module's table) is deliberately NOT
 * applied by this build — see the task's boundary: schema and code ship on a
 * branch, a human applies the migration separately. Every function on the hot
 * request path (check_in, and anything reusing getOrCreateAgentSession)
 * treats a not-yet-migrated environment the SAME as "no session tracking
 * available yet" rather than crashing an otherwise-working request — this is
 * the documented step-2 gap, matching step 1's own documented gap for
 * web_sessions. The regex is narrow on purpose: a genuine query/connectivity
 * bug must still throw and surface loudly.
 */
function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*agent_sessions\b/i.test(message)
}

// ── deriving the session identity from an already-authenticated request ────

export type NotAgentSessionReason = 'not_agent_session'

export interface AgentSessionContext {
  authKind: AgentAuthKind
  credentialId: string
  agentId: string
  memberId: string
  seat: string | null
}

/**
 * deriveAgentAuthKind — 'directory' channel is the OAuth 2.1 door (design's
 * "oauth"); every other channel an agent can be bound on (workspace/im/
 * dashboard) is a plain bearer member_token (design's "workspace_token").
 * Returns null for an unrecognized/absent channel — callers must fail
 * closed, never guess.
 */
export function deriveAgentAuthKind(channel: ConnectionChannel | undefined): AgentAuthKind | null {
  if (channel === 'directory') return 'oauth'
  if (channel === 'workspace' || channel === 'im' || channel === 'dashboard') return 'workspace_token'
  return null
}

/**
 * resolveAgentSessionContext — the ONE place that turns an authenticated
 * AuthContext into "which exact agent session is this". Every field comes
 * from server-derived AuthContext properties ONLY (auth.boundAgentId,
 * auth.memberId, auth.channel, auth.tokenId) — nothing here is ever read
 * from request args, matching the design's Security Invariant 1 ("Requested
 * tenant, agent, member, credential, and session identity are derived from
 * authentication, never request text").
 *
 * Fails closed with 'not_agent_session' — the exact failure code the design
 * doc names in its Failure Behavior section — for: no bound agent (a pure
 * human/operator principal), no resolved member, an unrecognized channel, or
 * a request with no live member_tokens row backing it (auth.tokenId unset —
 * cannot happen for a real authenticated request today, but the check stays
 * because "cannot happen" is not a proof).
 */
export function resolveAgentSessionContext(
  auth: AuthContext,
  seat?: string | null,
): { ok: true; context: AgentSessionContext } | { ok: false; reason: NotAgentSessionReason } {
  if (!auth.boundAgentId) return { ok: false, reason: 'not_agent_session' }
  if (!auth.memberId) return { ok: false, reason: 'not_agent_session' }
  const authKind = deriveAgentAuthKind(auth.channel)
  if (!authKind) return { ok: false, reason: 'not_agent_session' }
  if (!auth.tokenId) return { ok: false, reason: 'not_agent_session' }
  return {
    ok: true,
    context: {
      authKind,
      credentialId: auth.tokenId,
      agentId: auth.boundAgentId,
      memberId: auth.memberId,
      seat: seat && seat.trim().length > 0 ? seat.trim() : null,
    },
  }
}

// ── evaluate (fail closed) ──────────────────────────────────────────────────

export type AgentSessionLoadResult =
  | { ok: true; session: AgentSessionRecord }
  | { ok: false; reason: 'not_found' | 'revoked' | 'expired_idle' | 'expired_absolute' }

/**
 * evaluateAgentSession — pure fail-closed check against a loaded row.
 * Revocation wins over expiry; idle and absolute are two INDEPENDENT
 * ceilings — a row that beat one but not the other is still dead. Mirrors
 * web-sessions.ts's evaluateWebSession exactly (same reasoning applies).
 */
export function evaluateAgentSession(
  session: AgentSessionRecord,
  nowMs: number = Date.now(),
): AgentSessionLoadResult {
  if (session.revoked_at !== null) return { ok: false, reason: 'revoked' }
  if (nowMs >= Date.parse(session.absolute_expires_at)) {
    return { ok: false, reason: 'expired_absolute' }
  }
  if (nowMs >= Date.parse(session.idle_expires_at)) {
    return { ok: false, reason: 'expired_idle' }
  }
  return { ok: true, session }
}

// ── row access (self-guarding: a missing table reads as "no session") ──────

const SELECT_COLUMNS = `id, tenant, agent_id, member_id, auth_kind, credential_id, seat,
       created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoke_reason`

export async function loadAgentSessionById(env: Env, tenant: string, id: string): Promise<AgentSessionRecord | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM agent_sessions WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
    )
      .bind(id, tenant)
      .first<AgentSessionRecord>()
    return row ?? null
  } catch (err) {
    if (isMissingTableError(err)) return null
    throw err
  }
}

/** loadLiveAgentSessionByCredential — the row the partial unique index
 *  guarantees is at most one per (tenant, auth_kind, credential_id). */
export async function loadLiveAgentSessionByCredential(
  env: Env,
  tenant: string,
  authKind: AgentAuthKind,
  credentialId: string,
): Promise<AgentSessionRecord | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM agent_sessions
        WHERE tenant = ?1 AND auth_kind = ?2 AND credential_id = ?3 AND revoked_at IS NULL
        LIMIT 1`,
    )
      .bind(tenant, authKind, credentialId)
      .first<AgentSessionRecord>()
    return row ?? null
  } catch (err) {
    if (isMissingTableError(err)) return null
    throw err
  }
}

// ── create ────────────────────────────────────────────────────────────────

export interface CreateAgentSessionInput {
  tenant: string
  agentId: string
  memberId: string
  authKind: AgentAuthKind
  credentialId: string
  seat?: string | null
}

/** createAgentSession — pure insert, NOT self-guarding (mirrors
 *  createWebSession — the write path's missing-table handling belongs to the
 *  caller, since different callers want different fallback behavior). */
export async function createAgentSession(
  env: Env,
  input: CreateAgentSessionInput,
  nowMs: number = Date.now(),
): Promise<AgentSessionRecord> {
  const id = crypto.randomUUID()
  const nowIso = new Date(nowMs).toISOString()
  const idleExpiresAt = new Date(nowMs + AGENT_SESSION_IDLE_TIMEOUT_MS).toISOString()
  const absoluteExpiresAt = new Date(nowMs + AGENT_SESSION_ABSOLUTE_TTL_MS).toISOString()
  const seat = input.seat && input.seat.trim().length > 0 ? input.seat.trim() : null

  await env.DB.prepare(
    `INSERT INTO agent_sessions
       (id, tenant, agent_id, member_id, auth_kind, credential_id, seat, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)`,
  )
    .bind(id, input.tenant, input.agentId, input.memberId, input.authKind, input.credentialId, seat, nowIso, idleExpiresAt, absoluteExpiresAt)
    .run()

  return {
    id,
    tenant: input.tenant,
    agent_id: input.agentId,
    member_id: input.memberId,
    auth_kind: input.authKind,
    credential_id: input.credentialId,
    seat,
    created_at: nowIso,
    last_seen_at: nowIso,
    idle_expires_at: idleExpiresAt,
    absolute_expires_at: absoluteExpiresAt,
    revoked_at: null,
    revoke_reason: null,
  }
}

// ── touch ─────────────────────────────────────────────────────────────────

/**
 * touchAgentSession — bump idle_expires_at forward on real use, coalesced to
 * at most once every AGENT_SESSION_LAST_SEEN_COALESCE_MS, exactly mirroring
 * touchWebSession. Also updates `seat` when a non-empty seat is supplied and
 * differs from the stored value — check_in is the one place a seat label is
 * ever volunteered, and a session's seat can legitimately become known
 * partway through its life (e.g. the first check_in after a bare bearer
 * connect). Self-guarding: a missing table is a silent no-op, matching
 * touchWebSession.
 */
export async function touchAgentSession(
  env: Env,
  id: string,
  nowMs: number = Date.now(),
  seat?: string | null,
): Promise<void> {
  const normalizedSeat = seat && seat.trim().length > 0 ? seat.trim() : null
  try {
    const row = await env.DB.prepare(`SELECT last_seen_at, seat FROM agent_sessions WHERE id = ?1`)
      .bind(id)
      .first<{ last_seen_at: string; seat: string | null }>()
    if (!row) return

    const seatChanged = normalizedSeat !== null && normalizedSeat !== row.seat
    const dueForTouch = nowMs - Date.parse(row.last_seen_at) >= AGENT_SESSION_LAST_SEEN_COALESCE_MS
    if (!dueForTouch && !seatChanged) return

    const nowIso = new Date(nowMs).toISOString()
    if (dueForTouch) {
      const idleExpiresAt = new Date(nowMs + AGENT_SESSION_IDLE_TIMEOUT_MS).toISOString()
      await env.DB.prepare(
        `UPDATE agent_sessions
            SET last_seen_at = ?1, idle_expires_at = ?2, seat = COALESCE(?3, seat)
          WHERE id = ?4 AND revoked_at IS NULL`,
      )
        .bind(nowIso, idleExpiresAt, normalizedSeat, id)
        .run()
    } else {
      await env.DB.prepare(`UPDATE agent_sessions SET seat = ?1 WHERE id = ?2 AND revoked_at IS NULL`)
        .bind(normalizedSeat, id)
        .run()
    }
  } catch (err) {
    if (isMissingTableError(err)) return
    throw err
  }
}

// ── get-or-create (the "agent authentication" touchpoint) ──────────────────

export interface AgentSessionResolution {
  session: AgentSessionRecord
  created: boolean
  /** Set when a dead (revoked/idle-expired/absolute-expired) prior row for
   *  this SAME credential was retired to make way for this one — see the
   *  migration comment on why a credential with no discrete "login" event
   *  rotates its tracking row instead of reviving a dead one. */
  rotatedFromId: string | null
}

/**
 * getOrCreateAgentSession — the moment analogous to a human "login": called
 * from an already-authenticated request (today: check_in) to ensure a live
 * session row exists for the caller's exact credential, bump it forward on
 * use, and retire+replace it if it died since the last call.
 *
 * Self-guarding as a WHOLE (unlike web-sessions.ts's finer-grained per-
 * function guards): this function has multiple call sites sharing the same
 * "not migrated yet" fallback, so centralizing the missing-table catch here
 * avoids repeating it at every call site. Returns null (not a thrown error)
 * when the table does not exist yet — callers treat that identically to "no
 * session tracking available", never as a request failure.
 */
export async function getOrCreateAgentSession(
  env: Env,
  input: CreateAgentSessionInput,
  nowMs: number = Date.now(),
): Promise<AgentSessionResolution | null> {
  try {
    const existing = await loadLiveAgentSessionByCredential(env, input.tenant, input.authKind, input.credentialId)
    if (existing) {
      const evaluated = evaluateAgentSession(existing, nowMs)
      if (evaluated.ok) {
        await touchAgentSession(env, existing.id, nowMs, input.seat ?? null)
        const refreshed = await loadAgentSessionById(env, input.tenant, existing.id)
        return { session: refreshed ?? existing, created: false, rotatedFromId: null }
      }
      // Dead but not yet flagged (idle/absolute ceiling passed since the row
      // was last touched) — retire it explicitly so it stops reading as live
      // in any listing, then mint a fresh row for the same still-valid
      // credential. Idempotent: if it was already revoked_at IS NOT NULL
      // (evaluated.reason === 'revoked'), this WHERE clause matches zero
      // rows and is a harmless no-op.
      await markAgentSessionRevoked(env, existing.id, `auto_${evaluated.reason}`, nowMs)
      const created = await createAgentSession(env, input, nowMs)
      return { session: created, created: true, rotatedFromId: existing.id }
    }
    const created = await createAgentSession(env, input, nowMs)
    return { session: created, created: true, rotatedFromId: null }
  } catch (err) {
    if (isMissingTableError(err)) return null
    throw err
  }
}

// ── list ──────────────────────────────────────────────────────────────────

/** listAgentSessions — every session (live or not) for an agent, newest
 *  first. Same "history, not just current" contract as listWebSessions —
 *  callers filter with evaluateAgentSession if they only want live ones. */
export async function listAgentSessions(env: Env, tenant: string, agentId: string): Promise<AgentSessionRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_sessions
      WHERE tenant = ?1 AND agent_id = ?2
      ORDER BY created_at DESC`,
  )
    .bind(tenant, agentId)
    .all<AgentSessionRecord>()
  return rows.results ?? []
}

// ── revoke ────────────────────────────────────────────────────────────────

async function markAgentSessionRevoked(
  env: Env,
  id: string,
  reason: string,
  nowMs: number,
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE agent_sessions SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, id)
    .run()
  return { revoked: Number(result.meta?.changes ?? 0) > 0 }
}

/**
 * revokeAgentSessionById — revoke exactly one session, scoped to tenant +
 * owning agent_id (never cross-agent, never cross-tenant) — the shape a
 * human-admin tool uses (mirrors revoke_agent_token's ownership check in
 * src/mcp/provision.ts). Idempotent: revoking an already-dead row is a
 * no-op, never an error.
 */
export async function revokeAgentSessionById(
  env: Env,
  tenant: string,
  agentId: string,
  id: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE agent_sessions SET revoked_at = ?1, revoke_reason = ?2
      WHERE id = ?3 AND tenant = ?4 AND agent_id = ?5 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, id, tenant, agentId)
    .run()
  return { revoked: Number(result.meta?.changes ?? 0) > 0 }
}

/**
 * revokeAgentSessionByCredential — revoke exactly the LIVE session for one
 * credential, with NO id required from the caller. This is the "revocable by
 * the agent itself" primitive: an agent can end its own current session
 * without needing to know (or be able to guess/supply) an agent_sessions.id —
 * the target is entirely server-derived from the caller's own authenticated
 * credential, matching Security Invariant 1. It is also the primitive
 * revoke_agent_token and deactivate_agent use to keep a specific credential's
 * (or a whole agent's) session bookkeeping honest when the underlying
 * standing credential dies — see the callers in src/mcp/provision.ts.
 */
export async function revokeAgentSessionByCredential(
  env: Env,
  tenant: string,
  authKind: AgentAuthKind,
  credentialId: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean; sessionId: string | null }> {
  const existing = await loadLiveAgentSessionByCredential(env, tenant, authKind, credentialId)
  if (!existing) return { revoked: false, sessionId: null }
  const { revoked } = await markAgentSessionRevoked(env, existing.id, reason, nowMs)
  return { revoked, sessionId: existing.id }
}

/** revokeAllAgentSessionsForAgent — revoke EVERY live session for an agent
 *  in one write. Used by deactivate_agent (fact 3: standing-state revocation
 *  must actually reach this table too, not just agents.status/member_tokens/
 *  fleet_agents/agent_keys). Self-guarding: deactivate_agent is a live,
 *  currently-shipped tool and must keep working unmodified in an environment
 *  where migration 0141 has not been applied yet. */
export async function revokeAllAgentSessionsForAgent(
  env: Env,
  tenant: string,
  agentId: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revokedCount: number }> {
  try {
    const nowIso = new Date(nowMs).toISOString()
    const result = await env.DB.prepare(
      `UPDATE agent_sessions SET revoked_at = ?1, revoke_reason = ?2
        WHERE tenant = ?3 AND agent_id = ?4 AND revoked_at IS NULL`,
    )
      .bind(nowIso, reason, tenant, agentId)
      .run()
    return { revokedCount: Number(result.meta?.changes ?? 0) }
  } catch (err) {
    if (isMissingTableError(err)) return { revokedCount: 0 }
    throw err
  }
}

/** revokeAgentSessionByCredentialSafe — same contract as
 *  revokeAgentSessionByCredential, but swallows "table not migrated yet" —
 *  for wiring into revoke_agent_token, an existing live tool that must keep
 *  working unmodified pre-migration. */
export async function revokeAgentSessionByCredentialSafe(
  env: Env,
  tenant: string,
  authKind: AgentAuthKind,
  credentialId: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean; sessionId: string | null }> {
  try {
    return await revokeAgentSessionByCredential(env, tenant, authKind, credentialId, reason, nowMs)
  } catch (err) {
    if (isMissingTableError(err)) return { revoked: false, sessionId: null }
    throw err
  }
}
