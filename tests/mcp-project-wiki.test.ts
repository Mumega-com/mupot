// tests/mcp-project-wiki.test.ts — the `project_wiki` MCP tool (mupot v0.50
// goal item 4), gated IDENTICALLY to project_get: readAccess + readableProject.
// A caller without project read must be denied WITHOUT ever calling the
// upstream Inkwell wiki service.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const MEMBER_ID = 'member-a'
const SQUAD_ID = 'squad-a'
const OTHER_SQUAD_ID = 'squad-b'
const MASTER_KEY = '44'.repeat(32)
const CONNECTOR_ID = 'connector-inkwell-mcp'
const SECRET = 'mcp-wiki-secret-777'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_ID}', 'dept-a', 'squad-a', 'Squad A'),
      ('${OTHER_SQUAD_ID}', 'dept-a', 'squad-b', 'Squad B');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a-id', 'project-a-slug', 'Project A', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('proj-a-id', '${SQUAD_ID}', 'write');
  `)
  return harness
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
    ...overrides,
  }
}

async function envFor(harness: SqliteD1Harness, fake: FakeInternalWiki): Promise<Env> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'Inkwell wiki', '${encrypted}', NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  )
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    INKWELL_API_URL: 'https://inkwell-api.test',
    INKWELL_SVC: fake.asFetcher(),
  } as unknown as Env
}

describe('MCP project_wiki', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('a reader with project access gets the wiki graph', async () => {
    harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'proj-a-id', slug: 'overview', title: 'Overview' })
    const env = await envFor(harness, fake)

    const outcome = await invokeTool(auth(), env, 'project_wiki', { project_id: 'proj-a-id' }, 'https://pot.example')
    expect(outcome.ok).toBe(true)
    const result = outcome.result as { project_id: string; wiki: { nodes: { slug: string }[] } }
    expect(result.project_id).toBe('proj-a-id')
    expect(result.wiki.nodes.map((n) => n.slug)).toEqual(['overview'])
  })

  it('denies a caller with NO read access to the project — and the upstream wiki service is NEVER called', async () => {
    harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'proj-a-id', slug: 'overview', title: 'Overview' })
    const env = await envFor(harness, fake)

    // Member of squad-b only — squad-b has no project_squad_access row on project-a.
    const outsider = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: OTHER_SQUAD_ID, capability: 'observer' }],
    })
    const outcome = await invokeTool(outsider, env, 'project_wiki', { project_id: 'proj-a-id' }, 'https://pot.example')
    expect(outcome.ok).toBe(false)
    expect((outcome as { status: number }).status).toBe(404)
    expect(fake.requests).toEqual([]) // deny-without-upstream-call invariant
  })

  it('a grantless (zero-capability) token is denied by the observer floor before the tool even runs', async () => {
    harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)

    const grantless = auth({ capabilities: [] })
    const outcome = await invokeTool(grantless, env, 'project_wiki', { project_id: 'proj-a-id' }, 'https://pot.example')
    expect(outcome.ok).toBe(false)
    expect((outcome as { status: number }).status).toBe(403)
    expect(fake.requests).toEqual([])
  })

  it('an unknown project_id is 404, not a crash', async () => {
    harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)

    const outcome = await invokeTool(auth(), env, 'project_wiki', { project_id: 'does-not-exist' }, 'https://pot.example')
    expect(outcome.ok).toBe(false)
    expect((outcome as { status: number }).status).toBe(404)
  })

  it('an unreachable wiki service maps to a 503, not a 500', async () => {
    harness = makeHarness()
    const env = await envFor(harness, new FakeInternalWiki({ [TENANT]: 'wrong-secret' }))

    const outcome = await invokeTool(auth(), env, 'project_wiki', { project_id: 'proj-a-id' }, 'https://pot.example')
    expect(outcome.ok).toBe(false)
    expect((outcome as { status: number }).status).toBe(503)
  })

  it.each([
    [404, 'not_found'],
    [400, 'invalid_project'],
  ])('P2-B: a well-formed-but-rejected upstream call (JSON %i) maps to 502 wiki_request_rejected, never the upstream body', async (status, code) => {
    harness = makeHarness()
    const base = await envFor(harness, new FakeInternalWiki({ [TENANT]: SECRET }))
    // `as unknown as Fetcher`: the double implements only `fetch`, the one member wiki-client.ts calls.
    const rejecting = { fetch: async () => Response.json({ error: code, detail: 'UPSTREAM-BODY-SENTINEL' }, { status }) } as unknown as Fetcher
    const env = { ...base, INKWELL_SVC: rejecting } as Env

    const outcome = await invokeTool(auth(), env, 'project_wiki', { project_id: 'proj-a-id' }, 'https://pot.example')
    expect(outcome.ok).toBe(false)
    expect((outcome as { status: number }).status).toBe(502)
    expect(JSON.stringify(outcome)).toContain('wiki_request_rejected')
    expect(JSON.stringify(outcome)).not.toContain('UPSTREAM-BODY-SENTINEL')
  })
})
