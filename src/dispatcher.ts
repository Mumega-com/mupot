// src/dispatcher.ts — Cloudflare Workers for Platforms (WFP) root dispatch router.
//
// Supports both Linear-style workspace path routing (`mupot.mumega.com/<workspace>/...`)
// and subdomain / custom domain routing (`<workspace>.mupot.mumega.com` / `agents.viamar.ca`)
// to dedicated isolated user Workers in the `mupot-pots` dispatch namespace.
//
// Invariants (docs/workers-for-platforms.md):
//   1. Each user Worker runs in its own V8 isolate with dedicated D1, KV, R2, and Queue bindings.
//   2. Caches are disabled inside dispatch namespaces; zero `caches.default` / `caches.open`.
//   3. Single billed request across the chain: Dispatch Worker -> User Worker.

export interface DispatcherEnv {
  DISPATCHER: {
    get(
      name: string,
      args?: Record<string, unknown>,
      options?: { limits?: { cpuMs?: number; subRequests?: number } },
    ): {
      fetch(request: Request): Promise<Response>
    }
  }
  ROOT_DOMAIN?: string // default 'mupot.mumega.com'
  FALLBACK_POT?: string // default 'mumega'
  DEFAULT_CPU_MS?: number // default 50ms
  DEFAULT_SUBREQUESTS?: number // default 50
}

export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'
export const DEFAULT_FALLBACK_POT = 'mumega'
export const DEFAULT_DISPATCH_LIMITS = {
  cpuMs: 50,
  subRequests: 50,
} as const

export const RESERVED_ROOT_ROUTES = new Set([
  'health',
  'pricing',
  'signup',
  'login',
  'auth',
  'authorize',
  'token',
  'register',
  'oauth',
  'webhooks',
  'channels',
  'assets',
  'static',
  'favicon.ico',
  'robots.txt',
  '.well-known',
  'api',
])

export interface TenantRoutingResult {
  tenantSlug: string
  rewrittenUrl?: string
  isPathScoped: boolean
  isSubdomain: boolean
  isHeaderScoped: boolean
}

/**
 * Resolves the tenant routing context from the request URL, headers, and hostname.
 * Supports:
 *   1. Header override: `X-Mupot-Tenant-Slug`, `X-Pot-Tenant`, `X-Mupot-Tenant`
 *   2. Subdomain: `<tenant>.mupot.mumega.com`
 *   3. Linear-style workspace path: `mupot.mumega.com/<tenant>/...`
 *   4. Custom domain (CNAME): `agents.viamar.ca` -> `agents-viamar-ca`
 */
export function resolveTenantRouting(
  urlOrString: URL | string,
  rootDomain: string = DEFAULT_ROOT_DOMAIN,
  headerSlug?: string | null,
): TenantRoutingResult {
  const url = typeof urlOrString === 'string'
    ? urlOrString.startsWith('http://') || urlOrString.startsWith('https://')
      ? new URL(urlOrString)
      : new URL(`https://${urlOrString}`)
    : urlOrString

  // 1. Header resolution (highest precedence for direct API / MCP calls)
  if (headerSlug && /^[a-z0-9-_]+$/i.test(headerSlug.trim())) {
    return {
      tenantSlug: headerSlug.trim().toLowerCase(),
      isPathScoped: false,
      isSubdomain: false,
      isHeaderScoped: true,
    }
  }

  const cleanHost = url.hostname.toLowerCase().split(':')[0]
  const cleanRoot = rootDomain.toLowerCase().split(':')[0]
  const isRootOrWww = cleanHost === cleanRoot || cleanHost === `www.${cleanRoot}`

  // 2. Subdomain resolution (<tenant>.mupot.mumega.com)
  if (!isRootOrWww && cleanHost.endsWith(`.${cleanRoot}`)) {
    const sub = cleanHost.slice(0, -(cleanRoot.length + 1))
    const parts = sub.split('.')
    const tenantSlug = parts[parts.length - 1] || DEFAULT_FALLBACK_POT
    return {
      tenantSlug,
      isPathScoped: false,
      isSubdomain: true,
      isHeaderScoped: false,
    }
  }

  // 3. Linear-style path resolution (mupot.mumega.com/<workspace>/...)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const firstSegment = pathParts[0]?.toLowerCase()

  if (
    firstSegment &&
    /^[a-z0-9][a-z0-9-_]*$/i.test(firstSegment) &&
    !RESERVED_ROOT_ROUTES.has(firstSegment)
  ) {
    const tenantSlug = firstSegment.toLowerCase()
    const remainingSegments = pathParts.slice(1)
    const rewrittenPath = '/' + remainingSegments.join('/')

    const rewrittenUrl = new URL(url.toString())
    rewrittenUrl.pathname = rewrittenPath === '/' ? '/' : rewrittenPath

    return {
      tenantSlug,
      rewrittenUrl: rewrittenUrl.toString(),
      isPathScoped: true,
      isSubdomain: false,
      isHeaderScoped: false,
    }
  }

  // 4. Custom domain resolution or root fallback
  const tenantSlug = isRootOrWww
    ? DEFAULT_FALLBACK_POT
    : cleanHost.replace(/[^a-z0-9-]/g, '-')

  return {
    tenantSlug,
    isPathScoped: false,
    isSubdomain: false,
    isHeaderScoped: false,
  }
}

