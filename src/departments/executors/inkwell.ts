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

// SSRF guard (WARN-1 Sonnet/#209 + IPv6/CGNAT hardening Opus/#211). apiUrl is
// config-sourced (not payload) today, but the executor must not be steerable to an
// internal / loopback / cloud-metadata target by a misconfigured or hostile config.
// Require https + a PUBLIC host. We range-check the parsed IP (not a string regex)
// so IPv4-mapped IPv6, ULA, link-local, CGNAT, and the IPv4 evasions are all caught.
// (DNS-rebind — a public name re-resolving to an internal IP at fetch — is out of
// scope for a parse-time check; mitigate with an origin allowlist if apiUrl ever
// becomes connector/payload-driven.)
function isPrivateV4(ip: string): boolean {
  const o = ip.split('.').map((n) => Number(n))
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true // malformed → block
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  return false
}

function isPrivateHost(host: string): boolean {
  // URL.hostname keeps IPv6 brackets in Node ([::1]) — strip them + any trailing dot.
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local') || h === 'metadata.google.internal') {
    return true
  }
  if (h.includes(':')) {
    // IPv6 (URL.hostname is bracket-stripped). Block loopback/unspecified, ULA
    // (fc00::/7), link-local (fe80::/10), and IPv4-mapped (::ffff:a.b.c.d / hex).
    if (h === '::1' || h === '::') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true // fc00::/7
    if (/^fe[89ab]/.test(h)) return true // fe80::/10
    const mapped = h.match(/^::ffff:(.+)$/)
    if (mapped) {
      if (mapped[1].includes('.')) return isPrivateV4(mapped[1])
      const parts = mapped[1].split(':')
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16)
        const lo = parseInt(parts[1], 16)
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
        }
      }
      return true // unrecognised mapped form → block
    }
    return false // other global IPv6 → allow
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateV4(h)
  return false // a public hostname
}

function assertSafeInkwellUrl(apiUrl: string): URL {
  let u: URL
  try {
    u = new URL(apiUrl)
  } catch {
    throw new InkwellExecutorError('inkwell_bad_apiurl', 'apiUrl is not a valid URL')
  }
  if (u.protocol !== 'https:') {
    throw new InkwellExecutorError('inkwell_bad_apiurl', 'apiUrl must be https')
  }
  if (isPrivateHost(u.hostname)) {
    throw new InkwellExecutorError('inkwell_bad_apiurl', 'apiUrl host is private/internal')
  }
  return u
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
  const base = assertSafeInkwellUrl(cfg.apiUrl)
  const body = toPublishBody(payload)
  if (!body) {
    throw new InkwellExecutorError('invalid_payload', 'stored payload lacks title/content')
  }

  let res: Response
  try {
    res = await fetchImpl(`${base.origin}/api/content/publish`, {
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
