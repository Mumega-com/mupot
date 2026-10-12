// Test helper: builds Telegram-shaped initData signed with node:crypto, an implementation INDEPENDENT of the WebCrypto
// verifier under test (src/secure-moments/telegram-initdata.ts) and of its data-check-string builder: the signed string
// is assembled here from Telegram's documented rules (https://core.telegram.org/bots/webapps#validating-data-for-third-party-use).
import { createHmac, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto'

export interface TestKey { privateKey: KeyObject; publicKeyHex: string }

export function newTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, publicKeyHex: Buffer.from(der.subarray(der.length - 32)).toString('hex') }
}

export interface InitDataSpec {
  botId?: string
  userId?: number | string
  authDate?: number
  chatType?: string
  startParam?: string
  extra?: Record<string, string>
  /** Sign with this key (default: the supplied test key). */
  key?: TestKey
  /** Bot id placed in the SIGNED string (default: botId). Lets a test sign for one bot and present for another. */
  signedBotId?: string
  /** Emit no signature (classic clients); with hmacToken a valid hash is added. */
  omitSignature?: boolean
  hmacToken?: string
  /** Replace the signed string wholesale (signature over the WRONG string). */
  signedString?: (fields: Record<string, string>) => string
  /** Rewrite fields AFTER signing (tamper). */
  tamper?: (fields: Record<string, string>) => void
  /** Emit the pairs in this key order (default sorted reversed, to prove order does not matter). */
  order?: 'sorted' | 'reversed' | 'signature-first'
  userJson?: string
  /** With omitSignature + hmacToken: put THIS (invalid) signature in the payload BEFORE the HMAC is computed, so the hash is valid over it. */
  invalidSignatureUnderValidHash?: string
}

const b64u = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function dataCheckStringFor(botId: string, fields: Record<string, string>): string {
  const keys = Object.keys(fields).filter((k) => k !== 'hash' && k !== 'signature').sort()
  return `${botId}:WebAppData\n${keys.map((k) => `${k}=${fields[k]}`).join('\n')}`
}

export function initData(spec: InitDataSpec, defaultKey: TestKey, nowMs: number = Date.now()): string {
  const botId = spec.botId ?? '123456789'
  const fields: Record<string, string> = {
    auth_date: String(spec.authDate ?? Math.floor(nowMs / 1000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: spec.userJson ?? JSON.stringify({ id: spec.userId ?? 1001, first_name: 'Téa St+', last_name: 'A B', username: 'tea', language_code: 'en' }),
    ...(spec.chatType ? { chat_type: spec.chatType, chat_instance: '8428209589180549439' } : {}),
    ...(spec.startParam ? { start_param: spec.startParam } : {}),
    ...(spec.extra ?? {}),
  }
  if (!spec.omitSignature) {
    const key = spec.key ?? defaultKey
    const signed = spec.signedString ? spec.signedString(fields) : dataCheckStringFor(spec.signedBotId ?? botId, fields)
    fields.signature = b64u(nodeSign(null, Buffer.from(signed, 'utf8'), key.privateKey))
    fields.hash = 'f'.repeat(64) // Telegram sends a hash too; the third-party path must ignore it
  } else if (spec.hmacToken) {
    if (spec.invalidSignatureUnderValidHash !== undefined) fields.signature = spec.invalidSignatureUnderValidHash
    const secret = createHmac('sha256', 'WebAppData').update(spec.hmacToken).digest()
    const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
    fields.hash = createHmac('sha256', secret).update(dcs).digest('hex')
  }
  spec.tamper?.(fields)
  let keys = Object.keys(fields)
  if (spec.order === 'sorted') keys = keys.sort()
  else if (spec.order === 'signature-first') keys = ['signature', ...keys.filter((k) => k !== 'signature')]
  else keys = keys.sort().reverse()
  return keys.map((k) => `${k}=${encodeURIComponent(fields[k])}`).join('&')
}
