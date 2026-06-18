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
// Metrics (S2: via OutboundChannel in the channels field below):
//   growth.leads      — count of ALL prospects ever queued (sum of queued+drafted+sent+replied).
//                       A new prospect row = a new lead entering the funnel.
//   growth.replies    — count of prospects in 'replied' status. The KPI outcome.
//   growth.conversion — reply rate = replied / (sent + replied). Only emitted when reached > 0.
//
// These three descriptors were MOVED from metricsEmitted into OutboundChannel (S2).
// The collector (growth-collector.ts) is unchanged — same keys, same source, same logic.
// The composed manifest (metricsEmitted ∪ OutboundChannel.metricDescriptors) authorizes
// the collector's emits through the kernel's existing source-authority check.
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
import { OutboundChannel } from '../channels/outbound-channel'

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
  // S2 change: growth.leads / growth.replies / growth.conversion have been MOVED
  // into OutboundChannel (src/departments/channels/outbound-channel.ts) and are
  // composed in via the `channels` field below. The collector is UNCHANGED —
  // those keys are still authorized through composeDeptMetricDescriptors.
  //
  // metricsEmitted is empty because all current growth metrics are channel-owned.
  // The field remains (not removed) because DepartmentModule.metricsEmitted is
  // required, and future dept-owned metrics (not tied to a channel) would go here.
  metricsEmitted: [],

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

  // ── channels ──────────────────────────────────────────────────────────────────
  //
  // S2: the outbound prospects funnel is extracted as a ChannelDescriptor.
  // growth.leads / growth.replies / growth.conversion now live in OutboundChannel
  // and are composed into the dept's effective metric set at registration/mint time.
  // The collector (growth-collector.ts) is UNCHANGED — same keys, same source.
  channels: [OutboundChannel],
}

// Auto-register when this module is imported.
// This is the ONE registry call that must exist per department (§3.5 "registry plumbing").
// The production `register` is idempotent for the same module object (same key + same
// reference → no-op). No `replace` flag is used or accepted on the production singleton.
register(GrowthModule)
