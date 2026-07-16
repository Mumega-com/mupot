import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../types'
import {
  activate as activateDepartment,
  getRegistered as getRegisteredDepartment,
} from '../departments/registry'
import './modules'
import {
  assertAddonRuntimeContract,
  getRegisteredAddon,
  type AddonCatalogEntry,
} from './registry'

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

export interface AddonOperationLifecycleEvent {
  installationId: string
  operationId: string
}

export interface AddonLifecycleDeps {
  afterDepartmentActivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  afterInstallationDisabled?: (event: AddonOperationLifecycleEvent) => void | Promise<void>
  beforeDepartmentDeactivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  afterDepartmentDeactivated?: (event: AddonDepartmentLifecycleEvent) => void | Promise<void>
  beforeOwnershipReleased?: (event: AddonOwnershipLifecycleEvent) => void | Promise<void>
  afterOwnershipReleased?: (event: AddonOwnershipLifecycleEvent) => void | Promise<void>
  beforeOperationCompleted?: (event: AddonOperationLifecycleEvent) => void | Promise<void>
}

export type AddonFailureReason =
  | 'addon_not_registered'
  | 'manifest_digest_drift'
  | 'invalid_state'
  | 'write_failed'
  | 'not_authorized'
  | 'operation_busy'
  | 'fence_lost'

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
  lease_token: string
  lease_expires_at: string
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
  preserve_on_release: 0 | 1
  active: 0 | 1
  created_at: string
  released_at: string | null
}

interface DepartmentRow {
  id: string
  slug: string
  template_key: string | null
  template_version: string | null
  active: 0 | 1
}

interface DepartmentStateRow {
  id: string
  slug: string
  name: string
  created_at: string
  template_key: string | null
  template_version: string | null
  activated_at: string | null
  active: 0 | 1
  seed_receipt: string | null
}

interface BusinessTableRow {
  name: string
}

interface BusinessColumnRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
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

function matchesPersistedIdentity(
  installation: AddonInstallation,
  expected: AddonInstallation,
): boolean {
  return installation.id === expected.id
    && installation.tenant === expected.tenant
    && installation.addonKey === expected.addonKey
    && installation.installedVersion === expected.installedVersion
    && installation.publisher === expected.publisher
    && installation.trustClass === expected.trustClass
    && installation.manifestSha256 === expected.manifestSha256
    && installation.mupotCompatibility === expected.mupotCompatibility
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

async function loadLatestArchivedInstallation(env: Env, key: string): Promise<AddonInstallation | null> {
  const row = await env.DB.prepare(`
    SELECT ${INSTALLATION_COLUMNS}
      FROM addon_installations
     WHERE tenant = ?1 AND addon_key = ?2 AND state = 'archived'
     ORDER BY archived_at DESC, updated_at DESC, id DESC
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

async function loadTeardownMutationContext(
  env: Env,
  actor: AddonActor,
  key: string,
): Promise<
  | { ok: true; installation: AddonInstallation }
  | { ok: false; result: AddonMutationFailure }
> {
  if (!authorized(actor)) {
    return { ok: false, result: { ok: false, reason: 'not_authorized' } }
  }

  const installation = await loadLiveInstallation(env, key)
  if (!installation) {
    return {
      ok: false,
      result: getRegisteredAddon(key)
        ? { ok: false, reason: 'invalid_state' }
        : { ok: false, reason: 'addon_not_registered' },
    }
  }

  return { ok: true, installation }
}

const OPERATION_LEASE_MS = 30_000

class FenceLostError extends Error {
  constructor() {
    super('addon operation fence lost')
  }
}

type OperationAcquireResult =
  | { ok: true; operation: OperationRow }
  | { ok: false; reason: 'operation_busy' | 'fence_lost' }

function leaseWindow(nowMs = Date.now()): { now: string; expiresAt: string } {
  return {
    now: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + OPERATION_LEASE_MS).toISOString(),
  }
}

function leaseIsLive(operation: OperationRow, nowMs = Date.now()): boolean {
  return Date.parse(operation.lease_expires_at) > nowMs
}

function lifecycleFailure(error: unknown): AddonMutationFailure {
  return {
    ok: false,
    reason: error instanceof FenceLostError ? 'fence_lost' : 'write_failed',
  }
}

async function loadRunningOperation(env: Env, installationId: string): Promise<OperationRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_token, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE tenant = ?1 AND installation_id = ?2 AND status = 'running'
     LIMIT 1
  `).bind(env.TENANT_SLUG, installationId).first<OperationRow>()
}

async function loadFailedOperation(
  env: Env,
  installationId: string,
  action: OperationAction,
  targetState: OperationTargetState,
): Promise<OperationRow | null> {
  const operation = await env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_token, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE tenant = ?1 AND installation_id = ?2
       AND action = ?3 AND target_state = ?4
     ORDER BY updated_at DESC, created_at DESC, rowid DESC
     LIMIT 1
  `).bind(
    env.TENANT_SLUG,
    installationId,
    action,
    targetState,
  ).first<OperationRow>()
  return operation?.status === 'failed' ? operation : null
}

async function loadExactOperation(
  env: Env,
  operation: OperationRow,
  status: OperationRow['status'],
  step: string,
): Promise<OperationRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_token, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND action = ?4 AND target_state = ?5 AND actor_id = ?6
       AND lease_token = ?7 AND status = ?8 AND current_step = ?9
     LIMIT 1
  `).bind(
    operation.id,
    env.TENANT_SLUG,
    operation.installation_id,
    operation.action,
    operation.target_state,
    operation.actor_id,
    operation.lease_token,
    status,
    step,
  ).first<OperationRow>()
}

async function lifecycleOperationFailure(
  env: Env,
  operation: OperationRow,
  error: unknown,
): Promise<AddonMutationFailure> {
  if (error instanceof FenceLostError) return lifecycleFailure(error)
  const errorCode = {
    activate: 'activation_failed',
    disable: 'disable_failed',
    archive: 'archive_failed',
  }[operation.action]
  const failedAt = new Date().toISOString()
  const failureId = crypto.randomUUID()
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE addon_operations
           SET status = 'failed', error_code = ?1, updated_at = ?2
         WHERE id = ?3 AND tenant = ?4 AND installation_id = ?5
           AND action = ?6 AND target_state = ?7 AND current_step = ?8
           AND status = 'running' AND actor_id = ?9 AND lease_token = ?10
           AND lease_expires_at = ?11 AND lease_expires_at > ?2
      `).bind(
        errorCode,
        failedAt,
        operation.id,
        env.TENANT_SLUG,
        operation.installation_id,
        operation.action,
        operation.target_state,
        operation.current_step,
        operation.actor_id,
        operation.lease_token,
        operation.lease_expires_at,
      ),
      env.DB.prepare(`
        INSERT INTO addon_operation_failures (
          id, tenant, installation_id, operation_id, action, target_state,
          current_step, actor_id, lease_token, error_code, failed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).bind(
        failureId,
        env.TENANT_SLUG,
        operation.installation_id,
        operation.id,
        operation.action,
        operation.target_state,
        operation.current_step,
        operation.actor_id,
        operation.lease_token,
        errorCode,
        failedAt,
      ),
    ])
    if (!written(results[0]) || !written(results[1])) {
      return { ok: false, reason: 'fence_lost' }
    }
  } catch {
    return { ok: false, reason: 'fence_lost' }
  }

  operation.status = 'failed'
  operation.error_code = errorCode
  operation.updated_at = failedAt
  const [failed, evidence] = await Promise.all([
    loadExactOperation(env, operation, 'failed', operation.current_step),
    env.DB.prepare(`
      SELECT id
        FROM addon_operation_failures
       WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
         AND operation_id = ?4 AND action = ?5 AND target_state = ?6
         AND current_step = ?7 AND actor_id = ?8 AND lease_token = ?9
         AND error_code = ?10 AND failed_at = ?11
       LIMIT 1
    `).bind(
      failureId,
      env.TENANT_SLUG,
      operation.installation_id,
      operation.id,
      operation.action,
      operation.target_state,
      operation.current_step,
      operation.actor_id,
      operation.lease_token,
      errorCode,
      failedAt,
    ).first<{ id: string }>(),
  ])
  return failed && evidence?.id === failureId
    ? { ok: false, reason: 'write_failed' }
    : { ok: false, reason: 'fence_lost' }
}

async function assertLiveOperationLease(env: Env, operation: OperationRow): Promise<void> {
  const owned = await loadExactOperation(
    env,
    operation,
    'running',
    operation.current_step,
  )
  if (!owned || !leaseIsLive(owned)) throw new FenceLostError()
  operation.lease_expires_at = owned.lease_expires_at
  operation.updated_at = owned.updated_at
}

