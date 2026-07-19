import { html, raw } from 'hono/html'
import type {
  AuthContext,
  Capability,
  CapabilityGrant,
  Env,
  Project,
  ProjectAccessLevel,
  ProjectStatus,
} from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { parseFlightMetaV1 } from '../flight/meta'
import { canonicalFlightMetaSql } from '../flight/meta-sql'
import type { FlightRow } from '../flight/service'
import {
  getProject,
  isValidProjectTargetDate,
  validProjectStatusTransitions,
} from '../projects/service'
import type { ProjectMutationError, UpdateProjectInput } from '../projects/service'
import {
  projectReadAccessFromGrants,
  projectVisibilityClause,
  unrestrictedProjectRead,
  type ProjectReadAccess,
} from '../projects/access'
import { listProjectActivity, listProjectEvidence } from '../projects/projections'
import { loadProjectSituation } from '../projects/situation'
import { resolveAllSquadIds, resolveReadableSquadIds } from '../projects/readable-squads'
import type {
  ProjectActivitySource,
  ProjectEvidenceSource,
  ProjectProjectionPage,
} from '../projects/projections'
import type { ProjectHealth, ProjectSituation } from '../projects/situation'
import { getFleetAgentRuntimeStates } from '../fleet/registry'
import type { Presence } from '../fleet/registry'
import { emptyState, pageHeader, pill, sectionPanel } from './ui'
import type { Html } from './ui'

const MAX_PROJECTS = 100
const PARENT_OPTIONS_PAGE_SIZE = 500
const MAX_WORK_ROWS = 50
const MAX_SQUAD_ROWS = 100
const MAX_PROJECT_MEMBER_ROWS = 100
const MAX_FLIGHT_SCAN_PAGES = 10

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'planned', 'active', 'paused', 'completed', 'archived',
]

const PROJECT_LIFECYCLE_COMMANDS = [
  { command: 'activate', status: 'active', result: 'activated', label: 'Activate' },
  { command: 'pause', status: 'paused', result: 'paused', label: 'Pause' },
  { command: 'complete', status: 'completed', result: 'completed', label: 'Complete' },
  { command: 'archive', status: 'archived', result: 'archived', label: 'Archive' },
  { command: 'restore', status: 'planned', result: 'restored', label: 'Restore to planned' },
] as const

export function projectLifecycleTransition(command: string) {
  return PROJECT_LIFECYCLE_COMMANDS.find((candidate) => candidate.command === command) ?? null
}

type ParentContext = Pick<Project, 'id' | 'slug' | 'name' | 'status' | 'parent_project_id'>

interface ProjectAccess extends ProjectReadAccess {
  readableSquadIds: string[] | null
  taskableSquadIds: string[] | null
}

export interface ProjectListMetrics {
  directSquads: number
  openWork: number
  activeFlights: number
}

export type ProjectListChild = Project & {
  metrics: ProjectListMetrics
}

export interface ProjectListNode {
  project: Project | ParentContext
  contextOnly: boolean
  metrics: ProjectListMetrics | null
  children: ProjectListChild[]
}

export interface ProjectsPageView {
  nodes: ProjectListNode[]
  visibleProjectCount: number
  capped: boolean
  canManage: boolean
  filters: {
    search: string
    status: ProjectStatus | ''
  }
}

export interface ProjectListFilters {
  search?: string
  status?: ProjectStatus
}

export function parseProjectListFilters(
  search: string | undefined,
  status: string | undefined,
): ProjectListFilters | null {
  const normalizedStatus = status?.trim() ?? ''
  if (normalizedStatus && !(PROJECT_STATUSES as readonly string[]).includes(normalizedStatus)) return null
  return {
    search: search ?? '',
    ...(normalizedStatus ? { status: normalizedStatus as ProjectStatus } : {}),
  }
}

export interface ProjectTaskRow {
  id: string
  title: string
  status: string
  squad_name: string
}

export interface ProjectSquadRow {
  project_id: string
  squad_id: string
  access_level: ProjectAccessLevel
  granted_at: string
  squad_name: string
}

export interface ProjectMemberRow {
  squad_id: string
  squad_name: string
  access_level: ProjectAccessLevel
  agent_id: string
  agent_slug: string
  agent_name: string
  agent_role: string
  agent_model: string
  agent_status: string
  attached: boolean
  runtime: string
  runtime_status: string
  presence: Presence | 'not_attached'
  host: string
  last_seen: string
}

export interface ProjectDetailView {
  project: Project
  parent: ParentContext | null
  aggregates: {
    directTasks: number
    directSquads: number
    directFlights: number
  }
  tasks: ProjectTaskRow[]
  squads: ProjectSquadRow[]
  squadsTruncated: boolean
  members: ProjectMemberRow[]
  membersTruncated: boolean
  situation: ProjectSituation
  activity: ProjectProjectionPage<ProjectActivitySource>
  evidence: ProjectProjectionPage<ProjectEvidenceSource>
  canManage: boolean
}

export interface ProjectFormValues {
  slug: string
  name: string
  description: string
  goal: string
  parent_project_id: string
  target_date: string
}

export interface ProjectParentOption {
  id: string
  name: string
}

export interface ProjectFormView {
  values: ProjectFormValues
  parentOptions: ProjectParentOption[]
  error?: ProjectMutationError
}

export interface ProjectSettingsView extends ProjectFormView {
  project: Project
  lifecycleCommand?: string
}

export interface ProjectWorkContext {
  project: Project
  readableSquadIds: string[] | null
  taskableSquadIds: string[]
  taskableSquadIdsTruncated: boolean
}

export interface ProjectFlightsResult {
  rows: FlightRow[]
  scanLimited: boolean
}

async function memberIdFor(env: Env, auth: AuthContext): Promise<string | null> {
  if (auth.memberId) return auth.memberId
  if (!auth.email) return null
  const member = await env.DB.prepare(
    "SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'",
  ).bind(auth.email, env.TENANT_SLUG).first<{ id: string }>()
  return member?.id ?? null
}

async function projectAccess(env: Env, auth: AuthContext): Promise<ProjectAccess> {
  const memberId = await memberIdFor(env, auth)
  const grants = memberId ? auth.capabilities ?? await resolveCapabilities(env, memberId) : []
  const visibility = projectReadAccessFromGrants(auth, grants)
  const [readableSquadIds, taskableSquadIds] = await Promise.all([
    unrestrictedProjectRead(visibility)
      ? Promise.resolve(null)
      : resolveGrantedSquadIds(env, grants, 'observer'),
    visibility.workspaceAdmin
      ? Promise.resolve(null)
      : resolveGrantedSquadIds(env, grants, 'member'),
  ])
  return {
    ...visibility,
    readableSquadIds,
    taskableSquadIds,
  }
}

