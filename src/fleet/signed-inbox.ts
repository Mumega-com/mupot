// Ed25519 signed inbox reads — no-bearer inbox drain for host runtimes.
//
// The fleet daemon already proves an agent's identity with signed attach. This
// module gives the same host-held private key a second, domain-separated use:
// reading that agent's own inbox without placing a raw member bearer token in
// daemon config. The signed bytes bind tenant + agent + read mode + limit, and
// the nonce ledger is shared with signed attach so replay is still single-use.

import type { Env } from '../types'
import { readVerifiedSignedAgentInbox, type InboxMessage } from '../agents/messages'
import { agentKeyFingerprint, loadActiveAgentKey } from './agent-keys'
import { burnSharedAgentNonce, sharedNonceWindowSec } from './shared-nonce-ledger'

export const INBOX_WINDOW_SEC = sharedNonceWindowSec('agent-inbox:v1')
export const INBOX_SIG_DOMAIN = 'agent-inbox:v1'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/
const PUBKEY_B64URL_RE = /^[A-Za-z0-9_-]{40,64}$/
const MAX_INBOX_LIMIT = 100

export function canonicalInboxMessage(p: {
  tenant: string
  agent_id: string
  peek: boolean
  limit: number
  ts: number
  nonce: string
}): Uint8Array {
  const s = [
    INBOX_SIG_DOMAIN,
    p.tenant,
    p.agent_id,
    p.peek ? '1' : '0',
    String(p.limit),
    String(p.ts),
    p.nonce,
  ].join('\n')
  return new TextEncoder().encode(s)
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

export type SignedInboxOk = {
  ok: true
  agent_id: string
  peek: boolean
  limit: number
  member_id: string
  key_fingerprint: string
}

export type SignedInboxErr = {
  ok: false
  status: number
  error: string
  detail?: string
}

export type SignedInboxResult = SignedInboxOk | SignedInboxErr

export async function verifySignedInboxRead(
  env: Env,
  body: Record<string, unknown>,
): Promise<SignedInboxResult> {
  if (typeof body.agent_id !== 'string' || !AGENT_ID_RE.test(body.agent_id)) {
    return { ok: false, status: 400, error: 'bad_request', detail: 'agent_id: lowercase slug a-z0-9- required' }
  }
  const agentId = body.agent_id

  if (typeof body.peek !== 'boolean') {
    return { ok: false, status: 400, error: 'bad_request', detail: 'peek: boolean required' }
  }
  const peek = body.peek

  if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_INBOX_LIMIT) {
    return { ok: false, status: 400, error: 'bad_request', detail: `limit: integer 1-${MAX_INBOX_LIMIT} required` }
  }
  const limit = body.limit

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
  if (Math.abs(now - ts) > INBOX_WINDOW_SEC) {
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

  const msg = canonicalInboxMessage({ tenant, agent_id: agentId, peek, limit, ts, nonce })
  let verified = false
  try {
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, pubKey, sigBytes, msg)
  } catch {
    verified = false
  }
  if (!verified) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' }
  }

  const burned = await burnSharedAgentNonce(env, {
    domain: INBOX_SIG_DOMAIN,
    windowSec: INBOX_WINDOW_SEC,
    agentId,
    nonce,
    now,
  })
  if (!burned) {
    return { ok: false, status: 409, error: 'replay', detail: 'nonce already used' }
  }

  return {
    ok: true,
    agent_id: agentId,
    peek,
    limit,
    member_id: keyRow.member_id,
    key_fingerprint: await agentKeyFingerprint(keyRow.pubkey),
  }
}

export type VerifiedSignedInboxRead =
  | {
      ok: true
      agent_id: string
      messages: InboxMessage[]
      remaining: number
      consumed: boolean
    }
  | SignedInboxErr

/** Cryptographic boundary: no caller can select the privileged reader without a valid signature. */
export async function verifyAndReadSignedInbox(
  env: Env,
  body: Record<string, unknown>,
): Promise<VerifiedSignedInboxRead> {
  const verified = await verifySignedInboxRead(env, body)
  if (!verified.ok) return verified
  const inbox = await readVerifiedSignedAgentInbox(env, {
    agent: verified.agent_id,
    peek: verified.peek,
    limit: verified.limit,
    keyFingerprint: verified.key_fingerprint,
  })
  if (!inbox.ok) {
    const status = inbox.reason === 'consumer_fenced' ? 409 : inbox.reason === 'db_error' ? 500 : 400
    return { ok: false, status, error: inbox.reason, ...(inbox.detail ? { detail: inbox.detail } : {}) }
  }
  return {
    ok: true,
    agent_id: verified.agent_id,
    messages: inbox.messages,
    remaining: inbox.remaining,
    consumed: !verified.peek,
  }
}
