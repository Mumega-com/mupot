// mupot#1780 incident recovery (option C): the audited exception to the task state machine.
//
// TRANSITIONS (src/tasks/service.ts) has no edge back to 'open', so no supported tool can undo an
// accidental mass assignment. revertTaskForIncident is the ONE audited path that returns a task to
// open + unassigned. It is deliberately narrow:
//
//  - per-row compare-and-set: status, assignee_agent_id (IFNULL-safe) and updated_at must ALL equal
//    the operator's reviewed snapshot, inside the write. A row that moved since is SKIPPED and
//    reported as `drifted` with its actual values. It is never forced.
//  - it writes ONLY status, assignee_agent_id and updated_at. `result`, `completed_at`,
//    `execution_receipt_id`, `execution_claim_expires_at` and every other column are left exactly as
//    they are: their pre-incident values are not recorded anywhere, and inventing them would be a
//    fabricated history. The FULL pre-revert row is preserved in the append-only receipt instead.
//  - the receipt (migration 0201) and the UPDATE ride one D1 batch under ONE shared predicate; the
//    UPDATE additionally requires the receipt row to exist (EXISTS on its id and new_updated_at), so
//    a task can never be reverted without its evidence.
//  - archived tasks are refused (TASK_NOT_ARCHIVED_SQL in both statements). Only blocked and in_progress
//    rows are revertable; a task with a human assignee, a live execution claim, an in_progress run that
//    still holds an execution_receipt_id (without an expired claim), or a dispatch that can still be
//    executed or redelivered (archiveBlockingDispatchExistsSql, the archive_row predicate) is refused.
//    A BLOCKED task keeps the execution_receipt_id of its finished run; that alone does not refuse it.
//
// STALE WAKES: this does NOT fence them. See docs/operations/incident-revert-20261009.md.
// tasks.assignment_epoch is only compared by flight-spine (src/flight-spine/*); no wakeAgent,
// AgentDO, executor or claim path reads it, and an agent.wake carries no epoch. Bumping it here
// would fence nothing and would invalidate any flight assignment of the task. The operator must
// pause the executing agent first.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { isTaskStatus, type TaskStatus } from './service'
import { archiveBlockingDispatchExistsSql, hasArchiveBlockingDispatch } from './runtime-receipts'

export const INCIDENT_REVERT_MAX_ROWS = 50

/** Every column of `tasks` (verified against the real migrated schema by a test, so a new column
 *  fails CI until the receipt snapshot learns it). The snapshot is taken in SQL, inside the batch,
 *  so it is the row exactly as the guarded UPDATE sees it. */
export const TASK_ROW_COLUMNS = [
  'id', 'squad_id', 'title', 'body', 'status', 'assignee_agent_id', 'github_issue_url', 'created_at',
  'updated_at', 'result', 'completed_at', 'gate_owner', 'cost_micro_usd', 'workflow_instance_id',
  'done_when', 'execution_receipt_id', 'execution_claim_expires_at', 'project_id', 'source_pot',
  'external_source', 'priority', 'parent_task_id', 'assignment_epoch', 'assignee_member_id',
  'gate_wake_notice',
] as const

/** The only states the incident produced and no supported tool can leave: blocked (executor refused) and
 *  in_progress (orphaned by an unassign). review/approved/rejected carry a gate's verdict, done is terminal,
 *  open is already the target: each is refused per row as `status_not_revertable`, before any write. */
export const REVERTABLE_STATUSES: readonly TaskStatus[] = ['blocked', 'in_progress']
export function isRevertableStatus(status: string): boolean {
  return (REVERTABLE_STATUSES as readonly string[]).includes(status)
}

export interface RevertRowInput {
  task_id: string
  expected_status: string
  expected_assignee_agent_id: string | null
  expected_updated_at: string
}

export interface RevertActual {
  status: string
  assignee_agent_id: string | null
  assignee_member_id: string | null
  updated_at: string
}

export type DriftReason =
  | 'mismatch'
  | 'live_execution_claim'
  | 'runtime_held'
  | 'in_flight_dispatch'
  | 'write_conflict'
  | 'receipt_without_update'

export type RevertRowOutcome =
  | { task_id: string; outcome: 'reverted'; receipt_id: string; new_updated_at: string }
  | { task_id: string; outcome: 'drifted'; reason: DriftReason; actual: RevertActual; receipt_id?: string }
  | { task_id: string; outcome: 'status_not_revertable'; status: string }
  | { task_id: string; outcome: 'not_found' }
  | { task_id: string; outcome: 'archived' }
  | { task_id: string; outcome: 'error'; code: 'row_failed' }

