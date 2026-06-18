// mupot — channel layer: flat declarative descriptor.
//
// A ChannelDescriptor is a MANIFEST FRAGMENT — pure data that composes under a
// DepartmentModule. It is NOT a second kernel, NOT an authority boundary, NOT a
// lifecycle owner. It declares what metrics a channel emits, what connectors it
// references, what gated work-types it surfaces, and how its panels render.
//
// Architecture source: docs/architecture/marketing-channels.md §2 (S1 sprint).
// Cross-vendor review (Codex, 2026-06-17): keep the channel layer FLAT.
//
// HARD RULES (architectural, never relax without a multi-sprint consensus):
//
//   1. NO ctx-minting at the channel layer.
//      Channels have NO DepartmentCtx, NO kernelMintCtx call, NO token.
//      Authority flows through the department's existing ctx/Gate/metric_points path.
//
//   2. NO registry at the channel layer.
//      Channels are composed under a DepartmentModule (channels: ChannelDescriptor[]).
//      There is no channel registry singleton, no register() function here.
//
//   3. NO lifecycle at the channel layer.
//      No activate(), no deactivate(), no seed receipts, no DB writes.
//      Lifecycle is the department's concern.
//
//   4. NO audit / bus / capability resolver at the channel layer.
//      These are kernel-level concerns. Channels declare intent (sourceAuthority,
//      connectorRefs, requiredCapability on workTypes); enforcement is the dept's.
//
//   5. Composition, not authority escalation.
//      A channel contributes metricDescriptors + workTypes + renderHints to the dept.
//      The dept's getActiveMetricDescriptors union includes the channel's descriptors.
//      The channel's sourceAuthority feeds the dept's existing source check — no wider.
//
//   6. EXPORT SURFACE INVARIANT:
//      This file exports ONLY types and interfaces. No functions, no class instances,
//      no Symbol tokens, no registry state. A channel module file may import from here
//      freely — it cannot obtain any minting or authority-escalation capability.
//
// COMPOSITION MODEL:
//   A DepartmentModule gains an optional `channels: ChannelDescriptor[]` field.
//   The dept's effective metric descriptors = dept.metricsEmitted + union of
//     channel.metricDescriptors for each channel in dept.channels.
//   The dept's effective work-types = union of channel.workTypes across channels.
//   This is a pure array-flatten / merge — no new machinery, no new D1 writes.
//   Channel descriptors are deep-frozen via the same deepFreezeClone path the dept
//   manifest uses (channels array + each descriptor + nested arrays frozen at
//   registration time by composeChannels()).
//
// WHERE TO EXTEND:
//   - New channel keys: add a new ChannelDescriptor file under this directory.
//   - New workType keys: add to the GatedWorkType.key type comment below.
//   - configSchema: typed as `unknown` in S1; wire Zod in S3 when the first
//     external-agent channel (SEO) defines its config shape.

import type { MetricDescriptor, ConnectorRef } from '../contract'
import type { Capability } from '../../types'

// Re-export for callers who want one import point for channel contract types.
export type { MetricDescriptor, ConnectorRef } from '../contract'

// ── GatedWorkType ────────────────────────────────────────────────────────────
//
// A single class of work a channel surfaces for human-gated execution.
//
// Key design points:
//   - `proposesOnly: true` means an agent MAY research and propose this work type
//     into a gated record; a human (or the Gate) must approve before execution.
//   - `proposesOnly: false` is reserved for future work where the Gate is the
//     human approval surface (e.g. a scheduled low-risk cron). Default in S1 = true
//     for all fixture work-types.
//   - `requiredCapability` is declarative intent. The channel does NOT resolve it;
//     the dept ctx enforces it when an agent calls gate.propose().
//
// Examples of key values (not exhaustive):
//   'comparison-page' | 'answer-shape' | 'audit' | 'outreach' |
//   'keyword-research' | 'content-draft' | 'ad-copy' | 'email-sequence'

