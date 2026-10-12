// mupot - host key + drop name validation and the fingerprint spelling (pure; no secret ever passes through here).
// The SERVER only ever sees a PUBLIC key. Contract: docs/architecture/secure-moments.md ("W2: secure drops").
import { b64uDecode, b64uEncode, hex, sha256 } from '../secure-moments/webauthn'

/** The HPKE info prefix and suite label: info = INFO_PREFIX + drop id + "|" + host key fingerprint (hex); aad = drop id. */
export const HPKE_INFO_PREFIX = 'mupot-secure-drop/v1|'

/** A drop name is a safe filename slug: lower-case alphanumerics, '_' and '-', no dots, no leading '_'/'-', <= 63. */
export const DROP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
export function isValidDropName(v: unknown): v is string {
  return typeof v === 'string' && DROP_NAME_RE.test(v)
}

/** The X25519 small-order points (libsodium's blocklist): a key equal to one of them gives an all-zero shared secret. */
const LOW_ORDER_HEX = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]

export interface ParsedHostKey {
  /** Canonical base64url of the 32 raw bytes. */
  publicKeyB64u: string
  /** Lower-case hex sha256 of the raw public key. */
  fingerprint: string
}

/** 43-character base64url (no padding) of exactly 32 bytes, not a small-order point. Null otherwise. */
export async function parseHostPublicKey(v: unknown): Promise<ParsedHostKey | null> {
  if (typeof v !== 'string' || v.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(v)) return null
  const raw = b64uDecode(v)
  if (!raw || raw.length !== 32) return null
  if (b64uEncode(raw) !== v) return null // non-canonical trailing bits
  if (LOW_ORDER_HEX.includes(hex(raw))) return null
  return { publicKeyB64u: v, fingerprint: hex(await sha256(raw)) }
}

/** The human-comparable spelling: 16 groups of 4 hex digits ("ab12 cd34 ..."). */
export function groupFingerprint(fingerprintHex: string): string {
  return (fingerprintHex.match(/.{4}/g) ?? []).join(' ')
}

export function hpkeInfo(dropId: string, fingerprintHex: string): string {
  return `${HPKE_INFO_PREFIX}${dropId}|${fingerprintHex}`
}
