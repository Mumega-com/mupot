// mupot — WebAuthn server-side verification on WebCrypto (no dependency, runs in workerd and node).
//
// Scope, deliberately narrow:
//   - ES256 only (COSE alg -7, P-256). Registration asks for exactly that algorithm; any other key is refused.
//   - attestation is requested as 'none' and NEVER trusted: the attestation statement is not verified, the
//     credential public key is taken from the authenticator data. A passkey proves "the same authenticator
//     again", never anything about the device make; it grants no authority (docs/architecture/secure-moments.md).
//   - user verification (UV) is REQUIRED on every ceremony, as is user presence (UP).
//   - the RP ID is the dedicated secure host and the origin must equal https://<host> exactly.
// This module is pure: no I/O, no clock. Challenge lifetime, sign-count policy and "whose credential" live in
// store.ts / routes.ts.

import { timingSafeEqual } from '../lib/crypto' // the repo's one constant-time comparator (tests/timing-safe-equal.test.ts)

const enc = new TextEncoder()

export function b64uEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict base64url (no padding, no other alphabet); null when malformed. */
export function b64uDecode(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length > 16384 || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── minimal CBOR (RFC 8949) decoder: only what attestation objects and COSE keys use ─────────────────
export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>

class CborError extends Error {}

function readCbor(buf: Uint8Array, start: number, depth: number): { value: Cbor; next: number } {
  if (depth > 8) throw new CborError('too deep')
  if (start >= buf.length) throw new CborError('truncated')
  const head = buf[start]
  const major = head >> 5
  const info = head & 0x1f
  let pos = start + 1
  let arg: number
  if (info < 24) {
    arg = info
  } else if (info === 24 || info === 25 || info === 26) {
    const n = info === 24 ? 1 : info === 25 ? 2 : 4
    if (pos + n > buf.length) throw new CborError('truncated')
    arg = 0
    for (let i = 0; i < n; i++) arg = arg * 256 + buf[pos + i]
    pos += n
  } else {
    throw new CborError('unsupported length form') // 64-bit and indefinite lengths are never produced by authenticators
  }
  switch (major) {
    case 0:
      return { value: arg, next: pos }
    case 1:
      return { value: -1 - arg, next: pos }
    case 2: {
      if (pos + arg > buf.length) throw new CborError('truncated')
      return { value: buf.slice(pos, pos + arg), next: pos + arg }
    }
    case 3: {
      if (pos + arg > buf.length) throw new CborError('truncated')
      return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf.slice(pos, pos + arg)), next: pos + arg }
    }
    case 4: {
      if (arg > 64) throw new CborError('array too long')
      const out: Cbor[] = []
      for (let i = 0; i < arg; i++) {
        const item = readCbor(buf, pos, depth + 1)
        out.push(item.value)
        pos = item.next
      }
      return { value: out, next: pos }
    }
    case 5: {
      if (arg > 64) throw new CborError('map too long')
      const out = new Map<Cbor, Cbor>()
      for (let i = 0; i < arg; i++) {
        const k = readCbor(buf, pos, depth + 1)
        const v = readCbor(buf, k.next, depth + 1)
        if (out.has(k.value)) throw new CborError('duplicate key')
        out.set(k.value, v.value)
        pos = v.next
      }
      return { value: out, next: pos }
    }
    case 7: {
      if (info === 20) return { value: false, next: pos }
      if (info === 21) return { value: true, next: pos }
      if (info === 22) return { value: null, next: pos }
      throw new CborError('unsupported simple value')
    }
    default:
      throw new CborError('unsupported major type')
  }
}

/** Decode ONE item; returns null on any malformed input. `next` is the offset just past it. */
export function decodeCbor(buf: Uint8Array, start = 0): { value: Cbor; next: number } | null {
  try {
    return readCbor(buf, start, 0)
  } catch {
    return null
  }
}

// ── shared checks ─────────────────────────────────────────────────────────────────────────────────────
export interface Expected {
  /** base64url of the challenge the server issued for THIS ceremony. */
  challenge: string
  /** Exactly https://<secure host>. */
  origin: string
  /** The secure host (RP ID). */
  rpId: string
}

