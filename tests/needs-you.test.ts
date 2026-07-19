import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityGrant, Env } from '../src/types'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function sessions() {
  const rows = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = rows.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> {
      rows.set(key, value)
    },
    async delete(key: string): Promise<void> {
      rows.delete(key)
    },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-1', 'alpha', 'Alpha'),
      ('squad-b', 'dept-1', 'beta', 'Beta');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-a', 'squad-a', 'write'),
      ('project-b', 'squad-b', 'write');
  `)
  return harness
}

function envFor(
  harness: SqliteD1Harness,
  tenant = 'tenant-a',
  sessionStore = sessions(),
): Env {
  return { DB: harness.db, SESSIONS: sessionStore, TENANT_SLUG: tenant } as unknown as Env
}

const squadAGrant: CapabilityGrant = {
  member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member',
}

function member(): RoutinePrincipal {
  return {
    tenant: 'tenant-a', actor_type: 'member', actor_id: 'member-a', workspace_admin: false,
    grants: [squadAGrant],
    project_read: { workspaceAdmin: false, orgRead: false, squadIds: ['squad-a'], departmentIds: [] },
  }
}

function owner(): RoutinePrincipal {
  return {
    tenant: 'tenant-a', actor_type: 'member', actor_id: 'owner-a', workspace_admin: true,
    grants: [],
    project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    legacy_owner_admin: true,
  } as RoutinePrincipal
}

function principal(overrides: Partial<RoutinePrincipal> = {}): RoutinePrincipal {
  return {
    tenant: 'tenant-a', actor_type: 'member', actor_id: 'member-a', workspace_admin: false,
    grants: [squadAGrant],
    project_read: { workspaceAdmin: false, orgRead: false, squadIds: ['squad-a'], departmentIds: [] },
    ...overrides,
  } as RoutinePrincipal
}

function itemActions(page: Awaited<ReturnType<typeof listNeedsYou>>, sourceId: string) {
  const item = page.items.find(candidate => candidate.source_id === sourceId)
  if (!item) throw new Error(`missing item ${sourceId}`)
  return item.allowed_actions
}

function insertTask(harness: SqliteD1Harness, values: {
  id: string
  projectId?: string
  status: 'blocked' | 'review' | 'approved'
  title?: string
  assignee?: string | null
  gateOwner?: string | null
  result?: string | null
  createdAt?: string
  updatedAt?: string
}) {
  const projectId = values.projectId ?? 'project-a'
  const squadId = projectId === 'project-a' ? 'squad-a' : 'squad-b'
  const createdAt = values.createdAt ?? '2026-07-19T10:00:00.000Z'
  const updatedAt = values.updatedAt ?? createdAt
  harness.sqlite.prepare(
    `INSERT INTO tasks (
       id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
       gate_owner, result, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', 'A durable outcome.', ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id, squadId, projectId, values.title ?? values.id, values.status,
    values.assignee ?? null, values.gateOwner ?? null, values.result ?? null, createdAt, updatedAt,
  )
}

function insertWaitingRun(harness: SqliteD1Harness, values: {
  id: string
  reason: 'agent' | 'approval' | 'answer' | 'review' | 'budget'
  projectId?: string
  taskId?: string | null
  createdAt?: string
  updatedAt?: string
}) {
  const projectId = values.projectId ?? 'project-a'
  const createdAt = values.createdAt ?? '2026-07-19T11:00:00.000Z'
  const updatedAt = values.updatedAt ?? createdAt
  const routineId = `routine-${values.id}`
  const squadId = projectId === 'project-a' ? 'squad-a' : 'squad-b'
  harness.sqlite.prepare(
    `INSERT INTO routines (
       id, tenant, project_id, name, objective, status, trigger_kind, timezone,
       overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd,
       max_attempts, retry_backoff_seconds, revision, enabled_by, enabled_at,
       created_by, created_at, updated_at
     ) VALUES (?, 'tenant-a', ?, ?, 'Advance the Project.', 'enabled', 'manual', 'UTC',
       'skip', 'propose', ?, 1000, 3, 300, 1, 'member-requester', ?, 'member-requester', ?, ?)`,
  ).run(routineId, projectId, `Routine ${values.id}`, squadId, createdAt, createdAt, updatedAt)
  harness.sqlite.prepare(
    `INSERT INTO routine_runs (
       id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
       trigger_kind, status, waiting_reason, task_id, created_at, updated_at
     ) VALUES (?, 'tenant-a', ?, ?, 1, ?, ?, 'manual', 'waiting', ?, ?, ?, ?)`,
  ).run(
    values.id, projectId, routineId,
    JSON.stringify({ execution_mode: 'propose', overlap_policy: 'skip', responsible_squad_id: squadId,
      preferred_agent_id: null, budget_micro_usd: 1000, max_attempts: 3, retry_backoff_seconds: 300 }),
    `manual:${values.id}`, values.reason, values.taskId ?? null, createdAt, updatedAt,
  )
}

