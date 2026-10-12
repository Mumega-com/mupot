// mupot — secure-moments persistence (migration 0212). Every state transition is ONE guarded statement
// (`WHERE status = 'pending' AND expires_at > now ...`) and the caller trusts only its `meta.changes`, never a
// prior read: replay, a second tab and concurrent POSTs all lose the guard.
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { b64uEncode, hex, sha256 } from './webauthn'

export const MOMENT_MAX_TTL_MS = 24 * 60 * 60 * 1000
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const ENROLMENT_TTL_MS = 10 * 60 * 1000
/** Live (unconsumed, unexpired) decide challenges one moment may have outstanding: a flood cap. */
export const CHALLENGE_MAX_OUTSTANDING_PER_MOMENT = 20
export const PASSKEY_MAX_PER_MEMBER = 10

export type MomentKind = 'seed_attach' | 'elevation' | 'credential'

export interface MomentRow {
  id: string
  tenant: string
  kind: MomentKind
  subject_id: string
  requester_agent_id: string | null
  decider_member_id: string | null
  link_token_sha256: string
  status: 'pending' | 'consumed' | 'expired' | 'denied'
  created_at: string
  expires_at: string
  decided_at: string | null
  decision: 'approve' | 'deny' | 'provide' | null
}

const MOMENT_COLUMNS = `id, tenant, kind, subject_id, requester_agent_id, decider_member_id, link_token_sha256,
  status, created_at, expires_at, decided_at, decision`

export function randomToken(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
}

export async function tokenHash(token: string): Promise<string> {
  return hex(await sha256(token))
}

// ── moments ─────────────────────────────────────────────────────────────────────────────────────────
export interface CreateMomentInput {
  kind: MomentKind
  subjectId: string
  requesterAgentId: string | null
  /** The underlying request's own expiry; the moment never outlives it nor MOMENT_MAX_TTL_MS. */
  subjectExpiresAtIso: string
}

/**
 * File (or re-issue) the moment for one subject. A repeat request for the same live subject ROTATES the link
 * token (the old link dies) because only a hash is stored and a lost link must be replaceable.
 * Returns null when the subject is already past its own expiry.
 */
export async function createMoment(env: Env, input: CreateMomentInput, nowMs: number = Date.now()): Promise<{ id: string; token: string; expiresAt: string } | null> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const expiresMs = Math.min(Date.parse(input.subjectExpiresAtIso), nowMs + MOMENT_MAX_TTL_MS)
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null
  const expiresAt = new Date(expiresMs).toISOString()
  // A pending row past its expiry must not hold the single pending slot for this subject.
  await env.DB.prepare(
    `UPDATE secure_moments SET status = 'expired'
      WHERE tenant = ?1 AND kind = ?2 AND subject_id = ?3 AND status = 'pending' AND expires_at <= ?4`,
  ).bind(tenant, input.kind, input.subjectId, nowIso).run()

  const token = randomToken()
  const hash = await tokenHash(token)
  const id = crypto.randomUUID()
  const ins = await env.DB.prepare(
    `INSERT INTO secure_moments
       (id, tenant, kind, subject_id, requester_agent_id, decider_member_id, link_token_sha256, status, step_up_required, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'pending', 1, ?7, ?8)
     ON CONFLICT DO NOTHING`,
  ).bind(id, tenant, input.kind, input.subjectId, input.requesterAgentId, hash, nowIso, expiresAt).run()
  if (ins.meta.changes === 1) return { id, token, expiresAt }
  // The partial UNIQUE index refused: a live pending moment exists. Rotate its token in one guarded UPDATE.
  const rot = await env.DB.prepare(
    `UPDATE secure_moments SET link_token_sha256 = ?5, expires_at = ?6
      WHERE tenant = ?1 AND kind = ?2 AND subject_id = ?3 AND status = 'pending' AND expires_at > ?4`,
  ).bind(tenant, input.kind, input.subjectId, nowIso, hash, expiresAt).run()
  if (rot.meta.changes !== 1) return null
  const row = await env.DB.prepare(
    `SELECT id FROM secure_moments WHERE tenant = ?1 AND kind = ?2 AND subject_id = ?3 AND status = 'pending' LIMIT 1`,
  ).bind(tenant, input.kind, input.subjectId).first<{ id: string }>()
  return row ? { id: row.id, token, expiresAt } : null
}