/**
 * Extracts the tenant slug from a hostname, URL, or explicit header.
 * Backward-compatible helper used across dashboard and tests.
 */
export function extractTenantSlug(
  hostnameOrUrl: string,
  rootDomain: string = DEFAULT_ROOT_DOMAIN,
  headerSlug?: string | null,
): string {
  const routing = resolveTenantRouting(hostnameOrUrl, rootDomain, headerSlug)
  return routing.tenantSlug
}

function renderUnprovisionedPotHtml(tenantSlug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mupot · Sovereign Pot Not Found</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
    .card { max-width: 480px; width: 100%; background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 32px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .badge { display: inline-block; background: #27272a; color: #a1a1aa; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; margin: 0 0 12px 0; color: #ffffff; }
    p { font-size: 14px; line-height: 1.6; color: #a1a1aa; margin: 0 0 24px 0; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #06b6d4; background: #121214; padding: 2px 6px; border-radius: 4px; }
    .btn { display: inline-block; background: #06b6d4; color: #09090b; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 24px; border-radius: 8px; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Sovereign Cloudflare Isolation</div>
    <h1>Pot Not Provisioned</h1>
    <p>No active sovereign mupot instance found for <span class="code">${tenantSlug}</span>. Each organization runs in an isolated V8 container with dedicated D1 storage.</p>
    <a href="https://mupot.mumega.com/signup" class="btn">Provision Sovereign Pot</a>
  </div>
</body>
</html>`
}

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url)
    const rootDomain = env.ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN
    const headerSlug =
      request.headers.get('x-mupot-tenant-slug') ||
      request.headers.get('x-pot-tenant') ||
      request.headers.get('x-mupot-tenant')

    const routing = resolveTenantRouting(url, rootDomain, headerSlug)
    const tenantSlug = routing.tenantSlug

    const limits = {
      cpuMs: env.DEFAULT_CPU_MS ?? DEFAULT_DISPATCH_LIMITS.cpuMs,
      subRequests: env.DEFAULT_SUBREQUESTS ?? DEFAULT_DISPATCH_LIMITS.subRequests,
    }

    // Prepare the forward request. When Linear-style path routing is used (e.g. /viamar/studio),
    // rewrite the target URL path to /studio and attach tenant context headers.
    let forwardRequest: Request
    if (routing.isPathScoped && routing.rewrittenUrl) {
      const headers = new Headers(request.headers)
      headers.set('x-mupot-tenant', tenantSlug)
      headers.set('x-mupot-workspace-prefix', `/${tenantSlug}`)
      forwardRequest = new Request(routing.rewrittenUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        // @ts-expect-error duplex required for request body streaming in fetch
        duplex: request.body ? 'half' : undefined,
      })
    } else {
      forwardRequest = request
    }

    try {
      const userWorker = env.DISPATCHER.get(tenantSlug, {}, { limits })
      return await userWorker.fetch(forwardRequest)
    } catch (err) {
      const isNotFound =
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('No user worker'))

      if (isNotFound) {
        const acceptsHtml = request.headers.get('accept')?.includes('text/html')
        if (acceptsHtml && request.method === 'GET') {
          return new Response(renderUnprovisionedPotHtml(tenantSlug), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }

        return new Response(
          JSON.stringify({
            error: 'pot_not_found',
            tenant: tenantSlug,
            message: `No active sovereign mupot instance provisioned for '${tenantSlug}'.`,
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          error: 'dispatcher_error',
          tenant: tenantSlug,
          detail: err instanceof Error ? err.message : String(err),
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  },
}
