import type { D1Result } from '@cloudflare/workers-types'
import { sendAgentMessage } from '../agents/messages'
import { TASK_SELECT_COLUMNS } from '../tasks/ranking'
import { canonicalJson, canonicalJsonDigest, sha256Hex } from '../lib/canonical-json'
import { loadProjectSituation } from '../projects/situation'
import { dispatchFlight } from '../flight/dispatch'
import { FLIGHT_META_V1_SCHEMA, parseFlightMetaV1, type FlightMetaV1 } from '../flight/meta'
import { failFlight, getFlight, landGovernedFlight } from '../flight/service'
import {
  assertCompletableDoneWhen,
  checkTransition,
  createTask,
  emitTaskEvent,
  patchToDoneBypassesGate,
  persistTaskUpdate,
  stampTaskUpdate,
  TaskUpdateConflictError,
  verdictIsHuman,
} from '../tasks/service'
import type { Env, Project, Task } from '../types'
import { projectVisibilityClause } from '../projects/access'
import { executeProjectAccessGrant, projectAccessLevelRank } from '../projects/service'
import { getMemberHomeSquad } from '../org/service'
import { principalCanReadProject, principalCanRunForSquad, type RoutinePrincipal } from './access'
import {
  parseRoutineProposal,
  routineProposalReceiptRef,
  type RoutineProposal,
  type RoutineProposalAction,
  type RoutineProposalReference,
} from './proposal'
import type { RoutinePolicySnapshot } from './types'
import { isCancellationPending, sqlNotCancellationPending } from './cancellation-fence'
import { routineControlId } from './identity'
import { resolveSoleGateOwnerAgent } from '../gates/grants'

const ROUTINE_GATE = 'gate:routines'
const ROUTINE_ACTOR = 'mupot-routines'
const ROUTINE_MEMBER = 'system:routines'
const HUMAN_WAIT_BODY_LIMIT = 8000

type ProposalError =
  | 'invalid_proposal' | 'run_not_found' | 'run_not_accepting_proposal' | 'forbidden'
  | 'assigned_agent_mismatch' | 'run_mismatch' | 'project_mismatch' | 'situation_mismatch'
  | 'stale_situation' | 'invalid_policy' | 'project_not_active' | 'assignee_ineligible'
  | 'reference_out_of_scope' | 'budget_exceeded' | 'action_key_conflict'
  | 'proposal_already_submitted' | 'receipt_failed'
  | 'member_not_eligible' | 'access_ceiling_exceeded'
  // execution_mode_forbidden_for_kind (FP-01 Slice 2 v2, P0-1): project_access
  // may only ever be PROPOSED under policy.execution_mode='propose' — see
  // submitRoutineProposal's typed refusal, which exists specifically so this
  // privileged kind can never even be reserved under a policy that would
  // otherwise let ordinary actions execute without a human in the loop.
  | 'execution_mode_forbidden_for_kind'

type ActionError =
  | 'run_not_found' | 'action_not_found' | 'approval_required' | 'action_waiting'
  | 'invalid_policy' | 'budget_exceeded' | 'reference_out_of_scope' | 'stale_situation'
  | 'project_not_active' | 'action_failed' | 'receipt_failed'

// Athena addendum H: notification_reason is ADDITIVE only — every existing
// consumer of notification_pending (MCP tool results, HTTP route JSON) is
// unaffected; it names WHY notification_pending is true (or that it was
// actually delivered) instead of collapsing every non-delivery into one bit.
export type NotifyHumanWaitReasonField = 'delivered' | NotifyHumanWaitRefusalReason

export type RoutineProposalResult =
  | { ok: true; status: 'waiting'; reason: 'review' | 'answer'; run_id: string; action_key: string; duplicate: boolean; notification_pending: boolean; notification_reason: NotifyHumanWaitReasonField }
  | { ok: true; status: 'retry_scheduled'; reason: 'execution_failed'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'succeeded'; run_id: string; action_key: string; result: Record<string, unknown>; duplicate: boolean }
  | { ok: false; error: ProposalError | ActionError }

export type RoutineActionResult =
  | { ok: true; status: 'waiting'; reason: 'review' | 'answer'; run_id: string; action_key: string; duplicate: boolean; notification_pending: boolean; notification_reason: NotifyHumanWaitReasonField }
  | { ok: true; status: 'retry_scheduled'; reason: 'execution_failed'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'succeeded'; run_id: string; action_key: string; result: Record<string, unknown>; duplicate: boolean }
  | { ok: false; error: ActionError }

export type RoutineCancellationResult =
  | { ok: true; run_id: string; duplicate: boolean; outcome: 'confirmed' | 'unconfirmed' }
  | { ok: false; error: 'run_not_found' | 'forbidden' | 'run_terminal' | 'receipt_failed' }

export interface RoutinePendingQuestion {
  action_key: string
  question: string
  choices: string[]
}

export type RoutineAnswerResult =
  | { ok: true; run_id: string; duplicate: boolean }
  | { ok: false; error: 'run_not_found' | 'forbidden' | 'answer_not_found' | 'invalid_answer' | 'answer_conflict' | 'retry_exhausted' | 'run_terminal' | 'receipt_failed' }

type CancellationOutcomeKind = 'cancellation_confirmed' | 'cancellation_unconfirmed'

interface RunContext {
  id: string
  tenant: string
  project_id: string
  routine_id: string
  routine_revision: number
  policy_json: string
  status: string
  waiting_reason: string | null
  assigned_agent_id: string | null
  task_id: string | null
  flight_id: string | null
  situation_digest: string | null
  proposal_json: string | null
  cost_micro_usd: number
  attempt: number
  retry_at: string | null
  project_slug: string
  project_name: string
  project_description: string
  project_goal: string
  project_status: Project['status']
  parent_project_id: string | null
  target_date: string | null
  project_cycle_boundary_at: string | null
  project_stalled: number
  project_stall_threshold_days: number | null
  project_completion_proposed_by: string | null
  project_created_at: string
  project_updated_at: string
}

interface ActionRow {
  id: string
  tenant: string
  project_id: string
  run_id: string
  action_key: string
  kind: RoutineProposalAction['kind']
  input_json: string
  validation_status: 'pending' | 'accepted' | 'rejected'
  gate_status: 'not_required' | 'pending' | 'approved' | 'rejected'
  status: 'pending' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  source_type: string | null
  source_id: string | null
  receipt_id: string | null
  result_json: string | null
  // created_at (FP-01 Slice 2 v2, P0-2): when THIS proposal was accepted —
  // resolveProposalVerdict requires a bound verdict's decided_at to postdate
  // it, closing the "approve now, propose later, replay" reservoir class.
  created_at: string
}

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function cancellationOutcome(kind: CancellationOutcomeKind): 'confirmed' | 'unconfirmed' {
  return kind === 'cancellation_confirmed' ? 'confirmed' : 'unconfirmed'
}

async function loadCancellationOutcome(
  env: Env,
  runId: string,
  tenant: string,
): Promise<CancellationOutcomeKind | null> {
  const event = await env.DB.prepare(
    "SELECT kind FROM routine_run_events WHERE run_id = ? AND tenant = ? AND kind IN ('cancellation_confirmed','cancellation_unconfirmed') LIMIT 1",
  ).bind(runId, tenant).first<{ kind: CancellationOutcomeKind }>()
  return event?.kind ?? null
}

async function hasCancellationRequest(env: Env, runId: string, tenant: string): Promise<boolean> {
  return await env.DB.prepare(
    "SELECT 1 FROM routine_run_events WHERE run_id = ? AND tenant = ? AND kind = 'cancellation_requested' LIMIT 1",
  ).bind(runId, tenant).first() !== null
}

async function recordTerminalCancellationOutcome(
  env: Env,
  principal: RoutinePrincipal,
  runId: string,
  tenant: string,
  now: string,
): Promise<CancellationOutcomeKind | null> {
  try {
    await env.DB.prepare(
      `INSERT INTO routine_run_events (
         id, tenant, project_id, run_id, kind, actor_type, actor_id, occurred_at, metadata_json, correlation_id
       ) SELECT ?, rr.tenant, rr.project_id, rr.id, 'cancellation_unconfirmed', ?, ?, ?,
                json_object('reason', 'terminal_race', 'terminal_status', rr.status), rr.id
           FROM routine_runs rr
          WHERE rr.id = ? AND rr.tenant = ?
            AND rr.status IN ('succeeded','failed','skipped','cancelled')
            AND EXISTS (
              SELECT 1 FROM routine_run_events requested
               WHERE requested.run_id = rr.id AND requested.tenant = rr.tenant
                 AND requested.kind = 'cancellation_requested'
            )
            AND NOT EXISTS (
              SELECT 1 FROM routine_run_events outcome
               WHERE outcome.run_id = rr.id AND outcome.tenant = rr.tenant
                 AND outcome.kind IN ('cancellation_confirmed','cancellation_unconfirmed')
            )`,
    ).bind(crypto.randomUUID(), principal.actor_type, principal.actor_id, now, runId, tenant).run()
  } catch {
    // A concurrent reconciler may have won the unique cancellation-outcome index.
  }
  return loadCancellationOutcome(env, runId, tenant)
}

function parsePolicy(value: string): RoutinePolicySnapshot | null {
  try {
    const policy = JSON.parse(value) as Partial<RoutinePolicySnapshot>
    if (
      (policy.execution_mode !== 'propose' && policy.execution_mode !== 'execute_internal')
      || (policy.overlap_policy !== 'skip' && policy.overlap_policy !== 'queue')
      || typeof policy.responsible_squad_id !== 'string'
      || (policy.preferred_agent_id !== null && typeof policy.preferred_agent_id !== 'string')
      || !Number.isSafeInteger(policy.budget_micro_usd)
      || !Number.isInteger(policy.max_attempts)
      || !Number.isInteger(policy.retry_backoff_seconds)
    ) return null
    return policy as RoutinePolicySnapshot
  } catch {
    return null
  }
}

function projectFrom(run: RunContext): Project {
  return {
    id: run.project_id,
    slug: run.project_slug,
    name: run.project_name,
    description: run.project_description,
    goal: run.project_goal,
    status: run.project_status,
    parent_project_id: run.parent_project_id,
    target_date: run.target_date,
    cycle_boundary_at: run.project_cycle_boundary_at,
    stalled: Number(run.project_stalled),
    stall_threshold_days: run.project_stall_threshold_days,
    completion_proposed_by: run.project_completion_proposed_by,
    repo_url: null,
    worker_name: null,
    live_url: null,
    assigned_squad_id: null,
    deploy_status: 'idle',
    // Not selected by this routine-run join (migration 0166) — this is a
    // synthetic partial view for routine dispatch, not a full projects row.
    created_by_member_id: null,
    created_via_elevation_grant: null,
    created_at: run.project_created_at,
    updated_at: run.project_updated_at,
  }
}

// Exported for P1-4 unit-level pinning of notifyHumanWait's null-assignee
// branch (`if (!run.assigned_agent_id) return { delivered: false, reason:
// 'no_recipient' }`): every reachable public entry point
// (submitRoutineProposal) requires the acting agent principal to equal
// run.assigned_agent_id before it ever gets this far, so a null assignee can
// only be exercised by driving notifyHumanWait directly with a real,
// correctly-shaped RunContext/ActionRow — not by re-deriving the join.
export async function loadRun(env: Env, runId: string): Promise<RunContext | null> {
  return env.DB.prepare(
    `SELECT rr.id, rr.tenant, rr.project_id, rr.routine_id, rr.routine_revision,
            rr.policy_json, rr.status, rr.waiting_reason, rr.assigned_agent_id,
            rr.task_id, rr.flight_id, rr.situation_digest, rr.proposal_json,
            rr.cost_micro_usd, rr.attempt, rr.retry_at,
            p.slug AS project_slug, p.name AS project_name,
            p.description AS project_description, p.goal AS project_goal,
            p.status AS project_status, p.parent_project_id, p.target_date,
            p.cycle_boundary_at AS project_cycle_boundary_at,
            p.stalled AS project_stalled,
            p.stall_threshold_days AS project_stall_threshold_days,
            p.completion_proposed_by AS project_completion_proposed_by,
            p.created_at AS project_created_at, p.updated_at AS project_updated_at
       FROM routine_runs rr JOIN projects p ON p.id = rr.project_id
      WHERE rr.id = ? AND rr.tenant = ?`,
  ).bind(runId, env.TENANT_SLUG).first<RunContext>()
}

