// The ONE authorization predicate for setting agents.owner_member_id to a member
// (mupot#1425 gate rounds 1-2, extracted for mupot#1987). Both doors call it: the MCP
// update_agent tool and the dashboard POST /agents/:id/owner. Do not re-derive.
//
// owner_member_id is credential-conferring (it decides whose member identity the
// agent's harness may carry into a task_verdict), so a non-self, non-null target needs
// the org-scope MEMBER_BIND_MINT_FLOOR plus the target-rank ceiling. A self-target is
// exempt from both; clearing (null) confers nothing and is not gated here. Whitespace
// is rejected outright so the checked string and the written string cannot differ.
import type { AuthContext, Env } from '../types'
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
  ownerMemberId: unknown,
): Promise<OwnerChangeRefusal> {
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
