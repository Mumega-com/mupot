// tests/pages-port-contract.test.ts — the PagesPort CONTRACT, run against (a) an in-memory fake adapter
// and (b) the default Inkwell adapter over the FakeInternalWiki double. A future adapter proves itself
// by adding one line to ADAPTERS. Also pins the service-level stamping/ownership rules over the fake port.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'
import { getProjectWikiTopic } from '../src/projects/wiki-client'
import { createInkwellPagesPort, decodeEnvelope, encodeEnvelopeTags } from '../src/pages/inkwell-adapter'
import { PagesPortError, type PageEnvelope, type PagePutInput, type PageRecord, type PagesPort } from '../src/pages/port'
import { validatePageWrite, writePage, type ValidPageWrite } from '../src/pages/service'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const SECRET = 'pages-contract-secret'
const PROJECT = 'proj-a-id'
const CONNECTOR_ID = 'connector-inkwell-pages'
const MASTER_KEY = '55'.repeat(32)

/** A provider-agnostic in-memory adapter: proves nothing in the contract is Inkwell-shaped. */
export class FakePagesPort implements PagesPort {
  readonly id = 'fake-memory'
  readonly store = new Map<string, PagePutInput>()
  async get(projectId: string, slug: string): Promise<PageRecord | null> {
    const hit = this.store.get(`${projectId}/${slug}`)
    if (!hit) return null
    return { slug: hit.slug, title: hit.title, summary: hit.summary, tags: hit.tags, links: hit.links, envelope: hit.envelope }
  }
  async put(projectId: string, input: PagePutInput) {
    for (const l of input.links) {
      if (!this.store.has(`${projectId}/${l.toSlug}`)) throw new PagesPortError('rejected', 'edge_target_invalid')
    }
    const key = `${projectId}/${input.slug}`
    const created = !this.store.has(key)
    // links are ADDITIVE and identified by (to, relation), exactly like the Inkwell store (contract note on PagesPort.put)
    const prior = this.store.get(key)?.links ?? []
    const rel = (l: { toSlug: string; relation?: string }) => `${l.toSlug}|${l.relation ?? 'related'}`
    const incoming = input.links.map((l) => ({ toSlug: l.toSlug, relation: l.relation ?? 'related' }))
    const merged = [...prior.filter((p) => !incoming.some((n) => rel(n) === rel(p))), ...incoming]
    this.store.set(key, { ...input, links: merged })
    return { slug: input.slug, created, linksWritten: input.links.length }
  }
}

const env0 = (): PageEnvelope => ({ owner: 'agent-1', writer: 'agent-1', tier: 'project', purpose: 'decision', version: 1, writtenAt: '2026-10-15T00:00:00.000Z' })
const input = (slug: string, over: Partial<PagePutInput> = {}): PagePutInput => ({
  slug, title: `Title ${slug}`, summary: 'a summary', tags: ['alpha'], links: [], envelope: env0(), ...over,
})

interface Ctx { port: PagesPort; close: () => void; env?: Env }
const ADAPTERS: { name: string; make: () => Promise<Ctx> }[] = [
  { name: 'fake in-memory adapter', make: async () => ({ port: new FakePagesPort(), close: () => {} }) },
  {
    name: 'inkwell wiki adapter',
    make: async () => {
      const harness = createSqliteD1()
      for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) harness.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
      const fake = new FakeInternalWiki({ [TENANT]: SECRET })
      const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
      harness.sqlite.exec(
        `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at) VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${encrypted}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z')`,
      )
      const env = { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: fake.asFetcher() } as unknown as Env
      return { port: createInkwellPagesPort(env), close: () => harness.close(), env }
    },
  },
]