async function loadAction(env: Env, runId: string, actionKey: string): Promise<ActionRow | null> {
  return env.DB.prepare(
    `SELECT id, tenant, project_id, run_id, action_key, kind, input_json,
            validation_status, gate_status, status, source_type, source_id,
            receipt_id, result_json, created_at
       FROM routine_run_actions WHERE run_id = ? AND action_key = ? AND tenant = ?`,
  ).bind(runId, actionKey, env.TENANT_SLUG).first<ActionRow>()
}

export async function loadHumanAction(env: Env, runId: string): Promise<ActionRow | null> {
  return env.DB.prepare(
    `SELECT id, tenant, project_id, run_id, action_key, kind, input_json,
            validation_status, gate_status, status, source_type, source_id,
            receipt_id, result_json, created_at
       FROM routine_run_actions
      WHERE run_id = ? AND tenant = ? AND kind = 'ask_human'
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).bind(runId, env.TENANT_SLUG).first<ActionRow>()
}

function pendingQuestion(action: ActionRow): RoutinePendingQuestion | null {
  try {
    const input = JSON.parse(action.input_json) as Record<string, unknown>
    if (typeof input.question !== 'string') return null
    const choices = input.choices === undefined
      ? []
      : Array.isArray(input.choices) && input.choices.every(value => typeof value === 'string')
        ? input.choices as string[]
        : null
    return choices ? { action_key: action.action_key, question: input.question, choices } : null
  } catch {
    return null
  }
}

async function humanWaitRequestId(runId: string, actionKey: string): Promise<string> {
  const requestId = `routine-human:${runId}:${actionKey}`
  return requestId.length <= 128
    ? requestId
    : `routine-human:${await sha256Hex(`${runId}:${actionKey}`)}`
}

type HumanWaitDecision =
  | { type: 'review'; task_id: string; truncated?: true }
  | { type: 'answer'; question: string; choices: string[]; truncated?: true }

function jsonStringContentLength(value: string): number {
  return JSON.stringify(value).length - 2
}

function jsonBoundedSummary(value: string, budget: number): string {
  if (budget <= 0) return ''
  if (jsonStringContentLength(value) <= budget) return value
  const points = [...value]
  const candidate = (kept: number) => kept === 0
    ? ''
    : `${points.slice(0, Math.max(0, kept - 1)).join('')}…${points.at(-1)}`
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (jsonStringContentLength(candidate(middle)) <= budget) low = middle
    else high = middle - 1
  }
  return candidate(low)
}

function humanWaitBody(
  run: RunContext,
  action: ActionRow,
  reason: 'review' | 'answer',
  decision: HumanWaitDecision,
): string {
  const envelope = (boundedDecision: HumanWaitDecision) => JSON.stringify({
    version: 'routine.human-wait/v1',
    type: 'routine_human_wait',
    project_id: run.project_id,
    run_id: run.id,
    action_key: action.action_key,
    reason,
    decision: boundedDecision,
  })
  const body = envelope(decision)
  if (body.length <= HUMAN_WAIT_BODY_LIMIT) return body

  if (decision.type === 'review') {
    const review = envelope({ ...decision, truncated: true })
    if (review.length <= HUMAN_WAIT_BODY_LIMIT) return review
    throw new Error('human-wait review attribution exceeds message limit')
  }

  const emptyDecision: HumanWaitDecision = {
    type: 'answer', question: '', choices: decision.choices.map(() => ''), truncated: true,
  }
  const emptyBody = envelope(emptyDecision)
  const contentBudget = Math.max(0, HUMAN_WAIT_BODY_LIMIT - emptyBody.length)
  const questionBudget = decision.choices.length > 0 ? Math.floor(contentBudget / 2) : contentBudget
  const question = jsonBoundedSummary(decision.question, questionBudget)
  let choicesBudget = contentBudget - jsonStringContentLength(question)
  const choices = decision.choices.map((choice, index) => {
    const share = Math.floor(choicesBudget / (decision.choices.length - index))
    const bounded = jsonBoundedSummary(choice, share)
    choicesBudget -= jsonStringContentLength(bounded)
    return bounded
  })
  const truncated = envelope({ type: 'answer', question, choices, truncated: true })
  if (truncated.length <= HUMAN_WAIT_BODY_LIMIT) return truncated

  const omitted = envelope({
    type: 'answer',
    question: 'Decision summary omitted to fit the message limit.',
    choices: [],
    truncated: true,
  })
  if (omitted.length <= HUMAN_WAIT_BODY_LIMIT) return omitted
  throw new Error('human-wait attribution exceeds message limit')
}

// Athena addendum H: notifyHumanWait used to collapse every "not delivered"
// case (no assigned agent, no decision to deliver, and an actual send refusal
// or exception) into the same `true`. A caller could not tell "there was
// never anyone to notify" from "delivery was attempted and refused" — both
// looked identical. NotifyHumanWaitOutcome keeps that distinction; the three
// call sites below fold it back into the existing boolean
// `notification_pending` field (so RoutineProposalResult/RoutineActionResult
// and every MCP/route consumer of them are unchanged) and ALSO surface the
// new `notification_reason` as a purely additive field.
// requires_human (FP-01 Slice 2 v2, successor to PR #1488, P1-6): the
// PREVIOUS 'delivered: true' for a 'review' wait meant only that
// run.assigned_agent_id — the agent that JUST SUBMITTED the proposal — got
// an inbox ack that it is now waiting. No human was ever notified through
// that send; agent inboxes are not a channel a human reads. This reason
// names the honest outcome once notifyHumanWait resolves the REAL gate
// owner and finds a human holds it (the expected case for gate:routines):
// there is no agent-inbox channel to that principal at all, so the human
// must find this item via /needs — never silently reported as delivered.
export type NotifyHumanWaitRefusalReason = 'no_recipient' | 'no_decision' | 'delivery_refused' | 'requires_human'

export type NotifyHumanWaitOutcome =
  | { delivered: true }
  | { delivered: false; reason: NotifyHumanWaitRefusalReason }

export async function notifyHumanWait(
  env: Env,
  run: RunContext,
  action: ActionRow,
  reason: 'review' | 'answer',
): Promise<NotifyHumanWaitOutcome> {
  if (!run.assigned_agent_id) return { delivered: false, reason: 'no_recipient' }
  const decision: HumanWaitDecision | null = reason === 'review'
    ? run.task_id ? { type: 'review', task_id: run.task_id } : null
    : (() => {
        const question = pendingQuestion(action)
        return question
          ? { type: 'answer', question: question.question, choices: question.choices }
          : null
      })()
  if (!decision) return { delivered: false, reason: 'no_decision' }

  // FP-01 Slice 2 v2 (successor to PR #1488, P1-6): a 'review' wait means a
  // TASK entered review under ROUTINE_GATE — the actual decision-maker is
  // whoever holds that gate capability (resolveSoleGateOwnerAgent, the SAME
  // resolution the MCP task_update wake path uses, src/mcp/index.ts's
  // wakeGateOwnerOnReview), never run.assigned_agent_id (that is the agent
  // that just SUBMITTED the proposal and is, by definition, the one now
  // blocked waiting — sending it an inbox ack is not notifying a human).
  // 'answer' waits are unchanged (ask_human has no gate_owner/task behind
  // it in this run of the machinery; out of scope for this fix).
  if (reason === 'review') {
    const resolution = await resolveSoleGateOwnerAgent(env, ROUTINE_GATE)
    if (resolution.status !== 'resolved') return { delivered: false, reason: 'no_recipient' }
    if (resolution.principal.type === 'member') {
      // The expected steady state: a human holds gate:routines. There is no
      // agent-inbox channel to a member — the human finds this item via
      // /needs. Reporting 'delivered' here would be a fabricated signal.
      return { delivered: false, reason: 'requires_human' }
    }
    try {
      const delivery = await sendAgentMessage(env, {
        fromAgent: ROUTINE_ACTOR,
        fromMember: ROUTINE_MEMBER,
        toAgent: resolution.principal.id,
        kind: 'ack',
        requestId: await humanWaitRequestId(run.id, action.action_key),
        projectId: run.project_id,
        body: humanWaitBody(run, action, reason, decision),
      }, {
        system: true,
        reason: 'human-wait target is the resolved live holder of the gate capability, not the submitting agent',
      }, {
        systemProjectAttribution: true,
        requireActiveRecipientProjectAccess: true,
      })
      return delivery.ok ? { delivered: true } : { delivered: false, reason: 'delivery_refused' }
    } catch {
      return { delivered: false, reason: 'delivery_refused' }
    }
  }

  try {
    const delivery = await sendAgentMessage(env, {
      fromAgent: ROUTINE_ACTOR,
      fromMember: ROUTINE_MEMBER,
      toAgent: run.assigned_agent_id,
      kind: 'ack',
      requestId: await humanWaitRequestId(run.id, action.action_key),
      projectId: run.project_id,
      body: humanWaitBody(run, action, reason, decision),
    }, {
      system: true,
      reason: 'human-wait target is the server-owned assigned agent on the committed Routine run',
    }, {
      systemProjectAttribution: true,
      requireActiveRecipientProjectAccess: true,
    })
    return delivery.ok ? { delivered: true } : { delivered: false, reason: 'delivery_refused' }
  } catch {
    return { delivered: false, reason: 'delivery_refused' }
  }
}

/** Folds a NotifyHumanWaitOutcome into the two result fields every waiting
 *  RoutineProposalResult/RoutineActionResult carries: the existing boolean
 *  `notification_pending` (unchanged shape) plus the additive
 *  `notification_reason` a caller can use to distinguish WHY. */
function notificationFields(
  outcome: NotifyHumanWaitOutcome,
): { notification_pending: boolean; notification_reason: 'delivered' | NotifyHumanWaitRefusalReason } {
  return outcome.delivered
    ? { notification_pending: false, notification_reason: 'delivered' }
    : { notification_pending: true, notification_reason: outcome.reason }
}

async function deterministicUuid(namespace: string, value: string): Promise<string> {
  const hex = await sha256Hex(`mupot:${namespace}:${value}`)
  const bytes = Array.from({ length: 16 }, (_, index) => hex.slice(index * 2, index * 2 + 2))
  bytes[6] = (((Number.parseInt(bytes[6], 16) & 0x0f) | 0x50).toString(16)).padStart(2, '0')
  bytes[8] = (((Number.parseInt(bytes[8], 16) & 0x3f) | 0x80).toString(16)).padStart(2, '0')
  const normalized = bytes.join('')
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`
}

async function controlExclusions(env: Env, run: RunContext): Promise<{
  excludeTaskIds: string[]
  excludeFlightIds: string[]
  excludeMessageIds: string[]
}> {
  const refs = await env.DB.prepare(
    `SELECT ref_type, ref_id FROM routine_run_refs
      WHERE run_id = ? AND tenant = ? AND ref_type IN ('task','flight','message')`,
  ).bind(run.id, run.tenant).all<{ ref_type: string; ref_id: string }>()
  const rows = refs.results ?? []
  return {
    excludeTaskIds: [...new Set([run.task_id, ...rows.filter(row => row.ref_type === 'task').map(row => row.ref_id)].filter(Boolean) as string[])],
    excludeFlightIds: [...new Set([run.flight_id, ...rows.filter(row => row.ref_type === 'flight').map(row => row.ref_id)].filter(Boolean) as string[])],
    excludeMessageIds: [...new Set(rows.filter(row => row.ref_type === 'message').map(row => row.ref_id))],
  }
}

async function currentSituationDigest(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
): Promise<string> {
  const exclusions = await controlExclusions(env, run)
  const situation = await loadProjectSituation(
    env, projectFrom(run), [policy.responsible_squad_id], exclusions,
  )
  return canonicalJsonDigest(situation)
}

async function queueStaleObservation(env: Env, run: RunContext): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_run_actions SET validation_status = 'rejected', status = 'cancelled',
              result_json = json_object('reason', 'stale_situation'), updated_at = ?
        WHERE run_id = ? AND tenant = ? AND status IN ('pending','waiting')
          AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE id = ? AND tenant = ?
               AND ${sqlNotCancellationPending('routine_runs')}
          )`,
    ).bind(now, run.id, run.tenant, run.id, run.tenant),
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'queued', waiting_reason = NULL, retry_at = ?,
              result_summary = 'stale_situation', proposal_json = NULL, updated_at = ?
        WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
          AND ${sqlNotCancellationPending('routine_runs')}
          AND NOT EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE run_id = routine_runs.id AND tenant = routine_runs.tenant
               AND status = 'running'
          )`,
    ).bind(now, now, run.id, run.tenant),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'retry_scheduled', 'system', ?, ?,
             json_object('reason', 'stale_situation'), id
        FROM routine_runs WHERE id = ? AND tenant = ? AND status = 'queued'
          AND result_summary = 'stale_situation'
          AND retry_at = ?
          AND NOT EXISTS (
            SELECT 1 FROM routine_run_events e
             WHERE e.run_id = routine_runs.id AND e.kind = 'retry_scheduled'
               AND json_extract(e.metadata_json, '$.reason') = 'stale_situation'
               AND e.occurred_at = ?
          )`,
    ).bind(crypto.randomUUID(), ROUTINE_ACTOR, now, run.id, run.tenant, now, now),
  ])
}

async function referenceReadable(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
  reference: RoutineProposalReference,
): Promise<boolean> {
  if (reference.type === 'task') {
    const task = await env.DB.prepare(
      'SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND squad_id = ?',
    ).bind(reference.id, run.project_id, policy.responsible_squad_id).first()
    return task !== null
  }
  if (reference.type === 'flight') {
    const flight = await env.DB.prepare(
      `SELECT 1 FROM flights
        WHERE id = ? AND tenant = ? AND project_id = ? AND json_valid(meta)
          AND EXISTS (
            SELECT 1 FROM json_each(flights.meta, '$.squad_ids')
             WHERE CAST(value AS TEXT) = ?
          )`,
    ).bind(reference.id, run.tenant, run.project_id, policy.responsible_squad_id).first()
    return flight !== null
  }
  const artifact = await env.DB.prepare(
    `SELECT 1 FROM routine_run_refs
      WHERE run_id = ? AND tenant = ? AND ref_id = ?
        AND ref_type IN ('evidence','output','receipt')`,
  ).bind(run.id, run.tenant, reference.id).first()
  return artifact !== null
}

async function validateActionScope(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
  action: RoutineProposalAction,
): Promise<ProposalError | null> {
  if (action.kind === 'create_task') {
    const assignee = action.input.assignee_agent_id ?? run.assigned_agent_id
    if (!assignee) return 'assignee_ineligible'
    const row = await env.DB.prepare(
      `SELECT 1 FROM agents WHERE id = ? AND squad_id = ? AND status = 'active'`,
    ).bind(assignee, policy.responsible_squad_id).first()
    return row ? null : 'assignee_ineligible'
  }
  if (action.kind === 'dispatch_flight') {
    const remaining = Math.max(0, policy.budget_micro_usd - Number(run.cost_micro_usd))
    if (action.input.budget_micro_usd > remaining) return 'budget_exceeded'
    const rows = await env.DB.prepare(
      `SELECT id FROM tasks
        WHERE project_id = ? AND squad_id = ?
          AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    ).bind(
      run.project_id,
      policy.responsible_squad_id,
      JSON.stringify(action.input.task_ids),
    ).all<{ id: string }>()
    if ((rows.results?.length ?? 0) !== action.input.task_ids.length) return 'reference_out_of_scope'
    for (const ref of action.input.artifact_refs) {
      if (!await referenceReadable(env, run, policy, { type: 'artifact', id: ref })) {
        return 'reference_out_of_scope'
      }
    }
    return null
  }
  if (action.kind === 'request_review') {
    return await referenceReadable(env, run, policy, {
      type: action.input.source_type,
      id: action.input.source_id,
    }) ? null : 'reference_out_of_scope'
  }
  if (action.kind === 'ask_human') {
    for (const reference of action.input.references) {
      if (!await referenceReadable(env, run, policy, reference)) return 'reference_out_of_scope'
    }
  }
  if (action.kind === 'project_access') {
    return validateProjectAccessScope(env, run, action)
  }
  return null
}

