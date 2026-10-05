// A fake MCPWP site, for the office addon's publish/reconcile tests (mupot#1616).
//
// It models ONLY what the real plugin does that the addon relies on, read from the
// plugin source (mcpwp/includes, 3.11.1) — not from what the addon hopes it does:
//   - auth: every /wp-json/mcpwp/v1/* route needs `X-API-Key: <key>` (or Bearer).
//     An application-password `Authorization: Basic ...` is a 401 (observed live on
//     mcpwp.net, mupot#1616). WordPress core routes (/wp/v2) are not served here.
//   - POST /posts: title/content/status/slug/meta; the post gets the `meta` in the
//     same call; 201 + {id, url, status, slug, ...}. Draft slugs are NOT made unique
//     (a published slug is, with a -2 suffix) — also observed live.
//   - GET  /posts: ?search (title/content, plus the slug for a single-token term),
//     ?status (`any` = every non-trash status), ?per_page; -> {posts:[...], total}.
//     There is NO meta filter. Trashed posts are not listed.
//   - GET  /post-meta/{id}: -> {id, meta:{key:value}}; a post with no meta reads
//     `meta: []` (PHP's empty array). A value that "looks like a credential" reads
//     back as `***` (Mcpwp_Option_Access::looks_like_credential) — a bare 64-hex
//     digest does, which is why the addon stores its hash behind a prefix.
//
// The key is supplied by the caller (built at runtime in the test — never a literal,
// the no-secrets scan reads raw text).

import { vi } from 'vitest'

export interface FakeMcpwpPost {
  id: number
  slug: string
  status: string
  title: string
  content: string
  type: string
  meta: Record<string, string>
}

export type FakeMcpwpPostMode = 'ok' | 'throwAfterInsert' | '403AfterInsert' | '302AfterInsert' | '400AfterInsert'

export interface FakeMcpwpRequest {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly headers: Headers
  readonly body: unknown
}

export type FakeMcpwpScope = 'read' | 'write' | 'admin'

