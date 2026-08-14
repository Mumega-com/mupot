// /dashboard/kanban & /api/kanban/board — Multi-Perspective Squad & Project Kanban.
//
// Projections supported:
//   1. Squad Execution Board: ?squad_id=<uuid> (or ?squad=<slug>)
//      Columns: open -> in_progress -> review -> done (ordered by priority & rank)
//   2. Project Multi-Squad Board: ?project_id=<uuid> (or ?project=<slug>)
//      Swimlanes: Grouped by contributing Squads; Columns: workflow status
//   3. Org Matrix: ?view=matrix
//      Aggregates all accessible squads across the tenant

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { Env, AuthContext, Task, Squad, Project, TaskPriority } from '../types'
import { requireAuth } from '../auth'
import { isOrgAdmin } from '../auth/capability'
import { resolveAccessibleSquadIds } from '../projects/readable-squads'
import { actionableStatusOrderSql, priorityOrderSql } from '../tasks/ranking'

export const kanbanApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

interface KanbanTaskRow extends Task {
  squad_name?: string
  squad_slug?: string
  project_name?: string
  project_slug?: string
  assignee_name?: string
  assignee_slug?: string
}

export interface KanbanBoardData {
  mode: 'squad' | 'project' | 'matrix'
  squad?: Squad | null
  project?: Project | null
  lanes: Array<{
    key: string
    label: string
    tasks: KanbanTaskRow[]
  }>
  swimlanes?: Array<{
    id: string
    label: string
    lanes: Array<{
      key: string
      label: string
      tasks: KanbanTaskRow[]
    }>
  }>
}

const KANBAN_STATUS_LANES = [
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'In Review' },
  { key: 'done', label: 'Completed' },
] as const

// ── API: Load Kanban Data ───────────────────────────────────────────────────

