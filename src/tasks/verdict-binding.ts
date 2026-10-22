// src/tasks/verdict-binding.ts — seed-build-plan-20261022 B3 + B4.
//
// B3: a verdict is bound to the EXACT submission it decided (task_verdicts.submission_id / result_digest, migration 0252),
//     and ONLY when that submission is the task's CURRENT result: the latest ledger row, whose result_text still equals
//     tasks.result, with no unreversed rejection after it. Otherwise the binding is NULL and the receipt claims no submission.
//     (Several writers put a task into review with a new tasks.result and no ledger row: CI sync, runtime receipts, execute,
//     routines, loops, marketing, completion-gate, github-execute. A binding that ignored that would stamp an approval onto a
//     submission whose text is not what the decider saw, and write the false record into the immutable chain.)
// B4: a verdict on a task in CHAIN SCOPE appends a `gate.verdict` execution receipt to the tenant hash chain. Chain scope is
//     derived from trusted rows only (never from an external_source prefix, which any task creator can type).
//
// Verdict surfaces that reach the shared write: writeVerdict (HTTP, MCP task_verdict fallback, IM /approve, dashboard),
// the harness-attested-origin path (src/im/origin-verdict.ts) and the gate:office path (src/addons/office/service.ts) each call
// buildVerdictStatements with the resolved binding. They are THREE call sites of one builder, not one chokepoint.

import type { AuthContext, Env, TaskVerdict } from '../types'
import { appendExecutionReceipt, ExecutionReceiptError } from '../flight-spine/receipts'
import type { JsonValue } from '../flight-spine/types'
import { VerdictRaceError } from './verdict-errors'

/** The submission a verdict is bound to. `null` = the task has no CURRENT submission (see header). */
export interface VerdictSubmissionBinding {
  submissionId: string
  resultDigest: string
}

export type ReceiptActorKind = 'member' | 'agent'

/**
 * The SQL conditions that make a ledger row the task's CURRENT submission. This is the same predicate
 * selfCompletionProducerSql (src/tasks/service.ts) uses to decide "this agent produced the current result", factored out so
 * the two cannot drift: the row is the latest for the task (MAX(seq), this tenant), its result_text equals tasks.result
 * (a legacy NULL result_text never matches: fail closed), and no unreversed rejection was decided at or after it
 * (millisecond precision, a tie counts as rejected). A rejection BOUND to a submission (submission_id) spends exactly that
 * submission and no other, regardless of timestamps (clock skew cannot revive it, and a same-millisecond rejection of N cannot
 * spend N+1); the timestamp comparison applies only to UNBOUND rejections (submission_id NULL: legacy or cast with no current
 * submission).
 *
 * `tasks` MUST be in scope in the enclosing statement (it is the UPDATE target or a JOIN). Placeholders, in order: tenant,
 * tenant. `prefix` namespaces the inner aliases.
 */
export function currentSubmissionConditionsSql(subAlias: string, taskIdExpr: string, prefix = 'cur'): string {
  return `${subAlias}.tenant = ? AND ${subAlias}.task_id = ${taskIdExpr}
       AND ${subAlias}.result_text IS NOT NULL AND tasks.result IS NOT NULL AND ${subAlias}.result_text = tasks.result
       AND ${subAlias}.seq = (SELECT MAX(${prefix}_max.seq) FROM task_result_submissions ${prefix}_max
                               WHERE ${prefix}_max.tenant = ? AND ${prefix}_max.task_id = ${taskIdExpr})
       AND NOT EXISTS (SELECT 1 FROM task_verdicts ${prefix}_rej
                        WHERE ${prefix}_rej.task_id = ${taskIdExpr} AND ${prefix}_rej.verdict = 'rejected'
                          AND ${prefix}_rej.reversed_at IS NULL
                          AND (${prefix}_rej.submission_id = ${subAlias}.id
                               OR (${prefix}_rej.submission_id IS NULL
                                   AND substr(${prefix}_rej.decided_at, 1, 23) >= substr(${subAlias}.created_at, 1, 23))))`
}

