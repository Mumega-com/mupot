// mupot — Google Chat channel adapter (LEAF plugin). The microkernel core depends
// ONLY on the ChannelAdapter interface; this file is the single place any Google
// Chat-specific knowledge lives. Adding/removing Google Chat = this file + one
// registry entry, nothing else touches the core.
//
// This is viamar's likely pick (a Google shop): identity = the user's EMAIL, so a
// platform user auto-binds to members.email with ZERO link step. Google Chat has
// no per-space roles, so roleCapability returns null and the core falls back to the
// per-binding default capability (respecting max_capability on sync).
//
// Sovereign-core discipline (same as src/mcp + src/im + src/auth + the Discord adapter):
//   - Identity is the PLATFORM MAPPING, never message text. parseInbound returns the
//     raw space name + the sender's email; the core resolves those to a binding/member.
//     We never read a self-claimed identity field as proof of "who" for authorization.
//   - Webhook authenticity is verified fail-closed by cryptographically verifying the
//     Google-signed Bearer JWT (issuer chat@system.gserviceaccount.com, audience = the
//     app's project number) against Google's published x509 certs. No project number
//     configured / missing / invalid / unverifiable token → verify() returns false and
//     the core rejects the request.
//   - Outbound calls authenticate with a short-lived OAuth2 access token MINTED in-process
//     from a service-account key (GOOGLE_CHAT_SA_KEY) via the JWT-bearer grant, cached
//     until shortly before expiry. The service-account key and the minted token are
//     NEVER logged, echoed, or returned — the token leaves this file only inside an
//     Authorization header on an outbound fetch to Google.
//
// Runs in the Cloudflare Workers runtime: ALL crypto is Web Crypto (crypto.subtle);
// NO Node APIs (no Buffer, no node:crypto).
//
// Exports: `googleChatAdapter: ChannelAdapter` (platform 'google-chat').

import type { ChannelAdapter, Env, InboundMessage, Capability } from '../../types'

// ── env secret access ─────────────────────────────────────────────────────────
// These are platform-specific secrets/vars. They are runtime-only (wrangler secrets /
// vars) and intentionally NOT on the shared Env interface in types.ts (which this part
// must not edit). We read them through a narrow, per-adapter view of env. The cast is
// the documented seam for adapter-local secrets; it widens nothing for the core and
// never escapes this module.
interface GoogleChatSecrets {
  // Full service-account JSON key (the file Google hands you): { client_email,
  // private_key (PEM PKCS8), ... }. Used to MINT OAuth2 access tokens in-process for the
  // outbound Chat REST API. Never logged.
  GOOGLE_CHAT_SA_KEY?: string
  // The app's Google Cloud PROJECT NUMBER — the audience Google Chat signs inbound
  // request JWTs for. Required for inbound verify; unset → verify fails closed.
  GOOGLE_CHAT_PROJECT_NUMBER?: string
  // OPTIONAL, WEAKER fallback. A fixed shared verification token Google echoes back as the
  // inbound Authorization bearer. Only consulted when SA-based JWT verify cannot run
  // because GOOGLE_CHAT_PROJECT_NUMBER is unset. A shared bearer does NOT cryptographically
  // prove the payload's sender, so it is strictly weaker than JWT verify and exists only
  // as a transitional escape hatch. Prefer GOOGLE_CHAT_PROJECT_NUMBER.
  GOOGLE_CHAT_VERIFY_TOKEN?: string
}

function googleChatSecrets(env: Env): GoogleChatSecrets {
  // `as` is required because GoogleChatSecrets keys are not declared on Env; this is the
  // adapter-local secret seam, documented in the header. No platform code leaks out.
  return env as unknown as GoogleChatSecrets
}

const CHAT_API = 'https://chat.googleapis.com/v1'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
const CHAT_SYSTEM_ISSUER = 'chat@system.gserviceaccount.com'
const GOOGLE_CHAT_CERTS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com'

// ── small helpers ───────────────────────────────────────────────────────────────
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Extract the raw bearer token from an Authorization header value, or null.
function bearerToken(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}

// Constant-time string compare (length + char xor). Avoids leaking the secret
// character-by-character via early-exit timing. Both inputs are short bearer tokens.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// A Google Chat space is addressed as a resource name: "spaces/AAAA...". The core
// stores that whole resource name as external_channel_id. Build a REST path from it,
// tolerating either the bare id or the full "spaces/<id>" form. Never log the result
// with a token.
function spacePath(externalChannelId: string): string {
  const trimmed = externalChannelId.trim()
  return trimmed.startsWith('spaces/') ? trimmed : `spaces/${trimmed}`
}

