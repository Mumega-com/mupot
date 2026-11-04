// tests/inkwell-wiki-binding.test.ts — dedicated INKWELL_WIKI service binding
// (task 5d09276a, flight a696b174 step 1). The wiki uses INKWELL_WIKI when bound and
// falls back to INKWELL_SVC only when it is absent; connectors never leave INKWELL_SVC;
// /health reports which; the deploy-time script validates the wrangler props.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'
import { getProjectWikiGraph } from '../src/projects/wiki-client'
import { useConnectorById } from '../src/connectors/service'
import { healthPayload, wikiBindingMode } from '../src/health'
import { checkWikiBinding } from '../scripts/check-inkwell-wiki-binding.mjs'

const MASTER_KEY = '33'.repeat(32)
const TENANT = 'pot-a'
const CONNECTOR_ID = 'connector-inkwell-wiki'
const SECRET = 'wiki-pot-secret-xyz'

function recorder(label: string, hits: string[]): Fetcher {
  const fake = new FakeInternalWiki({ [TENANT]: SECRET })
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(label)
      return fake.fetch(input, init)
    },
  } as unknown as Fetcher
}

async function envWith(extra: Partial<Env>): Promise<Env> {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'Inkwell wiki', '${encrypted}', NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  )
  // Env is a wide Workers binding bag; the test supplies only what the code under test reads.
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    INKWELL_API_URL: 'https://inkwell-api.test',
    ...extra,
  } as Env
}

describe('wiki fetcher selection', () => {
  it('uses INKWELL_WIKI when both are bound', async () => {
    const hits: string[] = []
    const env = await envWith({ INKWELL_WIKI: recorder('wiki', hits), INKWELL_SVC: recorder('svc', hits) })
    await getProjectWikiGraph(env, 'p1')
    expect(hits).toEqual(['wiki'])
  })

  it('falls back to INKWELL_SVC when INKWELL_WIKI is absent', async () => {
    const hits: string[] = []
    const env = await envWith({ INKWELL_SVC: recorder('svc', hits) })
    await getProjectWikiGraph(env, 'p1')
    expect(hits).toEqual(['svc'])
  })

  it('connectors keep INKWELL_SVC even when INKWELL_WIKI is bound', async () => {
    const hits: string[] = []
    const env = await envWith({ INKWELL_WIKI: recorder('wiki', hits), INKWELL_SVC: recorder('svc', hits) })
    await useConnectorById(env, CONNECTOR_ID, 'inkwell', async (conn) => {
      await conn.authenticatedFetch('https://inkwell-api.test/api/internal/wiki/graph?tenant_slug=pot-a&project=p1')
      return { status: 'available', observations: [] }
    })
    expect(hits).toEqual(['svc'])
  })
})

describe('/health wiki_binding mode', () => {
  const f = {} as Fetcher
  it('reports scoped / legacy_svc / none', () => {
    expect(wikiBindingMode({ INKWELL_WIKI: f, INKWELL_SVC: f })).toBe('scoped')
    expect(wikiBindingMode({ INKWELL_WIKI: f })).toBe('scoped')
    expect(wikiBindingMode({ INKWELL_SVC: f })).toBe('legacy_svc')
    expect(wikiBindingMode({})).toBe('none')
  })

  it('the /health payload carries the field and still the public identity', () => {
    const body = healthPayload({ TENANT_SLUG: 't', INKWELL_WIKI: f })
    expect(body.wiki_binding).toBe('scoped')
    expect(body.tenant).toBe('t')
    expect(healthPayload({ TENANT_SLUG: 't', INKWELL_SVC: f }).wiki_binding).toBe('legacy_svc')
    expect(healthPayload({ TENANT_SLUG: 't' }).wiki_binding).toBe('none')
  })
})

const GOOD = `
[vars]
TENANT_SLUG = "mumega"

[[services]]
binding = "INKWELL_SVC"
service = "inkwell-api"

[[services]]
binding = "INKWELL_WIKI"
service = "inkwell-api"
props = { wiki = { tenant = "mumega", project_scope = "tenant", actions = ["read", "write"] } }
`

describe('check-inkwell-wiki-binding', () => {
  it('passes a good config (inline props)', () => {
    expect(checkWikiBinding(GOOD)).toEqual({ errors: [], configured: true })
  })

  it('passes a good config (sub-table form, optional projects, multi-line)', () => {
    const t = `
[vars]
TENANT_SLUG = "mumega"
[[services]]
binding = "INKWELL_WIKI"
service = "inkwell-api"
entrypoint = "WikiService"
[services.props.wiki]
tenant = "mumega"
project_scope = "tenant"
actions = [
  "read", # comment
  "write",
]
projects = ["8b5c7d0e-0000-4000-8000-000000000001"]
`
    expect(checkWikiBinding(t)).toEqual({ errors: [], configured: true })
  })

  it('absent binding is the legacy path, not an error', () => {
    expect(checkWikiBinding('[vars]\nTENANT_SLUG = "mumega"\n')).toEqual({ errors: [], configured: false })
  })

  const bad: Array<[string, string, RegExp]> = [
    ['tenant mismatch', GOOD.replace('tenant = "mumega"', 'tenant = "other"'), /must equal TENANT_SLUG/],
    ['wrong scope', GOOD.replace('"tenant", actions', '"all", actions'), /project_scope/],
    ['missing scope', GOOD.replace('project_scope = "tenant", ', ''), /project_scope/],
    ['bad action', GOOD.replace('["read", "write"]', '["read", "admin"]'), /actions/],
    ['empty actions', GOOD.replace('["read", "write"]', '[]'), /actions/],
    ['empty projects', GOOD.replace('actions = ["read", "write"]', 'actions = ["read"], projects = []'), /projects/],
    ['wildcard projects', GOOD.replace('actions = ["read", "write"]', 'actions = ["read"], projects = ["*"]'), /projects/],
    ['no props', GOOD.replace(/props = .*\n/, ''), /props\.wiki missing/],
    [
      'props on INKWELL_SVC',
      GOOD.replace('binding = "INKWELL_SVC"\nservice = "inkwell-api"', 'binding = "INKWELL_SVC"\nservice = "inkwell-api"\nprops = { wiki = { tenant = "mumega" } }'),
      /INKWELL_SVC must not carry props/,
    ],
  ]
  it.each(bad)('fails: %s', (_name, toml, re) => {
    const r = checkWikiBinding(toml)
    expect(r.errors.join('\n')).toMatch(re)
  })

  it('CLI exits non-zero on a bad config and zero on a good one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wikibind-'))
    const good = join(dir, 'good.toml')
    const badf = join(dir, 'bad.toml')
    writeFileSync(good, GOOD)
    writeFileSync(badf, GOOD.replace('tenant = "mumega"', 'tenant = "other"'))
    const run = (f: string, ...x: string[]) => {
      try {
        execFileSync('node', ['scripts/check-inkwell-wiki-binding.mjs', f, ...x], { stdio: 'pipe' })
        return 0
      } catch (e) {
        return (e as { status: number }).status
      }
    }
    expect(run(good)).toBe(0)
    expect(run(badf)).toBe(1)
    expect(run(join(dir, 'none.toml'))).not.toBe(0)
    writeFileSync(join(dir, 'legacy.toml'), '[vars]\nTENANT_SLUG = "mumega"\n')
    expect(run(join(dir, 'legacy.toml'))).toBe(0)
    expect(run(join(dir, 'legacy.toml'), '--require')).toBe(1)
  })
})
