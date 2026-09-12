// Memory factory — pot owner picks layers; agents keep remember/recall.
//
//   native (default) — D1 + Vectorize (pot_engram)
//   mirror           — real Mirror HTTP at MIRROR_URL (ops_experience)
//   verbs            — hosted MEMORY_VERBS v1 (not Mac GBrain)
//
// MEMORY_BACKEND picks a single store (legacy).
// MEMORY_LAYERS=native,mirror puts Mirror beside native.
// Unknown names fail closed. A sole down Mirror fails closed.
// A down extra Mirror layer does not invent hits and does not take native down.

import type { Env, MemoryBackendKind, MemoryPort } from '../types'
import { createLayeredMemory } from './layers'
import { createMirrorMemory } from './mirror'
import { createNativeMemory } from './native'
import { createVerbsMemory, MemoryBackendError, type FetchLike } from './verbs'

export { EMBED_MODEL } from './native'
export { createNativeMemory } from './native'
export { createVerbsMemory, MemoryBackendError, attributedProvenance, scopedEntity } from './verbs'
export { createMirrorMemory, mirrorCite } from './mirror'
export { createLayeredMemory, isOpsScope } from './layers'

const KINDS = new Set<MemoryBackendKind>(['native', 'mirror', 'verbs'])

export function resolveMemoryBackend(env: Env): MemoryBackendKind {
  const raw = (env.MEMORY_BACKEND ?? 'native').trim().toLowerCase()
  if (raw === '' || raw === 'native' || raw === 'vectorize' || raw === 'd1') return 'native'
  if (!KINDS.has(raw as MemoryBackendKind)) {
    throw new MemoryBackendError(
      `unknown MEMORY_BACKEND=${raw} (accepted: native, mirror, verbs)`,
      'memory_backend_unknown',
    )
  }
  return raw as MemoryBackendKind
}

export function resolveMemoryLayers(env: Env): MemoryBackendKind[] {
  const listed = (env.MEMORY_LAYERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (listed.length === 0) return [resolveMemoryBackend(env)]

  const layers: MemoryBackendKind[] = []
  for (const raw of listed) {
    const kind = raw === 'vectorize' || raw === 'd1' ? 'native' : raw
    if (!KINDS.has(kind as MemoryBackendKind)) {
      throw new MemoryBackendError(
        `unknown MEMORY_LAYERS entry=${raw} (accepted: native, mirror, verbs)`,
        'memory_layers_unknown',
      )
    }
    if (!layers.includes(kind as MemoryBackendKind)) layers.push(kind as MemoryBackendKind)
  }
  if (layers.length === 0) {
    throw new MemoryBackendError('MEMORY_LAYERS is empty', 'memory_layers_empty')
  }
  return layers
}

function buildPort(kind: MemoryBackendKind, env: Env, deps: { fetch?: FetchLike }): MemoryPort {
  if (kind === 'mirror') return createMirrorMemory(env, deps)
  if (kind === 'verbs') return createVerbsMemory(env, deps)
  return createNativeMemory(env)
}

export function createMemory(env: Env, deps: { fetch?: FetchLike } = {}): MemoryPort {
  const layers = resolveMemoryLayers(env)
  if (layers.length === 1) return buildPort(layers[0], env, deps)
  const ports: Partial<Record<MemoryBackendKind, MemoryPort>> = {}
  for (const kind of layers) ports[kind] = buildPort(kind, env, deps)
  return createLayeredMemory(ports, layers)
}
