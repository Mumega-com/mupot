import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env } from '../types'
import type { AddonInstallation } from './service'

export interface AddonConsoleRenderer {
  key: string
  path: string
  title: string
  navIcon: string
  render(env: Env, installation: AddonInstallation | null): Promise<HtmlEscapedString>
}

const renderers = new Map<string, AddonConsoleRenderer>()

const RENDERER_KEYS = ['key', 'path', 'title', 'navIcon', 'render'] as const

function snapshotRendererRecord(renderer: AddonConsoleRenderer): AddonConsoleRenderer {
  if (typeof renderer !== 'object' || renderer === null || Array.isArray(renderer)) {
    throw new Error('addon_console_renderer_invalid')
  }
  if (Object.getPrototypeOf(renderer) !== Object.prototype) {
    throw new Error('addon_console_renderer_invalid')
  }

  const allowed = new Set<string>(RENDERER_KEYS)
  for (const key of Reflect.ownKeys(renderer)) {
    if (typeof key !== 'string') throw new Error('addon_console_renderer_invalid')
    const descriptor = Object.getOwnPropertyDescriptor(renderer, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !allowed.has(key)) {
      throw new Error('addon_console_renderer_invalid')
    }
  }

  const snapshot = {} as Record<(typeof RENDERER_KEYS)[number], unknown>
  for (const key of RENDERER_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(renderer, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('addon_console_renderer_invalid')
    }
    snapshot[key] = descriptor.value
  }

  if (
    typeof snapshot.key !== 'string'
    || typeof snapshot.path !== 'string'
    || typeof snapshot.title !== 'string'
    || typeof snapshot.navIcon !== 'string'
    || typeof snapshot.render !== 'function'
  ) {
    throw new Error('addon_console_renderer_invalid')
  }

  return Object.freeze(snapshot as AddonConsoleRenderer)
}

export function registerAddonConsoleRenderer(renderer: AddonConsoleRenderer): void {
  const snapshot = snapshotRendererRecord(renderer)
  if (renderers.has(snapshot.key)) throw new Error('addon_console_renderer_duplicate_key')
  renderers.set(snapshot.key, snapshot)
}

export function getAddonConsoleRenderer(key: string): AddonConsoleRenderer | undefined {
  return renderers.get(key)
}
