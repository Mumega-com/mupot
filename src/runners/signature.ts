// src/runners/signature.ts — Flight-005 Slice 2b: optional runner-receipt
// provenance signature. Mirrors signed-detach: Ed25519 over a canonical payload,
// verified server-side against the seat's active agent key, nonce burned for
// replay protection. Optional: a receipt without a signature is still accepted
// when the caller is strictly bearer-bound (recordRunner clamps seat identity).
import type { Env } from '../types'
import { loadActiveAgentKey } from '../fleet/agent-keys'
import { burnSharedAgentNonce, sharedNonceWindowSec } from '../fleet/shared-nonce-ledger'
import { b64urlToBytes, importEd25519Pub } from '../fleet/signed-detach'
import type { RunnerStatus } from './types'

export const RUNNER_RECEIPT_SIG_DOMAIN = 'runner-receipt:v1'
export const RUNNER_RECEIPT_SIG_WINDOW_SEC = sharedNonceWindowSec(RUNNER_RECEIPT_SIG_DOMAIN)

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_B64URL_RE = /^[A-Za-z0-9_-]{80,120}$/
const PUBKEY_B64URL_RE = /^[A-Za-z0-9_-]{40,64}$/

export function canonicalRunnerReceiptMessage(p: {
  tenant: string
  seat_agent_id: string
  name: string
  task: string
  status: RunnerStatus
  ts: number
  nonce: string
}): Uint8Array {
  return new TextEncoder().encode([
    RUNNER_RECEIPT_SIG_DOMAIN,
    p.tenant,
    p.seat_agent_id,
    p.name,
    p.task,
    p.status,
    String(p.ts),
    p.nonce,
  ].join('\n'))
}

export interface RunnerReceiptSigInput {
  sig: string
  sig_ts: number
  sig_nonce: string
}

export async function verifyRunnerReceiptSig(
  env: Env,
  seatAgentId: string,
  name: string,
  task: string,
  status: RunnerStatus,
  sig: RunnerReceiptSigInput,
): Promise<void> {
  if (typeof sig.sig !== 'string' || !SIG_B64URL_RE.test(sig.sig)) {
    throw new Error('invalid_signature: sig must be a base64url Ed25519 signature')
  }
  const sigBytes = b64urlToBytes(sig.sig)
  if (!sigBytes || sigBytes.length !== 64) {
    throw new Error('invalid_signature: malformed sig')
  }
  if (typeof sig.sig_ts !== 'number' || !Number.isInteger(sig.sig_ts) || sig.sig_ts <= 0) {
    throw new Error('invalid_signature: sig_ts unix-seconds integer required')
  }
  if (typeof sig.sig_nonce !== 'string' || !NONCE_RE.test(sig.sig_nonce)) {
    throw new Error('invalid_signature: sig_nonce 16-128 char base64url required')
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - sig.sig_ts) > RUNNER_RECEIPT_SIG_WINDOW_SEC) {
    throw new Error('invalid_signature: signature timestamp out of window')
  }

  const keyRow = await loadActiveAgentKey(env, seatAgentId)
  if (!keyRow || keyRow.algo !== 'Ed25519' || !PUBKEY_B64URL_RE.test(keyRow.pubkey)) {
    throw new Error('invalid_signature: no active Ed25519 key for seat')
  }

  const pubKey = await importEd25519Pub(keyRow.pubkey)
  if (!pubKey) {
    throw new Error('invalid_signature: malformed pubkey')
  }

  let verified = false
  try {
    verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pubKey,
      sigBytes,
      canonicalRunnerReceiptMessage({
        tenant: env.TENANT_SLUG || 'mumega',
        seat_agent_id: seatAgentId,
        name,
        task,
        status,
        ts: sig.sig_ts,
        nonce: sig.sig_nonce,
      }),
    )
  } catch {
    verified = false
  }
  if (!verified) {
    throw new Error('invalid_signature: verification failed')
  }

  const burned = await burnSharedAgentNonce(env, {
    domain: RUNNER_RECEIPT_SIG_DOMAIN,
    windowSec: RUNNER_RECEIPT_SIG_WINDOW_SEC,
    agentId: seatAgentId,
    nonce: sig.sig_nonce,
    now,
  })
  if (!burned) {
    throw new Error('replay: signature nonce already used')
  }
}
