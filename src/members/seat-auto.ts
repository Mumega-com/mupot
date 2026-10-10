// mupot flight "agents as themselves" W5a — server-side AUTO-SEAT from a per-thread client key.
//
// WHY. A client that cannot attach a seat handle (ChatGPT: the model cannot add `_meta`, and the
// connector holds ONE OAuth grant) still sends a per-conversation `_meta["openai/session"]` on every
// tools/call. Without this, every ChatGPT thread behind one grant collapses into one unbound session.
//
// WHAT. On an UNBOUND harness session (OAuth harness grant or harness token) that presents NO seat
// handle, a recognised client key selects a seat: `openai/session` first, the Codex `threadId` second.
// The seat is the SAME `agent_seats` identity seat_select uses, keyed (tenant, member, harness,
// HASH(client key)), created through the SAME core (resolveOrCreateSeat: live / total / per-harness
// lifetime caps, cap triggers, per-member + per-harness-window throttle, audit row, welded identity,
// member-capability ceiling) and applied to THIS request through the SAME context builder as a handle
// (buildSeatContext: per-scope min(human, agent, member) clamp, admin floor on the home squad).
//
// TRUST BOUNDARY (read before changing anything).
//  * The client key is CLIENT-SUPPLIED and therefore a SELECTOR, never a credential. It is mixed with
//    the member id and the harness id inside the seat key hash, so it can only ever reach (or create)
//    a seat of the SAME member under the SAME harness. It cannot name another member's seat, another
//    harness's seat, or an existing non-seat agent (agents are never looked up by name or by key).
//  * A forged or guessed key therefore only creates / reaches ANOTHER seat of the same member+harness.
//    Threads behind one grant are NOT isolated from a hostile holder of that grant: whoever holds the
//    grant can mint any key and act as any of that grant's seats. This is the stance of #1806 /
//    seat_select (labels select, they do not authenticate). What the key buys is per-thread identity
//    for cooperative clients, not a boundary between mutually hostile holders of one grant.
//  * BUDGET. Auto seats are a SEPARATE pool (migration 0205, agent_seats.source='auto'): they never count
//    against the member live/lifetime caps or the per-harness lifetime cap that seat_select seats use,
//    and they never spend the member's seat_select throttle. The pool is bounded per HARNESS: at most
//    AUTO_SEAT_LIVE_PER_HARNESS live auto seats; when it is full the least-recently-used live auto seat
//    of that harness is RECLAIMED (retired, its agent deactivated, its token revoked) inside the creating
//    batch instead of refusing. A retired auto seat is never resurrected: that conversation, if it
//    returns, gets a fresh seat (new agent, no memory of the old one). The hard abuse bound on creation is
//    an ATOMIC per-harness window in D1 (AUTO_SEAT_HARNESS_WINDOW_MAX per 5 min, fails closed); it does
//    not depend on any lifetime cap. Refusals never fail the request: it stays the human's own unbound
//    (zero-capability) context, with the reason on the receipt, and a refusal is cached briefly per
//    (harness, key) so a refused conversation does not re-run the creation path on every call.
//  * REACH. A seat is found by (member, harness, key hash) and the human's grant only has to be LIVE,
//    UNBOUND and the same member+harness: any such grant (e.g. after a re-consent) reaches the same seat.
//  * The raw key is never stored or logged: it is hashed here, and only the final seat key_hash (which
//    also mixes member + harness) is persisted. `Mcp-Session-Id` is never read.
//  * An explicit seat handle ALWAYS wins; a presented-but-rejected handle never falls back to an
//    auto-seat (applySeatForRequest). The seat name is a LABEL (deriveSeatName), never authority.
//
// FLAG: SEAT_AUTO_ENROLL === '1' only (no new flag). Off -> applySeatHandle already returned the input
// untouched and this module never runs.

import type { AuthContext, Env } from '../types'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { loadHarness } from './harness'
import { normalizeSeatKey, seatKeyHash, type NormalizedSeatKey } from './seat-key'
import {
  applySeatHandle, buildSeatContext, SEAT_HANDLE_TOUCH_INTERVAL_MS,
  type HarnessHints, type SeatBindingSource, type SeatContextRow, type SeatRequestInputs,
} from './seat-handle'
import { resolveOrCreateSeat } from './seat-select'
import { sha256Hex } from './service'

/** A key longer than this is not a conversation id; ignored (never hashed, never a seat). */
export const AUTO_SEAT_KEY_MAX_LEN = 512

/** Max fresh-seat generations per conversation key (each reclaim of a returning conversation spends one). */
export const AUTO_SEAT_MAX_GENERATIONS = 8

