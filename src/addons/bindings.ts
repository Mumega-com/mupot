import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { resolveConnectorByIdWithMeta } from '../connectors/service'
import { manifestSha256, type AddonManifestV1 } from './contract'
import type { AddonInstallation } from './service'

export type AddonBindingKind = 'internal_adapter' | 'vault_connector'

export interface AddonBindingInput {
  slot: string
  adapter: string
  bindingKind: AddonBindingKind
  connectorId?: string
}

export interface AddonBinding {
  id: string
  tenant: string
  installationId: string
  slot: string
  adapter: string
  bindingKind: AddonBindingKind
  capability: 'read'
  connectorId: string | null
  manifestSha256: string
  configuredBy: string
  configuredAt: string
  revokedAt: string | null
}

export type AddonBindingFailureReason =
  | 'missing_required_slot'
  | 'unknown_slot'
  | 'adapter_not_allowed'
  | 'binding_kind_mismatch'
  | 'connector_not_available'
  | 'adapter_type_mismatch'
  | 'capability_mismatch'
  | 'manifest_digest_drift'

export type AddonBindingPreflight =
  | { ok: true; bindings: AddonBinding[] }
  | { ok: false; reason: AddonBindingFailureReason }

interface BindingRow {
  id: string
  tenant: string
  installation_id: string
  slot: string
  adapter: string
  binding_kind: AddonBindingKind
  capability: 'read'
  connector_id: string | null
  manifest_sha256: string
  configured_by: string
  configured_at: string
  revoked_at: string | null
}

export type ConfigureAddonBindingsResult =
  | { ok: false; reason: AddonBindingFailureReason }
  | {
      ok: true
      bindings: AddonBinding[]
      changed: boolean
      results: D1Result<unknown>[]
      bindingStatementCount: number
    }

export type AddonBindingConfigurationMatch =
  | { ok: false; reason: AddonBindingFailureReason }
  | { ok: true; matches: boolean }

const INTERNAL_ADAPTERS = new Set(['first_party'])

function bindingFromRow(row: BindingRow): AddonBinding {
  return {
    id: row.id,
    tenant: row.tenant,
    installationId: row.installation_id,
    slot: row.slot,
    adapter: row.adapter,
    bindingKind: row.binding_kind,
    capability: row.capability,
    connectorId: row.connector_id,
    manifestSha256: row.manifest_sha256,
    configuredBy: row.configured_by,
    configuredAt: row.configured_at,
    revokedAt: row.revoked_at,
  }
}

export async function listAddonBindings(env: Env, installationId: string): Promise<AddonBinding[]> {
  const result = await env.DB.prepare(`
    SELECT id, tenant, installation_id, slot, adapter, binding_kind, capability,
           connector_id, manifest_sha256, configured_by, configured_at, revoked_at
      FROM addon_connector_bindings
     WHERE tenant = ?1 AND installation_id = ?2 AND revoked_at IS NULL
     ORDER BY slot, id
  `).bind(env.TENANT_SLUG, installationId).all<BindingRow>()
  return (result.results ?? []).map(bindingFromRow)
}

function inputFromBinding(binding: AddonBinding): AddonBindingInput {
  return {
    slot: binding.slot,
    adapter: binding.adapter,
    bindingKind: binding.bindingKind,
    ...(binding.connectorId === null ? {} : { connectorId: binding.connectorId }),
  }
}

function sameConfiguration(bindings: AddonBinding[], inputs: AddonBindingInput[]): boolean {
  if (bindings.length !== inputs.length) return false
  return bindings.every((binding, index) => {
    const input = inputs[index]
    return binding.slot === input.slot
      && binding.adapter === input.adapter
      && binding.bindingKind === input.bindingKind
      && binding.connectorId === (input.connectorId ?? null)
  })
}

export async function addonBindingConfigurationMatches(
  env: Env,
  installation: AddonInstallation,
  manifest: AddonManifestV1,
  requestedBindings: readonly AddonBindingInput[],
): Promise<AddonBindingConfigurationMatch> {
  const preflight = await preflightAddonBindings(env, installation, manifest, requestedBindings)
  if (!preflight.ok) return preflight
  const current = await listAddonBindings(env, installation.id)
  return { ok: true, matches: sameConfiguration(current, preflight.bindings.map(inputFromBinding)) }
}

function validInput(value: unknown): value is AddonBindingInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.slot === 'string'
    && input.slot.length > 0
    && typeof input.adapter === 'string'
    && input.adapter.length > 0
    && (input.bindingKind === 'internal_adapter' || input.bindingKind === 'vault_connector')
    && (input.connectorId === undefined || (typeof input.connectorId === 'string' && input.connectorId.length > 0))
}

