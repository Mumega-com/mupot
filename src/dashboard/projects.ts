import { html, raw } from 'hono/html'
import type { AuthContext, Env, Project, ProjectAccessLevel, ProjectStatus } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { parseFlightMetaV1 } from '../flight/meta'
import { canonicalFlightMetaSql } from '../flight/meta-sql'
import type { FlightRow } from '../flight/service'
import { getProject } from '../projects/service'
import { listProjectActivity, listProjectEvidence } from '../projects/projections'
import type {
  ProjectActivitySource,
  ProjectEvidenceSource,
  ProjectProjectionPage,
} from '../projects/projections'
import { emptyState, kpiRow, pageHeader, pill, sectionPanel, statCard } from './ui'
import type { Html } from './ui'

const MAX_PROJECTS = 100
const MAX_WORK_ROWS = 50
const MAX_SQUAD_ROWS = 100
const MAX_FLIGHT_SCAN_PAGES = 10

type ParentContext = Pick<Project, 'id' | 'slug' | 'name' | 'status' | 'parent_project_id'>

interface ProjectAccess {
  workspaceAdmin: boolean
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
  activity: ProjectProjectionPage<ProjectActivitySource>
  evidence: ProjectProjectionPage<ProjectEvidenceSource>
}

export interface ProjectWorkContext {
  project: Project
  readableSquadIds: string[] | null
  taskableSquadIds: string[]
}

