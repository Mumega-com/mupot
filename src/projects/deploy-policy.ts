// src/projects/deploy-policy.ts — policy rule 5: a deploy-class action on a seed-attached project
// needs a canary receipt and a rollback line, enforced IN THE TOOL, not in prose.
//
// WHAT COUNTS
//   seed-attached   a project_seeds row exists for the project (seed_attach apply, any status: a seed
//                   still applying is treated as attached, fail closed).
//   canary receipt  the id of a TASK that
//                     - exists and belongs to the SAME project,
//                     - is gated by CANARY_GATE_OWNER (that is what makes it a canary rather than any
//                       task: the gate lane is held only by principals an admin granted it to),
//                     - is currently `approved` (or `done`, its normal next state) with its latest
//                       verdict an un-reversed approval,
//                     - was approved no more than CANARY_RECEIPT_MAX_AGE_HOURS ago, and
//                     - is not archived,
//                     - was approved by someone who neither is nor acts for the caller who is deploying
//                       (approverActsForDeployer: same identity, an agent owned by / bound to the
//                       deployer, or a member who owns / is bound to / holds the key of the deployer's
//                       agent; the verdict itself is independence-checked by the verdict write), and
//                     - has not already backed a deploy of this project (the deploy's receipt records
//                       `canary:<task id>:` in deployment_id; project_deployments is append-only).
//   rollback        a non-empty line saying how to undo the deploy (not a placeholder word).
// Every refusal has its own error code so a caller can tell which condition failed.
//
// ONE function (`checkDeployPolicy`) is called by deployProject, the shared function every deploy
// caller (the MCP tool, the REST route, the dashboard) goes through; there is no caller-supplied
// switch that skips it.

import type { AuthContext, Env, Project } from '../types'
import { findLatestVerdict } from '../tasks/service'
import { isPlaceholderArtifactPath } from '../tasks/artifact-verification'
import { isMemberAffiliatedWithAssigneeAgent } from '../tasks/verdict-independence'
import { isTaskArchived } from '../hygiene/filters'

/** The gate lane that marks a task as a canary receipt. */
export const CANARY_GATE_OWNER = 'gate:canary'
/** A canary approval older than this no longer vouches for a deploy. */
export const CANARY_RECEIPT_MAX_AGE_HOURS = 24
export const ROLLBACK_MAX_CHARS = 500

export type DeployPolicyError =
  | 'canary_receipt_required'
  | 'canary_receipt_not_found'
  | 'canary_receipt_archived'
  | 'canary_receipt_wrong_project'
  | 'canary_receipt_not_canary'
  | 'canary_receipt_not_passed'
  | 'canary_receipt_stale'
  | 'canary_receipt_self_certified'
  | 'canary_receipt_reused'
  | 'rollback_required'

export type DeployPolicyResult =
  | { ok: true; seedAttached: false }
  | { ok: true; seedAttached: true; canaryReceipt: string; rollback: string }
  | { ok: false; error: DeployPolicyError }

/** The deployment_id prefix that records which canary backed a deploy (project_deployments is append-only). */
export const CANARY_DEPLOYMENT_PREFIX = 'canary:'
export const canaryDeploymentId = (canaryTaskId: string, unique: string): string =>
  `${CANARY_DEPLOYMENT_PREFIX}${canaryTaskId}:${unique}`

/** True when this canary already backed a deploy of the project. Prefix compare, not LIKE: ids are caller text. */
export async function canaryAlreadyUsed(env: Env, projectId: string, canaryTaskId: string): Promise<boolean> {
  const prefix = `${CANARY_DEPLOYMENT_PREFIX}${canaryTaskId}:`
  const row = await env.DB.prepare(
    'SELECT 1 AS x FROM project_deployments WHERE project_id = ?1 AND substr(deployment_id, 1, ?2) = ?3 LIMIT 1',
  ).bind(projectId, prefix.length, prefix).first<{ x: number }>()
  return row !== null
}

/**
 * Does `decidedBy` (the canary approver) act for, or as, the deployer? Same affiliation logic as the
 * verdict rule, in both directions of agents.owner_member_id:
 *   - the approver IS the deployer (member id, user id or bound agent id);
 *   - the approver is an AGENT owned by / bound to a deployer identity (deployer approving through
 *     their own agent);
 *   - the approver is a MEMBER who owns / is bound to / holds the key of the deployer's agent
 *     (deployer is an agent acting for its owner).
 */
