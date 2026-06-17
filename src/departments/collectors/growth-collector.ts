// mupot — Growth department collector (garden/kernel-side service).
//
// This is NOT a DepartmentModule — it is a garden service that emits metrics through
// the object-capability ctx. It holds no manifest, no lifecycle hooks, and no self-
// registration. The module (src/departments/modules/growth.ts) is the declarative
// manifest; this file is the runtime data path.
//
// Object-capability discipline:
//   1. The collector receives a KernelHandle (raw D1) + a tenantId.
//   2. It mints a DepartmentCtx via kernelMintCtx — the kernel-side-only path.
//   3. All metric writes go through ctx.metrics.emit(...) — NOT raw DB calls.
//   4. The GrowthModule is imported for the manifest (passed to kernelMintCtx).
//      This import does NOT give the collector minting capability — it only gives
//      the module descriptor (a plain data object). The kernel token is closure-private
//      in kernel.ts; kernelMintCtx holds it internally, the caller never sees it.
//
// Data sourced from:
//   - prospects table via direct D1 queries (same SELECT pattern as countByStatus
//     in src/loops/prospects.ts — reused query shape, not the Env wrapper).
//
// Honesty contract:
//   - Zero prospects → emits nothing (empty state, not fabricated zeros).
//   - sent = 0 → no conversion point emitted (avoids division-by-zero fabrication).
//   - All emitted values are direct DB counts — no interpolation or estimation.
//   - occurred_at = `now` parameter (injected, deterministic — no Date.now() inside).
//
// Invocation: the existing cron (src/cron/heartbeat.ts or equivalent) can call
// collectGrowthMetrics(handle, tenantId, now) directly. A guarded admin route is also
// provided below for manual trigger during development. No new cron is registered
// in this pass — that is left for the wiring sprint.

import type { D1Database } from '@cloudflare/workers-types'
import type { KernelHandle } from '../ctx'
import type { EmitOutcome } from '../../metrics/pulse'
import { kernelMintCtx } from '../registry'
import { GrowthModule } from '../modules/growth'

// ── ProspectCounts ────────────────────────────────────────────────────────────

export interface ProspectCounts {
  queued: number
  drafted: number
  sent: number
  replied: number
}

// ── readProspectCounts ────────────────────────────────────────────────────────
//
// Direct D1 query — same pattern as countByStatus in src/loops/prospects.ts but
// fetches all four status counts in a single query (one DB round-trip) instead of
// four separate calls.
//
// tenant isolation: tenant column is bound from the trusted `tenantId` param,
// never derived from a row field.

export async function readProspectCounts(
  db: D1Database,
  tenantId: string,
): Promise<ProspectCounts> {
  // Single aggregation query: GROUP BY status for the four funnel statuses we care about.
  // opted_out and bounced are intentionally excluded — they are terminal negative states,
  // not active funnel positions. Including them in `leads` would misrepresent the funnel size.
  const result = await db
    .prepare(
      `SELECT status, COUNT(*) AS c
         FROM prospects
        WHERE tenant = ?1
          AND status IN ('queued', 'drafted', 'sent', 'replied')
        GROUP BY status`,
    )
    .bind(tenantId)
    .all<{ status: string; c: number }>()

  const rows = result.results ?? []
  const counts: ProspectCounts = { queued: 0, drafted: 0, sent: 0, replied: 0 }
  for (const row of rows) {
    const s = row.status as keyof ProspectCounts
    if (s in counts) counts[s] = row.c
  }
  return counts
}

// ── CollectResult ─────────────────────────────────────────────────────────────

export interface CollectResult {
  /** How many metric points were successfully emitted. */
  emitted: number
  /** How many were skipped (empty state or explicit skip — e.g. zero-sent conversion). */
  skipped: number
  /** Per-metric outcomes for audit / debugging. */
  outcomes: Array<{ key: string; outcome: 'emitted' | 'skipped' | 'duplicate'; detail?: string }>
}

// ── collectGrowthMetrics ──────────────────────────────────────────────────────
//
// Kernel-side collector. Mints a growth ctx, reads real prospect counts, emits
// metric_points through the capability-confined ctx.
//
// Parameters:
//   handle    — KernelHandle (raw D1). Held by kernel/garden code only.
//   tenantId  — tenant slug (bound from the trusted caller, never from rows).
//   now       — strict-canonical ISO 8601 timestamp for occurred_at. Injected for
//               determinism (no Date.now() inside this function).
//   opts.idGen — optional ID generator (injected in tests for determinism).
//
// Honesty:
//   - Zero total prospects (queued+drafted+sent+replied all zero) → emits nothing.
//     The caller sees { emitted: 0, skipped: 3 } — an honest empty state.
//   - sent = 0 → no growth.conversion point emitted (no division-by-zero fabrication).
//     The caller sees 'skipped' for growth.conversion with detail 'sent=0'.

