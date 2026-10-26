import type { AuthContext, BusEvent, Env, Project, ProjectSquadAccess, ProjectStatus } from '../types'
import { hasCapability } from '../auth/capability'
import {
  elevationHint,
  elevationRemedyMessage,
  hasElevatedAction,
  type ElevationGrantRecord,
} from '../auth/elevation'
import { resolveSquadRef } from '../org/resolve'
import { createBus } from '../bus'
import {
  createProject,
  getProject,
  removeProjectSquadAccess,
  updateProject,
  upsertProjectSquadAccess,
} from '../projects/service'
import type { ProjectMutationError } from '../projects/service'
import { projectSelectSql } from '../projects/columns'
import { deployErrorStatus, deployProject } from '../projects/deploy'
import { defaultStartGateDeps, startProject } from '../projects/start-gate'
import { isSquadArchived } from '../hygiene/filters'
import { stripExternalLifecycleFields } from '../projects/lifecycle-input'
import {
  defaultCircuitBreakerDeps,
  proposeProjectRecommit,
  recommitPrincipalFromAuth,
} from '../projects/circuit-breaker'
import {
  callerHasSquadAccessToProject,
  projectReadAccessFromGrants,
  projectVisibilityClause,
  unrestrictedProjectRead,
  type ProjectReadAccess,
} from '../projects/access'
import { resolveReadableSquadIds } from '../projects/readable-squads'
import { loadProjectSituation } from '../projects/situation'
import { resolveVisibleTaskScope } from '../tasks/visibility'
import { setProjectRepo } from '../workspaces/project-repos'
import { listPresence } from '../registry/service'
import { listProjectBindings } from '../projects/providers/bindings'
import { memberOrElevatedAgent, withElevationReceipt } from './elevated-principal'
import { authorizeStructuralWrite, finishDelegatedReceipt } from '../operators/chokepoint'
import { done, fail, memberCanOnSquadAuth, str, type ToolOutcome, type ToolSpec } from './index'
import { filterWikiGraphForCaller } from '../pages/inkwell-adapter'
import { getProjectWikiGraph, WikiClientError, WikiRequestError } from '../projects/wiki-client'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const NUMBER_SCHEMA = { type: 'number' }
const PROJECT_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'paused', 'completed', 'archived']
const MAX_PAGE_SIZE = 100
const MAX_PAGE_OFFSET = 10_000

type ParentContext = Pick<Project, 'id' | 'slug' | 'name' | 'status' | 'parent_project_id'> & {
  parent_context: true
}

type ProjectMutationOperation = 'created' | 'updated' | 'squad_access_set' | 'squad_access_removed'

async function emitProjectMutation(
  env: Env,
  memberId: string,
  operation: ProjectMutationOperation,
  projectId: string,
  extra: { squad_id?: string; status?: ProjectStatus; elevation_grant_id?: string } = {},
): Promise<void> {
  const event: BusEvent<{
    operation: ProjectMutationOperation
    project_id: string
    squad_id?: string
    status?: ProjectStatus
    elevation_grant_id?: string
  }> = {
    type: 'project.mutated',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    actor: { kind: 'member', id: memberId },
    payload: {
      operation,
      project_id: projectId,
      ...(extra.squad_id ? { squad_id: extra.squad_id } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      ...(extra.elevation_grant_id ? { elevation_grant_id: extra.elevation_grant_id } : {}),
    },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch {
    console.error('project MCP audit event failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      operation,
      project_id: projectId,
    })
  }
}

function workspaceAdmin(auth: AuthContext): boolean {
  if (auth.capabilities === undefined) return auth.role === 'owner' || auth.role === 'admin'
  return hasCapability(auth.capabilities, 'org', null, 'admin')
}

// Exported so sibling MCP tool modules (src/mcp/presence.ts — project-scoped presence
// read) reuse the SAME project-visibility primitive instead of re-deriving an authz
// path. readAccess + readableProject stay the one "can this caller read project X"
// chokepoint for the MCP surface.
export function readAccess(auth: AuthContext): ProjectReadAccess {
  return projectReadAccessFromGrants(auth, auth.capabilities ?? [])
}

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
}

