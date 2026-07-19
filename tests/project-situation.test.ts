import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectSituation } from '../src/projects/situation'
import type { Env, Project, ProjectStatus } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad A'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'pot-a' } as Env
}

function insertProject(harness: SqliteD1Harness, id: string, status: ProjectStatus = 'active'): Project {
  harness.sqlite.prepare(
    'INSERT INTO projects (id, slug, name, status) VALUES (?, ?, ?, ?)',
  ).run(id, id, `Project ${id}`, status)
  harness.sqlite.prepare(`
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
    VALUES (?, 'squad-a', 'write'), (?, 'squad-b', 'write')
  `).run(id, id)
  return harness.sqlite.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id,
            target_date, created_at, updated_at
       FROM projects WHERE id = ?`,
  ).get(id) as unknown as Project
}

function insertTask(
  harness: SqliteD1Harness,
  projectId: string,
  input: {
    id: string
    squadId?: string
    title?: string
    status: 'open' | 'in_progress' | 'blocked' | 'review' | 'done'
    updatedAt?: string
    result?: string | null
    gateOwner?: string | null
  },
): void {
  harness.sqlite.prepare(`
    INSERT INTO tasks (
      id, squad_id, title, status, assignee_agent_id, result, gate_owner,
      project_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.squadId ?? 'squad-a',
    input.title ?? input.id,
    input.status,
    input.squadId === 'squad-b' ? 'agent-b' : 'agent-a',
    input.result ?? null,
    input.gateOwner ?? null,
    projectId,
    input.updatedAt ?? '2026-07-19T01:00:00Z',
    input.updatedAt ?? '2026-07-19T01:00:00Z',
  )
}

function flightMeta(squadIds: string[], taskIds: string[]): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal',
    objective_id: 'objective',
    squad_ids: squadIds,
    task_ids: taskIds,
    done_when: ['Done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  })
}

function insertFlight(
  harness: SqliteD1Harness,
  projectId: string,
  input: { id: string; squadIds: string[]; taskIds: string[]; goal?: string; meta?: string },
): void {
  harness.sqlite.prepare(`
    INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
    VALUES (?, 'pot-a', 'agent-a', ?, 'running', ?, ?, ?)
  `).run(
    input.id,
    input.goal ?? input.id,
    projectId,
    Date.parse('2026-07-19T02:00:00Z'),
    input.meta ?? flightMeta(input.squadIds, input.taskIds),
  )
}