async function resolveGrantedSquadIds(
  env: Env,
  grants: CapabilityGrant[],
  minimum: Capability,
): Promise<string[]> {
  if (hasCapability(grants, 'org', null, minimum)) return resolveAllSquadIds(env)

  const squadIds: string[] = []
  const departmentIds: string[] = []
  for (const grant of grants) {
    if (!grant.scope_id || !hasCapability([grant], grant.scope_type, grant.scope_id, minimum)) continue
    if (grant.scope_type === 'squad') squadIds.push(grant.scope_id)
    if (grant.scope_type === 'department') departmentIds.push(grant.scope_id)
  }
  if (!squadIds.length && !departmentIds.length) return []
  return resolveReadableSquadIds(env, squadIds, departmentIds)
}

export async function canManageProjects(env: Env, auth: AuthContext): Promise<boolean> {
  return (await projectAccess(env, auth)).workspaceAdmin
}

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
}

function readableFlightSql(flightAlias: string, readableIdsParam: string): string {
  const safeMeta = `CASE WHEN json_valid(${flightAlias}.meta) THEN ${flightAlias}.meta ELSE '{}' END`
  return `${canonicalFlightMetaSql(flightAlias)}
    AND NOT EXISTS (
      SELECT 1
        FROM json_each(${safeMeta}, '$.squad_ids') squad_ref
       WHERE NOT EXISTS (
            SELECT 1
              FROM json_each(${readableIdsParam}) readable_squad
             WHERE CAST(readable_squad.value AS TEXT) = CAST(squad_ref.value AS TEXT)
          )
    )`
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

async function loadVisibleProjects(
  env: Env,
  access: ProjectAccess,
  filters: { search: string; status: ProjectStatus | '' },
): Promise<{ projects: Project[]; capped: boolean }> {
  const visibility = projectVisibilityClause(access)
  if (!unrestrictedProjectRead(access) && access.readableSquadIds?.length === 0) {
    return { projects: [], capped: false }
  }
  const clauses: string[] = [visibility.sql]
  const values: (string | number)[] = [...visibility.binds]
  if (filters.status) {
    clauses.push('p.status = ?')
    values.push(filters.status)
  }
  if (filters.search) {
    clauses.push('(instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.goal), lower(?)) > 0)')
    values.push(filters.search, filters.search)
  }
  const statement = env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id,
            p.target_date, p.created_at, p.updated_at
       FROM projects p
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
      LIMIT ?`,
  ).bind(...values, MAX_PROJECTS + 1)
  const result = await statement.all<Project>()
  const rows = result.results ?? []
  return { projects: rows.slice(0, MAX_PROJECTS), capped: rows.length > MAX_PROJECTS }
}

async function loadParentContexts(env: Env, parentIds: string[]): Promise<Map<string, ParentContext>> {
  if (!parentIds.length) return new Map()
  const result = await env.DB.prepare(
    `SELECT id, slug, name, status, parent_project_id
       FROM projects
      WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
      LIMIT ?2`,
  ).bind(jsonIds(parentIds), MAX_PROJECTS).all<ParentContext>()
  return new Map((result.results ?? []).map((parent) => [parent.id, parent]))
}

async function loadListMetrics(
  env: Env,
  projectIds: string[],
  access: ProjectAccess,
): Promise<Map<string, ProjectListMetrics>> {
  if (!projectIds.length) return new Map()
  const unrestricted = access.readableSquadIds === null
  const squadFilter = unrestricted
    ? ''
    : ' AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const flightFilter = unrestricted ? '' : readableFlightSql('f', '?2')
  const tenantParam = unrestricted ? '?2' : '?3'
  const limitParam = unrestricted ? '?3' : '?4'
  const result = await env.DB.prepare(
    `SELECT p.id,
            (SELECT COUNT(*) FROM project_squad_access
              WHERE project_id = p.id${squadFilter}) AS direct_squads,
            (SELECT COUNT(*) FROM tasks
              WHERE project_id = p.id${squadFilter}
                AND status IN ('open', 'in_progress', 'blocked', 'review')) AS open_work,
            (SELECT COUNT(*) FROM flights f
              WHERE f.project_id = p.id
                AND f.tenant = ${tenantParam}
                AND f.status IN ('preflight', 'running', 'waiting', 'sleeping')${flightFilter}) AS active_flights
       FROM projects p
      WHERE p.id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
      LIMIT ${limitParam}`,
  ).bind(
    jsonIds(projectIds),
    ...(unrestricted ? [] : [jsonIds(access.readableSquadIds ?? [])]),
    env.TENANT_SLUG,
    MAX_PROJECTS,
  ).all<{
    id: string
    direct_squads: number
    open_work: number
    active_flights: number
  }>()
  return new Map((result.results ?? []).map((row) => [row.id, {
    directSquads: Number(row.direct_squads ?? 0),
    openWork: Number(row.open_work ?? 0),
    activeFlights: Number(row.active_flights ?? 0),
  }]))
}

export async function loadProjectsPage(
  env: Env,
  auth: AuthContext,
  requestedFilters: ProjectListFilters = {},
): Promise<ProjectsPageView> {
  const access = await projectAccess(env, auth)
  const search = requestedFilters.search?.trim() ?? ''
  const status = requestedFilters.status ?? ''
  const { projects: displayed, capped } = await loadVisibleProjects(env, access, { search, status })
  const metrics = await loadListMetrics(env, displayed.map((project) => project.id), access)
  const displayedById = new Map(displayed.map((project) => [project.id, project]))
  const parentIds = [...new Set(displayed
    .map((project) => project.parent_project_id)
    .filter((id): id is string => id !== null && !displayedById.has(id)))]
  const parentContexts = await loadParentContexts(env, parentIds)
  const rootIds = new Set<string>()

  for (const project of displayed) {
    rootIds.add(project.parent_project_id ?? project.id)
  }

  const uncappedNodes = [...rootIds]
    .map((rootId): ProjectListNode | null => {
      const fullRoot = displayedById.get(rootId)
      const root = fullRoot ?? parentContexts.get(rootId)
      if (!root) return null
      const children = displayed
        .filter((project) => project.parent_project_id === rootId)
        .map((project) => ({
          ...project,
          metrics: metrics.get(project.id) ?? { directSquads: 0, openWork: 0, activeFlights: 0 },
        }))
      return {
        project: root,
        contextOnly: !fullRoot,
        metrics: fullRoot
          ? metrics.get(fullRoot.id) ?? { directSquads: 0, openWork: 0, activeFlights: 0 }
          : null,
        children,
      }
    })
    .filter((node): node is ProjectListNode => node !== null)

  return {
    nodes: uncappedNodes,
    visibleProjectCount: displayed.length,
    capped,
    canManage: access.workspaceAdmin,
    filters: { search, status },
  }
}

async function isReadableProject(env: Env, projectId: string, access: ProjectAccess): Promise<boolean> {
  const visibility = projectVisibilityClause(access)
  const project = await env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ? AND ${visibility.sql} LIMIT 1`,
  ).bind(projectId, ...visibility.binds).first()
  return project !== null
}