export async function loadMoment(env: Env, id: string): Promise<MomentRow | null> {
  const row = await env.DB.prepare(`SELECT ${MOMENT_COLUMNS} FROM secure_moments WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<MomentRow>()
  return row ?? null
}

export async function momentLinkMatches(row: MomentRow, token: string): Promise<boolean> {
  return timingSafeEqual(row.link_token_sha256, await tokenHash(token))
}

export function momentIsLive(row: MomentRow, nowMs: number): boolean {
  return row.status === 'pending' && Date.parse(row.expires_at) > nowMs
}

/**
 * THE consuming statement. True iff THIS call won it: still pending, unexpired, the link hash still the one
 * presented, (when the moment names a decider) the deciding member is that member, and the passkey is unrevoked
 * AND bound to a LIVE login identity of that member (so revoking the identity cuts the passkey off even between
 * the route's own check and this consume).
 */
export async function consumeMoment(
  env: Env,
  input: { id: string; token: string; decision: 'approve' | 'deny'; memberId: string; passkeyId: string },
  nowMs: number,
): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `UPDATE secure_moments
        SET status = CASE WHEN ?4 = 'deny' THEN 'denied' ELSE 'consumed' END,
            decided_at = ?3, decision = ?4, decided_via = 'webauthn', decided_by_member_id = ?5, decided_passkey_id = ?6
      WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND expires_at > ?3
        AND link_token_sha256 = ?7 AND (decider_member_id IS NULL OR decider_member_id = ?5)
        AND EXISTS (SELECT 1 FROM member_passkeys p
                      JOIN human_login_identities i
                        ON i.id = p.login_identity_id AND i.tenant = p.tenant AND i.member_id = p.member_id AND i.revoked_at IS NULL
                     WHERE p.id = ?6 AND p.tenant = ?2 AND p.member_id = ?5 AND p.revoked_at IS NULL)`,
  ).bind(input.id, env.TENANT_SLUG, nowIso, input.decision, input.memberId, input.passkeyId, await tokenHash(input.token)).run()
  return r.meta.changes === 1
}

// ── challenges ──────────────────────────────────────────────────────────────────────────────────────
export interface DecideBinding { momentId: string; decision: 'approve' | 'deny' | 'provide'; payloadSha256: string }

/** Mint a decide challenge bound to (moment, decision, parameter digest). Null when the outstanding cap is hit. */
export async function mintDecideChallenge(env: Env, b: DecideBinding, nowMs: number = Date.now()): Promise<string | null> {
  const challenge = randomToken()
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `INSERT INTO passkey_challenges
       (id, tenant, purpose, challenge_sha256, moment_id, decision, payload_sha256, created_at, expires_at)
     SELECT ?1, ?2, 'decide', ?3, ?4, ?5, ?6, ?7, ?8
      WHERE (SELECT COUNT(*) FROM passkey_challenges
              WHERE tenant = ?2 AND purpose = 'decide' AND moment_id = ?4 AND consumed_at IS NULL AND expires_at > ?7) < ?9`,
  ).bind(crypto.randomUUID(), env.TENANT_SLUG, await tokenHash(challenge), b.momentId, b.decision, b.payloadSha256,
    nowIso, new Date(nowMs + CHALLENGE_TTL_MS).toISOString(), CHALLENGE_MAX_OUTSTANDING_PER_MOMENT).run()
  return r.meta.changes === 1 ? challenge : null
}

export async function mintEnrolChallenge(env: Env, input: { memberId: string; enrolmentTokenId: string }, nowMs: number = Date.now()): Promise<string> {
  const challenge = randomToken()
  await env.DB.prepare(
    `INSERT INTO passkey_challenges
       (id, tenant, purpose, challenge_sha256, member_id, enrolment_token_id, created_at, expires_at)
     VALUES (?1, ?2, 'enrol', ?3, ?4, ?5, ?6, ?7)`,
  ).bind(crypto.randomUUID(), env.TENANT_SLUG, await tokenHash(challenge), input.memberId, input.enrolmentTokenId,
    new Date(nowMs).toISOString(), new Date(nowMs + CHALLENGE_TTL_MS).toISOString()).run()
  return challenge
}

/**
 * Consume a challenge (single use) only if it is live AND bound to exactly the ceremony being finished. The
 * binding is part of the UPDATE's WHERE, so a challenge minted for decision A, another moment, or other
 * parameters consumes nothing here (and is NOT burned by the mismatch).
 */
export async function consumeDecideChallenge(env: Env, challenge: string, b: DecideBinding, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE passkey_challenges SET consumed_at = ?2
      WHERE tenant = ?1 AND purpose = 'decide' AND challenge_sha256 = ?3 AND consumed_at IS NULL AND expires_at > ?2
        AND moment_id = ?4 AND decision = ?5 AND payload_sha256 = ?6`,
  ).bind(env.TENANT_SLUG, new Date(nowMs).toISOString(), await tokenHash(challenge), b.momentId, b.decision, b.payloadSha256).run()
  return r.meta.changes === 1
}

