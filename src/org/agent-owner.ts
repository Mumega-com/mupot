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

export type OwnerChangeRefusal =
  | { ok: true }
  | { ok: false; status: 400; error: 'invalid_args'; detail: string }
  | { ok: false; status: 403; error: 'forbidden'; detail: { need: typeof MEMBER_BIND_MINT_FLOOR; scope: 'org' } }
  | { ok: false; status: 403; error: 'target_rank_exceeds_ceiling'; detail: { owner_member_id: string } }

export async function authorizeOwnerMemberChange(
  env: Env,
  auth: AuthContext,
  agentId: string,
  ownerMemberId: unknown,
): Promise<OwnerChangeRefusal> {
  // OUTGOING owner (mupot#1987 gate P1): replacing or clearing an owner who outranks
  // the caller would let them detach the verdict-independence / approval-routing
  // principal. Applies to replace, clear and take-over alike; the self-target waiver
  // below does NOT skip it (a self-owner is exempt inside the ceiling itself).
  // The current owner is read HERE, fresh, so no caller can pass a stale or wrong one.
  const currentRow = ownerMemberId === undefined
    ? null
    : await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?').bind(agentId).first<{ owner_member_id: string | null }>()
  const currentOwnerMemberId = currentRow?.owner_member_id ?? null
  if (ownerMemberId !== undefined && currentOwnerMemberId) {
    if (await exceedsTargetRankCeiling(env, auth, currentOwnerMemberId)) {
      return { ok: false, status: 403, error: 'target_rank_exceeds_ceiling', detail: { owner_member_id: currentOwnerMemberId } }
    }
  }
  if (typeof ownerMemberId !== 'string' || ownerMemberId.length === 0) return { ok: true }
  if (/\s/.test(ownerMemberId)) {
    return { ok: false, status: 400, error: 'invalid_args', detail: 'owner_member_id must not contain whitespace' }
  }
  const isSelfTarget = auth.memberId != null && auth.memberId === ownerMemberId
  if (isSelfTarget) return { ok: true }
  const actorOrgRank = await actorRankOnScopeFor(env, auth, 'org', null)
  if (actorOrgRank < capabilityRank(MEMBER_BIND_MINT_FLOOR)) {
    return { ok: false, status: 403, error: 'forbidden', detail: { need: MEMBER_BIND_MINT_FLOOR, scope: 'org' } }
  }
  if (await exceedsTargetRankCeiling(env, auth, ownerMemberId)) {
    return { ok: false, status: 403, error: 'target_rank_exceeds_ceiling', detail: { owner_member_id: ownerMemberId } }
  }
  return { ok: true }
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
