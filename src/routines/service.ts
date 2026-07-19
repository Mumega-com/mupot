import type { D1Result } from '@cloudflare/workers-types'
import type { Env, Project } from '../types'
import { projectVisibilityClause } from '../projects/access'
import { nextRoutineOccurrence, routineOccurrenceKey, validateRoutineSchedule } from './schedule'
import type {
  Routine,
  RoutineExecutionMode,
  RoutineOverlapPolicy,
  RoutinePolicySnapshot,
  RoutineRun,
  RoutineSchedule,
  RoutineStatus,
  RoutineTriggerKind,
} from './types'
import {
  principalCanReadProject,
  principalCanRunForSquad,
  type RoutinePrincipal,
} from './access'

export type RoutineMutationError =
  | 'forbidden' | 'project_not_found' | 'project_not_active' | 'archived_project'
  | 'routine_not_found' | 'routine_not_enabled' | 'routine_archived' | 'invalid_state'
  | 'invalid_name' | 'invalid_objective' | 'invalid_trigger_fields' | 'invalid_once_at'
  | 'invalid_cron_expression' | 'invalid_timezone' | 'invalid_overlap_policy'
  | 'invalid_execution_mode' | 'invalid_budget' | 'invalid_retry_policy'
  | 'invalid_stop_condition' | 'responsible_squad_forbidden' | 'preferred_agent_ineligible'
  | 'invalid_idempotency_key' | 'invalid_pagination' | 'receipt_failed' | 'schedule_exhausted'

export type RoutineMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoutineMutationError }

export type RoutineRunCreationResult =
  | { ok: true; value: RoutineRun; duplicate: boolean }
  | { ok: false; error: RoutineMutationError }

export interface RoutineCursor {
  timestamp: string
  id: string
}

export type RoutinePage<T> =
  | { ok: true; items: T[]; next_cursor: RoutineCursor | null }
  | { ok: false; error: RoutineMutationError }

export interface CreateRoutineInput {
  project_id?: unknown
  name?: unknown
  objective?: unknown
  trigger_kind?: unknown
  run_once_at?: unknown
  cron_expression?: unknown
  timezone?: unknown
  overlap_policy?: unknown
  execution_mode?: unknown
  responsible_squad_id?: unknown
  preferred_agent_id?: unknown
  budget_micro_usd?: unknown
  max_attempts?: unknown
  retry_backoff_seconds?: unknown
  max_occurrences?: unknown
  stop_at?: unknown
}

export type UpdateRoutineInput = Omit<CreateRoutineInput, 'project_id'>

export interface ListRoutinesInput {
  project_id: string
  status?: RoutineStatus
  limit?: number
  after?: RoutineCursor
}

export interface ListRoutineRunsInput {
  project_id: string
  routine_id?: string
  limit?: number
  after?: RoutineCursor
}

interface NormalizedPolicy {
  name: string
  objective: string
  trigger_kind: RoutineTriggerKind
  run_once_at: string | null
  cron_expression: string | null
  timezone: string
  overlap_policy: RoutineOverlapPolicy
  execution_mode: RoutineExecutionMode
  responsible_squad_id: string
  preferred_agent_id: string | null
  budget_micro_usd: number
  max_attempts: number
  retry_backoff_seconds: number
  max_occurrences: number | null
  stop_at: string | null
}

const ROUTINE_SELECT = `id, tenant, project_id, name, objective, status, trigger_kind,
  run_once_at, cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
  responsible_squad_id, preferred_agent_id, budget_micro_usd, max_attempts,
  retry_backoff_seconds, max_occurrences, stop_at, revision, enabled_by, enabled_at,
  created_by, created_at, updated_at`

const RUN_SELECT = `id, tenant, project_id, routine_id, routine_revision, policy_json,
  occurrence_key, trigger_kind, scheduled_for, status, waiting_reason, lease_owner,
  lease_expires_at, attempt, retry_at, assigned_agent_id, task_id, flight_id,
  situation_digest, proposal_json, result_summary, cost_micro_usd, started_at,
  finished_at, created_at, updated_at`

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function exactInstant(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length >= min && normalized.length <= max ? normalized : null
}

function integer(value: unknown, fallback: number, min: number, max: number): number | null {
  const candidate = value === undefined ? fallback : value
  return Number.isSafeInteger(candidate) && Number(candidate) >= min && Number(candidate) <= max
    ? Number(candidate)
    : null
}

