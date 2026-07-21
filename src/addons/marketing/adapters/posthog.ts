import { POSTHOG_TIMEOUT_MS, posthogHost } from '../../../cro/posthog'
import { useConnectorById } from '../../../connectors/service'
import type { Env } from '../../../types'
import type { MarketingMonitorSource, MonitorWindow, SourceSnapshot } from '../types'

const HOGQL_24H_ROLLUP = `
  SELECT count() AS events_24h, count(DISTINCT person_id) AS users_24h
  FROM events
  WHERE timestamp >= now() - INTERVAL 1 DAY
  LIMIT 1
`.trim()

// Organic-search session count, trailing 24h — the SAME channel definition documented at
// src/departments/channels/seo-channel.ts ("seo.organic_sessions — sessions arriving via
// organic search"). "Organic" here = a $pageview with no utm_source (not a tagged
// paid/campaign visit) AND a referring domain that is a known public search engine.
//
// This is deliberately a DIFFERENT, narrower query than HOGQL_24H_ROLLUP above. The
// vault-connector path below reuses that all-traffic rollup only as a connectivity health
// check and does NOT turn it into a marketing observation (see
// marketing-monitor-adapters.test.ts, "does not fabricate a marketing metric") — an
// unfiltered event/person count is not honestly "organic sessions" for an arbitrary
// customer-supplied PostHog project. The env-fallback path below is purpose-built for the
// pot's own tenant instead, so it runs this dedicated organic-channel query rather than
// reusing the unfiltered rollup under a mislabeled metric key.
//
// Search-engine referring-domain allowlist, expressed once so the regex escaping below is
// generated rather than hand-duplicated per domain (fewer places to get `\.` wrong).
const ORGANIC_SEARCH_DOMAINS = ['google.', 'bing.', 'duckduckgo.', 'yahoo.', 'yandex.', 'baidu.']
const ORGANIC_SEARCH_DOMAIN_PATTERN = ORGANIC_SEARCH_DOMAINS
  .map((domain) => `(^|\\.)${domain.replace(/\./g, '\\.')}`)
  .join('|')

const HOGQL_ORGANIC_SESSIONS_24H = `
  SELECT count(DISTINCT properties.$session_id) AS organic_sessions
  FROM events
  WHERE event = '$pageview'
    AND timestamp >= now() - INTERVAL 1 DAY
    AND (properties.utm_source IS NULL OR properties.utm_source = '')
    AND match(properties.$referring_domain, '${ORGANIC_SEARCH_DOMAIN_PATTERN}')
  LIMIT 1
`.trim()

interface PosthogConnectorMeta {
  readonly projectId: string
  readonly host?: string
}

function parsePosthogMeta(meta: string | null): PosthogConnectorMeta | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.projectId !== 'string' || !record.projectId.trim()) return null
    if (record.host !== undefined && (typeof record.host !== 'string' || !record.host.trim())) return null
    return {
      projectId: record.projectId.trim(),
      ...(typeof record.host === 'string' ? { host: record.host.trim() } : {}),
    }
  } catch {
    return null
  }
}

const unavailable = (): SourceSnapshot => ({
  status: 'unavailable',
  reason: 'source_unavailable',
  observations: [],
})

const failed = (): SourceSnapshot => ({
  status: 'failed',
  reason: 'source_unavailable',
  observations: [],
})

function isRedirect(response: Response): boolean {
  return response.type as string === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)
}

/**
 * Env-credentials fallback (dogfood path): runs when no vault connector is bound for this
 * slot (binding.bindingKind === 'internal_adapter', binding.connectorId === null — see
 * MARKETING_MONITOR_BINDING_CONTRACT's 'either' rule for web_analytics.posthog). Rather
 * than requiring every tenant to provision a per-tenant connector, this authenticates from
 * the Worker's own operator-set PostHog credentials — EXACTLY the same env vars and the
 * same SSRF-guarded host resolution src/cro/collect.ts / src/cro/posthog.ts already use for
 * the CRO loop. Fail-closed at every step: missing creds, a bad/private host, a non-2xx
 * response, a redirect, or a malformed body all resolve to unavailable/failed with zero
 * observations — never a fabricated value.
 */
async function readFromEnvCredentials(
  env: Env,
  runId: string,
  window: MonitorWindow,
): Promise<SourceSnapshot> {
  const projectId = env.POSTHOG_PROJECT_ID
  const key = env.POSTHOG_PERSONAL_API_KEY
  if (!projectId || !key) return unavailable()

  let host: string
  try {
    host = posthogHost(env)
  } catch {
    return failed()
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
  try {
    const endpoint = `${host}/api/projects/${encodeURIComponent(projectId)}/query/`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        // Secret ONLY here. Never logged, never echoed (mirrors src/cro/posthog.ts).
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: HOGQL_ORGANIC_SESSIONS_24H } }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (isRedirect(response) || !response.ok) return failed()
    const data = await response.json() as { results?: unknown }
    const rows = data.results
    if (!Array.isArray(rows) || rows.length === 0) return unavailable()
    const row = rows[0]
    if (!Array.isArray(row)) return unavailable()
    const organicSessions = Number(row[0])
    if (!Number.isFinite(organicSessions)) return unavailable()
    return {
      status: 'available',
      observations: [{
        id: `${runId}:posthog:organic_sessions`,
        runId,
        metricKey: 'seo.organic_sessions',
        value: organicSessions,
        unit: 'count',
        authority: 'posthog',
        // Live-fetch snapshot convention (matches inkwell/mcpwp adapters): stamp the value
        // as-of the monitor window's end, not wall-clock now, so it always falls inside the
        // window the collector validates observedAt against.
        observedAt: window.end,
      }],
    }
  } catch {
    return failed()
  } finally {
    clearTimeout(timer)
  }
}

export function createPosthogMarketingSource(runId: string): MarketingMonitorSource {
  return {
    key: 'posthog',
    slot: 'web_analytics',
    async read(env, binding, window) {
      if (!binding.connectorId) return readFromEnvCredentials(env, runId, window)
      const snapshot = await useConnectorById(env, binding.connectorId, 'posthog', async (connector) => {
        const meta = parsePosthogMeta(connector.meta)
        if (!meta) return unavailable()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
        try {
          const host = posthogHost({
            ...(meta.host ? { POSTHOG_HOST: meta.host } : {}),
          } as Env)
          const endpoint = `${host}/api/projects/${encodeURIComponent(meta.projectId)}/query/`
          const response = await connector.authenticatedFetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: { kind: 'HogQLQuery', query: HOGQL_24H_ROLLUP } }),
            redirect: 'manual',
            signal: controller.signal,
          })
          if (isRedirect(response) || !response.ok) return failed()
          await response.json()
          return { status: 'available' as const, observations: [] }
        } catch {
          return failed()
        } finally {
          clearTimeout(timer)
        }
      })
      return snapshot ?? unavailable()
    },
  }
}