export interface ProjectFlightsResult {
  rows: FlightRow[]
  scanLimited: boolean
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

async function projectAccess(env: Env, auth: AuthContext): Promise<ProjectAccess> {
  if (legacyWorkspaceAdmin(auth)) {
    return { workspaceAdmin: true, readableSquadIds: null, taskableSquadIds: null }
  }
  const memberId = await memberIdFor(env, auth)
  const grants = memberId ? auth.capabilities ?? await resolveCapabilities(env, memberId) : []
  if (hasCapability(grants, 'org', null, 'admin')) {
    return { workspaceAdmin: true, readableSquadIds: null, taskableSquadIds: null }
  }
  const rows = grants.length
    ? await env.DB.prepare('SELECT id, department_id FROM squads').all<{ id: string; department_id: string }>()
    : { results: [] }
  const squads = rows.results ?? []
  return {
    workspaceAdmin: false,
    readableSquadIds: squads
      .filter((squad) => hasCapability(grants, 'squad', squad.id, 'observer', squad.department_id))
      .map((squad) => squad.id),
    taskableSquadIds: squads
      .filter((squad) => hasCapability(grants, 'squad', squad.id, 'member', squad.department_id))
      .map((squad) => squad.id),
  }
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
): Promise<{ projects: Project[]; capped: boolean }> {
  if (!access.workspaceAdmin && access.readableSquadIds?.length === 0) {
    return { projects: [], capped: false }
  }
  const statement = access.workspaceAdmin
    ? env.DB.prepare(
      `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id,
              p.target_date, p.created_at, p.updated_at
         FROM projects p
        ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
        LIMIT ?1`,
    ).bind(MAX_PROJECTS + 1)
    : env.DB.prepare(
      `SELECT p.id, p.slug, p.name, p.description, p.goal, p.status, p.parent_project_id,
              p.target_date, p.created_at, p.updated_at
         FROM projects p
        WHERE EXISTS (
          SELECT 1
            FROM project_squad_access psa
           WHERE psa.project_id = p.id
             AND psa.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
        )
        ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
        LIMIT ?2`,
    ).bind(jsonIds(access.readableSquadIds ?? []), MAX_PROJECTS + 1)
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
  const squadFilter = access.workspaceAdmin
    ? ''
    : ' AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const flightFilter = access.workspaceAdmin ? '' : readableFlightSql('f', '?2')
  const tenantParam = access.workspaceAdmin ? '?2' : '?3'
  const limitParam = access.workspaceAdmin ? '?3' : '?4'
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
    ...(access.workspaceAdmin ? [] : [jsonIds(access.readableSquadIds ?? [])]),
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

export async function loadProjectsPage(env: Env, auth: AuthContext): Promise<ProjectsPageView> {
  const access = await projectAccess(env, auth)
  const { projects: displayed, capped } = await loadVisibleProjects(env, access)
  const metrics = await loadListMetrics(env, displayed.map((project) => project.id), access)
  const visibleById = new Map(displayed.map((project) => [project.id, project]))
  const parentIds = [...new Set(displayed
    .map((project) => project.parent_project_id)
    .filter((id): id is string => id !== null && !visibleById.has(id)))]
  const parentContexts = await loadParentContexts(env, parentIds)
  const rootIds = new Set<string>()

  for (const project of displayed) {
    rootIds.add(project.parent_project_id ?? project.id)
  }

  const uncappedNodes = [...rootIds]
    .map((rootId): ProjectListNode | null => {
      const fullRoot = visibleById.get(rootId)
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
  }
}

async function isReadableProject(env: Env, projectId: string, access: ProjectAccess): Promise<boolean> {
  if (access.workspaceAdmin) return true
  if (!access.readableSquadIds?.length) return false
  const edge = await env.DB.prepare(
    `SELECT 1
       FROM project_squad_access psa
      WHERE psa.project_id = ?
        AND psa.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      LIMIT 1`,
  ).bind(projectId, jsonIds(access.readableSquadIds)).first()
  return edge !== null
}

async function loadReadableTasks(
  env: Env,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectTaskRow[]> {
  if (!access.workspaceAdmin && !access.readableSquadIds?.length) return []
  const filter = access.workspaceAdmin
    ? ''
    : ' AND t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const limitParam = access.workspaceAdmin ? '?2' : '?3'
  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.squad_id, s.name AS squad_name, s.department_id
      FROM tasks t
       JOIN squads s ON s.id = t.squad_id
      WHERE t.project_id = ?1${filter}
      ORDER BY t.created_at DESC, t.id
      LIMIT ${limitParam}`,
  ).bind(
    projectId,
    ...(access.workspaceAdmin ? [] : [jsonIds(access.readableSquadIds ?? [])]),
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
): Promise<ProjectSquadRow[]> {
  if (!access.workspaceAdmin && !access.readableSquadIds?.length) return []
  const filter = access.workspaceAdmin
    ? ''
    : ' AND psa.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const limitParam = access.workspaceAdmin ? '?2' : '?3'
  const result = await env.DB.prepare(
    `SELECT psa.project_id, psa.squad_id, psa.access_level, psa.granted_at, s.name AS squad_name
       FROM project_squad_access psa
       JOIN squads s ON s.id = psa.squad_id
      WHERE psa.project_id = ?1${filter}
      ORDER BY psa.squad_id
      LIMIT ${limitParam}`,
  ).bind(
    projectId,
    ...(access.workspaceAdmin ? [] : [jsonIds(access.readableSquadIds ?? [])]),
    MAX_SQUAD_ROWS,
  ).all<ProjectSquadRow>()
  return result.results ?? []
}

async function loadProjectAggregates(
  env: Env,
  projectId: string,
  access: ProjectAccess,
): Promise<ProjectDetailView['aggregates']> {
  const squadFilter = access.workspaceAdmin
    ? ''
    : ' AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
  const flightFilter = access.workspaceAdmin ? '' : readableFlightSql('f', '?2')
  const tenantParam = access.workspaceAdmin ? '?2' : '?3'
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE project_id = ?1${squadFilter}) AS direct_tasks,
       (SELECT COUNT(*) FROM project_squad_access WHERE project_id = ?1${squadFilter}) AS direct_squads,
       (SELECT COUNT(*) FROM flights f
         WHERE f.project_id = ?1 AND f.tenant = ${tenantParam}${flightFilter}) AS direct_flights`,
  ).bind(
    projectId,
    ...(access.workspaceAdmin ? [] : [jsonIds(access.readableSquadIds ?? [])]),
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

  const [aggregates, tasks, squads, parent, activity, evidence] = await Promise.all([
    loadProjectAggregates(env, project.id, access),
    loadReadableTasks(env, project.id, access),
    loadReadableSquads(env, project.id, access),
    project.parent_project_id ? getProject(env, project.parent_project_id) : Promise.resolve(null),
    listProjectActivity(env, { projectId: project.id, readableSquadIds: access.readableSquadIds }),
    listProjectEvidence(env, { projectId: project.id, readableSquadIds: access.readableSquadIds }),
  ])

  return {
    project,
    parent: parent ? safeParent(parent) : null,
    aggregates,
    tasks,
    squads,
    activity,
    evidence,
  }
}

export async function loadProjectWorkContext(
  env: Env,
  auth: AuthContext,
  projectId: string,
): Promise<ProjectWorkContext | null> {
  const [project, access] = await Promise.all([getProject(env, projectId), projectAccess(env, auth)])
  if (!project || !await isReadableProject(env, project.id, access)) return null
  const edges = await env.DB.prepare(
    `SELECT squad_id, access_level
       FROM project_squad_access
      WHERE project_id = ?1
      ORDER BY squad_id`,
  ).bind(project.id).all<{ squad_id: string; access_level: ProjectAccessLevel }>()
  const taskable = access.taskableSquadIds === null ? null : new Set(access.taskableSquadIds)
  return {
    project,
    readableSquadIds: access.readableSquadIds,
    taskableSquadIds: project.status === 'archived' ? [] : (edges.results ?? [])
      .filter((edge) => edge.access_level === 'write' || edge.access_level === 'admin')
      .filter((edge) => taskable === null || taskable.has(edge.squad_id))
      .map((edge) => edge.squad_id),
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
    <div class="ui-table" role="table" aria-label="${opts.label}" aria-colcount="${String(opts.cols.length)}">
      ${head}${rows}
    </div>
  </div>`
}

export function projectsPageBody(view: ProjectsPageView) {
  if (!view.nodes.length) {
    return html`
      ${pageHeader({
        crumbs: 'Workspace / Projects',
        title: 'Projects',
        sub: 'Goals, squads, work, and evidence organized around durable outcomes.',
      })}
      ${emptyState({
        title: 'No projects available',
        detail: 'No project is currently visible to this account.',
        hint: 'No project data is fabricated. Ask a workspace administrator to connect one of your squads.',
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
    ${pageHeader({
      crumbs: 'Workspace / Projects',
      title: 'Projects',
      sub: `${view.visibleProjectCount}${view.capped ? '+' : ''} visible project${view.visibleProjectCount === 1 ? '' : 's'} across root and child levels.`,
    })}
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

function projectTabs() {
  return html`<nav aria-label="Project sections" style="display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px;">
    <a class="btn secondary sm" data-project-tab href="#overview" aria-current="page">Overview</a>
    <a class="btn secondary sm" data-project-tab href="#work">Work</a>
    <a class="btn secondary sm" data-project-tab href="#squads">Squads</a>
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

export function projectDetailBody(view: ProjectDetailView) {
  const { project, parent, aggregates } = view
  const workLinks = html`<span style="display:flex;flex-wrap:wrap;gap:8px;">
    <a class="ui-link" href="/send?project_id=${encodeURIComponent(project.id)}">Project tasks</a>
    <a class="ui-link" href="/flights?project_id=${encodeURIComponent(project.id)}">Project flights</a>
  </span>`

  return html`
    ${pageHeader({
      crumbs: parent ? `Projects / ${parent.name}` : 'Projects',
      title: project.name,
      sub: project.description || 'No description set.',
      badge: project.status,
      badgeTone: statusTone(project.status),
    })}
    ${projectTabs()}
    <section id="overview" aria-label="Overview">
      ${sectionPanel({
        title: 'Overview',
        body: semanticDataTable({
          label: 'Project overview',
          cols: [
            { label: 'Goal', width: '2fr' },
            { label: 'Status', width: 'auto' },
            { label: 'Target date', width: 'auto' },
          ],
          rows: [[
            html`<span>${project.goal || 'No goal set'}</span>`,
            pill(project.status, statusTone(project.status)),
            html`<span class="ui-mono-dim">${project.target_date ?? 'Not set'}</span>`,
          ]],
        }),
      })}
      ${kpiRow([
        statCard({ label: 'Direct tasks', value: String(aggregates.directTasks), sub: 'All work attributed to this project' }),
        statCard({ label: 'Direct flights', value: String(aggregates.directFlights), sub: 'Governed runs attributed here' }),
        statCard({ label: 'Squad edges', value: String(aggregates.directSquads), sub: 'Explicit project access edges' }),
      ])}
    </section>
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
    <section id="squads" aria-label="Squads">
      ${sectionPanel({
        title: 'Squads',
        body: semanticDataTable({
          label: 'Project squads',
          cols: [
            { label: 'Squad', width: '1fr' },
            { label: 'Access', width: 'auto' },
          ],
          rows: view.squads.map((squad) => [
            html`<a class="ui-link" href="/squads/${encodeURIComponent(squad.squad_id)}">${squad.squad_name}</a>`,
            pill(squad.access_level, squad.access_level === 'read' ? 'dim' : 'primary'),
          ]),
          empty: 'No readable squad edges are connected to this project.',
        }),
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
