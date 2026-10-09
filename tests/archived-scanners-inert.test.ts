// mupot#1780: archived = inert for autonomous perception. The agent's sensorium (what a
// scheduled goal cycle sees as its own open work) must not list archived tasks.
import { describe, expect, it } from 'vitest'
import { buildSensorium } from '../src/agents/sensorium'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Agent, Env } from '../src/types'

function setup() {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s', 'd', 's', 'S');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a', 's', 'a', 'A', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m1', 'M', 'active', 't');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at)
      VALUES ('live', 's', 'live-task', 'b', 'd', 'open', 'a', '2026-01-01T00:00:00Z'),
             ('arch', 's', 'archived-task', 'b', 'd', 'open', 'a', '2026-01-01T00:00:00Z');
    INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
      VALUES ('arch', '2026-02-01T00:00:00Z', 'x', 'm1', 'open');
  `)
  const env = { DB: h.db, TENANT_SLUG: 't' } as unknown as Env
  const agent = { id: 'a', squad_id: 's', name: 'A', role: 'r', autonomy: 'draft', effort: 'standard', created_at: '2026-01-01T00:00:00Z' } as unknown as Agent
  return { h, env, agent }
}

describe('sensorium excludes archived tasks', () => {
  it('counts, overdue, open list and delegations ignore an archived task', async () => {
    const { h, env, agent } = setup()
    const s = await buildSensorium(env, agent, null, { now: '2026-06-01T00:00:00Z' })
    expect(s.schedule.counts.open).toBe(1)
    expect(s.schedule.overdue).toBe(1)
    expect(s.schedule.oldest_open_tasks).toEqual(['live-task'])
    expect(s.delegations.map((d) => d.task_id)).toEqual(['live'])
    h.close()
  })
})
