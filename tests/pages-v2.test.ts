// tests/pages-v2.test.ts — PagesPort v2: markdown body (bounded), backlinks, REAL squad-tier access, the
// body_unsupported refusal of the Inkwell adapter, and refusal detail reaching the MCP caller.
// Real SQL (all migrations); the Inkwell store is the FakeInternalWiki double; the body-capable store is
// FakePagesPort (the Inkwell adapter refuses bodies until inkwell-api stores them).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool, mcpApp } from '../src/mcp'
import { pagesPortFactory } from '../src/mcp/pages'
import { createInkwellPagesPort } from '../src/pages/inkwell-adapter'
import { MAX_BODY_BYTES, type PageEnvelope, type PagesPort } from '../src/pages/port'
import { readBacklinks, readPage, validatePageWrite, writePage } from '../src/pages/service'
import { sha256Hex } from '../src/members/service'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import type { AuthContext, Env } from '../src/types'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'
import { FakePagesPort } from './helpers/fake-pages-port'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const MASTER_KEY = '77'.repeat(32)
const CONNECTOR_ID = 'connector-inkwell-v2'
const SECRET = 'pages-v2-secret'
const MEMBER = 'member-w'
const SQ_W = 'squad-w' // write on PROJ
const SQ_R = 'squad-r' // read on PROJ
const SQ_O = 'squad-o' // no access
const PROJ = 'proj-a-id'
const ORIGIN = 'https://pot.example'

let shared: SqliteD1Harness
let fake: FakeInternalWiki
let env: Env
let inkwellFactory: typeof pagesPortFactory.create

beforeAll(async () => {
  shared = createSqliteD1()
  for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    shared.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
  }
  shared.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ_W}', 'dept-a', 'squad-w', 'W'), ('${SQ_R}', 'dept-a', 'squad-r', 'R'), ('${SQ_O}', 'dept-a', 'squad-o', 'O');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJ}', 'project-a-slug', 'Project A', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJ}', '${SQ_W}', 'write'), ('${PROJ}', '${SQ_R}', 'read');
  `)
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  shared.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at) VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${encrypted}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z')`,
  )
  inkwellFactory = pagesPortFactory.create
}, 120_000)
afterAll(() => {
  pagesPortFactory.create = inkwellFactory
  shared?.close()
})

beforeEach(() => {
  shared.sqlite.exec('DELETE FROM page_versions')
  fake = new FakeInternalWiki({ [TENANT]: SECRET })
  env = { DB: shared.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: fake.asFetcher() } as unknown as Env
  pagesPortFactory.create = inkwellFactory
})

const squadAuth = (squad: string, capability: 'observer' | 'member' = 'member'): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: squad, capability }],
})
/** Reads every project (org observer) but is a member of NO squad with access: must not see squad pages. */
const orgObserver: AuthContext = {
  userId: 'obs', memberId: 'obs', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  capabilities: [{ member_id: 'obs', scope_type: 'org', scope_id: null, capability: 'observer' }],
}
const orgAdmin: AuthContext = {
  userId: 'adm', memberId: 'adm', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  capabilities: [{ member_id: 'adm', scope_type: 'org', scope_id: null, capability: 'admin' }],
}

const base = { project_id: PROJ, title: 'A page', summary: 'a summary', purpose: 'decision', tier: 'project' }
const upsert = (a: AuthContext, args: Record<string, unknown>) => invokeTool(a, env, 'project_wiki_upsert', { ...base, ...args }, ORIGIN)
const get = (a: AuthContext, slug: string) => invokeTool(a, env, 'project_wiki_get', { project_id: PROJ, slug }, ORIGIN)
const graph = (a: AuthContext) => invokeTool(a, env, 'project_wiki', { project_id: PROJ }, ORIGIN)
type Page = { body: string | null; links: { to_slug: string }[]; backlinks: { slug: string; tier: string | null }[]; envelope: { tier: string } }
const pageOf = (o: Awaited<ReturnType<typeof get>>): Page => (o.ok ? (o.result as { page: Page }).page : (() => { throw new Error(JSON.stringify(o)) })())
const status = (o: { ok: boolean }) => (o as unknown as { status: number }).status

