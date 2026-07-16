import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../types'
import {
  activate as activateDepartment,
  deactivate as deactivateDepartment,
} from '../departments/registry'
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
  sequence: number
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

export interface AddonDepartmentLifecycleEvent {
  installationId: string
  operationId: string
  moduleKey: string
  departmentId: string
}

export interface AddonOwnershipLifecycleEvent extends AddonDepartmentLifecycleEvent {
  claimId: string
}

export interface AddonLifecycleDeps {
  activateDepartment?: typeof activateDepartment
  deactivateDepartment?: typeof deactivateDepartment
  afterDepartmentActivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  afterInstallationDisabled?: (event: {
    installationId: string
    operationId: string
  }) => void | Promise<void>
  beforeDepartmentDeactivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  afterDepartmentDeactivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  beforeOwnershipReleased?: (event: AddonOwnershipLifecycleEvent) => void | Promise<void>
  afterOwnershipReleased?: (event: AddonOwnershipLifecycleEvent) => void | Promise<void>
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

type AddonMutationFailure = Extract<AddonMutationResult, { ok: false }>

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
  sequence: number
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

type OperationAction = 'activate' | 'disable' | 'archive'
type OperationTargetState = 'active' | 'disabled' | 'archived'

interface OperationRow {
  id: string
  tenant: string
  installation_id: string
  action: OperationAction
  target_state: OperationTargetState
  current_step: string
  status: 'running' | 'completed' | 'failed' | 'compensated'
  actor_id: string
  lease_expires_at: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}

interface OwnershipRow {
  id: string
  tenant: string
  installation_id: string
  resource_type: string
  resource_id: string
  resource_key: string
  ownership_mode: 'exclusive' | 'co_owner'
  active: 0 | 1
  created_at: string
  released_at: string | null
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
    sequence: row.sequence,
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

function selectedInstallation(
  result: { success: boolean; results?: InstallationRow[] } | undefined,
): AddonInstallation | null {
  if (!result?.success) return null
  const row = result.results?.[0]
  return row ? installationFromRow(row) : null
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

async function loadInstallationById(env: Env, installationId: string): Promise<AddonInstallation | null> {
  const row = await env.DB.prepare(`
    SELECT ${INSTALLATION_COLUMNS}
      FROM addon_installations
     WHERE tenant = ?1 AND id = ?2
     LIMIT 1
  `).bind(env.TENANT_SLUG, installationId).first<InstallationRow>()
  return row ? installationFromRow(row) : null
}

async function loadLifecycleMutationContext(
  env: Env,
  actor: AddonActor,
  key: string,
): Promise<
  | { ok: true; entry: AddonCatalogEntry; installation: AddonInstallation }
  | { ok: false; result: AddonMutationFailure }
> {
  if (!authorized(actor)) {
    return { ok: false, result: { ok: false, reason: 'not_authorized' } }
  }

  const entry = getRegisteredAddon(key)
  if (!entry) {
    return { ok: false, result: { ok: false, reason: 'addon_not_registered' } }
  }

  const installation = await loadLiveInstallation(env, key)
  if (!installation) {
    return { ok: false, result: { ok: false, reason: 'invalid_state' } }
  }
  if (!matchesRegisteredIdentity(installation, entry)) {
    return { ok: false, result: { ok: false, reason: 'manifest_digest_drift' } }
  }

  return { ok: true, entry, installation }
}

async function loadRunningOperation(env: Env, installationId: string): Promise<OperationRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE tenant = ?1 AND installation_id = ?2 AND status = 'running'
     LIMIT 1
  `).bind(env.TENANT_SLUG, installationId).first<OperationRow>()
}

async function beginOrResumeOperation(
  env: Env,
  installationId: string,
  actorId: string,
  action: OperationAction,
  targetState: OperationTargetState,
  initialStep: string,
): Promise<OperationRow | null> {
  const running = await loadRunningOperation(env, installationId)
  if (running) {
    return running.action === action && running.target_state === targetState ? running : null
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  try {
    const result = await env.DB.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step,
        status, actor_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?8)
    `).bind(
      id,
      env.TENANT_SLUG,
      installationId,
      action,
      targetState,
      initialStep,
      actorId,
      createdAt,
    ).run()

