import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by root route tests') }
  },
}))

const { app } = await import('../src/index')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const token = 'routine-member-token'

function sessions(record: string | null) {
  return {
    get: async (key: string) => key === 'sess:live' ? record : null,
    put: async () => undefined,
    delete: async () => undefined,
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  const hash = createHash('sha256').update(token).digest('hex')
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-1', 'member@example.test', 'Member', 'active', 'tenant-a');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('token-1', 'member-1', '${hash}', 'Routine API', 'workspace', '2026-07-19T00:00:00.000Z', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-1', 'member-1', 'org', NULL, 'admin');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'Project One', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-1', 'write');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, session: string | null = null): Env {
  return {
    DB: harness.db,
    SESSIONS: sessions(session),
    TENANT_SLUG: 'tenant-a',
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://pot.test${path}`, options)
}

describe('root-mounted Routine and Needs You routes', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('selects a member bearer ahead of a stale session cookie for every Project-scoped route family', async () => {
    harness = makeHarness()
    const env = envFor(harness, null)
    const headers = { Authorization: `Bearer ${token}`, Cookie: 'mupot_session=stale', Origin: 'https://attacker.test' }
    for (const path of ['/api/projects/project-1/routines', '/api/projects/project-1/routine-runs', '/api/projects/project-1/needs-you']) {
      const response = await app.fetch(request(path, { headers }), env)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const created = await app.fetch(request('/api/projects/project-1/routines', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
        name: 'Bearer routine', objective: 'Keep Project moving.', trigger_kind: 'manual', timezone: 'UTC',
        responsible_squad_id: 'squad-1', budget_micro_usd: 1000,
      }),
    }), env)
    expect(created.status).toBe(201)
  })

  it('uses csrf only for selected browser sessions and rejects missing or foreign Origin', async () => {
    harness = makeHarness()
    const session = JSON.stringify({ userId: 'owner-1', email: null, role: 'owner', createdAt: '2026-07-19T00:00:00.000Z' })
    const env = envFor(harness, session)
    const body = JSON.stringify({
      name: 'Session routine', objective: 'Keep Project moving.', trigger_kind: 'manual', timezone: 'UTC',
      responsible_squad_id: 'squad-1', budget_micro_usd: 1000,
    })
    const base = { method: 'POST', headers: { Cookie: 'mupot_session=live', 'content-type': 'application/json' }, body }
    expect((await app.fetch(request('/api/projects/project-1/routines', base), env)).status).toBe(403)
    expect((await app.fetch(request('/api/projects/project-1/routines', {
      ...base, headers: { ...base.headers, Origin: 'https://attacker.test' },
    }), env)).status).toBe(403)
    expect((await app.fetch(request('/api/projects/project-1/routines', {
      ...base, headers: { ...base.headers, Origin: 'https://pot.test' },
    }), env)).status).toBe(201)
  })

  it('does not intercept unrelated API routes', async () => {
    harness = makeHarness()
    const response = await app.fetch(request('/api/tasks', { headers: { Authorization: `Bearer ${token}` } }), envFor(harness))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' })
  })

  it('does not trust an externally supplied OAuth auth-context header on REST', async () => {
    harness = makeHarness()
    const response = await app.fetch(request('/api/projects/project-1/routines', {
      headers: { 'x-mupot-auth-context': JSON.stringify({ role: 'owner', tenant: 'tenant-a' }) },
    }), envFor(harness))
    expect(response.status).toBe(401)
  })
})
