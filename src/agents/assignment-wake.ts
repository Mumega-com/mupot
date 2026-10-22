// src/agents/assignment-wake.ts — wake-on-assign: every assignment of a task to an AGENT rings that agent's inbox.
//
// Hadi 2026-10-22: mupot assigned work but never told the assignee. A plain inbox message does wake a seated agent
// (seatlink, the orca-mupot plugin, the webhook doorbell), so an assignment now enqueues ONE short doorbell through the
// existing sendAgentMessage path. Doorbell semantics: an identifier plus a pointer. The authority stays in the task; the
// body carries no secret and no instruction beyond "read task_get <id> and start".
//
// TWO HALVES, so the assigning request stays cheap (a 20-task router tick must not pay ~10 D1 statements per task):
//
//   INLINE   enqueueAssignmentWake — ONE conditional INSERT into task_assignment_wakes (migration 0251) that claims the
//            (task, agent, epoch) idempotency key AND the per-agent burst cap in a single statement, then a bus
//            `assignment.wake` job (a queue send, zero D1). It never throws and never touches the assignment itself.
//   OFF-PATH processAssignmentWakes — the queue consumer (and the cron sweep, the backstop) does everything else: re-checks
//            the assignment is still live, decides whether anyone can read the inbox, folds into an unread doorbell or
//            sends one, and fences every outcome write with its claim token.
//
// Guarantees:
//   - once per (task, agent, epoch); A -> B -> A is a new epoch for A. The cap is a conditional INSERT, so concurrent
//     assignments cannot overshoot it.
//   - agents only; self-assignment is not a wake.
//   - at most ONE unread doorbell per agent: while one is unread (and fresh) later assignments fold into it, they do not add
//     another inbox row, so an agent that never reads its inbox cannot be used to fill the 1000-unread cap and starve real
//     dispatch / gate / peer messages. An unread doorbell older than FOLD_MAX_AGE_MS is consumed and replaced.
//   - agents with no inbox reader (no live bound token, no live fleet runtime — in-Worker agents, webhook-only agents,
//     dead seats) get no inbox row; the webhook doorbell, if they have one, is rung regardless.
//   - an agent that is inactive / archived / gone is skipped; a PAUSED agent (status or execution pause) keeps its
//     assignments held and gets ONE summary when it resumes.
//   - at most ASSIGNMENT_WAKE_CAP assignments per agent per window ride individually; the extras are held and announced in
//     ONE "you have K new assignments" message.
//   - re-checked at send time: the task must still be this agent's, in a wakeable status, not archived, and not already
//     carried by a dispatch letter.
//   - fail-open: nothing here throws. A doorbell that cannot be written never fails or rolls back the assignment; it is
//     logged and left as a visible `failed` ledger row that the sweep retries (bounded attempts).

