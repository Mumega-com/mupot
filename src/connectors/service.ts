// mupot — connector credential service (issue #116).
//
// This is the SINGLE write/resolve path for connector credentials.
// Security discipline (same as members/service.ts for tokens):
//   - encrypted_secret is NEVER SELECT-ed outside resolveConnector().
//   - list/get queries return type, label, scope, masked hint ONLY.
//   - The decrypted secret is used only at call-time; never returned to callers,
//     never stored in variables beyond the immediate tool call.
//   - Every add / rotate / revoke is recorded in connector_audit (append-only).
//   - isAdmin is enforced at the ROUTE layer; this layer does NOT re-check it
//     (same discipline as mintMemberToken — caller is responsible for gating).
//
// Caller contract:
//   addConnector()      — encrypt + store, returns public row (no secret)
//   rotateConnector()   — re-encrypt new secret in-place, returns public row
//   revokeConnector()   — set revoked_at, idempotent, returns boolean
//   listConnectors()    — list rows: type/label/scope/last4 hint, NO encrypted_secret
//   resolveConnector()  — ONLY path that decrypts; returns plaintext or null

import type { Env } from '../types'
import {
  encryptConnectorSecret,
  decryptConnectorSecret,
  secretLast4,
  isConnectorType,
  isConnectorScopeType,
} from './crypto'
import type { ConnectorType, ConnectorScopeType } from './crypto'

export type { ConnectorType, ConnectorScopeType }

// ── shapes ────────────────────────────────────────────────────────────────────

/** What is stored in D1 (encrypted_secret included — never SELECT-ed in lists). */
export interface ConnectorRow {
  id: string
  tenant: string
  type: ConnectorType
  label: string
  encrypted_secret: string
  meta: string | null
  scope_type: ConnectorScopeType
  scope_id: string | null
  created_by: string
  created_at: string
  revoked_at: string | null
}

/** Safe public shape — secret is NEVER present, hint is last-4 of the original secret. */
export interface PublicConnector {
  id: string
  tenant: string
  type: ConnectorType
  label: string
  hint: string // last 4 chars of the secret — masked display only
  meta: string | null
  scope_type: ConnectorScopeType
  scope_id: string | null
  created_by: string
  created_at: string
  revoked_at: string | null
}

export interface AddConnectorParams {
  type: ConnectorType
  label: string
  secret: string // raw — will be encrypted then discarded
  meta?: string | null
  scope_type: ConnectorScopeType
  scope_id?: string | null
  created_by: string
}

export type AddConnectorResult =
  | { ok: true; connector: PublicConnector }
  | { ok: false; error: string }

export type RotateConnectorResult =
  | { ok: true; connector: PublicConnector }
  | { ok: false; error: string }

// ── master-key guard ─────────────────────────────────────────────────────────

/**
 * Retrieve the master encryption key from env. Fail-closed: throws if absent.
 * Deploy prereq: `npx wrangler secret put CONNECTOR_MASTER_KEY`
 */
function getMasterKey(env: Env): string {
  const key = env.CONNECTOR_MASTER_KEY
  if (!key) {
    throw new Error(
      'connector-service: CONNECTOR_MASTER_KEY secret is not set. ' +
        'Deploy prerequisite: `npx wrangler secret put CONNECTOR_MASTER_KEY` ' +
        '(64-char hex, 32 bytes). See wrangler.toml comments for setup.',
    )
  }
  return key
}

// ── audit helper ─────────────────────────────────────────────────────────────

async function writeAudit(
  env: Env,
  connectorId: string,
  action: 'add' | 'rotate' | 'revoke',
  actorId: string,
  detail?: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO connector_audit (id, connector_id, tenant, action, actor_id, detail, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      connectorId,
      env.TENANT_SLUG,
      action,
      actorId,
      detail ?? null,
      new Date().toISOString(),
    )
    .run()
}

// ── add ──────────────────────────────────────────────────────────────────────

