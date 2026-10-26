// The ONE authorization predicate for setting agents.owner_member_id to a member
// (mupot#1425 gate rounds 1-2, extracted for mupot#1987). Both doors call it: the MCP
// update_agent tool and the dashboard POST /agents/:id/owner. Do not re-derive.
//
// owner_member_id is credential-conferring (it decides whose member identity the
// agent's harness may carry into a task_verdict), so a non-self, non-null target needs
// the org-scope MEMBER_BIND_MINT_FLOOR plus the target-rank ceiling. A self-target is
// exempt from both; clearing (null) confers nothing and is not gated here. Whitespace
// is rejected outright so the checked string and the written string cannot differ.
import type { AuthContext, BusEvent, Env } from '../types'
import { createBus } from '../bus'
import { actorRankOnScopeFor, capabilityRank, exceedsTargetRankCeiling } from '../auth/capability'
import { MEMBER_BIND_MINT_FLOOR } from '../members/project-invites'
import { attachedAuthority } from '../auth/attached-ceiling'

/** Which member-reference column on agents the change targets. Both are authenticate-as-conferring, both use ONE predicate. */
export type OwnerDoorColumn = 'owner_member_id' | 'attach_designated_member_id'

export type OwnerChangeRefusal =
  | { ok: true; /** the outgoing value read by THIS check; carry it into the write so the check and the write cannot interleave */ current?: string | null }
  | { ok: false; status: 400; error: 'invalid_args'; detail: string }
  | { ok: false; status: 403; error: 'forbidden'; detail: { need: typeof MEMBER_BIND_MINT_FLOOR; scope: 'org' } }
  | { ok: false; status: 403; error: 'target_rank_exceeds_ceiling'; detail: { owner_member_id: string } }
  | { ok: false; status: 403; error: 'agent_rank_exceeds_ceiling'; detail: { agent_id: string } }
  | { ok: false; status: 403; error: 'seat_session_forbidden'; detail: { column: OwnerDoorColumn } }

