// tests/mcp-project-wiki-upsert.test.ts — project_wiki_upsert / project_wiki_get on the real D1 harness
// (all migrations) with the FakeInternalWiki double standing in for the Inkwell internal endpoint.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { stampableId } from '../src/mcp/pages'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'

const TENANT = 'pot-a'
const MASTER_KEY = '66'.repeat(32)
const CONNECTOR_ID = 'connector-inkwell-upsert'
const SECRET = 'upsert-secret-909'
const MEMBER = 'member-w'
const AGENT = 'agent-writer-1'
const SQ_W = 'squad-w' // write on project A
const SQ_R = 'squad-r' // read on project A
const SQ_O = 'squad-o' // no access
const PROJ = 'proj-a-id'
const OTHER = 'proj-b-id'
const ORIGIN = 'https://pot.example'

interface Rig { harness: SqliteD1Harness; fake: FakeInternalWiki; env: Env; puts: Record<string, unknown>[] }

// One migrated DB for the whole file (applying ~200 migrations per test is the slow part); each test
// gets a fresh FakeInternalWiki + an empty page_versions table, so tests stay independent.
let shared: SqliteD1Harness
let encryptedSecret: string

async function rig(): Promise<Rig> {
  const harness = shared
  harness.sqlite.exec('DELETE FROM page_versions')
  const fake = new FakeInternalWiki({ [TENANT]: SECRET })
  const puts: Record<string, unknown>[] = []
  const recording = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.method === 'PUT') puts.push((await req.clone().json()) as Record<string, unknown>)
      return fake.fetch(req)
    },
  } as unknown as Fetcher
  const env = { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY, INKWELL_API_URL: 'https://inkwell-api.test', INKWELL_SVC: recording } as unknown as Env
  return { harness, fake, env, puts }
}

beforeAll(async () => {
  shared = createSqliteD1()
  for (const f of readdirSync(join(__dirname, '..', 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    shared.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
  }
  shared.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ_W}', 'dept-a', 'squad-w', 'W'), ('${SQ_R}', 'dept-a', 'squad-r', 'R'), ('${SQ_O}', 'dept-a', 'squad-o', 'O');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJ}', 'project-a-slug', 'Project A', 'active'), ('${OTHER}', 'project-b-slug', 'Project B', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${PROJ}', '${SQ_W}', 'write'), ('${PROJ}', '${SQ_R}', 'read'), ('${OTHER}', '${SQ_W}', 'write');
  `)
  encryptedSecret = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  shared.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at) VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'w', '${encryptedSecret}', NULL, 'pot', NULL, 't', '2026-01-01T00:00:00Z')`,
  )
}, 120_000)
afterAll(() => shared?.close())

const auth = (squad: string, capability: 'observer' | 'member' | 'lead' = 'member', over: Partial<AuthContext> = {}): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: squad, capability }], ...over,
})
const attached = (squad: string, ceiling: 'member' | 'lead' | 'full', capability: 'observer' | 'member' = 'member'): AuthContext =>
  auth(squad, capability, {
    boundAgentId: AGENT,
    seatBinding: { seatId: 's1', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId: MEMBER, source: 'handle', attached: { attachmentId: 'att-1', admissionId: 'adm-1', agentId: AGENT, seatAgentId: 'seat-agent', ceiling } },
  })

const base = { project_id: PROJ, slug: 'design-notes', title: 'Design notes', summary: 'what we decided', purpose: 'decision', tier: 'project' }
const upsert = (a: AuthContext, env: Env, args: Record<string, unknown>) => invokeTool(a, env, 'project_wiki_upsert', args, ORIGIN)
const get = (a: AuthContext, env: Env, args: Record<string, unknown>) => invokeTool(a, env, 'project_wiki_get', args, ORIGIN)
type Out = Awaited<ReturnType<typeof invokeTool>>
const status = (o: Out) => (o as { status: number }).status
const errName = (o: Out) => JSON.stringify(o)

