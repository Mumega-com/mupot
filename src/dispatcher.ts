// src/dispatcher.ts — Cloudflare Workers for Platforms (WFP) root dispatch router.
//
// Routes incoming requests for `<org>.mupot.mumega.com` or custom domains
// to the dedicated isolated user Worker in the `mupot-pots` dispatch namespace.
//
// Invariants (docs/workers-for-platforms.md):
//   1. Each user Worker runs in its own V8 isolate with dedicated D1, KV, R2, and Queue bindings.
//   2. Caches are disabled inside dispatch namespaces; zero `caches.default` / `caches.open`.
//   3. Single billed request across the chain: Dispatch Worker -> User Worker.

import { RESERVED_TENANT_SLUGS } from './pots/service'

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
  DEFAULT_CPU_MS?: number // default 50ms
  DEFAULT_SUBREQUESTS?: number // default 50
}

export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'
// The apex's own pot. NOTE (mupot#1301 review): this constant is the ONLY thing that
// resolves the apex, and src/index.ts separately hardcodes `tenantSlug !== 'mumega'` in
// its dispatch guard — two copies of one predicate, in a repo documented as designed to
// be forked. A colony deployed with TENANT_SLUG !== 'mumega' is protected from
// dispatching its own apex into the namespace only by that duplicated literal. The dead
// `FALLBACK_POT` env field that used to imply this was configurable has been removed
// rather than left to read as a knob that does nothing; making it genuinely configurable
// is tracked separately.
export const DEFAULT_FALLBACK_POT = 'mumega'
export const DEFAULT_DISPATCH_LIMITS = {
  cpuMs: 50,
  subRequests: 50,
} as const

