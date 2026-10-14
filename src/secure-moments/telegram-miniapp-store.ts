// mupot — Telegram Mini App persistence and binding (migration 0214). Every state transition is ONE guarded
// statement (or one batch whose later statements are guarded by `changes() = 1`) and the caller trusts only
// `meta.changes`, never a prior read. A device secret is stored only as a sha256.
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { randomToken, tokenHash } from './store'

export const TG_ENROLMENT_TTL_MS = 10 * 60 * 1000
/** A started-but-unconfirmed device is only valid for the enrolment link it was issued under (10 minutes). */
export const TG_DEVICES_MAX_PER_MEMBER = 5

// ── enrolment links ─────────────────────────────────────────────────────────────────────────────────
export interface TgEnrolmentTokenRow {
  id: string
  member_id: string
  login_identity_id: string | null
  expires_at: string
  consumed_at: string | null
}

/** Mint a single-use 10-minute link for a member; any earlier unconsumed link of theirs is superseded. */
export async function mintTgEnrolmentToken(env: Env, memberId: string, loginIdentityId: string | null, nowMs: number = Date.now()): Promise<{ token: string; expiresAt: string }> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  await env.DB.prepare(
    `UPDATE tg_miniapp_enrolment_tokens SET consumed_at = ?3 WHERE tenant = ?1 AND member_id = ?2 AND consumed_at IS NULL`,
  ).bind(tenant, memberId, nowIso).run()
  const token = randomToken()
  const expiresAt = new Date(nowMs + TG_ENROLMENT_TTL_MS).toISOString()
  await env.DB.prepare(
    `INSERT INTO tg_miniapp_enrolment_tokens (id, tenant, member_id, login_identity_id, token_sha256, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(crypto.randomUUID(), tenant, memberId, loginIdentityId, await tokenHash(token), nowIso, expiresAt).run()
  return { token, expiresAt }
}

export async function loadTgEnrolmentToken(env: Env, token: string): Promise<TgEnrolmentTokenRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, member_id, login_identity_id, expires_at, consumed_at FROM tg_miniapp_enrolment_tokens WHERE tenant = ?1 AND token_sha256 = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, await tokenHash(token)).first<TgEnrolmentTokenRow>()
  return row ?? null
}

export function tgEnrolmentTokenIsLive(row: TgEnrolmentTokenRow, nowMs: number): boolean {
  return row.consumed_at === null && Date.parse(row.expires_at) > nowMs
}

// ── devices ─────────────────────────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

/** `<device id>.<secret>`: the one string the Mini App keeps behind the biometric. Null on any other shape. */
export function parseDeviceToken(raw: unknown): { deviceId: string; secret: string } | null {
  if (typeof raw !== 'string' || raw.length > 128) return null
  const dot = raw.indexOf('.')
  if (dot < 0) return null
  const deviceId = raw.slice(0, dot)
  const secret = raw.slice(dot + 1)
  return UUID_RE.test(deviceId) && SECRET_RE.test(secret) ? { deviceId, secret } : null
}

export interface TgDeviceRow {
  id: string
  member_id: string
  telegram_user_id: string
  login_identity_id: string | null
  enrolment_token_id: string
  secret_sha256: string
  created_at: string
  confirmed_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

const DEVICE_COLUMNS = 'id, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at, confirmed_at, last_used_at, revoked_at'

export type StartEnrolmentResult = { ok: true; deviceToken: string; deviceId: string } | { ok: false; reason: 'token_spent' | 'too_many_devices' | 'conflict' }

/**
 * Issue the device secret under a live enrolment link: any earlier pending device of the SAME link is revoked first
 * (one pending per link), the per-member active cap is part of the INSERT's own WHERE, and the link must still be live
 * and name this member. The secret is returned once and stored only as sha256.
 */
export async function startDeviceEnrolment(
  env: Env, input: { token: TgEnrolmentTokenRow; telegramUserId: string }, nowMs: number,
): Promise<StartEnrolmentResult> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const secret = randomToken()
  const deviceId = crypto.randomUUID()
  let out: Awaited<ReturnType<typeof env.DB.batch>>
  try {
    out = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tg_miniapp_devices SET revoked_at = ?3, revoked_reason = 'superseded'
          WHERE tenant = ?1 AND enrolment_token_id = ?2 AND confirmed_at IS NULL AND revoked_at IS NULL`,
      ).bind(tenant, input.token.id, nowIso),
      env.DB.prepare(
        `INSERT INTO tg_miniapp_devices
           (id, tenant, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE EXISTS (SELECT 1 FROM tg_miniapp_enrolment_tokens
                         WHERE id = ?6 AND tenant = ?2 AND member_id = ?3 AND consumed_at IS NULL AND expires_at > ?8)
            AND (SELECT COUNT(*) FROM tg_miniapp_devices
                  WHERE tenant = ?2 AND member_id = ?3 AND confirmed_at IS NOT NULL AND revoked_at IS NULL) < ?9`,
      ).bind(deviceId, tenant, input.token.member_id, input.telegramUserId, input.token.login_identity_id, input.token.id,
        await tokenHash(secret), nowIso, TG_DEVICES_MAX_PER_MEMBER),
    ])
  } catch {
    return { ok: false, reason: 'conflict' }
  }
  if (out[1].meta.changes !== 1) {
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tg_miniapp_devices WHERE tenant = ?1 AND member_id = ?2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL`,
    ).bind(tenant, input.token.member_id).first<{ n: number }>()
    return { ok: false, reason: (n?.n ?? 0) >= TG_DEVICES_MAX_PER_MEMBER ? 'too_many_devices' : 'token_spent' }
  }
  return { ok: true, deviceToken: `${deviceId}.${secret}`, deviceId }
}

export type ConfirmEnrolmentResult = { ok: true; deviceId: string } | { ok: false; reason: 'token_spent' | 'bad_device' }

/**
 * Activate the pending device ONLY when the Mini App read the secret BACK out of BiometricManager (so the device can
 * really round-trip it), the link is still live and names this member, the Telegram user is the one the device was
 * issued to, and its login identity is live; then consume the link. One batch: the link UPDATE is guarded by the
 * device UPDATE having changed a row, so a refusal on either side leaves the link unspent.
 */
/** W4.2 (TELEGRAM_MINIAPP_PIN_WINDOW): how the device unlocks, its PIN hash and its trusted window, written in the SAME guarded UPDATE that activates it. */
export interface DeviceSetup {
  unlockMode: 'biometric' | 'pin'
  pin: { saltHex: string; hashHex: string; iterations: number } | null
  trustWindowSeconds: number
}

export async function confirmDeviceEnrolment(
  env: Env, input: { token: TgEnrolmentTokenRow; deviceToken: string; telegramUserId: string; setup?: DeviceSetup }, nowMs: number,
): Promise<ConfirmEnrolmentResult> {
  const parsed = parseDeviceToken(input.deviceToken)
  if (!parsed) return { ok: false, reason: 'bad_device' }
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  const out = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tg_miniapp_devices SET confirmed_at = ?4${input.setup ? ', unlock_mode = ?8, pin_salt = ?9, pin_hash = ?10, pin_iterations = ?11, trust_window_seconds = ?12' : ''}
        WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND confirmed_at IS NULL AND revoked_at IS NULL
          AND enrolment_token_id = ?5 AND telegram_user_id = ?6 AND secret_sha256 = ?7
          AND EXISTS (SELECT 1 FROM tg_miniapp_enrolment_tokens t
                       WHERE t.id = ?5 AND t.tenant = ?2 AND t.member_id = ?3 AND t.consumed_at IS NULL AND t.expires_at > ?4)
          AND EXISTS (SELECT 1 FROM human_login_identities i
                       WHERE i.id = tg_miniapp_devices.login_identity_id AND i.tenant = ?2 AND i.member_id = ?3 AND i.revoked_at IS NULL)
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = ?3 AND m.tenant = ?2 AND m.telegram_chat_id = ?6 AND m.status = 'active')`,
    ).bind(parsed.deviceId, tenant, input.token.member_id, nowIso, input.token.id, input.telegramUserId, await tokenHash(parsed.secret),
      ...(input.setup ? [input.setup.unlockMode, input.setup.pin?.saltHex ?? null, input.setup.pin?.hashHex ?? null, input.setup.pin?.iterations ?? null, input.setup.trustWindowSeconds] : [])),
    env.DB.prepare(
      `UPDATE tg_miniapp_enrolment_tokens SET consumed_at = ?3
        WHERE id = ?1 AND tenant = ?2 AND consumed_at IS NULL AND expires_at > ?3 AND changes() = 1`,
    ).bind(input.token.id, tenant, nowIso),
  ])
  if (out[0].meta.changes !== 1 || out[1].meta.changes !== 1) {
    if (out[0].meta.changes === 1) {
      // Unreachable inside one transaction, but never leave an active device behind a link that is not spent.
      await env.DB.prepare(`UPDATE tg_miniapp_devices SET revoked_at = ?2, revoked_reason = 'enrol_inconsistent' WHERE id = ?1`).bind(parsed.deviceId, nowIso).run()
    }
    return { ok: false, reason: out[0].meta.changes === 1 ? 'token_spent' : 'bad_device' }
  }
  return { ok: true, deviceId: parsed.deviceId }
}