// project_access validation (FP-01 Slice 2, mupot#1443, brief §2 Task A).
// Three conjuncts, all re-derived from the DATABASE at validate time — never
// trusted from the proposal payload:
//   1. member exists, is 'active', and is this tenant's own (or legacy
//      tenant-less) row — the SAME predicate createHomeForMember uses
//      (src/org/service.ts) so the two functions can never disagree about
//      who is a real, live member.
//   2. the proposal names THIS run's own project — a routine is scoped to
//      one project (run.project_id); it may never propose access to a
//      DIFFERENT project it was never dispatched against.
//   3. access_level does not exceed the PROPOSER's OWN rank on the project.
//
// FP-01 Slice 2 v2 (successor to PR #1488, adversarial P2-10): (a) the rank
// comparison now uses projectAccessLevelRank (src/projects/service.ts) — the
// existing PROJECT_ACCESS_LEVELS ordering, exposed as a shared export —
// instead of a locally hand-rolled 3-level map (a "fifth copy" of this
// ordering per the adversarial gate). (b) the ceiling is now the PROPOSING
// AGENT's own structural squad (agents.squad_id for run.assigned_agent_id),
// not policy.responsible_squad_id. Those two can differ: policy_json is
// ROUTINE CONFIG (settable by whoever created/updated the routine), and
// principalCanRunForSquad only requires the agent hold a member+ CAPABILITY
// grant on responsible_squad_id — capability grants are cross-squad-
// grantable, so an agent whose own home squad has thin project access could
// otherwise borrow a highly-privileged responsible_squad_id's ceiling. Using
// the agent's own agents.squad_id row pins the ceiling to something the
// routine's config can't move.
async function validateProjectAccessScope(
  env: Env,
  run: RunContext,
  action: Extract<RoutineProposalAction, { kind: 'project_access' }>,
): Promise<ProposalError | null> {
  if (action.input.project_id !== run.project_id) return 'reference_out_of_scope'
  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ? AND status = 'active' AND (tenant = ? OR tenant IS NULL) LIMIT 1`,
  ).bind(action.input.member_id, run.tenant).first()
  if (!member) return 'member_not_eligible'
  if (!run.assigned_agent_id) return 'reference_out_of_scope'
  const proposerSquad = await env.DB.prepare(
    `SELECT psa.access_level FROM agents a
       JOIN project_squad_access psa ON psa.squad_id = a.squad_id
      WHERE a.id = ? AND psa.project_id = ?`,
  ).bind(run.assigned_agent_id, run.project_id).first<{ access_level: 'read' | 'write' | 'admin' }>()
  if (!proposerSquad) return 'reference_out_of_scope'
  if (projectAccessLevelRank(action.input.access_level) > projectAccessLevelRank(proposerSquad.access_level)) {
    return 'access_ceiling_exceeded'
  }
  return null
}

function stampRoutineProposalReceipt(env: Env, run: RunContext) {
  if (!run.flight_id) return null
  const ref = routineProposalReceiptRef(run.id)
  return env.DB.prepare(
    `UPDATE flights
        SET meta = json_set(
              meta,
              '$.receipt_refs',
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM json_each(meta, '$.receipt_refs') WHERE value = ?1
                ) THEN json_extract(meta, '$.receipt_refs')
                ELSE json_insert(
                  COALESCE(json_extract(meta, '$.receipt_refs'), json_array()),
                  '$[#]',
                  ?1
                )
              END
            )
      WHERE id = ?2
        AND tenant = ?3
        AND json_extract(meta, '$.routine_run_id') = ?4`,
  ).bind(ref, run.flight_id, run.tenant, run.id)
}

async function reserveAction(
  env: Env,
  run: RunContext,
  proposal: RoutineProposal,
): Promise<{ action: ActionRow; duplicate: boolean } | { error: ProposalError }> {
  const inputJson = canonicalJson(proposal.action.input)
  const keyed = await loadAction(env, run.id, proposal.action.key)
  if (keyed) {
    if (keyed.kind !== proposal.action.kind || canonicalJson(JSON.parse(keyed.input_json)) !== inputJson) {
      return { error: 'action_key_conflict' }
    }
    if (keyed.status === 'cancelled' || keyed.status === 'failed') {
      const now = new Date().toISOString()
      const proposalJson = canonicalJson(proposal)
      const stamp = stampRoutineProposalReceipt(env, run)
      const outcomes = await env.DB.batch([
        env.DB.prepare(
          `UPDATE routine_runs SET proposal_json = ?, result_summary = NULL, retry_at = NULL,
                  finished_at = NULL, updated_at = ?
            WHERE id = ? AND tenant = ? AND status = 'running' AND proposal_json IS NULL
              AND ${sqlNotCancellationPending('routine_runs')}`,
        ).bind(proposalJson, now, run.id, run.tenant),
        env.DB.prepare(
          `UPDATE routine_run_actions
              SET validation_status = 'accepted', gate_status = 'not_required', status = 'pending',
                  source_type = NULL, source_id = NULL, receipt_id = NULL, result_json = NULL,
                  updated_at = ?
            WHERE id = ? AND tenant = ? AND status = ?
              AND kind = ? AND input_json = ?
              AND EXISTS (
                SELECT 1 FROM routine_runs
                 WHERE id = ? AND tenant = ? AND status = 'running' AND proposal_json = ?
                   AND ${sqlNotCancellationPending('routine_runs')}
              )`,
        ).bind(
          now, keyed.id, run.tenant, keyed.status, proposal.action.kind, inputJson,
          run.id, run.tenant, proposalJson,
        ),
        env.DB.prepare(
          `INSERT INTO routine_run_events (
            id, tenant, project_id, run_id, kind, actor_type, actor_id,
            occurred_at, metadata_json, correlation_id
          )
          SELECT ?, tenant, project_id, id, 'proposal_received', 'agent', ?, ?,
                 json_object('action_key', ?, 'kind', ?, 'retry', true), id
            FROM routine_runs
           WHERE id = ? AND tenant = ? AND status = 'running' AND proposal_json = ?
             AND EXISTS (
               SELECT 1 FROM routine_run_actions
                WHERE id = ? AND tenant = ? AND status = 'pending' AND updated_at = ?
             )`,
        ).bind(
          crypto.randomUUID(), run.assigned_agent_id, now, proposal.action.key,
          proposal.action.kind, run.id, run.tenant, proposalJson, keyed.id, run.tenant, now,
        ),
        ...(stamp ? [stamp] : []),
      ])
      if (!wrote(outcomes[0]) || !wrote(outcomes[1]) || !wrote(outcomes[2]) || (stamp && !wrote(outcomes[3]))) {
        const raced = await loadAction(env, run.id, proposal.action.key)
        if (raced && raced.status !== 'cancelled' && raced.status !== 'failed') {
          return { action: raced, duplicate: true }
        }
        return { error: 'receipt_failed' }
      }
      const reactivated = await loadAction(env, run.id, proposal.action.key)
      return reactivated ? { action: reactivated, duplicate: true } : { error: 'receipt_failed' }
    }
    return { action: keyed, duplicate: true }
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM routine_run_actions
      WHERE run_id = ? AND tenant = ? AND status NOT IN ('cancelled','failed')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(run.id, run.tenant).first<{ id: string }>()
  if (existing) {
    return { error: 'proposal_already_submitted' }
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const proposalJson = canonicalJson(proposal)
  const stamp = stampRoutineProposalReceipt(env, run)
  let outcomes: D1Result<unknown>[]
  try {
    outcomes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE routine_runs SET proposal_json = ?, updated_at = ?
          WHERE id = ? AND tenant = ? AND status = 'running' AND proposal_json IS NULL
            AND ${sqlNotCancellationPending('routine_runs')}`,
      ).bind(proposalJson, now, run.id, run.tenant),
      env.DB.prepare(
        `INSERT INTO routine_run_actions (
          id, tenant, project_id, run_id, action_key, kind, input_json,
          validation_status, gate_status, status, created_at, updated_at
        )
        SELECT ?, tenant, project_id, id, ?, ?, ?, 'accepted', 'not_required',
               'pending', ?, ?
          FROM routine_runs
         WHERE id = ? AND tenant = ? AND status = 'running' AND proposal_json = ?`,
      ).bind(
        id, proposal.action.key, proposal.action.kind, inputJson,
        now, now, run.id, run.tenant, proposalJson,
      ),
      env.DB.prepare(
        `INSERT INTO routine_run_events (
          id, tenant, project_id, run_id, kind, actor_type, actor_id,
          occurred_at, metadata_json, correlation_id
        )
        SELECT ?, tenant, project_id, id, 'proposal_received', 'agent', ?, ?,
               json_object('action_key', ?, 'kind', ?), id
          FROM routine_runs WHERE id = ? AND tenant = ? AND proposal_json = ?`,
      ).bind(
        crypto.randomUUID(), run.assigned_agent_id, now, proposal.action.key,
        proposal.action.kind, run.id, run.tenant, proposalJson,
      ),
      ...(stamp ? [stamp] : []),
    ])
  } catch {
    const raced = await loadAction(env, run.id, proposal.action.key)
    if (raced && raced.kind === proposal.action.kind && canonicalJson(JSON.parse(raced.input_json)) === inputJson) {
      return { action: raced, duplicate: true }
    }
    return { error: 'receipt_failed' }
  }
  if (!wrote(outcomes[0]) || !wrote(outcomes[1]) || !wrote(outcomes[2]) || (stamp && !wrote(outcomes[3]))) {
    const raced = await loadAction(env, run.id, proposal.action.key)
    if (raced && raced.kind === proposal.action.kind && canonicalJson(JSON.parse(raced.input_json)) === inputJson) {
      return { action: raced, duplicate: true }
    }
    return { error: 'receipt_failed' }
  }
  const action = await loadAction(env, run.id, proposal.action.key)
  return action ? { action, duplicate: false } : { error: 'receipt_failed' }
}

