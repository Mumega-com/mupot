import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { AuthContext, CapabilityGrant, Env, Project, ProjectStatus } from '../types'
import { requireAuth } from '../auth'
import { resolveCapabilities } from '../auth/capability'
import { canonicalFlightMetaSql } from '../flight/meta-sql'
import { listProjectActivity, listProjectEvidence, type ProjectProjectionCursor } from './projections'
import {
  projectReadAccessFromGrants,
  projectVisibilityClause,
  unrestrictedProjectRead,
  type ProjectReadAccess,
} from './access'
import { resolveReadableSquadIds } from './readable-squads'
import { loadProjectSituation } from './situation'
import {
  createProject,
  getProject,
  removeProjectSquadAccess,
  updateProject,
  upsertProjectSquadAccess,
} from './service'
import type { CreateProjectInput, ProjectMutationError, UpdateProjectInput } from './service'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
type ParentContext = Pick<Project, 'id' | 'slug' | 'name' | 'status' | 'parent_project_id'>
type ContextProject = ParentContext & { parent_context: true }
type Page = { limit: number; offset: number }
type ProjectionKind = 'activity' | 'evidence'
type ProjectionPage = Page & { after?: ProjectProjectionCursor }

const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'paused', 'completed', 'archived']
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 100
const MAX_PAGE_OFFSET = 10_000
const PROJECTION_SOURCE_TYPES: Record<ProjectionKind, ReadonlySet<string>> = {
  activity: new Set(['task', 'message', 'flight', 'project_link']),
  evidence: new Set([
    'task_result', 'task_verdict', 'workflow_receipt', 'dispatch_receipt',
    'flight_receipt', 'message_ack', 'project_link_receipt',
  ]),
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}

function inTenantScope(auth: AuthContext, env: Env): boolean {
  return auth.tenant === env.TENANT_SLUG
}

function safeParent(project: Project): ParentContext {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    status: project.status,
    parent_project_id: project.parent_project_id,
  }
}

function parsePage(limitInput: string | undefined, cursorInput: string | undefined): Page | null {
  if (limitInput !== undefined && !/^(0|[1-9]\d*)$/.test(limitInput)) return null
  if (cursorInput !== undefined && !/^(0|[1-9]\d*)$/.test(cursorInput)) return null
  const limit = limitInput === undefined ? DEFAULT_PAGE_SIZE : Number(limitInput)
  const offset = cursorInput === undefined ? 0 : Number(cursorInput)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) return null
  return { limit, offset }
}

function nextCursor(page: Page, resultLength: number): string | null {
  const nextOffset = page.offset + page.limit
  return resultLength > page.limit && nextOffset <= MAX_PAGE_OFFSET ? String(nextOffset) : null
}

function cursorBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function cursorJson(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error('invalid_cursor')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function encodeProjectionCursor(kind: ProjectionKind, cursor: ProjectProjectionCursor): string {
  return cursorBase64(JSON.stringify({
    v: 1,
    p: kind,
    t: cursor.occurred_at,
    s: cursor.source_type,
    i: cursor.source_id,
  }))
}

function parseProjectionPage(
  limitInput: string | undefined,
  cursorInput: string | undefined,
  kind: ProjectionKind,
): ProjectionPage | null {
  if (limitInput !== undefined && !/^(0|[1-9]\d*)$/.test(limitInput)) return null
  const limit = limitInput === undefined ? DEFAULT_PAGE_SIZE : Number(limitInput)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null
  if (cursorInput === undefined) return { limit, offset: 0 }
  if (/^(0|[1-9]\d*)$/.test(cursorInput)) {
    const offset = Number(cursorInput)
    return Number.isInteger(offset) && offset >= 0 && offset <= MAX_PAGE_OFFSET
      ? { limit, offset }
      : null
  }

  try {
    const decoded = cursorJson(cursorInput) as Record<string, unknown>
    if (decoded.v !== 1 || decoded.p !== kind) return null
    if (typeof decoded.t !== 'string' || new Date(decoded.t).toISOString() !== decoded.t) return null
    if (typeof decoded.s !== 'string' || !PROJECTION_SOURCE_TYPES[kind].has(decoded.s)) return null
    if (typeof decoded.i !== 'string' || decoded.i.length < 1 || decoded.i.length > 512) return null
    return {
      limit,
      offset: 0,
      after: { occurred_at: decoded.t, source_type: decoded.s, source_id: decoded.i },
    }
  } catch {
    return null
  }
}

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
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

async function projectReadAccess(env: Env, auth: AuthContext): Promise<ProjectReadAccess> {
  const grants = await grantsFor(env, auth)
  return projectReadAccessFromGrants(auth, grants)
}

function edgePredicate(access: ProjectReadAccess): { sql: string; binds: string[] } {
  if (access.orgRead) return { sql: '1 = 1', binds: [] }
  return {
    sql: `(s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))`,
    binds: [jsonIds(access.squadIds), jsonIds(access.departmentIds)],
  }
}

async function readableProject(
  env: Env,
  id: string,
  access: ProjectReadAccess,
): Promise<Project | null> {
  const visibility = projectVisibilityClause(access)
  return env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id, p.target_date,
            p.cycle_boundary_at, p.stalled, p.stall_threshold_days, p.created_at, p.updated_at
       FROM projects p
      WHERE p.id = ?
        AND ${visibility.sql}`,
  ).bind(id, ...visibility.binds).first<Project>()
}

async function projectionReadableSquads(
  env: Env,
  access: ProjectReadAccess,
): Promise<string[] | null> {
  if (unrestrictedProjectRead(access)) return null
  return resolveReadableSquadIds(env, access.squadIds, access.departmentIds)
}

async function projectAggregates(
  env: Env,
  projectId: string,
  access: ProjectReadAccess,
): Promise<{ direct_tasks: number; direct_squads: number; direct_flights: number }> {
  if (unrestrictedProjectRead(access)) {
    const [tasks, squads, flights] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').bind(projectId).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM project_squad_access WHERE project_id = ?').bind(projectId).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM flights WHERE project_id = ? AND tenant = ?').bind(projectId, env.TENANT_SLUG).first<{ count: number }>(),
    ])
    return {
      direct_tasks: Number(tasks?.count ?? 0),
      direct_squads: Number(squads?.count ?? 0),
      direct_flights: Number(flights?.count ?? 0),
    }
  }

  const squadIds = jsonIds(access.squadIds)
  const departmentIds = jsonIds(access.departmentIds)
  const safeMeta = "CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END"
  const [tasks, squads, flights] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM tasks t
         JOIN squads s ON s.id = t.squad_id
        WHERE t.project_id = ?1
          AND (s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
            OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))`,
    ).bind(projectId, squadIds, departmentIds).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM project_squad_access psa
         JOIN squads s ON s.id = psa.squad_id
        WHERE psa.project_id = ?1
          AND (s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
            OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))`,
    ).bind(projectId, squadIds, departmentIds).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM flights f
        WHERE f.project_id = ?1
          AND f.tenant = ?2
          ${canonicalFlightMetaSql('f')}
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(${safeMeta}, '$.squad_ids') squad_ref
             WHERE NOT EXISTS (
               SELECT 1
                 FROM squads s
                WHERE s.id = CAST(squad_ref.value AS TEXT)
                  AND (s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?3))
                    OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
             )
          )`,
    ).bind(projectId, env.TENANT_SLUG, squadIds, departmentIds).first<{ count: number }>(),
  ])
  return {
    direct_tasks: Number(tasks?.count ?? 0),
    direct_squads: Number(squads?.count ?? 0),
    direct_flights: Number(flights?.count ?? 0),
  }
}