export type DeviceResolution = { kind: 'ok'; device: TgDeviceRow } | { kind: 'stale'; deviceId: string } | { kind: 'none' }

/**
 * The step-up check: the presented token names an ACTIVE device of exactly this member and this Telegram user, its
 * secret hashes to the stored digest, and its login identity is live. A RETIRED secret of an active device (the digest
 * a rotation replaced) is a harvested copy being replayed: the device is revoked on the spot and a receipt written
 * ('stale'). Anything else is 'none' (indistinguishable from an unknown device). consumeMomentTelegram re-checks the
 * same conditions for the CURRENT secret inside its own WHERE.
 */
export async function resolveDeviceForDecision(
  env: Env, deviceToken: unknown, who: { memberId: string; telegramUserId: string },
  /** W4.2: only the PIN-aware caller (TELEGRAM_MINIAPP_PIN_WINDOW on) may resolve a PIN-mode device; every other caller fails closed on one. */
  opts: { allowPinMode?: boolean } = {},
): Promise<DeviceResolution> {
  const parsed = parseDeviceToken(deviceToken)
  if (!parsed) return { kind: 'none' }
  const row = await env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS} FROM tg_miniapp_devices
      WHERE id = ?1 AND tenant = ?2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL${opts.allowPinMode ? '' : " AND unlock_mode = 'biometric'"} LIMIT 1`,
  ).bind(parsed.deviceId, env.TENANT_SLUG).first<TgDeviceRow>()
  if (!row) return { kind: 'none' }
  // Bound to exactly this member and Telegram user BEFORE anything else: a secret presented by anyone else is simply
  // unknown, so a harvested retired secret cannot be used by a third party to revoke someone's device (gate finding).
  if (row.member_id !== who.memberId || row.telegram_user_id !== who.telegramUserId) return { kind: 'none' }
  const presented = await tokenHash(parsed.secret)
  if (!timingSafeEqual(row.secret_sha256, presented)) {
    const retired = await env.DB.prepare(
      `SELECT 1 AS ok FROM tg_miniapp_retired_secrets WHERE secret_sha256 = ?1 AND tenant = ?2 AND device_id = ?3 LIMIT 1`,
    ).bind(presented, env.TENANT_SLUG, row.id).first<{ ok: number }>()
    if (!retired) return { kind: 'none' }
    const r = await env.DB.prepare(
      `UPDATE tg_miniapp_devices SET revoked_at = ?2, revoked_reason = 'stale_secret_replayed' WHERE id = ?1 AND revoked_at IS NULL`,
    ).bind(row.id, new Date().toISOString()).run()
    if (r.meta.changes === 1) {
      await recordTgAudit(env, {
        operation: 'tg_device_revoke', memberId: row.member_id, deviceId: row.id,
        evidence: { reason: 'stale_secret_replayed', suspicious: '1', presented_by_member_id: who.memberId, presented_by_telegram_user_id: who.telegramUserId },
      })
    }
    return { kind: 'stale', deviceId: row.id }
  }
  if (!row.login_identity_id) return { kind: 'none' }
  const identity = await env.DB.prepare(
    `SELECT id FROM human_login_identities WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(row.login_identity_id, env.TENANT_SLUG, row.member_id).first<{ id: string }>()
  return identity ? { kind: 'ok', device: row } : { kind: 'none' }
}

