// mupot#1794 W2 — seat handles: a selected seat AUTHENTICATES AS its agent, per request, with no
// per-agent API key.
//
// MODEL. seat_select (W1) resolves (human, harness, workspace key) -> ONE agent and now also mints
// an opaque SEAT HANDLE (32 random bytes, base64url; only sha256 is stored — migration 0199). A
// later request presents the handle (header `X-Mupot-Seat` carrying the `mseat_` prefix, or `_meta["mupot/seat"]` on the call)
// next to the human's ordinary OAuth grant. applySeatHandle() then builds the request context AS
// the seat agent.
//
// THE HANDLE IS A SELECTOR, NOT A CREDENTIAL. It resolves only while ALL of these hold, in one SQL
// statement (so there is no check-then-use gap): the human's directory grant token
// (grant_token_id) is live AND unbound (agent_id IS NULL) AND still the same member, the harness
// row still belongs to that member and equals the handle's harness, the consenting member is
// active, the seat is not retired, the agent is active with a welded dedicated member that is
// active, and the agent's server-held seat directory token (minted by W1, raw value discarded) is
// live. Presenting someone else's handle, a handle from another harness of the same human, a
// handle after the grant was re-consented, or a revoked handle never matches. A handle that does
// not match is IGNORED (the human's own unbound context stands) and recorded as
// `seat_handle_rejected` for the identity receipt — it never errors, never 500s, and never
// reveals which condition failed.
//
// AUTHORITY. The resulting context is `resolveSeatCapabilities`: per scope, min(the human's LIVE rank
// on that scope, the agent's rank where the scope comes from the agent's own grant, 'member'); a scope
// the human holds nothing on is dropped, so an agent's grant can only narrow, never widen. The human
// must still be admin on the agent's home squad. Re-derived live on every request, never frozen.
// Org / department grants keep hasCapability's existing rule: they do not reach a kind='home' squad.
// Admin/owner is never produced here. Zero capabilities -> the human's ORIGINAL context comes back
// (never a zero-capability context wearing the agent's member id).
//
// WHAT NEVER SELECTS A SEAT BY ITSELF: Mcp-Session-Id (ChatGPT re-initialises per call, Claude web shares
// one session, spec 2026-07-28 removes protocol sessions), clientInfo, openai/subject. Within THIS
// module the hints are presence-only. W5a (src/members/seat-auto.ts) is the one place a client key
// (openai/session, then Codex threadId) selects the member's OWN seat under the SAME harness, and only
// when no handle was presented.
//
// FLAG: SEAT_AUTO_ENROLL === '1'. Off -> applySeatHandle returns its input untouched before any read.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import { capabilityRank, resolveCapabilities, canOnSquad } from '../auth/capability'
import { humanMaxRankOnScope } from '../mcp/oauth-authorize'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { seatAutoEnrollEnabled } from './harness'
import { sha256Hex } from './service'

/** Live handles per seat. seat_select evicts the least-recently-used one at the cap, so it bounds
 *  growth without ever locking a seat out; the BEFORE INSERT trigger (0199) is the hard backstop. */
export const SEAT_HANDLE_MAX_LIVE_PER_SEAT = 32

/** last_used_at is bookkeeping, not a guard: refresh it at most this often, so a busy session is
 *  not a write per request. */
export const SEAT_HANDLE_TOUCH_INTERVAL_MS = 10 * 60 * 1000

const HANDLE_BYTES = 32
/** Recognisable prefix. X-Mupot-Seat is ALSO a long-standing cosmetic seat LABEL header (e.g.
 *  'cursor-mac'); only a value starting with this prefix is treated as a handle carrier, anything
 *  else stays a plain label and is never looked up or counted as a rejected handle. */
export const SEAT_HANDLE_PREFIX = 'mseat_'
// prefix + 32 bytes -> 43 base64url chars, no padding. Anything else cannot be a handle we issued,
// so it is rejected before any DB read (cheap guard against probing with garbage).
const HANDLE_RE = /^mseat_[A-Za-z0-9_-]{43}$/

/** The member-rank ceiling a seat session can ever hold. */
const SEAT_CEILING: Capability = 'member'

export function mintSeatHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(HANDLE_BYTES))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return SEAT_HANDLE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isWellFormedSeatHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_RE.test(value)
}

export async function hashSeatHandle(handle: string): Promise<string> {
  return sha256Hex(handle)
}

export interface SeatHandleIssue {
  /** The raw handle. Returned to the caller exactly once; only its hash is stored. */
  handle: string
  /** Statements to run (in order) in the caller's batch / a batch of their own. */
  statements: D1PreparedStatement[]
  /** Index of the INSERT inside `statements` (the eviction statement legitimately writes 0 rows). */
  insertIndex: number
}

