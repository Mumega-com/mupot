// mupot — mcpwp-office addon: health check (mupot#1580 slice 1).
//
// NOT wired into any generic addon health-check runner or console panel — none
// exists. `AddonManifestV1.healthChecks` (src/addons/contract.ts:71) is validated
// only as a non-empty, de-duplicated string array (src/addons/contract.ts's
// isStringArray call at line 427); nothing in this codebase reads, executes, or
// renders those strings (confirmed: no reference to `healthChecks` outside a
// manifest literal anywhere in src/, and src/dashboard/addons.ts never mentions
// health at all). Per this task's own instruction ("if the addon framework lacks
// a seam you need... stop and report the gap instead of inventing a parallel
// mechanism"), this file does NOT invent a generic runner — it is one addon's own
// health-check function, tested directly, exactly the way torivers.ts's bespoke
// GET /health route is that addon's own thing (src/addons/torivers.ts:50-58). See
// the PR description for the full gap report (file:line) and the follow-up issue.
//
// Two checks, matching the two entries in McpwpOfficeAddon.healthChecks
// (src/addons/office/manifest.ts): 'wordpress_site_endpoint_reachable' and
// 'wordpress_site_key_valid'. Both are answered by ONE round trip — a JSON-RPC
// `initialize` call against the mcpwp MCP endpoint — because an authenticated
// 200 proves both reachability and key validity, and a 401/403 proves the
// endpoint is reachable but the key is not.
//
// SSRF: the connector's stored siteUrl is asserted https + public-host BEFORE
// any network call (assertPublicHttpsUrl, src/lib/ssrf.ts) — mirrors
// src/addons/marketing/adapters/mcpwp.ts's own use of the same guard.
//
// Secrecy: the WordPress application-password/API key is never read by this
// file. It is decrypted and applied ONLY inside connectors/service.ts's
// useConnectorById, via connector.authenticatedFetch() — this function only ever
// sees the resulting Response, never the credential. useConnectorById's own
// safeImmediateResult wrapper additionally throws if the returned value ever
// contains the raw secret, so a future edit to this file that accidentally
// echoed it back would fail loudly rather than leak silently.

import { useConnectorById, type ImmediateConnectorUse } from '../../connectors/service'
import { assertPublicHttpsUrl } from '../../lib/ssrf'
import type { Env } from '../../types'

export const MCPWP_OFFICE_HEALTH_TIMEOUT_MS = 8_000
const MCPWP_MCP_PATH = '/wp-json/mcpwp/v1/mcp'

export type McpwpOfficeHealthReason =
  | 'connector_unavailable'
  | 'invalid_site_config'
  | 'invalid_site_url'
  | 'unreachable'
  | 'key_invalid'

export interface McpwpOfficeHealthResult {
  readonly status: 'available' | 'unavailable' | 'failed'
  readonly observations: readonly []
  readonly reason?: McpwpOfficeHealthReason
}

function unavailable(reason: McpwpOfficeHealthReason): McpwpOfficeHealthResult {
  return { status: 'unavailable', reason, observations: [] }
}

function failed(reason: McpwpOfficeHealthReason): McpwpOfficeHealthResult {
  return { status: 'failed', reason, observations: [] }
}

function healthy(): McpwpOfficeHealthResult {
  return { status: 'available', observations: [] }
}

function isRedirect(response: Response): boolean {
  return (response.type as string) === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)
}

export interface SiteConnectorConfig {
  readonly siteUrl: string
}

export function parseSiteConnectorConfig(meta: string | null): SiteConnectorConfig | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.siteUrl !== 'string' || !record.siteUrl.trim()) return null
    return { siteUrl: record.siteUrl.trim() }
  } catch {
    return null
  }
}

