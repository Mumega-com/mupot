// mupot - secure-drop persistence (migration 0213): host keys, credential requests, sealed ciphertext.
//
// THIS MODULE HAS NO DECRYPT PATH AND NEVER SEES PLAINTEXT. It stores `enc` and `ct` (base64url strings the
// browser produced) and their sha256, and deletes them on ack/revoke/expiry. tests/secure-drop.test.ts asserts the
// secure-drop modules import nothing able to open HPKE.
//
// Every state change is ONE guarded statement (or a batch whose later statements are anchored on `changes() = 1`);
// callers trust only meta.changes, never a prior read. Receipts go to mutation_audit_entries and carry ids,
// names, fingerprints and the ciphertext DIGEST only (the evidence type below cannot hold anything else).
import type { Env } from '../types'
import { b64uDecode, b64uEncode, hex, sha256 } from '../secure-moments/webauthn'
import { tokenHash } from '../secure-moments/store'
import { DROP_MAX_OPEN_PER_AGENT, DROP_RETAIN_MS } from './config'
import type { ParsedHostKey } from './keys'

export interface HostKeyRow {
  id: string
  tenant: string
  agent_id: string
  public_key_b64u: string
  fingerprint: string
  created_at: string
  revoked_at: string | null
}
const HOST_KEY_COLUMNS = 'id, tenant, agent_id, public_key_b64u, fingerprint, created_at, revoked_at'

export type DropStatus = 'requested' | 'ready' | 'delivered' | 'denied' | 'expired' | 'revoked'
export interface DropRow {
  id: string
  tenant: string
  moment_id: string | null
  agent_id: string
  host_key_id: string
  name: string
  purpose: string
  scope_hint: string | null
  status: DropStatus
  ct_sha256: string | null
  created_at: string
  expires_at: string
  provided_at: string | null
  retain_until: string | null
  delivered_at: string | null
  revoke_requested_at: string | null
  revoke_acked_at: string | null
}
// enc/ct are deliberately NOT in this column list: only the pull path ever reads them.
const DROP_COLUMNS = `id, tenant, moment_id, agent_id, host_key_id, name, purpose, scope_hint, status, ct_sha256,
  created_at, expires_at, provided_at, retain_until, delivered_at, revoke_requested_at, revoke_acked_at`

// ── receipts ────────────────────────────────────────────────────────────────────────────────────────
export type DropOperation =
  | 'host_key_register' | 'credential_request' | 'secure_drop_provide' | 'secure_drop_deny'
  | 'secure_drop_deliver' | 'secure_drop_revoke' | 'secure_drop_revoke_ack'

/** Receipt evidence: short scalars only. There is no field a ciphertext, key or secret could be put in by type. */
export type DropEvidence = Record<string, string | number | null>

interface AuditInput {
  operation: DropOperation
  principal: { kind: 'agent'; agentId: string; memberId: string | null } | { kind: 'member'; memberId: string }
  origin: 'mcp' | 'admin_ui'
  targetKind: 'secure_drop' | 'host_key'
  targetId: string
  evidence: DropEvidence
}

const SAFE_EVIDENCE_VALUE = /^[A-Za-z0-9 _.:@/|,+=-]{0,200}$/

