// tests/telegram-initdata.test.ts — Telegram Mini App initData verification (src/secure-moments/telegram-initdata.ts),
// pure: forgery, replay (freshness), wrong bot, signed-over-the-wrong-string, query ordering/encoding, duplicate keys,
// the production key pin, and the removal of the classic HMAC path. Signatures come from node:crypto (tests/helpers).
import { describe, expect, it } from 'vitest'
import {
  INITDATA_FUTURE_SKEW_SECONDS, parseInitData, TELEGRAM_PROD_PUBKEY_HEX, TELEGRAM_TEST_PUBKEY_HEX,
  thirdPartyDataCheckString, verifyInitData, type VerifyOptions,
} from '../src/secure-moments/telegram-initdata'
import { acceptedPublicKeys, miniappMaxAgeSeconds } from '../src/secure-moments/telegram-miniapp-config'
import { dataCheckStringFor, initData, newTestKey } from './helpers/telegram-initdata'

const BOT = '123456789'
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const key = newTestKey()
const other = newTestKey()
const opts = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({ botId: BOT, publicKeysHex: [key.publicKeyHex], nowMs: NOW, maxAgeSeconds: 300, ...over })
const make = (spec: Parameters<typeof initData>[0] = {}): string => initData({ authDate: Math.floor(NOW / 1000), ...spec }, key, NOW)
const reason = async (raw: unknown, o: VerifyOptions = opts()): Promise<string> => {
  const r = await verifyInitData(raw, o)
  return r.ok ? 'ok' : r.reason
}

describe('pinned Telegram keys', () => {
  it('pins the published production and test public keys byte for byte', () => {
    // https://core.telegram.org/bots/webapps#validating-data-for-third-party-use (read 2026-10-12)
    expect(TELEGRAM_PROD_PUBKEY_HEX).toBe('e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d')
    expect(TELEGRAM_TEST_PUBKEY_HEX).toBe('40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec')
  })
  it('the default accepted set is the PRODUCTION key alone: the Telegram test key is not accepted unless an operator adds it', () => {
    expect(acceptedPublicKeys({})).toEqual([TELEGRAM_PROD_PUBKEY_HEX])
    expect(acceptedPublicKeys({})).not.toContain(TELEGRAM_TEST_PUBKEY_HEX)
    expect(acceptedPublicKeys({ TELEGRAM_MINIAPP_EXTRA_PUBKEYS: TELEGRAM_TEST_PUBKEY_HEX })).toEqual([TELEGRAM_PROD_PUBKEY_HEX, TELEGRAM_TEST_PUBKEY_HEX])
  })
  it('extra keys: malformed, short, non-hex and duplicate entries are dropped, never interpreted', () => {
    const k = key.publicKeyHex
    expect(acceptedPublicKeys({ TELEGRAM_MINIAPP_EXTRA_PUBKEYS: `${k}, ${k.toUpperCase()},zz, ${k.slice(2)},${TELEGRAM_PROD_PUBKEY_HEX},` })).toEqual([TELEGRAM_PROD_PUBKEY_HEX, k])
  })
  it('a payload signed by a key outside the accepted set is refused', async () => {
    expect(await reason(make({ key: other }))).toBe('bad_signature')
    expect(await reason(make(), opts({ publicKeysHex: [TELEGRAM_PROD_PUBKEY_HEX] }))).toBe('bad_signature')
    expect(await reason(make(), opts({ publicKeysHex: [] }))).toBe('bad_signature')
  })
})