async function projectionReadableSquads(
  env: Env,
  access: ProjectReadAccess,
): Promise<string[] | null> {
  if (unrestrictedProjectRead(access)) return null
  return resolveReadableSquadIds(env, access.squadIds, access.departmentIds)
}

export async function readableProject(env: Env, projectId: string, access: ProjectReadAccess): Promise<Project | null> {
  const visibility = projectVisibilityClause(access)
  return env.DB.prepare(
    `SELECT ${projectSelectSql('p')}
       FROM projects p
      WHERE p.id = ? AND ${visibility.sql}`,
  ).bind(projectId, ...visibility.binds).first<Project>()
}

function mutationFailure(error: ProjectMutationError): ToolOutcome {
  if (error === 'project_not_found' || error === 'parent_not_found' || error === 'squad_not_found') {
    return fail(404, error)
  }
  if (error === 'slug_taken' || error === 'receipt_failed' || error === 'invalid_status_transition' || error === 'completion_gate_required' || error === 'start_gate_required') {
    return fail(409, error)
  }
  return fail(400, error)
}

function requireWorkspaceAdmin(auth: AuthContext, toolName?: string): ToolOutcome | null {
  if (workspaceAdmin(auth)) return null
  const hint = toolName ? elevationHint(toolName) : undefined
  return fail(403, 'forbidden', hint ? { need: 'admin', scope: 'org', hint } : { need: 'admin', scope: 'org' })
}

// mupot#1674 — which squad (if any) a newly created project is attached to.
// EXPLICIT squad_id: the caller must already hold member-or-better (write) on
// it, and it may not be a home or archived squad; any failure refuses the whole
// create BEFORE a project row exists. DEFAULT (no squad_id, agent-bound caller):
// the agent's own squad, attached only when the same checks pass — otherwise
// the create proceeds unattached exactly as before (best effort, never a
// refusal the caller did not ask for).
type CreatorSquad = { squadId: string | null } | { refusal: ToolOutcome }

