import type { Capability, CapabilityScopeType } from '../types'

export interface AddonManifestV1 {
  schema: 'mupot.addon/v1'
  key: string
  name: string
  version: string
  publisher: string
  trustClass: 'native_reviewed' | 'external_isolated'
  mupotCompatibility: string
  kind: 'native' | 'external_mcp'
  description: string
  departments: Array<{
    moduleKey: string
    required: boolean
  }>
  agentTemplates: Array<{
    key: string
    name: string
    role: string
    departmentModuleKey: string
    squadSlug: string
    defaultStatus: 'inactive'
  }>
  connectorRequirements: Array<{
    slot: string
    accepts: string[]
    required: boolean
    capability: 'read' | 'write'
    bindingKind: 'vault_connector' | 'internal_adapter' | 'either'
  }>
  authorityRequests: {
    rankGrants: Array<{
      subjectRef: string
      capability: Capability
      scopeType: CapabilityScopeType
      scopeRef: string | null
      reason: string
    }>
    surfaceGrants: Array<{
      subjectRef: string
      capability: string
      reason: string
    }>
  }
  metrics: Array<{
    descriptorKey: string
    ownerDepartment: string
  }>
  playbooks: Array<{
    key: string
    version: string
  }>
  loops: Array<{
    templateKey: string
    defaultState: 'disabled' | 'active'
    approvalRequired: boolean
  }>
  consoleSections: Array<{
    rendererKey: string
    path: string
    title: string
    navIcon: string
  }>
  eventSubscriptions: string[]
  approvalPolicies: Array<{
    action: string
    requiredCapability: Capability
    selfApproval: false
  }>
  healthChecks: string[]
  retention: {
    disablePreservesData: true
    purgeRequiresOwner: true
  }
}

export type AddonValidationResult =
  | { ok: true; manifest: AddonManifestV1 }
  | { ok: false; reason: string; path?: string }

const CAPABILITIES: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
const SCOPE_TYPES: readonly CapabilityScopeType[] = ['org', 'department', 'squad']
const TOP_LEVEL_KEYS = [
  'schema',
  'key',
  'name',
  'version',
  'publisher',
  'trustClass',
  'mupotCompatibility',
  'kind',
  'description',
  'departments',
  'agentTemplates',
  'connectorRequirements',
  'authorityRequests',
  'metrics',
  'playbooks',
  'loops',
  'consoleSections',
  'eventSubscriptions',
  'approvalPolicies',
  'healthChecks',
  'retention',
] as const

const KEY_PATTERN = /^[a-z0-9-]{3,64}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: string, path?: string): AddonValidationResult {
  return path === undefined ? { ok: false, reason } : { ok: false, reason, path }
}

function validateCanonicalRecord(value: unknown, keys: readonly string[], path: string): AddonValidationResult | null {
  if (!isRecord(value)) return fail('invalid_object', path)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail('invalid_object', path)

  const allowed = new Set(keys)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return fail('invalid_object', path)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail('invalid_object', `${path}.${key}`)
    if (!allowed.has(key)) return fail('unknown_field', `${path}.${key}`)
  }

  const missing = keys.find((key) => !Object.hasOwn(value, key))
  return missing === undefined ? null : fail('missing_field', `${path}.${missing}`)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown, path: string): AddonValidationResult | null {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) return fail('invalid_string_array', path)
  if (new Set(value).size !== value.length) return fail('duplicate_entry', path)
  return null
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITIES.includes(value as Capability)
}

function isScopeType(value: unknown): value is CapabilityScopeType {
  return typeof value === 'string' && SCOPE_TYPES.includes(value as CapabilityScopeType)
}

function validateDepartments(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'departments')
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `departments[${index}]`
    const keyError = validateCanonicalRecord(entry, ['moduleKey', 'required'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.moduleKey)) return fail('invalid_module_key', `${path}.moduleKey`)
    if (!isBoolean(entry.required)) return fail('invalid_boolean', `${path}.required`)
    if (keys.has(entry.moduleKey)) return fail('duplicate_key', `${path}.moduleKey`)
    keys.add(entry.moduleKey)
  }
  return null
}

function validateAgentTemplates(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'agentTemplates')
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `agentTemplates[${index}]`
    const keyError = validateCanonicalRecord(entry, ['key', 'name', 'role', 'departmentModuleKey', 'squadSlug', 'defaultStatus'], path)
    if (keyError) return keyError
    if (typeof entry.key !== 'string' || !KEY_PATTERN.test(entry.key)) return fail('invalid_key', `${path}.key`)
    if (!isNonEmptyString(entry.name) || !isNonEmptyString(entry.role)) return fail('invalid_string', path)
    if (!isNonEmptyString(entry.departmentModuleKey) || !isNonEmptyString(entry.squadSlug)) return fail('invalid_reference', path)
    if (entry.defaultStatus !== 'inactive') return fail('invalid_default_status', `${path}.defaultStatus`)
    if (keys.has(entry.key)) return fail('duplicate_key', `${path}.key`)
    keys.add(entry.key)
  }
  return null
}