// ── base64 / base64url codecs (Web APIs only; no Buffer) ──────────────────────────
// Standard base64 → bytes. `atob` yields a binary string; copy char codes to a Uint8Array.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// base64url (JWT segments) → bytes. Restore standard alphabet + padding, then decode.
function base64UrlToBytes(b64url: string): Uint8Array {
  let s = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad === 2) s += '=='
  else if (pad === 3) s += '='
  else if (pad === 1) throw new Error('invalid base64url length')
  return base64ToBytes(s)
}

// Copy a Uint8Array (which may be a view over a larger / Shared buffer) into a fresh,
// tightly-sized ArrayBuffer. crypto.subtle wants a plain ArrayBuffer; `.buffer` is typed
// ArrayBufferLike (may be SharedArrayBuffer) so we always copy to be type- and intent-safe.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

// bytes → base64url (no padding) for the JWT segments we sign.
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// UTF-8 string → base64url, for JWT header/claim JSON.
function strToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s))
}

// base64url → UTF-8 string, for reading a JWT header/payload segment.
function base64UrlToStr(b64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(b64url))
}

// ── PEM (PKCS8) → ArrayBuffer DER ─────────────────────────────────────────────────
// Strip the BEGIN/END armor + ALL whitespace, then base64-decode the body to DER. Works
// for "PRIVATE KEY" (PKCS8) bodies as Google supplies in the SA key's private_key field.
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  if (!body) throw new Error('empty PEM body')
  return toArrayBuffer(base64ToBytes(body))
}

// ── outbound OAuth2 token minting (service-account JWT-bearer grant) ───────────────
// We mint a short-lived access token from the service-account key and cache it
// module-level until ~60s before expiry, then re-mint. The key and token are never
// logged. Cache is keyed by the SA client_email so a key rotation (different SA) does
// not serve a stale token for the wrong identity.

interface ServiceAccountKey {
  client_email: string
  private_key: string // PEM PKCS8
}

interface TokenResponse {
  access_token?: unknown
  expires_in?: unknown
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
  clientEmail: string
}

// Module-level token cache. Survives across requests within a Worker isolate; a cold
// isolate simply re-mints. No secret is persisted here beyond the short-lived token.
let cachedToken: CachedToken | null = null

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('google-chat: GOOGLE_CHAT_SA_KEY is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('google-chat: GOOGLE_CHAT_SA_KEY is not an object')
  }
  const obj = parsed as Record<string, unknown>
  const clientEmail = asString(obj.client_email)
  const privateKey = asString(obj.private_key)
  if (!clientEmail || !privateKey) {
    throw new Error('google-chat: GOOGLE_CHAT_SA_KEY missing client_email or private_key')
  }
  return { client_email: clientEmail, private_key: privateKey }
}

// Build + RS256-sign the assertion JWT, exchange it for an access token at Google's token
// endpoint. Returns the access token and its absolute expiry. Throws on any failure; the
// thrown message never contains the key or token.
async function mintAccessToken(sa: ServiceAccountKey): Promise<CachedToken> {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 3600

  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: sa.client_email,
    scope: CHAT_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat,
    exp,
  }

  const signingInput = `${strToBase64Url(JSON.stringify(header))}.${strToBase64Url(
    JSON.stringify(claims),
  )}`

  const der = pemToDer(sa.private_key)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )
  const assertion = `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuf))}`

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    // Status only — the request carried the SA-signed assertion; do not echo headers.
    // Google's error body names the OAuth error (no secret echoed).
    const detail = await res.text().catch(() => '')
    throw new Error(`google-chat: token mint failed (${res.status}) ${detail.slice(0, 256)}`)
  }
  const json = (await res.json().catch(() => null)) as TokenResponse | null
  const accessToken = asString(json?.access_token)
  const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : 3600
  if (!accessToken) {
    throw new Error('google-chat: token mint response missing access_token')
  }

  return {
    accessToken,
    // Refresh ~60s early so an in-flight request never races the hard expiry.
    expiresAtMs: Date.now() + Math.max(0, expiresIn - 60) * 1000,
    clientEmail: sa.client_email,
  }
}