import type { BusEvent, Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { sha256Hex } from '../lib/canonical-json'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { getFleetAgentLiveness } from '../fleet/registry'
import { isExecutionPaused } from './execution-brake-sql'
import { sendAgentMessage } from './messages'
import { ASSIGNMENT_WAKE_SENDER } from './system-senders'
import { scheduleTaskAssignedDoorbell } from './webhook-doorbell'

export { ASSIGNMENT_WAKE_SENDER }
/** from_member stamped on the doorbell: the server is the sender, not any member. */
export const ASSIGNMENT_WAKE_ACTOR = 'system:assignment-wake'
/** At most this many assignments per agent per window ride individually; the rest are held and summarised. */
export const ASSIGNMENT_WAKE_CAP = 5
export const ASSIGNMENT_WAKE_WINDOW_MS = 10 * 60_000
/** A 'pending' claim older than this is a crashed worker and may be re-claimed. */
export const ASSIGNMENT_WAKE_PENDING_STALE_MS = 2 * 60_000
/** Failed sends / crashed claims tolerated per row before the sweep gives up (the row stays visible as failed). */
export const ASSIGNMENT_WAKE_MAX_ATTEMPTS = 3
/** An unread doorbell younger than this absorbs new assignments; an older one is consumed and replaced. */
export const ASSIGNMENT_WAKE_FOLD_MAX_AGE_MS = 30 * 60_000
/** Terminal ledger rows older than this are pruned by the sweep. */
export const ASSIGNMENT_WAKE_RETENTION_MS = 7 * 24 * 60 * 60_000
export const ASSIGNMENT_WAKE_EVENT = 'assignment.wake'

const SUMMARY_LIST_MAX = 10
const TITLE_MAX = 100
const NAME_MAX = 60
const CLAIM_BATCH_MAX = 100
const SWEEP_AGENTS_MAX = 5
const PRUNE_BATCH_MAX = 200

/** Task statuses in which a (new) assignee still has work to start. */
const WAKEABLE_TASK_STATUSES: readonly string[] = ['open', 'in_progress', 'blocked', 'rejected']

export type EnqueueOutcome = 'queued' | 'coalesced' | 'duplicate' | 'skipped' | 'failed'

export interface EnqueueResult {
  outcome: EnqueueOutcome
  reason?: string
}

export interface AssignmentWakeInput {
  taskId: string
  /** agents.id of the assignee. */
  agentId: string
  /** The assignment occurrence: the assigning write's updated_at stamp (any stable per-assignment string). */
  epoch: string
  /** The agent that performed the assignment, if any: assigning work to yourself is not a wake. */
  actorAgentId?: string | null
  /** Who assigned it, when known: 'member:<id>' | 'agent:<id>' | 'system:<name>'. Shown in the doorbell. */
  assignedBy?: string | null
}

export interface AssignmentWakeOpts {
  /** Injected clock, deterministic tests. */
  now?: () => Date
  /** Burst cap override (tests). */
  cap?: number
}

/** Passed by assigning code paths (createTask options / persistTaskUpdate): who is assigning. */
export interface AssignmentWakeContext {
  actorAgentId?: string | null
  assignedBy?: string | null
}

/** The assigner label shown in the doorbell: the bound agent when an agent-bound credential acts, else the member. */
export function assignerLabel(auth: { memberId?: string | null; boundAgentId?: string | null }): string | null {
  if (auth.boundAgentId) return `agent:${auth.boundAgentId}`
  return auth.memberId ? `member:${auth.memberId}` : null
}

/** True when a task in `status` has work for a freshly assigned agent. */
export function isWakeableTaskStatus(status: string): boolean {
  return WAKEABLE_TASK_STATUSES.includes(status)
}

function logWakeProblem(event: string, detail: Record<string, unknown>): void {
  // console.error inside the failure path only: the doorbell is best-effort, so this is its visibility.
  console.error(JSON.stringify({ event, ...detail }))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown_error'
}

async function keyHash(parts: readonly string[]): Promise<string> {
  return (await sha256Hex(parts.join('\u0000'))).slice(0, 40)
}

/**
 * Untrusted member-written text inside an agent's inbox: one line, bounded, with every control / format / separator code
 * point (C0, C1 incl. NEL, bidi overrides, zero-width, U+2028/9) and every quote or backtick removed, so it cannot break
 * out of the quoted, labelled slot it is rendered in.
 */
export function cleanUntrustedText(raw: string, max: number): string {
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/["'`\u2018\u2019\u201a\u201b\u2032\u00ab\u00bb\u201c\u201d\u201e\u201f\u2033\u2039\u203a]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const points = Array.from(flat)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat
}

// ── INLINE half ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record an assignment for the off-path worker. Call AFTER the assignment has committed. Never throws.
 *
 * ONE statement: INSERT ... SELECT ... ON CONFLICT DO NOTHING RETURNING outcome. The conflict target is the idempotency
 * key (a replay inserts nothing), and the row's outcome is decided IN the statement from the agent's current window count
 * ('queued' under the cap, 'coalesced' at or over it), so concurrent assignments serialise on the write lock and cannot
 * overshoot the cap. A queued row also sends the `assignment.wake` bus job (no D1); a coalesced row sends it delayed to
 * when its window ends.
 */
export async function enqueueAssignmentWake(
  env: Env,
  input: AssignmentWakeInput,
  opts: AssignmentWakeOpts = {},
): Promise<EnqueueResult> {
  try {
    const tenant = env.TENANT_SLUG
    if (!tenant) return { outcome: 'failed', reason: 'no_tenant' }
    if (!input.agentId || !input.taskId || !input.epoch) return { outcome: 'skipped', reason: 'incomplete_assignment' }
    if (input.actorAgentId && input.actorAgentId === input.agentId) return { outcome: 'skipped', reason: 'self_assignment' }

    const now = opts.now ?? (() => new Date())
    const nowIso = now().toISOString()
    const sinceIso = new Date(now().getTime() - ASSIGNMENT_WAKE_WINDOW_MS).toISOString()
    const cap = opts.cap ?? ASSIGNMENT_WAKE_CAP
    const row = await env.DB.prepare(
      `INSERT INTO task_assignment_wakes
         (id, tenant, task_id, agent_id, epoch, outcome, reason, assigned_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5,
              CASE WHEN c.n < ?8 THEN 'queued' ELSE 'coalesced' END,
              CASE WHEN c.n < ?8 THEN NULL ELSE 'burst_cap' END,
              ?9, ?6, ?6
         FROM (SELECT COUNT(*) AS n FROM task_assignment_wakes w
                WHERE w.tenant = ?2 AND w.agent_id = ?4
                  AND w.outcome IN ('queued', 'pending', 'sent') AND w.created_at > ?7) c
        WHERE 1
       ON CONFLICT (tenant, task_id, agent_id, epoch) DO NOTHING
       RETURNING outcome`,
    )
      .bind(crypto.randomUUID(), tenant, input.taskId, input.agentId, input.epoch, nowIso, sinceIso, cap, input.assignedBy ?? null)
      .first<{ outcome: 'queued' | 'coalesced' }>()
    if (!row) return { outcome: 'duplicate' }

    await sendWakeJob(env, tenant, input.agentId, nowIso, row.outcome === 'coalesced' ? ASSIGNMENT_WAKE_WINDOW_MS / 1000 + 5 : 0)
    return row.outcome === 'queued' ? { outcome: 'queued' } : { outcome: 'coalesced', reason: 'burst_cap' }
  } catch (error) {
    logWakeProblem('assignment_wake_enqueue_failed', { task_id: input.taskId, agent_id: input.agentId, reason: errorText(error) })
    return { outcome: 'failed', reason: errorText(error) }
  }
}

async function sendWakeJob(env: Env, tenant: string, agentId: string, nowIso: string, delaySeconds: number): Promise<void> {
  try {
    if (!env.BUS?.send) return // no queue (tests, local): the cron sweep delivers
    const event: BusEvent<Record<string, never>> = { type: ASSIGNMENT_WAKE_EVENT, tenant, agent_id: agentId, payload: {}, ts: nowIso }
    if (delaySeconds > 0) await env.BUS.send(event, { delaySeconds })
    else await env.BUS.send(event)
  } catch (error) {
    // The ledger row is durable; the sweep will deliver it. A dead queue never fails the assignment.
    logWakeProblem('assignment_wake_job_failed', { agent_id: agentId, reason: errorText(error) })
  }
}

// ── OFF-PATH half ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorkerResult {
  /** assignments delivered (rode in a new inbox row or folded into an unread one) */
  delivered: number
  /** new inbox rows written */
  messages: number
}

interface ClaimedRow {
  id: string
  task_id: string
  epoch: string
  assigned_by: string | null
}

interface LiveTask {
  row: ClaimedRow
  title: string
  projectName: string | null
  externalSource: string | null
  sourcePot: string | null
}

type AgentWakeState = { kind: 'ok' } | { kind: 'hold'; reason: string } | { kind: 'skip'; reason: string }

async function agentWakeState(env: Env, agentId: string): Promise<AgentWakeState> {
  const agent = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1 LIMIT 1')
    .bind(agentId)
    .first<{ status: string; archived_at: string | null }>()
  if (!agent) return { kind: 'skip', reason: 'agent_not_found' }
  if (agent.archived_at) return { kind: 'skip', reason: 'agent_archived' }
  if (agent.status === 'paused') return { kind: 'hold', reason: 'agent_paused' }
  if (agent.status !== 'active') return { kind: 'skip', reason: `agent_${agent.status}` }
  if (await isExecutionPaused(env, agentId)) return { kind: 'hold', reason: 'agent_paused' }
  return { kind: 'ok' }
}

/** A reader exists when the agent has a live bound token (a seat, the plugin, seatlink) or a live fleet runtime. */
async function hasInboxReader(env: Env, tenant: string, agentId: string): Promise<boolean> {
  const token = await env.DB.prepare(
    `SELECT 1 AS x FROM member_tokens t
      WHERE t.tenant = ?1 AND t.agent_id = ?2 AND ${TOKEN_LIVE_PREDICATE('?3')}
      LIMIT 1`,
  )
    .bind(tenant, agentId, nowSqlUtc())
    .first<{ x: number }>()
  if (token) return true
  return (await getFleetAgentLiveness(env, agentId)).live
}

async function windowCount(env: Env, tenant: string, agentId: string, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM task_assignment_wakes
      WHERE tenant = ?1 AND agent_id = ?2 AND outcome IN ('queued', 'pending', 'sent') AND created_at > ?3`,
  )
    .bind(tenant, agentId, sinceIso)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Claim-token fenced outcome write: a worker whose claim went stale cannot overwrite a newer one. */
async function finish(
  env: Env,
  row: ClaimedRow,
  token: string,
  outcome: 'sent' | 'summarized' | 'skipped' | 'failed',
  nowIso: string,
  extra: { reason?: string; seq?: number; bumpAttempts?: boolean } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE task_assignment_wakes
        SET outcome = ?3, reason = ?4, message_seq = ?5, updated_at = ?6, attempts = attempts + ?7
      WHERE id = ?1 AND claim_token = ?2 AND outcome = 'pending'`,
  )
    .bind(row.id, token, outcome, extra.reason ?? null, extra.seq ?? null, nowIso, extra.bumpAttempts ? 1 : 0)
    .run()
}