/** The receipt INSERT as a statement, so it can ride in the same batch as the change it records. */
function auditStatement(env: Env, a: AuditInput, nowIso: string, onlyIfChanged: boolean): D1PreparedStatement {
  const id = crypto.randomUUID()
  const evidence: Record<string, string | number | null> = {}
  for (const [k, v] of Object.entries(a.evidence)) {
    // Belt and braces for the "never secret material" rule: a value that is not a short plain scalar is dropped.
    evidence[k] = typeof v === 'string' && !SAFE_EVIDENCE_VALUE.test(v) ? null : v
  }
  const principalId = a.principal.kind === 'agent' ? a.principal.agentId : a.principal.memberId
  const agentId = a.principal.kind === 'agent' ? a.principal.agentId : null
  const memberId = a.principal.memberId
  const values = [id, env.TENANT_SLUG, a.principal.kind, principalId, memberId, agentId, a.origin, a.operation, a.targetKind, a.targetId,
    JSON.stringify(evidence), nowIso] as const
  const cols = `id, tenant, principal_kind, principal_id, member_id, agent_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at`
  return env.DB.prepare(
    `INSERT INTO mutation_audit_entries (${cols})
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'secure_drop', ?8, ?9, ?10, ?1, ?1, ?11, ?12
      WHERE ${onlyIfChanged ? 'changes() = 1' : 'true'}
     ON CONFLICT DO NOTHING`,
  ).bind(...values)
}

// ── host keys ───────────────────────────────────────────────────────────────────────────────────────
export async function loadLiveHostKey(env: Env, agentId: string): Promise<HostKeyRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${HOST_KEY_COLUMNS} FROM host_keys WHERE tenant = ?1 AND agent_id = ?2 AND revoked_at IS NULL LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<HostKeyRow>()
  return row ?? null
}

export async function loadHostKeyById(env: Env, id: string): Promise<HostKeyRow | null> {
  const row = await env.DB.prepare(`SELECT ${HOST_KEY_COLUMNS} FROM host_keys WHERE tenant = ?1 AND id = ?2 LIMIT 1`)
    .bind(env.TENANT_SLUG, id).first<HostKeyRow>()
  return row ?? null
}

export type RegisterHostKeyResult =
  | { ok: true; id: string; rotated: boolean; unchanged: boolean; fingerprint: string }
  | { ok: false; reason: 'key_was_revoked' | 'conflict' }

/**
 * Register the agent's host public key. The caller has already proved it IS that agent (agent-bound token).
 * Same key as the live one: idempotent. A different key rotates: ONE batch revokes the old key, expires every
 * open request and unpulled ciphertext sealed to it (nobody could ever open them now) and inserts the new key.
 * A key that was revoked before is never resurrected.
 */
export async function registerHostKey(env: Env, input: { agentId: string; memberId: string | null; key: ParsedHostKey }, nowMs: number = Date.now()): Promise<RegisterHostKeyResult> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const live = await loadLiveHostKey(env, input.agentId)
  if (live && live.public_key_b64u === input.key.publicKeyB64u) {
    return { ok: true, id: live.id, rotated: false, unchanged: true, fingerprint: live.fingerprint }
  }
  const burned = await env.DB.prepare(
    `SELECT 1 AS x FROM host_keys WHERE tenant = ?1 AND agent_id = ?2 AND public_key_b64u = ?3 AND revoked_at IS NOT NULL LIMIT 1`,
  ).bind(tenant, input.agentId, input.key.publicKeyB64u).first<{ x: number }>()
  if (burned) return { ok: false, reason: 'key_was_revoked' }
  const newId = crypto.randomUUID()
  const stmts: D1PreparedStatement[] = []
  if (live) {
    stmts.push(
      env.DB.prepare(
        `UPDATE secure_moments SET status = 'expired'
          WHERE tenant = ?1 AND kind = 'credential' AND status = 'pending'
            AND subject_id IN (SELECT id FROM secure_drops WHERE tenant = ?1 AND host_key_id = ?2 AND status = 'requested')`,
      ).bind(tenant, live.id),
      env.DB.prepare(
        `UPDATE secure_drops SET status = 'expired', enc_b64u = NULL, ct_b64u = NULL
          WHERE tenant = ?1 AND host_key_id = ?2 AND status IN ('requested', 'ready')`,
      ).bind(tenant, live.id),
      env.DB.prepare(`UPDATE host_keys SET revoked_at = ?3 WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL`).bind(live.id, tenant, nowIso),
    )
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO host_keys (id, tenant, agent_id, public_key_b64u, fingerprint, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(newId, tenant, input.agentId, input.key.publicKeyB64u, input.key.fingerprint, nowIso),
    auditStatement(env, {
      operation: 'host_key_register', principal: { kind: 'agent', agentId: input.agentId, memberId: input.memberId }, origin: 'mcp',
      targetKind: 'host_key', targetId: newId,
      evidence: { fingerprint: input.key.fingerprint, rotated: live ? 1 : 0, replaced_host_key_id: live?.id ?? null },
    }, nowIso, true),
  )
  try {
    await env.DB.batch(stmts)
  } catch {
    // The partial UNIQUE index refused (a concurrent registration won) or the batch rolled back whole.
    return { ok: false, reason: 'conflict' }
  }
  const landed = await loadLiveHostKey(env, input.agentId)
  if (!landed || landed.id !== newId) return { ok: false, reason: 'conflict' }
  return { ok: true, id: newId, rotated: live !== null, unchanged: false, fingerprint: input.key.fingerprint }
}

