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
//                     - was approved by someone other than the caller who is deploying (nobody
//                       certifies their own deploy; the verdict itself is independence-checked by
//                       the verdict write, see src/tasks/verdict-independence.ts).
//   rollback        a non-empty line saying how to undo the deploy (not a placeholder word).
// Every refusal has its own error code so a caller can tell which condition failed.
//
// ONE function (`checkDeployPolicy`) is called by deployProject, the shared function every deploy
// caller (the MCP tool, the REST route, the dashboard) goes through; there is no caller-supplied
// switch that skips it.

import type { AuthContext, Env, Project } from '../types'
import { findLatestVerdict } from '../tasks/service'
import { isPlaceholderArtifactPath } from '../tasks/artifact-verification'

/** The gate lane that marks a task as a canary receipt. */
export const CANARY_GATE_OWNER = 'gate:canary'
/** A canary approval older than this no longer vouches for a deploy. */
export const CANARY_RECEIPT_MAX_AGE_HOURS = 24
export const ROLLBACK_MAX_CHARS = 500

export type DeployPolicyError =
  | 'canary_receipt_required'
  | 'canary_receipt_not_found'
  | 'canary_receipt_wrong_project'
  | 'canary_receipt_not_canary'
  | 'canary_receipt_not_passed'
  | 'canary_receipt_stale'
  | 'canary_receipt_self_certified'
  | 'rollback_required'

export type DeployPolicyResult =
  | { ok: true; seedAttached: false }
  | { ok: true; seedAttached: true; canaryReceipt: string; rollback: string }
  | { ok: false; error: DeployPolicyError }

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

  const caller = new Set([auth.memberId, auth.userId, auth.boundAgentId].filter((v): v is string => typeof v === 'string' && v.length > 0))
  if (caller.has(verdict.decided_by)) return { ok: false, error: 'canary_receipt_self_certified' }

  const rollback = cleanLine(input.rollback)
  if (!rollback || rollback.length > ROLLBACK_MAX_CHARS || isPlaceholderArtifactPath(rollback)) {
    return { ok: false, error: 'rollback_required' }
  }
  return { ok: true, seedAttached: true, canaryReceipt: task.id, rollback }
}
