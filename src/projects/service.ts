import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { Env, Project, ProjectAccessLevel, ProjectSquadAccess, ProjectStatus } from '../types'
import { isNonEmptyString, isValidSlug } from '../org/service'
import { projectSelectSql } from './columns'
import { isSafeHttpsUrl, isValidWorkerName, slugFromProjectName } from './urls'
import { assertWritten } from '../lib/receipt'

const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'paused', 'review', 'completed', 'archived']
const PROJECT_ACCESS_LEVELS: readonly ProjectAccessLevel[] = ['read', 'write', 'admin']
const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  planned: ['active', 'archived'],
  // completed is NOT reachable here — only via completion-gate verdict (slice 2).
  active: ['paused', 'review', 'archived'],
  paused: ['active', 'archived'],
  review: ['active', 'completed'],
  completed: ['active', 'archived'],
  archived: ['planned'],
}

export type ProjectMutationError =
  | 'invalid_slug' | 'invalid_name' | 'invalid_status' | 'invalid_status_transition' | 'invalid_target_date'
  | 'invalid_repo_url' | 'invalid_live_url' | 'invalid_worker_name'
  | 'slug_taken' | 'project_not_found' | 'parent_not_found'
  | 'hierarchy_depth' | 'hierarchy_cycle' | 'active_children'
  | 'archived_project' | 'squad_not_found' | 'invalid_access_level'
  | 'receipt_failed'
  | 'completion_gate_required'
  | 'start_gate_required'

export type ProjectMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectMutationError }

export interface CreateProjectInput {
  slug?: unknown
  name?: unknown
  description?: unknown
  goal?: unknown
  status?: unknown
  parent_project_id?: unknown
  target_date?: unknown
  repo_url?: unknown
  worker_name?: unknown
  live_url?: unknown
  assigned_squad_id?: unknown
}

export interface UpdateProjectInput {
  slug?: unknown
  name?: unknown
  description?: unknown
  goal?: unknown
  status?: unknown
  parent_project_id?: unknown
  target_date?: unknown
  repo_url?: unknown
  worker_name?: unknown
  live_url?: unknown
  assigned_squad_id?: unknown
  /** Set when entering/leaving completion review (slice 2). */
  completion_proposed_by?: string | null
  /**
   * Internal flag: allow active→review / review→completed writes owned by
   * completion-gate.ts. Bare updateProject callers cannot self-report completed.
   */
  via_completion_gate?: boolean
  /**
   * Internal flag: allow planned→active writes owned by start-gate.ts.
   * Bare updateProject callers cannot activate without authorize+provision.
   */
  via_start_gate?: boolean
  /** Principal recorded on lessons-capture when completed→archived. */
  lifecycle_principal?: string
}

export interface ListProjectsOptions {
  status?: ProjectStatus
  parent_project_id?: string | null
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}

function isProjectAccessLevel(value: unknown): value is ProjectAccessLevel {
  return typeof value === 'string' && (PROJECT_ACCESS_LEVELS as readonly string[]).includes(value)
}

// projectAccessLevelRank — the ONE ordering table for ProjectAccessLevel
// (FP-01 Slice 2 v2, successor to PR #1488's adversarial finding 10: a
// fourth 3-level PROJECT_ACCESS_RANK map had been hand-rolled in
// src/routines/actions.ts, alongside four pre-existing binary write|admin
// checks — src/projects/access.ts, src/projects/start-gate.ts,
// src/addons/project-link/service.ts, src/attention/service.ts — none of
// which share an ordering with each other or with this one). PROJECT_ACCESS_LEVELS'
// own declared order (read, write, admin) IS the rank — this just exposes
// it as a comparable number so a caller never re-derives its own copy.
export function projectAccessLevelRank(level: ProjectAccessLevel): number {
  return PROJECT_ACCESS_LEVELS.indexOf(level)
}

export function isValidProjectTargetDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

export function validProjectStatusTransitions(status: ProjectStatus): readonly ProjectStatus[] {
  return PROJECT_STATUS_TRANSITIONS[status]
}

export function isValidProjectStatusTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === to || PROJECT_STATUS_TRANSITIONS[from].includes(to)
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)
}

