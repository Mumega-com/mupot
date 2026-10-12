// mupot — secure moments W4.2: the PIN fallback and the user-chosen trusted-device window for the Telegram Mini App.
// Flag: TELEGRAM_MINIAPP_PIN_WINDOW (needs the Mini App channel itself on). OFF means the W4.1 code path, untouched.
//
// WHAT THIS ADDS, AND WHAT IT DOES NOT: a PIN and a window are two more ways a device proves "the same human again". They
// grant NOTHING. The policy that keeps sensitive elevations and home_access passkey-only (telegramPolicyRefusal) runs
// BEFORE anything here is consulted, so neither can satisfy those kinds. A seed approve is not "routine": it always needs a
// fresh biometric or PIN, never the window.
//
// THE FACTORS
//   biometric device  : initData + device secret (read out of BiometricManager, i.e. behind the fingerprint/face).
//   PIN device        : initData + device secret (kept in the Mini App's device storage) + the 6-digit PIN, which only
//                       the SERVER can check (salted PBKDF2). Chosen at setup when BiometricManager is missing
//                       (Telegram Desktop / web) or the user prefers it.
//   trusted window    : after any successful decision the server records trusted_until = now + the device's window and
//                       issues a TRUST SECRET. While now < trusted_until a routine decision needs only initData + that
//                       trust secret. It is a SECOND, rotating secret (not the device secret): the phone must cache it
//                       outside BiometricManager to use it without a prompt, and a copy of the device secret must not turn
//                       an expired window back into "no prompt". The server voids the trust secret at trusted_until.
//
// Every state change is ONE guarded statement (or a batch guarded on the decision row existing); the caller trusts only
// meta.changes. The PIN is never logged, stored, echoed or put in a receipt.
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { randomToken, tokenHash } from './store'
import { telegramMiniappStatus } from './telegram-miniapp-config'
import {
  parseDeviceToken, recordTgAudit, resolveDeviceForDecision, type TgDeviceRow,
} from './telegram-miniapp-store'

// ── flag ────────────────────────────────────────────────────────────────────────────────────────────
export function pinWindowFlag(env: Pick<Env, 'TELEGRAM_MINIAPP_PIN_WINDOW'>): boolean {
  const v = env.TELEGRAM_MINIAPP_PIN_WINDOW?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** On only when the sub-flag is set AND the Mini App channel is itself fully on (a misconfigured channel stays dark). */
export function pinWindowOn(env: Env): boolean {
  return pinWindowFlag(env) && telegramMiniappStatus(env).state === 'on'
}

// ── the window ──────────────────────────────────────────────────────────────────────────────────────
export const TRUST_WINDOW_MAX_SECONDS = 7 * 24 * 60 * 60
export const TRUST_WINDOW_DEFAULT_SECONDS = 30 * 60
/** The ONLY accepted values. Anything else (a forged 10-year window, 31 minutes, a string) is refused server-side. */
export const TRUST_WINDOW_PRESETS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'Every time' },
  { seconds: 30 * 60, label: '30 minutes' },
  { seconds: 2 * 60 * 60, label: '2 hours' },
  { seconds: 8 * 60 * 60, label: '8 hours' },
  { seconds: 24 * 60 * 60, label: '24 hours' },
  { seconds: TRUST_WINDOW_MAX_SECONDS, label: '7 days' },
]

/** A preset's seconds, or null for anything that is not exactly one of them (so the 7-day cap cannot be exceeded). */
export function parseTrustWindow(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  return TRUST_WINDOW_PRESETS.some((p) => p.seconds === v) ? v : null
}

// ── the PIN ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * PBKDF2-HMAC-SHA256 at 100,000 iterations: the highest count Cloudflare Workers' WebCrypto accepts (it throws above it),
 * about tens of milliseconds of CPU per attempt, well inside a Worker's budget. A 6-digit PIN has only 10^6 values, so the
 * hash is defence in depth for a leaked database, NOT the protection: that is the 5-attempt lockout, which also needs the
 * device secret and fresh signed initData before a single guess is even counted.
 */
export const PIN_ITERATIONS = 100_000
export const PIN_MAX_WRONG = 5

export function pinFormatOk(pin: unknown): pin is string {
  return typeof pin === 'string' && /^[0-9]{6}$/.test(pin)
}

