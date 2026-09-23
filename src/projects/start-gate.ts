// Project lifecycle start-gate (slice 3) — authorize + provision atomically.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// planned → active is NOT a bare enum flip. One governed action must:
//   1) seed >=1 first task from the project goal onto a write/admin squad, AND
//   2) mint/confirm that squad's resource via the EXISTING grant path
//      (mintAgentBoundToken / setAgentSquadAccess) — no fork.
// If the resource commit fails, the project stays planned and surfaces as
// blocked-start (no false active). A stale planned project with no provision
// attempt escalates to org owners (ghost-start alarm).

import type { BusEvent, Env, Project, ProjectAccessLevel, Task } from '../types'
import {
  mintAgentBoundToken,
  resolveActiveAgentMember,
  revokeMemberToken,
  type AgentForMint,
} from '../members/service'
import { setAgentSquadAccess } from '../members/agent-access'
import { createTask } from '../tasks/service'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { createDepartment, createSquad } from '../org/service'
import { createBus } from '../bus'
import { lifecycleTaskId } from './circuit-breaker'
import { DEFAULT_CYCLE_DAYS, nextCycleBoundary } from './cycle-creation'
import { setProjectStalledFlag } from './stall-detector'
import { getProject, updateProject, upsertProjectSquadAccess, type ProjectMutationResult } from './service'

// A small, DELIBERATE duplicate of src/mcp/provision.ts's emitProvisioned — same
// "org.provisioned" event shape, same best-effort/non-fatal discipline (mupot#1498,
// P2-4: the auto-created department/squad below must emit the SAME event
// create_department/create_squad already do, so a consumer watching org.provisioned
// does not see a structural create appear from nowhere just because it happened
// through project_update's start-gate instead of the provision tools). NOT imported
// from provision.ts: doing so would close a NEW cycle (provision.ts -> mcp/index.ts
// -> mcp/projects.ts -> this file) through a module that is not already part of the
// existing, carefully-entered index/provision cycle.
async function emitOrgProvisioned(
  env: Env,
  memberId: string,
  kind: 'department' | 'squad',
  id: string,
  extra: { squad_id?: string } = {},
): Promise<void> {
  const event: BusEvent<{ kind: string; id: string; by: string }> = {
    type: 'org.provisioned',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    actor: { kind: 'member', id: memberId },
    payload: { kind, id, by: memberId },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch {
    console.error('start-gate: org.provisioned emit failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      kind,
      id,
    })
  }
}

export const START_GATE_STEP = 'project_start_gate'
export const START_GATE_SCHEMA = 'mupot.project_start_gate/v1'
export const BLOCKED_START_STEP = 'blocked_start'
export const BLOCKED_START_SCHEMA = 'mupot.blocked_start/v1'
export const GHOST_START_ALARM_STEP = 'ghost_start_alarm'
export const GHOST_START_ALARM_SCHEMA = 'mupot.ghost_start_alarm/v1'
export const START_GATE_PRINCIPAL = 'system:project-loop'
/** Default age (days) before a planned project with no provision attempt alarms. */
export const DEFAULT_GHOST_START_DAYS = 7
/** Capability confirmed/minted on the acting squad via the existing grant path. */
export const START_RESOURCE_CAPABILITY = 'member' as const
/** Provenance marker embedded in start-gate seeded task bodies. */
export const START_GATE_SEED_MARKER = '<!-- mupot:start-gate-seed -->'

export type StartBlockReason =
  | 'project_not_found'
  | 'not_planned'
  | 'no_writable_squad'
  | 'no_squad_agent'
  | 'resource_commit_failed'
  | 'task_seed_failed'
  | 'activate_failed'

export type ResourceCommitKind = 'minted' | 'confirmed'

export interface StartGateSuccess {
  ok: true
  project: Project
  task_id: string
  squad_id: string
  agent_id: string
  resource: ResourceCommitKind
}

export interface StartGateFailure {
  ok: false
  error: StartBlockReason
  project: Project | null
}

export type StartGateResult = StartGateSuccess | StartGateFailure

export type GhostStartOutcome = 'skipped' | 'alarmed' | 'already_alarmed'

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
  input: { status: 'active'; via_start_gate?: boolean },
) => Promise<ProjectMutationResult<Project>>

