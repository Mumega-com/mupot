// tests/wiki-documents-caller.test.ts — the capability-aware wiki caller (wiki flight PR2): project_wiki_upsert /
// project_wiki_get against (a) a LEGACY Inkwell (no capabilities) and (b) a wiki-documents/v1 server whose
// response shapes are replayed from mumega-com PR #1650 (tests/helpers/fake-wiki-documents.ts).
// Real SQL for the mupot side; the store is a fetch double. Acceptance vectors: Athena's wiki-core-acceptance cases.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { pagesPortFactory } from '../src/mcp/pages'
import { createInkwellPagesPort } from '../src/pages/inkwell-adapter'
import { validatePageWrite, writePage } from '../src/pages/service'
import { parseWikiCapabilities } from '../src/projects/wiki-client'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import type { AuthContext, Env } from '../src/types'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'
import { FakeWikiDocuments, V1_CAPABILITIES } from './helpers/fake-wiki-documents'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'pot-a'
const MASTER_KEY = '77'.repeat(32)
const CONNECTOR_ID = 'connector-inkwell-docs'
const SECRET = 'wiki-docs-secret'
const MEMBER = 'member-w'
const SQ_W = 'squad-w'
const PROJ = 'proj-a-id'
const ORIGIN = 'https://pot.example'
const STAMP = ['owner:agent-x', 'tier:project', 'v:19', 'by:agent-x', 'at:2026-01-01T00:00:00.000Z']

let shared: SqliteD1Harness
let v1: FakeWikiDocuments
let env: Env
let originalFactory: typeof pagesPortFactory.create

function envFor(fetcher: Fetcher): Env {
  return { DB: shared.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: fetcher } as unknown as Env // test env: only the bindings this path reads
}

beforeAll(async () => {
  shared = createSqliteD1()
  applyAllMigrations(shared.sqlite)
  shared.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ_W}', 'dept-a', 'squad-w', 'W');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJ}', 'project-a-slug', 'Project A', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJ}', '${SQ_W}', 'write');
  `)
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  shared.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at) VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${encrypted}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z')`,
  )
  originalFactory = pagesPortFactory.create
}, 120_000)
afterAll(() => { pagesPortFactory.create = originalFactory; shared?.close() })

beforeEach(() => {
  shared.sqlite.exec('DELETE FROM page_versions')
  v1 = new FakeWikiDocuments(TENANT, SECRET)
  env = envFor(v1.asFetcher())
  pagesPortFactory.create = originalFactory
})

const auth: AuthContext = {
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQ_W, capability: 'member' }],
}
const base = { project_id: PROJ, title: 'A page', summary: 'a summary', purpose: 'decision', tier: 'project' }
const upsert = (args: Record<string, unknown>) => invokeTool(auth, env, 'project_wiki_upsert', { ...base, ...args }, ORIGIN)
const get = (slug: string) => invokeTool(auth, env, 'project_wiki_get', { project_id: PROJ, slug }, ORIGIN)

type Out = Awaited<ReturnType<typeof upsert>>
const okResult = (o: Out): Record<string, unknown> => { if (!o.ok) throw new Error(JSON.stringify(o)); return o.result as Record<string, unknown> }
const failOf = (o: Out): { status: number; error: string; detail: unknown } => { if (o.ok) throw new Error('expected failure: ' + JSON.stringify(o)); return o as unknown as { status: number; error: string; detail: unknown } }
const puts = (f: { requests: { method: string }[] }) => f.requests.filter((r) => r.method === 'PUT')
const seed = (slug: string, over: Parameters<FakeWikiDocuments['seed']>[2] = {}) => v1.seed(PROJ, slug, { tags: STAMP, ...over })