function scheduleFrom(policy: Pick<NormalizedPolicy, 'trigger_kind' | 'run_once_at' | 'cron_expression' | 'timezone'>): RoutineSchedule {
  if (policy.trigger_kind === 'manual') return { kind: 'manual', timezone: policy.timezone }
  if (policy.trigger_kind === 'once') {
    return { kind: 'once', timezone: policy.timezone, runOnceAt: policy.run_once_at as string }
  }
  return { kind: 'cron', timezone: policy.timezone, cronExpression: policy.cron_expression as string }
}

function normalizePolicy(
  input: CreateRoutineInput | UpdateRoutineInput,
  existing?: Routine,
): RoutineMutationResult<NormalizedPolicy> {
  const name = input.name === undefined && existing ? existing.name : boundedText(input.name, 1, 120)
  if (!name) return { ok: false, error: 'invalid_name' }
  const objective = input.objective === undefined && existing
    ? existing.objective
    : boundedText(input.objective, 1, 4000)
  if (!objective) return { ok: false, error: 'invalid_objective' }

  const triggerKind = (input.trigger_kind === undefined && existing ? existing.trigger_kind : input.trigger_kind)
  if (triggerKind !== 'manual' && triggerKind !== 'once' && triggerKind !== 'cron') {
    return { ok: false, error: 'invalid_trigger_fields' }
  }
  const timezoneValue = input.timezone === undefined && existing ? existing.timezone : input.timezone ?? 'UTC'
  if (typeof timezoneValue !== 'string') return { ok: false, error: 'invalid_timezone' }
  const runOnceAt = input.run_once_at === undefined && existing ? existing.run_once_at : input.run_once_at ?? null
  const cronExpression = input.cron_expression === undefined && existing ? existing.cron_expression : input.cron_expression ?? null
  const schedule = triggerKind === 'manual'
    ? { kind: 'manual' as const, timezone: timezoneValue,
        ...(runOnceAt !== null ? { runOnceAt } : {}), ...(cronExpression !== null ? { cronExpression } : {}) }
    : triggerKind === 'once'
      ? { kind: 'once' as const, timezone: timezoneValue, runOnceAt,
          ...(cronExpression !== null ? { cronExpression } : {}) }
      : { kind: 'cron' as const, timezone: timezoneValue, cronExpression,
          ...(runOnceAt !== null ? { runOnceAt } : {}) }
  const scheduleValidation = validateRoutineSchedule(schedule as RoutineSchedule)
  if (!scheduleValidation.ok) return scheduleValidation

  const overlap = input.overlap_policy === undefined && existing ? existing.overlap_policy : input.overlap_policy ?? 'skip'
  if (overlap !== 'skip' && overlap !== 'queue') return { ok: false, error: 'invalid_overlap_policy' }
  const mode = input.execution_mode === undefined && existing ? existing.execution_mode : input.execution_mode ?? 'propose'
  if (mode !== 'propose' && mode !== 'execute_internal') return { ok: false, error: 'invalid_execution_mode' }
  const squad = input.responsible_squad_id === undefined && existing
    ? existing.responsible_squad_id
    : boundedText(input.responsible_squad_id, 1, 200)
  if (!squad) return { ok: false, error: 'responsible_squad_forbidden' }
  const preferred = input.preferred_agent_id === undefined && existing
    ? existing.preferred_agent_id
    : input.preferred_agent_id ?? null
  if (preferred !== null && !boundedText(preferred, 1, 200)) {
    return { ok: false, error: 'preferred_agent_ineligible' }
  }
  const budget = integer(input.budget_micro_usd, existing?.budget_micro_usd ?? 0, 0, Number.MAX_SAFE_INTEGER)
  if (budget === null) return { ok: false, error: 'invalid_budget' }
  const attempts = integer(input.max_attempts, existing?.max_attempts ?? 3, 1, 5)
  const backoff = integer(input.retry_backoff_seconds, existing?.retry_backoff_seconds ?? 300, 30, 86_400)
  if (attempts === null || backoff === null) return { ok: false, error: 'invalid_retry_policy' }
  const maxOccurrencesInput = input.max_occurrences === undefined ? existing?.max_occurrences ?? null : input.max_occurrences
  const maxOccurrences = maxOccurrencesInput === null
    ? null
    : integer(maxOccurrencesInput, 1, 1, Number.MAX_SAFE_INTEGER)
  const stopAtInput = input.stop_at === undefined ? existing?.stop_at ?? null : input.stop_at
  const stopAt = stopAtInput === null ? null : exactInstant(stopAtInput)
  if (maxOccurrences === null && maxOccurrencesInput !== null || stopAt === null && stopAtInput !== null) {
    return { ok: false, error: 'invalid_stop_condition' }
  }

  return { ok: true, value: {
    name, objective, trigger_kind: triggerKind,
    run_once_at: triggerKind === 'once' ? runOnceAt as string : null,
    cron_expression: triggerKind === 'cron' ? cronExpression as string : null,
    timezone: timezoneValue, overlap_policy: overlap, execution_mode: mode,
    responsible_squad_id: squad, preferred_agent_id: preferred as string | null,
    budget_micro_usd: budget, max_attempts: attempts, retry_backoff_seconds: backoff,
    max_occurrences: maxOccurrences, stop_at: stopAt,
  } }
}