async function resolveCreatorSquad(env: Env, auth: AuthContext, squadArg: unknown): Promise<CreatorSquad> {
  const explicit = squadArg === undefined || squadArg === null ? null : str(squadArg)
  if (squadArg !== undefined && squadArg !== null && !explicit) return { refusal: fail(400, 'invalid_squad_id') }
  let ref = explicit
  if (!ref && auth.boundAgentId) {
    const row = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ? LIMIT 1')
      .bind(auth.boundAgentId).first<{ squad_id: string }>()
    ref = row?.squad_id ?? null
  }
  if (!ref) return { squadId: null }
  const resolved = await resolveSquadRef(env, ref)
  if (!resolved.ok) {
    if (!explicit) return { squadId: null }
    return { refusal: fail(resolved.reason === 'ambiguous' ? 409 : 404, resolved.reason === 'ambiguous' ? 'ambiguous_squad_id' : 'squad_not_found') }
  }
  const squad = resolved.value
  const usable = squad.kind !== 'home' && !(await isSquadArchived(env, squad.id))
  const member = usable && (await memberCanOnSquadAuth(env, auth, squad, 'member'))
  if (member) return { squadId: squad.id }
  if (!explicit) return { squadId: null }
  // Never reveal more than the refusal needs: a squad the caller does not
  // belong to is a plain forbidden, same shape as the other squad gates.
  if (squad.kind === 'home') return { refusal: fail(403, 'home_scope_not_grantable') }
  if (usable === false) return { refusal: fail(409, 'squad_archived') }
  return { refusal: fail(403, 'forbidden', { need: 'member', scope: 'squad' }) }
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
  args: '{ slug: string, name: string, description?: string, goal?: string, status?: "planned"|"active"|"paused"|"completed"|"archived", parent_project_id?: string|null, target_date?: string|null, squad_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
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
    // Workspace admin, OR a live action:workspace_project elevation at ORG scope.
    //
    // Projects in mupot are WORKSPACE objects, not squad objects (the gate is
    // requireWorkspaceAdmin, not a squad check), so the elevation that
    // authorizes creating one is necessarily org-scoped. That is broader than
    // a squad-scoped grant and deliberately so: the approver is choosing the
    // scope, and an org-scoped grant that expires on its own clock is still
    // strictly narrower than the standing workspace admin it replaces.
    // The ONE structural chokepoint: project_create attaches the creator's own squad edge. Not delegable; an agent keeps
    // its pre-W0 lane exactly (workspace admin or the org-scoped action:workspace_project elevation), flag on or off.
    const createGate = await authorizeStructuralWrite(env, auth, 'project_create', {})
    if (createGate.kind === 'refused') return fail(createGate.status, createGate.error, createGate.detail)
    const denied = requireWorkspaceAdmin(auth, 'project_create')
    // createdViaElevationGrant: the elevation_grants.id that authorized this create,
    // when this call ran under a bounded elevation rather than standing
    // workspace admin — null otherwise (stamped alongside created_by_member_id).
    let createdViaElevationGrant: string | undefined
    if (denied) {
      // action:workspace_project, NOT action:project_lifecycle.
      //
      // project_create is workspace-gated, so its elevation must be granted at
      // ORG scope — and hasElevatedAction treats an org-scoped grant as covering
      // every scope. While both tools read one action key, the single grant that
      // let a squad lead make its own project ALSO created squads in departments
      // it had nothing to do with (measured). Splitting the key is what keeps an
      // org-scoped PROJECT grant from being a squad-structure grant: create_squad
      // asks for a different action, so this one cannot answer for it.
      const elevated = await hasElevatedAction(env, auth, 'action:workspace_project', 'org', null, {
        toolName: 'project_create',
        detail: { slug: args.slug },
      })
      if (!elevated.granted) {
        return fail(403, 'forbidden', {
          need: 'admin',
          scope: 'org',
          elevation_denied: elevated.reason,
          remedy: elevationRemedyMessage(elevated.reason),
        })
      }
      createdViaElevationGrant = elevated.grant.id
    }
    // squad_id is NOT a CreateProjectInput field (never request-settable on the
    // REST path); it is validated here and passed as a TS-only opt.
    const creatorSquad = await resolveCreatorSquad(env, auth, args.squad_id)
    if ('refusal' in creatorSquad) return creatorSquad.refusal
    const result = await createProject(env, args, {
      createdByMemberId: auth.memberId ?? undefined,
      createdViaElevationGrant,
      attachSquadId: creatorSquad.squadId ?? undefined,
    })
    if (!result.ok) return mutationFailure(result.error)
    await emitProjectMutation(env, auth.memberId as string, 'created', result.value.id)
    // Report what actually landed: the edge is guarded in SQL on the squad's
    // current state, so it can be absent if the squad was archived mid-call.
    const edge = creatorSquad.squadId
      ? await env.DB.prepare('SELECT squad_id, access_level FROM project_squad_access WHERE project_id = ? AND squad_id = ?')
          .bind(result.value.id, creatorSquad.squadId).first<{ squad_id: string; access_level: string }>()
      : null
    return done({ project: result.value, squad_access: edge ?? null })
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
    const visibility = projectVisibilityClause(access)
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
      `SELECT ${projectSelectSql('p')}
         FROM projects p
        WHERE ${clauses.join(' AND ')}
        ORDER BY p.parent_project_id IS NOT NULL, p.created_at, p.id
        LIMIT ? OFFSET ?`,
    ).bind(...binds, limit + 1, offset).all<Project>()
    const resultRows = rows.results ?? []
    const projects = resultRows.slice(0, limit)
    const ids = new Set(projects.map(project => project.id))
    const parentIds = [...new Set(
      projects
        .map(project => project.parent_project_id)
        .filter((id): id is string => id !== null && !ids.has(id)),
    )]
    let parentContexts: ParentContext[] = []
    if (parentIds.length > 0) {
      const parents = await env.DB.prepare(
        `SELECT id, slug, name, status, parent_project_id
           FROM projects
          WHERE id IN (${parentIds.map(() => '?').join(', ')})
          ORDER BY created_at, id`,
      ).bind(...parentIds).all<Omit<ParentContext, 'parent_context'>>()
      parentContexts = (parents.results ?? []).map(parent => ({ ...parent, parent_context: true }))
    }
    return done({
      projects: [...parentContexts, ...projects],
      next_cursor: nextCursor(offset, limit, resultRows.length),
    })
  },
}

