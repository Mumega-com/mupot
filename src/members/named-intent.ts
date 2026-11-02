// NAMED_INTENT_CONNECT — a new connection states WHICH agent it means, and reaches it through ONE guided consent,
// instead of drifting onto a throwaway seat-<hash> agent first.
//
// WHAT THIS IS. A thin ordering layer over the services that already own every write:
//   1. RESOLVE FIRST. The named target is resolved among the agents this human may attach to
//      (resolveAttachableAgent: active, not a pool seat, designated when SEAT_ATTACH_DESIGNATED is on, human holds admin
//      on its squad). A miss writes NOTHING: no seat, no agent, no admission. It answers with the reason and the next step.
//   2. CARRIER SEAT. An attachment hangs off a seat row (agent_seats). When the session already has a seat the intent rides
//      on it. When it has none, the seat is made through seatSelect (the ONE seat writer) keyed by the TARGET AGENT ID
//      (never by the typed name), so a repeat call, a restart, or a second device resolves the SAME seat row.
//   3. ATTACH. attachSeatToAgent files (or reuses) the pending admission and, once the human taps their passkey, attaches.
//      The id it is handed is the resolved id, and it re-resolves it again inside. The consent is the existing secure
//      moment: it names the target agent, scope and reason; nothing here can approve it.
//
// WHAT THIS IS NOT. It creates no named agent (a missing agent is a refusal with a next step, never a silent mint), writes
// no designation, grants no capability, and treats a name as a SELECTOR only: authority is the human's own admin
// standing plus their passkey consent, both enforced by the writers below. A name alone grants nothing.
//
// FLAG: NAMED_INTENT_CONNECT === '1' AND SEAT_AUTO_ENROLL === '1' AND SEAT_ATTACH === '1'. Off -> the tool is not
// advertised and a direct call refuses before any read or write.

import type { AuthContext, Env } from '../types'
import { seatAutoEnrollEnabled } from './harness'
import { seatSelect } from './seat-select'
import {
  attachSeatToAgent, listDesignatableAgents, resolveAttachableAgent, seatAttachDesignatedEnabled, seatAttachEnabled,
  type AdmissionScope, type AttachableAgent, type AttachResult,
} from './seat-attach'
import { isUnboundDirectorySession } from './bootstrap-self'
import { normalizeSeatKey, seatKeyHash } from './seat-key'

export function namedIntentEnabled(env: Pick<Env, 'NAMED_INTENT_CONNECT' | 'SEAT_AUTO_ENROLL' | 'SEAT_ATTACH'>): boolean {
  return env.NAMED_INTENT_CONNECT === '1' && seatAutoEnrollEnabled(env) && seatAttachEnabled(env)
}

export const INTENT_REF_MAX = 128
export const INTENT_REASON_MAX = 280
/** The fixed project label of every intent seat: the seat key is (project, thread=<target agent id>[:<thread label>]). */
export const INTENT_SEAT_PROJECT = 'named-intent'

export type NamedIntentFailure =
  | 'named_intent_disabled'
  | 'invalid_args'
  | 'seat_session_required'
  | 'seat_handle_rejected'
  | 'already_attached'
  | 'intent_seat_cap'
  | 'agent_not_found'
  | 'agent_not_designated_for_you'
  | 'agent_ambiguous'

/** Unattached intent seats (handle path) one human may hold per app: a flood bound, so new thread labels cannot mint seats forever. */
export const INTENT_UNATTACHED_SEAT_CAP = 3

export interface NamedIntentArgs { agent: unknown; reason: unknown; scope?: unknown; thread?: unknown }

export type NamedIntentResult =
  | { ok: true; carrier: 'chat_seat' | 'handle_seat'; target: AttachableAgent; attach: AttachResult; seat: { handle: string | null; id: string } }
  | { ok: true; carrier: 'chat_seat'; target: AttachableAgent; attach: null; seat: null }
  | { ok: false; error: NamedIntentFailure; detail?: unknown; agent?: { id: string; slug: string; name: string } }
  | { ok: false; error: 'seat_failed'; seatError: string; detail?: unknown }

