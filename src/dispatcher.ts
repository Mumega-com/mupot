// src/dispatcher.ts — Cloudflare Workers for Platforms (WFP) root dispatch router.
//
// Routes incoming requests for `<org>.mupot.mumega.com` or custom domains
// to the dedicated isolated user Worker in the `mupot-pots` dispatch namespace.
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

export function extractTenantSlug(
  hostname: string,
  rootDomain: string = DEFAULT_ROOT_DOMAIN,
  headerSlug?: string | null,
): string {
  if (headerSlug && /^[a-z0-9-_]+$/i.test(headerSlug.trim())) {
    return headerSlug.trim().toLowerCase()
  }

  const cleanHost = hostname.toLowerCase().split(':')[0]
  const cleanRoot = rootDomain.toLowerCase().split(':')[0]

  if (cleanHost === cleanRoot || cleanHost === `www.${cleanRoot}`) {
    return DEFAULT_FALLBACK_POT
  }

  if (cleanHost.endsWith(`.${cleanRoot}`)) {
    const sub = cleanHost.slice(0, -(cleanRoot.length + 1))
    const parts = sub.split('.')
    return parts[parts.length - 1] || DEFAULT_FALLBACK_POT
  }

  // Custom domains (Cloudflare for SaaS CNAMEs) default to sanitized host slug
  return cleanHost.replace(/[^a-z0-9-]/g, '-')
}

const PATH_TENANT_RE = /^\/t\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(\/.*)?$/i

/** Apex path ` /t/{tenant}/{interface} ` e.g. `/t/gaf/mcp`. */
export function extractPathTenant(pathname: string): { slug: string; remainder: string } | null {
  const match = pathname.match(PATH_TENANT_RE)
  if (!match) return null
  const slug = match[1].toLowerCase()
  const rest = match[2]
  const remainder = rest && rest.length > 0 ? rest : '/'
  return { slug, remainder }
}

export type ApexPathTenant =
  | { kind: 'home'; request: Request; slug: string }
  | { kind: 'dispatch'; request: Request; slug: string }

function rewriteRequest(request: Request, hostname: string, pathname: string): Request {
  const url = new URL(request.url)
  url.hostname = hostname
  url.pathname = pathname
  return new Request(url, request)
}

// Headers a client must never use to retarget a resolved path tenant.
const TENANT_OVERRIDE_HEADERS = ['x-mupot-tenant-slug', 'x-pot-tenant']
// Colony credentials that must never ride into a foreign tenant isolate.
// The path door is same-origin (`mupot.mumega.com`), so unlike subdomain
// routing the browser/operator credentials arrive with the request — strip
// them before dispatch. Tenant Workers authenticate through their own door.
const CREDENTIAL_HEADERS = ['cookie', 'authorization', 'proxy-authorization']

function stripHeaders(request: Request, names: string[]): Request {
  const headers = new Headers(request.headers)
  for (const name of names) headers.delete(name)
  return new Request(request, { headers })
}

/**
 * On the colony apex, `/t/{slug}/{interface}` is the tenant URL.
 * Home slug stays on this Worker with the prefix stripped.
 * Any other slug is rewritten to `{slug}.{rootDomain}{interface}` for WFP dispatch.
 */
export function resolveApexPathTenant(
  request: Request,
  homeSlug: string,
  rootDomain: string = DEFAULT_ROOT_DOMAIN,
): ApexPathTenant | null {
  const url = new URL(request.url)
  const parsed = extractPathTenant(url.pathname)
  if (!parsed) return null
  const home = homeSlug.toLowerCase()
  if (parsed.slug === home) {
    // Home stays on this Worker (same isolate, colony credentials valid),
    // but the tenant-override headers must die here so the downstream
    // header dispatch in index.ts cannot retarget a resolved path.
    const homeRequest = stripHeaders(
      rewriteRequest(request, url.hostname, parsed.remainder),
      TENANT_OVERRIDE_HEADERS,
    )
    return { kind: 'home', slug: parsed.slug, request: homeRequest }
  }
  // Foreign tenant: the rewritten request carries no client tenant-override
  // and no colony credentials into the isolate (Athena gate 2026-09-04).
  const dispatchRequest = stripHeaders(
    rewriteRequest(request, `${parsed.slug}.${rootDomain}`, parsed.remainder),
    [...TENANT_OVERRIDE_HEADERS, ...CREDENTIAL_HEADERS],
  )
  return {
    kind: 'dispatch',
    slug: parsed.slug,
    request: dispatchRequest,
  }
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
    const headerSlug = request.headers.get('x-mupot-tenant-slug') || request.headers.get('x-pot-tenant')
    const tenantSlug = extractTenantSlug(url.hostname, rootDomain, headerSlug)

    const limits = {
      cpuMs: env.DEFAULT_CPU_MS ?? DEFAULT_DISPATCH_LIMITS.cpuMs,
      subRequests: env.DEFAULT_SUBREQUESTS ?? DEFAULT_DISPATCH_LIMITS.subRequests,
    }

    try {
      const userWorker = env.DISPATCHER.get(tenantSlug, {}, { limits })
      return await userWorker.fetch(request)
    } catch (err) {
      const isNotFound = err instanceof Error && (err.message.includes('not found') || err.message.includes('No user worker'))
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

