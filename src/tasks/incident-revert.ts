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
//  - archived tasks are refused (TASK_NOT_ARCHIVED_SQL in both statements), and a task with a live
//    execution claim is refused so a revert can never pull a task out from under a running executor.
//
// STALE WAKES: this does NOT fence them. See docs/operations/incident-revert-20261009.md.
// tasks.assignment_epoch is only compared by flight-spine (src/flight-spine/*); no wakeAgent,
// AgentDO, executor or claim path reads it, and an agent.wake carries no epoch. Bumping it here
// would fence nothing and would invalidate any flight assignment of the task. The operator must
// pause the executing agent first.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { ALL_TASK_STATUSES, isTaskStatus, type TaskStatus } from './service'

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

/** done is terminal and carries completed_at/result the revert would leave contradicting 'open'. */
export const REVERTABLE_STATUSES: readonly TaskStatus[] = ALL_TASK_STATUSES.filter((s) => s !== 'done')

export interface RevertRowInput {
  task_id: string
  expected_status: string
  expected_assignee_agent_id: string | null
  expected_updated_at: string
}

export interface RevertActual {
  status: string
  assignee_agent_id: string | null
  updated_at: string
}

export type RevertRowOutcome =
  | { task_id: string; outcome: 'reverted'; receipt_id: string; new_updated_at: string }
  | { task_id: string; outcome: 'drifted'; reason: 'mismatch' | 'live_execution_claim' | 'receipt_without_update'; actual: RevertActual; receipt_id?: string }
  | { task_id: string; outcome: 'not_found' }
  | { task_id: string; outcome: 'archived' }

// D1 caps a SQL function at 32 arguments, and tasks has 25 columns (50 json_object args). The snapshot is
// therefore nested: {"part1": {12 columns}, "part2": {...}, "part3": {...}}. Nesting (not json_patch, which
// would DELETE every NULL-valued key per RFC 7386) keeps NULL columns in the evidence.
const SNAPSHOT_PART_SIZE = 12
export const SNAPSHOT_PART_KEYS: readonly string[] = Array.from(
  { length: Math.ceil(TASK_ROW_COLUMNS.length / SNAPSHOT_PART_SIZE) },
  (_, i) => `part${i + 1}`,
)
const SNAPSHOT_JSON_SQL = `json_object(${SNAPSHOT_PART_KEYS.map((key, i) => {
  const cols = TASK_ROW_COLUMNS.slice(i * SNAPSHOT_PART_SIZE, (i + 1) * SNAPSHOT_PART_SIZE)
  return `'${key}', json_object(${cols.map((c) => `'${c}', t.${c}`).join(', ')})`
}).join(', ')})`

/** The ONE compare-and-set predicate, used verbatim by the receipt INSERT and the UPDATE so the
 *  evidence row and the mutation can never disagree about which state they matched. */
const casPredicateSql = (a: string, p: { status: string; assignee: string; updatedAt: string; now: string }): string =>
  `${a}.status = ${p.status}
           AND IFNULL(${a}.assignee_agent_id, '') = IFNULL(${p.assignee}, '')
           AND ${a}.updated_at = ${p.updatedAt}
           AND NOT (${a}.status = 'in_progress' AND ${a}.execution_claim_expires_at IS NOT NULL
                    AND ${a}.execution_claim_expires_at > ${p.now})`

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
          AND ${casPredicateSql('t', { status: '?7', assignee: '?8', updatedAt: '?9', now: '?12' })}
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
          AND ${casPredicateSql('tasks', { status: '?3', assignee: '?4', updatedAt: '?5', now: '?6' })}
          AND ${TASK_NOT_ARCHIVED_SQL()}
          AND EXISTS (SELECT 1 FROM task_incident_revert_receipts r
                       WHERE r.id = ?7 AND r.task_id = ?2 AND r.new_updated_at = ?1)`,
    ).bind(
      newUpdatedAt, row.task_id, row.expected_status, row.expected_assignee_agent_id,
      row.expected_updated_at, Date.now(), receiptId,
    ),
  ])

  const receiptWritten = (results[0]?.meta?.changes ?? 0) === 1
  const updated = (results[1]?.meta?.changes ?? 0) === 1
  if (receiptWritten && updated) {
    return { task_id: row.task_id, outcome: 'reverted', receipt_id: receiptId, new_updated_at: newUpdatedAt }
  }

  // 0 rows: classify from the live row. Never retried, never forced.
  const actual = await env.DB.prepare(
    `SELECT t.status AS status, t.assignee_agent_id AS assignee_agent_id, t.updated_at AS updated_at,
            t.execution_claim_expires_at AS claim,
            EXISTS (SELECT 1 FROM tasks_archive_state s WHERE s.task_id = t.id) AS archived
       FROM tasks t WHERE t.id = ?1`,
  ).bind(row.task_id).first<{
    status: string
    assignee_agent_id: string | null
    updated_at: string
    claim: number | null
    archived: number
  }>()
  if (!actual) return { task_id: row.task_id, outcome: 'not_found' }
  const snapshot: RevertActual = {
    status: actual.status,
    assignee_agent_id: actual.assignee_agent_id,
    updated_at: actual.updated_at,
  }
  if (receiptWritten) {
    // Unreachable inside one D1 transaction (both statements share one predicate); checked BEFORE the
    // archived/drift classification so an orphan receipt is reported loudly, never hidden behind it.
    return { task_id: row.task_id, outcome: 'drifted', reason: 'receipt_without_update', actual: snapshot, receipt_id: receiptId }
  }
  if (actual.archived) return { task_id: row.task_id, outcome: 'archived' }
  const matches = actual.status === row.expected_status
    && (actual.assignee_agent_id ?? '') === (row.expected_assignee_agent_id ?? '')
    && actual.updated_at === row.expected_updated_at
  return {
    task_id: row.task_id,
    outcome: 'drifted',
    reason: matches ? 'live_execution_claim' : 'mismatch',
    actual: snapshot,
  }
}

/** Rows run sequentially, one guarded batch each: a drifted row never blocks the others. */
export async function revertTasksForIncident(
  env: Env,
  ctx: RevertContext,
  rows: readonly RevertRowInput[],
): Promise<RevertRowOutcome[]> {
  const outcomes: RevertRowOutcome[] = []
  for (const row of rows) outcomes.push(await revertOne(env, ctx, row))
  return outcomes
}

export { isTaskStatus }