/** Validated, trimmed arguments. Never throws. */
export function readIntentArgs(a: NamedIntentArgs):
  | { ok: true; ref: string; reason: string; scope: AdmissionScope | undefined; thread: string | undefined }
  | { ok: false; field: string } {
  const ref = typeof a.agent === 'string' ? a.agent.trim() : ''
  if (ref.length === 0 || ref.length > INTENT_REF_MAX || ref.includes('\0')) return { ok: false, field: 'agent' }
  const reason = typeof a.reason === 'string' ? a.reason.trim() : ''
  if (reason.length === 0 || reason.length > INTENT_REASON_MAX || reason.includes('\0')) return { ok: false, field: 'reason' }
  if (a.scope !== undefined && a.scope !== 'seat' && a.scope !== 'harness') return { ok: false, field: 'scope' }
  let thread: string | undefined
  if (a.thread !== undefined) {
    if (typeof a.thread !== 'string' || a.thread.trim().length === 0 || a.thread.length > 100) return { ok: false, field: 'thread' }
    thread = a.thread.trim()
  }
  return { ok: true, ref, reason, scope: a.scope === 'harness' ? 'harness' : a.scope === 'seat' ? 'seat' : undefined, thread }
}

/**
 * Resolve the named target for THIS human, writing nothing. Order: (1) the attachable set; (2) the human's own
 * undesignated-but-designatable agent (a guided refusal naming it: they hold standing, so it reveals nothing);
 * (3) otherwise agent_not_found, identical for "does not exist", "not yours to attach" and "a pool seat agent".
 */
export async function resolveIntentTarget(env: Env, humanMemberId: string, ref: string):
  Promise<{ ok: true; agent: AttachableAgent } | { ok: false; error: 'agent_not_found' | 'agent_ambiguous' | 'agent_not_designated_for_you'; agent?: { id: string; slug: string; name: string } }> {
  const r = await resolveAttachableAgent(env, humanMemberId, ref)
  if (r.ok) return r
  if (r.error === 'agent_not_found' && seatAttachDesignatedEnabled(env)) {
    const d = await listDesignatableAgents(env, humanMemberId, ref)
    if (d.length === 1) return { ok: false, error: 'agent_not_designated_for_you', agent: { id: d[0].id, slug: d[0].slug, name: d[0].name } }
  }
  return r
}

/** Which seat carries the intent: this chat's own seat (handle, or its conversation-keyed seat), or none yet. */
export type IntentCarrier =
  | { kind: 'seat'; humanMemberId: string; seatId: string; grantTokenId: string; seatAgentId: string; attachedAgentId: string | null }
  | { kind: 'unbound' }

export function intentCarrier(auth: AuthContext): IntentCarrier | null {
  const sb = auth.seatBinding
  if (sb && auth.channel === 'directory' && auth.boundAgentId) {
    return { kind: 'seat', humanMemberId: sb.humanMemberId, seatId: sb.seatId, grantTokenId: sb.grantTokenId, seatAgentId: auth.boundAgentId, attachedAgentId: sb.attached ? sb.attached.agentId : null }
  }
  if (isUnboundDirectorySession(auth)) return { kind: 'unbound' }
  return null
}