function validateConnectorRequirements(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'connectorRequirements')
  const slots = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `connectorRequirements[${index}]`
    const keyError = validateCanonicalRecord(entry, ['slot', 'accepts', 'required', 'capability', 'bindingKind'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.slot)) return fail('invalid_string', `${path}.slot`)
    const acceptsError = isStringArray(entry.accepts, `${path}.accepts`)
    if (acceptsError) return acceptsError
    if (!isBoolean(entry.required)) return fail('invalid_boolean', `${path}.required`)
    if (entry.capability !== 'read' && entry.capability !== 'write') return fail('invalid_connector_capability', `${path}.capability`)
    if (entry.bindingKind !== 'vault_connector' && entry.bindingKind !== 'internal_adapter' && entry.bindingKind !== 'either') {
      return fail('invalid_binding_kind', `${path}.bindingKind`)
    }
    if (slots.has(entry.slot)) return fail('duplicate_key', `${path}.slot`)
    slots.add(entry.slot)
  }
  return null
}

function validateAuthorityRequests(value: unknown): AddonValidationResult | null {
  if (!isRecord(value)) return fail('invalid_object', 'authorityRequests')
  const objectError = validateCanonicalRecord(value, ['rankGrants', 'surfaceGrants'], 'authorityRequests')
  if (objectError) return objectError
  if (!Array.isArray(value.rankGrants) || !Array.isArray(value.surfaceGrants)) return fail('invalid_array', 'authorityRequests')

  const rankKeys = new Set<string>()
  for (const [index, entry] of value.rankGrants.entries()) {
    const path = `authorityRequests.rankGrants[${index}]`
    const keyError = validateCanonicalRecord(entry, ['subjectRef', 'capability', 'scopeType', 'scopeRef', 'reason'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.subjectRef) || !isNonEmptyString(entry.reason)) return fail('invalid_string', path)
    if (!isCapability(entry.capability)) return fail('invalid_capability', `${path}.capability`)
    if (!isScopeType(entry.scopeType)) return fail('invalid_scope_type', `${path}.scopeType`)
    if (entry.scopeType === 'org') {
      if (entry.scopeRef !== null) return fail('invalid_scope_ref', `${path}.scopeRef`)
    } else if (!isNonEmptyString(entry.scopeRef)) {
      return fail('invalid_scope_ref', `${path}.scopeRef`)
    }
    const rankKey = `${entry.subjectRef}\u0000${entry.scopeType}\u0000${entry.scopeRef ?? ''}\u0000${entry.capability}`
    if (rankKeys.has(rankKey)) return fail('duplicate_key', path)
    rankKeys.add(rankKey)
  }

  const surfaceKeys = new Set<string>()
  for (const [index, entry] of value.surfaceGrants.entries()) {
    const path = `authorityRequests.surfaceGrants[${index}]`
    const keyError = validateCanonicalRecord(entry, ['subjectRef', 'capability', 'reason'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.subjectRef) || !isNonEmptyString(entry.capability) || !isNonEmptyString(entry.reason)) return fail('invalid_string', path)
    if (entry.capability.includes('*')) return fail('invalid_surface_capability', `${path}.capability`)
    const surfaceKey = `${entry.subjectRef}\u0000${entry.capability}`
    if (surfaceKeys.has(surfaceKey)) return fail('duplicate_key', path)
    surfaceKeys.add(surfaceKey)
  }
  return null
}

function validateMetrics(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'metrics')
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `metrics[${index}]`
    const keyError = validateCanonicalRecord(entry, ['descriptorKey', 'ownerDepartment'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.descriptorKey) || !isNonEmptyString(entry.ownerDepartment)) return fail('invalid_string', path)
    if (keys.has(entry.descriptorKey)) return fail('duplicate_key', `${path}.descriptorKey`)
    keys.add(entry.descriptorKey)
  }
  return null
}

function validatePlaybooks(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'playbooks')
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `playbooks[${index}]`
    const keyError = validateCanonicalRecord(entry, ['key', 'version'], path)
    if (keyError) return keyError
    if (typeof entry.key !== 'string' || !KEY_PATTERN.test(entry.key)) return fail('invalid_key', `${path}.key`)
    if (typeof entry.version !== 'string' || !SEMVER_PATTERN.test(entry.version)) return fail('invalid_version', `${path}.version`)
    if (keys.has(entry.key)) return fail('duplicate_key', `${path}.key`)
    keys.add(entry.key)
  }
  return null
}

function validateLoops(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'loops')
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `loops[${index}]`
    const keyError = validateCanonicalRecord(entry, ['templateKey', 'defaultState', 'approvalRequired'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.templateKey)) return fail('invalid_string', `${path}.templateKey`)
    if (entry.defaultState !== 'disabled' && entry.defaultState !== 'active') return fail('invalid_loop_state', `${path}.defaultState`)
    if (!isBoolean(entry.approvalRequired)) return fail('invalid_boolean', `${path}.approvalRequired`)
    if (keys.has(entry.templateKey)) return fail('duplicate_key', `${path}.templateKey`)
    keys.add(entry.templateKey)
  }
  return null
}