// project_wiki (mupot v0.50 goal item 4) — read a project's rendered wiki
// graph (mumega.com PR #1278's internal wiki service path) so a seat can read
// the wiki via MCP, not just the dashboard. Gated IDENTICALLY to project_get:
// readAccess + readableProject — a caller without project read never reaches
// the upstream Inkwell call at all (mirrors src/dashboard/project-wiki.ts's
// "mupot is the permission authority" discipline on the dashboard surface).
const toolProjectWiki: ToolSpec = {
  name: 'project_wiki',
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
    const access = readAccess(auth)
    const project = await readableProject(env, projectId, access)
    if (!project) return fail(404, 'project_not_found')
    try {
      // Squad-tier pages (and their edges) are dropped for a caller without squad access to the project.
      const wiki = filterWikiGraphForCaller(
        await getProjectWikiGraph(env, project.id),
        await callerHasSquadAccessToProject(env, access, project.id),
      )
      return done({ project_id: project.id, wiki })
    } catch (e) {
      // A well-formed call the upstream rejected as invalid (P2-B) is
      // distinct from the service being unreachable/misconfigured — 502,
      // never the raw upstream body.
      if (e instanceof WikiRequestError) return fail(502, 'wiki_request_rejected')
      if (e instanceof WikiClientError) return fail(503, e.reason)
      throw e
    }
  },
}

// project_list shows slugs, so project_get accepts one too (mupot#1674). id
// first, then slug (slugs are UNIQUE), both through the SAME visibility clause —
// a slug the caller cannot read is the same project_not_found as an unknown one.
async function readableProjectByRef(env: Env, ref: string, access: ProjectReadAccess): Promise<Project | null> {
  const byId = await readableProject(env, ref, access)
  if (byId) return byId
  const visibility = projectVisibilityClause(access)
  return env.DB.prepare(
    `SELECT ${projectSelectSql('p')}
       FROM projects p
      WHERE p.slug = ? AND ${visibility.sql}`,
  ).bind(ref, ...visibility.binds).first<Project>()
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
    const access = readAccess(auth)
    const project = await readableProjectByRef(env, projectId, access)
    if (!project) return fail(404, 'project_not_found')
    const readableSquadIds = await projectionReadableSquads(env, access)
    const taskScope = await resolveVisibleTaskScope(env, auth)
    const situation = await loadProjectSituation(env, project, readableSquadIds, { taskScope })
    return done({ project, situation })
  },
}

// project_context (Port 1.2) — the unified "where is this project" read. project_get
// returns meta + situation (board position); project_context ALSO returns the online
// ROSTER (who is present on the project) and a DATA MAP (where the project's data
// lives). This is what the concierge reads to know its position before dispatching,
// and what any agent reads to align on a project in one call. READ-gated identically
// to project_get (readAccess + readableProject); every composed read is already
// project-scoped, so no new disclosure beyond what project_get / presence_list give a
// project-reader. No new tables — it composes existing readers.
const toolProjectContext: ToolSpec = {
  name: 'project_context',
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
    const access = readAccess(auth)
    const project = await readableProject(env, projectId, access)
    if (!project) return fail(404, 'project_not_found')
    const readableSquadIds = await projectionReadableSquads(env, access)
    const taskScope = await resolveVisibleTaskScope(env, auth)
    const [situation, roster, boardBindings] = await Promise.all([
      loadProjectSituation(env, project, readableSquadIds, { taskScope }),
      listPresence(env, { projectId }),
      listProjectBindings(env, projectId),
    ])
    return done({
      project,
      situation,
      roster,
      data_map: {
        // where the project's board lives externally (github_projects / linear / notion)
        board_bindings: boardBindings,
        // where the project's shared memory lives — query it via project_recall
        memory_scope: `project:${projectId}`,
      },
    })
  },
}

/**
 * An agent-bound caller refused by the workspace-admin gate may change a
 * project's STATUS (and nothing else) under a live action:project_status
 * ORG-scope grant (a squad-scoped grant is refused). Any other
 * field or a missing grant refuses with the gate's own
 * refusal (`denied`), so nothing about the target is revealed.
 */
