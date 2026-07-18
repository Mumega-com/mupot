import type { AuthContext, Env, Project, ProjectSquadAccess, ProjectStatus } from '../types'
import { hasCapability } from '../auth/capability'
import {
  createProject,
  getProject,
  removeProjectSquadAccess,
  updateProject,
  upsertProjectSquadAccess,
} from '../projects/service'
import type { ProjectMutationError } from '../projects/service'
import { done, fail, str, type ToolOutcome, type ToolSpec } from './index'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const NUMBER_SCHEMA = { type: 'number' }
const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'paused', 'completed', 'archived']
const MAX_PAGE_SIZE = 100
const MAX_PAGE_OFFSET = 10_000

type ProjectReadAccess = {
  workspaceAdmin: boolean
  orgRead: boolean
  squadIds: string[]
  departmentIds: string[]
}

function workspaceAdmin(auth: AuthContext): boolean {
  if (auth.capabilities === undefined) return auth.role === 'owner' || auth.role === 'admin'
  return hasCapability(auth.capabilities, 'org', null, 'admin')
}

function readAccess(auth: AuthContext): ProjectReadAccess {
  if (workspaceAdmin(auth)) {
    return { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] }
  }

  const grants = auth.capabilities ?? []
  const squadIds = new Set<string>()
  const departmentIds = new Set<string>()
  for (const grant of grants) {
    if (!hasCapability([grant], grant.scope_type, grant.scope_id, 'observer')) continue
    if (grant.scope_type === 'squad' && grant.scope_id) squadIds.add(grant.scope_id)
    if (grant.scope_type === 'department' && grant.scope_id) departmentIds.add(grant.scope_id)
  }
  return {
    workspaceAdmin: false,
    orgRead: hasCapability(grants, 'org', null, 'observer'),
    squadIds: [...squadIds],
    departmentIds: [...departmentIds],
  }
}

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
}

function visibilityClause(access: ProjectReadAccess): { sql: string; binds: string[] } {
  if (access.workspaceAdmin || access.orgRead) return { sql: '1 = 1', binds: [] }
  return {
    sql: `EXISTS (
      SELECT 1
        FROM project_squad_access psa
        JOIN squads s ON s.id = psa.squad_id
       WHERE psa.project_id = p.id
         AND (s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
           OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))
    )`,
    binds: [jsonIds(access.squadIds), jsonIds(access.departmentIds)],
  }
}

