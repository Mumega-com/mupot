// mupot — approval_expiry_sweep / approval_resubmit_cap_reset MCP tools (migrations/0232).
// Thin ToolSpec wrappers around src/gates/approval-expiry.ts (the guarded core, shared with the cron).
//
// Gate: org-admin only, operator principal only (no agent-bound caller), exactly the archive_row /
// task_incident_revert bar: an agent seat can never expire or un-cap a human's approval queue.
// approval_expiry_sweep is the ONE-TIME BACKFILL path: it goes through the SAME transition code as
// the cron (sweepExpiredApprovals), never raw SQL, and records gate_owner_dead vs approval_expired
// distinctly on every receipt. dry_run DEFAULTS TO TRUE (scripts/check-effectful-tools-dry-run.mjs).

import type { AuthContext } from '../types'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import { APPROVAL_EXPIRY, resetResubmitCap, sweepExpiredApprovals } from '../gates/approval-expiry'

function requireOperatorOrgAdmin(auth: AuthContext): ReturnType<typeof fail> | null {
  if (auth.boundAgentId) return fail(403, 'operator_principal_required')
  if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
  if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
  return null
}

export const toolApprovalExpirySweep: ToolSpec = {
  name: 'approval_expiry_sweep',
  scope: 'org',
  min: 'admin',
  args: `{ dry_run?: boolean (default TRUE: counts only, nothing written), limit?: number (1-${APPROVAL_EXPIRY.sweep_batch_max}, default ${APPROVAL_EXPIRY.sweep_batch}) }` +
    ' -- org-admin only, operator principal only (no agent-bound caller). Moves every gate ask unanswered for' +
    ` ${APPROVAL_EXPIRY.gate_verdict_days} days after review entry from review to blocked through the SAME guarded transition the cron uses,` +
    ' reason approval_expired, or gate_owner_dead when the gate has grants but no live holder. Receipted' +
    ' (actor system:sweeper, via backfill) and the assignee is notified. Never writes a verdict; archived tasks' +
    ' are untouched. Bounded per call: repeat until remaining is 0. Pass dry_run:false to act.',
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail
    if (auth.tenant !== env.TENANT_SLUG) return fail(403, 'forbidden', { need: 'same_tenant' })
    const rawLimit = args.limit
    if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > APPROVAL_EXPIRY.sweep_batch_max)) {
      return fail(400, 'invalid_args', `limit must be an integer 1-${APPROVAL_EXPIRY.sweep_batch_max}`)
    }
    // Default is the dry run: only an explicit false acts.
    const dryRun = args.dry_run !== false
    const result = await sweepExpiredApprovals(env, {
      dryRun,
      via: 'backfill',
      ...(typeof rawLimit === 'number' ? { limit: rawLimit } : {}),
    })
    return done(result)
  },
}

export const toolApprovalResubmitCapReset: ToolSpec = {
  name: 'approval_resubmit_cap_reset',
  scope: 'org',
  min: 'admin',
  args: '{ task_id: string }' +
    ` -- org-admin only, operator principal only. The human touch behind the resubmit cap: after ${APPROVAL_EXPIRY.resubmit_cap} unanswered expiries` +
    ' a resubmission to review is refused (resubmit_cap_needs_human). This zeroes expired_count so the task may be' +
    ' resubmitted again; receipted (reason resubmit_cap_reset). Archived tasks are refused.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const gateFail = requireOperatorOrgAdmin(auth)
    if (gateFail) return gateFail
    if (auth.tenant !== env.TENANT_SLUG) return fail(403, 'forbidden', { need: 'same_tenant' })
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    const out = await resetResubmitCap(env, taskId, auth.memberId as string) // requireOperatorOrgAdmin proved memberId
    if (!out.ok) return fail(out.error === 'not_found' ? 404 : 409, out.error ?? 'refused')
    return done({ task_id: taskId, receipt_id: out.receipt_id })
  },
}

export const APPROVAL_EXPIRY_TOOLS: ToolSpec[] = [toolApprovalExpirySweep, toolApprovalResubmitCapReset]