async function waitForHuman(
  env: Env,
  run: RunContext,
  action: ActionRow,
  reason: 'review' | 'answer',
): Promise<RoutineActionResult> {
  const now = new Date().toISOString()
  const waitReceipt = crypto.randomUUID()
  if (reason === 'review' && !run.task_id) return { ok: false, error: 'receipt_failed' }
  const statements = [
    env.DB.prepare(
      `UPDATE routine_run_actions SET status = 'waiting', gate_status = ?,
              source_type = ?, source_id = ?, receipt_id = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE id = ? AND tenant = ? AND status = 'running'
               AND ${sqlNotCancellationPending('routine_runs')}
          )`,
    ).bind(
      reason === 'review' ? 'pending' : 'not_required',
      reason === 'review' ? 'task' : 'question',
      reason === 'review' ? run.task_id : action.id,
      waitReceipt, now, action.id, run.tenant, run.id, run.tenant,
    ),
    ...(reason === 'review' ? [env.DB.prepare(
      `UPDATE tasks SET status = 'review', gate_owner = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status IN ('in_progress','review')
          AND (gate_owner IS NULL OR gate_owner = ?)
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'waiting' AND receipt_id = ?
          )`,
    ).bind(
      ROUTINE_GATE, now, run.task_id, run.project_id, ROUTINE_GATE,
      action.id, run.tenant, waitReceipt,
    )] : []),
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'waiting', waiting_reason = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'waiting' AND receipt_id = ?
          )`,
    ).bind(reason, now, run.id, run.tenant, action.id, run.tenant, waitReceipt),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, ?, 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'waiting' AND waiting_reason = ?
         AND updated_at = ?
         AND EXISTS (
           SELECT 1 FROM routine_run_actions
            WHERE id = ? AND tenant = ? AND status = 'waiting' AND receipt_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = ?
              AND json_extract(e.metadata_json, '$.action_key') = ?
         )`,
    ).bind(
      crypto.randomUUID(), reason === 'review' ? 'approval_requested' : 'action_started',
      ROUTINE_ACTOR, now, JSON.stringify({ action_key: action.action_key, reason }),
      run.id, run.tenant, reason, now, action.id, run.tenant, waitReceipt,
      reason === 'review' ? 'approval_requested' : 'action_started', action.action_key,
    ),
  ]
  const outcomes = await env.DB.batch(statements)
  if (outcomes.some(outcome => !wrote(outcome))) {
    const raced = await loadAction(env, run.id, action.action_key)
    if (raced?.status === 'waiting') {
      const outcome = await notifyHumanWait(env, run, raced, reason)
      return {
        ok: true, status: 'waiting', reason, run_id: run.id, action_key: action.action_key,
        duplicate: true, ...notificationFields(outcome),
      }
    }
    return { ok: false, error: 'receipt_failed' }
  }
  const outcome = await notifyHumanWait(env, run, action, reason)
  return {
    ok: true, status: 'waiting', reason, run_id: run.id, action_key: action.action_key,
    duplicate: false, ...notificationFields(outcome),
  }
}

// approvedGate flips a WAITING action's own gate_status/status generically,
// for every routine action kind that can go through waitForHuman('review')
// — create_task, dispatch_flight, request_review, ask_human, project_access
// alike. It is intentionally left reading "the latest verdict on the
// control task" (unbound to any one proposal) because that generic flip is
// not, on its own, a privileged effect: a stale-verdict replay through THIS
// function only ever gets an action into 'approved'/'pending' bookkeeping
// state, never any downstream write. The privileged effect for
// project_access — the actual project_squad_access grant — is authorized
// separately, by resolveProposalVerdict below, which IS bound to this exact
// proposal. See PR #1488's adversarial finding 2 (kasra-review 2026-09-21)
// for the exploit this split closes without widening approvedGate's blast
// radius onto the other four action kinds' existing, separately-tested
// behavior.
async function approvedGate(env: Env, action: ActionRow): Promise<'approved' | 'rejected' | null> {
  if (action.gate_status !== 'pending' || action.source_type !== 'task' || !action.source_id) return null
  const verdict = await env.DB.prepare(
    `SELECT verdict FROM task_verdicts WHERE task_id = ? ORDER BY decided_at DESC, id DESC LIMIT 1`,
  ).bind(action.source_id).first<{ verdict: 'approved' | 'rejected' }>()
  return verdict?.verdict ?? null
}

// resolveProposalVerdict — FP-01 Slice 2 v2 (successor to PR #1488, P0-2):
// unlike approvedGate above, this IS the gate on the privileged effect
// (the project_squad_access grant) and is bound to the SPECIFIC proposal
// being executed, not merely "a verdict exists on the control task":
//   1. proposal_id = action.id — the verdict must NAME this proposal
//      (0159_task_verdict_proposal_binding.sql; stamped server-side at
//      verdict-write time by resolveVerdictProposalId, never caller-
//      supplied), closing the cross-proposal replay the adversarial gate
//      demonstrated (approve an unrelated earlier proposal on the same
//      long-lived control task, reopen it, submit a NEW proposal, replay).
//   2. decided_at > action.created_at — Athena's design ruling, belt-and-
//      suspenders alongside (1): the verdict must postdate the proposal it
//      claims to decide.
//   3. reversed_at IS NULL — a reversed approval (task_verdict_reverse,
//      src/mcp/index.ts / src/tasks/index.ts) must never re-authorize a
//      grant it no longer stands behind.
// Returns null (never falls back to "no verdict = treat as absent-but-
// harmless") on anything but a clean 'approved' or 'rejected' match — the
// caller must treat null as "not yet decided for THIS proposal," exactly
// like no verdict existing at all.
async function resolveProposalVerdict(
  env: Env,
  action: ActionRow,
): Promise<{ id: string; verdict: 'approved' | 'rejected'; decided_by: string; decided_via: 'agent_attested_origin' | null } | null> {
  return env.DB.prepare(
    `SELECT id, verdict, decided_by, decided_via FROM task_verdicts
      WHERE proposal_id = ? AND decided_at > ? AND reversed_at IS NULL
      ORDER BY decided_at DESC, id DESC LIMIT 1`,
  ).bind(action.id, action.created_at)
    // decided_via's DB-level CHECK constraint restricts it to NULL or
    // 'agent_attested_origin' (migrations/0155) — the generic type param
    // documents that constraint for callers (verdictIsHuman) rather than
    // widening to `string | null` and forcing every caller to re-narrow.
    .first<{ id: string; verdict: 'approved' | 'rejected'; decided_by: string; decided_via: 'agent_attested_origin' | null }>()
}

async function replayWaitingAction(
  env: Env,
  run: RunContext,
  action: ActionRow,
): Promise<RoutineActionResult> {
  if (run.waiting_reason === 'review' && await approvedGate(env, action)) {
    return executeRoutineAction(env, run.id, action.action_key)
  }
  const reason = run.waiting_reason === 'answer' ? 'answer' : 'review'
  const outcome = await notifyHumanWait(env, run, action, reason)
  return {
    ok: true,
    status: 'waiting',
    reason,
    run_id: run.id,
    action_key: action.action_key,
    duplicate: true,
    ...notificationFields(outcome),
  }
}

async function ensureActionTask(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
  action: Extract<RoutineProposalAction, { kind: 'create_task' }>,
  actionId: string,
): Promise<Task> {
  const id = await deterministicUuid('routine-action-task', actionId)
  const existing = await env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS}
       FROM tasks WHERE id = ?`,
  ).bind(id).first<Task>()
  if (existing) return existing
  try {
    return await createTask(env, {
      squad_id: policy.responsible_squad_id,
      project_id: run.project_id,
      title: action.input.title,
      body: action.input.description,
      done_when: `Evidence satisfies Routine action ${action.key}.`,
      status: 'open',
      assignee_agent_id: action.input.assignee_agent_id ?? run.assigned_agent_id,
    }, { id, skipMirror: true })
  } catch (error) {
    const raced = await env.DB.prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks WHERE id = ?`,
    ).bind(id).first<Task>()
    if (raced) return raced
    throw error
  }
}

