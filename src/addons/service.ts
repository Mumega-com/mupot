import type { Env } from '../types'
import './modules/fixture'
import { getRegisteredAddon, type AddonCatalogEntry } from './registry'

export type AddonState = 'installed' | 'configured' | 'active' | 'disabled' | 'archived'

export interface AddonInstallation {
  id: string
  tenant: string
  addonKey: string
  installedVersion: string
  publisher: string
  trustClass: 'native_reviewed'
  manifestSha256: string
  mupotCompatibility: string
  state: AddonState
  latestPreviousState: AddonState | null
  installedBy: string
  latestActorId: string
  latestReceiptId: string
  installedAt: string
  configuredAt: string | null
  activatedAt: string | null
  disabledAt: string | null
  archivedAt: string | null
  updatedAt: string
  lastError: string | null
}

export interface AddonReceipt {
  id: string
  tenant: string
  installationId: string
  action: string
  previousState: AddonState | null
  nextState: AddonState | null
  addonKey: string
  installedVersion: string
  publisher: string
  trustClass: 'native_reviewed'
  mupotCompatibility: string
  manifestSha256: string
  actorId: string
  outcome: 'pass' | 'fail'
  sideEffectIds: string[]
  checks: Record<string, unknown>
  errorCode: string | null
  createdAt: string
}

export interface AddonActor {
  id: string
  role: 'owner' | 'admin' | 'member'
}

export type AddonFailureReason =
  | 'addon_not_registered'
  | 'manifest_digest_drift'
  | 'invalid_state'
  | 'write_failed'
  | 'not_authorized'

export type AddonMutationResult =
  | { ok: true; state: AddonState; installation: AddonInstallation; created: true; idempotent?: never }
  | { ok: true; state: AddonState; installation: AddonInstallation; idempotent: true; created?: never }
  | { ok: true; state: AddonState; installation: AddonInstallation; created?: never; idempotent?: never }
  | { ok: false; reason: AddonFailureReason; state?: AddonState }

interface InstallationRow {
  id: string
  tenant: string
  addon_key: string
  installed_version: string
  publisher: string
  trust_class: 'native_reviewed'
  manifest_sha256: string
  mupot_compatibility: string
  state: AddonState
  latest_previous_state: AddonState | null
  installed_by: string
  latest_actor_id: string
  latest_receipt_id: string
  installed_at: string
  configured_at: string | null
  activated_at: string | null
  disabled_at: string | null
  archived_at: string | null
  updated_at: string
  last_error: string | null
}

interface ReceiptRow {
  id: string
  tenant: string
  installation_id: string
  action: string
  previous_state: AddonState | null
  next_state: AddonState | null
  addon_key: string
  installed_version: string
  publisher: string
  trust_class: 'native_reviewed'
  mupot_compatibility: string
  manifest_sha256: string
  actor_id: string
  outcome: 'pass' | 'fail'
  side_effect_ids: string
  checks: string
  error_code: string | null
  created_at: string
}

const INSTALLATION_COLUMNS = `
  id, tenant, addon_key, installed_version, publisher, trust_class,
  manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
  latest_actor_id, latest_receipt_id, installed_at, configured_at,
  activated_at, disabled_at, archived_at, updated_at, last_error
`

function installationFromRow(row: InstallationRow): AddonInstallation {
  return {
    id: row.id,
    tenant: row.tenant,
    addonKey: row.addon_key,
    installedVersion: row.installed_version,
    publisher: row.publisher,
    trustClass: row.trust_class,
    manifestSha256: row.manifest_sha256,
    mupotCompatibility: row.mupot_compatibility,
    state: row.state,
    latestPreviousState: row.latest_previous_state,
    installedBy: row.installed_by,
    latestActorId: row.latest_actor_id,
    latestReceiptId: row.latest_receipt_id,
    installedAt: row.installed_at,
    configuredAt: row.configured_at,
    activatedAt: row.activated_at,
    disabledAt: row.disabled_at,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  }
}

function parseStringArray(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('invalid addon receipt JSON')
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('invalid addon receipt JSON')
  }
  return parsed
}

function parseChecks(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('invalid addon receipt JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid addon receipt JSON')
  }
  return parsed as Record<string, unknown>
}

