import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by router root route tests') }
  },
}))

const { app } = await import('../src/index')

const TENANT = 'router-test'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

function grant(memberId: string, capability: CapabilityGrant['capability'], squadId: string): CapabilityGrant {
  return { member_id: memberId, scope_type: 'squad', scope_id: squadId, capability }
}

function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities,
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A}', 'dept', 'a', 'Squad A'),
      ('${SQUAD_B}', 'dept', 'b', 'Squad B');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-a', 'member-a@example.test', 'Member A', 'active', '${TENANT}'),
      ('lead-a', 'lead-a@example.test', 'Lead A', 'active', '${TENANT}'),
      ('lead-b', 'lead-b@example.test', 'Lead B', 'active', '${TENANT}'),
      ('observer-a', 'observer-a@example.test', 'Observer A', 'active', '${TENANT}'),
      ('org-admin', 'org-admin@example.test', 'Org Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('member-a-cap', 'member-a', 'squad', '${SQUAD_A}', 'member'),
      ('lead-a-cap', 'lead-a', 'squad', '${SQUAD_A}', 'lead'),
      ('lead-b-cap', 'lead-b', 'squad', '${SQUAD_B}', 'lead'),
      ('observer-a-cap', 'observer-a', 'squad', '${SQUAD_A}', 'observer'),
      ('org-admin-cap', 'org-admin', 'org', NULL, 'admin');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_A}', '${SQUAD_A}', 'agent-a', 'Agent A', 'active'),
      ('${AGENT_B}', '${SQUAD_B}', 'agent-b', 'Agent B', 'active');
    INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at) VALUES
      ('${TENANT}', 'agent-a-member', 'Agent A', 'test', 'seat-a', '${AGENT_A}', datetime('now'), datetime('now')),
      ('${TENANT}', 'agent-b-member', 'Agent B', 'test', 'seat-b', '${AGENT_B}', datetime('now'), datetime('now'));
  `)
}

function insertTask(sqlite: SqliteD1Harness['sqlite'], id: string, squadId: string, projectId: string | null = null): void {
  sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'done', 'open', NULL, datetime('now'), datetime('now'))`,
  ).run(id, squadId, projectId, id)
}

function makeEnv(harness: SqliteD1Harness, options: {
  loseClaim?: boolean
  beforeClaim?: () => void
  candidateReads?: { value: number }
  writes?: { value: number }
} = {}) {
  const events: unknown[] = []
  const db = {
    prepare(sql: string) {
      const statement = harness.db.prepare(sql)
      const candidateQuery = /FROM tasks\s+t/i.test(sql)
      const claim = /^\s*UPDATE tasks\s+SET assignee_agent_id/i.test(sql)
      const write = /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args)
          return {
            first: <T>() => bound.first<T>(),
            all: <T>() => {
              if (candidateQuery && options.candidateReads) options.candidateReads.value += 1
              return bound.all<T>()
            },
            run: async () => {
              if (write && options.writes) options.writes.value += 1
              if (claim) options.beforeClaim?.()
              if (claim && options.loseClaim) return { meta: { changes: 0 } } as D1Result
              return bound.run()
            },
          }
        },
      }
    },
  }
  return {
    env: {
      DB: db,
      TENANT_SLUG: TENANT,
      BUS: { send: vi.fn(async (event: unknown) => { events.push(event) }) },
    } as unknown as Env,
    events,
  }
}

async function routerTick(authContext: AuthContext, env: Env, args: Record<string, unknown>) {
  return invokeTool(authContext, env, 'router_tick', args, 'https://pot.example')
}