function triggerMutationError(error: unknown): ProjectMutationError | null {
  if (!(error instanceof Error)) return null
  if (error.message.includes('archived parent project') || error.message.includes('archived project squad access')) {
    return 'archived_project'
  }
  if (error.message.includes('project hierarchy depth')) return 'hierarchy_depth'
  if (error.message.includes('project hierarchy cycle')) return 'hierarchy_cycle'
  if (error.message.includes('parent project not found')) return 'parent_not_found'
  if (error.message.includes('active child projects')) return 'active_children'
  return null
}

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous)
  const floor = Number.isNaN(previousMs) ? Date.now() : previousMs + 1
  return new Date(Math.max(Date.now(), floor)).toISOString()
}

async function hasNonArchivedChildren(env: Env, projectId: string): Promise<boolean> {
  return (await env.DB.prepare(
    "SELECT 1 FROM projects WHERE parent_project_id = ? AND status <> 'archived' LIMIT 1",
  ).bind(projectId).first()) !== null
}

async function hasChildren(env: Env, projectId: string): Promise<boolean> {
  return (await env.DB.prepare(
    'SELECT 1 FROM projects WHERE parent_project_id = ? LIMIT 1',
  ).bind(projectId).first()) !== null
}

async function validateParent(
  env: Env,
  projectId: string | null,
  parentProjectId: unknown,
): Promise<ProjectMutationError | null> {
  if (parentProjectId === null) return null
  if (typeof parentProjectId !== 'string' || !parentProjectId) return 'parent_not_found'

  const directParent = await getProject(env, parentProjectId)
  if (!directParent) return 'parent_not_found'
  if (directParent.status === 'archived') return 'archived_project'

  let parent: Project | null = directParent
  while (parent) {
    if (parent.id === projectId) return 'hierarchy_cycle'
    if (parent.parent_project_id === null) break
    parent = await getProject(env, parent.parent_project_id)
    if (!parent) return 'parent_not_found'
  }

  return directParent?.parent_project_id === null ? null : 'hierarchy_depth'
}

function optionalText(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback
  return typeof value === 'string' ? value : null
}

function optionalNullableUrl(
  value: unknown,
  existing: string | null,
  error: 'invalid_repo_url' | 'invalid_live_url',
): { ok: true; value: string | null } | { ok: false; error: ProjectMutationError } {
  if (value === undefined) return { ok: true, value: existing }
  if (value === null || value === '') return { ok: true, value: null }
  if (!isSafeHttpsUrl(value)) return { ok: false, error }
  return { ok: true, value }
}

function optionalWorkerName(
  value: unknown,
  existing: string | null,
): { ok: true; value: string | null } | { ok: false; error: ProjectMutationError } {
  if (value === undefined) return { ok: true, value: existing }
  if (value === null || value === '') return { ok: true, value: null }
  if (!isValidWorkerName(value)) return { ok: false, error: 'invalid_worker_name' }
  return { ok: true, value }
}