async function unattachedIntentSeats(env: Env, memberId: string, harnessId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_seats s
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND s.harness_id = ?3 AND s.source = 'select' AND s.label_basename = ?4 AND s.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_seat_attachments a WHERE a.seat_id = s.id AND a.detached_at IS NULL)`,
  ).bind(env.TENANT_SLUG, memberId, harnessId, INTENT_SEAT_PROJECT).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function connectNamedIntent(env: Env, auth: AuthContext, rawArgs: NamedIntentArgs): Promise<NamedIntentResult> {
  // 1. Flag: first statement; off means nothing below ever runs.
  if (!namedIntentEnabled(env)) return { ok: false, error: 'named_intent_disabled' }
  const args = readIntentArgs(rawArgs)
  if (!args.ok) return { ok: false, error: 'invalid_args', detail: { field: args.field } }
  // A presented handle that did not resolve is final: it never falls through to a new seat.
  if (auth.seatInputs?.handleRejected === true) return { ok: false, error: 'seat_handle_rejected' }
  const carrier = intentCarrier(auth)
  if (!carrier) return { ok: false, error: 'seat_session_required' }
  const humanMemberId = carrier.kind === 'seat' ? carrier.humanMemberId : auth.memberId
  if (typeof humanMemberId !== 'string') return { ok: false, error: 'seat_session_required' }

  // 2. An attached chat: compared ONLY against the agent it is attached to (id or slug), resolving no other agent, so a
  //    non-match is the same already_attached whether or not the named agent exists (no oracle), and no second seat is made.
  if (carrier.kind === 'seat' && carrier.attachedAgentId !== null) {
    const row = await env.DB.prepare(`SELECT id, slug, name, squad_id FROM agents WHERE id = ?1 LIMIT 1`).bind(carrier.attachedAgentId)
      .first<{ id: string; slug: string; name: string; squad_id: string }>()
    if (!row || (args.ref !== row.id && args.ref.toLowerCase() !== row.slug.toLowerCase())) return { ok: false, error: 'already_attached' }
    return { ok: true, carrier: 'chat_seat', target: { ...row, squad_name: '' }, attach: null, seat: null }
  }

  // 3. Resolve the target BEFORE anything is created or filed.
  const target = await resolveIntentTarget(env, humanMemberId, args.ref)
  if (!target.ok) return target.error === 'agent_not_designated_for_you'
    ? { ok: false, error: target.error, agent: target.agent }
    : { ok: false, error: target.error }

  // 4. This chat's own seat. Never a seat shared with another chat: the approval is bound to the seat that asked.
  let seatId: string
  let grantTokenId: string | null
  let requesterAgentId: string
  let seatInfo: { handle: string | null; id: string }
  let carrierKind: 'chat_seat' | 'handle_seat' = 'chat_seat'
  if (carrier.kind === 'seat') {
    seatId = carrier.seatId; grantTokenId = carrier.grantTokenId; requesterAgentId = carrier.seatAgentId
    seatInfo = { handle: null, id: seatId }
  } else if (auth.intentSeater) {
    // The chat carries a per-conversation client key: its own conversation-keyed seat (created now, after resolution).
    const bound = await auth.intentSeater()
    if (!bound.seatBinding || !bound.boundAgentId) {
      return { ok: false, error: 'seat_failed', seatError: bound.seatInputs?.autoSeatRefused ?? 'seat_not_live' }
    }
    seatId = bound.seatBinding.seatId; grantTokenId = bound.seatBinding.grantTokenId; requesterAgentId = bound.boundAgentId
    seatInfo = { handle: null, id: seatId }
  } else {
    if (typeof auth.harnessId !== 'string') return { ok: false, error: 'seat_failed', seatError: 'harness_required' }
    // No client key at all: the chat must name its own stable thread label (a selector, as in seat_select) and carry the handle.
    if (args.thread === undefined) return { ok: false, error: 'invalid_args', detail: { field: 'thread', reason: 'thread_required_without_client_key' } }
    const threadLabel = `${target.agent.id}:${args.thread}`
    const harnessId = auth.harnessId
    if (typeof harnessId === 'string') {
      const nk = normalizeSeatKey({ project: INTENT_SEAT_PROJECT, thread: threadLabel })
      if (nk.ok) {
        const kh = await seatKeyHash(humanMemberId, harnessId, nk.key)
        const exists = await env.DB.prepare(`SELECT 1 AS x FROM agent_seats WHERE tenant = ?1 AND member_id = ?2 AND harness_id = ?3 AND key_hash = ?4 LIMIT 1`)
          .bind(env.TENANT_SLUG, humanMemberId, harnessId, kh).first<{ x: number }>()
        // Only a NEW label is bounded: a repeat of an existing one creates nothing.
        if (!exists && (await unattachedIntentSeats(env, humanMemberId, harnessId)) >= INTENT_UNATTACHED_SEAT_CAP) {
          return { ok: false, error: 'intent_seat_cap', detail: { cap: INTENT_UNATTACHED_SEAT_CAP } }
        }
      }
    }
    const sel = await seatSelect(env, auth, { project: INTENT_SEAT_PROJECT, thread: threadLabel })
    if (!sel.ok) return { ok: false, error: 'seat_failed', seatError: sel.error, detail: sel.detail }
    seatId = sel.seat.id; grantTokenId = auth.tokenId ?? null; requesterAgentId = sel.agent.id
    seatInfo = { handle: sel.seat_handle, id: seatId }
    carrierKind = 'handle_seat'
  }

  // 5. Attach through the one writer, handing it the RESOLVED id (it re-resolves inside; a name never reaches a write).
  const attach = await attachSeatToAgent(env, {
    humanMemberId, seatId, agentRef: target.agent.id, via: 'tool', reason: args.reason, requesterAgentId, grantTokenId, scope: args.scope,
  })
  return { ok: true, carrier: carrierKind, target: target.agent, attach, seat: seatInfo }
}
