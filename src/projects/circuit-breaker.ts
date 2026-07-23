// Project lifecycle circuit breaker (slice 1) — kill default at cycle boundary.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// At cycle_boundary_at, if status ≠ completed/archived and there is no receipted
// recommit for that boundary, default action is kill → archived. Continuation must
// be justified via a recommit_or_kill receipt written through the EXISTING
// workflow_receipts path (writeReceiptToD1) — no second decision store.
//
// Enforcement (codex diverse-gate 2026-07-23):
//   - Receipted recommit requires status=ok, boundary_at match, authorized writer
//   - Principal is derived from AUTHENTICATED context (never caller-supplied);
//     system may only write kill; self-recommit blocked unless owner override
//   - Kill path re-reads the winning immutable receipt before archive (no TOCTOU)
//   - Boundaries are canonical UTC ISO; evaluation uses normalized epoch

import type { AuthContext, Env, Project, ProjectStatus } from '../types'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { updateProject, type ProjectMutationResult } from './service'

export const RECOMMIT_OR_KILL_STEP = 'recommit_or_kill'
export const RECOMMIT_OR_KILL_SCHEMA = 'mupot.recommit_or_kill/v1'
export const CIRCUIT_BREAKER_PRINCIPAL = 'system:project-loop'
export const KILL_REASON_NO_RECOMMIT = 'cycle_boundary_no_recommit'
export const RECEIPT_STATUS_OK = 'ok'

const AUTHORIZED_RECOMMIT_WRITER_RE = /^(member|agent):.+$/

export type RecommitOrKillDecision = 'recommit' | 'kill'

export type CircuitBreakerOutcome = 'skipped' | 'recommitted' | 'killed'

export interface RecommitOrKillReceiptDetail {
  schema: typeof RECOMMIT_OR_KILL_SCHEMA
  project_id: string
  boundary_at: string
  decision: RecommitOrKillDecision
  principal: string
  reason: string
}

export type RecommitWriter =
  | { kind: 'authenticated'; auth: AuthContext; overrideSelfVerdict: boolean }
  | { kind: 'system_kill' }

export interface RecordRecommitOrKillInput {
  projectId: string
  boundaryAt: string
  decision: RecommitOrKillDecision
  reason: string
  writer: RecommitWriter
}

export type WriteReceiptFn = (
  env: Env,
  row: {
    instanceId: string
    taskId: string
    stepName: string
    status: string
    detail?: string
  },
) => Promise<void>

export type UpdateProjectFn = (
  env: Env,
  id: string,
  input: { status: ProjectStatus },
) => Promise<ProjectMutationResult<Project>>

export type HasRecommitFn = (
  env: Env,
  projectId: string,
  boundaryAt: string,
) => Promise<boolean>

export type ReadReceiptFn = (
  env: Env,
  projectId: string,
  boundaryAt: string,
) => Promise<RecommitOrKillReceiptRow | null>

export type ClearBoundaryFn = (env: Env, projectId: string) => Promise<void>

export interface CircuitBreakerDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
  hasRecommit: HasRecommitFn
  readReceipt: ReadReceiptFn
  clearInvalidBoundary: ClearBoundaryFn
  principal: string
}

export interface RecommitOrKillReceiptRow {
  status: string
  detail: RecommitOrKillReceiptDetail
}

export type RecordRecommitError =
  | 'invalid_boundary'
  | 'invalid_principal'
  | 'self_verdict'
  | 'system_cannot_recommit'
  | 'authenticated_required_for_recommit'

export class RecordRecommitOrKillError extends Error {
  readonly code: RecordRecommitError

  constructor(code: RecordRecommitError, message: string) {
    super(message)
    this.name = 'RecordRecommitOrKillError'
    this.code = code
  }
}

/** Stable workflow instance id for one project + boundary (UNIQUE with step_name). */
export function cycleInstanceId(projectId: string, boundaryAt: string): string {
  return `project-cycle:${projectId}:${boundaryAt}`
}