interface SubmissionRow {
  id: string
  result_digest: string
}

/**
 * Read the task's CURRENT submission (see currentSubmissionConditionsSql), or null. The caller passes the result to
 * buildVerdictStatements, which re-asserts it INSIDE the status UPDATE's WHERE (latestSubmissionGuardSql), so a change between
 * this read and the write refuses the verdict instead of binding it to a submission the decider did not see.
 */
export async function resolveVerdictSubmission(env: Env, taskId: string): Promise<VerdictSubmissionBinding | null> {
  const row = await env.DB.prepare(
    `SELECT s.id AS id, s.result_digest AS result_digest
       FROM tasks JOIN task_result_submissions s ON s.task_id = tasks.id
      WHERE tasks.id = ? AND ${currentSubmissionConditionsSql('s', 'tasks.id')}`,
  ).bind(taskId, env.TENANT_SLUG, env.TENANT_SLUG).first<SubmissionRow>()
  return row ? { submissionId: row.id, resultDigest: row.result_digest } : null
}

/**
 * SQL conjunct for the tasks UPDATE's WHERE asserting, atomically with the write: (1) the task's current submission is still
 * exactly the one read (or, for a null binding, there is still none), and (2) tasks.result is still the text the caller read.
 */
export function latestSubmissionGuardSql(
  env: Env,
  binding: VerdictSubmissionBinding | null,
  taskResult: string | null,
): { sql: string; params: unknown[] } {
  return {
    sql: `COALESCE((SELECT s.id FROM task_result_submissions s WHERE ${currentSubmissionConditionsSql('s', 'tasks.id', 'guard')}), '') = ?
       AND tasks.result IS ?`,
    params: [env.TENANT_SLUG, env.TENANT_SLUG, binding ? binding.submissionId : '', taskResult],
  }
}

/**
 * The live (non-reversed) verdict that decided EXACTLY this submission, or null. A verdict bound to submission N is not an
 * answer for submission N+1. A verdict with a NULL submission_id never matches a concrete submission id.
 */
export async function verdictForSubmission(
  env: Env,
  taskId: string,
  submissionId: string,
): Promise<TaskVerdict | null> {
  return env.DB.prepare(
    `SELECT id, task_id, verdict, note, decided_by, decided_at, decided_via, origin_agent_id, proposal_id, reversed_at,
            submission_id, result_digest, receipt_actor_kind, attachment_id, consenting_member_id
       FROM task_verdicts
      WHERE task_id = ? AND submission_id = ? AND reversed_at IS NULL
      ORDER BY decided_at DESC, id DESC LIMIT 1`,
  ).bind(taskId, submissionId).first<TaskVerdict>()
}

/** Whether the task's CURRENT submission carries an approving, non-reversed verdict bound to it. */
export async function currentSubmissionApproved(env: Env, taskId: string): Promise<boolean> {
  const current = await resolveVerdictSubmission(env, taskId)
  if (!current) return false
  const verdict = await verdictForSubmission(env, taskId, current.submissionId)
  return verdict !== null && verdict.verdict === 'approved'
}

// ── decider-seen binding (expected_submission_id) ────────────────────────────────────────────────────────────────

/** The decider named a submission and it is not the one the verdict would bind. 409; nothing is written. */
export class VerdictSubmissionMismatchError extends VerdictRaceError {
  constructor(taskId: string) {
    super(taskId)
    this.message = `submission_mismatch: task ${taskId}'s current submission is not the one the decider named`
    this.name = 'VerdictSubmissionMismatchError'
  }
}

/**
 * A task in chain scope must be decided by an AGENT surface against a named submission (`expected_submission_id`, null meaning
 * "I saw none"), so the binding is what the decider saw, not whatever was latest at write time. Human surfaces (IM /approve, the
 * dashboard) cannot carry it yet and leave it optional; the UPDATE's read-then-assert guard still protects them from a change
 * between their read and the write.
 */
