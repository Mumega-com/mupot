// mupot — "Set up wake": what the human can do, on the agent's page, to make the claimed agent reachable without polling.
//
// WHAT DECIDES THE CARD. Server-held CAPABILITY FACTS about the agent, never a harness or runtime NAME:
//   * attached  — a live agent_seat_attachments row: a chat is acting as the agent. Nudge-only by design (it reads its inbox
//                 when the chat is open), nothing to set up.
//   * push      — the pot has seat events on, AND another agent that has been reporting this agent into the fleet registry
//                 (fleet_agents.reported_by: a host daemon) is a host the viewing member OWNS and that holds a registered,
//                 active signing key. Or a live seat_event_grant already exists.
//   * webhook   — the pot has doorbells on; the card shows whether this agent has one and the last delivery outcome.
// reported_by is an untrusted, agent-written hint used only to SUGGEST a host. It confers nothing: the grant write re-checks
// ownership, the key, and the existing authorization chokepoint, and refuses everything else.
//
// THE GRANT. "Allow push from <host>" is a human-issued seat_event_grant through createSeatEventGrant (the one writer; it checks
// the host key, the host's standing in the agent's squad, the project, and the one-live-grant-per-agent fence) after
// authorizeSeatGrantTarget (org admin, or lead on the agent's squad: the existing rule). On top, and only here, the host must be
// an agent the SAME member already owns (agents.owner_member_id), so a claim can never be used to point an agent's hints at
// someone else's host. Every refusal after authorization is one uniform answer.

import type { AuthContext, Env } from '../types'
import { isOrgAdmin, resolveCapabilities } from '../auth/capability'
import { loadActiveAgentKey } from '../fleet/agent-keys'
import { activeSeatEventGrant, authorizeSeatDelivery, authorizeSeatGrantTarget, createSeatEventGrant, hostHasStandingInSquad, isSeatEventsEnabled } from '../agents/seat-events'
import { getAgentWebhookDoorbell, webhookDoorbellEnabled } from '../agents/webhook-doorbell'

export interface WakeFacts {
  attached: boolean
  seatEventsEnabled: boolean
  /** The live grant for this agent, if any. */
  grant: { id: string; hostAgentId: string; hostName: string | null; /** the delivery predicate (key, member, standing, project) still passes */ delivers: boolean } | null
  /** A host the viewing member owns that reports this agent and could be granted push. */
  hostCandidate: { id: string; name: string } | null
  doorbellEnabled: boolean
  doorbell: { configured: boolean; last4: string | null; lastOutcome: string | null; lastAt: string | null } | null
}

export type WakeCard =
  | { show: false }
  | {
      show: true
      nudgeOnly: boolean
      push: { state: 'on'; hostName: string | null } | { state: 'broken'; hostName: string | null } | { state: 'available'; hostId: string; hostName: string } | null
      webhook: { configured: boolean; last4: string | null; lastOutcome: string | null; lastAt: string | null } | null
    }

/** Pure: facts in, card out. */
export function deriveWakeCard(f: WakeFacts): WakeCard {
  const push: NonNullable<Extract<WakeCard, { show: true }>['push']> | null = !f.seatEventsEnabled
    ? null
    : f.grant
      ? { state: f.grant.delivers ? 'on' : 'broken', hostName: f.grant.hostName }
      : f.hostCandidate
        ? { state: 'available', hostId: f.hostCandidate.id, hostName: f.hostCandidate.name }
        : null
  const webhook = f.doorbellEnabled
    ? { configured: f.doorbell?.configured === true, last4: f.doorbell?.last4 ?? null, lastOutcome: f.doorbell?.lastOutcome ?? null, lastAt: f.doorbell?.lastAt ?? null }
    : null
  return { show: true, nudgeOnly: f.attached, push, webhook }
}

