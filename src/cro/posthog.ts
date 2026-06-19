// mupot — the PostHog CRO source: the first EXTERNAL connector on the data fabric
// (CRO epic, slice 2 "Connectors — PostHog first").
//
// PostHog is the pot's product-analytics warehouse. This adapter reads a small,
// SERVER-AGGREGATED conversion signal (24h event volume + 24h unique users) via the
// PostHog Query API (HogQL) and normalizes it into CroMetric points. The CRO loop then
// perceives engagement trend without the pot ever rebuilding analytics.
//
// DESIGN (the choices the gate will probe):
//   1. AGGREGATE, not raw rows. The HogQL is a `count()` / `count(DISTINCT …)` rollup that
//      returns ONE row. There is no pagination surface — the result set is bounded by
//      construction, so a hostile/huge response is impossible from this query. (A future
//      time-series variant MUST add an explicit row LIMIT + cap; this one doesn't need it
//      because the aggregate is single-row. We still slice defensively.)
//   2. ROLLING-WINDOW SNAPSHOT at tick time. occurred_at = now (the collection moment),
//      exactly like the growth collector. Each cron tick writes a fresh reading of the
//      trailing-24h volume; the pulse spine buckets ticks into an intraday OHLC candle.
//      This avoids the day-bucket dedup-freeze you'd get if occurred_at were "midnight of
//      day X" (the metric_points UNIQUE on (tenant,key,occurred_at,source) would lock
//      today's value at the first tick and never update).
//   3. FAIL-CLOSED + FAIL-SOFT. No key/project ⇒ available()=false (skipped, never blocks
//      the fabric). A bad host, non-2xx, timeout, or malformed body ⇒ collect() throws and
//      the collector records ok:false for this source and degrades gracefully.
//   4. SECRET DISCIPLINE. The personal API key travels ONLY in the Authorization header,
//      is never logged, never returned, never persisted. Error messages carry the HTTP
//      status, never the request detail.
//   5. NO SSRF. The host is operator-set env (POSTHOG_HOST, default US cloud) — never
//      client input — and is validated through the SHARED hardened guard (src/lib/ssrf.ts):
//      https + a PUBLIC host. Loopback / RFC1918 / link-local / cloud-metadata / ULA /
//      IPv4-mapped-IPv6 are all blocked, so a misconfigured or hostile POSTHOG_HOST cannot
//      point the cron at an internal target (#219 BLOCK-1, Codex cross-vendor catch).

import type { Env } from '../types'
import type { CroMetric, CroSource } from './sources'
import { assertPublicHttpsUrl } from '../lib/ssrf'

export const POSTHOG_KEY = 'posthog'

// Default PostHog cloud host (US region — the pot's project 436189 lives here). Operators
// on EU cloud / self-host override via POSTHOG_HOST. Always https; validated below.
export const POSTHOG_DEFAULT_HOST = 'https://us.posthog.com'

// Outbound timeout — a hung PostHog API must never stall the cron invocation. The whole
// scheduled() handler shares the Worker's wall-clock budget across all heartbeats.
export const POSTHOG_TIMEOUT_MS = 8000

// The conversion-signal rollup. Single-row aggregate over the trailing 24h:
//   - events_24h : total events captured (engagement volume floor — always present)
//   - users_24h  : distinct persons seen (reach)
// LIMIT 1 is defensive belt-and-suspenders; a pure aggregate already returns one row.
const HOGQL_24H_ROLLUP = `
  SELECT count() AS events_24h, count(DISTINCT person_id) AS users_24h
  FROM events
  WHERE timestamp >= now() - INTERVAL 1 DAY
  LIMIT 1
`.trim()

/** Shape of the PostHog Query API response we depend on (subset). */
interface PostHogQueryResponse {
  results?: unknown
}

/**
 * Validate + normalize the PostHog base host. Operator-set env only (never client input).
 * Must be a parseable https URL with a PUBLIC host (the shared SSRF guard blocks loopback /
 * RFC1918 / link-local / metadata / ULA / IPv4-mapped-IPv6). Returns the origin (drops any
 * path/userinfo/query). Throws a stable code-string otherwise so collect() records an honest
 * error rather than firing a request at a bad/insecure/internal URL.
 *   posthog_host_unparseable | posthog_host_not_https | posthog_host_private
 */
export function posthogHost(env: Env): string {
  const raw = (env.POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST).trim()
  try {
    return assertPublicHttpsUrl(raw).origin
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_unparseable'
    if (code === 'url_not_https') throw new Error('posthog_host_not_https')
    if (code === 'url_private_host') throw new Error('posthog_host_private')
    throw new Error('posthog_host_unparseable')
  }
}

export const posthogCroSource: CroSource = {
  key: POSTHOG_KEY,
  label: 'PostHog (product analytics)',

  // Connected iff the credential + project are present. Cheap (no network) — collect()
  // owns the actual call and its failure handling. Fail-closed: missing either ⇒ skipped.
  async available(env: Env): Promise<boolean> {
    return Boolean(env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID)
  },

  async collect(env: Env): Promise<CroMetric[]> {
    const key = env.POSTHOG_PERSONAL_API_KEY
    const projectId = env.POSTHOG_PROJECT_ID
    if (!key || !projectId) return [] // defensive — available() already gates this

    const host = posthogHost(env) // throws on a bad/insecure host → recorded ok:false
    // PostHog Query API. projectId is operator-set env; encode defensively all the same.
    const endpoint = `${host}/api/projects/${encodeURIComponent(projectId)}/query/`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
    // Keep the abort armed across BOTH the fetch AND the body read (WARN-1, Opus): a server
    // that returns headers fast but hangs the body stream must still be bounded by the
    // timeout. The signal is on the fetch; the json() read inherits the abort because it is
    // inside the same armed window, and clearTimeout only fires once the body is fully read.
    let data: PostHogQueryResponse
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          // Secret ONLY here. Never logged, never echoed.
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: HOGQL_24H_ROLLUP } }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // Carry the status, never the request detail (keeps secret-discipline tight).
        throw new Error(`posthog_query_http_${res.status}`)
      }
      data = (await res.json()) as PostHogQueryResponse
    } finally {
      clearTimeout(timer)
    }
    const rows = data.results
    // Aggregate ⇒ exactly one row. Defensive slice(0,1): a future query shape change can't
    // amplify this adapter's output beyond the single aggregate row we asked for.
    if (!Array.isArray(rows) || rows.length === 0) return []
    const row = rows[0]
    if (!Array.isArray(row)) return []

    // occurred_at = the collection moment (rolling-window snapshot, tick-time convention).
    const occurredAt = new Date().toISOString()
    const out: CroMetric[] = []

    const events = Number(row[0])
    if (Number.isFinite(events)) {
      out.push({ metric_key: 'cro.posthog.events_24h', value: events, occurred_at: occurredAt })
    }
    const users = Number(row[1])
    if (Number.isFinite(users)) {
      out.push({ metric_key: 'cro.posthog.users_24h', value: users, occurred_at: occurredAt })
    }
    return out
  },
}