    if (written(result)) {
      return {
        id,
        tenant: env.TENANT_SLUG,
        installation_id: installationId,
        action,
        target_state: targetState,
        current_step: initialStep,
        status: 'running',
        actor_id: actorId,
        lease_expires_at: null,
        error_code: null,
        created_at: createdAt,
        updated_at: createdAt,
      }
    }
  } catch {
    // A concurrent caller may have won the one-running-operation constraint.
  }

  const raced = await loadRunningOperation(env, installationId)
  return raced?.action === action && raced.target_state === targetState ? raced : null
}

function operationStepStatement(
  env: Env,
  operation: OperationRow,
  step: string,
  updatedAt: string,
  status: 'running' | 'completed' = 'running',
): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE addon_operations
       SET current_step = ?1, status = ?2, updated_at = ?3, error_code = NULL
     WHERE id = ?4 AND tenant = ?5 AND installation_id = ?6
       AND action = ?7 AND target_state = ?8 AND status = 'running'
  `).bind(
    step,
    status,
    updatedAt,
    operation.id,
    env.TENANT_SLUG,
    operation.installation_id,
    operation.action,
    operation.target_state,
  )
}

async function setOperationStep(env: Env, operation: OperationRow, step: string): Promise<void> {
  const updatedAt = new Date().toISOString()
  await operationStepStatement(env, operation, step, updatedAt).run()
}

function transitionReceiptStatement(
  env: Env,
  installation: AddonInstallation,
  operation: OperationRow,
  receipt: {
    id: string
    action: OperationAction
    previousState: AddonState
    nextState: AddonState
    sideEffectIds: string
    checks: string
    createdAt: string
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO addon_receipts (
      id, tenant, installation_id, action, previous_state, next_state,
      addon_key, installed_version, publisher, trust_class,
      mupot_compatibility, manifest_sha256, actor_id, outcome,
      side_effect_ids, checks, created_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
      ?11, ?12, ?13, 'pass', ?14, ?15, ?16
    )
  `).bind(
    receipt.id,
    env.TENANT_SLUG,
    installation.id,
    receipt.action,
    receipt.previousState,
    receipt.nextState,
    installation.addonKey,
    installation.installedVersion,
    installation.publisher,
    installation.trustClass,
    installation.mupotCompatibility,
    installation.manifestSha256,
    operation.actor_id,
    receipt.sideEffectIds,
    receipt.checks,
    receipt.createdAt,
  )
}

function selectTransitionStatement(
  env: Env,
  installationId: string,
  operation: OperationRow,
  previousState: AddonState,
  nextState: AddonState,
  receiptId: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    SELECT ${INSTALLATION_COLUMNS}
      FROM addon_installations
     WHERE id = ?1 AND tenant = ?2 AND state = ?3
       AND latest_previous_state = ?4 AND latest_actor_id = ?5
       AND latest_receipt_id = ?6
     LIMIT 1
  `).bind(
    installationId,
    env.TENANT_SLUG,
    nextState,
    previousState,
    operation.actor_id,
    receiptId,
  )
}

async function loadDepartmentClaims(
  env: Env,
  installationId: string,
  activeOnly = false,
): Promise<OwnershipRow[]> {
  const activePredicate = activeOnly ? 'AND active = 1' : ''
  const result = await env.DB.prepare(`
    SELECT id, tenant, installation_id, resource_type, resource_id,
           resource_key, ownership_mode, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE tenant = ?1 AND installation_id = ?2 AND resource_type = 'department'
       ${activePredicate}
     ORDER BY resource_key ASC, id ASC
  `).bind(env.TENANT_SLUG, installationId).all<OwnershipRow>()
  return result.results ?? []
}

async function loadDepartmentClaim(
  env: Env,
  installationId: string,
  moduleKey: string,
): Promise<OwnershipRow | null> {
  const result = await env.DB.prepare(`
    SELECT id, tenant, installation_id, resource_type, resource_id,
           resource_key, ownership_mode, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE tenant = ?1 AND installation_id = ?2
       AND resource_type = 'department' AND resource_key = ?3
     ORDER BY id ASC
  `).bind(env.TENANT_SLUG, installationId, moduleKey).all<OwnershipRow>()
  const rows = result.results ?? []
  if (rows.length > 1) throw new Error('duplicate addon department ownership')
  return rows[0] ?? null
}

async function loadOwnershipClaimById(
  env: Env,
  installationId: string,
  claimId: string,
): Promise<OwnershipRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, installation_id, resource_type, resource_id,
           resource_key, ownership_mode, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND resource_type = 'department'
     LIMIT 1
  `).bind(claimId, env.TENANT_SLUG, installationId).first<OwnershipRow>()
}

