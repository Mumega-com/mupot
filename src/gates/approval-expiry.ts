// src/gates/approval-expiry.ts — an unanswered gate ask expires (Hadi, org owner, 2026-10-16:
// "if one didn't answer to the approval it expires").
//
// BEFORE: a task in `review` with a gate_owner waited forever. The only exit from review is a
// verdict and nothing swept (the stall watchdog only re-wakes; it never closes).
//
// RULE (one config constant, below):
//   - a gate verdict ask and a publish ask expire 14 days after the task ENTERED review;
//   - a secret-env request expires after 30 days;
//   - elevations (10 min) and secure moments keep their own windows and are NOT touched here.
//   Slice 1 enforces the gate-verdict window (tasks in `review`). The publish and secret-env
//   windows are recorded here as the rule but their enforcement is a follow-up (see issue).
//
// ONE PREDICATE. GATE_ASK_LIVE_PREDICATE is written once and used by:
//   - the read side (Needs You approvals source, /approvals queue),
//   - the verdict WRITE (buildVerdictStatements' UPDATE ... WHERE, the chokepoint HTTP, MCP, IM,
//     harness-attested origin and office all funnel through),
//   - the sweep's candidate scan (as NOT live).
//   A reader that hides an ask the writer would still accept (or the reverse) is the defect this
//   avoids. EXPIRY IS NEVER APPROVAL: an expired ask cannot be approved; the sweep moves it to
//   `blocked`, it never writes a verdict.
//
// CLOCK. review_entered_at is stamped BY TRIGGER (migrations/0232) on every transition into
// review. updated_at is NOT the clock: stall rewakes and notices bump it.

import type { Env, Task } from '../types'
import { TASK_NOT_ARCHIVED_SQL, isTaskArchived } from '../hygiene/filters'
import { claimTimestamp } from '../lib/claim-timestamp'
import { sendAgentMessage } from '../agents/messages'
import { persistGateWakeNotice } from './grants'
import { CAPABILITY_LIVE_PREDICATE } from '../auth/capability'
import {
  APPROVAL_EXPIRY,
  GATE_ASK_LIVE_PREDICATE,
  gateAskExpiresAt,
  type ExpiryReason,
} from './approval-expiry-rule'

export * from './approval-expiry-rule'

export const SWEEPER_ACTOR = 'system:sweeper'
const SWEEPER_SENDER = 'mupot-approval-sweeper'
export const APPROVAL_EXPIRED_NOTICE = 'approval expired unanswered — resubmit if still needed'

// "Dead" gate: nobody can answer it. Live holder = an ACTIVE principal behind a gate_grants row
// (the wake seam's liveness: agents.status / members.status = 'active'). A capability with NO grants
// is an org-admin lane (e.g. gate:routines, decided by role) and is live only while an org owner/admin
// with a live capability row exists (CAPABILITY_LIVE_PREDICATE): a gate whose grants were all revoked
// AND that has no live org admin behind it is dead too.
const GATE_DEAD_SQL = `(
  NOT EXISTS (
    SELECT 1 FROM gate_grants gg
      LEFT JOIN agents ga ON gg.principal_type = 'agent' AND ga.id = gg.principal_id
      LEFT JOIN members gm ON gg.principal_type = 'member' AND gm.id = gg.principal_id
     WHERE gg.capability = t.gate_owner
       AND ((gg.principal_type = 'agent' AND ga.status = 'active')
         OR (gg.principal_type = 'member' AND gm.status = 'active')))
  AND NOT (
    NOT EXISTS (SELECT 1 FROM gate_grants gg WHERE gg.capability = t.gate_owner)
    AND EXISTS (
      SELECT 1 FROM capabilities cap
        JOIN members cm ON cm.id = cap.member_id AND cm.status = 'active'
       WHERE cap.scope_type = 'org' AND cap.capability IN ('owner', 'admin')
         AND ${CAPABILITY_LIVE_PREDICATE('cap', "datetime('now')")})))`

export interface ExpirySweepOptions {
  dryRun?: boolean
  limit?: number
  via?: 'cron' | 'backfill'
  /** Recorded as the receipt actor. The cron and the backfill both run as the system sweeper. */
  actor?: string
}

export interface ExpirySweepResult {
  dry_run: boolean
  scanned: number
  expired: number
  approval_expired: number
  gate_owner_dead: number
  notified: number
  skipped_claimed: number
  errors: number
  /** Expired asks beyond this batch (the next tick / call takes them). */
  remaining: number
  task_ids: string[]
}

