// member-bearer — resolve a pot member-token (bearer) to its identity.
//
// Shared agent/member bearer resolution for non-MCP surfaces (e.g. fleet check-in).
// Mirrors the MCP auth path in src/mcp/index.ts (sha256 the token → look up a live,
// non-revoked member_token joined to an ACTIVE member). Tenant is environment-
// derived, never client-supplied.
//
// NOTE: src/mcp/index.ts has its own inline copy of this lookup. Once the in-flight
// #41 work lands, dedupe MCP's authenticateMember onto this helper. Kept separate
// for now to avoid editing that file mid-change.

import type { Env } from '../types'
import { resolveCapabilities, hasCapability } from './capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc, shouldStampLastUsed, touchTokenLastUsed } from './token-lifecycle'
import { authLookupOrNull } from './fail-closed'
import { vipLaneEnabled } from '../members/vip-lane'
import { withAuthTiming } from '../lib/server-timing'

export interface AgentIdentity {
  // Exact live member_tokens row that authenticated this request. Never supplied
  // by the caller; verification uses it to prove the issued credential was used.
  tokenId: string
  memberId: string
  displayName: string
  email: string | null
  // The agent this token is BOUND to (member_tokens.agent_id), or null for a pure
  // human/operator principal. The weld between the member plane and the agent plane:
  // an agent-scoped token's holder IS that agent (orient/presence/attribution use it).
  boundAgentId: string | null
}

/** SHA-256 hex digest of a raw member token — store/pass this, never the raw secret. */
export async function hashMemberToken(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Parse "Bearer <token>" → raw token, or null. Same shape as the MCP extractor.
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}

// Resolve a raw bearer token to an identity, or null on any failure (no oracle —
// a missing token and a bad token are indistinguishable to the caller).
export async function resolveMemberByToken(env: Env, raw: string | null): Promise<AgentIdentity | null> {
  // mupot#1281 — this copy sits under Hono's error handler, so its throw surfaced as a
  // clean 500 rather than a 1101. Same fault, different surface; guarded the same way.
  return withAuthTiming(env, () => authLookupOrNull('resolveMemberByToken', () => resolveMemberByTokenInner(env, raw)))
}

/** Stream entry must distinguish an unavailable authority from a bad credential.
 * Keep ordinary callers' historical null behavior unchanged. */
export async function resolveStreamMemberByToken(env: Env, raw: string | null): Promise<
  { status: 'valid'; identity: AgentIdentity } | { status: 'invalid' | 'error' }
> {
  try {
    const identity = await boundedStreamLookup(() => withAuthTiming(env, () => resolveMemberByTokenInner(env, raw)))
    return identity ? { status: 'valid', identity } : { status: 'invalid' }
  } catch { return { status: 'error' } }
}

/** Connection-entry checks must not strand sockets/requests on a hung D1 call. */
export async function boundedStreamLookup<T>(lookup: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('stream_lookup_timeout')), 5000) })
  try { return await Promise.race([Promise.resolve().then(lookup), timeout]) }
  finally { clearTimeout(timer!) }
}

/** #2060 P1-c: the seat status rides the ONE token query (no second read that could fail open). VIP_LANE off = no join, no column read.
 *  A seat row that is observed/held (or any unknown value) floors the bearer; a non-seat agent (no seat row) and trusted/NULL are unaffected. */
export function seatFloorSql(env: Env, agentExpr = 't.agent_id'): { select: string; join: string } {
  return vipLaneEnabled(env)
    ? { select: ', s.admission_status AS seat_status, s.id AS seat_row_id', join: `LEFT JOIN agent_seats s ON s.agent_id = ${agentExpr} AND s.tenant = t.tenant AND s.retired_at IS NULL` }
    : { select: ', NULL AS seat_status, NULL AS seat_row_id', join: '' }
}
/** The seat status carried on AuthContext from the ONE token query: undefined = flag off (not read), null = not a seat agent / no status,
 *  otherwise the stored value (an unknown stored value maps to 'held', fail closed). No second read exists to fail open. */
export function seatAgentStatusFromRow(env: Env, row: { seat_row_id?: string | null; seat_status?: string | null }): 'observed' | 'trusted' | 'held' | null | undefined {
  if (!vipLaneEnabled(env)) return undefined
  if (typeof row.seat_row_id !== 'string' || typeof row.seat_status !== 'string') return null
  return row.seat_status === 'observed' || row.seat_status === 'trusted' ? row.seat_status : 'held'
}
const seatRowFloors = (row: { seat_row_id: string | null; seat_status: string | null }): boolean =>
  typeof row.seat_row_id === 'string' && typeof row.seat_status === 'string' && row.seat_status !== 'trusted'

