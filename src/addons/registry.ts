import {
  manifestSha256,
  validateAddonManifest,
  type AddonManifestV1,
} from './contract'

export interface AddonCatalogEntry {
  manifest: AddonManifestV1
  manifestSha256: string
}

export interface AddonRegistry {
  register(manifest: AddonManifestV1): Promise<void>
  get(key: string): AddonCatalogEntry | undefined
  list(): AddonCatalogEntry[]
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key))
    }
    Object.freeze(value)
  }
  return value
}

export function createAddonRegistry(): AddonRegistry {
  const entries = new Map<string, AddonCatalogEntry>()
  const inFlightKeys = new Set<string>()

  return {
    async register(manifest: AddonManifestV1): Promise<void> {
      const validation = validateAddonManifest(manifest)
      if (!validation.ok) throw new Error(`addon_manifest_invalid:${validation.reason}`)
      if (entries.has(validation.manifest.key) || inFlightKeys.has(validation.manifest.key)) {
        throw new Error('addon_registry_duplicate_key')
      }

      inFlightKeys.add(validation.manifest.key)
      try {
        const immutableManifest = deepFreeze(structuredClone(validation.manifest))
        const entry = Object.freeze({
          manifest: immutableManifest,
          manifestSha256: await manifestSha256(immutableManifest),
        })
        entries.set(immutableManifest.key, entry)
      } finally {
        inFlightKeys.delete(validation.manifest.key)
      }
    },
    get(key: string): AddonCatalogEntry | undefined {
      return entries.get(key)
    },
    list(): AddonCatalogEntry[] {
      return [...entries.values()]
    },
  }
}

const productionRegistry = createAddonRegistry()

export function registerAddon(manifest: AddonManifestV1): Promise<void> {
  return productionRegistry.register(manifest)
}

export function getRegisteredAddon(key: string): AddonCatalogEntry | undefined {
  return productionRegistry.get(key)
}

export function listRegisteredAddons(): AddonCatalogEntry[] {
  return productionRegistry.list()
}
