// mupot — seat events: one multiplexed, body-free notification channel per fleet host.
//
// WHY. /api/inbox/stream is one server-side D1 poll per open stream (1s cadence, plus a bearer
// revalidation per tick). A host serving N seats across projects holds N of them open forever.
// This channel replaces that for hosts that opt in: the host keeps ONE WebSocket, and Mupot
// pushes a hint only when a row actually lands.
//
// FLOW.
//   send / task_dispatch  → agent_messages INSERT → BUS.emit('message.created')   (existing seam,
//                           src/agents/messages.ts; emitted only on a real insert, never a body)
//   Queue consumer        → publishSeatHint() → SeatEventsDO /hint               (src/bus/consumer.ts)
//   SeatEventsDO          → re-authorizes the grant → sends {type:'hint'} to the one socket
//                           holding that agent                                   (./seat-events-do.ts)
//   host (Orca plugin)    → waits for the seat's turn to end → types one notice; the seat reads
//                           and inbox_acks its OWN inbox with its OWN credential.
//
// AUTHORIZATION — three independent facts, all required, all re-checked on every hint:
//   1. the host proves possession of its registered Ed25519 key (agent_keys; the same signed
//      fleet identity as signed attach/inbox) over a domain-separated, single-use message;
//   2. an explicit seat_event_grants row authorizes THAT host for THAT agent (one live grant
//      per agent — the durable one-consumer-per-UUID fence);
//   3. the agent is active (and, for a project-scoped grant, still has the project).
// The ticket that comes out is short-lived (TICKET_TTL_SEC), single-use, stored only as a hash,
// and scoped to the exact agent list that passed 1–3.
//
// WHAT IS NEVER HERE. Message bodies: every frame is built from HINT_FIELDS, and the catch-up
// query selects those columns by name. Inbox consumption: hints never mark anything read;
// inbox_ack stays the seat's call. Task settlement: task receipts/verdicts are untouched.
//
// NO POLLING. Nothing here runs on a timer. The DO has no alarm; catch-up is one bounded query
// per (connect, agent). The host's keepalive ping is answered by the DO's WebSocket
// auto-response without waking it.

import type { Env, MessageCreatedPayload } from '../types'
import { loadActiveAgentKey } from '../fleet/agent-keys'
import { burnSharedAgentNonce, sharedNonceWindowSec } from '../fleet/shared-nonce-ledger'
import { canOnSquad, capabilityRank, currentMemberRankAtLeastSql, resolveCapabilities } from '../auth/capability'

export const SEAT_EVENTS_FLAG = '1'
export const SEAT_EVENTS_PROTOCOL = 1
// mupot#1595 P1: internal Worker→DO header carrying the ticket's already-verified host, set
// ONLY by seatEventsApp's GET / handler (after atomically consuming the ticket) and read ONLY
// by SeatEventsDO's /connect — never forwarded from, or influenced by, anything client-sent
// (presenceLiveDoUpgradeRequest's own hop-header allowlist doesn't include it, so a
// client-supplied header of this name is dropped before this one is set on top).
export const SEAT_EVENTS_HOST_HEADER = 'x-seat-events-host'
export const TICKET_SIG_DOMAIN = 'seat-events-ticket:v1'
export const TICKET_WINDOW_SEC = sharedNonceWindowSec(TICKET_SIG_DOMAIN)
export const TICKET_TTL_SEC = 60
export const MAX_AGENTS_PER_TICKET = 64
export const BACKLOG_HINT_LIMIT = 50
export const RECENT_HINT_IDS = 1024
export const CLOSE_TICKET_INVALID = 4401
export const CLOSE_NO_SUBSCRIPTIONS = 4409

// mupot#1589 P1-2: an unauthenticated WebSocket could reach SeatEventsDO's /connect and
// `acceptWebSocket` ran before any credential was checked. The Worker route now refuses an
// upgrade with no well-formed ticket in the query string before it ever calls the DO
// (seat-events-routes.ts); the ticket itself is still redeemed exactly once, over the hello
// frame, exactly as before (`onMessage` below) — this is the outer gate, not a protocol
// change. These are the DO-side belt-and-braces controls for what happens between accept and
// a completed hello: a size cap and a junk-frame cap on every frame, a cap on how many
// concurrent authenticated sockets one host may hold, and an auth deadline that closes a
// socket that connects and never completes hello at all.
export const CLOSE_AUTH_TIMEOUT = 4408
export const CLOSE_PROTOCOL_ABUSE = 4400
export const AUTH_DEADLINE_SEC = 15
export const MAX_FRAME_BYTES = 4096
export const MAX_JUNK_FRAMES = 20
export const MAX_SOCKETS_PER_HOST = 8
export const MAX_SOCKETS_PER_POT = 500
// mupot#1594 P1-A: a SEPARATE, small ceiling for sockets that have accepted but not yet
// completed hello. Counting them against MAX_SOCKETS_PER_POT was the anonymous-lockout
// mechanism — 200 forged-ticket connections ate the same 500-socket budget authenticated
// Hermes/Orca hosts need. See podAcceptRefusal below.
export const MAX_PENDING_SOCKETS_PER_POT = 64

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/

/** Format-only check, used by the Worker route to refuse an upgrade with no
 *  credential-shaped ticket before the DO is ever called (mupot#1589 P1-2). It does NOT
 *  prove the ticket is real — only `tickets.take()` (single-use, DO-storage-backed) does
 *  that, over the hello frame, exactly as before. */
export function isWellFormedTicket(s: string): boolean {
  return TICKET_RE.test(s)
}

export function isSeatEventsEnabled(env: Env): boolean {
  return env.REALTIME_SEAT_EVENTS === SEAT_EVENTS_FLAG && env.SEAT_EVENTS !== undefined
}

/** One DO per pot. The commit seam knows the recipient agent, not a fleet, so routing inside the
 *  pot's single channel is an attachment lookup rather than an agent→fleet query per event. */
export function seatEventsChannelName(tenant: string): string {
  const t = tenant.trim()
  if (!t) throw new Error('seat_events_tenant_required')
  return `${t}:seat-events`
}

// ── hints ─────────────────────────────────────────────────────────────────────────────────

/** The complete set of fields a hint may carry. There is no body field and no way to add one
 *  without editing this list — hintFromPayload and the backlog SELECT both derive from it. */
export const HINT_FIELDS = [
  'id', 'seq', 'to_agent', 'from_agent', 'kind', 'request_id', 'in_reply_to', 'target_seat', 'project_id', 'created_at',
] as const

export type SeatHint = {
  id: string
  seq: number
  to_agent: string
  from_agent: string
  kind: string
  request_id: string | null
  in_reply_to: string | null
  target_seat: string | null
  project_id: string | null
  created_at: string
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Build a hint from the committed-message event. Allowlist, never spread: whatever else the
 *  payload grows later cannot reach a socket. Returns null for a malformed payload. */
export function hintFromPayload(p: Partial<MessageCreatedPayload> | null | undefined): SeatHint | null {
  if (!p || typeof p !== 'object') return null
  const seq = Number(p.seq)
  if (typeof p.message_id !== 'string' || !p.message_id) return null
  if (!Number.isSafeInteger(seq) || seq <= 0) return null
  if (typeof p.to_agent !== 'string' || !p.to_agent) return null
  return {
    id: p.message_id,
    seq,
    to_agent: p.to_agent,
    from_agent: typeof p.from_agent === 'string' ? p.from_agent : '',
    kind: typeof p.kind === 'string' ? p.kind : 'message',
    request_id: strOrNull(p.request_id),
    in_reply_to: strOrNull(p.in_reply_to),
    target_seat: strOrNull(p.target_seat),
    project_id: strOrNull(p.project_id),
    created_at: typeof p.created_at === 'string' ? p.created_at : '',
  }
}

/** Re-normalize a hint that crossed a process boundary (Worker → DO). Same allowlist. */
export function normalizeHint(obj: unknown): SeatHint | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  return hintFromRow(o, o.to_agent as string)
}

