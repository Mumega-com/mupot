// mupot — MCP Events for ATTACHED agents (W2). Why this exists (2026-10-15, Rava): a W2 connector grant is the human's UNBOUND
// directory token, and events/* deliberately never resolves a seat handle (a subscription stores its principal and must not be
// minted from a handle). So a chat attached to an existing agent could not discover or subscribe to message.created at all, and its
// wake silently depended on an older agent-bound connector.
//
// The principal here is the ATTACHMENT, found from facts the server already holds, never from a handle the caller presents:
//   human = the grant token's member, harness = the grant token's harness, agent = named by an `agent` argument (or the only live one).
// A candidate exists only while ALL of these hold (the same chain findLiveAttachment enforces per request):
//   live admission for exactly (agent, human, harness); attachment not detached; the seat not retired; agent active and welded to an
//   active member; the harness still the human's; the attachment's OWN token live and bound to the agent; the human's grant token live
//   and unbound; and the human still administers the agent's squad (the floor attach uses).
// The subscription then stores the ATTACHMENT's token (not the human's grant), so every delivery re-derives liveness from that token
// (subscriberAccessLive) plus an explicit attachment/admission check: detach, revoke, retire or deactivate stops wakes at the next
// message. The wake is body-free (message_id/seq only), so nothing about identity, retrieval or inbox content is shared.
import type { AuthContext, Env } from '../types'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canOnSquad, resolveCapabilities } from '../auth/capability'
import { resolveConsentedAgentCapabilities } from './oauth-authorize'

export interface EventsAttachment {
  attachmentId: string
  agentId: string
  slug: string
  name: string
  squadId: string
  agentMemberId: string
  seatTokenId: string
}

interface Row {
  attachment_id: string
  agent_id: string
  slug: string
  name: string
  squad_id: string
  agent_member_id: string
  seat_token_id: string
}

/** The live attachments an unbound W2 grant may subscribe for, one per agent (newest attachment wins). Empty when the attach tables are
 *  absent (a pot that never applied the seat-attach migration has none). */
export async function listLiveAttachmentsForEvents(
  env: Env,
  human: { memberId: string; harnessId: string; grantTokenId: string },
): Promise<EventsAttachment[]> {
  let rows: Row[]
  try {
    rows = (await env.DB.prepare(
      `SELECT att.id AS attachment_id, a.id AS agent_id, a.slug AS slug, a.name AS name, a.squad_id AS squad_id,
              b.member_id AS agent_member_id, att.seat_token_id AS seat_token_id
         FROM agent_seat_attachments att
         JOIN agent_seat_admissions adm ON adm.id = att.admission_id AND adm.tenant = att.tenant AND adm.status = 'live'
              AND adm.agent_id = att.agent_id AND adm.human_member_id = att.human_member_id AND adm.harness_id = att.harness_id
         JOIN agent_seats s ON s.id = att.seat_id AND s.tenant = att.tenant AND s.retired_at IS NULL
              AND s.member_id = att.human_member_id AND s.harness_id = att.harness_id
         JOIN agents a ON a.id = att.agent_id AND a.status = 'active'
         JOIN agent_member_bindings b ON b.tenant = att.tenant AND b.agent_id = a.id
         JOIN members am ON am.id = b.member_id AND am.tenant = att.tenant AND am.status = 'active'
         JOIN harnesses hr ON hr.id = att.harness_id AND hr.tenant = att.tenant AND hr.member_id = att.human_member_id
        WHERE att.tenant = ?1 AND att.human_member_id = ?2 AND att.harness_id = ?3 AND att.detached_at IS NULL
          AND EXISTS (SELECT 1 FROM member_tokens t
                       WHERE t.id = att.seat_token_id AND t.member_id = b.member_id AND t.agent_id = a.id AND t.tenant = ?1
                         AND t.channel = 'directory' AND ${TOKEN_LIVE_PREDICATE('?5')})
          AND EXISTS (SELECT 1 FROM member_tokens g
                       WHERE g.id = ?4 AND g.member_id = ?2 AND g.tenant = ?1 AND g.channel = 'directory' AND g.agent_id IS NULL
                         AND ${TOKEN_LIVE_PREDICATE('?5').replace(/\bt\./g, 'g.')})
        ORDER BY att.created_at DESC
        LIMIT 400`, // same ceiling as the attachable-agent list: the per-agent dedupe and the admin floor run AFTER this, so a small cap could hide a real agent
    ).bind(env.TENANT_SLUG, human.memberId, human.harnessId, human.grantTokenId, nowSqlUtc()).all<Row>()).results ?? []
  } catch (err) {
    if (/no such table:\s*agent_seat_(attachments|admissions|seats)\b/i.test(err instanceof Error ? err.message : String(err))) return []
    throw err
  }
  const grants = await resolveCapabilities(env, human.memberId)
  const out: EventsAttachment[] = []
  const seen = new Set<string>()
  const adminOn = new Map<string, boolean>()
  for (const r of rows) {
    if (seen.has(r.agent_id)) continue
    let ok = adminOn.get(r.squad_id)
    if (ok === undefined) {
      ok = await canOnSquad(env, grants, r.squad_id, 'admin')
      adminOn.set(r.squad_id, ok)
    }
    if (!ok) continue
    seen.add(r.agent_id)
    out.push({ attachmentId: r.attachment_id, agentId: r.agent_id, slug: r.slug, name: r.name, squadId: r.squad_id, agentMemberId: r.agent_member_id, seatTokenId: r.seat_token_id })
  }
  return out
}

/** Which attachment a call means: the `agent` argument (id, slug or exact name, matched only among the LIVE candidates), or the only one. */
export function pickAttachment(
  cands: EventsAttachment[],
  ref: unknown,
): { ok: true; attachment: EventsAttachment } | { ok: false; code: string; data: Record<string, unknown> } {
  const list = cands.map((c) => ({ id: c.agentId, slug: c.slug }))
  if (ref !== undefined && ref !== null && ref !== '') {
    if (typeof ref !== 'string') return { ok: false, code: 'invalid_arguments', data: { reason: 'agent must be a string' } }
    const lower = ref.toLowerCase()
    const hit = cands.filter((c) => c.agentId === ref || c.slug.toLowerCase() === lower || c.name.toLowerCase() === lower)
    if (hit.length === 1) return { ok: true, attachment: hit[0] }
    // Unknown and not-attached read the same: no existence oracle for agents this grant is not attached to.
    return { ok: false, code: 'agent_not_attached', data: { reason: 'no live attachment for that agent on this connection', attached: list } }
  }
  if (cands.length === 1) return { ok: true, attachment: cands[0] }
  return { ok: false, code: 'agent_required', data: { reason: 'this connection is attached to several agents: pass arguments.agent', attached: list } }
}

/** The auth the events handlers evaluate: the attached AGENT's identity, the ATTACHMENT's own token, the human as the consenting member,
 *  capabilities = the agent's grants clamped by the human (live). Never a seat handle. */
export async function eventsAuthForAttachment(env: Env, grant: AuthContext, a: EventsAttachment): Promise<AuthContext> {
  const caps = await resolveConsentedAgentCapabilities(env, a.agentId, grant.memberId ?? null)
  return {
    ...grant,
    boundAgentId: a.agentId,
    memberId: a.agentMemberId,
    tokenId: a.seatTokenId,
    consentedByMemberId: grant.memberId ?? null,
    capabilities: caps,
  }
}
