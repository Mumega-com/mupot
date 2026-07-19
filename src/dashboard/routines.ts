import { html, raw } from 'hono/html'
import type { AuthContext, Env, Project } from '../types'
import { getProject } from '../projects/service'
import { principalCanReadProject, principalCanRunForSquad, routinePrincipal } from '../routines/access'
import { getRoutine, listRoutineRuns, listRoutines, type RoutineCursor } from '../routines/service'
import type { Routine, RoutineRun } from '../routines/types'
import { pageHeader, pill, sectionPanel } from './ui'
import type { Html } from './ui'

const PAGE_LIMIT = 50
const EVENT_PAGE_LIMIT = 50

export interface DashboardCursor {
  timestamp: string
  id: string
}

export interface RoutineEventRow {
  id: string
  run_id: string
  routine_id: string
  routine_name: string
  kind: string
  actor_type: string
  actor_id: string
  occurred_at: string
}

export interface RoutineFormValues {
  name: string
  objective: string
  trigger_kind: string
  run_once_at: string
  cron_expression: string
  timezone: string
  overlap_policy: string
  execution_mode: string
  responsible_squad_id: string
  preferred_agent_id: string
  budget_micro_usd: string
  max_attempts: string
  retry_backoff_seconds: string
  max_occurrences: string
  stop_at: string
}

export interface RoutineWorkspaceView {
  project: Project
  routines: Routine[]
  runs: RoutineRun[]
  runNextCursor: RoutineCursor | null
  events: RoutineEventRow[]
  eventNextCursor: DashboardCursor | null
  routineLabels: Map<string, string>
  agentLabels: Map<string, string>
  canManage: boolean
  runNonces: Map<string, string>
  editRoutine: Routine | null
  formValues: RoutineFormValues
  runTruncated: boolean
  eventTruncated: boolean
}

export interface RoutineWorkspaceOptions {
  runAfter?: RoutineCursor
  eventAfter?: DashboardCursor
  editId?: string
  runLimit?: number
  eventLimit?: number
}

export function parseDashboardCursor(value: string | undefined): DashboardCursor | null | undefined {
  if (value === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0)))) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Record<string, unknown>
    if (candidate.v !== 1 || typeof candidate.t !== 'string' || typeof candidate.i !== 'string') return null
    if (new Date(candidate.t).toISOString() !== candidate.t || !/^[A-Za-z0-9_-]{1,200}$/.test(candidate.i)) return null
    return { timestamp: candidate.t, id: candidate.i }
  } catch {
    return null
  }
}

export function encodeDashboardCursor(cursor: DashboardCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: cursor.timestamp, i: cursor.id }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function routineFormValues(routine?: Routine): RoutineFormValues {
  return {
    name: routine?.name ?? '',
    objective: routine?.objective ?? '',
    trigger_kind: routine?.trigger_kind ?? 'manual',
    run_once_at: routine?.run_once_at ?? '',
    cron_expression: routine?.cron_expression ?? '',
    timezone: routine?.timezone ?? 'UTC',
    overlap_policy: routine?.overlap_policy ?? 'skip',
    execution_mode: routine?.execution_mode ?? 'propose',
    responsible_squad_id: routine?.responsible_squad_id ?? '',
    preferred_agent_id: routine?.preferred_agent_id ?? '',
    budget_micro_usd: String(routine?.budget_micro_usd ?? 0),
    max_attempts: String(routine?.max_attempts ?? 3),
    retry_backoff_seconds: String(routine?.retry_backoff_seconds ?? 300),
    max_occurrences: routine?.max_occurrences === null || routine?.max_occurrences === undefined ? '' : String(routine.max_occurrences),
    stop_at: routine?.stop_at ?? '',
  }
}

export function submittedRoutineFormValues(input: Record<string, unknown>): RoutineFormValues {
  const text = (name: keyof RoutineFormValues) => typeof input[name] === 'string' ? input[name] : ''
  return {
    name: text('name'), objective: text('objective'), trigger_kind: text('trigger_kind'),
    run_once_at: text('run_once_at'), cron_expression: text('cron_expression'), timezone: text('timezone'),
    overlap_policy: text('overlap_policy'), execution_mode: text('execution_mode'),
    responsible_squad_id: text('responsible_squad_id'), preferred_agent_id: text('preferred_agent_id'),
    budget_micro_usd: text('budget_micro_usd'), max_attempts: text('max_attempts'),
    retry_backoff_seconds: text('retry_backoff_seconds'), max_occurrences: text('max_occurrences'), stop_at: text('stop_at'),
  }
}