export async function loadKanbanData(
  env: Env,
  auth: AuthContext,
  params: { squadIdOrSlug?: string; projectIdOrSlug?: string; view?: string },
): Promise<KanbanBoardData> {
  const accessibleSquadIds = await resolveAccessibleSquadIds(env, auth)
  const isAllAccessible = isOrgAdmin(auth) || accessibleSquadIds === null

  // Fail-closed for grant-less members
  if (!isAllAccessible && accessibleSquadIds && accessibleSquadIds.length === 0) {
    return { mode: params.projectIdOrSlug ? 'project' : 'squad', squad: null, project: null, lanes: [], swimlanes: [] }
  }

  // 1. Project-Centric View
  if (params.projectIdOrSlug) {
    let project: Project | null = null
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.projectIdOrSlug)
    if (isUuid) {
      project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(params.projectIdOrSlug).first<Project>()
    } else {
      project = await env.DB.prepare('SELECT * FROM projects WHERE slug = ?1').bind(params.projectIdOrSlug).first<Project>()
    }

    if (!project) {
      return { mode: 'project', project: null, lanes: [] }
    }

    // Load tasks for project, strictly filtered to accessible squads
    const squadFilter = isAllAccessible
      ? ''
      : ' AND t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))'
    
    const taskRows = await env.DB.prepare(`
      SELECT 
        t.id, t.squad_id, t.project_id, t.priority, t.parent_task_id,
        t.title, t.body, t.status, t.assignee_agent_id, t.github_issue_url,
        t.result, t.completed_at, t.gate_owner, t.done_when, t.created_at, t.updated_at,
        s.name AS squad_name, s.slug AS squad_slug,
        a.name AS assignee_name, a.slug AS assignee_slug
      FROM tasks t
      JOIN squads s ON t.squad_id = s.id
      LEFT JOIN agents a ON t.assignee_agent_id = a.id
      WHERE t.project_id = ?1${squadFilter}
      ORDER BY s.name ASC, ${actionableStatusOrderSql('t.status')}, ${priorityOrderSql('t.priority')}, t.updated_at DESC
    `).bind(
      project.id,
      ...(isAllAccessible ? [] : [JSON.stringify(accessibleSquadIds ?? [])]),
    ).all<KanbanTaskRow>()

    const tasks = taskRows.results ?? []
    
    // Group into swimlanes by Squad
    const swimlanesMap = new Map<string, { label: string; tasks: KanbanTaskRow[] }>()
    for (const t of tasks) {
      const sKey = t.squad_id
      const sLabel = t.squad_name || 'Squad'
      if (!swimlanesMap.has(sKey)) {
        swimlanesMap.set(sKey, { label: sLabel, tasks: [] })
      }
      swimlanesMap.get(sKey)!.tasks.push(t)
    }

    const swimlanes = Array.from(swimlanesMap.entries()).map(([sId, { label, tasks: sTasks }]) => {
      const byLane = new Map<string, KanbanTaskRow[]>()
      for (const lane of KANBAN_STATUS_LANES) byLane.set(lane.key, [])
      for (const t of sTasks) {
        const laneKey = t.status === 'blocked' ? 'in_progress' : t.status === 'approved' || t.status === 'rejected' ? 'review' : t.status
        const l = byLane.get(laneKey)
        if (l) l.push(t)
      }
      return {
        id: sId,
        label,
        lanes: KANBAN_STATUS_LANES.map(lane => ({
          key: lane.key,
          label: lane.label,
          tasks: byLane.get(lane.key) ?? []
        }))
      }
    })

    return {
      mode: 'project',
      project,
      lanes: [],
      swimlanes,
    }
  }

  // 2. Squad-Centric View (Default / Targeted Squad)
  let targetSquadId: string | null = null
  let targetSquad: Squad | null = null

  if (params.squadIdOrSlug) {
    targetSquad = await env.DB.prepare('SELECT * FROM squads WHERE id = ?1 OR slug = ?1').bind(params.squadIdOrSlug).first<Squad>()
    if (targetSquad) {
      // Enforce Squad-scope authorization
      if (!isAllAccessible && (!accessibleSquadIds || !accessibleSquadIds.includes(targetSquad.id))) {
        return { mode: 'squad', squad: null, lanes: [] }
      }
      targetSquadId = targetSquad.id
    }
  } else if (!isAllAccessible && accessibleSquadIds && accessibleSquadIds.length > 0) {
    targetSquadId = accessibleSquadIds[0]
    targetSquad = await env.DB.prepare('SELECT * FROM squads WHERE id = ?1').bind(targetSquadId).first<Squad>()
  } else if (isAllAccessible) {
    // Only org admins may default to the first squad in DB
    targetSquad = await env.DB.prepare('SELECT * FROM squads ORDER BY created_at ASC LIMIT 1').first<Squad>()
    if (targetSquad) targetSquadId = targetSquad.id
  }

  if (!targetSquadId || !targetSquad) {
    return { mode: 'squad', squad: null, lanes: [] }
  }

  const taskRows = await env.DB.prepare(`
    SELECT 
      t.id, t.squad_id, t.project_id, t.priority, t.parent_task_id,
      t.title, t.body, t.status, t.assignee_agent_id, t.github_issue_url,
      t.result, t.completed_at, t.gate_owner, t.done_when, t.created_at, t.updated_at,
      p.name AS project_name, p.slug AS project_slug,
      a.name AS assignee_name, a.slug AS assignee_slug
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN agents a ON t.assignee_agent_id = a.id
    WHERE t.squad_id = ?1
    ORDER BY ${actionableStatusOrderSql('t.status')}, ${priorityOrderSql('t.priority')}, t.updated_at DESC
  `).bind(targetSquadId).all<KanbanTaskRow>()

  const tasks = taskRows.results ?? []
  const byLane = new Map<string, KanbanTaskRow[]>()
  for (const lane of KANBAN_STATUS_LANES) byLane.set(lane.key, [])

  for (const t of tasks) {
    const laneKey = t.status === 'blocked' ? 'in_progress' : t.status === 'approved' || t.status === 'rejected' ? 'review' : t.status
    const l = byLane.get(laneKey)
    if (l) l.push(t)
  }

  return {
    mode: 'squad',
    squad: targetSquad,
    lanes: KANBAN_STATUS_LANES.map(lane => ({
      key: lane.key,
      label: lane.label,
      tasks: byLane.get(lane.key) ?? []
    })),
  }
}

// ── API Route ───────────────────────────────────────────────────────────────

kanbanApp.get('/api/kanban/board', requireAuth, async (c) => {
  const squad = c.req.query('squad') || c.req.query('squad_id')
  const project = c.req.query('project') || c.req.query('project_id')
  const view = c.req.query('view')

  const data = await loadKanbanData(c.env, c.get('auth'), {
    squadIdOrSlug: squad,
    projectIdOrSlug: project,
    view,
  })

  return c.json({ ok: true, ...data })
})

// ── HTML Views ──────────────────────────────────────────────────────────────

function priorityBadgeHtml(priority: TaskPriority | null) {
  if (!priority) return html`<span class="k-priority k-p-none">Untriaged</span>`
  const cls = priority === 'P0' ? 'k-p0' : priority === 'P1' ? 'k-p1' : priority === 'P2' ? 'k-p2' : 'k-p3'
  return html`<span class="k-priority ${cls}">${priority}</span>`
}

function taskCardHtml(t: KanbanTaskRow) {
  const assignee = t.assignee_name || (t.assignee_agent_id ? 'Assigned' : 'Unassigned')
  const projectBadge = t.project_name ? html`<span class="k-proj-chip">${t.project_name}</span>` : html``
  const gateBadge = t.gate_owner ? html`<span class="k-gate-chip">${t.gate_owner}</span>` : html``
  const ghLink = t.github_issue_url ? html`<a href="${t.github_issue_url}" target="_blank" class="k-gh-link">GH#</a>` : html``

  return html`
    <div class="k-card" data-task-id="${t.id}">
      <div class="k-card-top">
        ${priorityBadgeHtml(t.priority)}
        ${projectBadge}
        ${ghLink}
      </div>
      <div class="k-card-title">${t.title}</div>
      <div class="k-card-bottom">
        <div class="k-assignee">${assignee}</div>
        ${gateBadge}
      </div>
    </div>
  `
}