export async function preflightAddonBindings(
  env: Env,
  installation: AddonInstallation,
  manifest: AddonManifestV1,
  requestedBindings?: readonly AddonBindingInput[],
): Promise<AddonBindingPreflight> {
  if (manifest.connectorRequirements.some(({ capability }) => capability !== 'read')) {
    return { ok: false, reason: 'capability_mismatch' }
  }
  if (
    installation.tenant !== env.TENANT_SLUG
    || installation.addonKey !== manifest.key
    || installation.manifestSha256 !== await manifestSha256(manifest)
  ) {
    return { ok: false, reason: 'manifest_digest_drift' }
  }

  const persisted = requestedBindings === undefined
    ? await listAddonBindings(env, installation.id)
    : null
  const rawBindings: unknown = requestedBindings ?? persisted?.map(inputFromBinding) ?? []
  if (!Array.isArray(rawBindings) || !rawBindings.every(validInput)) {
    return { ok: false, reason: 'binding_kind_mismatch' }
  }
  const bindings = [...rawBindings].sort((left, right) => left.slot.localeCompare(right.slot))
  if (new Set(bindings.map(({ slot }) => slot)).size !== bindings.length) {
    return { ok: false, reason: 'unknown_slot' }
  }

  const requirements = new Map(manifest.connectorRequirements.map((requirement) => [requirement.slot, requirement]))
  for (const binding of bindings) {
    if (!requirements.has(binding.slot)) return { ok: false, reason: 'unknown_slot' }
  }
  for (const requirement of manifest.connectorRequirements) {
    if (requirement.required && !bindings.some(({ slot }) => slot === requirement.slot)) {
      return { ok: false, reason: 'missing_required_slot' }
    }
  }

  const normalized: AddonBinding[] = []
  for (const input of bindings) {
    const requirement = requirements.get(input.slot)
    if (!requirement) return { ok: false, reason: 'unknown_slot' }
    if (!requirement.accepts.includes(input.adapter)) return { ok: false, reason: 'adapter_not_allowed' }
    if (requirement.bindingKind !== 'either' && requirement.bindingKind !== input.bindingKind) {
      return { ok: false, reason: 'binding_kind_mismatch' }
    }

    let connectorId: string | null = null
    if (input.bindingKind === 'internal_adapter') {
      if (input.connectorId !== undefined) return { ok: false, reason: 'binding_kind_mismatch' }
      if (!INTERNAL_ADAPTERS.has(input.adapter)) return { ok: false, reason: 'adapter_not_allowed' }
    } else {
      if (!input.connectorId) return { ok: false, reason: 'binding_kind_mismatch' }
      const connector = await resolveConnectorByIdWithMeta(env, input.connectorId)
      if (!connector) return { ok: false, reason: 'connector_not_available' }
      if (connector.type !== input.adapter) return { ok: false, reason: 'adapter_type_mismatch' }
      connectorId = connector.id
    }

    const existing = persisted?.find(({ slot }) => slot === input.slot)
    normalized.push(existing ?? {
      id: '',
      tenant: env.TENANT_SLUG,
      installationId: installation.id,
      slot: input.slot,
      adapter: input.adapter,
      bindingKind: input.bindingKind,
      capability: 'read',
      connectorId,
      manifestSha256: installation.manifestSha256,
      configuredBy: '',
      configuredAt: '',
      revokedAt: null,
    })
  }
  return { ok: true, bindings: normalized }
}

export async function configureAddonBindings(
  env: Env,
  installation: AddonInstallation,
  manifest: AddonManifestV1,
  actorId: string,
  requestedBindings: readonly AddonBindingInput[],
  lifecycleStatements: D1PreparedStatement[] = [],
  runLifecycleWhenUnchanged = false,
): Promise<ConfigureAddonBindingsResult> {
  const preflight = await preflightAddonBindings(env, installation, manifest, requestedBindings)
  if (!preflight.ok) return preflight

  const current = await listAddonBindings(env, installation.id)
  const inputs = preflight.bindings.map(inputFromBinding)
  if (sameConfiguration(current, inputs)) {
    const results = runLifecycleWhenUnchanged
      ? await env.DB.batch(lifecycleStatements) as D1Result<unknown>[]
      : []
    return { ok: true, bindings: current, changed: false, results, bindingStatementCount: 0 }
  }

  const configuredAt = new Date().toISOString()
  const bindings = preflight.bindings.map((binding) => ({
    ...binding,
    id: crypto.randomUUID(),
    configuredBy: actorId,
    configuredAt,
  }))
  const statements: D1PreparedStatement[] = []
  if (current.length > 0) {
    statements.push(env.DB.prepare(`
      UPDATE addon_connector_bindings
         SET revoked_at = ?1
       WHERE tenant = ?2 AND installation_id = ?3 AND revoked_at IS NULL
    `).bind(configuredAt, env.TENANT_SLUG, installation.id))
  }
  for (const binding of bindings) {
    statements.push(env.DB.prepare(`
      INSERT INTO addon_connector_bindings (
        id, tenant, installation_id, slot, adapter, binding_kind, capability,
        connector_id, manifest_sha256, configured_by, configured_at, revoked_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'read', ?7, ?8, ?9, ?10, NULL)
    `).bind(
      binding.id,
      binding.tenant,
      binding.installationId,
      binding.slot,
      binding.adapter,
      binding.bindingKind,
      binding.connectorId,
      binding.manifestSha256,
      binding.configuredBy,
      binding.configuredAt,
    ))
  }
  const bindingStatementCount = statements.length
  const results = await env.DB.batch([...statements, ...lifecycleStatements]) as D1Result<unknown>[]
  return { ok: true, bindings, changed: true, results, bindingStatementCount }
}
