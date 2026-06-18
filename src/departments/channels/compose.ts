// mupot — channel layer: pure composition helper.
//
// composeChannels() flattens a list of ChannelDescriptors into the arrays that
// a DepartmentModule (or its tests) need:
//   - activeMetricDescriptors: dept.metricsEmitted ∪ channels[].metricDescriptors
//   - activeWorkTypes:         union of channels[].workTypes
//
// DESIGN RULES (binding):
//   - This file exports ONLY pure functions. No class, no singleton, no state.
//   - No D1 calls, no ctx calls, no registry calls. Pure data transformation.
//   - deepFreezeChannels() mirrors the dept's deepFreezeClone for the channel layer:
//     each ChannelDescriptor + nested arrays are frozen so a registered channel
//     descriptor cannot be mutated post-registration to widen authority.
//   - This file does NOT re-export types from contract.ts — callers who need types
//     import from contract.ts directly.
//
// NOTE ON deepFreezeChannels vs deepFreezeClone:
//   The dept's deepFreezeClone is module-private in registry.ts (it freezes a full
//   DepartmentModule). Channel descriptors are embedded in the dept manifest and
//   freeze together WITH the manifest when the dept registers. The deepFreezeChannels
//   helper here is used by tests (and any standalone channel freeze path) to freeze
//   a channel array in isolation, matching the same depth as the dept path:
//     each descriptor + metricDescriptors + each MetricDescriptor + its sourceAuthority
//     + each MetricDescriptor.display + workTypes + each GatedWorkType + connectorRefs
//     + each ConnectorRef + renderHints + the top-level descriptor itself.
//   SECURITY: because channels are nested inside a DepartmentModule, and
//   deepFreezeClone freezes the entire manifest, channels registered via a
//   DepartmentModule are frozen by the dept's registration path. The function here
//   is an explicit utility for tests and for callers who need to freeze a standalone
//   channel array.

import type { MetricDescriptor } from '../contract'
import type { ChannelDescriptor, GatedWorkType } from './contract'

// ── deepFreezeChannels ────────────────────────────────────────────────────────
//
// Deep-freeze an array of ChannelDescriptors and return the frozen array.
// Mirrors the depth of deepFreezeClone in registry.ts, applied to channels.
// Returns the same array reference (mutated to frozen in place, then frozen).

export function deepFreezeChannels(channels: ChannelDescriptor[]): readonly ChannelDescriptor[] {
  for (const ch of channels) {
    // Freeze each MetricDescriptor and its nested arrays.
    for (const desc of ch.metricDescriptors) {
      Object.freeze((desc as { sourceAuthority: readonly string[] }).sourceAuthority)
      Object.freeze((desc as { display: object }).display)
      Object.freeze(desc)
    }
    Object.freeze(ch.metricDescriptors)

    // Freeze the top-level sourceAuthority array.
    Object.freeze((ch as { sourceAuthority: string[] }).sourceAuthority)

    // Freeze each ConnectorRef.
    for (const conn of ch.connectorRefs) {
      Object.freeze(conn)
    }
    Object.freeze(ch.connectorRefs)

    // Freeze each GatedWorkType.
    for (const wt of ch.workTypes) {
      Object.freeze(wt)
    }
    Object.freeze(ch.workTypes)

    // Freeze renderHints if present.
    if (ch.renderHints) {
      Object.freeze(ch.renderHints)
    }

    // Freeze the descriptor itself.
    Object.freeze(ch)
  }

  Object.freeze(channels)
  return channels
}

// ── getChannelMetricDescriptors ───────────────────────────────────────────────
//
// Returns the flat union of metricDescriptors from all channels.
// Pure function — no side effects, no state.

export function getChannelMetricDescriptors(
  channels: readonly ChannelDescriptor[],
): MetricDescriptor[] {
  const result: MetricDescriptor[] = []
  for (const ch of channels) {
    result.push(...ch.metricDescriptors)
  }
  return result
}

// ── getChannelWorkTypes ───────────────────────────────────────────────────────
//
// Returns the flat union of workTypes from all channels.
// Pure function — no side effects, no state.

export function getChannelWorkTypes(
  channels: readonly ChannelDescriptor[],
): GatedWorkType[] {
  const result: GatedWorkType[] = []
  for (const ch of channels) {
    result.push(...ch.workTypes)
  }
  return result
}

// ── composeDeptMetricDescriptors ─────────────────────────────────────────────
//
// Dept-level composition: deptOwn + all channels' metricDescriptors.
// This is the value getActiveMetricDescriptors() should return for a dept
// that has channels: deptModule.metricsEmitted + channels' metricDescriptors.
//
// Usage: registry.ts's getActiveMetricDescriptors() calls this when a dept
// module carries a `channels` field (future wiring in S2). Tests call this
// directly to assert composition.

export function composeDeptMetricDescriptors(
  deptOwn: readonly MetricDescriptor[],
  channels: readonly ChannelDescriptor[],
): MetricDescriptor[] {
  return [...deptOwn, ...getChannelMetricDescriptors(channels)]
}
