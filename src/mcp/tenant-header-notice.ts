// src/mcp/tenant-header-notice.ts — say so when a client's `x-mupot-tenant-slug` is ignored (#2035 wall 4, #1299).
//
// Tenant selection is a function of the HOSTNAME alone (src/dispatcher.ts). The header NEVER selects a tenant; this
// module only REPORTS that a header was ignored, so a client that believes it is in tenant X learns it is in Y.
// It changes no routing and reads no credential. The echoed value is client-controlled, so it is bounded to
// [a-z0-9-] and 40 chars before it can reach any text.

import { DEFAULT_ROOT_DOMAIN } from '../dispatcher'
import { RESERVED_TENANT_SLUGS } from '../pots/service'
import type { Env } from '../types'

/** Request headers a client has used to name a tenant (both are ignored by the router). */
export const TENANT_HEADER_NAMES = ['x-mupot-tenant-slug', 'x-pot-tenant'] as const
export const TENANT_NOTICE_CODE = 'tenant_header_ignored'
/** HTTP response header carrying the notice on EVERY response of a request that sent a mismatching header. */
export const TENANT_NOTICE_RESPONSE_HEADER = 'x-mupot-tenant-header-ignored'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const MAX_ECHO = 40

export interface TenantHeaderNotice {
  code: typeof TENANT_NOTICE_CODE
  /** The bounded echo of the header value ([a-z0-9-], <= 40 chars). */
  header_value: string
  resolved_tenant: string
  /** True only when the value is a well-formed slug of an active registered pot. */
  known_tenant: boolean
  /** Only when known_tenant: the URL forms that exist in the router. */
  use_instead?: { tenant_host: string; apex_path: string }
  line: string
}

/** Bound a client-supplied value for echo: lower-case, [a-z0-9-] only, <= 40 chars. Never throws. */
export function boundTenantHeaderValue(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, MAX_ECHO)
}

/** The first tenant-naming header present (slug header wins), trimmed; null when absent or blank. */
export function readTenantHeader(headers: Headers): string | null {
  for (const name of TENANT_HEADER_NAMES) {
    const v = headers.get(name)
    if (v !== null && v.trim().length > 0) return v.trim()
  }
  return null
}

async function isKnownTenant(env: Env, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug) || RESERVED_TENANT_SLUGS.has(slug) || !env.DB) return false
  try {
    // Same predicate the apex /t/ door uses (src/dispatcher.ts isRegisteredActivePot).
    const row = await env.DB.prepare("SELECT 1 AS ok FROM pots WHERE slug = ?1 AND worker_script = ?1 AND status = 'active' LIMIT 1").bind(slug).first()
    return row !== null
  } catch {
    return false
  }
}

function rootHost(env: Env, resolved: string): string {
  try {
    if (env.PUBLIC_ORIGIN) {
      const host = new URL(env.PUBLIC_ORIGIN).hostname
      const prefix = `${resolved.toLowerCase()}.`
      return host.startsWith(prefix) ? host.slice(prefix.length) : host
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_ROOT_DOMAIN
}

/** The notice for a request, or null when the header is absent or names the resolved tenant. */
export async function tenantHeaderNotice(env: Env, headers: Headers): Promise<TenantHeaderNotice | null> {
  const raw = readTenantHeader(headers)
  if (raw === null) return null
  const resolved = (env.TENANT_SLUG ?? '').toLowerCase()
  if (raw.toLowerCase() === resolved) return null
  const echo = boundTenantHeaderValue(raw)
  const shown = echo.length > 0 ? echo : '(unprintable)'
  // The comparison above is on the raw value; a value that only equals the tenant after bounding is not "the tenant".
  const known = echo !== resolved && (await isKnownTenant(env, echo))
  if (!known) {
    return {
      code: TENANT_NOTICE_CODE, header_value: shown, resolved_tenant: resolved, known_tenant: false,
      line: `tenant header '${shown}' ignored; you are in tenant '${resolved}'. unknown tenant '${shown}'.`,
    }
  }
  const root = rootHost(env, resolved)
  const use = { tenant_host: `https://${echo}.${root}/mcp`, apex_path: `https://${root}/t/${echo}/mcp` }
  return {
    code: TENANT_NOTICE_CODE, header_value: echo, resolved_tenant: resolved, known_tenant: true, use_instead: use,
    line: `tenant header '${echo}' ignored; you are in tenant '${resolved}'. To reach ${echo} use ${use.tenant_host} or /t/${echo}/mcp`,
  }
}