export async function authorizeOwnerMemberChange(
  env: Env,
  auth: AuthContext,
  agentId: string,
  ownerMemberId: unknown,
  column: OwnerDoorColumn = 'owner_member_id',
): Promise<OwnerChangeRefusal> {
  // attach_designated_member_id (migration 0238) decides which agents a human's chats may BECOME. It goes through this same
  // door with two differences: (1) NO self-target waiver (a squad admin could otherwise designate themselves on any agent),
  // and (2) a seat or attached chat may never write it (a chat must not widen what chats may become). The seat test reads
  // the server-derived auth.seatBinding / attachedAuthority, never a client claim. Ranks below are read from the EFFECTIVE
  // auth.capabilities (actorRankOnScopeFor), never DB rows, so an attached or clamped session cannot out-rank its clamp.
  const designation = column === 'attach_designated_member_id'
  if (designation && ownerMemberId !== undefined && (auth.seatBinding || attachedAuthority(auth))) {
    return { ok: false, status: 403, error: 'seat_session_forbidden', detail: { column } }
  }
  // OUTGOING owner (mupot#1987 gate P1): replacing or clearing an owner who outranks
  // the caller would let them detach the verdict-independence / approval-routing
  // principal. Applies to replace, clear and take-over alike; the self-target waiver
  // below does NOT skip it (a self-owner is exempt inside the ceiling itself).
  // The current owner is read HERE, fresh, so no caller can pass a stale or wrong one.
  const currentRow = ownerMemberId === undefined
    ? null
    : await env.DB.prepare(`SELECT ${column} AS owner_member_id FROM agents WHERE id = ?`).bind(agentId).first<{ owner_member_id: string | null }>()
  const currentOwnerMemberId = currentRow?.owner_member_id ?? null
  if (ownerMemberId !== undefined && currentOwnerMemberId) {
    if (await exceedsTargetRankCeiling(env, auth, currentOwnerMemberId)) {
      return { ok: false, status: 403, error: 'target_rank_exceeds_ceiling', detail: { owner_member_id: currentOwnerMemberId } }
    }
  }
  // Mom-walk D2: an agent's OWNER may designate THEMSELVES for their own agent, with no org-admin floor. Narrow on purpose:
  // the target must be the caller, the caller must be the agent's CURRENT agents.owner_member_id (read fresh here, never a
  // token minter or a bound member), and the caller must be a real member session (the seat / attached / agent-bound refusals
  // above and the route's boundAgentId refusal already exclude chats and agents). Designating someone else, clearing a
  // designation, or acting on an agent the caller does not own keeps the admin floor below. The outgoing-designee rank
  // ceiling above and the AGENT ceiling at the bottom (owner OR bound member outranking the caller) still apply.
  let ownerSelfDesignation = false
  if (designation && typeof ownerMemberId === 'string' && ownerMemberId.length > 0 && auth.memberId != null
    && auth.memberId === ownerMemberId && !auth.boundAgentId) {
    const ownerRow = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
    ownerSelfDesignation = ownerRow?.owner_member_id === auth.memberId
  }
  if (designation && ownerMemberId !== undefined && !ownerSelfDesignation) {
    // Clearing a designation disables every attached chat of the agent, so it needs the same org floor as setting one.
    const floorRank = await actorRankOnScopeFor(env, auth, 'org', null)
    if (floorRank < capabilityRank(MEMBER_BIND_MINT_FLOOR)) {
      return { ok: false, status: 403, error: 'forbidden', detail: { need: MEMBER_BIND_MINT_FLOOR, scope: 'org' } }
    }
  }
  if (typeof ownerMemberId !== 'string' || ownerMemberId.length === 0) return { ok: true, current: currentOwnerMemberId }
  if (/\s/.test(ownerMemberId)) {
    return { ok: false, status: 400, error: 'invalid_args', detail: 'owner_member_id must not contain whitespace' }
  }
  const isSelfTarget = !designation && auth.memberId != null && auth.memberId === ownerMemberId
  if (isSelfTarget) return { ok: true, current: currentOwnerMemberId }
  if (!ownerSelfDesignation) {
    const actorOrgRank = await actorRankOnScopeFor(env, auth, 'org', null)
    if (actorOrgRank < capabilityRank(MEMBER_BIND_MINT_FLOOR)) {
      return { ok: false, status: 403, error: 'forbidden', detail: { need: MEMBER_BIND_MINT_FLOOR, scope: 'org' } }
    }
  }
  if (!ownerSelfDesignation && await exceedsTargetRankCeiling(env, auth, ownerMemberId)) {
    return { ok: false, status: 403, error: 'target_rank_exceeds_ceiling', detail: { owner_member_id: ownerMemberId } }
  }
  // AGENT ceiling (designation only): a chat that becomes the agent acts with the agent's standing, so the actor may not
  // designate an agent whose owner OR welded/bound member outranks them (e.g. an owner-held or high-rank steward agent),
  // even for themselves. Ranks come from the effective auth.capabilities of the actor (exceedsTargetRankCeiling).
  if (designation) {
    const holders = await env.DB.prepare(
      `SELECT a.owner_member_id AS owner_member_id, b.member_id AS bound_member_id
         FROM agents a LEFT JOIN agent_member_bindings b ON b.tenant = ?2 AND b.agent_id = a.id WHERE a.id = ?1`,
    ).bind(agentId, env.TENANT_SLUG).all<{ owner_member_id: string | null; bound_member_id: string | null }>()
    for (const r of holders.results ?? []) {
      for (const m of [r.owner_member_id, r.bound_member_id]) {
        if (m && await exceedsTargetRankCeiling(env, auth, m)) {
          return { ok: false, status: 403, error: 'agent_rank_exceeds_ceiling', detail: { agent_id: agentId } }
        }
      }
    }
  }
  return { ok: true, current: currentOwnerMemberId }
}

// Same org.provisioned / agent_updated event shape MCP update_agent emits (a small
// deliberate duplicate: importing src/mcp/provision from the dashboard closes the mcp
// import cycle — see the note in src/projects/start-gate.ts). Best-effort, never throws.
export async function emitAgentOwnerUpdated(
  env: Env,
  memberId: string,
  agent: { id: string; squad_id: string; owner_member_id: string | null },
  newOwner: string | null,
): Promise<void> {
  const event: BusEvent<{ kind: string; id: string; by: string; changed: Record<string, { from: unknown; to: unknown }> }> = {
    type: 'org.provisioned',
    tenant: env.TENANT_SLUG,
    squad_id: agent.squad_id,
    agent_id: agent.id,
    actor: { kind: 'member', id: memberId },
    payload: {
      kind: 'agent_updated',
      id: agent.id,
      by: memberId,
      changed: { owner_member_id: { from: agent.owner_member_id ?? null, to: newOwner } },
    },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch {
    console.error('agent-owner: agent_updated emit failed (non-fatal)', { tenant: env.TENANT_SLUG, id: agent.id })
  }
}