async function validateOwnership(
  env: Env,
  projectId: string,
  policy: NormalizedPolicy,
): Promise<RoutineMutationError | null> {
  const edge = await env.DB.prepare(
    `SELECT 1 FROM project_squad_access
      WHERE project_id = ? AND squad_id = ? AND access_level IN ('write','admin')`,
  ).bind(projectId, policy.responsible_squad_id).first()
  if (!edge) return 'responsible_squad_forbidden'
  if (policy.preferred_agent_id) {
    const agent = await env.DB.prepare(
      `SELECT 1 FROM agents
        WHERE id = ? AND squad_id = ? AND status = 'active'`,
    ).bind(policy.preferred_agent_id, policy.responsible_squad_id).first()
    if (!agent) return 'preferred_agent_ineligible'
  }
  return null
}

async function directRoutine(env: Env, id: string): Promise<Routine | null> {
  return env.DB.prepare(
    `SELECT ${ROUTINE_SELECT} FROM routines WHERE id = ? AND tenant = ?`,
  ).bind(id, env.TENANT_SLUG).first<Routine>()
}

async function project(env: Env, id: string): Promise<Project | null> {
  return env.DB.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id,
            target_date, created_at, updated_at FROM projects WHERE id = ?`,
  ).bind(id).first<Project>()
}

function policySnapshot(routine: Routine): RoutinePolicySnapshot {
  return {
    execution_mode: routine.execution_mode,
    overlap_policy: routine.overlap_policy,
    responsible_squad_id: routine.responsible_squad_id,
    preferred_agent_id: routine.preferred_agent_id,
    budget_micro_usd: routine.budget_micro_usd,
    max_attempts: routine.max_attempts,
    retry_backoff_seconds: routine.retry_backoff_seconds,
  }
}

function validPage(limit = 50, after?: RoutineCursor): boolean {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return false
  if (!after) return true
  return boundedText(after.timestamp, 1, 100) !== null && boundedText(after.id, 1, 200) !== null
}

export async function createRoutine(
  env: Env,
  principal: RoutinePrincipal,
  input: CreateRoutineInput,
): Promise<RoutineMutationResult<Routine>> {
  if (principal.tenant !== env.TENANT_SLUG || !principal.workspace_admin) return { ok: false, error: 'forbidden' }
  const projectId = boundedText(input.project_id, 1, 200)
  if (!projectId) return { ok: false, error: 'project_not_found' }
  const targetProject = await project(env, projectId)
  if (!targetProject) return { ok: false, error: 'project_not_found' }
  if (targetProject.status === 'archived') return { ok: false, error: 'archived_project' }
  const normalized = normalizePolicy(input)
  if (!normalized.ok) return normalized
  const ownershipError = await validateOwnership(env, projectId, normalized.value)
  if (ownershipError) return { ok: false, error: ownershipError }
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const p = normalized.value
  const result = await env.DB.prepare(
    `INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
      cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
      responsible_squad_id, preferred_agent_id, budget_micro_usd, max_attempts,
      retry_backoff_seconds, max_occurrences, stop_at, revision, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(
    id, env.TENANT_SLUG, projectId, p.name, p.objective, p.trigger_kind, p.run_once_at,
    p.cron_expression, p.timezone, p.overlap_policy, p.execution_mode,
    p.responsible_squad_id, p.preferred_agent_id, p.budget_micro_usd, p.max_attempts,
    p.retry_backoff_seconds, p.max_occurrences, p.stop_at, principal.actor_id, now, now,
  ).run()
  if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  const created = await directRoutine(env, id)
  return created ? { ok: true, value: created } : { ok: false, error: 'receipt_failed' }
}