/**
 * Prepare the eviction + insert for one new handle. The eviction revokes this seat's
 * least-recently-used live handle ONLY when the seat is already at the cap; the insert is the
 * statement whose success matters. The insert's own BEFORE INSERT trigger aborts the batch if a
 * concurrent issuer filled the cap in between.
 */
export async function prepareSeatHandleIssue(
  env: Env,
  p: { seatId: string; agentId: string; harnessId: string; consentingMemberId: string; grantTokenId: string },
  nowIso: string = new Date().toISOString(),
): Promise<SeatHandleIssue> {
  const handle = mintSeatHandle()
  const handleHash = await hashSeatHandle(handle)
  const evict = env.DB.prepare(
    `UPDATE seat_handles SET revoked_at = ?2
      WHERE id = (SELECT id FROM seat_handles
                   WHERE seat_id = ?1 AND revoked_at IS NULL
                   ORDER BY COALESCE(last_used_at, created_at) ASC, created_at ASC LIMIT 1)
        AND (SELECT COUNT(*) FROM seat_handles WHERE seat_id = ?1 AND revoked_at IS NULL) >= ?3`,
  ).bind(p.seatId, nowIso, SEAT_HANDLE_MAX_LIVE_PER_SEAT)
  const insert = env.DB.prepare(
    `INSERT INTO seat_handles (id, tenant, handle_hash, seat_id, agent_id, harness_id, consenting_member_id, grant_token_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(crypto.randomUUID(), env.TENANT_SLUG, handleHash, p.seatId, p.agentId, p.harnessId, p.consentingMemberId, p.grantTokenId, nowIso)
  return { handle, statements: [evict, insert], insertIndex: 1 }
}

// ── capabilities ────────────────────────────────────────────────────────────


/**
 * The effective capability set of a seat session, per scope:
 *
 *     min( the human's LIVE rank on that scope, the agent's rank where the scope comes from the
 *          agent's own grant, 'member' )
 *
 * with a scope the human holds NOTHING on dropped outright. The human side uses the SAME ladder walk
 * as resolveConsentedAgentCapabilities (humanMaxRankOnScope, reused, not copied), so department/org
 * inheritance and the "org grants never cover a kind='home' squad" rule are identical. The agent's
 * grants can therefore only narrow the result, never widen it: a grant someone gave the agent on a
 * squad the human is not on yields nothing there, and removing the human from a squad removes it from
 * the seat on the very next request.
 *
 * Precondition: the human must still stand as ADMIN on the agent's own (home) squad, the same floor
 * /oauth/consent applies. Returns [] otherwise, and the caller falls back to the human's context.
 * Every grant is re-stamped to the agent's dedicated member id. Admin/owner is never produced.
 */
export async function resolveSeatCapabilities(
  env: Env,
  p: { humanMemberId: string; agentId: string; agentSquadId: string; agentMemberId: string },
): Promise<CapabilityGrant[]> {
  const humanGrants = await resolveCapabilities(env, p.humanMemberId)
  if (!(await canOnSquad(env, humanGrants, p.agentSquadId, 'admin'))) return []
  const agentGrants = await resolveCapabilities(env, p.agentMemberId)

  const memberRank = capabilityRank(SEAT_CEILING)
  const merged = new Map<string, CapabilityGrant>()
  const consider = async (g: CapabilityGrant, fromAgent: boolean): Promise<void> => {
    const humanRank = await humanMaxRankOnScope(env, humanGrants, g.scope_type, g.scope_id)
    const rank = Math.min(humanRank, memberRank, fromAgent ? capabilityRank(g.capability) : memberRank)
    if (rank <= 0) return // the human holds nothing here (or the value is unknown): dropped, never defaulted
    const cap = RANK_ASC.find((c) => capabilityRank(c) === rank)
    if (!cap) return
    const key = `${g.scope_type}\u0000${g.scope_id ?? ''}`
    const prior = merged.get(key)
    if (!prior || rank > capabilityRank(prior.capability)) {
      merged.set(key, { member_id: p.agentMemberId, scope_type: g.scope_type, scope_id: g.scope_id, capability: cap })
    }
  }
  for (const g of humanGrants) await consider(g, false)
  for (const g of agentGrants) await consider(g, true)
  return [...merged.values()]
}

const RANK_ASC: readonly Capability[] = ['observer', 'member', 'lead', 'admin', 'owner']

// ── request inputs ──────────────────────────────────────────────────────────

/** Presence-only hints. Never used to select or authorise anything. */
export interface HarnessHints {
  openai_session: boolean
  openai_subject: boolean
  codex_thread_id: boolean
}

export interface SeatRequestInputs {
  /** `X-Mupot-Seat` header value, if any. */
  headerHandle?: string | null
  /** `_meta["mupot/seat"]` (call params or call arguments), if any. */
  metaHandle?: string | null
  hints: HarnessHints
}

export const NO_HINTS: HarnessHints = { openai_session: false, openai_subject: false, codex_thread_id: false }

/** What the request carried, resolved to ONE candidate. A `_meta` handle wins when present. The
 *  header is a handle carrier ONLY when it carries the handle prefix; otherwise it is a cosmetic
 *  label and contributes nothing here. A chosen candidate that fails is NOT retried against the
 *  other carrier (one candidate, one verdict). */
export function pickHandle(inputs: SeatRequestInputs): string | null {
  if (typeof inputs.metaHandle === 'string' && inputs.metaHandle.length > 0) return inputs.metaHandle
  const header = typeof inputs.headerHandle === 'string' ? inputs.headerHandle.trim() : ''
  if (header.startsWith(SEAT_HANDLE_PREFIX)) return header
  return null
}

interface MatchRow {
  handle_id: string
  last_used_at: string | null
  seat_id: string
  seat_label: string
  agent_id: string
  agent_squad_id: string
  agent_member_id: string
  agent_email: string | null
  seat_token_id: string | null
  harness_id: string
}

/**
 * The single, atomic match. Everything that must be true is in ONE statement.
 *   ?1 tenant  ?2 handle hash  ?3 grant token id  ?4 human member id  ?5 harness id  ?6 now
 */
async function findLiveSeatForHandle(
  env: Env,
  handleHash: string,
  grantTokenId: string,
  humanMemberId: string,
  harnessId: string,
): Promise<MatchRow | null> {
  return env.DB.prepare(
    `SELECT h.id AS handle_id, h.last_used_at AS last_used_at, h.seat_id AS seat_id,
            s.label_basename AS seat_label, a.id AS agent_id, a.squad_id AS agent_squad_id,
            b.member_id AS agent_member_id, am.email AS agent_email, h.harness_id AS harness_id,
            (SELECT t.id FROM member_tokens t
              WHERE t.id = s.seat_token_id AND t.member_id = b.member_id AND t.agent_id = a.id
                AND t.tenant = ?1 AND t.channel = 'directory'
                AND ${TOKEN_LIVE_PREDICATE('?6')}) AS seat_token_id
       FROM seat_handles h
       JOIN agent_seats s ON s.id = h.seat_id AND s.tenant = h.tenant
       JOIN agents a ON a.id = h.agent_id
       JOIN agent_member_bindings b ON b.tenant = h.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = h.tenant AND am.status = 'active'
       JOIN members hm ON hm.id = h.consenting_member_id AND hm.tenant = h.tenant AND hm.status = 'active'
       JOIN harnesses hr ON hr.id = h.harness_id AND hr.tenant = h.tenant AND hr.member_id = h.consenting_member_id
      WHERE h.tenant = ?1
        AND h.handle_hash = ?2
        AND h.revoked_at IS NULL
        AND h.grant_token_id = ?3
        AND h.consenting_member_id = ?4
        AND h.harness_id = ?5
        AND s.retired_at IS NULL
        AND s.agent_id = h.agent_id
        AND s.member_id = h.consenting_member_id
        AND s.harness_id = h.harness_id
        AND a.status = 'active'
        AND EXISTS (SELECT 1 FROM member_tokens g
                     WHERE g.id = ?3 AND g.member_id = ?4 AND g.tenant = ?1
                       AND g.channel = 'directory' AND g.agent_id IS NULL
                       AND ${TOKEN_LIVE_PREDICATE('?6').replace(/\bt\./g, 'g.')})
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, handleHash, grantTokenId, humanMemberId, harnessId, nowSqlUtc()).first<MatchRow>()
}

