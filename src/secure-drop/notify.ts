// mupot - tell the people who govern an agent that its host key was registered or rotated.
//
// A stolen agent token can call host_key_register and silently re-key the agent. Every registration therefore (1) is
// receipted (store.ts), (2) emits the `org.provisioned` bus event the other in-band provisioning writes use, and (3)
// lands in the INBOX of every agent owned by a governor, through the same system-sender sendAgentMessage seam the wake
// router uses. Governors = active human members with admin/owner on the agent's squad, its department, or the org
// (the capabilities table, as projects/start-gate.listOrgOwnerMemberIds reads it). Their inbox agents are the agents
// whose owner_member_id is that member. Best effort by design: the key is already registered and receipted, and a
// delivery failure must not undo it (the result reports how many governors were reached, including zero).
import type { Env } from '../types'
import { sendAgentMessage } from '../agents/messages'
import type { DoorbellWaitUntil } from '../agents/webhook-doorbell'
import { createBus } from '../bus'
import { groupFingerprint } from './keys'
import type { AgentRow } from './authority'

export const NOTIFY_SENDER = 'mupot-secure-drop'

export interface GovernorNotice { governors: number; delivered: number }

/** Active human members who hold admin or owner over this agent, and the agents that carry their inbox. */
async function governorInboxes(env: Env, agent: AgentRow): Promise<{ members: string[]; agents: string[] }> {
  const tenant = env.TENANT_SLUG
  const members = await env.DB.prepare(
    `SELECT DISTINCT c.member_id AS member_id
       FROM capabilities c
       JOIN members m ON m.id = c.member_id
      WHERE m.tenant = ?1 AND m.status = 'active' AND m.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = ?1 AND b.member_id = m.id)
        AND c.capability IN ('owner', 'admin')
        AND (
          (c.scope_type = 'org')
          OR (c.scope_type = 'squad' AND c.scope_id = ?2)
          OR (c.scope_type = 'department' AND c.scope_id = (SELECT department_id FROM squads WHERE id = ?2))
        )
      ORDER BY c.member_id ASC LIMIT 25`,
  ).bind(tenant, agent.squad_id).all<{ member_id: string }>()
  const ids = (members.results ?? []).map((r) => r.member_id)
  if (ids.length === 0) return { members: [], agents: [] }
  const marks = ids.map((_, i) => `?${i + 2}`).join(', ')
  const owned = await env.DB.prepare(
    `SELECT id FROM agents WHERE status = 'active' AND owner_member_id IN (${marks}) AND id <> ?${ids.length + 2} ORDER BY id ASC LIMIT 25`,
  ).bind(tenant, ...ids, agent.id).all<{ id: string }>()
  return { members: ids, agents: (owned.results ?? []).map((r) => r.id) }
}

export async function notifyGovernorsOfHostKey(
  env: Env,
  input: { agent: AgentRow; byMemberId: string | null; fingerprint: string; rotated: boolean; keyId: string },
  waitUntil?: DoorbellWaitUntil,
): Promise<GovernorNotice> {
  const fp = groupFingerprint(input.fingerprint)
  const what = input.rotated ? 'ROTATED' : 'registered'
  // (2) the bus event, best effort like every in-band provisioning event.
  try {
    await createBus(env).emit({
      type: 'org.provisioned',
      tenant: env.TENANT_SLUG,
      squad_id: input.agent.squad_id,
      agent_id: input.agent.id,
      actor: { kind: 'member', id: input.byMemberId ?? input.agent.id },
      payload: { kind: input.rotated ? 'host_key_rotated' : 'host_key_registered', id: input.keyId, by: input.byMemberId ?? input.agent.id },
      ts: new Date().toISOString(),
    })
  } catch {
    // non-fatal: the receipt in mutation_audit_entries is the durable record
  }
  // (3) the governors' inboxes.
  let governors = 0
  let delivered = 0
  try {
    const g = await governorInboxes(env, input.agent)
    governors = g.members.length
    const body = [
      `Secure drop host key ${what} for agent ${input.agent.name} (${input.agent.slug}).`,
      `New key fingerprint: ${fp}.`,
      'If you did not expect this, a stolen agent token may have re-keyed the agent: do not paste any secret for it until you have compared this fingerprint with one you got from the host operator OUT OF BAND (not from the agent).',
    ].join(' ')
    for (const toAgent of g.agents) {
      const sent = await sendAgentMessage(env, {
        fromAgent: NOTIFY_SENDER,
        fromMember: input.byMemberId ?? input.agent.id,
        toAgent,
        kind: 'message',
        body,
        requestId: `host-key:${input.keyId}:${toAgent}`.slice(0, 128),
      }, { system: true, reason: 'secure-drop host key change notice to the inbox of an agent owned by a governor of the re-keyed agent' }, { waitUntil })
      if (sent.ok) delivered += 1
    }
  } catch {
    // best effort
  }
  return { governors, delivered }
}
