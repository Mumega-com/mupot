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

// validateBindingInputs — the ONE shallow, request-shape validator for a caller-supplied
// bindings array, shared by every entry point that accepts one (the dashboard HTTP route's
// parseConfigureBody in src/addons/routes.ts AND the addon_configure MCP tool in
// src/mcp/addons.ts). Deliberately shallow: field types, the allowed-key allowlist, no
// duplicate slots WITHIN the request, and a bound on array length. The deep semantic checks
// (does the slot exist on the manifest? is the adapter allowed? does the connector resolve?)
// live inside configureAddon → preflightAddonBindings below — this function's job is only to
// turn `unknown` into a well-shaped AddonBindingInput[] or reject, identically for every
// caller. A single implementation means the HTTP route and the MCP tool can never drift into
// accepting different shapes for the same underlying mutation.
export function validateBindingInputs(
  raw: unknown[],
  maximumBindings: number,
): { ok: true; bindings: AddonBindingInput[] } | { ok: false } {
  if (raw.length > Math.min(maximumBindings, 16)) return { ok: false }

  const bindings: AddonBindingInput[] = []
  const slots = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
    const binding = value as Record<string, unknown>
    const keys = Object.keys(binding)
    if (keys.some((key) => !['slot', 'adapter', 'bindingKind', 'connectorId'].includes(key))) return { ok: false }
    if (
      typeof binding.slot !== 'string'
      || binding.slot.length === 0
      || typeof binding.adapter !== 'string'
      || binding.adapter.length === 0
      || (binding.bindingKind !== 'internal_adapter' && binding.bindingKind !== 'vault_connector')
      || (Object.hasOwn(binding, 'connectorId') && (
        typeof binding.connectorId !== 'string' || binding.connectorId.length === 0
      ))
      || slots.has(binding.slot)
    ) {
      return { ok: false }
    }
    slots.add(binding.slot)
    bindings.push({
      slot: binding.slot,
      adapter: binding.adapter,
      bindingKind: binding.bindingKind,
      ...(typeof binding.connectorId === 'string' ? { connectorId: binding.connectorId } : {}),
    })
  }
  return { ok: true, bindings }
}

