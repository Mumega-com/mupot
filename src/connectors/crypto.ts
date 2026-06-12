// mupot — connector credential crypto (issue #116).
//
// AES-GCM-256 + HKDF for per-connector secret encryption. Adapted from the
// inkwell-api intake-crypto pattern; domain-separated for mupot connector types.
//
// Algorithm:
//   CONNECTOR_MASTER_KEY (256-bit hex Worker secret)
//   → HKDF-SHA256(master, salt=connector_id, info='mupot_connector_<type>_v1')
//   → per-connector AES-GCM-256 key
//   → encrypt(key, IV=random 96-bit, plaintext) → base64(iv || ciphertext || tag)
//
// Domain separation: each connector type uses a distinct `info` string so that
// even if two connectors share the same id (impossible by UUID, but defensive),
// the derived keys differ. The connector_id (UUID) is the HKDF salt — unique
// per connector row, never reused.
//
// Fail-closed (ADV-C-13 from intake-crypto): decrypt throws on ANY failure.
// Callers must translate to 500 and NEVER fall through to using a bad plaintext.
//
// Plaintext discipline:
//   - NEVER log, NEVER return in API responses, NEVER persist in any field.
//   - Use immediately for the outbound tool call, then discard.

const IV_BYTES = 12 // GCM standard 96-bit IV
const KEY_BITS = 256

export type ConnectorType =
  | 'telegram'
  | 'instantly'
  | 'ghl'
  | 'apify'
  | 'mcpwp'
  | 'github_app'
  | 'custom'
export type ConnectorScopeType = 'squad' | 'agent' | 'pot'

const VALID_TYPES: readonly ConnectorType[] = [
  'telegram',
  'instantly',
  'ghl',
  'apify',
  'mcpwp',
  'github_app',
  'custom',
]
const VALID_SCOPE_TYPES: readonly ConnectorScopeType[] = ['squad', 'agent', 'pot']

export function isConnectorType(v: unknown): v is ConnectorType {
  return typeof v === 'string' && (VALID_TYPES as readonly string[]).includes(v)
}

export function isConnectorScopeType(v: unknown): v is ConnectorScopeType {
  return typeof v === 'string' && (VALID_SCOPE_TYPES as readonly string[]).includes(v)
}

// ── internal helpers ─────────────────────────────────────────────────────────

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function asBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('connector-crypto: master key must be even-length hex')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function importMasterKey(masterKeyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(masterKeyHex)
  if (raw.length !== 32) {
    throw new Error(`connector-crypto: master key must be 32 bytes (got ${raw.length})`)
  }
  return crypto.subtle.importKey('raw', asBuf(raw), { name: 'HKDF' }, false, ['deriveKey'])
}

/**
 * Derive a per-connector AES-GCM-256 key.
 *
 * @param masterKeyHex 64-char hex (32 bytes). From CONNECTOR_MASTER_KEY secret.
 * @param connectorId  The connector UUID — used as HKDF salt (unique per row).
 * @param type         ConnectorType — used in the info string for domain separation.
 */
async function deriveConnectorKey(
  masterKeyHex: string,
  connectorId: string,
  type: ConnectorType,
): Promise<CryptoKey> {
  const master = await importMasterKey(masterKeyHex)
  const info = `mupot_connector_${type}_v1`
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBuf(utf8(connectorId)),
      info: asBuf(utf8(info)),
    },
    master,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a connector secret for storage.
 * Returns base64(iv || ciphertext || tag).
 * The plaintext MUST be discarded after this call.
 */
export async function encryptConnectorSecret(
  masterKeyHex: string,
  connectorId: string,
  type: ConnectorType,
  plaintext: string,
): Promise<string> {
  if (!plaintext) throw new Error('connector-crypto: plaintext must be non-empty')
  const key = await deriveConnectorKey(masterKeyHex, connectorId, type)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(utf8(plaintext))),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return bytesToBase64(out)
}

/**
 * Decrypt a stored connector secret. Throws on ANY failure (fail-closed).
 * Callers must use the result immediately and never return it in API responses.
 */
export async function decryptConnectorSecret(
  masterKeyHex: string,
  connectorId: string,
  type: ConnectorType,
  encryptedBase64: string,
): Promise<string> {
  if (!encryptedBase64) {
    throw new Error('connector-crypto: ciphertext is empty (decrypt fail-closed)')
  }
  const blob = base64ToBytes(encryptedBase64)
  if (blob.length <= IV_BYTES + 16) {
    throw new Error('connector-crypto: ciphertext too short (decrypt fail-closed)')
  }
  const iv = blob.slice(0, IV_BYTES)
  const ct = blob.slice(IV_BYTES)
  const key = await deriveConnectorKey(masterKeyHex, connectorId, type)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(ct))
  return new TextDecoder().decode(pt)
}

/**
 * Returns the last 4 characters of a secret for the masked UI hint.
 * Safe to surface in list views.
 */
export function secretLast4(secret: string): string {
  return secret.slice(-4)
}