async function acquireOperation(
  env: Env,
  installationId: string,
  actorId: string,
  action: OperationAction,
  targetState: OperationTargetState,
  initialStep: string,
  expectedStates: readonly [AddonState, AddonState],
): Promise<OperationAcquireResult> {
  const running = await loadRunningOperation(env, installationId)
  const token = crypto.randomUUID()
  const { now, expiresAt } = leaseWindow()

  if (running) {
    if (leaseIsLive(running)) return { ok: false, reason: 'operation_busy' }
    if (running.action !== action || running.target_state !== targetState) {
      return { ok: false, reason: 'operation_busy' }
    }

    const claimed = await env.DB.prepare(`
      UPDATE addon_operations
         SET lease_token = ?1, lease_expires_at = ?2, updated_at = ?3, error_code = NULL
       WHERE id = ?4 AND tenant = ?5 AND installation_id = ?6
         AND action = ?7 AND target_state = ?8 AND current_step = ?9
         AND status = 'running' AND actor_id = ?10
         AND lease_token = ?11 AND lease_expires_at = ?12 AND lease_expires_at <= ?3
         AND EXISTS (
           SELECT 1 FROM addon_installations AS installation
            WHERE installation.id = addon_operations.installation_id
              AND installation.tenant = addon_operations.tenant
              AND installation.state IN (?13, ?14)
         )
    `).bind(
      token,
      expiresAt,
      now,
      running.id,
      env.TENANT_SLUG,
      installationId,
      action,
      targetState,
      running.current_step,
      running.actor_id,
      running.lease_token,
      running.lease_expires_at,
      expectedStates[0],
      expectedStates[1],
    ).run()
    if (!written(claimed)) {
      const raced = await loadRunningOperation(env, installationId)
      return raced && leaseIsLive(raced)
        ? { ok: false, reason: 'operation_busy' }
        : { ok: false, reason: 'fence_lost' }
    }

    const operation = { ...running, lease_token: token, lease_expires_at: expiresAt, updated_at: now }
    const selected = await loadExactOperation(env, operation, 'running', running.current_step)
    return selected
      ? { ok: true, operation: selected }
      : { ok: false, reason: 'fence_lost' }
  }

  const failed = await loadFailedOperation(env, installationId, action, targetState)
  const currentState = expectedStates[0]
  const recoverable = failed && (
    action === 'activate'
    || (action === 'disable' && (
      currentState === 'disabled' || failed.current_step === initialStep
    ))
    || (action === 'archive' && failed.current_step === initialStep)
  )
  if (failed && recoverable) {
    try {
      const recovered = await env.DB.prepare(`
        UPDATE addon_operations
           SET status = 'running', lease_token = ?1, lease_expires_at = ?2,
               updated_at = ?3, error_code = NULL
         WHERE id = ?4 AND tenant = ?5 AND installation_id = ?6
           AND action = ?7 AND target_state = ?8 AND current_step = ?9
           AND status = 'failed' AND actor_id = ?10 AND lease_token = ?11
           AND error_code = ?12
           AND EXISTS (
             SELECT 1 FROM addon_installations AS installation
              WHERE installation.id = addon_operations.installation_id
                AND installation.tenant = addon_operations.tenant
                AND installation.state IN (?13, ?14)
           )
      `).bind(
        token,
        expiresAt,
        now,
        failed.id,
        env.TENANT_SLUG,
        installationId,
        action,
        targetState,
        failed.current_step,
        failed.actor_id,
        failed.lease_token,
        failed.error_code,
        expectedStates[0],
        expectedStates[1],
      ).run()
      if (written(recovered)) {
        const operation: OperationRow = {
          ...failed,
          status: 'running',
          lease_token: token,
          lease_expires_at: expiresAt,
          error_code: null,
          updated_at: now,
        }
        const selected = await loadExactOperation(
          env,
          operation,
          'running',
          operation.current_step,
        )
        return selected
          ? { ok: true, operation: selected }
          : { ok: false, reason: 'fence_lost' }
      }
    } catch {
      // The one-running-operation constraint identifies a concurrent recovery winner.
    }

    const raced = await loadRunningOperation(env, installationId)
    return raced
      ? { ok: false, reason: 'operation_busy' }
      : { ok: false, reason: 'fence_lost' }
  }

  const id = crypto.randomUUID()
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step,
        status, actor_id, lease_token, lease_expires_at, created_at, updated_at
      )
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?10
       WHERE EXISTS (
         SELECT 1 FROM addon_installations
          WHERE id = ?3 AND tenant = ?2 AND state IN (?11, ?12)
       )
    `).bind(
      id,
      env.TENANT_SLUG,
      installationId,
      action,
      targetState,
      initialStep,
      actorId,
      token,
      expiresAt,
      now,
      expectedStates[0],
      expectedStates[1],
    ).run()
    if (written(inserted)) {
      const operation: OperationRow = {
        id,
        tenant: env.TENANT_SLUG,
        installation_id: installationId,
        action,
        target_state: targetState,
        current_step: initialStep,
        status: 'running',
        actor_id: actorId,
        lease_token: token,
        lease_expires_at: expiresAt,
        error_code: null,
        created_at: now,
        updated_at: now,
      }
      return { ok: true, operation }
    }
  } catch {
    // The running-operation or lease-token uniqueness constraint identifies the winner.
  }

  const raced = await loadRunningOperation(env, installationId)
  return raced ? { ok: false, reason: 'operation_busy' } : { ok: false, reason: 'fence_lost' }
}

function operationStepStatement(
  env: Env,
  operation: OperationRow,
  step: string,
  status: 'running' | 'completed',
  expectedStates: readonly [AddonState, AddonState],
  timing = leaseWindow(),
): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE addon_operations
       SET current_step = ?1, status = ?2, lease_expires_at = ?3,
           updated_at = ?4, error_code = NULL
     WHERE id = ?5 AND tenant = ?6 AND installation_id = ?7
       AND action = ?8 AND target_state = ?9 AND actor_id = ?10
       AND lease_token = ?11 AND current_step = ?12 AND status = 'running'
       AND lease_expires_at > ?4
       AND EXISTS (
         SELECT 1 FROM addon_installations AS installation
          WHERE installation.id = addon_operations.installation_id
            AND installation.tenant = addon_operations.tenant
            AND installation.state IN (?13, ?14)
       )
  `).bind(
    step,
    status,
    timing.expiresAt,
    timing.now,
    operation.id,
    env.TENANT_SLUG,
    operation.installation_id,
    operation.action,
    operation.target_state,
    operation.actor_id,
    operation.lease_token,
    operation.current_step,
    expectedStates[0],
    expectedStates[1],
  )
}

async function setOperationStep(
  env: Env,
  operation: OperationRow,
  step: string,
  expectedStates: readonly [AddonState, AddonState],
): Promise<void> {
  const timing = leaseWindow()
  const result = await operationStepStatement(
    env,
    operation,
    step,
    'running',
    expectedStates,
    timing,
  ).run()
  if (!written(result)) throw new FenceLostError()
  operation.current_step = step
  operation.lease_expires_at = timing.expiresAt
  operation.updated_at = timing.now
}

async function renewOperationLease(
  env: Env,
  operation: OperationRow,
  expectedStates: readonly [AddonState, AddonState],
): Promise<void> {
  await setOperationStep(env, operation, operation.current_step, expectedStates)
}

async function completeOperation(
  env: Env,
  operation: OperationRow,
  expectedState: AddonState,
): Promise<OperationRow> {
  const timing = leaseWindow()
  const result = await operationStepStatement(
    env,
    operation,
    'completed',
    'completed',
    [expectedState, expectedState],
    timing,
  ).run()
  if (!written(result)) throw new FenceLostError()
  operation.current_step = 'completed'
  operation.status = 'completed'
  operation.lease_expires_at = timing.expiresAt
  operation.updated_at = timing.now
  const completed = await loadExactOperation(env, operation, 'completed', 'completed')
  if (!completed) throw new FenceLostError()
  return completed
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
           resource_key, ownership_mode, preserve_on_release, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE installation_id = ?1
       ${activePredicate}
     ORDER BY resource_key ASC, id ASC
  `).bind(installationId).all<OwnershipRow>()
  return result.results ?? []
}

async function loadDepartmentClaim(
  env: Env,
  installationId: string,
  moduleKey: string,
): Promise<OwnershipRow | null> {
  const result = await env.DB.prepare(`
    SELECT id, tenant, installation_id, resource_type, resource_id,
           resource_key, ownership_mode, preserve_on_release, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE installation_id = ?1 AND resource_key = ?2
     ORDER BY id ASC
  `).bind(installationId, moduleKey).all<OwnershipRow>()
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
           resource_key, ownership_mode, preserve_on_release, active, created_at, released_at
      FROM addon_resource_ownership
     WHERE id = ?1 AND installation_id = ?2
     LIMIT 1
  `).bind(claimId, installationId).first<OwnershipRow>()
}