// ── requests ────────────────────────────────────────────────────────────────────────────────────────
export type CreateDropResult =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; reason: 'delivery_pending' | 'too_many_open' | 'conflict' }

/** Expire (lazily) every request/ciphertext of this tenant that is past its time. Ciphertext is deleted with the status. */
export async function purgeExpiredDrops(env: Env, nowMs: number = Date.now()): Promise<void> {
  const nowIso = new Date(nowMs).toISOString()
  await env.DB.prepare(
    `UPDATE secure_moments SET status = 'expired'
      WHERE tenant = ?1 AND kind = 'credential' AND status = 'pending' AND expires_at <= ?2`,
  ).bind(env.TENANT_SLUG, nowIso).run()
  await env.DB.prepare(
    `UPDATE secure_drops SET status = 'expired', enc_b64u = NULL, ct_b64u = NULL
      WHERE tenant = ?1 AND ((status = 'requested' AND expires_at <= ?2) OR (status = 'ready' AND retain_until <= ?2))`,
  ).bind(env.TENANT_SLUG, nowIso).run()
}

export async function createDropRequest(
  env: Env,
  input: { agentId: string; memberId: string | null; hostKey: HostKeyRow; name: string; purpose: string; scopeHint: string | null; ttlMinutes: number },
  nowMs: number = Date.now(),
): Promise<CreateDropResult> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  await purgeExpiredDrops(env, nowMs)
  const open = await env.DB.prepare(
    `SELECT id, status FROM secure_drops WHERE tenant = ?1 AND agent_id = ?2 AND status IN ('requested', 'ready')`,
  ).bind(tenant, input.agentId).all<{ id: string; status: string }>()
  const rows = open.results ?? []
  const sameName = await env.DB.prepare(
    `SELECT id, status FROM secure_drops WHERE tenant = ?1 AND agent_id = ?2 AND name = ?3 AND status IN ('requested', 'ready') LIMIT 1`,
  ).bind(tenant, input.agentId, input.name).first<{ id: string; status: string }>()
  // Sealed ciphertext for this name still waits for the host: pull it first, do not shadow it.
  if (sameName?.status === 'ready') return { ok: false, reason: 'delivery_pending' }
  if (!sameName && rows.length >= DROP_MAX_OPEN_PER_AGENT) return { ok: false, reason: 'too_many_open' }
  const id = crypto.randomUUID()
  const expiresAt = new Date(nowMs + input.ttlMinutes * 60_000).toISOString()
  const stmts: D1PreparedStatement[] = []
  if (sameName) {
    // A re-request for the same name supersedes the open one: its link dies with it.
    stmts.push(
      env.DB.prepare(
        `UPDATE secure_moments SET status = 'expired' WHERE tenant = ?1 AND kind = 'credential' AND subject_id = ?2 AND status = 'pending'`,
      ).bind(tenant, sameName.id),
      env.DB.prepare(`UPDATE secure_drops SET status = 'expired' WHERE id = ?1 AND tenant = ?2 AND status = 'requested'`).bind(sameName.id, tenant),
    )
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO secure_drops (id, tenant, agent_id, host_key_id, name, purpose, scope_hint, status, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'requested', ?8, ?9)`,
    ).bind(id, tenant, input.agentId, input.hostKey.id, input.name, input.purpose, input.scopeHint, nowIso, expiresAt),
    auditStatement(env, {
      operation: 'credential_request', principal: { kind: 'agent', agentId: input.agentId, memberId: input.memberId }, origin: 'mcp',
      targetKind: 'secure_drop', targetId: id,
      evidence: { name: input.name, host_key_id: input.hostKey.id, fingerprint: input.hostKey.fingerprint, ttl_minutes: input.ttlMinutes, superseded: sameName?.id ?? null },
    }, nowIso, true),
  )
  try {
    await env.DB.batch(stmts)
  } catch {
    return { ok: false, reason: 'conflict' }
  }
  return { ok: true, id, expiresAt }
}

/** Bind the issued moment to the request (guarded: only while unbound) or, when no link could be issued, close it. */
export async function attachMoment(env: Env, dropId: string, momentId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE secure_drops SET moment_id = ?3 WHERE id = ?1 AND tenant = ?2 AND status = 'requested' AND moment_id IS NULL`,
  ).bind(dropId, env.TENANT_SLUG, momentId).run()
  return r.meta.changes === 1
}

