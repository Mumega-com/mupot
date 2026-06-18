// mupot — channel layer: Outbound prospects funnel channel.
//
// OutboundChannel is the first REAL channel — it surfaces the prospect funnel
// (leads → replies → conversion) that the Growth department already runs.
//
// MOVE vs COPY:
//   The three metric descriptors here (growth.leads, growth.replies, growth.conversion)
//   are MOVED VERBATIM from src/departments/modules/growth.ts. Keys, unit, direction,
//   cadence, aggregation, ohlcEligible, sourceAuthority, retention, and display are
//   identical to what was in growth.ts metricsEmitted. The growth collector is UNCHANGED
//   — it still emits the same three keys from 'prospects' source, and is now authorized
//   via the composed manifest (growth.metricsEmitted ∪ OutboundChannel.metricDescriptors).
//
// AUTHORITY:
//   This channel has NO ctx, NO registry, NO lifecycle. It is pure data.
//   sourceAuthority: ['prospects'] on each descriptor — unchanged from growth.ts.
//   The kernel's _metricsMap is built from composeDeptMetricDescriptors(metricsEmitted, channels)
//   so the collector's emit path is authorized through the existing source-authority check.
//
// COLLECTOR UNCHANGED (growth-collector.ts):
//   The collector emits growth.leads, growth.replies, growth.conversion via ctx.metrics.emit.
//   With the composed manifest, those keys are present in _metricsMap. No change is needed
//   in the collector — the composition is transparent to it.
//
// Architecture source: docs/architecture/marketing-channels.md §5, §6 (S2 sprint).

import type { ChannelDescriptor } from './contract'

export const OutboundChannel: ChannelDescriptor = {
  key: 'outbound',
  name: 'Outbound',

  // ── metricDescriptors ─────────────────────────────────────────────────────
  //
  // MOVED VERBATIM from growth.ts metricsEmitted (same keys, same values, same
  // sourceAuthority: ['prospects']). ohlcEligible=false for all — daily cron
  // emits one scalar per tick (O==H==L==C → fabricated candle; honest render = bar).
  metricDescriptors: [
    {
      key: 'growth.leads',
      // Total prospects entering the funnel (all statuses except opted_out/bounced are
      // "leads" from a marketing perspective). In practice the collector sums
      // queued+drafted+sent+replied as the total funnel entry count.
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      aggregation: 'sum',
      // ohlcEligible=false: the collector emits one reading per tick (daily scalar).
      // O==H==L==C → fabricated candle. Honest rendering = bar.
      ohlcEligible: false,
      sourceAuthority: ['prospects'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'growth.replies',
      // Prospects that replied — the primary KPI outcome signal.
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      aggregation: 'sum',
      ohlcEligible: false,
      sourceAuthority: ['prospects'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'growth.conversion',
      // Reply rate = replied / (sent + replied) — range 0–1 by construction.
      // Denominator is all prospects known to have been contacted (reached).
      // When reached === 0 (nobody contacted yet) → no conversion point emitted.
      unit: 'ratio',
      direction: 'up_good',
      cadence: 'daily',
      // aggregation=last: the conversion ratio is a rate, not an additive count.
      // Taking the last reading of the day (from the most recent snapshot) is honest
      // for a daily scalar. 'sum' of ratios is meaningless.
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['prospects'],
      retention: '90d',
      display: { precision: 3, suffix: ' reply rate' },
    },
  ],

  // ── sourceAuthority ───────────────────────────────────────────────────────
  //
  // Top-level intent declaration — mirrors per-descriptor sourceAuthority.
  // Informational; the per-descriptor value is the binding authority check.
  sourceAuthority: ['prospects'],

  // ── workTypes ─────────────────────────────────────────────────────────────
  //
  // The outreach-send work-type is proposesOnly: an agent may research and
  // propose an outreach action into a gated record; a human (or the Gate)
  // must approve before any email/message is sent.
  workTypes: [
    {
      key: 'outreach-send',
      name: 'Outreach Send',
      // proposesOnly=true: produces a gated proposal/evidence record.
      // No direct send; all sends require human gate approval.
      // ALL S2 work-types are proposesOnly=true (per marketing-channels.md §2).
      proposesOnly: true,
    },
  ],

  // ── connectorRefs ─────────────────────────────────────────────────────────
  //
  // No live connectors in S2 — the collector uses only the prospects table.
  // Declared empty; wiring GHL etc. requires Hadi-go (secrets/key mint).
  connectorRefs: [],

  // ── renderHints ───────────────────────────────────────────────────────────
  renderHints: {
    panelTitle: 'Outbound funnel',
    order: 1,
  },
}