function hintFromRow(row: Record<string, unknown>, agent: string): SeatHint | null {
  return hintFromPayload({
    message_id: row.id as string,
    seq: Number(row.seq),
    to_agent: agent,
    from_agent: row.from_agent as string,
    kind: row.kind as string,
    request_id: row.request_id as string | null,
    in_reply_to: row.in_reply_to as string | null,
    target_seat: row.target_seat as string | null,
    project_id: row.project_id as string | null,
    created_at: row.created_at as string,
  })
}

// ── frames ────────────────────────────────────────────────────────────────────────────────

export type ServerFrame =
  | { type: 'ready'; protocol: number; host: string; subscriptions: { agent: string; ok: boolean; reason?: string }[] }
  | { type: 'backlog'; agent: string; unread: number; complete: boolean; hints: SeatHint[] }
  | { type: 'hint'; agent: string; hint: SeatHint }
  | { type: 'revoked'; agent: string; reason: string }
  | { type: 'superseded'; agent: string; reason: string }
  | { type: 'error'; reason: string }

export const encodeFrame = (f: ServerFrame): string => JSON.stringify(f)

// ── grants ────────────────────────────────────────────────────────────────────────────────

export type GrantResult =
  | { ok: true; id: string }
  | {
      ok: false
      reason:
        | 'invalid_args'
        | 'agent_not_found'
        | 'host_key_missing'
        | 'host_no_squad_standing'
        | 'project_access_denied'
        | 'agent_already_granted'
        | 'db_error'
    }

// mupot#1594 P2-C: "the HOST must have standing in the target agent's squad." Before this,
// createSeatEventGrant checked that the host HAD an Ed25519 key at all (host_key_missing) but
// never that the host belonged anywhere near the agent it was being handed delivery rights
// for — a lead of squad s1 could route an s1 agent's notification traffic to a host whose
// owner has no relationship to s1 whatsoever.
//
// A `host_agent_id` is NOT generally a row in `agents` — per docs/fleet/seat-events-channel.md
// it is "the identity whose Ed25519 key (agent_keys) signs the host's ticket requests", and a
// fleet machine (e.g. an Orca host) commonly has no squad membership of its own at all. So
// "standing" is checked on the TWO things a host identity actually has, reusing existing
// seams rather than inventing a third:
//   - "the host must be registered to it": the host identity itself IS an agent whose home
//     squad (agents.squad_id) is the target's — covers a host that IS another squad agent.
//   - "the host member must be a member of that squad": agent_keys.member_id — the human who
//     registered the host's OWN signing key, the SAME column authorizeSeatDelivery already
//     joins through — holds standing on the target squad via the ordinary capability ladder
//     (canOnSquad), the SAME primitive the grant-writer rank ceiling above already uses.
async function hostHasStandingInSquad(env: Env, hostAgentId: string, squadId: string): Promise<boolean> {
  const asAgent = await env.DB.prepare(`SELECT 1 AS x FROM agents WHERE id = ?1 AND squad_id = ?2`)
    .bind(hostAgentId, squadId).first()
  if (asAgent) return true
  const key = await loadActiveAgentKey(env, hostAgentId)
  if (!key) return false
  const grants = await resolveCapabilities(env, key.member_id)
  return canOnSquad(env, grants, squadId, 'member')
}

/** Authorize host → agent. Refuses while another live grant holds the agent: moving an agent
 *  is revoke-then-grant, never an implicit takeover. */
export async function createSeatEventGrant(
  env: Env,
  input: { hostAgentId: string; agentId: string; projectId?: string | null; memberId: string; reason: string },
  now: () => string = () => new Date().toISOString(),
): Promise<GrantResult> {
  const tenant = env.TENANT_SLUG
  if (!ID_RE.test(input.hostAgentId) || !ID_RE.test(input.agentId)) return { ok: false, reason: 'invalid_args' }
  if (!input.reason?.trim() || input.reason.length > 500) return { ok: false, reason: 'invalid_args' }
  const agent = await env.DB.prepare(`SELECT squad_id FROM agents WHERE id = ?1 AND status = 'active'`)
    .bind(input.agentId).first<{ squad_id: string }>()
  if (!agent) return { ok: false, reason: 'agent_not_found' }
  if (!(await loadActiveAgentKey(env, input.hostAgentId))) return { ok: false, reason: 'host_key_missing' }
  if (!(await hostHasStandingInSquad(env, input.hostAgentId, agent.squad_id))) {
    return { ok: false, reason: 'host_no_squad_standing' }
  }
  const projectId = input.projectId ?? null
  if (projectId !== null && !(await agentHasProject(env, input.agentId, projectId))) {
    return { ok: false, reason: 'project_access_denied' }
  }
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, tenant, input.hostAgentId, input.agentId, projectId, input.memberId, input.reason.trim(), now()).run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE/i.test(msg)) return { ok: false, reason: 'agent_already_granted' }
    return { ok: false, reason: 'db_error' }
  }
  return { ok: true, id }
}

export async function revokeSeatEventGrant(
  env: Env,
  // mupot#1595 P2 (codex round-2 review): "bind the authorized grant to the revoke update."
  // Without `grantId`, this always revoked WHATEVER live grant currently exists for the
  // agent — so a caller who authorized against grant A (read separately, before this call)
  // could end up revoking grant B if A was itself revoked and replaced in between (a
  // concurrent revoke-and-replace race). Passing the exact row id the caller already
  // checked turns "revoke the live grant" into "revoke THAT grant, if it is still live" —
  // 0 rows changed means it moved, and the caller must re-authorize against whatever is
  // live NOW rather than silently acting on it.
  input: { agentId: string; memberId: string; grantId?: string },
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: boolean; revoked: number }> {
  const res = await env.DB.prepare(
    input.grantId
      ? `UPDATE seat_event_grants SET revoked_at = ?1, revoked_by_member_id = ?2
          WHERE tenant = ?3 AND agent_id = ?4 AND id = ?5 AND revoked_at IS NULL`
      : `UPDATE seat_event_grants SET revoked_at = ?1, revoked_by_member_id = ?2
          WHERE tenant = ?3 AND agent_id = ?4 AND revoked_at IS NULL`,
  ).bind(...(input.grantId ? [now(), input.memberId, env.TENANT_SLUG, input.agentId, input.grantId] : [now(), input.memberId, env.TENANT_SLUG, input.agentId])).run()
  return { ok: true, revoked: Number(res.meta?.changes ?? 0) }
}

/** mupot#1595 P2 (codex round-2 review): "a suspended or archived creator's authority must
 *  not impose a revoke ceiling" — resolveCapabilities reads capability rows with no status
 *  filter at all, so a suspended member's stale admin/owner row would otherwise still block
 *  a squad lead's revoke forever. A principal who cannot currently authenticate must not be
 *  able to exercise authority through a row this codebase never re-validates for them. */
