import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { AuthContext, CapabilityGrant, Env, Project, ProjectStatus } from '../types'
import { requireAuth } from '../auth'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import {
  createProject,
  getProject,
  listProjectSquads,
  listProjects,
  removeProjectSquadAccess,
  updateProject,
  upsertProjectSquadAccess,
} from './service'
import type { CreateProjectInput, ProjectMutationError, UpdateProjectInput } from './service'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
type VisibleProject = Project & { parent_context?: true }

const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'paused', 'completed', 'archived']

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}

function inTenantScope(auth: AuthContext, env: Env): boolean {
  return auth.tenant === env.TENANT_SLUG
}

function legacyWorkspaceAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

async function memberIdFor(env: Env, auth: AuthContext): Promise<string | null> {
  if (auth.memberId) return auth.memberId
  if (!auth.email) return null
  const member = await env.DB.prepare(
    "SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'",
  ).bind(auth.email, env.TENANT_SLUG).first<{ id: string }>()
  return member?.id ?? null
}

async function grantsFor(env: Env, auth: AuthContext): Promise<CapabilityGrant[]> {
  const memberId = await memberIdFor(env, auth)
  if (!memberId) return []
  return auth.capabilities ?? resolveCapabilities(env, memberId)
}

async function isWorkspaceAdmin(env: Env, auth: AuthContext): Promise<boolean> {
  if (legacyWorkspaceAdmin(auth)) return true
  return hasCapability(await grantsFor(env, auth), 'org', null, 'admin')
}

async function visibleProjectIds(env: Env, auth: AuthContext): Promise<Set<string> | null> {
  if (legacyWorkspaceAdmin(auth)) return null
  if (!await memberIdFor(env, auth)) return new Set()

  const grants = await grantsFor(env, auth)
  const edges = await env.DB.prepare(
    `SELECT psa.project_id, psa.squad_id, s.department_id
       FROM project_squad_access psa
       JOIN squads s ON s.id = psa.squad_id`,
  ).all<{ project_id: string; squad_id: string; department_id: string | null }>()
  const visible = new Set<string>()
  for (const edge of edges.results ?? []) {
    if (hasCapability(grants, 'squad', edge.squad_id, 'observer', edge.department_id)) {
      visible.add(edge.project_id)
    }
  }
  return visible
}

async function readableProject(env: Env, auth: AuthContext, id: string): Promise<Project | null> {
  const project = await getProject(env, id)
  if (!project) return null
  const visible = await visibleProjectIds(env, auth)
  return visible === null || visible.has(id) ? project : null
}

function mutationStatus(error: ProjectMutationError): 400 | 404 | 409 {
  if (error === 'project_not_found' || error === 'parent_not_found' || error === 'squad_not_found') return 404
  if (error === 'slug_taken' || error === 'receipt_failed') return 409
  return 400
}

async function jsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

export const projectsApp = new Hono<AppEnv>()

projectsApp.get('/health', (c) => c.json({ ok: true, component: 'projects', tenant: c.env.TENANT_SLUG }))
projectsApp.use('*', csrf())
projectsApp.use('*', requireAuth)
projectsApp.use('*', async (c, next) => {
  if (!inTenantScope(c.get('auth'), c.env)) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

projectsApp.get('/', async (c) => {
  const rawStatus = c.req.query('status')
  const parentId = c.req.query('parent_id')
  if (rawStatus !== undefined && !isProjectStatus(rawStatus)) return c.json({ error: 'invalid_status' }, 400)
  if (parentId !== undefined && !parentId.trim()) return c.json({ error: 'invalid_parent_id' }, 400)

  const options: { status?: ProjectStatus; parent_project_id?: string } = {}
  if (rawStatus !== undefined) options.status = rawStatus
  if (parentId !== undefined) options.parent_project_id = parentId
  const projects = await listProjects(c.env, options)
  const visible = await visibleProjectIds(c.env, c.get('auth'))
  if (visible === null) return c.json({ projects })

  const readable = projects.filter((project) => visible.has(project.id))
  const included = new Set(readable.map((project) => project.id))
  const parents = new Map<string, Project>()
  for (const project of readable) {
    if (!project.parent_project_id || included.has(project.parent_project_id)) continue
    const parent = await getProject(c.env, project.parent_project_id)
    if (parent) parents.set(parent.id, parent)
  }
  const rows: VisibleProject[] = [...readable, ...[...parents.values()].map((project) => ({ ...project, parent_context: true }))]
  rows.sort((a, b) => {
    if (a.parent_project_id === null && b.parent_project_id !== null) return -1
    if (a.parent_project_id !== null && b.parent_project_id === null) return 1
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  })
  return c.json({ projects: rows })
})

projectsApp.post('/', async (c) => {
  if (!await isWorkspaceAdmin(c.env, c.get('auth'))) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await createProject(c.env, body as CreateProjectInput)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ project: result.value }, 201)
})

projectsApp.get('/:id', async (c) => {
  const project = await readableProject(c.env, c.get('auth'), c.req.param('id'))
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const [tasks, squads, flights] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').bind(project.id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM project_squad_access WHERE project_id = ?').bind(project.id).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM flights WHERE project_id = ? AND tenant = ?').bind(project.id, c.env.TENANT_SLUG).first<{ count: number }>(),
  ])
  const parent = project.parent_project_id ? await getProject(c.env, project.parent_project_id) : null
  return c.json({
    project,
    aggregates: {
      direct_tasks: Number(tasks?.count ?? 0),
      direct_squads: Number(squads?.count ?? 0),
      direct_flights: Number(flights?.count ?? 0),
    },
    ...(parent ? { parent } : {}),
  })
})

projectsApp.patch('/:id', async (c) => {
  if (!await isWorkspaceAdmin(c.env, c.get('auth'))) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await updateProject(c.env, c.req.param('id'), body as UpdateProjectInput)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ project: result.value })
})

projectsApp.get('/:id/squads', async (c) => {
  const project = await readableProject(c.env, c.get('auth'), c.req.param('id'))
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  return c.json({ squads: await listProjectSquads(c.env, project.id) })
})

projectsApp.put('/:id/squads/:squadId', async (c) => {
  if (!await isWorkspaceAdmin(c.env, c.get('auth'))) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await upsertProjectSquadAccess(c.env, c.req.param('id'), c.req.param('squadId'), body.access_level)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ squad: result.value })
})

projectsApp.delete('/:id/squads/:squadId', async (c) => {
  if (!await isWorkspaceAdmin(c.env, c.get('auth'))) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const projectId = c.req.param('id')
  const squadId = c.req.param('squadId')
  if (!await getProject(c.env, projectId)) return c.json({ error: 'project_not_found' }, 404)
  const edge = await c.env.DB.prepare(
    'SELECT 1 FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
  ).bind(projectId, squadId).first()
  if (!edge) return c.json({ error: 'project_squad_access_not_found' }, 404)
  const result = await removeProjectSquadAccess(c.env, projectId, squadId)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.body(null, 204)
})
