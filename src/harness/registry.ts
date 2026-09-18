// src/harness/registry.ts — Registry for pluggable Harness Adapters.
//
// Governs adapter discovery, registration, and strict resolution.
// Rule: NEVER silently fallback from one harness to another (e.g. Cursor fails -> don't launch Grok).
// Fallback is strictly an intentional operator routing decision.

import type { Env } from '../types'
import { cursorCloudAdapter } from './adapters/cursor'
import { grokCliAdapter } from './adapters/grok'
import type { HarnessAdapter, HarnessKind } from './types'

const adapters = new Map<HarnessKind, HarnessAdapter>([
  ['cursor-cloud', cursorCloudAdapter],
  ['grok-cli', grokCliAdapter],
])

export function registerHarnessAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.kind, adapter)
}

export function getHarnessAdapter(kind: HarnessKind): HarnessAdapter | null {
  return adapters.get(kind) ?? null
}

export function requireHarnessAdapter(kind: HarnessKind): HarnessAdapter {
  const adapter = getHarnessAdapter(kind)
  if (!adapter) {
    throw new Error(`harness_adapter_not_found: ${kind}`)
  }
  return adapter
}

export function listHarnessAdapters(): HarnessAdapter[] {
  return Array.from(adapters.values())
}

export function discoverAvailableAdapters(env: Env): HarnessAdapter[] {
  return listHarnessAdapters().filter((adapter) => adapter.isAvailable(env))
}

export function resolveHarnessAdapter(
  preferred: HarnessKind,
  env: Env,
): { ok: true; adapter: HarnessAdapter } | { ok: false; error: 'harness_unknown' | 'harness_unavailable' } {
  const adapter = getHarnessAdapter(preferred)
  if (!adapter) {
    return { ok: false, error: 'harness_unknown' }
  }
  if (!adapter.isAvailable(env)) {
    return { ok: false, error: 'harness_unavailable' }
  }
  return { ok: true, adapter }
}
