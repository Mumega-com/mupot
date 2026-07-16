// Shared Ed25519 signed-attach core — used by the attach-signed CLI and the fleet daemon.
//
// STERILE / FORKABLE: this runtime ships WITH the pot. It hardcodes NO tenant — the caller
// must supply `tenant` explicitly (from config/env). Fork the pot, point base_url at your
// deployment, set your tenant, run your agents.
//
// The private key never leaves the host; it is used only to sign. The canonical message MUST
// stay byte-identical to the pot's canonicalAttachMessage() (src/fleet/signed-attach.ts):
//   [domain, tenant, agent_id, type, runtime, lifecycle, ts, nonce]  '\n'-joined, UTF-8.
import { webcrypto as w } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SIG_DOMAIN = 'fleet-attach:v1'
export const DETACH_SIG_DOMAIN = 'fleet-detach:v1'
export const INBOX_SIG_DOMAIN = 'agent-inbox:v1'

// HTTP wall-clock bound. Without it, one stalled (half-open) connection freezes the whole
// sequential heartbeat tick → undici's ~300s default would flip the entire fleet to stale.
export const HTTP_TIMEOUT_MS = 8000

export function keyPathFor(agentId) {
  return join(homedir(), '.fleet', 'agents', `${agentId}.key`)
}

/** Load + import an agent's Ed25519 private signing key. Fail-closed on missing file or any
 *  group/world/exec permission bit (only 0600 owner-rw permitted). */
export async function loadPrivKey(agentId) {
  const keyPath = keyPathFor(agentId)
  const st = statSync(keyPath) // throws ENOENT if missing → caller handles
  if (st.mode & 0o177) {
    throw new Error(`key ${keyPath} perms ${(st.mode & 0o777).toString(8)} too open — chmod 600`)
  }
  // SECURITY: a JSON.parse error on the private-key file can echo key bytes (the 'd' scalar)
  // into the thrown message → logs. Catch and re-throw a FIXED string (path only).
  let privJwk
  try {
    privJwk = JSON.parse(readFileSync(keyPath, 'utf8'))
  } catch {
    throw new Error(`key ${keyPath} is unreadable or not valid JSON (regenerate with agent-keygen)`)
  }
  return w.subtle.importKey('jwk', privJwk, { name: 'Ed25519' }, false, ['sign'])
}

/** The exact bytes both sides sign/verify. Keep field order in lockstep with the worker. */
export function canonicalMessage({ tenant, agentId, type, runtime, lifecycle, ts, nonce }) {
  return [SIG_DOMAIN, tenant, agentId, type, runtime, lifecycle, String(ts), nonce].join('\n')
}

/** Domain-separated bytes for signed detach. Keep byte-identical to
 *  src/fleet/signed-detach.ts canonicalDetachMessage(). */
export function canonicalDetachMessage({ tenant, agentId, ts, nonce }) {
  return [DETACH_SIG_DOMAIN, tenant, agentId, String(ts), nonce].join('\n')
}

/** Domain-separated bytes for signed inbox reads. Keep byte-identical to
 *  src/fleet/signed-inbox.ts canonicalInboxMessage(). */
export function canonicalInboxMessage({ tenant, agentId, peek, limit, ts, nonce }) {
  return [
    INBOX_SIG_DOMAIN,
    tenant,
    agentId,
    peek ? '1' : '0',
    String(limit),
    String(ts),
    nonce,
  ].join('\n')
}

function nonce() {
  return Buffer.from(w.getRandomValues(new Uint8Array(32))).toString('base64url')
}