export type CreateTaskFn = (
  env: Env,
  input: {
    squad_id: string
    project_id: string
    title: string
    body: string
    done_when: string
    assignee_agent_id: string
  },
) => Promise<Task>

export type MintAgentBoundTokenFn = (
  env: Env,
  agent: AgentForMint,
  label: string,
  grantCapability: typeof START_RESOURCE_CAPABILITY,
) => Promise<{ tokenId: string; memberId: string }>

export type RevokeMemberTokenFn = (
  env: Env,
  memberId: string,
  tokenId: string,
) => Promise<boolean>

export type ResolveActiveAgentMemberFn = (
  env: Env,
  agentId: string,
) => Promise<string | 'unminted' | 'ambiguous'>

export type SetAgentSquadAccessFn = (
  env: Env,
  input: {
    agentId: string
    memberId: string
    squadId: string
    capability: typeof START_RESOURCE_CAPABILITY
  },
) => Promise<
  | { ok: true; result: 'created' | 'updated' | 'unchanged' | 'removed' }
  | { ok: false; error: string }
>

export interface StartGateDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
  createTask: CreateTaskFn
  mintAgentBoundToken: MintAgentBoundTokenFn
  revokeMemberToken: RevokeMemberTokenFn
  resolveActiveAgentMember: ResolveActiveAgentMemberFn
  setAgentSquadAccess: SetAgentSquadAccessFn
  principal: string
  /**
   * The human member driving THIS call, when one exists (mupot#1498, P2-4) —
   * threaded through so the no-writable-squad auto-create's org.provisioned
   * events (emitOrgProvisioned, below) attribute to the real caller, the same
   * way create_department/create_squad already do. null for a system-driven
   * call (e.g. the ghost-start reaper) — those auto-creates, if ever added,
   * emit nothing rather than attribute a structural change to no one.
   */
  actorMemberId: string | null
  /**
   * Clock for the post-activation cycle-boundary reset below. Optional so the
   * three existing call sites (mcp/projects.ts, dashboard/index.ts,
   * projects/index.ts) need no change — defaults to the real clock inside
   * startProject itself. Tests override it for a deterministic boundary.
   */
  nowIso?: () => string
}

export interface GhostStartDeps {
  writeReceipt: WriteReceiptFn
  listStalePlanned?: (env: Env, olderThanIso: string) => Promise<Project[]>
  hasProvisionAttempt?: (env: Env, projectId: string) => Promise<boolean>
  listOrgOwnerMemberIds?: (env: Env) => Promise<string[]>
  ghostThresholdDays: number
  principal: string
}

export function defaultStartGateDeps(actorMemberId: string | null = null): StartGateDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: (env, id, input) => updateProject(env, id, { ...input, via_start_gate: true }),
    createTask: (env, input) => createTask(env, input, { skipMirror: true }),
    mintAgentBoundToken: (env, agent, label, capability) =>
      mintAgentBoundToken(env, agent, label, capability),
    revokeMemberToken: (env, memberId, tokenId) => revokeMemberToken(env, memberId, tokenId),
    resolveActiveAgentMember,
    setAgentSquadAccess: (env, input) => setAgentSquadAccess(env, input),
    principal: START_GATE_PRINCIPAL,
    actorMemberId,
  }
}

export function defaultGhostStartDeps(): GhostStartDeps {
  return {
    writeReceipt: writeReceiptToD1,
    listStalePlanned: listStalePlannedProjects,
    hasProvisionAttempt: hasStartProvisionAttempt,
    listOrgOwnerMemberIds: listOrgOwnerMemberIds,
    ghostThresholdDays: DEFAULT_GHOST_START_DAYS,
    principal: START_GATE_PRINCIPAL,
  }
}

export function startInstanceId(projectId: string): string {
  return `project-start:${projectId}`
}

export function ghostInstanceId(projectId: string): string {
  return `project-ghost:${projectId}`
}

export function isWritableProjectAccess(level: ProjectAccessLevel): boolean {
  return level === 'write' || level === 'admin'
}