// Return a valid access token, minting (and caching) on demand. Reuses the cached token
// until ~60s before expiry. Throws if GOOGLE_CHAT_SA_KEY is absent/invalid.
async function getAccessToken(env: Env): Promise<string> {
  const raw = googleChatSecrets(env).GOOGLE_CHAT_SA_KEY
  if (!raw) {
    throw new Error('google-chat: GOOGLE_CHAT_SA_KEY not configured')
  }
  const sa = parseServiceAccountKey(raw)

  const now = Date.now()
  if (
    cachedToken &&
    cachedToken.clientEmail === sa.client_email &&
    cachedToken.expiresAtMs > now
  ) {
    return cachedToken.accessToken
  }

  const minted = await mintAccessToken(sa)
  cachedToken = minted
  return minted.accessToken
}

// ── inbound JWT verify (fail-closed, cryptographic) ───────────────────────────────
// Google Chat signs each request with a Bearer JWT in the Authorization header, issued by
// chat@system.gserviceaccount.com with audience = the app's PROJECT NUMBER. We:
//   1) read the bearer, split header.payload.signature,
//   2) fetch Google's x509 certs (cached briefly) keyed by `kid`,
//   3) verify the RS256 signature over `header.payload`,
//   4) check iss === chat@system.gserviceaccount.com and aud === expected project number,
//      and that the token is within iat/exp.
// Anything missing/invalid/throwing → false. If GOOGLE_CHAT_PROJECT_NUMBER is unset we
// CANNOT validate the audience, so we fail closed (unless the weaker shared-token
// fallback is configured — see GOOGLE_CHAT_VERIFY_TOKEN).

// Google publishes certs as { kid: "-----BEGIN CERTIFICATE-----..." }. Cache them
// module-level for a short TTL to avoid a fetch per inbound event without going stale.
interface CertCache {
  certs: Record<string, string>
  expiresAtMs: number
}
let certCache: CertCache | null = null
const CERT_TTL_MS = 60 * 60 * 1000 // 1h; Google rotates infrequently and sets cache headers

async function fetchGoogleChatCerts(): Promise<Record<string, string>> {
  const now = Date.now()
  if (certCache && certCache.expiresAtMs > now) return certCache.certs

  const res = await fetch(GOOGLE_CHAT_CERTS_URL)
  if (!res.ok) throw new Error(`google-chat: cert fetch failed (${res.status})`)
  const json = (await res.json().catch(() => null)) as unknown
  if (!json || typeof json !== 'object') throw new Error('google-chat: malformed cert response')

  const certs: Record<string, string> = {}
  for (const [kid, pem] of Object.entries(json as Record<string, unknown>)) {
    if (typeof pem === 'string') certs[kid] = pem
  }
  if (Object.keys(certs).length === 0) throw new Error('google-chat: empty cert set')

  certCache = { certs, expiresAtMs: now + CERT_TTL_MS }
  return certs
}

