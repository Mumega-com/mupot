import { describe, expect, it } from 'vitest'
import { html } from 'hono/html'
import {
  getAddonConsoleRenderer,
  registerAddonConsoleRenderer,
} from '../src/addons/console-registry'

describe('addon console renderer registry', () => {
  it('resolves a pre-registered addon renderer independently of departments', () => {
    registerAddonConsoleRenderer({
      key: 'marketing-cro-monitor',
      path: '/addons/marketing-cro-monitor',
      title: 'Marketing & CRO',
      navIcon: 'chart-no-axes-combined',
      render: async () => html`<p>Unavailable until configured</p>`,
    })

    expect(getAddonConsoleRenderer('marketing-cro-monitor')?.path).toBe('/addons/marketing-cro-monitor')
  })

  it('freezes the registered renderer and rejects a duplicate key', () => {
    const renderer = {
      key: 'fixture-addon-console',
      path: '/addons/fixture-addon-console',
      title: 'Fixture Addon Console',
      navIcon: 'beaker',
      render: async () => html`<p>Fixture</p>`,
    }

    registerAddonConsoleRenderer(renderer)

    expect(Object.isFrozen(getAddonConsoleRenderer(renderer.key))).toBe(true)
    expect(() => registerAddonConsoleRenderer(renderer)).toThrow('addon_console_renderer_duplicate_key')
  })
})
