// tests/helpers/fake-wiki-documents.ts — a stateful double of the wiki-documents/v1 server (mumega-com PR #1650,
// head d3cb7668, workers/inkwell-api/src/routes/internal-wiki.ts). It REPLAYS the response shapes of that route:
//   GET  /graph                      -> { tenant_slug, project, capabilities, nodes (no body), edges }  (even when empty)
//   GET  /topics/:slug               -> { tenant_slug, project, capabilities, topic{ ..., version, last_writer, body }, edges }
//   GET  /topics/:slug/revisions     -> { revisions:[{version, body, last_writer, written_at, title, description}], next_after_version }
//   PUT  /topics/:slug               -> expected_version REQUIRED (400 expected_version_required); 0 = create, N>0 = edit;
//                                       stale -> 409 { error:'topic_write_conflict', current_version, last_writer };
//                                       create-vs-missing mismatch on an absent page -> 409 { error:'topic_write_conflict' } (no version);
//                                       ok -> 200|201 { ok, ..., id, created, version: expected+1, last_writer, edges_upserted, audit_ok }
// Final head fa6b8eb1 additions replayed: last_writer is namespaced `svc:mupot/<writer>` (default unknown); a PUT with
// neither expected_version nor body is tolerated (legacy metadata); expected_id fences delete/recreate; a corrupt document reads
// body:null + body_error; an unfinished schema answers 503 schema_pending.
// 914bf4fe additions replayed: capabilities.expected_id:true; a body write at expected_version>0 without expected_id is
// 400 expected_id_required on a VISIBLE page and a bare 409 on a hidden/absent one; a v0 create collision is 409 BEFORE
// that check; an id mismatch is 409 with reason page_replaced (visible page only); expected_id is trimmed, and an
// empty or >128-char one is 400 invalid_expected_id; GET 404s hidden and unpublished rows; an unpublished-but-readable row
// is republished by a matching write; the corrupt-document 409 comes AFTER the identity checks.
// Test hooks model what a unit test cannot otherwise reach: another writer landing after our commit, an ack
// that did not persist, an unreadable history, and a tier flip between the caller's read and its write.

// Models mumega-com 914bf4fe (see inkwell-wiki-contract.ts for the commit, the PUT check ORDER, and the 400/409 shapes).
import { INKWELL_MAX_EXPECTED_ID_LENGTH, INKWELL_PAGE_REPLACED_REASON, INKWELL_V1_CAPABILITIES } from './inkwell-wiki-contract'

export const V1_CAPABILITIES: Record<string, unknown> = { ...INKWELL_V1_CAPABILITIES }
const SERVICE_KEY = 'mupot:project'

interface Rev { version: number; body: string | null; last_writer: string; title: string; description: string }
interface Topic {
  id: string; project: string; slug: string; title: string; description: string; topic_type: string; tags: string[]
  version: number; last_writer: string; body: string | null; revisions: Rev[]; bodyError?: string
  /** gated / another project's / not service-readable: GET 404, PUT answers a bare 409, never a typed refusal. */
  hidden?: boolean
  /**
   * An admin-unpublished row that is STILL service-readable (required_keys empty). Real 914bf4fe: GET answers 404,
   * the PUT passes the readable check, the typed/rich answers (400 expected_id_required, rich 409) are withheld
   * (they need a published row), and a write whose version and id match REPUBLISHES it.
   */
  unpublished?: boolean
}
export interface RecordedRequest { method: string; path: string; search: string; json?: Record<string, unknown> }

export class FakeWikiDocuments {
  readonly requests: RecordedRequest[] = []
  readonly topics = new Map<string, Topic>()
  capabilities: unknown = V1_CAPABILITIES
  /** after a PUT commits, run this (e.g. another writer advancing the page). */
  afterCommit?: (t: Topic) => void
  /** before a PUT is evaluated (e.g. a tier flip). */
  beforePut?: (t: Topic | undefined) => void
  /** acknowledge the PUT but store nothing (a lying/failed persistence). */
  dropWrites = false
  /** PUT and revisions answer 503 schema_pending (migration unfinished). */
  schemaPending = false
  /** the next PUT is refused 409 with current_version == the version it expected (a same-number id race). */
  fenceNext = false
  /** every 409 carries THESE values instead of the real ones (a lying/poisoned store). */
  conflictOverride?: { current_version: number; last_writer: string }
  /** answer the revisions route with this status instead of data. */
  historyStatus?: number
  /** PUT response `version`: 'omit' drops it, a number lies, undefined = honest expected+1. */
  echoVersion?: number | 'omit'
  /** Act like a rolled-back legacy server behind a v1 handshake: ignore expected_version and body, no version anywhere. */
  rolledBack = false
  private n = 0

