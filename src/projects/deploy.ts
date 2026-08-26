import type { AuthContext, Env, Project, ProjectDeployment, ProjectDeployStatus } from '../types'
import { createFlight } from '../flight/service'
import { createTask } from '../tasks/service'
import { getProject } from './service'
import { githubRepoSlug, studioDispatchPath } from './urls'

const COMMIT_SHA_RE = /^(?:[0-9a-f]{7,40}|pending|unspecified)$/i
const DEPLOYMENT_SELECT = `id, project_id, commit_sha, deployment_id, url, status, dispatched_by, flight_id, created_at`

export type ProjectDeployError =
  | 'project_not_found'
  | 'archived_project'
  | 'repo_required'
  | 'invalid_commit_sha'
  | 'receipt_failed'

export type ProjectDeployResult =
  | {
      ok: true
      deployment: ProjectDeployment
      project: Project
      flight_id: string | null
      studio_url: string
    }
  | { ok: false; error: ProjectDeployError }

export interface DeployProjectInput {
  commit_sha?: unknown
  prompt?: unknown
}

function actorId(auth: AuthContext): string {
  return auth.memberId || auth.userId
}

function readCommitSha(value: unknown, fallback: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') {
    if (typeof fallback === 'string' && COMMIT_SHA_RE.test(fallback)) return fallback.toLowerCase()
    return fallback ? null : 'pending'
  }
  if (typeof value !== 'string' || !COMMIT_SHA_RE.test(value)) return null
  return value.toLowerCase()
}

export async function listProjectDeployments(
  env: Env,
  projectId: string,
  limit = 20,
): Promise<ProjectDeployment[]> {
  const rows = await env.DB.prepare(
    `SELECT ${DEPLOYMENT_SELECT}
       FROM project_deployments
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).bind(projectId, Math.min(Math.max(limit, 1), 100)).all<ProjectDeployment>()
  return rows.results ?? []
}

export async function recordProjectDeployment(
  env: Env,
  receipt: Omit<ProjectDeployment, 'created_at'> & { created_at?: string },
): Promise<ProjectDeployment | null> {
  const createdAt = receipt.created_at ?? new Date().toISOString()
  const row: ProjectDeployment = { ...receipt, created_at: createdAt }
  try {
    const result = await env.DB.prepare(
      `INSERT INTO project_deployments
       (id, project_id, commit_sha, deployment_id, url, status, dispatched_by, flight_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.project_id,
      row.commit_sha,
      row.deployment_id,
      row.url,
      row.status,
      row.dispatched_by,
      row.flight_id,
      row.created_at,
    ).run()
    if (Number(result.meta?.changes ?? 0) < 1) return null
  } catch {
    return null
  }
  return row
}

async function markProjectDeployStatus(
  env: Env,
  projectId: string,
  status: ProjectDeployStatus,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE projects SET deploy_status = ?, updated_at = ? WHERE id = ?`,
  ).bind(status, new Date().toISOString(), projectId).run()
}

async function dispatchDeployFlight(
  env: Env,
  auth: AuthContext,
  project: Project,
  prompt: string,
): Promise<string | null> {
  const squadId = project.assigned_squad_id
  if (!squadId || !project.repo_url) return null

  const access = await env.DB.prepare(
    `SELECT 1 FROM project_squad_access
      WHERE project_id = ? AND squad_id = ? AND access_level IN ('write', 'admin')`,
  ).bind(project.id, squadId).first()
  if (!access) return null

  const agent = await env.DB.prepare(
    `SELECT id FROM agents WHERE squad_id = ? AND status = 'active' ORDER BY name LIMIT 1`,
  ).bind(squadId).first<{ id: string }>()
  const agentId = agent?.id ?? auth.boundAgentId ?? 'studio'

  const title = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt
  const task = await createTask(
    env,
    {
      squad_id: squadId,
      project_id: project.id,
      title,
      body: [
        prompt,
        '',
        `repo: ${project.repo_url}`,
        project.live_url ? `live: ${project.live_url}` : null,
        project.worker_name ? `worker: ${project.worker_name}` : null,
        `dispatched_by: ${auth.email || auth.userId}`,
        'source: project-worker-deploy',
      ].filter((line) => line !== null).join('\n'),
      done_when: 'Feature flight lands with a reviewable receipt against the project repo.',
      assignee_agent_id: agentId === 'studio' ? null : agentId,
    },
    { skipEvent: true, skipMirror: true, actor: { kind: 'member', id: actorId(auth) } },
  )

  return createFlight(env, {
    agent: agentId,
    dispatched_by: auth.boundAgentId ?? agentId,
    goal: prompt,
    project_id: project.id,
    trigger_source: 'api',
    meta: {
      schema: 'mupot.flight.meta/v1',
      goal_id: `project-deploy:${project.id}`,
      objective_id: 'feature-flight',
      squad_ids: [squadId],
      task_ids: [task.id],
      done_when: ['Feature flight lands with a reviewable receipt against the project repo.'],
      artifact_refs: [project.repo_url],
      receipt_refs: [],
      confidentiality: 'internal',
      publication_target: 'none',
      parent_flight_id: null,
    },
  })
}

export async function deployProject(
  env: Env,
  projectId: string,
  auth: AuthContext,
  input: DeployProjectInput = {},
): Promise<ProjectDeployResult> {
  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'archived') return { ok: false, error: 'archived_project' }
  if (!project.repo_url) return { ok: false, error: 'repo_required' }

  const commitSha = readCommitSha(input.commit_sha, env.RELEASE_SHA)
  if (input.commit_sha !== undefined && input.commit_sha !== null && input.commit_sha !== '' && !commitSha) {
    return { ok: false, error: 'invalid_commit_sha' }
  }

  const prompt = typeof input.prompt === 'string' && input.prompt.trim()
    ? input.prompt.trim()
    : `Dispatch a feature flight for ${project.name} against ${githubRepoSlug(project.repo_url) ?? project.repo_url}`

  await markProjectDeployStatus(env, project.id, 'deploying')

  let flightId: string | null = null
  try {
    flightId = await dispatchDeployFlight(env, auth, project, prompt)
  } catch (error) {
    console.error('project deploy flight dispatch failed (receipt still written)', {
      project_id: project.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const deploymentId = crypto.randomUUID()
  const receipt = await recordProjectDeployment(env, {
    id: crypto.randomUUID(),
    project_id: project.id,
    commit_sha: commitSha,
    deployment_id: deploymentId,
    url: project.live_url,
    status: 'deploying',
    dispatched_by: actorId(auth),
    flight_id: flightId,
  })
  if (!receipt) return { ok: false, error: 'receipt_failed' }

  const updated = await getProject(env, project.id)
  return {
    ok: true,
    deployment: receipt,
    project: updated ?? { ...project, deploy_status: 'deploying' },
    flight_id: flightId,
    studio_url: studioDispatchPath(project.repo_url),
  }
}