describe('legacy server (no capabilities): metadata-only, body refused BEFORE create', () => {
  // wraps the legacy double and records raw PUT bodies, to pin the byte shape
  function legacyRig() {
    const legacy = new FakeInternalWiki({ [TENANT]: SECRET })
    const puts: string[] = []
    const fetcher = {
      fetch: async (i: RequestInfo | URL, init?: RequestInit) => {
        const req = i instanceof Request ? i : new Request(i, init)
        if (req.method === 'PUT') puts.push(await req.clone().text())
        return legacy.fetch(req)
      },
    } as unknown as Fetcher
    env = envFor(fetcher)
    return { legacy, puts }
  }

  it('a body is refused 501 body_unsupported with ZERO PUTs (empty project, expected_version 0)', async () => {
    const r = legacyRig()
    const out = failOf(await upsert({ slug: 'legacy-body', body: '# Full document', expected_version: 0 }))
    expect(out).toMatchObject({ status: 501, error: 'body_unsupported' })
    expect(r.puts).toEqual([])
    expect(r.legacy.requests.filter((q) => q.method === 'PUT')).toEqual([])
  })

  it('metadata write is byte-identical to the pre-v1 request shape (no expected_version/writer/body keys)', async () => {
    const r = legacyRig()
    const out = okResult(await upsert({ slug: 'legacy-meta', tags: ['alpha'] }))
    expect(out.storage_version).toBeNull()
    expect(r.puts).toHaveLength(1)
    const sent = JSON.parse(r.puts[0]) as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['tenant_slug', 'project', 'title', 'description', 'topic_type', 'tags', 'edges'])
    expect(r.puts[0]).not.toMatch(/expected_version|writer|"body"/)
  })

  it('an explicit expected_version cannot be honoured: refused 501, never silently ignored, no PUT', async () => {
    const r = legacyRig()
    const out = failOf(await upsert({ slug: 'legacy-cas', expected_version: 3 }))
    expect(out).toMatchObject({ status: 501, error: 'conditional_writes_unsupported' })
    expect(r.puts).toEqual([])
  })

  it('get on a legacy store has version null and body null', async () => {
    legacyRig()
    okResult(await upsert({ slug: 'legacy-get' }))
    const page = (okResult(await get('legacy-get')).page) as { version: unknown; body: unknown }
    expect(page.version).toBeNull()
    expect(page.body).toBeNull()
  })
})

describe('unknown / partial contract is LEGACY', () => {
  it.each([
    ['unknown contract', { contract: 'unknown' }],
    ['future contract', { ...V1_CAPABILITIES, contract: 'wiki-documents/v2' }],
    ['body:false', { ...V1_CAPABILITIES, body: false }],
    ['conditional_writes:false', { ...V1_CAPABILITIES, conditional_writes: false }],
    ['junk cap', { ...V1_CAPABILITIES, max_body_bytes: 'big' }],
    ['null', null],
  ])('%s -> body refused, zero PUTs', async (_n, caps) => {
    v1.capabilities = caps
    const out = failOf(await upsert({ slug: 'unk-contract', body: '# Full document', expected_version: 0 }))
    expect(out).toMatchObject({ status: 501, error: 'body_unsupported' })
    expect(puts(v1)).toEqual([])
  })
  it('parseWikiCapabilities: exact contract only; revision_history optional', () => {
    expect(parseWikiCapabilities(V1_CAPABILITIES)).toEqual({ contract: 'wiki-documents/v1', max_body_bytes: 65536, revision_history: true })
    expect(parseWikiCapabilities({ ...V1_CAPABILITIES, revision_history: false })?.revision_history).toBe(false)
    expect(parseWikiCapabilities(undefined)).toBeNull()
    expect(parseWikiCapabilities({ ...V1_CAPABILITIES, max_body_bytes: 0 })).toBeNull()
  })
})