describe('PagesPort v2: body (fake body-capable store)', () => {
  beforeEach(() => { pagesPortFactory.create = () => new FakePagesPort() })
  // the factory returns a NEW port per call, so share one instance per test
  const useShared = (): FakePagesPort => { const p = new FakePagesPort(); pagesPortFactory.create = () => p; return p }

  it('upsert stores the body, get returns it; omitting body on update keeps it; "" clears it', async () => {
    useShared()
    expect((await upsert(squadAuth(SQ_W), { slug: 'with-body', body: '# Heading\n\ntext **bold**' })).ok).toBe(true)
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'with-body')).body).toBe('# Heading\n\ntext **bold**')
    await upsert(squadAuth(SQ_W), { slug: 'with-body', title: 'A page 2' })
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'with-body')).body).toBe('# Heading\n\ntext **bold**')
    await upsert(squadAuth(SQ_W), { slug: 'with-body', body: '' })
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'with-body')).body).toBeNull()
  })

  it('a page with no body returns body null', async () => {
    useShared()
    await upsert(squadAuth(SQ_W), { slug: 'no-body-page' })
    expect(pageOf(await get(squadAuth(SQ_W), 'no-body-page')).body).toBeNull()
  })

  it('the cap is in BYTES: exactly MAX accepted, one over refused (never truncated), multibyte counted as bytes', async () => {
    const port = useShared()
    const exact = 'a'.repeat(MAX_BODY_BYTES)
    expect((await upsert(squadAuth(SQ_W), { slug: 'exact-cap', body: exact })).ok).toBe(true)
    expect(port.store.get(`${PROJ}/exact-cap`)?.body).toHaveLength(MAX_BODY_BYTES)
    const over = await upsert(squadAuth(SQ_W), { slug: 'over-cap', body: exact + 'a' })
    expect(status(over)).toBe(400)
    expect(JSON.stringify(over)).toContain(`max ${MAX_BODY_BYTES}`)
    expect(port.store.has(`${PROJ}/over-cap`)).toBe(false)
    // 32769 two-byte chars = 65538 bytes but only 32769 characters: a char-count check would pass it.
    expect(status(await upsert(squadAuth(SQ_W), { slug: 'multibyte-cap', body: 'é'.repeat(32769) }))).toBe(400)
    expect(port.store.has(`${PROJ}/multibyte-cap`)).toBe(false)
  })

  it('a non-string body and NUL bytes are refused', () => {
    const v = (body: unknown) => validatePageWrite({ slug: 'good-slug', title: 'Title', summary: 's', body, purpose: 'decision', tier: 'project', tags: undefined, links: undefined })
    expect(v(5)).toMatchObject({ ok: false, status: 400 })
    expect(v('a\u0000b')).toMatchObject({ ok: false, status: 400 })
    expect(v('tab\tand\nnewline ok')).toMatchObject({ ok: true })
  })
})

describe('PagesPort v2: Inkwell adapter refuses a body it cannot store (body_unsupported, 501)', () => {
  it('a non-empty body is refused 501 body_unsupported, the upstream is never touched, nothing is dropped silently', async () => {
    const out = await upsert(squadAuth(SQ_W), { slug: 'inkwell-body', body: 'long markdown' })
    expect(out.ok).toBe(false)
    expect(status(out)).toBe(501)
    expect(JSON.stringify(out)).toContain('body_unsupported')
    expect(fake.requests).toEqual([])
  })

  it('an empty body or no body is accepted (nothing to store)', async () => {
    expect((await upsert(squadAuth(SQ_W), { slug: 'inkwell-empty', body: '' })).ok).toBe(true)
    expect((await upsert(squadAuth(SQ_W), { slug: 'inkwell-none' })).ok).toBe(true)
    expect(pageOf(await get(squadAuth(SQ_W), 'inkwell-none')).body).toBeNull()
  })

  it('defence in depth: the adapter put itself throws the typed failure before any I/O', async () => {
    const port = createInkwellPagesPort(env)
    expect(port.supportsBody).toBe(false)
    const envelope: PageEnvelope = { owner: 'a', writer: 'a', tier: 'project', purpose: 'decision', version: 1, writtenAt: '2026-10-26T00:00:00.000Z' }
    await expect(port.put(PROJ, { slug: 'direct-put', title: 'Direct', summary: 's', body: 'x', tags: [], links: [], envelope }))
      .rejects.toMatchObject({ kind: 'unsupported', code: 'body_unsupported' })
    expect(fake.requests).toEqual([])
  })

  it('the service refuses before get/put when the port cannot hold bodies (fake port with supportsBody=false)', async () => {
    const port = new FakePagesPort({ supportsBody: false })
    const checked = validatePageWrite({ slug: 'svc-body', title: 'Title', summary: 's', body: 'x', purpose: 'decision', tier: 'project', tags: undefined, links: undefined })
    if (!checked.ok) throw new Error('fixture invalid')
    expect(await writePage(env, port, { projectId: PROJ, writer: 'w', input: checked.value, canSeeSquadPages: true })).toMatchObject({ ok: false, status: 501, error: 'body_unsupported' })
    expect(port.store.size).toBe(0)
  })
})