describe('third-party (Ed25519) path', () => {
  it('verifies a correctly signed payload and returns the signed fields', async () => {
    const r = await verifyInitData(make({ userId: 1001, chatType: 'private', startParam: 'm_abc' }), opts())
    expect(r).toEqual({ ok: true, data: { method: 'ed25519', authDate: Math.floor(NOW / 1000), userId: '1001', chatType: 'private', startParam: 'm_abc' } })
  })
  it('the data-check-string is bot_id:WebAppData, LF, then sorted key=value lines without hash and signature', () => {
    const fields = new Map([['user', '{"id":1}'], ['auth_date', '5'], ['hash', 'h'], ['signature', 's'], ['query_id', 'q']])
    expect(thirdPartyDataCheckString('42424', fields)).toBe('42424:WebAppData\nauth_date=5\nquery_id=q\nuser={"id":1}')
    expect(thirdPartyDataCheckString(BOT, new Map([['b', '1'], ['a', '2']]))).toBe(dataCheckStringFor(BOT, { b: '1', a: '2' }))
  })
  it('query-string order does not matter (the string is sorted before signing)', async () => {
    for (const order of ['sorted', 'reversed', 'signature-first'] as const) expect(await reason(make({ order }))).toBe('ok')
  })
  it('percent-encoding and + inside values: a space as + or %20, a literal plus as %2B, unicode, all decode to the signed string', async () => {
    expect(await reason(make({ userJson: JSON.stringify({ id: 1001, first_name: 'A+B C é 名' }) }))).toBe('ok')
    const raw = make({ userJson: JSON.stringify({ id: 1001, first_name: 'A B' }) }).replace(/%20/g, '+')
    expect(await reason(raw)).toBe('ok')
  })
  it('a different bot id: signed for another bot, or presented to a bot with another id, is refused', async () => {
    expect(await reason(make({ signedBotId: '987654321' }))).toBe('bad_signature')
    expect(await reason(make({ botId: '987654321' }))).toBe('bad_signature') // presented to OUR bot id 123456789 in opts
    expect(await reason(make(), opts({ botId: '987654321' }))).toBe('bad_signature')
  })
  it('a signature over the WRONG string is refused: no bot prefix, hash included, signature included, wrong separator', async () => {
    const f = (fields: Record<string, string>): string => Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
    expect(await reason(make({ signedString: (fields) => f(fields) }))).toBe('bad_signature')
    expect(await reason(make({ signedString: (fields) => `${BOT}:WebAppData ${f(fields)}` }))).toBe('bad_signature')
    expect(await reason(make({ signedString: (fields) => `${BOT}:WebAppData\n${f({ ...fields, hash: 'f'.repeat(64) })}` }))).toBe('bad_signature')
    expect(await reason(make({ signedString: (fields) => `${BOT}:WebAppData\n${f(fields).replace(/\n/g, '&')}` }))).toBe('bad_signature')
    expect(await reason(make({ signedString: (fields) => `WebAppData:${BOT}\n${f(fields)}` }))).toBe('bad_signature')
  })
  it('any tampering after signing breaks it: user id, auth_date, an added field, a removed field', async () => {
    expect(await reason(make({ tamper: (f) => { f.user = JSON.stringify({ id: 1002, first_name: 'x' }) } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { f.auth_date = String(Number(f.auth_date) + 1) } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { f.start_param = 'm_evil' } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { delete f.query_id } }))).toBe('bad_signature')
  })
  it('a garbage, truncated, padded or wrong-length signature is refused, and there is no fallback path', async () => {
    expect(await reason(make({ tamper: (f) => { f.signature = 'AAAA' } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { f.signature = '!!!' } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { f.signature = f.signature.slice(0, 40) } }))).toBe('bad_signature')
    expect(await reason(make({ tamper: (f) => { f.signature = '' } }), opts())).toBe('bad_signature')
  })
  it('the third-party path ignores the hash field (Telegram sends one beside the signature)', async () => {
    expect(await reason(make({ tamper: (f) => { f.hash = '0'.repeat(64) } }))).toBe('ok')
    expect(await reason(make({ tamper: (f) => { delete f.hash } }))).toBe('ok')
  })
})