export async function consumeEnrolChallenge(env: Env, challenge: string, input: { memberId: string; enrolmentTokenId: string }, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE passkey_challenges SET consumed_at = ?2
      WHERE tenant = ?1 AND purpose = 'enrol' AND challenge_sha256 = ?3 AND consumed_at IS NULL AND expires_at > ?2
        AND member_id = ?4 AND enrolment_token_id = ?5`,
  ).bind(env.TENANT_SLUG, new Date(nowMs).toISOString(), await tokenHash(challenge), input.memberId, input.enrolmentTokenId).run()
  return r.meta.changes === 1
}

// ── passkeys ────────────────────────────────────────────────────────────────────────────────────────
export interface PasskeyRow {
  id: string
  tenant: string
  member_id: string
  login_identity_id: string | null
  credential_id: string
  public_key: string
  sign_count: number
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const PASSKEY_COLUMNS = 'id, tenant, member_id, login_identity_id, credential_id, public_key, sign_count, created_at, last_used_at, revoked_at'

export async function loadPasskeyByCredential(env: Env, credentialId: string): Promise<PasskeyRow | null> {
  const row = await env.DB.prepare(`SELECT ${PASSKEY_COLUMNS} FROM member_passkeys WHERE tenant = ?1 AND credential_id = ?2 LIMIT 1`)
    .bind(env.TENANT_SLUG, credentialId).first<PasskeyRow>()
  return row ?? null
}

export async function listMemberPasskeys(env: Env, memberId: string): Promise<PasskeyRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PASSKEY_COLUMNS} FROM member_passkeys WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL ORDER BY created_at ASC`,
  ).bind(env.TENANT_SLUG, memberId).all<PasskeyRow>()
  return rows.results ?? []
}

/**
 * Advance the stored counter in ONE guarded statement. Authenticators that never count report 0 forever
 * (allowed: 0 over 0). Otherwise the new value must be strictly greater; an equal or lower non-zero value is a
 * cloned authenticator or a replayed assertion and wins nothing. Also refuses a revoked passkey.
 */
export async function advancePasskeyCounter(env: Env, passkeyId: string, newCount: number, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE member_passkeys SET sign_count = ?3, last_used_at = ?4
      WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL
        AND ((?3 = 0 AND sign_count = 0) OR ?3 > sign_count)`,
  ).bind(passkeyId, env.TENANT_SLUG, newCount, new Date(nowMs).toISOString()).run()
  return r.meta.changes === 1
}

export async function revokeOwnPasskey(env: Env, memberId: string, passkeyId: string, nowMs: number = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE member_passkeys SET revoked_at = ?4 WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(passkeyId, env.TENANT_SLUG, memberId, new Date(nowMs).toISOString()).run()
  if (r.meta.changes === 1) await recordPasskeyAudit(env, { operation: 'passkey_revoke', memberId, passkeyId, evidence: { reason: 'owner_revoke' } }, nowMs)
  return r.meta.changes === 1
}

/**
 * "Cut this human off" levers kill the passkeys too: every unrevoked passkey of the member (all of them), or only
 * those enrolled under one login identity. Called from revokeAllWebSessions and revokeLoginIdentity so a passkey
 * can never be the surviving door. Receipted once per call when anything was revoked.
 */
export async function revokeMemberPasskeys(
  env: Env, memberId: string, reason: string, opts: { loginIdentityId?: string } = {}, nowMs: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(nowMs).toISOString()
  const tenant = env.TENANT_SLUG
  let r: Awaited<ReturnType<ReturnType<Env['DB']['prepare']>['run']>>
  try {
    r = opts.loginIdentityId
      ? await env.DB.prepare(
          `UPDATE member_passkeys SET revoked_at = ?4 WHERE tenant = ?1 AND member_id = ?2 AND login_identity_id = ?3 AND revoked_at IS NULL`,
        ).bind(tenant, memberId, opts.loginIdentityId, nowIso).run()
      : await env.DB.prepare(
          `UPDATE member_passkeys SET revoked_at = ?3 WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL`,
        ).bind(tenant, memberId, nowIso).run()
  } catch (err) {
    // A pot that has not applied migration 0212 has no passkeys to revoke; sign-out and identity revoke must still work.
    if (err instanceof Error && /no such table/i.test(err.message)) return 0
    throw err
  }
  const n = Number(r.meta?.changes ?? 0)
  if (n > 0) await recordPasskeyAudit(env, { operation: 'passkey_revoke', memberId, passkeyId: null, evidence: { reason, count: String(n), ...(opts.loginIdentityId ? { login_identity_id: opts.loginIdentityId } : {}) } }, nowMs)
  return n
}

/**
 * Passkey enrol/revoke are identity-surface writes: each leaves a mutation_audit_entries row. Best effort by
 * design (a failed receipt must not undo or block a revoke, which is the safe direction); returns whether it landed.
 */
export async function recordPasskeyAudit(
  env: Env,
  input: { operation: 'passkey_enrol' | 'passkey_revoke'; memberId: string; passkeyId: string | null; evidence: Record<string, string> },
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       VALUES (?1, ?2, 'member', ?3, ?3, 'admin_ui', 'secure_moment', ?4, 'member_passkey', ?5, ?1, ?1, ?6, ?7)
       ON CONFLICT DO NOTHING`,
    ).bind(id, env.TENANT_SLUG, input.memberId, input.operation, input.passkeyId ?? input.memberId,
      JSON.stringify({ ...input.evidence, passkey_id: input.passkeyId }), new Date(nowMs).toISOString()).run()
    return true
  } catch {
    return false
  }
}