export class VerdictSubmissionRequiredError extends Error {
  constructor(taskId: string) {
    super(`expected_submission_id_required: task ${taskId} is in receipt-chain scope; an agent verdict must name the submission it reviewed (expected_submission_id, or null if there is none)`)
    this.name = 'VerdictSubmissionRequiredError'
  }
}

/** Compare the decider-named submission to the binding. `undefined` = not asserted. Throws on mismatch. */
export function assertExpectedSubmission(
  taskId: string,
  binding: VerdictSubmissionBinding | null,
  expected: string | null | undefined,
): void {
  if (expected === undefined) return
  if (expected !== (binding ? binding.submissionId : null)) throw new VerdictSubmissionMismatchError(taskId)
}

/** Agent surfaces on a chain-scope task MUST name the submission. */
export async function assertAgentNamedSubmission(
  env: Env,
  taskId: string,
  expected: string | null | undefined,
): Promise<void> {
  if (expected !== undefined) return
  if (await resolveGateVerdictScope(env, taskId)) throw new VerdictSubmissionRequiredError(taskId)
}

// ── B4: gate.verdict receipt ─────────────────────────────────────────────────────────────────────────────────────

export interface GateVerdictReceiptScope {
  objectiveId: string | null
  flightId: string | null
  bountyId: string | null
}

/**
 * Is this task in receipt-chain scope? From TRUSTED rows only:
 *   (a) the task is a lane of a flight linked to an objective (flight_lanes -> flight_objectives), or
 *   (b) a bounty_task_bindings row binds it (the idempotent bounty -> task binding, migration 0250, src/events/bounty-claimed.ts).
 * `tasks.external_source` is NOT consulted: any task creator can type a `mumega-bounty:` prefix.
 */
export async function resolveGateVerdictScope(env: Env, taskId: string): Promise<GateVerdictReceiptScope | null> {
  const chain = await env.DB.prepare(
    `SELECT fo.objective_id AS objective_id, fl.flight_id AS flight_id
       FROM flight_lanes fl
       JOIN flight_objectives fo ON fo.tenant = fl.tenant AND fo.flight_id = fl.flight_id
      WHERE fl.tenant = ? AND fl.task_id = ?
      ORDER BY fl.created_at ASC, fl.id ASC LIMIT 1`,
  ).bind(env.TENANT_SLUG, taskId).first<{ objective_id: string; flight_id: string }>()

  const binding = await env.DB.prepare('SELECT bounty_id FROM bounty_task_bindings WHERE task_id = ?')
    .bind(taskId).first<{ bounty_id: string }>()
  const bountyId = binding?.bounty_id ?? null

  if (!chain && bountyId === null) return null
  return { objectiveId: chain?.objective_id ?? null, flightId: chain?.flight_id ?? null, bountyId }
}

export type GateVerdictReceiptOutcome =
  | { status: 'appended'; receipt_id: string; sequence: number }
  | { status: 'failed'; error: string }

function receiptAuth(env: Env, kind: ReceiptActorKind, id: string): AuthContext {
  return kind === 'agent'
    ? { userId: id, email: null, role: 'member', tenant: env.TENANT_SLUG, boundAgentId: id }
    : { userId: id, email: null, role: 'member', tenant: env.TENANT_SLUG, memberId: id, boundAgentId: null }
}

/** Bounded retry for a lost race on the tenant-wide chain head. */
export const RECEIPT_MAX_ATTEMPTS = 4