/** Who sees the card: the member holding a LIVE admission on this agent (they claimed it), or the agent's recorded owner. */
async function viewerClaimedAgent(env: Env, memberId: string, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM agents a
      WHERE a.id = ?2 AND (a.owner_member_id = ?1
            OR EXISTS (SELECT 1 FROM agent_seat_admissions d WHERE d.tenant = ?3 AND d.agent_id = a.id AND d.human_member_id = ?1 AND d.status = 'live'))
      LIMIT 1`,
  ).bind(memberId, agentId, env.TENANT_SLUG).first<{ x: number }>()
  return row !== null
}

/** An agent the member owns, active, with a registered active signing key, and not the agent itself. */
async function ownedHostWithKey(env: Env, memberId: string, hostId: string, agentId: string): Promise<{ id: string; name: string } | null> {
  if (hostId === agentId) return null
  const host = await env.DB.prepare(
    `SELECT id, name FROM agents WHERE id = ?1 AND status = 'active' AND archived_at IS NULL AND owner_member_id = ?2 LIMIT 1`,
  ).bind(hostId, memberId).first<{ id: string; name: string }>()
  if (!host) return null
  return (await loadActiveAgentKey(env, host.id)) ? host : null
}

export async function loadWakeCard(env: Env, auth: AuthContext, memberId: string, agentId: string): Promise<WakeCard> {
  if (!(await viewerClaimedAgent(env, memberId, agentId))) return { show: false }
  // Offer the push button only to someone the write would accept (org admin, or lead on the agent's squad): never a button that 403s.
  const target = (await authorizeSeatGrantTarget(env, { grants: auth.capabilities ?? (await resolveCapabilities(env, memberId)), orgAdmin: isOrgAdmin(auth) }, agentId))
  const attached = (await env.DB.prepare(
    `SELECT 1 AS x FROM agent_seat_attachments WHERE tenant = ?1 AND agent_id = ?2 AND detached_at IS NULL LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<{ x: number }>()) !== null

  const seatEventsEnabled = isSeatEventsEnabled(env)
  let grant: WakeFacts['grant'] = null
  let hostCandidate: WakeFacts['hostCandidate'] = null
  if (seatEventsEnabled) {
    const g = await activeSeatEventGrant(env, agentId)
    if (g) {
      const hn = await env.DB.prepare('SELECT name FROM agents WHERE id = ?1 LIMIT 1').bind(g.host_agent_id).first<{ name: string }>()
      // The row existing is not the same as delivery working: re-run the delivery predicate (key removed, standing lost...).
      grant = { id: g.id, hostAgentId: g.host_agent_id, hostName: hn?.name ?? null, delivers: (await authorizeSeatDelivery(env, g.host_agent_id, agentId)) === 'granted' }
    } else {
      const rep = await env.DB.prepare('SELECT reported_by FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1')
        .bind(env.TENANT_SLUG, agentId).first<{ reported_by: string }>()
      if (target.ok && rep?.reported_by) {
        const cand = await ownedHostWithKey(env, memberId, rep.reported_by, agentId)
        // Offer only a host the writer would accept: it must also have standing in the agent's squad (never a button that 403s).
        if (cand && (await hostHasStandingInSquad(env, cand.id, target.squadId, memberId))) hostCandidate = cand
      }
    }
  }

  const doorbellEnabled = webhookDoorbellEnabled(env)
  let doorbell: WakeFacts['doorbell'] = null
  if (doorbellEnabled) {
    const d = await getAgentWebhookDoorbell(env, agentId)
    const last = d
      ? await env.DB.prepare(
        `SELECT outcome, attempted_at FROM agent_webhook_doorbell_receipts WHERE tenant = ?1 AND agent_id = ?2 ORDER BY attempted_at DESC LIMIT 1`,
      ).bind(env.TENANT_SLUG, agentId).first<{ outcome: string; attempted_at: string }>()
      : null
    doorbell = { configured: d !== null, last4: d?.auth_last4 ?? null, lastOutcome: last?.outcome ?? null, lastAt: last?.attempted_at ?? null }
  }
  return deriveWakeCard({ attached, seatEventsEnabled, grant, hostCandidate, doorbellEnabled, doorbell })
}

export type AllowPushResult =
  | { ok: true; grantId: string }
  | { ok: false; error: 'not_enabled' | 'not_allowed' | 'invalid_args' | 'failed' }

/**
 * "Allow push from <host>". `memberId` is the SESSION member; the host must be an agent that member owns and that holds an active
 * registered key; the agent must be one they claimed (or own) and may authorize seat grants for (org admin or squad lead).
 */
export async function allowPushFromHost(
  env: Env,
  auth: AuthContext,
  p: { memberId: string; agentId: string; hostAgentId: unknown },
): Promise<AllowPushResult> {
  if (!isSeatEventsEnabled(env)) return { ok: false, error: 'not_enabled' }
  if (typeof p.hostAgentId !== 'string' || p.hostAgentId.length === 0 || p.hostAgentId.length > 64) return { ok: false, error: 'invalid_args' }
  if (!(await viewerClaimedAgent(env, p.memberId, p.agentId))) return { ok: false, error: 'not_allowed' }
  const grants = auth.capabilities ?? (await resolveCapabilities(env, p.memberId))
  const target = await authorizeSeatGrantTarget(env, { grants, orgAdmin: isOrgAdmin(auth) }, p.agentId)
  if (!target.ok) return { ok: false, error: 'not_allowed' }
  const host = await ownedHostWithKey(env, p.memberId, p.hostAgentId, p.agentId)
  if (!host) return { ok: false, error: 'not_allowed' }
  const res = await createSeatEventGrant(env, {
    hostAgentId: host.id,
    agentId: p.agentId,
    memberId: p.memberId,
    reason: 'Allowed by the agent\'s human from the agent page (Set up wake)',
    expectSquadId: target.squadId,
  })
  if (!res.ok) return { ok: false, error: res.reason === 'invalid_args' ? 'invalid_args' : res.reason === 'db_error' ? 'failed' : 'not_allowed' }
  return { ok: true, grantId: res.id }
}