async function countOtherActiveClaims(
  env: Env,
  claim: OwnershipRow,
): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
      FROM addon_resource_ownership AS other_claim
      JOIN addon_installations AS installation
        ON installation.id = other_claim.installation_id
       AND installation.tenant = other_claim.tenant
     WHERE other_claim.tenant = ?1
       AND other_claim.resource_type = ?2
       AND other_claim.resource_id = ?3
       AND other_claim.installation_id <> ?4
       AND other_claim.active = 1
       AND installation.state = 'active'
  `).bind(
    env.TENANT_SLUG,
    claim.resource_type,
    claim.resource_id,
    claim.installation_id,
  ).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function countActiveClaimsForDepartment(
  env: Env,
  moduleKey: string,
  departmentId: string,
  excludedInstallationId: string | null = null,
): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
      FROM addon_resource_ownership AS claim
     WHERE claim.tenant = ?1 AND claim.resource_type = 'department'
       AND claim.resource_key = ?2 AND claim.resource_id = ?3
       AND claim.ownership_mode = 'co_owner' AND claim.active = 1
       AND (?4 IS NULL OR claim.installation_id <> ?4)
       AND EXISTS (
         SELECT 1 FROM addon_installations AS installation
          WHERE installation.id = claim.installation_id
            AND installation.tenant = claim.tenant
            AND installation.state = 'active'
       )
  `).bind(
    env.TENANT_SLUG,
    moduleKey,
    departmentId,
    excludedInstallationId,
  ).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function loadCanonicalDepartment(
  env: Env,
  moduleKey: string,
  departmentId: string,
  expectedActive: 0 | 1 | null,
): Promise<DepartmentRow> {
  const module = getRegisteredDepartment(moduleKey)
  if (!module) throw new Error('addon department module is not registered')
  const result = await env.DB.prepare(`
    SELECT id, slug, template_key, template_version, active
      FROM departments
     WHERE id = ?1 OR slug = ?2
     ORDER BY id ASC
  `).bind(departmentId, moduleKey).all<DepartmentRow>()
  const rows = result.results ?? []
  if (rows.length !== 1) throw new Error('addon department canonical row is ambiguous')
  const row = rows[0]
  if (
    row.id !== departmentId
    || row.slug !== moduleKey
    || row.template_key !== module.key
    || row.template_version !== module.version
    || (expectedActive !== null && row.active !== expectedActive)
  ) {
    throw new Error('addon department canonical row mismatch')
  }
  return row
}

async function loadPersistedClaimedDepartment(
  env: Env,
  moduleKey: string,
  departmentId: string,
  expectedActive: 0 | 1 | null,
): Promise<DepartmentRow> {
  const row = await env.DB.prepare(`
    SELECT id, slug, template_key, template_version, active
      FROM departments
     WHERE id = ?1
     LIMIT 1
  `).bind(departmentId).first<DepartmentRow>()
  if (
    !row
    || row.id !== departmentId
    || row.slug !== moduleKey
    || row.template_key !== moduleKey
    || (expectedActive !== null && row.active !== expectedActive)
  ) {
    throw new Error('addon persisted department row identity mismatch')
  }
  return row
}

async function setPersistedClaimedDepartmentActive(
  env: Env,
  moduleKey: string,
  departmentId: string,
  active: 0 | 1,
): Promise<void> {
  await loadPersistedClaimedDepartment(env, moduleKey, departmentId, null)
  const sql = active === 1
    ? 'UPDATE departments SET active = 1 WHERE id = ?1 AND slug = ?2 AND template_key = ?2 AND active <> 1'
    : 'UPDATE departments SET active = 0 WHERE id = ?1 AND slug = ?2 AND template_key = ?2 AND active <> 0'
  const result = await env.DB.prepare(sql).bind(departmentId, moduleKey).run()
  if (!result.success) throw new Error('addon persisted department reconciliation failed')
  await loadPersistedClaimedDepartment(env, moduleKey, departmentId, active)
}

async function departmentIdForClaim(
  env: Env,
  moduleKey: string,
): Promise<string> {
  if (!getRegisteredDepartment(moduleKey)) {
    throw new Error('addon department module is not registered')
  }
  const result = await env.DB.prepare(`
    SELECT id, slug, template_key
      FROM departments
     WHERE slug = ?1
     ORDER BY id ASC
  `).bind(moduleKey).all<Pick<DepartmentRow, 'id' | 'slug' | 'template_key'>>()
  const rows = result.results ?? []
  if (rows.length > 1) throw new Error('addon department canonical row is ambiguous')
  const row = rows[0]
  if (!row) return crypto.randomUUID()
  if (row.slug !== moduleKey || (row.template_key !== null && row.template_key !== moduleKey)) {
    throw new Error('addon department canonical row mismatch')
  }
  return row.id
}

async function activateCanonicalDepartment(
  env: Env,
  moduleKey: string,
  expectedDepartmentId?: string,
): Promise<DepartmentRow> {
  const options = expectedDepartmentId
    ? { idGen: () => expectedDepartmentId }
    : undefined
  let result = await activateDepartment(env.DB, moduleKey, options)
  if (!result.ok && result.reason === 'db_error') {
    result = await activateDepartment(env.DB, moduleKey, options)
  }
  if (!result.ok) throw new Error(`department activation failed: ${result.reason}`)
  if (expectedDepartmentId && result.departmentId !== expectedDepartmentId) {
    throw new Error('department activation changed canonical ID')
  }
  return loadCanonicalDepartment(env, moduleKey, result.departmentId, 1)
}

function validateDepartmentClaim(
  env: Env,
  installationId: string,
  moduleKey: string,
  department: DepartmentRow,
  claim: OwnershipRow,
): void {
  if (
    claim.tenant !== env.TENANT_SLUG
    || claim.installation_id !== installationId
    || claim.resource_type !== 'department'
    || claim.resource_key !== moduleKey
    || claim.resource_id !== department.id
    || claim.ownership_mode !== 'co_owner'
    || (claim.preserve_on_release !== 0 && claim.preserve_on_release !== 1)
  ) {
    throw new Error('addon department ownership identity mismatch')
  }
}

function validatePersistedDepartmentClaimIdentity(
  env: Env,
  installationId: string,
  claim: OwnershipRow,
): void {
  if (
    claim.tenant !== env.TENANT_SLUG
    || claim.installation_id !== installationId
    || claim.resource_type !== 'department'
    || claim.resource_id.length === 0
    || claim.resource_key.length === 0
    || claim.ownership_mode !== 'co_owner'
  ) {
    throw new Error('addon persisted department ownership identity mismatch')
  }
}

function serializedClaimIdentities(claims: OwnershipRow[]): string {
  return JSON.stringify(claims.map((claim) => ({
    id: claim.id,
    installationId: claim.installation_id,
    ownershipMode: claim.ownership_mode,
    preserveOnRelease: claim.preserve_on_release,
    resourceId: claim.resource_id,
    resourceKey: claim.resource_key,
    resourceType: claim.resource_type,
    tenant: claim.tenant,
  })))
}

async function validateDepartmentClaimSet(
  env: Env,
  installation: AddonInstallation,
  entry: AddonCatalogEntry,
  claims: OwnershipRow[],
  requireExact: boolean,
  expectedDepartmentActive: 0 | 1 | null,
): Promise<void> {
  for (const claim of claims) {
    const declared = entry.manifest.departments.find(
      (department) => department.moduleKey === claim.resource_key,
    )
    if (!declared) throw new Error('active addon claim is not declared by the manifest')
    const department = await loadCanonicalDepartment(
      env,
      declared.moduleKey,
      claim.resource_id,
      expectedDepartmentActive,
    )
    validateDepartmentClaim(env, installation.id, declared.moduleKey, department, claim)
  }

  if (requireExact) {
    if (claims.length !== entry.manifest.departments.length) {
      throw new Error('addon department claim set does not match the manifest')
    }
    for (const department of entry.manifest.departments) {
      const matches = claims.filter((claim) => claim.resource_key === department.moduleKey)
      if (matches.length !== 1) {
        throw new Error('addon department claim is missing or duplicated')
      }
    }
  }
}

async function validateActiveDepartmentClaims(
  env: Env,
  installation: AddonInstallation,
  entry: AddonCatalogEntry,
  requireExact = installation.state === 'active',
): Promise<OwnershipRow[]> {
  const claims = await loadDepartmentClaims(env, installation.id, true)
  await validateDepartmentClaimSet(
    env,
    installation,
    entry,
    claims,
    requireExact,
    installation.state === 'active' ? 1 : null,
  )
  return claims
}

async function validatePersistedActiveDepartmentClaims(
  env: Env,
  installation: AddonInstallation,
): Promise<OwnershipRow[]> {
  const claims = await loadDepartmentClaims(env, installation.id, true)
  const resourceKeys = new Set<string>()
  for (const claim of claims) {
    validatePersistedDepartmentClaimIdentity(env, installation.id, claim)
    if (resourceKeys.has(claim.resource_key)) {
      throw new Error('addon persisted department ownership is duplicated')
    }
    resourceKeys.add(claim.resource_key)
    const department = await loadPersistedClaimedDepartment(
      env,
      claim.resource_key,
      claim.resource_id,
      installation.state === 'active' ? 1 : null,
    )
    validateDepartmentClaim(env, installation.id, claim.resource_key, department, claim)
  }
  if (installation.state === 'active') {
    const receipt = await env.DB.prepare(`
      SELECT side_effect_ids, checks
        FROM addon_receipts
       WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
         AND action = 'activate' AND previous_state = ?5 AND next_state = 'active'
         AND actor_id = ?4 AND outcome = 'pass'
       LIMIT 1
    `).bind(
      installation.latestReceiptId,
      env.TENANT_SLUG,
      installation.id,
      installation.latestActorId,
      installation.latestPreviousState,
    ).first<Pick<ReceiptRow, 'side_effect_ids' | 'checks'>>()
    if (!receipt) throw new Error('addon activation receipt evidence is missing')
    if (typeof parseChecks(receipt.checks).operationId === 'string') {
      const expectedClaimIds = parseStringArray(receipt.side_effect_ids).sort()
      const activeClaimIds = claims.map((claim) => claim.id).sort()
      if (
        expectedClaimIds.length !== activeClaimIds.length
        || expectedClaimIds.some((id, index) => id !== activeClaimIds[index])
      ) {
        throw new Error('addon active claims do not match persisted activation evidence')
      }
    }
  }
  return claims
}