async function loadReadableTasks(
  env: Env,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectTaskRow[]> {
  if (access.readableSquadIds !== null && !access.readableSquadIds.length) return []
  const filter = access.readableSquadIds === null
    ? ''
    : ' AND t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const limitParam = access.readableSquadIds === null ? '?2' : '?3'
  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.squad_id, s.name AS squad_name, s.department_id
      FROM tasks t
       JOIN squads s ON s.id = t.squad_id
      WHERE t.project_id = ?1${filter}
      ORDER BY CASE t.status
        WHEN 'review' THEN 1
        WHEN 'blocked' THEN 2
        WHEN 'in_progress' THEN 3
        WHEN 'open' THEN 4
        ELSE 5
      END, t.updated_at, t.id
      LIMIT ${limitParam}`,
  ).bind(
    projectId,
    ...(access.readableSquadIds === null ? [] : [jsonIds(access.readableSquadIds)]),
    MAX_WORK_ROWS,
  )
    .all<ProjectTaskRow & { squad_id: string; department_id: string }>()
  return (result.results ?? [])
    .map(({ id, title, status, squad_name }) => ({ id, title, status, squad_name }))
}

async function loadReadableSquads(
  env: Env,
  projectId: string,
  access: ProjectAccess,
): Promise<{ rows: ProjectSquadRow[]; truncated: boolean }> {
  if (access.readableSquadIds !== null && !access.readableSquadIds.length) return { rows: [], truncated: false }
  const filter = access.readableSquadIds === null
    ? ''
    : ' AND psa.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const limitParam = access.readableSquadIds === null ? '?2' : '?3'
  const result = await env.DB.prepare(
    `SELECT psa.project_id, psa.squad_id, psa.access_level, psa.granted_at, s.name AS squad_name
       FROM project_squad_access psa
       JOIN squads s ON s.id = psa.squad_id
      WHERE psa.project_id = ?1${filter}
      ORDER BY psa.squad_id
      LIMIT ${limitParam}`,
  ).bind(
    projectId,
    ...(access.readableSquadIds === null ? [] : [jsonIds(access.readableSquadIds)]),
    MAX_SQUAD_ROWS + 1,
  ).all<ProjectSquadRow>()
  const candidates = result.results ?? []
  return {
    rows: candidates.slice(0, MAX_SQUAD_ROWS),
    truncated: candidates.length > MAX_SQUAD_ROWS,
  }
}

async function loadReadableProjectMembers(
  env: Env,
  squads: ProjectSquadRow[],
): Promise<{ rows: ProjectMemberRow[]; truncated: boolean }> {
  if (!squads.length) return { rows: [], truncated: false }
  type IdentityRow = Omit<
    ProjectMemberRow,
    'squad_name' | 'access_level' | 'attached' | 'runtime' | 'runtime_status' | 'presence' | 'host' | 'last_seen'
  >
  const result = await env.DB.prepare(
    `SELECT a.squad_id, a.id AS agent_id, a.slug AS agent_slug, a.name AS agent_name,
            a.role AS agent_role, a.model AS agent_model, a.status AS agent_status
       FROM agents a
       JOIN squads s ON s.id = a.squad_id
      WHERE a.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
      ORDER BY s.name, a.name, a.id
      LIMIT ?2`,
  ).bind(jsonIds(squads.map((squad) => squad.squad_id)), MAX_PROJECT_MEMBER_ROWS + 1).all<IdentityRow>()
  const candidates = result.results ?? []
  const truncated = candidates.length > MAX_PROJECT_MEMBER_ROWS
  const identities = candidates.slice(0, MAX_PROJECT_MEMBER_ROWS)
  const squadsById = new Map(squads.map((squad) => [squad.squad_id, squad]))
  const runtimeStates = await getFleetAgentRuntimeStates(
    env,
    identities.map((agent) => ({ agent_id: agent.agent_id, slug: agent.agent_slug })),
  )
  return {
    truncated,
    rows: identities.map((agent) => {
      const squad = squadsById.get(agent.squad_id)!
      const state = runtimeStates.get(agent.agent_id)
      const attached = Boolean(state?.runtime)
      return {
        ...agent,
        squad_name: squad.squad_name,
        access_level: squad.access_level,
        attached,
        runtime: state?.runtime ?? '',
        runtime_status: state?.status ?? '',
        presence: state?.presence ?? 'not_attached',
        host: state?.host ?? '',
        last_seen: state?.last_seen ?? '',
      }
    }),
  }
}

async function loadProjectAggregates(
  env: Env,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectDetailView['aggregates']> {
  const unrestricted = access.readableSquadIds === null
  const squadFilter = unrestricted
    ? ''
    : ' AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const flightFilter = unrestricted ? '' : readableFlightSql('f', '?2')
  const tenantParam = unrestricted ? '?2' : '?3'
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE project_id = ?1${squadFilter}) AS direct_tasks,
       (SELECT COUNT(*) FROM project_squad_access WHERE project_id = ?1${squadFilter}) AS direct_squads,
       (SELECT COUNT(*) FROM flights f
         WHERE f.project_id = ?1 AND f.tenant = ${tenantParam}${flightFilter}) AS direct_flights`,
  ).bind(
    projectId,
    ...(unrestricted ? [] : [jsonIds(access.readableSquadIds ?? [])]),
    env.TENANT_SLUG,
  ).first<{ direct_tasks: number; direct_squads: number; direct_flights: number }>()
  return {
    directTasks: Number(row?.direct_tasks ?? 0),
    directSquads: Number(row?.direct_squads ?? 0),
    directFlights: Number(row?.direct_flights ?? 0),
  }
}

export async function loadProjectDetail(
  env: Env,
  auth: AuthContext,
  projectId: string,
): Promise<ProjectDetailView | null> {
  const [project, access] = await Promise.all([getProject(env, projectId), projectAccess(env, auth)])
  if (!project || !await isReadableProject(env, project.id, access)) return null

  const squads = await loadReadableSquads(env, project.id, access)
  const [aggregates, tasks, members, parent, situation, activity, evidence] = await Promise.all([
    loadProjectAggregates(env, project.id, access),
    loadReadableTasks(env, project.id, access),
    loadReadableProjectMembers(env, squads.rows),
    project.parent_project_id ? getProject(env, project.parent_project_id) : Promise.resolve(null),
    loadProjectSituation(env, project, access.readableSquadIds),
    listProjectActivity(env, { projectId: project.id, readableSquadIds: access.readableSquadIds }),
    listProjectEvidence(env, { projectId: project.id, readableSquadIds: access.readableSquadIds }),
  ])

  return {
    project,
    parent: parent ? safeParent(parent) : null,
    aggregates,
    tasks,
    squads: squads.rows,
    squadsTruncated: squads.truncated,
    members: members.rows,
    membersTruncated: members.truncated,
    situation,
    activity,
    evidence,
    canManage: access.workspaceAdmin,
  }
}

export function projectFormValues(project?: Project): ProjectFormValues {
  return {
    slug: project?.slug ?? '',
    name: project?.name ?? '',
    description: project?.description ?? '',
    goal: project?.goal ?? '',
    parent_project_id: project?.parent_project_id ?? '',
    target_date: project?.target_date ?? '',
  }
}