export async function getRoutine(
  env: Env,
  principal: RoutinePrincipal,
  id: string,
): Promise<Routine | null> {
  if (principal.tenant !== env.TENANT_SLUG) return null
  const visibility = projectVisibilityClause(principal.project_read)
  return env.DB.prepare(
    `SELECT ${ROUTINE_SELECT.split(',').map(column => `r.${column.trim()}`).join(', ')}
       FROM routines r JOIN projects p ON p.id = r.project_id
      WHERE r.id = ? AND r.tenant = ? AND ${visibility.sql}`,
  ).bind(id, env.TENANT_SLUG, ...visibility.binds).first<Routine>()
}

export async function listRoutines(
  env: Env,
  principal: RoutinePrincipal,
  input: ListRoutinesInput,
): Promise<RoutinePage<Routine>> {
  const limit = input.limit ?? 50
  if (!validPage(limit, input.after)) return { ok: false, error: 'invalid_pagination' }
  if (!await principalCanReadProject(env, principal, input.project_id)) {
    return { ok: false, error: 'project_not_found' }
  }
  const clauses = ['tenant = ?', 'project_id = ?']
  const binds: unknown[] = [env.TENANT_SLUG, input.project_id]
  if (input.status) {
    clauses.push('status = ?')
    binds.push(input.status)
  }
  if (input.after) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id > ?))')
    binds.push(input.after.timestamp, input.after.timestamp, input.after.id)
  }
  const result = await env.DB.prepare(
    `SELECT ${ROUTINE_SELECT} FROM routines WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id ASC LIMIT ?`,
  ).bind(...binds, limit + 1).all<Routine>()
  const rows = result.results ?? []
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    ok: true,
    items,
    next_cursor: rows.length > limit && last ? { timestamp: last.updated_at, id: last.id } : null,
  }
}

export async function updateRoutine(
  env: Env,
  principal: RoutinePrincipal,
  id: string,
  input: UpdateRoutineInput,
): Promise<RoutineMutationResult<Routine>> {
  if (principal.tenant !== env.TENANT_SLUG || !principal.workspace_admin) return { ok: false, error: 'forbidden' }
  const existing = await directRoutine(env, id)
  if (!existing) return { ok: false, error: 'routine_not_found' }
  if (existing.status === 'archived') return { ok: false, error: 'routine_archived' }
  const normalized = normalizePolicy(input, existing)
  if (!normalized.ok) return normalized
  const ownershipError = await validateOwnership(env, existing.project_id, normalized.value)
  if (ownershipError) return { ok: false, error: ownershipError }
  const p = normalized.value
  const next = existing.status === 'enabled'
    ? nextRoutineOccurrence(scheduleFrom(p), new Date())
    : null
  if (existing.status === 'enabled' && p.trigger_kind !== 'manual' && !next) {
    return { ok: false, error: 'schedule_exhausted' }
  }
  const updatedAt = new Date().toISOString()
  const result = await env.DB.prepare(
    `UPDATE routines SET name = ?, objective = ?, trigger_kind = ?, run_once_at = ?,
      cron_expression = ?, timezone = ?, next_run_at = ?, overlap_policy = ?, execution_mode = ?,
      responsible_squad_id = ?, preferred_agent_id = ?, budget_micro_usd = ?, max_attempts = ?,
      retry_backoff_seconds = ?, max_occurrences = ?, stop_at = ?, revision = revision + 1,
      updated_at = ? WHERE id = ? AND tenant = ? AND revision = ?`,
  ).bind(
    p.name, p.objective, p.trigger_kind, p.run_once_at, p.cron_expression, p.timezone,
    next?.toISOString() ?? null, p.overlap_policy, p.execution_mode, p.responsible_squad_id,
    p.preferred_agent_id, p.budget_micro_usd, p.max_attempts, p.retry_backoff_seconds,
    p.max_occurrences, p.stop_at, updatedAt, id, env.TENANT_SLUG, existing.revision,
  ).run()
  if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  const updated = await directRoutine(env, id)
  return updated ? { ok: true, value: updated } : { ok: false, error: 'receipt_failed' }
}

