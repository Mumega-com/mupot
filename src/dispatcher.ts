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
}

const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'
const DEFAULT_FALLBACK_POT = 'mumega'

export function extractTenantSlug(hostname: string, rootDomain: string = DEFAULT_ROOT_DOMAIN): string {
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

  // Custom domains (Cloudflare for SaaS CNAMEs) default to host slug
  return cleanHost.replace(/[^a-z0-9-]/g, '-')
}

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url)
    const rootDomain = env.ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN
    const tenantSlug = extractTenantSlug(url.hostname, rootDomain)

    try {
      const userWorker = env.DISPATCHER.get(tenantSlug)
      return await userWorker.fetch(request)
    } catch (err) {
      const isNotFound = err instanceof Error && (err.message.includes('not found') || err.message.includes('No user worker'))
      if (isNotFound) {
        return new Response(
          JSON.stringify({
            error: 'pot_not_found',
            tenant: tenantSlug,
            message: `No active mupot instance provisioned for '${tenantSlug}'.`,
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