for (const adapter of ADAPTERS) {
  describe(`PagesPort contract: ${adapter.name}`, () => {
    let ctx: Ctx | undefined
    afterEach(() => { ctx?.close(); ctx = undefined })

    it('get of an absent page is null, not an error', async () => {
      ctx = await adapter.make()
      expect(await ctx.port.get(PROJECT, 'nothing-here')).toBeNull()
    })

    it('put creates, a second put to the same slug updates (idempotent identity)', async () => {
      ctx = await adapter.make()
      expect((await ctx.port.put(PROJECT, input('first-page'))).created).toBe(true)
      expect((await ctx.port.put(PROJECT, input('first-page', { title: 'Renamed' }))).created).toBe(false)
      expect((await ctx.port.get(PROJECT, 'first-page'))?.title).toBe('Renamed')
    })

    it('round-trips summary, caller tags (envelope stamps NOT mixed in) and the stamped envelope', async () => {
      ctx = await adapter.make()
      await ctx.port.put(PROJECT, input('round-trip', { summary: 'S', tags: ['a', 'b'], envelope: { ...env0(), owner: 'o1', writer: 'w2', tier: 'squad', purpose: 'runbook', version: 7 } }))
      const got = await ctx.port.get(PROJECT, 'round-trip')
      expect(got?.summary).toBe('S')
      expect(got?.tags).toEqual(['a', 'b'])
      expect(got?.envelope).toEqual({ owner: 'o1', writer: 'w2', tier: 'squad', purpose: 'runbook', version: 7, writtenAt: '2026-10-15T00:00:00.000Z' })
    })

    it('links are written and read back; an edge to a missing page is rejected, writing nothing', async () => {
      ctx = await adapter.make()
      await ctx.port.put(PROJECT, input('target-page'))
      const res = await ctx.port.put(PROJECT, input('source-page', { links: [{ toSlug: 'target-page', relation: 'depends-on' }] }))
      expect(res.linksWritten).toBe(1)
      expect((await ctx.port.get(PROJECT, 'source-page'))?.links).toEqual([{ toSlug: 'target-page', relation: 'depends-on' }])
      await expect(ctx.port.put(PROJECT, input('dangling-page', { links: [{ toSlug: 'no-such-page' }] }))).rejects.toMatchObject({ kind: 'rejected' })
      expect(await ctx.port.get(PROJECT, 'dangling-page')).toBeNull()
    })
  })
}

for (const adapter of ADAPTERS) {
  describe(`PagesPort contract (links + reads): ${adapter.name}`, () => {
    let ctx: Ctx | undefined
    afterEach(() => { ctx?.close(); ctx = undefined })

    it('links are ADDITIVE: a later put without them keeps them; a changed relation adds a second link', async () => {
      ctx = await adapter.make()
      await ctx.port.put(PROJECT, input('target-one'))
      await ctx.port.put(PROJECT, input('linker-page', { links: [{ toSlug: 'target-one', relation: 'depends-on' }] }))
      await ctx.port.put(PROJECT, input('linker-page', { links: [] }))
      expect((await ctx.port.get(PROJECT, 'linker-page'))?.links).toEqual([{ toSlug: 'target-one', relation: 'depends-on' }])
      await ctx.port.put(PROJECT, input('linker-page', { links: [{ toSlug: 'target-one', relation: 'blocks' }] }))
      const rels = ((await ctx.port.get(PROJECT, 'linker-page'))?.links ?? []).map((l) => l.relation).sort()
      expect(rels).toEqual(['blocks', 'depends-on'])
    })

    it('an INCOMING link is not reported as this page\'s own link', async () => {
      ctx = await adapter.make()
      await ctx.port.put(PROJECT, input('anchor-page'))
      await ctx.port.put(PROJECT, input('pointer-page', { links: [{ toSlug: 'anchor-page' }] }))
      expect((await ctx.port.get(PROJECT, 'anchor-page'))?.links).toEqual([])
      expect((await ctx.port.get(PROJECT, 'pointer-page'))?.links).toEqual([{ toSlug: 'anchor-page', relation: 'related' }])
    })
  })
}

describe('Inkwell adapter against the real-route rules the fake now mirrors', () => {
  let ctx: Ctx | undefined
  afterEach(() => { ctx?.close(); ctx = undefined })
  const inkwell = ADAPTERS[1]
  it('a link to a service-OWNED target is written (the keyless-public refusal is pinned in the MCP tests, which can seed one)', async () => {
    ctx = await inkwell.make()
    await ctx.port.put(PROJECT, input('owned-target'))
    expect((await ctx.port.put(PROJECT, input('src-page', { links: [{ toSlug: 'owned-target' }] }))).linksWritten).toBe(1)
  })
  it('purpose is stored in topic_type and survives the 32-char cap', async () => {
    ctx = await inkwell.make()
    const purpose = 'p'.repeat(32)
    await ctx.port.put(PROJECT, input('purpose-page', { envelope: { ...env0(), purpose } }))
    expect((await ctx.port.get(PROJECT, 'purpose-page'))?.envelope?.purpose).toBe(purpose)
  })
  it('title and summary come back whitespace-collapsed (the store normalises)', async () => {
    ctx = await inkwell.make()
    await ctx.port.put(PROJECT, input('space-page', { title: 'A   B', summary: 'one\n two\t three' }))
    const got = await ctx.port.get(PROJECT, 'space-page')
    expect(got?.title).toBe('A B')
    expect(got?.summary).toBe('one two three')
  })
})