function receiptFromRow(row: ReceiptRow): AddonReceipt {
  return {
    id: row.id,
    tenant: row.tenant,
    installationId: row.installation_id,
    action: row.action,
    previousState: row.previous_state,
    nextState: row.next_state,
    addonKey: row.addon_key,
    installedVersion: row.installed_version,
    publisher: row.publisher,
    trustClass: row.trust_class,
    mupotCompatibility: row.mupot_compatibility,
    manifestSha256: row.manifest_sha256,
    actorId: row.actor_id,
    outcome: row.outcome,
    sideEffectIds: parseStringArray(row.side_effect_ids),
    checks: parseChecks(row.checks),
    errorCode: row.error_code,
    createdAt: row.created_at,
  }
}

function authorized(actor: AddonActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

function isZeroAuthority(entry: AddonCatalogEntry): boolean {
  return entry.manifest.connectorRequirements.length === 0
    && entry.manifest.authorityRequests.rankGrants.length === 0
    && entry.manifest.authorityRequests.surfaceGrants.length === 0
}

function matchesRegisteredIdentity(installation: AddonInstallation, entry: AddonCatalogEntry): boolean {
  return installation.addonKey === entry.manifest.key
    && installation.installedVersion === entry.manifest.version
    && installation.publisher === entry.manifest.publisher
    && installation.trustClass === entry.manifest.trustClass
    && installation.manifestSha256 === entry.manifestSha256
    && installation.mupotCompatibility === entry.manifest.mupotCompatibility
}

function written(result: { success: boolean; meta?: { changes?: number } }): boolean {
  return result.success && result.meta?.changes === 1
}

async function loadLiveInstallation(env: Env, key: string): Promise<AddonInstallation | null> {
  const row = await env.DB.prepare(`
    SELECT ${INSTALLATION_COLUMNS}
      FROM addon_installations
     WHERE tenant = ?1 AND addon_key = ?2
       AND state <> 'archived'
     ORDER BY installed_at DESC, id DESC
     LIMIT 1
  `).bind(env.TENANT_SLUG, key).first<InstallationRow>()
  return row ? installationFromRow(row) : null
}

export async function listAddonInstallations(env: Env): Promise<AddonInstallation[]> {
  const result = await env.DB.prepare(`
    SELECT ${INSTALLATION_COLUMNS}
      FROM addon_installations
     WHERE tenant = ?1
     ORDER BY installed_at ASC, id ASC
  `).bind(env.TENANT_SLUG).all<InstallationRow>()
  return (result.results ?? []).map(installationFromRow)
}

export async function getAddonReceipts(env: Env, installationId: string): Promise<AddonReceipt[]> {
  const result = await env.DB.prepare(`
    SELECT id, tenant, installation_id, action, previous_state, next_state,
           addon_key, installed_version, publisher, trust_class,
           mupot_compatibility, manifest_sha256, actor_id, outcome,
           side_effect_ids, checks, error_code, created_at
      FROM addon_receipts
     WHERE tenant = ?1 AND installation_id = ?2
     ORDER BY created_at DESC, id DESC
  `).bind(env.TENANT_SLUG, installationId).all<ReceiptRow>()
  return (result.results ?? []).map(receiptFromRow)
}

export async function installAddon(env: Env, actor: AddonActor, key: string): Promise<AddonMutationResult> {
  if (!authorized(actor)) return { ok: false, reason: 'not_authorized' }

  const entry = getRegisteredAddon(key)
  if (!entry) return { ok: false, reason: 'addon_not_registered' }
  if (entry.manifest.kind !== 'native' || entry.manifest.trustClass !== 'native_reviewed') {
    return { ok: false, reason: 'invalid_state' }
  }

  const existing = await loadLiveInstallation(env, key)
  if (existing) {
    if (!matchesRegisteredIdentity(existing, entry)) {
      return { ok: false, reason: 'manifest_digest_drift' }
    }
    return { ok: true, state: existing.state, installation: existing, idempotent: true }
  }

  const installationId = crypto.randomUUID()
  const receiptId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const checks = JSON.stringify({ manifestDigest: 'matched', inert: true })

  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO addon_installations (
          id, tenant, addon_key, installed_version, publisher, trust_class,
          manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
          latest_actor_id, latest_receipt_id, installed_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'installed', NULL, ?9, ?9, ?10, ?11, ?11)
      `).bind(
        installationId,
        env.TENANT_SLUG,
        entry.manifest.key,
        entry.manifest.version,
        entry.manifest.publisher,
        entry.manifest.trustClass,
        entry.manifestSha256,
        entry.manifest.mupotCompatibility,
        actor.id,
        receiptId,
        createdAt,
      ),
      env.DB.prepare(`
        INSERT INTO addon_receipts (
          id, tenant, installation_id, action, previous_state, next_state,
          addon_key, installed_version, publisher, trust_class,
          mupot_compatibility, manifest_sha256, actor_id, outcome,
          side_effect_ids, checks, created_at
        ) VALUES (
          ?1, ?2, ?3, 'install', NULL, 'installed', ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, 'pass', '[]', ?11, ?12
        )
      `).bind(
        receiptId,
        env.TENANT_SLUG,
        installationId,
        entry.manifest.key,
        entry.manifest.version,
        entry.manifest.publisher,
        entry.manifest.trustClass,
        entry.manifest.mupotCompatibility,
        entry.manifestSha256,
        actor.id,
        checks,
        createdAt,
      ),
    ])

    if (!written(results[0]) || !written(results[1])) return { ok: false, reason: 'write_failed' }
  } catch {
    const raced = await loadLiveInstallation(env, key)
    if (!raced) return { ok: false, reason: 'write_failed' }
    if (!matchesRegisteredIdentity(raced, entry)) {
      return { ok: false, reason: 'manifest_digest_drift' }
    }
    return { ok: true, state: raced.state, installation: raced, idempotent: true }
  }

  const installation = await loadLiveInstallation(env, key)
  if (!installation) return { ok: false, reason: 'write_failed' }
  return { ok: true, state: installation.state, installation, created: true }
}

export async function configureAddon(env: Env, actor: AddonActor, key: string): Promise<AddonMutationResult> {
  if (!authorized(actor)) return { ok: false, reason: 'not_authorized' }

  const entry = getRegisteredAddon(key)
  if (!entry) return { ok: false, reason: 'addon_not_registered' }

  const existing = await loadLiveInstallation(env, key)
  if (!existing) return { ok: false, reason: 'invalid_state' }
  if (!matchesRegisteredIdentity(existing, entry)) {
    return { ok: false, reason: 'manifest_digest_drift' }
  }
  if (existing.state === 'configured') {
    return { ok: true, state: existing.state, installation: existing, idempotent: true }
  }
  if (existing.state !== 'installed' || !isZeroAuthority(entry)) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  const receiptId = crypto.randomUUID()
  const configuredAt = new Date().toISOString()
  const checks = JSON.stringify({ connectorRequirements: 'empty', authorityRequests: 'empty' })

  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', configured_at = ?1, updated_at = ?1,
               latest_previous_state = 'installed',
               latest_actor_id = ?2, latest_receipt_id = ?3, last_error = NULL
         WHERE id = ?4 AND tenant = ?5 AND addon_key = ?6
           AND state = 'installed' AND manifest_sha256 = ?7
      `).bind(configuredAt, actor.id, receiptId, existing.id, env.TENANT_SLUG, key, entry.manifestSha256),
      env.DB.prepare(`
        INSERT INTO addon_receipts (
          id, tenant, installation_id, action, previous_state, next_state,
          addon_key, installed_version, publisher, trust_class,
          mupot_compatibility, manifest_sha256, actor_id, outcome,
          side_effect_ids, checks, created_at
        )
        VALUES (
          ?1, ?2, ?3, 'configure', 'installed', 'configured',
          ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pass', '[]', ?11, ?12
        )
      `).bind(
        receiptId,
        env.TENANT_SLUG,
        existing.id,
        existing.addonKey,
        existing.installedVersion,
        existing.publisher,
        existing.trustClass,
        existing.mupotCompatibility,
        existing.manifestSha256,
        actor.id,
        checks,
        configuredAt,
      ),
    ])

    if (written(results[0]) && written(results[1])) {
      const configured = await loadLiveInstallation(env, key)
      return configured
        ? { ok: true, state: configured.state, installation: configured }
        : { ok: false, reason: 'write_failed' }
    }
  } catch {
    const current = await loadLiveInstallation(env, key)
    if (!current) return { ok: false, reason: 'write_failed' }
    if (!matchesRegisteredIdentity(current, entry)) {
      return { ok: false, reason: 'manifest_digest_drift' }
    }
    if (current.state === 'installed') return { ok: false, reason: 'write_failed' }
    if (current.state === 'configured') {
      return { ok: true, state: current.state, installation: current, idempotent: true }
    }
    return { ok: false, reason: 'invalid_state', state: current.state }
  }

  const current = await loadLiveInstallation(env, key)
  if (!current) return { ok: false, reason: 'write_failed' }
  if (!matchesRegisteredIdentity(current, entry)) {
    return { ok: false, reason: 'manifest_digest_drift' }
  }
  if (current.state === 'configured') {
    return { ok: true, state: current.state, installation: current, idempotent: true }
  }
  return { ok: false, reason: 'invalid_state', state: current.state }
}