/** Sign + POST a signed-attach (the agent's identity proof / heartbeat). Returns
 *  {ok, status, json}. Never throws on HTTP failure (returns ok:false) so a daemon loop
 *  survives transient errors; a missing/bad key OR a missing tenant throws.
 *
 *  STERILE: `tenant` is REQUIRED — there is no default. The pot is multi-tenant-neutral.
 *
 *  `host` (#21 slice 2) is the self-reported physical-machine signal (os.hostname() on
 *  the calling runtime — see attach-signed.mjs / fleet-daemon.mjs). It is UNTRUSTED,
 *  display-only, and deliberately NOT part of the signed canonicalMessage bytes: a
 *  cosmetic string needs no signature-covered integrity, and keeping it out of the
 *  signed message means no re-signing-scheme change on either side. Defaults to '' (an
 *  older caller that never passes opts.host still round-trips fine — the pot treats
 *  missing/empty host as "unknown", never a hard failure). */
export async function signedAttach(baseUrl, agentId, opts = {}) {
  const {
    type = 'generic',
    runtime = 'claude-code',
    tenant,
    lifecycle = 'on_demand',
    host = '',
    privKey,
    fetchImpl = fetch,
  } = opts
  if (typeof tenant !== 'string' || !tenant) {
    throw new Error('signedAttach: tenant is required (this runtime hardcodes no tenant)')
  }
  const key = privKey ?? (await loadPrivKey(agentId))
  const ts = Math.floor(Date.now() / 1000)
  const requestNonce = nonce()
  const message = canonicalMessage({ tenant, agentId, type, runtime, lifecycle, ts, nonce: requestNonce })
  const sigBuf = await w.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message))
  const sig = Buffer.from(sigBuf).toString('base64url')
  const body = { agent_id: agentId, type, runtime, lifecycle, ts, nonce: requestNonce, sig, host: typeof host === 'string' ? host : '' }

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/fleet/attach-signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // NB AbortSignal.timeout's timer is unref'd — safe here because a real fetch holds a
      // ref'd socket; only a fully-mocked fetch (no pending I/O) could settle early.
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e && e.message ? e.message : e) } }
  }
}

/** Sign + POST a signed detach. This is the explicit offline transition for a
 *  keyed runtime after the host has stopped the agent process or the daemon is
 *  shutting down its managed live agents. */
export async function signedDetach(baseUrl, agentId, opts = {}) {
  const {
    tenant,
    privKey,
    fetchImpl = fetch,
  } = opts
  if (typeof tenant !== 'string' || !tenant) {
    throw new Error('signedDetach: tenant is required (this runtime hardcodes no tenant)')
  }
  const key = privKey ?? (await loadPrivKey(agentId))
  const ts = Math.floor(Date.now() / 1000)
  const requestNonce = nonce()
  const message = canonicalDetachMessage({ tenant, agentId, ts, nonce: requestNonce })
  const sigBuf = await w.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message))
  const sig = Buffer.from(sigBuf).toString('base64url')
  const body = { agent_id: agentId, ts, nonce: requestNonce, sig }

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/fleet/detach-signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e && e.message ? e.message : e) } }
  }
}

/** Sign + POST an inbox read. This is the no-bearer path for fleet-daemon inbox
 *  drain: the same host-held private key used for signed attach proves the agent
 *  identity, and the worker reads only that agent's own inbox. */
export async function signedInbox(baseUrl, agentId, opts = {}) {
  const {
    tenant,
    peek = true,
    limit = 20,
    privKey,
    fetchImpl = fetch,
  } = opts
  if (typeof tenant !== 'string' || !tenant) {
    throw new Error('signedInbox: tenant is required (this runtime hardcodes no tenant)')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('signedInbox: limit must be an integer 1-100')
  }
  const key = privKey ?? (await loadPrivKey(agentId))
  const ts = Math.floor(Date.now() / 1000)
  const requestNonce = nonce()
  const message = canonicalInboxMessage({ tenant, agentId, peek: !!peek, limit, ts, nonce: requestNonce })
  const sigBuf = await w.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message))
  const sig = Buffer.from(sigBuf).toString('base64url')
  const body = { agent_id: agentId, peek: !!peek, limit, ts, nonce: requestNonce, sig }

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/inbox/signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e && e.message ? e.message : e) } }
  }
}