describe('getProjectWikiTopic (wiki-client) response handling', () => {
  // one migrated DB + a swappable upstream handler for the whole describe
  let harness: SqliteD1Harness
  let env: Env
  let handler: (req: Request) => Response | Promise<Response> = () => Response.json({})
  beforeAll(async () => {
    harness = createSqliteD1()
    for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) harness.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
    const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
    harness.sqlite.exec(`INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at) VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${encrypted}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z')`)
    const svc = { fetch: async (i: RequestInfo | URL, init?: RequestInit) => handler(i instanceof Request ? i : new Request(i, init)) } as unknown as Fetcher
    env = { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: svc } as unknown as Env
  }, 120_000)
  afterAll(() => harness?.close())
  const run = async (h: (req: Request) => Response | Promise<Response>) => {
    handler = h
    return getProjectWikiTopic(env, PROJECT, 'some-page').then((v) => ({ v }), (e: unknown) => ({ e }))
  }
  it('404 -> null; 200 with a topic -> topic+edges; the request is a GET with tenant_slug and project', async () => {
    let seen = ''
    const ok = await run((req) => { seen = `${req.method} ${new URL(req.url).pathname}?${new URL(req.url).searchParams.toString()}`; return Response.json({ topic: { slug: 'some-page', title: 'T', tags: [], topic_type: 'x', description: '' }, edges: [] }) })
    expect(ok).toMatchObject({ v: { topic: { slug: 'some-page' }, edges: [] } })
    expect(seen).toBe(`GET /api/internal/wiki/topics/some-page?tenant_slug=${TENANT}&project=${PROJECT}`)
    expect(await run(() => Response.json({ error: 'not_found' }, { status: 404 }))).toEqual({ v: null })
  })
  it('malformed bodies and 5xx collapse to wiki_unavailable; a 4xx rejection is a WikiRequestError', async () => {
    for (const body of [() => Response.json({ edges: [] }), () => Response.json({ topic: 'str', edges: [] }), () => Response.json({ topic: { slug: 'x' } }), () => new Response('not json', { status: 200 })]) {
      expect(await run(body)).toMatchObject({ e: expect.objectContaining({ name: 'WikiClientError' }) })
    }
    expect(await run(() => new Response('boom', { status: 500 }))).toMatchObject({ e: expect.objectContaining({ name: 'WikiClientError' }) })
    expect(await run(() => Response.json({ error: 'invalid_slug' }, { status: 400 }))).toMatchObject({ e: expect.objectContaining({ name: 'WikiRequestError' }) })
  })
  it('adapter put: every upstream edge-target refusal vocabulary collapses to ONE code; other 4xx is a generic rejection; a 409 never leaks existing_project', async () => {
    handler = () => Response.json({}) // placeholder
    const port = createInkwellPagesPort(env)
    for (const code of ['edge_target_invalid', 'cross_project_edge_refused', 'edge_target_unpublished']) {
      handler = () => Response.json({ error: code }, { status: 400 })
      await expect(port.put(PROJECT, input('some-page'))).rejects.toMatchObject({ kind: 'rejected', code: 'edge_target_invalid' })
    }
    handler = () => Response.json({ error: 'title too short' }, { status: 400 })
    await expect(port.put(PROJECT, input('some-page'))).rejects.toMatchObject({ kind: 'rejected', code: 'request_rejected' })
    handler = () => Response.json({ error: 'topic_owned_by_other_project', existing_project: 'secret-project' }, { status: 409 })
    const err: unknown = await port.put(PROJECT, input('some-page')).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'conflict', code: 'slug_unavailable' })
    expect(JSON.stringify(err)).not.toContain('secret-project')
    expect(String((err as Error).message)).not.toContain('secret-project')
    handler = () => new Response('x', { status: 500 })
    await expect(port.put(PROJECT, input('some-page'))).rejects.toMatchObject({ kind: 'unavailable' })
  })
  it('an invalid slug never reaches the network', async () => {
    let called = false
    handler = () => { called = true; return Response.json({}) }
    await expect(getProjectWikiTopic(env, PROJECT, 'Bad Slug')).rejects.toMatchObject({ name: 'WikiClientError' })
    expect(called).toBe(false)
  })
})