describe('parsing', () => {
  it('refuses duplicate keys (including a second signature or user), empty segments, missing =, bad keys, controls and whitespace', async () => {
    const good = make()
    expect(await reason(`${good}&user=%7B%22id%22%3A2%7D`)).toBe('duplicate_field')
    expect(await reason(`${good}&signature=AAAA`)).toBe('duplicate_field')
    expect(await reason(`${good}&auth_date=1`)).toBe('duplicate_field')
    expect(await reason(`${good}&`)).toBe('bad_format')
    expect(await reason(`${good}&&x=1`)).toBe('bad_format')
    expect(await reason(`${good}&flag`)).toBe('bad_format')
    expect(await reason(`${good}&=1`)).toBe('bad_format')
    expect(await reason(`${good}&Bad-Key=1`)).toBe('bad_format')
    expect(await reason(`${good}\n`)).toBe('bad_format')
    expect(await reason(`${good} `)).toBe('bad_format')
    expect(await reason(`${good}&x=%ZZ`)).toBe('bad_format')
  })
  it('refuses a non-string, empty or oversized payload', async () => {
    for (const bad of [undefined, null, 5, {}, [], '', 'a'.repeat(9000)]) expect(await reason(bad)).toBe('bad_format')
    expect(parseInitData('a=1&b=2')).toMatchObject({ ok: true })
  })
})

describe('freshness (replay)', () => {
  const at = (ageSeconds: number, o: Partial<VerifyOptions> = {}): Promise<string> =>
    reason(make({ authDate: Math.floor(NOW / 1000) - ageSeconds }), opts(o))
  it('accepts up to the window and refuses one second past it', async () => {
    expect(await at(0)).toBe('ok')
    expect(await at(300)).toBe('ok')
    expect(await at(301)).toBe('stale')
    expect(await at(86400)).toBe('stale')
  })
  it('refuses a payload dated in the future beyond the skew allowance', async () => {
    expect(await at(-INITDATA_FUTURE_SKEW_SECONDS)).toBe('ok')
    expect(await at(-(INITDATA_FUTURE_SKEW_SECONDS + 1))).toBe('future')
  })
  it('the window is configurable and capped at one hour', async () => {
    expect(await at(1000, { maxAgeSeconds: 1200 })).toBe('ok')
    expect(miniappMaxAgeSeconds({})).toBe(300)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '900' })).toBe(900)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '999999' })).toBe(3600)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '0' })).toBe(300)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '-5' })).toBe(300)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '1e9' })).toBe(300)
    expect(miniappMaxAgeSeconds({ TELEGRAM_MINIAPP_MAX_AGE_SECONDS: '3600' })).toBe(3600)
  })
  it('refuses a missing, zero, negative, fractional or non-numeric auth_date (signed, so the refusal is the freshness check itself)', async () => {
    // Signed OVER the odd value (the signed string is built from the mutated fields), so only the freshness rule can refuse it.
    const bad = (value: string | null): Promise<string> => reason(make({
      signedString: (f) => { if (value === null) delete f.auth_date; else f.auth_date = value; return dataCheckStringFor(BOT, f) },
    }))
    expect(await bad(null)).toBe('missing_field')
    expect(await bad('0')).toBe('bad_auth_date')
    expect(await bad('-5')).toBe('bad_auth_date')
    expect(await bad('1.5')).toBe('bad_auth_date')
    expect(await bad('abc')).toBe('bad_auth_date')
  })
  it('freshness is judged only AFTER the signature: an unsigned stale payload reads as a bad signature', async () => {
    expect(await reason(make({ authDate: 5, tamper: (f) => { f.signature = 'AAAA' } }))).toBe('bad_signature')
  })
})

describe('the user', () => {
  const withUser = (userJson: string | undefined): Promise<string> => reason(make({ userJson }))
  it('needs a positive safe integer id', async () => {
    expect(await withUser(JSON.stringify({ id: 0 }))).toBe('bad_user')
    expect(await withUser(JSON.stringify({ id: -4 }))).toBe('bad_user')
    expect(await withUser(JSON.stringify({ id: '1001' }))).toBe('bad_user')
    expect(await withUser(JSON.stringify({ id: 1.5 }))).toBe('bad_user')
    expect(await withUser(JSON.stringify({ id: 2 ** 60 }))).toBe('bad_user')
    expect(await withUser(JSON.stringify({ name: 'x' }))).toBe('bad_user')
    expect(await withUser('not json')).toBe('bad_user')
    expect(await withUser('[1001]')).toBe('bad_user')
    expect(await withUser(JSON.stringify({ id: 7000000001 }))).toBe('ok')
  })
  it('a payload with no user at all is refused', async () => {
    const raw = initData({ authDate: Math.floor(NOW / 1000), signedString: (f) => { delete f.user; return dataCheckStringFor(BOT, f) }, tamper: (f) => { delete f.user } }, key, NOW)
    expect(await reason(raw)).toBe('bad_user')
  })
})