async function projectStatusElevation(
  auth: AuthContext,
  env: Env,
  args: Record<string, unknown>,
  denied: ToolOutcome,
): Promise<{ ok: true; grant: ElevationGrantRecord } | { ok: false; outcome: ToolOutcome }> {
  const projectId = str(args.project_id)?.trim() ?? null // canonical id: authorized and written as the same value
  const onlyStatus = Object.keys(args).every((key) => key === 'project_id' || key === 'status')
  if (!auth.boundAgentId || !auth.memberId || !projectId || !onlyStatus || str(args.status) === null) return { ok: false, outcome: denied }
  // ORG scope only, like project_create: a squad-scoped grant is a squad admin's
  // approval and must not change the status of a project that squad merely writes to.
  const acting = await memberOrElevatedAgent(auth, env, 'action:project_status', { type: 'org' }, {
    toolName: 'project_update',
    refusalCode: 'forbidden',
    detail: { project_id: projectId, status: args.status },
    recordUsage: false,
  })
  if (!acting.ok) return { ok: false, outcome: acting.outcome }
  if (acting.via !== 'elevation') return { ok: false, outcome: denied }
  return { ok: true, grant: acting.grant }
}

const toolProjectUpdate: ToolSpec = {
  name: 'project_update',
  scope: 'workspace project lifecycle, including archive and restore (an agent holding a live action:project_status elevation grant may change status only)',
  min: 'admin',
  args: '{ project_id: string, slug?: string, name?: string, description?: string, goal?: string, status?: "planned"|"active"|"paused"|"completed"|"archived", parent_project_id?: string|null, target_date?: string|null, add_repo?: string, remove_repo?: string }  // add_repo/remove_repo edit the project\'s repository allow-list (project_repos) and cannot be combined with other fields',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      add_repo: { type: 'string', description: 'A git remote URL (any spelling) to add to this project\'s repository allow-list. Needs write access on the project. Refused when another project already owns the repo.' },
      remove_repo: { type: 'string', description: 'A git remote URL to remove from this project\'s repository allow-list.' },
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
    const denied = requireWorkspaceAdmin(auth, 'project_update')
    // elevationGrant: set only when this call ran under a live
    // action:project_status grant instead of standing workspace admin.
    let elevationGrant: ElevationGrantRecord | undefined
    if (denied) {
      const elevated = await projectStatusElevation(auth, env, args, denied)
      if (!elevated.ok) return elevated.outcome
      elevationGrant = elevated.grant
    }
    const projectId = str(args.project_id)?.trim() ?? null // canonical id, same value the elevation check used
    if (!projectId) return fail(400, 'invalid_project_id')
    const { project_id: _projectId, add_repo: addRepo, remove_repo: removeRepo, ...rawInput } = args
    // Strip internal lifecycle flags even though schema forbids them — class coverage.
    const input = stripExternalLifecycleFields(rawInput as Record<string, unknown>)

    // Repository allow-list edit: a structural write of its own (never rides along with other fields, never elevated).
    if (addRepo !== undefined || removeRepo !== undefined) {
      if (elevationGrant) return denied ?? fail(403, 'forbidden')
      // The structural chokepoint: project_repos is a structural table. Not delegable; an agent-bound caller is refused.
      const repoGate = await authorizeStructuralWrite(env, auth, addRepo !== undefined ? 'project_repo_set' : 'project_repo_remove', {})
      if (repoGate.kind === 'refused') return fail(repoGate.status, repoGate.error, repoGate.detail)
      if ((addRepo !== undefined && removeRepo !== undefined) || Object.keys(input).length > 0) return fail(400, 'repo_edit_standalone')
      const edited = await setProjectRepo(env, auth, {
        project_id: projectId,
        op: addRepo !== undefined ? 'add' : 'remove',
        repo: addRepo !== undefined ? addRepo : removeRepo,
      })
      if (!edited.ok) return fail(edited.status, edited.error)
      await emitProjectMutation(env, auth.memberId as string, 'updated', projectId)
      return done({ project_id: projectId, repo_key: edited.repo_key, changed: edited.changed, project_repos: edited.repos, receipt_id: edited.receipt_id })
    }

    // Slice 3: planned→active must go through start-gate (authorize + provision).
    if (str(input.status) === 'active') {
      const existing = await getProject(env, projectId)
      // The start gate provisions a squad and an agent; an elevated caller may
      // change a status but never trigger that provisioning.
      if (existing?.status === 'planned' && elevationGrant) return denied ?? fail(403, 'forbidden')
      if (existing?.status === 'planned') {
        // planned -> active provisions a department, squad and agent plus an admin edge and grants: a structural side
        // effect. Not delegable (no delegation scope can cover a NEW department); the pre-W0 lane is unchanged.
        const startGate = await authorizeStructuralWrite(env, auth, 'project_start', {})
        if (startGate.kind === 'refused') return fail(startGate.status, startGate.error, startGate.detail)
        const started = await startProject(env, projectId, defaultStartGateDeps(auth.memberId ?? null))
        if (!started.ok) {
          const code = started.error === 'project_not_found' ? 404 : 409
          return fail(code, started.error, { blocked_start: true })
        }
        await emitProjectMutation(env, auth.memberId as string, 'updated', started.project.id, {
          status: started.project.status,
        })
        return done({
          project: started.project,
          start_gate: {
            task_id: started.task_id,
            squad_id: started.squad_id,
            agent_id: started.agent_id,
            resource: started.resource,
          },
        })
      }
    }

    let result: Awaited<ReturnType<typeof updateProject>>
    if (elevationGrant) {
      // Two-phase receipt: pending row first, flipped to applied INSIDE updateProject's
      // own UPDATE batch (atomic with the status write), failed on any refusal.
      const receipted = await withElevationReceipt(
        env, elevationGrant, 'project_update', { project_id: projectId, status: args.status },
        (receiptId) => updateProject(env, projectId, input, { elevationReceiptId: receiptId }),
        (r) => (r.ok ? { applied: true } : { applied: false, code: String(r.error) }),
        { inBatch: true },
      )
      if (!receipted.began) return receipted.outcome
      result = receipted.value
    } else {
      result = await updateProject(env, projectId, input)
    }
    if (!result.ok) return mutationFailure(result.error)
    await emitProjectMutation(env, auth.memberId as string, 'updated', result.value.id, {
      status: result.value.status,
      ...(elevationGrant ? { elevation_grant_id: elevationGrant.id } : {}),
    })
    return done({ project: result.value })
  },
}