describe('project_wiki_upsert / project_wiki_get', () => {
  let r: Rig | undefined

  it('happy create then update: same slug is idempotent, version counts up, stamps are server-side', async () => {
    r = await rig()
    const a = await upsert(auth(SQ_W), r.env, { ...base, links: [], tags: ['alpha'] })
    expect(a.ok).toBe(true)
    expect(a.result).toMatchObject({ project_id: PROJ, slug: 'design-notes', result: 'created', version: 1, owner: MEMBER, writer: MEMBER, tier: 'project' })
    expect((a.result as { url: string }).url).toBe(`/projects/${PROJ}/wiki#wiki-topic-design-notes`)
    const b = await upsert(auth(SQ_W), r.env, { ...base, title: 'Design notes 2' })
    expect(b.result).toMatchObject({ result: 'updated', version: 2 })
    const g = await get(auth(SQ_R, 'observer'), r.env, { project_id: PROJ, slug: 'design-notes' })
    expect(g.ok).toBe(true)
    expect((g.result as { page: { title: string; envelope: { version: number; owner: string; purpose: string } } }).page).toMatchObject({ title: 'Design notes 2', envelope: { version: 2, owner: MEMBER, purpose: 'decision' } })
  })

  it('the PUT sent upstream carries project.id, purpose as topic_type and the stamps as tags', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, { ...base, tags: ['alpha'] })
    expect(r.puts).toHaveLength(1)
    const put = r.puts[0]
    expect(put.project).toBe(PROJ)
    expect(put.topic_type).toBe('decision')
    expect(put.description).toBe('what we decided')
    const tags = put.tags as string[]
    expect(tags).toEqual(expect.arrayContaining([`owner:${MEMBER}`, 'tier:project', 'v:1', `by:${MEMBER}`, 'alpha']))
    expect(tags.find((t) => t.startsWith('at:'))).toMatch(/^at:\d{4}-\d{2}-\d{2}T/)
  })

  it('a non-writer is refused 403 and the upstream is never touched (read-only squad)', async () => {
    r = await rig()
    const o = await upsert(auth(SQ_R, 'member'), r.env, base)
    expect(o.ok).toBe(false)
    expect(status(o)).toBe(403)
    expect(errName(o)).toContain('project_write')
    expect(r.fake.requests).toEqual([])
    expect(r.puts).toEqual([])
  })

  it('an observer-capability caller is refused by the member floor', async () => {
    r = await rig()
    const o = await upsert(auth(SQ_W, 'observer'), r.env, base)
    expect(status(o)).toBe(403)
    expect(r.fake.requests).toEqual([])
  })

  it('non-oracle: an invisible project answers byte-identically to an unknown project, upstream untouched', async () => {
    r = await rig()
    const outsider = auth(SQ_O)
    const hidden = await upsert(outsider, r.env, base)
    const unknown = await upsert(outsider, r.env, { ...base, project_id: 'no-such-project' })
    expect(status(hidden)).toBe(404)
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(unknown))
    const gh = await get(outsider, r.env, { project_id: PROJ, slug: 'design-notes' })
    const gu = await get(outsider, r.env, { project_id: 'no-such-project', slug: 'design-notes' })
    expect(status(gh)).toBe(404)
    expect(JSON.stringify(gh)).toBe(JSON.stringify(gu))
    expect(r.fake.requests).toEqual([])
  })

  it('org admin may write without a squad grant', async () => {
    r = await rig()
    const admin = auth(SQ_O, 'member', { capabilities: [{ member_id: MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }] })
    expect((await upsert(admin, r.env, base)).ok).toBe(true)
  })

  describe('attached chats (min(human standing, agent grant, ceiling): capabilities arrive pre-clamped)', () => {
    it.each(['member', 'lead', 'full'] as const)('attached with ceiling %s and a write squad is allowed; writer is the bound agent', async (ceiling) => {
      r = await rig()
      const o = await upsert(attached(SQ_W, ceiling), r.env, base)
      expect(o.ok).toBe(true)
      expect(o.result).toMatchObject({ writer: AGENT, owner: AGENT })
    })
    it('attached whose clamped standing is read-only on the project is refused', async () => {
      r = await rig()
      const o = await upsert(attached(SQ_R, 'full'), r.env, base)
      expect(status(o)).toBe(403)
      expect(r.puts).toEqual([])
    })
    it('attached clamped below member (observer) is refused by the floor', async () => {
      r = await rig()
      const o = await upsert(attached(SQ_W, 'member', 'observer'), r.env, base)
      expect(status(o)).toBe(403)
      expect(r.puts).toEqual([])
    })
    it('attached with no squad on the project is a 404 (non-oracle), not a 403', async () => {
      r = await rig()
      expect(status(await upsert(attached(SQ_O, 'full'), r.env, base))).toBe(404)
    })
  })

  it.each(['project-card-proj-a-id', 'project-card-x1', 'mupot-internal', 'system-prompt'])('reserved slug %s is refused before any I/O', async (slug) => {
    r = await rig()
    const o = await upsert(auth(SQ_W), r.env, { ...base, slug })
    expect(status(o)).toBe(403)
    expect(errName(o)).toContain('reserved_slug')
    expect(r.fake.requests).toEqual([])
  })

  it('size cap: a 500-char summary lands whole; 501 is refused and nothing is written', async () => {
    r = await rig()
    expect((await upsert(auth(SQ_W), r.env, { ...base, summary: 'x'.repeat(500) })).ok).toBe(true)
    expect(((r.puts[0] as { description: string }).description).length).toBe(500)
    const over = await upsert(auth(SQ_W), r.env, { ...base, slug: 'too-long', summary: 'x'.repeat(501) })
    expect(status(over)).toBe(400)
    expect(errName(over)).toContain('project_remember')
    expect(r.puts).toHaveLength(1)
  })

  it('a markdown body is not accepted (no second store)', async () => {
    r = await rig()
    const o = await upsert(auth(SQ_W), r.env, { ...base, body: '# long text' })
    expect(o.ok).toBe(false)
    expect(r.fake.requests).toEqual([])
  })

  it('envelope is required: missing purpose, missing tier, bad tier are all refused', async () => {
    r = await rig()
    for (const over of [{ purpose: undefined }, { tier: undefined }, { tier: 'public' }]) {
      const o = await upsert(auth(SQ_W), r.env, { ...base, ...over })
      expect(o.ok).toBe(false)
    }
    expect(r.fake.requests).toEqual([])
  })

  it('the client can set none of owner/writer/version/written_at (unknown args refused, forged tags refused)', async () => {
    r = await rig()
    for (const over of [{ owner: 'x' }, { writer: 'x' }, { version: 99 }, { written_at: '2000-01-01' }, { tags: ['v:99'] }, { tags: ['owner:someone-else'] }]) {
      const o = await upsert(auth(SQ_W), r.env, { ...base, ...over })
      expect(o.ok, JSON.stringify(over)).toBe(false)
    }
    expect(r.puts).toEqual([])
  })

  it('links are passed through to the store and read back; a link to a missing page is a 400 and writes nothing', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, { ...base, slug: 'target-page', title: 'Target' })
    const o = await upsert(auth(SQ_W), r.env, { ...base, slug: 'source-page', title: 'Source', links: [{ to_slug: 'target-page', relation: 'depends-on' }] })
    expect(o.ok).toBe(true)
    expect(o.result).toMatchObject({ links_written: 1 })
    expect((r.puts[1] as { edges: unknown[] }).edges).toEqual([{ to_slug: 'target-page', relation_type: 'depends-on' }])
    const g = await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'source-page' })
    expect((g.result as { page: { links: unknown[] } }).page.links).toEqual([{ to_slug: 'target-page', relation: 'depends-on' }])
    const bad = await upsert(auth(SQ_W), r.env, { ...base, slug: 'dangler-page', links: [{ to_slug: 'nowhere-page' }] })
    expect(status(bad)).toBe(400)
    expect(errName(bad)).toContain('edge_target_invalid')
  })

  it('a slug held by ANOTHER project is a generic 409 that never names the other project', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, { ...base, project_id: OTHER, slug: 'shared-name' })
    const o = await upsert(auth(SQ_W), r.env, { ...base, slug: 'shared-name' })
    expect(status(o)).toBe(409)
    expect(errName(o)).toContain('slug_unavailable')
    expect(errName(o)).not.toContain(OTHER)
  })

  it('cannot overwrite a page this tool did not write (dashboard card / admin content)', async () => {
    r = await rig()
    r.fake.seed({ tenantSlug: TENANT, project: PROJ, slug: 'admin-notes', title: 'Admin notes' })
    const o = await upsert(auth(SQ_W), r.env, { ...base, slug: 'admin-notes' })
    expect(status(o)).toBe(409)
    expect(errName(o)).toContain('slug_unavailable')
    expect(r.puts).toEqual([])
  })

  it('a second writer updates but ownership stays with the first writer', async () => {
    r = await rig()
    await upsert(attached(SQ_W, 'full'), r.env, base)
    const o = await upsert(auth(SQ_W), r.env, { ...base, title: 'Edited by human' })
    expect(o.result).toMatchObject({ result: 'updated', version: 2, owner: AGENT, writer: MEMBER })
  })

  it('P1-A probe: attacker\'s write fails on a bad link, victim then creates the slug, victim owns it; attacker cannot take it', async () => {
    r = await rig()
    const attacker = auth(SQ_W, 'member', { memberId: 'attacker', userId: 'attacker' })
    const victim = auth(SQ_W, 'member', { memberId: 'victim', userId: 'victim' })
    const bad = await upsert(attacker, r.env, { ...base, slug: 'roadmap', links: [{ to_slug: 'nowhere-page' }] })
    expect(status(bad)).toBe(400)
    const none = await shared.db.prepare('SELECT COUNT(*) AS n FROM page_versions').first<{ n: number }>()
    expect(none?.n).toBe(0)
    const v = await upsert(victim, r.env, { ...base, slug: 'roadmap' })
    expect(v.result).toMatchObject({ result: 'created', version: 1, owner: 'victim', writer: 'victim' })
    const a2 = await upsert(attacker, r.env, { ...base, slug: 'roadmap', title: 'Hijack', tier: 'squad' })
    expect(status(a2)).toBe(403) // not the owner: cannot change tier
    const a3 = await upsert(attacker, r.env, { ...base, slug: 'roadmap', title: 'Edit' })
    expect(a3.result).toMatchObject({ owner: 'victim', writer: 'attacker', version: 2 })
  })

  it('P1-A: an upstream outage during an update leaves the counter row untouched', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, base)
    const down = { ...r.env, INKWELL_SVC: new FakeInternalWiki({ [TENANT]: 'wrong' }).asFetcher() } as Env
    expect(status(await upsert(auth(SQ_W), down, base))).toBe(503)
    const row = await shared.db.prepare('SELECT version FROM page_versions WHERE slug = ?').bind('design-notes').first<{ version: number }>()
    expect(row?.version).toBe(1)
  })

  describe('P1-B: rank in the squad, not just the squad\'s access to the project', () => {
    // observer on the WRITE squad, member elsewhere: the tool floor passes on the other grant
    const sneaky = (): AuthContext => auth(SQ_W, 'observer', {
      capabilities: [
        { member_id: MEMBER, scope_type: 'squad', scope_id: SQ_W, capability: 'observer' },
        { member_id: MEMBER, scope_type: 'squad', scope_id: SQ_O, capability: 'member' },
      ],
    })
    it('project_wiki_upsert refuses it', async () => {
      r = await rig()
      const o = await upsert(sneaky(), r.env, base)
      expect(status(o)).toBe(403)
      expect(errName(o)).toContain('project_write')
      expect(r.puts).toEqual([])
    })
    it('project_remember (shared predicate) refuses it too, before touching memory', async () => {
      r = await rig()
      const o = await invokeTool(sneaky(), r.env, 'project_remember', { project_id: PROJ, text: 'poison' }, ORIGIN)
      expect(status(o)).toBe(403)
      expect(errName(o)).toContain('project_write')
    })
    it('a MEMBER grant on the write squad still writes (positive control)', async () => {
      r = await rig()
      const ok = auth(SQ_W, 'member', {
        capabilities: [
          { member_id: MEMBER, scope_type: 'squad', scope_id: SQ_W, capability: 'member' },
          { member_id: MEMBER, scope_type: 'squad', scope_id: SQ_O, capability: 'observer' },
        ],
      })
      expect((await upsert(ok, r.env, base)).ok).toBe(true)
    })
  })

  it('P2-1: a page of ours that an admin unpublished is refused (not republished); the fake now republishes on update like the real route', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, base)
    r.fake.unpublish('design-notes')
    const before = r.puts.length
    const o = await upsert(auth(SQ_W), r.env, { ...base, title: 'Edit' })
    expect(status(o)).toBe(409)
    expect(errName(o)).toContain('slug_unavailable')
    expect(r.puts.length).toBe(before)
  })

  it('P2-2: slug held by a hidden project, an unstamped page, and an unpublished page all refuse with the SAME body', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, { ...base, project_id: OTHER, slug: 'held-elsewhere' })
    r.fake.seed({ tenantSlug: TENANT, project: PROJ, slug: 'admin-card', title: 'Card' })
    await upsert(auth(SQ_W), r.env, { ...base, slug: 'was-ours' })
    r.fake.unpublish('was-ours')
    const bodies = new Set<string>()
    for (const slug of ['held-elsewhere', 'admin-card', 'was-ours']) {
      const o = await upsert(auth(SQ_W), r.env, { ...base, slug })
      expect(status(o)).toBe(409)
      bodies.add(JSON.stringify(o))
    }
    expect(bodies.size).toBe(1)
  })

  it('P2-3 (superseded by squad-tier enforcement): the tool description no longer calls tier squad a label', async () => {
    const { PAGES_TOOLS } = await import('../src/mcp/pages')
    const spec = PAGES_TOOLS.find((t) => t.name === 'project_wiki_upsert')
    expect(spec?.scope).not.toContain('label, not access control')
    expect(spec?.scope).toContain("tier 'squad' pages are readable and writable only by members of a squad")
  })

  it('P2-4: an id longer than the stamp budget is hashed, so the owner/by tags never exceed 48 chars', async () => {
    r = await rig()
    const longId = 'm'.repeat(90)
    const o = await upsert(auth(SQ_W, 'member', { memberId: longId, userId: longId }), r.env, base)
    expect(o.ok).toBe(true)
    const tags = (r.puts[0] as { tags: string[] }).tags
    expect(tags.every((t) => t.length <= 48)).toBe(true)
    expect(tags.find((t) => t.startsWith('owner:'))).toMatch(/^owner:sha256-[0-9a-f]{32}$/)
    expect(await stampableId('short-id')).toBe('short-id')
    expect(await stampableId('x'.repeat(40))).toBe('x'.repeat(40))
    expect((await stampableId('x'.repeat(41))).startsWith('sha256-')).toBe(true)
  })

  it('an INCOMING link is not shown as the target page\'s own link; links are additive across updates', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, { ...base, slug: 'anchor-page', title: 'Anchor' })
    await upsert(auth(SQ_W), r.env, { ...base, slug: 'pointer-page', title: 'Pointer', links: [{ to_slug: 'anchor-page', relation: 'depends-on' }] })
    const anchor = await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'anchor-page' })
    expect((anchor.result as { page: { links: unknown[] } }).page.links).toEqual([])
    await upsert(auth(SQ_W), r.env, { ...base, slug: 'pointer-page', title: 'Pointer' }) // no links this time
    const pointer = await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'pointer-page' })
    expect((pointer.result as { page: { links: unknown[] } }).page.links).toEqual([{ to_slug: 'anchor-page', relation: 'depends-on' }])
  })

  it('a link to a keyless PUBLIC admin topic is refused (the real route needs a service-owned target)', async () => {
    r = await rig()
    r.fake.seed({ tenantSlug: TENANT, project: PROJ, slug: 'public-admin-page', title: 'Public' })
    const o = await upsert(auth(SQ_W), r.env, { ...base, slug: 'linker-page', links: [{ to_slug: 'public-admin-page' }] })
    expect(status(o)).toBe(400)
    expect(errName(o)).toContain('edge_target_invalid')
  })

  it('whitespace: a multi-line summary is stored collapsed, and the 500 cap measures the collapsed text', async () => {
    r = await rig()
    const o = await upsert(auth(SQ_W), r.env, { ...base, summary: 'line one\n\n  line two', title: 'T\n\nitle' })
    expect(o.ok).toBe(true)
    expect((r.puts[0] as { description: string; title: string }).description).toBe('line one line two')
    expect((r.puts[0] as { title: string }).title).toBe('T itle')
    const wide = await upsert(auth(SQ_W), r.env, { ...base, slug: 'wide-page', summary: 'x \n'.repeat(200) })
    expect(wide.ok).toBe(true) // 600 raw chars, 399 collapsed
  })

  it('purpose longer than 32 is refused; 32 is stored and read back intact', async () => {
    r = await rig()
    expect(status(await upsert(auth(SQ_W), r.env, { ...base, purpose: 'p'.repeat(33) }))).toBe(400)
    expect((await upsert(auth(SQ_W), r.env, { ...base, purpose: 'p'.repeat(32) })).ok).toBe(true)
    const g = await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'design-notes' })
    expect((g.result as { page: { envelope: { purpose: string } } }).page.envelope.purpose).toBe('p'.repeat(32))
  })

  it('project_wiki_get: an upstream outage is a 503, never a 500', async () => {
    r = await rig()
    const down = { ...r.env, INKWELL_SVC: new FakeInternalWiki({ [TENANT]: 'wrong' }).asFetcher() } as Env
    expect(status(await get(auth(SQ_W), down, { project_id: PROJ, slug: 'design-notes' }))).toBe(503)
  })

  it('the tool description documents additive links, whitespace collapse and the 500 cap', async () => {
    const { PAGES_TOOLS } = await import('../src/mcp/pages')
    const spec = PAGES_TOOLS.find((t) => t.name === 'project_wiki_upsert')
    expect(spec?.min).toBe('member') // declared floor (defence in depth with the rank-aware write gate)
    expect(PAGES_TOOLS.find((t) => t.name === 'project_wiki_get')?.min).toBe('observer')
    expect(spec?.scope).toContain('Links are additive')
    expect(spec?.scope).toContain('whitespace-collapsed')
  })

  it('upstream outage is a 503, never a 500', async () => {
    r = await rig()
    const env = { ...r.env, INKWELL_SVC: new FakeInternalWiki({ [TENANT]: 'wrong' }).asFetcher() } as Env
    expect(status(await upsert(auth(SQ_W), env, base))).toBe(503)
  })

  it('project_wiki_get: absent page is 404 page_not_found; a bad slug is 400', async () => {
    r = await rig()
    expect(status(await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'not-there' }))).toBe(404)
    expect(status(await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'Bad Slug' }))).toBe(400)
  })

  it('project_wiki_get shows a page this tool did not write with envelope null', async () => {
    r = await rig()
    r.fake.seed({ tenantSlug: TENANT, project: PROJ, slug: 'admin-notes', title: 'Admin notes' })
    const g = await get(auth(SQ_W), r.env, { project_id: PROJ, slug: 'admin-notes' })
    expect((g.result as { page: { envelope: unknown } }).page.envelope).toBeNull()
  })

  it('project_wiki still reads what the tool wrote (same store, no second one)', async () => {
    r = await rig()
    await upsert(auth(SQ_W), r.env, base)
    const w = await invokeTool(auth(SQ_R, 'observer'), r.env, 'project_wiki', { project_id: PROJ }, ORIGIN)
    expect((w.result as { wiki: { nodes: { slug: string }[] } }).wiki.nodes.map((n) => n.slug)).toEqual(['design-notes'])
  })
})