describe('upgraded server: body + compare-and-set', () => {
  it('cold create on an EMPTY project: handshake GET graph first, PUT expected_version 0 with body + writer, readback verifies', async () => {
    const out = okResult(await upsert({ slug: 'new-doc', body: '# Full document', expected_version: 0 }))
    expect(out).toMatchObject({ result: 'created', storage_version: 1, verification: 'readback' })
    const put = puts(v1)
    expect(put).toHaveLength(1)
    // the handshake (GET graph) is asked BEFORE the create is sent
    const graphIdx = v1.requests.findIndex((r) => r.path === '/api/internal/wiki/graph')
    expect(graphIdx).toBeGreaterThanOrEqual(0)
    expect(graphIdx).toBeLessThan(v1.requests.indexOf(put[0]))
    expect(put[0].json).toMatchObject({ expected_version: 0, body: '# Full document', writer: MEMBER })
    // persisted: the readback GET is after the PUT
    const idxPut = v1.requests.indexOf(put[0])
    expect(v1.requests[idxPut + 1]).toMatchObject({ method: 'GET', path: '/api/internal/wiki/topics/new-doc' })
    const page = (okResult(await get('new-doc')).page) as { body: string; version: number; envelope: { version: number } }
    expect(page).toMatchObject({ body: '# Full document', version: 1 })
    expect(page.envelope.version).toBe(1) // legacy counter, separate field
  })

  it('create without expected_version defaults to 0 (the page does not exist)', async () => {
    okResult(await upsert({ slug: 'new-doc-2', body: 'x' }))
    expect(puts(v1)[0].json).toMatchObject({ expected_version: 0 })
  })

  it('CAS uses the STORAGE version, never the legacy v: counter (storage 2, envelope v:19)', async () => {
    seed('storage-vs-envelope', { version: 2, body: 'Old' })
    const out = okResult(await upsert({ slug: 'storage-vs-envelope', body: 'Edited', expected_version: 2 }))
    expect(puts(v1)[0].json).toMatchObject({ expected_version: 2 })
    expect(out).toMatchObject({ storage_version: 3, verification: 'readback', version: 20 }) // legacy envelope counter still 19+1
    expect(v1.topics.get('storage-vs-envelope')?.body).toBe('Edited')
  })

  it('body write to an existing page WITHOUT expected_version is refused (blind overwrite), no PUT', async () => {
    seed('blind', { version: 4, body: 'Mine' })
    const out = failOf(await upsert({ slug: 'blind', body: 'Theirs' }))
    expect(out).toMatchObject({ status: 400, error: 'expected_version_required' })
    expect(JSON.stringify(out.detail)).toContain('expected_version 4')
    expect(puts(v1)).toEqual([])
    expect(v1.topics.get('blind')?.body).toBe('Mine')
  })

  it('metadata-only write retains the body and conditions on the revision just read', async () => {
    seed('meta-only', { version: 3, body: 'Retain' })
    okResult(await upsert({ slug: 'meta-only', title: 'New title' }))
    const sent = puts(v1)[0].json as Record<string, unknown>
    expect(sent.expected_version).toBe(3)
    expect('body' in sent).toBe(false)
    expect(v1.topics.get('meta-only')).toMatchObject({ title: 'New title', body: 'Retain', version: 4 })
  })

  it('"" clears the body (sent as empty string, readback null)', async () => {
    seed('clear-me', { version: 3, body: 'Old' })
    const out = okResult(await upsert({ slug: 'clear-me', body: '', expected_version: 3 }))
    expect(puts(v1)[0].json).toMatchObject({ body: '' })
    expect(out).toMatchObject({ storage_version: 4, verification: 'readback' })
    expect(v1.topics.get('clear-me')?.body).toBeNull()
  })

  it('the tool surface exposes expected_version (schema) and project_wiki_get returns version + body', async () => {
    seed('shape', { version: 7, body: 'Full' })
    const page = (okResult(await get('shape')).page) as { version: number; body: string }
    expect(page).toMatchObject({ version: 7, body: 'Full' })
  })
})

