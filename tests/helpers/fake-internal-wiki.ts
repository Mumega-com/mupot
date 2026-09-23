// tests/helpers/fake-internal-wiki.ts — an in-memory double for
// workers/inkwell-api/src/routes/internal-wiki.ts (mumega.com PR #1278,
// confirmed against round 2, head 81839e85, plus an announced-but-unmerged
// successor contract — see SERVICE_WRITE_KEY below), used to test
// src/projects/wiki-client.ts without a real Inkwell worker.
//
// DOUBLE DISCIPLINE (a double that accepts everything is a finding, not a
// test): this fake REFUSES exactly what the real route refuses —
//   - absent Bearer -> 401 { error: 'unauthorized' }
//   - missing tenant_slug entirely -> 400 { error: 'tenant_slug required' }
//     (distinct from a WRONG bearer/tenant, which is 401 — mirrors
//     authorizeTenant's own two-step: presence is validated before the
//     secret comparison ever runs)
//   - a tenant_slug asserted but not owned by this bearer, or no configured
//     secret for it at all -> 401 { error: 'unauthorized' } (never reveals
//     whether the tenant exists)
//   - missing project -> 400 { error: 'project required' }
//   - title outside [2, 120] chars (after trim) -> 400 title_required /
//     title_too_short
//   - more than 50 edges in one write -> 400 { error: 'too_many_edges' }
//   - reads are STRICTLY scoped to (tenant, project) — a topic under a
//     different project never appears in that project's graph/get (404)
//   - round-2 contract: reads ALSO require published=1 AND (required_keys=[]
//     OR required_keys is EXACTLY the service marker — see
//     SERVICE_WRITE_KEY) — a topic gated by any OTHER key, or unpublished,
//     is 404 on GET /topics/:slug and ABSENT from GET /graph (both nodes and
//     any edge touching it)
//   - PUT to a slug already owned by a different project -> 409
//     topic_owned_by_other_project (+ existing_project)
//   - PUT to a slug that is pre-existing AND gated by a REAL (non-service)
//     key -> 409 topic_is_keychain_gated (this fake never lets a PUT create
//     or preserve a real gate — required_keys is always forced to the
//     service marker on write, exactly mirroring the real route's "this path
//     cannot create keychain-gated content"; a REAL gated row can only enter
//     the store via `seed()`, standing in for the admin-only wiki.ts path)
//   - UPDATE does NOT reset `published` — only CREATE forces published=1;
//     an existing row's published flag survives an update untouched (round-2
//     parity: the real route's UPDATE statement never SETs published)
//   - PUT with an edge naming a to_slug in a different project or that does
//     not exist -> 400 cross_project_edge_refused
//   - PUT with an edge naming an UNPUBLISHED to_slug -> 400
//     edge_target_unpublished — validated, like every edge, BEFORE any write
//     (all-or-nothing; the topic itself is left untouched on refusal)
//   - `topic_write_conflict` (409, a TOCTOU race) is a concurrency outcome
//     this single-threaded fake cannot naturally reproduce —
//     wiki-client.test.ts exercises that mapping with a raw fetchImpl
//     instead of through this double
//
// ONLY /api/internal/wiki/* paths are handled — anything else (e.g. a public
// routes/wiki.ts path) 404s uniformly, same as a route this fake does not
// implement. wiki-client.ts never constructs any other path (see
// tests/wiki-client.test.ts's "only calls /api/internal/wiki/*" test).

/**
 * P0 (adversarial gate, 2026-09-23): an ANNOUNCED-but-not-yet-merged
 * successor to #1278 will force `required_keys = ['mupot:project']` (this
 * exact reserved marker) on every service-path write, specifically so
 * Inkwell's PUBLIC routes (routes/wiki.ts, keyed on a real end-user's
 * keychain) hide service-written topics — a random site visitor holds no
 * 'mupot:project' key, so isTopicVisible() returns false for them. The
 * INTERNAL service GET path is expected to keep showing these topics
 * (mupot is the one and only reader of this channel, and it should see what
 * it itself wrote) by treating this ONE reserved key as service-visible,
 * the same way an always-empty required_keys is visible today. This fake
 * models that: writes always leave `required_keys = [SERVICE_WRITE_KEY]`,
 * reads treat that exact array as visible, and the 409 "already gated"
 * conflict check only fires for a REAL (non-service) key so a service topic
 * can still be updated idempotently by a later service PUT.
 */
export const SERVICE_WRITE_KEY = 'mupot:project'

export interface FakeWikiTopicSeed {
  tenantSlug: string
  project: string
  slug: string
  title: string
  description?: string
  topicType?: string
  tags?: string[]
  requiredKeys?: string[]
  published?: boolean
}

interface StoredTopic {
  id: string
  tenant_id: string
  project: string
  slug: string
  title: string
  description: string
  topic_type: string
  required_keys: string[]
  tags: string[]
  published: boolean
  created_at: number
  updated_at: number
}