async function loadPersistedDisabledDepartmentClaims(
  env: Env,
  installation: AddonInstallation,
): Promise<OwnershipRow[]> {
  const claims = await loadDepartmentClaims(env, installation.id)
  if (claims.some((claim) => claim.active === 1)) {
    throw new Error('active addon ownership remains after disable')
  }
  const resourceKeys = new Set<string>()
  for (const claim of claims) {
    validatePersistedDepartmentClaimIdentity(env, installation.id, claim)
    if (resourceKeys.has(claim.resource_key)) {
      throw new Error('addon persisted department ownership is duplicated')
    }
    resourceKeys.add(claim.resource_key)
    const department = await loadPersistedClaimedDepartment(
      env,
      claim.resource_key,
      claim.resource_id,
      null,
    )
    validateDepartmentClaim(env, installation.id, claim.resource_key, department, claim)
  }
  return claims
}

async function loadCompletedDisableOperationEvidence(
  env: Env,
  installation: AddonInstallation,
): Promise<OperationRow | null> {
  const receipt = await env.DB.prepare(`
    SELECT id, actor_id, checks, created_at
     FROM addon_receipts
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND action = 'disable' AND previous_state = ?11 AND next_state = 'disabled'
       AND addon_key = ?4 AND installed_version = ?5 AND publisher = ?6
       AND trust_class = ?7 AND mupot_compatibility = ?8 AND manifest_sha256 = ?9
       AND actor_id = ?10 AND outcome = 'pass'
     LIMIT 1
  `).bind(
    installation.latestReceiptId,
    env.TENANT_SLUG,
    installation.id,
    installation.addonKey,
    installation.installedVersion,
    installation.publisher,
    installation.trustClass,
    installation.mupotCompatibility,
    installation.manifestSha256,
    installation.latestActorId,
    installation.latestPreviousState,
  ).first<Pick<ReceiptRow, 'id' | 'actor_id' | 'checks' | 'created_at'>>()
  if (!receipt) return null

  const operationId = parseChecks(receipt.checks).operationId
  if (typeof operationId !== 'string' || operationId.length === 0) return null

  return env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_token, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND action = 'disable' AND target_state = 'disabled'
       AND current_step = 'completed' AND status = 'completed'
       AND actor_id = ?4 AND created_at <= ?5 AND updated_at >= ?5
     LIMIT 1
  `).bind(
    operationId,
    env.TENANT_SLUG,
    installation.id,
    receipt.actor_id,
    receipt.created_at,
  ).first<OperationRow>()
}

async function loadCompletedArchiveOperationEvidence(
  env: Env,
  installation: AddonInstallation,
): Promise<OperationRow | null> {
  const receipt = await env.DB.prepare(`
    SELECT id, actor_id, checks, created_at
      FROM addon_receipts
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND action = 'archive' AND previous_state = 'disabled' AND next_state = 'archived'
       AND addon_key = ?4 AND installed_version = ?5 AND publisher = ?6
       AND trust_class = ?7 AND mupot_compatibility = ?8 AND manifest_sha256 = ?9
       AND actor_id = ?10 AND outcome = 'pass'
     LIMIT 1
  `).bind(
    installation.latestReceiptId,
    env.TENANT_SLUG,
    installation.id,
    installation.addonKey,
    installation.installedVersion,
    installation.publisher,
    installation.trustClass,
    installation.mupotCompatibility,
    installation.manifestSha256,
    installation.latestActorId,
  ).first<Pick<ReceiptRow, 'id' | 'actor_id' | 'checks' | 'created_at'>>()
  if (!receipt) return null

  const operationId = parseChecks(receipt.checks).operationId
  if (typeof operationId !== 'string' || operationId.length === 0) return null
  return env.DB.prepare(`
    SELECT id, tenant, installation_id, action, target_state, current_step,
           status, actor_id, lease_token, lease_expires_at, error_code, created_at, updated_at
      FROM addon_operations
     WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
       AND action = 'archive' AND target_state = 'archived'
       AND current_step = 'completed' AND status = 'completed'
       AND actor_id = ?4 AND created_at <= ?5 AND updated_at >= ?5
     LIMIT 1
  `).bind(
    operationId,
    env.TENANT_SLUG,
    installation.id,
    receipt.actor_id,
    receipt.created_at,
  ).first<OperationRow>()
}

const MAX_DEPARTMENT_RECONCILIATION_ATTEMPTS = 4

async function reconcileDepartmentForOwnership(
  env: Env,
  moduleKey: string,
  departmentId: string,
  options: {
    excludedInstallationId?: string
    preserveWhenUnowned?: boolean
    operation?: OperationRow
    expectedStates?: readonly [AddonState, AddonState]
  } = {},
): Promise<void> {
  let shouldBeActive = await countActiveClaimsForDepartment(
    env,
    moduleKey,
    departmentId,
    options.excludedInstallationId ?? null,
  ) > 0

  if (!shouldBeActive && options.preserveWhenUnowned) {
    await loadPersistedClaimedDepartment(env, moduleKey, departmentId, null)
    return
  }

  let lastRegistryError: Error | null = null
  for (let attempt = 0; attempt < MAX_DEPARTMENT_RECONCILIATION_ATTEMPTS; attempt += 1) {
    try {
      if (shouldBeActive) {
        await setPersistedClaimedDepartmentActive(env, moduleKey, departmentId, 1)
      } else {
        await setPersistedClaimedDepartmentActive(env, moduleKey, departmentId, 0)
      }
      lastRegistryError = null
    } catch (error) {
      lastRegistryError = error instanceof Error ? error : new Error(String(error))
      continue
    }

    if (options.operation && options.expectedStates) {
      try {
        await renewOperationLease(env, options.operation, options.expectedStates)
      } catch (error) {
        if (error instanceof FenceLostError) {
          await compensateDepartmentForOwnership(
            env,
            moduleKey,
            departmentId,
            options.preserveWhenUnowned ?? false,
          )
        }
        throw error
      }
    }

    const activeClaims = await countActiveClaimsForDepartment(
      env,
      moduleKey,
      departmentId,
      options.excludedInstallationId ?? null,
    )
    const department = await loadPersistedClaimedDepartment(env, moduleKey, departmentId, null)
    shouldBeActive = activeClaims > 0
    if (!shouldBeActive && options.preserveWhenUnowned) return
    if (department.active === (shouldBeActive ? 1 : 0)) return
  }

  if (lastRegistryError) throw lastRegistryError
  throw new Error('addon department ownership did not stabilize')
}

async function compensateDepartmentForOwnership(
  env: Env,
  moduleKey: string,
  departmentId: string,
  preserveWhenUnowned = false,
): Promise<void> {
  await reconcileDepartmentForOwnership(env, moduleKey, departmentId, { preserveWhenUnowned })
}

async function repairAndValidatePersistedDisabledDepartmentClaims(
  env: Env,
  installation: AddonInstallation,
  options: {
    operation?: OperationRow
    expectedStates?: readonly [AddonState, AddonState]
  } = {},
): Promise<OwnershipRow[]> {
  const claims = await loadPersistedDisabledDepartmentClaims(env, installation)
  for (const claim of claims) {
    await reconcileDepartmentForOwnership(
      env,
      claim.resource_key,
      claim.resource_id,
      {
        ...options,
        // A tenant-owned department is outside addon teardown authority.
        ...(claim.preserve_on_release === 1 ? { preserveWhenUnowned: true } : {}),
      },
    )
  }

  const confirmed = await loadPersistedDisabledDepartmentClaims(env, installation)
  for (const claim of confirmed) {
    const activeClaims = await countActiveClaimsForDepartment(
      env,
      claim.resource_key,
      claim.resource_id,
    )
    await loadPersistedClaimedDepartment(env, claim.resource_key, claim.resource_id,
      activeClaims > 0 ? 1 : claim.preserve_on_release === 1 ? null : 0)
  }
  return confirmed
}

async function renewAfterRegistryCall(
  env: Env,
  operation: OperationRow,
  expectedStates: readonly [AddonState, AddonState],
  moduleKey: string,
  departmentId: string,
  pendingActivationClaim?: OwnershipRow,
): Promise<void> {
  try {
    await renewOperationLease(env, operation, expectedStates)
  } catch (error) {
    if (error instanceof FenceLostError) {
      if (pendingActivationClaim) {
        const releasedAt = leaseWindow().now
        await env.DB.prepare(`
          UPDATE addon_resource_ownership
             SET active = 0, released_at = ?1
           WHERE id = ?2 AND tenant = ?3 AND installation_id = ?4
             AND resource_type = 'department' AND resource_id = ?5
             AND resource_key = ?6 AND ownership_mode = 'co_owner' AND active = 1
             AND EXISTS (
               SELECT 1 FROM addon_operations AS operation
                WHERE operation.id = ?7 AND operation.tenant = ?3
                  AND operation.installation_id = ?4
                  AND operation.action = 'activate' AND operation.target_state = 'active'
                  AND operation.current_step = ?8 AND operation.status = 'running'
                  AND operation.actor_id = ?9 AND operation.lease_token = ?10
             )
             AND EXISTS (
               SELECT 1 FROM addon_installations AS installation
                WHERE installation.id = ?4 AND installation.tenant = ?3
                  AND installation.state <> 'active'
             )
        `).bind(
          releasedAt,
          pendingActivationClaim.id,
          env.TENANT_SLUG,
          operation.installation_id,
          pendingActivationClaim.resource_id,
          pendingActivationClaim.resource_key,
          operation.id,
          operation.current_step,
          operation.actor_id,
          operation.lease_token,
        ).run()
      }
      await compensateDepartmentForOwnership(
        env,
        moduleKey,
        departmentId,
        pendingActivationClaim?.preserve_on_release === 1,
      )
    }
    throw error
  }
}

async function deactivateIfUnowned(
  env: Env,
  installationId: string,
  operation: OperationRow,
  claim: OwnershipRow,
  deps: AddonLifecycleDeps,
): Promise<boolean> {
  const department = await loadPersistedClaimedDepartment(
    env,
    claim.resource_key,
    claim.resource_id,
    null,
  )
  validateDepartmentClaim(env, installationId, claim.resource_key, department, claim)
  if (claim.preserve_on_release === 1) return false
  if (await countOtherActiveClaims(env, claim) > 0) return false

  await deps.beforeDepartmentDeactivated?.({
    installationId,
    operationId: operation.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  await renewOperationLease(env, operation, ['disabled', 'disabled'])
  if (await countOtherActiveClaims(env, claim) > 0) return false

  await renewOperationLease(env, operation, ['disabled', 'disabled'])
  await setPersistedClaimedDepartmentActive(env, claim.resource_key, claim.resource_id, 0)
  await deps.afterDepartmentDeactivated?.({
    installationId,
    operationId: operation.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  await renewAfterRegistryCall(
    env,
    operation,
    ['disabled', 'disabled'],
    claim.resource_key,
    claim.resource_id,
  )
  if (await countOtherActiveClaims(env, claim) > 0) {
    await reconcileDepartmentForOwnership(
      env,
      claim.resource_key,
      claim.resource_id,
      {
        excludedInstallationId: installationId,
        operation,
        expectedStates: ['disabled', 'disabled'],
      },
    )
    return false
  }
  await loadPersistedClaimedDepartment(env, claim.resource_key, claim.resource_id, 0)
  return true
}

async function releaseDepartmentClaim(
  env: Env,
  installationId: string,
  operation: OperationRow,
  claim: OwnershipRow,
  deps: AddonLifecycleDeps,
): Promise<void> {
  const department = await loadPersistedClaimedDepartment(
    env,
    claim.resource_key,
    claim.resource_id,
    null,
  )
  validateDepartmentClaim(env, installationId, claim.resource_key, department, claim)
  await deps.beforeOwnershipReleased?.({
    installationId,
    operationId: operation.id,
    claimId: claim.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  await renewOperationLease(env, operation, ['disabled', 'disabled'])

  const now = leaseWindow().now
  const result = await env.DB.prepare(`
    UPDATE addon_resource_ownership
       SET active = 0, released_at = ?1
     WHERE id = ?2 AND tenant = ?3 AND installation_id = ?4
       AND resource_type = ?5 AND resource_id = ?6
       AND resource_key = ?7 AND ownership_mode = 'co_owner' AND active = 1
       AND EXISTS (
         SELECT 1 FROM addon_operations AS operation
          WHERE operation.id = ?8 AND operation.tenant = ?3
            AND operation.installation_id = ?4
            AND operation.action = 'disable' AND operation.target_state = 'disabled'
            AND operation.current_step = ?9 AND operation.status = 'running'
            AND operation.actor_id = ?10 AND operation.lease_token = ?11
            AND operation.lease_expires_at > ?12
       )
       AND EXISTS (
         SELECT 1 FROM addon_installations AS installation
          WHERE installation.id = ?4 AND installation.tenant = ?3
            AND installation.state = 'disabled'
       )
  `).bind(
    now,
    claim.id,
    env.TENANT_SLUG,
    installationId,
    claim.resource_type,
    claim.resource_id,
    claim.resource_key,
    operation.id,
    operation.current_step,
    operation.actor_id,
    operation.lease_token,
    now,
  ).run()
  if (!written(result)) {
    await renewOperationLease(env, operation, ['disabled', 'disabled'])
    const raced = await loadOwnershipClaimById(env, installationId, claim.id)
    if (!raced || raced.active !== 0) throw new Error('addon department ownership release failed')
    validateDepartmentClaim(env, installationId, claim.resource_key, department, raced)
  }

  await deps.afterOwnershipReleased?.({
    installationId,
    operationId: operation.id,
    claimId: claim.id,
    moduleKey: claim.resource_key,
    departmentId: claim.resource_id,
  })
  await renewAfterRegistryCall(
    env,
    operation,
    ['disabled', 'disabled'],
    claim.resource_key,
    claim.resource_id,
    claim,
  )
}

async function ensureDepartmentClaim(
  env: Env,
  installation: AddonInstallation,
  operation: OperationRow,
  moduleKey: string,
  deps: AddonLifecycleDeps,
): Promise<OwnershipRow> {
  const expectedStates = [installation.state, installation.state] as const
  await renewOperationLease(env, operation, expectedStates)
  const existing = await loadDepartmentClaim(env, installation.id, moduleKey)
  let claim: OwnershipRow

  if (existing) {
    validatePersistedDepartmentClaimIdentity(env, installation.id, existing)
    if (existing.active === 1) {
      claim = existing
    } else {
      const now = leaseWindow().now
      const result = await env.DB.prepare(`
        UPDATE addon_resource_ownership
           SET active = 1, released_at = NULL,
               preserve_on_release = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM departments AS department
                    WHERE department.id = ?4 AND department.slug = ?5
                      AND department.template_key = ?5 AND department.active = 1
                 ) AND (
                   NOT EXISTS (
                     SELECT 1 FROM addon_resource_ownership AS other_claim
                      WHERE other_claim.tenant = ?2
                        AND other_claim.resource_type = 'department'
                        AND other_claim.resource_id = ?4
                        AND other_claim.id <> ?1
                        AND other_claim.active = 1
                   ) OR EXISTS (
                     SELECT 1 FROM addon_resource_ownership AS preserving_claim
                      WHERE preserving_claim.tenant = ?2
                        AND preserving_claim.resource_type = 'department'
                        AND preserving_claim.resource_id = ?4
                        AND preserving_claim.id <> ?1
                        AND preserving_claim.active = 1
                        AND preserving_claim.preserve_on_release = 1
                   )
                 ) THEN 1 ELSE 0
               END
         WHERE id = ?1 AND tenant = ?2 AND installation_id = ?3
           AND resource_type = 'department' AND resource_id = ?4
           AND resource_key = ?5 AND ownership_mode = 'co_owner' AND active = 0
           AND EXISTS (
             SELECT 1 FROM addon_operations AS fenced
              WHERE fenced.id = ?6 AND fenced.tenant = ?2 AND fenced.installation_id = ?3
                AND fenced.action = 'activate' AND fenced.target_state = 'active'
                AND fenced.current_step = ?7 AND fenced.status = 'running'
                AND fenced.actor_id = ?8 AND fenced.lease_token = ?9
                AND fenced.lease_expires_at > ?10
           )
           AND EXISTS (
             SELECT 1 FROM addon_installations AS installation
              WHERE installation.id = ?3 AND installation.tenant = ?2
                AND installation.state IN (?11, ?12)
           )
      `).bind(
        existing.id,
        env.TENANT_SLUG,
        installation.id,
        existing.resource_id,
        moduleKey,
        operation.id,
        operation.current_step,
        operation.actor_id,
        operation.lease_token,
        now,
        expectedStates[0],
        expectedStates[1],
      ).run()
      if (!written(result)) throw new FenceLostError()
      const reactivated = await loadOwnershipClaimById(env, installation.id, existing.id)
      if (!reactivated || reactivated.active !== 1) throw new FenceLostError()
      claim = reactivated
    }
  } else {
    const claimId = crypto.randomUUID()
    const resourceId = await departmentIdForClaim(env, moduleKey)
    const createdAt = leaseWindow().now
    const result = await env.DB.prepare(`
      INSERT INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, preserve_on_release, active, created_at
      )
      SELECT ?1, ?2, ?3, 'department', ?4, ?5, 'co_owner',
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM departments AS department
                  WHERE department.id = ?4 AND department.slug = ?5
                    AND department.template_key = ?5 AND department.active = 1
               ) AND (
                 NOT EXISTS (
                   SELECT 1 FROM addon_resource_ownership AS other_claim
                    WHERE other_claim.tenant = ?2
                      AND other_claim.resource_type = 'department'
                      AND other_claim.resource_id = ?4
                      AND other_claim.active = 1
                 ) OR EXISTS (
                   SELECT 1 FROM addon_resource_ownership AS preserving_claim
                    WHERE preserving_claim.tenant = ?2
                      AND preserving_claim.resource_type = 'department'
                      AND preserving_claim.resource_id = ?4
                      AND preserving_claim.active = 1
                      AND preserving_claim.preserve_on_release = 1
                 )
               ) THEN 1 ELSE 0
             END,
             1, ?6
       WHERE EXISTS (
         SELECT 1 FROM addon_operations AS fenced
          WHERE fenced.id = ?7 AND fenced.tenant = ?2 AND fenced.installation_id = ?3
            AND fenced.action = 'activate' AND fenced.target_state = 'active'
            AND fenced.current_step = ?8 AND fenced.status = 'running'
            AND fenced.actor_id = ?9 AND fenced.lease_token = ?10
            AND fenced.lease_expires_at > ?11
       )
       AND EXISTS (
         SELECT 1 FROM addon_installations AS installation
          WHERE installation.id = ?3 AND installation.tenant = ?2
            AND installation.state IN (?12, ?13)
       )
    `).bind(
      claimId,
      env.TENANT_SLUG,
      installation.id,
      resourceId,
      moduleKey,
      createdAt,
      operation.id,
      operation.current_step,
      operation.actor_id,
      operation.lease_token,
      createdAt,
      expectedStates[0],
      expectedStates[1],
    ).run()
    if (!written(result)) throw new FenceLostError()
    const inserted = await loadOwnershipClaimById(env, installation.id, claimId)
    if (!inserted || inserted.active !== 1) throw new FenceLostError()
    claim = inserted
  }

  await renewOperationLease(env, operation, expectedStates)
  const activated = await activateCanonicalDepartment(env, moduleKey, claim.resource_id)
  validateDepartmentClaim(env, installation.id, moduleKey, activated, claim)
  await deps.afterDepartmentActivated?.({
    installationId: installation.id,
    operationId: operation.id,
    moduleKey,
    departmentId: activated.id,
  })
  await renewAfterRegistryCall(env, operation, expectedStates, moduleKey, activated.id, claim)

  const confirmed = await activateCanonicalDepartment(env, moduleKey, claim.resource_id)
  await renewAfterRegistryCall(env, operation, expectedStates, moduleKey, confirmed.id, claim)
  validateDepartmentClaim(env, installation.id, moduleKey, confirmed, claim)
  return claim
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

export async function countAddonOwnershipClaims(env: Env, installationId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
      FROM addon_resource_ownership
     WHERE tenant = ?1 AND installation_id = ?2
  `).bind(env.TENANT_SLUG, installationId).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