export function submittedProjectFormValues(input: Record<string, unknown>): ProjectFormValues {
  const text = (value: unknown): string => typeof value === 'string' ? value : ''
  return {
    slug: text(input.slug),
    name: text(input.name),
    description: text(input.description),
    goal: text(input.goal),
    parent_project_id: text(input.parent_project_id),
    target_date: text(input.target_date),
  }
}

export function projectMutationInput(values: ProjectFormValues): UpdateProjectInput {
  return {
    slug: values.slug,
    name: values.name,
    description: values.description,
    goal: values.goal,
    parent_project_id: values.parent_project_id || null,
    target_date: values.target_date || null,
  }
}

export function projectMutationStatus(error: ProjectMutationError): 400 | 404 | 409 {
  if (error === 'project_not_found' || error === 'parent_not_found' || error === 'squad_not_found') return 404
  if (
    error === 'slug_taken'
    || error === 'receipt_failed'
    || error === 'hierarchy_depth'
    || error === 'hierarchy_cycle'
    || error === 'active_children'
    || error === 'archived_project'
    || error === 'invalid_status_transition'
  ) return 409
  return 400
}

export async function loadProjectParentOptions(
  env: Env,
  currentProjectId?: string,
): Promise<ProjectParentOption[]> {
  const options: ProjectParentOption[] = []
  let afterId = ''
  while (true) {
    const result = await env.DB.prepare(
      `SELECT id, name
         FROM projects
        WHERE parent_project_id IS NULL
          AND status <> 'archived'
          AND (?1 IS NULL OR id <> ?1)
          AND id > ?2
        ORDER BY id
        LIMIT ?3`,
    ).bind(currentProjectId ?? null, afterId, PARENT_OPTIONS_PAGE_SIZE).all<ProjectParentOption>()
    const page = result.results ?? []
    options.push(...page)
    if (page.length < PARENT_OPTIONS_PAGE_SIZE) break
    afterId = page[page.length - 1].id
  }

  if (currentProjectId) {
    const currentParent = await env.DB.prepare(
      `SELECT parent.id, parent.name
         FROM projects current
         JOIN projects parent ON parent.id = current.parent_project_id
        WHERE current.id = ?1`,
    ).bind(currentProjectId).first<ProjectParentOption>()
    if (currentParent && !options.some((option) => option.id === currentParent.id)) {
      options.push(currentParent)
      options.sort((a, b) => a.id.localeCompare(b.id))
    }
  }
  return options
}

export async function loadProjectWorkContext(
  env: Env,
  auth: AuthContext,
  projectId: string,
): Promise<ProjectWorkContext | null> {
  const [project, access] = await Promise.all([getProject(env, projectId), projectAccess(env, auth)])
  if (!project || !await isReadableProject(env, project.id, access)) return null
  if (project.status === 'archived' || access.taskableSquadIds?.length === 0) {
    return {
      project,
      readableSquadIds: access.readableSquadIds,
      taskableSquadIds: [],
      taskableSquadIdsTruncated: false,
    }
  }
  const taskableFilter = access.taskableSquadIds === null
    ? ''
    : ' AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const limitParam = access.taskableSquadIds === null ? '?2' : '?3'
  const edges = await env.DB.prepare(
    `SELECT squad_id, access_level
       FROM project_squad_access
      WHERE project_id = ?1
        AND access_level IN ('write', 'admin')${taskableFilter}
      ORDER BY squad_id
      LIMIT ${limitParam}`,
  ).bind(
    project.id,
    ...(access.taskableSquadIds === null ? [] : [jsonIds(access.taskableSquadIds)]),
    MAX_SQUAD_ROWS + 1,
  ).all<{ squad_id: string; access_level: ProjectAccessLevel }>()
  const candidates = edges.results ?? []
  return {
    project,
    readableSquadIds: access.readableSquadIds,
    taskableSquadIds: candidates.slice(0, MAX_SQUAD_ROWS).map((edge) => edge.squad_id),
    taskableSquadIdsTruncated: candidates.length > MAX_SQUAD_ROWS,
  }
}

export function projectFlightIsReadable(context: ProjectWorkContext, meta: string): boolean {
  if (context.readableSquadIds === null) return true
  const readable = new Set(context.readableSquadIds)
  try {
    const parsed = parseFlightMetaV1(JSON.parse(meta))
    return parsed !== null && parsed.squad_ids.every((id) => readable.has(id))
  } catch {
    return false
  }
}

export async function loadProjectFlights(
  env: Env,
  context: ProjectWorkContext,
): Promise<ProjectFlightsResult> {
  if (context.readableSquadIds === null) {
    const result = await env.DB.prepare(
      `SELECT *
         FROM flights
        WHERE tenant = ?1 AND project_id = ?2
        ORDER BY created_at DESC, id DESC
        LIMIT ?3`,
    ).bind(env.TENANT_SLUG, context.project.id, 100).all<FlightRow>()
    return { rows: result.results ?? [], scanLimited: false }
  }

  const flights: FlightRow[] = []
  let cursorCreatedAt: number | null = null
  let cursorId: string | null = null

  for (let page = 0; page < MAX_FLIGHT_SCAN_PAGES; page += 1) {
    const result: { results?: FlightRow[] } = await env.DB.prepare(
      `SELECT *
         FROM flights f
        WHERE f.tenant = ?1 AND f.project_id = ?2
          ${readableFlightSql('f', '?3')}
          AND (
            ?4 IS NULL
            OR f.created_at < ?4
            OR (f.created_at = ?4 AND f.id < ?5)
          )
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ?6`,
    ).bind(
      env.TENANT_SLUG,
      context.project.id,
      jsonIds(context.readableSquadIds),
      cursorCreatedAt,
      cursorId,
      100,
    ).all<FlightRow>()
    const candidates: FlightRow[] = result.results ?? []

    for (const flight of candidates) {
      if (projectFlightIsReadable(context, flight.meta)) {
        flights.push(flight)
        if (flights.length === 100) break
      }
    }

    if (candidates.length < 100 || flights.length === 100) {
      return { rows: flights, scanLimited: false }
    }
    const last: FlightRow = candidates[candidates.length - 1]!
    cursorCreatedAt = last.created_at
    cursorId = last.id
  }

  return { rows: flights, scanLimited: true }
}

function statusTone(status: ProjectStatus): 'ok' | 'warn' | 'dim' | 'primary' {
  if (status === 'active' || status === 'completed') return 'ok'
  if (status === 'planned' || status === 'paused') return 'warn'
  if (status === 'archived') return 'dim'
  return 'primary'
}

function memberPresenceLabel(presence: ProjectMemberRow['presence']): string {
  if (presence === 'not_attached') return 'Not attached'
  return presence.charAt(0).toUpperCase() + presence.slice(1)
}

function memberPresenceTone(
  presence: ProjectMemberRow['presence'],
): 'ok' | 'warn' | 'dim' {
  if (presence === 'live') return 'ok'
  if (presence === 'stale') return 'warn'
  return 'dim'
}