describe('Ed25519 only: the classic HMAC path is gone', () => {
  it('a payload with no signature (a client older than Bot API 8.0) is refused, whatever else it carries', async () => {
    expect(await reason(make({ omitSignature: true }))).toBe('signature_required')
    // Even a payload carrying a well-formed hash: there is no hash path at all.
    expect(await reason(make({ omitSignature: true, tamper: (f) => { f.hash = 'a'.repeat(64) } }))).toBe('signature_required')
  })
  it('the verifier has no bot-token input and the config module has no HMAC token reader', async () => {
    const mod = await import('../src/secure-moments/telegram-miniapp-config')
    expect(Object.keys(mod)).not.toContain('miniappHmacToken')
    expect(await reason(make({ omitSignature: true }), { ...opts(), ...({ hmacBotToken: `${BOT}:AAEhqMY-classic-test-token` } as object) })).toBe('signature_required')
  })
})

describe('signature encoding and decoded control characters', () => {
  it('accepts Telegram\'s unpadded base64url and the same bytes with = padding; refuses malformed padding', async () => {
    expect(await reason(make({ encodeSignature: (b) => b }))).toBe('ok')
    expect(await reason(make({ encodeSignature: (b) => `${b}==` }))).toBe('ok') // 64 bytes => 86 chars; padding is 2
    expect(await reason(make({ encodeSignature: (b) => `${b}===` }))).toBe('bad_signature')
    expect(await reason(make({ encodeSignature: (b) => `${b.slice(0, 40)}=${b.slice(40)}` }))).toBe('bad_signature')
    expect(await reason(make({ encodeSignature: (b) => `${b}==x` }))).toBe('bad_signature')
  })
  it('a control character that only appears AFTER percent-decoding is refused in every field (the %0A folding probe)', async () => {
    // Signed over the folded string, so only the decode-then-reject rule can refuse it.
    for (const value of ['q\nchat_type=sender', 'q\rx', 'q\u0000x', 'q\u007fx']) {
      const fields = { query_id: value }
      expect(await reason(make({ chatType: 'group', extra: fields }))).toBe('bad_format')
    }
    expect(await reason(make({ startParam: 'a\nb' }))).toBe('bad_format')
    expect(await reason(make({ userJson: '{"id":1001,"first_name":"A\nB"}' }))).toBe('bad_format')
    // The folded payload would otherwise present chat_type=sender to the fence while Telegram signed chat_type=group:
    const raw = make({ chatType: 'group', extra: { query_id: 'q\nchat_type=sender' } })
    expect(raw).toContain('%0A')
    expect(parseInitData(raw)).toEqual({ ok: false, reason: 'bad_format' })
  })
  it('ordinary escaped text inside JSON still verifies (the JSON text has no raw control characters)', async () => {
    expect(await reason(make({ userJson: JSON.stringify({ id: 1001, first_name: 'line1\nline2\t\u2028x' }) }))).toBe('ok')
  })
})

describe('configuration is validated', () => {
  it('a malformed bot id or a non-positive window is bad_config, not a verification', async () => {
    expect(await reason(make(), opts({ botId: 'abc' }))).toBe('bad_config')
    expect(await reason(make(), opts({ botId: '12' }))).toBe('bad_config')
    expect(await reason(make(), opts({ maxAgeSeconds: 0 }))).toBe('bad_config')
    expect(await reason(make(), opts({ maxAgeSeconds: Number.NaN }))).toBe('bad_config')
  })
})