function numeric(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN
}

export function routineInput(values: RoutineFormValues): Record<string, unknown> {
  return {
    name: values.name, objective: values.objective, trigger_kind: values.trigger_kind,
    run_once_at: values.run_once_at || null, cron_expression: values.cron_expression || null,
    timezone: values.timezone, overlap_policy: values.overlap_policy, execution_mode: values.execution_mode,
    responsible_squad_id: values.responsible_squad_id, preferred_agent_id: values.preferred_agent_id || null,
    budget_micro_usd: numeric(values.budget_micro_usd), max_attempts: numeric(values.max_attempts),
    retry_backoff_seconds: numeric(values.retry_backoff_seconds),
    max_occurrences: values.max_occurrences ? numeric(values.max_occurrences) : null,
    stop_at: values.stop_at || null,
  }
}

function nonceKey(nonce: string): string {
  return `dashboard:routine-run-nonce:${nonce}`
}

interface RunNonceRecord {
  tenant: string
  actor_type: 'member' | 'agent'
  actor_id: string
  routine_id: string
}

/** The form is protected by dashboard CSRF middleware; this separate one-time nonce supplies idempotency. */
export async function mintRoutineRunNonce(env: Env, auth: AuthContext, routineId: string): Promise<string> {
  const principal = routinePrincipal(auth)
  const nonce = crypto.randomUUID()
  const record: RunNonceRecord = {
    tenant: env.TENANT_SLUG,
    actor_type: principal.actor_type,
    actor_id: principal.actor_id,
    routine_id: routineId,
  }
  await env.SESSIONS.put(nonceKey(nonce), JSON.stringify(record), { expirationTtl: 300 })
  return nonce
}

export async function consumeRoutineRunNonce(
  env: Env,
  auth: AuthContext,
  routineId: string,
  nonce: unknown,
): Promise<boolean> {
  if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce)) return false
  const stored = await env.SESSIONS.get<RunNonceRecord>(nonceKey(nonce), 'json')
  await env.SESSIONS.delete(nonceKey(nonce))
  const principal = routinePrincipal(auth)
  return stored?.tenant === env.TENANT_SLUG
    && stored.actor_type === principal.actor_type
    && stored.actor_id === principal.actor_id
    && stored.routine_id === routineId
}

async function loadLabels(env: Env, routines: Routine[]): Promise<{ routineLabels: Map<string, string>; agentLabels: Map<string, string> }> {
  const squadIds = [...new Set(routines.map(routine => routine.responsible_squad_id))]
  const agentIds = [...new Set(routines.flatMap(routine => routine.preferred_agent_id ? [routine.preferred_agent_id] : []))]
  const [squads, agents] = await Promise.all([
    squadIds.length ? env.DB.prepare(`SELECT id, name FROM squads WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`)
      .bind(JSON.stringify(squadIds)).all<{ id: string; name: string }>() : Promise.resolve({ results: [] as Array<{ id: string; name: string }> }),
    agentIds.length ? env.DB.prepare(`SELECT id, name FROM agents WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`)
      .bind(JSON.stringify(agentIds)).all<{ id: string; name: string }>() : Promise.resolve({ results: [] as Array<{ id: string; name: string }> }),
  ])
  return {
    routineLabels: new Map((squads.results ?? []).map(row => [row.id, row.name])),
    agentLabels: new Map((agents.results ?? []).map(row => [row.id, row.name])),
  }
}

