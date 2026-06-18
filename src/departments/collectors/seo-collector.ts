// mupot — SEO/Content channel collector (garden/kernel-side service).
//
// READ-ONLY evidence → gated proposals (S3). No writes, no external API calls.
// First-party signals only; PostHog and GSC slots are left as honest "source not connected"
// seams for S4+.
//
// Architecture: docs/architecture/marketing-channels.md §7 (S3 sprint).
//
// Object-capability discipline (mirrors growth-collector.ts):
//   1. The collector receives a KernelHandle (raw D1) + a tenantId.
//   2. It mints a DepartmentCtx via kernelMintCtx — the kernel-side-only path.
//   3. All metric writes go through ctx.metrics.emit(...) — NOT raw DB calls.
//   4. The manifest is sourced from the REGISTRY's frozen registered copy
//      (getRegistered('growth')), NOT the directly-imported mutable GrowthModule
//      singleton. Registry-frozen-clone invariant holds here too.
//   5. ctx.gate.propose() records intent for gated work-types; no customer asset is
//      mutated by this collector (S3 invariant: propose-not-mutate-without-Gate).
//
// Honesty contract:
//   - No first-party signal in this pot's D1? → emits nothing (empty state, no fabrication).
//   - Source not connected (PostHog, GSC)? → honest SeoSourceState, no fabrication.
//   - Gated proposals: proposesOnly=true work-types only; ctx.gate.propose() records intent;
//     no customer asset is mutated (S3 invariant: propose-not-mutate-without-Gate).
//
// First-party signal detection:
//   The pot's own pulse spine (metric_points) is the first-party source. If any
//   seo.* rows exist for this tenant, the collector has first-party data. An empty
//   pulse spine is an honest empty state — the collector emits nothing and proposes
//   an audit instead. This is REAL value: "we have no SEO signals, propose an audit"
//   is better than a fabricated zero.

import type { D1Database } from '@cloudflare/workers-types'
import type { KernelHandle } from '../ctx'
import type { DepartmentModule } from '../contract'
import { kernelMintCtx, getRegistered } from '../registry'
// Import GrowthModule to trigger auto-registration on module load (same pattern as growth-collector.ts).
// Do NOT pass this directly to kernelMintCtx — use the registry's frozen copy instead.
import { GrowthModule as _GrowthModuleForRegistration } from '../modules/growth'
// Suppress unused-variable lint: the side-effect import is intentional.
void _GrowthModuleForRegistration

// ── SeoSourceState ────────────────────────────────────────────────────────────
//
// Honest declaration of whether a data source is available for this collector run.
// connected=false means the connector is not wired for this pot — no fabrication,
// no "best guess" fill. The consumer (dashboard, reporting) can surface this as
// "source not connected" rather than showing a zero.

export interface SeoSourceState {
  connected: boolean
  /** Human-readable reason when connected=false. */
  reason?: string
}

// ── SeoCollectResult ──────────────────────────────────────────────────────────

export interface SeoCollectResult {
  /** How many metric points were successfully emitted. */
  emitted: number
  /** How many were skipped (no data, source not connected). */
  skipped: number
  /** Gated proposals submitted to ctx.gate.propose(). */
  proposals: Array<{ workType: string; gateId: string }>
  /** Honest source-availability state for this run. */
  sources: {
    firstParty: 'available' | 'empty'
    posthog: SeoSourceState
    gsc: SeoSourceState
  }
  /** Per-metric outcomes for audit/debugging. */
  outcomes: Array<{ key: string; outcome: 'emitted' | 'skipped' | 'proposed'; detail?: string }>
}

// ── readSeoFirstPartySignals ──────────────────────────────────────────────────
//
// Check the pot's own pulse spine (metric_points) for any seo.* rows.
// This is REAL first-party data — the pot's own prior pulse records.
// If empty → honest empty state. If rows exist → the pot has prior SEO data.
//
// For S3 the collector does NOT re-emit rows from a prior run (that would be a
// duplicate). It only reads to determine firstParty state. Actual new-data emits
// from live connectors are S4+ work.
//
// tenant isolation: tenant_id is bound from the trusted `tenantId` param,
// never derived from a row field.

export async function readSeoFirstPartySignals(
  db: D1Database,
  tenantId: string,
): Promise<{ hasData: boolean; rowCount: number }> {
  const result = await db
    .prepare(
      `SELECT metric_key, value, occurred_at
         FROM metric_points
        WHERE tenant_id = ?1
          AND metric_key LIKE 'seo.%'
        ORDER BY occurred_at DESC
        LIMIT 10`,
    )
    .bind(tenantId)
    .all<{ metric_key: string; value: number; occurred_at: string }>()

  const rows = result.results ?? []
  return { hasData: rows.length > 0, rowCount: rows.length }
}