async function touchHandle(env: Env, row: MatchRow, nowMs: number): Promise<void> {
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN
  if (Number.isFinite(last) && nowMs - last < SEAT_HANDLE_TOUCH_INTERVAL_MS) return
  try {
    await env.DB.prepare(`UPDATE seat_handles SET last_used_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`)
      .bind(row.handle_id, new Date(nowMs).toISOString()).run()
  } catch {
    // Bookkeeping only. A failed touch must never fail the request.
  }
}

/** Seat state a downstream reader (the identity receipt) needs. Never client-controlled. */
export type SeatBindingSource = 'handle' | 'auto:openai_session' | 'auto:codex_thread'

export interface SeatBinding {
  seatId: string
  label: string
  harnessId: string
  grantTokenId: string
  humanMemberId: string
  /** How the server bound this request to the seat. 'handle' = a presented mseat_ handle; 'auto:*' =
   *  W5a client-key auto-seat (src/members/seat-auto.ts). Server-derived, never client-controlled. */
  source: SeatBindingSource
}

export interface SeatInputsRecord {
  handleRejected: boolean
  hints: HarnessHints
  /** W5a: an auto-seat was attempted and refused (cap, throttle, inactive seat...). The request stays
   *  the human's own unbound context; this is receipt input only. */
  autoSeatRefused?: string
}