describe('inkwell adapter envelope encoding', () => {
  it('encode/decode round-trips and a half-stamped tag set decodes to null (not one of ours)', () => {
    const e = env0()
    expect(decodeEnvelope(encodeEnvelopeTags(e), e.purpose)).toEqual(e)
    expect(decodeEnvelope(encodeEnvelopeTags(e).filter((t) => !t.startsWith('v:')), e.purpose)).toBeNull()
    expect(decodeEnvelope(['owner:x', 'tier:public', 'v:1', 'by:x', 'at:y'], 'p')).toBeNull() // tier outside the enum
    expect(decodeEnvelope(['owner:x', 'tier:project', 'v:0', 'by:x', 'at:y'], 'p')).toBeNull() // version >= 1
  })
  it('refuses a stamp the upstream would silently slice at 48 chars', () => {
    expect(() => encodeEnvelopeTags({ ...env0(), owner: 'x'.repeat(60) })).toThrow(PagesPortError)
  })
})

describe('validatePageWrite', () => {
  const ok = { slug: 'good-slug', title: 'Good', summary: 'sum', purpose: 'decision', tier: 'project', tags: undefined, links: undefined }
  it('accepts the minimal valid shape', () => { expect(validatePageWrite(ok).ok).toBe(true) })
  it.each([
    ['slug too short', { slug: 'ab' }],
    ['slug uppercase', { slug: 'Bad-Slug' }],
    ['slug 64 chars', { slug: 'a'.repeat(64) }],
    ['slug leading dash', { slug: '-abc' }],
    ['title too short', { title: 'x' }],
    ['title too long', { title: 'x'.repeat(121) }],
    ['empty summary', { summary: '   ' }],
    ['summary 501', { summary: 'x'.repeat(501) }],
    ['no purpose', { purpose: undefined }],
    ['bad purpose', { purpose: 'Not Kebab' }],
    ['no tier', { tier: undefined }],
    ['tier outside enum', { tier: 'public' }],
    ['too many tags', { tags: ['1', '2', '3', '4', '5', '6', '7', '8'] }],
    ['link to self', { links: [{ to_slug: 'good-slug' }] }],
    ['link bad slug', { links: [{ to_slug: 'BAD' }] }],
    ['too many links', { links: Array.from({ length: 21 }, (_, i) => ({ to_slug: `link-${i}-x` })) }],
  ])('refuses %s', (_n, over) => {
    const r = validatePageWrite({ ...ok, ...over })
    expect(r.ok).toBe(false)
  })
  it('whitespace is collapsed BEFORE length checks (multi-line input is stored as one line)', () => {
    const r = validatePageWrite({ ...ok, title: '  A \n B  ', summary: 'x\n'.repeat(250) })
    expect(r.ok && r.value.title).toBe('A B')
    expect(r.ok && r.value.summary.length).toBe(499) // 250 x's + 249 single spaces
  })
  it('tags are deduplicated and links are deduplicated by target', () => {
    const r = validatePageWrite({ ...ok, tags: ['a', 'a', ' a ', 'b'], links: [{ to_slug: 'other-page' }, { to_slug: 'other-page', relation: 'blocks' }] })
    expect(r.ok && r.value.tags).toEqual(['a', 'b'])
    expect(r.ok && r.value.links).toEqual([{ toSlug: 'other-page' }])
  })
  it.each([['Bad Rel'], ['x'.repeat(33)], ['-lead'], ['UPPER']])('relation %s is refused', (relation) => {
    expect(validatePageWrite({ ...ok, links: [{ to_slug: 'other-page', relation }] }).ok).toBe(false)
  })
  it('relation of exactly 32 chars and 1 char are accepted', () => {
    expect(validatePageWrite({ ...ok, links: [{ to_slug: 'other-page', relation: 'r'.repeat(32) }] }).ok).toBe(true)
    expect(validatePageWrite({ ...ok, links: [{ to_slug: 'other-page', relation: 'r' }] }).ok).toBe(true)
  })
  it('purpose is capped at 32 (the store cuts topic_type there): 32 passes, 33 is refused', () => {
    expect(validatePageWrite({ ...ok, purpose: 'p'.repeat(32) }).ok).toBe(true)
    expect(validatePageWrite({ ...ok, purpose: 'p'.repeat(33) }).ok).toBe(false)
  })
  it('summary of exactly 500 passes, not truncated', () => {
    const r = validatePageWrite({ ...ok, summary: 'x'.repeat(500) })
    expect(r.ok && r.value.summary.length).toBe(500)
  })
  it.each(['project-card-abc', 'mupot-x-y', 'system-notes'])('reserved slug %s is a 403', (slug) => {
    expect(validatePageWrite({ ...ok, slug })).toMatchObject({ ok: false, status: 403, error: 'reserved_slug' })
  })
  it.each(['owner:evil', 'TIER:squad', 'v:99', 'by:someone', 'at:now'])('envelope-forging tag %s is refused', (tag) => {
    expect(validatePageWrite({ ...ok, tags: [tag] })).toMatchObject({ ok: false, error: 'reserved_tag' })
  })
})

