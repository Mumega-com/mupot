// Ed25519 signed-attach verification — the no-bearer identity proof for "agent running
// on mupot". The runtime holds a host-side Ed25519 PRIVATE key; mupot stores only the
// PUBLIC key (agent_keys) and verifies a signed, tenant-bound, time-boxed, single-use
// message. No secret is transported or placed anywhere.
//
// Security properties:
//   - DOMAIN-SEPARATED, TENANT-BOUND message — a signature for tenant A cannot be
//     replayed against tenant B (tenant is inside the signed bytes AND the key lookup
//     is keyed by (tenant, agent_id)).
//   - FRESHNESS WINDOW — ts must be within ±ATTACH_WINDOW_SEC of server time, so a
//     captured signature expires.
//   - SINGLE-USE NONCE — a verified nonce is burned (INSERT OR IGNORE, PK=nonce); a
//     replay within the window finds the nonce already burned (changes=0) → rejected.
//     The nonce is burned ONLY AFTER the signature verifies, so unsigned junk can never
//     fill the ledger.
//   - NO IDENTITY ORACLE beyond what's needed: a missing key, a bad signature, an
//     expired ts, and a replay all surface as distinct 4xx for the *operator*, but none
//     leaks key material.

import type { Env } from '../types'

// ── tunables ────────────────────────────────────────────────────────────────────────

/** Signature freshness window, seconds. A signed attach is valid for ±this around the
 *  server clock. Bounds both replay exposure and nonce-ledger growth. */
export const ATTACH_WINDOW_SEC = 300

/** Domain-separation tag — pins these bytes to the attach protocol + version. Any future
 *  signed surface MUST use a different tag so signatures never cross protocols. */
const SIG_DOMAIN = 'fleet-attach:v1'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/        // base64url, 16..128 chars
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/   // Ed25519 sig = 64 bytes → 86 b64url chars
const PUBKEY_B64URL_RE = /^[A-Za-z0-9_-]{40,64}$/ // Ed25519 pub = 32 bytes → 43 b64url chars

// ── canonical message ─────────────────────────────────────────────────────────────

/** The exact bytes both sides sign/verify. Fixed field order, newline-joined, with the
 *  domain tag first and the tenant bound in. The host signer MUST produce byte-identical
 *  output (see agents/fleet-control/attach-signed.mjs). */
export function canonicalAttachMessage(p: {
  tenant: string
  agent_id: string
  type: string
  runtime: string
  ts: number
  nonce: string
}): Uint8Array {
  const s = [SIG_DOMAIN, p.tenant, p.agent_id, p.type, p.runtime, String(p.ts), p.nonce].join('\n')
  return new TextEncoder().encode(s)
}

// ── base64url ─────────────────────────────────────────────────────────────────────

function b64urlToBytes(s: string): Uint8Array | null {
  // Reject non-b64url input up front (verified again by regex at call sites).
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function importEd25519Pub(xB64url: string): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: xB64url, ext: true },
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
  } catch {
    return null
  }
}

// ── result type ─────────────────────────────────────────────────────────────────────

export type SignedAttachOk = {
  ok: true
  agent_id: string
  type: string
  runtime: string
  member_id: string | null
}
export type SignedAttachErr = {
  ok: false
  status: number
  error: string
  detail?: string
}
export type SignedAttachResult = SignedAttachOk | SignedAttachErr

// ── verify ──────────────────────────────────────────────────────────────────────────

/** Verify a signed attach body against the registered public key for (tenant, agent_id).
 *  On success the nonce is burned and {ok:true, ...} returned; the caller then performs
 *  the fleet_agents upsert. The caller MUST treat any {ok:false} as terminal (no upsert).
 *
 *  `body` is the already-parsed, byte-capped request object (untrusted). `validTypes`
 *  and `validRuntimes` are passed in so this module shares the route's allow-lists. */
export async function verifySignedAttach(
  env: Env,
  body: Record<string, unknown>,
  validTypes: Set<string>,
  validRuntimes: Set<string>,
): Promise<SignedAttachResult> {
  // 1. Shape + field validation (all from the UNTRUSTED body).
  if (typeof body.agent_id !== 'string' || !AGENT_ID_RE.test(body.agent_id)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }
  }
  const agentId = body.agent_id

  if (typeof body.type !== 'string' || !validTypes.has(body.type)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'type: invalid' }
  }
  const type = body.type

  if (typeof body.runtime !== 'string' || !validRuntimes.has(body.runtime)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'runtime: invalid' }
  }
  const runtime = body.runtime

  if (typeof body.ts !== 'number' || !Number.isInteger(body.ts) || body.ts <= 0) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'ts: unix-seconds integer required' }
  }
  const ts = body.ts

  if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'nonce: 16-128 char base64url required' }
  }
  const nonce = body.nonce

  if (typeof body.sig !== 'string' || !SIG_B64URL_RE.test(body.sig)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'sig: base64url Ed25519 signature required' }
  }
  const sigBytes = b64urlToBytes(body.sig)
  if (!sigBytes || sigBytes.length !== 64) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'sig: malformed' }
  }

  // 2. Freshness window — reject stale/future signatures (replay exposure bound).
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > ATTACH_WINDOW_SEC) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature timestamp out of window' }
  }

  // 3. Look up the registered PUBLIC key for THIS tenant + agent. No key → no signed
  //    attach (and crucially: no fallthrough to bearer; the route enforces that).
  const tenant = env.TENANT_SLUG
  const keyRow = await env.DB.prepare(
    `SELECT pubkey, algo, member_id FROM agent_keys WHERE tenant = ?1 AND agent_id = ?2`,
  )
    .bind(tenant, agentId)
    .first<{ pubkey: string; algo: string; member_id: string | null }>()

  if (!keyRow || keyRow.algo !== 'Ed25519' || !PUBKEY_B64URL_RE.test(keyRow.pubkey)) {
    // Indistinguishable from a bad signature to the caller — no key-existence oracle.
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  const pubKey = await importEd25519Pub(keyRow.pubkey)
  if (!pubKey) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  // 4. Verify the signature over the canonical, tenant-bound message.
  const msg = canonicalAttachMessage({ tenant, agent_id: agentId, type, runtime, ts, nonce })
  let verified = false
  try {
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, msg)
  } catch {
    verified = false
  }
  if (!verified) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  // 5. Burn the nonce — single-use. INSERT OR IGNORE is atomic on the PK; changes=0 means
  //    the nonce was already used → replay. Only verified requests reach this line, so the
  //    ledger never holds unsigned junk. Opportunistically prune expired nonces first.
  await env.DB.prepare(`DELETE FROM agent_attach_nonces WHERE created_at < ?1`)
    .bind(now - ATTACH_WINDOW_SEC)
    .run()

  const burn = await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_attach_nonces (nonce, agent_id, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(nonce, agentId, now)
    .run()

  const changes = (burn.meta as { changes?: number }).changes ?? 0
  if (changes === 0) {
    return { ok: false, status: 409, error: 'replay', detail: 'nonce already used' }
  }

  return { ok: true, agent_id: agentId, type, runtime, member_id: keyRow.member_id ?? null }
}