// Import a PEM X.509 CERTIFICATE as an RSASSA-PKCS1-v1_5 verification key. Web Crypto
// importKey('spki', ...) expects a SubjectPublicKeyInfo, which is the certificate's
// embedded public key — but it does NOT parse a full X.509 cert. We extract the SPKI from
// the certificate's DER below.
async function importCertPublicKey(certPem: string): Promise<CryptoKey> {
  const certDer = pemToDer(certPem)
  const spki = extractSpkiFromCertificate(new Uint8Array(certDer))
  return crypto.subtle.importKey(
    'spki',
    toArrayBuffer(spki),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

// Minimal DER walker to pull the SubjectPublicKeyInfo out of an X.509 Certificate.
//
// Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { ... subjectPublicKeyInfo SPKI ... }
//                            signatureAlgorithm, signatureValue }
// The SPKI is itself a SEQUENCE whose first element is an AlgorithmIdentifier SEQUENCE
// containing the rsaEncryption OID (1.2.840.113549.1.1.1 → DER 06 09 2A 86 48 86 F7 0D 01 01 01).
// We locate that OID and back up to the enclosing SEQUENCE header to recover the SPKI bytes.
// This avoids pulling in a full ASN.1 library while staying within Web-only APIs.
function extractSpkiFromCertificate(der: Uint8Array): Uint8Array {
  const rsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]

  // Find the rsaEncryption OID inside the certificate.
  let oidPos = -1
  for (let i = 0; i + rsaOid.length <= der.length; i++) {
    let match = true
    for (let j = 0; j < rsaOid.length; j++) {
      if (der[i + j] !== rsaOid[j]) {
        match = false
        break
      }
    }
    if (match) {
      oidPos = i
      break
    }
  }
  if (oidPos < 0) throw new Error('google-chat: rsaEncryption OID not found in certificate')

  // Walk backwards to find the SEQUENCE (0x30) header of the AlgorithmIdentifier that
  // contains this OID, then the SEQUENCE header of the enclosing SPKI. We scan for a 0x30
  // tag whose declared length encloses the OID; the SPKI is the OUTER such SEQUENCE.
  // Strategy: try each 0x30 before the OID as a candidate SPKI start and verify its
  // length spans past the OID, picking the nearest enclosing one (the AlgorithmIdentifier),
  // then step out one more SEQUENCE to the SPKI.

  // Read a DER length at position p (p points at the length byte). Returns [length, headerLen].
  const readLen = (p: number): [number, number] => {
    const first = der[p]
    if (first < 0x80) return [first, 1]
    const numBytes = first & 0x7f
    if (numBytes === 0 || numBytes > 4) throw new Error('google-chat: bad DER length')
    let len = 0
    for (let k = 0; k < numBytes; k++) len = (len << 8) | der[p + 1 + k]
    return [len, 1 + numBytes]
  }

  // Find the AlgorithmIdentifier SEQUENCE: the nearest 0x30 before the OID whose contents
  // begin at the OID (an AlgorithmIdentifier is SEQUENCE { OID, params }).
  let algSeqStart = -1
  for (let p = oidPos - 1; p >= 0; p--) {
    if (der[p] !== 0x30) continue
    try {
      const [, hdr] = readLen(p + 1)
      if (p + 1 + hdr === oidPos) {
        algSeqStart = p
        break
      }
    } catch {
      // not a valid length here; keep scanning
    }
  }
  if (algSeqStart < 0) throw new Error('google-chat: AlgorithmIdentifier SEQUENCE not found')

  // The SPKI SEQUENCE is the nearest 0x30 before algSeqStart whose contents START at
  // algSeqStart (SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING }).
  let spkiStart = -1
  for (let p = algSeqStart - 1; p >= 0; p--) {
    if (der[p] !== 0x30) continue
    try {
      const [, hdr] = readLen(p + 1)
      if (p + 1 + hdr === algSeqStart) {
        spkiStart = p
        break
      }
    } catch {
      // keep scanning
    }
  }
  if (spkiStart < 0) throw new Error('google-chat: SPKI SEQUENCE not found')

  const [spkiLen, spkiHdr] = readLen(spkiStart + 1)
  const end = spkiStart + 1 + spkiHdr + spkiLen
  if (end > der.length) throw new Error('google-chat: SPKI length exceeds certificate')
  return der.slice(spkiStart, end)
}

interface JwtHeader {
  alg?: unknown
  kid?: unknown
}

interface JwtClaims {
  iss?: unknown
  aud?: unknown
  iat?: unknown
  exp?: unknown
}

// Cryptographically verify a Google Chat inbound JWT. Returns true ONLY on a fully valid
// token (good signature, correct issuer, correct audience, within iat/exp). Any failure
// returns false. `expectedAud` is the configured project number.
async function verifyGoogleChatJwt(jwt: string, expectedAud: string): Promise<boolean> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return false
  const [headerB64, payloadB64, sigB64] = parts

  let header: JwtHeader
  let claims: JwtClaims
  try {
    header = JSON.parse(base64UrlToStr(headerB64)) as JwtHeader
    claims = JSON.parse(base64UrlToStr(payloadB64)) as JwtClaims
  } catch {
    return false
  }

  if (asString(header.alg) !== 'RS256') return false
  const kid = asString(header.kid)
  if (!kid) return false

  // Claim checks BEFORE the (more expensive) signature verify.
  if (asString(claims.iss) !== CHAT_SYSTEM_ISSUER) return false
  if (asString(claims.aud) !== expectedAud) return false

  const nowSec = Math.floor(Date.now() / 1000)
  const skew = 60 // tolerate 60s clock skew
  const exp = typeof claims.exp === 'number' ? claims.exp : null
  const iat = typeof claims.iat === 'number' ? claims.iat : null
  if (exp === null || nowSec > exp + skew) return false
  if (iat !== null && nowSec < iat - skew) return false

  let certs: Record<string, string>
  try {
    certs = await fetchGoogleChatCerts()
  } catch {
    return false
  }
  const certPem = certs[kid]
  if (!certPem) return false

  let key: CryptoKey
  try {
    key = await importCertPublicKey(certPem)
  } catch {
    return false
  }

  let signature: Uint8Array
  try {
    signature = base64UrlToBytes(sigB64)
  } catch {
    return false
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  try {
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toArrayBuffer(signature), signed)
  } catch {
    return false
  }
}