function rootEnv(harness: SqliteD1Harness, session: string | null): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: {
      get: async (key: string) => key === 'sess:router' ? session : null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function rootRequest(path: string, body?: unknown, authenticated = false): Request {
  return new Request(`https://pot.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { Cookie: 'mupot_session=router' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function sessionFor(memberId: string): string {
  return JSON.stringify({
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    createdAt: '2026-08-29T00:00:00.000Z',
  })
}

describe('router_tick authorization and squad fencing', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('rejects member mutation before reading candidates', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const candidateReads = { value: 0 }
    const { env, events } = makeEnv(harness, { candidateReads })

    const result = await routerTick(auth('member-a', [grant('member-a', 'member', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(candidateReads.value).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('rejects lead of another squad', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const candidateReads = { value: 0 }
    const { env } = makeEnv(harness, { candidateReads })

    const result = await routerTick(auth('lead-b', [grant('lead-b', 'lead', SQUAD_B)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(candidateReads.value).toBe(0)
  })

  it('requires squad_id and never performs a tenant sweep', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    insertTask(harness.sqlite, 'task-b', SQUAD_B)
    const candidateReads = { value: 0 }
    const { env } = makeEnv(harness, { candidateReads })

    const result = await routerTick(auth('observer-a', [grant('observer-a', 'observer', SQUAD_A)]), env, {
      dry_run: true,
    })

    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(candidateReads.value).toBe(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-b')).toEqual({ assignee_agent_id: null })
  })

  it('leaves inaccessible project tasks unrouted', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active')`)
    harness.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', '${SQUAD_A}', 'write')`)
    insertTask(harness.sqlite, 'task-a', SQUAD_A, 'project-a')
    // The router must fence legacy/drifted rows too; the task's project access is
    // revoked after its valid creation, so the migration trigger cannot hide this case.
    harness.sqlite.exec(`DELETE FROM project_squad_access WHERE project_id = 'project-a' AND squad_id = '${SQUAD_A}'`)
    const { env, events } = makeEnv(harness)

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0, unrouted: 1 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'unrouted', agent_id: null },
    ])
    expect(events).toHaveLength(0)
  })

  it('never chooses a candidate from another squad', async () => {
    harness.sqlite.prepare('DELETE FROM agents WHERE id = ?').run(AGENT_A)
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const { env, events } = makeEnv(harness)

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0, unrouted: 1 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'unrouted', agent_id: null },
    ])
    expect(events).toHaveLength(0)
  })

  it('lost concurrent claim neither wakes nor increments assigned', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const { env, events } = makeEnv(harness, { loseClaim: true })

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'lost_claim', agent_id: AGENT_A },
    ])
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a')).toEqual({ assignee_agent_id: null })
  })

  it('does not claim after authorization when the actor lead grant is revoked before claim', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const { env, events } = makeEnv(harness, {
      beforeClaim: () => {
        harness.sqlite.prepare('DELETE FROM capabilities WHERE id = ?').run('lead-a-cap')
      },
    })

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'lost_claim', agent_id: AGENT_A },
    ])
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a'))
      .toEqual({ assignee_agent_id: null })
  })

  it('does not claim a task moved to another squad after selection', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const { env, events } = makeEnv(harness, {
      beforeClaim: () => {
        harness.sqlite.prepare('UPDATE tasks SET squad_id = ? WHERE id = ?').run(SQUAD_B, 'task-a')
      },
    })

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'lost_claim', agent_id: AGENT_A },
    ])
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT squad_id, assignee_agent_id FROM tasks WHERE id = ?').get('task-a')).toEqual({
      squad_id: SQUAD_B, assignee_agent_id: null,
    })
  })

  it.each([
    ['candidate moved squads', () => {
      harness.sqlite.prepare('UPDATE agents SET squad_id = ? WHERE id = ?').run(SQUAD_B, AGENT_A)
    }],
    ['candidate became inactive', () => {
      harness.sqlite.prepare('UPDATE agents SET status = ? WHERE id = ?').run('paused', AGENT_A)
    }],
    ['candidate presence became stale', () => {
      harness.sqlite.prepare('UPDATE presence SET last_seen_at = ? WHERE agent_id = ?')
        .run('2020-01-01T00:00:00.000Z', AGENT_A)
    }],
    ['candidate presence was removed', () => {
      harness.sqlite.prepare('DELETE FROM presence WHERE agent_id = ?').run(AGENT_A)
    }],
  ])('does not claim after selection when %s', async (_name, interleave) => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const { env, events } = makeEnv(harness, { beforeClaim: interleave })

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'lost_claim', agent_id: AGENT_A },
    ])
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a'))
      .toEqual({ assignee_agent_id: null })
  })

  it.each([
    ['project access was revoked', () => {
      harness.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ? AND squad_id = ?')
        .run('project-a', SQUAD_A)
    }],
    ['project became inactive', () => {
      harness.sqlite.prepare('UPDATE projects SET status = ? WHERE id = ?').run('paused', 'project-a')
    }],
  ])('does not claim a project task after selection when %s', async (_name, interleave) => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active')`)
    harness.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', '${SQUAD_A}', 'write')`)
    insertTask(harness.sqlite, 'task-a', SQUAD_A, 'project-a')
    const { env, events } = makeEnv(harness, { beforeClaim: interleave })

    const result = await routerTick(auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: false,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'lost_claim', agent_id: AGENT_A },
    ])
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a'))
      .toEqual({ assignee_agent_id: null })
  })

  it('dry-run performs zero writes and wakes', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const writes = { value: 0 }
    const { env, events } = makeEnv(harness, { writes })

    const result = await routerTick(auth('observer-a', [grant('observer-a', 'observer', SQUAD_A)]), env, {
      squad_id: SQUAD_A, dry_run: true,
    })

    expect(result).toMatchObject({ ok: true, result: { assigned: 0, scanned: 1 } })
    expect((result.result as { decisions: unknown[] }).decisions).toEqual([
      { task_id: 'task-a', outcome: 'would_assign', agent_id: AGENT_A },
    ])
    expect(writes.value).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('keeps the ordinary MCP presence update for router mutation', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const writes = { value: 0 }
    const { env } = makeEnv(harness, { writes })
    const deferred: Promise<unknown>[] = []

    const result = await invokeTool(
      auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]),
      env,
      'router_tick',
      { squad_id: SQUAD_A, dry_run: false },
      { origin: 'https://pot.example', waitUntil: (promise) => deferred.push(promise) },
    )
    await Promise.all(deferred)

    expect(result).toMatchObject({ ok: true, result: { assigned: 1 } })
    expect(writes.value).toBeGreaterThan(1)
    expect(harness.sqlite.prepare('SELECT member_id FROM presence WHERE tenant = ? AND member_id = ?').get(TENANT, 'lead-a')).toEqual({ member_id: 'lead-a' })
  })

  it('rejects malformed dry_run before it can select a presence-touch branch', async () => {
    const writes = { value: 0 }
    const { env } = makeEnv(harness, { writes })
    const deferred: Promise<unknown>[] = []

    const result = await invokeTool(
      auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]),
      env,
      'router_tick',
      { squad_id: SQUAD_A, dry_run: 'false' },
      { origin: 'https://pot.example', waitUntil: (promise) => deferred.push(promise) },
    )
    await Promise.all(deferred)

    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(writes.value).toBe(0)
  })

  it('rejects null dry_run before task, wake, or presence writes', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const writes = { value: 0 }
    const { env, events } = makeEnv(harness, { writes })
    const deferred: Promise<unknown>[] = []

    const result = await invokeTool(
      auth('lead-a', [grant('lead-a', 'lead', SQUAD_A)]),
      env,
      'router_tick',
      { squad_id: SQUAD_A, dry_run: null },
      { origin: 'https://pot.example', waitUntil: (promise) => deferred.push(promise) },
    )
    await Promise.all(deferred)

    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(writes.value).toBe(0)
    expect(events).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a')).toEqual({ assignee_agent_id: null })
    expect(harness.sqlite.prepare('SELECT member_id FROM presence WHERE tenant = ? AND member_id = ?').get(TENANT, 'lead-a')).toBeUndefined()
  })
})