export async function approverActsForDeployer(env: Env, decidedBy: string, auth: AuthContext): Promise<boolean> {
  const ids = [auth.memberId, auth.userId, auth.boundAgentId].filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (ids.includes(decidedBy)) return true
  const agent = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?1').bind(decidedBy).first<{ owner_member_id: string | null }>()
  if (agent) {
    if (agent.owner_member_id && ids.includes(agent.owner_member_id)) return true
    const bound = await env.DB.prepare('SELECT member_id FROM agent_member_bindings WHERE agent_id = ?1').bind(decidedBy).all<{ member_id: string }>()
    if ((bound.results ?? []).some((b) => ids.includes(b.member_id))) return true
  }
  if (auth.boundAgentId && (await isMemberAffiliatedWithAssigneeAgent(env, decidedBy, auth.boundAgentId))) return true
  return false
}

export async function isSeedAttached(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS x FROM project_seeds WHERE project_id = ?1 AND tenant = ?2 LIMIT 1',
  ).bind(projectId, env.TENANT_SLUG).first<{ x: number }>()
  return row !== null
}

function cleanLine(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

export async function checkDeployPolicy(
  env: Env,
  project: Pick<Project, 'id'>,
  auth: AuthContext,
  input: { canary_receipt?: unknown; rollback?: unknown },
  now: number = Date.now(),
): Promise<DeployPolicyResult> {
  if (!(await isSeedAttached(env, project.id))) return { ok: true, seedAttached: false }

  const receiptId = cleanLine(input.canary_receipt)
  if (!receiptId) return { ok: false, error: 'canary_receipt_required' }

  const task = await env.DB.prepare(
    'SELECT id, project_id, gate_owner, status FROM tasks WHERE id = ?1',
  ).bind(receiptId).first<{ id: string; project_id: string | null; gate_owner: string | null; status: string }>()
  if (!task) return { ok: false, error: 'canary_receipt_not_found' }
  if (task.project_id !== project.id) return { ok: false, error: 'canary_receipt_wrong_project' }
  if (task.gate_owner !== CANARY_GATE_OWNER) return { ok: false, error: 'canary_receipt_not_canary' }

  if (await isTaskArchived(env, task.id)) return { ok: false, error: 'canary_receipt_archived' }

  const verdict = await findLatestVerdict(env, task.id)
  // `approved` -> `done` is the normal life of an approved task, so both still vouch; anything else
  // (back in review, reopened, rejected) does not, and neither does a verdict that is not an
  // un-reversed approval. The three conditions overlap on purpose: a row set that disagrees with
  // itself fails closed instead of being reasoned about.
  if (!['approved', 'done'].includes(task.status) || !verdict || verdict.verdict !== 'approved' || verdict.reversed_at) {
    return { ok: false, error: 'canary_receipt_not_passed' }
  }
  const decidedAt = Date.parse(verdict.decided_at)
  if (!Number.isFinite(decidedAt)) return { ok: false, error: 'canary_receipt_not_passed' }
  const ageMs = now - decidedAt
  if (ageMs > CANARY_RECEIPT_MAX_AGE_HOURS * 3_600_000) return { ok: false, error: 'canary_receipt_stale' }
  // A decision from the future cannot be a completed canary.
  if (ageMs < -60_000) return { ok: false, error: 'canary_receipt_not_passed' }

  if (await approverActsForDeployer(env, verdict.decided_by, auth)) return { ok: false, error: 'canary_receipt_self_certified' }
  // One canary backs one deploy: a green canary is not a standing licence.
  if (await canaryAlreadyUsed(env, project.id, task.id)) return { ok: false, error: 'canary_receipt_reused' }

  const rollback = cleanLine(input.rollback)
  if (!rollback || rollback.length > ROLLBACK_MAX_CHARS || isPlaceholderArtifactPath(rollback)) {
    return { ok: false, error: 'rollback_required' }
  }
  return { ok: true, seedAttached: true, canaryReceipt: task.id, rollback }
}