// ── verify (fail-closed) ──────────────────────────────────────────────────────
// Cryptographically verify the Google-signed inbound JWT. The expected audience is the
// app's project number (GOOGLE_CHAT_PROJECT_NUMBER). If that is unset we cannot validate
// the audience, so we fall back to the WEAKER fixed-shared-token compare ONLY if
// GOOGLE_CHAT_VERIFY_TOKEN is configured; otherwise fail closed (return false). A shared
// bearer does not prove the payload's sender — see the secret-doc above — so it is a
// transitional escape hatch, not the recommended posture.
async function verify(req: Request, env: Env): Promise<boolean> {
  const secrets = googleChatSecrets(env)
  const presented = bearerToken(req.headers.get('authorization'))
  if (!presented) return false // no bearer → fail closed

  const projectNumber = asString(secrets.GOOGLE_CHAT_PROJECT_NUMBER)
  if (projectNumber) {
    try {
      return await verifyGoogleChatJwt(presented, projectNumber)
    } catch {
      return false // anything throwing → fail closed
    }
  }

  // Weaker fallback: fixed shared-token compare (constant-time). Only when no project
  // number is configured AND a verify token is explicitly set. Otherwise sealed.
  const fallback = asString(secrets.GOOGLE_CHAT_VERIFY_TOKEN)
  if (fallback) return safeEqual(presented, fallback)

  return false
}

// ── inbound parsing ───────────────────────────────────────────────────────────
// Google Chat delivers events as JSON. The shapes we care about:
//   - MESSAGE event: { type:'MESSAGE', space:{name}, message:{ sender:{email,type},
//                      argumentText, text }, user:{email,type} }
//   - ADDED_TO_SPACE / REMOVED_FROM_SPACE / other: no usable message → null.
// Identity is the SENDER'S EMAIL (so it auto-binds to members.email). We return null
// for any event without a space + a human sender email, and for bot-authored messages
// (sender.type === 'BOT') so the app never loops on its own posts. Identity fields are
// returned RAW for the core to map — never trusted here as authorization.

interface GoogleChatUser {
  name?: unknown
  email?: unknown
  type?: unknown // 'HUMAN' | 'BOT'
}

interface GoogleChatSpace {
  name?: unknown // "spaces/AAAA..."
}

interface GoogleChatMessage {
  sender?: GoogleChatUser | null
  argumentText?: unknown // message text with the bot @mention stripped
  text?: unknown // full message text (fallback)
}

interface GoogleChatEvent {
  type?: unknown // 'MESSAGE' | 'ADDED_TO_SPACE' | ...
  space?: GoogleChatSpace | null
  message?: GoogleChatMessage | null
  user?: GoogleChatUser | null // the user who triggered the event
}

function isBotUser(u: GoogleChatUser | null | undefined): boolean {
  return typeof u?.type === 'string' && u.type.toUpperCase() === 'BOT'
}

// Prefer argumentText (mention-stripped) so a "@bot task: x" reads as "task: x"; fall
// back to the full text. Either may be absent on non-text events.
function messageText(m: GoogleChatMessage | null | undefined): string {
  if (!m) return ''
  return asString(m.argumentText) ?? asString(m.text) ?? ''
}

/**
 * parseInbound — Google Chat event → normalized InboundMessage, or null.
 * Returns null for non-MESSAGE events, bot-authored messages, or any payload missing a
 * space name or a sender email. externalUserId is the sender's EMAIL (auto-binds to
 * members.email). The text is the user's intent; identity is the platform mapping,
 * never authorization.
 */