export async function abandonRequest(env: Env, dropId: string): Promise<void> {
  await env.DB.prepare(`UPDATE secure_drops SET status = 'expired' WHERE id = ?1 AND tenant = ?2 AND status = 'requested'`)
    .bind(dropId, env.TENANT_SLUG).run()
}

export async function loadDrop(env: Env, id: string): Promise<DropRow | null> {
  const row = await env.DB.prepare(`SELECT ${DROP_COLUMNS} FROM secure_drops WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<DropRow>()
  return row ?? null
}

// ── the human's decision ────────────────────────────────────────────────────────────────────────────
/** sha256 of enc || ciphertext (raw bytes), lowercase hex: THE value the WebAuthn challenge is bound to. */
export async function sealedDigest(enc: Uint8Array, ct: Uint8Array): Promise<string> {
  const both = new Uint8Array(enc.length + ct.length)
  both.set(enc, 0)
  both.set(ct, enc.length)
  return hex(await sha256(both))
}

export interface DecideDropInput {
  momentId: string
  token: string
  drop: DropRow
  decision: 'provide' | 'deny'
  memberId: string
  passkeyId: string
  /** provide only: the base64url strings exactly as submitted, and the digest the challenge was bound to. */
  sealed?: { encB64u: string; ctB64u: string; digestHex: string }
  fingerprint: string
}

/**
 * Consume the moment AND store the sealed ciphertext (or record the denial) in ONE batch. The consuming UPDATE
 * carries every guard (pending, unexpired, link hash, passkey unrevoked under a live login identity, the request
 * still open and bound to this moment, and for provide the host key STILL live); the drop UPDATE and the receipt
 * run only if it won (`changes() = 1`). So a refusal can never burn the link, and a stored ciphertext always has
 * a consumed moment behind it. Returns true only when the drop reads back in the expected state.
 */
export async function decideDrop(env: Env, i: DecideDropInput, nowMs: number): Promise<boolean> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const provide = i.decision === 'provide'
  if (provide && !i.sealed) return false
  const sealed = i.sealed
  const retainUntil = new Date(nowMs + DROP_RETAIN_MS).toISOString()
  const consume = env.DB.prepare(
    `UPDATE secure_moments
        SET status = CASE WHEN ?4 = 'deny' THEN 'denied' ELSE 'consumed' END,
            decided_at = ?3, decision = ?4, decided_via = 'webauthn', decided_by_member_id = ?5, decided_passkey_id = ?6
      WHERE id = ?1 AND tenant = ?2 AND kind = 'credential' AND status = 'pending' AND expires_at > ?3
        AND link_token_sha256 = ?7 AND (decider_member_id IS NULL OR decider_member_id = ?5)
        AND EXISTS (SELECT 1 FROM member_passkeys p
                      JOIN human_login_identities li
                        ON li.id = p.login_identity_id AND li.tenant = p.tenant AND li.member_id = p.member_id AND li.revoked_at IS NULL
                     WHERE p.id = ?6 AND p.tenant = ?2 AND p.member_id = ?5 AND p.revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM secure_drops d
                     WHERE d.id = ?8 AND d.tenant = ?2 AND d.moment_id = ?1 AND d.agent_id = ?9 AND d.status = 'requested'
                       AND d.expires_at > ?3
                       AND (?4 = 'deny' OR EXISTS (SELECT 1 FROM host_keys k
                                                    WHERE k.id = d.host_key_id AND k.tenant = d.tenant AND k.agent_id = d.agent_id
                                                      AND k.revoked_at IS NULL)))`,
  ).bind(i.momentId, tenant, nowIso, i.decision === 'deny' ? 'deny' : 'provide', i.memberId, i.passkeyId, await tokenHash(i.token), i.drop.id, i.drop.agent_id)
  const store = provide && sealed
    ? env.DB.prepare(
        `UPDATE secure_drops
            SET status = 'ready', enc_b64u = ?3, ct_b64u = ?4, ct_sha256 = ?5, decided_by_member_id = ?6,
                provided_at = ?7, retain_until = ?8
          WHERE id = ?1 AND tenant = ?2 AND status = 'requested' AND changes() = 1`,
      ).bind(i.drop.id, tenant, sealed.encB64u, sealed.ctB64u, sealed.digestHex, i.memberId, nowIso, retainUntil)
    : env.DB.prepare(
        `UPDATE secure_drops SET status = 'denied', decided_by_member_id = ?3 WHERE id = ?1 AND tenant = ?2 AND status = 'requested' AND changes() = 1`,
      ).bind(i.drop.id, tenant, i.memberId)
  const receipt = auditStatement(env, {
    operation: provide ? 'secure_drop_provide' : 'secure_drop_deny',
    principal: { kind: 'member', memberId: i.memberId }, origin: 'admin_ui', targetKind: 'secure_drop', targetId: i.drop.id,
    evidence: {
      name: i.drop.name, agent_id: i.drop.agent_id, moment_id: i.momentId, passkey_id: i.passkeyId, host_key_id: i.drop.host_key_id,
      fingerprint: i.fingerprint, ct_sha256: provide && sealed ? sealed.digestHex : null,
    },
  }, nowIso, true)
  try {
    await env.DB.batch([consume, store, receipt])
  } catch {
    return false
  }
  const after = await loadDrop(env, i.drop.id)
  if (!after) return false
  return provide ? after.status === 'ready' && after.ct_sha256 === sealed?.digestHex : after.status === 'denied'
}

// ── the host's pull / ack ───────────────────────────────────────────────────────────────────────────
export interface PendingDrop { id: string; name: string; enc: string; ct: string; host_key_fingerprint: string }
export interface PendingRevoke { id: string; name: string }

/**
 * Ciphertext the agent may pull: its OWN drops, sealed to its CURRENT live host key (a drop sealed to a rotated
 * key is never listed), still within retention. Reads only; the ciphertext stays until the host acks.
 */
export async function listPendingDrops(env: Env, agentId: string, nowMs: number = Date.now()): Promise<PendingDrop[]> {
  const rows = await env.DB.prepare(
    `SELECT d.id AS id, d.name AS name, d.enc_b64u AS enc, d.ct_b64u AS ct, k.fingerprint AS host_key_fingerprint
       FROM secure_drops d
       JOIN host_keys k ON k.id = d.host_key_id AND k.tenant = d.tenant AND k.agent_id = d.agent_id AND k.revoked_at IS NULL
      WHERE d.tenant = ?1 AND d.agent_id = ?2 AND d.status = 'ready' AND d.retain_until > ?3
        AND d.enc_b64u IS NOT NULL AND d.ct_b64u IS NOT NULL
      ORDER BY d.provided_at ASC LIMIT 20`,
  ).bind(env.TENANT_SLUG, agentId, new Date(nowMs).toISOString()).all<PendingDrop>()
  return rows.results ?? []
}

export async function listPendingRevokes(env: Env, agentId: string): Promise<PendingRevoke[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name FROM secure_drops
      WHERE tenant = ?1 AND agent_id = ?2 AND status = 'delivered' AND revoke_requested_at IS NOT NULL AND revoke_acked_at IS NULL
      ORDER BY revoke_requested_at ASC LIMIT 20`,
  ).bind(env.TENANT_SLUG, agentId).all<PendingRevoke>()
  return rows.results ?? []
}