export async function isMemberActive(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM members WHERE id = ?1 AND tenant = ?2 AND status = 'active'`)
    .bind(memberId, env.TENANT_SLUG)
    .first()
  return row !== null
}

export async function activeSeatEventGrant(
  env: Env,
  agentId: string,
): Promise<{ id: string; host_agent_id: string; project_id: string | null; granted_by_member_id: string } | null> {
  return env.DB.prepare(
    `SELECT id, host_agent_id, project_id, granted_by_member_id FROM seat_event_grants
      WHERE tenant = ?1 AND agent_id = ?2 AND revoked_at IS NULL LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<{ id: string; host_agent_id: string; project_id: string | null; granted_by_member_id: string }>()
}

async function agentHasProject(env: Env, agentId: string, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM memberships ms
       JOIN project_squad_access psa ON psa.squad_id = ms.squad_id
       JOIN projects p ON p.id = psa.project_id
      WHERE ms.agent_id = ?1 AND p.id = ?2 AND p.status = 'active' LIMIT 1`,
  ).bind(agentId, projectId).first()
  return row !== null
}

/** Tri-state, not boolean (mupot#1589 P2-3): a transient D1 error is NOT the same fact as
 *  "no grant". `claim()` and `publish()` below must tell them apart — a blip must never read
 *  as a definitive revocation. Only `hostMayReceive`'s boolean callers (ticket verification's
 *  per-agent filter, and any caller that already fails closed on its own) collapse 'error'
 *  into false. */
export type SeatAuthorization = 'granted' | 'not_granted' | 'error'

// mupot#1595 P1 (codex round-2 review on 4dff34d2): "the new host-standing requirement is
// checked only when the grant is created." authorizeSeatDelivery is the SHARED gate mint
// (hostMayReceive), redeem (onMessage's re-check), the Herdr fence, and every published hint
// all run through — folding host-squad-standing in HERE, as one more AND clause on the
// SAME query, revalidates it on every one of those at once, for EVERY grant including ones
// created before this requirement existed (nothing here reads when the grant was created).
// Mirrors hostHasStandingInSquad's two branches (createSeatEventGrant, above) but as SQL,
// reusing currentMemberRankAtLeastSql — the SAME embeddable rank-ladder fragment
// acceptInvite's write-time re-check uses (src/auth/capability.ts) — rather than a second,
// JS-side round trip per disclosure.
const HOST_STANDING_SQL = `(
  EXISTS (SELECT 1 FROM agents ha WHERE ha.id = g.host_agent_id AND ha.squad_id = a.squad_id)
  OR ${currentMemberRankAtLeastSql('squad', {
    inviterIdParam: 'k.member_id',
    scopeIdParam: 'a.squad_id',
    requiredRankParam: String(capabilityRank('member')),
  })}
)`

/** The per-disclosure check. One indexed query: live grant for (host, agent), agent active,
 *  host key still bound to an active member, host still has standing in the agent's squad,
 *  project (if scoped) still reachable. */
export async function authorizeSeatDelivery(env: Env, hostAgentId: string, agentId: string): Promise<SeatAuthorization> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS x
         FROM seat_event_grants g
         JOIN agents a ON a.id = g.agent_id AND a.status = 'active'
         JOIN agent_keys k ON k.tenant = g.tenant AND k.agent_id = g.host_agent_id AND k.member_id IS NOT NULL
         JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant AND m.status = 'active'
        WHERE g.tenant = ?1 AND g.host_agent_id = ?2 AND g.agent_id = ?3 AND g.revoked_at IS NULL
          AND (g.project_id IS NULL OR EXISTS (
                SELECT 1 FROM memberships ms
                  JOIN project_squad_access psa ON psa.squad_id = ms.squad_id
                  JOIN projects p ON p.id = psa.project_id
                 WHERE ms.agent_id = g.agent_id AND p.id = g.project_id AND p.status = 'active'))
          AND ${HOST_STANDING_SQL}
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, hostAgentId, agentId).first()
    return row !== null ? 'granted' : 'not_granted'
  } catch {
    return 'error' // transient — distinct from a definitive not_granted (P2-3)
  }
}

/** Boolean collapse of authorizeSeatDelivery, for callers that only need yes/no and already
 *  fail closed on their own path (ticket verification's per-agent grant filter, and tests). */
export async function hostMayReceive(env: Env, hostAgentId: string, agentId: string): Promise<boolean> {
  return (await authorizeSeatDelivery(env, hostAgentId, agentId)) === 'granted'
}

// ── ticket-mint rate limit (mupot#1589 P3) ─────────────────────────────────────────────────
//
// POST /ticket has no bearer — anyone can cost the pot one D1 read (loadActiveAgentKey) and
// one Ed25519 verify per request, with no rate limit at all. The key CANNOT be the caller-
// asserted host_agent_id (unverified at this point in the request — a caller could spread
// load across host ids it does not even own to dodge a per-host ceiling); it has to be
// something the platform derives itself. Same seam as email-login's `underRateLimit`
// (src/auth/email-login.ts): an UPSERT whose `DO UPDATE ... WHERE count < ?` makes "check the
// ceiling and record this call" ONE atomic statement, never a KV-style read-then-write —
// see MEMORY feedback_kv_read_compare_put_is_not_a_guard_under_concurrency.md.
export const TICKET_RATE_LIMIT_WINDOW_SEC = 600 // 10-minute fixed buckets, same convention as email-login
export const TICKET_RATE_LIMIT_MAX_PER_IP = 60

// mupot#1594 P3 (from the #1593 gate): "the per-IP ticket limit is defeated by IPv6
// rotation. Bucket by /64." — the smallest block an RIR normally delegates to one customer,
// so bucketing any finer just charges the attacker nothing to rotate. IPv4 passes through
// unchanged (a /32 rotation costs a real address). Applied to BOTH the ticket-mint limiter
// and the upgrade-route limiter below, so neither can be walked around the same way.
// mupot#1595 P3 (kasra-review round 1): an IPv4-mapped IPv6 address (::ffff:a.b.c.d) IS the
// same client as the plain IPv4 address it carries. Without this, EVERY IPv4-mapped address
// (and ::1) expanded and truncated to the identical "0:0:0:0" /64 prefix — a shared-bucket
// DoS: any one of them exhausting the bucket rate-limits every unrelated address that also
// happens to arrive IPv4-mapped, none of them able to tell.
const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

export function ipRateLimitKey(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown'
  const mapped = ip.match(IPV4_MAPPED_RE)
  if (mapped) return mapped[1] // key by the embedded IPv4 address, same as a native IPv4 client
  if (!ip.includes(':')) return ip // IPv4 (or an already-opaque non-IP fallback)
  const [head, tail] = ip.split('::')
  const headParts = head ? head.split(':').filter(Boolean) : []
  const tailParts = ip.includes('::') && tail ? tail.split(':').filter(Boolean) : []
  const full = ip.includes('::')
    ? [...headParts, ...Array(Math.max(8 - headParts.length - tailParts.length, 0)).fill('0'), ...tailParts]
    : ip.split(':')
  return full.slice(0, 4).join(':') || 'unknown'
}

// mupot#1595 P2 (kasra-review round 1): "the rate-limit tables grow without bound... nothing
// deletes old windows." Best-effort, event-driven cleanup — same convention as
// recordTicketPreCheck's own opportunistic purge below. A prune failure must NEVER fail the
// rate-limit decision itself (the try/catch swallows it, logs, and moves on) — pruning is
// housekeeping, not part of the security property.
async function pruneRateLimitTable(env: Env, table: 'seat_events_ticket_rate_limits' | 'seat_events_upgrade_rate_limits', nowMs: number, windowSec: number): Promise<void> {
  try {
    const cutoff = new Date(nowMs - 2 * windowSec * 1000).toISOString()
    await env.DB.prepare(`DELETE FROM ${table} WHERE tenant = ?1 AND window_start < ?2`).bind(env.TENANT_SLUG, cutoff).run()
  } catch (err) {
    console.error(`[seat-events] ${table} prune failed (non-fatal):`, err instanceof Error ? err.message : err)
  }
}

export async function underTicketRateLimit(
  env: Env,
  ip: string,
  nowMs: number = Date.now(),
  max: number = TICKET_RATE_LIMIT_MAX_PER_IP,
): Promise<boolean> {
  const windowStart = new Date(
    Math.floor(nowMs / (TICKET_RATE_LIMIT_WINDOW_SEC * 1000)) * TICKET_RATE_LIMIT_WINDOW_SEC * 1000,
  ).toISOString()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO seat_events_ticket_rate_limits (tenant, key, window_start, count)
       VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (tenant, key, window_start) DO UPDATE SET count = count + 1
        WHERE count < ?4
       RETURNING count`,
    ).bind(env.TENANT_SLUG, ipRateLimitKey(ip), windowStart, max).first<{ count: number }>()
    // mupot#1595 P2-a (adversarial round 2): prune only on the FIRST request of a brand-new
    // window (RETURNING count === 1 — the INSERT branch fired, never the DO UPDATE branch,
    // which always leaves count >= 2). An over-limit call (WHERE skipped, RETURNING nothing,
    // `result === null`) or a mid-window increment must never ALSO pay for a table scan.
    if (result?.count === 1) {
      await pruneRateLimitTable(env, 'seat_events_ticket_rate_limits', nowMs, TICKET_RATE_LIMIT_WINDOW_SEC)
    }
    return result !== null
  } catch (err) {
    // Fail CLOSED on D1 trouble — same posture as email-login and the enroll-mint limiter: a
    // crypto-verifying, unauthenticated, D1-reading endpoint must refuse when its own guard
    // breaks, not open the tap.
    console.error('[seat-events] ticket rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)
    return false
  }
}