export type WebAuthnFailure =
  | 'bad_client_data' | 'bad_type' | 'challenge_mismatch' | 'origin_mismatch' | 'cross_origin'
  | 'bad_auth_data' | 'rp_id_mismatch' | 'user_not_present' | 'user_not_verified' | 'bad_flags'
  | 'bad_attestation' | 'bad_key' | 'bad_signature'

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

interface ClientData { type: unknown; challenge: unknown; origin: unknown; crossOrigin?: unknown; topOrigin?: unknown }

function checkClientData(raw: Uint8Array, type: 'webauthn.create' | 'webauthn.get', want: Expected): WebAuthnFailure | null {
  let cd: ClientData
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'bad_client_data'
    cd = parsed as ClientData // as: just narrowed to a plain object; every field is checked as unknown below
  } catch {
    return 'bad_client_data'
  }
  if (cd.type !== type) return 'bad_type'
  if (typeof cd.challenge !== 'string' || cd.challenge !== want.challenge) return 'challenge_mismatch'
  if (typeof cd.origin !== 'string' || cd.origin !== want.origin) return 'origin_mismatch'
  // An assertion produced inside a cross-origin iframe (or with a topOrigin) is not this page asking.
  if (cd.crossOrigin === true || cd.topOrigin !== undefined) return 'cross_origin'
  return null
}

interface ParsedAuthData {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
  rest: Uint8Array
}

function parseAuthData(auth: Uint8Array): ParsedAuthData | null {
  if (auth.length < 37) return null
  const signCount = ((auth[33] << 24) | (auth[34] << 16) | (auth[35] << 8) | auth[36]) >>> 0
  return { rpIdHash: auth.slice(0, 32), flags: auth[32], signCount, rest: auth.slice(37) }
}

async function checkAuthFlags(a: ParsedAuthData, rpId: string): Promise<WebAuthnFailure | null> {
  if (!timingSafeEqual(hex(a.rpIdHash), hex(await sha256(rpId)))) return 'rp_id_mismatch'
  if ((a.flags & FLAG_UP) === 0) return 'user_not_present'
  if ((a.flags & FLAG_UV) === 0) return 'user_not_verified'
  if ((a.flags & FLAG_BS) !== 0 && (a.flags & FLAG_BE) === 0) return 'bad_flags' // backed up but not backup-eligible: impossible
  return null
}

// ── ES256 key handling ────────────────────────────────────────────────────────────────────────────────
const SPKI_P256_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
])

async function importEs256(spki: Uint8Array): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  } catch {
    return null
  }
}

/** COSE_Key (EC2, P-256, ES256) -> SPKI DER; null for any other key or an invalid curve point. */
async function coseToSpki(cose: Cbor): Promise<Uint8Array | null> {
  if (!(cose instanceof Map)) return null
  const kty = cose.get(1)
  const alg = cose.get(3)
  const crv = cose.get(-1)
  const x = cose.get(-2)
  const y = cose.get(-3)
  if (kty !== 2 || alg !== -7 || crv !== 1) return null
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return null
  const spki = new Uint8Array(SPKI_P256_PREFIX.length + 64)
  spki.set(SPKI_P256_PREFIX)
  spki.set(x, SPKI_P256_PREFIX.length)
  spki.set(y, SPKI_P256_PREFIX.length + 32)
  return (await importEs256(spki)) ? spki : null // importKey rejects a point that is not on the curve
}

/** ASN.1 DER ECDSA signature -> IEEE P1363 (r||s, 64 bytes) as WebCrypto expects; null if malformed. */
export function derToP1363(der: Uint8Array): Uint8Array | null {
  let p = 0
  if (der[p++] !== 0x30) return null
  let len = der[p++]
  if (len === undefined) return null
  if (len & 0x80) {
    const n = len & 0x7f
    if (n !== 1) return null
    len = der[p++]
  }
  if (len !== der.length - p) return null
  const out = new Uint8Array(64)
  for (let part = 0; part < 2; part++) {
    if (der[p++] !== 0x02) return null
    const l = der[p++]
    if (l === undefined || l === 0 || p + l > der.length) return null
    let int = der.slice(p, p + l)
    p += l
    if ((int[0] & 0x80) !== 0) return null // negative
    while (int.length > 1 && int[0] === 0) int = int.slice(1)
    if (int.length > 32) return null
    out.set(int, part * 32 + (32 - int.length))
  }
  return p === der.length ? out : null
}

