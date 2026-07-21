import {
  MARKETING_MONITOR_METRIC_CONTRACT,
  MARKETING_MONITOR_METRIC_KEYS,
  type MarketingMonitorMetricKey,
  type MarketingMonitorSource,
  type SourceObservation,
} from '../types'

const FIRST_PARTY_AUTHORITY = 'first-party'
const MAX_OBSERVATIONS = 100

/** Metric keys the first-party adapter is allowed to emit. */
const FIRST_PARTY_MARKETING_KEYS = Object.freeze(
  MARKETING_MONITOR_METRIC_KEYS.filter((key) => (
    (MARKETING_MONITOR_METRIC_CONTRACT[key].authorities as readonly string[])
      .includes(FIRST_PARTY_AUTHORITY)
  )),
)

function isMarketingMetricKey(value: string): value is MarketingMonitorMetricKey {
  return Object.prototype.hasOwnProperty.call(MARKETING_MONITOR_METRIC_CONTRACT, value)
}

/**
 * Read marketing metric_points for this tenant inside the monitor window.
 *
 * Intentionally does NOT reuse cro/first-party's LIMIT-200 recent scan: that
 * query is flooded by cro.posthog.* ticks and crowds out seo/growth metric rows
 * the marketing monitor needs to rank opportunities.
 */
export function createFirstPartyMarketingSource(runId: string): MarketingMonitorSource {
  return {
    key: 'first_party',
    slot: 'web_analytics',
    async read(env, _binding, window) {
      const tenantId = env.TENANT_SLUG
      if (!tenantId || FIRST_PARTY_MARKETING_KEYS.length === 0) {
        return { status: 'available', observations: [] }
      }

      const placeholders = FIRST_PARTY_MARKETING_KEYS.map(() => '?').join(', ')
      const result = await env.DB.prepare(
        `SELECT metric_key, value, occurred_at
           FROM metric_points
          WHERE tenant_id = ?
            AND metric_key IN (${placeholders})
            AND occurred_at >= ?
            AND occurred_at <= ?
          ORDER BY occurred_at DESC
          LIMIT ${MAX_OBSERVATIONS}`,
      )
        .bind(tenantId, ...FIRST_PARTY_MARKETING_KEYS, window.start, window.end)
        .all<{ metric_key: string; value: number; occurred_at: string }>()

      const observations: SourceObservation[] = []
      const rows = result.results ?? []
      for (let index = 0; index < rows.length && observations.length < MAX_OBSERVATIONS; index += 1) {
        const point = rows[index]
        if (!isMarketingMetricKey(point.metric_key)) continue
        if (typeof point.value !== 'number' || !Number.isFinite(point.value)) continue
        if (typeof point.occurred_at !== 'string' || !point.occurred_at) continue
        const contract = MARKETING_MONITOR_METRIC_CONTRACT[point.metric_key]
        if (!(contract.authorities as readonly string[]).includes(FIRST_PARTY_AUTHORITY)) continue
        observations.push({
          id: `${runId}:first_party:${index}`,
          runId,
          metricKey: point.metric_key,
          value: point.value,
          unit: contract.unit,
          authority: FIRST_PARTY_AUTHORITY,
          observedAt: point.occurred_at,
        })
      }

      return { status: 'available', observations }
    },
  }
}