/**
 * Add a new connector. Encrypts secret before storage. Returns a public row
 * (no secret). The caller MUST have verified isAdmin before calling this.
 *
 * The raw secret is encrypted to ciphertext and then is not accessible via any
 * read path. The last-4 hint is derived from the raw secret BEFORE encryption
 * and stored only in the `hint` field of the returned PublicConnector (never persisted).
 *
 * Note: hint is NOT stored in D1 — it is computed at add/rotate time and
 * returned once in the result. List calls do not show the hint (use rotate to update).
 * This is intentional: storing even a masked hint in D1 creates a read-back surface.
 */
export async function addConnector(
  env: Env,
  params: AddConnectorParams,
): Promise<AddConnectorResult> {
  const { type, label, secret, meta, scope_type, scope_id, created_by } = params

  if (!isConnectorType(type)) return { ok: false, error: 'invalid_type' }
  if (!isConnectorScopeType(scope_type)) return { ok: false, error: 'invalid_scope_type' }
  if (!label.trim()) return { ok: false, error: 'label_required' }
  if (!secret.trim()) return { ok: false, error: 'secret_required' }
  if (!created_by) return { ok: false, error: 'created_by_required' }

  // scope_id must be present for squad/agent scope
  if ((scope_type === 'squad' || scope_type === 'agent') && !scope_id) {
    return { ok: false, error: 'scope_id_required' }
  }

  // Validate scope_id exists in this pot's D1 (tenant-scope enforcement)
  if (scope_type === 'squad' && scope_id) {
    const row = await env.DB.prepare(`SELECT id FROM squads WHERE id = ?1 LIMIT 1`)
      .bind(scope_id)
      .first<{ id: string }>()
    if (!row) return { ok: false, error: 'squad_not_found' }
  }
  if (scope_type === 'agent' && scope_id) {
    const row = await env.DB.prepare(`SELECT id FROM agents WHERE id = ?1 LIMIT 1`)
      .bind(scope_id)
      .first<{ id: string }>()
    if (!row) return { ok: false, error: 'agent_not_found' }
  }

  const masterKey = getMasterKey(env)
  const id = crypto.randomUUID()
  const hint = secretLast4(secret)
  const encryptedSecret = await encryptConnectorSecret(masterKey, id, type, secret)
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO connectors
       (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      type,
      label.trim(),
      encryptedSecret,
      meta ?? null,
      scope_type,
      scope_id ?? null,
      created_by,
      now,
    )
    .run()

  await writeAudit(env, id, 'add', created_by, JSON.stringify({ type, label: label.trim(), scope_type }))

  return {
    ok: true,
    connector: {
      id,
      tenant: env.TENANT_SLUG,
      type,
      label: label.trim(),
      hint,
      meta: meta ?? null,
      scope_type,
      scope_id: scope_id ?? null,
      created_by,
      created_at: now,
      revoked_at: null,
    },
  }
}

// ── rotate ───────────────────────────────────────────────────────────────────

/**
 * Re-encrypt a connector's secret. The old encrypted_secret is overwritten.
 * The caller MUST have verified isAdmin. Returns public row (no secret).
 */