// D1 caps a SQL function at 32 arguments, and tasks has 25 columns (50 json_object args). The snapshot is
// therefore nested: {"part1": {12 columns}, "part2": {...}, "part3": {...}}. Nesting (not json_patch, which
// would DELETE every NULL-valued key per RFC 7386) keeps NULL columns in the evidence.
export const SNAPSHOT_PART_SIZE = 12
export const SNAPSHOT_PART_KEYS: readonly string[] = Array.from(
  { length: Math.ceil(TASK_ROW_COLUMNS.length / SNAPSHOT_PART_SIZE) },
  (_, i) => `part${i + 1}`,
)
export const SNAPSHOT_JSON_SQL = `json_object(${SNAPSHOT_PART_KEYS.map((key, i) => {
  const cols = TASK_ROW_COLUMNS.slice(i * SNAPSHOT_PART_SIZE, (i + 1) * SNAPSHOT_PART_SIZE)
  return `'${key}', json_object(${cols.map((c) => `'${c}', t.${c}`).join(', ')})`
}).join(', ')})`

/** The ONE compare-and-set predicate, used verbatim by the receipt INSERT and the UPDATE so the
 *  evidence row and the mutation can never disagree about which state they matched.
 *  Beyond the operator's snapshot (status, agent assignee, updated_at) it requires that the task is
 *  genuinely free: no human assignee (so "open and unassigned" is true), no live execution claim, no
 *  runtime-held in_progress run (an execution_receipt_id with no EXPIRED claim: a live or unaccounted
 *  runtime), and no dispatch that can still be executed or redelivered (the archive_row predicate). */
const casPredicateSql = (
  a: string,
  p: { status: string; assignee: string; updatedAt: string; now: string; tenant: string },
): string =>
  `${a}.status = ${p.status}
           AND IFNULL(${a}.assignee_agent_id, '') = IFNULL(${p.assignee}, '')
           AND ${a}.assignee_member_id IS NULL
           AND ${a}.updated_at = ${p.updatedAt}
           AND NOT (${a}.status = 'in_progress' AND ${a}.execution_claim_expires_at IS NOT NULL
                    AND ${a}.execution_claim_expires_at > ${p.now})
           AND NOT (${a}.status = 'in_progress' AND ${a}.execution_receipt_id IS NOT NULL
                    AND NOT (${a}.execution_claim_expires_at IS NOT NULL
                             AND ${a}.execution_claim_expires_at <= ${p.now}))
           AND NOT ${archiveBlockingDispatchExistsSql({ tenantParam: p.tenant, taskIdExpr: `${a}.id` })}`

export interface RevertContext {
  incidentRef: string
  reason: string
  actorMemberId: string
}