describe('root-mounted router REST route', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('requires authentication on POST /api/router/tick', async () => {
    const response = await app.fetch(rootRequest('/api/router/tick', { squad_id: SQUAD_A, dry_run: false }), rootEnv(harness, null))
    expect(response.status).toBe(401)
  })

  it('rejects an authenticated non-admin on POST /api/router/tick', async () => {
    const response = await app.fetch(
      rootRequest('/api/router/tick', { squad_id: SQUAD_A, dry_run: false }, true),
      rootEnv(harness, sessionFor('lead-a')),
    )
    expect(response.status).toBe(403)
  })

  it('runs the same named-squad engine only at POST /api/router/tick', async () => {
    insertTask(harness.sqlite, 'task-a', SQUAD_A)
    const env = rootEnv(harness, sessionFor('org-admin'))

    const missingSquad = await app.fetch(rootRequest('/api/router/tick', { dry_run: false }, true), env)
    expect(missingSquad.status).toBe(400)

    const response = await app.fetch(rootRequest('/api/router/tick', { squad_id: SQUAD_A, dry_run: false }, true), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, result: { squad_id: SQUAD_A, assigned: 1 } })
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-a')).toEqual({ assignee_agent_id: AGENT_A })

    const duplicatedChild = await app.fetch(rootRequest('/api/router/tick/tick', { squad_id: SQUAD_A, dry_run: false }, true), env)
    expect(duplicatedChild.status).toBe(404)
  })
})