describe('PagesPort v2: backlinks', () => {
  it('get returns the pages linking to the slug (Inkwell store)', async () => {
    await upsert(squadAuth(SQ_W), { slug: 'target-page' })
    await upsert(squadAuth(SQ_W), { slug: 'source-one', links: [{ to_slug: 'target-page', relation: 'cites' }] })
    await upsert(squadAuth(SQ_W), { slug: 'source-two', links: [{ to_slug: 'target-page' }] })
    const page = pageOf(await get(squadAuth(SQ_R, 'observer'), 'target-page'))
    expect(page.backlinks.map((b) => b.slug)).toEqual(['source-one', 'source-two'])
    expect(page.backlinks[0]).toMatchObject({ relation: 'cites', tier: 'project' })
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'source-one')).backlinks).toEqual([])
  })

  it('same behaviour on the fake body-capable port', async () => {
    const p = new FakePagesPort()
    pagesPortFactory.create = () => p
    await upsert(squadAuth(SQ_W), { slug: 'target-page' })
    await upsert(squadAuth(SQ_W), { slug: 'source-one', links: [{ to_slug: 'target-page' }] })
    expect(pageOf(await get(squadAuth(SQ_W), 'target-page')).backlinks.map((b) => b.slug)).toEqual(['source-one'])
  })
})

describe('squad-tier access (real): allowed and refused, plus backlink and graph leak tests', () => {
  async function seed(): Promise<void> {
    await upsert(squadAuth(SQ_W), { slug: 'open-target' })
    await upsert(squadAuth(SQ_W), { slug: 'squad-secret', title: 'Squad secret plan', tier: 'squad', links: [{ to_slug: 'open-target', relation: 'cites' }] })
    await upsert(squadAuth(SQ_W), { slug: 'open-page', links: [{ to_slug: 'squad-secret', relation: 'see' }, { to_slug: 'open-target' }] })
  }

  it('ALLOWED: a member of a squad with access reads and writes a squad page; an org admin reads it', async () => {
    await seed()
    for (const a of [squadAuth(SQ_W), squadAuth(SQ_R, 'observer'), orgAdmin]) {
      const g = await get(a, 'squad-secret')
      expect(g.ok).toBe(true)
      expect(pageOf(g).envelope.tier).toBe('squad')
    }
    expect((await upsert(squadAuth(SQ_W), { slug: 'squad-secret', title: 'Squad secret plan 2', tier: 'squad' })).ok).toBe(true)
  })

  it('REFUSED: an org-wide observer (reads the project, no squad access) gets page_not_found, byte-identical to an absent page', async () => {
    await seed()
    const hidden = await get(orgObserver, 'squad-secret')
    const absent = await get(orgObserver, 'no-such-page')
    expect(hidden.ok).toBe(false)
    expect(status(hidden)).toBe(404)
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent))
  })

  it('REFUSED: an org observer cannot write a squad page (project write floor) and the page is untouched', async () => {
    await seed()
    const before = fake.requests.length
    const out = await upsert(orgObserver, { slug: 'squad-secret', title: 'Hijack', tier: 'squad' })
    expect(out.ok).toBe(false)
    expect([403]).toContain(status(out))
    expect(fake.requests.length).toBe(before)
    expect(pageOf(await get(squadAuth(SQ_W), 'squad-secret')).envelope.tier).toBe('squad')
  })

  it('LEAK (links): a visible page does not name a squad page in its links for a non-squad reader', async () => {
    await seed()
    expect(pageOf(await get(orgObserver, 'open-page')).links.map((l) => l.to_slug)).toEqual(['open-target'])
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'open-page')).links.map((l) => l.to_slug).sort()).toEqual(['open-target', 'squad-secret'])
  })

  it('LEAK (backlinks): a squad page linking to a visible page is absent from that page\'s backlinks for a non-squad reader', async () => {
    await seed()
    expect(pageOf(await get(orgObserver, 'open-target')).backlinks.map((b) => b.slug)).toEqual(['open-page'])
    expect(pageOf(await get(squadAuth(SQ_R, 'observer'), 'open-target')).backlinks.map((b) => b.slug)).toEqual(['open-page', 'squad-secret'])
    expect(pageOf(await get(orgAdmin, 'open-target')).backlinks.map((b) => b.slug)).toEqual(['open-page', 'squad-secret'])
  })

  it('LEAK (backlinks of a squad page): the squad page itself is hidden, so its inbound links are too (service level)', async () => {
    await seed()
    const port = createInkwellPagesPort(env)
    expect(await readBacklinks(port, { projectId: PROJ, slug: 'squad-secret', canSeeSquadPages: false })).toBeNull()
    expect((await readBacklinks(port, { projectId: PROJ, slug: 'squad-secret', canSeeSquadPages: true }))?.map((b) => b.slug)).toEqual(['open-page'])
    expect(await readPage(port, { projectId: PROJ, slug: 'squad-secret', canSeeSquadPages: false })).toBeNull()
  })

  it('LEAK (graph): project_wiki omits the squad node and every edge touching it for a non-squad reader', async () => {
    await seed()
    const wikiOf = (o: Awaited<ReturnType<typeof graph>>) => (o.result as { wiki: { nodes: { slug: string }[]; edges: { from_slug: string; to_slug: string }[] } }).wiki
    const hidden = wikiOf(await graph(orgObserver))
    expect(hidden.nodes.map((n) => n.slug).sort()).toEqual(['open-page', 'open-target'])
    expect(hidden.edges.some((e) => e.from_slug === 'squad-secret' || e.to_slug === 'squad-secret')).toBe(false)
    expect(JSON.stringify(hidden)).not.toContain('squad-secret')
    expect(JSON.stringify(hidden)).not.toContain('Squad secret plan')
    const shown = wikiOf(await graph(squadAuth(SQ_R, 'observer')))
    expect(shown.nodes.map((n) => n.slug)).toContain('squad-secret')
    expect(shown.edges.some((e) => e.from_slug === 'squad-secret')).toBe(true)
    expect(wikiOf(await graph(orgAdmin)).nodes.map((n) => n.slug)).toContain('squad-secret')
  })

  it('SERVICE: writePage refuses a squad page the caller cannot see, and refuses creating one without squad access', async () => {
    const port = new FakePagesPort()
    const mk = (tier: 'project' | 'squad') => {
      const c = validatePageWrite({ slug: 'svc-squad', title: 'Title', summary: 's', purpose: 'decision', tier, tags: undefined, links: undefined })
      if (!c.ok) throw new Error('fixture invalid')
      return c.value
    }
    expect(await writePage(env, port, { projectId: PROJ, writer: 'w', input: mk('squad'), canSeeSquadPages: false })).toMatchObject({ ok: false, status: 403, error: 'squad_access_required' })
    expect(port.store.size).toBe(0)
    expect((await writePage(env, port, { projectId: PROJ, writer: 'w', input: mk('squad'), canSeeSquadPages: true })).ok).toBe(true)
    // overwrite of an existing squad page by a caller who cannot see it: the one non-oracle refusal, store untouched
    const before = JSON.stringify([...port.store])
    expect(await writePage(env, port, { projectId: PROJ, writer: 'x', input: { ...mk('project') }, canSeeSquadPages: false })).toMatchObject({ ok: false, status: 409, error: 'slug_unavailable' })
    expect(JSON.stringify([...port.store])).toBe(before)
  })

  it('a department-only reader (no squad grant) does not see squad pages either', async () => {
    await seed()
    const deptOnly: AuthContext = {
      ...squadAuth(SQ_W), userId: 'dept', memberId: 'dept',
      capabilities: [{ member_id: 'dept', scope_type: 'department', scope_id: 'dept-a', capability: 'observer' }],
    }
    expect(status(await get(deptOnly, 'squad-secret'))).toBe(404)
    expect(pageOf(await get(deptOnly, 'open-target')).backlinks.map((b) => b.slug)).toEqual(['open-page'])
  })
})

