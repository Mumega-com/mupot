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
}

export interface SquadOption {
  id: string
  name: string
  dept_name: string | null
}

// ── loadAllAgents ─────────────────────────────────────────────────────────────

/**
 * Load every agent in the pot, joined to squad + department, with aggregate
 * task counts. Uses LEFT JOINs so agents with zero tasks still appear.
 *
 * task_count  — total tasks ever assigned to the agent
 * open_count  — tasks currently open or in_progress (in-flight)
 */
export async function loadAllAgents(env: Env): Promise<AgentAdminRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       a.id            AS id,
       a.slug          AS slug,
       a.name          AS name,
       a.role          AS role,
       a.model         AS model,
       a.status        AS status,
       a.created_at    AS created_at,
       a.squad_id      AS squad_id,
       s.name          AS squad_name,
       d.name          AS dept_name,
       COUNT(t.id)     AS task_count,
       COALESCE(SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS open_count,
       COALESCE(SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS in_flight_count
     FROM agents a
     JOIN squads s ON s.id = a.squad_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN tasks t ON t.assignee_agent_id = a.id
     GROUP BY a.id, a.slug, a.name, a.role, a.model, a.status, a.created_at,
              a.squad_id, s.name, d.name
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
