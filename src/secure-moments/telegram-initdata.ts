// mupot — Telegram Mini App `initData` verification (secure moments W4). Pure: no D1, no env, no clock reads.
//
// Telegram signs the data a Mini App is launched with. mupot accepts ONLY the third-party method (Ed25519, no bot
// token involved in validation): the `signature` field is a base64url Ed25519 signature over
//     "<bot_id>:WebAppData\n" + every received field EXCEPT `hash` and `signature`, as `key=<value>` lines sorted
//     alphabetically and joined by "\n"
// verified against Telegram's published public key. The classic HMAC path (`hash`, keyed by the bot token) was
// removed: the bot token is the root of trust and is used ONLY to send messages, never to validate, so a worker bug
// or log can never turn a validation oracle into a token use. A client that sends no `signature` (Bot API < 8.0) is refused.
// Source (read 2026-10-12): https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
// Telegram publishes NO worked test vector, so the tests sign with a node:crypto keypair (an independent code path
// from the WebCrypto verify below) and the signed string is built by an independent helper in the test file.
//
// What this module guarantees: the payload was produced by Telegram for THIS bot (the bot id is in the signed
// string, built from OUR configured id, never from the payload), is fresh, and carries a well-formed user id.
// What it does NOT say: who that Telegram user is in mupot (the caller maps the id to a member) nor that the
// person at the phone is the account owner (the biometric device secret is the step-up for that).
import { b64uDecode, hex, sha256 } from './webauthn'

/** Telegram's published Ed25519 public key for the PRODUCTION environment (hex, 32 bytes). */
export const TELEGRAM_PROD_PUBKEY_HEX = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d'
/**
 * Telegram's published key for its TEST environment. Exported for documentation and the pin test ONLY: it is NOT
 * in the default accepted set (see acceptedPublicKeys in telegram-miniapp-config.ts); a staging pot opts in explicitly.
 */
export const TELEGRAM_TEST_PUBKEY_HEX = '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec'

export const INITDATA_MAX_LENGTH = 8192
/** A payload dated in the future by more than this is refused (clock skew allowance, seconds). */
export const INITDATA_FUTURE_SKEW_SECONDS = 60

export type InitDataFailure =
  | 'bad_format' | 'duplicate_field' | 'missing_field' | 'bad_auth_date' | 'stale' | 'future'
  | 'bad_user' | 'signature_required' | 'bad_signature' | 'bad_config'

export interface VerifiedInitData {
  /** Which documented path verified it. */
  method: 'ed25519'
  /** Unix seconds Telegram stamped on the launch. */
  authDate: number
  /** The Telegram user id (digits, positive). */
  userId: string
  /** `chat_type` when present (sender/private/group/supergroup/channel). */
  chatType: string | null
  /** The signed `start_param` when present (a launch parameter, covered by the signature). */
  startParam: string | null
}

export type InitDataResult = { ok: true; data: VerifiedInitData } | { ok: false; reason: InitDataFailure }

export interface VerifyOptions {
  /** OUR bot's numeric id (TELEGRAM_MINIAPP_BOT_ID): put into the signed string, never read from the payload. */
  botId: string
  /** Accepted Ed25519 public keys (hex). Empty = the Ed25519 path is closed. */
  publicKeysHex: readonly string[]
  nowMs: number
  maxAgeSeconds: number
}

const BOT_ID_RE = /^[1-9][0-9]{4,15}$/
const KEY_RE = /^[A-Za-z0-9_]{1,32}$/
// eslint-disable-next-line no-control-regex -- the point is to match control characters
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/

/**
 * Strict split of the query string: every segment is key=value, keys are unique and plain, nothing is skipped.
 * (URLSearchParams silently drops empty segments and keeps duplicates; either would let two different raw strings
 * stand for one signed string, so both are refused here.)
 */