async function executeFlightAction(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
  action: Extract<RoutineProposalAction, { kind: 'dispatch_flight' }>,
  actionId: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const remaining = Math.max(0, policy.budget_micro_usd - Number(run.cost_micro_usd))
  if (action.input.budget_micro_usd > remaining || !run.assigned_agent_id) {
    return { ok: false, reason: 'reference_out_of_scope' }
  }
  const id = await deterministicUuid('routine-action-flight', `${actionId}:${run.attempt}`)
  type ExistingFlight = { id: string; status: string; project_id: string | null; agent: string; meta: string }
  const loadExisting = () => env.DB.prepare(
    'SELECT id, status, project_id, agent, meta FROM flights WHERE id = ? AND tenant = ?',
  ).bind(id, run.tenant).first<ExistingFlight>()
  const existingOutcome = (flight: ExistingFlight): { ok: true; id: string } | { ok: false; reason: string } => {
    try {
      const parsed = parseFlightMetaV1(JSON.parse(flight.meta) as unknown)
      const matches = ['running', 'landed', 'held'].includes(flight.status)
        && flight.project_id === run.project_id
        && flight.agent === run.assigned_agent_id
        && parsed?.routine_run_id === run.id
        && parsed.objective_id === actionId
      if (!matches) return { ok: false, reason: 'reference_out_of_scope' }
      return flight.status === 'held'
        ? { ok: false, reason: 'flight_clearance_hold' }
        : { ok: true, id: flight.id }
    } catch {
      return { ok: false, reason: 'reference_out_of_scope' }
    }
  }
  const existing = await loadExisting()
  if (existing) return existingOutcome(existing)
  const tasks = await env.DB.prepare(
    `SELECT id, done_when FROM tasks
      WHERE project_id = ? AND squad_id = ?
        AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(
    run.project_id, policy.responsible_squad_id, JSON.stringify(action.input.task_ids),
  ).all<{ id: string; done_when: string }>()
  if ((tasks.results?.length ?? 0) !== action.input.task_ids.length) {
    return { ok: false, reason: 'reference_out_of_scope' }
  }
  const doneWhen = new Map((tasks.results ?? []).map(task => [task.id, task.done_when]))
  const meta: FlightMetaV1 = {
    schema: FLIGHT_META_V1_SCHEMA,
    goal_id: run.routine_id,
    objective_id: actionId,
    squad_ids: [policy.responsible_squad_id],
    task_ids: action.input.task_ids,
    done_when: action.input.task_ids.map(taskId => doneWhen.get(taskId) as string),
    artifact_refs: action.input.artifact_refs,
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: run.flight_id,
    routine_run_id: run.id,
    routine_revision: run.routine_revision,
  }
  try {
    const result = await dispatchFlight(env, {
      agent: run.assigned_agent_id,
      goal: action.input.goal,
      project_id: run.project_id,
      trigger_source: 'schedule',
      budget_micro_usd: action.input.budget_micro_usd,
      meta,
    }, {
      contextComplete: true,
      toolsReachable: true,
      budgetRemainingMicroUsd: remaining,
      budgetEstimateMicroUsd: action.input.budget_micro_usd,
      recentProgress: 1,
      progressPerStep: 1,
      wastePerStep: 0,
      stepSeconds: 60,
    }, {}, { allowCollisionWith: run.flight_id ? [run.flight_id] : [], id })
    return result.go
      ? { ok: true, id: result.id }
      : { ok: false, reason: result.reasons.includes('flight_clearance_hold') ? 'flight_clearance_hold' : 'preflight_hold' }
  } catch (error) {
    const raced = await loadExisting()
    if (raced) return existingOutcome(raced)
    throw error
  }
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  return env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS}
       FROM tasks WHERE id = ?`,
  ).bind(taskId).first<Task>()
}

async function completeControlTask(env: Env, run: RunContext): Promise<void> {
  if (!run.task_id) throw new Error('routine control Task missing')
  let task = await loadTask(env, run.task_id)
  if (!task || task.project_id !== run.project_id) throw new Error('routine control Task ownership mismatch')
  if (task.status === 'done') return
  assertCompletableDoneWhen(task.done_when)
  if (patchToDoneBypassesGate(task.status, task.gate_owner, 'done')) {
    throw new Error('routine control Task gate is incomplete')
  }
  const transitionError = checkTransition(task.status, 'done')
  if (transitionError) throw new Error(`routine control Task ${transitionError.from} cannot complete`)
  const existing = task
  task = { ...task, status: 'done' }
  stampTaskUpdate(task, existing.status, new Date().toISOString())
  try {
    await persistTaskUpdate(env, existing, task)
  } catch (error) {
    if (!(error instanceof TaskUpdateConflictError)) throw error
    const raced = await loadTask(env, run.task_id)
    if (raced?.status === 'done') return
    throw error
  }
  await emitTaskEvent(env, 'task.updated', task, { kind: 'agent', id: run.assigned_agent_id ?? ROUTINE_ACTOR })
}

async function landControlFlight(env: Env, run: RunContext): Promise<void> {
  if (!run.flight_id || !run.assigned_agent_id) throw new Error('routine control Flight missing')
  const flight = await getFlight(env, run.flight_id)
  if (!flight || flight.project_id !== run.project_id || flight.agent !== run.assigned_agent_id) {
    throw new Error('routine control Flight ownership mismatch')
  }
  const meta = parseFlightMetaV1(JSON.parse(flight.meta) as unknown)
  if (!meta || meta.routine_run_id !== run.id || meta.routine_revision !== run.routine_revision) {
    throw new Error('routine control Flight metadata mismatch')
  }
  const landed = await landGovernedFlight(env, flight.id, {
    cost_micro_usd: 0,
    score: 1,
    expected_agent: run.assigned_agent_id,
    agent_id: run.assigned_agent_id,
    meta,
    actor: { kind: 'agent', id: run.assigned_agent_id },
  })
  // #916: `landed` is now a result object, so a bare truthiness test would always pass and
  // skip the verification below — which is the one place that catches a control flight
  // that transitioned without a receipt. Require BOTH, and let the re-check adjudicate.
  if (landed.transitioned && landed.receipt) return
  const existing = await getFlight(env, flight.id)
  const outbox = await env.DB.prepare(
    `SELECT 1 FROM flight_event_outbox
      WHERE tenant = ? AND flight_id = ? AND event_type = 'flight.landed'`,
  ).bind(run.tenant, flight.id).first()
  if (existing?.status !== 'landed' || !outbox) throw new Error('routine control Flight could not land')
}

async function cancelControlTask(env: Env, run: Pick<RunContext, 'task_id' | 'project_id'>): Promise<boolean> {
  if (!run.task_id) return true
  let task = await loadTask(env, run.task_id)
  if (!task || task.project_id !== run.project_id) return false
  if (task.status === 'blocked' || task.status === 'done') return true
  if (task.status === 'open') {
    const existing = task
    task = { ...task, status: 'in_progress' }
    stampTaskUpdate(task, existing.status, new Date().toISOString())
    try {
      await persistTaskUpdate(env, existing, task)
      await emitTaskEvent(env, 'task.updated', task, { kind: 'member', id: ROUTINE_ACTOR })
    } catch (error) {
      if (!(error instanceof TaskUpdateConflictError)) throw error
      const raced = await loadTask(env, run.task_id)
      if (raced?.status === 'blocked' || raced?.status === 'done') return true
      if (raced?.status !== 'in_progress') return false
      task = raced
    }
  }
  if (checkTransition(task.status, 'blocked')) return false
  const existing = task
  task = { ...task, status: 'blocked', result: 'Routine cancelled by operator.' }
  stampTaskUpdate(task, existing.status, new Date().toISOString())
  try {
    await persistTaskUpdate(env, existing, task)
  } catch (error) {
    if (!(error instanceof TaskUpdateConflictError)) throw error
    const raced = await loadTask(env, run.task_id)
    return raced?.status === 'blocked' || raced?.status === 'done'
  }
  await emitTaskEvent(env, 'task.updated', task, { kind: 'member', id: ROUTINE_ACTOR })
  return true
}

async function cancelControlFlight(env: Env, run: Pick<RunContext, 'flight_id' | 'project_id'>): Promise<{
  stopped: boolean
  /** True only when no live flight existed or it was already terminal before failFlight. */
  confirmable: boolean
}> {
  if (!run.flight_id) return { stopped: true, confirmable: true }
  const flight = await getFlight(env, run.flight_id)
  if (!flight || flight.project_id !== run.project_id) return { stopped: false, confirmable: false }
  if (flight.status === 'failed') {
    return { stopped: true, confirmable: flight.gate_reason !== 'routine_cancelled' }
  }
  if (flight.status === 'held') return { stopped: true, confirmable: true }
  if (flight.status === 'landed') return { stopped: false, confirmable: false }
  // Best-effort DB fail — local status change is NOT a runtime acknowledgement.
  await failFlight(env, flight.id, 'routine_cancelled')
  const current = await getFlight(env, flight.id)
  return { stopped: current?.status === 'failed', confirmable: false }
}

function storedActionResult(run: RunContext, action: ActionRow, duplicate: boolean): RoutineActionResult | null {
  if (action.status === 'succeeded' && action.result_json) {
    return {
      ok: true, status: 'succeeded', run_id: run.id, action_key: action.action_key,
      result: JSON.parse(action.result_json) as Record<string, unknown>, duplicate,
    }
  }
  if (action.status === 'failed') {
    if (run.status === 'queued' && run.retry_at) {
      return {
        ok: true, status: 'retry_scheduled', reason: 'execution_failed',
        run_id: run.id, action_key: action.action_key, duplicate,
      }
    }
    return { ok: false, error: 'action_failed' }
  }
  return null
}

async function classifyActionFailure(
  env: Env,
  run: RunContext,
  policy: RoutinePolicySnapshot,
  action: ActionRow,
  reason: string,
): Promise<RoutineActionResult> {
  const now = new Date().toISOString()
  const retryAt = run.attempt < policy.max_attempts
    ? new Date(Date.now() + policy.retry_backoff_seconds * 1000).toISOString()
    : null
  const resultJson = canonicalJson({ reason, attempt: run.attempt, retry_at: retryAt })
  const eventKind = retryAt ? 'retry_scheduled' : 'failed'
  const runStatus = retryAt ? 'queued' : 'failed'
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_run_actions
          SET status = 'failed', result_json = ?, receipt_id = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
               AND ${sqlNotCancellationPending('routine_runs')}
          )`,
    ).bind(resultJson, action.id, now, action.id, run.tenant, run.id, run.tenant),
    env.DB.prepare(
      `UPDATE routine_runs
          SET status = ?, waiting_reason = NULL, retry_at = ?, result_summary = ?,
              proposal_json = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
          AND ${sqlNotCancellationPending('routine_runs')}
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'failed'
               AND receipt_id = ? AND result_json = ?
          )`,
    ).bind(
      runStatus, retryAt, reason, retryAt ? null : now, now, run.id, run.tenant,
      action.id, run.tenant, action.id, resultJson,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, ?, 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = ? AND updated_at = ?
         AND EXISTS (
           SELECT 1 FROM routine_run_actions
            WHERE id = ? AND tenant = ? AND status = 'failed' AND result_json = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = ?
              AND json_extract(e.metadata_json, '$.action_key') = ?
              AND CAST(json_extract(e.metadata_json, '$.attempt') AS INTEGER) = ?
         )`,
    ).bind(
      crypto.randomUUID(), eventKind, ROUTINE_ACTOR, now,
      JSON.stringify({ action_key: action.action_key, reason, retry_at: retryAt, attempt: run.attempt }),
      run.id, run.tenant, runStatus, now, action.id, run.tenant, resultJson,
      eventKind, action.action_key, run.attempt,
    ),
  ])
  if (wrote(outcomes[0]) && wrote(outcomes[1]) && wrote(outcomes[2])) {
    return retryAt
      ? { ok: true, status: 'retry_scheduled', reason: 'execution_failed', run_id: run.id, action_key: action.action_key, duplicate: false }
      : { ok: false, error: 'action_failed' }
  }
  const [currentRun, currentAction] = await Promise.all([
    loadRun(env, run.id),
    loadAction(env, run.id, action.action_key),
  ])
  if (currentRun && currentAction) {
    const stored = storedActionResult(currentRun, currentAction, true)
    if (stored) return stored
  }
  return { ok: false, error: 'receipt_failed' }
}

