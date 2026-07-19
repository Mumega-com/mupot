import type { D1Result } from '@cloudflare/workers-types'
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
} from '../tasks/service'
import type { Env, Project, Task } from '../types'
import { projectVisibilityClause } from '../projects/access'
import { principalCanReadProject, principalCanRunForSquad, type RoutinePrincipal } from './access'
import {
  parseRoutineProposal,
  type RoutineProposal,
  type RoutineProposalAction,
  type RoutineProposalReference,
} from './proposal'
import type { RoutinePolicySnapshot } from './types'
import { isCancellationPending, sqlNotCancellationPending } from './cancellation-fence'

const ROUTINE_GATE = 'gate:routines'
const ROUTINE_ACTOR = 'mupot-routines'

type ProposalError =
  | 'invalid_proposal' | 'run_not_found' | 'run_not_accepting_proposal' | 'forbidden'
  | 'assigned_agent_mismatch' | 'run_mismatch' | 'project_mismatch' | 'situation_mismatch'
  | 'stale_situation' | 'invalid_policy' | 'project_not_active' | 'assignee_ineligible'
  | 'reference_out_of_scope' | 'budget_exceeded' | 'action_key_conflict'
  | 'proposal_already_submitted' | 'receipt_failed'

type ActionError =
  | 'run_not_found' | 'action_not_found' | 'approval_required' | 'action_waiting'
  | 'invalid_policy' | 'budget_exceeded' | 'reference_out_of_scope' | 'stale_situation'
  | 'project_not_active' | 'action_failed' | 'receipt_failed'

export type RoutineProposalResult =
  | { ok: true; status: 'waiting'; reason: 'review' | 'answer'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'retry_scheduled'; reason: 'execution_failed'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'succeeded'; run_id: string; action_key: string; result: Record<string, unknown>; duplicate: boolean }
  | { ok: false; error: ProposalError | ActionError }

export type RoutineActionResult =
  | { ok: true; status: 'waiting'; reason: 'review' | 'answer'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'retry_scheduled'; reason: 'execution_failed'; run_id: string; action_key: string; duplicate: boolean }
  | { ok: true; status: 'succeeded'; run_id: string; action_key: string; result: Record<string, unknown>; duplicate: boolean }
  | { ok: false; error: ActionError }

export type RoutineCancellationResult =
  | { ok: true; run_id: string; duplicate: boolean; outcome: 'confirmed' | 'unconfirmed' }
  | { ok: false; error: 'run_not_found' | 'forbidden' | 'run_terminal' | 'receipt_failed' }

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
    created_at: run.project_created_at,
    updated_at: run.project_updated_at,
  }
}

async function loadRun(env: Env, runId: string): Promise<RunContext | null> {
  return env.DB.prepare(
    `SELECT rr.id, rr.tenant, rr.project_id, rr.routine_id, rr.routine_revision,
            rr.policy_json, rr.status, rr.waiting_reason, rr.assigned_agent_id,
            rr.task_id, rr.flight_id, rr.situation_digest, rr.proposal_json,
            rr.cost_micro_usd, rr.attempt, rr.retry_at,
            p.slug AS project_slug, p.name AS project_name,
            p.description AS project_description, p.goal AS project_goal,
            p.status AS project_status, p.parent_project_id, p.target_date,
            p.created_at AS project_created_at, p.updated_at AS project_updated_at
       FROM routine_runs rr JOIN projects p ON p.id = rr.project_id
      WHERE rr.id = ? AND rr.tenant = ?`,
  ).bind(runId, env.TENANT_SLUG).first<RunContext>()
}

async function loadAction(env: Env, runId: string, actionKey: string): Promise<ActionRow | null> {
  return env.DB.prepare(
    `SELECT id, tenant, project_id, run_id, action_key, kind, input_json,
            validation_status, gate_status, status, source_type, source_id,
            receipt_id, result_json
       FROM routine_run_actions WHERE run_id = ? AND action_key = ? AND tenant = ?`,
  ).bind(runId, actionKey, env.TENANT_SLUG).first<ActionRow>()
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
  return null
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
      ])
      if (!wrote(outcomes[0]) || !wrote(outcomes[1]) || !wrote(outcomes[2])) {
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
    ])
  } catch {
    const raced = await loadAction(env, run.id, proposal.action.key)
    if (raced && raced.kind === proposal.action.kind && canonicalJson(JSON.parse(raced.input_json)) === inputJson) {
      return { action: raced, duplicate: true }
    }
    return { error: 'receipt_failed' }
  }
  if (!wrote(outcomes[0]) || !wrote(outcomes[1]) || !wrote(outcomes[2])) {
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
      return { ok: true, status: 'waiting', reason, run_id: run.id, action_key: action.action_key, duplicate: true }
    }
    return { ok: false, error: 'receipt_failed' }
  }
  return { ok: true, status: 'waiting', reason, run_id: run.id, action_key: action.action_key, duplicate: false }
}

async function approvedGate(env: Env, action: ActionRow): Promise<'approved' | 'rejected' | null> {
  if (action.gate_status !== 'pending' || action.source_type !== 'task' || !action.source_id) return null
  const verdict = await env.DB.prepare(
    `SELECT verdict FROM task_verdicts WHERE task_id = ? ORDER BY decided_at DESC, id DESC LIMIT 1`,
  ).bind(action.source_id).first<{ verdict: 'approved' | 'rejected' }>()
  return verdict?.verdict ?? null
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
    `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
            github_issue_url, result, completed_at, gate_owner, created_at, updated_at
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
      `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
              github_issue_url, result, completed_at, gate_owner, created_at, updated_at
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
    `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
            github_issue_url, result, completed_at, gate_owner, created_at, updated_at
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
  if (landed) return
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
  if (flight.status === 'failed' || flight.status === 'held') return { stopped: true, confirmable: true }
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
    const candidate = await deterministicUuid('task', `${live.id}:${live.attempt}`)
    const existing = await loadTask(env, candidate)
    if (existing && existing.project_id === live.project_id) taskId = candidate
  }
  if (!flightId) {
    const candidate = await deterministicUuid('flight', `${live.id}:${live.attempt}`)
    const existing = await getFlight(env, candidate)
    if (existing && existing.project_id === live.project_id) flightId = candidate
  }
  const children = { project_id: live.project_id, task_id: taskId, flight_id: flightId }

  const runningAction = await env.DB.prepare(
    "SELECT 1 FROM routine_run_actions WHERE run_id = ? AND tenant = ? AND status = 'running' LIMIT 1",
  ).bind(live.id, live.tenant).first()
  const deliveredMessage = await env.DB.prepare(
    `SELECT 1 FROM agent_messages
      WHERE tenant = ? AND project_id = ? AND from_agent = ? AND request_id = ?
      LIMIT 1`,
  ).bind(live.tenant, live.project_id, ROUTINE_ACTOR, `routine-run:${live.id}`).first()
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
      return {
        ok: true, status: 'waiting', reason: run.waiting_reason === 'answer' ? 'answer' : 'review',
        run_id: run.id, action_key: replay.action_key, duplicate: true,
      }
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
    return {
      ok: true, status: 'waiting', reason: run.waiting_reason === 'answer' ? 'answer' : 'review',
      run_id: run.id, action_key: action.action_key, duplicate: true,
    }
  }
  if (proposal.action.kind === 'no_action') {
    const result = await executeRoutineAction(env, run.id, proposal.action.key)
    return result.ok ? { ...result, duplicate } : result
  }
  if (policy.execution_mode === 'propose' || proposal.action.kind === 'request_review') {
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