/** Pure: build the first-task payload from the project goal (fallback to name). */
export function seedTaskFromGoal(project: Pick<Project, 'name' | 'goal'>): {
  title: string
  body: string
  done_when: string
} {
  const goal = project.goal.trim()
  const name = project.name.trim() || 'project'
  if (goal.length === 0) {
    return {
      title: `Start ${name}`,
      body: `Kick off ${name}\n\n${START_GATE_SEED_MARKER}`,
      done_when: `First actionable delivery exists for ${name}`,
    }
  }
  const title = goal.length <= 120 ? goal : `${goal.slice(0, 117)}...`
  return {
    title,
    body: `${goal}\n\n${START_GATE_SEED_MARKER}`,
    done_when: `First delivery toward: ${goal.slice(0, 200)}`,
  }
}

export function isStartGateSeedTask(body: string | null, squadId: string, expectedSquadId: string): boolean {
  if (squadId !== expectedSquadId) return false
  if (body === null) return false
  return body.includes(START_GATE_SEED_MARKER)
}

export function ghostCutoffIso(nowIso: string, thresholdDays: number): string {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
  }
  if (!Number.isFinite(thresholdDays) || thresholdDays < 0) {
    throw new Error('invalid_ghost_threshold_days')
  }
  return new Date(nowMs - thresholdDays * 24 * 60 * 60 * 1000).toISOString()
}

interface WritableSquadRow {
  squad_id: string
  access_level: ProjectAccessLevel
}

interface SquadAgentRow {
  id: string
  squad_id: string
  slug: string
  name: string
}

async function pickWritableSquad(
  env: Env,
  projectId: string,
): Promise<WritableSquadRow | null> {
  const row = await env.DB.prepare(
    `SELECT squad_id, access_level
       FROM project_squad_access
      WHERE project_id = ?1
        AND access_level IN ('write', 'admin')
      ORDER BY CASE access_level WHEN 'admin' THEN 0 ELSE 1 END, squad_id ASC
      LIMIT 1`,
  )
    .bind(projectId)
    .first<WritableSquadRow>()
  return row ?? null
}

// mupot#1498: "project_update on a project without any squad should
// auto-create `<slug>-sqd` + ADMIN edge instead of refusing no_writable_squad".
//
// WHY THIS IS SAFE TO DO INSIDE startProject, NOT JUST INSIDE the MCP
// project_update tool: every caller of startProject
// (src/mcp/projects.ts's toolProjectUpdate, src/dashboard/index.ts's
// POST /projects/:id/status, src/projects/index.ts's PATCH /:id) already
// gates workspace/org admin BEFORE calling — requireWorkspaceAdmin,
// canManageProjects, access.workspaceAdmin respectively. "keep the refusal
// for non-admins" therefore holds by CONSTRUCTION: a non-admin caller never
// reaches this function at all, so there is nothing to keep refusing here
// beyond what the three call sites already refuse before this line runs.
//
// WHICH DEPARTMENT: a project carries no department of its own (projects
// are workspace objects — see src/projects/service.ts), so a brand-new
// squad needs somewhere to live. Rather than invent a per-project
// department (churning one new department row per project with no writable
// squad), this reuses ONE well-known department for every auto-created
// project squad — the same "adopt, don't fork" discipline
// createHomeForMember applies to a member's home department
// (src/org/service.ts). A second project with no squad reuses the SAME
// department; only the squad itself is per-project.
const PROJECT_SQUAD_DEPARTMENT_SLUG = 'dept-projects'
const PROJECT_SQUAD_DEPARTMENT_NAME = 'Projects'
const AUTO_SQUAD_SLUG_SUFFIX = '-sqd'