// ── registration ──────────────────────────────────────────────────────────────────────────────────────
export interface VerifiedRegistration {
  credentialId: string // base64url
  publicKeySpki: string // base64url
  signCount: number
  aaguid: string // hex
}

export async function verifyRegistration(
  input: { clientDataJSON: unknown; attestationObject: unknown },
  want: Expected,
): Promise<{ ok: true; registration: VerifiedRegistration } | { ok: false; reason: WebAuthnFailure }> {
  const cdj = b64uDecode(input.clientDataJSON)
  const ao = b64uDecode(input.attestationObject)
  if (!cdj || !ao) return { ok: false, reason: 'bad_client_data' }
  const cdFail = checkClientData(cdj, 'webauthn.create', want)
  if (cdFail) return { ok: false, reason: cdFail }
  const decoded = decodeCbor(ao)
  if (!decoded || decoded.next !== ao.length || !(decoded.value instanceof Map)) return { ok: false, reason: 'bad_attestation' }
  const authBytes = decoded.value.get('authData')
  if (!(authBytes instanceof Uint8Array)) return { ok: false, reason: 'bad_attestation' }
  const a = parseAuthData(authBytes)
  if (!a) return { ok: false, reason: 'bad_auth_data' }
  const flagFail = await checkAuthFlags(a, want.rpId)
  if (flagFail) return { ok: false, reason: flagFail }
  if ((a.flags & FLAG_AT) === 0) return { ok: false, reason: 'bad_flags' }
  const r = a.rest
  if (r.length < 18) return { ok: false, reason: 'bad_auth_data' }
  const aaguid = r.slice(0, 16)
  const idLen = (r[16] << 8) | r[17]
  if (idLen < 16 || idLen > 1023 || r.length < 18 + idLen) return { ok: false, reason: 'bad_auth_data' }
  const credId = r.slice(18, 18 + idLen)
  const key = decodeCbor(r, 18 + idLen)
  if (!key) return { ok: false, reason: 'bad_key' }
  const spki = await coseToSpki(key.value)
  if (!spki) return { ok: false, reason: 'bad_key' }
  return {
    ok: true,
    registration: { credentialId: b64uEncode(credId), publicKeySpki: b64uEncode(spki), signCount: a.signCount, aaguid: hex(aaguid) },
  }
}

// ── assertion ─────────────────────────────────────────────────────────────────────────────────────────
export async function verifyAssertion(
  input: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown },
  want: Expected,
  publicKeySpki: string,
): Promise<{ ok: true; signCount: number } | { ok: false; reason: WebAuthnFailure }> {
  const cdj = b64uDecode(input.clientDataJSON)
  const authBytes = b64uDecode(input.authenticatorData)
  const sigDer = b64uDecode(input.signature)
  if (!cdj || !authBytes || !sigDer) return { ok: false, reason: 'bad_client_data' }
  const cdFail = checkClientData(cdj, 'webauthn.get', want)
  if (cdFail) return { ok: false, reason: cdFail }
  const a = parseAuthData(authBytes)
  if (!a) return { ok: false, reason: 'bad_auth_data' }
  const flagFail = await checkAuthFlags(a, want.rpId)
  if (flagFail) return { ok: false, reason: flagFail }
  const spki = b64uDecode(publicKeySpki)
  const key = spki ? await importEs256(spki) : null
  if (!key) return { ok: false, reason: 'bad_key' }
  const raw = derToP1363(sigDer)
  if (!raw) return { ok: false, reason: 'bad_signature' }
  const signed = new Uint8Array(authBytes.length + 32)
  signed.set(authBytes)
  signed.set(await sha256(cdj), authBytes.length)
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed)
  return good ? { ok: true, signCount: a.signCount } : { ok: false, reason: 'bad_signature' }
}
