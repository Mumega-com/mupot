import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('member-a', 'Member A', 'active', '${TENANT}'),
      ('lead-a', 'Lead A', 'active', '${TENANT}'),
      ('lead-b', 'Lead B', 'active', '${TENANT}'),
      ('observer-a', 'Observer A', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('member-a-cap', 'member-a', 'squad', '${SQUAD_A}', 'member'),
      ('lead-a-cap', 'lead-a', 'squad', '${SQUAD_A}', 'lead'),
      ('lead-b-cap', 'lead-b', 'squad', '${SQUAD_B}', 'lead'),
      ('observer-a-cap', 'observer-a', 'squad', '${SQUAD_A}', 'observer');
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
})