async function loadEvents(env: Env, projectId: string, limit: number, after?: DashboardCursor): Promise<{ rows: RoutineEventRow[]; next: DashboardCursor | null }> {
  const predicates = ['e.tenant = ?', 'e.project_id = ?']
  const binds: unknown[] = [env.TENANT_SLUG, projectId]
  if (after) {
    predicates.push('(e.occurred_at < ? OR (e.occurred_at = ? AND e.id > ?))')
    binds.push(after.timestamp, after.timestamp, after.id)
  }
  const result = await env.DB.prepare(
    `SELECT e.id, e.run_id, rr.routine_id, r.name AS routine_name, e.kind, e.actor_type, e.actor_id, e.occurred_at
       FROM routine_run_events e
       JOIN routine_runs rr ON rr.id = e.run_id AND rr.tenant = e.tenant
       JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant
      WHERE ${predicates.join(' AND ')}
      ORDER BY e.occurred_at DESC, e.id ASC LIMIT ?`,
  ).bind(...binds, limit + 1).all<RoutineEventRow>()
  const rows = result.results ?? []
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return { rows: items, next: rows.length > EVENT_PAGE_LIMIT && last ? { timestamp: last.occurred_at, id: last.id } : null }
}

export async function loadRoutineWorkspace(
  env: Env,
  auth: AuthContext,
  projectId: string,
  options: RoutineWorkspaceOptions = {},
): Promise<RoutineWorkspaceView | null> {
  const principal = routinePrincipal(auth)
  if (!await principalCanReadProject(env, principal, projectId)) return null
  const project = await getProject(env, projectId)
  if (!project) return null
  const [routinePage, runPage, eventPage] = await Promise.all([
    listRoutines(env, principal, { project_id: projectId, limit: PAGE_LIMIT }),
    listRoutineRuns(env, principal, { project_id: projectId, limit: options.runLimit ?? PAGE_LIMIT, ...(options.runAfter ? { after: options.runAfter } : {}) }),
    loadEvents(env, projectId, options.eventLimit ?? EVENT_PAGE_LIMIT, options.eventAfter),
  ])
  if (!routinePage.ok || !runPage.ok) return null
  const routines = routinePage.items.filter(routine => routine.status !== 'archived')
  const labels = await loadLabels(env, routines)
  const canManage = principal.actor_type === 'member' && principal.workspace_admin
  const editRoutine = canManage && options.editId ? await getRoutine(env, principal, options.editId) : null
  const allowedEdit = editRoutine?.project_id === projectId ? editRoutine : null
  const runNonces = new Map<string, string>()
  if (principal.actor_type === 'member') {
    for (const routine of routines.filter(routine => routine.status === 'enabled')) {
      if (await principalCanRunForSquad(env, principal, projectId, routine.responsible_squad_id)) {
        runNonces.set(routine.id, await mintRoutineRunNonce(env, auth, routine.id))
      }
    }
  }
  return {
    project, routines, runs: runPage.items, runNextCursor: runPage.next_cursor, events: eventPage.rows,
    eventNextCursor: eventPage.next, ...labels, canManage, runNonces, editRoutine: allowedEdit,
    formValues: routineFormValues(allowedEdit ?? undefined), runTruncated: runPage.next_cursor !== null,
    eventTruncated: eventPage.next !== null,
  }
}

