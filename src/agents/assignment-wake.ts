// src/agents/assignment-wake.ts — wake-on-assign: every assignment of a task to an AGENT rings that agent's inbox.
//
// Hadi 2026-10-22: mupot assigned work but never told the assignee. A plain inbox message does wake a seated agent
// (seatlink, the orca-mupot plugin, the webhook doorbell), so an assignment now enqueues ONE short doorbell message
// through the existing sendAgentMessage path. Doorbell semantics: an identifier plus a pointer. The authority stays
// in the task; the body carries no secret and no instruction beyond "read task_get <id> and start".
//
//   - once per (task, agent, epoch): task_assignment_wakes (migration 0251) is the idempotency key. A replay of the
//     same assignment sends nothing; a reassign A->B->A is a new epoch (the assigning write's updated_at stamp).
//   - agents only: callers pass an agents.id; a member / human assignee never reaches this module.
//   - throttled: an agent that is not active, is archived or is execution-paused gets no doorbell (a 'skipped' row
//     records why). At most ASSIGNMENT_WAKE_CAP doorbells per agent per ASSIGNMENT_WAKE_WINDOW_MS; the extras are held
//     ('coalesced') and announced by ONE summary message "you have K new assignments" as soon as the window has room.
//     The cap is read-then-write, not atomic: concurrent assignments racing the same window can overshoot it by the
//     concurrency, never unboundedly (every later ring sees the real count).
//   - fail-open: nothing here throws. A doorbell that cannot be written never fails or rolls back the assignment; it is
//     logged (console.error, structured) and left visible as a 'failed' ledger row. A replay retries it.

import type { Env } from '../types'
import { sha256Hex } from '../lib/canonical-json'
import { isExecutionPaused } from './execution-brake-sql'
import { sendAgentMessage } from './messages'
import { ASSIGNMENT_WAKE_SENDER } from './system-senders'
import { scheduleTaskAssignedDoorbell, type DoorbellWaitUntil } from './webhook-doorbell'

export { ASSIGNMENT_WAKE_SENDER }
/** from_member stamped on the doorbell: the server is the sender, not any member. */
export const ASSIGNMENT_WAKE_ACTOR = 'system:assignment-wake'
/** At most this many doorbell messages per agent per window; the rest are coalesced into one summary. */
export const ASSIGNMENT_WAKE_CAP = 5
export const ASSIGNMENT_WAKE_WINDOW_MS = 10 * 60_000
/** A 'pending' claim older than this is a crashed attempt and may be re-claimed. */
export const ASSIGNMENT_WAKE_PENDING_STALE_MS = 2 * 60_000
const SUMMARY_LIST_MAX = 10
const TITLE_MAX = 100
const FLUSH_ROWS_MAX = 100
const FLUSH_AGENTS_MAX = 50

/** Task statuses in which a (new) assignee still has work to start. */
const WAKEABLE_TASK_STATUSES: readonly string[] = ['open', 'in_progress', 'blocked', 'rejected']

export type AssignmentWakeOutcome = 'sent' | 'duplicate' | 'coalesced' | 'skipped' | 'failed'

export interface AssignmentWakeResult {
  outcome: AssignmentWakeOutcome
  reason?: string
  seq?: number
}

export interface AssignmentWakeInput {
  taskId: string
  /** agents.id of the assignee. */
  agentId: string
  /** The assignment occurrence: the assigning write's updated_at stamp (any stable per-assignment string). */
  epoch: string
  /** The agent that performed the assignment, if any: assigning work to yourself is not a wake. */
  actorAgentId?: string | null
}

export interface AssignmentWakeOpts {
  /** ctx.waitUntil of the hosting request: the webhook-doorbell POST of the inbox send outlives the response. */
  waitUntil?: DoorbellWaitUntil
  /** Injected clock, deterministic tests. */
  now?: () => Date
  /** Burst cap override (tests). */
  cap?: number
}

/** True when a task in `status` has work for a freshly assigned agent. */
export function isWakeableTaskStatus(status: string): boolean {
  return WAKEABLE_TASK_STATUSES.includes(status)
}

/** The webhook-doorbell ref of this assignment: matches scheduleTaskAssignedDoorbell's `<task>#<assignment>`, so a
 *  webhook-registered agent is rung once for the pair (task.assigned + inbox.wake). */
function assignmentCorrelation(taskId: string, epoch: string): string {
  return `${taskId}#${epoch}`
}