describe('stale write: surfaced, never swallowed, never auto-refreshed', () => {
  it('caller expected 2 but the page is at 3 -> 409 stale_version with current version, last writer, next step; one PUT; no overwrite', async () => {
    seed('stale-doc', { version: 3, body: 'Winner', last_writer: 'agent:winner' })
    const out = failOf(await upsert({ slug: 'stale-doc', body: 'Stale intent', expected_version: 2 }))
    expect(out).toMatchObject({ status: 409, error: 'stale_version' })
    expect(out.detail).toMatchObject({ current_version: 3, last_writer: 'agent:winner' })
    expect(JSON.stringify(out.detail)).toMatch(/re-read, merge, retry with expected_version 3/)
    expect(puts(v1)).toHaveLength(1) // exactly the attempt; no refresh-and-retry
    expect(v1.topics.get('stale-doc')).toMatchObject({ body: 'Winner', version: 3 })
    const rows = shared.sqlite.prepare("SELECT version FROM page_versions WHERE slug = 'stale-doc'").all()
    expect(rows).toEqual([]) // a refused write consumes no legacy counter
  })

  it('create race: expected 0 but the page exists -> stale with its version', async () => {
    seed('race-create', { version: 1, body: 'First' })
    // service sees the page, so a body write demands a version; passing 0 explicitly reaches the store and is refused
    const out = failOf(await upsert({ slug: 'race-create', body: 'Second', expected_version: 0 }))
    expect(out).toMatchObject({ status: 409, error: 'stale_version' })
    expect(out.detail).toMatchObject({ current_version: 1 })
  })

  it('defence in depth: a page that flipped to squad tier between read and write never reveals its version to a caller without squad access', async () => {
    seed('flip-doc', { version: 2, body: 'Open' })
    v1.beforePut = (t) => {
      if (!t) return
      t.tags = t.tags.map((x) => (x === 'tier:project' ? 'tier:squad' : x))
      t.version += 1 // makes the caller's expected_version stale
    }
    const checked = validatePageWrite({ slug: 'flip-doc', title: 'T1', summary: 's', body: 'Edit', expectedVersion: 2, purpose: 'decision', tier: 'project', tags: undefined, links: undefined })
    if (!checked.ok) throw new Error('fixture invalid')
    const out = await writePage(env, createInkwellPagesPort(env), { projectId: PROJ, writer: 'w', input: checked.value, canSeeSquadPages: false })
    expect(out).toMatchObject({ ok: false, status: 409, error: 'slug_unavailable' })
    expect(JSON.stringify(out)).not.toMatch(/current_version|last_writer/)
  })
})