/** Synthetic task id for project-scoped lifecycle receipts (no FK on workflow_receipts). */
export function lifecycleTaskId(projectId: string): string {
  return `project-cycle:${projectId}`
}

/**
 * Canonical UTC ISO-8601 instant (Date.prototype.toISOString form).
 * Returns null for empty/invalid input — callers must not store or evaluate NaN.
 */
export function canonicalizeUtcIso(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

export function epochMs(value: string | null): number | null {
  const canonical = canonicalizeUtcIso(value)
  if (canonical === null) return null
  return Date.parse(canonical)
}

export function isAtCycleBoundary(cycleBoundaryAt: string | null, nowIso: string): boolean {
  const boundaryMs = epochMs(cycleBoundaryAt)
  const nowMs = epochMs(nowIso)
  if (boundaryMs === null || nowMs === null) return false
  return nowMs >= boundaryMs
}

/**
 * Breaker evaluates only at/after the boundary for non-terminal projects.
 * completed is exempt (structural finish path). archived is already terminal.
 */
export function shouldEvaluateBreaker(
  status: ProjectStatus,
  cycleBoundaryAt: string | null,
  nowIso: string,
): boolean {
  if (status === 'completed' || status === 'archived') return false
  return isAtCycleBoundary(cycleBoundaryAt, nowIso)
}

/** Authenticated principal id used for self-verdict / different-principal checks. */
export function circuitPrincipalId(auth: AuthContext): string {
  if (auth.boundAgentId) return auth.boundAgentId
  if (auth.memberId) return auth.memberId
  return auth.userId
}

/** Receipt principal stamped from AUTHENTICATED context (never caller-supplied). */
export function formatAuthenticatedCircuitPrincipal(auth: AuthContext): string {
  if (auth.boundAgentId) return `agent:${auth.boundAgentId}`
  if (auth.memberId) return `member:${auth.memberId}`
  if (auth.userId.trim() !== '') return `agent:${auth.userId}`
  throw new RecordRecommitOrKillError('invalid_principal', 'authenticated principal is empty')
}

/** Authorized recommit writers are authenticated member/agent principals — not system. */
export function isAuthorizedRecommitWriter(principal: string): boolean {
  if (principal.trim() === '') return false
  if (principal === CIRCUIT_BREAKER_PRINCIPAL) return false
  if (principal.startsWith('system:')) return false
  return AUTHORIZED_RECOMMIT_WRITER_RE.test(principal)
}

/**
 * Self-recommit: the project's own synthetic identity (or the system killer)
 * cannot rubber-stamp continuation. Matches the design's self-verdict-blocked rule.
 */
export function isCircuitSelfRecommit(projectId: string, principal: string): boolean {
  if (principal === CIRCUIT_BREAKER_PRINCIPAL) return true
  if (principal.startsWith('system:')) return true
  if (principal === projectId) return true
  if (principal === `project:${projectId}`) return true
  if (principal === lifecycleTaskId(projectId)) return true
  if (principal === `member:${projectId}` || principal === `agent:${projectId}`) return true
  return false
}

export function resolveRecordPrincipal(
  projectId: string,
  decision: RecommitOrKillDecision,
  writer: RecommitWriter,
  reason: string,
): { principal: string; reason: string } {
  if (writer.kind === 'system_kill') {
    if (decision !== 'kill') {
      throw new RecordRecommitOrKillError(
        'system_cannot_recommit',
        'system:project-loop may only record kill decisions',
      )
    }
    return { principal: CIRCUIT_BREAKER_PRINCIPAL, reason }
  }

  const principal = formatAuthenticatedCircuitPrincipal(writer.auth)
  if (decision === 'recommit' && !isAuthorizedRecommitWriter(principal)) {
    throw new RecordRecommitOrKillError('invalid_principal', 'recommit requires an authorized writer principal')
  }

  if (decision === 'recommit' && isCircuitSelfRecommit(projectId, principal)) {
    const isOrgOwner = writer.auth.role === 'owner'
    if (!isOrgOwner || !writer.overrideSelfVerdict) {
      throw new RecordRecommitOrKillError(
        'self_verdict',
        'project cannot recommit itself; self-verdict is blocked',
      )
    }
    const overrideNote = `[self_verdict_override by org owner ${circuitPrincipalId(writer.auth)}]`
    return {
      principal,
      reason: reason.trim() === '' ? overrideNote : `${overrideNote} ${reason}`,
    }
  }

  return { principal, reason }
}

export function buildRecommitOrKillDetail(input: {
  projectId: string
  boundaryAt: string
  decision: RecommitOrKillDecision
  principal: string
  reason: string
}): RecommitOrKillReceiptDetail {
  return {
    schema: RECOMMIT_OR_KILL_SCHEMA,
    project_id: input.projectId,
    boundary_at: input.boundaryAt,
    decision: input.decision,
    principal: input.principal,
    reason: input.reason,
  }
}

/**
 * Record a recommit_or_kill decision through workflow_receipts (writeReceiptToD1).
 * Principal is derived from writer (authenticated context or system_kill) — never
 * caller-supplied. INSERT OR IGNORE makes a second write for the same project+boundary a no-op.
 */
export async function recordRecommitOrKill(
  env: Env,
  input: RecordRecommitOrKillInput,
  writeReceipt: WriteReceiptFn,
): Promise<RecommitOrKillReceiptDetail> {
  if (input.decision === 'recommit' && input.writer.kind !== 'authenticated') {
    throw new RecordRecommitOrKillError(
      'authenticated_required_for_recommit',
      'recommit requires an authenticated writer',
    )
  }

  const boundaryAt = canonicalizeUtcIso(input.boundaryAt)
  if (boundaryAt === null) {
    throw new RecordRecommitOrKillError('invalid_boundary', 'boundary_at must be a canonical UTC ISO instant')
  }

  const resolved = resolveRecordPrincipal(
    input.projectId,
    input.decision,
    input.writer,
    input.reason,
  )
  const detail = buildRecommitOrKillDetail({
    projectId: input.projectId,
    boundaryAt,
    decision: input.decision,
    principal: resolved.principal,
    reason: resolved.reason,
  })
  await writeReceipt(env, {
    instanceId: cycleInstanceId(input.projectId, boundaryAt),
    taskId: lifecycleTaskId(input.projectId),
    stepName: RECOMMIT_OR_KILL_STEP,
    status: RECEIPT_STATUS_OK,
    detail: JSON.stringify(detail),
  })
  return detail
}

export function parseRecommitOrKillDetail(
  raw: string | null,
): RecommitOrKillReceiptDetail | null {
  if (raw === null || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (obj.schema !== RECOMMIT_OR_KILL_SCHEMA) return null
    if (typeof obj.project_id !== 'string' || obj.project_id.trim() === '') return null
    if (typeof obj.boundary_at !== 'string' || obj.boundary_at.trim() === '') return null
    if (obj.decision !== 'recommit' && obj.decision !== 'kill') return null
    if (typeof obj.principal !== 'string' || obj.principal.trim() === '') return null
    if (typeof obj.reason !== 'string' || obj.reason.trim() === '') return null
    const boundaryAt = canonicalizeUtcIso(obj.boundary_at)
    if (boundaryAt === null) return null
    return {
      schema: RECOMMIT_OR_KILL_SCHEMA,
      project_id: obj.project_id,
      boundary_at: boundaryAt,
      decision: obj.decision,
      principal: obj.principal,
      reason: obj.reason,
    }
  } catch {
    return null
  }
}

/**
 * True when a receipted recommit exists for this project + boundary.
 * Rejects forged rows: status must be ok, detail.boundary_at must match, and
 * principal must be an authorized recommit writer (not arbitrary detail).
 */
export async function hasReceiptedRecommit(
  env: Env,
  projectId: string,
  boundaryAt: string,
): Promise<boolean> {
  const row = await readRecommitOrKillReceipt(env, projectId, boundaryAt)
  if (row === null) return false
  return isValidReceiptedRecommit(row, projectId, boundaryAt)
}

export function isValidReceiptedRecommit(
  row: RecommitOrKillReceiptRow,
  projectId: string,
  boundaryAt: string,
): boolean {
  if (row.status !== RECEIPT_STATUS_OK) return false
  if (row.detail.decision !== 'recommit') return false
  if (row.detail.project_id !== projectId) return false
  const expectedBoundary = canonicalizeUtcIso(boundaryAt)
  if (expectedBoundary === null) return false
  if (row.detail.boundary_at !== expectedBoundary) return false
  if (!isAuthorizedRecommitWriter(row.detail.principal)) return false
  return true
}

export async function readRecommitOrKillReceipt(
  env: Env,
  projectId: string,
  boundaryAt: string,
): Promise<RecommitOrKillReceiptRow | null> {
  const canonicalBoundary = canonicalizeUtcIso(boundaryAt)
  if (canonicalBoundary === null) return null
  const row = await env.DB.prepare(
    `SELECT status, detail FROM workflow_receipts
      WHERE instance_id = ?1 AND step_name = ?2
      LIMIT 1`,
  )
    .bind(cycleInstanceId(projectId, canonicalBoundary), RECOMMIT_OR_KILL_STEP)
    .first<{ status: string; detail: string | null }>()
  if (!row) return null
  const detail = parseRecommitOrKillDetail(row.detail)
  if (detail === null) return null
  return { status: row.status, detail }
}

/** Quarantine invalid cycle_boundary_at so the loop cannot retry forever. */
export async function clearInvalidCycleBoundary(env: Env, projectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE projects SET cycle_boundary_at = NULL, updated_at = ?1 WHERE id = ?2`,
  )
    .bind(new Date().toISOString(), projectId)
    .run()
}

export function defaultCircuitBreakerDeps(): CircuitBreakerDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: (env, id, input) => updateProject(env, id, input),
    hasRecommit: hasReceiptedRecommit,
    readReceipt: readRecommitOrKillReceipt,
    clearInvalidBoundary: clearInvalidCycleBoundary,
    principal: CIRCUIT_BREAKER_PRINCIPAL,
  }
}

/**
 * At a due boundary: receipted recommit → keep status; else kill receipt + archive.
 * Re-reads the winning immutable receipt before archive so a mid-sequence recommit
 * wins the UNIQUE race instead of being archived anyway (TOCTOU).
 */
export async function evaluateProjectCircuitBreaker(
  env: Env,
  project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at'>,
  nowIso: string,
  deps: CircuitBreakerDeps,
): Promise<CircuitBreakerOutcome> {
  const boundaryAt = canonicalizeUtcIso(project.cycle_boundary_at)
  if (project.cycle_boundary_at !== null && boundaryAt === null) {
    await deps.clearInvalidBoundary(env, project.id)
    return 'skipped'
  }
  if (!shouldEvaluateBreaker(project.status, boundaryAt, nowIso)) {
    return 'skipped'
  }
  if (boundaryAt === null) return 'skipped'

  if (await deps.hasRecommit(env, project.id, boundaryAt)) {
    return 'recommitted'
  }

  await recordRecommitOrKill(
    env,
    {
      projectId: project.id,
      boundaryAt,
      decision: 'kill',
      reason: KILL_REASON_NO_RECOMMIT,
      writer: { kind: 'system_kill' },
    },
    deps.writeReceipt,
  )

  // Re-read the winning immutable receipt before archive (INSERT OR IGNORE race).
  const winning = await deps.readReceipt(env, project.id, boundaryAt)
  if (winning !== null && isValidReceiptedRecommit(winning, project.id, boundaryAt)) {
    return 'recommitted'
  }
  if (winning === null || winning.detail.decision !== 'kill' || winning.status !== RECEIPT_STATUS_OK) {
    throw new Error('circuit_breaker_kill_receipt_missing')
  }

  const archived = await deps.updateProject(env, project.id, { status: 'archived' })
  if (!archived.ok) {
    throw new Error(`circuit_breaker_archive_failed:${archived.error}`)
  }
  return 'killed'
}