/** Refuse the PINs a thief tries first: one repeated digit, and straight runs up or down. Format is checked separately. */
export function pinIsTooEasy(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true
  const d = [...pin].map(Number)
  const step = d[1] - d[0]
  return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)
}

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

export function newPinSaltHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)))
}

export interface PinBinding { deviceId: string; memberId: string; telegramUserId: string }

/**
 * The hash is bound to the device row: the salt is the per-device random salt AND the device, member and Telegram user it
 * belongs to, so a hash copied onto another device (or another member's device) never verifies there.
 */
export async function derivePinHash(pin: string, saltHex: string, bind: PinBinding, iterations: number): Promise<string> {
  const enc = new TextEncoder()
  const prefix = enc.encode(`mupot.tg.pin.v1|${bind.deviceId}|${bind.memberId}|${bind.telegramUserId}|`)
  const rand = enc.encode(saltHex)
  const salt = new Uint8Array(prefix.length + rand.length)
  salt.set(prefix, 0)
  salt.set(rand, prefix.length)
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Math.min(Math.max(1, iterations), PIN_ITERATIONS) }, key, 256)
  return toHex(new Uint8Array(bits))
}

// ── per-device columns (kept apart from the W4 store so flag-off never selects a W4.2 column) ───────
export interface PwColumns {
  unlock_mode: 'biometric' | 'pin'
  pin_salt: string | null
  pin_hash: string | null
  pin_iterations: number | null
  pin_failed_attempts: number
  trust_window_seconds: number
  trust_secret_sha256: string | null
  trusted_until: string | null
}
export type PwDevice = TgDeviceRow & PwColumns

async function loadActivePwDevice(env: Env, deviceId: string): Promise<PwDevice | null> {
  return env.DB.prepare(
    `SELECT * FROM tg_miniapp_devices WHERE id = ?1 AND tenant = ?2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL LIMIT 1`,
  ).bind(deviceId, env.TENANT_SLUG).first<PwDevice>()
}

/** What the phone needs to render itself and the account page needs to list. */
export async function listMemberTgDevicesPw(env: Env, memberId: string): Promise<Array<Pick<PwDevice, 'id' | 'created_at' | 'confirmed_at' | 'last_used_at' | 'unlock_mode' | 'trust_window_seconds' | 'trusted_until'>>> {
  const rows = await env.DB.prepare(
    `SELECT id, created_at, confirmed_at, last_used_at, unlock_mode, trust_window_seconds, trusted_until
       FROM tg_miniapp_devices WHERE tenant = ?1 AND member_id = ?2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at ASC`,
  ).bind(env.TENANT_SLUG, memberId).all<Pick<PwDevice, 'id' | 'created_at' | 'confirmed_at' | 'last_used_at' | 'unlock_mode' | 'trust_window_seconds' | 'trusted_until'>>()
  return rows.results ?? []
}

// ── enrolment: parse what the human chose ───────────────────────────────────────────────────────────
export type SetupParse =
  | { ok: true; setup: { unlockMode: 'biometric' | 'pin'; pin: { saltHex: string; hashHex: string; iterations: number } | null; trustWindowSeconds: number } }
  | { ok: false; message: string }

/** Validate the unlock mode, PIN and window of an enrolment confirm. Nothing is derived from a value outside the allowed sets. */
export async function parseDeviceSetup(
  body: Record<string, unknown>, deviceToken: string, memberId: string, telegramUserId: string,
): Promise<SetupParse> {
  const mode = body.unlock_mode === undefined ? 'biometric' : body.unlock_mode
  if (mode !== 'biometric' && mode !== 'pin') return { ok: false, message: 'Unknown unlock method.' }
  const window = body.trust_window_seconds === undefined ? TRUST_WINDOW_DEFAULT_SECONDS : parseTrustWindow(body.trust_window_seconds)
  if (window === null) return { ok: false, message: 'That trusted-device window is not one of the allowed choices (the longest is 7 days).' }
  if (mode === 'biometric') return { ok: true, setup: { unlockMode: 'biometric', pin: null, trustWindowSeconds: window } }
  if (!pinFormatOk(body.pin)) return { ok: false, message: 'The PIN must be exactly 6 digits.' }
  if (pinIsTooEasy(body.pin)) return { ok: false, message: 'Choose a PIN that is not a repeated digit or a straight run (like 123456).' }
  const parsed = parseDeviceToken(deviceToken)
  if (!parsed) return { ok: false, message: 'The device could not be confirmed. Start again from the link.' }
  const saltHex = newPinSaltHex()
  const hashHex = await derivePinHash(body.pin, saltHex, { deviceId: parsed.deviceId, memberId, telegramUserId }, PIN_ITERATIONS)
  return { ok: true, setup: { unlockMode: 'pin', pin: { saltHex, hashHex, iterations: PIN_ITERATIONS }, trustWindowSeconds: window } }
}