function situationTone(health: ProjectHealth): 'ok' | 'warn' | 'danger' | 'dim' | 'primary' {
  if (health === 'blocked') return 'danger'
  if (health === 'review' || health === 'paused') return 'warn'
  if (health === 'archived') return 'dim'
  if (health === 'completed' || health === 'ready') return 'ok'
  return 'primary'
}

function situationCount(value: number, truncated: boolean): string {
  return `${value}${truncated ? '+' : ''}`
}

function operatingSituationBand(
  project: Project,
  aggregates: ProjectDetailView['aggregates'],
  situation: ProjectSituation,
): Html {
  const activity = situation.latest_activity
  const notices = [
    situation.active_work_count_truncated
      ? 'One or more work-status counts exceed 100; active work is a lower bound.'
      : null,
    situation.active_flight_count_truncated ? 'Active flight count is capped at 100.' : null,
    situation.blocker_details_truncated ? `Showing the first ${situation.blockers.length} blockers.` : null,
    situation.pending_review_details_truncated ? `Showing the first ${situation.pending_reviews.length} pending reviews.` : null,
  ].filter((notice): notice is string => notice !== null)

  return html`<section id="overview" aria-label="Overview" style="padding:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);">
    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;">
      <h2 class="ui-panel-title">Operating summary</h2>
      <span class="ui-panel-sub">Health</span>
      ${pill(situation.health, situationTone(situation.health))}
      <span style="min-width:0;overflow-wrap:anywhere;">${situation.summary}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:12px;margin-top:14px;">
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Next action</div>
        <div style="min-width:0;overflow-wrap:anywhere;">${situation.next_action?.label ?? 'No next action is available for this project.'}</div>
      </div>
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Active work</div>
        <div>${situationCount(situation.active_work_count, situation.active_work_count_truncated)}</div>
      </div>
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Active flights</div>
        <div>${situationCount(situation.active_flight_count, situation.active_flight_count_truncated)}</div>
      </div>
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Latest activity</div>
        ${activity
          ? html`<div style="min-width:0;overflow-wrap:anywhere;">${activity.title}</div><div class="ui-agent-role" style="min-width:0;overflow-wrap:anywhere;">${activity.detail || activity.status}</div>`
          : html`<div style="min-width:0;overflow-wrap:anywhere;">No material activity yet.</div>`}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:16px;margin-top:16px;">
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Blockers</div>
        ${situation.blockers.length
          ? html`<ul style="box-sizing:border-box;max-width:100%;margin:6px 0 0;padding-left:18px;overflow-wrap:anywhere;">${situation.blockers.map((blocker) => html`<li style="min-width:0;overflow-wrap:anywhere;">
              <span style="min-width:0;overflow-wrap:anywhere;">${blocker.title}</span>${blocker.blocker_summary ? html`<span class="ui-agent-role" style="min-width:0;overflow-wrap:anywhere;">${blocker.blocker_summary}</span>` : ''}
            </li>`)}</ul>`
          : html`<div>No blockers need attention.</div>`}
      </div>
      <div style="min-width:0;overflow-wrap:anywhere;">
        <div class="ui-panel-sub">Pending reviews</div>
        ${situation.pending_reviews.length
          ? html`<ul style="box-sizing:border-box;max-width:100%;margin:6px 0 0;padding-left:18px;overflow-wrap:anywhere;">${situation.pending_reviews.map((review) => html`<li style="min-width:0;overflow-wrap:anywhere;">
              <span style="min-width:0;overflow-wrap:anywhere;">${review.title}</span>${review.gate_owner ? html`<span class="ui-agent-role" style="min-width:0;overflow-wrap:anywhere;">${review.gate_owner}</span>` : ''}
            </li>`)}</ul>`
          : html`<div>No reviews are pending.</div>`}
      </div>
    </div>
    ${notices.length ? html`<div class="ui-panel-sub" style="margin-top:14px;">${notices.join(' ')}</div>` : ''}
    <dl style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:12px;margin:16px 0 0;padding-top:14px;border-top:1px solid var(--border);">
      <div style="min-width:0;overflow-wrap:anywhere;"><dt class="ui-panel-sub">Goal</dt><dd style="margin:4px 0 0;min-width:0;overflow-wrap:anywhere;">${project.goal || 'No goal set'}</dd></div>
      <div style="min-width:0;overflow-wrap:anywhere;"><dt class="ui-panel-sub">Target date</dt><dd style="margin:4px 0 0;min-width:0;overflow-wrap:anywhere;">${project.target_date ?? 'Not set'}</dd></div>
      <div style="min-width:0;overflow-wrap:anywhere;"><dt class="ui-panel-sub">Direct tasks</dt><dd style="margin:4px 0 0;min-width:0;overflow-wrap:anywhere;">${String(aggregates.directTasks)}</dd></div>
      <div style="min-width:0;overflow-wrap:anywhere;"><dt class="ui-panel-sub">Direct flights</dt><dd style="margin:4px 0 0;min-width:0;overflow-wrap:anywhere;">${String(aggregates.directFlights)}</dd></div>
      <div style="min-width:0;overflow-wrap:anywhere;"><dt class="ui-panel-sub">Squad edges</dt><dd style="margin:4px 0 0;min-width:0;overflow-wrap:anywhere;">${String(aggregates.directSquads)}</dd></div>
    </dl>
  </section>`
}

interface ProjectTableColumn {
  label: string
  width?: string
}

function safeTrack(width: string | undefined): string {
  if (!width) return '1fr'
  return /^(auto|[0-9]+(\.[0-9]+)?fr)$/.test(width) ? width : '1fr'
}

function semanticDataTable(opts: {
  label: string
  cols: ProjectTableColumn[]
  rows: Html[][]
  empty?: string
  minWidth?: string
}): Html {
  const template = opts.cols.map((column) => safeTrack(column.width)).join(' ')
  const head = html`<div class="ui-tr ui-thead" role="row" style="grid-template-columns:${raw(template)}">
    ${opts.cols.map((column) => html`<div class="ui-th" role="columnheader">${column.label}</div>`)}
  </div>`
  const rows = opts.rows.length
    ? opts.rows.map((cells) => html`<div class="ui-tr ui-row" role="row" style="grid-template-columns:${raw(template)}">
        ${cells.map((cell) => html`<div class="ui-td" role="cell" style="overflow-wrap:anywhere;">${cell}</div>`)}
      </div>`)
    : html`<div class="ui-table-empty">${opts.empty ?? 'Nothing here yet.'}</div>`
  return html`<div role="region" aria-label="${opts.label}" tabindex="0" style="max-width:100%;overflow-x:auto;">
    <div class="ui-table" role="table" aria-label="${opts.label}" aria-colcount="${String(opts.cols.length)}"${opts.minWidth ? html` style="min-width:${opts.minWidth};"` : ''}>
      ${head}${rows}
    </div>
  </div>`
}