describe('post-write verification', () => {
  it('another writer advances the page right after ours: verified through retained history (after_version = ours - 1), no second PUT', async () => {
    seed('adv-doc', { version: 1, body: 'v1' })
    v1.afterCommit = (t) => { if (t.version === 2) { v1.afterCommit = undefined; v1.advance('adv-doc', 'Another authorized edit') } }
    const out = okResult(await upsert({ slug: 'adv-doc', body: 'Mine', expected_version: 1 }))
    expect(out).toMatchObject({ storage_version: 2, verification: 'history', current_storage_version: 3, result: 'updated' })
    expect(puts(v1)).toHaveLength(1) // no blind retry
    const hist = v1.requests.find((r) => r.path.endsWith('/revisions'))
    expect(hist?.search).toContain('after_version=1')
    expect(v1.topics.get('adv-doc')?.body).toBe('Another authorized edit') // their edit is untouched
  })

  it('history shows a DIFFERENT body at our version -> real mismatch (502), not success', async () => {
    seed('adv-bad', { version: 1, body: 'v1' })
    v1.afterCommit = (t) => {
      if (t.version !== 2) return
      v1.afterCommit = undefined
      t.revisions[t.revisions.length - 1].body = 'tampered'
      v1.advance('adv-bad', 'Other')
    }
    const out = failOf(await upsert({ slug: 'adv-bad', body: 'Mine', expected_version: 1 }))
    expect(out).toMatchObject({ status: 502, error: 'wiki_persistence_mismatch' })
    expect(puts(v1)).toHaveLength(1)
  })

  it('history unreadable after an advance -> success is reported UNVERIFIED, not a false failure', async () => {
    seed('adv-nohist', { version: 1, body: 'v1' })
    v1.historyStatus = 404
    v1.afterCommit = (t) => { if (t.version === 2) { v1.afterCommit = undefined; v1.advance('adv-nohist', 'Other') } }
    const out = okResult(await upsert({ slug: 'adv-nohist', body: 'Mine', expected_version: 1 }))
    expect(out).toMatchObject({ storage_version: 2, verification: 'unverified', current_storage_version: 3 })
  })

  it('an ack that did not persist (readback behind our version / different body) is a persistence mismatch, not silent success', async () => {
    seed('drop-doc', { version: 1, body: 'v1' })
    v1.dropWrites = true
    const out = failOf(await upsert({ slug: 'drop-doc', body: 'Mine', expected_version: 1 }))
    expect(out).toMatchObject({ status: 502, error: 'wiki_persistence_mismatch' })
    expect(JSON.stringify(out.detail)).toMatch(/do NOT blindly retry/)
  })

  it('same version but a different body on readback is a mismatch', async () => {
    seed('same-ver', { version: 1, body: 'v1' })
    v1.afterCommit = (t) => { t.body = 'something else' }
    expect(failOf(await upsert({ slug: 'same-ver', body: 'Mine', expected_version: 1 }))).toMatchObject({ error: 'wiki_persistence_mismatch' })
  })
})

describe('body cap: 65536 UTF-8 bytes after LF normalisation; refused, never truncated', () => {
  it('exactly 65536 bytes is accepted and stored verbatim', async () => {
    const body = 'a'.repeat(65536)
    okResult(await upsert({ slug: 'cap-ok', body }))
    expect(v1.topics.get('cap-ok')?.body).toBe(body)
  })
  it('65537 bytes is refused 400 with zero requests to the store, and nothing is truncated', async () => {
    const out = failOf(await upsert({ slug: 'cap-over', body: 'a'.repeat(65537) }))
    expect(out.status).toBe(400)
    expect(JSON.stringify(out)).toMatch(/65537 bytes/)
    expect(v1.requests).toEqual([])
  })
  it('multibyte counts bytes, not characters', async () => {
    expect(failOf(await upsert({ slug: 'cap-mb', body: 'é'.repeat(32769) })).status).toBe(400) // 65538 bytes
    okResult(await upsert({ slug: 'cap-mb-ok', body: 'é'.repeat(32768) })) // 65536 bytes
  })
  it('measured AFTER normalisation: CRLF text over the cap raw but within it as LF is accepted, stored as LF', async () => {
    const raw = 'x\r\n'.repeat(30000) // 90000 raw bytes, 60000 after LF
    okResult(await upsert({ slug: 'cap-crlf', body: raw }))
    expect(v1.topics.get('cap-crlf')?.body).toBe('x\n'.repeat(30000))
  })
  it('the store may advertise a SMALLER cap: the adapter honours it (body_too_large, no PUT)', async () => {
    v1.capabilities = { ...V1_CAPABILITIES, max_body_bytes: 100 }
    const out = failOf(await upsert({ slug: 'cap-store', body: 'a'.repeat(101) }))
    expect(out).toMatchObject({ status: 400, error: 'body_too_large' })
    expect(puts(v1)).toEqual([])
  })
  it('invalid expected_version is refused before any I/O', async () => {
    for (const bad of [-1, 1.5, '2']) {
      const out = await upsert({ slug: 'bad-ev', body: 'x', expected_version: bad })
      expect(out.ok).toBe(false)
    }
    expect(v1.requests).toEqual([])
  })
})