async function finishAction(
  env: Env,
  run: RunContext,
  action: ActionRow,
  result: Record<string, unknown>,
  ref?: { type: 'task' | 'flight'; id: string },
): Promise<RoutineActionResult> {
  const now = new Date().toISOString()
  const resultJson = canonicalJson(result)
  const statements = [
    env.DB.prepare(
      `UPDATE routine_run_actions SET status = 'succeeded', result_json = ?,
              receipt_id = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
               AND ${sqlNotCancellationPending('routine_runs')}
          )`,
    ).bind(resultJson, action.id, now, action.id, run.tenant, run.id, run.tenant),
    ...(ref ? [env.DB.prepare(
      `INSERT INTO routine_run_refs
        (id, tenant, project_id, run_id, ref_type, ref_id, relation, created_at)
       SELECT ?, tenant, project_id, id, ?, ?, 'action_result', ?
         FROM routine_runs
        WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'succeeded'
               AND receipt_id = ? AND result_json = ?
          )
       ON CONFLICT (run_id, ref_type, ref_id, relation) DO NOTHING`,
    ).bind(
      crypto.randomUUID(), ref.type, ref.id, now, run.id, run.tenant,
      action.id, run.tenant, action.id, resultJson,
    )] : []),
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'succeeded', waiting_reason = NULL,
              result_summary = ?, cost_micro_usd = (
                SELECT COALESCE(SUM(f.cost_micro_usd), 0)
                  FROM flights f
                 WHERE f.tenant = routine_runs.tenant AND (
                   f.id = routine_runs.flight_id OR f.id IN (
                     SELECT ref_id FROM routine_run_refs
                      WHERE run_id = routine_runs.id AND ref_type = 'flight'
                   )
                 )
              ), finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'succeeded'
               AND receipt_id = ? AND result_json = ?
          )`,
    ).bind(
      JSON.stringify(result).slice(0, 4000), now, now, run.id, run.tenant,
      action.id, run.tenant, action.id, resultJson,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'action_completed', 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'succeeded' AND finished_at = ?
         AND EXISTS (
           SELECT 1 FROM routine_run_actions
            WHERE id = ? AND tenant = ? AND status = 'succeeded'
              AND receipt_id = ? AND result_json = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = 'action_completed'
              AND json_extract(e.metadata_json, '$.action_key') = ?
         )`,
    ).bind(
      crypto.randomUUID(), ROUTINE_ACTOR, now, JSON.stringify({ action_key: action.action_key, result }),
      run.id, run.tenant, now, action.id, run.tenant, action.id, resultJson, action.action_key,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'succeeded', 'system', ?, ?, ?, id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'succeeded' AND finished_at = ?
         AND EXISTS (
           SELECT 1 FROM routine_run_actions
            WHERE id = ? AND tenant = ? AND status = 'succeeded'
              AND receipt_id = ? AND result_json = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = 'succeeded'
         )`,
    ).bind(
      crypto.randomUUID(), ROUTINE_ACTOR, now, JSON.stringify({ action_key: action.action_key, result }),
      run.id, run.tenant, now, action.id, run.tenant, action.id, resultJson,
    ),
  ]
  const outcomes = await env.DB.batch(statements)
  const runIndex = ref ? 2 : 1
  const actionEventIndex = runIndex + 1
  const succeededEventIndex = actionEventIndex + 1
  if (wrote(outcomes[0]) && wrote(outcomes[runIndex]) && wrote(outcomes[actionEventIndex]) && wrote(outcomes[succeededEventIndex])) {
    return {
      ok: true, status: 'succeeded', run_id: run.id, action_key: action.action_key,
      result, duplicate: false,
    }
  }
  const [currentRun, currentAction] = await Promise.all([
    loadRun(env, run.id),
    loadAction(env, run.id, action.action_key),
  ])
  if (currentRun && currentAction) {
    const stored = storedActionResult(currentRun, currentAction, true)
    if (stored) return stored
  }
  return { ok: false, error: 'receipt_failed' }
}

export async function executeRoutineAction(
  env: Env,
  runId: string,
  actionKey: string,
): Promise<RoutineActionResult> {
  const run = await loadRun(env, runId)
  if (!run) return { ok: false, error: 'run_not_found' }
  if (await isCancellationPending(env, run.id, run.tenant)) return { ok: false, error: 'receipt_failed' }
  const policy = parsePolicy(run.policy_json)
  if (!policy) return { ok: false, error: 'invalid_policy' }
  let action = await loadAction(env, run.id, actionKey)
  if (!action) return { ok: false, error: 'action_not_found' }
  const stored = storedActionResult(run, action, true)
  if (stored) return stored
  if (!run.proposal_json) return { ok: false, error: 'receipt_failed' }
  const storedProposal = parseRoutineProposal(JSON.parse(run.proposal_json) as unknown)
  if (!storedProposal.ok || storedProposal.value.action.key !== action.action_key) {
    return { ok: false, error: 'receipt_failed' }
  }
  const typedAction = storedProposal.value.action
  if (action.status !== 'running') {
    if (run.project_status !== 'active') return { ok: false, error: 'project_not_active' }
    if (await currentSituationDigest(env, run, policy) !== run.situation_digest) {
      await queueStaleObservation(env, run)
      const [racedRun, racedAction] = await Promise.all([
        loadRun(env, run.id),
        loadAction(env, run.id, action.action_key),
      ])
      if (racedRun && racedAction) {
        const racedResult = storedActionResult(racedRun, racedAction, true)
        if (racedResult) return racedResult
        if (racedAction.status === 'running') {
          return executeRoutineAction(env, run.id, action.action_key)
        }
      }
      return { ok: false, error: 'stale_situation' }
    }
    const scopeError = await validateActionScope(env, run, policy, typedAction)
    if (scopeError === 'budget_exceeded') return { ok: false, error: 'budget_exceeded' }
    if (scopeError) return { ok: false, error: 'reference_out_of_scope' }
  }
  if (action.gate_status === 'pending') {
    const verdict = await approvedGate(env, action)
    if (!verdict) return { ok: false, error: 'approval_required' }
    if (verdict === 'rejected') {
      const now = new Date().toISOString()
      const rejectionReceipt = crypto.randomUUID()
      const outcomes = await env.DB.batch([
        env.DB.prepare(
          `UPDATE routine_run_actions
              SET gate_status = 'rejected', status = 'cancelled', receipt_id = ?,
                  result_json = json_object('reason', 'proposal_rejected'), updated_at = ?
            WHERE id = ? AND tenant = ? AND gate_status = 'pending' AND status = 'waiting'
              AND EXISTS (
                SELECT 1 FROM routine_runs
                 WHERE id = ? AND tenant = ? AND status = 'waiting' AND waiting_reason = 'review'
              )`,
        ).bind(rejectionReceipt, now, action.id, run.tenant, run.id, run.tenant),
        env.DB.prepare(
          `UPDATE routine_runs SET status = 'cancelled', waiting_reason = NULL,
                  result_summary = 'proposal_rejected', finished_at = ?, updated_at = ?
            WHERE id = ? AND tenant = ? AND status = 'waiting' AND waiting_reason = 'review'
              AND EXISTS (
                SELECT 1 FROM routine_run_actions
                 WHERE id = ? AND tenant = ? AND status = 'cancelled' AND receipt_id = ?
              )`,
        ).bind(now, now, run.id, run.tenant, action.id, run.tenant, rejectionReceipt),
        env.DB.prepare(
          `INSERT INTO routine_run_events (
            id, tenant, project_id, run_id, kind, actor_type, actor_id,
            occurred_at, metadata_json, correlation_id
          )
          SELECT ?, tenant, project_id, id, 'cancelled', 'system', ?, ?, ?, id
            FROM routine_runs
           WHERE id = ? AND tenant = ? AND status = 'cancelled' AND finished_at = ?
             AND EXISTS (
               SELECT 1 FROM routine_run_actions
                WHERE id = ? AND tenant = ? AND status = 'cancelled' AND receipt_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM routine_run_events e
                WHERE e.run_id = routine_runs.id AND e.kind = 'cancelled'
             )`,
        ).bind(
          crypto.randomUUID(), ROUTINE_ACTOR, now,
          JSON.stringify({ action_key: action.action_key, reason: 'proposal_rejected' }),
          run.id, run.tenant, now, action.id, run.tenant, rejectionReceipt,
        ),
      ])
      if (outcomes.some(outcome => !wrote(outcome))) {
        const raced = await loadAction(env, run.id, action.action_key)
        if (raced?.status !== 'cancelled') return { ok: false, error: 'receipt_failed' }
      }
      return { ok: false, error: 'approval_required' }
    }
    await env.DB.prepare(
      `UPDATE routine_run_actions SET gate_status = 'approved', status = 'pending',
              receipt_id = NULL, updated_at = ?
        WHERE id = ? AND tenant = ? AND gate_status = 'pending'`,
    ).bind(new Date().toISOString(), action.id, run.tenant).run()
    action = { ...action, gate_status: 'approved', status: 'pending' }
  }
  if (action.kind === 'ask_human' && action.status === 'waiting') {
    return { ok: false, error: 'action_waiting' }
  }
  if (action.status !== 'running') {
    const startedAt = new Date().toISOString()
    const outcomes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE routine_run_actions SET status = 'running', updated_at = ?
          WHERE id = ? AND tenant = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM routine_runs
               WHERE id = ? AND tenant = ? AND status IN ('running','waiting')
                 AND ${sqlNotCancellationPending('routine_runs')}
            )`,
      ).bind(startedAt, action.id, run.tenant, run.id, run.tenant),
      env.DB.prepare(
        `INSERT INTO routine_run_events (
          id, tenant, project_id, run_id, kind, actor_type, actor_id,
          occurred_at, metadata_json, correlation_id
        )
        SELECT ?, rr.tenant, rr.project_id, rr.id, 'action_started', 'system', ?, ?, ?, rr.id
          FROM routine_runs rr
          JOIN routine_run_actions a ON a.run_id = rr.id AND a.tenant = rr.tenant
         WHERE rr.id = ? AND rr.tenant = ? AND rr.status IN ('running','waiting')
           AND a.id = ? AND a.status = 'running' AND a.updated_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM routine_run_events e
              WHERE e.run_id = rr.id AND e.kind = 'action_started'
                AND json_extract(e.metadata_json, '$.action_key') = ?
                AND CAST(json_extract(e.metadata_json, '$.attempt') AS INTEGER) = ?
           )`,
      ).bind(
        crypto.randomUUID(), ROUTINE_ACTOR, startedAt,
        JSON.stringify({ action_key: action.action_key, attempt: run.attempt }),
        run.id, run.tenant, action.id, startedAt, action.action_key, run.attempt,
      ),
    ])
    if (!wrote(outcomes[0])) {
      const [racedRun, racedAction] = await Promise.all([
        loadRun(env, run.id),
        loadAction(env, run.id, action.action_key),
      ])
      if (racedRun && racedAction) {
        const racedResult = storedActionResult(racedRun, racedAction, true)
        if (racedResult) return racedResult
        if (racedAction.status === 'running') action = racedAction
        else return { ok: false, error: 'receipt_failed' }
      } else {
        return { ok: false, error: 'receipt_failed' }
      }
    } else if (!wrote(outcomes[1])) {
      return classifyActionFailure(env, run, policy, { ...action, status: 'running' }, 'receipt_failed')
    } else {
      action = { ...action, status: 'running' }
    }
  }

  try {
    let result: Record<string, unknown>
    let ref: { type: 'task' | 'flight'; id: string } | undefined
    if (typedAction.kind === 'create_task') {
      const task = await ensureActionTask(env, run, policy, typedAction, action.id)
      result = { task_id: task.id }
      ref = { type: 'task', id: task.id }
    } else if (typedAction.kind === 'dispatch_flight') {
      const flight = await executeFlightAction(env, run, policy, typedAction, action.id)
      if (!flight.ok) return classifyActionFailure(env, run, policy, action, flight.reason)
      result = { flight_id: flight.id }
      ref = { type: 'flight', id: flight.id }
    } else if (typedAction.kind === 'request_review') {
      result = {
        reviewed_source_type: typedAction.input.source_type,
        reviewed_source_id: typedAction.input.source_id,
      }
    } else if (typedAction.kind === 'ask_human') {
      return { ok: false, error: 'action_waiting' }
    } else if (typedAction.kind === 'project_access') {
      // Reached only after the gate-approved branch above generically
      // flipped action.gate_status 'pending' -> 'approved' — that flip is
      // NOT sufficient authorization for this privileged effect (see
      // approvedGate's own doc comment above). resolveProposalVerdict is
      // the REAL gate here: bound to THIS proposal (action.id), fresh
      // (postdates action.created_at), and not reversed. P0-3: the verdict
      // must also have been cast by a human — an agent's own gate:routines
      // capability approving the control task is not "member builds, human
      // gates" (see ADVERSARIAL PATTERN LIBRARY finding 3, kasra-review
      // 2026-09-21, PR #1488). Both checks fail closed with a typed,
      // receipt-less refusal — no project_access_grant_receipts row is ever
      // written on either path.
      const verdict = await resolveProposalVerdict(env, action)
      if (!verdict || verdict.verdict !== 'approved') {
        return classifyActionFailure(env, run, policy, action, 'verdict_not_found')
      }
      if (!(await verdictIsHuman(env, verdict, run.tenant))) {
        return classifyActionFailure(env, run, policy, action, 'rejected_non_human_verdict')
      }
      const homeSquad = await getMemberHomeSquad(env, typedAction.input.member_id)
      if (!homeSquad) {
        return classifyActionFailure(env, run, policy, action, 'member_home_not_found')
      }
      const grant = await executeProjectAccessGrant(env, {
        projectId: typedAction.input.project_id,
        squadId: homeSquad.id,
        memberId: typedAction.input.member_id,
        accessLevel: typedAction.input.access_level,
        proposalId: action.id,
        verdictId: verdict.id,
        decidedBy: verdict.decided_by,
        decidedVia: verdict.decided_via,
      })
      if (!grant.ok) {
        return classifyActionFailure(env, run, policy, action, grant.error)
      }
      result = {
        project_id: typedAction.input.project_id,
        member_id: typedAction.input.member_id,
        squad_id: homeSquad.id,
        access_level: typedAction.input.access_level,
        proposal_id: action.id,
        verdict_id: verdict.id,
        grant_receipt_id: grant.value.id,
      }
    } else {
      result = { no_action: true, reason: typedAction.input.reason }
    }
    await completeControlTask(env, run)
    await landControlFlight(env, run)
    return await finishAction(env, run, action, result, ref)
  } catch {
    return classifyActionFailure(env, run, policy, action, 'execution_failed')
  }
}