async function appendWithRetry(
  env: Env,
  kind: ReceiptActorKind,
  actorId: string,
  draft: Parameters<typeof appendExecutionReceipt>[2],
  logContext: Record<string, string>,
): Promise<GateVerdictReceiptOutcome> {
  let lastCode = 'unknown'
  for (let attempt = 1; attempt <= RECEIPT_MAX_ATTEMPTS; attempt++) {
    try {
      const receipt = await appendExecutionReceipt(env, receiptAuth(env, kind, actorId), draft)
      return { status: 'appended', receipt_id: receipt.id, sequence: receipt.sequence }
    } catch (error) {
      lastCode = error instanceof ExecutionReceiptError ? error.code : error instanceof Error ? error.name : 'unknown'
      // stale_head = another receipt took the head between our read and write: re-read and try again. Anything else is final.
      if (lastCode !== 'stale_head') break
    }
  }
  // Not silent: the verdict stands and the chain is missing a link. The verdict row carries the pending marker
  // (receipt_actor_kind), so reconcileGateVerdictReceipts (scheduled sweep) replays it exactly.
  console.error('gate.verdict receipt append failed', JSON.stringify({ ...logContext, error: lastCode }))
  return { status: 'failed', error: lastCode }
}

/**
 * Append the `gate.verdict` receipt for an already-written verdict. NEVER throws and never blocks the verdict (it is already
 * committed). Returns null when the verdict was not in chain scope at write time (no `receipt_actor_kind` marker on the row).
 *
 * The marker is written in the verdict INSERT itself (atomic with the verdict), so "receipt owed" survives a crash or a
 * failed append: reconcileGateVerdictReceipts finds owed-but-missing receipts by anti-join on the idempotency key and replays
 * them. The actor kind is read from the row so the replay is byte-identical to the first attempt.
 *
 * Idempotent: idempotencyKey = `verdict:<verdict_id>`; the claims are a pure function of the verdict row, so a replay
 * returns the ORIGINAL receipt. Hash-chain semantics are appendExecutionReceipt's own.
 */
export async function emitGateVerdictReceipt(env: Env, verdict: TaskVerdict): Promise<GateVerdictReceiptOutcome | null> {
  if (!verdict.receipt_actor_kind) return null
  // Causal order across the task's verdicts: this task's OLDER owed receipts (verdicts and reversals) go on the chain first.
  // If one cannot be appended this receipt is DEFERRED (left owed for the sweep), never appended out of order.
  const older = await healOlderOwedReceipts(env, verdict)
  if (older) return older
  return appendVerdictReceipt(env, verdict)
}

async function appendVerdictReceipt(env: Env, verdict: TaskVerdict): Promise<GateVerdictReceiptOutcome | null> {
  const kind = verdict.receipt_actor_kind
  if (!kind) return null
  try {
    const scope = await resolveGateVerdictScope(env, verdict.task_id)
    const claims: JsonValue = {
      verdict_id: verdict.id,
      task_id: verdict.task_id,
      verdict: verdict.verdict,
      decided_by: verdict.decided_by,
      decided_at: verdict.decided_at,
      decided_via: verdict.decided_via ?? null,
      submission_id: verdict.submission_id ?? null,
      result_digest: verdict.result_digest ?? null,
      attachment_id: verdict.attachment_id ?? null,
      consenting_member_id: verdict.consenting_member_id ?? null,
    }
    return await appendWithRetry(env, kind, verdict.decided_by, {
      type: 'gate.verdict',
      idempotencyKey: `verdict:${verdict.id}`,
      objectiveId: scope?.objectiveId ?? null,
      flightId: scope?.flightId ?? null,
      taskId: verdict.task_id,
      claims,
    }, { verdict_id: verdict.id, task_id: verdict.task_id })
  } catch (error) {
    const code = error instanceof Error ? error.name : 'unknown'
    console.error('gate.verdict receipt append failed', JSON.stringify({ verdict_id: verdict.id, task_id: verdict.task_id, error: code }))
    return { status: 'failed', error: code }
  }
}

interface RecordedReversalRow {
  rev_id: string
  rev_actor_id: string
  rev_actor_type: string
}