  constructor(private readonly tenant: string, private readonly secret: string) {}

  seed(project: string, slug: string, over: Partial<Topic> = {}): Topic {
    const t: Topic = {
      id: `t-${this.n++}`, project, slug, title: 'Seeded', description: 's', topic_type: 'decision', tags: [],
      version: 1, last_writer: 'service:mupot', body: null, revisions: [], ...over,
    }
    if (!t.revisions.length) t.revisions.push({ version: t.version, body: t.body, last_writer: t.last_writer, title: t.title, description: t.description })
    this.topics.set(slug, t)
    return t
  }

  /** The slug is deleted and recreated: NEW id, version restarts at 1. */
  recreate(slug: string, body: string | null = null): Topic {
    const old = this.topics.get(slug)
    if (!old) throw new Error('recreate: no topic')
    this.topics.delete(slug)
    return this.seed(old.project, slug, { tags: old.tags, body, version: 1, last_writer: 'svc:mupot/recreator' })
  }

  /** Another authorized writer advances the page by one revision. */
  advance(slug: string, body: string, writer = 'svc:mupot/agent-other'): void {
    const t = this.topics.get(slug)
    if (!t) throw new Error('advance: no topic')
    t.version += 1
    t.body = body
    t.last_writer = writer
    t.revisions.push({ version: t.version, body, last_writer: writer, title: t.title, description: t.description })
  }