async function resolveMemberByTokenInner(env: Env, raw: string | null): Promise<AgentIdentity | null> {
  if (!raw) return null
  const tokenHash = await hashMemberToken(raw)
  const sf = seatFloorSql(env)
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, m.id AS member_id, m.display_name AS display_name, m.email AS email, m.status AS status, t.agent_id AS bound_agent_id, t.last_used_at AS last_used_at${sf.select}
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
       ${sf.join}
      WHERE t.token_hash = ?1
        AND t.tenant = ?2
        AND m.tenant = ?2
        -- 0099: same shared liveness predicate mcp/index.ts authenticateMember uses.
        -- These two lookups are known duplicates (see this file's header, #41). Expiry
        -- enforced in one but not the other would make THIS the door an expired
        -- credential still opens, so both execute the one export.
        AND ${TOKEN_LIVE_PREDICATE('?3')}
        -- mupot#1794 W4: a 'directory' unbound token is a zero-standing harness credential (seat_select
        -- only). These REST surfaces authorise by member id, so letting it resolve here would turn a
        -- zero-standing credential into the human's FULL authority. No other directory token is ever
        -- presentable (raw discarded at mint), so this is inert for every existing credential.
        AND t.channel <> 'directory'
      LIMIT 1`,
  )
    .bind(tokenHash, env.TENANT_SLUG, nowSqlUtc())
    .first<{ token_id: string; member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null; last_used_at?: string | null; seat_status: string | null; seat_row_id: string | null }>()
  if (!row || row.status !== 'active') return null
  // #2060 P1-c: every REST surface resolves its bearer here. A seat agent that is observed/held has no REST reach (the observed floor is
  // MCP tool names; REST routes are not on it), so a human-minted token bound to such a seat agent resolves to nobody. VIP_LANE off = no-op.
  if (seatRowFloors(row)) return null
  // 0099: best-effort usage stamp, same contract as the mcp/index.ts copy — telemetry
  // that makes cleanup possible, never an authorization input.
  // Throttled: skipped when the row we just read says it was stamped < 60 s ago (D1 write load).
  if (shouldStampLastUsed(row.last_used_at, Date.now())) void touchTokenLastUsed(env, tokenHash)
  return {
    tokenId: row.token_id,
    memberId: row.member_id,
    displayName: row.display_name,
    email: row.email,
    boundAgentId: row.bound_agent_id ?? null,
  }
}

/**
 * Re-check a previously accepted subscription's token hash: still unrevoked,
 * still bound to the expected member, member still active. Used by long-lived
 * presence WebSockets so revoke/deactivate takes effect without waiting for disconnect.
 */
export async function memberTokenHashIsLive(
  env: Env,
  tokenHash: string,
  expectedMemberId: string,
): Promise<boolean> {
  if (!tokenHash || !expectedMemberId) return false
  const sf = seatFloorSql(env)
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.status AS status, t.agent_id AS bound_agent_id${sf.select}
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
       ${sf.join}
      WHERE t.token_hash = ?1
        AND t.tenant = ?2
        AND m.tenant = ?2
        AND ${TOKEN_LIVE_PREDICATE('?3')}
        AND t.channel <> 'directory' -- mupot#1794 W4: see resolveMemberByToken
      LIMIT 1`,
  )
    .bind(tokenHash, env.TENANT_SLUG, nowSqlUtc())
    .first<{ member_id: string; status: string; bound_agent_id: string | null; seat_status: string | null; seat_row_id: string | null }>()
  if (row && seatRowFloors(row)) return false // #2060 P1-c: a live presence socket drops when its seat is observed/held
  return !!row && row.status === 'active' && row.member_id === expectedMemberId
}

// Resolve a bearer token to an ORG-ADMIN identity, or a refusal. Shared by the
// money/field-spending inbound surfaces (the #70 flight connector + the orient
// field-push) — the mind calls these as an org-admin service principal. 401 =
// missing/bad token (no auth oracle); 403 = valid token, not org-admin.
export async function resolveOrgAdmin(
  env: Env,
  authHeader: string | null | undefined,
): Promise<{ ok: true; id: AgentIdentity } | { ok: false; status: 401 | 403 }> {
  const id = await resolveMemberByToken(env, bearerToken(authHeader))
  if (!id) return { ok: false, status: 401 }
  const caps = await resolveCapabilities(env, id.memberId)
  if (!hasCapability(caps, 'org', null, 'admin')) return { ok: false, status: 403 }
  return { ok: true, id }
}