/** Convenience for callers that only need the live device (tests, enrolment checks). */
export async function resolveActiveDevice(
  env: Env, deviceToken: unknown, who: { memberId: string; telegramUserId: string },
): Promise<TgDeviceRow | null> {
  const r = await resolveDeviceForDecision(env, deviceToken, who)
  return r.kind === 'ok' ? r.device : null
}

export async function memberHasActiveDevice(env: Env, memberId: string, telegramUserId: string, opts: { allowPinMode?: boolean } = {}): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM tg_miniapp_devices d
       JOIN human_login_identities i ON i.id = d.login_identity_id AND i.tenant = d.tenant AND i.member_id = d.member_id AND i.revoked_at IS NULL
      WHERE d.tenant = ?1 AND d.member_id = ?2 AND d.telegram_user_id = ?3 AND d.confirmed_at IS NOT NULL AND d.revoked_at IS NULL${opts.allowPinMode ? '' : " AND d.unlock_mode = 'biometric'"} LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId, telegramUserId).first<{ ok: number }>()
  return row !== null
}

export async function listMemberTgDevices(env: Env, memberId: string): Promise<TgDeviceRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS} FROM tg_miniapp_devices WHERE tenant = ?1 AND member_id = ?2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at ASC`,
  ).bind(env.TENANT_SLUG, memberId).all<TgDeviceRow>()
  return rows.results ?? []
}

export async function revokeOwnTgDevice(env: Env, memberId: string, deviceId: string, nowMs: number = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE tg_miniapp_devices SET revoked_at = ?4, revoked_reason = 'owner_revoke' WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(deviceId, env.TENANT_SLUG, memberId, new Date(nowMs).toISOString()).run()
  if (r.meta.changes === 1) await recordTgAudit(env, { operation: 'tg_device_revoke', memberId, deviceId, evidence: { reason: 'owner_revoke' } }, nowMs)
  return r.meta.changes === 1
}

/**
 * The "cut this human off" levers (sign out everywhere, revoke a login identity) kill the Telegram devices too, from
 * revokeMemberPasskeys, so a device can never be the surviving door. A pot that has not applied 0214 has none.
 */
export async function revokeMemberTgDevices(
  env: Env, memberId: string, reason: string, opts: { loginIdentityId?: string } = {}, nowMs: number = Date.now(),
): Promise<number> {
  const nowIso = new Date(nowMs).toISOString()
  const tenant = env.TENANT_SLUG
  let r: Awaited<ReturnType<ReturnType<Env['DB']['prepare']>['run']>>
  try {
    r = opts.loginIdentityId
      ? await env.DB.prepare(
          `UPDATE tg_miniapp_devices SET revoked_at = ?4, revoked_reason = ?5
            WHERE tenant = ?1 AND member_id = ?2 AND login_identity_id = ?3 AND revoked_at IS NULL`,
        ).bind(tenant, memberId, opts.loginIdentityId, nowIso, reason.slice(0, 64)).run()
      : await env.DB.prepare(
          `UPDATE tg_miniapp_devices SET revoked_at = ?3, revoked_reason = ?4 WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL`,
        ).bind(tenant, memberId, nowIso, reason.slice(0, 64)).run()
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return 0
    throw err
  }
  const n = Number(r.meta?.changes ?? 0)
  if (n > 0) await recordTgAudit(env, { operation: 'tg_device_revoke', memberId, deviceId: null, evidence: { reason, count: String(n), ...(opts.loginIdentityId ? { login_identity_id: opts.loginIdentityId } : {}) } }, nowMs)
  return n
}

/** Device enrol/revoke are identity-surface writes: each leaves a mutation_audit_entries row (best effort, like passkeys). */
export async function recordTgAudit(
  env: Env,
  input: { operation: 'tg_device_enrol' | 'tg_device_revoke' | 'tg_device_rotate' | 'tg_device_pin_set' | 'tg_device_pin_attempt' | 'tg_device_pin_lockout' | 'tg_device_window_change'; memberId: string; deviceId: string | null; evidence: Record<string, string> },
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       VALUES (?1, ?2, 'member', ?3, ?3, 'admin_ui', 'secure_moment', ?4, 'member_tg_device', ?5, ?1, ?1, ?6, ?7)
       ON CONFLICT DO NOTHING`,
    ).bind(id, env.TENANT_SLUG, input.memberId, input.operation, input.deviceId ?? input.memberId,
      JSON.stringify({ ...input.evidence, device_id: input.deviceId, via: 'telegram_miniapp' }), new Date(nowMs).toISOString()).run()
    return true
  } catch {
    return false
  }
}