// ── collectSeoMetrics ─────────────────────────────────────────────────────────
//
// Kernel-side collector. Reads the pot's pulse spine for first-party SEO signals,
// declares honest source states for external connectors (not wired in S3), and
// always proposes at least one gated seo-audit-proposal via ctx.gate.propose().
//
// Parameters:
//   handle    — KernelHandle (raw D1). Held by kernel/garden code only.
//   tenantId  — tenant slug (bound from the trusted caller, never from rows).
//   now       — strict-canonical ISO 8601 timestamp. Injected for determinism.
//   opts.idGen — optional ID generator (injected in tests for determinism).
//
// Returns:
//   SeoCollectResult — structured report with emitted count, skipped count,
//   proposals, honest source states, and per-metric outcomes.

export async function collectSeoMetrics(
  handle: KernelHandle,
  tenantId: string,
  now: string,
  opts?: { idGen?: () => string },
): Promise<SeoCollectResult> {
  const result: SeoCollectResult = {
    emitted: 0,
    skipped: 0,
    proposals: [],
    sources: {
      firstParty: 'empty',
      posthog: { connected: false, reason: 'connector_not_configured' },
      gsc: { connected: false, reason: 'connector_not_configured' },
    },
    outcomes: [],
  }

  // ── Resolve the frozen growth module from the registry ────────────────────
  //
  // SEO is composed under the Growth department (channels: [OutboundChannel, SeoChannel]).
  // The import above triggers GrowthModule's auto-registration so getRegistered works.
  // Sourcing from the registry's frozen copy — same invariant as growth-collector.ts.
  const frozenModule: DepartmentModule = (() => {
    const m = getRegistered('growth')
    if (!m) throw new Error('[seo_collector] GrowthModule is not registered — cannot mint ctx')
    return m
  })()

  // ── Mint a capability-confined ctx for growth ─────────────────────────────
  const ctx = kernelMintCtx(handle, {
    tenantId,
    departmentKey: 'growth',
    module: frozenModule,
    capabilities: ['member'],
    now: () => now,
    idGen: opts?.idGen,
  })

  // ── Read first-party signals from the pot's own pulse spine ──────────────
  //
  // The pot's metric_points table IS the first-party data source. Reading it
  // requires no external creds — it is the pot's own D1.
  const firstPartySignals = await readSeoFirstPartySignals(handle.db, tenantId)

  if (firstPartySignals.hasData) {
    result.sources.firstParty = 'available'
    // Prior seo.* rows exist in the pulse spine. For S3 we do NOT re-emit them
    // (re-emitting would produce duplicate constraint failures on the spine's
    // UNIQUE index over tenant_id+metric_key+occurred_at+source).
    // S4+ will add fresh-data paths once live connectors are wired.
    // Outcome: all 5 SEO metrics skipped (honest — data exists but no new data to emit).
    const seoKeys = [
      'seo.organic_sessions',
      'seo.conversion_rate',
      'seo.indexed_pages',
      'seo.issues_open',
      'seo.ai_citations',
    ]
    for (const key of seoKeys) {
      result.skipped++
      result.outcomes.push({
        key,
        outcome: 'skipped',
        detail: 'first-party data exists in pulse spine — no new data from live connector (S3)',
      })
    }
  } else {
    // No first-party data → honest empty state, emit nothing.
    result.sources.firstParty = 'empty'

    const seoKeys = [
      'seo.organic_sessions',
      'seo.conversion_rate',
      'seo.indexed_pages',
      'seo.issues_open',
      'seo.ai_citations',
    ]
    for (const key of seoKeys) {
      result.skipped++
      result.outcomes.push({
        key,
        outcome: 'skipped',
        detail: 'no first-party data in pulse spine — honest empty state (S3)',
      })
    }
  }

  // ── PostHog: not connected in S3 ──────────────────────────────────────────
  // result.sources.posthog is already set to { connected: false, ... } above.
  // No emit attempted — honest no-data, not a fabricated zero.

  // ── GSC: not connected in S3 ─────────────────────────────────────────────
  // result.sources.gsc is already set to { connected: false, ... } above.
  // No emit attempted.

  // ── Gated audit proposal ──────────────────────────────────────────────────
  //
  // Regardless of data state, propose a gated seo-audit-proposal. This is REAL
  // value: the fact that the collector ran and observed the current state (no
  // data, no live connectors) is evidence worth proposing to a human gate.
  //
  // ctx.gate.propose() records intent in the gate system — no customer asset
  // is mutated (proposesOnly=true invariant). The returned gateId is included
  // in the result for the caller to track / surface in the dashboard.
  const auditProposal = await ctx.gate.propose({
    action: 'seo-audit-proposal',
    payload: {
      reason: firstPartySignals.hasData ? 'periodic_audit' : 'no_first_party_data',
      tenantId,
      requestedAt: now,
      sources: {
        firstParty: result.sources.firstParty,
        posthog: result.sources.posthog,
        gsc: result.sources.gsc,
      },
    },
  })

  result.proposals.push({ workType: 'seo-audit-proposal', gateId: auditProposal.gateId })
  result.outcomes.push({
    key: 'seo-audit-proposal',
    outcome: 'proposed',
    detail: `gateId=${auditProposal.gateId}`,
  })

  return result
}