/** The columns buildSeatContext needs; MatchRow (handle path) and the auto-seat match both satisfy it. */
export type SeatContextRow = Pick<MatchRow, 'seat_id' | 'seat_label' | 'agent_id' | 'agent_squad_id' | 'agent_member_id' | 'agent_email' | 'harness_id'> & { seat_token_id: string }

/**
 * ONE place that turns a verified seat row + the human's unbound grant into the seat agent's request
 * context (shared by the handle path and the W5a auto-seat). Returns null on zero capabilities.
 */
export async function buildSeatContext(
  env: Env,
  human: { memberId: string; tokenId: string },
  row: SeatContextRow,
  hints: HarnessHints,
  source: SeatBindingSource,
): Promise<AuthContext | null> {
  const capabilities = await resolveSeatCapabilities(env, {
    humanMemberId: human.memberId,
    agentId: row.agent_id,
    agentSquadId: row.agent_squad_id,
    agentMemberId: row.agent_member_id,
  })
  if (capabilities.length === 0) return null
  return {
    userId: row.agent_member_id,
    email: row.agent_email,
    role: 'member', // coarse org-role; real authz is `capabilities`
    tenant: env.TENANT_SLUG,
    memberId: row.agent_member_id,
    channel: 'directory',
    capabilities,
    // The seat session is deliberately NOT given the human's raw standing grants as "latent"
    // authority: latent == the clamped set, so the explicit-named-act escape hatch cannot widen it.
    latentCapabilities: capabilities,
    boundAgentId: row.agent_id,
    consentedByMemberId: human.memberId,
    tokenId: row.seat_token_id,
    harnessId: row.harness_id,
    seatBinding: {
      seatId: row.seat_id,
      label: row.seat_label,
      harnessId: row.harness_id,
      grantTokenId: human.tokenId,
      humanMemberId: human.memberId,
      source,
    },
    seatInputs: { handleRejected: false, hints },
  }
}

/**
 * Apply a presented seat handle to the HUMAN's unbound directory context.
 *
 * Returns the seat agent's context on a match, otherwise the human's context (with
 * `seatInputs.handleRejected` set when a handle WAS presented). Fails closed to the human's
 * original context on any error. The gate order is flag -> unbound directory + harness -> a
 * candidate handle; each earlier check short-circuits before any read.
 */
export async function applySeatHandle(
  env: Env,
  human: AuthContext,
  inputs: SeatRequestInputs,
  nowMs: number = Date.now(),
): Promise<AuthContext> {
  if (!seatAutoEnrollEnabled(env)) return human
  if (
    human.channel !== 'directory'
    || human.boundAgentId
    || typeof human.memberId !== 'string'
    || typeof human.harnessId !== 'string' || human.harnessId.length === 0
    || typeof human.tokenId !== 'string' || human.tokenId.length === 0
  ) {
    // Legacy agent-bound grants, workspace/im/dashboard channels and harness-less grants: a handle
    // presented here is not even looked at.
    return human
  }

  const candidate = pickHandle(inputs)
  const record = (rejected: boolean): AuthContext => ({ ...human, seatInputs: { handleRejected: rejected, hints: inputs.hints } })
  if (candidate === null) return record(false)
  if (!isWellFormedSeatHandle(candidate)) return record(true)

  try {
    const hash = await hashSeatHandle(candidate)
    const row = await findLiveSeatForHandle(env, hash, human.tokenId, human.memberId, human.harnessId)
    if (!row || !row.seat_token_id) return record(true)

    const bound = await buildSeatContext(env, { memberId: human.memberId, tokenId: human.tokenId }, { ...row, seat_token_id: row.seat_token_id }, inputs.hints, 'handle')
    // Never a zero-capability context wearing the agent's identity: fall back to the human.
    if (!bound) return record(true)
    await touchHandle(env, row, nowMs)
    return bound
  } catch {
    return record(true)
  }
}
