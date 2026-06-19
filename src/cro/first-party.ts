// mupot — the first-party CRO source: the always-on, zero-credential floor (CRO epic, slice 1).
//
// The pot already collects its OWN signal into metric_points (growth/seo/ops/finance series,
// via the department collectors + pulse). The first-party CRO source surfaces the
// conversion-relevant slice of that — so the CRO loop has a baseline BEFORE any external
// connector (PostHog/GSC/Ads/CRM) is added, and needs no credential. `available()` is always
// true; `collect()` reads the recent CRO-relevant metric_points for this pot.

import type { Env } from '../types'
import type { CroMetric, CroSource } from './sources'

export const FIRST_PARTY_KEY = 'first_party'

// Metric-key prefixes that count as conversion-relevant first-party signal. The pot's own
// collectors emit these (see migrations/0028 comment: 'growth.leads' | 'finance.revenue' |
// 'ops.throughput', plus 'seo.%' from the SEO collector). The reasoner decides what to act on;
// the source just surfaces what's there. Kept as an explicit allowlist so an unrelated series
// can't masquerade as CRO signal.
export const CRO_FIRST_PARTY_PREFIXES: readonly string[] = ['cro.', 'growth.', 'seo.', 'finance.', 'ops.']

const MAX_POINTS = 200

/** How many recent CRO-relevant first-party points to surface. */
export function firstPartyWhereClause(): string {
  return CRO_FIRST_PARTY_PREFIXES.map(() => 'metric_key LIKE ?').join(' OR ')
}

export const firstPartyCroSource: CroSource = {
  key: FIRST_PARTY_KEY,
  label: 'First-party (this pot)',

  // The floor is always connected — the pot owns its own data, no credential needed.
  async available(): Promise<boolean> {
    return true
  },

  async collect(env: Env): Promise<CroMetric[]> {
    const tenantId = env.TENANT_SLUG
    if (!tenantId) return []

    // Read recent CRO-relevant points. Prefix-bound via parameterized LIKE (the '%' is
    // appended to a fixed, code-controlled prefix — never to user input), so no injection.
    const likeBinds = CRO_FIRST_PARTY_PREFIXES.map((p) => `${p}%`)
    const where = firstPartyWhereClause()
    const result = await env.DB.prepare(
      `SELECT metric_key, value, occurred_at
         FROM metric_points
        WHERE tenant_id = ? AND (${where})
        ORDER BY occurred_at DESC
        LIMIT ${MAX_POINTS}`,
    )
      .bind(tenantId, ...likeBinds)
      .all<{ metric_key: string; value: number; occurred_at: string }>()

    const rows = result.results ?? []
    const out: CroMetric[] = []
    for (const r of rows) {
      if (typeof r.metric_key !== 'string' || !r.metric_key) continue
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) continue
      if (typeof r.occurred_at !== 'string' || !r.occurred_at) continue
      out.push({ metric_key: r.metric_key, value: r.value, occurred_at: r.occurred_at })
    }
    return out
  },
}