export async function rotateConnector(
  env: Env,
  connectorId: string,
  newSecret: string,
  actorId: string,
): Promise<RotateConnectorResult> {
  if (!newSecret.trim()) return { ok: false, error: 'secret_required' }

  // Load the row — using only safe columns (no encrypted_secret)
  const row = await env.DB.prepare(
    `SELECT id, tenant, type, label, meta, scope_type, scope_id, created_by, created_at, revoked_at
       FROM connectors
      WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(connectorId, env.TENANT_SLUG)
    .first<Omit<ConnectorRow, 'encrypted_secret'>>()

  if (!row) return { ok: false, error: 'not_found' }
  if (row.revoked_at) return { ok: false, error: 'already_revoked' }

  const masterKey = getMasterKey(env)
  const hint = secretLast4(newSecret)
  const encryptedSecret = await encryptConnectorSecret(masterKey, connectorId, row.type, newSecret)

  await env.DB.prepare(
    `UPDATE connectors SET encrypted_secret = ?1 WHERE id = ?2 AND tenant = ?3`,
  )
    .bind(encryptedSecret, connectorId, env.TENANT_SLUG)
    .run()

  await writeAudit(env, connectorId, 'rotate', actorId)

  return {
    ok: true,
    connector: {
      id: row.id,
      tenant: row.tenant,
      type: row.type,
      label: row.label,
      hint,
      meta: row.meta,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      created_by: row.created_by,
      created_at: row.created_at,
      revoked_at: null,
    },
  }
}

// ── revoke ───────────────────────────────────────────────────────────────────

/**
 * Revoke a connector (set revoked_at). Idempotent: returns false if already
 * revoked or not found. The caller MUST have verified isAdmin.
 */
export async function revokeConnector(
  env: Env,
  connectorId: string,
  actorId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE connectors
        SET revoked_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), connectorId, env.TENANT_SLUG)
    .run()

  const changed = Boolean(res.meta?.changes && res.meta.changes > 0)
  if (changed) {
    await writeAudit(env, connectorId, 'revoke', actorId)
  }
  return changed
}

// ── list ─────────────────────────────────────────────────────────────────────

/** List row shape for the admin list view — NO encrypted_secret, NO hint. */
export interface ConnectorListRow {
  id: string
  type: ConnectorType
  label: string
  meta: string | null
  scope_type: ConnectorScopeType
  scope_id: string | null
  created_by: string
  created_at: string
  revoked_at: string | null
}

export interface ConnectorSafeMeta {
  id: string
  type: ConnectorType
  label: string
  meta: string | null
  scopeType: ConnectorScopeType
  scopeId: string | null
  createdAt: string
}

interface ConnectorSafeMetaRow {
  id: string
  type: ConnectorType
  label: string
  meta: string | null
  scope_type: ConnectorScopeType
  scope_id: string | null
  created_at: string
}

/** Resolve non-secret metadata for one active connector by exact tenant-local ID. */
export async function resolveConnectorByIdWithMeta(
  env: Env,
  connectorId: string,
): Promise<ConnectorSafeMeta | null> {
  if (!connectorId) return null
  const row = await env.DB.prepare(`
    SELECT id, type, label, meta, scope_type, scope_id, created_at
      FROM connectors
     WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL
     LIMIT 1
  `).bind(connectorId, env.TENANT_SLUG).first<ConnectorSafeMetaRow>()
  if (!row || !isConnectorType(row.type) || !isConnectorScopeType(row.scope_type)) return null
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    meta: row.meta,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    createdAt: row.created_at,
  }
}

/**
 * List active (non-revoked) connectors for this pot.
 * encrypted_secret is NEVER selected. This is enforced in the SQL query.
 */
export async function listConnectors(env: Env): Promise<ConnectorListRow[]> {
  const rows = await env.DB.prepare(
    // SECURITY: SELECT list explicitly excludes encrypted_secret.
    // Do not add encrypted_secret here — it breaks the write-only invariant.
    `SELECT id, type, label, meta, scope_type, scope_id, created_by, created_at, revoked_at
       FROM connectors
      WHERE tenant = ?1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(env.TENANT_SLUG)
    .all<ConnectorListRow>()
  return rows.results ?? []
}

// ── resolve (the ONLY decrypt path) ─────────────────────────────────────────

/**
 * Resolve a connector credential for use at call-time.
 *
 * This is the ONLY function that may SELECT encrypted_secret from D1, and
 * the ONLY path that decrypts. The decrypted secret MUST be used immediately
 * for the outbound tool call and never returned to any caller or stored.
 *
 * Returns null when:
 *   - No active connector exists for (tenant, scope context, type)
 *   - The connector is revoked
 *   - The master key is absent (fail-closed)
 *   - Decryption fails (fail-closed)
 *
 * Scope resolution order:
 *   1. Exact agent scope (scope_type='agent', scope_id=agentOrSquadId)
 *   2. Exact squad scope (scope_type='squad', scope_id=agentOrSquadId)
 *   3. Pot-wide scope (scope_type='pot')
 *
 * @param env            Worker env
 * @param agentOrSquadId The agent id or squad id requesting the credential
 * @param type           The connector type needed (e.g. 'telegram')
 * @returns              Decrypted secret string, or null if unavailable
 */
export async function resolveConnector(
  env: Env,
  agentOrSquadId: string,
  type: ConnectorType,
): Promise<string | null> {
  if (!isConnectorType(type)) return null

  const masterKey = env.CONNECTOR_MASTER_KEY
  if (!masterKey) return null // fail-closed: no key = no decrypt

  // Look up the most specific active connector in scope order.
  // SECURITY: encrypted_secret IS selected here — ONLY here.
  // This query deliberately uses a priority ordering so agent > squad > pot.
  const row = await env.DB.prepare(
    `SELECT id, type, encrypted_secret
       FROM connectors
      WHERE tenant = ?1
        AND type = ?2
        AND revoked_at IS NULL
        AND (
              (scope_type = 'agent' AND scope_id = ?3)
           OR (scope_type = 'squad' AND scope_id = ?3)
           OR  scope_type = 'pot'
            )
      ORDER BY CASE scope_type
                 WHEN 'agent' THEN 1
                 WHEN 'squad' THEN 2
                 ELSE 3
               END
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, type, agentOrSquadId)
    .first<{ id: string; type: ConnectorType; encrypted_secret: string }>()

  if (!row) return null

  try {
    // Decrypt in-place. The plaintext is returned to the caller who MUST use it
    // immediately for the outbound call. It must not be stored, logged, or returned
    // in any HTTP response.
    return await decryptConnectorSecret(masterKey, row.id, row.type, row.encrypted_secret)
  } catch {
    // Decryption failure is fatal (corrupted ciphertext, wrong key, etc.).
    // Return null → the caller treats the connector as unavailable.
    return null
  }
}

/**
 * Resolve a connector credential AND its non-secret `meta` field together.
 *
 * Same scope-priority query + fail-closed discipline as resolveConnector() (agent >
 * squad > pot; no master key or no row or decrypt-failure → null) — added (#370) for
 * connector types whose adapter needs more than one field (e.g. 'mcpwp': the WordPress
 * application-password is the encrypted secret, but siteUrl + username are non-secret
 * per-connector config carried in `meta`, exactly like the Telegram connector's
 * allowed_chats). resolveConnector() itself is UNTOUCHED — this is an additive sibling,
 * not a replacement, so every existing single-secret caller (inkwell, telegram, …) is
 * unaffected.
 *
 * @returns { secret, meta } or null if unavailable (same null conditions as resolveConnector).
 */
export async function resolveConnectorWithMeta(
  env: Env,
  agentOrSquadId: string,
  type: ConnectorType,
): Promise<{ secret: string; meta: string | null } | null> {
  if (!isConnectorType(type)) return null

  const masterKey = env.CONNECTOR_MASTER_KEY
  if (!masterKey) return null // fail-closed: no key = no decrypt

  // Identical scope-priority query to resolveConnector(), plus `meta` in the SELECT.
  const row = await env.DB.prepare(
    `SELECT id, type, encrypted_secret, meta
       FROM connectors
      WHERE tenant = ?1
        AND type = ?2
        AND revoked_at IS NULL
        AND (
              (scope_type = 'agent' AND scope_id = ?3)
           OR (scope_type = 'squad' AND scope_id = ?3)
           OR  scope_type = 'pot'
            )
      ORDER BY CASE scope_type
                 WHEN 'agent' THEN 1
                 WHEN 'squad' THEN 2
                 ELSE 3
               END
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, type, agentOrSquadId)
    .first<{ id: string; type: ConnectorType; encrypted_secret: string; meta: string | null }>()

  if (!row) return null

  try {
    const secret = await decryptConnectorSecret(masterKey, row.id, row.type, row.encrypted_secret)
    return { secret, meta: row.meta }
  } catch {
    // Decryption failure is fatal (corrupted ciphertext, wrong key, etc.).
    return null
  }
}

// ── Telegram helpers ─────────────────────────────────────────────────────────

/**
 * Parse the allowed_chats list from a Telegram connector's meta field.
 * Returns [] if meta is absent or not a valid JSON array.
 */
export function telegramAllowedChats(meta: string | null): string[] {
  if (!meta) return []
  try {
    const parsed = JSON.parse(meta)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/**
 * Check whether a chat_id is in the allowed list for a Telegram connector.
 * Returns true when no allowed list is configured (open) or when the chat is listed.
 */
export function isTelegramChatAllowed(meta: string | null, chatId: string): boolean {
  const allowed = telegramAllowedChats(meta)
  if (allowed.length === 0) return true // no restriction configured = open
  return allowed.includes(chatId)
}