async function transitionRoutine(
  env: Env,
  principal: RoutinePrincipal,
  id: string,
  target: 'enabled' | 'paused' | 'archived',
): Promise<RoutineMutationResult<Routine>> {
  if (principal.tenant !== env.TENANT_SLUG || !principal.workspace_admin) return { ok: false, error: 'forbidden' }
  const existing = await directRoutine(env, id)
  if (!existing) return { ok: false, error: 'routine_not_found' }
  if (existing.status === 'archived') return { ok: false, error: 'routine_archived' }
  if (target === 'enabled' && !['draft', 'paused'].includes(existing.status)) return { ok: false, error: 'invalid_state' }
  if (target === 'paused' && existing.status !== 'enabled') return { ok: false, error: 'invalid_state' }
  const targetProject = await project(env, existing.project_id)
  if (!targetProject) return { ok: false, error: 'project_not_found' }
  if (target === 'enabled' && targetProject.status !== 'active') return { ok: false, error: 'project_not_active' }
  const normalized = normalizePolicy({}, existing)
  if (!normalized.ok) return normalized
  const ownershipError = await validateOwnership(env, existing.project_id, normalized.value)
  if (ownershipError) return { ok: false, error: ownershipError }
  const now = new Date()
  const next = target === 'enabled' ? nextRoutineOccurrence(scheduleFrom(normalized.value), now) : null
  if (target === 'enabled' && existing.trigger_kind !== 'manual' && !next) {
    return { ok: false, error: 'schedule_exhausted' }
  }
  const result = await env.DB.prepare(
    `UPDATE routines SET status = ?, next_run_at = ?, revision = revision + 1,
      enabled_by = CASE WHEN ? = 'enabled' THEN ? ELSE enabled_by END,
      enabled_at = CASE WHEN ? = 'enabled' THEN ? ELSE enabled_at END,
      updated_at = ? WHERE id = ? AND tenant = ? AND revision = ?`,
  ).bind(
    target, next?.toISOString() ?? null, target, principal.actor_id, target,
    now.toISOString(), now.toISOString(), id, env.TENANT_SLUG, existing.revision,
  ).run()
  if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  const updated = await directRoutine(env, id)
  return updated ? { ok: true, value: updated } : { ok: false, error: 'receipt_failed' }
}

export const enableRoutine = (env: Env, principal: RoutinePrincipal, id: string) =>
  transitionRoutine(env, principal, id, 'enabled')
export const pauseRoutine = (env: Env, principal: RoutinePrincipal, id: string) =>
  transitionRoutine(env, principal, id, 'paused')
export const archiveRoutine = (env: Env, principal: RoutinePrincipal, id: string) =>
  transitionRoutine(env, principal, id, 'archived')