interface Candidate {
  id: string
  squad_id: string
  gate_owner: string
  assignee_agent_id: string | null
  review_entered_at: string | null
  updated_at: string
  expired_count: number
  dead: number
}

function clampLimit(limit: number | undefined): number {
  const n = limit === undefined ? APPROVAL_EXPIRY.sweep_batch : Math.trunc(limit)
  if (!Number.isSafeInteger(n) || n < 1) return APPROVAL_EXPIRY.sweep_batch
  return Math.min(n, APPROVAL_EXPIRY.sweep_batch_max)
}

/**
 * Sweep unanswered gate asks: review -> blocked, reason approval_expired | gate_owner_dead.
 *
 * IDEMPOTENT + BOUNDED. The candidate scan only sees tasks still in review and past the window;
 * the transition is ONE guarded UPDATE (status='review', same review_entered_at, not live, not
 * archived) in a batch with its receipt INSERT anchored on that UPDATE's own unique updated_at, so
 * a concurrent sweep, a late verdict or an archive makes it a no-op and a re-run finds nothing.
 * Archived tasks are never touched (TASK_NOT_ARCHIVED_SQL on scan and write). dryRun reads only.
 */
export async function sweepExpiredApprovals(env: Env, opts: ExpirySweepOptions = {}): Promise<ExpirySweepResult> {
  const dryRun = opts.dryRun === true
  const via = opts.via ?? 'cron'
  const actor = opts.actor ?? SWEEPER_ACTOR
  const limit = clampLimit(opts.limit)
  const result: ExpirySweepResult = {
    dry_run: dryRun, scanned: 0, expired: 0, approval_expired: 0, gate_owner_dead: 0,
    notified: 0, skipped_claimed: 0, errors: 0, remaining: 0, task_ids: [],
  }

  const where = `t.status = 'review' AND t.gate_owner IS NOT NULL AND t.gate_owner <> ''
        AND ${TASK_NOT_ARCHIVED_SQL('t')}
        AND NOT (${GATE_ASK_LIVE_PREDICATE('t', "datetime('now')")})`
  const rows = await env.DB.prepare(
    `SELECT t.id, t.squad_id, t.gate_owner, t.assignee_agent_id, t.review_entered_at, t.updated_at,
            t.expired_count, ${GATE_DEAD_SQL} AS dead
       FROM tasks t
      WHERE ${where}
      ORDER BY COALESCE(t.review_entered_at, t.updated_at) ASC, t.id ASC
      LIMIT ?1`,
  ).bind(limit).all<Candidate>()
  const candidates = rows.results ?? []
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`)
    .first<{ n: number }>()
  result.remaining = Math.max(0, (total?.n ?? 0) - candidates.length)

  for (const c of candidates) {
    result.scanned += 1
    const reason: ExpiryReason = Number(c.dead) === 1 ? 'gate_owner_dead' : 'approval_expired'
    if (dryRun) {
      result.expired += 1
      result[reason] += 1
      result.task_ids.push(c.id)
      continue
    }
    try {
      const entered = c.review_entered_at ?? c.updated_at
      const stamp = claimTimestamp()
      const receiptId = crypto.randomUUID()
      const batch = await env.DB.batch([
        env.DB.prepare(
          `UPDATE tasks
              SET status = 'blocked', updated_at = ?1, expired_count = expired_count + 1
            WHERE id = ?2 AND status = 'review' AND review_entered_at IS ?3
              AND NOT (${GATE_ASK_LIVE_PREDICATE('tasks', "datetime('now')")})
              AND ${TASK_NOT_ARCHIVED_SQL()}`,
        ).bind(stamp, c.id, c.review_entered_at),
        env.DB.prepare(
          `INSERT INTO approval_expiry_receipts
             (id, tenant, task_id, squad_id, gate_owner, from_status, to_status, reason,
              review_entered_at, expires_at, expired_count_after, actor, via, notify_target)
           SELECT ?1, ?2, id, squad_id, gate_owner, 'review', 'blocked', ?3, review_entered_at, ?4,
                  expired_count, ?5, ?6, ?7
             FROM tasks WHERE id = ?8 AND status = 'blocked' AND updated_at = ?9`,
        ).bind(receiptId, env.TENANT_SLUG, reason, gateAskExpiresAt(entered), actor, via, c.assignee_agent_id, c.id, stamp),
      ])
      if (!batch[0]?.meta?.changes) {
        result.skipped_claimed += 1
        continue
      }
      result.expired += 1
      result[reason] += 1
      result.task_ids.push(c.id)
      if (await notifyExpired(env, c, reason, receiptId)) result.notified += 1
    } catch {
      result.errors += 1
    }
  }
  return result
}

/** Best-effort: tell the assignee through the existing inbox + the task's visible notice. */
async function notifyExpired(env: Env, c: Candidate, reason: ExpiryReason, receiptId: string): Promise<boolean> {
  const notice = reason === 'gate_owner_dead'
    ? `${APPROVAL_EXPIRED_NOTICE} (gate ${c.gate_owner} had no live holder)`
    : APPROVAL_EXPIRED_NOTICE
  try {
    await persistGateWakeNotice(env, c.id, notice)
  } catch {
    // the receipt is the record; the notice is a convenience
  }
  if (!c.assignee_agent_id) return false
  try {
    const delivery = await sendAgentMessage(
      env,
      {
        fromAgent: SWEEPER_SENDER,
        fromMember: SWEEPER_ACTOR,
        toAgent: c.assignee_agent_id,
        kind: 'message',
        body: JSON.stringify({ type: 'approval_expired', task_id: c.id, gate_owner: c.gate_owner, reason, notice }),
        requestId: `approval-expired:${c.id}:${receiptId}`,
      },
      { system: true, reason: 'target is the task assignee read from the row the sweeper just blocked, not caller input' },
    )
    return delivery.ok
  } catch {
    return false
  }
}

export interface CapResetResult {
  ok: boolean
  error?: 'not_found' | 'archived' | 'no_cap_to_reset' | 'lost_race'
  receipt_id?: string
}

/**
 * The human touch behind the resubmit cap: an org admin zeroes expired_count so the task may be
 * resubmitted again. Guarded (not archived, count > 0) and receipted in the same batch.
 */
export async function resetResubmitCap(env: Env, taskId: string, memberId: string): Promise<CapResetResult> {
  const task = await env.DB.prepare(`SELECT id, status, expired_count, gate_owner, squad_id FROM tasks WHERE id = ?1`)
    .bind(taskId).first<Pick<Task, 'id' | 'status' | 'gate_owner' | 'squad_id'> & { expired_count: number }>()
  if (!task) return { ok: false, error: 'not_found' }
  if (Number(task.expired_count) === 0) return { ok: false, error: 'no_cap_to_reset' }
  const receiptId = crypto.randomUUID()
  // Receipt first, conditioned on there being a cap to reset; the guarded UPDATE follows in the
  // same transaction. (An UPDATE-first order would let the receipt's own guard see the post-update
  // zero and record nothing.)
  const [, update] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO approval_expiry_receipts
         (id, tenant, task_id, squad_id, gate_owner, from_status, to_status, reason, review_entered_at,
          expires_at, expired_count_after, actor, via)
       SELECT ?1, ?2, id, squad_id, COALESCE(gate_owner, ''), status, status, 'resubmit_cap_reset', NULL, NULL, 0, ?3, 'human'
         FROM tasks WHERE id = ?4 AND expired_count > 0 AND ${TASK_NOT_ARCHIVED_SQL()}`,
    ).bind(receiptId, env.TENANT_SLUG, memberId, taskId),
    env.DB.prepare(
      `UPDATE tasks SET expired_count = 0 WHERE id = ?1 AND expired_count > 0 AND ${TASK_NOT_ARCHIVED_SQL()}`,
    ).bind(taskId),
  ])
  if (!update?.meta?.changes) {
    // Zero rows: archived (never reset an archived task) or a concurrent reset won (distinct code).
    return { ok: false, error: (await isTaskArchived(env, taskId)) ? 'archived' : 'lost_race' }
  }
  return { ok: true, receipt_id: receiptId }
}

/**
 * The cron heartbeat. DRY RUN unless APPROVAL_EXPIRY_ENFORCE is exactly '1': an unset or any other
 * value logs counts and writes nothing, so shipping this code never starts expiring asks by itself.
 */
export async function runApprovalExpiryTick(env: Env): Promise<ExpirySweepResult> {
  const counts = await sweepExpiredApprovals(env, { dryRun: env.APPROVAL_EXPIRY_ENFORCE !== '1', via: 'cron' })
  if (counts.scanned > 0 || counts.errors > 0) {
    // Counts only in the log; task ids live in approval_expiry_receipts.
    console.info('[approval-expiry]', {
      dry_run: counts.dry_run, scanned: counts.scanned, expired: counts.expired,
      approval_expired: counts.approval_expired, gate_owner_dead: counts.gate_owner_dead,
      notified: counts.notified, skipped_claimed: counts.skipped_claimed, errors: counts.errors,
      remaining: counts.remaining,
    })
  }
  return counts
}