async function optionalAssignedSquad(
  env: Env,
  value: unknown,
  existing: string | null,
): Promise<{ ok: true; value: string | null } | { ok: false; error: ProjectMutationError }> {
  if (value === undefined) return { ok: true, value: existing }
  if (value === null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string' || !value) return { ok: false, error: 'squad_not_found' }
  const squad = await env.DB.prepare('SELECT 1 FROM squads WHERE id = ?').bind(value).first()
  if (!squad) return { ok: false, error: 'squad_not_found' }
  return { ok: true, value }
}

export async function createProject(
  env: Env,
  input: CreateProjectInput,
): Promise<ProjectMutationResult<Project>> {
  if (!isNonEmptyString(input.name)) return { ok: false, error: 'invalid_name' }
  const slug = typeof input.slug === 'string' && input.slug.trim()
    ? input.slug.trim()
    : slugFromProjectName(input.name)
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid_slug' }

  const description = optionalText(input.description, '')
  const goal = optionalText(input.goal, '')
  if (description === null || goal === null) return { ok: false, error: 'invalid_name' }

  const status = input.status === undefined ? 'active' : input.status
  if (!isProjectStatus(status)) return { ok: false, error: 'invalid_status' }

  const targetDate = input.target_date === undefined || input.target_date === null ? null : input.target_date
  if (targetDate !== null && !isValidProjectTargetDate(targetDate)) return { ok: false, error: 'invalid_target_date' }

  const parentProjectId = input.parent_project_id === undefined ? null : input.parent_project_id
  if (parentProjectId !== null) {
    const parentError = await validateParent(env, null, parentProjectId)
    if (parentError) return { ok: false, error: parentError }
  }

  const repoUrl = optionalNullableUrl(input.repo_url, null, 'invalid_repo_url')
  if (!repoUrl.ok) return repoUrl
  const liveUrl = optionalNullableUrl(input.live_url, null, 'invalid_live_url')
  if (!liveUrl.ok) return liveUrl
  const workerName = optionalWorkerName(input.worker_name, null)
  if (!workerName.ok) return workerName
  const assignedSquad = await optionalAssignedSquad(env, input.assigned_squad_id, null)
  if (!assignedSquad.ok) return assignedSquad

  const now = new Date().toISOString()
  const project: Project = {
    id: crypto.randomUUID(),
    slug,
    name: input.name.trim(),
    description,
    goal,
    status,
    parent_project_id: parentProjectId as string | null,
    target_date: targetDate,
    cycle_boundary_at: null,
    stalled: 0,
    stall_threshold_days: null,
    completion_proposed_by: null,
    repo_url: repoUrl.value,
    worker_name: workerName.value,
    live_url: liveUrl.value,
    assigned_squad_id: assignedSquad.value,
    deploy_status: liveUrl.value ? 'healthy' : 'idle',
    created_at: now,
    updated_at: now,
  }

  try {
    const result = await env.DB.prepare(
      `INSERT INTO projects
       (id, slug, name, description, goal, status, parent_project_id, target_date,
        cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by,
        repo_url, worker_name, live_url, assigned_squad_id, deploy_status,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      project.id, project.slug, project.name, project.description, project.goal, project.status,
      project.parent_project_id, project.target_date,
      project.cycle_boundary_at, project.stalled, project.stall_threshold_days, project.completion_proposed_by,
      project.repo_url, project.worker_name, project.live_url, project.assigned_squad_id, project.deploy_status,
      project.created_at, project.updated_at,
    ).run()
    if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'slug_taken' }
    if (isForeignKeyViolation(error)) return { ok: false, error: 'parent_not_found' }
    const mapped = triggerMutationError(error)
    if (mapped) return { ok: false, error: mapped }
    throw error
  }

  return { ok: true, value: project }
}

export async function listProjects(env: Env, options: ListProjectsOptions = {}): Promise<Project[]> {
  const where: string[] = []
  const values: (string | null)[] = []
  if (options.status !== undefined) {
    where.push('status = ?')
    values.push(options.status)
  }
  if (options.parent_project_id !== undefined) {
    where.push(options.parent_project_id === null ? 'parent_project_id IS NULL' : 'parent_project_id = ?')
    if (options.parent_project_id !== null) values.push(options.parent_project_id)
  }
  const sql = `SELECT ${projectSelectSql()}
    FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY parent_project_id IS NOT NULL, created_at, id`
  const result = await env.DB.prepare(sql).bind(...values).all<Project>()
  return result.results ?? []
}

export async function getProject(env: Env, id: string): Promise<Project | null> {
  return env.DB.prepare(
    `SELECT ${projectSelectSql()} FROM projects WHERE id = ?`,
  ).bind(id).first<Project>()
}

export async function updateProject(
  env: Env,
  id: string,
  input: UpdateProjectInput,
): Promise<ProjectMutationResult<Project>> {
  const existing = await getProject(env, id)
  if (!existing) return { ok: false, error: 'project_not_found' }

  const suppliedKeys = Object.keys(input).filter((key) => {
    if (key === 'via_completion_gate' || key === 'via_start_gate' || key === 'lifecycle_principal') {
      return false
    }
    return input[key as keyof UpdateProjectInput] !== undefined
  })
  const statusWasSupplied = input.status !== undefined
  if (statusWasSupplied && !isProjectStatus(input.status)) return { ok: false, error: 'invalid_status' }
  if (existing.status === 'archived' && suppliedKeys.some((key) => key !== 'status')) {
    return { ok: false, error: 'archived_project' }
  }
  if (existing.status === 'archived' && !statusWasSupplied) {
    return { ok: false, error: 'archived_project' }
  }
  const nextStatus = statusWasSupplied ? input.status as ProjectStatus : existing.status
  if (statusWasSupplied && !isValidProjectStatusTransition(existing.status, nextStatus)) {
    return { ok: false, error: 'invalid_status_transition' }
  }

  // Slice 2: completed / review status flips are owned by completion-gate.ts.
  // Bare updateProject (agents, dashboard self-report) cannot mark completed.
  const viaGate = input.via_completion_gate === true
  if (
    statusWasSupplied
    && nextStatus === 'completed'
    && existing.status !== 'completed'
    && !viaGate
  ) {
    return { ok: false, error: 'completion_gate_required' }
  }
  if (
    statusWasSupplied
    && nextStatus === 'review'
    && existing.status !== 'review'
    && !viaGate
  ) {
    return { ok: false, error: 'completion_gate_required' }
  }

  // Slice 3: planned→active is owned by start-gate.ts (authorize + provision).
  // Bare updateProject cannot flip to active without a real resource commit.
  const viaStartGate = input.via_start_gate === true
  if (
    statusWasSupplied
    && existing.status === 'planned'
    && nextStatus === 'active'
    && !viaStartGate
  ) {
    return { ok: false, error: 'start_gate_required' }
  }

  const nextSlug = input.slug === undefined ? existing.slug : input.slug
  if (!isValidSlug(nextSlug)) return { ok: false, error: 'invalid_slug' }
  const nextName = input.name === undefined ? existing.name : input.name
  if (!isNonEmptyString(nextName)) return { ok: false, error: 'invalid_name' }
  const nextDescription = optionalText(input.description, existing.description)
  const nextGoal = optionalText(input.goal, existing.goal)
  if (nextDescription === null || nextGoal === null) return { ok: false, error: 'invalid_name' }
  const nextTargetDate = input.target_date === undefined ? existing.target_date : input.target_date
  if (nextTargetDate !== null && !isValidProjectTargetDate(nextTargetDate)) return { ok: false, error: 'invalid_target_date' }

  const nextParentProjectId = input.parent_project_id === undefined
    ? existing.parent_project_id
    : input.parent_project_id
  if (nextParentProjectId !== existing.parent_project_id) {
    const parentError = await validateParent(env, id, nextParentProjectId)
    if (parentError) return { ok: false, error: parentError }
    if (nextParentProjectId !== null && await hasChildren(env, id)) {
      return { ok: false, error: 'hierarchy_depth' }
    }
  }

  const nextRepoUrl = optionalNullableUrl(input.repo_url, existing.repo_url, 'invalid_repo_url')
  if (!nextRepoUrl.ok) return nextRepoUrl
  const nextLiveUrl = optionalNullableUrl(input.live_url, existing.live_url, 'invalid_live_url')
  if (!nextLiveUrl.ok) return nextLiveUrl
  const nextWorkerName = optionalWorkerName(input.worker_name, existing.worker_name)
  if (!nextWorkerName.ok) return nextWorkerName
  const nextAssignedSquad = await optionalAssignedSquad(env, input.assigned_squad_id, existing.assigned_squad_id)
  if (!nextAssignedSquad.ok) return nextAssignedSquad

  if (nextStatus === 'archived' && existing.status !== 'archived' && await hasNonArchivedChildren(env, id)) {
    return { ok: false, error: 'active_children' }
  }

  const nextProposedBy = input.completion_proposed_by !== undefined
    ? input.completion_proposed_by
    : (existing.status === 'review' && nextStatus !== 'review' ? null : existing.completion_proposed_by)

  const updated: Project = {
    ...existing,
    slug: nextSlug,
    name: nextName.trim(),
    description: nextDescription,
    goal: nextGoal,
    status: nextStatus,
    parent_project_id: nextParentProjectId as string | null,
    target_date: nextTargetDate,
    completion_proposed_by: nextProposedBy,
    repo_url: nextRepoUrl.value,
    worker_name: nextWorkerName.value,
    live_url: nextLiveUrl.value,
    assigned_squad_id: nextAssignedSquad.value,
    updated_at: nextUpdatedAt(existing.updated_at),
  }
  try {
    // Compare-and-set on (id, updated_at, status) closes the check-then-write
    // TOCTOU: a concurrent status flip between getProject and this UPDATE loses.
    const result = await env.DB.prepare(
      `UPDATE projects SET slug = ?, name = ?, description = ?, goal = ?, status = ?, parent_project_id = ?,
       target_date = ?, completion_proposed_by = ?,
       repo_url = ?, worker_name = ?, live_url = ?, assigned_squad_id = ?,
       updated_at = ?
       WHERE id = ? AND updated_at = ? AND status = ?`,
    ).bind(
      updated.slug, updated.name, updated.description, updated.goal, updated.status,
      updated.parent_project_id, updated.target_date, updated.completion_proposed_by,
      updated.repo_url, updated.worker_name, updated.live_url, updated.assigned_squad_id,
      updated.updated_at,
      updated.id, existing.updated_at, existing.status,
    ).run()
    if (!wrote(result)) {
      const current = await getProject(env, id)
      if (!current) return { ok: false, error: 'project_not_found' }
      return { ok: false, error: current.status === 'archived' ? 'archived_project' : 'receipt_failed' }
    }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'slug_taken' }
    if (isForeignKeyViolation(error)) return { ok: false, error: 'parent_not_found' }
    const mapped = triggerMutationError(error)
    if (mapped) return { ok: false, error: mapped }
    throw error
  }

  // Slice 2: completed → archived always writes a lessons-capture receipt.
  if (existing.status === 'completed' && nextStatus === 'archived') {
    const principal = typeof input.lifecycle_principal === 'string' && input.lifecycle_principal.trim() !== ''
      ? input.lifecycle_principal.trim()
      : 'system:project-lifecycle'
    const { recordLessonsCapture, defaultCompletionGateDeps } = await import('./completion-gate')
    await recordLessonsCapture(
      env,
      id,
      principal,
      updated.updated_at,
      defaultCompletionGateDeps().writeReceipt,
    )
  }

  return { ok: true, value: updated }
}

export async function listProjectSquads(env: Env, projectId: string): Promise<ProjectSquadAccess[]> {
  const result = await env.DB.prepare(
    `SELECT project_id, squad_id, access_level, granted_at
     FROM project_squad_access WHERE project_id = ? ORDER BY squad_id`,
  ).bind(projectId).all<ProjectSquadAccess>()
  return result.results ?? []
}

// projectSquadAccessStatements — FP-01 Slice 2 v2 (successor to PR #1488,
// P1-5): extracted from upsertProjectSquadAccess's own body, unchanged in
// behavior, so executeProjectAccessGrant below can append its OWN receipt
// INSERT to the SAME statement list and run everything as ONE batch —
// previously the grant (via upsertProjectSquadAccess, its own separate
// batch) and the project_access_grant_receipts INSERT were two independent
// D1 calls; a failure of the second left a live, unreceipted grant (see
// ADVERSARIAL PATTERN LIBRARY finding 5, kasra-review 2026-09-21, PR #1488).
// Pure/sync (no `env.DB.batch()` call inside), mirroring the
// buildVerdictStatements pattern (src/tasks/service.ts) for the same reason:
// a caller building a larger batch needs the STATEMENTS, not an executed
// result.
function projectSquadAccessStatements(
  env: Env,
  projectId: string,
  squadId: string,
  accessLevel: ProjectAccessLevel,
  grantedAt: string,
): D1PreparedStatement[] {
  const upsertStmt = env.DB.prepare(
    `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, squad_id) DO UPDATE SET access_level = excluded.access_level`,
  ).bind(projectId, squadId, accessLevel, grantedAt)
  const needsInvalidate = accessLevel !== 'write' && accessLevel !== 'admin'
  return needsInvalidate
    ? [upsertStmt, invalidateSquadScopedProviderBindingsStatement(env, projectId, squadId)]
    : [upsertStmt]
}

export async function upsertProjectSquadAccess(
  env: Env,
  projectId: string,
  squadId: string,
  accessLevel: unknown,
): Promise<ProjectMutationResult<ProjectSquadAccess>> {
  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'archived') return { ok: false, error: 'archived_project' }
  if ((await env.DB.prepare('SELECT 1 FROM squads WHERE id = ?').bind(squadId).first()) === null) {
    return { ok: false, error: 'squad_not_found' }
  }
  if (!isProjectAccessLevel(accessLevel)) return { ok: false, error: 'invalid_access_level' }

  const grantedAt = new Date().toISOString()
  // SECURITY (#453 follow-up, adversarial review on 86b05bb): the access
  // write and the binding invalidation were two separate statements. An
  // error between them, or a concurrent bind() reading the OLD access level
  // in between, could leave a squad-scoped connector attached after its
  // authority was revoked. `env.DB.batch()` runs both as ONE atomic
  // transaction (the same primitive used elsewhere in this codebase for
  // exactly this "two writes, one unit" shape — e.g. flight/service.ts,
  // auth/index.ts) — there is no instant where the access change is
  // committed but the invalidation is not, or vice versa.
  const statements = projectSquadAccessStatements(env, projectId, squadId, accessLevel, grantedAt)
  try {
    const results = statements.length > 1 ? await env.DB.batch(statements) : [await statements[0].run()]
    if (!wrote(results[0])) return { ok: false, error: 'receipt_failed' }
  } catch (error) {
    const mapped = triggerMutationError(error)
    if (mapped) return { ok: false, error: mapped }
    if (isForeignKeyViolation(error)) {
      if (!await getProject(env, projectId)) return { ok: false, error: 'project_not_found' }
      if ((await env.DB.prepare('SELECT 1 FROM squads WHERE id = ?').bind(squadId).first()) === null) {
        return { ok: false, error: 'squad_not_found' }
      }
      return { ok: false, error: 'project_not_found' }
    }
    throw error
  }

  const access = await env.DB.prepare(
    'SELECT project_id, squad_id, access_level, granted_at FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
  ).bind(projectId, squadId).first<ProjectSquadAccess>()
  return { ok: true, value: access ?? { project_id: projectId, squad_id: squadId, access_level: accessLevel, granted_at: grantedAt } }
}

export interface ProjectAccessGrantReceipt {
  id: string
  project_id: string
  squad_id: string
  member_id: string
  access_level: ProjectAccessLevel
  proposal_id: string
  verdict_id: string
  decided_by: string
  decided_via: string | null
  created_at: string
}

export type ProjectAccessGrantError = ProjectMutationError | 'verdict_mismatch'

// executeProjectAccessGrant — FP-01 Slice 2 (mupot#1443, brief §2 Task A): the
// ONE place a `project_access` routine proposal's human verdict turns into a
// standing grant. Called EXCLUSIVELY from src/routines/actions.ts's
// executeRoutineAction, itself only reachable after approvedGate() has
// confirmed a task_verdicts row exists for the control task — this function
// never gates on that itself (same "caller gates before calling" doctrine as
// createHomeForMember/createSquad in src/org/service.ts), it only WRITES.
//
// This is the narrow, server-internal exception the brief asked for: it
// calls upsertProjectSquadAccess directly (the same function project_squad_set
// calls), never the MCP tool's requireWorkspaceAdmin gate — project_squad_access
// is DELIBERATELY UNGUARDED for a home-squad target (src/auth/capability.ts's
// planeCoversScope table inventory says so explicitly: "FP-01 Slice 2's own
// design uses this to give a member's home write access to a project;
// blocking it would break the feature this flight exists to build"). No
// change to project_squad_set's own authz — this function is a second,
// narrower caller of the same underlying writer, reachable only through the
// routine-proposal verdict path, never exposed as its own MCP tool.
//
// IDEMPOTENT on proposalId (UNIQUE(proposal_id) on project_access_grant_receipts,
// migrations/0157): a retried execution (executeRoutineAction can be replayed —
// see src/routines/actions.ts) re-runs the upsert (itself idempotent) and finds
// the EXISTING receipt row rather than writing a second one or erroring.
//
// ATOMIC grant + receipt (FP-01 Slice 2 v2, successor to PR #1488, P1-5): the
// grant (project_squad_access) and its append-only receipt now land in ONE
// `env.DB.batch()` — built from projectSquadAccessStatements' SAME statements
// upsertProjectSquadAccess uses, plus this function's own receipt INSERT
// appended to the list, never as two independent D1 calls. Closes the
// adversarial gate's PROVEN failure mode: forcing only the receipt INSERT to
// fail used to leave project_squad_access committed with ZERO
// project_access_grant_receipts rows — "the standing privilege is live and
// unreceipted," the exact outcome 0157's own header says the table exists to
// prevent. `assertWritten` on each required statement turns a silent 0-row
// write into a loud throw rather than a phantom success.
//
// KNOWN GAP, NOT FIXED HERE (P2-5, kasra-review adversarial round 2 on PR
// #1490 — Kasra-core's call): there is no RECEIPTED path to REVOKE a grant
// this function made. Once a member's home squad holds access_level on a
// project, the only way to remove it is project_squad_set (an org-admin
// tool, itself the P2-9 bypass documented at its own definition,
// src/mcp/projects.ts) or a raw project_squad_access UPSERT that overwrites
// the level in place — neither writes anything to
// project_access_grant_receipts, so a revoked or downgraded grant leaves NO
// audit trail distinguishable from "never granted differently." A
// project_access_revoke tool (mirroring this function's own atomic
// grant+receipt shape, with a `kind='revoke'` receipt row) is the natural
// fix but is real, net-new scope beyond this round's remit — filed, not
// built here.
export async function executeProjectAccessGrant(
  env: Env,
  input: {
    projectId: string
    squadId: string
    memberId: string
    accessLevel: unknown
    proposalId: string
    verdictId: string
    decidedBy: string
    decidedVia: string | null
  },
): Promise<ProjectMutationResult<ProjectAccessGrantReceipt> | { ok: false; error: ProjectAccessGrantError }> {
  const existingReceipt = await env.DB.prepare(
    `SELECT id, project_id, squad_id, member_id, access_level, proposal_id, verdict_id, decided_by, decided_via, created_at
       FROM project_access_grant_receipts WHERE proposal_id = ?`,
  ).bind(input.proposalId).first<ProjectAccessGrantReceipt>()
  if (existingReceipt) {
    // A proposal id is immutable once decided — a replay with a DIFFERENT
    // verdict id would mean two verdicts claim to authorize the same
    // proposal, which the caller (executeRoutineAction) must never allow to
    // reach here twice with different verdicts. Checked anyway: silent
    // divergence between the receipt and a later mismatched replay is worse
    // than a loud refusal.
    if (existingReceipt.verdict_id !== input.verdictId) return { ok: false, error: 'verdict_mismatch' }
    return { ok: true, value: existingReceipt }
  }
  if (!isProjectAccessLevel(input.accessLevel)) return { ok: false, error: 'invalid_access_level' }

  // Same pre-checks upsertProjectSquadAccess itself performs — duplicated
  // (not delegated) because this function now builds its OWN batch rather
  // than calling upsertProjectSquadAccess end-to-end, so it must reproduce
  // its validation ahead of that batch.
  const project = await getProject(env, input.projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'archived') return { ok: false, error: 'archived_project' }
  if ((await env.DB.prepare('SELECT 1 FROM squads WHERE id = ?').bind(input.squadId).first()) === null) {
    return { ok: false, error: 'squad_not_found' }
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const grantStatements = projectSquadAccessStatements(env, input.projectId, input.squadId, input.accessLevel, now)
  const receiptStmt = env.DB.prepare(
    `INSERT INTO project_access_grant_receipts (
      id, tenant, project_id, squad_id, member_id, access_level,
      proposal_id, verdict_id, decided_by, decided_via, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, env.TENANT_SLUG, input.projectId, input.squadId, input.memberId, input.accessLevel,
    input.proposalId, input.verdictId, input.decidedBy, input.decidedVia, now,
  )
  try {
    const results = await env.DB.batch([...grantStatements, receiptStmt])
    // grantStatements[0] (the upsert) and the LAST result (the receipt
    // INSERT) must each write exactly 1 row; a middle invalidate statement
    // (present only when accessLevel is 'read') is best-effort and may
    // legitimately write 0 (upsertProjectSquadAccess never checks it
    // either) — asserted individually rather than via assertBatchWritten,
    // which would wrongly demand >=1 from that optional statement too.
    assertWritten(results[0], 'execute_project_access_grant.upsert', 1)
    assertWritten(results[results.length - 1], 'execute_project_access_grant.receipt', 1)
  } catch (error) {
    const mapped = triggerMutationError(error)
    if (mapped) return { ok: false, error: mapped }
    if (isForeignKeyViolation(error)) {
      if (!await getProject(env, input.projectId)) return { ok: false, error: 'project_not_found' }
      if ((await env.DB.prepare('SELECT 1 FROM squads WHERE id = ?').bind(input.squadId).first()) === null) {
        return { ok: false, error: 'squad_not_found' }
      }
      return { ok: false, error: 'project_not_found' }
    }
    // UNIQUE(proposal_id) refusal: a concurrent execution of the SAME
    // proposal already inserted the receipt (and its grant) between our
    // SELECT above and this batch committing. Adopt the winner rather than
    // error — same "classify, don't compensate a real winner" doctrine used
    // throughout this codebase (e.g. org/service.ts's createHomeForMember).
    const raced = await env.DB.prepare(
      `SELECT id, project_id, squad_id, member_id, access_level, proposal_id, verdict_id, decided_by, decided_via, created_at
         FROM project_access_grant_receipts WHERE proposal_id = ?`,
    ).bind(input.proposalId).first<ProjectAccessGrantReceipt>()
    if (raced) return { ok: true, value: raced }
    return { ok: false, error: 'receipt_failed' }
  }
  return {
    ok: true,
    value: {
      id, project_id: input.projectId, squad_id: input.squadId, member_id: input.memberId,
      access_level: input.accessLevel, proposal_id: input.proposalId, verdict_id: input.verdictId,
      decided_by: input.decidedBy, decided_via: input.decidedVia, created_at: now,
    },
  }
}

export async function removeProjectSquadAccess(
  env: Env,
  projectId: string,
  squadId: string,
): Promise<ProjectMutationResult<void>> {
  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'archived') return { ok: false, error: 'archived_project' }
  // SECURITY (#453 follow-up): atomic with the invalidation below, same
  // reasoning as upsertProjectSquadAccess — removal always drops the squad
  // to zero access, so invalidation is unconditional here.
  const deleteStmt = env.DB.prepare(
    'DELETE FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
  ).bind(projectId, squadId)
  try {
    const [result] = await env.DB.batch([
      deleteStmt,
      invalidateSquadScopedProviderBindingsStatement(env, projectId, squadId),
    ])
    if (!wrote(result)) return { ok: false, error: 'receipt_failed' }
  } catch (error) {
    const mapped = triggerMutationError(error)
    if (mapped) return { ok: false, error: mapped }
    throw error
  }
  return { ok: true, value: undefined }
}

// SECURITY (#453 follow-up): a squad-scoped connector was only ever a valid
// project_provider_binding reference because that squad held write/admin here
// at BIND time (see upsertProjectBinding's actor check). If that squad's
// access is later downgraded below write/admin, or removed entirely, a stored
// connector_id referencing IT becomes a stale grant of authority nobody
// currently holds — the adapters that will eventually consume connector_id
// (Linear/Notion, still pending_credentials stubs) have no project-scope
// recheck at resolve time, so the binding itself must self-heal here instead.
// Clearing to NULL (not deleting the binding) preserves the provider/
// external_id link; a manager with current authority can re-bind a connector.
//
// Returns a bound-but-not-yet-run statement so callers can include it in an
// `env.DB.batch()` alongside the access mutation itself — adversarial review
// found the access write and this invalidation, as two separate `run()`
// calls, were not atomic (an error, or a concurrently-racing bind(), could
// land between them).
function invalidateSquadScopedProviderBindingsStatement(
  env: Env,
  projectId: string,
  squadId: string,
) {
  return env.DB.prepare(
    `UPDATE project_provider_bindings
        SET connector_id = NULL, updated_at = ?
      WHERE project_id = ?
        AND connector_id IN (
          SELECT id FROM connectors WHERE scope_type = 'squad' AND scope_id = ?
        )`,
  ).bind(new Date().toISOString(), projectId, squadId)
}