function singleBody(live: LiveTask): string {
  const by = live.row.assigned_by ? cleanUntrustedText(live.row.assigned_by.replace(':', ' '), NAME_MAX) : ''
  const external = live.externalSource
    ? ` [external source: ${cleanUntrustedText(live.externalSource, 40)}]`
    : live.sourcePot
      ? ` [cross-pot: ${cleanUntrustedText(live.sourcePot, 40)}]`
      : ''
  return [
    `Assigned to you${by ? ` by ${by}` : ''}${external}: task ${live.row.task_id}`,
    `, title (member-written): '${cleanUntrustedText(live.title, TITLE_MAX)}'`,
    live.projectName ? `, project (member-written): '${cleanUntrustedText(live.projectName, NAME_MAX)}'` : '',
    `. Read task_get ${live.row.task_id} and start; reply via task notes. Everything assigned to you: task_list.`,
  ].join('')
}

function summaryBody(taskIds: readonly string[]): string {
  const shown = taskIds.slice(0, SUMMARY_LIST_MAX).join(', ')
  const more = taskIds.length > SUMMARY_LIST_MAX ? ` and ${taskIds.length - SUMMARY_LIST_MAX} more` : ''
  const noun = taskIds.length === 1 ? 'assignment' : 'assignments'
  return `You have ${taskIds.length} new ${noun}: ${shown}${more}. Read task_list (assigned to you) and task_get <id>, then start; reply via task notes.`
}

