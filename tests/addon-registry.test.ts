import { describe, expect, it } from 'vitest'
import { createAddonRegistry } from '../src/addons/registry'
import { FixtureAddon } from '../src/addons/modules/fixture'
import { MarketingCroMonitorAddon } from '../src/addons/modules/marketing-cro-monitor'

describe('addon registry', () => {
  it('registers a deep-frozen clone', async () => {
    const registry = createAddonRegistry()
    await registry.register(FixtureAddon)
    const stored = registry.get(FixtureAddon.key)
    expect(stored?.manifest).not.toBe(FixtureAddon)
    expect(Object.isFrozen(stored?.manifest)).toBe(true)
    expect(Object.isFrozen(stored?.manifest.departments)).toBe(true)
    expect(stored?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects duplicate keys without a replacement API', async () => {
    const registry = createAddonRegistry()
    await registry.register(FixtureAddon)
    await expect(registry.register(FixtureAddon)).rejects.toThrow('addon_registry_duplicate_key')
  })

  it('rejects concurrent duplicate registrations', async () => {
    const registry = createAddonRegistry()
    const results = await Promise.allSettled([
      registry.register(FixtureAddon),
      registry.register(FixtureAddon),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('rejects a manifest incompatible with the deployed Mupot API', async () => {
    const registry = createAddonRegistry()

    await expect(registry.register({
      ...FixtureAddon,
      key: 'incompatible-addon',
      mupotCompatibility: '^0.23.0',
    })).rejects.toThrow('addon_mupot_incompatible')
  })

  it('rejects unknown department references', async () => {
    const registry = createAddonRegistry()

    await expect(registry.register({
      ...FixtureAddon,
      key: 'unknown-department-addon',
      departments: [{ moduleKey: 'missing-department', required: true }],
    })).rejects.toThrow('addon_department_not_registered')
  })

  it('rejects metrics that are not owned by an authoritative department descriptor', async () => {
    const registry = createAddonRegistry()

    await expect(registry.register({
      ...FixtureAddon,
      key: 'unknown-metric-addon',
      metrics: [{ descriptorKey: 'fixture.unknown', ownerDepartment: 'fixture' }],
    })).rejects.toThrow('addon_metric_not_registered')
  })

  it('rejects console references that do not exactly match a registered section', async () => {
    const registry = createAddonRegistry()

    await expect(registry.register({
      ...FixtureAddon,
      key: 'unknown-renderer-addon',
      consoleSections: [{
        rendererKey: 'fixture',
        path: '/departments/fixture',
        title: 'Fixture',
        navIcon: 'unregistered-icon',
      }],
    })).rejects.toThrow('addon_renderer_not_registered')
  })

  it('registers the marketing monitor against its pre-registered console renderer', async () => {
    const registry = createAddonRegistry()

    await registry.register(MarketingCroMonitorAddon)

    expect(registry.get(MarketingCroMonitorAddon.key)?.manifest.consoleSections).toEqual([
      expect.objectContaining({
        rendererKey: 'marketing-cro-monitor',
        path: '/addons/marketing-cro-monitor',
      }),
    ])
  })
})