export function kanbanBoardBody(data: KanbanBoardData, squads: Squad[], projects: Project[]) {
  const isProjectMode = data.mode === 'project' && data.project

  return html`
    <div class="kanban-container">
      <div class="kanban-controls">
        <div class="kanban-selectors">
          <label>Perspective:
            <select onchange="location.href = this.value">
              <optgroup label="Squad Boards">
                ${squads.map(s => html`<option value="/dashboard/kanban?squad=${s.slug}" ${data.squad?.id === s.id ? 'selected' : ''}>Squad: ${s.name}</option>`)}
              </optgroup>
              <optgroup label="Project Multi-Squad Boards">
                ${projects.map(p => html`<option value="/dashboard/kanban?project=${p.slug}" ${data.project?.id === p.id ? 'selected' : ''}>Project: ${p.name}</option>`)}
              </optgroup>
            </select>
          </label>
        </div>
        <div class="kanban-meta-summary">
          ${isProjectMode ? html`<strong>Project Goal:</strong> ${data.project?.goal || 'No goal set'}` : html`<strong>Squad Charter:</strong> ${data.squad?.charter || 'Active execution squad'}`}
        </div>
      </div>

      ${isProjectMode ? html`
        <div class="kanban-swimlanes">
          ${(data.swimlanes ?? []).map(sw => html`
            <div class="kanban-swimlane">
              <div class="swimlane-header">
                <span class="swimlane-title">👥 Contributing Squad: <strong>${sw.label}</strong></span>
              </div>
              <div class="kanban-columns">
                ${sw.lanes.map(lane => html`
                  <div class="k-column">
                    <div class="k-col-head">
                      <span>${lane.label}</span>
                      <span class="k-count">${lane.tasks.length}</span>
                    </div>
                    <div class="k-col-body">
                      ${lane.tasks.length === 0 ? html`<div class="k-empty">No tasks</div>` : lane.tasks.map(t => taskCardHtml(t))}
                    </div>
                  </div>
                `)}
              </div>
            </div>
          `)}
        </div>
      ` : html`
        <div class="kanban-columns">
          ${data.lanes.map(lane => html`
            <div class="k-column">
              <div class="k-col-head">
                <span>${lane.label}</span>
                <span class="k-count">${lane.tasks.length}</span>
              </div>
              <div class="k-col-body">
                ${lane.tasks.length === 0 ? html`<div class="k-empty">No tasks</div>` : lane.tasks.map(t => taskCardHtml(t))}
              </div>
            </div>
          `)}
        </div>
      `}
    </div>

    <style>
      .kanban-container { padding: 16px 0; }
      .kanban-controls { display: flex; justify-content: space-between; align-items: center; background: var(--surface); padding: 12px 18px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; }
      .kanban-selectors select { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-family: var(--font-body); }
      .kanban-meta-summary { font-size: 0.9rem; color: var(--muted); }
      .kanban-columns { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; align-items: start; }
      .k-column { background: var(--surface2, #1c2230); border: 1px solid var(--border); border-radius: var(--radius); min-height: 480px; display: flex; flex-direction: column; }
      .k-col-head { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 0.95rem; }
      .k-count { background: var(--border); padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; color: var(--text2); }
      .k-col-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
      .k-empty { text-align: center; color: var(--muted); font-size: 0.85rem; padding: 40px 0; }
      .k-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; flex-direction: column; gap: 8px; }
      .k-card-top { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .k-card-title { font-weight: 500; font-size: 0.92rem; color: var(--text); line-height: 1.4; }
      .k-card-bottom { display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
      .k-priority { font-size: 0.72rem; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
      .k-p0 { background: #ef4444; color: white; }
      .k-p1 { background: #f97316; color: white; }
      .k-p2 { background: #eab308; color: black; }
      .k-p3 { background: #3b82f6; color: white; }
      .k-p-none { background: var(--border); color: var(--muted); }
      .k-proj-chip { background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary); font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
      .k-gate-chip { background: color-mix(in srgb, var(--accent2) 15%, transparent); color: var(--accent2); font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
      .k-gh-link { font-size: 0.75rem; color: var(--primary); text-decoration: none; margin-left: auto; }
      .kanban-swimlane { margin-bottom: 24px; }
      .swimlane-header { background: var(--surface); padding: 10px 16px; border: 1px solid var(--border); border-bottom: none; border-radius: var(--radius) var(--radius) 0 0; }
      .swimlane-title { font-size: 1rem; color: var(--text); }
      @media (max-width: 900px) { .kanban-columns { grid-template-columns: 1fr; } }
    </style>
  `
}