/**
 * Deliver everything this agent has waiting. Idempotent and safe to run concurrently (rows are claimed with a token), never
 * throws. Driven by the `assignment.wake` bus job and, as the backstop, by the sweep.
 */
export async function processAssignmentWakes(
  env: Env,
  agentId: string,
  opts: AssignmentWakeOpts = {},
): Promise<WorkerResult> {
  try {
    return await work(env, agentId, opts)
  } catch (error) {
    logWakeProblem('assignment_wake_worker_failed', { agent_id: agentId, reason: errorText(error) })
    return { delivered: 0, messages: 0 }
  }
}

async function work(env: Env, agentId: string, opts: AssignmentWakeOpts): Promise<WorkerResult> {
  const none: WorkerResult = { delivered: 0, messages: 0 }
  const tenant = env.TENANT_SLUG
  if (!tenant) return none
  const now = opts.now ?? (() => new Date())
  const nowIso = now().toISOString()
  const staleIso = new Date(now().getTime() - ASSIGNMENT_WAKE_PENDING_STALE_MS).toISOString()
  const sinceIso = new Date(now().getTime() - ASSIGNMENT_WAKE_WINDOW_MS).toISOString()
  const cap = opts.cap ?? ASSIGNMENT_WAKE_CAP

  const state = await agentWakeState(env, agentId)
  if (state.kind === 'skip') {
    await env.DB.prepare(
      `UPDATE task_assignment_wakes SET outcome = 'skipped', reason = ?3, updated_at = ?4
        WHERE tenant = ?1 AND agent_id = ?2
          AND (outcome IN ('queued', 'coalesced', 'failed') OR (outcome = 'pending' AND updated_at < ?5))`,
    ).bind(tenant, agentId, state.reason, nowIso, staleIso).run()
    return none
  }
  if (state.kind === 'hold') {
    // Paused: nothing is dropped. Touching updated_at rotates this agent behind the others in the sweep's order.
    await env.DB.prepare(
      `UPDATE task_assignment_wakes SET outcome = 'coalesced', reason = ?3, updated_at = ?4
        WHERE tenant = ?1 AND agent_id = ?2 AND outcome IN ('queued', 'coalesced')`,
    ).bind(tenant, agentId, state.reason, nowIso).run()
    return none
  }

  // Claim. Queued rows and retryable failures / crashed claims always; held rows only when the window has room.
  const token = crypto.randomUUID()
  const claim = async (where: string, binds: unknown[]): Promise<void> => {
    await env.DB.prepare(
      `UPDATE task_assignment_wakes
          SET outcome = 'pending', claim_token = ?3, updated_at = ?4,
              attempts = attempts + CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END
        WHERE id IN (SELECT id FROM task_assignment_wakes
                      WHERE tenant = ?1 AND agent_id = ?2 AND (${where})
                      ORDER BY created_at ASC, id ASC LIMIT ${CLAIM_BATCH_MAX})`,
    ).bind(tenant, agentId, token, nowIso, ...binds).run()
  }
  await claim(
    `outcome = 'queued' OR (outcome = 'failed' AND attempts < ?5) OR (outcome = 'pending' AND updated_at < ?6 AND attempts < ?5)`,
    [ASSIGNMENT_WAKE_MAX_ATTEMPTS, staleIso],
  )
  if ((await windowCount(env, tenant, agentId, sinceIso)) < cap) await claim(`outcome = 'coalesced'`, [])
  const claimed = await env.DB.prepare(
    `SELECT id, task_id, epoch, assigned_by FROM task_assignment_wakes
      WHERE tenant = ?1 AND agent_id = ?2 AND claim_token = ?3 AND outcome = 'pending'
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(tenant, agentId, token)
    .all<ClaimedRow>()
  const rows = claimed.results ?? []
  if (rows.length === 0) {
    // Held rows with no room yet: touch them so the sweep rotates this agent behind the others instead of re-picking it forever.
    await env.DB.prepare(
      `UPDATE task_assignment_wakes SET updated_at = ?3 WHERE tenant = ?1 AND agent_id = ?2 AND outcome = 'coalesced'`,
    ).bind(tenant, agentId, nowIso).run()
    return none
  }

  // Re-check every assignment at send time: still this agent's, still wakeable, not archived, not already dispatched.
  const live: LiveTask[] = []
  for (const row of rows) {
    const task = await env.DB.prepare(
      `SELECT t.title, t.status, t.assignee_agent_id, t.external_source, t.source_pot, p.name AS project_name,
              ${TASK_NOT_ARCHIVED_SQL('t')} AS not_archived
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = ?1 LIMIT 1`,
    )
      .bind(row.task_id)
      .first<{
        title: string
        status: string
        assignee_agent_id: string | null
        external_source: string | null
        source_pot: string | null
        project_name: string | null
        not_archived: number
      }>()
    let skip: string | null = null
    if (!task) skip = 'task_not_found'
    else if (!task.not_archived) skip = 'task_archived'
    else if (task.assignee_agent_id !== agentId) skip = 'reassigned'
    else if (!isWakeableTaskStatus(task.status)) skip = 'task_not_wakeable'
    else if (await dispatchLetterExists(env, tenant, row.task_id, agentId, row.epoch)) skip = 'dispatch_letter_exists'
    if (skip || !task) {
      await finish(env, row, token, 'skipped', nowIso, { reason: skip ?? 'task_not_found' })
      continue
    }
    live.push({ row, title: task.title, projectName: task.project_name, externalSource: task.external_source, sourcePot: task.source_pot })
  }

  // One entry per task: a task assigned twice in a row is announced once (the newest assignment represents it).
  const byTask = new Map<string, LiveTask>()
  for (const item of live) byTask.set(item.row.task_id, item)
  const primary = [...byTask.values()]
  for (const item of live) {
    if (byTask.get(item.row.task_id) !== item) await finish(env, item.row, token, 'summarized', nowIso, { reason: 'duplicate_task' })
  }
  if (primary.length === 0) return none

  // Webhook doorbell (flag-gated, fail-open, a no-op for an agent without one). Rung BEFORE the inbox-reader check: an agent
  // whose only consumer is its webhook is woken here and gets no inbox row.
  for (const item of primary) {
    await scheduleTaskAssignedDoorbell(env, agentId, item.row.task_id, { assignment: item.row.epoch })
  }

  if (!(await hasInboxReader(env, tenant, agentId))) {
    for (const item of primary) await finish(env, item.row, token, 'skipped', nowIso, { reason: 'no_inbox_reader' })
    return none
  }

  try {
    // At most one unread doorbell: fold into a fresh one; consume (and replace) a stale one.
    const unread = await env.DB.prepare(
      `SELECT seq, created_at, lease_expires_at FROM agent_messages
        WHERE tenant = ?1 AND to_agent = ?2 AND from_agent = ?3 AND read_at IS NULL AND dead_lettered_at IS NULL
        ORDER BY seq DESC LIMIT 1`,
    )
      .bind(tenant, agentId, ASSIGNMENT_WAKE_SENDER)
      .first<{ seq: number; created_at: string; lease_expires_at: string | null }>()
    const leased = unread?.lease_expires_at != null && unread.lease_expires_at > nowIso
    if (unread && !leased) {
      const age = now().getTime() - Date.parse(unread.created_at)
      if (age < ASSIGNMENT_WAKE_FOLD_MAX_AGE_MS) {
        for (const item of primary) await finish(env, item.row, token, 'sent', nowIso, { seq: unread.seq, reason: 'folded' })
        return { delivered: primary.length, messages: 0 }
      }
      await env.DB.prepare(
        `UPDATE agent_messages SET read_at = ?4
          WHERE tenant = ?1 AND to_agent = ?2 AND from_agent = ?3 AND read_at IS NULL
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?4)`,
      ).bind(tenant, agentId, ASSIGNMENT_WAKE_SENDER, nowIso).run()
    }

    const single = primary.length === 1
    const body = single ? singleBody(primary[0]) : summaryBody(primary.map((p) => p.row.task_id))
    const requestId = `assign:${await keyHash([tenant, agentId, ...primary.map((p) => `${p.row.task_id}@${p.row.epoch}`).sort()])}`
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
      { system: true, reason: 'target is the agent the assignment just committed to, resolved server-side, not caller input' },
      {
        now: () => nowIso,
        // Same `<task>#<epoch>` ref as the task.assigned ring above: a webhook-registered agent is POSTed once.
        ...(single ? { doorbellCorrelation: `${primary[0].row.task_id}#${primary[0].row.epoch}` } : {}),
      },
    )
    // request_id_conflict = this exact set already landed under a different body (a retry after a title edit): delivered.
    if (!sent.ok && sent.reason !== 'request_id_conflict') {
      for (const item of primary) await finish(env, item.row, token, 'failed', nowIso, { reason: sent.reason, bumpAttempts: true })
      logWakeProblem('assignment_wake_failed', { agent_id: agentId, count: primary.length, reason: sent.reason })
      return none
    }
    const seq = sent.ok ? sent.seq : undefined
    for (const item of primary) await finish(env, item.row, token, 'sent', nowIso, { seq, reason: single ? undefined : 'summary' })
    return { delivered: primary.length, messages: 1 }
  } catch (error) {
    // Leave every claimed row retryable and visible rather than 'pending' forever.
    const reason = errorText(error)
    logWakeProblem('assignment_wake_failed', { agent_id: agentId, count: primary.length, reason })
    try {
      for (const item of primary) await finish(env, item.row, token, 'failed', nowIso, { reason, bumpAttempts: true })
    } catch {
      // the stale-pending re-claim covers a ledger that cannot be written right now
    }
    return none
  }
}