async function findProjectSquadDepartment(env: Env): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT id FROM departments WHERE slug = ?1 LIMIT 1`)
    .bind(PROJECT_SQUAD_DEPARTMENT_SLUG)
    .first<{ id: string }>()
}

async function resolveProjectSquadDepartmentId(env: Env, actorMemberId: string | null): Promise<string | null> {
  const existing = await findProjectSquadDepartment(env)
  if (existing) return existing.id
  const created = await createDepartment(env, {
    slug: PROJECT_SQUAD_DEPARTMENT_SLUG,
    name: PROJECT_SQUAD_DEPARTMENT_NAME,
  })
  if (created.ok) {
    // P2-4: the same org.provisioned event create_department's own MCP tool
    // emits — see emitOrgProvisioned's header for why this is a deliberate
    // duplicate rather than an import.
    if (actorMemberId) await emitOrgProvisioned(env, actorMemberId, 'department', created.value.id)
    return created.value.id
  }
  if (created.error === 'slug_taken') {
    // Race: a concurrent start-gate call for a DIFFERENT project won this
    // exact department between our read and this insert. Adopt it — same
    // "classify, don't compensate a real winner" doctrine createHomeForMember
    // documents for its own department race.
    const raced = await findProjectSquadDepartment(env)
    if (raced) return raced.id
  }
  return null
}

/**
 * Auto-create `<project.slug>-sqd` under the shared projects department, wire
 * an ADMIN project<->squad edge, and return it in the same shape
 * pickWritableSquad returns — so the caller below cannot tell an
 * already-writable project from a freshly-provisioned one. Returns null on
 * any failure (entitlement limit, a genuine D1 error) — the caller then
 * fails closed with 'no_writable_squad', exactly as it did before this
 * function existed.
 */
async function autoCreateWritableSquad(
  env: Env,
  project: Project,
  actorMemberId: string | null,
): Promise<WritableSquadRow | null> {
  const departmentId = await resolveProjectSquadDepartmentId(env, actorMemberId)
  if (!departmentId) return null

  const squadSlug = `${project.slug}${AUTO_SQUAD_SLUG_SUFFIX}`
  const existing = await env.DB.prepare(
    `SELECT id FROM squads WHERE department_id = ?1 AND slug = ?2 LIMIT 1`,
  )
    .bind(departmentId, squadSlug)
    .first<{ id: string }>()

  let squadId: string
  if (existing) {
    squadId = existing.id
  } else {
    const created = await createSquad(
      env,
      departmentId,
      { slug: squadSlug, name: `${project.name} Squad` },
      // P3-2 (mupot#1498 successor to PR #1510): stamp provenance so a LATER
      // team_bootstrap call adopting this exact squad by derived slug can
      // recognize it as created by the acting admin, rather than falling
      // through to the org-admin adopt:true override every time.
      { createdByMemberId: actorMemberId ?? undefined },
    )
    if (created.ok) {
      squadId = created.value.id
      // P2-4: same org.provisioned event create_squad's own MCP tool emits.
      if (actorMemberId) await emitOrgProvisioned(env, actorMemberId, 'squad', squadId, { squad_id: squadId })
    } else if (created.error === 'slug_taken') {
      const raced = await env.DB.prepare(
        `SELECT id FROM squads WHERE department_id = ?1 AND slug = ?2 LIMIT 1`,
      )
        .bind(departmentId, squadSlug)
        .first<{ id: string }>()
      if (!raced) return null
      squadId = raced.id
    } else {
      return null
    }
  }

  const edge = await upsertProjectSquadAccess(env, project.id, squadId, 'admin')
  if (!edge.ok) return null
  return { squad_id: squadId, access_level: 'admin' }
}

async function pickSquadAgent(env: Env, squadId: string): Promise<SquadAgentRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, slug, name
       FROM agents
      WHERE squad_id = ?1 AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  )
    .bind(squadId)
    .first<SquadAgentRow>()
  return row ?? null
}

async function countProjectTasks(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?1',
  )
    .bind(projectId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

async function pickExistingSeedTaskId(
  env: Env,
  projectId: string,
  squadId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, body FROM tasks
      WHERE project_id = ?1
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(projectId)
    .all<{ id: string; squad_id: string; body: string | null }>()
  for (const candidate of row.results ?? []) {
    if (isStartGateSeedTask(candidate.body, candidate.squad_id, squadId)) {
      return candidate.id
    }
  }
  return null
}

/**
 * Mint (if unminted) or confirm (if already welded) the agent-bound resource
 * through the shared members/service grant path — never a forked provisioner.
 */
export async function commitSquadResource(
  env: Env,
  agent: AgentForMint,
  deps: Pick<
    StartGateDeps,
    'mintAgentBoundToken' | 'resolveActiveAgentMember' | 'setAgentSquadAccess'
  >,
): Promise<{ kind: ResourceCommitKind; memberId: string; tokenId: string | null } | null> {
  const identity = await deps.resolveActiveAgentMember(env, agent.id)
  if (identity === 'ambiguous') return null

  if (identity === 'unminted') {
    const minted = await deps.mintAgentBoundToken(
      env,
      agent,
      `start-gate:${agent.slug}`,
      START_RESOURCE_CAPABILITY,
    )
    return { kind: 'minted', memberId: minted.memberId, tokenId: minted.tokenId }
  }

  const outcome = await deps.setAgentSquadAccess(env, {
    agentId: agent.id,
    memberId: identity,
    squadId: agent.squad_id,
    capability: START_RESOURCE_CAPABILITY,
  })
  if (!outcome.ok) return null
  return { kind: 'confirmed', memberId: identity, tokenId: null }
}

async function compensateStartProvision(
  env: Env,
  deps: StartGateDeps,
  minted: { tokenId: string; memberId: string } | null,
  createdTaskId: string | null,
): Promise<void> {
  if (createdTaskId !== null) {
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(createdTaskId).run()
  }
  if (minted !== null) {
    await deps.revokeMemberToken(env, minted.memberId, minted.tokenId)
  }
}

export async function recordBlockedStart(
  env: Env,
  projectId: string,
  reason: StartBlockReason,
  principal: string,
  writeReceipt: WriteReceiptFn,
): Promise<void> {
  await writeReceipt(env, {
    instanceId: startInstanceId(projectId),
    taskId: lifecycleTaskId(projectId),
    stepName: BLOCKED_START_STEP,
    status: 'error',
    detail: JSON.stringify({
      schema: BLOCKED_START_SCHEMA,
      project_id: projectId,
      reason,
      principal,
    }),
  })
}

export async function recordStartGateSuccess(
  env: Env,
  detail: {
    projectId: string
    taskId: string
    squadId: string
    agentId: string
    resource: ResourceCommitKind
    principal: string
  },
  writeReceipt: WriteReceiptFn,
): Promise<void> {
  await writeReceipt(env, {
    instanceId: startInstanceId(detail.projectId),
    taskId: lifecycleTaskId(detail.projectId),
    stepName: START_GATE_STEP,
    status: 'ok',
    detail: JSON.stringify({
      schema: START_GATE_SCHEMA,
      project_id: detail.projectId,
      task_id: detail.taskId,
      squad_id: detail.squadId,
      agent_id: detail.agentId,
      resource: detail.resource,
      principal: detail.principal,
    }),
  })
}

/** True when a start or blocked-start receipt exists (a provision was attempted). */
export async function hasStartProvisionAttempt(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM workflow_receipts
      WHERE instance_id = ?1
        AND step_name IN (?2, ?3)
      LIMIT 1`,
  )
    .bind(startInstanceId(projectId), START_GATE_STEP, BLOCKED_START_STEP)
    .first<{ ok: number }>()
  return row !== null
}

