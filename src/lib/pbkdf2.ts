// mupot — PBKDF2-HMAC-SHA256 over WebCrypto, returning lowercase hex. A one-way password hash, NOT a decryption path;
// it lives in src/lib (not src/secure-moments) because the secure-drop ratchet bans `subtle.deriveBits` there as a proxy
// for "the server can open sealed credentials". Cloudflare Workers throws above 100,000 iterations, so callers must stay at or below that.
export const PBKDF2_MAX_ITERATIONS = 100_000

export async function pbkdf2Sha256Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const n = Math.min(Math.max(1, Math.trunc(iterations)), PBKDF2_MAX_ITERATIONS)
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: n }, key, 256)
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
