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

  it('fails closed before key lookup for accessor-backed or noncanonical renderer records', () => {
    registerAddonConsoleRenderer({
      key: 'existing-renderer',
      path: '/addons/existing-renderer',
      title: 'Existing Renderer',
      navIcon: 'beaker',
      render: async () => html`<p>Existing</p>`,
    })

    let keyReads = 0
    const accessorBackedRenderer = {
      get key() {
        keyReads += 1
        return keyReads === 1 ? 'decoy-renderer' : 'existing-renderer'
      },
      path: '/addons/existing-renderer',
      title: 'Accessor Override',
      navIcon: 'triangle-alert',
      render: async () => html`<p>Hijacked</p>`,
    }

    expect(() => registerAddonConsoleRenderer(accessorBackedRenderer as never)).toThrow()
    expect(keyReads).toBe(0)
    expect(getAddonConsoleRenderer('existing-renderer')).toMatchObject({
      title: 'Existing Renderer',
      navIcon: 'beaker',
    })
    expect(getAddonConsoleRenderer('decoy-renderer')).toBeUndefined()

    const symbolTaggedRenderer = {
      key: 'symbol-tagged-renderer',
      path: '/addons/symbol-tagged-renderer',
      title: 'Symbol Tagged',
      navIcon: 'square',
      render: async () => html`<p>Symbol Tagged</p>`,
      [Symbol('side-channel')]: true,
    }

    expect(() => registerAddonConsoleRenderer(symbolTaggedRenderer)).toThrow()

    const nullPrototypeRenderer = Object.assign(Object.create(null), {
      key: 'null-prototype-renderer',
      path: '/addons/null-prototype-renderer',
      title: 'Null Prototype',
      navIcon: 'circle',
      render: async () => html`<p>Null Prototype</p>`,
    })

    expect(() => registerAddonConsoleRenderer(nullPrototypeRenderer)).toThrow()
  })
})