async function countOtherActiveClaims(
  env: Env,
  claim: OwnershipRow,
): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
      FROM addon_resource_ownership
     WHERE tenant = ?1 AND resource_type = ?2 AND resource_id = ?3
       AND installation_id <> ?4 AND active = 1
  `).bind(
    env.TENANT_SLUG,
    claim.resource_type,
    claim.resource_id,
    claim.installation_id,
  ).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function activateRegisteredDepartment(
  env: Env,
  moduleKey: string,
  deps: AddonLifecycleDeps,
): Promise<{ departmentId: string }> {
  const activate = deps.activateDepartment ?? activateDepartment
  let result = await activate(env.DB, moduleKey)
  if (!result.ok && result.reason === 'db_error') {
    result = await activate(env.DB, moduleKey)
  }
  if (!result.ok) throw new Error(`department activation failed: ${result.reason}`)
  return result
}

async function deactivateIfUnowned(
  env: Env,
  installationId: string,
  operation: OperationRow,
  claim: OwnershipRow,
  deps: AddonLifecycleDeps,
): Promise<boolean> {
  if (await countOtherActiveClaims(env, claim) > 0) return false

  await deps.beforeDepartmentDeactivated?.({
    installationId,
    operationId: operation.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  if (await countOtherActiveClaims(env, claim) > 0) return false

  const deactivate = deps.deactivateDepartment ?? deactivateDepartment
  const deactivated = await deactivate(env.DB, claim.resource_key)
  if (!deactivated.ok && deactivated.reason !== 'not_found') {
    throw new Error(`department deactivation failed: ${deactivated.reason}`)
  }
  if (await countOtherActiveClaims(env, claim) > 0) {
    await activateRegisteredDepartment(env, claim.resource_key, deps)
  }
  await deps.afterDepartmentDeactivated?.({
    installationId,
    operationId: operation.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  return true
}

async function releaseDepartmentClaim(
  env: Env,
  installationId: string,
  operation: OperationRow,
  claim: OwnershipRow,
  deps: AddonLifecycleDeps,
): Promise<void> {
  await deps.beforeOwnershipReleased?.({
    installationId,
    operationId: operation.id,
    claimId: claim.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })

  const result = await env.DB.prepare(`
    UPDATE addon_resource_ownership
       SET active = 0, released_at = ?1
     WHERE id = ?2 AND tenant = ?3 AND installation_id = ?4
       AND resource_type = ?5 AND resource_id = ?6
       AND resource_key = ?7 AND ownership_mode = 'co_owner' AND active = 1
  `).bind(
    new Date().toISOString(),
    claim.id,
    env.TENANT_SLUG,
    installationId,
    claim.resource_type,
    claim.resource_id,
    claim.resource_key,
  ).run()
  if (!written(result)) {
    const raced = await loadOwnershipClaimById(env, installationId, claim.id)
    if (!raced || raced.active !== 0) throw new Error('addon department ownership release failed')
  }

  await deps.afterOwnershipReleased?.({
    installationId,
    operationId: operation.id,
    claimId: claim.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
}

async function ensureDepartmentClaim(
  env: Env,
  installation: AddonInstallation,
  operation: OperationRow,
  moduleKey: string,
  deps: AddonLifecycleDeps,
): Promise<OwnershipRow> {
  const existing = await loadDepartmentClaim(env, installation.id, moduleKey)
  if (existing?.active === 1) return existing

  const activated = await activateRegisteredDepartment(env, moduleKey, deps)
  await deps.afterDepartmentActivated?.({
    installationId: installation.id,
    operationId: operation.id,
    moduleKey,
    departmentId: activated.departmentId,
  })

  if (existing) {
    if (existing.ownership_mode !== 'co_owner' || existing.resource_id !== activated.departmentId) {
      throw new Error('addon department ownership does not match activation')
    }
    const result = await env.DB.prepare(`
      UPDATE addon_resource_ownership
         SET active = 1, released_at = NULL
       WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
         AND resource_type = 'department' AND resource_id = ?4
         AND resource_key = ?5 AND ownership_mode = 'co_owner' AND active = 0
    `).bind(
      existing.id,
      env.TENANT_SLUG,
      installation.id,
      existing.resource_id,
      moduleKey,
    ).run()
    if (written(result)) return { ...existing, active: 1, released_at: null }

    const raced = await loadDepartmentClaim(env, installation.id, moduleKey)
    if (raced?.active === 1 && raced.resource_id === activated.departmentId) return raced
    throw new Error('addon department ownership reactivation failed')
  }

  const claimId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  try {
    const result = await env.DB.prepare(`
      INSERT INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, active, created_at
      ) VALUES (?1, ?2, ?3, 'department', ?4, ?5, 'co_owner', 1, ?6)
    `).bind(
      claimId,
      env.TENANT_SLUG,
      installation.id,
      activated.departmentId,
      moduleKey,
      createdAt,
    ).run()
    if (written(result)) {
      return {
        id: claimId,
        tenant: env.TENANT_SLUG,
        installation_id: installation.id,
        resource_type: 'department',
        resource_id: activated.departmentId,
        resource_key: moduleKey,
        ownership_mode: 'co_owner',
        active: 1,
        created_at: createdAt,
        released_at: null,
      }
    }
  } catch {
    // A concurrent retry can persist the same installation/resource claim first.
  }

  const raced = await loadDepartmentClaim(env, installation.id, moduleKey)
  if (
    raced?.active === 1
    && raced.ownership_mode === 'co_owner'
    && raced.resource_id === activated.departmentId
  ) {
    return raced
  }
  throw new Error('addon department ownership write failed')
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
    SELECT sequence, id, tenant, installation_id, action, previous_state, next_state,
           addon_key, installed_version, publisher, trust_class,
           mupot_compatibility, manifest_sha256, actor_id, outcome,
           side_effect_ids, checks, error_code, created_at
      FROM addon_receipts
     WHERE tenant = ?1 AND installation_id = ?2
     ORDER BY sequence DESC
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
    const results = await env.DB.batch<InstallationRow>([
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
      env.DB.prepare(`
        SELECT ${INSTALLATION_COLUMNS}
          FROM addon_installations
         WHERE id = ?1 AND tenant = ?2
           AND state = 'installed' AND latest_previous_state IS NULL
           AND latest_actor_id = ?3 AND latest_receipt_id = ?4
         LIMIT 1
      `).bind(installationId, env.TENANT_SLUG, actor.id, receiptId),
    ])

    if (!written(results[0]) || !written(results[1])) return { ok: false, reason: 'write_failed' }
    const installation = selectedInstallation(results[2])
    return installation
      ? { ok: true, state: installation.state, installation, created: true }
      : { ok: false, reason: 'write_failed' }
  } catch {
    const raced = await loadLiveInstallation(env, key)
    if (!raced) return { ok: false, reason: 'write_failed' }
    if (!matchesRegisteredIdentity(raced, entry)) {
      return { ok: false, reason: 'manifest_digest_drift' }
    }
    return { ok: true, state: raced.state, installation: raced, idempotent: true }
  }
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
    const results = await env.DB.batch<InstallationRow>([
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
      env.DB.prepare(`
        SELECT ${INSTALLATION_COLUMNS}
          FROM addon_installations
         WHERE id = ?1 AND tenant = ?2
           AND state = 'configured' AND latest_previous_state = 'installed'
           AND latest_actor_id = ?3 AND latest_receipt_id = ?4
         LIMIT 1
      `).bind(existing.id, env.TENANT_SLUG, actor.id, receiptId),
    ])

    if (written(results[0]) && written(results[1])) {
      const configured = selectedInstallation(results[2])
      return configured
        ? { ok: true, state: configured.state, installation: configured }
        : { ok: false, reason: 'write_failed' }
    }
  } catch {
    const current = await loadInstallationById(env, existing.id)
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

  const current = await loadInstallationById(env, existing.id)
  if (!current) return { ok: false, reason: 'write_failed' }
  if (!matchesRegisteredIdentity(current, entry)) {
    return { ok: false, reason: 'manifest_digest_drift' }
  }
  if (current.state === 'configured') {
    return { ok: true, state: current.state, installation: current, idempotent: true }
  }
  return { ok: false, reason: 'invalid_state', state: current.state }
}

export async function activateAddon(
  env: Env,
  actor: AddonActor,
  key: string,
  deps: AddonLifecycleDeps = {},
): Promise<AddonMutationResult> {
  const context = await loadLifecycleMutationContext(env, actor, key)
  if (!context.ok) return context.result
  const { entry, installation: existing } = context
  if (existing.state === 'active') {
    return { ok: true, state: existing.state, installation: existing, idempotent: true }
  }
  if (
    (existing.state !== 'configured' && existing.state !== 'disabled')
    || !isZeroAuthority(entry)
  ) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  try {
    const operation = await beginOrResumeOperation(
      env,
      existing.id,
      actor.id,
      'activate',
      'active',
      'activate_departments',
    )
    if (!operation) return { ok: false, reason: 'invalid_state', state: existing.state }

    const claims: OwnershipRow[] = []
    for (const department of entry.manifest.departments) {
      claims.push(await ensureDepartmentClaim(
        env,
        existing,
        operation,
        department.moduleKey,
        deps,
      ))
    }

    await setOperationStep(env, operation, 'activate_transition')
    const current = await loadInstallationById(env, existing.id)
    if (!current) return { ok: false, reason: 'write_failed' }
    if (!matchesRegisteredIdentity(current, entry)) {
      return { ok: false, reason: 'manifest_digest_drift' }
    }
    if (current.state === 'active') {
      return { ok: true, state: current.state, installation: current, idempotent: true }
    }
    if (current.state !== 'configured' && current.state !== 'disabled') {
      return { ok: false, reason: 'invalid_state', state: current.state }
    }

    const receiptId = crypto.randomUUID()
    const activatedAt = new Date().toISOString()
    const sideEffectIds = JSON.stringify(claims.map((claim) => claim.id))
    const checks = JSON.stringify({
      authorityRequests: 'empty',
      connectorRequirements: 'empty',
      departments: claims.map((claim) => ({
        claimId: claim.id,
        departmentId: claim.resource_id,
        moduleKey: claim.resource_key,
      })),
      manifestDigest: 'matched',
      operationId: operation.id,
    })

    try {
      const results = await env.DB.batch<InstallationRow>([
        env.DB.prepare(`
          UPDATE addon_installations
             SET state = 'active', activated_at = ?1, updated_at = ?1,
                 latest_previous_state = ?2, latest_actor_id = ?3,
                 latest_receipt_id = ?4, last_error = NULL
           WHERE id = ?5 AND tenant = ?6 AND addon_key = ?7
             AND state = ?8 AND manifest_sha256 = ?9 AND latest_receipt_id = ?10
             AND EXISTS (
               SELECT 1 FROM addon_operations AS operation
                WHERE operation.id = ?11
                  AND operation.tenant = addon_installations.tenant
                  AND operation.installation_id = addon_installations.id
                  AND operation.action = 'activate' AND operation.target_state = 'active'
                  AND operation.current_step = 'activate_transition'
                  AND operation.status = 'running' AND operation.actor_id = ?12
             )
        `).bind(
          activatedAt,
          current.state,
          operation.actor_id,
          receiptId,
          current.id,
          env.TENANT_SLUG,
          key,
          current.state,
          entry.manifestSha256,
          current.latestReceiptId,
          operation.id,
          operation.actor_id,
        ),
        transitionReceiptStatement(env, current, operation, {
          id: receiptId,
          action: 'activate',
          previousState: current.state,
          nextState: 'active',
          sideEffectIds,
          checks,
          createdAt: activatedAt,
        }),
        operationStepStatement(env, operation, 'completed', activatedAt, 'completed'),
        selectTransitionStatement(
          env,
          current.id,
          operation,
          current.state,
          'active',
          receiptId,
        ),
      ])

      if (written(results[0]) && written(results[1]) && written(results[2])) {
        const activated = selectedInstallation(results[3])
        return activated
          ? { ok: true, state: activated.state, installation: activated }
          : { ok: false, reason: 'write_failed' }
      }
    } catch {
      const raced = await loadInstallationById(env, current.id)
      if (raced && matchesRegisteredIdentity(raced, entry) && raced.state === 'active') {
        return { ok: true, state: raced.state, installation: raced, idempotent: true }
      }
      return { ok: false, reason: 'write_failed' }
    }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  const current = await loadInstallationById(env, existing.id)
  if (current && matchesRegisteredIdentity(current, entry) && current.state === 'active') {
    return { ok: true, state: current.state, installation: current, idempotent: true }
  }
  return { ok: false, reason: 'write_failed' }
}

export async function disableAddon(
  env: Env,
  actor: AddonActor,
  key: string,
  deps: AddonLifecycleDeps = {},
): Promise<AddonMutationResult> {
  const context = await loadLifecycleMutationContext(env, actor, key)
  if (!context.ok) return context.result
  const { entry, installation: existing } = context

  const running = await loadRunningOperation(env, existing.id)
  if (existing.state === 'disabled' && !running) {
    return { ok: true, state: existing.state, installation: existing, idempotent: true }
  }
  if (existing.state !== 'active' && existing.state !== 'disabled') {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }
  if (running && (running.action !== 'disable' || running.target_state !== 'disabled')) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  try {
    const operation = running ?? await beginOrResumeOperation(
      env,
      existing.id,
      actor.id,
      'disable',
      'disabled',
      'disable_state',
    )
    if (!operation) return { ok: false, reason: 'invalid_state', state: existing.state }

    let disabled = existing
    if (existing.state === 'active') {
      const activeClaims = await loadDepartmentClaims(env, existing.id, true)
      const receiptId = crypto.randomUUID()
      const disabledAt = new Date().toISOString()
      const sideEffectIds = JSON.stringify(activeClaims.map((claim) => claim.id))
      const checks = JSON.stringify({
        activeClaims: activeClaims.length,
        operationId: operation.id,
        stateChangedBeforeTeardown: true,
      })

      try {
        const results = await env.DB.batch<InstallationRow>([
          env.DB.prepare(`
            UPDATE addon_installations
               SET state = 'disabled', disabled_at = ?1, updated_at = ?1,
                   latest_previous_state = 'active', latest_actor_id = ?2,
                   latest_receipt_id = ?3, last_error = NULL
             WHERE id = ?4 AND tenant = ?5 AND addon_key = ?6
               AND state = 'active' AND manifest_sha256 = ?7 AND latest_receipt_id = ?8
               AND EXISTS (
                 SELECT 1 FROM addon_operations AS operation
                  WHERE operation.id = ?9
                    AND operation.tenant = addon_installations.tenant
                    AND operation.installation_id = addon_installations.id
                    AND operation.action = 'disable' AND operation.target_state = 'disabled'
                    AND operation.current_step = 'disable_state'
                    AND operation.status = 'running' AND operation.actor_id = ?10
               )
          `).bind(
            disabledAt,
            operation.actor_id,
            receiptId,
            existing.id,
            env.TENANT_SLUG,
            key,
            entry.manifestSha256,
            existing.latestReceiptId,
            operation.id,
            operation.actor_id,
          ),
          transitionReceiptStatement(env, existing, operation, {
            id: receiptId,
            action: 'disable',
            previousState: 'active',
            nextState: 'disabled',
            sideEffectIds,
            checks,
            createdAt: disabledAt,
          }),
          operationStepStatement(env, operation, 'disable_teardown', disabledAt),
          selectTransitionStatement(
            env,
            existing.id,
            operation,
            'active',
            'disabled',
            receiptId,
          ),
        ])

        if (!written(results[0]) || !written(results[1]) || !written(results[2])) {
          return { ok: false, reason: 'write_failed' }
        }
        const selected = selectedInstallation(results[3])
        if (!selected) return { ok: false, reason: 'write_failed' }
        disabled = selected
      } catch {
        const raced = await loadInstallationById(env, existing.id)
        if (!raced || !matchesRegisteredIdentity(raced, entry) || raced.state !== 'disabled') {
          return { ok: false, reason: 'write_failed' }
        }
        disabled = raced
      }

      await deps.afterInstallationDisabled?.({
        installationId: existing.id,
        operationId: operation.id,
      })
    }

    if (operation.current_step.startsWith('disable_claim:')) {
      const pendingClaim = await loadOwnershipClaimById(
        env,
        existing.id,
        operation.current_step.slice('disable_claim:'.length),
      )
      if (pendingClaim?.active === 0) {
        await deactivateIfUnowned(env, existing.id, operation, pendingClaim, deps)
        await setOperationStep(env, operation, 'disable_teardown')
      }
    }

    const claims = await loadDepartmentClaims(env, existing.id, true)
    for (const claim of claims) {
      await setOperationStep(env, operation, `disable_claim:${claim.id}`)
      const deactivatedBeforeRelease = await deactivateIfUnowned(
        env,
        existing.id,
        operation,
        claim,
        deps,
      )
      await releaseDepartmentClaim(env, existing.id, operation, claim, deps)
      if (!deactivatedBeforeRelease) {
        await deactivateIfUnowned(env, existing.id, operation, claim, deps)
      }
      await setOperationStep(env, operation, 'disable_teardown')
    }

    if ((await loadDepartmentClaims(env, existing.id, true)).length > 0) {
      return { ok: false, reason: 'write_failed' }
    }

    const completedAt = new Date().toISOString()
    await operationStepStatement(env, operation, 'completed', completedAt, 'completed').run()

    return { ok: true, state: disabled.state, installation: disabled }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export async function archiveAddon(
  env: Env,
  actor: AddonActor,
  key: string,
): Promise<AddonMutationResult> {
  const context = await loadLifecycleMutationContext(env, actor, key)
  if (!context.ok) return context.result
  const { entry, installation: existing } = context
  if (existing.state !== 'disabled') {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  const running = await loadRunningOperation(env, existing.id)
  if (running && (running.action !== 'archive' || running.target_state !== 'archived')) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }
  if ((await loadDepartmentClaims(env, existing.id, true)).length > 0) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  try {
    const operation = running ?? await beginOrResumeOperation(
      env,
      existing.id,
      actor.id,
      'archive',
      'archived',
      'archive_transition',
    )
    if (!operation) return { ok: false, reason: 'invalid_state', state: existing.state }

    const receiptId = crypto.randomUUID()
    const archivedAt = new Date().toISOString()
    const checks = JSON.stringify({
      activeClaims: 0,
      deletes: 0,
      operationId: operation.id,
      softArchive: true,
    })

    try {
      const results = await env.DB.batch<InstallationRow>([
        env.DB.prepare(`
          UPDATE addon_installations
             SET state = 'archived', archived_at = ?1, updated_at = ?1,
                 latest_previous_state = 'disabled', latest_actor_id = ?2,
                 latest_receipt_id = ?3, last_error = NULL
           WHERE id = ?4 AND tenant = ?5 AND addon_key = ?6
             AND state = 'disabled' AND manifest_sha256 = ?7 AND latest_receipt_id = ?8
             AND EXISTS (
               SELECT 1 FROM addon_operations AS operation
                WHERE operation.id = ?9
                  AND operation.tenant = addon_installations.tenant
                  AND operation.installation_id = addon_installations.id
                  AND operation.action = 'archive' AND operation.target_state = 'archived'
                  AND operation.current_step = 'archive_transition'
                  AND operation.status = 'running' AND operation.actor_id = ?10
             )
             AND NOT EXISTS (
               SELECT 1 FROM addon_resource_ownership AS claim
                WHERE claim.tenant = addon_installations.tenant
                  AND claim.installation_id = addon_installations.id
                  AND claim.active = 1
             )
        `).bind(
          archivedAt,
          operation.actor_id,
          receiptId,
          existing.id,
          env.TENANT_SLUG,
          key,
          entry.manifestSha256,
          existing.latestReceiptId,
          operation.id,
          operation.actor_id,
        ),
        transitionReceiptStatement(env, existing, operation, {
          id: receiptId,
          action: 'archive',
          previousState: 'disabled',
          nextState: 'archived',
          sideEffectIds: '[]',
          checks,
          createdAt: archivedAt,
        }),
        operationStepStatement(env, operation, 'completed', archivedAt, 'completed'),
        selectTransitionStatement(
          env,
          existing.id,
          operation,
          'disabled',
          'archived',
          receiptId,
        ),
      ])

      if (written(results[0]) && written(results[1]) && written(results[2])) {
        const archived = selectedInstallation(results[3])
        return archived
          ? { ok: true, state: archived.state, installation: archived }
          : { ok: false, reason: 'write_failed' }
      }
    } catch {
      const raced = await loadInstallationById(env, existing.id)
      if (raced && matchesRegisteredIdentity(raced, entry) && raced.state === 'archived') {
        return { ok: true, state: raced.state, installation: raced, idempotent: true }
      }
      return { ok: false, reason: 'write_failed' }
    }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  return { ok: false, reason: 'write_failed' }
}