export async function createManualRoutineRun(
  env: Env,
  principal: RoutinePrincipal,
  routineId: string,
  idempotencyKey: string,
): Promise<RoutineRunCreationResult> {
  if (principal.tenant !== env.TENANT_SLUG) return { ok: false, error: 'forbidden' }
  const routine = await getRoutine(env, principal, routineId)
  if (!routine) return { ok: false, error: 'routine_not_found' }
  if (routine.status !== 'enabled') return { ok: false, error: 'routine_not_enabled' }
  const targetProject = await project(env, routine.project_id)
  if (!targetProject || targetProject.status !== 'active') return { ok: false, error: 'project_not_active' }
  if (!await principalCanRunForSquad(env, principal, routine.project_id, routine.responsible_squad_id)) {
    return { ok: false, error: 'forbidden' }
  }
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(idempotencyKey)) {
    return { ok: false, error: 'invalid_idempotency_key' }
  }
  const now = new Date()
  const occurrenceKey = routineOccurrenceKey({ kind: 'manual', timezone: routine.timezone }, now, idempotencyKey)
  const existing = await env.DB.prepare(
    `SELECT ${RUN_SELECT} FROM routine_runs
      WHERE tenant = ? AND routine_id = ? AND occurrence_key = ?`,
  ).bind(env.TENANT_SLUG, routine.id, occurrenceKey).first<RoutineRun>()
  if (existing) return { ok: true, value: existing, duplicate: true }
  if (routine.stop_at !== null && now.getTime() >= Date.parse(routine.stop_at)) {
    return { ok: false, error: 'schedule_exhausted' }
  }
  if (routine.max_occurrences !== null) {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM routine_runs WHERE tenant = ? AND routine_id = ?',
    ).bind(env.TENANT_SLUG, routine.id).first<{ count: number }>()
    if (Number(count?.count ?? 0) >= routine.max_occurrences) {
      return { ok: false, error: 'schedule_exhausted' }
    }
  }

  const run: RoutineRun = {
    id: crypto.randomUUID(), tenant: env.TENANT_SLUG, project_id: routine.project_id,
    routine_id: routine.id, routine_revision: routine.revision,
    policy_json: JSON.stringify(policySnapshot(routine)), occurrence_key: occurrenceKey,
    trigger_kind: 'manual', scheduled_for: null, status: 'queued', waiting_reason: null,
    lease_owner: null, lease_expires_at: null, attempt: 0, retry_at: null,
    assigned_agent_id: null, task_id: null, flight_id: null, situation_digest: null,
    proposal_json: null, result_summary: null, cost_micro_usd: 0,
    started_at: null, finished_at: null, created_at: now.toISOString(), updated_at: now.toISOString(),
  }
  try {
    const outcomes = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
          trigger_kind, scheduled_for, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', NULL, 'queued', ?, ?)`,
      ).bind(
        run.id, run.tenant, run.project_id, run.routine_id, run.routine_revision,
        run.policy_json, run.occurrence_key, run.created_at, run.updated_at,
      ),
      env.DB.prepare(
        `INSERT INTO routine_run_events (
          id, tenant, project_id, run_id, kind, actor_type, actor_id,
          occurred_at, metadata_json, correlation_id
        ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, '{}', ?)`,
      ).bind(
        crypto.randomUUID(), run.tenant, run.project_id, run.id, principal.actor_type,
        principal.actor_id, run.created_at, run.id,
      ),
    ])
    if (outcomes.length !== 2 || outcomes.some(outcome => !wrote(outcome))) {
      return { ok: false, error: 'receipt_failed' }
    }
    return { ok: true, value: run, duplicate: false }
  } catch (error) {
    if (error instanceof Error && error.message.includes('routine schedule exhausted')) {
      return { ok: false, error: 'schedule_exhausted' }
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      const raced = await env.DB.prepare(
        `SELECT ${RUN_SELECT} FROM routine_runs
          WHERE tenant = ? AND routine_id = ? AND occurrence_key = ?`,
      ).bind(env.TENANT_SLUG, routine.id, occurrenceKey).first<RoutineRun>()
      if (raced) return { ok: true, value: raced, duplicate: true }
    }
    throw error
  }
}

export async function getRoutineRun(
  env: Env,
  principal: RoutinePrincipal,
  id: string,
): Promise<RoutineRun | null> {
  if (principal.tenant !== env.TENANT_SLUG) return null
  const visibility = projectVisibilityClause(principal.project_read)
  return env.DB.prepare(
    `SELECT ${RUN_SELECT.split(',').map(column => `rr.${column.trim()}`).join(', ')}
       FROM routine_runs rr JOIN projects p ON p.id = rr.project_id
      WHERE rr.id = ? AND rr.tenant = ? AND ${visibility.sql}`,
  ).bind(id, env.TENANT_SLUG, ...visibility.binds).first<RoutineRun>()
}

export async function listRoutineRuns(
  env: Env,
  principal: RoutinePrincipal,
  input: ListRoutineRunsInput,
): Promise<RoutinePage<RoutineRun>> {
  const limit = input.limit ?? 50
  if (!validPage(limit, input.after)) return { ok: false, error: 'invalid_pagination' }
  if (!await principalCanReadProject(env, principal, input.project_id)) {
    return { ok: false, error: 'project_not_found' }
  }
  const clauses = ['tenant = ?', 'project_id = ?']
  const binds: unknown[] = [env.TENANT_SLUG, input.project_id]
  if (input.routine_id) {
    clauses.push('routine_id = ?')
    binds.push(input.routine_id)
  }
  if (input.after) {
    clauses.push('(created_at < ? OR (created_at = ? AND id > ?))')
    binds.push(input.after.timestamp, input.after.timestamp, input.after.id)
  }
  const result = await env.DB.prepare(
    `SELECT ${RUN_SELECT} FROM routine_runs WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id ASC LIMIT ?`,
  ).bind(...binds, limit + 1).all<RoutineRun>()
  const rows = result.results ?? []
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    ok: true,
    items,
    next_cursor: rows.length > limit && last ? { timestamp: last.created_at, id: last.id } : null,
  }
}
