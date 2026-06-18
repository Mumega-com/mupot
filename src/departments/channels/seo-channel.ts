// mupot — channel layer: SEO & Content channel descriptor.
//
// SeoChannel is the first EXTERNAL-AGENT channel — it surfaces the SEO / AEO
// signals that external tools (PostHog, GSC) provide, plus the first-party
// signals the pot itself can read from its own pulse spine (metric_points).
//
// S3 design points:
//   - configSchema is a REAL Zod schema (exported as SeoChannelConfigSchema).
//     This closes the S1 TODO in contract.ts and the S3 TODO in compose.ts.
//     The schema is stored as `unknown` on the descriptor (ChannelDescriptor.configSchema)
//     and frozen by deepFreezeChannels() post-registration — it cannot be mutated
//     to widen authority or carry prompt-with-authority (marketing-channels.md §3, leak-guard 3).
//
//   - All workTypes are proposesOnly=true.
//     No customer asset is mutated by the collector (S3 invariant: propose-not-mutate-without-Gate).
//
//   - connectorRefs for PostHog and GSC are declared as INTENT (required=false).
//     They are NOT wired live in S3 — wiring requires Hadi-go (secrets/key mint).
//
//   - sourceAuthority: ['first-party', 'posthog', 'gsc'].
//     The pot's own pulse spine reads are 'first-party'; external connector reads
//     are 'posthog' and 'gsc'. No connector is live in S3 → 'first-party' only emitted.
//
// Architecture source: docs/architecture/marketing-channels.md §7 (S3 sprint).
// Contract rule §6 EXPORT SURFACE INVARIANT: this file exports ONLY plain data objects
// and Zod schema types. No functions that mint ctx, acquire a token, or register a module.

import { z } from 'zod'
import type { ChannelDescriptor } from './contract'

// ── SeoChannelConfigSchema ────────────────────────────────────────────────────
//
// Per-pot configuration shape for the SEO channel.
//
// SECURITY NOTE: this is DATA — not prompt text. The schema is stored on the
// descriptor's `configSchema` field (typed as `unknown`), and is deep-frozen by
// deepFreezeChannels() post-registration so it cannot be mutated after the
// module is registered. The schema object carries no authority — it is a validation
// spec only. (marketing-channels.md §3 leak-guard 3.)
//
// Fields:
//   domain           — the canonical domain this pot owns (e.g. 'mumega.com').
//   keywordClusters  — keyword groups the pot tracks (informational, not authority).
//   competitors      — competitor domains to benchmark against (informational).
//   executor         — which publishing surface the pot uses:
//                        'inkwell-content' = Inkwell CMS (the OSS framework)
//                        'mcpwp'           = MCPWP-managed WordPress

export const SeoChannelConfigSchema = z.object({
  domain: z.string().min(1),
  keywordClusters: z.array(z.string()),
  competitors: z.array(z.string()),
  executor: z.enum(['inkwell-content', 'mcpwp']),
})

export type SeoChannelConfig = z.infer<typeof SeoChannelConfigSchema>

// ── SeoChannel ────────────────────────────────────────────────────────────────
//
// The SEO & Content channel descriptor.
// Pure data — no ctx, no lifecycle, no registry call.