function validDepartmentStateRow(value: unknown): value is DepartmentStateRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = [
    'id',
    'slug',
    'name',
    'created_at',
    'template_key',
    'template_version',
    'activated_at',
    'active',
    'seed_receipt',
  ]
  const nullableStrings = ['template_key', 'template_version', 'activated_at', 'seed_receipt']
  return Object.keys(row).length === keys.length
    && keys.every((key) => Object.hasOwn(row, key))
    && typeof row.id === 'string'
    && typeof row.slug === 'string'
    && typeof row.name === 'string'
    && typeof row.created_at === 'string'
    && nullableStrings.every((key) => row[key] === null || typeof row[key] === 'string')
    && (row.active === 0 || row.active === 1)
}

export async function getDepartmentStateSha256(env: Env): Promise<string> {
  const result = await env.DB.prepare(`
    SELECT id, slug, name, created_at, template_key, template_version,
           activated_at, active, seed_receipt
      FROM departments
     ORDER BY id ASC
  `).all<DepartmentStateRow>()
  const rows = result.results ?? []
  const ids = new Set<string>()
  const canonicalRows = rows.map((row) => {
    if (!validDepartmentStateRow(row) || ids.has(row.id)) {
      throw new Error('invalid department state row')
    }
    ids.add(row.id)
    return [
      row.id,
      row.slug,
      row.name,
      row.created_at,
      row.template_key,
      row.template_version,
      row.activated_at,
      row.active,
      row.seed_receipt,
    ]
  })
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalRows)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const ADDON_INTERNAL_TABLES = new Set([
  'addon_installations',
  'addon_operation_failures',
  'addon_operations',
  'addon_resource_ownership',
  'addon_receipts',
])

function quotedSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function validBusinessColumn(value: unknown): value is BusinessColumnRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const column = value as Record<string, unknown>
  return Number.isSafeInteger(column.cid)
    && typeof column.name === 'string'
    && column.name.length > 0
    && typeof column.type === 'string'
    && (column.notnull === 0 || column.notnull === 1)
    && (column.dflt_value === null || typeof column.dflt_value === 'string')
    && Number.isSafeInteger(column.pk)
    && Number.isSafeInteger(column.hidden)
}

const BUSINESS_EVIDENCE_PAGE_SIZE = 128
const EMPTY_SHA256 = '0'.repeat(64)

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function getBusinessStateSha256(env: Env): Promise<string> {
  const tableResult = await env.DB.prepare(`
    SELECT name
      FROM sqlite_schema
     WHERE type = 'table'
     ORDER BY name ASC
  `).all<BusinessTableRow>()
  const seenTables = new Set<string>()
  const tables = (tableResult.results ?? []).filter((table) => {
    if (typeof table.name !== 'string' || table.name.length === 0 || seenTables.has(table.name)) {
      throw new Error('invalid business table registry')
    }
    seenTables.add(table.name)
    return !table.name.startsWith('sqlite_')
      && !table.name.toLowerCase().startsWith('_cf_')
      && table.name !== 'd1_migrations'
      && !ADDON_INTERNAL_TABLES.has(table.name)
  })

  let databaseChain = EMPTY_SHA256
  let tableCount = 0
  for (const table of tables) {
    const identifier = quotedSqlIdentifier(table.name)
    const columnResult = await env.DB.prepare(`PRAGMA table_xinfo(${identifier})`)
      .all<BusinessColumnRow>()
    const columns = (columnResult.results ?? []).sort((left, right) => left.cid - right.cid)
    if (columns.length === 0 || columns.some((column) => !validBusinessColumn(column))) {
      throw new Error('invalid business table schema')
    }
    const columnNames = new Set<string>()
    for (const column of columns) {
      if (columnNames.has(column.name)) throw new Error('duplicate business table column')
      columnNames.add(column.name)
    }

    const projections = columns.flatMap((column, index) => {
      const columnIdentifier = quotedSqlIdentifier(column.name)
      return [
        `typeof(${columnIdentifier}) AS ${quotedSqlIdentifier(`__type_${index}`)}`,
        `CASE typeof(${columnIdentifier})
           WHEN 'null' THEN NULL
           WHEN 'blob' THEN lower(hex(${columnIdentifier}))
           WHEN 'real' THEN printf('%!.17g', ${columnIdentifier})
           ELSE CAST(${columnIdentifier} AS TEXT)
         END AS ${quotedSqlIdentifier(`__value_${index}`)}`,
      ]
    })
    const orderBy = columns.flatMap((_, index) => [
      quotedSqlIdentifier(`__type_${index}`),
      quotedSqlIdentifier(`__value_${index}`),
    ]).join(', ')
    let rowChain = EMPTY_SHA256
    let rowCount = 0
    let offset = 0
    while (true) {
      const rowResult = await env.DB.prepare(`
        SELECT ${projections.join(', ')}
          FROM ${identifier}
         ORDER BY ${orderBy}
         LIMIT ?1 OFFSET ?2
      `).bind(BUSINESS_EVIDENCE_PAGE_SIZE, offset).all<Record<string, unknown>>()
      const page = (rowResult.results ?? []).map((row) => columns.map((_, index) => {
        const storageType = row[`__type_${index}`]
        const value = row[`__value_${index}`]
        if (
          !['null', 'integer', 'real', 'text', 'blob'].includes(String(storageType))
          || (storageType === 'null' ? value !== null : typeof value !== 'string')
        ) {
          throw new Error('invalid business table row')
        }
        return [storageType, value]
      }))
      if (page.length === 0) break

      const pageDigest = await sha256Json(page)
      rowChain = await sha256Json([rowChain, pageDigest, page.length])
      rowCount += page.length
      offset += page.length
      if (page.length < BUSINESS_EVIDENCE_PAGE_SIZE) break
    }

    const tableDigest = await sha256Json({
      name: table.name,
      columns: columns.map((column) => [
        column.cid,
        column.name,
        column.type,
        column.notnull,
        column.dflt_value,
        column.pk,
        column.hidden,
      ]),
      rowCount,
      rowChain,
    })
    databaseChain = await sha256Json([databaseChain, tableDigest])
    tableCount += 1
  }

  return sha256Json({ algorithm: 'mupot-business-state-v2', tableCount, databaseChain })
}