async function keyHash(parts: readonly string[]): Promise<string> {
  return (await sha256Hex(parts.join('\u0000'))).slice(0, 40)
}

function cleanTitle(raw: string): string {
  // Untrusted task text inside an agent's inbox: one line, bounded, no quotes or control characters.
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim()
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine
}

function logWakeProblem(event: string, detail: Record<string, unknown>): void {
  // console.error inside the failure path only: the doorbell is best-effort, so this is its visibility.
  console.error(JSON.stringify({ event, ...detail }))
}

/** Why this agent must not be woken right now, or null. Order: unknown / inactive / archived, then execution pause. */
async function wakeBlockedReason(env: Env, agentId: string): Promise<string | null> {
  const agent = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1 LIMIT 1')
    .bind(agentId)
    .first<{ status: string; archived_at: string | null }>()
  if (!agent) return 'agent_not_found'
  if (agent.archived_at) return 'agent_archived'
  if (agent.status !== 'active') return `agent_${agent.status}`
  if (await isExecutionPaused(env, agentId)) return 'execution_paused'
  return null
}

async function doorbellsInWindow(env: Env, tenant: string, agentId: string, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_messages
      WHERE tenant = ?1 AND to_agent = ?2 AND from_agent = ?3 AND created_at > ?4`,
  )
    .bind(tenant, agentId, ASSIGNMENT_WAKE_SENDER, sinceIso)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function setOutcome(
  env: Env,
  rowId: string,
  outcome: string,
  nowIso: string,
  extra: { reason?: string; seq?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE task_assignment_wakes
        SET outcome = ?2, reason = ?3, message_seq = ?4, updated_at = ?5
      WHERE id = ?1`,
  )
    .bind(rowId, outcome, extra.reason ?? null, extra.seq ?? null, nowIso)
    .run()
}

/**
 * Ring the assignee. Never throws. Call AFTER the assignment has committed.
 *
 * Returns what happened: 'sent' (one doorbell written), 'duplicate' (this epoch was already handled),
 * 'coalesced' (over the burst cap, announced later by the summary), 'skipped' (agent paused / inactive / archived,
 * self-assignment, task gone) or 'failed' (the doorbell could not be written; the assignment is unaffected).
 */
export async function ringAssignmentWake(
  env: Env,
  input: AssignmentWakeInput,
  opts: AssignmentWakeOpts = {},
): Promise<AssignmentWakeResult> {
  try {
    return await ring(env, input, opts)
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown_error'
    logWakeProblem('assignment_wake_failed', { task_id: input.taskId, agent_id: input.agentId, reason })
    return { outcome: 'failed', reason }
  }
}