// mupot#1594 P1-A: the upgrade route (GET /) had NO rate limit at all — only a format check
// on the ticket. Same atomic fixed-window UPSERT…WHERE count<cap shape as the ticket-mint
// limiter above, a SEPARATE table (migration 0180) because 0177's table has no `scope`
// column to add one to without touching an already-applied table's shape.
export const UPGRADE_RATE_LIMIT_WINDOW_SEC = 600
export const UPGRADE_RATE_LIMIT_MAX_PER_IP = 60

export async function underUpgradeRateLimit(
  env: Env,
  ip: string,
  nowMs: number = Date.now(),
  max: number = UPGRADE_RATE_LIMIT_MAX_PER_IP,
): Promise<boolean> {
  const windowStart = new Date(
    Math.floor(nowMs / (UPGRADE_RATE_LIMIT_WINDOW_SEC * 1000)) * UPGRADE_RATE_LIMIT_WINDOW_SEC * 1000,
  ).toISOString()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO seat_events_upgrade_rate_limits (tenant, key, window_start, count)
       VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (tenant, key, window_start) DO UPDATE SET count = count + 1
        WHERE count < ?4
       RETURNING count`,
    ).bind(env.TENANT_SLUG, ipRateLimitKey(ip), windowStart, max).first<{ count: number }>()
    if (result?.count === 1) {
      await pruneRateLimitTable(env, 'seat_events_upgrade_rate_limits', nowMs, UPGRADE_RATE_LIMIT_WINDOW_SEC)
    }
    return result !== null
  } catch (err) {
    console.error('[seat-events] upgrade rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)
    return false
  }
}

// ── route-level ticket pre-check (mupot#1594 P1-A) ─────────────────────────────────────────
//
// The upgrade route refused a malformed ticket (isWellFormedTicket, FORMAT only — 43 chars
// of the right alphabet) but forwarded anything shaped right straight to SeatEventsDO's
// /connect. 200/200 forged 43-char strings reached acceptWebSocket in the adversarial probe:
// `tickets.take()` still catches a forgery, but only AFTER the WebSocket is already open and
// counted against the pot's socket budget.
//
// seat_events_tickets (migration 0180) is the route's OWN existence+expiry check, written by
// the SAME /ticket POST call that seeds the DO-storage record — one indexed SELECT, scoped
// by tenant (the "audience" check) and expiry, no DO round-trip. A forged string must collide
// with a real 256-bit secret's SHA-256 hash to pass: the SAME unforgeability an HMAC
// signature would give, just checked one hop earlier in D1 instead of verified inline —
// deliberately NOT a new signing secret, which would need `wrangler secret put` in prod
// before it did anything; this migration-only table needs no such rollout step to take
// effect the moment it deploys.
//
// mupot#1595 P1 (kasra-review round 1, Probe Z2): the ORIGINAL pre-check was existence-only,
// never burned — one minted ticket got 80/80 upgrades forwarded to the DO from 80 distinct
// /64s inside its 60s TTL, each spending a pending-socket slot, before the DO's OWN burn
// (`tickets.take()`, at hello) ever saw it. The DO's single-use burn is UNTOUCHED and still
// happens exactly once, over the hello frame — this is a SEPARATE, EARLIER single-use gate:
// the route now burns the SAME ticket a second time, atomically, via `UPDATE ... SET used_at
// ... WHERE used_at IS NULL ... RETURNING` — the exact seam src/auth/email-login.ts's
// `consumed_at` redemption already uses (`VerifyEmailLoginResult`'s UPDATE...RETURNING). One
// ticket now opens exactly one upgrade attempt, full stop; a captured, already-redeemed
// ticket is refused instantly (401) with no socket ever accepted.
export async function recordTicketPreCheck(
  env: Env,
  hash: string,
  hostAgentId: string,
  expiresAt: number,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<void> {
  const now = nowSec()
  // mupot#1595 (adversarial round 2): NO `ON CONFLICT ... DO UPDATE` branch. The previous
  // version reset `used_at` back to NULL on any conflict — an UN-BURN path: a colliding
  // (tenant, hash) row (or any future caller that re-mints the same hash) would silently
  // un-consume an already-burned ticket, defeating consumeTicketPreCheck's entire single-use
  // guarantee. A genuine collision (astronomically unlikely — hash is SHA-256 of a fresh
  // 256-bit secret) now throws a UNIQUE-constraint error, caught by the route's own
  // try/catch → 503 `ticket_store_failed`. A safe failure, never a silent un-burn.
  await env.DB.prepare(
    `INSERT INTO seat_events_tickets (tenant, hash, host_agent_id, expires_at, used_at, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
  ).bind(env.TENANT_SLUG, hash, hostAgentId, expiresAt, new Date(now * 1000).toISOString()).run()
  // Opportunistic cleanup, event-driven like the DO's own purgeExpired — never a timer. Uses
  // the SAME injected clock as the row it just wrote, so a test (or a clock skew) can never
  // have this delete the row it just inserted out from under itself.
  await env.DB.prepare(`DELETE FROM seat_events_tickets WHERE tenant = ?1 AND expires_at < ?2`)
    .bind(env.TENANT_SLUG, now - TICKET_TTL_SEC)
    .run()
}

export type ConsumeTicketPreCheckResult =
  | { ok: true; hostAgentId: string }
  | { ok: false; reason: 'invalid' | 'error' }

/** Atomic single-use burn (mupot#1595 P1). Fails CLOSED on a D1 error (same posture as
 *  underTicketRateLimit) — a broken pre-check must refuse the upgrade, never silently let a
 *  possibly-forged or already-used ticket through to the DO. The tenant conjunct is bound,
 *  never string-interpolated, so a ticket hash cannot be redeemed cross-tenant even if two
 *  tenants' hashes ever collided (astronomically unlikely, still checked). */
export async function consumeTicketPreCheck(
  env: Env,
  hash: string,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<ConsumeTicketPreCheckResult> {
  try {
    const now = nowSec()
    const row = await env.DB.prepare(
      `UPDATE seat_events_tickets
          SET used_at = ?4
        WHERE tenant = ?1 AND hash = ?2 AND used_at IS NULL AND expires_at >= ?3
       RETURNING host_agent_id`,
    ).bind(env.TENANT_SLUG, hash, now, new Date(now * 1000).toISOString()).first<{ host_agent_id: string }>()
    if (!row) return { ok: false, reason: 'invalid' }
    return { ok: true, hostAgentId: row.host_agent_id }
  } catch (err) {
    console.error('[seat-events] ticket pre-check consume failed (refusing, fail-closed):', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'error' }
  }
}

/** Pure — the DO's /connect handler calls this with the ALREADY-open sockets split into
 *  authenticated vs pending counts, before ever calling acceptWebSocket (mupot#1589 P1-2 /
 *  mupot#1594 P1-A capacity control). Kept pure and exported so the boundary itself is
 *  unit-testable without workerd.
 *
 *  mupot#1594 P1-A: pending sockets get their OWN small ceiling, never the authenticated
 *  one — that separation is what stops a flood of forged-ticket connections from starving
 *  legitimate authenticated hosts of the pot's 500-socket budget. */
export type PodAcceptRefusal = 'pot_full' | 'pending_full'

export function podAcceptRefusal(counts: { authenticated: number; pending: number }): PodAcceptRefusal | null {
  if (counts.authenticated >= MAX_SOCKETS_PER_POT) return 'pot_full'
  if (counts.pending >= MAX_PENDING_SOCKETS_PER_POT) return 'pending_full'
  return null
}

// mupot#1595 P1 (kasra-review round 1): the pot-wide pending cap alone still let ONE host
// (one holder of a granted key, minting fresh single-use tickets fast enough) fill the whole
// 64-slot pending budget by itself, locking out every OTHER host's reconnect — the same
// lockout shape, one level down, now that a ticket is single-use. Since the route atomically
// consumes the ticket and therefore KNOWS its real host before ever calling the DO, it hands
// that host to /connect (an internal, Worker-to-DO-only header — never client-controlled),
// and the DO caps PENDING sockets per host independently of the pot-wide pending cap.
export const MAX_PENDING_SOCKETS_PER_HOST = MAX_SOCKETS_PER_HOST

export function pendingHostCapExceeded(currentPendingForHost: number): boolean {
  return currentPendingForHost >= MAX_PENDING_SOCKETS_PER_HOST
}

// ── signed ticket request ─────────────────────────────────────────────────────────────────

/** The exact bytes the host signs. Agents are de-duplicated and sorted so the signature binds the
 *  set, not the order. Domain tag first, tenant bound in (no cross-pot replay). */
export function canonicalTicketMessage(p: { tenant: string; host_agent_id: string; agents: readonly string[]; ts: number; nonce: string }): Uint8Array {
  const agents = [...new Set(p.agents)].sort().join(',')
  return new TextEncoder().encode([TICKET_SIG_DOMAIN, p.tenant, p.host_agent_id, agents, String(p.ts), p.nonce].join('\n'))
}

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export type TicketRequestResult =
  | { ok: true; host: string; granted: string[]; refused: { agent: string; reason: string }[] }
  | { ok: false; status: 400 | 401 | 403 | 409; error: string; detail?: string }

export async function verifyTicketRequest(
  env: Env,
  body: Record<string, unknown>,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<TicketRequestResult> {
  const host = body.host_agent_id
  if (typeof host !== 'string' || !ID_RE.test(host)) return { ok: false, status: 400, error: 'bad_request', detail: 'host_agent_id' }
  const agentsRaw = body.agents
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0 || agentsRaw.length > MAX_AGENTS_PER_TICKET) {
    return { ok: false, status: 400, error: 'bad_request', detail: `agents: 1..${MAX_AGENTS_PER_TICKET}` }
  }
  if (!agentsRaw.every((a) => typeof a === 'string' && ID_RE.test(a))) return { ok: false, status: 400, error: 'bad_request', detail: 'agents' }
  const agents = [...new Set(agentsRaw as string[])].sort()
  const ts = body.ts
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return { ok: false, status: 400, error: 'bad_request', detail: 'ts' }
  if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) return { ok: false, status: 400, error: 'bad_request', detail: 'nonce' }
  if (typeof body.sig !== 'string' || !SIG_B64URL_RE.test(body.sig)) return { ok: false, status: 400, error: 'bad_request', detail: 'sig' }
  const nonce = body.nonce
  const now = nowSec()
  if (Math.abs(now - ts) > TICKET_WINDOW_SEC) return { ok: false, status: 401, error: 'stale_signature' }

  const key = await loadActiveAgentKey(env, host)
  if (!key || key.algo !== 'Ed25519') return { ok: false, status: 401, error: 'unauthorized' }
  let pub: CryptoKey
  try {
    pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.pubkey, ext: true }, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false, status: 401, error: 'unauthorized' }
  }
  const sig = b64urlToBytes(body.sig)
  if (!sig) return { ok: false, status: 401, error: 'unauthorized' }
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' }, pub, sig, canonicalTicketMessage({ tenant: env.TENANT_SLUG, host_agent_id: host, agents, ts, nonce }),
  )
  if (!valid) return { ok: false, status: 401, error: 'unauthorized' }
  // Burn only after the signature verifies, so unsigned junk cannot fill the ledger.
  const fresh = await burnSharedAgentNonce(env, { domain: TICKET_SIG_DOMAIN, windowSec: TICKET_WINDOW_SEC, agentId: host, nonce, now })
  if (!fresh) return { ok: false, status: 409, error: 'replay' }

  const granted: string[] = []
  const refused: { agent: string; reason: string }[] = []
  for (const agent of agents) {
    if (await hostMayReceive(env, host, agent)) granted.push(agent)
    else refused.push({ agent, reason: 'not_granted' })
  }
  if (granted.length === 0) return { ok: false, status: 403, error: 'no_granted_agents' }
  return { ok: true, host, granted, refused }
}

// ── tickets ───────────────────────────────────────────────────────────────────────────────

export interface TicketRecord {
  host: string
  agents: string[]
  expires_at: number // unix seconds
}

export interface TicketStore {
  put(hash: string, rec: TicketRecord): Promise<void>
  /** Atomically read and delete — the single-use property lives here. */
  take(hash: string): Promise<TicketRecord | null>
}

/** The subset of DurableObjectStorage the ticket store uses (so it runs under plain vitest). */
export interface TicketStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(keys: string | string[]): Promise<unknown>
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}

const TICKET_PREFIX = 'ticket:'

export function storageTicketStore(storage: TicketStorage, nowSec: () => number): TicketStore & { purgeExpired(): Promise<void> } {
  return {
    async put(hash, rec) {
      await storage.put(TICKET_PREFIX + hash, rec)
    },
    // Single use: read then delete. The DO processes one hello at a time per input gate, so no
    // second redeem can interleave between the two.
    async take(hash) {
      const key = TICKET_PREFIX + hash
      const rec = await storage.get<TicketRecord>(key)
      if (rec) await storage.delete(key)
      return rec ?? null
    },
    // Event-driven cleanup: runs when a ticket is minted, never on a timer.
    async purgeExpired() {
      const all = await storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
      const dead = [...all].filter(([, r]) => r.expires_at < nowSec()).map(([k]) => k)
      if (dead.length) await storage.delete(dead)
    },
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function mintTicketSecret(): Promise<{ ticket: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  const ticket = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { ticket, hash: await sha256Hex(ticket) }
}

// ── the hub (DO logic, runtime-free so it runs under plain vitest) ────────────────────────

export interface SocketState {
  host: string
  agents: string[]
}

export interface HubSocket {
  send(data: string): void
  close(code: number, reason: string): void
  getState(): SocketState | null
  setState(s: SocketState): void
  /** mupot#1594 P1-A: backed by the WebSocket's own serializeAttachment payload (or the test
   *  double's equivalent), NEVER an in-memory map keyed on the wrapper's identity — that is
   *  what makes the auth deadline survive hibernation and DO eviction. The old design kept
   *  connect time in a `ConnectClock` WeakMap that lived only as long as the DO instance did;
   *  a probe held a pending socket open 3600s by forcing an evict in between. Undefined until
   *  markConnected() has run. */
  getConnectedAt(): number | undefined
  /** Idempotent — the FIRST call wins, so nothing can postpone a socket's own deadline by
   *  re-triggering whatever path calls this. `pendingHost`, when given, is the route's
   *  already-verified ticket host (mupot#1595 P1), recorded alongside connectedAt so the DO
   *  can cap pending sockets per host before any hello ever arrives. */
  markConnected(nowSec: number, pendingHost?: string): void
  /** mupot#1595 P1: the host recorded by markConnected, or undefined for a socket that
   *  connected with no host (shouldn't happen post-fix) or before this field existed. */
  getPendingHost(): string | undefined
  /** mupot#1595 P1 (adversarial round 2 on the round-2 alarm fix): stamp this WHENEVER the
   *  hub closes a socket (any reason). In real workerd, a socket we called `.close()` on
   *  stays in `ctx.getWebSockets()` with `readyState === CLOSING` until the peer acks —
   *  sometimes never, for a half-open raw-TCP client — and its `connectedAt` never changes.
   *  Without this flag, `enforceAuthDeadline`'s own closes kept feeding that STALE
   *  `connectedAt` back into the next alarm computation forever: Miniflare reproduced
   *  15,887 alarms in 66s with 3 half-open clients. Idempotent. */
  markClosed(nowSec: number): void
  /** True once markClosed has run. Every pending/authenticated COUNT (accept-time caps,
   *  the hello-time recheck, the alarm's own pending-deadline list) must exclude a closed
   *  socket — it no longer occupies a real slot, whatever the runtime's own teardown timing
   *  happens to be. */
  isClosed(): boolean
}

/** mupot#1595 P1 (codex round-2 review): what a WebSocket's attachment holds in the CURRENT
 *  shape — never read directly; always go through decodeSocketAttachment below, which also
 *  recognizes the legacy pre-mupot#1594 shape. */
export interface RawAttachment {
  connectedAt?: number
  pendingHost?: string
  closedAt?: number
  sub?: SocketState
}

/** A socket accepted by the PREVIOUSLY deployed code (before mupot#1594) wrote its
 *  attachment as the bare SocketState itself — {host, agents} — directly, via the old
 *  `setState: (s) => ws.serializeAttachment(s)`. After this code deploys and wakes such a
 *  hibernated socket, reading `.sub` off that raw value finds nothing: the socket is
 *  misclassified as pending — hints silently skipped (publish() checks `getState()`), and
 *  because it also has no `connectedAt`, the auth-deadline sweep can never time it out while
 *  it sits in the pending count forever. Recognize the legacy shape (host + agents present,
 *  neither `sub` nor `connectedAt` present — the new format ALWAYS writes at least one of
 *  those) and decode it as already-authenticated. Once any NEW write touches this socket
 *  (e.g. `claim`/`drop` calling setState again), it is rewritten in the current format and
 *  this branch no longer applies to it — self-healing, no migration step needed. */
export function decodeSocketAttachment(raw: unknown): RawAttachment {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  if (typeof r.host === 'string' && Array.isArray(r.agents) && r.sub === undefined && r.connectedAt === undefined) {
    return { sub: { host: r.host, agents: r.agents as string[] } }
  }
  return r as RawAttachment
}

export interface HubDeps {
  sockets: () => HubSocket[]
  tickets: TicketStore
  nowSec?: () => number
  /** Bounded memory of recently published hint ids; survives across calls while the DO is awake. */
  recent?: RecentIds
  authorize?: (host: string, agent: string) => Promise<SeatAuthorization>
  /** Per-socket junk-frame counter; survives across calls while the DO is awake (mupot#1589 P1-2). */
  junk?: JunkTracker
}

export class RecentIds {
  private readonly ids = new Set<string>()
  constructor(private readonly max = RECENT_HINT_IDS) {}
  /** true the first time an id is seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string)
    return true
  }
}

/** Counts non-conforming frames per socket (mupot#1589 P1-2 — PROBE-G: 1000 junk frames left a
 *  socket open forever with zero replies). Keyed on the `HubSocket` wrapper's own identity,
 *  which the DO shell keeps stable per real WebSocket for the DO's lifetime (`wrapOnce`'s
 *  cache) — a WeakMap here never grows unbounded and needs no eviction of its own. */
export interface JunkTracker {
  /** Increment and return the new count for this socket. */
  bump(sock: HubSocket): number
}

export function createJunkTracker(): JunkTracker {
  const counts = new WeakMap<HubSocket, number>()
  return {
    bump(sock) {
      const n = (counts.get(sock) ?? 0) + 1
      counts.set(sock, n)
      return n
    },
  }
}

/** mupot#1594 P1-A: every connect used to call `ctx.storage.setAlarm` unconditionally, and
 *  setAlarm REPLACES any pending alarm rather than taking the earlier of the two — so a host
 *  (or an attacker) reconnecting faster than AUTH_DEADLINE_SEC postpones the sweep
 *  indefinitely; the probe held a pending socket 3600s this way. Pure so it is testable
 *  without a real DO alarm: returns the timestamp to arm, or null when the existing alarm
 *  already fires at or before `desired` (never push a pending sweep LATER). */
export function nextAuthDeadlineAlarm(existing: number | null, desired: number): number | null {
  if (existing === null || desired < existing) return desired
  return null
}

/** mupot#1595 P2 (codex round-2 review): after a sweep, the DO used to rearm the alarm at a
 *  fresh `now + AUTH_DEADLINE_SEC` for whatever pending sockets survived — but a socket that
 *  connected even 1s after the one that triggered the sweep can then survive to nearly
 *  DOUBLE its true deadline (swept together with the first at t=15, rearmed for a full new
 *  interval, so it isn't checked again until t=30 instead of its own real deadline at
 *  t≈16). Pure: given the connectedAt (unix seconds) of every socket STILL pending after a
 *  sweep, returns the EARLIEST real deadline (ms) to arm next, or null when nothing is
 *  pending (let the alarm lapse, same as before). */
export function nextSweepAlarmMs(pendingConnectedAtSec: readonly number[]): number | null {
  if (pendingConnectedAtSec.length === 0) return null
  return (Math.min(...pendingConnectedAtSec) + AUTH_DEADLINE_SEC) * 1000
}

export async function backlogFor(env: Env, agent: string, since: number): Promise<{ unread: number; complete: boolean; hints: SeatHint[] }> {
  const cols = HINT_FIELDS.filter((f) => f !== 'to_agent').join(', ')
  const rows = await env.DB.prepare(
    `SELECT ${cols} FROM agent_messages
      WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3
      ORDER BY seq ASC LIMIT ?4`,
  ).bind(env.TENANT_SLUG, agent, since, BACKLOG_HINT_LIMIT + 1).all<Record<string, unknown>>()
  const list = rows.results ?? []
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL`,
  ).bind(env.TENANT_SLUG, agent).first<{ n: number }>()
  const hints = list.slice(0, BACKLOG_HINT_LIMIT).map((r) => hintFromRow(r, agent)).filter((h): h is SeatHint => h !== null)
  return { unread: Number(count?.n ?? 0), complete: list.length <= BACKLOG_HINT_LIMIT, hints }
}

export class SeatEventsHub {
  private readonly nowSec: () => number
  private readonly recent: RecentIds
  private readonly authorize: (host: string, agent: string) => Promise<SeatAuthorization>
  private readonly junk: JunkTracker

  constructor(private readonly env: Env, private readonly deps: HubDeps) {
    this.nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000))
    this.recent = deps.recent ?? new RecentIds()
    this.authorize = deps.authorize ?? ((host, agent) => authorizeSeatDelivery(env, host, agent))
    this.junk = deps.junk ?? createJunkTracker()
  }

  /** Record that `sock` was just accepted, for enforceAuthDeadline (mupot#1589 P1-2). Call
   *  exactly once per socket, right after accept, before any message can arrive. mupot#1594
   *  P1-A: this now writes through `sock.markConnected`, which is backed by the socket's OWN
   *  attachment (serializeAttachment), not an in-memory map — so the deadline this establishes
   *  survives hibernation and DO eviction, and a hub rebuilt after either still sees it.
   *  mupot#1595 P1: `pendingHost`, when the route forwarded one (it always does post-fix —
   *  the ticket is consumed before the DO is ever called, so the host is already known),
   *  is recorded too, for the per-host pending cap. */
  noteConnected(sock: HubSocket, pendingHost?: string): void {
    sock.markConnected(this.nowSec(), pendingHost)
  }

  /** Close any socket that connected (per its OWN attachment, mupot#1594 P1-A) at least
   *  AUTH_DEADLINE_SEC ago and never completed hello (no state set) — mupot#1589 P1-2. The
   *  Worker route and this DO's /connect already refuse an upgrade with no well-formed,
   *  pre-checked ticket at all before ever accepting, so in normal operation this finds
   *  nothing to close; it exists so a socket that slips past that outer gate (a still-live
   *  but never-redeemed ticket, or a client that opens the socket and then never sends hello)
   *  cannot sit open forever — including across a hibernate/evict cycle, since the deadline
   *  lives on the WebSocket's own attachment rather than this hub instance's memory. */
  enforceAuthDeadline(): number {
    let closed = 0
    const now = this.nowSec()
    for (const sock of this.deps.sockets()) {
      if (sock.getState()) continue
      const at = sock.getConnectedAt()
      if (at === undefined || now - at < AUTH_DEADLINE_SEC) continue
      this.closeSocket(sock, CLOSE_AUTH_TIMEOUT, 'auth_timeout')
      closed++
    }
    return closed
  }

  /** The only client frame: `{type:'hello', v, ticket, since:{agent:seq}}`. Anything else
   *  (oversized, unparseable, wrong type, or already-subscribed) is junk-counted, and the
   *  socket is closed once MAX_JUNK_FRAMES is exceeded (mupot#1589 P1-2 — PROBE-G: 1000 junk
   *  frames used to leave a socket open forever, replying to nothing). */
  async onMessage(sock: HubSocket, raw: string | ArrayBuffer): Promise<void> {
    const byteLength = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
    if (byteLength > MAX_FRAME_BYTES) return this.closeSocket(sock, CLOSE_PROTOCOL_ABUSE, 'frame_too_large')
    if (typeof raw !== 'string') return this.junkFrame(sock) // the wire protocol is JSON text only
    let f: Record<string, unknown>
    try {
      f = JSON.parse(raw)
    } catch {
      return this.junkFrame(sock)
    }
    if (f?.type !== 'hello') return this.junkFrame(sock)
    if (sock.getState()) return sock.send(encodeFrame({ type: 'error', reason: 'already_subscribed' }))
    if (f.v !== SEAT_EVENTS_PROTOCOL) return this.reject(sock, 'protocol_unsupported')
    if (typeof f.ticket !== 'string' || !TICKET_RE.test(f.ticket)) return this.reject(sock, 'ticket_invalid')
    const rec = await this.deps.tickets.take(await sha256Hex(f.ticket))
    if (!rec || rec.expires_at < this.nowSec()) return this.reject(sock, 'ticket_invalid')

    // mupot#1589 P1-2 defence in depth: bound how many concurrent AUTHENTICATED sockets one
    // host may hold. A well-behaved host holds exactly one — the same-host reconnect path
    // below (claim → 'newer_connection_same_host') supersedes rather than adding a second —
    // so this is a ceiling against a compromised or buggy host key, not the normal path.
    // mupot#1595 (adversarial round 2): both counts below now also exclude a socket this hub
    // has already closed — a closed socket lingering in sockets() (real workerd: readyState
    // CLOSING until the peer acks; the test double: nothing ever splices it out) must not go
    // on counting against either cap forever.
    const heldByHost = this.deps.sockets().filter((s) => s.getState()?.host === rec.host && !s.isClosed()).length
    if (heldByHost >= MAX_SOCKETS_PER_HOST) return this.reject(sock, 'host_socket_limit')

    // mupot#1595 P2 (codex round-2 review): the pot-wide authenticated cap was enforced only
    // at DO accept time, while the socket was still pending — many pending sockets (each
    // individually under the pending cap, which doesn't count against this one) can complete
    // hello in the same DO wake and each pass this check independently, together exceeding
    // MAX_SOCKETS_PER_POT authenticated sockets. Re-check it HERE, at the actual
    // pending→authenticated transition, before this hello is allowed to succeed — `this` sock
    // is still pending (getState() === null) so it is correctly excluded from its own count.
    const authenticatedNow = this.deps.sockets().filter((s) => s.getState() !== null && !s.isClosed()).length
    if (podAcceptRefusal({ authenticated: authenticatedNow, pending: 0 }) === 'pot_full') {
      return this.reject(sock, 'pot_at_capacity')
    }

    const since = (f.since && typeof f.since === 'object' ? f.since : {}) as Record<string, unknown>
    const subs: { agent: string; ok: boolean; reason?: string }[] = []
    const mine: string[] = []
    for (const agent of rec.agents) {
      // Re-check at redeem: a grant revoked between mint and connect must not open.
      const status = await this.authorize(rec.host, agent)
      if (status !== 'granted') {
        subs.push({ agent, ok: false, reason: status === 'error' ? 'authorization_error' : 'not_granted' })
        continue
      }
      const conflict = await this.claim(sock, rec.host, agent)
      if (conflict) {
        subs.push({ agent, ok: false, reason: conflict })
        continue
      }
      mine.push(agent)
      subs.push({ agent, ok: true })
    }
    if (mine.length === 0) {
      sock.send(encodeFrame({ type: 'ready', protocol: SEAT_EVENTS_PROTOCOL, host: rec.host, subscriptions: subs }))
      sock.close(CLOSE_NO_SUBSCRIPTIONS, 'no_subscriptions')
      return
    }
    sock.setState({ host: rec.host, agents: mine })
    sock.send(encodeFrame({ type: 'ready', protocol: SEAT_EVENTS_PROTOCOL, host: rec.host, subscriptions: subs }))
    for (const agent of mine) {
      const s = Number(since[agent] ?? 0)
      const b = await backlogFor(this.env, agent, Number.isSafeInteger(s) && s > 0 ? s : 0)
      sock.send(encodeFrame({ type: 'backlog', agent, ...b }))
    }
  }

  private junkFrame(sock: HubSocket): void {
    const n = this.junk.bump(sock)
    if (n > MAX_JUNK_FRAMES) this.closeSocket(sock, CLOSE_PROTOCOL_ABUSE, 'junk_frames')
  }

  private closeSocket(sock: HubSocket, code: number, reason: string): void {
    // mupot#1595 (adversarial round 2): stamp closed FIRST, unconditionally — even a socket
    // that's "already gone" (close() throws) must be marked, or it stays eligible to be
    // recounted as pending/authenticated forever.
    sock.markClosed(this.nowSec())
    try {
      sock.close(code, reason)
    } catch {
      // already gone
    }
  }

  /** mupot#1595 P1 (adversarial round 2 on the round-2 alarm fix): the connectedAt of every
   *  socket that is STILL pending (no hello yet) AND not already closed by this hub. Feeding
   *  a CLOSED socket's stale connectedAt into nextSweepAlarmMs was the hot-loop bug: in real
   *  workerd, a socket enforceAuthDeadline just closed can sit in ctx.getWebSockets() with
   *  readyState CLOSING until the peer acks — sometimes never, for a half-open raw-TCP client
   *  — and its connectedAt never advances, so the alarm re-arms at a timestamp already in the
   *  past and fires again immediately. Miniflare reproduced 15,887 alarms in 66s with 3
   *  half-open clients; with this exclusion, 2 alarms in 31s (round-1 behaviour restored).
   *  Deliberately Hub-level (not DO-shell-only) so it is unit-testable without workerd: the
   *  DO additionally filters by real `readyState === OPEN` (belt and braces for a socket that
   *  entered CLOSING via a path this hub never called `.close()` on), but the CORE fix — never
   *  recount a socket THIS hub already closed — lives here. */
  pendingDeadlines(): number[] {
    const out: number[] = []
    for (const sock of this.deps.sockets()) {
      if (sock.getState() !== null || sock.isClosed()) continue
      const at = sock.getConnectedAt()
      if (at !== undefined) out.push(at)
    }
    return out
  }

  /** One live socket per agent. Same host reconnecting supersedes its old socket; another host
   *  that is still authorized keeps the agent (the grant table makes this unreachable unless a
   *  grant moved while an old socket lived — then the old holder is evicted as revoked). */
  private async claim(sock: HubSocket, host: string, agent: string): Promise<string | null> {
    for (const other of this.deps.sockets()) {
      if (other === sock) continue
      const st = other.getState()
      if (!st?.agents.includes(agent)) continue
      if (st.host !== host) {
        // mupot#1589 P2-3: a transient error must not read as a confirmed loss of the OTHER
        // host's grant — only 'not_granted' lets a newcomer steal the agent from a still-live
        // holder. 'error' defers to the existing holder, same as 'granted' would.
        const otherStatus = await this.authorize(st.host, agent)
        if (otherStatus !== 'not_granted') return 'held_by_other_host'
      }
      const frame: ServerFrame =
        st.host === host
          ? { type: 'superseded', agent, reason: 'newer_connection_same_host' }
          : { type: 'revoked', agent, reason: 'grant_moved' }
      this.drop(other, st, agent, frame)
    }
    return null
  }

  private drop(sock: HubSocket, st: SocketState, agent: string, frame: ServerFrame): void {
    const agents = st.agents.filter((a) => a !== agent)
    sock.setState({ host: st.host, agents })
    try {
      sock.send(encodeFrame(frame))
      if (agents.length === 0) sock.close(CLOSE_NO_SUBSCRIPTIONS, 'no_subscriptions')
    } catch {
      // socket already gone
    }
  }

  private reject(sock: HubSocket, reason: string): void {
    sock.send(encodeFrame({ type: 'error', reason }))
    sock.close(CLOSE_TICKET_INVALID, reason)
  }

  /** Fan a committed-message hint out to the socket holding its agent. Duplicate publishes
   *  (Queue redelivery) are dropped while the DO stays awake; after hibernation a duplicate
   *  reaches the host, which dedups by id and seq floor — harmless either way. */
  async publish(hint: SeatHint): Promise<{ sent: number; duplicate: boolean; revoked: number }> {
    if (!this.recent.add(hint.id)) return { sent: 0, duplicate: true, revoked: 0 }
    let sent = 0
    let revoked = 0
    for (const sock of this.deps.sockets()) {
      const st = sock.getState()
      if (!st?.agents.includes(hint.to_agent)) continue
      const status = await this.authorize(st.host, hint.to_agent)
      if (status === 'not_granted') {
        this.drop(sock, st, hint.to_agent, { type: 'revoked', agent: hint.to_agent, reason: 'grant_revoked' })
        revoked++
        continue
      }
      if (status === 'error') {
        // mupot#1589 P2-3: a transient D1 error is not a revocation. Skip this ONE hint for
        // this socket — the grant, the socket and every OTHER subscription stay exactly as
        // they were; the Queue's own retry (or the next hint) covers the disclosure.
        continue
      }
      try {
        sock.send(encodeFrame({ type: 'hint', agent: hint.to_agent, hint }))
        sent++
      } catch {
        // socket closed under us; the host's reconnect catch-up covers it
      }
    }
    return { sent, duplicate: false, revoked }
  }
}