// ── decide: authorise ───────────────────────────────────────────────────────────────────────────────
export type PwAuth =
  | { ok: true; device: TgDeviceRow & { login_identity_id: string }; proof: 'secret' | 'trust'; presentedSha256: string }
  | { ok: false; status: 403; title: string; message: string; extra: Record<string, unknown> }

const refuse = (title: string, message: string, code: string, extra: Record<string, unknown> = {}): PwAuth => ({ ok: false, status: 403, title, message, extra: { code, ...extra } })
const NOT_RECOGNISED = refuse('Device not recognised', 'This device is not recognised for decisions. Set it up again from My Account (Telegram device) on the dashboard.', 'device_not_recognised')

async function identityIsLive(env: Env, row: TgDeviceRow): Promise<boolean> {
  if (!row.login_identity_id) return false
  const identity = await env.DB.prepare(
    `SELECT id FROM human_login_identities WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
  ).bind(row.login_identity_id, env.TENANT_SLUG, row.member_id).first<{ id: string }>()
  return identity !== null
}

async function lockIfCapped(env: Env, deviceId: string, memberId: string, nowMs: number): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `UPDATE tg_miniapp_devices SET revoked_at = ?3, revoked_reason = 'pin_lockout'
      WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL AND pin_failed_attempts >= ?4`,
  ).bind(deviceId, env.TENANT_SLUG, nowIso, PIN_MAX_WRONG).run()
  if (r.meta.changes === 1) {
    await recordTgAudit(env, { operation: 'tg_device_pin_lockout', memberId, deviceId, evidence: { reason: 'pin_lockout', max_wrong: String(PIN_MAX_WRONG) } }, nowMs)
    return true
  }
  return false
}

const LOCKED = refuse('Device removed', 'Too many wrong PINs, so this phone was removed for your safety. Set it up again from My Account (Telegram device).', 'pin_lockout')

/**
 * The PIN gate. An attempt first RESERVES a slot (one guarded UPDATE: counter < 5 and not revoked), then hashes, so N
 * concurrent guesses can trigger at most 5 verifications in total. The fifth wrong PIN revokes the device ('pin_lockout').
 * A correct PIN resets the consecutive-wrong counter. Receipts carry the outcome and the count, never the PIN.
 */
async function checkPin(env: Env, device: PwDevice, pin: unknown, nowMs: number): Promise<PwAuth | null> {
  if (!device.pin_hash || !device.pin_salt || !device.pin_iterations) return NOT_RECOGNISED // a PIN device with no PIN fails closed
  if (!pinFormatOk(pin)) return refuse('PIN needed', 'Enter your 6-digit PIN.', 'pin_required')
  const reserved = await env.DB.prepare(
    `UPDATE tg_miniapp_devices SET pin_failed_attempts = pin_failed_attempts + 1
      WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL AND unlock_mode = 'pin' AND pin_failed_attempts < ?3`,
  ).bind(device.id, env.TENANT_SLUG, PIN_MAX_WRONG).run()
  if (reserved.meta.changes !== 1) {
    await lockIfCapped(env, device.id, device.member_id, nowMs)
    return LOCKED
  }
  const got = await derivePinHash(pin, device.pin_salt, { deviceId: device.id, memberId: device.member_id, telegramUserId: device.telegram_user_id }, device.pin_iterations)
  if (timingSafeEqual(got, device.pin_hash)) {
    await env.DB.prepare(`UPDATE tg_miniapp_devices SET pin_failed_attempts = 0 WHERE id = ?1 AND tenant = ?2 AND revoked_at IS NULL`).bind(device.id, env.TENANT_SLUG).run()
    await recordTgAudit(env, { operation: 'tg_device_pin_attempt', memberId: device.member_id, deviceId: device.id, evidence: { outcome: 'ok' } }, nowMs)
    return null
  }
  const after = await env.DB.prepare(`SELECT pin_failed_attempts AS n FROM tg_miniapp_devices WHERE id = ?1 AND tenant = ?2`).bind(device.id, env.TENANT_SLUG).first<{ n: number }>()
  const used = after?.n ?? PIN_MAX_WRONG
  await recordTgAudit(env, { operation: 'tg_device_pin_attempt', memberId: device.member_id, deviceId: device.id, evidence: { outcome: 'wrong', failed_attempts: String(used) } }, nowMs)
  if (await lockIfCapped(env, device.id, device.member_id, nowMs)) return LOCKED
  const left = Math.max(0, PIN_MAX_WRONG - used)
  return refuse('Wrong PIN', left > 0 ? `That PIN is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before this phone is removed.` : 'That PIN is not right.', 'pin_wrong', { attempts_left: left })
}

type TrustResolution = { kind: 'live'; device: PwDevice } | { kind: 'expired' } | { kind: 'stale' } | { kind: 'none' }

/** The trust-secret door: the presented token must name an ACTIVE device of exactly this member and Telegram user. */
async function resolveTrust(env: Env, trustToken: unknown, who: { memberId: string; telegramUserId: string }, nowMs: number): Promise<TrustResolution> {
  const parsed = parseDeviceToken(trustToken)
  if (!parsed) return { kind: 'none' }
  const row = await loadActivePwDevice(env, parsed.deviceId)
  if (!row) return { kind: 'none' }
  if (row.member_id !== who.memberId || row.telegram_user_id !== who.telegramUserId) return { kind: 'none' }
  const presented = await tokenHash(parsed.secret)
  if (row.trust_secret_sha256 !== null && timingSafeEqual(row.trust_secret_sha256, presented)) {
    if (row.trusted_until === null || !(Date.parse(row.trusted_until) > nowMs)) return { kind: 'expired' }
    return (await identityIsLive(env, row)) ? { kind: 'live', device: row } : { kind: 'none' }
  }
  // A digest this device already retired (a rotated trust or device secret): a harvested copy is being replayed.
  const retired = await env.DB.prepare(
    `SELECT 1 AS ok FROM tg_miniapp_retired_secrets WHERE secret_sha256 = ?1 AND tenant = ?2 AND device_id = ?3 LIMIT 1`,
  ).bind(presented, env.TENANT_SLUG, row.id).first<{ ok: number }>()
  if (!retired) return { kind: 'none' }
  const r = await env.DB.prepare(
    `UPDATE tg_miniapp_devices SET revoked_at = ?2, revoked_reason = 'stale_secret_replayed' WHERE id = ?1 AND revoked_at IS NULL`,
  ).bind(row.id, new Date(nowMs).toISOString()).run() // the revoke trigger ends the window in the same statement
  if (r.meta.changes === 1) {
    await recordTgAudit(env, {
      operation: 'tg_device_revoke', memberId: row.member_id, deviceId: row.id,
      evidence: { reason: 'stale_secret_replayed', suspicious: '1', presented: 'trust_secret', presented_by_member_id: who.memberId, presented_by_telegram_user_id: who.telegramUserId },
    }, nowMs)
  }
  return { kind: 'stale' }
}

const STALE = refuse('Device removed', 'This device presented an out-of-date secret, so it was removed for your safety. Set it up again (My Account, Telegram device).', 'device_removed')

/**
 * Pick the credential, verify it, and say which proof carried the decision. `routine` is decided by the caller from the
 * policy it already enforced: only a deny or a (non-sensitive) elevation approve is routine; a seed approve never is.
 *  - `device_token` present: the W4 secret path (+ the PIN when the device unlocks with one).
 *  - else `trust_token`: the window path, routine decisions only, only while trusted_until is in the future.
 * Every refusal here is read-only with respect to the nonce, so the client can answer it and retry on the same challenge.
 */
export async function pwAuthorize(
  env: Env, input: { body: Record<string, unknown>; who: { memberId: string; telegramUserId: string }; routine: boolean }, nowMs: number,
): Promise<PwAuth> {
  const { body, who } = input
  const hasDevice = body.device_token !== undefined && body.device_token !== null && body.device_token !== ''
  if (!hasDevice) {
    if (body.trust_token === undefined || body.trust_token === null || body.trust_token === '') return NOT_RECOGNISED
    const t = await resolveTrust(env, body.trust_token, who, nowMs)
    if (t.kind === 'stale') return STALE
    if (t.kind === 'expired') return refuse('Confirm again', 'Your trusted-device time is over. Confirm with your fingerprint, face or PIN.', 'window_expired')
    if (t.kind !== 'live' || !t.device.login_identity_id) return NOT_RECOGNISED
    if (!input.routine) return refuse('Confirm again', 'This kind of request always needs a fresh fingerprint, face or PIN.', 'prompt_required')
    const parsed = parseDeviceToken(body.trust_token)
    return { ok: true, device: { ...t.device, login_identity_id: t.device.login_identity_id }, proof: 'trust', presentedSha256: await tokenHash(parsed?.secret ?? '') }
  }
  const resolved = await resolveDeviceForDecision(env, body.device_token, who)
  if (resolved.kind === 'stale') return STALE
  if (resolved.kind !== 'ok' || !resolved.device.login_identity_id) return NOT_RECOGNISED
  const device = await loadActivePwDevice(env, resolved.device.id)
  if (!device || !device.login_identity_id) return NOT_RECOGNISED
  if (device.unlock_mode === 'pin') {
    const refusal = await checkPin(env, device, body.pin, nowMs)
    if (refusal) return refusal
  }
  return { ok: true, device: { ...device, login_identity_id: device.login_identity_id }, proof: 'secret', presentedSha256: device.secret_sha256 }
}

// ── the consuming statement (W4.2 form) ─────────────────────────────────────────────────────────────
export interface PwConsumeResult { won: boolean; nextDeviceToken: string | null; nextTrustToken: string | null; trustedUntil: string | null }

const ISO_PLUS_WINDOW = `strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || trust_window_seconds || ' seconds')`

/**
 * THE consuming statement for a Telegram decision under W4.2. Same shape as consumeMomentTelegram (the moment is consumed
 * only if the device is an active one of this member and Telegram user, on a live identity, with the Telegram binding in
 * place) with the proof the caller used re-checked INSIDE the WHERE:
 *  - 'secret': d.secret_sha256 = presented. Then the secret rotates AND, if the device's window is not 0, trusted_until =
 *    now + trust_window_seconds is set from the ROW (so a window shortened a moment ago wins) with a fresh trust secret.
 *  - 'trust' : d.trust_secret_sha256 = presented AND d.trusted_until > now. Then ONLY the trust secret rotates; trusted_until
 *    does not move (a window is never extended by being used).
 * Later statements are guarded on THIS decision's row existing, so a lost race changes nothing.
 */
export async function consumeMomentTelegramPw(
  env: Env,
  input: { momentId: string; decision: 'approve' | 'deny'; memberId: string; telegramUserId: string; deviceId: string; presentedSha256: string; proof: 'secret' | 'trust' },
  nowMs: number,
): Promise<PwConsumeResult> {
  const nowIso = new Date(nowMs).toISOString()
  const tenant = env.TENANT_SLUG
  const nextSecret = randomToken()
  const nextTrust = randomToken()
  const nextSecretSha = await tokenHash(nextSecret)
  const nextTrustSha = await tokenHash(nextTrust)
  const proofCond = input.proof === 'secret'
    ? 'd.secret_sha256 = ?8'
    : 'd.trust_secret_sha256 = ?8 AND d.trusted_until IS NOT NULL AND d.trusted_until > ?3'
  const decided = `EXISTS (SELECT 1 FROM tg_miniapp_decisions WHERE moment_id = ?1 AND device_id = ?2 AND decided_at = ?3)`
  const update = input.proof === 'secret'
    ? `UPDATE tg_miniapp_devices SET last_used_at = ?3, secret_sha256 = ?4,
         trust_secret_sha256 = CASE WHEN trust_window_seconds > 0 THEN ?5 ELSE NULL END,
         trusted_until = CASE WHEN trust_window_seconds > 0 THEN ${ISO_PLUS_WINDOW} ELSE NULL END
       WHERE id = ?2 AND ${decided}`
    : `UPDATE tg_miniapp_devices SET last_used_at = ?3, trust_secret_sha256 = ?5 WHERE id = ?2 AND ${decided}`
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
                         AND ${proofCond} AND d.confirmed_at IS NOT NULL AND d.revoked_at IS NULL)`,
    ).bind(input.momentId, tenant, nowIso, input.decision, input.memberId, input.deviceId, input.telegramUserId, input.presentedSha256),
    env.DB.prepare(
      `INSERT INTO tg_miniapp_decisions (moment_id, tenant, member_id, telegram_user_id, device_id, decision, decided_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
    ).bind(input.momentId, tenant, input.memberId, input.telegramUserId, input.deviceId, input.decision, nowIso),
    // retire the digest that was just used (it is a copy if it is ever presented again)
    env.DB.prepare(
      `INSERT OR IGNORE INTO tg_miniapp_retired_secrets (secret_sha256, tenant, device_id, retired_at)
       SELECT ?4, ?5, ?2, ?3 WHERE ${decided}`,
    ).bind(input.momentId, input.deviceId, nowIso, input.presentedSha256, tenant),
    // a trust secret the secret path is about to replace is retired too, so a harvested copy of it is still detected
    env.DB.prepare(
      `INSERT OR IGNORE INTO tg_miniapp_retired_secrets (secret_sha256, tenant, device_id, retired_at)
       SELECT trust_secret_sha256, tenant, id, ?3 FROM tg_miniapp_devices
        WHERE id = ?2 AND trust_secret_sha256 IS NOT NULL AND trust_secret_sha256 <> ?4 AND ${decided}`,
    ).bind(input.momentId, input.deviceId, nowIso, input.presentedSha256),
    env.DB.prepare(update).bind(input.momentId, input.deviceId, nowIso, nextSecretSha, nextTrustSha),
    env.DB.prepare(
      `SELECT trust_secret_sha256 = ?2 AS issued, trusted_until FROM tg_miniapp_devices WHERE id = ?1`,
    ).bind(input.deviceId, nextTrustSha),
  ])
  const won = out[0].meta.changes === 1
  if (!won) return { won: false, nextDeviceToken: null, nextTrustToken: null, trustedUntil: null }
  const applied = out[4].meta.changes === 1
  const sel = (out[5].results?.[0] ?? null) as { issued: number | null; trusted_until: string | null } | null
  const trustIssued = applied && sel !== null && Number(sel.issued) === 1
  return {
    won,
    nextDeviceToken: applied && input.proof === 'secret' ? `${input.deviceId}.${nextSecret}` : null,
    nextTrustToken: trustIssued ? `${input.deviceId}.${nextTrust}` : null,
    trustedUntil: trustIssued ? sel.trusted_until : null,
  }
}

// ── /account: change the window ─────────────────────────────────────────────────────────────────────
export type ChangeWindowResult = { ok: true; from: number; to: number } | { ok: false; reason: 'bad_window' | 'not_found' }

/**
 * Set a device's window (a preset, nothing else). SHORTENING takes effect NOW: the live trusted_until is clamped to
 * now + the new window (0 ends it and voids the trust secret). Lengthening never extends a window already running; it
 * applies from the next successful decision. Guarded to the owner's own live device; the receipt records from and to.
 */
export async function changeTrustWindow(
  env: Env, memberId: string, deviceId: string, seconds: unknown, nowMs: number = Date.now(),
): Promise<ChangeWindowResult> {
  const to = parseTrustWindow(seconds)
  if (to === null) return { ok: false, reason: 'bad_window' }
  const before = await env.DB.prepare(
    `SELECT trust_window_seconds AS w FROM tg_miniapp_devices WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND confirmed_at IS NOT NULL AND revoked_at IS NULL`,
  ).bind(deviceId, env.TENANT_SLUG, memberId).first<{ w: number }>()
  const clamp = `strftime('%Y-%m-%dT%H:%M:%fZ', ?5, '+' || ?4 || ' seconds')`
  const r = await env.DB.prepare(
    `UPDATE tg_miniapp_devices
        SET trust_window_seconds = ?4,
            trusted_until = CASE WHEN ?4 = 0 THEN NULL
                                 WHEN trusted_until IS NOT NULL AND trusted_until > ${clamp} THEN ${clamp}
                                 ELSE trusted_until END,
            trust_secret_sha256 = CASE WHEN ?4 = 0 THEN NULL ELSE trust_secret_sha256 END
      WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND confirmed_at IS NOT NULL AND revoked_at IS NULL`,
  ).bind(deviceId, env.TENANT_SLUG, memberId, to, new Date(nowMs).toISOString()).run()
  if (r.meta.changes !== 1) return { ok: false, reason: 'not_found' }
  const from = before?.w ?? TRUST_WINDOW_DEFAULT_SECONDS
  await recordTgAudit(env, { operation: 'tg_device_window_change', memberId, deviceId, evidence: { from_seconds: String(from), to_seconds: String(to) } }, nowMs)
  return { ok: true, from, to }
}