describe('loadProjectSituation', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('derives blocker health while reviewing a pending item first', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'priority')
    insertTask(harness, project.id, {
      id: 'blocked', status: 'blocked', title: 'Restore delivery', result: 'provider_token=hidden-value',
    })
    insertTask(harness, project.id, { id: 'review', status: 'review', title: 'Review release', gateOwner: 'lead' })
    insertTask(harness, project.id, { id: 'working', status: 'in_progress', title: 'Continue rollout' })
    insertTask(harness, project.id, { id: 'open', status: 'open', title: 'Start follow-up' })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'blocked',
      summary: expect.any(String),
      blockers: [{ id: 'blocked', title: 'Restore delivery', status: 'blocked' }],
      pending_reviews: [{ id: 'review', title: 'Review release', status: 'review', gate_owner: 'lead' }],
      active_work_count: 2,
      active_flight_count: 0,
      next_action: { type: 'review_task', task: { id: 'review' } },
    })
    expect(JSON.stringify(situation)).not.toContain('hidden-value')
  })

  it('derives review health when no blocker is readable', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'review-only')
    insertTask(harness, project.id, { id: 'review', status: 'review' })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.health).toBe('review')
    expect(situation.next_action).toMatchObject({ type: 'review_task', task: { id: 'review' } })
  })

  it('continues in-progress work before open work and an active flight', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'active-work')
    insertTask(harness, project.id, { id: 'open', status: 'open' })
    insertTask(harness, project.id, { id: 'working', status: 'in_progress' })
    insertFlight(harness, project.id, { id: 'flight', squadIds: ['squad-a'], taskIds: ['working'] })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'active',
      active_work_count: 2,
      active_flight_count: 1,
      next_action: { type: 'continue_task', task: { id: 'working' } },
    })
    expect(situation.latest_activity).not.toBeNull()
  })

  it('falls through from open work to flight monitoring', async () => {
    harness = makeHarness()
    const openProject = insertProject(harness, 'open-work')
    insertTask(harness, openProject.id, { id: 'open', status: 'open' })
    expect(await loadProjectSituation(envFor(harness), openProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'start_task', task: { id: 'open' } },
    })

    const flightProject = insertProject(harness, 'flight-only')
    insertTask(harness, flightProject.id, { id: 'flight-task', status: 'done' })
    insertFlight(harness, flightProject.id, { id: 'flight', squadIds: ['squad-a'], taskIds: ['flight-task'] })
    expect(await loadProjectSituation(envFor(harness), flightProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'monitor_flight', flight: { id: 'flight' } },
    })
  })

  it.each([
    ['paused', 'paused', 'resume_project'],
    ['completed', 'completed', 'verify_completion'],
    ['archived', 'archived', 'reopen_project'],
  ] as const)('prioritizes %s lifecycle health', async (status, health, action) => {
    harness = makeHarness()
    const activeProject = insertProject(harness, `lifecycle-${status}`)
    const project = { ...activeProject, status }
    insertTask(harness, project.id, { id: `${status}-blocker`, status: 'blocked' })
    harness.sqlite.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, project.id)

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.health).toBe(health)
    expect(situation.next_action?.type).toBe('unblock_task')

    harness.sqlite.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id)
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action?.type).toBe(action)
  })

  it('returns ready for empty projects and creates work only for an active project', async () => {
    harness = makeHarness()
    const active = insertProject(harness, 'empty-active', 'active')
    const planned = insertProject(harness, 'empty-planned', 'planned')

    expect(await loadProjectSituation(envFor(harness), active, null)).toMatchObject({
      health: 'ready',
      blockers: [],
      pending_reviews: [],
      active_work_count: 0,
      active_flight_count: 0,
      latest_activity: null,
      next_action: { type: 'create_task' },
    })
    expect(await loadProjectSituation(envFor(harness), planned, null)).toMatchObject({
      health: 'ready', latest_activity: null, next_action: null,
    })
  })

  it('never derives health, counts, activity, or actions from unreadable squad rows', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'restricted')
    insertTask(harness, project.id, {
      id: 'visible-open', squadId: 'squad-a', status: 'open', updatedAt: '2026-07-19T01:00:00Z',
    })
    insertTask(harness, project.id, {
      id: 'hidden-blocker', squadId: 'squad-b', status: 'blocked', title: 'Private blocker',
      result: 'password=private-value', updatedAt: '2026-07-19T03:00:00Z',
    })
    insertTask(harness, project.id, {
      id: 'hidden-review', squadId: 'squad-b', status: 'review', title: 'Private review',
      updatedAt: '2026-07-19T04:00:00Z',
    })
    insertFlight(harness, project.id, { id: 'visible-flight', squadIds: ['squad-a'], taskIds: ['visible-open'] })
    insertFlight(harness, project.id, { id: 'hidden-flight', squadIds: ['squad-b'], taskIds: ['hidden-blocker'] })
    insertFlight(harness, project.id, {
      id: 'mixed-flight', squadIds: ['squad-a', 'squad-b'], taskIds: ['visible-open', 'hidden-blocker'],
    })
    insertFlight(harness, project.id, {
      id: 'malformed-flight', squadIds: ['squad-a'], taskIds: ['visible-open'], goal: 'Malformed private goal',
      meta: JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }),
    })

    const scoped = await loadProjectSituation(envFor(harness), project, ['squad-a'])
    expect(scoped).toMatchObject({
      health: 'active',
      blockers: [],
      pending_reviews: [],
      active_work_count: 1,
      active_flight_count: 1,
      next_action: { type: 'start_task', task: { id: 'visible-open' } },
    })
    expect(JSON.stringify(scoped)).not.toMatch(/Private blocker|Private review|private-value|hidden-flight|mixed-flight|Malformed private goal/)

    const none = await loadProjectSituation(envFor(harness), project, [])
    expect(none).toMatchObject({
      health: 'ready', blockers: [], pending_reviews: [], active_work_count: 0,
      active_flight_count: 0, latest_activity: null, next_action: { type: 'create_task' },
    })
  })
})