interface StoredEdge {
  tenant_id: string
  from_slug: string
  to_slug: string
  relation_type: string
  weight: number
}

function isServiceOnlyGate(requiredKeys: string[]): boolean {
  return requiredKeys.length === 0 || (requiredKeys.length === 1 && requiredKeys[0] === SERVICE_WRITE_KEY)
}

let idCounter = 0

export class FakeInternalWiki {
  private readonly secretsByTenant: Map<string, string>
  private readonly topics: StoredTopic[] = []
  private readonly edges: StoredEdge[] = []
  /** Every request this fake received — for asserting "no call was made" (deny-without-upstream-call tests). */
  public readonly requests: { method: string; path: string }[] = []

  constructor(secretsByTenant: Record<string, string>) {
    this.secretsByTenant = new Map(Object.entries(secretsByTenant))
  }

  /** Stand-in for the admin-only wiki.ts create path — the ONLY way a REAL (non-service) gated topic enters the store. */
  seed(seed: FakeWikiTopicSeed): void {
    this.topics.push({
      id: `seed-${idCounter++}`,
      tenant_id: seed.tenantSlug,
      project: seed.project,
      slug: seed.slug,
      title: seed.title,
      description: seed.description ?? '',
      topic_type: seed.topicType ?? 'general',
      required_keys: seed.requiredKeys ?? [],
      tags: seed.tags ?? [],
      published: seed.published ?? true,
      created_at: 0,
      updated_at: 0,
    })
  }

  private findByTenantSlug(tenantId: string, slug: string): StoredTopic | undefined {
    return this.topics.find((t) => t.tenant_id === tenantId && t.slug === slug)
  }

  /** Service-path read visibility: published, AND (keyless OR service-marker-only). */
  private readableByTenantSlug(tenantId: string, slug: string): StoredTopic | undefined {
    const row = this.findByTenantSlug(tenantId, slug)
    if (!row || !row.published || !isServiceOnlyGate(row.required_keys)) return undefined
    return row
  }