/** The reversal exactly as RECORDED on the verdict_reversals row (never the current caller). */
function recordedReversalFacts(row: RecordedReversalRow): VerdictReversalFacts {
  return {
    reversalId: row.rev_id,
    actorId: row.rev_actor_id,
    actorKind: row.rev_actor_type === 'agent' ? 'agent' : 'member', // 'system' reversals are recorded as the member-kind actor id
  }
}

/**
 * Append, in causal order, every receipt still owed by this task's verdicts decided BEFORE `current` (their verdict receipt,
 * then their reversal receipt if reversed). Returns null when nothing older is outstanding or all of it landed; otherwise a
 * `failed` outcome (error `older_receipt_owed`) and the caller must NOT append `current`.
 */
async function healOlderOwedReceipts(env: Env, current: TaskVerdict): Promise<GateVerdictReceiptOutcome | null> {
  const issuerId = `mupot:${env.TENANT_SLUG}`
  const older = await env.DB.prepare(
    `SELECT v.*, rv.id AS rev_id, rv.actor_id AS rev_actor_id, rv.actor_type AS rev_actor_type
       FROM task_verdicts v LEFT JOIN verdict_reversals rv ON rv.id = 'reversal:' || v.id
      WHERE v.task_id = ?1 AND v.receipt_actor_kind IS NOT NULL
        AND (v.decided_at < ?2 OR (v.decided_at = ?2 AND v.id < ?3))
        AND (NOT EXISTS (SELECT 1 FROM execution_receipts r
                          WHERE r.tenant = ?4 AND r.issuer_kind = 'mupot' AND r.issuer_id = ?5 AND r.idempotency_key = 'verdict:' || v.id)
             OR (v.reversed_at IS NOT NULL AND rv.id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM execution_receipts r2
                                  WHERE r2.tenant = ?4 AND r2.issuer_kind = 'mupot' AND r2.issuer_id = ?5
                                    AND r2.idempotency_key = 'verdict-reversed:' || v.id)))
      ORDER BY v.decided_at ASC, v.id ASC`,
  ).bind(current.task_id, current.decided_at, current.id, env.TENANT_SLUG, issuerId).all<TaskVerdict & Partial<RecordedReversalRow>>()
  for (const row of older.results ?? []) {
    const first = await appendVerdictReceipt(env, row)
    if (first?.status === 'failed') return { status: 'failed', error: 'older_receipt_owed' }
    if (row.reversed_at && row.rev_id && row.rev_actor_id && row.rev_actor_type) {
      const rev = await emitGateVerdictReversalReceipt(env, row, recordedReversalFacts({
        rev_id: row.rev_id, rev_actor_id: row.rev_actor_id, rev_actor_type: row.rev_actor_type,
      }))
      if (rev?.status === 'failed') return { status: 'failed', error: 'older_receipt_owed' }
    }
  }
  return null
}

export interface VerdictReversalFacts {
  reversalId: string
  actorId: string
  actorKind: ReceiptActorKind
}

/**
 * A reversal must reach the chain too, or it shows "approved" forever. Same receipt type with `reversed: true`, key
 * `verdict-reversed:<verdict_id>`. Only for a verdict that had a receipt owed (marker present). Never throws.
 */
export async function emitGateVerdictReversalReceipt(
  env: Env,
  verdict: TaskVerdict,
  reversal: VerdictReversalFacts,
): Promise<GateVerdictReceiptOutcome | null> {
  if (!verdict.receipt_actor_kind) return null
  try {
    const scope = await resolveGateVerdictScope(env, verdict.task_id)
    const claims: JsonValue = {
      verdict_id: verdict.id,
      task_id: verdict.task_id,
      reversed: true,
      verdict: verdict.verdict,
      submission_id: verdict.submission_id ?? null,
      result_digest: verdict.result_digest ?? null,
      reversal_id: reversal.reversalId,
      reversed_by: reversal.actorId,
      reversed_by_kind: reversal.actorKind,
    }
    return await appendWithRetry(env, reversal.actorKind, reversal.actorId, {
      type: 'gate.verdict',
      idempotencyKey: `verdict-reversed:${verdict.id}`,
      objectiveId: scope?.objectiveId ?? null,
      flightId: scope?.flightId ?? null,
      taskId: verdict.task_id,
      claims,
    }, { verdict_id: verdict.id, task_id: verdict.task_id, reversal: 'true' })
  } catch (error) {
    const code = error instanceof Error ? error.name : 'unknown'
    console.error('gate.verdict reversal receipt append failed', JSON.stringify({ verdict_id: verdict.id, error: code }))
    return { status: 'failed', error: code }
  }
}