describe('refusal detail reaches the MCP caller', () => {
  it('a validator refusal over POST /mcp carries its detail in the tool result text, not only in error.data', async () => {
    const hash = await sha256Hex('detail-tok')
    shared.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status, created_at, tenant) VALUES ('m-detail', NULL, 'd', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-detail', 'm-detail', 'org', NULL, 'owner');
      INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('t-detail', 'm-detail', '${hash}', 't', 'workspace', '2026-08-01T00:00:00.000Z', NULL, '${TENANT}');
    `)
    const res = await mcpApp.request('https://pot.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer detail-tok' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_wiki_upsert', arguments: { ...base, slug: 'design-notes', purpose: 'x' } } }),
    }, { ...env, BRAND: 'D', OAUTH_PROVIDER: 'google' } as Env)
    const body = await res.json() as { result?: { isError: boolean; content: { text: string }[] }; error?: unknown }
    expect(body.error).toBeUndefined()
    expect(body.result?.isError).toBe(true)
    const parsed = JSON.parse(body.result?.content[0]?.text ?? '{}') as { error: string; status: number; detail: string }
    expect(parsed).toMatchObject({ error: 'invalid_args', status: 400 })
    expect(parsed.detail).toBe('purpose required: kebab, 3-32 chars (e.g. decision, runbook)')
  })

  it('other tools keep the bare -32602 invalid_args (the narrow fix does not change their contract)', async () => {
    const res = await mcpApp.request('https://pot.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer detail-tok' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: { bogus: 1 } } }),
    }, { ...env, BRAND: 'D', OAUTH_PROVIDER: 'google' } as Env)
    const body = await res.json() as { error?: { code: number; message: string } }
    expect(body.error).toMatchObject({ code: -32602, message: 'invalid_args' })
  })
})

// Compile-time: the three port implementations in this file satisfy PagesPort.
const _typecheck: PagesPort[] = [new FakePagesPort()]
void _typecheck