  private serialize(row: StoredTopic) {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      project: row.project,
      slug: row.slug,
      title: row.title,
      description: row.description,
      topic_type: row.topic_type,
      required_keys: row.required_keys,
      tags: row.tags,
      published: row.published,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /**
   * authorizeTenant() parity: presence of tenant_slug is checked BEFORE the
   * bearer is compared against anything — a caller that sends no tenant_slug
   * at all gets 400, never 401, even with a perfectly valid bearer for some
   * OTHER tenant.
   */
  private authorize(
    req: Request,
    tenantSlugRaw: string | null,
  ): { ok: true; tenantSlug: string } | { ok: false; res: Response } {
    if (!tenantSlugRaw || !tenantSlugRaw.trim()) {
      return { ok: false, res: Response.json({ error: 'tenant_slug required' }, { status: 400 }) }
    }
    const tenantSlug = tenantSlugRaw.trim()

    const auth = req.headers.get('authorization')
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
    const expected = this.secretsByTenant.get(tenantSlug)
    if (!bearer || !expected || bearer !== expected) {
      return { ok: false, res: Response.json({ error: 'unauthorized' }, { status: 401 }) }
    }
    return { ok: true, tenantSlug }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    this.requests.push({ method: req.method, path: url.pathname })

    if (!url.pathname.startsWith('/api/internal/wiki/')) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }

    let putBody: Record<string, unknown> | null = null
    if (req.method === 'PUT') {
      putBody = (await req.json().catch(() => null)) as Record<string, unknown> | null
      if (!putBody) return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const tenantSlugRaw =
      (typeof putBody?.tenant_slug === 'string' ? putBody.tenant_slug : null) ?? url.searchParams.get('tenant_slug')

    const auth = this.authorize(req, tenantSlugRaw)
    if (!auth.ok) return auth.res
    const tenantSlug = auth.tenantSlug

    if (req.method === 'GET' && url.pathname === '/api/internal/wiki/graph') {
      const project = url.searchParams.get('project')
      if (!project) return Response.json({ error: 'project required' }, { status: 400 })
      const nodes = this.topics.filter(
        (t) => t.tenant_id === tenantSlug && t.project === project && t.published && isServiceOnlyGate(t.required_keys),
      )
      const visibleSlugs = new Set(nodes.map((n) => n.slug))
      const edges = this.edges.filter(
        (e) => e.tenant_id === tenantSlug && visibleSlugs.has(e.from_slug) && visibleSlugs.has(e.to_slug),
      )
      return Response.json({
        tenant_slug: tenantSlug,
        project,
        nodes: nodes.map((n) => this.serialize(n)),
        edges: edges.map((e) => ({ from_slug: e.from_slug, to_slug: e.to_slug, relation_type: e.relation_type, weight: e.weight })),
      })
    }

    const topicMatch = url.pathname.match(/^\/api\/internal\/wiki\/topics\/([^/]+)$/)
    if (req.method === 'GET' && topicMatch) {
      const slug = decodeURIComponent(topicMatch[1])
      const project = url.searchParams.get('project')
      if (!project) return Response.json({ error: 'project required' }, { status: 400 })
      const row = this.readableByTenantSlug(tenantSlug, slug)
      if (!row || row.project !== project) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json({ tenant_slug: tenantSlug, project, topic: this.serialize(row), edges: [] })
    }

    if (req.method === 'PUT' && topicMatch) {
      const slug = decodeURIComponent(topicMatch[1])
      const body = putBody as Record<string, unknown>
      const project = typeof body.project === 'string' ? body.project : null
      if (!project) return Response.json({ error: 'project required' }, { status: 400 })

      const titleRaw = typeof body.title === 'string' ? body.title.trim() : ''
      if (!titleRaw) return Response.json({ error: 'title required' }, { status: 400 })
      if (titleRaw.length < 2) return Response.json({ error: 'title too short' }, { status: 400 })
      const title = titleRaw.slice(0, 120)

      const existing = this.findByTenantSlug(tenantSlug, slug)
      if (existing && existing.project !== project) {
        return Response.json({ error: 'topic_owned_by_other_project', existing_project: existing.project }, { status: 409 })
      }
      // Only a REAL (non-service) gate refuses the write — a topic this
      // service path itself previously wrote (required_keys ===
      // [SERVICE_WRITE_KEY]) can be updated by a later service PUT, exactly
      // like an ungated topic could (P0 idempotency requirement).
      if (existing && !isServiceOnlyGate(existing.required_keys)) {
        return Response.json({ error: 'topic_is_keychain_gated' }, { status: 409 })
      }
      // Round-2 P2-5 parity: the TOCTOU race window (a concurrent write
      // reassigning this slug between our pre-check and the actual write)
      // is not reachable in this single-threaded fake — a caller wanting to
      // exercise `topic_write_conflict` mapping does so with a raw
      // fetchImpl, not through this double (see wiki-client.test.ts).

      const edgesInput = Array.isArray(body.edges) ? body.edges : []
      if (edgesInput.length > 50) {
        return Response.json({ error: 'too_many_edges', max: 50 }, { status: 400 })
      }

      // ── Validate ALL edges BEFORE any write — all-or-nothing, same order
      //    the real route checks: existence + same-project first, THEN
      //    published. ──────────────────────────────────────────────────────
      type PendingEdge = { toSlug: string; relationType: string; weight: number }
      const pendingEdges: PendingEdge[] = []
      for (const raw of edgesInput) {
        if (!raw || typeof raw !== 'object') return Response.json({ error: 'invalid_edge' }, { status: 400 })
        const e = raw as Record<string, unknown>
        const toSlug = typeof e.to_slug === 'string' ? e.to_slug : null
        if (!toSlug) return Response.json({ error: 'invalid_edge_to_slug' }, { status: 400 })
        const target = this.findByTenantSlug(tenantSlug, toSlug)
        if (!target || target.project !== project) {
          return Response.json({ error: 'cross_project_edge_refused', to_slug: toSlug }, { status: 400 })
        }
        // An edge to an unpublished (draft) target is refused — an edge is
        // itself a read-side signal the target exists.
        if (!target.published) {
          return Response.json({ error: 'edge_target_unpublished', to_slug: toSlug }, { status: 400 })
        }
        pendingEdges.push({
          toSlug,
          relationType: typeof e.relation_type === 'string' ? e.relation_type : 'related',
          weight: typeof e.weight === 'number' ? e.weight : 1,
        })
      }

      const now = Math.floor(Date.now() / 1000)
      const created = !existing
      const row: StoredTopic = {
        id: existing?.id ?? `put-${idCounter++}`,
        tenant_id: tenantSlug,
        project,
        slug,
        title,
        description: typeof body.description === 'string' ? body.description.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
        topic_type: typeof body.topic_type === 'string' ? body.topic_type : 'general',
        required_keys: [SERVICE_WRITE_KEY], // ALWAYS forced to the service marker on write
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
        // CREATE forces published=1; UPDATE never touches it (round-2 parity —
        // "update does NOT force published").
        published: existing ? existing.published : true,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      if (existing) {
        const idx = this.topics.indexOf(existing)
        this.topics[idx] = row
      } else {
        this.topics.push(row)
      }

      for (const edge of pendingEdges) {
        this.edges.push({
          tenant_id: tenantSlug,
          from_slug: slug,
          to_slug: edge.toSlug,
          relation_type: edge.relationType,
          weight: edge.weight,
        })
      }

      return Response.json(
        { ok: true, tenant_slug: tenantSlug, project, slug, id: row.id, created, edges_upserted: pendingEdges.length },
        { status: created ? 201 : 200 },
      )
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  asFetcher(): Fetcher {
    return { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.fetch(input, init) } as unknown as Fetcher
  }
}