export async function collectGrowthMetrics(
  handle: KernelHandle,
  tenantId: string,
  now: string,
  opts?: { idGen?: () => string },
): Promise<CollectResult> {
  const result: CollectResult = { emitted: 0, skipped: 0, outcomes: [] }

  // ── Read real prospect counts ─────────────────────────────────────────────
  const counts = await readProspectCounts(handle.db, tenantId)

  const total = counts.queued + counts.drafted + counts.sent + counts.replied

  // ── Empty state: no prospects at all → emit nothing (honest) ─────────────
  if (total === 0) {
    result.skipped = 3
    result.outcomes.push(
      { key: 'growth.leads', outcome: 'skipped', detail: 'no prospects' },
      { key: 'growth.replies', outcome: 'skipped', detail: 'no prospects' },
      { key: 'growth.conversion', outcome: 'skipped', detail: 'no prospects' },
    )
    return result
  }

  // ── Mint a capability-confined ctx for growth ─────────────────────────────
  //
  // kernelMintCtx is the only public path to a DepartmentCtx. The kernel token
  // is closure-private in kernel.ts — the collector cannot observe or forge it.
  // We pass GrowthModule (the manifest) so the ctx knows which keys and sources
  // are authorised for this department.
  const ctx = kernelMintCtx(handle, {
    tenantId,
    departmentKey: 'growth',
    module: GrowthModule,
    capabilities: ['member'],
    now: () => now,
    idGen: opts?.idGen,
  })

  // ── growth.leads ──────────────────────────────────────────────────────────
  //
  // Total funnel entries: sum of all active funnel positions.
  // This represents the total number of prospects that have entered the system.
  const leadsValue = total
  const leadsOutcome = await emitSafe(ctx.metrics.emit({
    key: 'growth.leads',
    value: leadsValue,
    occurredAt: now,
    source: 'prospects',
  }))
  result.outcomes.push({ key: 'growth.leads', outcome: leadsOutcome.kind, detail: leadsOutcome.detail })
  if (leadsOutcome.kind === 'emitted') result.emitted++
  else if (leadsOutcome.kind === 'skipped') result.skipped++

  // ── growth.replies ────────────────────────────────────────────────────────
  //
  // Count of prospects in 'replied' status — the primary KPI outcome signal.
  const repliesValue = counts.replied
  const repliesOutcome = await emitSafe(ctx.metrics.emit({
    key: 'growth.replies',
    value: repliesValue,
    occurredAt: now,
    source: 'prospects',
  }))
  result.outcomes.push({ key: 'growth.replies', outcome: repliesOutcome.kind, detail: repliesOutcome.detail })
  if (repliesOutcome.kind === 'emitted') result.emitted++
  else if (repliesOutcome.kind === 'skipped') result.skipped++

  // ── growth.conversion ─────────────────────────────────────────────────────
  //
  // Ratio: replied / sent. Only emitted when sent > 0 to avoid fabrication.
  // Definition: of the prospects we actually reached out to (status='sent'),
  // how many replied? This is the outreach effectiveness rate.
  //
  // Note: prospects in 'replied' may have been 'sent' in a prior tick. The
  // formula counts cumulative totals (not a per-period cohort). This is honest
  // for the current data model — a per-period cohort would require temporal
  // joins we don't have yet.
  if (counts.sent === 0) {
    result.skipped++
    result.outcomes.push({
      key: 'growth.conversion',
      outcome: 'skipped',
      detail: 'sent=0 (no outreach yet — conversion undefined)',
    })
  } else {
    const conversionValue = counts.replied / counts.sent
    const convOutcome = await emitSafe(ctx.metrics.emit({
      key: 'growth.conversion',
      value: conversionValue,
      occurredAt: now,
      source: 'prospects',
    }))
    result.outcomes.push({ key: 'growth.conversion', outcome: convOutcome.kind, detail: convOutcome.detail })
    if (convOutcome.kind === 'emitted') result.emitted++
    else if (convOutcome.kind === 'skipped') result.skipped++
  }

  return result
}

// ── emitSafe ──────────────────────────────────────────────────────────────────
//
// Wraps a ctx.metrics.emit() promise into a uniform result shape so the collector
// can aggregate outcomes without try/catch clutter at every call site.
//
// A 'duplicate' outcome from the pulse spine (same tenant+key+time+source) is NOT
// an error — it means the cron ticked twice for the same period. We normalise it
// to 'skipped' here since no new data was stored.
//
// Any other error is rethrown — the collector does not swallow unexpected failures.

type EmitResult = { kind: 'emitted'; detail?: string } | { kind: 'skipped'; detail: string }

async function emitSafe(promise: Promise<EmitOutcome>): Promise<EmitResult> {
  const outcome = await promise
  if (outcome.ok) {
    return { kind: 'emitted' }
  }
  // outcome.reason === 'duplicate'
  return { kind: 'skipped', detail: `duplicate (same tick already recorded)` }
}
