// dashboard/agents-admin.ts — data layer for the /agents management page.
//
// All reads are pure D1 queries with no side-effects; every function is
// independently testable via a D1 mock (same pattern as approvals.ts).
//
// loadAllAgents — every agent across all squads, with squad name, department
//   name, status, role, model, and task counts. Ordered squad → name.
// loadSquadOptions — flat squad list for the add-agent <select> picker.

import type { Env } from '../types'

// ── Row shapes (what D1 returns; narrower than the full Agent type) ───────────

export interface AgentAdminRow {
  id: string
  slug: string
  name: string
  role: string
  model: string
  status: 'active' | 'paused'
  created_at: string
  squad_id: string
  squad_name: string
  dept_name: string | null
  task_count: number
  open_count: number
  in_flight_count: number
  // work-unit config fields (0009_work_unit.sql) — read alongside identity so
  // the card renderer can display OKR/KPI/effort/autonomy/budget in one query.
  okr: string | null
  kpi_target: string | null
  kpi_progress: number
  effort: string   // Effort — kept as string here; type guards live in types.ts
  autonomy: string // Autonomy — same
  budget_cap_cents: number | null
  budget_window: string // BudgetWindow
  // current-work: most recent in_progress or open task assigned to this agent.
  // LEFT JOIN pulls one row (MIN id tiebreak); null when the agent has no tasks.
  current_task_title: string | null
  // next-approval: most recent task this agent owns that is in 'review' status.
  // null when there is nothing pending approval from this agent.
  review_task_title: string | null
}

export interface SquadOption {
  id: string
  name: string
  dept_name: string | null
}

// ── loadAllAgents ─────────────────────────────────────────────────────────────

/**
 * Load every agent in the pot, joined to squad + department, with aggregate
 * task counts and the agent's current-work + next-approval task titles.
 *
 * task_count        — total tasks ever assigned to the agent
 * open_count        — tasks currently open or in_progress (in-flight)
 * current_task_title — title of the most-recent in_progress or open task
 * review_task_title  — title of the most-recent task in 'review' status
 *
 * Both title fields are derived via correlated subqueries rather than extra
 * JOINs so the GROUP BY stays simple and the whole load remains a single round-trip.
 */
export async function loadAllAgents(env: Env): Promise<AgentAdminRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       a.id               AS id,
       a.slug             AS slug,
       a.name             AS name,
       a.role             AS role,
       a.model            AS model,
       a.status           AS status,
       a.created_at       AS created_at,
       a.squad_id         AS squad_id,
       s.name             AS squad_name,
       d.name             AS dept_name,
       a.okr              AS okr,
       a.kpi_target       AS kpi_target,
       a.kpi_progress     AS kpi_progress,
       a.effort           AS effort,
       a.autonomy         AS autonomy,
       a.budget_cap_cents AS budget_cap_cents,
       a.budget_window    AS budget_window,
       COUNT(t.id)        AS task_count,
       COALESCE(SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS open_count,
       COALESCE(SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS in_flight_count,
       (SELECT title FROM tasks
          WHERE assignee_agent_id = a.id
            AND status IN ('in_progress','open')
          ORDER BY updated_at DESC
          LIMIT 1) AS current_task_title,
       (SELECT title FROM tasks
          WHERE assignee_agent_id = a.id
            AND status = 'review'
          ORDER BY updated_at DESC
          LIMIT 1) AS review_task_title
     FROM agents a
     JOIN squads s ON s.id = a.squad_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN tasks t ON t.assignee_agent_id = a.id
     GROUP BY a.id, a.slug, a.name, a.role, a.model, a.status, a.created_at,
              a.squad_id, s.name, d.name,
              a.okr, a.kpi_target, a.kpi_progress, a.effort, a.autonomy,
              a.budget_cap_cents, a.budget_window
     ORDER BY s.name ASC, a.name ASC`,
  ).all<AgentAdminRow>()
  return rows.results ?? []
}

// ── loadSquadOptions ──────────────────────────────────────────────────────────

/**
 * Flat squad list for the add-agent form picker, each carrying the parent
 * department name so the <option> label can read "Dept / Squad".
 */
export async function loadSquadOptions(env: Env): Promise<SquadOption[]> {
  const rows = await env.DB.prepare(
    `SELECT s.id AS id, s.name AS name, d.name AS dept_name
       FROM squads s
       LEFT JOIN departments d ON d.id = s.department_id
      ORDER BY d.name ASC, s.name ASC`,
  ).all<SquadOption>()
  return rows.results ?? []
}