export const SeoChannel: ChannelDescriptor = {
  key: 'seo',
  name: 'SEO & Content',

  // ── metricDescriptors ─────────────────────────────────────────────────────
  //
  // Five daily scalar signals:
  //
  //   seo.organic_sessions — sessions arriving via organic search.
  //   seo.conversion_rate  — organic-sessions → goal-conversion (e.g. sign-up).
  //   seo.indexed_pages    — pages Google has indexed for this domain.
  //   seo.issues_open      — open crawl/indexing issues (GSC Coverage issues).
  //   seo.ai_citations     — AI-engine citations detected for this domain.
  //
  // All ohlcEligible=false: the collector emits one scalar snapshot per cron tick
  // (daily cadence). O==H==L==C → fabricated candle; honest rendering = bar.
  //
  // sourceAuthority per metric:
  //   organic_sessions, conversion_rate → ['first-party', 'posthog']
  //   indexed_pages, issues_open         → ['first-party', 'gsc']
  //   ai_citations                       → ['first-party']  (pot-native signal)

  metricDescriptors: [
    {
      key: 'seo.organic_sessions',
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      // aggregation=sum: we add daily session counts (not a snapshot rate).
      aggregation: 'sum',
      ohlcEligible: false,
      sourceAuthority: ['first-party', 'posthog'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'seo.conversion_rate',
      unit: 'ratio',
      direction: 'up_good',
      cadence: 'daily',
      // aggregation=last: conversion_rate is a ratio snapshot (not a sum).
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['first-party', 'posthog'],
      retention: '90d',
      display: { precision: 3, suffix: ' conv rate' },
    },
    {
      key: 'seo.indexed_pages',
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      // aggregation=last: indexed-page count is a current snapshot.
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['first-party', 'gsc'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'seo.issues_open',
      unit: 'count',
      // direction=down_good: fewer open issues is better.
      direction: 'down_good',
      cadence: 'daily',
      // aggregation=last: issue count is a current snapshot.
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['first-party', 'gsc'],
      retention: '90d',
      display: { precision: 0 },
    },
    {
      key: 'seo.ai_citations',
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      // aggregation=sum: citation events are counted (additive).
      aggregation: 'sum',
      ohlcEligible: false,
      // first-party only: citation detection comes from the pot's own tracking.
      sourceAuthority: ['first-party'],
      retention: '90d',
      display: { precision: 0 },
    },
  ],

  // ── sourceAuthority ───────────────────────────────────────────────────────
  //
  // Top-level intent declaration — the union of all per-descriptor sourceAuthority
  // values. Informational; the per-descriptor value is the binding authority check.
  sourceAuthority: ['first-party', 'posthog', 'gsc'],

  // ── connectorRefs ─────────────────────────────────────────────────────────
  //
  // PostHog and GSC are declared as INTENT (required=false).
  // Neither is wired live in S3 — wiring requires Hadi-go (secrets/key mint).
  // Declared so the manifest is complete; the collector is honest about
  // which connectors are available when invoked.
  connectorRefs: [
    { key: 'posthog', required: false },
    { key: 'gsc', required: false },
  ],

  // ── workTypes ─────────────────────────────────────────────────────────────
  //
  // All proposesOnly=true (S3 invariant): an agent researches and proposes;
  // it never directly mutates a customer asset. The human (or Gate) confirms
  // before any write occurs.
  workTypes: [
    {
      key: 'seo-audit-proposal',
      name: 'SEO Audit Proposal',
      proposesOnly: true,
    },
    {
      key: 'keyword-gap-proposal',
      name: 'Keyword Gap Proposal',
      proposesOnly: true,
    },
    {
      key: 'comparison-page-proposal',
      name: 'Comparison Page Proposal',
      proposesOnly: true,
    },
    {
      key: 'content-refresh-proposal',
      name: 'Content Refresh Proposal',
      proposesOnly: true,
    },
  ],

  // ── renderHints ───────────────────────────────────────────────────────────
  renderHints: {
    panelTitle: 'SEO & Content',
    order: 2,
  },

  // ── configSchema ──────────────────────────────────────────────────────────
  //
  // A real Zod schema (SeoChannelConfigSchema) stored as `unknown` per the
  // ChannelDescriptor contract (configSchema?: unknown). This is the S3 wire-up
  // referenced in contract.ts §configSchema comment and the S3 TODO in compose.ts.
  //
  // deepFreezeChannels() in compose.ts freezes this object post-registration
  // so it cannot be mutated to carry prompt-with-authority or widen channel
  // authority (marketing-channels.md §3 leak-guard 3).
  //
  // Callers that need to validate a pot's SEO config should import
  // SeoChannelConfigSchema directly and call .parse() / .safeParse().
  configSchema: SeoChannelConfigSchema,
}