export async function installAddon(env: Env, actor: AddonActor, key: string): Promise<AddonMutationResult> {
  if (!authorized(actor)) return { ok: false, reason: 'not_authorized' }

  const entry = getRegisteredAddon(key)
  if (!entry) return { ok: false, reason: 'addon_not_registered' }
  try {
    assertAddonRuntimeContract(entry.manifest)
  } catch {
    return { ok: false, reason: 'invalid_state' }
  }
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
  try {
    assertAddonRuntimeContract(entry.manifest)
  } catch {
    return { ok: false, reason: 'invalid_state' }
  }

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
  try {
    assertAddonRuntimeContract(entry.manifest)
  } catch {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }
  if (existing.state === 'active') {
    try {
      await validateActiveDepartmentClaims(env, existing, entry)
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
    return { ok: true, state: existing.state, installation: existing, idempotent: true }
  }
  if (
    (existing.state !== 'configured' && existing.state !== 'disabled')
    || !isZeroAuthority(entry)
  ) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }
  try {
    await validateActiveDepartmentClaims(env, existing, entry)
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  let operation: OperationRow | null = null
  try {
    const acquired = await acquireOperation(
      env,
      existing.id,
      actor.id,
      'activate',
      'active',
      'activate_departments',
      [existing.state, existing.state],
    )
    if (!acquired.ok) {
      return acquired.reason === 'operation_busy'
        ? { ok: false, reason: acquired.reason, state: existing.state }
        : { ok: false, reason: acquired.reason }
    }
    operation = acquired.operation

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
    await validateDepartmentClaimSet(env, existing, entry, claims, true, 1)

    await setOperationStep(
      env,
      operation,
      'activate_transition',
      [existing.state, existing.state],
    )
    const current = await loadInstallationById(env, existing.id)
    if (!current) {
      await assertLiveOperationLease(env, operation)
      throw new Error('addon installation read failed after activation step')
    }
    if (!matchesRegisteredIdentity(current, entry)) {
      await assertLiveOperationLease(env, operation)
      throw new Error('addon installation identity changed after activation step')
    }
    if (current.state === 'active') {
      await assertLiveOperationLease(env, operation)
      throw new Error('addon installation changed outside the owned activation')
    }
    if (current.state !== 'configured' && current.state !== 'disabled') {
      await assertLiveOperationLease(env, operation)
      throw new Error('addon installation entered an invalid activation state')
    }

    const receiptId = crypto.randomUUID()
    const transitionTiming = leaseWindow()
    const activatedAt = transitionTiming.now
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
                  AND operation.lease_token = ?13 AND operation.lease_expires_at > ?14
             )
             AND (
               SELECT COUNT(*) FROM addon_resource_ownership AS claim
                WHERE claim.tenant = addon_installations.tenant
                  AND claim.installation_id = addon_installations.id
                  AND claim.active = 1
             ) = ?15
             AND NOT EXISTS (
               SELECT 1 FROM addon_resource_ownership AS claim
                WHERE claim.tenant = addon_installations.tenant
                  AND claim.installation_id = addon_installations.id
                  AND claim.active = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(?16) AS expected
                     WHERE json_extract(expected.value, '$.id') = claim.id
                       AND json_extract(expected.value, '$.tenant') = claim.tenant
                       AND json_extract(expected.value, '$.installationId') = claim.installation_id
                       AND json_extract(expected.value, '$.resourceType') = claim.resource_type
                       AND json_extract(expected.value, '$.resourceId') = claim.resource_id
                       AND json_extract(expected.value, '$.resourceKey') = claim.resource_key
                       AND json_extract(expected.value, '$.ownershipMode') = claim.ownership_mode
                       AND json_extract(expected.value, '$.preserveOnRelease') = claim.preserve_on_release
                  )
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
          operation.lease_token,
          activatedAt,
          claims.length,
          serializedClaimIdentities(claims),
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
        operationStepStatement(
          env,
          operation,
          'completed',
          'completed',
          ['active', 'active'],
          transitionTiming,
        ),
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
        operation.current_step = 'completed'
        operation.status = 'completed'
        operation.lease_expires_at = transitionTiming.expiresAt
        operation.updated_at = transitionTiming.now
        if (!await loadExactOperation(env, operation, 'completed', 'completed')) {
          throw new FenceLostError()
        }
        const activated = selectedInstallation(results[3])
        return activated
          ? { ok: true, state: activated.state, installation: activated }
          : { ok: false, reason: 'write_failed' }
      }
    } catch (error) {
      return lifecycleOperationFailure(env, operation, error)
    }
  } catch (error) {
    return operation
      ? lifecycleOperationFailure(env, operation, error)
      : lifecycleFailure(error)
  }

  return operation
    ? lifecycleOperationFailure(env, operation, new Error('activation did not complete'))
    : { ok: false, reason: 'write_failed' }
}