export interface FakeMcpwpOptions {
  readonly apiKey: string
  /** Scope of the key. Default 'admin' (so older tests are unchanged). Modelled from
   *  MCPWP v3.13.0 (git show v3.13.0:mcpwp/includes/traits/trait-mcpwp-api-auth.php,
   *  get_required_scope_for_request + request_targets_publish_status +
   *  key_has_scope): POST /mcpwp/v1/posts needs 'write', and 'admin' when the body
   *  status is publish|private|future; a read key sees published posts only. */
  readonly scope?: FakeMcpwpScope
  /** MCPWP 3.11.1 had no publish gate: set false to model it. Default true (3.13.0). */
  readonly publishNeedsAdmin?: boolean
  /** Mcpwp_Slug_Search opts a single-token search into slug matching; a search
   *  plugin that touches the clause disables it (plain title/content search only). */
  readonly slugSearch?: boolean
  readonly postMode?: FakeMcpwpPostMode
  readonly seed?: readonly FakeMcpwpPost[]
  /** Mutates the stored post right after the insert (a workflow plugin changing
   *  its status, a slug/title rewrite, a post-type switch) — what the site does to
   *  the post behind the addon's back. */
  readonly afterInsert?: (post: FakeMcpwpPost) => void
  /** Called before routing; return a Response (or throw) to override. */
  readonly intercept?: (req: FakeMcpwpRequest) => Response | undefined
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Mirrors Mcpwp_Option_Access::looks_like_credential for the shapes in play. */
function looksLikeCredential(value: string): boolean {
  if (value.length < 16 || value.includes(' ') || value.includes('@')) return false
  if (UUID_RE.test(value)) return false
  return value.length >= 32
    && /^[A-Za-z0-9+/=_-]+$/.test(value)
    && /[0-9]/.test(value)
    && /[A-Za-z]/.test(value)
    && !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(value)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function createFakeMcpwp(options: FakeMcpwpOptions) {
  const posts: FakeMcpwpPost[] = (options.seed ?? []).map((p) => ({ ...p, meta: { ...p.meta } }))
  const requests: FakeMcpwpRequest[] = []
  let nextId = 100
  const hostUrl = (host: string, id: number) => `https://${host}/?p=${id}`

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const req: FakeMcpwpRequest = { method, path: url.pathname, search: url.search, headers, body }
    requests.push(req)

    const intercepted = options.intercept?.(req)
    if (intercepted) return intercepted

    const prefix = '/wp-json/mcpwp/v1/'
    if (!url.pathname.startsWith(prefix)) return json({ code: 'rest_no_route' }, 404)
    const presented = headers.get('x-api-key') ?? (headers.get('authorization')?.startsWith('Bearer ') ? headers.get('authorization')?.slice(7) : null)
    if (!presented || presented !== options.apiKey) return json({ code: 'missing_api_key' }, 401)
    const route = url.pathname.slice(prefix.length)

    const scope = options.scope ?? 'admin'
    if (route === 'posts' && method === 'POST') {
      const data = body as { title: string; content: string; slug?: string; status?: string; meta?: Record<string, string> }
      const status = data.status ?? 'draft'
      const targetsPublish = ['publish', 'private', 'future'].includes(status)
      if (scope === 'read' || (scope === 'write' && targetsPublish && (options.publishNeedsAdmin ?? true))) {
        return json({ code: 'insufficient_scope', required_scope: targetsPublish ? 'admin' : 'write' }, 403)
      }
      let slug = data.slug ?? ''
      if (status === 'publish') {
        let n = 2
        const base = slug
        while (posts.some((p) => p.slug === slug && p.status === 'publish')) slug = `${base}-${n++}`
      }
      const post: FakeMcpwpPost = { id: nextId++, slug, status, title: data.title, content: data.content, type: 'post', meta: { ...(data.meta ?? {}) } }
      posts.push(post)
      options.afterInsert?.(post)
      switch (options.postMode) {
        case 'throwAfterInsert': throw new DOMException('The operation was aborted.', 'AbortError')
        case '403AfterInsert': return new Response('<html>403 Forbidden (WAF)</html>', { status: 403 })
        case '302AfterInsert': return new Response(null, { status: 302, headers: { location: `https://${url.host}/wp-admin/` } })
        case '400AfterInsert': return new Response('{"code":"plugin_validation"}', { status: 400 })
        default: return json({ id: post.id, title: post.title, slug: post.slug, status: post.status, url: hostUrl(url.host, post.id), meta_applied: post.meta }, 201)
      }
    }

    if (route === 'posts' && method === 'GET') {
      const search = url.searchParams.get('search')
      const statusParam = url.searchParams.get('status') ?? 'publish'
      const perPage = Number(url.searchParams.get('per_page') ?? '10')
      let matches = posts.filter((p) => p.type === 'post')
      matches = matches.filter((p) => (statusParam === 'any' ? p.status !== 'trash' : statusParam.split(',').includes(p.status)))
      if (scope === 'read') matches = matches.filter((p) => p.status === 'publish') // non-public content needs write scope
      if (search !== null) {
        const hay = (p: FakeMcpwpPost) => `${p.title} ${p.content}`.toLowerCase()
        // Slug search is opt-in for a single token (Mcpwp_Slug_Search::should_match_slug).
        const single = (options.slugSearch ?? true) && !/[\s",+]/.test(search)
        matches = matches.filter((p) => hay(p).includes(search.toLowerCase()) || (single && p.slug === search))
      }
      const page = matches.slice(0, perPage)
      return json({
        posts: page.map((p) => ({ id: p.id, title: p.title, slug: p.slug, status: p.status, url: hostUrl(url.host, p.id) })),
        total: matches.length,
      })
    }

    const metaMatch = /^post-meta\/(\d+)$/.exec(route)
    if (metaMatch && method === 'GET') {
      const post = posts.find((p) => p.id === Number(metaMatch[1]))
      if (!post || (scope === 'read' && post.status !== 'publish')) return json({ code: 'not_found' }, 404)
      const entries = Object.entries(post.meta)
      if (entries.length === 0) return json({ id: post.id, meta: [] })
      return json({ id: post.id, meta: Object.fromEntries(entries.map(([k, v]) => [k, looksLikeCredential(v) ? '***' : v])) })
    }

    return json({ code: 'rest_no_route' }, 404)
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } }

  return { f: fetchImpl as unknown as typeof fetch, posts, requests }
}