/** Raw per-thread client keys lifted from `_meta`. Only ever hashed, never stored. */
export interface AutoSeatKeys {
  openaiSession: string | null
  codexThreadId: string | null
}

export interface AutoSeatCandidate {
  source: Extract<SeatBindingSource, 'auto:openai_session' | 'auto:codex_thread'>
  raw: string
}

/** openai/session first, Codex threadId second. Empty / over-long values are not keys. */
export function pickAutoSeatKey(keys: AutoSeatKeys | undefined): AutoSeatCandidate | null {
  if (!keys) return null
  const ok = (v: string | null): v is string => typeof v === 'string' && v.length > 0 && v.length <= AUTO_SEAT_KEY_MAX_LEN
  if (ok(keys.openaiSession)) return { source: 'auto:openai_session', raw: keys.openaiSession }
  if (ok(keys.codexThreadId)) return { source: 'auto:codex_thread', raw: keys.codexThreadId }
  return null
}

/** The normalised seat key for a client key. Labels are derived from the HASH of the client key, so
 *  the raw value never reaches seat-key normalisation, the key hash input, the DB or a display name.
 *  Domain-separated per source: the same string as an openai session and as a Codex thread differ. */
export async function autoSeatKey(c: AutoSeatCandidate, gen = 0): Promise<NormalizedSeatKey> {
  const digest = await sha256Hex(`mupot:auto-seat:v1:${c.source}:${c.raw}`)
  // GENERATION: a RECLAIMED (retired) auto seat is never resurrected, but the conversation may return. It
  // then gets a FRESH seat under generation + 1 (a different key hash, hence a different agent). Generation
  // 0 carries no suffix, so every seat created before generations existed keeps its identity.
  const r = normalizeSeatKey({ project: `thread-${digest.slice(0, 6)}`, thread: `${c.source}:${digest.slice(0, 32)}${gen > 0 ? `:g${gen}` : ''}` })
  if (!r.ok) throw new Error('auto_seat_key_invalid') // unreachable: the inputs are generated from hex
  return r.key
}

interface AutoMatchRow extends SeatContextRow {
  seat_token_id: string
  last_used_at: string | null
}

// ── refusal cache ────────────────────────────────────────────────────────────
// A refused auto conversation must not re-run the creation path (home lookup, name lookup, statement
// prep, window UPSERT) on every call. Deterministic refusals are remembered per (harness, key hash) for
// a short TTL, per isolate (lossy by design: a cold isolate just re-evaluates once). A window refusal is
// remembered per HARNESS too, so a looping client stalls on one map hit, not on a database round trip.
// Never cached: 'error' / 'provisioning_failed' (transient). seat_key_source_conflict is deterministic for a
// (member, harness, key hash): the key is the member's own and a seat row's source never changes, so the
// per-(harness, key hash) cache key and the 30s TTL are safe (never harness-wide: not a window refusal).
export const AUTO_SEAT_REFUSAL_TTL_MS = 30_000
const REFUSAL_CACHE_MAX = 2000
const refusalCache = new Map<string, { reason: string; until: number }>()
const CACHEABLE = new Set(['rate_limited', 'seat_agent_inactive', 'home_rank_insufficient', 'member_not_active', 'harness_required', 'seat_not_live', 'seat_cap_reached', 'seat_key_source_conflict'])

export function resetAutoSeatRefusalCache(): void { refusalCache.clear() }

/** `wide` = the harness-wide window refusal. It only gates CREATION (consulted after the live-seat lookup
 *  misses), so a stalled window never blocks conversations that already have a seat. */
function cachedRefusal(harnessId: string, keyHash: string, nowMs: number, wide: boolean): string | null {
  const k = wide ? `${harnessId}:*` : `${harnessId}:${keyHash}`
  const e = refusalCache.get(k)
  if (e && e.until > nowMs) return e.reason
  if (e) refusalCache.delete(k)
  return null
}

function cacheRefusal(harnessId: string, keyHash: string, reason: string, detail: unknown, nowMs: number): void {
  if (!CACHEABLE.has(reason)) return
  if (refusalCache.size >= REFUSAL_CACHE_MAX) refusalCache.clear()
  const harnessWide = reason === 'rate_limited' && typeof detail === 'object' && detail !== null && (detail as { scope?: unknown }).scope === 'harness_window'
  const entry = { reason, until: nowMs + AUTO_SEAT_REFUSAL_TTL_MS }
  refusalCache.set(`${harnessId}:${keyHash}`, entry)
  if (harnessWide) refusalCache.set(`${harnessId}:*`, entry)
}