export async function listStalePlannedProjects(
  env: Env,
  olderThanIso: string,
): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id, target_date,
            cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by,
            created_at, updated_at
       FROM projects
      WHERE status = 'planned'
        AND created_at <= ?1
      ORDER BY created_at ASC, id ASC
      LIMIT 25`,
  )
    .bind(olderThanIso)
    .all<Project>()
  return result.results ?? []
}

export async function listOrgOwnerMemberIds(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT c.member_id AS member_id
       FROM capabilities c
       JOIN members m ON m.id = c.member_id
      WHERE c.scope_type = 'org'
        AND c.scope_id IS NULL
        AND c.capability = 'owner'
        AND m.tenant = ?1
        AND m.status = 'active'
      ORDER BY c.member_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<{ member_id: string }>()
  return (result.results ?? []).map((row) => row.member_id)
}

export async function recordGhostStartAlarm(
  env: Env,
  projectId: string,
  ownerMemberIds: readonly string[],
  principal: string,
  writeReceipt: WriteReceiptFn,
): Promise<boolean> {
  const before = await env.DB.prepare(
    `SELECT 1 AS ok FROM workflow_receipts
      WHERE instance_id = ?1 AND step_name = ?2 LIMIT 1`,
  )
    .bind(ghostInstanceId(projectId), GHOST_START_ALARM_STEP)
    .first<{ ok: number }>()
  if (before !== null) return false

  await writeReceipt(env, {
    instanceId: ghostInstanceId(projectId),
    taskId: lifecycleTaskId(projectId),
    stepName: GHOST_START_ALARM_STEP,
    status: 'ok',
    detail: JSON.stringify({
      schema: GHOST_START_ALARM_SCHEMA,
      project_id: projectId,
      owner_member_ids: ownerMemberIds,
      principal,
      reason: 'stale_planned_no_provision_attempt',
    }),
  })
  return true
}

/**
 * Governed planned → active: resource commit + seed first task, then activate.
 * On any downstream failure after mint/task, compensate (revoke minted token +
 * delete created task) BEFORE recording blocked-start — no orphaned credential/task.
 */
export async function startProject(
  env: Env,
  projectId: string,
  deps: StartGateDeps,
): Promise<StartGateResult> {
  const project = await getProject(env, projectId)
  if (!project) {
    return { ok: false, error: 'project_not_found', project: null }
  }
  if (project.status !== 'planned') {
    return { ok: false, error: 'not_planned', project }
  }

  let mintedCredential: { tokenId: string; memberId: string } | null = null
  let createdTaskId: string | null = null

  const fail = async (error: StartBlockReason): Promise<StartGateFailure> => {
    await compensateStartProvision(env, deps, mintedCredential, createdTaskId)
    mintedCredential = null
    createdTaskId = null
    await recordBlockedStart(env, projectId, error, deps.principal, deps.writeReceipt)
    const current = await getProject(env, projectId)
    return { ok: false, error, project: current ?? project }
  }

  let squad = await pickWritableSquad(env, projectId)
  if (!squad) {
    // mupot#1498: "a project WITHOUT ANY SQUAD" auto-creates `<slug>-sqd` +
    // an ADMIN edge instead of refusing. A project that already has a squad
    // edge — just not a write/admin one (e.g. a deliberate read-only link) —
    // is a DIFFERENT case: an operator chose that edge on purpose, and
    // auto-creating a second squad behind their back would be a surprise
    // write, not a convenience. Only the true "zero edges at all" case
    // auto-provisions; see autoCreateWritableSquad's doc comment for why
    // this is safe here regardless (every caller of startProject already
    // gates admin before reaching this line, so "keep the refusal for
    // non-admins" holds by construction).
    const hasAnyEdge = await env.DB.prepare(
      `SELECT 1 FROM project_squad_access WHERE project_id = ?1 LIMIT 1`,
    )
      .bind(projectId)
      .first()
    if (!hasAnyEdge) {
      squad = await autoCreateWritableSquad(env, project, deps.actorMemberId)
    }
    if (!squad) return fail('no_writable_squad')
  }

  const agentRow = await pickSquadAgent(env, squad.squad_id)
  if (!agentRow) return fail('no_squad_agent')

  const agent: AgentForMint = {
    id: agentRow.id,
    squad_id: agentRow.squad_id,
    slug: agentRow.slug,
    name: agentRow.name,
  }

  let resource: { kind: ResourceCommitKind; memberId: string }
  try {
    const committed = await commitSquadResource(env, agent, deps)
    if (!committed) return fail('resource_commit_failed')
    resource = committed
    if (committed.kind === 'minted' && committed.tokenId !== null) {
      mintedCredential = { tokenId: committed.tokenId, memberId: committed.memberId }
    }
  } catch {
    return fail('resource_commit_failed')
  }

  let taskId: string
  try {
    const existingCount = await countProjectTasks(env, projectId)
    // mupot: reviving an archived project (archived -> planned -> active)
    // re-runs this same startProject path. `existingCount > 0` means the
    // project already carries tasks, but that is NOT proof a start-gate seed
    // exists among them — every project that predates the start gate (or
    // whose seed lived on a squad edge that was since removed/changed) has
    // tasks with none of them carrying START_GATE_SEED_MARKER on the picked
    // squad. The idempotence guard below (pickExistingSeedTaskId) exists so a
    // RETRY after a partial failure reuses the seed it already made rather
    // than minting a second one — it was never meant to be the ONLY path to
    // a seed. Fall through to the exact same create-a-seed logic the
    // existingCount === 0 branch runs when no seed is found, instead of
    // failing closed with task_seed_failed. A seed that exists on a
    // DIFFERENT squad than the one just picked (e.g. project_squad_access
    // was repointed between an old activation and this one) is deliberately
    // NOT reused here — isStartGateSeedTask's squadId check means
    // pickExistingSeedTaskId will not find it, and a fresh seed is created on
    // the picked squad instead, so the seed always lives where the assignee
    // agent actually is.
    let existingId: string | null = null
    if (existingCount > 0) {
      existingId = await pickExistingSeedTaskId(env, projectId, squad.squad_id)
    }
    if (existingId) {
      taskId = existingId
    } else {
      const seed = seedTaskFromGoal(project)
      const task = await deps.createTask(env, {
        squad_id: squad.squad_id,
        project_id: projectId,
        title: seed.title,
        body: seed.body,
        done_when: seed.done_when,
        assignee_agent_id: agent.id,
      })
      taskId = task.id
      createdTaskId = task.id
    }
  } catch {
    return fail('task_seed_failed')
  }

  const activated = await deps.updateProject(env, projectId, {
    status: 'active',
    via_start_gate: true,
  })
  if (!activated.ok || activated.value.status !== 'active') {
    return fail('activate_failed')
  }

  // mupot: a REVIVED project (archived -> planned -> active, this same path)
  // can carry an old, already-elapsed cycle_boundary_at with stalled=1 from
  // before it was archived. shouldEvaluateBreaker (circuit-breaker.ts)
  // early-evaluates ANY stalled=1 project that has a non-null boundary — so
  // without a reset, a revived project is immediately re-killable on the next
  // loop tick, and project_recommit against that stale boundary already
  // returns already_decided (a KILL receipt is on file for it), so nobody can
  // save it either. Reset both, exactly as a brand-new active project would
  // start: reuse nextCycleBoundary's pure now+interval branch (existing
  // boundary passed as null so this is always a FRESH now+interval boundary,
  // never an advance off the stale one — an ancient boundary plus one
  // interval can still land in the past) and the shared setProjectStalledFlag
  // writer stall-detector.ts already uses for the same column, rather than
  // hand-rolling either write.
  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()
  const freshBoundary = nextCycleBoundary(nowIso, null, DEFAULT_CYCLE_DAYS)
  if (freshBoundary !== null) {
    await env.DB.prepare(
      `UPDATE projects SET cycle_boundary_at = ?1, updated_at = ?2 WHERE id = ?3`,
    )
      .bind(freshBoundary, nowIso, projectId)
      .run()
  }
  await setProjectStalledFlag(env, projectId, 0, nowIso)

  await recordStartGateSuccess(
    env,
    {
      projectId,
      taskId,
      squadId: squad.squad_id,
      agentId: agent.id,
      resource: resource.kind,
      principal: deps.principal,
    },
    deps.writeReceipt,
  )

  // Re-read: activated.value predates the cycle_boundary_at/stalled reset
  // above, so the returned project must reflect the post-reset row, not the
  // stale snapshot from the activation write.
  const finalProject = (await getProject(env, projectId)) ?? activated.value

  return {
    ok: true,
    project: finalProject,
    task_id: taskId,
    squad_id: squad.squad_id,
    agent_id: agent.id,
    resource: resource.kind,
  }
}

/**
 * Escalate stale planned projects that never attempted provision (ghost-start).
 * Idempotent per project via ghost_start_alarm receipt.
 */
export async function evaluateGhostStartAlarm(
  env: Env,
  project: Pick<Project, 'id' | 'status' | 'created_at'>,
  nowIso: string,
  deps: GhostStartDeps,
): Promise<GhostStartOutcome> {
  if (project.status !== 'planned') return 'skipped'

  const cutoff = ghostCutoffIso(nowIso, deps.ghostThresholdDays)
  if (project.created_at > cutoff) return 'skipped'

  const hasAttempt = deps.hasProvisionAttempt
    ? await deps.hasProvisionAttempt(env, project.id)
    : await hasStartProvisionAttempt(env, project.id)
  if (hasAttempt) return 'skipped'

  const owners = deps.listOrgOwnerMemberIds
    ? await deps.listOrgOwnerMemberIds(env)
    : await listOrgOwnerMemberIds(env)

  const wrote = await recordGhostStartAlarm(
    env,
    project.id,
    owners,
    deps.principal,
    deps.writeReceipt,
  )
  return wrote ? 'alarmed' : 'already_alarmed'
}