/**
 * Ack by the owning agent. A 'ready' drop whose host key is still live becomes 'delivered' and its ciphertext is
 * deleted in the same statement (single use: a replayed ack changes nothing). A delivered drop with a pending
 * revoke instruction becomes 'revoked'. Anything else, including another agent's drop, is refused identically.
 */
export async function ackDrop(env: Env, input: { agentId: string; memberId: string | null; id: string }, nowMs: number = Date.now()): Promise<'delivered' | 'revoke_acked' | null> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const drop = await loadDrop(env, input.id)
  const deliver = async (): Promise<boolean> => {
    if (!drop) return false
    const out = await env.DB.batch([
      env.DB.prepare(
        `UPDATE secure_drops SET status = 'delivered', delivered_at = ?4, enc_b64u = NULL, ct_b64u = NULL
          WHERE id = ?1 AND tenant = ?2 AND agent_id = ?3 AND status = 'ready' AND retain_until > ?4
            AND EXISTS (SELECT 1 FROM host_keys k WHERE k.id = secure_drops.host_key_id AND k.tenant = ?2 AND k.agent_id = ?3 AND k.revoked_at IS NULL)`,
      ).bind(input.id, tenant, input.agentId, nowIso),
      auditStatement(env, {
        operation: 'secure_drop_deliver', principal: { kind: 'agent', agentId: input.agentId, memberId: input.memberId }, origin: 'mcp',
        targetKind: 'secure_drop', targetId: input.id,
        evidence: { name: drop.name, host_key_id: drop.host_key_id, ct_sha256: drop.ct_sha256 },
      }, nowIso, true),
    ])
    return out[0].meta.changes === 1
  }
  if (await deliver()) return 'delivered'
  if (!drop) return null
  const out = await env.DB.batch([
    env.DB.prepare(
      `UPDATE secure_drops SET status = 'revoked', revoke_acked_at = ?4
        WHERE id = ?1 AND tenant = ?2 AND agent_id = ?3 AND status = 'delivered' AND revoke_requested_at IS NOT NULL AND revoke_acked_at IS NULL`,
    ).bind(input.id, tenant, input.agentId, nowIso),
    auditStatement(env, {
      operation: 'secure_drop_revoke_ack', principal: { kind: 'agent', agentId: input.agentId, memberId: input.memberId }, origin: 'mcp',
      targetKind: 'secure_drop', targetId: input.id, evidence: { name: drop.name },
    }, nowIso, true),
  ])
  return out[0].meta.changes === 1 ? 'revoke_acked' : null
}

