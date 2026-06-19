// mupot — CRO ingest runner: the cron step that pulls EXTERNAL connector signal into
// metric_points (CRO epic, slice 2). The 6th scheduled() heartbeat.
//
// Pipeline:  EXTERNAL_CRO_SOURCES → collectFromSources (graceful degradation) →
//            emitMetric (per point, tenant-bound, receipt-guarded).
//
// THREE invariants (the ones the gate will probe):
//   1. EXTERNAL-ONLY persistence. The first-party source READS metric_points and returns
//      the pot's OWN data; re-emitting it under source='first_party' would DUPLICATE that
//      data under a new source tag (write-amplification / pollution). So the persist runner
//      lists only EXTERNAL ingest sources (PostHog, later GSC/Ads/CRM), and additionally
//      GUARDS against ever writing a first-party-keyed point (belt-and-suspenders if the
//      list changes). The first-party floor stays for the read/reason fabric, a separate
//      consumer.
//   2. Single-tenant-per-pot. Every write binds tenant_id = env.TENANT_SLUG (the trusted
//      param), never a value derived from a collected point.
//   3. Fail-soft, per point AND per sweep. A bad point (validation throw) is logged and
//      skipped; a broken source can never block the others (collectFromSources owns that);
//      a total sweep failure is caught so the CRO heartbeat never breaks the rest of cron.
//
// `now` (createdAt) is read once at this I/O boundary and injected into emitMetric so the
// writer stays deterministic. occurred_at comes from each source (PostHog: the tick time).

import type { Env } from '../types'
import type { CroSource } from './sources'
import { collectFromSources } from './sources'
import { FIRST_PARTY_KEY } from './first-party'
import { posthogCroSource } from './posthog'
import { emitMetric } from '../metrics/pulse'

// The external ingest sources, in order. First-party is deliberately ABSENT — it is a read
// adapter for the reasoner, not an ingest source (see invariant #1). Add GSC/Ads/CRM here.
export const EXTERNAL_CRO_SOURCES: readonly CroSource[] = [posthogCroSource]

export interface CroCollectSummary {
  emitted: number
  duplicate: number
  failed: number
  skippedFirstParty: number
}

// ── runCroCollection ───────────────────────────────────────────────────────────
//
// Called from scheduled() in src/index.ts via ctx.waitUntil(). Also exported for direct
// unit testing. Returns a summary (useful in tests / future receipts); the cron ignores it.
//
// `sources` defaults to EXTERNAL_CRO_SOURCES; it is injectable for unit tests (and lets a
// future caller run a narrowed source set). The first-party guard (#1) holds regardless of
// what is injected — a first-party-keyed point is never persisted.

export async function runCroCollection(
  env: Env,
  sources: readonly CroSource[] = EXTERNAL_CRO_SOURCES,
): Promise<CroCollectSummary> {
  const summary: CroCollectSummary = { emitted: 0, duplicate: 0, failed: 0, skippedFirstParty: 0 }
  const tenantId = env.TENANT_SLUG
  if (!tenantId) return summary // fail-closed: no tenant ⇒ nothing to write

  let metrics: Array<{ metric_key: string; value: number; occurred_at: string; source: string }>
  try {
    const result = await collectFromSources(env, [...sources])
    metrics = result.metrics
  } catch (err) {
    // collectFromSources is designed never to throw (it isolates per-source failures), but
    // guard anyway — a CRO heartbeat failure must never break the rest of the cron.
    console.error('[cro_cron] collectFromSources failed — skipping CRO collection', err)
    return summary
  }

  const createdAt = new Date().toISOString() // injected into emitMetric (writer stays pure)

  for (const m of metrics) {
    // INVARIANT #1 guard: never persist the first-party floor back into metric_points.
    if (m.source === FIRST_PARTY_KEY) {
      summary.skippedFirstParty++
      continue
    }
    try {
      const outcome = await emitMetric(
        env.DB,
        {
          tenantId, // bound from the trusted param, never from the collected point
          metricKey: m.metric_key,
          value: m.value,
          occurredAt: m.occurred_at,
          source: m.source,
        },
        crypto.randomUUID(),
        createdAt,
      )
      if (outcome.ok) summary.emitted++
      else summary.duplicate++ // same tenant+key+time+source already recorded — clean no-op
    } catch (err) {
      // Per-point fail-soft: a single bad point (e.g. validation reject) must not abort the
      // remaining points. Logged for audit; the key is safe to log (it is not a secret).
      summary.failed++
      console.error('[cro_cron] emitMetric failed', { key: m.metric_key, source: m.source, err })
    }
  }

  return summary
}