export function parseInitData(raw: unknown): { ok: true; fields: Map<string, string> } | { ok: false; reason: 'bad_format' | 'duplicate_field' } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > INITDATA_MAX_LENGTH) return { ok: false, reason: 'bad_format' }
  // eslint-disable-next-line no-control-regex -- control characters (incl. a raw LF that would forge a data-check-string line) have no place in a query string
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return { ok: false, reason: 'bad_format' }
  const fields = new Map<string, string>()
  for (const segment of raw.split('&')) {
    const eq = segment.indexOf('=')
    if (eq <= 0) return { ok: false, reason: 'bad_format' }
    const rawKey = segment.slice(0, eq)
    if (!KEY_RE.test(rawKey)) return { ok: false, reason: 'bad_format' }
    let value: string
    try {
      value = decodeURIComponent(segment.slice(eq + 1).replace(/\+/g, ' '))
    } catch {
      return { ok: false, reason: 'bad_format' }
    }
    // DECODE-THEN-REJECT: the raw string is checked above, but %0A / %0D / %00 decode to control characters that would
    // fold one field's value into extra data-check-string lines. No signed value legitimately contains one (JSON text
    // escapes them), so a decoded control character anywhere is refused.
    if (CONTROL_RE.test(value)) return { ok: false, reason: 'bad_format' }
    if (fields.has(rawKey)) return { ok: false, reason: 'duplicate_field' }
    fields.set(rawKey, value)
  }
  return { ok: true, fields }
}

function sortedLines(fields: Map<string, string>, exclude: readonly string[]): string {
  return [...fields.entries()]
    .filter(([k]) => !exclude.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** The exact string Telegram signs for the third-party (Ed25519) path. Exported so tests pin the construction. */
export function thirdPartyDataCheckString(botId: string, fields: Map<string, string>): string {
  return `${botId}:WebAppData\n${sortedLines(fields, ['hash', 'signature'])}`
}

function hexToBytes(h: string): Uint8Array | null {
  if (!PUBKEY_HEX_RE.test(h)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function verifyEd25519(publicKeysHex: readonly string[], message: string, signature: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false
  const data = new TextEncoder().encode(message)
  for (const keyHex of publicKeysHex) {
    const raw = hexToBytes(keyHex)
    if (!raw) continue
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
      if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data)) return true
    } catch {
      // an unusable key is skipped, never accepted
    }
  }
  return false
}

function readUserId(rawUser: string | undefined): string | null {
  if (rawUser === undefined || rawUser.length > 2048) return null
  try {
    const parsed: unknown = JSON.parse(rawUser)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('id' in parsed)) return null
    const id = parsed.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return null
    return String(id)
  } catch {
    return null
  }
}

export async function verifyInitData(raw: unknown, opts: VerifyOptions): Promise<InitDataResult> {
  if (!BOT_ID_RE.test(opts.botId) || !Number.isFinite(opts.maxAgeSeconds) || opts.maxAgeSeconds <= 0) return { ok: false, reason: 'bad_config' }
  const parsed = parseInitData(raw)
  if (!parsed.ok) return parsed
  const { fields } = parsed

  // `signature` is mandatory. Telegram sends it unpadded base64url; a trailing '=' padding is tolerated (it decodes to the
  // same bytes) and nothing else is: the decoded signature must be exactly 64 bytes and verify.
  const signatureB64 = fields.get('signature')
  if (signatureB64 === undefined) return { ok: false, reason: 'signature_required' }
  const sig = b64uDecode(signatureB64.replace(/={1,2}$/, ''))
  if (!sig || !(await verifyEd25519(opts.publicKeysHex, thirdPartyDataCheckString(opts.botId, fields), sig))) {
    return { ok: false, reason: 'bad_signature' }
  }
  const method = 'ed25519' as const

  // Freshness runs AFTER the signature: only a payload Telegram signed is worth dating.
  const authDateRaw = fields.get('auth_date')
  if (authDateRaw === undefined) return { ok: false, reason: 'missing_field' }
  if (!/^[1-9][0-9]{0,11}$/.test(authDateRaw)) return { ok: false, reason: 'bad_auth_date' }
  const authDate = Number(authDateRaw)
  const ageSeconds = Math.floor(opts.nowMs / 1000) - authDate
  if (ageSeconds > opts.maxAgeSeconds) return { ok: false, reason: 'stale' }
  if (ageSeconds < -INITDATA_FUTURE_SKEW_SECONDS) return { ok: false, reason: 'future' }

  const userId = readUserId(fields.get('user'))
  if (!userId) return { ok: false, reason: 'bad_user' }
  return {
    ok: true,
    data: { method, authDate, userId, chatType: fields.get('chat_type') ?? null, startParam: fields.get('start_param') ?? null },
  }
}

/** sha256 hex helper kept here so callers need not reach into webauthn.ts for one digest. */
export async function digestHex(text: string): Promise<string> {
  return hex(await sha256(text))
}