describe('Needs You projection', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('projects pending approvals once, keeps gate actions authority-scoped, and keeps result output on that source', async () => {
    harness = makeHarness()
    insertTask(harness, {
      id: 'approval-output', status: 'review', assignee: 'agent-a', gateOwner: 'gate:content',
      result: 'Draft output', createdAt: '2026-07-19T12:00:00.000Z',
    })
    const env = envFor(harness)

    const visible = await listNeedsYou(env, member(), { project_id: 'project-a' })
    expect(visible.items).toEqual([expect.objectContaining({
      kind: 'approval', source_type: 'task', source_id: 'approval-output',
      allowed_actions: ['view'], safe_url: '/api/tasks/approval-output',
    })])

    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES ('grant-a', 'gate:content', 'member', 'member-a', 'owner-a', '2026-07-19T12:01:00.000Z')`,
    ).run()
    const decidable = await listNeedsYou(env, member(), { project_id: 'project-a' })
    expect(decidable.items).toEqual([expect.objectContaining({
      source_id: 'approval-output', allowed_actions: ['view', 'approve', 'reject'],
    })])
  })

  it('projects Routine waits, human-owned blocked work, and publishable reviewed output without inventing a source', async () => {
    harness = makeHarness()
    insertWaitingRun(harness, { id: 'wait-agent', reason: 'agent' })
    insertWaitingRun(harness, { id: 'wait-answer', reason: 'answer' })
    insertWaitingRun(harness, { id: 'wait-budget', reason: 'budget' })
    insertTask(harness, { id: 'human-blocked', status: 'blocked', gateOwner: 'role:delivery' })
    insertTask(harness, { id: 'agent-blocked', status: 'blocked', assignee: 'agent-a', gateOwner: 'role:delivery' })
    insertTask(harness, {
      id: 'publishable', status: 'approved', assignee: 'agent-a', gateOwner: 'gate:content', result: 'Ready',
    })
    const page = await listNeedsYou(envFor(harness), owner(), {})

    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'routine_agent', source_type: 'routine_run', source_id: 'wait-agent' }),
      expect.objectContaining({ kind: 'routine_answer', source_type: 'routine_run', source_id: 'wait-answer' }),
      expect.objectContaining({ kind: 'routine_budget', source_type: 'routine_run', source_id: 'wait-budget' }),
      expect.objectContaining({ kind: 'blocked_task', source_type: 'task', source_id: 'human-blocked' }),
      expect.objectContaining({ kind: 'publishable_output', source_type: 'task', source_id: 'publishable' }),
    ]))
    expect(page.items.map(item => item.source_id)).not.toContain('agent-blocked')
  })

  it('filters by Project and excludes unreadable Project rows', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'visible', status: 'blocked', gateOwner: 'role:delivery' })
    insertTask(harness, { id: 'hidden', projectId: 'project-b', status: 'blocked', gateOwner: 'role:delivery' })
    const env = envFor(harness)

    await expect(listNeedsYou(env, member(), {})).resolves.toMatchObject({
      items: [expect.objectContaining({ source_id: 'visible', project_id: 'project-a' })],
    })
    await expect(listNeedsYou(env, member(), { project_id: 'project-b' })).resolves.toMatchObject({ items: [] })
  })

  it('orders urgency before deadline and creation timestamp with a stable source identity tie-breaker', async () => {
    harness = makeHarness()
    insertTask(harness, {
      id: 'blocked-later', status: 'blocked', gateOwner: 'role:delivery', createdAt: '2026-07-19T15:00:00.000Z',
    })
    insertTask(harness, {
      id: 'approval-z', status: 'review', gateOwner: 'gate:content', createdAt: '2026-07-19T10:00:00.000Z',
    })
    insertTask(harness, {
      id: 'approval-a', status: 'review', gateOwner: 'gate:content', createdAt: '2026-07-19T10:00:00.000Z',
    })
    const page = await listNeedsYou(envFor(harness), owner(), {})

    expect(page.items.map(item => item.source_id)).toEqual(['approval-a', 'approval-z', 'blocked-later'])
  })

  it('continues with an opaque validated keyset cursor and rejects a tampered cursor', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'approval-a', status: 'review', gateOwner: 'gate:content', createdAt: '2026-07-19T12:00:00.000Z' })
    insertTask(harness, { id: 'approval-b', status: 'review', gateOwner: 'gate:content', createdAt: '2026-07-19T11:00:00.000Z' })
    const env = envFor(harness)
    const first = await listNeedsYou(env, owner(), { limit: 1 })
    expect(first.next_cursor).toEqual(expect.any(String))
    if (!first.next_cursor) throw new Error('expected cursor')

    await expect(listNeedsYou(env, owner(), { limit: 1, after: `${first.next_cursor}x` }))
      .rejects.toThrow('invalid_needs_you_cursor')
    await expect(listNeedsYou(env, owner(), { limit: 1, after: first.next_cursor })).resolves.toMatchObject({
      items: [expect.objectContaining({ source_id: 'approval-b' })], next_cursor: null,
    })
  })

  it('caps every source scan and reports when a cap can hide more authoritative rows', async () => {
    harness = makeHarness()
    for (let index = 0; index < 101; index++) {
      insertTask(harness, {
        id: `blocked-${String(index).padStart(3, '0')}`,
        status: 'blocked', gateOwner: 'role:delivery',
        createdAt: `2026-07-19T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })
    }
    const page = await listNeedsYou(envFor(harness), owner(), { limit: 100 })

    expect(page.items).toHaveLength(100)
    expect(page.next_cursor).toEqual(expect.any(String))
    expect(page.truncated).toBe(true)
    expect(page.truncated_sources).toContain('blocked_tasks')
  })

  it('advertises Routine lifecycle and answer actions only to the authorized human principal', async () => {
    harness = makeHarness()
    insertWaitingRun(harness, { id: 'routine-agent', reason: 'agent' })
    insertWaitingRun(harness, { id: 'routine-answer', reason: 'answer' })
    insertWaitingRun(harness, { id: 'routine-budget', reason: 'budget' })
    const env = envFor(harness)
    const observer = principal({
      grants: [{ ...squadAGrant, capability: 'observer' }],
    })
    const administrator = principal({
      actor_id: 'admin-a', workspace_admin: true,
      grants: [{ ...squadAGrant, scope_type: 'org', scope_id: null, capability: 'admin' }],
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    })
    const agent = principal({
      actor_type: 'agent', actor_id: 'agent-a', workspace_admin: true,
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    })

    const observerPage = await listNeedsYou(env, observer, {})
    expect(itemActions(observerPage, 'routine-agent')).toEqual(['view'])
    expect(itemActions(observerPage, 'routine-answer')).toEqual(['view'])
    expect(itemActions(observerPage, 'routine-budget')).toEqual(['view'])

    const memberPage = await listNeedsYou(env, member(), {})
    expect(itemActions(memberPage, 'routine-agent')).toEqual(['view'])
    expect(itemActions(memberPage, 'routine-answer')).toEqual(['view', 'answer'])
    expect(itemActions(memberPage, 'routine-budget')).toEqual(['view'])

    const adminPage = await listNeedsYou(env, administrator, {})
    expect(itemActions(adminPage, 'routine-agent')).toEqual(['view', 'assign_agent', 'cancel'])
    expect(itemActions(adminPage, 'routine-answer')).toEqual(['view', 'answer', 'cancel'])
    expect(itemActions(adminPage, 'routine-budget')).toEqual(['view', 'change_budget', 'cancel'])

    const agentPage = await listNeedsYou(env, agent, {})
    expect(itemActions(agentPage, 'routine-agent')).toEqual(['view'])
    expect(itemActions(agentPage, 'routine-answer')).toEqual(['view'])
    expect(itemActions(agentPage, 'routine-budget')).toEqual(['view'])
  })

  it('matches verdict squad, gate, self-verdict, and gate:loops approval authority', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'standard-gate', status: 'review', assignee: 'agent-b', gateOwner: 'gate:content' })
    insertTask(harness, { id: 'self-gate', status: 'review', assignee: 'agent-a', gateOwner: 'gate:content' })
    insertTask(harness, { id: 'loops-gate', status: 'review', assignee: 'agent-b', gateOwner: 'gate:loops' })
    harness.sqlite.exec(`
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
        ('content-member', 'gate:content', 'member', 'member-a', 'owner-a', '2026-07-19T12:00:00.000Z'),
        ('content-observer', 'gate:content', 'member', 'observer-a', 'owner-a', '2026-07-19T12:00:00.000Z'),
        ('content-agent', 'gate:content', 'agent', 'agent-a', 'owner-a', '2026-07-19T12:00:00.000Z'),
        ('loops-member', 'gate:loops', 'member', 'member-a', 'owner-a', '2026-07-19T12:00:00.000Z');
    `)
    const env = envFor(harness)
    const observer = principal({
      actor_id: 'observer-a', grants: [{ ...squadAGrant, member_id: 'observer-a', capability: 'observer' }],
    })
    const noGateFineGrainedAdmin = principal({
      actor_id: 'fine-admin', workspace_admin: true,
      grants: [{ ...squadAGrant, member_id: 'fine-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    })
    const selfAgent = principal({ actor_type: 'agent', actor_id: 'agent-a' })

    expect(itemActions(await listNeedsYou(env, observer, {}), 'standard-gate')).toEqual(['view'])
    expect(itemActions(await listNeedsYou(env, noGateFineGrainedAdmin, {}), 'standard-gate')).toEqual(['view'])
    expect(itemActions(await listNeedsYou(env, member(), {}), 'standard-gate')).toEqual(['view', 'approve', 'reject'])
    expect(itemActions(await listNeedsYou(env, selfAgent, {}), 'self-gate')).toEqual(['view'])
    expect(itemActions(await listNeedsYou(env, member(), {}), 'loops-gate')).toEqual(['view', 'reject'])

    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES ('loops-send', 'outreach:send-gated', 'member', 'member-a', 'owner-a', '2026-07-19T12:01:00.000Z')`,
    ).run()
    expect(itemActions(await listNeedsYou(env, member(), {}), 'loops-gate')).toEqual(['view', 'approve', 'reject'])
  })

  it('binds cursors to the principal, tenant, and Project filter and rejects missing server state', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'cursor-a', status: 'review', gateOwner: 'gate:content' })
    insertTask(harness, { id: 'cursor-b', status: 'review', gateOwner: 'gate:content', createdAt: '2026-07-19T09:00:00.000Z' })
    const sessionStore = sessions()
    const env = envFor(harness, 'tenant-a', sessionStore)
    const first = await listNeedsYou(env, owner(), { limit: 1 })
    if (!first.next_cursor) throw new Error('expected cursor')

    await expect(listNeedsYou(env, member(), { limit: 1, after: first.next_cursor }))
      .rejects.toThrow('invalid_needs_you_cursor')
    await expect(listNeedsYou(envFor(harness, 'tenant-b', sessionStore), { ...owner(), tenant: 'tenant-b' }, {
      limit: 1, after: first.next_cursor,
    })).rejects.toThrow('invalid_needs_you_cursor')
    await expect(listNeedsYou(env, owner(), { project_id: 'project-a', limit: 1, after: first.next_cursor }))
      .rejects.toThrow('invalid_needs_you_cursor')
    await expect(listNeedsYou(envFor(harness), owner(), { limit: 1, after: first.next_cursor }))
      .rejects.toThrow('invalid_needs_you_cursor')
  })

  it('continues beyond a capped authoritative source without skipping its remaining rows', async () => {
    harness = makeHarness()
    for (let index = 0; index < 101; index++) {
      insertTask(harness, {
        id: `continuation-${String(index).padStart(3, '0')}`,
        status: 'blocked', gateOwner: 'role:delivery',
        createdAt: `2026-07-19T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })
    }
    const env = envFor(harness)
    const first = await listNeedsYou(env, owner(), { limit: 100 })
    if (!first.next_cursor) throw new Error('expected cursor')
    const second = await listNeedsYou(env, owner(), { limit: 100, after: first.next_cursor })

    expect(second.items).toHaveLength(1)
    expect(new Set([...first.items, ...second.items].map(item => item.source_id)).size).toBe(101)
  })
})
