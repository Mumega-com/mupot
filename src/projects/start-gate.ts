// Project lifecycle start-gate (slice 3) — authorize + provision atomically.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// planned → active is NOT a bare enum flip. One governed action must:
//   1) seed >=1 first task from the project goal onto a write/admin squad, AND
//   2) mint/confirm that squad's resource via the EXISTING grant path
//      (mintAgentBoundToken / upsertActiveAgentCapabilityGrant) — no fork.
// If the resource commit fails, the project stays planned and surfaces as
// blocked-start (no false active). A stale planned project with no provision
// attempt escalates to org owners (ghost-start alarm).

import type { Env, Project, ProjectAccessLevel, Task } from '../types'
import {
  mintAgentBoundToken,
  resolveActiveAgentMember,
  upsertActiveAgentCapabilityGrant,
  type AgentForMint,
} from '../members/service'
import { createTask } from '../tasks/service'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { lifecycleTaskId } from './circuit-breaker'
import { getProject, updateProject, type ProjectMutationResult } from './service'

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

export type ResolveActiveAgentMemberFn = (
  env: Env,
  agentId: string,
) => Promise<string | 'unminted' | 'ambiguous'>

export type UpsertActiveAgentCapabilityGrantFn = (
  env: Env,
  input: {
    agentId: string
    expectedMemberId: string
    squadId: string
    capability: typeof START_RESOURCE_CAPABILITY
  },
) => Promise<{ result: 'created' | 'updated' | 'unchanged' } | null>

export interface StartGateDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
  createTask: CreateTaskFn
  mintAgentBoundToken: MintAgentBoundTokenFn
  resolveActiveAgentMember: ResolveActiveAgentMemberFn
  upsertActiveAgentCapabilityGrant: UpsertActiveAgentCapabilityGrantFn
  principal: string
}

export interface GhostStartDeps {
  writeReceipt: WriteReceiptFn
  listStalePlanned?: (env: Env, olderThanIso: string) => Promise<Project[]>
  hasProvisionAttempt?: (env: Env, projectId: string) => Promise<boolean>
  listOrgOwnerMemberIds?: (env: Env) => Promise<string[]>
  ghostThresholdDays: number
  principal: string
}

export function defaultStartGateDeps(): StartGateDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: (env, id, input) => updateProject(env, id, { ...input, via_start_gate: true }),
    createTask: (env, input) => createTask(env, input, { skipMirror: true }),
    mintAgentBoundToken: (env, agent, label, capability) =>
      mintAgentBoundToken(env, agent, label, capability),
    resolveActiveAgentMember,
    upsertActiveAgentCapabilityGrant: (env, input) =>
      upsertActiveAgentCapabilityGrant(env, input),
    principal: START_GATE_PRINCIPAL,
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
      body: `Kick off ${name}`,
      done_when: `First actionable delivery exists for ${name}`,
    }
  }
  const title = goal.length <= 120 ? goal : `${goal.slice(0, 117)}...`
  return {
    title,
    body: goal,
    done_when: `First delivery toward: ${goal.slice(0, 200)}`,
  }
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

async function pickExistingSeedTaskId(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM tasks WHERE project_id = ?1 ORDER BY created_at ASC, id ASC LIMIT 1`,
  )
    .bind(projectId)
    .first<{ id: string }>()
  return row?.id ?? null
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
    'mintAgentBoundToken' | 'resolveActiveAgentMember' | 'upsertActiveAgentCapabilityGrant'
  >,
): Promise<{ kind: ResourceCommitKind; memberId: string } | null> {
  const identity = await deps.resolveActiveAgentMember(env, agent.id)
  if (identity === 'ambiguous') return null

  if (identity === 'unminted') {
    const minted = await deps.mintAgentBoundToken(
      env,
      agent,
      `start-gate:${agent.slug}`,
      START_RESOURCE_CAPABILITY,
    )
    return { kind: 'minted', memberId: minted.memberId }
  }

  const outcome = await deps.upsertActiveAgentCapabilityGrant(env, {
    agentId: agent.id,
    expectedMemberId: identity,
    squadId: agent.squad_id,
    capability: START_RESOURCE_CAPABILITY,
  })
  if (!outcome) return null
  return { kind: 'confirmed', memberId: identity }
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
 * On resource failure the project remains planned and a blocked-start receipt is written.
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

  const fail = async (error: StartBlockReason): Promise<StartGateFailure> => {
    await recordBlockedStart(env, projectId, error, deps.principal, deps.writeReceipt)
    const current = await getProject(env, projectId)
    return { ok: false, error, project: current ?? project }
  }

  const squad = await pickWritableSquad(env, projectId)
  if (!squad) return fail('no_writable_squad')

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
  } catch {
    return fail('resource_commit_failed')
  }

  let taskId: string
  try {
    const existingCount = await countProjectTasks(env, projectId)
    if (existingCount > 0) {
      const existingId = await pickExistingSeedTaskId(env, projectId)
      if (!existingId) return fail('task_seed_failed')
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

  return {
    ok: true,
    project: activated.value,
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