const toolProjectRecommit: ToolSpec = {
  name: 'project_recommit',
  scope: 'workspace project cycle recommit (circuit breaker continuation)',
  min: 'admin',
  args: '{ project_id: string, reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    // Principal from bound token only — ignore any forged principal field.
    const principal = recommitPrincipalFromAuth(auth)
    const reason = str(args.reason) || 'operator_recommit'
    const result = await proposeProjectRecommit(
      env,
      projectId,
      principal,
      reason,
      defaultCircuitBreakerDeps().writeReceipt,
    )
    if (!result.ok) {
      const code = result.error === 'project_not_found' ? 404 : 409
      return fail(code, result.error)
    }
    return done({ recommit: result.detail })
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
    const unrestricted = unrestrictedProjectRead(access)
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

// KNOWN GAP, NOT FIXED HERE (FP-01 Slice 2 v2, Athena's design ruling on the
// successor to PR #1488, P2-9 — Athena is filing the tracking issue, not
// this PR): an org admin calling this tool directly against a member's HOME
// squad writes a project_squad_access row with ZERO proposal, ZERO verdict,
// and ZERO project_access_grant_receipts row — project_access_grant_receipts
// is therefore NOT a complete record of every home->project grant, only of
// the ones that went through the routine-proposal chain
// (src/routines/actions.ts's project_access kind ->
// src/projects/service.ts's executeProjectAccessGrant). This bypass is
// INHERITED from #1472's own ruling that project_squad_access is
// deliberately unguarded for a home-squad target — not introduced by this
// PR — but it means the chain's "member builds, human gates, exactly one
// privileged writer" invariant does not hold against THIS tool. Per
// Athena's ruling: a direct org-admin write onto a home is FORBIDDEN by
// policy going forward — elevation with a receipt is the only sanctioned
// path — even though the code does not yet enforce that. Do not widen this
// tool's own gate as a side effect of an unrelated change; the fix belongs
// to whatever closes the tracked issue.
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
    // The ONE structural chokepoint (W0): a bound agent needs a live delegation covering this project (flag on); every
    // other caller keeps the workspace-admin gate below, unchanged.
    const gate = await authorizeStructuralWrite(env, auth, 'project_squad_set', async () => {
      const p = str(args.project_id)
      const q = str(args.squad_id)
      if (!p) return { kind: 'refused' as const, status: 400 as const, error: 'invalid_project_id' }
      if (!q) return { kind: 'refused' as const, status: 400 as const, error: 'invalid_squad_id' }
      const level = args.access_level
      if (level !== 'read' && level !== 'write' && level !== 'admin') {
        return { kind: 'refused' as const, status: 400 as const, error: 'invalid_access_level' }
      }
      return { projectId: p, squadId: q, projectAccessLevel: level }
    })
    if (gate.kind === 'refused') return fail(gate.status, gate.error, gate.detail)
    const denied = gate.kind === 'delegated' ? null : requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    const squadId = str(args.squad_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    if (!squadId) return fail(400, 'invalid_squad_id')
    // mupot#1496 Round 3 (adversarial P1-C): an archived squad cannot be
    // repopulated by granting it project access.
    if (await isSquadArchived(env, squadId)) return fail(409, 'squad_archived')
    const result = await upsertProjectSquadAccess(env, projectId, squadId, args.access_level)
    await finishDelegatedReceipt(env, gate, result.ok)
    if (!result.ok) return mutationFailure(result.error)
    await emitProjectMutation(env, auth.memberId as string, 'squad_access_set', projectId, { squad_id: squadId })
    return done({ squad: result.value })
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
    const gate = await authorizeStructuralWrite(env, auth, 'project_squad_remove', async () => {
      const p = str(args.project_id)
      const q = str(args.squad_id)
      if (!p) return { kind: 'refused' as const, status: 400 as const, error: 'invalid_project_id' }
      if (!q) return { kind: 'refused' as const, status: 400 as const, error: 'invalid_squad_id' }
      return { projectId: p, squadId: q }
    })
    if (gate.kind === 'refused') return fail(gate.status, gate.error, gate.detail)
    const denied = gate.kind === 'delegated' ? null : requireWorkspaceAdmin(auth)
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
    await finishDelegatedReceipt(env, gate, result.ok)
    if (!result.ok) return mutationFailure(result.error)
    await emitProjectMutation(env, auth.memberId as string, 'squad_access_removed', projectId, { squad_id: squadId })
    return done({ project_id: projectId, squad_id: squadId, removed: true })
  },
}