function statusLabel(status: ProjectStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function projectsControls(view: ProjectsPageView): Html {
  return html`<div style="display:flex;flex-wrap:wrap;align-items:end;justify-content:space-between;gap:12px;margin:16px 0;">
    <form method="get" action="/projects" style="display:flex;flex:1 1 34rem;flex-wrap:wrap;align-items:end;gap:10px;min-width:0;">
      <label style="display:grid;gap:5px;flex:1 1 16rem;min-width:min(100%,12rem);">
        <span class="ui-panel-sub">Search</span>
        <input name="search" type="search" value="${view.filters.search}" placeholder="Name or goal" style="box-sizing:border-box;width:100%;min-width:0;">
      </label>
      <label style="display:grid;gap:5px;flex:0 1 12rem;min-width:min(100%,10rem);">
        <span class="ui-panel-sub">Status</span>
        <select name="status" style="box-sizing:border-box;width:100%;min-width:0;">
          <option value=""${view.filters.status === '' ? raw(' selected') : raw('')}>All statuses</option>
          ${PROJECT_STATUSES.map((status) => html`<option value="${status}"${view.filters.status === status ? raw(' selected') : raw('')}>${statusLabel(status)}</option>`)}
        </select>
      </label>
      <button class="btn secondary" type="submit">Filter</button>
    </form>
    ${view.canManage ? html`<a class="btn" href="/projects/new">Create project</a>` : ''}
  </div>`
}

export function projectsPageBody(view: ProjectsPageView) {
  const header = html`${pageHeader({
    crumbs: 'Workspace / Projects',
    title: 'Projects',
    sub: 'Goals, squads, work, and evidence organized around durable outcomes.',
  })}${projectsControls(view)}`
  if (!view.nodes.length) {
    return html`
      ${header}
      ${emptyState({
        title: 'No projects available',
        detail: view.filters.search || view.filters.status
          ? 'No visible project matches the current filters.'
          : 'No project is currently visible to this account.',
        hint: view.filters.search || view.filters.status
          ? 'Clear or adjust the search and status filters.'
          : 'No project data is fabricated. Ask a workspace administrator to connect one of your squads.',
      })}`
  }

  const rows = view.nodes.flatMap((node) => {
    const rootGoal = node.contextOnly ? 'Parent context only' : (node.project as Project).goal || 'No goal set'
    const rootTarget = node.contextOnly ? 'Context' : (node.project as Project).target_date ?? 'Not set'
    const rootName = node.contextOnly
      ? html`<span class="ui-agent-name">${node.project.name}</span>`
      : html`<a class="ui-agent-name" href="/projects/${encodeURIComponent(node.project.id)}">${node.project.name}</a>`
    return [
      [
        html`${rootName}
          <span class="ui-agent-role">${node.contextOnly ? 'Parent context' : rootGoal}</span>`,
        pill(node.project.status, statusTone(node.project.status)),
        html`<span class="ui-mono-dim">${node.metrics?.directSquads ?? 'Context'}</span>`,
        html`<span class="ui-mono-dim">${node.metrics?.openWork ?? 'Context'}</span>`,
        html`<span class="ui-mono-dim">${node.metrics?.activeFlights ?? 'Context'}</span>`,
        html`<span class="ui-mono-dim">${rootTarget}</span>`,
      ],
      ...node.children.map((child) => [
        html`<span class="ui-panel-sub">Child project</span>
          <a class="ui-agent-name" href="/projects/${encodeURIComponent(child.id)}">${child.name}</a>
          <span class="ui-agent-role">${child.goal || 'No goal set'}</span>`,
        pill(child.status, statusTone(child.status)),
        html`<span class="ui-mono-dim">${child.metrics.directSquads}</span>`,
        html`<span class="ui-mono-dim">${child.metrics.openWork}</span>`,
        html`<span class="ui-mono-dim">${child.metrics.activeFlights}</span>`,
        html`<span class="ui-mono-dim">${child.target_date ?? 'Not set'}</span>`,
      ]),
    ]
  })

  return html`
    ${header}
    <p class="ui-panel-sub">${view.visibleProjectCount}${view.capped ? '+' : ''} matching visible project${view.visibleProjectCount === 1 ? '' : 's'} across root and child levels.</p>
    ${sectionPanel({
      title: 'Project workspace',
      body: semanticDataTable({
        label: 'Projects',
        cols: [
          { label: 'Project', width: '1.5fr' },
          { label: 'Status', width: 'auto' },
          { label: 'Squads', width: 'auto' },
          { label: 'Open work', width: 'auto' },
          { label: 'Active flights', width: 'auto' },
          { label: 'Target', width: 'auto' },
        ],
        rows,
      }),
    })}
    ${view.capped ? html`<p class="ui-panel-sub">Showing the first ${MAX_PROJECTS} visible projects.</p>` : ''}`
}

function projectMutationMessage(error: ProjectMutationError): string {
  const messages: Record<ProjectMutationError, string> = {
    invalid_slug: 'Use a lowercase slug with letters, numbers, and hyphens.',
    invalid_name: 'Enter a project name.',
    invalid_status: 'Choose a valid project status action.',
    invalid_status_transition: 'That action is not available from the current project status.',
    invalid_target_date: 'Enter a valid target date.',
    slug_taken: 'That project slug is already in use.',
    project_not_found: 'The project no longer exists.',
    parent_not_found: 'The selected parent project was not found.',
    hierarchy_depth: 'Projects can only be nested one level deep.',
    hierarchy_cycle: 'A project cannot be moved beneath itself.',
    active_children: 'Archive or move active child projects first.',
    archived_project: 'Restore the archived project before changing its metadata.',
    squad_not_found: 'A connected squad was not found.',
    invalid_access_level: 'A connected squad has an invalid access level.',
    receipt_failed: 'The project changed concurrently. Reload and try again.',
  }
  return messages[error]
}

function projectMetadataForm(opts: {
  action: string
  values: ProjectFormValues
  parentOptions: ProjectParentOption[]
  submitLabel: string
  error?: ProjectMutationError
}): Html {
  const unavailableParent = opts.values.parent_project_id
    && !opts.parentOptions.some((parent) => parent.id === opts.values.parent_project_id)
  return html`<form method="post" action="${opts.action}" style="display:grid;gap:16px;padding:16px 0;border-top:1px solid var(--border);">
    ${opts.error ? html`<p role="alert" style="margin:0;color:var(--danger,#c0392b);">${projectMutationMessage(opts.error)}</p>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:14px;min-width:0;">
      <label style="display:grid;gap:5px;min-width:0;">
        <span class="ui-panel-sub">Name</span>
        <input name="name" required value="${opts.values.name}" style="box-sizing:border-box;width:100%;min-width:0;">
      </label>
      <label style="display:grid;gap:5px;min-width:0;">
        <span class="ui-panel-sub">Slug</span>
        <input name="slug" required value="${opts.values.slug}" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" style="box-sizing:border-box;width:100%;min-width:0;">
      </label>
      <label style="display:grid;gap:5px;min-width:0;">
        <span class="ui-panel-sub">Parent</span>
        <select name="parent_project_id" style="box-sizing:border-box;width:100%;min-width:0;">
          <option value=""${opts.values.parent_project_id === '' ? raw(' selected') : raw('')}>No parent</option>
          ${unavailableParent ? html`<option value="${opts.values.parent_project_id}" selected>Unavailable parent: ${opts.values.parent_project_id}</option>` : ''}
          ${opts.parentOptions.map((parent) => html`<option value="${parent.id}"${opts.values.parent_project_id === parent.id ? raw(' selected') : raw('')}>${parent.name}</option>`)}
        </select>
      </label>
      <label style="display:grid;gap:5px;min-width:0;">
        <span class="ui-panel-sub">Target date</span>
        <input name="target_date" type="${opts.values.target_date === '' || isValidProjectTargetDate(opts.values.target_date) ? 'date' : 'text'}" value="${opts.values.target_date}" style="box-sizing:border-box;width:100%;min-width:0;">
      </label>
    </div>
    <label style="display:grid;gap:5px;min-width:0;">
      <span class="ui-panel-sub">Goal</span>
      <textarea name="goal" rows="3" style="box-sizing:border-box;width:100%;min-width:0;resize:vertical;">${opts.values.goal}</textarea>
    </label>
    <label style="display:grid;gap:5px;min-width:0;">
      <span class="ui-panel-sub">Description</span>
      <textarea name="description" rows="4" style="box-sizing:border-box;width:100%;min-width:0;resize:vertical;">${opts.values.description}</textarea>
    </label>
    <div><button class="btn" type="submit">${opts.submitLabel}</button></div>
  </form>`
}

export function projectCreateBody(view: ProjectFormView): Html {
  return html`${pageHeader({
    crumbs: 'Workspace / Projects',
    title: 'Create project',
    sub: 'Create a planned project, then activate it when work is ready to begin.',
  })}${projectMetadataForm({
    action: '/projects',
    values: view.values,
    parentOptions: view.parentOptions,
    submitLabel: 'Create project',
    error: view.error,
  })}`
}

export function projectSettingsBody(view: ProjectSettingsView): Html {
  const projectPath = `/projects/${encodeURIComponent(view.project.id)}`
  const validTargets = validProjectStatusTransitions(view.project.status)
  const availableCommands = PROJECT_LIFECYCLE_COMMANDS.filter((candidate) => validTargets.includes(candidate.status))
  const unavailableCommand = view.lifecycleCommand
    && !availableCommands.some((candidate) => candidate.command === view.lifecycleCommand)
  return html`${pageHeader({
    crumbs: `Projects / ${view.project.name}`,
    title: 'Project settings',
    sub: 'Update project metadata, hierarchy, and lifecycle status.',
    badge: view.project.status,
    badgeTone: statusTone(view.project.status),
  })}
  ${projectMetadataForm({
    action: `${projectPath}/settings`,
    values: view.values,
    parentOptions: view.parentOptions,
    submitLabel: 'Save settings',
    error: view.error,
  })}
  <section aria-labelledby="project-lifecycle-title" style="padding:16px 0;border-top:1px solid var(--border);">
    <h2 id="project-lifecycle-title" class="ui-panel-title">Lifecycle</h2>
    <form method="post" action="${projectPath}/status" style="display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin-top:12px;">
      <label style="display:grid;gap:5px;flex:1 1 16rem;min-width:min(100%,12rem);">
        <span class="ui-panel-sub">Action</span>
        <select name="command" style="box-sizing:border-box;width:100%;min-width:0;">
          ${unavailableCommand ? html`<option value="${view.lifecycleCommand}" selected>Unavailable action: ${view.lifecycleCommand}</option>` : ''}
          ${availableCommands.map((candidate) => html`<option value="${candidate.command}"${view.lifecycleCommand === candidate.command ? raw(' selected') : raw('')}>${candidate.label}</option>`)}
        </select>
      </label>
      <button class="btn" type="submit">Apply status</button>
    </form>
  </section>`
}

function projectTabs() {
  return html`<nav aria-label="Project sections" style="display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px;">
    <a class="btn secondary sm" data-project-tab href="#overview" aria-current="page">Overview</a>
    <a class="btn secondary sm" data-project-tab href="#work">Work</a>
    <a class="btn secondary sm" data-project-tab href="#squads">Team / Squads</a>
    <a class="btn secondary sm" data-project-tab href="#activity">Activity</a>
    <a class="btn secondary sm" data-project-tab href="#evidence">Evidence</a>
  </nav>
  <script>
    (function () {
      function syncProjectTab() {
        var current = window.location.hash || '#overview';
        document.querySelectorAll('[data-project-tab]').forEach(function (link) {
          if (link.getAttribute('href') === current) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        });
      }
      window.addEventListener('hashchange', syncProjectTab);
      syncProjectTab();
    })();
  </script>`
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

const PROJECT_RESULT_MESSAGES: Readonly<Record<string, string>> = {
  created: 'Project created.',
  updated: 'Project settings saved.',
  activated: 'Project activated.',
  paused: 'Project paused.',
  completed: 'Project completed.',
  archived: 'Project archived.',
  restored: 'Project restored to planned.',
}

export function projectDetailBody(view: ProjectDetailView, statusResult?: string) {
  const { project, parent, aggregates, situation } = view
  const resultMessage = statusResult && Object.hasOwn(PROJECT_RESULT_MESSAGES, statusResult)
    ? PROJECT_RESULT_MESSAGES[statusResult]
    : undefined
  const workLinks = html`<span style="display:flex;flex-wrap:wrap;gap:8px;">
    <a class="ui-link" href="/send?project_id=${encodeURIComponent(project.id)}">Project tasks</a>
    <a class="ui-link" href="/flights?project_id=${encodeURIComponent(project.id)}">Project flights</a>
  </span>`
  const squadCell = (squad: Pick<ProjectSquadRow, 'squad_id' | 'squad_name' | 'access_level'>) => html`<span style="display:grid;gap:3px;min-width:0;white-space:normal;overflow-wrap:anywhere;">
    <a class="ui-link" style="white-space:normal;overflow-wrap:anywhere;" href="/squads/${encodeURIComponent(squad.squad_id)}">${squad.squad_name}</a>
    <span class="ui-panel-sub">Project access: ${squad.access_level}</span>
  </span>`
  const memberCells = (member: ProjectMemberRow): Html[] => [
    squadCell(member),
    html`<a class="ui-link" style="white-space:normal;overflow-wrap:anywhere;" href="/agents/${encodeURIComponent(member.agent_id)}">${member.agent_name}</a>`,
    html`<span style="display:grid;gap:3px;min-width:0;white-space:normal;overflow-wrap:anywhere;">
      <span>${member.agent_role}</span>
      <span class="ui-panel-sub" style="white-space:normal;overflow-wrap:anywhere;">Model: ${member.agent_model}</span>
      <span class="ui-panel-sub">Agent status: ${member.agent_status}</span>
    </span>`,
    member.attached
      ? html`<span style="display:grid;gap:3px;min-width:0;white-space:normal;overflow-wrap:anywhere;">
          <span>${member.runtime}</span>
          <span class="ui-panel-sub">Stored intent: ${member.runtime_status || 'unknown'}</span>
        </span>`
      : html`<span style="display:grid;gap:3px;min-width:0;white-space:normal;overflow-wrap:anywhere;">
          <span>Not attached</span>
          <span class="ui-panel-sub">No external runtime reported.</span>
          ${member.runtime_status ? html`<span class="ui-panel-sub">Stored intent: ${member.runtime_status}</span>` : ''}
        </span>`,
    html`<span data-project-agent-presence data-agent-id="${member.agent_id}" data-presence="${member.presence}">${pill(memberPresenceLabel(member.presence), memberPresenceTone(member.presence))}</span>`,
    html`<span style="display:grid;gap:3px;min-width:0;white-space:normal;overflow-wrap:anywhere;">
      <span>${member.host || 'Host not reported'}</span>
      <span class="ui-panel-sub" style="white-space:normal;overflow-wrap:anywhere;">Last seen: ${member.last_seen || 'Never reported'}</span>
    </span>`,
  ]
  const membersBySquad = new Map<string, ProjectMemberRow[]>()
  for (const member of view.members) {
    const members = membersBySquad.get(member.squad_id) ?? []
    members.push(member)
    membersBySquad.set(member.squad_id, members)
  }
  const teamRows = view.squads.flatMap((squad) => {
    const members = membersBySquad.get(squad.squad_id) ?? []
    return members.length
      ? members.map(memberCells)
      : [[
          squadCell(squad),
          html`<span class="ui-panel-sub">No readable agent members are shown for this connected project squad.</span>`,
          html`<span class="ui-panel-sub">No agent details reported.</span>`,
          html`<span class="ui-panel-sub">No runtime reported.</span>`,
          pill('Not attached', 'dim'),
          html`<span class="ui-panel-sub">No host or last-seen data reported.</span>`,
        ]]
  })

  return html`
    ${pageHeader({
      crumbs: parent ? `Projects / ${parent.name}` : 'Projects',
      title: project.name,
      sub: project.description || 'No description set.',
      badge: project.status,
      badgeTone: statusTone(project.status),
    })}
    ${resultMessage ? html`<p role="status" style="margin:8px 0;color:var(--ok,#16a34a);">${resultMessage}</p>` : ''}
    ${view.canManage ? html`<div style="display:flex;justify-content:flex-end;margin:8px 0;"><a class="btn secondary sm" href="/projects/${encodeURIComponent(project.id)}/settings">Project settings</a></div>` : ''}
    ${projectTabs()}
    <script type="application/json" id="project-situation-json">${raw(jsonScript(situation))}</script>
    ${operatingSituationBand(project, aggregates, situation)}
    <section id="work" aria-label="Work">
      ${sectionPanel({
        title: 'Work',
        right: workLinks,
        body: semanticDataTable({
          label: 'Project work',
          cols: [
            { label: 'Task', width: '1.5fr' },
            { label: 'Squad', width: '1fr' },
            { label: 'Status', width: 'auto' },
          ],
          rows: view.tasks.map((task) => [
            html`<span>${task.title}</span>`,
            html`<span>${task.squad_name}</span>`,
            html`<span class="ui-mono-dim">${task.status}</span>`,
          ]),
          empty: 'No readable tasks are attributed to this project yet.',
        }),
      })}
    </section>
    <section id="squads" aria-label="Team and squads">
      ${sectionPanel({
        title: 'Team / Squads',
        body: html`${semanticDataTable({
          label: 'Readable project agent members',
          minWidth: '70rem',
          cols: [
            { label: 'Squad', width: '1fr' },
            { label: 'Agent', width: '1.3fr' },
            { label: 'Role / model / status', width: '1.3fr' },
            { label: 'Runtime', width: '1fr' },
            { label: 'Presence', width: 'auto' },
            { label: 'Host / last seen', width: '1.2fr' },
          ],
          rows: teamRows,
          empty: 'No readable squad edges are connected to this project.',
        })}${view.squadsTruncated ? html`<p class="ui-panel-sub">Showing the first ${MAX_SQUAD_ROWS} readable squad edges.</p>` : ''}${view.membersTruncated ? html`<p class="ui-panel-sub">Showing the first ${MAX_PROJECT_MEMBER_ROWS} readable agent members.</p>` : ''}`,
      })}
    </section>
    <section id="activity" aria-label="Activity">
      ${sectionPanel({
        title: 'Activity',
        body: html`${semanticDataTable({
          label: 'Project activity',
          cols: [
            { label: 'When', width: 'auto' },
            { label: 'Type', width: 'auto' },
            { label: 'Item', width: '2fr' },
            { label: 'Status', width: 'auto' },
          ],
          rows: view.activity.rows.map((event) => [
            html`<span class="ui-mono-dim">${event.occurred_at}</span>`,
            html`<span>${event.source_type}</span>`,
            html`<span>${event.title}</span>${event.detail ? html`<span class="ui-agent-role">${event.detail}</span>` : ''}`,
            pill(event.status, event.status === 'done' || event.status === 'landed' || event.status === 'ack' ? 'ok' : 'primary'),
          ]),
          empty: 'No task, message, or flight is attributed to this project yet.',
        })}${view.activity.hasMore ? html`<p class="ui-panel-sub">Showing the newest 100 activity rows.</p>` : ''}`,
      })}
    </section>
    <section id="evidence" aria-label="Evidence">
      ${sectionPanel({
        title: 'Evidence',
        body: html`${semanticDataTable({
          label: 'Project evidence',
          cols: [
            { label: 'When', width: 'auto' },
            { label: 'Receipt', width: 'auto' },
            { label: 'Evidence', width: '2fr' },
            { label: 'Status', width: 'auto' },
          ],
          rows: view.evidence.rows.map((receipt) => [
            html`<span class="ui-mono-dim">${receipt.occurred_at}</span>`,
            html`<span>${receipt.source_type.replaceAll('_', ' ')}</span>`,
            html`<span>${receipt.title}</span>${receipt.detail ? html`<span class="ui-agent-role">${receipt.detail}</span>` : ''}`,
            pill(receipt.status, receipt.status === 'ok' || receipt.status === 'approved' || receipt.status === 'delivered' || receipt.status === 'consumed' || receipt.status === 'done' ? 'ok' : 'primary'),
          ]),
          empty: 'No retained result or linked receipt exists for this project yet.',
        })}${view.evidence.hasMore ? html`<p class="ui-panel-sub">Showing the newest 100 evidence rows.</p>` : ''}`,
      })}
    </section>`
}

export function projectNotFoundBody() {
  return html`${pageHeader({ crumbs: 'Workspace / Projects', title: 'Project not found' })}
    ${emptyState({
      title: 'Project unavailable',
      detail: 'This project does not exist or is not visible to this account.',
    })}`
}
