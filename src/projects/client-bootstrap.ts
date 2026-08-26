import type { Env, Project } from '../types'
import { getProject, upsertProjectSquadAccess } from './service'

export const CURSOR_SQUAD_SLUG = 'squad-cursor'
export const CURSOR_SQUAD_ID = 'squad-cursor'
export const CURSOR_DEPARTMENT_ID = 'dept-cursor'
export const CURSOR_DEPARTMENT_SLUG = 'cursor'

export const DEFAULT_CLIENT_PROJECTS = [
  {
    id: 'project-worker-alpha',
    slug: 'worker-alpha',
    name: 'Worker Alpha',
    description: 'Dynamic client worker surface.',
    goal: 'Maintain the edge worker healthy and ship autonomous feature flights.',
    repo_url: 'https://github.com/Mumega-com/mupot',
    live_url: 'https://mupot.mumega.com',
    worker_name: 'worker-alpha',
  },
  {
    id: 'project-worker-beta',
    slug: 'worker-beta',
    name: 'Worker Beta',
    description: 'Autonomous client worker surface.',
    goal: 'Maintain the edge worker healthy and ship autonomous feature flights.',
    repo_url: 'https://github.com/Mumega-com/mupot',
    live_url: 'https://mupot.mumega.com',
    worker_name: 'worker-beta',
  },
] as const

export interface ProvisionedClientProject {
  project: Project
  created: boolean
}

export interface ProvisionDefaultClientProjectsResult {
  squad_id: string
  projects: ProvisionedClientProject[]
}

async function ensureCursorDepartment(env: Env): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT id FROM departments WHERE id = ? OR slug = ? LIMIT 1',
  ).bind(CURSOR_DEPARTMENT_ID, CURSOR_DEPARTMENT_SLUG).first<{ id: string }>()
  if (existing) return existing.id

  const any = await env.DB.prepare('SELECT id FROM departments ORDER BY created_at, id LIMIT 1')
    .first<{ id: string }>()
  if (any) return any.id

  await env.DB.prepare(
    `INSERT INTO departments (id, slug, name, created_at)
     VALUES (?, ?, 'Cursor Cloud', datetime('now'))`,
  ).bind(CURSOR_DEPARTMENT_ID, CURSOR_DEPARTMENT_SLUG).run()
  return CURSOR_DEPARTMENT_ID
}

async function ensureCursorSquad(env: Env, departmentId: string): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT id FROM squads WHERE id = ? OR slug = ? LIMIT 1',
  ).bind(CURSOR_SQUAD_ID, CURSOR_SQUAD_SLUG).first<{ id: string }>()
  if (existing) return existing.id

  await env.DB.prepare(
    `INSERT INTO squads (id, department_id, slug, name, created_at)
     VALUES (?, ?, ?, 'squad-cursor', datetime('now'))`,
  ).bind(CURSOR_SQUAD_ID, departmentId, CURSOR_SQUAD_SLUG).run()
  return CURSOR_SQUAD_ID
}

async function upsertClientProject(
  env: Env,
  spec: (typeof DEFAULT_CLIENT_PROJECTS)[number],
  squadId: string,
): Promise<ProvisionedClientProject> {
  const byId = await getProject(env, spec.id)
  const bySlug = byId ?? (await env.DB.prepare(
    'SELECT id FROM projects WHERE slug = ?',
  ).bind(spec.slug).first<{ id: string }>())
  if (bySlug) {
    const id = 'id' in bySlug && typeof bySlug.id === 'string' ? bySlug.id : spec.id
    await env.DB.prepare(
      `UPDATE projects
          SET name = ?, description = ?, goal = ?,
              repo_url = ?, worker_name = ?, live_url = ?,
              assigned_squad_id = ?, deploy_status = 'healthy',
              updated_at = ?
        WHERE id = ?`,
    ).bind(
      spec.name,
      spec.description,
      spec.goal,
      spec.repo_url,
      spec.worker_name,
      spec.live_url,
      squadId,
      new Date().toISOString(),
      id,
    ).run()
    const project = await getProject(env, id)
    if (!project) throw new Error('client project upsert vanished')
    await upsertProjectSquadAccess(env, project.id, squadId, 'admin')
    return { project, created: false }
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO projects
     (id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by,
      repo_url, worker_name, live_url, assigned_squad_id, deploy_status,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?, 'healthy', ?, ?)`,
  ).bind(
    spec.id,
    spec.slug,
    spec.name,
    spec.description,
    spec.goal,
    spec.repo_url,
    spec.worker_name,
    spec.live_url,
    squadId,
    now,
    now,
  ).run()
  const project = await getProject(env, spec.id)
  if (!project) throw new Error('client project create vanished')
  await upsertProjectSquadAccess(env, project.id, squadId, 'admin')
  return { project, created: true }
}

/**
 * Idempotent provision of the default client worker projects (Viamar, DME)
 * and the squad-cursor assignment. Safe to call from tests, local seed, or
 * an operator bootstrap. Does not run inside a migration.
 */
export async function provisionDefaultClientProjects(
  env: Env,
): Promise<ProvisionDefaultClientProjectsResult> {
  const departmentId = await ensureCursorDepartment(env)
  const squadId = await ensureCursorSquad(env, departmentId)
  const projects: ProvisionedClientProject[] = []
  for (const spec of DEFAULT_CLIENT_PROJECTS) {
    projects.push(await upsertClientProject(env, spec, squadId))
  }
  return { squad_id: squadId, projects }
}
