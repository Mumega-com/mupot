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

// ── ChannelComposeError ───────────────────────────────────────────────────────
//
// Thrown by composeDeptMetricDescriptors and getChannelWorkTypes when a duplicate
// key is detected across (deptOwn ∪ channels) or across sibling channels.
//
// SECURITY: a duplicate metric key means a channel is shadowing a dept-owned (or
// sibling-owned) descriptor with a potentially wider sourceAuthority. The kernel
// builds its authority map via `new Map(module.metricsEmitted.map(...))` — last key
// wins — so any duplicate is an authority-shadow vector. We FAIL CLOSED: throw
// before the result is ever produced. Do NOT silently dedupe or last-wins.
//
// A duplicate work-type key is a hard error too: work-type keys may become
// authority-bearing in S3/S4. Fail closed now.

export class ChannelComposeError extends Error {
  readonly code: 'duplicate_metric_key' | 'duplicate_work_type_key'
  readonly key: string

  constructor(code: 'duplicate_metric_key' | 'duplicate_work_type_key', key: string) {
    super(
      code === 'duplicate_metric_key'
        ? `ChannelComposeError: duplicate_metric_key — key '${key}' appears more than once across dept own + channel descriptors. A channel cannot shadow a dept-owned or sibling metric key (authority-widening vector). Fix: ensure every metric key is globally unique within the department.`
        : `ChannelComposeError: duplicate_work_type_key — key '${key}' appears more than once across channel work-types. Fix: ensure every work-type key is unique across all channels in this department.`,
    )
    this.name = 'ChannelComposeError'
    this.code = code
    this.key = key
  }
}

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
//
// DUPLICATE-KEY GUARD: throws ChannelComposeError('duplicate_work_type_key', key)
// if the same work-type key appears in more than one channel. A duplicate is a hard
// error — work-type keys may become authority-bearing in S3/S4 (Codex gate, S1).
// Do NOT silently dedupe; fail closed before the result is produced.
//
// TODO(S2): when channels are wired into DepartmentModule, the registration/mint
// path MUST call getChannelWorkTypes (or cover the channels field in
// registry.deepFreezeClone) so composed work-type descriptors are frozen before
// the kernel consumes them.

export function getChannelWorkTypes(
  channels: readonly ChannelDescriptor[],
): GatedWorkType[] {
  const seen = new Set<string>()
  const result: GatedWorkType[] = []
  for (const ch of channels) {
    for (const wt of ch.workTypes) {
      if (seen.has(wt.key)) {
        throw new ChannelComposeError('duplicate_work_type_key', wt.key)
      }
      seen.add(wt.key)
      result.push(wt)
    }
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
//
// DUPLICATE-KEY GUARD (SECURITY — fail closed): throws
// ChannelComposeError('duplicate_metric_key', key) if ANY metric key appears
// more than once across (deptOwn ∪ all channel metricDescriptors), including
// channel-vs-channel duplicates. The kernel builds its authority map via:
//   new Map(module.metricsEmitted.map(...))   ← last duplicate key wins
// A channel can therefore shadow a dept-owned key with a wider sourceAuthority.
// We reject BEFORE the result array is produced — the Map is never built from
// a poisoned input. Do NOT silently dedupe or last-wins; a key collision is
// always either an authority-shadow attempt or a configuration bug.
//
// TODO(S2): when channels are wired into DepartmentModule, the registration/mint
// path MUST deepFreezeChannels (or registry.deepFreezeClone must cover the
// channels field) so composed channel descriptors are frozen before the kernel
// consumes them.
//
// TODO(S3): configSchema is not deep-frozen in deepFreezeChannels. Wire
// Zod-validate + freeze configSchema here when the SEO channel defines a real
// config shape (Opus Low finding, S1 gate).

export function composeDeptMetricDescriptors(
  deptOwn: readonly MetricDescriptor[],
  channels: readonly ChannelDescriptor[],
): MetricDescriptor[] {
  // First pass: collect all keys and fail closed on the first duplicate.
  const seen = new Set<string>()

  // Step 1: check for duplicates WITHIN deptOwn itself (authority-shadow vector).
  // A dup inside deptOwn is a config bug; fail closed before building anything.
  for (const desc of deptOwn) {
    if (seen.has(desc.key)) {
      throw new ChannelComposeError('duplicate_metric_key', desc.key)
    }
    seen.add(desc.key)
  }

  // Step 2: check for deptOwn-vs-channel and channel-vs-channel collisions.
  for (const ch of channels) {
    for (const desc of ch.metricDescriptors) {
      if (seen.has(desc.key)) {
        throw new ChannelComposeError('duplicate_metric_key', desc.key)
      }
      seen.add(desc.key)
    }
  }

  // Second pass: produce the result only after all keys are proven unique.
  return [...deptOwn, ...getChannelMetricDescriptors(channels)]
}