export interface GatedWorkType {
  /**
   * Stable dotted or hyphenated key: 'comparison-page' | 'answer-shape' | …
   * Must be lowercase alphanumeric + hyphens: [a-z0-9-]+.
   */
  key: string
  /** Human-readable name for display in the board / task panel. */
  name: string
  /**
   * true  = this work-type produces a gated proposal/evidence record.
   *         An agent researches and proposes; it never directly mutates a customer
   *         asset. The human (or Gate) confirms before any write occurs.
   *         All S1/S2/S3 work-types are proposesOnly=true.
   * false = reserved for future Gate-as-approval-surface patterns.
   */
  proposesOnly: boolean
  /**
   * Optional minimum capability required to propose this work-type.
   * Declarative hint only — the dept ctx enforces it on gate.propose().
   * If omitted, defaults to the dept's minimum ('member').
   */
  requiredCapability?: Capability
}

// ── ChannelRenderHint ────────────────────────────────────────────────────────
//
// How the channel's panels appear in the console dashboard.
// Purely presentational — no authority impact.

export interface ChannelRenderHint {
  /**
   * Display title for the channel panel in the department view.
   * E.g. 'Outbound', 'SEO / AEO', 'Fixture Channel'.
   */
  panelTitle: string
  /**
   * Relative display order among sibling channels (ascending, optional).
   * Channels without an order sort after those with one, alphabetically by key.
   */
  order?: number
}

// ── ChannelDescriptor ────────────────────────────────────────────────────────
//
// The seam a channel must satisfy. This is a MANIFEST FRAGMENT: it declares
// metrics, connectors, gated work-types, and render hints. It does NOT carry
// lifecycle hooks, minting logic, or authority machinery.
//
// ISOLATION INVARIANT:
//   Removing a channel's ChannelDescriptor from dept.channels removes its
//   metricDescriptors and workTypes from the dept's active lists WITHOUT touching
//   sibling channels OR the dept's own metricsEmitted. No cascading edits.
//
// AUTHORITY INVARIANT:
//   A channel's sourceAuthority feeds the dept's existing source check.
//   The channel does NOT widen the dept's authority surface — it declares intent
//   so the dept can validate emits on the channel's behalf.

export interface ChannelDescriptor {
  /**
   * Stable unique key within a department: 'fixture-channel' | 'outbound' | 'seo' | …
   * Must be lowercase alphanumeric + hyphens: [a-z0-9-]+.
   */
  key: string
  /** Human-readable display name for the channel. */
  name: string
  /**
   * Metric descriptors this channel contributes.
   * REUSES the dept's MetricDescriptor type (§4.1 of the microkernel spec).
   * These compose into the dept's active metric list — they are NOT a parallel registry.
   * sourceAuthority on each descriptor must be a subset of or consistent with this
   * channel's top-level sourceAuthority (both are checked; the per-descriptor value
   * is the binding one used by the ctx's source check).
   */
  metricDescriptors: MetricDescriptor[]
  /**
   * Which connector/source values may emit this channel's metrics.
   * Top-level declaration of intent — the per-MetricDescriptor sourceAuthority is the
   * binding authority check in ctx.metrics.emit(). This field is informational (for
   * the dept manifest + tooling); having it here makes channel intent discoverable
   * without iterating all descriptors.
   */
  sourceAuthority: string[]
  /**
   * Connector references for this channel.
   * REUSES the dept's ConnectorRef type. Declared as intent; wiring is kernel work.
   * Requires Hadi-go for any connector needing a secret/key.
   */
  connectorRefs: ConnectorRef[]
  /**
   * Gated work-types this channel surfaces.
   * Composes into the dept's allowed work-types (union across channels).
   */
  workTypes: GatedWorkType[]
  /**
   * How the channel's panels render in the console dashboard.
   * Purely presentational — no authority surface.
   */
  renderHints?: ChannelRenderHint
  /**
   * Per-pot config shape for this channel (domain, keywords, competitors, creds…).
   * Typed as `unknown` in S1. Wire a Zod schema in S3 when the SEO channel
   * defines its config shape. configSchema is DATA — never prompt text with implicit
   * authority (§3 leak-guard 3 of marketing-channels.md).
   */
  configSchema?: unknown
}
