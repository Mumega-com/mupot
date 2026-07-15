import { describe, expect, it } from 'vitest'
import { createAddonRegistry } from '../src/addons/registry'
import { FixtureAddon } from '../src/addons/modules/fixture'

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
})