async function readableProject(env: Env, projectId: string, access: ProjectReadAccess): Promise<Project | null> {
  const visibility = visibilityClause(access)
  return env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id,
            p.target_date, p.created_at, p.updated_at
       FROM projects p
      WHERE p.id = ? AND ${visibility.sql}`,
  ).bind(projectId, ...visibility.binds).first<Project>()
}

function mutationFailure(error: ProjectMutationError): ToolOutcome {
  if (error === 'project_not_found' || error === 'parent_not_found' || error === 'squad_not_found') {
    return fail(404, error)
  }
  if (error === 'slug_taken' || error === 'receipt_failed') return fail(409, error)
  return fail(400, error)
}

function requireWorkspaceAdmin(auth: AuthContext): ToolOutcome | null {
  return workspaceAdmin(auth) ? null : fail(403, 'forbidden', { need: 'admin', scope: 'org' })
}

function readLimit(value: unknown): number | null {
  if (value === undefined || value === null) return MAX_PAGE_SIZE
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) return null
  return value
}

function readOffset(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null
  const offset = Number(value)
  return Number.isSafeInteger(offset) && offset <= MAX_PAGE_OFFSET ? offset : null
}

function nextCursor(offset: number, limit: number, resultLength: number): string | null {
  const next = offset + limit
  return resultLength > limit && next <= MAX_PAGE_OFFSET ? String(next) : null
}

const toolProjectCreate: ToolSpec = {
  name: 'project_create',
  scope: 'workspace project lifecycle',
  min: 'admin',
  args: '{ slug: string, name: string, description?: string, goal?: string, status?: "planned"|"active"|"paused"|"completed"|"archived", parent_project_id?: string|null, target_date?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      slug: STRING_SCHEMA,
      name: STRING_SCHEMA,
      description: STRING_SCHEMA,
      goal: STRING_SCHEMA,
      status: STRING_SCHEMA,
      parent_project_id: NULLABLE_STRING_SCHEMA,
      target_date: NULLABLE_STRING_SCHEMA,
    },
    required: ['slug', 'name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const result = await createProject(env, args)
    return result.ok ? done({ project: result.value }) : mutationFailure(result.error)
  },
}

const toolProjectList: ToolSpec = {
  name: 'project_list',
  scope: 'visible workspace projects',
  min: 'observer',
  args: '{ status?: "planned"|"active"|"paused"|"completed"|"archived", parent_project_id?: string|null, limit?: number, cursor?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      status: STRING_SCHEMA,
      parent_project_id: NULLABLE_STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
      cursor: STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (args.status !== undefined && !PROJECT_STATUSES.includes(args.status as ProjectStatus)) {
      return fail(400, 'invalid_status')
    }
    if (args.parent_project_id !== undefined && args.parent_project_id !== null && !str(args.parent_project_id)) {
      return fail(400, 'invalid_parent_id')
    }
    const limit = readLimit(args.limit)
    const offset = readOffset(args.cursor)
    if (limit === null || offset === null) return fail(400, 'invalid_pagination')

    const access = readAccess(auth)
    const visibility = visibilityClause(access)
    const clauses = [visibility.sql]
    const binds: unknown[] = [...visibility.binds]
    if (args.status !== undefined) {
      clauses.push('p.status = ?')
      binds.push(args.status)
    }
    if (args.parent_project_id !== undefined) {
      if (args.parent_project_id === null) clauses.push('p.parent_project_id IS NULL')
      else {
        clauses.push('p.parent_project_id = ?')
        binds.push(args.parent_project_id)
      }
    }

    const rows = await env.DB.prepare(
      `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id,
              p.target_date, p.created_at, p.updated_at
         FROM projects p
        WHERE ${clauses.join(' AND ')}
        ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
        LIMIT ? OFFSET ?`,
    ).bind(...binds, limit + 1, offset).all<Project>()
    const projects = rows.results ?? []
    return done({ projects: projects.slice(0, limit), next_cursor: nextCursor(offset, limit, projects.length) })
  },
}

const toolProjectGet: ToolSpec = {
  name: 'project_get',
  scope: 'visible workspace project',
  min: 'observer',
  args: '{ project_id: string }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    const project = await readableProject(env, projectId, readAccess(auth))
    return project ? done({ project }) : fail(404, 'project_not_found')
  },
}

const toolProjectUpdate: ToolSpec = {
  name: 'project_update',
  scope: 'workspace project lifecycle, including archive and restore',
  min: 'admin',
  args: '{ project_id: string, slug?: string, name?: string, description?: string, goal?: string, status?: "planned"|"active"|"paused"|"completed"|"archived", parent_project_id?: string|null, target_date?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      slug: STRING_SCHEMA,
      name: STRING_SCHEMA,
      description: STRING_SCHEMA,
      goal: STRING_SCHEMA,
      status: STRING_SCHEMA,
      parent_project_id: NULLABLE_STRING_SCHEMA,
      target_date: NULLABLE_STRING_SCHEMA,
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    const { project_id: _projectId, ...input } = args
    const result = await updateProject(env, projectId, input)
    return result.ok ? done({ project: result.value }) : mutationFailure(result.error)
  },
}

const toolProjectSquadList: ToolSpec = {
  name: 'project_squad_list',
  scope: 'visible project squad-access edges',
  min: 'observer',
  args: '{ project_id: string, limit?: number, cursor?: string }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, limit: NUMBER_SCHEMA, cursor: STRING_SCHEMA },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    const limit = readLimit(args.limit)
    const offset = readOffset(args.cursor)
    if (limit === null || offset === null) return fail(400, 'invalid_pagination')

    const access = readAccess(auth)
    if (!await readableProject(env, projectId, access)) return fail(404, 'project_not_found')
    const unrestricted = access.workspaceAdmin || access.orgRead
    const rows = await env.DB.prepare(
      `SELECT psa.project_id, psa.squad_id, psa.access_level, psa.granted_at
         FROM project_squad_access psa
         JOIN squads s ON s.id = psa.squad_id
        WHERE psa.project_id = ?
          AND (${unrestricted ? '1 = 1' : `(s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))`})
        ORDER BY psa.squad_id
        LIMIT ? OFFSET ?`,
    ).bind(
      projectId,
      ...(unrestricted ? [] : [jsonIds(access.squadIds), jsonIds(access.departmentIds)]),
      limit + 1,
      offset,
    ).all<ProjectSquadAccess>()
    const squads = rows.results ?? []
    return done({ squads: squads.slice(0, limit), next_cursor: nextCursor(offset, limit, squads.length) })
  },
}

const toolProjectSquadSet: ToolSpec = {
  name: 'project_squad_set',
  scope: 'workspace project squad-access edge',
  min: 'admin',
  args: '{ project_id: string, squad_id: string, access_level: "read"|"write"|"admin" }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, squad_id: STRING_SCHEMA, access_level: STRING_SCHEMA },
    required: ['project_id', 'squad_id', 'access_level'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    const squadId = str(args.squad_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    if (!squadId) return fail(400, 'invalid_squad_id')
    const result = await upsertProjectSquadAccess(env, projectId, squadId, args.access_level)
    return result.ok ? done({ squad: result.value }) : mutationFailure(result.error)
  },
}

const toolProjectSquadRemove: ToolSpec = {
  name: 'project_squad_remove',
  scope: 'workspace project squad-access edge',
  min: 'admin',
  args: '{ project_id: string, squad_id: string }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, squad_id: STRING_SCHEMA },
    required: ['project_id', 'squad_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    const squadId = str(args.squad_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    if (!squadId) return fail(400, 'invalid_squad_id')
    if (!await getProject(env, projectId)) return fail(404, 'project_not_found')
    const edge = await env.DB.prepare(
      'SELECT 1 FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
    ).bind(projectId, squadId).first()
    if (!edge) return fail(404, 'project_squad_access_not_found')
    const result = await removeProjectSquadAccess(env, projectId, squadId)
    return result.ok ? done({ project_id: projectId, squad_id: squadId, removed: true }) : mutationFailure(result.error)
  },
}

export const PROJECT_TOOLS: ToolSpec[] = [
  toolProjectCreate,
  toolProjectList,
  toolProjectGet,
  toolProjectUpdate,
  toolProjectSquadList,
  toolProjectSquadSet,
  toolProjectSquadRemove,
]