export interface ReconcileResult {
  verdicts_healed: number
  reversals_healed: number
  failed: number
}

const RECONCILE_GRACE_MS = 30_000

interface PendingReversalRow extends TaskVerdict {
  rev_id: string
  rev_actor_id: string
  rev_actor_type: string
}

/**
 * Heal verdicts whose `gate.verdict` receipt never landed (append failed, worker died after the verdict commit). Finds
 * verdict rows carrying the pending marker (receipt_actor_kind) with no receipt under their idempotency key, oldest first,
 * bounded; and reversals whose reversal receipt is missing. Idempotent and safe to run concurrently with the first attempt
 * (a verdict younger than the grace window is left alone; a race resolves through the idempotency replay).
 * Wired into the maintenance cron (src/index.ts, 'gate-verdict-receipts').
 */
export async function reconcileGateVerdictReceipts(
  env: Env,
  opts: { limit?: number; graceMs?: number; now?: Date } = {},
): Promise<ReconcileResult> {
  const limit = opts.limit ?? 25
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.graceMs ?? RECONCILE_GRACE_MS)).toISOString()
  const issuerId = `mupot:${env.TENANT_SLUG}`
  const result: ReconcileResult = { verdicts_healed: 0, reversals_healed: 0, failed: 0 }

  const pending = await env.DB.prepare(
    `SELECT v.* FROM task_verdicts v
      WHERE v.receipt_actor_kind IS NOT NULL AND v.decided_at <= ?1
        AND NOT EXISTS (SELECT 1 FROM execution_receipts r
                         WHERE r.tenant = ?2 AND r.issuer_kind = 'mupot' AND r.issuer_id = ?3
                           AND r.idempotency_key = 'verdict:' || v.id)
      ORDER BY v.decided_at ASC, v.id ASC LIMIT ?4`,
  ).bind(cutoff, env.TENANT_SLUG, issuerId, limit).all<TaskVerdict>()
  for (const verdict of pending.results ?? []) {
    const outcome = await emitGateVerdictReceipt(env, verdict)
    if (outcome?.status === 'appended') result.verdicts_healed++
    else result.failed++
  }

  const reversals = await env.DB.prepare(
    `SELECT v.*, rv.id AS rev_id, rv.actor_id AS rev_actor_id, rv.actor_type AS rev_actor_type
       FROM task_verdicts v JOIN verdict_reversals rv ON rv.id = 'reversal:' || v.id
      WHERE v.receipt_actor_kind IS NOT NULL AND v.reversed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM execution_receipts r
                         WHERE r.tenant = ?1 AND r.issuer_kind = 'mupot' AND r.issuer_id = ?2
                           AND r.idempotency_key = 'verdict-reversed:' || v.id)
      ORDER BY v.decided_at ASC, v.id ASC LIMIT ?3`,
  ).bind(env.TENANT_SLUG, issuerId, limit).all<PendingReversalRow>()
  for (const row of reversals.results ?? []) {
    // The chain must read verdict -> reversal in order: make sure the verdict's own receipt exists first (idempotent).
    const first = await emitGateVerdictReceipt(env, row)
    if (first?.status === 'failed') { result.failed++; continue }
    const outcome = await emitGateVerdictReversalReceipt(env, row, recordedReversalFacts(row))
    if (outcome?.status === 'appended') result.reversals_healed++
    else result.failed++
  }
  return result
}