export async function getRoutinePendingQuestion(
  env: Env,
  principal: RoutinePrincipal,
  runId: string,
): Promise<RoutinePendingQuestion | null> {
  const run = await loadRun(env, runId)
  if (!run || run.status !== 'waiting' || run.waiting_reason !== 'answer') return null
  if (principal.actor_type !== 'member' || !await principalCanReadProject(env, principal, run.project_id)) return null
  const policy = parsePolicy(run.policy_json)
  if (!policy || !await principalCanRunForSquad(env, principal, run.project_id, policy.responsible_squad_id)) return null
  const action = await loadHumanAction(env, run.id)
  return action?.status === 'waiting' ? pendingQuestion(action) : null
}

export interface RoutineProjectAccessRequest {
  member_id: string
  member_name: string | null
  project_id: string
  project_name: string
  access_level: 'read' | 'write' | 'admin'
  reason: string
}

// getRoutineProjectAccessRequest — FP-01 Slice 2 v2 (successor to PR #1488,
// P1-6): the human decision surface (IM /needs, src/im/index.ts's
// needsReply) must show WHAT is being decided before /approve is possible.
// Mirrors getRoutinePendingQuestion's shape/gating exactly (member-principal
// only, principalCanReadProject-gated) but keyed on the CONTROL TASK id
// (item.source_id for a 'task'-sourced /needs row), not a run id — a
// project_access proposal surfaces on /needs as an ordinary gated task, so
// the caller (needsReply) has the task id, not the run id, in hand.
export async function getRoutineProjectAccessRequest(
  env: Env,
  principal: RoutinePrincipal,
  taskId: string,
): Promise<RoutineProjectAccessRequest | null> {
  if (principal.actor_type !== 'member') return null
  const runRow = await env.DB.prepare(
    `SELECT id FROM routine_runs WHERE task_id = ? AND tenant = ? LIMIT 1`,
  ).bind(taskId, env.TENANT_SLUG).first<{ id: string }>()
  if (!runRow) return null
  const run = await loadRun(env, runRow.id)
  if (!run || !await principalCanReadProject(env, principal, run.project_id)) return null
  const action = await env.DB.prepare(
    `SELECT input_json FROM routine_run_actions
      WHERE run_id = ? AND tenant = ? AND kind = 'project_access' AND status = 'waiting' AND gate_status = 'pending'
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).bind(run.id, run.tenant).first<{ input_json: string }>()
  if (!action) return null
  let input: { member_id: string; project_id: string; access_level: 'read' | 'write' | 'admin'; reason: string }
  try {
    input = JSON.parse(action.input_json)
  } catch {
    return null
  }
  const [member, project] = await Promise.all([
    env.DB.prepare('SELECT display_name FROM members WHERE id = ?').bind(input.member_id).first<{ display_name: string }>(),
    env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(input.project_id).first<{ name: string }>(),
  ])
  return {
    member_id: input.member_id,
    member_name: member?.display_name ?? null,
    project_id: input.project_id,
    project_name: project?.name ?? input.project_id,
    access_level: input.access_level,
    reason: input.reason,
  }
}

export async function answerRoutineRun(
  env: Env,
  principal: RoutinePrincipal,
  runId: string,
  rawAnswer: unknown,
): Promise<RoutineAnswerResult> {
  const run = await loadRun(env, runId)
  if (!run || !await principalCanReadProject(env, principal, run.project_id)) {
    return { ok: false, error: 'run_not_found' }
  }
  if (principal.actor_type !== 'member') return { ok: false, error: 'forbidden' }
  const policy = parsePolicy(run.policy_json)
  if (!policy || !await principalCanRunForSquad(env, principal, run.project_id, policy.responsible_squad_id)) {
    return { ok: false, error: 'forbidden' }
  }
  const answer = typeof rawAnswer === 'string' ? rawAnswer.trim() : ''
  if (answer.length < 1 || new TextEncoder().encode(answer).byteLength > 4000) {
    return { ok: false, error: 'invalid_answer' }
  }
  const action = await loadHumanAction(env, run.id)
  if (!action) return { ok: false, error: 'answer_not_found' }
  const question = pendingQuestion(action)
  if (!question || (question.choices.length > 0 && !question.choices.includes(answer))) {
    return { ok: false, error: 'invalid_answer' }
  }
  if (action.status === 'succeeded' && action.result_json) {
    try {
      const stored = JSON.parse(action.result_json) as Record<string, unknown>
      return stored.answer === answer
        ? { ok: true, run_id: run.id, duplicate: true }
        : { ok: false, error: 'answer_conflict' }
    } catch {
      return { ok: false, error: 'receipt_failed' }
    }
  }
  if (['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status)) {
    return { ok: false, error: 'run_terminal' }
  }
  if (run.status !== 'waiting' || run.waiting_reason !== 'answer' || action.status !== 'waiting') {
    return { ok: false, error: 'answer_not_found' }
  }
  if (run.attempt >= policy.max_attempts) return { ok: false, error: 'retry_exhausted' }

  try {
    await completeControlTask(env, run)
    await landControlFlight(env, run)
  } catch {
    return { ok: false, error: 'receipt_failed' }
  }

  const now = new Date().toISOString()
  const receiptId = crypto.randomUUID()
  const resultJson = canonicalJson({ answer, answered_by: principal.actor_id })
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_run_actions
          SET status = 'succeeded', result_json = ?, receipt_id = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'waiting' AND kind = 'ask_human'
          AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE id = ? AND tenant = ? AND status = 'waiting' AND waiting_reason = 'answer'
               AND ${sqlNotCancellationPending('routine_runs')}
          )`,
    ).bind(resultJson, receiptId, now, action.id, run.tenant, run.id, run.tenant),
    env.DB.prepare(
      `UPDATE routine_runs
          SET status = 'queued', waiting_reason = NULL, lease_owner = NULL,
              lease_expires_at = NULL, retry_at = NULL, task_id = NULL, flight_id = NULL,
              situation_digest = NULL, proposal_json = NULL, result_summary = 'human_answered',
              finished_at = NULL, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'waiting' AND waiting_reason = 'answer'
          AND ${sqlNotCancellationPending('routine_runs')}
          AND EXISTS (
            SELECT 1 FROM routine_run_actions
             WHERE id = ? AND tenant = ? AND status = 'succeeded'
               AND receipt_id = ? AND result_json = ?
          )`,
    ).bind(now, run.id, run.tenant, action.id, run.tenant, receiptId, resultJson),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
         id, tenant, project_id, run_id, kind, actor_type, actor_id,
         occurred_at, metadata_json, correlation_id
       ) SELECT ?, tenant, project_id, id, 'action_completed', 'member', ?, ?, ?, id
           FROM routine_runs
          WHERE id = ? AND tenant = ? AND status = 'queued' AND updated_at = ?
            AND EXISTS (
              SELECT 1 FROM routine_run_actions
               WHERE id = ? AND tenant = ? AND status = 'succeeded' AND receipt_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM routine_run_events e
               WHERE e.run_id = routine_runs.id AND e.tenant = routine_runs.tenant
                 AND e.kind = 'action_completed'
                 AND json_extract(e.metadata_json, '$.action_key') = ?
                 AND json_extract(e.metadata_json, '$.reason') = 'human_answered'
            )`,
    ).bind(
      crypto.randomUUID(), principal.actor_id, now,
      JSON.stringify({ action_key: action.action_key, reason: 'human_answered' }),
      run.id, run.tenant, now, action.id, run.tenant, receiptId, action.action_key,
    ),
  ])
  if (outcomes.every(wrote)) return { ok: true, run_id: run.id, duplicate: false }
  const raced = await loadHumanAction(env, run.id)
  if (raced?.status === 'succeeded' && raced.result_json) {
    try {
      const stored = JSON.parse(raced.result_json) as Record<string, unknown>
      if (stored.answer === answer) return { ok: true, run_id: run.id, duplicate: true }
      return { ok: false, error: 'answer_conflict' }
    } catch {
      return { ok: false, error: 'receipt_failed' }
    }
  }
  return { ok: false, error: 'receipt_failed' }
}

/** Cancel an accessible nonterminal run and record durable cancellation receipts. */
export async function cancelRoutineRun(
  env: Env,
  principal: RoutinePrincipal,
  runId: string,
): Promise<RoutineCancellationResult> {
  if (principal.tenant !== env.TENANT_SLUG) return { ok: false, error: 'run_not_found' }
  const visibility = projectVisibilityClause(principal.project_read)
  const run = await env.DB.prepare(
    `SELECT rr.id, rr.tenant, rr.project_id, rr.status, rr.task_id, rr.flight_id
       FROM routine_runs rr JOIN projects p ON p.id = rr.project_id
      WHERE rr.id = ? AND rr.tenant = ? AND ${visibility.sql}`,
  ).bind(runId, env.TENANT_SLUG, ...visibility.binds).first<{
    id: string; tenant: string; project_id: string; status: string; task_id: string | null; flight_id: string | null
  }>()
  if (!run) return { ok: false, error: 'run_not_found' }
  if (principal.actor_type !== 'member' || !principal.workspace_admin) return { ok: false, error: 'forbidden' }
  const now = new Date().toISOString()
  const existingOutcome = await loadCancellationOutcome(env, run.id, run.tenant)
  if (existingOutcome) {
    return { ok: true, run_id: run.id, duplicate: true, outcome: cancellationOutcome(existingOutcome) }
  }
  const existingRequest = await hasCancellationRequest(env, run.id, run.tenant)
  if (['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status)) {
    if (existingRequest) {
      const outcome = await recordTerminalCancellationOutcome(env, principal, run.id, run.tenant, now)
      if (outcome) {
        return { ok: true, run_id: run.id, duplicate: true, outcome: cancellationOutcome(outcome) }
      }
      return { ok: false, error: 'receipt_failed' }
    }
    if (run.status === 'cancelled') return { ok: false, error: 'receipt_failed' }
    return { ok: false, error: 'run_terminal' }
  }

  const requested = await env.DB.prepare(
    `INSERT INTO routine_run_events (
       id, tenant, project_id, run_id, kind, actor_type, actor_id, occurred_at, metadata_json, correlation_id
     ) SELECT ?, tenant, project_id, id, 'cancellation_requested', ?, ?, ?, ?, id
         FROM routine_runs
        WHERE id = ? AND tenant = ?
          AND status IN ('queued','leased','observing','waiting','running')
          AND NOT EXISTS (
            SELECT 1 FROM routine_run_events e
             WHERE e.run_id = routine_runs.id AND e.tenant = routine_runs.tenant
               AND e.kind = 'cancellation_requested'
          )`,
  ).bind(
    crypto.randomUUID(), principal.actor_type, principal.actor_id, now,
    JSON.stringify({ reason: 'operator_cancelled' }), run.id, run.tenant,
  ).run()

  if (!wrote(requested)) {
    const racedOutcome = await loadCancellationOutcome(env, run.id, run.tenant)
    if (racedOutcome) {
      return {
        ok: true,
        run_id: run.id,
        duplicate: true,
        outcome: cancellationOutcome(racedOutcome),
      }
    }
    if (!await hasCancellationRequest(env, run.id, run.tenant)) {
      const current = await env.DB.prepare(
        'SELECT status FROM routine_runs WHERE id = ? AND tenant = ?',
      ).bind(run.id, run.tenant).first<{ status: string }>()
      if (current && ['succeeded', 'failed', 'skipped', 'cancelled'].includes(current.status)) {
        return { ok: false, error: 'run_terminal' }
      }
      return { ok: false, error: 'receipt_failed' }
    }
    // Request-only state: resume reconciliation below.
  }

  // Re-read children after the durable fence so confirmation cannot use a stale snapshot.
  // Resolve deterministic dispatch Task/Flight IDs only when those rows already exist
  // (create-before-observe race under the cancellation fence).
  const live = await env.DB.prepare(
    `SELECT id, tenant, project_id, status, attempt, task_id, flight_id
       FROM routine_runs WHERE id = ? AND tenant = ?`,
  ).bind(run.id, run.tenant).first<{
    id: string; tenant: string; project_id: string; status: string; attempt: number
    task_id: string | null; flight_id: string | null
  }>()
  if (!live) return { ok: false, error: 'run_not_found' }
  if (['succeeded', 'failed', 'skipped', 'cancelled'].includes(live.status)) {
    const racedOutcome = await recordTerminalCancellationOutcome(env, principal, live.id, live.tenant, now)
    if (racedOutcome) {
      return { ok: true, run_id: live.id, duplicate: true, outcome: cancellationOutcome(racedOutcome) }
    }
    return { ok: false, error: 'receipt_failed' }
  }

  let taskId = live.task_id
  let flightId = live.flight_id
  if (!taskId) {
    const candidate = await routineControlId('task', `${live.id}:${live.attempt}`)
    const existing = await loadTask(env, candidate)
    if (existing && existing.project_id === live.project_id) taskId = candidate
  }
  if (!flightId) {
    const candidate = await routineControlId('flight', `${live.id}:${live.attempt}`)
    const existing = await getFlight(env, candidate)
    if (existing && existing.project_id === live.project_id) flightId = candidate
  }
  const children = { project_id: live.project_id, task_id: taskId, flight_id: flightId }

  const runningAction = await env.DB.prepare(
    "SELECT 1 FROM routine_run_actions WHERE run_id = ? AND tenant = ? AND status = 'running' LIMIT 1",
  ).bind(live.id, live.tenant).first()
  const deliveredMessage = await env.DB.prepare(
    `SELECT 1 FROM agent_messages
      WHERE tenant = ? AND project_id = ? AND from_agent = ?
        AND (request_id = ? OR instr(request_id, ? || ':attempt:') = 1)
      LIMIT 1`,
  ).bind(
    live.tenant, live.project_id, ROUTINE_ACTOR,
    `routine-run:${live.id}`, `routine-run:${live.id}`,
  ).first()
  const taskConfirmed = await cancelControlTask(env, children)
  const flightCancel = await cancelControlFlight(env, children)
  // A delivered inbox request is external work unless the runtime supplies an acknowledgement.
  const outcome =
    runningAction === null && deliveredMessage === null && taskConfirmed && flightCancel.confirmable
      ? 'confirmed'
      : 'unconfirmed'
  const terminalStatus = outcome === 'confirmed' ? 'cancelled' : 'failed'
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs
          SET status = ?, waiting_reason = NULL, lease_owner = NULL, lease_expires_at = NULL,
              retry_at = NULL, result_summary = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant = ?
          AND status IN ('queued','leased','observing','waiting','running')`,
    ).bind(terminalStatus, `cancellation_${outcome}`, now, now, live.id, live.tenant),
    env.DB.prepare(
      `UPDATE routine_run_actions
          SET status = 'cancelled', updated_at = ?
        WHERE run_id = ? AND tenant = ? AND status IN ('pending','waiting','running')`,
    ).bind(now, live.id, live.tenant),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
         id, tenant, project_id, run_id, kind, actor_type, actor_id, occurred_at, metadata_json, correlation_id
       ) SELECT ?, tenant, project_id, id, ?, ?, ?, ?, ?, id
           FROM routine_runs
          WHERE id = ? AND tenant = ? AND status = ? AND finished_at = ?
            AND NOT EXISTS (
              SELECT 1 FROM routine_run_events e
               WHERE e.run_id = routine_runs.id AND e.tenant = routine_runs.tenant
                 AND e.kind IN ('cancellation_confirmed','cancellation_unconfirmed')
            )`,
    ).bind(
      crypto.randomUUID(), `cancellation_${outcome}`, principal.actor_type, principal.actor_id, now,
      JSON.stringify({
        reason: 'operator_cancelled',
        task_confirmed: taskConfirmed,
        flight_stopped: flightCancel.stopped,
        flight_confirmable: flightCancel.confirmable,
        message_delivered: deliveredMessage !== null,
        action_claimed: runningAction !== null,
      }),
      live.id, live.tenant, terminalStatus, now,
    ),
  ])
  if (wrote(outcomes[0]) && wrote(outcomes[2])) {
    return { ok: true, run_id: live.id, duplicate: !wrote(requested), outcome }
  }

  const [current, event] = await Promise.all([
    env.DB.prepare('SELECT status FROM routine_runs WHERE id = ? AND tenant = ?').bind(live.id, live.tenant).first<{ status: string }>(),
    loadCancellationOutcome(env, live.id, live.tenant),
  ])
  if (event) {
    return { ok: true, run_id: live.id, duplicate: true, outcome: cancellationOutcome(event) }
  }
  if (current && ['succeeded', 'failed', 'skipped', 'cancelled'].includes(current.status)) {
    const racedOutcome = await recordTerminalCancellationOutcome(env, principal, live.id, live.tenant, now)
    if (racedOutcome) {
      return { ok: true, run_id: live.id, duplicate: true, outcome: cancellationOutcome(racedOutcome) }
    }
  }
  return { ok: false, error: 'receipt_failed' }
}

export async function submitRoutineProposal(
  env: Env,
  principal: RoutinePrincipal,
  rawProposal: unknown,
): Promise<RoutineProposalResult> {
  const parsed = parseRoutineProposal(rawProposal)
  if (!parsed.ok) return { ok: false, error: 'invalid_proposal' }
  const proposal = parsed.value
  const run = await loadRun(env, proposal.run_id)
  if (!run) return { ok: false, error: 'run_not_found' }
  if (principal.tenant !== env.TENANT_SLUG || !await principalCanReadProject(env, principal, run.project_id)) {
    return { ok: false, error: 'run_not_found' }
  }
  const policy = parsePolicy(run.policy_json)
  if (!policy) return { ok: false, error: 'invalid_policy' }
  // FP-01 Slice 2 v2 (successor to PR #1488, P0-1): project_access is the
  // one action kind whose executed effect is a standing privilege grant, so
  // it may only ever be proposed under a policy that routes EVERY action
  // through the human-review gate. Refusing at submit time — before
  // reserveAction ever inserts the routine_run_actions row — means an
  // 'execute_internal' (or any future non-'propose') policy can never even
  // reserve one of these, closing the class the adversarial gate proved
  // live: execute_internal + a pre-existing approved verdict on the control
  // task landed a grant with gate_status='not_required', zero human review.
  if (proposal.action.kind === 'project_access' && policy.execution_mode !== 'propose') {
    return { ok: false, error: 'execution_mode_forbidden_for_kind' }
  }
  if (!await principalCanRunForSquad(env, principal, run.project_id, policy.responsible_squad_id)) {
    return { ok: false, error: 'forbidden' }
  }
  if (principal.tenant !== env.TENANT_SLUG || principal.actor_type !== 'agent') {
    return { ok: false, error: 'forbidden' }
  }
  if (principal.actor_id !== run.assigned_agent_id) return { ok: false, error: 'assigned_agent_mismatch' }
  if (proposal.run_id !== run.id) return { ok: false, error: 'run_mismatch' }
  if (proposal.project_id !== run.project_id) return { ok: false, error: 'project_mismatch' }
  if (proposal.situation_digest !== run.situation_digest) return { ok: false, error: 'situation_mismatch' }
  const replay = await loadAction(env, run.id, proposal.action.key)
  if (replay) {
    const same = replay.kind === proposal.action.kind
      && canonicalJson(JSON.parse(replay.input_json)) === canonicalJson(proposal.action.input)
    if (!same) return { ok: false, error: 'action_key_conflict' }
    const replayResult = storedActionResult(run, replay, true)
    if (replayResult && !(replay.status === 'failed' && run.status === 'running' && run.proposal_json === null)) {
      return replayResult
    }
    if (replay.status === 'waiting') {
      return replayWaitingAction(env, run, replay)
    }
    if (replay.status === 'running') return executeRoutineAction(env, run.id, replay.action_key)
  }
  if (!['running', 'waiting'].includes(run.status)) return { ok: false, error: 'run_not_accepting_proposal' }
  if (run.project_status !== 'active') return { ok: false, error: 'project_not_active' }
  if (await currentSituationDigest(env, run, policy) !== run.situation_digest) {
    await queueStaleObservation(env, run)
    return { ok: false, error: 'stale_situation' }
  }
  const scopeError = await validateActionScope(env, run, policy, proposal.action)
  if (scopeError) return { ok: false, error: scopeError }
  const reservation = await reserveAction(env, run, proposal)
  if ('error' in reservation) return { ok: false, error: reservation.error }
  const { action, duplicate } = reservation
  const reservedResult = storedActionResult(run, action, true)
  if (reservedResult) return reservedResult
  if (action.status === 'waiting') {
    return replayWaitingAction(env, run, action)
  }
  if (proposal.action.kind === 'no_action') {
    const result = await executeRoutineAction(env, run.id, proposal.action.key)
    return result.ok ? { ...result, duplicate } : result
  }
  // `|| proposal.action.kind === 'project_access'` is defense-in-depth, not
  // reachable in normal operation: the typed refusal above already returns
  // before reserveAction whenever a project_access proposal's policy is not
  // 'propose', so by the time execution reaches this line
  // policy.execution_mode === 'propose' is already true for this kind and
  // the first disjunct already covers it. Kept (per Kasra-core's original
  // brief and Athena's confirming ruling: "always human-gated regardless of
  // execution_mode") so this line stays correct on its own even if a future
  // change adds another path into this function that skips the submit-time
  // refusal — see the successor PR body for why this specific line is
  // intentionally not independently mutation-tested.
  if (
    policy.execution_mode === 'propose'
    || proposal.action.kind === 'request_review'
    || proposal.action.kind === 'project_access'
  ) {
    const result = await waitForHuman(env, run, action, 'review')
    return result.ok ? { ...result, duplicate } : result
  }
  if (proposal.action.kind === 'ask_human') {
    const result = await waitForHuman(env, run, action, 'answer')
    return result.ok ? { ...result, duplicate } : result
  }
  const result = await executeRoutineAction(env, run.id, proposal.action.key)
  return result.ok ? { ...result, duplicate } : result
}