const toolProjectDeploy: ToolSpec = {
  name: 'project_deploy',
  scope: 'workspace project worker deploy',
  min: 'admin',
  args: '{ project_id: string, commit_sha?: string, prompt?: string, canary_receipt?: string, rollback?: string }' +
    ' -- canary_receipt and rollback are REQUIRED when the project is seed-attached (created by seed_attach):' +
    ' canary_receipt is the id of a task in this project gated by gate:canary, approved within the last 24 hours by someone other than the caller;' +
    ' rollback is a non-empty line saying how to undo the deploy. Refusals: canary_receipt_required | canary_receipt_not_found | canary_receipt_wrong_project |' +
    ' canary_receipt_not_canary | canary_receipt_not_passed | canary_receipt_stale | canary_receipt_self_certified | rollback_required (all 409).',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      commit_sha: STRING_SCHEMA,
      prompt: STRING_SCHEMA,
      canary_receipt: STRING_SCHEMA,
      rollback: STRING_SCHEMA,
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const denied = requireWorkspaceAdmin(auth)
    if (denied) return denied
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    const result = await deployProject(env, projectId, auth, {
      commit_sha: args.commit_sha,
      prompt: args.prompt,
      canary_receipt: args.canary_receipt,
      rollback: args.rollback,
    })
    if (!result.ok) return fail(deployErrorStatus(result.error), result.error)
    await emitProjectMutation(env, auth.memberId as string, 'updated', result.project.id, {
      status: result.project.status,
    })
    return done({
      deployment: result.deployment,
      project: result.project,
      flight_id: result.flight_id,
      studio_url: result.studio_url,
    })
  },
}

export const PROJECT_TOOLS: ToolSpec[] = [
  toolProjectCreate,
  toolProjectList,
  toolProjectGet,
  toolProjectContext,
  toolProjectWiki,
  toolProjectUpdate,
  toolProjectRecommit,
  toolProjectDeploy,
  toolProjectSquadList,
  toolProjectSquadSet,
  toolProjectSquadRemove,
]