describe('writePage over a fake port (stamping, versions, ownership)', () => {
  // One migrated DB for the describe (applying ~200 migrations per test is the slow part).
  let shared: SqliteD1Harness
  beforeAll(() => {
    shared = createSqliteD1()
    for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) shared.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
  }, 120_000)
  afterAll(() => shared?.close())
  const mk = () => {
    shared.sqlite.exec('DELETE FROM page_versions')
    return { env: { DB: shared.db } as unknown as Env, port: new FakePagesPort() }
  }
  const valid = (over: Partial<ValidPageWrite> = {}): ValidPageWrite => ({ slug: 'doc-one', title: 'Doc', summary: 's', purpose: 'decision', tier: 'project', tags: [], links: [], ...over })
  const t = (iso: string) => () => new Date(iso)

  it('stamps writer/owner/version/writtenAt from the server and counts versions up', async () => {
    const { env, port } = mk()
    const a = await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid(), now: t('2026-10-15T01:00:00.000Z') })
    expect(a).toMatchObject({ ok: true, created: true, version: 1, envelope: { owner: 'agent-a', writer: 'agent-a', writtenAt: '2026-10-15T01:00:00.000Z' } })
    const b = await writePage(env, port, { projectId: PROJECT, writer: 'agent-b', input: valid({ title: 'Doc v2' }), now: t('2026-10-15T02:00:00.000Z') })
    expect(b).toMatchObject({ ok: true, created: false, version: 2, envelope: { owner: 'agent-a', writer: 'agent-b', writtenAt: '2026-10-15T02:00:00.000Z' } })
    const row = await env.DB.prepare('SELECT version FROM page_versions WHERE project_id = ? AND slug = ?').bind(PROJECT, 'doc-one').first<{ version: number }>()
    expect(row).toEqual({ version: 2 })
  })

  it('a visible page WITHOUT our stamp (dashboard card / admin content) is refused', async () => {
    const { env, port } = mk()
    port.store.set(`${PROJECT}/doc-two`, { ...input('doc-two'), envelope: undefined as unknown as PageEnvelope })
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid({ slug: 'doc-two' }) })).toMatchObject({ ok: false, status: 409, error: 'slug_unavailable' })
  })

  it('REBUILD: owner and version come from the stamped TEXT when the counter row is missing', async () => {
    const { env, port } = mk()
    port.store.set(`${PROJECT}/doc-one`, input('doc-one', { envelope: { ...env0(), owner: 'agent-a', version: 40 } }))
    const r = await writePage(env, port, { projectId: PROJECT, writer: 'agent-b', input: valid() })
    expect(r).toMatchObject({ ok: true, created: false, version: 41, envelope: { owner: 'agent-a', writer: 'agent-b' } })
  })

  it('version = MAX(counter, text) + 1 in both directions', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() }) // text v1, counter 1
    await env.DB.prepare('UPDATE page_versions SET version = 10').run() // counter ahead of text
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })).toMatchObject({ ok: true, version: 11 })
    const rec = port.store.get(`${PROJECT}/doc-one`)
    if (rec) port.store.set(`${PROJECT}/doc-one`, { ...rec, envelope: { ...rec.envelope, version: 50 } }) // text ahead of counter
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })).toMatchObject({ ok: true, version: 51 })
  })

  it('the counter row carries NO ownership: deleting it changes nothing about who owns the page', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })
    await env.DB.prepare('DELETE FROM page_versions').run()
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-b', input: valid() })).toMatchObject({ ok: true, envelope: { owner: 'agent-a' } })
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('page_versions')").all<{ name: string }>()
    expect((cols.results ?? []).map((c) => c.name).sort()).toEqual(['project_id', 'slug', 'version'])
  })

  it('P1-A: a failed put leaves NO row, so a refused write cannot squat ownership', async () => {
    const { env, port } = mk()
    const failing: PagesPort = { id: 'f', get: async () => null, put: async () => { throw new PagesPortError('rejected', 'edge_target_invalid') } }
    expect(await writePage(env, failing, { projectId: PROJECT, writer: 'attacker', input: valid() })).toMatchObject({ ok: false, status: 400 })
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM page_versions').first<{ n: number }>()
    expect(n?.n).toBe(0)
    const v = await writePage(env, port, { projectId: PROJECT, writer: 'victim', input: valid() })
    expect(v).toMatchObject({ ok: true, created: true, version: 1, envelope: { owner: 'victim' } })
    expect((await port.get(PROJECT, 'doc-one'))?.envelope?.owner).toBe('victim')
  })

  it('P1-A: a failed UPDATE changes no row (version and writer stay)', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })
    const failing: PagesPort = { id: 'f', get: (p, s) => port.get(p, s), put: async () => { throw new PagesPortError('unavailable', 'wiki_unavailable') } }
    expect(await writePage(env, failing, { projectId: PROJECT, writer: 'agent-b', input: valid() })).toMatchObject({ ok: false, status: 503 })
    const row = await env.DB.prepare('SELECT version FROM page_versions WHERE slug = ?').bind('doc-one').first<{ version: number }>()
    expect(row).toEqual({ version: 1 })
  })

  it('racing writers that stamped the same version still advance the counter, so the next stamp is distinct', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })
    const stale: PagesPort = { id: 'stale', get: async () => port.get(PROJECT, 'doc-one'), put: async () => ({ slug: 'doc-one', created: false, linksWritten: 0 }) }
    await Promise.all([
      writePage(env, stale, { projectId: PROJECT, writer: 'agent-b', input: valid() }),
      writePage(env, stale, { projectId: PROJECT, writer: 'agent-c', input: valid() }),
    ])
    const row = await env.DB.prepare('SELECT version FROM page_versions WHERE slug = ?').bind('doc-one').first<{ version: number }>()
    expect(row?.version).toBe(3)
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })).toMatchObject({ ok: true, version: 4 })
  })

  it('P2-1: a page of ours that the store no longer shows is refused, never re-put (no silent republish)', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid() })
    port.store.clear()
    let puts = 0
    const spy: PagesPort = { id: 's', get: (p, s) => port.get(p, s), put: async (p, i) => { puts++; return port.put(p, i) } }
    expect(await writePage(env, spy, { projectId: PROJECT, writer: 'agent-b', input: valid() })).toMatchObject({ ok: false, status: 409, error: 'slug_unavailable' })
    expect(puts).toBe(0)
  })

  it('only the owner may change the tier', async () => {
    const { env, port } = mk()
    await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid({ tier: 'squad' }) })
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-b', input: valid({ tier: 'project' }) })).toMatchObject({ ok: false, status: 403, error: 'tier_change_owner_only' })
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-b', input: valid({ tier: 'squad' }) })).toMatchObject({ ok: true })
    expect(await writePage(env, port, { projectId: PROJECT, writer: 'agent-a', input: valid({ tier: 'project' }) })).toMatchObject({ ok: true })
  })

  it('maps port failures to typed statuses without leaking detail', async () => {
    const { env } = mk()
    const boom = (kind: 'conflict' | 'rejected' | 'unavailable', code: string): PagesPort => ({ id: 'x', get: async () => null, put: async () => { throw new PagesPortError(kind, code) } })
    expect(await writePage(env, boom('conflict', 'slug_unavailable'), { projectId: PROJECT, writer: 'w', input: valid() })).toMatchObject({ status: 409, error: 'slug_unavailable' })
    expect(await writePage(env, boom('rejected', 'edge_target_invalid'), { projectId: PROJECT, writer: 'w', input: valid({ slug: 'doc-two' }) })).toMatchObject({ status: 400, error: 'edge_target_invalid' })
    expect(await writePage(env, boom('rejected', 'request_rejected'), { projectId: PROJECT, writer: 'w', input: valid({ slug: 'doc-three' }) })).toMatchObject({ status: 502 })
    expect(await writePage(env, boom('unavailable', 'wiki_unavailable'), { projectId: PROJECT, writer: 'w', input: valid({ slug: 'doc-four' }) })).toMatchObject({ status: 503 })
  })
})