async function revertOne(env: Env, ctx: RevertContext, row: RevertRowInput): Promise<RevertRowOutcome> {
  const receiptId = crypto.randomUUID()
  const now = new Date()
  const createdAt = now.toISOString()
  // updated_at must move even when two reverts land in the same millisecond as the old value.
  const newUpdatedAt = createdAt === row.expected_updated_at ? new Date(now.getTime() + 1).toISOString() : createdAt

  const results = await env.DB.batch([
    // (1) evidence first: the FULL pre-revert row, lands only when the CAS predicate holds right now.
    env.DB.prepare(
      `INSERT INTO task_incident_revert_receipts
         (id, tenant, incident_ref, reason, task_id, actor_member_id, expected_status,
          expected_assignee_agent_id, expected_updated_at, pre_row_json, new_updated_at, created_at)
       SELECT ?1, ?2, ?3, ?4, t.id, ?5, ?7, ?8, ?9, ${SNAPSHOT_JSON_SQL}, ?10, ?11
         FROM tasks t
        WHERE t.id = ?6
          AND ${casPredicateSql('t', { status: '?7', assignee: '?8', updatedAt: '?9', now: '?12', tenant: '?2' })}
          AND ${TASK_NOT_ARCHIVED_SQL('t')}`,
    ).bind(
      receiptId, env.TENANT_SLUG, ctx.incidentRef, ctx.reason, ctx.actorMemberId, row.task_id,
      row.expected_status, row.expected_assignee_agent_id, row.expected_updated_at,
      newUpdatedAt, createdAt, Date.now(),
    ),
    // (2) the mutation: same predicate, and it additionally requires the receipt to exist.
    env.DB.prepare(
      `UPDATE tasks
          SET status = 'open', assignee_agent_id = NULL, updated_at = ?1
        WHERE id = ?2
          AND ${casPredicateSql('tasks', { status: '?3', assignee: '?4', updatedAt: '?5', now: '?6', tenant: '?8' })}
          AND ${TASK_NOT_ARCHIVED_SQL()}
          AND EXISTS (SELECT 1 FROM task_incident_revert_receipts r
                       WHERE r.id = ?7 AND r.task_id = ?2 AND r.new_updated_at = ?1)`,
    ).bind(
      newUpdatedAt, row.task_id, row.expected_status, row.expected_assignee_agent_id,
      row.expected_updated_at, Date.now(), receiptId, env.TENANT_SLUG,
    ),
  ])

  const receiptWritten = (results[0]?.meta?.changes ?? 0) === 1
  const updated = (results[1]?.meta?.changes ?? 0) === 1
  if (receiptWritten && updated) {
    return { task_id: row.task_id, outcome: 'reverted', receipt_id: receiptId, new_updated_at: newUpdatedAt }
  }

  // 0 rows: classify from the live row. Never retried, never forced.
  const actual = await env.DB.prepare(
    `SELECT t.status AS status, t.assignee_agent_id AS assignee_agent_id, t.assignee_member_id AS assignee_member_id,
            t.updated_at AS updated_at, t.execution_claim_expires_at AS claim, t.execution_receipt_id AS exec_receipt,
            EXISTS (SELECT 1 FROM tasks_archive_state s WHERE s.task_id = t.id) AS archived
       FROM tasks t WHERE t.id = ?1`,
  ).bind(row.task_id).first<{
    status: string
    assignee_agent_id: string | null
    assignee_member_id: string | null
    updated_at: string
    claim: number | null
    exec_receipt: string | null
    archived: number
  }>()
  if (!actual) return { task_id: row.task_id, outcome: 'not_found' }
  const snapshot: RevertActual = {
    status: actual.status,
    assignee_agent_id: actual.assignee_agent_id,
    assignee_member_id: actual.assignee_member_id,
    updated_at: actual.updated_at,
  }
  if (receiptWritten) {
    // Unreachable inside one D1 transaction (both statements share one predicate); checked BEFORE the
    // archived/drift classification so an orphan receipt is reported loudly, never hidden behind it.
    return { task_id: row.task_id, outcome: 'drifted', reason: 'receipt_without_update', actual: snapshot, receipt_id: receiptId }
  }
  if (actual.archived) return { task_id: row.task_id, outcome: 'archived' }
  const drift = (reason: DriftReason): RevertRowOutcome => ({ task_id: row.task_id, outcome: 'drifted', reason, actual: snapshot })
  const matches = actual.status === row.expected_status
    && (actual.assignee_agent_id ?? '') === (row.expected_assignee_agent_id ?? '')
    && actual.assignee_member_id === null
    && actual.updated_at === row.expected_updated_at
  if (!matches) return drift('mismatch')
  const nowMs = Date.now()
  const inProgress = actual.status === 'in_progress'
  if (inProgress && actual.claim !== null && actual.claim > nowMs) return drift('live_execution_claim')
  if (inProgress && actual.exec_receipt !== null && !(actual.claim !== null && actual.claim <= nowMs)) return drift('runtime_held')
  if (await hasArchiveBlockingDispatch(env, row.task_id)) return drift('in_flight_dispatch')
  return drift('write_conflict')
}

/** Rows run sequentially, one guarded batch each: a drifted row never blocks the others. */
export async function revertTasksForIncident(
  env: Env,
  ctx: RevertContext,
  rows: readonly RevertRowInput[],
): Promise<RevertRowOutcome[]> {
  const outcomes: RevertRowOutcome[] = []
  for (const row of rows) {
    // Narrowing before any SQL: only blocked and in_progress can be reverted.
    if (!isRevertableStatus(row.expected_status)) {
      outcomes.push({ task_id: row.task_id, outcome: 'status_not_revertable', status: row.expected_status })
      continue
    }
    // Per-row isolation: a thrown row (D1 error, constraint) is reported and the loop continues, so the
    // response always carries every row's outcome. The D1 batch rolled back, so a thrown row left no receipt
    // and no mutation. The error message is not echoed (it may carry SQL or identifiers).
    try {
      outcomes.push(await revertOne(env, ctx, row))
    } catch {
      outcomes.push({ task_id: row.task_id, outcome: 'error', code: 'row_failed' })
    }
  }
  return outcomes
}

export { isTaskStatus }
