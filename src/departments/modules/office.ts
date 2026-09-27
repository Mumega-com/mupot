// mupot — department microkernel: Office department (mupot#1580).
//
// "WordPress as each pot's office." This department exists so the `mcpwp-office`
// addon (src/addons/office/manifest.ts) has a registered ownerDepartment for its
// two manifest metrics (content.posts_published, office.pending_approvals) and a
// squad for the site-operator agent template to run under (§3.5 microkernel
// litmus — one module file + one register() call, nothing else edited).
//
// Slice 1 (this file) is declarative only: no tools read or write these metrics
// yet — that lands in slice 2 (mupot#1580 T2) alongside the office_* MCP tools
// named as intent in the addon's authorityRequests.surfaceGrants.

import type { DepartmentModule } from '../contract'
import { register } from '../registry'

export const OfficeModule: DepartmentModule = {
  key: 'office',
  name: 'Office (WordPress Site Operations)',
  version: '0.1.0',

  // ── defaultSquads: the site-operator agent template (see the mcpwp-office addon
  // manifest) runs under this squad. Seeded on first activation, same as every
  // other department — no bespoke squad-creation logic here.
  defaultSquads: [
    {
      slug: 'site-operator',
      name: 'Site Operator',
      charter: 'Runs the pot’s WordPress office (content publish/review) under gate.',
      okr: 'Keep the office content surface current without unreviewed publishes.',
    },
  ],

  // ── metricsEmitted: reuses the SAME dotted key the marketing-monitor's own
  // metric vocabulary already uses for WordPress-sourced content counts
  // (src/addons/marketing/adapters/mcpwp.ts, src/addons/marketing/types.ts) — this
  // is a DIFFERENT registry (the department microkernel's MetricDescriptor / pulse
  // spine, composeDeptMetricDescriptors), not the marketing_monitor_observations
  // table, so the string is shared by convention/readability, not by code path.
  metricsEmitted: [
    {
      key: 'content.posts_published',
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      aggregation: 'sum',
      ohlcEligible: false,
      sourceAuthority: ['mcpwp'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'office.pending_approvals',
      unit: 'count',
      direction: 'down_good',
      cadence: 'realtime',
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['mcpwp'],
      retention: '90d',
      display: { precision: 0 },
    },
  ],

  // ── consoleSection: a render reference. No renderer is registered for it in
  // slice 1 (no office-specific dashboard page yet) — this is the department's
  // own nav placeholder, independent of the addon's (empty) consoleSections.
  consoleSection: {
    id: 'office',
    title: 'Office',
    navIcon: 'building-2',
    path: '/departments/office',
  },

  // ── requiredCapabilities: 'member' is sufficient for a metric-emitting
  // department; the addon's own approvalPolicies gate the write-side actions.
  requiredCapabilities: ['member'],

  // ── connectors: none at the department level — the mcpwp-office addon
  // declares the 'wordpress_site' connector requirement itself.
  connectors: [],
}

// Auto-register when this module is imported (§3.5 "registry plumbing").
register(OfficeModule)