export interface AddonBinding {
  id: string
  tenant: string
  installationId: string
  generationId: string
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
  | { ok: true; bindings: AddonBinding[]; generation: AddonBindingGeneration | null }
  | { ok: false; reason: AddonBindingFailureReason }

export interface AddonBindingGeneration {
  id: string
  tenant: string
  installationId: string
  configurationSha256: string
  bindingCount: number
  manifestSha256: string
  configuredBy: string
  configuredAt: string
  revokedAt: string | null
  previousGenerationId: string | null
  expectedInstallationState: 'installed' | 'configured' | 'disabled'
  baseReceiptId: string
}

interface GenerationRow {
  id: string
  tenant: string
  installation_id: string
  configuration_sha256: string
  binding_count: number
  manifest_sha256: string
  configured_by: string
  configured_at: string
  revoked_at: string | null
  previous_generation_id: string | null
  expected_installation_state: 'installed' | 'configured' | 'disabled'
  base_receipt_id: string
}

interface BindingRow {
  id: string
  tenant: string
  installation_id: string
  generation_id: string
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
      initializedGeneration: boolean
    }

export type AddonBindingConfigurationMatch =
  | { ok: false; reason: AddonBindingFailureReason }
  | { ok: true; matches: boolean }

// Adapter names allowed to bind as bindingKind 'internal_adapter' (no vault connector row).
// 'posthog' is dual-mode (see MARKETING_MONITOR_BINDING_CONTRACT's 'either' rule for
// web_analytics): a tenant can bind it to a real per-tenant vault connector (unaffected,
// not listed here as internal) OR, with no connector, to the Worker's own env-level
// PostHog credentials — the pot's own dogfood tenant path (src/cro/posthog.ts /
// src/addons/marketing/adapters/posthog.ts). Adding an adapter name here only widens WHO
// may bind it without a connector; the manifest's per-slot connectorRequirements still
// gates which adapters are accepted at all.
const INTERNAL_ADAPTERS = new Set(['first_party', 'posthog'])

function bindingFromRow(row: BindingRow): AddonBinding {
  return {
    id: row.id,
    tenant: row.tenant,
    installationId: row.installation_id,
    generationId: row.generation_id,
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

function generationFromRow(row: GenerationRow): AddonBindingGeneration {
  return {
    id: row.id,
    tenant: row.tenant,
    installationId: row.installation_id,
    configurationSha256: row.configuration_sha256,
    bindingCount: row.binding_count,
    manifestSha256: row.manifest_sha256,
    configuredBy: row.configured_by,
    configuredAt: row.configured_at,
    revokedAt: row.revoked_at,
    previousGenerationId: row.previous_generation_id,
    expectedInstallationState: row.expected_installation_state,
    baseReceiptId: row.base_receipt_id,
  }
}

export async function loadLiveAddonBindingGeneration(
  env: Env,
  installationId: string,
): Promise<AddonBindingGeneration | null> {
  const row = await env.DB.prepare(`
    SELECT id, tenant, installation_id, configuration_sha256, binding_count,
           manifest_sha256, configured_by, configured_at, revoked_at,
           previous_generation_id, expected_installation_state, base_receipt_id
      FROM addon_binding_generations
     WHERE tenant = ?1 AND installation_id = ?2 AND revoked_at IS NULL
     LIMIT 1
  `).bind(env.TENANT_SLUG, installationId).first<GenerationRow>()
  return row ? generationFromRow(row) : null
}

export async function listAddonBindings(env: Env, installationId: string): Promise<AddonBinding[]> {
  const result = await env.DB.prepare(`
    SELECT binding.id, binding.tenant, binding.installation_id, binding.generation_id,
           binding.slot, binding.adapter, binding.binding_kind, binding.capability,
           binding.connector_id, binding.manifest_sha256, binding.configured_by,
           binding.configured_at, binding.revoked_at
      FROM addon_connector_bindings AS binding
      JOIN addon_binding_generations AS generation
        ON generation.id = binding.generation_id
       AND generation.installation_id = binding.installation_id
       AND generation.tenant = binding.tenant
       AND generation.revoked_at IS NULL
     WHERE binding.tenant = ?1 AND binding.installation_id = ?2
       AND binding.revoked_at IS NULL
     ORDER BY binding.slot, binding.id
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
  const generation = await loadLiveAddonBindingGeneration(env, installation.id)
  if (!generation) return { ok: true, matches: false }
  const current = await listAddonBindings(env, installation.id)
  const inputs = preflight.bindings.map(inputFromBinding)
  return {
    ok: true,
    matches: generation.configurationSha256 === await configurationSha256(inputs)
      && generation.bindingCount === inputs.length
      && sameConfiguration(current, inputs),
  }
}

async function configurationSha256(inputs: readonly AddonBindingInput[]): Promise<string> {
  const normalized = inputs.map((input) => ({
    slot: input.slot,
    adapter: input.adapter,
    bindingKind: input.bindingKind,
    connectorId: input.connectorId ?? null,
  }))
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(normalized)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
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

  const generation = requestedBindings === undefined
    ? await loadLiveAddonBindingGeneration(env, installation.id)
    : null
  if (requestedBindings === undefined && !generation) {
    throw new Error('addon binding generation is missing')
  }
  const persisted = requestedBindings === undefined
    ? await listAddonBindings(env, installation.id)
    : null
  if (generation && persisted && generation.bindingCount !== persisted.length) {
    throw new Error('addon binding generation count mismatch')
  }
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
      generationId: generation?.id ?? '',
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
  return { ok: true, bindings: normalized, generation }
}

export async function configureAddonBindings(
  env: Env,
  installation: AddonInstallation,
  manifest: AddonManifestV1,
  actorId: string,
  requestedBindings: readonly AddonBindingInput[],
  configuredAt: string,
  lifecycleStatements: D1PreparedStatement[] = [],
  runLifecycleWhenUnchanged = false,
): Promise<ConfigureAddonBindingsResult> {
  const preflight = await preflightAddonBindings(env, installation, manifest, requestedBindings)
  if (!preflight.ok) return preflight

  const current = await listAddonBindings(env, installation.id)
  const inputs = preflight.bindings.map(inputFromBinding)
  const currentGeneration = await loadLiveAddonBindingGeneration(env, installation.id)
  const desiredConfigurationSha256 = await configurationSha256(inputs)
  if (
    currentGeneration
    && currentGeneration.configurationSha256 === desiredConfigurationSha256
    && currentGeneration.bindingCount === inputs.length
    && sameConfiguration(current, inputs)
  ) {
    const results = runLifecycleWhenUnchanged
      ? await env.DB.batch(lifecycleStatements) as D1Result<unknown>[]
      : []
    return {
      ok: true,
      bindings: current,
      changed: false,
      results,
      bindingStatementCount: 0,
      initializedGeneration: false,
    }
  }

  const generationId = crypto.randomUUID()
  const bindings = preflight.bindings.map((binding) => ({
    ...binding,
    id: crypto.randomUUID(),
    generationId,
    configuredBy: actorId,
    configuredAt,
  }))
  const statements: D1PreparedStatement[] = []
  if (currentGeneration) {
    statements.push(env.DB.prepare(`
      UPDATE addon_binding_generations
         SET revoked_at = ?1
       WHERE id = ?2 AND tenant = ?3 AND installation_id = ?4 AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM addon_installations AS installation
            WHERE installation.id = ?4 AND installation.tenant = ?3
              AND installation.state = ?5 AND installation.latest_receipt_id = ?6
         )
    `).bind(
      configuredAt,
      currentGeneration.id,
      env.TENANT_SLUG,
      installation.id,
      installation.state,
      installation.latestReceiptId,
    ))
    statements.push(env.DB.prepare(`
      UPDATE addon_connector_bindings
         SET revoked_at = ?1
       WHERE tenant = ?2 AND installation_id = ?3 AND generation_id = ?4
         AND revoked_at IS NULL
    `).bind(configuredAt, env.TENANT_SLUG, installation.id, currentGeneration.id))
  }
  statements.push(env.DB.prepare(`
    INSERT INTO addon_binding_generations (
      id, tenant, installation_id, configuration_sha256, binding_count,
      manifest_sha256, configured_by, configured_at, revoked_at,
      previous_generation_id, expected_installation_state, base_receipt_id
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11)
  `).bind(
    generationId,
    env.TENANT_SLUG,
    installation.id,
    desiredConfigurationSha256,
    bindings.length,
    installation.manifestSha256,
    actorId,
    configuredAt,
    currentGeneration?.id ?? null,
    installation.state,
    installation.latestReceiptId,
  ))
  for (const binding of bindings) {
    statements.push(env.DB.prepare(`
      INSERT INTO addon_connector_bindings (
        id, tenant, installation_id, generation_id, slot, adapter, binding_kind, capability,
        connector_id, manifest_sha256, configured_by, configured_at, revoked_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'read', ?8, ?9, ?10, ?11, NULL)
    `).bind(
      binding.id,
      binding.tenant,
      binding.installationId,
      binding.generationId,
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
  return {
    ok: true,
    bindings,
    changed: true,
    results,
    bindingStatementCount,
    initializedGeneration: currentGeneration === null,
  }
}