async function ring(env: Env, input: AssignmentWakeInput, opts: AssignmentWakeOpts): Promise<AssignmentWakeResult> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { outcome: 'failed', reason: 'no_tenant' }
  if (!input.agentId || !input.taskId || !input.epoch) return { outcome: 'skipped', reason: 'incomplete_assignment' }
  if (input.actorAgentId && input.actorAgentId === input.agentId) return { outcome: 'skipped', reason: 'self_assignment' }

  const now = opts.now ?? (() => new Date())
  const nowIso = now().toISOString()
  const rowId = crypto.randomUUID()

  // Claim the (task, agent, epoch) key. A terminal row (sent / coalesced / summarized) is a no-op replay; a
  // skipped / failed / stale-pending row is re-evaluated, so a retry after a transient failure is not blocked.
  const staleBefore = new Date(now().getTime() - ASSIGNMENT_WAKE_PENDING_STALE_MS).toISOString()
  const claim = await env.DB.prepare(
    `INSERT INTO task_assignment_wakes (id, tenant, task_id, agent_id, epoch, outcome, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)
     ON CONFLICT (tenant, task_id, agent_id, epoch) DO UPDATE
        SET outcome = 'pending', reason = NULL, updated_at = excluded.updated_at
      WHERE task_assignment_wakes.outcome IN ('skipped', 'failed')
         OR (task_assignment_wakes.outcome = 'pending' AND task_assignment_wakes.updated_at < ?7)
     RETURNING id`,
  )
    .bind(rowId, tenant, input.taskId, input.agentId, input.epoch, nowIso, staleBefore)
    .first<{ id: string }>()
  if (!claim) return { outcome: 'duplicate' }
  const claimedId = claim.id

  try {
    const blocked = await wakeBlockedReason(env, input.agentId)
    if (blocked) {
      await setOutcome(env, claimedId, 'skipped', nowIso, { reason: blocked })
      return { outcome: 'skipped', reason: blocked }
    }

    const task = await env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.assignee_agent_id, p.name AS project_name
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = ?1 LIMIT 1`,
    )
      .bind(input.taskId)
      .first<{ id: string; title: string; status: string; assignee_agent_id: string | null; project_name: string | null }>()
    if (!task) {
      await setOutcome(env, claimedId, 'skipped', nowIso, { reason: 'task_not_found' })
      return { outcome: 'skipped', reason: 'task_not_found' }
    }

    // Capacity first for the backlog: held extras go out as one summary before this assignment competes for the window.
    const cap = opts.cap ?? ASSIGNMENT_WAKE_CAP
    await flushCoalescedForAgent(env, tenant, input.agentId, { ...opts, cap })

    const sinceIso = new Date(now().getTime() - ASSIGNMENT_WAKE_WINDOW_MS).toISOString()
    if ((await doorbellsInWindow(env, tenant, input.agentId, sinceIso)) >= cap) {
      await setOutcome(env, claimedId, 'coalesced', nowIso, { reason: 'burst_cap' })
      return { outcome: 'coalesced', reason: 'burst_cap' }
    }

    // Webhook doorbell (flag-gated, fail-open, a no-op for an agent without one): the same `mupot.task.assigned` ring the
    // MCP / REST / router sites send themselves. Same `<task>#<epoch>` ref, so a site that also rings it coalesces to ONE
    // POST, and the inbox.wake of the letter below (same correlation) joins it. Rung first so the richer event wins.
    await scheduleTaskAssignedDoorbell(env, input.agentId, input.taskId, { waitUntil: opts.waitUntil, assignment: input.epoch })

    const body = [
      `Assigned to you: task ${task.id} "${cleanTitle(task.title)}"`,
      task.project_name ? ` (project: ${cleanTitle(task.project_name)})` : '',
      `. Read task_get ${task.id} and start; reply via task notes.`,
    ].join('')
    const sent = await sendAgentMessage(
      env,
      {
        fromAgent: ASSIGNMENT_WAKE_SENDER,
        fromMember: ASSIGNMENT_WAKE_ACTOR,
        toAgent: input.agentId,
        kind: 'message',
        body,
        requestId: `assign:${await keyHash([tenant, input.taskId, input.agentId, input.epoch])}`,
      },
      { system: true, reason: 'target is the agent the assignment just committed to, resolved server-side, not caller input' },
      { waitUntil: opts.waitUntil, now: () => nowIso, doorbellCorrelation: assignmentCorrelation(input.taskId, input.epoch) },
    )
    if (!sent.ok) {
      await setOutcome(env, claimedId, 'failed', nowIso, { reason: sent.reason })
      logWakeProblem('assignment_wake_failed', { task_id: input.taskId, agent_id: input.agentId, reason: sent.reason })
      return { outcome: 'failed', reason: sent.reason }
    }
    await setOutcome(env, claimedId, 'sent', nowIso, { seq: sent.seq })
    return { outcome: 'sent', seq: sent.seq }
  } catch (error) {
    // Leave the claim re-claimable and visible rather than 'pending' forever.
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown_error'
    logWakeProblem('assignment_wake_failed', { task_id: input.taskId, agent_id: input.agentId, reason })
    try {
      await setOutcome(env, claimedId, 'failed', nowIso, { reason })
    } catch {
      // the stale-pending re-claim covers a ledger that cannot be written right now
    }
    return { outcome: 'failed', reason }
  }
}

interface CoalescedRow {
  id: string
  task_id: string
  epoch: string
}

/**
 * Announce the assignments held by the burst cap in ONE message ("you have K new assignments"), once the agent's
 * window has room again. Rows whose task has since moved on (reassigned, finished) are dropped from the count, not
 * announced. Never throws. Returns how many assignments the summary carried (0 = nothing sent).
 */
