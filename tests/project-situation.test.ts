import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadProjectSituation,
  projectSituationFactFor,
} from '../src/projects/situation'
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
    sourcePot?: string | null
  },
): void {
  harness.sqlite.prepare(`
    INSERT INTO tasks (
      id, squad_id, title, status, assignee_agent_id, result, gate_owner,
      project_id, source_pot, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.squadId ?? 'squad-a',
    input.title ?? input.id,
    input.status,
    input.squadId === 'squad-b' ? 'agent-b' : 'agent-a',
    input.result ?? null,
    input.gateOwner ?? null,
    projectId,
    input.sourcePot ?? null,
    input.updatedAt ?? '2026-07-19T01:00:00Z',
    input.updatedAt ?? '2026-07-19T01:00:00Z',
  )
}

function insertProjectLink(
  harness: SqliteD1Harness,
  projectId: string,
  input: {
    id: string
    remotePot: string
    remoteProjectId?: string
    remoteAgentId?: string
    state?: 'active' | 'revoked'
    staleAfterSeconds?: number
    lastSuccessAt?: string | null
    lastFailureAt?: string | null
  },
): void {
  harness.sqlite.prepare(`
    INSERT INTO project_links (
      id, tenant, local_project_id, local_squad_id, local_agent_id, local_key_id,
      remote_pot, remote_project_id, remote_link_id, remote_agent_id, remote_key_id,
      remote_public_key, remote_base_url, capabilities_json, evidence_origins_json,
      state, stale_after_seconds, last_success_at, last_failure_at, created_by, created_at
    ) VALUES (
      ?, 'pot-a', ?, 'squad-a', 'agent-a', 'local-key',
      ?, ?, 'remote-link', ?, 'remote-key',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'https://remote.example/',
      '["project.task.write"]', '[]',
      ?, ?, ?, ?, 'mbr-a', '2026-07-19T00:00:00Z'
    )
  `).run(
    input.id,
    projectId,
    input.remotePot,
    input.remoteProjectId ?? 'remote-project',
    input.remoteAgentId ?? 'remote-agent',
    input.state ?? 'active',
    input.staleAfterSeconds ?? 30,
    input.lastSuccessAt === undefined ? null : input.lastSuccessAt,
    input.lastFailureAt === undefined ? null : input.lastFailureAt,
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
      task_counts: { blocked: 1, review: 1, in_progress: 1, open: 1 },
      task_counts_truncated: {
        blocked: false, review: false, in_progress: false, open: false, overall: false,
      },
      active_work_count: 4,
      active_work_count_truncated: false,
      active_flight_count: 0,
      active_flight_count_truncated: false,
      blocker_details_truncated: false,
      pending_review_details_truncated: false,
      snapshot_truncated: false,
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
    expect(situation.active_work_count).toBe(1)
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

  it('ignores a malformed newest flight when deriving latest_activity for an unrestricted reader', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'canonical-activity')
    insertTask(harness, project.id, {
      id: 'canonical-task', status: 'done', updatedAt: '2026-07-19T01:00:00Z',
    })
    insertFlight(harness, project.id, {
      id: 'canonical-flight', squadIds: ['squad-a'], taskIds: ['canonical-task'],
    })
    harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      VALUES ('malformed-newest', 'pot-a', 'agent-a', 'Malformed newest', 'running', ?, ?, ?)
    `).run(
      project.id,
      Date.parse('2026-07-19T03:00:00Z'),
      JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }),
    )

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.latest_activity).toMatchObject({
      source_type: 'flight', source_id: 'canonical-flight',
    })
    expect(JSON.stringify(situation)).not.toContain('Malformed newest')
  })

  it('uses isolated health and action precedence for review, unblock, start, and lifecycle fallback', async () => {
    harness = makeHarness()

    const reviewProject = insertProject(harness, 'precedence-review')
    insertTask(harness, reviewProject.id, { id: 'review', status: 'review' })
    insertTask(harness, reviewProject.id, { id: 'review-working', status: 'in_progress' })
    expect(await loadProjectSituation(envFor(harness), reviewProject, null)).toMatchObject({
      health: 'review', next_action: { type: 'review_task', task: { id: 'review' } },
    })

    const blockedProject = insertProject(harness, 'precedence-blocked')
    insertTask(harness, blockedProject.id, { id: 'blocker', status: 'blocked' })
    insertTask(harness, blockedProject.id, { id: 'blocked-working', status: 'in_progress' })
    expect(await loadProjectSituation(envFor(harness), blockedProject, null)).toMatchObject({
      health: 'blocked', next_action: { type: 'unblock_task', task: { id: 'blocker' } },
    })

    const startProject = insertProject(harness, 'precedence-start')
    insertTask(harness, startProject.id, { id: 'start-open', status: 'open' })
    insertFlight(harness, startProject.id, {
      id: 'start-flight', squadIds: ['squad-a'], taskIds: ['start-open'],
    })
    expect(await loadProjectSituation(envFor(harness), startProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'start_task', task: { id: 'start-open' } },
    })

    const pausedProject = insertProject(harness, 'precedence-paused')
    insertTask(harness, pausedProject.id, { id: 'paused-working', status: 'in_progress' })
    harness.sqlite.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(pausedProject.id)
    const paused = { ...pausedProject, status: 'paused' as const }
    expect(await loadProjectSituation(envFor(harness), paused, null)).toMatchObject({
      health: 'paused', next_action: { type: 'continue_task', task: { id: 'paused-working' } },
    })
    harness.sqlite.prepare('DELETE FROM tasks WHERE project_id = ?').run(paused.id)
    expect(await loadProjectSituation(envFor(harness), paused, null)).toMatchObject({
      health: 'paused', next_action: { type: 'resume_project' },
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
      active_work_count_truncated: false,
      active_flight_count: 0,
      active_flight_count_truncated: false,
      blocker_details_truncated: false,
      pending_review_details_truncated: false,
      snapshot_truncated: false,
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

  it('caps each task status and active-flight snapshot with explicit truncation truth', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'capped')
    for (const status of ['blocked', 'review', 'in_progress', 'open'] as const) {
      harness.sqlite.exec(`
        WITH RECURSIVE seq(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
        )
        INSERT INTO tasks (id, squad_id, title, status, project_id, created_at, updated_at)
        SELECT '${status}-' || printf('%03d', n), 'squad-a', '${status} ' || n, '${status}', '${project.id}',
               '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
          FROM seq;
      `)
    }
    insertTask(harness, project.id, { id: 'flight-task', status: 'done' })
    const insert = harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      VALUES (?, 'pot-a', 'agent-a', ?, 'running', ?, ?, ?)
    `)
    for (let index = 0; index < 101; index += 1) {
      insert.run(
        `flight-${index.toString().padStart(3, '0')}`,
        `Flight ${index}`,
        project.id,
        Date.parse('2026-07-19T02:00:00Z') + index,
        flightMeta(['squad-a'], ['flight-task']),
      )
    }

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'blocked',
      task_counts: { blocked: 100, review: 100, in_progress: 100, open: 100 },
      task_counts_truncated: {
        blocked: true, review: true, in_progress: true, open: true, overall: true,
      },
      active_work_count: 400,
      active_work_count_truncated: true,
      active_flight_count: 100,
      active_flight_count_truncated: true,
      blocker_details_truncated: true,
      pending_review_details_truncated: true,
      snapshot_truncated: true,
      next_action: { type: 'review_task', task: { id: 'review-000' } },
    })
    expect(situation.blockers).toHaveLength(20)
    expect(situation.pending_reviews).toHaveLength(20)
  })

  it('reports detail truncation at 21 rows without marking exact counts as truncated', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'detail-capped')
    for (const status of ['blocked', 'review'] as const) {
      harness.sqlite.exec(`
        WITH RECURSIVE seq(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 20
        )
        INSERT INTO tasks (id, squad_id, title, status, project_id, created_at, updated_at)
        SELECT 'detail-${status}-' || printf('%02d', n), 'squad-a', '${status} ' || n, '${status}', '${project.id}',
               '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
          FROM seq;
      `)
    }

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      task_counts: { blocked: 21, review: 21, in_progress: 0, open: 0 },
      task_counts_truncated: {
        blocked: false, review: false, in_progress: false, open: false, overall: false,
      },
      active_work_count: 42,
      active_work_count_truncated: false,
      blocker_details_truncated: true,
      pending_review_details_truncated: true,
      snapshot_truncated: true,
    })
    expect(situation.blockers).toHaveLength(20)
    expect(situation.pending_reviews).toHaveLength(20)
  })
})

describe('projectSituationFactFor', () => {
  it('labels local, current remote, stale remote, and unknown without inference', () => {
    const health = new Map([
      ['dme', 'healthy' as const],
      ['partner', 'stale' as const],
      ['failed-pot', 'failed' as const],
      ['revoked-pot', 'revoked' as const],
    ])
    expect(projectSituationFactFor(null, health)).toEqual({ kind: 'local', source_pot: null })
    expect(projectSituationFactFor('dme', health)).toEqual({ kind: 'current_remote', source_pot: 'dme' })
    expect(projectSituationFactFor('partner', health)).toEqual({ kind: 'stale_remote', source_pot: 'partner' })
    expect(projectSituationFactFor('failed-pot', health)).toEqual({ kind: 'stale_remote', source_pot: 'failed-pot' })
    expect(projectSituationFactFor('revoked-pot', health)).toEqual({ kind: 'stale_remote', source_pot: 'revoked-pot' })
    expect(projectSituationFactFor('missing', health)).toEqual({ kind: 'unknown', source_pot: 'missing' })
  })
})

describe('loadProjectSituation linked-pot facts', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('distinguishes local, current remote, stale remote, and unknown task facts', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'linked-facts')
    insertProjectLink(harness, project.id, {
      id: 'link-healthy',
      remotePot: 'dme',
      lastSuccessAt: '2026-07-19T10:00:00Z',
      staleAfterSeconds: 30,
    })
    insertProjectLink(harness, project.id, {
      id: 'link-stale',
      remotePot: 'partner',
      remoteProjectId: 'partner-project',
      remoteAgentId: 'partner-agent',
      lastSuccessAt: '2026-07-19T09:00:00Z',
      staleAfterSeconds: 30,
    })
    insertTask(harness, project.id, { id: 'local-open', status: 'open' })
    insertTask(harness, project.id, {
      id: 'remote-current', status: 'blocked', title: 'Current remote blocker',
      sourcePot: 'dme', result: 'waiting on dme',
    })
    insertTask(harness, project.id, {
      id: 'remote-stale', status: 'in_progress', title: 'Stale remote work',
      sourcePot: 'partner',
    })
    insertTask(harness, project.id, {
      id: 'remote-unknown', status: 'review', title: 'Orphan remote review',
      sourcePot: 'ghost-pot', gateOwner: 'lead',
    })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T10:00:10Z'))
    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.linked_pots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        link_id: 'link-healthy',
        source_pot: 'dme',
        health: 'healthy',
        last_synchronized_at: '2026-07-19T10:00:00Z',
        agent_presence: 'unknown',
      }),
      expect.objectContaining({
        link_id: 'link-stale',
        source_pot: 'partner',
        health: 'stale',
        last_synchronized_at: '2026-07-19T09:00:00Z',
        agent_presence: 'unknown',
      }),
    ]))
    expect(situation.blockers).toEqual([
      expect.objectContaining({
        id: 'remote-current',
        fact: { kind: 'current_remote', source_pot: 'dme' },
      }),
    ])
    expect(situation.pending_reviews).toEqual([
      expect.objectContaining({
        id: 'remote-unknown',
        fact: { kind: 'unknown', source_pot: 'ghost-pot' },
      }),
    ])
    expect(situation.remote_tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote-current',
        fact: { kind: 'current_remote', source_pot: 'dme' },
      }),
      expect.objectContaining({
        id: 'remote-stale',
        fact: { kind: 'stale_remote', source_pot: 'partner' },
      }),
      expect.objectContaining({
        id: 'remote-unknown',
        fact: { kind: 'unknown', source_pot: 'ghost-pot' },
      }),
    ]))
    expect(situation.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: 'agent-a',
        fact: { kind: 'local', source_pot: null },
      }),
      expect.objectContaining({
        agent_id: 'remote-agent',
        presence: 'unknown',
        fact: { kind: 'current_remote', source_pot: 'dme' },
      }),
      expect.objectContaining({
        agent_id: 'partner-agent',
        presence: 'unknown',
        fact: { kind: 'stale_remote', source_pot: 'partner' },
      }),
    ]))
    expect(situation.linked_pots.find((link) => link.health === 'healthy')?.last_synchronized_at)
      .toBe('2026-07-19T10:00:00Z')
    // Never invent sync time for an unknown / never-synced link.
    insertProjectLink(harness, project.id, {
      id: 'link-unknown',
      remotePot: 'quiet',
      remoteProjectId: 'quiet-project',
      remoteAgentId: 'quiet-agent',
    })
    const withUnknown = await loadProjectSituation(envFor(harness), project, null)
    expect(withUnknown.linked_pots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        link_id: 'link-unknown',
        health: 'unknown',
        last_synchronized_at: null,
        agent_presence: 'unknown',
      }),
    ]))
  })

  it('keeps a never-synced link unknown and does not treat absence as healthy', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'unknown-link')
    insertProjectLink(harness, project.id, {
      id: 'link-never',
      remotePot: 'dme',
    })
    insertTask(harness, project.id, {
      id: 'remote-open', status: 'open', sourcePot: 'dme',
    })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.linked_pots).toEqual([
      expect.objectContaining({
        health: 'unknown',
        last_synchronized_at: null,
        agent_presence: 'unknown',
      }),
    ])
    expect(situation.remote_tasks[0]).toMatchObject({
      id: 'remote-open',
      fact: { kind: 'unknown', source_pot: 'dme' },
    })
  })

  it('labels project-link receipt evidence by link freshness', async () => {
    harness = makeHarness()
    // Fixture receipts bypass the live authorization trigger the same way projection tests do.
    harness.sqlite.exec('DROP TRIGGER IF EXISTS trg_project_link_receipt_authorized')
    const project = insertProject(harness, 'linked-evidence')
    insertProjectLink(harness, project.id, {
      id: 'link-evidence',
      remotePot: 'dme',
      lastSuccessAt: '2026-07-19T10:00:00Z',
      staleAfterSeconds: 30,
    })
    harness.sqlite.prepare(`
      INSERT INTO project_link_receipts (
        id, tenant, link_id, local_project_id, direction, idempotency_key,
        correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
        remote_project_id, source_agent_id, action_type, action_id,
        evidence_sha256, receipt_key_id, receipt_signature, status, created_at
      ) VALUES (
        'receipt-1', 'pot-a', 'link-evidence', ?, 'inbound', 'idem-1',
        'corr-1', 'env-hash', 'receipt-hash', 'dme',
        'remote-project', 'remote-agent', 'evidence', 'action-1',
        'evidence-hash', 'receipt-key', 'receipt-sig', 'accepted', '2026-07-19T10:00:00Z'
      )
    `).run(project.id)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T10:00:10Z'))
    const current = await loadProjectSituation(envFor(harness), project, null)
    expect(current.evidence).toEqual([
      expect.objectContaining({
        source_type: 'project_link_receipt',
        source_id: 'receipt-1',
        fact: { kind: 'current_remote', source_pot: 'dme' },
      }),
    ])

    vi.setSystemTime(new Date('2026-07-19T10:00:31Z'))
    const stale = await loadProjectSituation(envFor(harness), project, null)
    expect(stale.linked_pots[0]).toMatchObject({ health: 'stale' })
    expect(stale.evidence[0]).toMatchObject({
      fact: { kind: 'stale_remote', source_pot: 'dme' },
    })
  })
})