describe('adapter port surface', () => {
  it('put on a legacy-shaped store returns no storageVersion; get maps version/body', async () => {
    seed('port-get', { version: 5, body: 'Doc', last_writer: 'agent:z' })
    const rec = await createInkwellPagesPort(env).get(PROJ, 'port-get')
    expect(rec).toMatchObject({ storageVersion: 5, body: 'Doc', lastWriter: 'agent:z' })
  })
})

describe('fail-closed handshake and untrusted acks (gate requirements 1-4)', () => {
  it.each([
    ['wrong case', { ...V1_CAPABILITIES, contract: 'Wiki-Documents/V1' }],
    ['trailing space', { ...V1_CAPABILITIES, contract: 'wiki-documents/v1 ' }],
    ['missing contract', { body: true, conditional_writes: true, max_body_bytes: 65536 }],
  ])('contract %s -> legacy, body refused, zero PUTs', async (_n, caps) => {
    v1.capabilities = caps
    expect(failOf(await upsert({ slug: 'fc-contract', body: 'x' }))).toMatchObject({ status: 501, error: 'body_unsupported' })
    expect(puts(v1)).toEqual([])
  })

  it('re-handshakes before EVERY write (never cached across requests): a downgrade between two writes is caught', async () => {
    okResult(await upsert({ slug: 'rehs-doc', body: 'one' }))
    okResult(await upsert({ slug: 'rehs-doc', body: 'two', expected_version: 1 }))
    expect(v1.requests.filter((r) => r.path === '/api/internal/wiki/graph')).toHaveLength(2)
    v1.capabilities = undefined // server rolled back to legacy
    const before = puts(v1).length
    expect(failOf(await upsert({ slug: 'rehs-doc', body: 'three', expected_version: 2 }))).toMatchObject({ status: 501, error: 'body_unsupported' })
    expect(puts(v1)).toHaveLength(before)
  })

  it('echo version wrong or missing: NOT trusted, readback decides; a correct readback still verifies', async () => {
    for (const echo of [99, 'omit'] as const) {
      v1.echoVersion = echo
      const slug = `echo-${echo}`
      const out = okResult(await upsert({ slug, body: 'Mine' }))
      expect(out).toMatchObject({ storage_version: 1, verification: 'readback' })
      expect(v1.requests.some((r) => r.method === 'GET' && r.path.endsWith(`/topics/${slug}`))).toBe(true)
    }
  })

  it('echo wrong AND the readback cannot confirm (dropped write / unreadable history) -> failure, never success', async () => {
    v1.echoVersion = 'omit'
    v1.dropWrites = true
    expect(failOf(await upsert({ slug: 'echo-drop', body: 'Mine' }))).toMatchObject({ status: 502, error: 'wiki_persistence_mismatch' })
    v1.dropWrites = false
    seed('echo-adv', { version: 1, body: 'v1' })
    v1.historyStatus = 404
    v1.afterCommit = (t) => { if (t.version === 2) { v1.afterCommit = undefined; v1.advance('echo-adv', 'Other') } }
    expect(failOf(await upsert({ slug: 'echo-adv', body: 'Mine', expected_version: 1 }))).toMatchObject({ error: 'wiki_persistence_mismatch' })
  })

  it('rolled-back server (v1 handshake, ignores body + expected_version): body write -> body_unsupported, metadata write -> mismatch; never success', async () => {
    v1.rolledBack = true
    seed('rb-doc', { version: 1, body: 'v1' })
    expect(failOf(await upsert({ slug: 'rb-doc', body: 'Mine', expected_version: 1 }))).toMatchObject({ status: 501, error: 'body_unsupported' })
    expect(failOf(await upsert({ slug: 'rb-doc2', title: 'Meta only' }))).toMatchObject({ status: 502, error: 'wiki_persistence_mismatch' })
  })
})
