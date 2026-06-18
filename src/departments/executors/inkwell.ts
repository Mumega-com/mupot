// inkwell.ts — S4: the inkwell-content ACT executor adapter.
//
// PURE + FAIL-CLOSED. Given a resolved config { apiUrl, token } and the STORED
// proposal payload, POSTs one content write to the Inkwell API and returns the
// created artifact. No env access, no connector decrypt, no DB — those happen at
// the Worker boundary which resolves the connector credential (Hadi-go) and passes
// the narrow config in. This keeps the kernel pure + unit-testable, and means the
// adapter is inert unless the Worker explicitly supplies a credential.

export interface InkwellExecutorConfig {
  /** Inkwell API origin, e.g. https://inkwell-api.mumega.com (staging by default). */
  apiUrl: string
  /** Bearer publish token (resolved from the per-pot 'inkwell' connector). */
  token: string
}

export interface InkwellWriteResult {
  ok: true
  slug: string
  url: string
}

/** Body accepted by Inkwell's POST /api/content/publish. */
interface PublishBody {
  title: string
  content: string
  slug?: string
  author: string
  tags: string[]
  description: string
  status: 'draft' | 'published' | 'archived'
  overwrite: boolean
}

/**
 * Map an opaque stored proposal payload to a publish body. Returns null when the
 * required fields (title + content) are absent — the caller must fail-closed.
 * Defaults are conservative: status 'draft' (never auto-publish), overwrite false.
 */
export function toPublishBody(payload: unknown): PublishBody | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const content = typeof p.content === 'string' ? p.content : ''
  if (!title || !content) return null
  const status = p.status === 'published' || p.status === 'archived' ? p.status : 'draft'
  return {
    title,
    content,
    slug: typeof p.slug === 'string' && p.slug ? p.slug : undefined,
    author: typeof p.author === 'string' && p.author ? p.author : 'mupot',
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
    description: typeof p.description === 'string' ? p.description : '',
    status,
    overwrite: p.overwrite === true,
  }
}

export class InkwellExecutorError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message ?? reason)
    this.name = 'InkwellExecutorError'
  }
}

/**
 * Write one content artifact to Inkwell. Throws InkwellExecutorError (fail-closed)
 * on missing config, unmappable payload, or a non-ok response. `fetchImpl` is
 * injectable for tests.
 */
export async function inkwellContentWrite(
  cfg: InkwellExecutorConfig,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<InkwellWriteResult> {
  if (!cfg || !cfg.apiUrl || !cfg.token) {
    throw new InkwellExecutorError('inkwell_not_configured', 'missing apiUrl or token')
  }
  const body = toPublishBody(payload)
  if (!body) {
    throw new InkwellExecutorError('invalid_payload', 'stored payload lacks title/content')
  }

  let res: Response
  try {
    res = await fetchImpl(`${cfg.apiUrl.replace(/\/$/, '')}/api/content/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new InkwellExecutorError('inkwell_unreachable', String(e))
  }

  if (!res.ok) {
    throw new InkwellExecutorError('inkwell_http_error', `status ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; slug?: string; url?: string } | null
  if (!json || json.ok !== true || !json.slug || !json.url) {
    throw new InkwellExecutorError('inkwell_bad_response', 'response missing ok/slug/url')
  }
  return { ok: true, slug: json.slug, url: json.url }
}
