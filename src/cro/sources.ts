// mupot — the CRO data fabric: a pluggable source-adapter layer (CRO epic, slice 1).
//
// A CRO source is any place a conversion signal lives — the pot's own first-party data
// (the zero-cred floor), or an external connector (PostHog, Search Console, Google/FB
// Ads, CRM). Each adapter NORMALIZES its data into CroMetric points; the unified store is
// `metric_points` (one time-series table, `source` distinguishes the origin). The CRO loop
// reads from there, so adding a connector adds signal without touching the loop.
//
// DESIGN PRINCIPLE (Hadi, 2026-06-19): ask for the sources that fit the business stack,
// but NEVER block on a missing one — collect from whatever is connected and degrade
// gracefully. More sources → sharper CRO; zero external sources → still runs on first-party.
//
// This module is PURE orchestration over injected adapters (no I/O of its own), so the
// degradation logic is unit-tested with no DB or network.

import type { Env } from '../types'

/** A normalized conversion-signal point, shaped to persist as a metric_points row. */
export interface CroMetric {
  /** Namespaced series key, e.g. 'growth.signups' | 'cro.checkout_rate'. */
  metric_key: string
  /** The numeric value (rate as a fraction, count, revenue micro-USD — per the key). */
  value: number
  /** ISO 8601 timestamp the signal is FOR (intraday precision). */
  occurred_at: string
}

/**
 * A pluggable CRO data source. `available()` decides whether the source is connected for
 * this pot (first-party: always true; external: a vault connector row exists). `collect()`
 * returns normalized signal. Neither is trusted to be well-behaved — the collector below
 * isolates failures.
 */
export interface CroSource {
  /** Stable source identity; also written as metric_points.source. */
  readonly key: string
  /** Human label for the connect-by-stack console. */
  readonly label: string
  available(env: Env): Promise<boolean>
  collect(env: Env): Promise<CroMetric[]>
}

/**
 * Hard per-source output cap (BLOCK-1, Codex cross-vendor catch). The collector is the
 * one place every source funnels through, so the bound lives HERE — a buggy or hostile
 * source (especially a future untrusted external API: PostHog/GSC/Ads/CRM) returning a
 * huge array cannot CPU/memory-amplify the sweep or, downstream, amplify metric_points
 * writes. A source returning more than this is truncated and flagged (`capped`), never
 * silently dropped.
 */
export const MAX_POINTS_PER_SOURCE = 1000

/** Per-source outcome of a collection sweep — surfaced so the console shows what ran. */
export interface SourceStatus {
  key: string
  available: boolean
  ok: boolean // collected without throwing AND returned an array
  count: number // metrics accepted (after poison-filter + cap)
  capped?: boolean // true when the source returned more than MAX_POINTS_PER_SOURCE
  error?: string
}

export interface CollectResult {
  /** Every collected metric, stamped with its source. Order: by source, as listed. */
  metrics: Array<CroMetric & { source: string }>
  /** One status per source attempted — the receipt of what was connected / ran / failed. */
  sources: SourceStatus[]
}

/**
 * collectFromSources — run every source, GRACEFULLY DEGRADING:
 *   - a source whose `available()` is false or throws → skipped, recorded available:false.
 *   - a source whose `collect()` throws → recorded ok:false with the reason, and SKIPPED;
 *     it NEVER aborts the other sources.
 * So a missing/broken connector can never block the fabric — the loop perceives whatever
 * the healthy, connected sources returned. Sources run sequentially for deterministic
 * ordering + receipts; each is independent.
 */
export async function collectFromSources(env: Env, sources: CroSource[]): Promise<CollectResult> {
  const metrics: Array<CroMetric & { source: string }> = []
  const statuses: SourceStatus[] = []

  for (const src of sources) {
    let available = false
    try {
      available = await src.available(env)
    } catch {
      available = false // an adapter that can't even answer availability is treated as not connected
    }
    if (!available) {
      statuses.push({ key: src.key, available: false, ok: true, count: 0 })
      continue
    }

    try {
      const collected = await src.collect(env)
      // A non-array return is a misbehaving adapter — record it, don't crash/iterate it.
      if (!Array.isArray(collected)) {
        statuses.push({ key: src.key, available: true, ok: false, count: 0, error: 'non_array_return' })
        continue
      }
      // CAP FIRST (BLOCK-1): bound processing to MAX_POINTS_PER_SOURCE before iterating, so
      // a huge return can't amplify CPU/memory or the downstream write. Truncation is flagged.
      const capped = collected.length > MAX_POINTS_PER_SOURCE
      const bounded = capped ? collected.slice(0, MAX_POINTS_PER_SOURCE) : collected
      let count = 0
      for (const m of bounded) {
        // Defensive: a hostile/buggy adapter must not poison the store with NaN/∞ or a
        // non-string key. Drop bad points rather than failing the whole source.
        if (typeof m?.metric_key !== 'string' || !m.metric_key) continue
        if (typeof m.value !== 'number' || !Number.isFinite(m.value)) continue
        if (typeof m.occurred_at !== 'string' || !m.occurred_at) continue
        metrics.push({ metric_key: m.metric_key, value: m.value, occurred_at: m.occurred_at, source: src.key })
        count++
      }
      statuses.push({ key: src.key, available: true, ok: true, count, ...(capped ? { capped: true } : {}) })
    } catch (e) {
      statuses.push({
        key: src.key,
        available: true,
        ok: false,
        count: 0,
        error: e instanceof Error ? e.message : 'collect_failed',
      })
    }
  }

  return { metrics, sources: statuses }
}