function mutationStatus(error: ProjectMutationError): 400 | 404 | 409 {
  if (error === 'project_not_found' || error === 'parent_not_found' || error === 'squad_not_found') return 404
  if (error === 'slug_taken' || error === 'receipt_failed' || error === 'invalid_status_transition') return 409
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

projectsApp.use('*', csrf())
projectsApp.use('*', async (c, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'forbidden', reason: 'csrf' }, 403)
  }
  await next()
})
projectsApp.use('*', requireAuth)
projectsApp.use('*', async (c, next) => {
  if (!inTenantScope(c.get('auth'), c.env)) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

projectsApp.get('/health', (c) => c.json({ ok: true, component: 'projects', tenant: c.env.TENANT_SLUG }))

projectsApp.get('/', async (c) => {
  const rawStatus = c.req.query('status')
  const parentId = c.req.query('parent_id')
  const page = parsePage(c.req.query('limit'), c.req.query('cursor'))
  if (rawStatus !== undefined && !isProjectStatus(rawStatus)) return c.json({ error: 'invalid_status' }, 400)
  if (parentId !== undefined && !parentId.trim()) return c.json({ error: 'invalid_parent_id' }, 400)
  if (!page) return c.json({ error: 'invalid_pagination' }, 400)

  const access = await projectReadAccess(c.env, c.get('auth'))
  const visibility = projectVisibilityClause(access)
  const clauses = [visibility.sql]
  const binds: string[] = [...visibility.binds]
  if (rawStatus !== undefined) {
    clauses.push('p.status = ?')
    binds.push(rawStatus)
  }
  if (parentId !== undefined) {
    clauses.push('p.parent_project_id = ?')
    binds.push(parentId)
  }
  const result = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id, p.target_date,
            p.cycle_boundary_at, p.stalled, p.stall_threshold_days, p.created_at, p.updated_at
       FROM projects p
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
      LIMIT ? OFFSET ?`,
  ).bind(...binds, page.limit + 1, page.offset).all<Project>()
  const resultRows = result.results ?? []
  const projects = resultRows.slice(0, page.limit)
  const ids = new Set(projects.map((project) => project.id))
  const parentIds = [...new Set(projects.map((project) => project.parent_project_id).filter((id): id is string => id !== null && !ids.has(id)))]
  let parentContexts: ContextProject[] = []
  if (parentIds.length) {
    const parents = await c.env.DB.prepare(
      `SELECT id, slug, name, status, parent_project_id
         FROM projects
        WHERE id IN (${parentIds.map(() => '?').join(', ')})
        ORDER BY created_at, id`,
    ).bind(...parentIds).all<ParentContext>()
    parentContexts = (parents.results ?? []).map((parent) => ({ ...parent, parent_context: true }))
  }
  return c.json({
    projects: [...parentContexts, ...projects],
    next_cursor: nextCursor(page, resultRows.length),
  })
})

projectsApp.post('/', async (c) => {
  const access = await projectReadAccess(c.env, c.get('auth'))
  if (!access.workspaceAdmin) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await createProject(c.env, body as CreateProjectInput)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ project: result.value }, 201)
})

projectsApp.get('/:id', async (c) => {
  const access = await projectReadAccess(c.env, c.get('auth'))
  const project = await readableProject(c.env, c.req.param('id'), access)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const readableSquadIds = await projectionReadableSquads(c.env, access)
  const [aggregates, situation, parent] = await Promise.all([
    projectAggregates(c.env, project.id, access),
    loadProjectSituation(c.env, project, readableSquadIds),
    project.parent_project_id ? getProject(c.env, project.parent_project_id) : null,
  ])
  return c.json({
    project,
    aggregates,
    situation,
    ...(parent ? { parent: safeParent(parent) } : {}),
  })
})

projectsApp.get('/:id/activity', async (c) => {
  const page = parseProjectionPage(c.req.query('limit'), c.req.query('cursor'), 'activity')
  if (!page) return c.json({ error: 'invalid_pagination' }, 400)
  const access = await projectReadAccess(c.env, c.get('auth'))
  const project = await readableProject(c.env, c.req.param('id'), access)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const rows = await listProjectActivity(c.env, {
    projectId: project.id,
    readableSquadIds: await projectionReadableSquads(c.env, access),
    limit: page.limit,
    offset: page.offset,
    after: page.after,
  })
  return c.json({
    rows: rows.rows,
    next_cursor: rows.nextCursor ? encodeProjectionCursor('activity', rows.nextCursor) : null,
  })
})

projectsApp.get('/:id/evidence', async (c) => {
  const page = parseProjectionPage(c.req.query('limit'), c.req.query('cursor'), 'evidence')
  if (!page) return c.json({ error: 'invalid_pagination' }, 400)
  const access = await projectReadAccess(c.env, c.get('auth'))
  const project = await readableProject(c.env, c.req.param('id'), access)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const rows = await listProjectEvidence(c.env, {
    projectId: project.id,
    readableSquadIds: await projectionReadableSquads(c.env, access),
    limit: page.limit,
    offset: page.offset,
    after: page.after,
  })
  return c.json({
    rows: rows.rows,
    next_cursor: rows.nextCursor ? encodeProjectionCursor('evidence', rows.nextCursor) : null,
  })
})

projectsApp.patch('/:id', async (c) => {
  const access = await projectReadAccess(c.env, c.get('auth'))
  if (!access.workspaceAdmin) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await updateProject(c.env, c.req.param('id'), body as UpdateProjectInput)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ project: result.value })
})

projectsApp.get('/:id/squads', async (c) => {
  const page = parsePage(c.req.query('limit'), c.req.query('cursor'))
  if (!page) return c.json({ error: 'invalid_pagination' }, 400)
  const access = await projectReadAccess(c.env, c.get('auth'))
  const project = await readableProject(c.env, c.req.param('id'), access)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const edge = edgePredicate(access)
  const result = await c.env.DB.prepare(
    `SELECT psa.project_id, psa.squad_id, psa.access_level, psa.granted_at
       FROM project_squad_access psa
       JOIN squads s ON s.id = psa.squad_id
      WHERE psa.project_id = ?
        AND (${access.workspaceAdmin ? '1 = 1' : edge.sql})
      ORDER BY psa.squad_id
      LIMIT ? OFFSET ?`,
  ).bind(project.id, ...(access.workspaceAdmin ? [] : edge.binds), page.limit + 1, page.offset).all()
  const squads = result.results ?? []
  return c.json({
    squads: squads.slice(0, page.limit),
    next_cursor: nextCursor(page, squads.length),
  })
})

projectsApp.put('/:id/squads/:squadId', async (c) => {
  const access = await projectReadAccess(c.env, c.get('auth'))
  if (!access.workspaceAdmin) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const body = await jsonObject(c)
  if (!body) return c.json({ error: 'invalid_json' }, 400)
  const result = await upsertProjectSquadAccess(c.env, c.req.param('id'), c.req.param('squadId'), body.access_level)
  if (!result.ok) return c.json({ error: result.error }, mutationStatus(result.error))
  return c.json({ squad: result.value })
})

projectsApp.delete('/:id/squads/:squadId', async (c) => {
  const access = await projectReadAccess(c.env, c.get('auth'))
  if (!access.workspaceAdmin) return c.json({ error: 'forbidden', need: 'admin' }, 403)
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
