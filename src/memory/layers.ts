// Composite memory — Mirror as one layer beside native, not a replacement.
// Writes: member:* → native (if present); squad:* / project:* → mirror (if present).
// Recall: all enabled layers. A down extra layer returns no hits (no invention)
// and does not take the other layers down. A sole layer still fails closed.

import type { MemoryBackendKind, MemoryHit, MemoryPort } from '../types'
import { MemoryBackendError } from './verbs'

export function isOpsScope(scope: string): boolean {
  return scope.startsWith('squad:') || scope.startsWith('project:')
}

export function createLayeredMemory(
  ports: Partial<Record<MemoryBackendKind, MemoryPort>>,
  order: MemoryBackendKind[],
): MemoryPort {
  if (order.length === 0) {
    throw new MemoryBackendError('memory layers list is empty', 'memory_layers_empty')
  }
  for (const kind of order) {
    if (!ports[kind]) {
      throw new MemoryBackendError(`memory layer ${kind} is not constructed`, 'memory_layer_missing')
    }
  }

  function writerFor(scope: string): MemoryPort {
    if (isOpsScope(scope) && ports.mirror) return ports.mirror
    if (ports.native) return ports.native
    return ports[order[0]] as MemoryPort
  }

  return {
    backend: ports.native ? 'native' : order[0],
    layers: order,
    remember(scope: string, text: string, concepts?: string[]) {
      return writerFor(scope).remember(scope, text, concepts)
    },
    async recall(scope: string, query: string, limit = 5): Promise<MemoryHit[]> {
      const collected: MemoryHit[] = []
      const errors: Error[] = []
      for (const kind of order) {
        const port = ports[kind] as MemoryPort
        try {
          collected.push(...await port.recall(scope, query, limit))
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
        }
      }
      if (collected.length === 0 && errors.length === order.length) {
        throw errors[0]
      }
      return collected
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
  }
}
