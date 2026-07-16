import {
  manifestSha256,
  validateAddonManifest,
  type AddonManifestV1,
} from './contract'
import { MUPOT_PUBLIC_API_VERSION } from '../version'
import { composeDeptMetricDescriptors } from '../departments/channels/compose'
import { getRegistered as getRegisteredDepartment } from '../departments/registry'
import { getAddonConsoleRenderer } from './console-registry'

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

interface Semver {
  major: number
  minor: number
  patch: number
}

function parseSemver(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : null
}

function compareSemver(left: Semver, right: Semver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

function supportsMupotVersion(range: string, version: string): boolean {
  const current = parseSemver(version)
  if (!current) return false
  const exact = parseSemver(range)
  if (exact) return compareSemver(current, exact) === 0
  if (!range.startsWith('^')) return false
  const minimum = parseSemver(range.slice(1))
  if (!minimum || compareSemver(current, minimum) < 0) return false
  const maximum = minimum.major > 0
    ? { major: minimum.major + 1, minor: 0, patch: 0 }
    : minimum.minor > 0
      ? { major: 0, minor: minimum.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: minimum.patch + 1 }
  return compareSemver(current, maximum) < 0
}

export function assertAddonRuntimeContract(manifest: AddonManifestV1): void {
  if (!supportsMupotVersion(manifest.mupotCompatibility, MUPOT_PUBLIC_API_VERSION)) {
    throw new Error('addon_mupot_incompatible')
  }

  const declaredDepartments = new Map<string, ReturnType<typeof getRegisteredDepartment>>()
  for (const department of manifest.departments) {
    const registered = getRegisteredDepartment(department.moduleKey)
    if (!registered) throw new Error('addon_department_not_registered')
    declaredDepartments.set(department.moduleKey, registered)
  }

  for (const metric of manifest.metrics) {
    const owner = declaredDepartments.get(metric.ownerDepartment)
    if (!owner) throw new Error('addon_metric_owner_not_registered')
    const descriptors = composeDeptMetricDescriptors(owner.metricsEmitted, owner.channels ?? [])
    if (!descriptors.some((descriptor) => descriptor.key === metric.descriptorKey)) {
      throw new Error('addon_metric_not_registered')
    }
  }

  for (const section of manifest.consoleSections) {
    const registered = getAddonConsoleRenderer(section.rendererKey)
    if (
      !registered
      || registered.key !== section.rendererKey
      || registered.path !== section.path
      || registered.title !== section.title
      || registered.navIcon !== section.navIcon
    ) {
      throw new Error('addon_renderer_not_registered')
    }
  }
}

export function createAddonRegistry(): AddonRegistry {
  const entries = new Map<string, AddonCatalogEntry>()
  const inFlightKeys = new Set<string>()

  return {
    async register(manifest: AddonManifestV1): Promise<void> {
      const validation = validateAddonManifest(manifest)
      if (!validation.ok) throw new Error(`addon_manifest_invalid:${validation.reason}`)
      assertAddonRuntimeContract(validation.manifest)
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