/** A dispatch letter (task_dispatch bridge / explicit dispatch) for this task and agent at or after this assignment. */
async function dispatchLetterExists(env: Env, tenant: string, taskId: string, agentId: string, epoch: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM task_dispatch_receipts
      WHERE tenant = ?1 AND task_id = ?2 AND agent_id = ?3 AND created_at >= ?4 LIMIT 1`,
  )
    .bind(tenant, taskId, agentId, epoch)
    .first<{ x: number }>()
  return row !== null
}

/**
 * task_dispatch carries its own letter: retire any not-yet-delivered doorbell for this task and agent so the assignee is
 * not told twice. Never throws.
 */
export async function supersedeAssignmentWakesByDispatch(env: Env, taskId: string, agentId: string): Promise<void> {
  try {
    const tenant = env.TENANT_SLUG
    if (!tenant) return
    await env.DB.prepare(
      `UPDATE task_assignment_wakes SET outcome = 'skipped', reason = 'dispatch_letter_exists', updated_at = ?4
        WHERE tenant = ?1 AND task_id = ?2 AND agent_id = ?3 AND outcome IN ('queued', 'coalesced')`,
    ).bind(tenant, taskId, agentId, new Date().toISOString()).run()
  } catch (error) {
    logWakeProblem('assignment_wake_supersede_failed', { task_id: taskId, agent_id: agentId, reason: errorText(error) })
  }
}

// ── SWEEP (cron backstop) ─────────────────────────────────────────────────────────────────────────────────────────

/** Which agents have undelivered rows, oldest first. INDEXED BY pins the (tenant, outcome, agent_id, updated_at) index. */
export const SWEEP_DUE_SQL = `SELECT agent_id, MIN(updated_at) AS oldest FROM task_assignment_wakes INDEXED BY idx_task_assignment_wakes_sweep
        WHERE tenant = ?1
          AND (outcome IN ('queued', 'coalesced')
               OR (outcome = 'failed' AND attempts < ?3)
               OR (outcome = 'pending' AND updated_at < ?2 AND attempts < ?3))
        GROUP BY agent_id ORDER BY oldest ASC LIMIT ${SWEEP_AGENTS_MAX}`

/**
 * Cron entry: prune old terminal rows, then work through the agents with undelivered rows, oldest first. Retries `failed`
 * rows and stale `pending` claims (bounded by ASSIGNMENT_WAKE_MAX_ATTEMPTS) and delivers held rows whose window has room
 * or whose agent resumed. Fair: a worker touches updated_at of what it cannot deliver, which rotates that agent to the
 * back. Never throws.
 */
export async function sweepAssignmentWakes(
  env: Env,
  opts: AssignmentWakeOpts = {},
): Promise<{ agents: number; delivered: number; pruned: number }> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { agents: 0, delivered: 0, pruned: 0 }
  try {
    const now = opts.now ?? (() => new Date())
    const nowIso = now().toISOString()
    const staleIso = new Date(now().getTime() - ASSIGNMENT_WAKE_PENDING_STALE_MS).toISOString()
    const oldIso = new Date(now().getTime() - ASSIGNMENT_WAKE_RETENTION_MS).toISOString()

    // A crashed claim past its attempt ceiling is a failure, not a forever-pending row.
    await env.DB.prepare(
      `UPDATE task_assignment_wakes SET outcome = 'failed', reason = 'attempts_exhausted', updated_at = ?3
        WHERE tenant = ?1 AND outcome = 'pending' AND updated_at < ?2 AND attempts >= ?4`,
    ).bind(tenant, staleIso, nowIso, ASSIGNMENT_WAKE_MAX_ATTEMPTS).run()

    const pruned = await env.DB.prepare(
      `DELETE FROM task_assignment_wakes
        WHERE id IN (SELECT id FROM task_assignment_wakes
                      WHERE tenant = ?1 AND updated_at < ?2
                        AND (outcome IN ('sent', 'skipped', 'summarized') OR (outcome = 'failed' AND attempts >= ?3))
                      LIMIT ${PRUNE_BATCH_MAX})`,
    ).bind(tenant, oldIso, ASSIGNMENT_WAKE_MAX_ATTEMPTS).run()

    const due = await env.DB.prepare(SWEEP_DUE_SQL)
      .bind(tenant, staleIso, ASSIGNMENT_WAKE_MAX_ATTEMPTS)
      .all<{ agent_id: string; oldest: string }>()
    let delivered = 0
    const agents = due.results ?? []
    for (const { agent_id } of agents) delivered += (await processAssignmentWakes(env, agent_id, opts)).delivered
    return { agents: agents.length, delivered, pruned: pruned.meta?.changes ?? 0 }
  } catch (error) {
    logWakeProblem('assignment_wake_sweep_failed', { reason: errorText(error) })
    return { agents: 0, delivered: 0, pruned: 0 }
  }
}