function validateConsoleSections(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'consoleSections')
  const renderers = new Set<string>()
  const paths = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `consoleSections[${index}]`
    const keyError = validateCanonicalRecord(entry, ['rendererKey', 'path', 'title', 'navIcon'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.rendererKey) || !isNonEmptyString(entry.title) || !isNonEmptyString(entry.navIcon)) return fail('invalid_string', path)
    if (!isNonEmptyString(entry.path) || !entry.path.startsWith('/')) return fail('invalid_path', `${path}.path`)
    if (renderers.has(entry.rendererKey)) return fail('duplicate_key', `${path}.rendererKey`)
    if (paths.has(entry.path)) return fail('duplicate_key', `${path}.path`)
    renderers.add(entry.rendererKey)
    paths.add(entry.path)
  }
  return null
}

function validateApprovalPolicies(value: unknown): AddonValidationResult | null {
  if (!Array.isArray(value)) return fail('invalid_array', 'approvalPolicies')
  const actions = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const path = `approvalPolicies[${index}]`
    const keyError = validateCanonicalRecord(entry, ['action', 'requiredCapability', 'selfApproval'], path)
    if (keyError) return keyError
    if (!isNonEmptyString(entry.action)) return fail('invalid_string', `${path}.action`)
    if (!isCapability(entry.requiredCapability)) return fail('invalid_capability', `${path}.requiredCapability`)
    if (entry.selfApproval !== false) return fail('invalid_self_approval', `${path}.selfApproval`)
    if (actions.has(entry.action)) return fail('duplicate_key', `${path}.action`)
    actions.add(entry.action)
  }
  return null
}

export function validateAddonManifest(value: unknown): AddonValidationResult {
  try {
    if (!isRecord(value)) return fail('invalid_manifest')
    const topLevelError = validateCanonicalRecord(value, TOP_LEVEL_KEYS, 'manifest')
    if (topLevelError) return topLevelError
    if (value.schema !== 'mupot.addon/v1') return fail('invalid_schema', 'schema')
    if (typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)) return fail('invalid_key', 'key')
    for (const field of ['name', 'publisher', 'mupotCompatibility', 'description'] as const) {
      if (!isNonEmptyString(value[field])) return fail('invalid_string', field)
    }
    if (typeof value.version !== 'string' || !SEMVER_PATTERN.test(value.version)) return fail('invalid_version', 'version')
    if (value.trustClass !== 'native_reviewed' && value.trustClass !== 'external_isolated') return fail('invalid_trust_class', 'trustClass')
    if (value.kind !== 'native' && value.kind !== 'external_mcp') return fail('invalid_kind', 'kind')
    if ((value.kind === 'native') !== (value.trustClass === 'native_reviewed')) return fail('trust_kind_mismatch')

    const validators: Array<[unknown, (entry: unknown) => AddonValidationResult | null]> = [
      [value.departments, validateDepartments],
      [value.agentTemplates, validateAgentTemplates],
      [value.connectorRequirements, validateConnectorRequirements],
      [value.authorityRequests, validateAuthorityRequests],
      [value.metrics, validateMetrics],
      [value.playbooks, validatePlaybooks],
      [value.loops, validateLoops],
      [value.consoleSections, validateConsoleSections],
    ]
    for (const [entry, validator] of validators) {
      const error = validator(entry)
      if (error) return error
    }

    const eventError = isStringArray(value.eventSubscriptions, 'eventSubscriptions')
    if (eventError) return eventError
    const approvalError = validateApprovalPolicies(value.approvalPolicies)
    if (approvalError) return approvalError
    const healthError = isStringArray(value.healthChecks, 'healthChecks')
    if (healthError) return healthError

    if (!isRecord(value.retention)) return fail('invalid_object', 'retention')
    const retentionError = validateCanonicalRecord(value.retention, ['disablePreservesData', 'purgeRequiresOwner'], 'retention')
    if (retentionError) return retentionError
    if (value.retention.disablePreservesData !== true || value.retention.purgeRequiresOwner !== true) return fail('invalid_retention', 'retention')

    const manifest = value as unknown as AddonManifestV1
    const policies = new Set(manifest.approvalPolicies.map((policy) => policy.action))
    for (const [index, connector] of manifest.connectorRequirements.entries()) {
      if (connector.capability === 'write' && !policies.has(connector.slot)) {
        return fail('missing_approval_policy', `connectorRequirements[${index}].slot`)
      }
    }
    return { ok: true, manifest }
  } catch {
    return fail('invalid_manifest')
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  }
  return value
}

export function canonicalManifestJson(manifest: AddonManifestV1): string {
  return JSON.stringify(sortValue(manifest))
}

export async function manifestSha256(manifest: AddonManifestV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifestJson(manifest))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