export async function disableAddon(
  env: Env,
  actor: AddonActor,
  key: string,
  deps: AddonLifecycleDeps = {},
): Promise<AddonMutationResult> {
  const context = await loadTeardownMutationContext(env, actor, key)
  if (!context.ok) return context.result
  const { installation: existing } = context

  const running = await loadRunningOperation(env, existing.id)
  const failedDisable = await loadFailedOperation(env, existing.id, 'disable', 'disabled')
  if (existing.state === 'disabled' && !running && !failedDisable) {
    try {
      const evidence = await loadCompletedDisableOperationEvidence(env, existing)
      if (!evidence) {
        return { ok: false, reason: 'fence_lost' }
      }
      await repairAndValidatePersistedDisabledDepartmentClaims(env, existing)
      const confirmedEvidence = await loadCompletedDisableOperationEvidence(env, existing)
      if (!confirmedEvidence || confirmedEvidence.id !== evidence.id) {
        return { ok: false, reason: 'fence_lost' }
      }
      return { ok: true, state: existing.state, installation: existing, idempotent: true }
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
  }
  if (
    existing.state !== 'installed'
    && existing.state !== 'configured'
    && existing.state !== 'active'
    && existing.state !== 'disabled'
  ) {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }
  if (running && (running.action !== 'disable' || running.target_state !== 'disabled')) {
    return { ok: false, reason: 'operation_busy', state: existing.state }
  }
  if (existing.state !== 'disabled') {
    try {
      await validatePersistedActiveDepartmentClaims(env, existing)
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
  }

  let operation: OperationRow | null = null
  try {
    const acquired = await acquireOperation(
      env,
      existing.id,
      actor.id,
      'disable',
      'disabled',
      'disable_state',
      [existing.state, existing.state],
    )
    if (!acquired.ok) {
      return acquired.reason === 'operation_busy'
        ? { ok: false, reason: acquired.reason, state: existing.state }
        : { ok: false, reason: acquired.reason }
    }
    operation = acquired.operation

    if (existing.state !== 'disabled') {
      if (operation.current_step !== 'disable_state') throw new FenceLostError()
      const previousState = existing.state
      const activeClaims = await validatePersistedActiveDepartmentClaims(env, existing)
      const receiptId = crypto.randomUUID()
      const transitionTiming = leaseWindow()
      const disabledAt = transitionTiming.now
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
                   latest_previous_state = ?15, latest_actor_id = ?2,
                   latest_receipt_id = ?3, last_error = NULL
             WHERE id = ?4 AND tenant = ?5 AND addon_key = ?6
               AND state = ?15 AND manifest_sha256 = ?7 AND latest_receipt_id = ?8
               AND EXISTS (
                 SELECT 1 FROM addon_operations AS operation
                  WHERE operation.id = ?9
                    AND operation.tenant = addon_installations.tenant
                    AND operation.installation_id = addon_installations.id
                    AND operation.action = 'disable' AND operation.target_state = 'disabled'
                    AND operation.current_step = 'disable_state'
                    AND operation.status = 'running' AND operation.actor_id = ?10
                    AND operation.lease_token = ?11 AND operation.lease_expires_at > ?12
               )
               AND (
                 SELECT COUNT(*) FROM addon_resource_ownership AS claim
                  WHERE claim.tenant = addon_installations.tenant
                    AND claim.installation_id = addon_installations.id
                    AND claim.active = 1
               ) = ?13
               AND NOT EXISTS (
                 SELECT 1 FROM addon_resource_ownership AS claim
                  WHERE claim.tenant = addon_installations.tenant
                    AND claim.installation_id = addon_installations.id
                    AND claim.active = 1
                    AND NOT EXISTS (
                      SELECT 1 FROM json_each(?14) AS expected
                       WHERE json_extract(expected.value, '$.id') = claim.id
                         AND json_extract(expected.value, '$.tenant') = claim.tenant
                         AND json_extract(expected.value, '$.installationId') = claim.installation_id
                         AND json_extract(expected.value, '$.resourceType') = claim.resource_type
                         AND json_extract(expected.value, '$.resourceId') = claim.resource_id
                         AND json_extract(expected.value, '$.resourceKey') = claim.resource_key
                         AND json_extract(expected.value, '$.ownershipMode') = claim.ownership_mode
                         AND json_extract(expected.value, '$.preserveOnRelease') = claim.preserve_on_release
                    )
               )
          `).bind(
            disabledAt,
            operation.actor_id,
            receiptId,
            existing.id,
            env.TENANT_SLUG,
            key,
            existing.manifestSha256,
            existing.latestReceiptId,
            operation.id,
            operation.actor_id,
            operation.lease_token,
            disabledAt,
            activeClaims.length,
            serializedClaimIdentities(activeClaims),
            previousState,
          ),
          transitionReceiptStatement(env, existing, operation, {
            id: receiptId,
            action: 'disable',
            previousState,
            nextState: 'disabled',
            sideEffectIds,
            checks,
            createdAt: disabledAt,
          }),
          operationStepStatement(
            env,
            operation,
            'disable_teardown',
            'running',
            ['disabled', 'disabled'],
            transitionTiming,
          ),
          selectTransitionStatement(
            env,
            existing.id,
            operation,
            previousState,
            'disabled',
            receiptId,
          ),
        ])

        if (!written(results[0]) || !written(results[1]) || !written(results[2])) {
          throw new FenceLostError()
        }
        const selected = selectedInstallation(results[3])
        if (!selected) throw new Error('disabled installation transition was not observable')
        operation.current_step = 'disable_teardown'
        operation.lease_expires_at = transitionTiming.expiresAt
        operation.updated_at = transitionTiming.now
      } catch (error) {
        return lifecycleOperationFailure(env, operation, error)
      }

      await deps.afterInstallationDisabled?.({
        installationId: existing.id,
        operationId: operation.id,
      })
      await renewOperationLease(env, operation, ['disabled', 'disabled'])
    }

    if (operation.current_step.startsWith('disable_claim:')) {
      const pendingClaim = await loadOwnershipClaimById(
        env,
        existing.id,
        operation.current_step.slice('disable_claim:'.length),
      )
      if (!pendingClaim) throw new Error('pending addon ownership claim is missing')
      if (pendingClaim.active === 0) {
        await deactivateIfUnowned(env, existing.id, operation, pendingClaim, deps)
        await setOperationStep(
          env,
          operation,
          'disable_teardown',
          ['disabled', 'disabled'],
        )
      }
    }

    const claims = await loadDepartmentClaims(env, existing.id, true)
    for (const claim of claims) {
      await setOperationStep(
        env,
        operation,
        `disable_claim:${claim.id}`,
        ['disabled', 'disabled'],
      )
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
      await setOperationStep(
        env,
        operation,
        'disable_teardown',
        ['disabled', 'disabled'],
      )
    }

    await repairAndValidatePersistedDisabledDepartmentClaims(env, existing, {
      operation,
      expectedStates: ['disabled', 'disabled'],
    })

    await deps.beforeOperationCompleted?.({
      installationId: existing.id,
      operationId: operation.id,
    })
    const completedOperation = await completeOperation(env, operation, 'disabled')

    const completedInstallation = await loadInstallationById(env, existing.id)
    if (
      !completedInstallation
      || completedInstallation.state !== 'disabled'
      || !matchesPersistedIdentity(completedInstallation, existing)
    ) {
      throw new FenceLostError()
    }
    const evidence = await loadCompletedDisableOperationEvidence(env, completedInstallation)
    if (!evidence || evidence.id !== completedOperation.id) throw new FenceLostError()
    await repairAndValidatePersistedDisabledDepartmentClaims(env, completedInstallation)
    const confirmedEvidence = await loadCompletedDisableOperationEvidence(env, completedInstallation)
    if (!confirmedEvidence || confirmedEvidence.id !== completedOperation.id) throw new FenceLostError()

    return { ok: true, state: completedInstallation.state, installation: completedInstallation }
  } catch (error) {
    return operation
      ? lifecycleOperationFailure(env, operation, error)
      : lifecycleFailure(error)
  }
}

export async function archiveAddon(
  env: Env,
  actor: AddonActor,
  key: string,
): Promise<AddonMutationResult> {
  if (!authorized(actor)) return { ok: false, reason: 'not_authorized' }

  const live = await loadLiveInstallation(env, key)
  if (!live) {
    const archived = await loadLatestArchivedInstallation(env, key)
    if (archived) {
      try {
        const evidence = await loadCompletedArchiveOperationEvidence(env, archived)
        return evidence
          ? { ok: true, state: 'archived', installation: archived, idempotent: true }
          : { ok: false, reason: 'fence_lost' }
      } catch {
        return { ok: false, reason: 'write_failed' }
      }
    }
  }

  const context = await loadTeardownMutationContext(env, actor, key)
  if (!context.ok) return context.result
  const { installation: existing } = context
  if (existing.state !== 'disabled') {
    return { ok: false, reason: 'invalid_state', state: existing.state }
  }

  const running = await loadRunningOperation(env, existing.id)
  if (running && (running.action !== 'archive' || running.target_state !== 'archived')) {
    return { ok: false, reason: 'operation_busy', state: existing.state }
  }
  let disableEvidence: OperationRow | null = null
  let retainedClaims: OwnershipRow[] = []
  try {
    const evidence = await loadCompletedDisableOperationEvidence(env, existing)
    if (!evidence) {
      return { ok: false, reason: 'fence_lost' }
    }
    retainedClaims = await repairAndValidatePersistedDisabledDepartmentClaims(env, existing)
    const confirmedEvidence = await loadCompletedDisableOperationEvidence(env, existing)
    if (!confirmedEvidence || confirmedEvidence.id !== evidence.id) {
      return { ok: false, reason: 'fence_lost' }
    }
    disableEvidence = confirmedEvidence
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
  if (!disableEvidence) return { ok: false, reason: 'fence_lost' }

  let operation: OperationRow | null = null
  try {
    const acquired = await acquireOperation(
      env,
      existing.id,
      actor.id,
      'archive',
      'archived',
      'archive_transition',
      ['disabled', 'disabled'],
    )
    if (!acquired.ok) {
      return acquired.reason === 'operation_busy'
        ? { ok: false, reason: acquired.reason, state: existing.state }
        : { ok: false, reason: acquired.reason }
    }
    operation = acquired.operation

    const receiptId = crypto.randomUUID()
    const transitionTiming = leaseWindow()
    const archivedAt = transitionTiming.now
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
                  AND operation.lease_token = ?11 AND operation.lease_expires_at > ?12
             )
             AND EXISTS (
               SELECT 1 FROM addon_operations AS disable_operation
                WHERE disable_operation.id = ?13
                  AND disable_operation.tenant = addon_installations.tenant
                  AND disable_operation.installation_id = addon_installations.id
                  AND disable_operation.action = 'disable'
                  AND disable_operation.target_state = 'disabled'
                  AND disable_operation.current_step = 'completed'
                  AND disable_operation.status = 'completed'
                  AND disable_operation.actor_id = ?14
                  AND disable_operation.lease_token = ?15
                  AND disable_operation.lease_expires_at = ?16
                  AND disable_operation.created_at = ?17
                  AND disable_operation.updated_at = ?18
             )
             AND EXISTS (
               SELECT 1 FROM addon_receipts AS disable_receipt
                WHERE disable_receipt.id = addon_installations.latest_receipt_id
                  AND disable_receipt.tenant = addon_installations.tenant
                  AND disable_receipt.installation_id = addon_installations.id
                  AND disable_receipt.action = 'disable'
                  AND disable_receipt.previous_state = ?21
                  AND disable_receipt.next_state = 'disabled'
                  AND disable_receipt.actor_id = ?14
                  AND disable_receipt.outcome = 'pass'
                  AND json_extract(disable_receipt.checks, '$.operationId') = ?13
             )
             AND (
               SELECT COUNT(*) FROM addon_resource_ownership AS claim
                WHERE claim.tenant = addon_installations.tenant
                  AND claim.installation_id = addon_installations.id
             ) = ?19
             AND NOT EXISTS (
               SELECT 1 FROM addon_resource_ownership AS claim
                WHERE claim.tenant = addon_installations.tenant
                  AND claim.installation_id = addon_installations.id
                  AND (
                    claim.active <> 0
                    OR NOT EXISTS (
                      SELECT 1 FROM json_each(?20) AS expected
                       WHERE json_extract(expected.value, '$.id') = claim.id
                         AND json_extract(expected.value, '$.tenant') = claim.tenant
                         AND json_extract(expected.value, '$.installationId') = claim.installation_id
                         AND json_extract(expected.value, '$.resourceType') = claim.resource_type
                         AND json_extract(expected.value, '$.resourceId') = claim.resource_id
                         AND json_extract(expected.value, '$.resourceKey') = claim.resource_key
                         AND json_extract(expected.value, '$.ownershipMode') = claim.ownership_mode
                         AND json_extract(expected.value, '$.preserveOnRelease') = claim.preserve_on_release
                    )
                  )
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?20) AS expected
                WHERE NOT EXISTS (
                  SELECT 1 FROM addon_resource_ownership AS claim
                   WHERE claim.id = json_extract(expected.value, '$.id')
                     AND claim.tenant = json_extract(expected.value, '$.tenant')
                     AND claim.installation_id = json_extract(expected.value, '$.installationId')
                     AND claim.resource_type = json_extract(expected.value, '$.resourceType')
                     AND claim.resource_id = json_extract(expected.value, '$.resourceId')
                     AND claim.resource_key = json_extract(expected.value, '$.resourceKey')
                     AND claim.ownership_mode = json_extract(expected.value, '$.ownershipMode')
                     AND claim.preserve_on_release = json_extract(expected.value, '$.preserveOnRelease')
                     AND claim.active = 0
                )
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
          existing.manifestSha256,
          existing.latestReceiptId,
          operation.id,
          operation.actor_id,
          operation.lease_token,
          archivedAt,
          disableEvidence.id,
          disableEvidence.actor_id,
          disableEvidence.lease_token,
          disableEvidence.lease_expires_at,
          disableEvidence.created_at,
          disableEvidence.updated_at,
          retainedClaims.length,
          serializedClaimIdentities(retainedClaims),
          existing.latestPreviousState,
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
        operationStepStatement(
          env,
          operation,
          'completed',
          'completed',
          ['archived', 'archived'],
          transitionTiming,
        ),
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
        operation.current_step = 'completed'
        operation.status = 'completed'
        operation.lease_expires_at = transitionTiming.expiresAt
        operation.updated_at = transitionTiming.now
        if (!await loadExactOperation(env, operation, 'completed', 'completed')) {
          throw new FenceLostError()
        }
        const archived = selectedInstallation(results[3])
        return archived
          ? { ok: true, state: archived.state, installation: archived }
          : { ok: false, reason: 'write_failed' }
      }
    } catch (error) {
      return lifecycleOperationFailure(env, operation, error)
    }
  } catch (error) {
    return operation
      ? lifecycleOperationFailure(env, operation, error)
      : lifecycleFailure(error)
  }

  return operation
    ? lifecycleOperationFailure(env, operation, new Error('archive did not complete'))
    : { ok: false, reason: 'write_failed' }
}