/**
 * The single live match for an auto-seat: ONE statement, so there is no check-then-use gap. Mirrors
 * the handle match (findLiveSeatForHandle) minus the handle table, and pins what a handle's row pins:
 * the seat belongs to THIS member + harness + key hash, is not retired, its agent is active with an
 * active welded member and a live server-held seat token, the consenting member is active, the harness
 * row belongs to the member (and a TOKEN harness is only ever the credential that IS it), and the
 * human's grant token is live + unbound.
 *   ?1 tenant ?2 key hash ?3 grant token id ?4 human member id ?5 harness id ?6 now
 */
export async function findLiveAutoSeat(
  env: Env, keyHash: string | string[], grantTokenId: string, humanMemberId: string, harnessId: string,
): Promise<AutoMatchRow | null> {
  const hashes = Array.isArray(keyHash) ? keyHash : [keyHash]
  const inList = hashes.map((_, i) => (i === 0 ? '?2' : `?${6 + i}`)).join(', ')
  const row = await env.DB.prepare(
    `SELECT s.id AS seat_id, s.label_basename AS seat_label, s.last_used_at AS last_used_at, a.id AS agent_id, a.squad_id AS agent_squad_id,
            b.member_id AS agent_member_id, am.email AS agent_email, s.harness_id AS harness_id,
            (SELECT t.id FROM member_tokens t
              WHERE t.id = s.seat_token_id AND t.member_id = b.member_id AND t.agent_id = a.id
                AND t.tenant = ?1 AND t.channel = 'directory'
                AND ${TOKEN_LIVE_PREDICATE('?6')}) AS seat_token_id
       FROM agent_seats s
       JOIN agents a ON a.id = s.agent_id
       JOIN agent_member_bindings b ON b.tenant = s.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = s.tenant AND am.status = 'active'
       JOIN members hm ON hm.id = s.member_id AND hm.tenant = s.tenant AND hm.status = 'active'
       JOIN harnesses hr ON hr.id = s.harness_id AND hr.tenant = s.tenant AND hr.member_id = s.member_id
      WHERE s.tenant = ?1
        AND s.member_id = ?4
        AND s.harness_id = ?5
        AND s.key_hash IN (${inList})
        AND s.source = 'auto'
        AND s.retired_at IS NULL
        AND a.status = 'active'
        AND (hr.credential_kind <> 'token' OR hr.token_id = ?3)
        AND EXISTS (SELECT 1 FROM member_tokens g
                     WHERE g.id = ?3 AND g.member_id = ?4 AND g.tenant = ?1
                       AND g.channel = 'directory' AND g.agent_id IS NULL
                       AND ${TOKEN_LIVE_PREDICATE('?6').replace(/\bt\./g, 'g.')})
      ORDER BY s.created_at DESC
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, hashes[0], grantTokenId, humanMemberId, harnessId, nowSqlUtc(), ...hashes.slice(1)).first<Omit<AutoMatchRow, 'seat_token_id'> & { seat_token_id: string | null }>()
  if (!row || !row.seat_token_id) return null
  return { ...row, seat_token_id: row.seat_token_id }
}

/** LRU bookkeeping for reclaim: stamped at most every SEAT_HANDLE_TOUCH_INTERVAL_MS, never fails a request. */
async function touchAutoSeat(env: Env, row: AutoMatchRow, nowMs: number): Promise<void> {
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN
  if (Number.isFinite(last) && nowMs - last < SEAT_HANDLE_TOUCH_INTERVAL_MS) return
  try {
    await env.DB.prepare(`UPDATE agent_seats SET last_used_at = ?2 WHERE id = ?1 AND source = 'auto' AND retired_at IS NULL`)
      .bind(row.seat_id, new Date(nowMs).toISOString()).run()
  } catch {
    // Bookkeeping only.
  }
}

/**
 * The one entry point the request path uses (src/mcp/index.ts resolveSeatSession).
 *
 *   1. applySeatHandle runs exactly as before. A matching handle wins (its context is returned). A
 *      presented handle that does not resolve returns `handleRejected` and STOPS here: no fallback.
 *   2. Only when NO handle was presented (the human context came back with handleRejected=false) and a
 *      recognised client key is present does the auto-seat resolve or create the seat and bind it.
 *   3. Any refusal or error returns the human's context with `autoSeatRefused` set; never throws.
 */
export async function applySeatForRequest(
  env: Env,
  human: AuthContext,
  inputs: SeatRequestInputs & { autoKeys?: AutoSeatKeys },
  nowMs: number = Date.now(),
  /** Test seam only: production uses the constants. */
  limits?: { autoLive?: number; windowMax?: number },
): Promise<AuthContext> {
  const afterHandle = await applySeatHandle(env, human, inputs, nowMs)
  // Handle bound, or a handle was presented and failed: the handle's verdict is final.
  if (afterHandle.seatBinding || afterHandle.seatInputs === undefined || afterHandle.seatInputs.handleRejected) return afterHandle
  const candidate = pickAutoSeatKey(inputs.autoKeys)
  if (candidate === null) return afterHandle
  // applySeatHandle's gates passed (that is the only way seatInputs is set), so these are narrowed.
  const memberId = afterHandle.memberId
  const tokenId = afterHandle.tokenId
  const harnessId = afterHandle.harnessId
  if (typeof memberId !== 'string' || typeof tokenId !== 'string' || typeof harnessId !== 'string') return afterHandle
  const refuse = (reason: string): AuthContext => ({
    ...afterHandle,
    seatInputs: { handleRejected: false, hints: inputs.hints, autoSeatRefused: reason },
  })
  try {
    // The conversation's identity is its generation-0 hash (cache key, fast path). Later generations
    // exist only after a reclaim retired the earlier seat.
    const key0 = await autoSeatKey(candidate)
    const hash0 = await seatKeyHash(memberId, harnessId, key0)
    const cached = cachedRefusal(harnessId, hash0, nowMs, false)
    if (cached !== null) return refuse(cached)
    let row = await findLiveAutoSeat(env, hash0, tokenId, memberId, harnessId)
    const gens: Array<{ key: NormalizedSeatKey; hash: string }> = [{ key: key0, hash: hash0 }]
    const allGens = async (): Promise<void> => {
      for (let g = gens.length; g < AUTO_SEAT_MAX_GENERATIONS; g++) {
        const key = await autoSeatKey(candidate, g)
        gens.push({ key, hash: await seatKeyHash(memberId, harnessId, key) })
      }
    }
    if (row === null) {
      // A returning conversation whose generation-0 seat was reclaimed lives under a later generation.
      await allGens()
      row = await findLiveAutoSeat(env, gens.map((g) => g.hash), tokenId, memberId, harnessId)
    }
    if (row === null) {
      const wide = cachedRefusal(harnessId, hash0, nowMs, true)
      if (wide !== null) return refuse(wide)
      // First sight of this key (or every earlier generation retired): resolve/create through the shared core.
      const harness = await loadHarness(env, memberId, harnessId)
      if (!harness) return refuse('harness_required')
      if (harness.credential_kind === 'token' && harness.token_id !== tokenId) return refuse('harness_required')
      const member = await env.DB.prepare(`SELECT id FROM members WHERE id = ?1 AND status = 'active' AND tenant = ?2 LIMIT 1`)
        .bind(memberId, env.TENANT_SLUG).first<{ id: string }>()
      if (!member) return refuse('member_not_active')
      let made: Awaited<ReturnType<typeof resolveOrCreateSeat>> | null = null
      for (const g of gens) {
        // grantTokenIdClaim null: an auto-seat needs no handle row, so none is issued.
        made = await resolveOrCreateSeat(env, { memberId, harness, key: g.key, keyHash: g.hash, grantTokenIdClaim: null, source: 'auto', limits, nowMs })
        // Only a RETIRED (reclaimed) seat moves on to a fresh generation; a deactivated agent stays refused.
        // A seat_key_source_conflict deliberately BREAKS the loop (does not advance a generation): the
        // key was taken by the SAME member's explicit seat (nobody else can derive it), so the member can
        // only unseat their own conversation. Pinned by a test (#1820).
        const retired = !made.ok && made.error === 'seat_agent_inactive'
          && typeof made.detail === 'object' && made.detail !== null && (made.detail as { reason?: unknown }).reason === 'seat_retired'
        if (!retired) break
      }
      if (made === null || !made.ok) {
        const err = made === null ? 'seat_not_live' : made.ok ? 'seat_not_live' : made.error
        const detail = made !== null && !made.ok ? made.detail : undefined
        cacheRefusal(harnessId, hash0, err, detail, nowMs)
        return refuse(err)
      }
      row = await findLiveAutoSeat(env, gens.map((g) => g.hash), tokenId, memberId, harnessId)
      if (row === null) { cacheRefusal(harnessId, hash0, 'seat_not_live', undefined, nowMs); return refuse('seat_not_live') }
    }
    const bound = await buildSeatContext(env, { memberId, tokenId }, row, inputs.hints, candidate.source)
    if (!bound) return refuse('no_capabilities')
    await touchAutoSeat(env, row, nowMs)
    return bound
  } catch {
    return refuse('error')
  }
}

export type { HarnessHints }