  private serialize(t: Topic, withBody: boolean) {
    return {
      id: t.id, tenant_id: this.tenant, project: t.project, slug: t.slug, title: t.title, description: t.description,
      ...(withBody ? (t.bodyError ? { body: null, body_error: t.bodyError } : { body: t.body }) : {}),
      version: t.version, last_writer: t.last_writer, topic_type: t.topic_type, required_keys: [SERVICE_KEY], tags: t.tags,
      published: true, created_at: 0, updated_at: 0,
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const rec: RecordedRequest = { method: req.method, path: url.pathname, search: url.search }
    const text = req.method === 'PUT' ? await req.text() : ''
    if (text) rec.json = JSON.parse(text) as Record<string, unknown> // test double: our own client's JSON
    this.requests.push(rec)
    if (req.headers.get('authorization') !== `Bearer ${this.secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const project = (rec.json?.project as string | undefined) ?? url.searchParams.get('project') ?? ''
    const base = '/api/internal/wiki'

    if (req.method === 'GET' && url.pathname === `${base}/graph`) {
      const nodes = [...this.topics.values()].filter((t) => t.project === project && !t.hidden && !t.unpublished).map((t) => this.serialize(t, false))
      return Response.json({
        tenant_slug: this.tenant, project,
        ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
        nodes, edges: [],
      })
    }
    const m = url.pathname.match(/^\/api\/internal\/wiki\/topics\/([^/]+)(\/revisions)?$/)
    if (!m) return Response.json({ error: 'not_found' }, { status: 404 })
    const slug = decodeURIComponent(m[1])
    const t = this.topics.get(slug)

    if (req.method === 'GET' && m[2]) {
      if (this.schemaPending) return Response.json({ error: 'schema_pending' }, { status: 503 })
      if (this.historyStatus) return Response.json({ error: 'x' }, { status: this.historyStatus })
      if (!t || t.project !== project) return Response.json({ error: 'not_found' }, { status: 404 })
      const after = Number(url.searchParams.get('after_version') ?? '0')
      const revisions = t.revisions.filter((r) => r.version > after).map((r) => ({ ...r, written_at: 0 }))
      return Response.json({ revisions, next_after_version: null })
    }
    if (req.method === 'GET') {
      if (!t || t.project !== project || t.hidden || t.unpublished) return Response.json({ error: 'not_found' }, { status: 404 })
      const topic = this.serialize(t, true)
      if (this.rolledBack) { delete (topic as Record<string, unknown>).version; delete (topic as Record<string, unknown>).body; delete (topic as Record<string, unknown>).last_writer }
      return Response.json({
        tenant_slug: this.tenant, project,
        ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
        topic, edges: [],
      })
    }
    if (req.method === 'PUT') {
      const p = rec.json ?? {}
      if (this.schemaPending) return Response.json({ error: 'schema_pending' }, { status: 503 })
      if (this.rolledBack) {
        // legacy behavior: unknown keys ignored, metadata stored, response has no version
        const cur0 = this.topics.get(slug)
        const t0: Topic = cur0 ?? { id: `t-${this.n++}`, project, slug, title: '', description: '', topic_type: '', tags: [], version: 1, last_writer: '', body: null, revisions: [] }
        t0.title = String(p.title); t0.description = String(p.description ?? ''); t0.tags = Array.isArray(p.tags) ? (p.tags as string[]) : []
        this.topics.set(slug, t0)
        return Response.json({ ok: true, id: t0.id, created: !cur0, edges_upserted: 0 }, { status: cur0 ? 200 : 201 })
      }
      const legacyMetadata = p.expected_version === undefined && p.body === undefined
      // 1. expected_version
      if (!legacyMetadata && (!Number.isSafeInteger(p.expected_version) || (p.expected_version as number) < 0)) return Response.json({ error: 'expected_version_required' }, { status: 400 })
      const expected = legacyMetadata ? (this.topics.get(slug)?.version ?? 0) : (p.expected_version as number)
      // 2. expected_id shape (trimmed before validation and comparison)
      const expectedId = typeof p.expected_id === 'string' ? p.expected_id.trim() : undefined
      if (p.expected_id !== undefined && (expectedId === undefined || !expectedId || expectedId.length > INKWELL_MAX_EXPECTED_ID_LENGTH)) return Response.json({ error: 'invalid_expected_id' }, { status: 400 })
      if (p.body !== undefined && (typeof p.body !== 'string' || new TextEncoder().encode(p.body).byteLength > 65536)) return Response.json({ error: 'invalid_body', max_bytes: 65536 }, { status: 400 })
      this.beforePut?.(this.topics.get(slug))
      const cur = this.topics.get(slug)
      const readable = !!cur && cur.project === project && !cur.hidden
      const visible = readable && !cur?.unpublished
      const conflict = () => Response.json(
        visible && cur
          ? { error: 'topic_write_conflict', ...(this.conflictOverride ?? { current_version: cur.version, last_writer: cur.last_writer }), ...(expectedId !== undefined && cur.id !== expectedId ? { reason: INKWELL_PAGE_REPLACED_REASON } : {}) }
          : { error: 'topic_write_conflict' },
        { status: 409 },
      )
      // 3. a row that is another project's or not service-readable: bare 409
      if (cur && !readable) return Response.json({ error: 'topic_write_conflict' }, { status: 409 })
      if (this.fenceNext) { this.fenceNext = false; return Response.json({ error: 'topic_write_conflict', current_version: expected, last_writer: cur?.last_writer }, { status: 409 }) }
      // 4. create-vs-missing mismatch (this runs BEFORE the expected_id_required check)
      if (!legacyMetadata && ((!cur && expected !== 0) || (cur && expected === 0))) return conflict()
      // 5. a body write at a positive expected_version must name the page it read
      if (p.body !== undefined && expectedId === undefined && (legacyMetadata ? 0 : expected) > 0) {
        if (cur && visible) return Response.json({ error: 'expected_id_required' }, { status: 400 })
        return conflict()
      }
      // 6. identity
      if (expectedId !== undefined && cur?.id !== expectedId) return conflict()
      // 6b. a corrupt stored document is only discovered when the body is rewritten: AFTER the identity checks
      if (cur?.bodyError && typeof p.body === 'string') return Response.json({ error: 'invalid_content_blocks' }, { status: 409 })
      // 7. version
      if (!legacyMetadata && cur && cur.version !== expected) return conflict()
      const writer = `svc:mupot/${typeof p.writer === 'string' ? p.writer : 'unknown'}`
      const next: Topic = cur ?? { id: `t-${this.n++}`, project, slug, title: '', description: '', topic_type: '', tags: [], version: 0, last_writer: '', body: null, revisions: [] }
      if (!this.dropWrites) {
        next.title = String(p.title); next.description = String(p.description ?? ''); next.topic_type = String(p.topic_type ?? 'general')
        next.tags = Array.isArray(p.tags) ? (p.tags as string[]) : []
        if (typeof p.body === 'string') next.body = p.body === '' ? null : p.body
        next.version = expected + 1
        next.last_writer = writer
        next.revisions.push({ version: next.version, body: next.body, last_writer: writer, title: next.title, description: next.description })
        next.unpublished = false // a matching write republishes an unpublished row
        this.topics.set(slug, next)
        this.afterCommit?.(next)
      }
      return Response.json({ ok: true, tenant_slug: this.tenant, project, slug, id: next.id, created: !cur, ...(this.echoVersion === 'omit' ? {} : { version: this.echoVersion ?? expected + 1 }), last_writer: writer, edges_upserted: 0, audit_ok: true }, { status: cur ? 200 : 201 })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  asFetcher(): Fetcher {
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => this.fetch(i, init) } as unknown as Fetcher // Fetcher binding shape, test double
  }
}