// ── the consuming statement ─────────────────────────────────────────────────────────────────────────
/**
 * THE consuming statement for a Telegram decision. `won` is true iff THIS call won it: the moment is still pending,
 * unexpired, of a kind the Mini App may decide (never a credential moment), addressed to this member (or to anyone),
 * AND the device is still an active one of this member and Telegram user with the presented secret, on a live login
 * identity, with the Telegram binding still in place. In the SAME batch (each statement guarded by `changes() = 1`
 * from the one before): the decision row lands, the presented secret is RETIRED and the device's secret becomes
 * `nextSecretSha256`. `nextDeviceToken` is non-null only when the whole chain landed, i.e. the client must now store it.
 */
export async function consumeMomentTelegram(
  env: Env,
  input: { momentId: string; decision: 'approve' | 'deny'; memberId: string; telegramUserId: string; deviceId: string; secretSha256: string },
  nowMs: number,
): Promise<{ won: boolean; nextDeviceToken: string | null }> {
  const nowIso = new Date(nowMs).toISOString()
  const tenant = env.TENANT_SLUG
  const nextSecret = randomToken()
  const out = await env.DB.batch([
    env.DB.prepare(
      `UPDATE secure_moments
          SET status = CASE WHEN ?4 = 'deny' THEN 'denied' ELSE 'consumed' END,
              decided_at = ?3, decision = ?4, decided_by_member_id = ?5
        WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND expires_at > ?3
          AND kind IN ('seed_attach', 'elevation')
          AND (decider_member_id IS NULL OR decider_member_id = ?5)
          AND EXISTS (SELECT 1 FROM tg_miniapp_devices d
                        JOIN human_login_identities i
                          ON i.id = d.login_identity_id AND i.tenant = d.tenant AND i.member_id = d.member_id AND i.revoked_at IS NULL
                        JOIN members m ON m.id = d.member_id AND m.tenant = d.tenant AND m.telegram_chat_id = d.telegram_user_id AND m.status = 'active'
                       WHERE d.id = ?6 AND d.tenant = ?2 AND d.member_id = ?5 AND d.telegram_user_id = ?7
                         AND d.secret_sha256 = ?8 AND d.confirmed_at IS NOT NULL AND d.revoked_at IS NULL
                         AND d.unlock_mode = 'biometric')`,
    ).bind(input.momentId, tenant, nowIso, input.decision, input.memberId, input.deviceId, input.telegramUserId, input.secretSha256),
    env.DB.prepare(
      `INSERT INTO tg_miniapp_decisions (moment_id, tenant, member_id, telegram_user_id, device_id, decision, decided_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
    ).bind(input.momentId, tenant, input.memberId, input.telegramUserId, input.deviceId, input.decision, nowIso),
    env.DB.prepare(
      `INSERT INTO tg_miniapp_retired_secrets (secret_sha256, tenant, device_id, retired_at)
       SELECT secret_sha256, tenant, id, ?2 FROM tg_miniapp_devices WHERE id = ?1 AND changes() = 1`,
    ).bind(input.deviceId, nowIso),
    env.DB.prepare(
      `UPDATE tg_miniapp_devices SET last_used_at = ?2, secret_sha256 = ?3 WHERE id = ?1 AND changes() = 1`,
    ).bind(input.deviceId, nowIso, await tokenHash(nextSecret)),
  ])
  const won = out[0].meta.changes === 1
  return { won, nextDeviceToken: won && out[3].meta.changes === 1 ? `${input.deviceId}.${nextSecret}` : null }
}

// ── the Telegram channel's own decision nonces ──────────────────────────────────────────────────────
export const TG_NONCE_TTL_MS = 5 * 60 * 1000
/** Live nonces one member may hold on one moment: the Telegram channel's own flood cap (passkey_challenges is not touched). */
export const TG_NONCE_MAX_OUTSTANDING = 5

export interface TgNonceBinding { momentId: string; memberId: string; telegramUserId: string; decision: 'approve' | 'deny'; payloadSha256: string }

/** Mint a nonce bound to (moment, member, Telegram user, decision, parameter digest); null when this member's cap is hit. */
export async function mintTgNonce(env: Env, b: TgNonceBinding, nowMs: number = Date.now()): Promise<string | null> {
  const nonce = randomToken()
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `INSERT INTO tg_miniapp_nonces
       (id, tenant, nonce_sha256, moment_id, member_id, telegram_user_id, decision, payload_sha256, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
      WHERE (SELECT COUNT(*) FROM tg_miniapp_nonces
              WHERE tenant = ?2 AND moment_id = ?4 AND member_id = ?5 AND consumed_at IS NULL AND expires_at > ?9) < ?11`,
  ).bind(crypto.randomUUID(), env.TENANT_SLUG, await tokenHash(nonce), b.momentId, b.memberId, b.telegramUserId, b.decision, b.payloadSha256,
    nowIso, new Date(nowMs + TG_NONCE_TTL_MS).toISOString(), TG_NONCE_MAX_OUTSTANDING).run()
  return r.meta.changes === 1 ? nonce : null
}

/** Consume a nonce (single use) only if it is live AND bound to exactly this ceremony. A mismatch consumes nothing. */
export async function consumeTgNonce(env: Env, nonce: string, b: TgNonceBinding, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE tg_miniapp_nonces SET consumed_at = ?2
      WHERE tenant = ?1 AND nonce_sha256 = ?3 AND consumed_at IS NULL AND expires_at > ?2
        AND moment_id = ?4 AND member_id = ?5 AND telegram_user_id = ?6 AND decision = ?7 AND payload_sha256 = ?8`,
  ).bind(env.TENANT_SLUG, new Date(nowMs).toISOString(), await tokenHash(nonce), b.momentId, b.memberId, b.telegramUserId, b.decision, b.payloadSha256).run()
  return r.meta.changes === 1
}

// ── delivery receipts (the worker sends the button) ─────────────────────────────────────────────────
export const TG_DELIVERY_WINDOW_MS = 10 * 60 * 1000
export const TG_DELIVERY_MAX_PER_WINDOW = 5

export async function recentDeliveryCount(env: Env, memberId: string, nowMs: number = Date.now()): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tg_miniapp_deliveries WHERE tenant = ?1 AND member_id = ?2 AND created_at > ?3`,
  ).bind(env.TENANT_SLUG, memberId, new Date(nowMs - TG_DELIVERY_WINDOW_MS).toISOString()).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Reserve a delivery slot ATOMICALLY: one INSERT ... SELECT whose WHERE counts this member's rows in the window, so
 * concurrent callers cannot all pass a read-then-write check (gate finding on #1868: 20 parallel calls sent 20). The
 * row starts 'reserved' (it counts against the cap); finishDelivery marks it sent or failed after the Bot API call.
 * Null = the member's window is full.
 */
export async function reserveDelivery(
  env: Env,
  input: { kind: 'moment' | 'enrol'; subjectId: string; memberId: string; requestedBy: string },
  nowMs: number = Date.now(),
): Promise<{ id: string; createdAt: string } | null> {
  const id = crypto.randomUUID()
  const createdAt = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `INSERT INTO tg_miniapp_deliveries (id, tenant, kind, subject_id, member_id, requested_by, status, error, telegram_message_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', NULL, NULL, ?7
      WHERE (SELECT COUNT(*) FROM tg_miniapp_deliveries WHERE tenant = ?2 AND member_id = ?5 AND created_at > ?8) < ?9`,
  ).bind(id, env.TENANT_SLUG, input.kind, input.subjectId, input.memberId, input.requestedBy, createdAt,
    new Date(nowMs - TG_DELIVERY_WINDOW_MS).toISOString(), TG_DELIVERY_MAX_PER_WINDOW).run()
  return r.meta.changes === 1 ? { id, createdAt } : null
}

export async function finishDelivery(
  env: Env, id: string, outcome: { status: 'sent' | 'failed'; error: string | null; messageId: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tg_miniapp_deliveries SET status = ?3, error = ?4, telegram_message_id = ?5 WHERE id = ?1 AND tenant = ?2 AND status = 'reserved'`,
  ).bind(id, env.TENANT_SLUG, outcome.status, outcome.error, outcome.messageId).run()
}

/** A reserved row older than this no longer blocks a re-send (the worker that reserved it died before finishing). */
export const TG_DELIVERY_RESERVED_STALE_MS = 60 * 1000

/**
 * The AUTOMATIC delivery's slot: exactly one send per (moment, member). One statement, so the dedupe and the per-member cap
 * both hold under concurrency. A row already `sent` (or `reserved` and still fresh) for this moment and member blocks a second
 * message, so a repeated tool call or a rotated link (same moment id) never double-sends; a `failed` row does not, so a later
 * call can retry (the per-member cap still bounds it). Returns the new slot, or why there is none.
 */
// One requesting agent may auto-notify a human at most this many times per window, so a single noisy or hostile agent cannot use
// up the human's whole allowance (and block other agents' approvals or the human's own device-setup message). The plain approve_url
// is still returned either way.
export const TG_DELIVERY_MAX_PER_REQUESTER = 3

export async function reserveMomentDeliveryOnce(
  env: Env,
  input: { momentId: string; memberId: string; requestedBy: string },
  nowMs: number = Date.now(),
): Promise<{ state: 'reserved'; id: string; createdAt: string } | { state: 'duplicate' } | { state: 'rate_limited' }> {
  const id = crypto.randomUUID()
  const createdAt = new Date(nowMs).toISOString()
  const staleBefore = new Date(nowMs - TG_DELIVERY_RESERVED_STALE_MS).toISOString()
  const r = await env.DB.prepare(
    `INSERT INTO tg_miniapp_deliveries (id, tenant, kind, subject_id, member_id, requested_by, status, error, telegram_message_id, created_at)
     SELECT ?1, ?2, 'moment', ?3, ?4, ?5, 'reserved', NULL, NULL, ?6
      WHERE NOT EXISTS (SELECT 1 FROM tg_miniapp_deliveries
                         WHERE tenant = ?2 AND kind = 'moment' AND subject_id = ?3 AND member_id = ?4
                           AND (status = 'sent' OR (status = 'reserved' AND created_at > ?7)))
        AND (SELECT COUNT(*) FROM tg_miniapp_deliveries WHERE tenant = ?2 AND member_id = ?4 AND created_at > ?8) < ?9
        AND (SELECT COUNT(*) FROM tg_miniapp_deliveries WHERE tenant = ?2 AND kind = 'moment' AND requested_by = ?5 AND created_at > ?8) < ?10`,
  ).bind(id, env.TENANT_SLUG, input.momentId, input.memberId, input.requestedBy, createdAt, staleBefore,
    new Date(nowMs - TG_DELIVERY_WINDOW_MS).toISOString(), TG_DELIVERY_MAX_PER_WINDOW, TG_DELIVERY_MAX_PER_REQUESTER).run()
  if (r.meta.changes === 1) return { state: 'reserved', id, createdAt }
  const dup = await env.DB.prepare(
    `SELECT 1 AS x FROM tg_miniapp_deliveries
      WHERE tenant = ?1 AND kind = 'moment' AND subject_id = ?2 AND member_id = ?3
        AND (status = 'sent' OR (status = 'reserved' AND created_at > ?4)) LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.momentId, input.memberId, staleBefore).first<{ x: number }>()
  return dup ? { state: 'duplicate' } : { state: 'rate_limited' }
}
