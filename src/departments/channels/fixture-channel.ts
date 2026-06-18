// mupot — channel layer: Fixture/Null channel.
//
// THIS CHANNEL HAS NO PRODUCT VALUE. Its sole purpose is to prove the channel
// composition shape (S1 of marketing-channels.md) BEFORE any real channel
// (Outbound, SEO, …) is built.
//
// Why a fixture first?
//   Real channels (SEO, Outbound) have connector uncertainty and product
//   complexity. A semantically empty fixture lets the channel conformance harness
//   catch shape defects cheaply — exactly as the dept fixture did for the microkernel.
//
// What this fixture proves:
//   1. A ChannelDescriptor satisfies the contract type.
//   2. Its metricDescriptor composes into the dept's active list.
//   3. Its workType composes into the dept's allowed work-types.
//   4. Removing it leaves siblings + dept own descriptors intact.
//   5. The channel exports NO mint/ctx/token/registry symbol.
//   6. A registered channel descriptor is deep-frozen via the compose path.
//
// Channel litmus (mirrors the dept litmus §3.5):
//   Adding this file is ALL that is required.
//   contract.ts, compose.ts, registry.ts, the dept module, the metrics spine,
//   the capability resolver, and any sibling channel are NOT edited.
//
// AUTHORITY: this channel has NO ctx, NO registry, NO lifecycle, NO audit.
// It is pure data. Authority flows through the Growth dept's existing ctx path.

import type { ChannelDescriptor } from './contract'

export const FixtureChannel: ChannelDescriptor = {
  key: 'fixture-channel',
  name: 'Fixture Channel (Test)',

  // ── metricDescriptors ─────────────────────────────────────────────────────
  //
  // One metric to prove composition. Using MetricDescriptor from contract.ts
  // (reuse of the dept type — no new type is introduced).
  //
  // fixture.channel.pings: daily count, ohlcEligible=false (one per tick → bar,
  // never candle). Honest minimal metric — no product meaning.
  metricDescriptors: [
    {
      key: 'fixture.channel.pings',
      unit: 'count',
      direction: 'neutral',
      cadence: 'daily',
      aggregation: 'sum',
      // ohlcEligible=false: one reading per tick → O==H==L==C → fabricated candle.
      // Honest rendering = bar (same discipline as the dept's growth metrics).
      ohlcEligible: false,
      // sourceAuthority: only 'fixture-channel-harness' may emit this key.
      // This is the binding source check used by the dept ctx on emit().
      sourceAuthority: ['fixture-channel-harness'],
      retention: '30d',
      display: { precision: 0, suffix: ' ch-pings' },
    },
  ],

  // ── sourceAuthority ───────────────────────────────────────────────────────
  //
  // Top-level declaration of intent — mirrors the per-descriptor sourceAuthority.
  // Informational for the dept manifest + tooling. The per-descriptor value is
  // the binding authority check in ctx.metrics.emit().
  sourceAuthority: ['fixture-channel-harness'],

  // ── connectorRefs ─────────────────────────────────────────────────────────
  //
  // No external connectors for the fixture. Declared empty to satisfy the shape.
  connectorRefs: [],

  // ── workTypes ─────────────────────────────────────────────────────────────
  //
  // One proposesOnly work-type to prove work-type composition.
  // 'channel-ping-proposal' has no real work meaning — it exists to test the shape.
  workTypes: [
    {
      key: 'channel-ping-proposal',
      name: 'Channel Ping Proposal',
      // proposesOnly=true: produces a gated proposal/evidence record.
      // An agent researches and proposes; no direct mutation of a customer asset.
      // ALL S1 work-types are proposesOnly=true (per marketing-channels.md §2).
      proposesOnly: true,
      // requiredCapability not set → defaults to the dept's minimum ('member').
    },
  ],

  // ── renderHints ───────────────────────────────────────────────────────────
  //
  // Minimal render hint. Purely presentational — no authority surface.
  renderHints: {
    panelTitle: 'Fixture Channel',
    order: 999, // sort last — this is a test channel, not a real panel
  },

  // configSchema: omitted in S1. Wire Zod in S3 for the SEO channel.
}
