// mupot — Growth department module: Marketing & Sales.
//
// DECLARATIVE MANIFEST — no runtime hooks, no lifecycle functions, no emit calls.
// Runtime behavior lives in src/departments/collectors/growth-collector.ts (garden code).
//
// Microkernel litmus discipline (§3.5 of console-department-microkernel.md):
//   - Adding this file + one register() call is ALL that is required.
//   - Nav, metric selector, capability resolver, audit writer, bus, schema, and sibling
//     departments are NOT edited.
//   - Removing this file + its register() call leaves all other tests green.
//
// Metrics backed by real data today (via prospects table, countByStatus):
//   growth.leads      — count of ALL prospects ever queued (sum of queued+drafted+sent+replied).
//                       A new prospect row = a new lead entering the funnel.
//   growth.replies    — count of prospects in 'replied' status. The KPI outcome.
//   growth.conversion — reply rate = replied / (sent + replied). Only emitted when reached > 0.
//
// ohlcEligible = false for all three: the collector runs once per cron tick (daily cadence)
// and emits a single scalar snapshot. With one reading per day, O==H==L==C → fabricated
// candle data. seriesShape() will return 'bar' for all three, which is honest.
//
// connectors: GHL and an ads connector are declared as intent — NOT wired live.
// Wiring requires Hadi-go (secrets/key mint). Declared here so the manifest is
// complete; the collector only uses what is available today (prospects table).

import type { DepartmentModule } from '../contract'
import { register } from '../registry'

export const GrowthModule: DepartmentModule = {
  key: 'growth',
  name: 'Marketing & Sales',
  version: '0.1.0',

  // ── defaultSquads ─────────────────────────────────────────────────────────────
  //
  // Seeded once on first activation. Re-activation is idempotent (seed receipt guard).
  defaultSquads: [
    {
      slug: 'demand-gen',
      name: 'Demand Gen',
      charter: 'Builds top-of-funnel: awareness, inbound, content, ads.',
      okr: 'Fill the pipeline with qualified leads each sprint.',
    },
    {
      slug: 'pipeline',
      name: 'Pipeline',
      charter: 'Converts leads to customers: outreach, proposals, closings.',
      okr: 'Move every qualified lead from first-touch to signed within SLA.',
    },
  ],

  // ── metricsEmitted ────────────────────────────────────────────────────────────
  //
  // Full MetricDescriptor schema required — these are the ONLY keys the growth
  // collector may emit (the ctx rejects anything not in this list).
  //
  // Data source for all: the `prospects` table (src/loops/prospects.ts:countByStatus).
  // Honesty: ohlcEligible=false for all (daily snapshot scalars → bar, never candle).
  metricsEmitted: [
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

  // ── consoleSection ────────────────────────────────────────────────────────────
  //
  // A render reference — NOT a shell import. The nav iterates getActiveConsoleSections()
  // and maps each id to a registered renderer without any per-department branch.
  consoleSection: {
    id: 'growth',
    title: 'Marketing & Sales',
    navIcon: 'trending-up',
    path: '/departments/growth',
  },

  // ── requiredCapabilities ──────────────────────────────────────────────────────
  //
  // 'member' is the minimum to emit metrics (ctx facade enforces this). The collector
  // is kernel/garden code — it mints its own ctx with the appropriate caps.
  requiredCapabilities: ['member'],

  // ── connectors ────────────────────────────────────────────────────────────────
  //
  // Declared as intent only — wiring is kernel work, requires Hadi-go for secrets.
  // The collector uses only the prospects table today (no live connector needed).
  connectors: [
    {
      key: 'ghl',
      // GHL is optional for basic funnel visibility — the prospects table is sufficient.
      // When wired, GHL would be the source for CRM-stage-based pipeline counts.
      required: false,
    },
    {
      key: 'ads',
      // Ad platform connector (Meta/Google) for CPL and ROAS signals.
      // Not wired live — declared so the manifest is complete for future activation.
      required: false,
    },
  ],
}

// Auto-register when this module is imported.
// This is the ONE registry call that must exist per department (§3.5 "registry plumbing").
// The production `register` is idempotent for the same module object (same key + same
// reference → no-op). No `replace` flag is used or accepted on the production singleton.
register(GrowthModule)