/**
 * checkMcpwpOfficeHealth — the mcpwp-office addon's own health probe.
 *
 * Resolves the bound 'wordpress_site' connector by id, asserts its stored
 * siteUrl is a public https URL (SSRF guard — throws BEFORE any fetch), then
 * POSTs a JSON-RPC `initialize` request to `<siteUrl-path>/wp-json/mcpwp/v1/mcp`
 * (the FULL stored path, not just the origin — a subdirectory WordPress install
 * needs its own path preserved) through the connector's one-shot authenticatedFetch:
 *   - 200 (any well-formed response)      -> { status: 'available' }               (both checks pass)
 *   - 401 or 403                          -> { status: 'failed', reason: 'key_invalid' }
 *   - any other non-2xx, redirect, thrown, or timed-out response
 *                                          -> { status: 'failed', reason: 'unreachable' }
 *   - connector missing/wrong type/meta unparsable
 *                                          -> { status: 'unavailable', reason: ... }
 */
export async function checkMcpwpOfficeHealth(
  env: Env,
  connectorId: string | null,
): Promise<McpwpOfficeHealthResult> {
  if (!connectorId) return unavailable('connector_unavailable')

  const result = await useConnectorById(env, connectorId, 'mcpwp', async (connector: ImmediateConnectorUse) => {
    const config = parseSiteConnectorConfig(connector.meta)
    if (!config) return unavailable('invalid_site_config')

    let base: URL
    try {
      base = assertPublicHttpsUrl(config.siteUrl)
    } catch {
      return unavailable('invalid_site_url')
    }

    // Resolve against the FULL stored URL, not just its origin — a WordPress site
    // installed under a subdirectory (e.g. https://example.com/blog) must probe
    // https://example.com/blog/wp-json/mcpwp/v1/mcp, not the bare-origin path (P3
    // fix: `new URL(MCPWP_MCP_PATH, base.origin)` silently dropped `base.pathname`
    // and always probed the wrong endpoint for any non-root install).
    const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
    const endpoint = new URL(`${basePath}${MCPWP_MCP_PATH}`, base.origin)

    // mupot#1587 P1-A (round-2 gate on #1582): assertPublicHttpsUrl above only ever
    // validated `config.siteUrl` (i.e. `base`) — but `endpoint` is then REBUILT by
    // concatenating `basePath` (attacker/operator-controlled: it comes straight from
    // the stored siteUrl's own pathname) into a new URL string and re-parsing it. The
    // WHATWG URL parser treats a string beginning `//` as SCHEME-RELATIVE — it takes
    // everything after the slashes as a NEW AUTHORITY (host), not a path segment — so
    // a stored siteUrl of `https://blog.example.com//169.254.169.254/x` yields
    // `basePath = '//169.254.169.254/x'`, and `new URL(basePath + MCPWP_MCP_PATH,
    // base.origin)` silently resolves to `https://169.254.169.254/x/wp-json/...` —an
    // entirely different, private/metadata host — with the vaulted Basic credential
    // still attached by authenticatedFetch below. A leading `\\` reaches the same
    // outcome (the URL parser normalizes backslashes to forward slashes for special
    // schemes before this same scheme-relative rule applies). Re-validating `endpoint`
    // from scratch (assertPublicHttpsUrl again, not just re-checking the host inline)
    // AND requiring its origin to be BYTE-IDENTICAL to `base`'s origin closes this:
    // any string that caused the rebuild to change host, port, or scheme is refused
    // here, before authenticatedFetch is ever called — zero fetches, credential never
    // sent. This must run on every request; it is not a one-time check on `siteUrl`.
    try {
      assertPublicHttpsUrl(endpoint.href)
    } catch {
      return unavailable('invalid_site_url')
    }
    if (endpoint.origin !== base.origin) return unavailable('invalid_site_url')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MCPWP_OFFICE_HEALTH_TIMEOUT_MS)
    try {
      const response = await connector.authenticatedFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'mupot-office-addon-health/1.0' },
        redirect: 'manual',
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'mupot-office-health', method: 'initialize', params: {} }),
      })
      if (response.status === 401 || response.status === 403) return failed('key_invalid')
      if (isRedirect(response) || !response.ok) return failed('unreachable')
      return healthy()
    } catch {
      return failed('unreachable')
    } finally {
      clearTimeout(timer)
    }
  })

  return result ?? unavailable('connector_unavailable')
}
