// tests/helpers/fake-internal-wiki.ts — an in-memory double for
// workers/inkwell-api/src/routes/internal-wiki.ts (mumega.com PR #1278,
// confirmed against round 2, head 81839e85), used to test
// src/projects/wiki-client.ts without a real Inkwell worker.
//
// DOUBLE DISCIPLINE (a double that accepts everything is a finding, not a
// test): this fake REFUSES exactly what the real route refuses —
//   - wrong/absent Bearer -> 401 { error: 'unauthorized' }
//   - missing tenant_slug (no secret configured for it) -> 401 (mirrors
//     authorizeTenant's fail-closed: an unrecognized tenant is indistinguishable
//     from a wrong bearer, by design — never leak which tenants exist)
//   - missing project -> 400 { error: 'project required' }
//   - reads are STRICTLY scoped to (tenant, project) — a topic under a
//     different project never appears in that project's graph/get (404)
//   - round-2 contract: reads ALSO require required_keys=[] AND published=1
//     (via the SAME isTopicVisible(row, emptyKeySet) predicate the real
//     route reuses) — a gated or unpublished topic is 404 on GET
//     /topics/:slug and ABSENT from GET /graph (both nodes and any edge
//     touching it)
//   - PUT to a slug already owned by a different project -> 409
//     topic_owned_by_other_project (+ existing_project)
//   - PUT to a slug that is pre-existing AND keychain-gated -> 409
//     topic_is_keychain_gated (this fake never lets a PUT itself create a
//     gated topic — required_keys is always forced to [] on write, exactly
//     like the real route; a gated row can only get into the store via
//     `seed()`, standing in for the admin-only wiki.ts path)
//   - PUT with an edge naming a to_slug in a different project or that does
//     not exist -> 400 cross_project_edge_refused
//   - round-2 P1-2: PUT with an edge naming an UNPUBLISHED to_slug -> 400
//     edge_target_unpublished — validated, like every edge, BEFORE any write
//     (all-or-nothing; the topic itself is left untouched on refusal)
//   - round-2 P2-5's `topic_write_conflict` (409, a TOCTOU race) is a
//     concurrency outcome this single-threaded fake cannot naturally
//     reproduce — wiki-client.test.ts exercises that mapping with a raw
//     fetchImpl instead of through this double

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

  /** Stand-in for the admin-only wiki.ts create path — the ONLY way a gated topic enters the store. */
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

  /** Round-2 read visibility: keyless AND published only. */
  private readableByTenantSlug(tenantId: string, slug: string): StoredTopic | undefined {
    const row = this.findByTenantSlug(tenantId, slug)
    if (!row || row.required_keys.length > 0 || !row.published) return undefined
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

  private authorize(req: Request): { ok: true; tenantSlug: string } | { ok: false; res: Response } {
    const auth = req.headers.get('authorization')
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
    if (!bearer) {
      return { ok: false, res: Response.json({ error: 'unauthorized' }, { status: 401 }) }
    }
    // Find a tenant whose configured secret matches this bearer. A caller
    // asserting a tenant_slug the bearer does NOT own must 401, same as a
    // wrong bearer entirely (never confirm/deny tenant existence).
    for (const [tenant, secret] of this.secretsByTenant) {
      if (secret === bearer) return { ok: true, tenantSlug: tenant }
    }
    return { ok: false, res: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    this.requests.push({ method: req.method, path: url.pathname })

    const auth = this.authorize(req)
    if (!auth.ok) return auth.res
    const tenantSlug = auth.tenantSlug

    // Cross-tenant assertion check: if the caller ALSO named a tenant_slug
    // (query or body) that differs from the one the bearer actually owns,
    // refuse — mirrors authorizeTenant's BLOCK-1 parity check.
    const assertedTenant =
      url.searchParams.get('tenant_slug') ??
      (req.method === 'PUT' ? ((await req.clone().json().catch(() => null)) as Record<string, unknown> | null)?.tenant_slug : null)
    if (typeof assertedTenant === 'string' && assertedTenant && assertedTenant !== tenantSlug) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    if (req.method === 'GET' && url.pathname === '/api/internal/wiki/graph') {
      const project = url.searchParams.get('project')
      if (!project) return Response.json({ error: 'project required' }, { status: 400 })
      const nodes = this.topics.filter((t) => t.tenant_id === tenantSlug && t.project === project && t.required_keys.length === 0 && t.published)
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
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 })
      const project = typeof body.project === 'string' ? body.project : null
      if (!project) return Response.json({ error: 'project required' }, { status: 400 })
      if (typeof body.title !== 'string' || !body.title.trim()) return Response.json({ error: 'title required' }, { status: 400 })

      const existing = this.findByTenantSlug(tenantSlug, slug)
      if (existing && existing.project !== project) {
        return Response.json({ error: 'topic_owned_by_other_project', existing_project: existing.project }, { status: 409 })
      }
      if (existing && existing.required_keys.length > 0) {
        return Response.json({ error: 'topic_is_keychain_gated' }, { status: 409 })
      }
      // Round-2 P2-5 parity: the TOCTOU race window (a concurrent write
      // reassigning this slug between our pre-check and the actual write)
      // is not reachable in this single-threaded fake — a caller wanting to
      // exercise `topic_write_conflict` mapping does so with a raw
      // fetchImpl, not through this double (see wiki-client.test.ts).

      // ── Validate ALL edges BEFORE any write — all-or-nothing (round-2
      //    invariant #6), same order the real route checks: existence +
      //    same-project first, THEN published. ─────────────────────────────
      type PendingEdge = { toSlug: string; relationType: string; weight: number }
      const pendingEdges: PendingEdge[] = []
      const edgesInput = Array.isArray(body.edges) ? body.edges : []
      for (const raw of edgesInput) {
        if (!raw || typeof raw !== 'object') return Response.json({ error: 'invalid_edge' }, { status: 400 })
        const e = raw as Record<string, unknown>
        const toSlug = typeof e.to_slug === 'string' ? e.to_slug : null
        if (!toSlug) return Response.json({ error: 'invalid_edge_to_slug' }, { status: 400 })
        const target = this.findByTenantSlug(tenantSlug, toSlug)
        if (!target || target.project !== project) {
          return Response.json({ error: 'cross_project_edge_refused', to_slug: toSlug }, { status: 400 })
        }
        // Round-2 P1-2: an edge to an unpublished (draft) target is refused
        // — an edge is itself a read-side signal the target exists.
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
        title: body.title,
        description: typeof body.description === 'string' ? body.description : '',
        topic_type: typeof body.topic_type === 'string' ? body.topic_type : 'general',
        required_keys: [], // ALWAYS forced to [] on write, exactly like the real route
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
        published: true, // this write path always produces a published=1 topic (no `published` body field exists)
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