// ── enrolment tokens ────────────────────────────────────────────────────────────────────────────────
export interface EnrolmentTokenRow {
  id: string
  member_id: string
  login_identity_id: string | null
  expires_at: string
  consumed_at: string | null
}

/** Mint a single-use 10-minute enrolment token for a member; any earlier unconsumed token is superseded. */
export async function mintEnrolmentToken(env: Env, memberId: string, loginIdentityId: string | null, nowMs: number = Date.now()): Promise<{ token: string; expiresAt: string }> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  await env.DB.prepare(
    `UPDATE passkey_enrolment_tokens SET consumed_at = ?3 WHERE tenant = ?1 AND member_id = ?2 AND consumed_at IS NULL`,
  ).bind(tenant, memberId, nowIso).run()
  const token = randomToken()
  const expiresAt = new Date(nowMs + ENROLMENT_TTL_MS).toISOString()
  await env.DB.prepare(
    `INSERT INTO passkey_enrolment_tokens (id, tenant, member_id, login_identity_id, token_sha256, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(crypto.randomUUID(), tenant, memberId, loginIdentityId, await tokenHash(token), nowIso, expiresAt).run()
  return { token, expiresAt }
}

export async function loadEnrolmentToken(env: Env, token: string): Promise<EnrolmentTokenRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, member_id, login_identity_id, expires_at, consumed_at FROM passkey_enrolment_tokens WHERE tenant = ?1 AND token_sha256 = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, await tokenHash(token)).first<EnrolmentTokenRow>()
  return row ?? null
}

export type FinishEnrolmentResult = { ok: true; passkeyId: string } | { ok: false; reason: 'token_spent' | 'duplicate_credential' | 'too_many_passkeys' }

/**
 * Consume the token AND store the passkey in one batch. The INSERT runs only if the UPDATE won
 * (`changes() = 1`) and only under the per-member cap; a duplicate credential id makes the INSERT throw,
 * which rolls the whole batch back, so the token is not burned by it.
 */
export async function finishEnrolment(
  env: Env,
  input: { tokenId: string; memberId: string; loginIdentityId: string | null; credentialId: string; publicKey: string; signCount: number; aaguid: string; transports: string | null },
  nowMs: number,
): Promise<FinishEnrolmentResult> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const passkeyId = crypto.randomUUID()
  let out: Awaited<ReturnType<typeof env.DB.batch>>
  try {
    out = await env.DB.batch([
      // The cap is part of the consuming guard: over the cap the token is simply not spent.
      env.DB.prepare(
        `UPDATE passkey_enrolment_tokens SET consumed_at = ?4
          WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND consumed_at IS NULL AND expires_at > ?4
            AND (SELECT COUNT(*) FROM member_passkeys WHERE tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL) < ?5`,
      ).bind(input.tokenId, tenant, input.memberId, nowIso, PASSKEY_MAX_PER_MEMBER),
      env.DB.prepare(
        `INSERT INTO member_passkeys
           (id, tenant, member_id, login_identity_id, credential_id, public_key, cose_alg, sign_count, transports, aaguid, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, -7, ?7, ?8, ?9, ?10
          WHERE changes() = 1`,
      ).bind(passkeyId, tenant, input.memberId, input.loginIdentityId, input.credentialId, input.publicKey, input.signCount,
        input.transports, input.aaguid, nowIso),
    ])
  } catch {
    return { ok: false, reason: 'duplicate_credential' }
  }
  if (out[0].meta.changes !== 1) {
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM member_passkeys WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL`,
    ).bind(tenant, input.memberId).first<{ n: number }>()
    return { ok: false, reason: (n?.n ?? 0) >= PASSKEY_MAX_PER_MEMBER ? 'too_many_passkeys' : 'token_spent' }
  }
  return { ok: true, passkeyId }
}