// ── worker-side publish (called by the bus consumer) ──────────────────────────────────────

export type PublishSeatHintResult =
  | { ok: true; skipped: true; reason: 'disabled' | 'invalid_payload' | 'tenant_mismatch' }
  | { ok: true; skipped: false; sent: number }
  | { ok: false; error: string }

// mupot#1594 P3: "no timeout on the seat publish." The consumer's own try/catch (mupot#1589
// P1-3) isolates a THROW from the Hermes delivery leg, but an unresolved fetch (a wedged or
// slow-to-wake DO) never throws — it just hangs, and would hold the queue message's whole
// handleQueue call hostage. Same AbortSignal.timeout pattern as src/loops/resources.ts and
// src/auth/email-sender.ts.
const SEAT_PUBLISH_TIMEOUT_MS = 5_000

export async function publishSeatHint(env: Env, tenant: string, payload: unknown): Promise<PublishSeatHintResult> {
  if (!isSeatEventsEnabled(env) || !env.SEAT_EVENTS) return { ok: true, skipped: true, reason: 'disabled' }
  if (tenant !== env.TENANT_SLUG) return { ok: true, skipped: true, reason: 'tenant_mismatch' }
  const hint = hintFromPayload(payload as Partial<MessageCreatedPayload>)
  if (!hint) return { ok: true, skipped: true, reason: 'invalid_payload' }
  const ns = env.SEAT_EVENTS
  try {
    const res = await ns.get(ns.idFromName(seatEventsChannelName(env.TENANT_SLUG))).fetch(
      new Request('https://seat-events/hint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hint),
        signal: AbortSignal.timeout(SEAT_PUBLISH_TIMEOUT_MS),
      }),
    )
    if (!res.ok) return { ok: false, error: `seat_events_http_${res.status}` }
    const body = (await res.json()) as { sent?: unknown }
    return { ok: true, skipped: false, sent: typeof body.sent === 'number' ? body.sent : 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'seat_events_fetch_failed' }
  }
}