// ── revoke (the human authority) ────────────────────────────────────────────────────────────────────
export interface RevokeCandidate { id: string; agent_id: string; status: DropStatus; revoke_requested_at: string | null }

export async function findRevokeCandidates(env: Env, name: string, agentId: string | null): Promise<RevokeCandidate[]> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, status, revoke_requested_at FROM secure_drops
      WHERE tenant = ?1 AND name = ?2 AND status IN ('requested', 'ready', 'delivered') AND (?3 IS NULL OR agent_id = ?3)`,
  ).bind(env.TENANT_SLUG, name, agentId).all<RevokeCandidate>()
  return rows.results ?? []
}

/**
 * Revoke one drop: a request that is still open is cancelled, unpulled ciphertext is deleted at once, and a
 * delivered credential gets a revoke INSTRUCTION the host acts on at its next pull (it shreds the file and acks).
 * Returns what it did, or null when the guard did not match (someone else already moved it).
 */
export async function revokeDrop(env: Env, input: { drop: RevokeCandidate; name: string; memberId: string }, nowMs: number = Date.now()): Promise<'cancelled' | 'deleted' | 'instructed' | null> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const d = input.drop
  const audit = (kind: string): D1PreparedStatement => auditStatement(env, {
    operation: 'secure_drop_revoke', principal: { kind: 'member', memberId: input.memberId }, origin: 'mcp',
    targetKind: 'secure_drop', targetId: d.id, evidence: { name: input.name, agent_id: d.agent_id, effect: kind },
  }, nowIso, true)
  if (d.status === 'requested') {
    const out = await env.DB.batch([
      env.DB.prepare(
        `UPDATE secure_moments SET status = 'expired' WHERE tenant = ?1 AND kind = 'credential' AND subject_id = ?2 AND status = 'pending'`,
      ).bind(tenant, d.id),
      env.DB.prepare(
        `UPDATE secure_drops SET status = 'revoked', revoke_requested_at = ?3, revoke_requested_by = ?4, revoke_acked_at = ?3
          WHERE id = ?1 AND tenant = ?2 AND status = 'requested'`,
      ).bind(d.id, tenant, nowIso, input.memberId),
      audit('cancelled'),
    ])
    return out[1].meta.changes === 1 ? 'cancelled' : null
  }
  if (d.status === 'ready') {
    const out = await env.DB.batch([
      env.DB.prepare(
        `UPDATE secure_drops SET status = 'revoked', enc_b64u = NULL, ct_b64u = NULL, revoke_requested_at = ?3, revoke_requested_by = ?4, revoke_acked_at = ?3
          WHERE id = ?1 AND tenant = ?2 AND status = 'ready'`,
      ).bind(d.id, tenant, nowIso, input.memberId),
      audit('deleted'),
    ])
    return out[0].meta.changes === 1 ? 'deleted' : null
  }
  const out = await env.DB.batch([
    env.DB.prepare(
      `UPDATE secure_drops SET revoke_requested_at = ?3, revoke_requested_by = ?4
        WHERE id = ?1 AND tenant = ?2 AND status = 'delivered' AND revoke_requested_at IS NULL`,
    ).bind(d.id, tenant, nowIso, input.memberId),
    audit('instructed'),
  ])
  return out[0].meta.changes === 1 ? 'instructed' : null
}

/** The base64url strings a provide request carries, decoded and bounded. Null on any malformation. */
export function decodeSealed(encB64u: unknown, ctB64u: unknown, limits: { encBytes: number; ctMin: number; ctMax: number }): { enc: Uint8Array; ct: Uint8Array; encB64u: string; ctB64u: string } | null {
  if (typeof encB64u !== 'string' || typeof ctB64u !== 'string') return null
  const enc = b64uDecode(encB64u)
  const ct = b64uDecode(ctB64u)
  if (!enc || !ct || enc.length !== limits.encBytes || ct.length < limits.ctMin || ct.length > limits.ctMax) return null
  // Canonical spelling only: the stored string, the digest and the host's decode must all name the same bytes.
  if (b64uEncode(enc) !== encB64u || b64uEncode(ct) !== ctB64u) return null
  return { enc, ct, encB64u, ctB64u }
}
