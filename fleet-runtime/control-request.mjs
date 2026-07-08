// Host-side verifier for Mupot fleet-control requests.
//
// The Worker signs these bytes with FLEET_PANEL_SK. The host stores only the
// public key, verifies freshness/signature, and burns the nonce locally before
// touching a process.

import { webcrypto as w } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CONTROL_VERSION = 'fleet-control.v1'
export const CONTROL_WINDOW_SEC = 300
export const CONTROL_VERBS = ['start', 'stop', 'status', 'restart']

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIG_RE = /^[A-Za-z0-9_-]{86}(?:==)?$/

export function canonicalControlMessage({ agent_id, verb, nonce, ts }) {
  return [CONTROL_VERSION, agent_id, verb, nonce, String(ts)].join('\n')
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_=-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
  } catch {
    return null
  }
}

export async function importPanelPublicKey(jwkJson) {
  let jwk
  try {
    jwk = JSON.parse(jwkJson)
  } catch {
    throw new Error('panel public key is not valid JSON')
  }
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || jwk.d) {
    throw new Error('panel public key must be a PUBLIC Ed25519 OKP JWK')
  }
  return w.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify'])
}

export class JsonNonceLedger {
  constructor(path, opts = {}) {
    this.path = path
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  write(data) {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  prune(data, now = this.nowSec()) {
    const out = {}
    for (const [nonce, created] of Object.entries(data)) {
      if (typeof created === 'number' && created >= now - 2 * CONTROL_WINDOW_SEC) out[nonce] = created
    }
    return out
  }

  burn(nonce, now = this.nowSec()) {
    const data = this.prune(this.read(), now)
    if (data[nonce] !== undefined) {
      this.write(data)
      return false
    }
    data[nonce] = now
    this.write(data)
    return true
  }
}

function validateShape(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return 'request_not_object'
  if (typeof req.agent_id !== 'string' || !ID_RE.test(req.agent_id)) return 'bad_agent_id'
  if (typeof req.verb !== 'string' || !CONTROL_VERBS.includes(req.verb)) return 'bad_verb'
  if (typeof req.nonce !== 'string' || !NONCE_RE.test(req.nonce)) return 'bad_nonce'
  if (typeof req.ts !== 'number' || !Number.isInteger(req.ts) || req.ts <= 0) return 'bad_ts'
  if (typeof req.sig !== 'string' || !SIG_RE.test(req.sig)) return 'bad_sig'
  const sig = b64urlToBytes(req.sig)
  if (!sig || sig.length !== 64) return 'bad_sig'
  return null
}

export async function verifyControlRequest(publicKey, req, ledger, opts = {}) {
  const shapeError = validateShape(req)
  if (shapeError) return { ok: false, reason: shapeError }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - req.ts) > CONTROL_WINDOW_SEC) {
    return { ok: false, reason: 'stale' }
  }

  const sig = b64urlToBytes(req.sig)
  let verified = false
  try {
    verified = await w.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      sig,
      new TextEncoder().encode(canonicalControlMessage(req)),
    )
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, reason: 'bad_signature' }

  if (!ledger.burn(req.nonce, nowSec)) {
    return { ok: false, reason: 'replay' }
  }

  return { ok: true, request: { agent_id: req.agent_id, verb: req.verb, nonce: req.nonce, ts: req.ts } }
}