async function parseInbound(req: Request, _env: Env): Promise<InboundMessage | null> {
  let payload: unknown
  try {
    payload = await req.clone().json()
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const event = payload as GoogleChatEvent

  // Only message events carry user intent. Everything else (ADDED_TO_SPACE, etc.) is
  // not a message → the core has nothing to act on.
  const type = asString(event.type)
  if (type !== 'MESSAGE') return null

  const spaceName = asString(event.space?.name)
  if (!spaceName) return null

  // Sender identity = email. Google nests it under message.sender; some payloads also
  // carry a top-level `user`. Prefer the message sender (the message author).
  const sender = event.message?.sender ?? event.user ?? null
  if (isBotUser(sender)) return null // ignore bot/self messages → no loops
  const email = asString(sender?.email)
  if (!email) return null

  const text = messageText(event.message)
  return {
    platform: 'google-chat',
    externalChannelId: spaceName,
    externalUserId: email,
    text,
  }
}

// ── outbound post ─────────────────────────────────────────────────────────────
// POST https://chat.googleapis.com/v1/{space}/messages with a freshly-minted (cached)
// OAuth2 access token. The token never appears in a log line or an error message — on
// failure we surface only the HTTP status (+ Google's body, which carries no secret),
// never the headers.

async function post(env: Env, externalChannelId: string, text: string): Promise<void> {
  const token = await getAccessToken(env) // throws (token-safe) if SA key is absent/invalid

  const space = spacePath(externalChannelId)
  const res = await fetch(`${CHAT_API}/${space}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  if (!res.ok) {
    // Surface status only — never the request headers (which carry the token) or the
    // token itself. Google's error body is safe to include (no secret echoed back).
    const detail = await res.text().catch(() => '')
    throw new Error(`google-chat: post failed (${res.status}) ${detail.slice(0, 256)}`)
  }
}

// ── channel members ───────────────────────────────────────────────────────────
// spaces.members.list → the space's memberships. Each membership nests the principal
// under `member` (type 'HUMAN'); for a human, member.name resolves to a user. We return
// the external user ids = EMAILS where present (so they line up with parseInbound +
// members.email), else the user id from member.name. Bots are excluded so sync never
// grants capabilities to a bot account. Best-effort + fail-soft: any error → [] so a
// transient Google outage can't wedge reconciliation.

interface GoogleChatMembership {
  member?: GoogleChatUser | null // the human/bot principal (member.name = "users/<id>")
  state?: unknown // 'JOINED' | 'INVITED' | ...
}

interface GoogleChatMembersList {
  memberships?: GoogleChatMembership[] | null
  nextPageToken?: unknown
}

async function chatGet(env: Env, path: string): Promise<unknown | null> {
  let token: string
  try {
    token = await getAccessToken(env)
  } catch {
    return null // no/invalid SA key → fail-soft (caller returns [])
  }
  const res = await fetch(`${CHAT_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return res.json<unknown>().catch(() => null)
}

/**
 * listChannelMembers — the human members of a Google Chat space as external user ids
 * (EMAILS where Google provides them, else the user id from member.name). Pages
 * spaces.members.list via nextPageToken (we request the max page size and follow the
 * cursor). Excludes bots and de-dupes (case-insensitively). Fail-soft: returns [] on any
 * error so a transient outage can't wedge reconciliation. These ids feed the core's
 * membership sync, which binds them under the per-binding ceiling.
 */
async function listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> {
  const space = spacePath(externalChannelId)
  const ids: string[] = []
  const seen = new Set<string>()
  let pageToken = ''

  // Bounded paging loop — stop when Google returns no nextPageToken. Hard cap the
  // iterations defensively against a misbehaving cursor.
  for (let page = 0; page < 100; page++) {
    const query = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    const data = await chatGet(env, `/${space}/members?pageSize=1000${query}`)
    if (!data || typeof data !== 'object') break

    const list = data as GoogleChatMembersList
    const memberships = Array.isArray(list.memberships) ? list.memberships : []
    for (const m of memberships) {
      const principal = m?.member ?? null
      if (isBotUser(principal)) continue
      // Prefer the email (auto-binds to members.email); fall back to the user resource
      // id (member.name = "users/<id>") so a member without a visible email still syncs.
      const id = asString(principal?.email) ?? asString(principal?.name)
      if (!id) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      ids.push(id)
    }

    const next = asString(list.nextPageToken)
    if (!next) break
    pageToken = next
  }

  return ids
}

// ── role → capability (optional) ──────────────────────────────────────────────
// Google Chat has NO per-space roles (membership is flat: a member is in the space or
// not). There is no platform signal to map to a finer capability, so we return null and
// the core falls back to the per-binding default capability (bounded by max_capability
// on sync). Declared explicitly for parity with the other adapters.
async function roleCapability(
  _env: Env,
  _externalChannelId: string,
  _externalUserId: string,
): Promise<Capability | null> {
  return null
}

// ── the adapter (the only export the core sees) ───────────────────────────────
export const googleChatAdapter: ChannelAdapter = {
  platform: 'google-chat',
  verify,
  parseInbound,
  post,
  listChannelMembers,
  roleCapability,
}
