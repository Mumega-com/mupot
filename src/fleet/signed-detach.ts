// Ed25519 signed-detach verification — explicit offline signal for keyed agents.
//
// This mirrors signed attach but uses a separate domain. A detach signature can
// only stop the row for its own (tenant, agent_id) key binding; member_id remains
// key-derived and is never accepted from the body.

import type { Env } from '../types'
import { loadActiveAgentKey } from './agent-keys'
import { burnSharedAgentNonce, sharedNonceWindowSec } from './shared-nonce-ledger'

export const DETACH_WINDOW_SEC = sharedNonceWindowSec('fleet-detach:v1')
export const DETACH_SIG_DOMAIN = 'fleet-detach:v1'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/
const PUBKEY_B64URL_RE = /^[A-Za-z0-9_-]{40,64}$/

export function canonicalDetachMessage(p: {
  tenant: string
  agent_id: string
  ts: number
  nonce: string
}): Uint8Array {
  return new TextEncoder().encode([
    DETACH_SIG_DOMAIN,
    p.tenant,
    p.agent_id,
    String(p.ts),
    p.nonce,
  ].join('\n'))
}

function b64urlToBytes(s: string): Uint8Array | null {
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

export type SignedDetachOk = {
  ok: true
  agent_id: string
  member_id: string
}

export type SignedDetachErr = {
  ok: false
  status: number
  error: string
  detail?: string
}

export type SignedDetachResult = SignedDetachOk | SignedDetachErr

export async function verifySignedDetach(
  env: Env,
  body: Record<string, unknown>,
): Promise<SignedDetachResult> {
  if (typeof body.agent_id !== 'string' || !AGENT_ID_RE.test(body.agent_id)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }
  }
  const agentId = body.agent_id

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

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > DETACH_WINDOW_SEC) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature timestamp out of window' }
  }

  const tenant = env.TENANT_SLUG
  const keyRow = await loadActiveAgentKey(env, agentId)

  if (!keyRow || keyRow.algo !== 'Ed25519' || !PUBKEY_B64URL_RE.test(keyRow.pubkey)) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  const pubKey = await importEd25519Pub(keyRow.pubkey)
  if (!pubKey) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  let verified = false
  try {
    verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pubKey,
      sigBytes,
      canonicalDetachMessage({ tenant, agent_id: agentId, ts, nonce }),
    )
  } catch {
    verified = false
  }
  if (!verified) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  const burned = await burnSharedAgentNonce(env, {
    domain: DETACH_SIG_DOMAIN,
    windowSec: DETACH_WINDOW_SEC,
    agentId,
    nonce,
    now,
  })
  if (!burned) {
    return { ok: false, status: 409, error: 'replay', detail: 'nonce already used' }
  }

  return { ok: true, agent_id: agentId, member_id: keyRow.member_id }
}