function title(value: string): string {
  return value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function runState(run: RoutineRun): string {
  return run.status === 'waiting' ? `waiting(${run.waiting_reason ?? 'action'})` : title(run.status)
}

function routineTone(status: Routine['status']): 'ok' | 'warn' | 'dim' | 'primary' {
  if (status === 'enabled') return 'ok'
  if (status === 'paused') return 'warn'
  if (status === 'archived') return 'dim'
  return 'primary'
}

function runTone(run: RoutineRun): 'ok' | 'warn' | 'danger' | 'dim' | 'primary' {
  if (run.status === 'succeeded') return 'ok'
  if (run.status === 'failed' || run.status === 'cancelled') return 'danger'
  if (run.status === 'waiting') return 'warn'
  if (run.status === 'skipped') return 'dim'
  return 'primary'
}

function routineNextAction(routine: Routine, run: RoutineRun | undefined): string {
  if (run?.status === 'waiting') return `Address ${run.waiting_reason ?? 'the pending action'}`
  if (run?.status === 'failed') return 'Review failure evidence'
  if (run && !['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status)) return 'Monitor current run'
  if (routine.status === 'draft') return 'Configure and enable'
  if (routine.status === 'paused') return 'Resume when ready'
  if (routine.next_run_at) return 'Monitor next occurrence'
  return 'Run when accountable work is ready'
}

function table(label: string, minWidth: string, columns: Array<{ label: string; width: string }>, rows: Html[][], empty: string): Html {
  const tracks = columns.map(column => column.width).join(' ')
  return html`<div role="region" aria-label="${label}" tabindex="0" style="max-width:100%;overflow-x:auto;">
    <div class="ui-table" role="table" aria-label="${label}" style="min-width:${minWidth};">
      <div class="ui-tr ui-thead" role="row" style="grid-template-columns:${raw(tracks)}">${columns.map(column => html`<div class="ui-th" role="columnheader">${column.label}</div>`)}</div>
      ${rows.length ? rows.map(cells => html`<div class="ui-tr ui-row" role="row" style="grid-template-columns:${raw(tracks)}">${cells.map(cell => html`<div class="ui-td" role="cell" style="overflow-wrap:anywhere;">${cell}</div>`)}</div>`) : html`<div class="ui-table-empty">${empty}</div>`}
    </div>
  </div>`
}

function routineForm(view: RoutineWorkspaceView, error?: string, values = view.formValues): Html {
  if (!view.canManage) return html``
  const edit = view.editRoutine
  const action = edit
    ? `/projects/${encodeURIComponent(view.project.id)}/routines/${encodeURIComponent(edit.id)}`
    : `/projects/${encodeURIComponent(view.project.id)}/routines`
  return html`${sectionPanel({
    title: edit ? `Edit routine: ${edit.name}` : 'Create routine',
    body: html`${error ? html`<p role="alert" style="color:var(--danger,#c0392b);">${error}</p>` : ''}
      <form method="post" action="${action}" style="display:grid;gap:12px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:10px;">
          <label><span class="ui-panel-sub">Name</span><input required name="name" value="${values.name}"></label>
          <label><span class="ui-panel-sub">Responsible squad ID</span><input required name="responsible_squad_id" value="${values.responsible_squad_id}"></label>
          <label><span class="ui-panel-sub">Preferred agent ID</span><input name="preferred_agent_id" value="${values.preferred_agent_id}"></label>
          <label><span class="ui-panel-sub">Trigger</span><select name="trigger_kind"><option value="manual"${values.trigger_kind === 'manual' ? raw(' selected') : raw('')}>Manual</option><option value="once"${values.trigger_kind === 'once' ? raw(' selected') : raw('')}>Once</option><option value="cron"${values.trigger_kind === 'cron' ? raw(' selected') : raw('')}>Cron</option></select></label>
          <label><span class="ui-panel-sub">Run once at (UTC)</span><input name="run_once_at" value="${values.run_once_at}"></label>
          <label><span class="ui-panel-sub">Cron expression</span><input name="cron_expression" value="${values.cron_expression}"></label>
          <label><span class="ui-panel-sub">Timezone</span><input required name="timezone" value="${values.timezone}"></label>
          <label><span class="ui-panel-sub">Mode</span><select name="execution_mode"><option value="propose"${values.execution_mode === 'propose' ? raw(' selected') : raw('')}>Propose</option><option value="execute_internal"${values.execution_mode === 'execute_internal' ? raw(' selected') : raw('')}>Execute internal</option></select></label>
          <label><span class="ui-panel-sub">Overlap</span><select name="overlap_policy"><option value="skip"${values.overlap_policy === 'skip' ? raw(' selected') : raw('')}>Skip</option><option value="queue"${values.overlap_policy === 'queue' ? raw(' selected') : raw('')}>Queue</option></select></label>
          <label><span class="ui-panel-sub">Budget (micro USD)</span><input required inputmode="numeric" name="budget_micro_usd" value="${values.budget_micro_usd}"></label>
          <label><span class="ui-panel-sub">Max attempts</span><input required inputmode="numeric" name="max_attempts" value="${values.max_attempts}"></label>
          <label><span class="ui-panel-sub">Retry backoff seconds</span><input required inputmode="numeric" name="retry_backoff_seconds" value="${values.retry_backoff_seconds}"></label>
          <label><span class="ui-panel-sub">Maximum occurrences</span><input inputmode="numeric" name="max_occurrences" value="${values.max_occurrences}"></label>
          <label><span class="ui-panel-sub">Stop at (UTC)</span><input name="stop_at" value="${values.stop_at}"></label>
        </div>
        <label><span class="ui-panel-sub">Objective</span><textarea required name="objective" rows="3">${values.objective}</textarea></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn" type="submit">${edit ? 'Save routine' : 'Create draft'}</button>${edit ? html`<a class="btn secondary" href="/projects/${encodeURIComponent(view.project.id)}/routines">Cancel edit</a>` : ''}</div>
      </form>`,
  })}`
}

export function routineWorkspaceBody(view: RoutineWorkspaceView, options: { error?: string; values?: RoutineFormValues; status?: string } = {}): Html {
  const latestRunByRoutine = new Map<string, RoutineRun>()
  for (const run of view.runs) if (!latestRunByRoutine.has(run.routine_id)) latestRunByRoutine.set(run.routine_id, run)
  const projectPath = `/projects/${encodeURIComponent(view.project.id)}`
  const routineRows = view.routines.map((routine) => {
    const current = latestRunByRoutine.get(routine.id)
    const nonce = view.runNonces.get(routine.id)
    return [
      html`<span style="display:grid;gap:3px;"><strong>${routine.name}</strong><span class="ui-panel-sub">${routine.trigger_kind} · ${routine.timezone}</span></span>`,
      pill(title(routine.status), routineTone(routine.status)),
      html`<span>${routine.next_run_at ?? 'Not scheduled'}<span class="ui-panel-sub">Previous: ${current?.created_at ?? 'No run yet'}</span></span>`,
      html`<span>${view.routineLabels.get(routine.responsible_squad_id) ?? routine.responsible_squad_id}<span class="ui-panel-sub">${routine.preferred_agent_id ? view.agentLabels.get(routine.preferred_agent_id) ?? routine.preferred_agent_id : 'No preferred agent'}</span></span>`,
      html`<span>${routine.execution_mode.replace('_', ' ')}<span class="ui-panel-sub">${routine.budget_micro_usd} micro USD · retry ${routine.max_attempts}/${routine.retry_backoff_seconds}s · ${routine.overlap_policy}</span></span>`,
      html`<span>${current ? pill(runState(current), runTone(current)) : pill(title(routine.status), routineTone(routine.status))}<span class="ui-panel-sub">${routineNextAction(routine, current)}</span></span>`,
      html`<div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${nonce ? html`<form method="post" action="${projectPath}/routines/${encodeURIComponent(routine.id)}/run"><input type="hidden" name="nonce" value="${nonce}"><button class="btn secondary sm" type="submit">Run now</button></form>` : ''}
        ${view.canManage ? html`<a class="btn secondary sm" href="${projectPath}/routines?edit=${encodeURIComponent(routine.id)}">Edit</a>
          ${routine.status === 'draft' || routine.status === 'paused' ? html`<form method="post" action="${projectPath}/routines/${encodeURIComponent(routine.id)}/enable"><button class="btn secondary sm" type="submit">Enable</button></form>` : ''}
          ${routine.status === 'enabled' ? html`<form method="post" action="${projectPath}/routines/${encodeURIComponent(routine.id)}/pause"><button class="btn secondary sm" type="submit">Pause</button></form>` : ''}
          <form method="post" action="${projectPath}/routines/${encodeURIComponent(routine.id)}/archive"><button class="btn secondary sm" type="submit">Archive</button></form>` : ''}
      </div>`,
    ]
  })
  const runRows = view.runs.map(run => [
    html`<span>${run.created_at}<span class="ui-panel-sub">${run.trigger_kind}</span></span>`,
    html`<a class="ui-link" href="${projectPath}/routines?run_id=${encodeURIComponent(run.id)}">${run.id}</a>`,
    pill(runState(run), runTone(run)),
    html`<span>${run.assigned_agent_id ?? 'Unassigned'}<span class="ui-panel-sub">Attempt ${run.attempt}</span></span>`,
    html`<span>${run.cost_micro_usd} micro USD<span class="ui-panel-sub">${run.result_summary ?? 'No terminal summary'}</span></span>`,
    html`<div style="display:flex;gap:8px;flex-wrap:wrap;"><a class="ui-link" href="${projectPath}#activity">Activity</a><a class="ui-link" href="${projectPath}#evidence">Evidence</a>${view.canManage && !['succeeded', 'failed', 'skipped', 'cancelled'].includes(run.status) ? html`<form method="post" action="${projectPath}/routines/${encodeURIComponent(run.id)}/cancel"><button class="btn secondary sm" type="submit">Cancel</button></form>` : ''}</div>`,
  ])
  const eventRows = view.events.map(event => [
    html`<span>${event.occurred_at}</span>`, html`<a class="ui-link" href="${projectPath}/routines?run_id=${encodeURIComponent(event.run_id)}">${event.routine_name}</a>`,
    html`<span>${title(event.kind)}</span>`, html`<span>${event.actor_type}: ${event.actor_id}</span>`,
    html`<span style="display:flex;gap:8px;"><a class="ui-link" href="${projectPath}#activity">Activity</a><a class="ui-link" href="${projectPath}#evidence">Evidence</a></span>`,
  ])
  const runMore = view.runNextCursor ? `${projectPath}/routines?run_cursor=${encodeURIComponent(encodeDashboardCursor(view.runNextCursor))}` : null
  const eventMore = view.eventNextCursor ? `${projectPath}/routines?event_cursor=${encodeURIComponent(encodeDashboardCursor(view.eventNextCursor))}` : null
  return html`${pageHeader({ crumbs: `Projects / ${view.project.name}`, title: 'Project routines', sub: 'Operational schedules, runs, and retained event history.' })}
    ${options.status ? html`<p role="status" style="color:var(--ok,#16a34a);">${options.status}</p>` : ''}
    ${options.error ? html`<p role="alert" style="color:var(--danger,#c0392b);">${options.error}</p>` : ''}
    <p style="margin:0 0 14px;"><a class="ui-link" href="${projectPath}">Project overview</a></p>
    ${routineForm(view, undefined, options.values)}
    ${sectionPanel({ title: 'Routines', body: table('Project routines', '88rem', [
      { label: 'Routine', width: '1.2fr' }, { label: 'Status', width: 'auto' }, { label: 'Schedule', width: '1.2fr' }, { label: 'Squad / agent', width: '1.1fr' }, { label: 'Policy', width: '1.5fr' }, { label: 'Current state / next action', width: '1.3fr' }, { label: 'Actions', width: 'auto' },
    ], routineRows, 'No Project Routines are configured yet.') })}
    ${sectionPanel({ title: 'Run history', body: html`${table('Routine run history', '72rem', [
      { label: 'When', width: '1fr' }, { label: 'Run', width: '1fr' }, { label: 'State', width: '1fr' }, { label: 'Agent / attempt', width: '1.1fr' }, { label: 'Cost / outcome', width: '1.2fr' }, { label: 'Evidence', width: '1fr' },
    ], runRows, 'No routine runs are recorded for this Project yet.')}${view.runTruncated ? html`<p class="ui-panel-sub">Showing a bounded page of runs. ${runMore ? html`<a class="ui-link" href="${runMore}">Continue runs</a>` : ''}</p>` : ''}` })}
    ${sectionPanel({ title: 'Event history', body: html`${table('Routine event history', '62rem', [
      { label: 'When', width: '1fr' }, { label: 'Routine', width: '1.1fr' }, { label: 'Event', width: '1fr' }, { label: 'Actor', width: '1fr' }, { label: 'Links', width: 'auto' },
    ], eventRows, 'No routine events are recorded for this Project yet.')}${view.eventTruncated ? html`<p class="ui-panel-sub">Showing a bounded page of events. ${eventMore ? html`<a class="ui-link" href="${eventMore}">Continue events</a>` : ''}</p>` : ''}` })}`
}

export function routineDashboardErrorStatus(error: string): 400 | 403 | 404 | 409 {
  if (['project_not_found', 'routine_not_found', 'run_not_found'].includes(error)) return 404
  if (error === 'forbidden') return 403
  if (['receipt_failed', 'invalid_state', 'routine_archived', 'routine_not_enabled', 'schedule_exhausted', 'run_terminal'].includes(error)) return 409
  return 400
}
