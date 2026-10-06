import { describe, expect, it, vi } from 'vitest'
import { ADDON_API_VERSION } from '../src/addons/api-version'
import { canonicalManifestJson, manifestSha256, validateAddonManifest } from '../src/addons/contract'
import { createAddonRegistry, listRegisteredAddons } from '../src/addons/registry'
import { FixtureAddon } from '../src/addons/modules/fixture'
import '../src/addons/modules/index'
import '../src/addons/modules/fixture-with-loop'
import '../src/addons/project-link/manifest'
import '../src/addons/workflow-circuits/manifest'
import '../src/addons/office/manifest'

// Digests of every registered addon as computed on main BEFORE ADDON_API_VERSION
// existed (e07f938d). Decoupling addon compatibility from the product version
// must not move any of them — a moved digest drifts live addon_installations
// rows and needs a backfill migration like 0181. If this test goes red you
// changed digest-bound manifest content; that is a migration, not a refactor.
const PINNED_DIGESTS: Record<string, string> = {
  'fixture-addon': '5dc890ecb8ad0f17ca934f4862d80974af2a8fd1f3f8d89469085d1433376cea',
  'fixture-addon-with-loop': '747d860766a47f0788eca7e130d72f73e2fcee08e5f4f858199fd766203307d3',
  'marketing-cro-monitor': '7c6081a3debd40846c4c724110917c1c2685ebe315f081e9d73b2ad258225c6a',
  'project-link': '139f17b91d4ce39b23f510c4006826d3ddfa95e11c13d30ba528bcb36e8dd629',
  'workflow-circuits': '3e7e7084eb77f6cc8f27f93d3370294c1ed6d399a674acc1a8d272053f0dd661',
  'mcpwp-office': '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f',
}

const externalVariant = {
  ...FixtureAddon,
  key: 'external-api-variant',
  trustClass: 'external_isolated' as const,
  kind: 'external_mcp' as const,
  departments: [],
  metrics: [],
  consoleSections: [],
}

describe('addon API compatibility', () => {
  it('starts at 1.0.0 and every in-repo manifest declares a range satisfied by it', () => {
    expect(ADDON_API_VERSION).toBe('1.0.0')
    const entries = listRegisteredAddons()
    expect(entries.map((e) => e.manifest.key).sort()).toEqual(Object.keys(PINNED_DIGESTS).sort())
    for (const entry of entries) expect(entry.manifest.addonApiCompatibility).toBe('^1.0.0')
  })

  it('registers native and external manifests compatible with the addon API', async () => {
    const registry = createAddonRegistry()
    await registry.register({ ...FixtureAddon, key: 'api-ok-native', addonApiCompatibility: '^1.0.0' })
    await registry.register({ ...externalVariant, addonApiCompatibility: '^1.0.0' })
    expect(registry.list()).toHaveLength(2)
  })

  it.each(['^2.0.0', '^1.1.0', '^0.31.0', '~1.0.0', '>=1.0.0'])(
    'rejects an addon requiring addon API %s (native and external, no grace band)',
    async (range) => {
      const registry = createAddonRegistry()
      await expect(registry.register({ ...FixtureAddon, key: 'api-bad-native', addonApiCompatibility: range }))
        .rejects.toThrow('addon_api_incompatible')
      await expect(registry.register({ ...externalVariant, addonApiCompatibility: range }))
        .rejects.toThrow('addon_api_incompatible')
    },
  )

  it('ignores the legacy mupotCompatibility pin once addonApiCompatibility is declared', async () => {
    const registry = createAddonRegistry()
    await registry.register({
      ...FixtureAddon,
      key: 'legacy-pin-ignored',
      mupotCompatibility: '^0.1.0',
      addonApiCompatibility: '^1.0.0',
    })
    expect(registry.get('legacy-pin-ignored')).toBeDefined()
  })

  it('rejects a non-string addonApiCompatibility at validation', () => {
    const result = validateAddonManifest({ ...FixtureAddon, addonApiCompatibility: 1 })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_string', path: 'addonApiCompatibility' })
  })
})

describe('digest-bound identity is independent of the addon API pin', () => {
  it('keeps every registered addon digest byte-identical to its pre-ADDON_API_VERSION value', () => {
    const actual = Object.fromEntries(listRegisteredAddons().map((e) => [e.manifest.key, e.manifestSha256]))
    expect(actual).toEqual(PINNED_DIGESTS)
  })

  it('declaring or re-pinning addonApiCompatibility does not change the digest', async () => {
    const { addonApiCompatibility: _declared, ...legacy } = FixtureAddon
    const base = await manifestSha256(legacy)
    expect(await manifestSha256({ ...legacy, addonApiCompatibility: '^1.0.0' })).toBe(base)
    expect(await manifestSha256({ ...legacy, addonApiCompatibility: '^2.0.0' })).toBe(base)
    expect(canonicalManifestJson({ ...legacy, addonApiCompatibility: '^1.0.0' })).not.toContain('addonApiCompatibility')
  })

  it('still binds the frozen mupotCompatibility into the digest (mutation guard)', async () => {
    const base = await manifestSha256(FixtureAddon)
    expect(await manifestSha256({ ...FixtureAddon, mupotCompatibility: '^0.99.0' })).not.toBe(base)
  })
})

describe('product version bump does not touch addons', () => {
  it('keeps all registered addons valid with identical digests when MUPOT_PUBLIC_API_VERSION alone changes', async () => {
    vi.resetModules()
    vi.doMock('../src/version', () => ({ MUPOT_PUBLIC_API_VERSION: '9.99.0' }))
    try {
      // Importing the manifests re-runs their top-level registerAddon() against
      // a fresh production registry whose host version is now 9.99.0. A
      // product-version-coupled check would throw addon_mupot_incompatible here.
      const registry = await import('../src/addons/registry')
      await import('../src/addons/modules/index')
      await import('../src/addons/modules/fixture-with-loop')
      await import('../src/addons/project-link/manifest')
      await import('../src/addons/workflow-circuits/manifest')
      await import('../src/addons/office/manifest')
      const actual = Object.fromEntries(registry.listRegisteredAddons().map((e) => [e.manifest.key, e.manifestSha256]))
      expect(actual).toEqual(PINNED_DIGESTS)
    } finally {
      vi.doUnmock('../src/version')
      vi.resetModules()
    }
  })

  it('legacy manifests without addonApiCompatibility remain coupled to the product version (documents the old failure)', async () => {
    const { addonApiCompatibility: _declared, ...legacy } = FixtureAddon
    vi.resetModules()
    vi.doMock('../src/version', () => ({ MUPOT_PUBLIC_API_VERSION: '9.99.0' }))
    try {
      const { createAddonRegistry: fresh } = await import('../src/addons/registry')
      await expect(fresh().register({ ...legacy, key: 'legacy-coupled' })).rejects.toThrow('addon_mupot_incompatible')
    } finally {
      vi.doUnmock('../src/version')
      vi.resetModules()
    }
  })
})
