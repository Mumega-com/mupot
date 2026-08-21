import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const MEMBER_ID = 'member-1'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-uuid-1'
const OTHER_AGENT_ID = 'agent-uuid-other'
const NOW = Date.parse('2026-08-21T14:02:00Z')

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${SQUAD_ID}', '${DEPT_ID}', 'squad-1', 'Squad 1'),
      ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'squad-2', 'Squad 2');

    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
    VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', 'kasra', 'Kasra', 'builder', '@cf/test', 'active', '2026-08-01T00:00:00Z'),
      ('${OTHER_AGENT_ID}', '${OTHER_SQUAD_ID}', 'hermes', 'Hermes', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');

    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status,
                             reported_by, agent_type, member_id, host, last_reported_at, updated_at)
    VALUES
      ('${AGENT_ID}', '${TENANT}', 'Kasra Display', 'claude-code', '["${SQUAD_ID}"]', 'on_demand', 'running',
       'reporter', 'builder', '${MEMBER_ID}', 'host-1', '${sqliteStamp(NOW - 120_000)}', '${sqliteStamp(NOW - 120_000)}'),
      ('${OTHER_AGENT_ID}', '${TENANT}', 'Hermes Display', 'hermes', '["${OTHER_SQUAD_ID}"]', 'on_demand', 'running',
       'reporter', 'generic', 'other-member', 'host-2', '${sqliteStamp(NOW - 7200_000)}', '${sqliteStamp(NOW - 7200_000)}');
  `)
}

describe('MCP fleet_agent_get tool (mupot#1184)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT, FLEET_PRESENCE_TTL_SEC: '300' } as unknown as Env
  })

  afterEach(() => {
    vi.useRealTimers()
    harness.close()
  })

  it('is advertised on the MCP surface in TOOLS', () => {
    const tool = TOOLS.find((t) => t.name === 'fleet_agent_get')
    expect(tool).toBeDefined()
    expect(tool?.min).toBe('authenticated')
  })

  it('reads self agent fleet status when agent_id is omitted', async () => {
    const res = await invokeTool(auth(), env, 'fleet_agent_get', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as {
      agent_id: string
      agent_slug: string
      squad_id: string
      runtime: string
      status: string
      last_reported_at: string
      presence_ttl_sec: number
      derived_presence: string
      live: boolean
    }
    expect(result.agent_id).toBe(AGENT_ID)
    expect(result.agent_slug).toBe('kasra')
    expect(result.squad_id).toBe(SQUAD_ID)
    expect(result.runtime).toBe('claude-code')
    expect(result.status).toBe('running')
    expect(result.presence_ttl_sec).toBe(300)
    expect(result.derived_presence).toBe('live')
    expect(result.live).toBe(true)
  })

  it('reads explicit agent_id by slug', async () => {
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: 'kasra' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { agent_id: string; runtime: string; live: boolean }
    expect(result.agent_id).toBe(AGENT_ID)
    expect(result.runtime).toBe('claude-code')
    expect(result.live).toBe(true)
  })

  it('refuses cross-squad lookup when caller has no observer capability on that squad', async () => {
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: OTHER_AGENT_ID }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('forbidden')
  })

  it('allows cross-squad lookup for org admin', async () => {
    const adminAuth = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
    })
    const res = await invokeTool(adminAuth, env, 'fleet_agent_get', { agent_id: OTHER_AGENT_ID }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { agent_id: string; runtime: string; live: boolean; derived_presence: string }
    expect(result.agent_id).toBe(OTHER_AGENT_ID)
    expect(result.runtime).toBe('hermes')
    // 2 hours ago is older than 300s TTL, so stale
    expect(result.derived_presence).toBe('stale')
    expect(result.live).toBe(false)
  })

  it('returns 404 for unknown agent', async () => {
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: 'nonexistent-agent' }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('agent_not_found')
  })
})