// TENANT SELECTION IS A FUNCTION OF THE HOSTNAME ALONE (mupot#1299).
//
// This used to accept a third `headerSlug` argument, read from a client-supplied
// `x-mupot-tenant-slug` / `x-pot-tenant` request header, and it took PRIORITY over the
// hostname. That made "which tenant Worker serves this request" an unauthenticated
// choice made by the caller: measured live on prod at 8ff9b8e2, an anonymous
// `GET https://mupot.mumega.com/health` carrying that header was answered by the named
// tenant's Worker instead of the colony's.
//
// The parameter is GONE rather than gated, because a gated version has to be correct at
// every call site forever, and there were already two independent readers of the header
// (this file and src/index.ts) that had to agree. A signature that cannot express the
// unsafe call cannot be called unsafely.
//
// The credential half of the hazard closes with it: hostname routing means a browser only
// ever sends cookies the browser itself scoped to that hostname. mupot's session cookie is
// set with no `Domain=` attribute (src/auth/index.ts setSessionCookie), so it is host-only
// and never reaches a tenant subdomain. Forwarding headers to the User Worker is therefore
// correct here — stripping Cookie/Authorization would break a tenant's own logged-in users.
// That reasoning depends on the cookie staying host-only, so it is pinned by an assertion
// in tests/auth-dev-login.test.ts (next to setSessionCookie, the code that would break it).
// NOTE: only the SESSION cookie is pinned. The OAuth CSRF and consent cookies in
// src/mcp/oauth-authorize.ts also omit Domain= today, but nothing asserts that.
export function extractTenantSlug(
  hostname: string,
  rootDomain: string = DEFAULT_ROOT_DOMAIN,
): string {
  // A TRAILING DOT IS A LEGAL, FULLY-QUALIFIED HOSTNAME, and it reached production.
  // `Host: mupot.mumega.com.` survives the Cloudflare edge (Host and SNI still match) and
  // is preserved in req.url, so before this normalization the apex failed BOTH the
  // `=== cleanRoot` and the `.endsWith('.' + cleanRoot)` tests, fell through to the
  // custom-domain branch, and produced the slug `mupot-mumega-com-` — which was then
  // handed verbatim to DISPATCHER.get() as a script name, unauthenticated, ahead of all
  // auth. It failed closed only because no Worker happens to carry that name. Measured
  // live on 2026-09-04 (mupot#1301 review):
  //   curl --resolve 'mupot.mumega.com.:443:<ip>' https://mupot.mumega.com./health
  //   -> {"error":"pot_not_found","tenant":"mupot-mumega-com-"}
  // It also knocked the colony off its own app for any request that appended a dot.
  const cleanHost = hostname.toLowerCase().split(':')[0].replace(/\.+$/, '')
  const cleanRoot = rootDomain.toLowerCase().split(':')[0].replace(/\.+$/, '')

  if (cleanHost === cleanRoot || cleanHost === `www.${cleanRoot}`) {
    return DEFAULT_FALLBACK_POT
  }

  if (cleanHost.endsWith(`.${cleanRoot}`)) {
    const sub = cleanHost.slice(0, -(cleanRoot.length + 1))
    const parts = sub.split('.')
    // Sanitized on the SAME terms as the custom-domain branch below. This label used to be
    // returned raw (lowercased only) and is interpolated into HTML by
    // renderUnprovisionedPotHtml; the only thing standing between that and reflected XSS
    // was WHATWG `new URL()` rejecting forbidden host code points before `url.hostname`
    // exists — an implicit dependency, on a surface that runs before all auth. Both
    // branches now emit the same shape, so the render has one contract instead of two.
    return sanitizeSlug(parts[parts.length - 1]) || DEFAULT_FALLBACK_POT
  }

  // Custom domains (Cloudflare for SaaS CNAMEs) default to sanitized host slug
  return sanitizeSlug(cleanHost)
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
  | { kind: 'reserved'; slug: string }

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
  // Reserved infrastructure names can never own a tenant worker (see
  // RESERVED_TENANT_SLUGS in src/pots/service.ts) — refuse before dispatch.
  if (RESERVED_TENANT_SLUGS.has(parsed.slug)) {
    return { kind: 'reserved', slug: parsed.slug }
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

export interface ApexPathEnv {
  PUBLIC_ORIGIN?: string
  TENANT_SLUG?: string
  DISPATCHER?: DispatcherEnv['DISPATCHER']
}

export type ApexPathRoute =
  | { kind: 'passthrough' }
  | { kind: 'home'; request: Request }
  | { kind: 'respond'; response: Response }

/**
 * Route one apex `/t/{tenant}/{interface}` request. Returns `passthrough` when
 * the path is not a tenant address, the rewritten home request for this
 * Worker's own slug, or a terminal response (reserved slug, unbound
 * dispatcher, dispatched tenant response). Extracted so the routing contract
 * is unit-testable without booting the full Worker entry.
 */
export async function routeApexPathTenant(req: Request, env: ApexPathEnv): Promise<ApexPathRoute> {
  const rootHost = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).hostname : DEFAULT_ROOT_DOMAIN
  const homeSlug = (env.TENANT_SLUG || 'mumega').toLowerCase()
  const pathTenant = resolveApexPathTenant(req, homeSlug, rootHost)
  if (!pathTenant) return { kind: 'passthrough' }
  if (pathTenant.kind === 'home') return { kind: 'home', request: pathTenant.request }
  if (pathTenant.kind === 'reserved') {
    return {
      kind: 'respond',
      response: new Response(
        JSON.stringify({
          error: 'reserved_slug',
          tenant: pathTenant.slug,
          message: `Slug '${pathTenant.slug}' is reserved infrastructure and cannot name a tenant.`,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    }
  }
  if (!env.DISPATCHER) {
    return {
      kind: 'respond',
      response: new Response(
        JSON.stringify({
          error: 'unconfigured',
          tenant: pathTenant.slug,
          message: 'Cloudflare dispatch namespace is not bound; cannot route /t/{tenant}.',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    }
  }
  // No FALLBACK_POT: that field was removed from DispatcherEnv in mupot#1301 because
  // nothing ever read it — extractTenantSlug returns the module constant. Passing it here
  // would re-add a knob that does nothing.
  const response = await dispatcher.fetch(pathTenant.request, {
    DISPATCHER: env.DISPATCHER,
    ROOT_DOMAIN: rootHost,
  })
  return { kind: 'respond', response }
}


/** The one normalization both hostname branches emit. Substitutes, never shortens. */
function sanitizeSlug(label: string): string {
  return label.replace(/[^a-z0-9-]/g, '-')
}

/** Escapes text interpolated into the unprovisioned-pot page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Exported for test. It must be safe for ANY input, not merely for what sanitizeSlug
// happens to emit today — otherwise the render's safety is a property of its caller, and
// a future change to the sanitizer silently un-fixes it. Verified by mutation: with the
// escaping removed, a test that only routes hostile input THROUGH the sanitizer stays
// green, because sanitization strips `<` first. The two guards must be proven separately.
export function renderUnprovisionedPotHtml(tenantSlug: string): string {
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
    <p>No active sovereign mupot instance found for <span class="code">${escapeHtml(tenantSlug)}</span>. Each organization runs in an isolated V8 container with dedicated D1 storage.</p>
    <a href="https://mupot.mumega.com/signup" class="btn">Provision Sovereign Pot</a>
  </div>
</body>
</html>`
}

const dispatcher = {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url)
    const rootDomain = env.ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN
    // No header is consulted: see extractTenantSlug (mupot#1299).
    const tenantSlug = extractTenantSlug(url.hostname, rootDomain)

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

export default dispatcher