export async function flushCoalescedForAgent(
  env: Env,
  tenant: string,
  agentId: string,
  opts: AssignmentWakeOpts = {},
): Promise<number> {
  try {
    const held = await env.DB.prepare(
      `SELECT id, task_id, epoch FROM task_assignment_wakes
        WHERE tenant = ?1 AND agent_id = ?2 AND outcome = 'coalesced'
        ORDER BY created_at ASC, id ASC LIMIT ?3`,
    )
      .bind(tenant, agentId, FLUSH_ROWS_MAX)
      .all<CoalescedRow>()
    const rows = held.results ?? []
    if (rows.length === 0) return 0

    const now = opts.now ?? (() => new Date())
    const nowIso = now().toISOString()

    const blocked = await wakeBlockedReason(env, agentId)
    if (blocked) {
      await env.DB.prepare(
        `UPDATE task_assignment_wakes SET outcome = 'skipped', reason = ?3, updated_at = ?4
          WHERE tenant = ?1 AND agent_id = ?2 AND outcome = 'coalesced'`,
      ).bind(tenant, agentId, blocked, nowIso).run()
      return 0
    }

    const cap = opts.cap ?? ASSIGNMENT_WAKE_CAP
    const sinceIso = new Date(now().getTime() - ASSIGNMENT_WAKE_WINDOW_MS).toISOString()
    if ((await doorbellsInWindow(env, tenant, agentId, sinceIso)) >= cap) return 0

    // Still the assignee's open work? A task reassigned or finished while it was held is not announced.
    const live: CoalescedRow[] = []
    for (const row of rows) {
      const task = await env.DB.prepare('SELECT status, assignee_agent_id FROM tasks WHERE id = ?1 LIMIT 1')
        .bind(row.task_id)
        .first<{ status: string; assignee_agent_id: string | null }>()
      if (task && task.assignee_agent_id === agentId && isWakeableTaskStatus(task.status)) {
        live.push(row)
      } else {
        await setOutcome(env, row.id, 'skipped', nowIso, { reason: 'stale_at_flush' })
      }
    }
    if (live.length === 0) return 0

    const ids = live.map((r) => r.task_id)
    const shown = ids.slice(0, SUMMARY_LIST_MAX).join(', ')
    const more = ids.length > SUMMARY_LIST_MAX ? ` and ${ids.length - SUMMARY_LIST_MAX} more` : ''
    const noun = live.length === 1 ? 'assignment' : 'assignments'
    const body = `You have ${live.length} new ${noun}: ${shown}${more}. Read task_list (assigned to you) and task_get <id>, then start; reply via task notes.`
    const requestId = `assign-batch:${await keyHash([tenant, agentId, ...live.map((r) => `${r.task_id}@${r.epoch}`)])}`
    const sent = await sendAgentMessage(
      env,
      {
        fromAgent: ASSIGNMENT_WAKE_SENDER,
        fromMember: ASSIGNMENT_WAKE_ACTOR,
        toAgent: agentId,
        kind: 'message',
        body,
        requestId,
      },
      { system: true, reason: 'summary of assignments already committed to this agent, resolved server-side' },
      { waitUntil: opts.waitUntil, now: () => nowIso },
    )
    if (!sent.ok) {
      logWakeProblem('assignment_wake_summary_failed', { agent_id: agentId, count: live.length, reason: sent.reason })
      return 0
    }
    for (const row of live) {
      await env.DB.prepare(
        `UPDATE task_assignment_wakes
            SET outcome = 'summarized', summary_request_id = ?2, message_seq = ?3, updated_at = ?4
          WHERE id = ?1 AND outcome = 'coalesced'`,
      ).bind(row.id, requestId, sent.seq, nowIso).run()
    }
    return live.length
  } catch (error) {
    logWakeProblem('assignment_wake_summary_failed', {
      agent_id: agentId,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown_error',
    })
    return 0
  }
}

/** Cron entry: announce every agent's held assignments whose window has room. Never throws. */
export async function flushCoalescedAssignmentWakes(
  env: Env,
  opts: AssignmentWakeOpts = {},
): Promise<{ agents: number; announced: number }> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { agents: 0, announced: 0 }
  try {
    const held = await env.DB.prepare(
      `SELECT DISTINCT agent_id FROM task_assignment_wakes
        WHERE tenant = ?1 AND outcome = 'coalesced' LIMIT ?2`,
    )
      .bind(tenant, FLUSH_AGENTS_MAX)
      .all<{ agent_id: string }>()
    let announced = 0
    const agents = held.results ?? []
    for (const { agent_id } of agents) announced += await flushCoalescedForAgent(env, tenant, agent_id, opts)
    return { agents: agents.length, announced }
  } catch (error) {
    logWakeProblem('assignment_wake_flush_failed', {
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown_error',
    })
    return { agents: 0, announced: 0 }
  }
}
