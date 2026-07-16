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

export function registerAddonConsoleRenderer(renderer: AddonConsoleRenderer): void {
  if (renderers.has(renderer.key)) throw new Error('addon_console_renderer_duplicate_key')
  renderers.set(renderer.key, Object.freeze({ ...renderer }))
}

export function getAddonConsoleRenderer(key: string): AddonConsoleRenderer | undefined {
  return renderers.get(key)
}
