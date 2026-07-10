// Fleet Control — panel-side control-request SIGNER (Deliverable 2, mupot side).
//
// The panel can't run a subprocess (it's a Worker). A start/stop action becomes a SIGNED
// control-request that rides the agent inbox to the host consumer, which verifies it (Ed25519 +
// freshness + single-use nonce) BEFORE touching any process. The panel holds the Ed25519 PRIVATE
// key (FLEET_PANEL_SK, a mupot secret); the host holds only the PUBLIC key.
//
// THE CONTRACT (must match the host verifier byte-for-byte — agents/fleet-control/control_request.py
// in the mumega.com repo): we sign a canonical, versioned, '\n'-joined string of PRE-VALIDATED
// fields (NOT JSON — cross-language JSON canonicalization is a footgun). Every field is validated to
// exclude the '\n' delimiter before the canonical string is built, so the signer's and verifier's
// bytes can't diverge. A committed cross-language test vector (test/fleet-control-vector.json) pins
// this compatibility.

export const CANON_VERSION = 'fleet-control.v1'
export const CONTROL_VERBS = ['start', 'stop', 'status', 'restart'] as const
export type ControlVerb = (typeof CONTROL_VERBS)[number]

// Mirror the host's spec.ID_RE (slug, bounded 64) and NONCE_RE (url-safe, 16-128).
// SECURITY — NO `/m` FLAG. With no flags, `$` anchors at the absolute string end, matching
// Python's `\Z` exactly (the host uses `\Z`). If anyone adds `/m`, JS `$` would also match
// before a trailing `\n`, letting a trailing-newline agent_id/nonce pass here but be rejected
// by the host — re-opening cross-language signature confusion. The control-request.test.ts
// asserts `ID_RE.test('x\n') === false`; keep it that way.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/

// Exposed for the parity test (must equal the host regexes' trailing-newline behavior).
export const _ID_RE = ID_RE
export const _NONCE_RE = NONCE_RE

export interface ControlRequest {
  agent_id: string
  verb: ControlVerb
  nonce: string
  ts: number
  sig: string
}

export class ControlRequestError extends Error {}

function b64urlEncode(bytes: Uint8Array, pad: boolean): string {
  let bin = ''
  for (const x of bytes) bin += String.fromCharCode(x)
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_')
  return pad ? b64 : b64.replace(/=+$/, '')
}

/** 18 random bytes → 24 url-safe chars (no padding ever — 18 is a multiple of 3). */
export function genNonce(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return b64urlEncode(b, false)
}

/** The exact bytes signed/verified. Fields are pre-validated (no '\n' possible). */
export function canonicalBytes(agentId: string, verb: string, nonce: string, ts: number): Uint8Array {
  return new TextEncoder().encode([CANON_VERSION, agentId, verb, nonce, String(ts)].join('\n'))
}

function validate(agentId: string, verb: string, nonce: string, ts: number): void {
  if (!ID_RE.test(agentId)) throw new ControlRequestError('agent_id must be a registry slug (<=64, no traversal)')
  if (!(CONTROL_VERBS as readonly string[]).includes(verb)) throw new ControlRequestError(`verb must be one of ${CONTROL_VERBS.join('|')}`)
  if (!NONCE_RE.test(nonce)) throw new ControlRequestError('nonce must be 16-128 url-safe chars')
  if (!Number.isInteger(ts)) throw new ControlRequestError('ts must be an integer (unix seconds)')
}

type PanelPrivateJwk = JsonWebKey & { kty: 'OKP'; crv: 'Ed25519'; x: string; d: string }

function parsePrivateKey(jwkJson: string): PanelPrivateJwk {
  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(jwkJson) as JsonWebKey
  } catch {
    throw new ControlRequestError('FLEET_PANEL_SK is not valid JSON')
  }
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !jwk.x ||
    typeof (jwk as { d?: unknown }).d !== 'string' ||
    !(jwk as { d: string }).d
  ) {
    throw new ControlRequestError('FLEET_PANEL_SK must be a PRIVATE Ed25519 OKP JWK (with d)')
  }
  return jwk as PanelPrivateJwk
}

async function importPrivateKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = parsePrivateKey(jwkJson)
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
}

/**
 * Derive the host-safe trust root from FLEET_PANEL_SK without returning private
 * scalar `d`. Importing first makes this fail closed for malformed JWK material.
 */
export async function panelPublicJwk(privateKeyJwkJson: string | undefined): Promise<JsonWebKey> {
  if (!privateKeyJwkJson) throw new ControlRequestError('FLEET_PANEL_SK not configured (fail-closed)')
  const jwk = parsePrivateKey(privateKeyJwkJson)
  await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x }
}

export interface SignOpts {
  nonce?: string
  ts?: number
  now?: () => number // ms; injectable for tests
}

/** Build a signed control-request. Validates first; throws ControlRequestError on bad input. */
export async function signControlRequest(
  privateKeyJwkJson: string | undefined,
  input: { agent_id: string; verb: string },
  opts: SignOpts = {},
): Promise<ControlRequest> {
  if (!privateKeyJwkJson) throw new ControlRequestError('FLEET_PANEL_SK not configured (fail-closed)')
  const agentId = input.agent_id
  const verb = input.verb
  const nonce = opts.nonce ?? genNonce()
  const nowMs = opts.now ? opts.now() : Date.now()
  const ts = opts.ts ?? Math.floor(nowMs / 1000)
  validate(agentId, verb, nonce, ts)
  const key = await importPrivateKey(privateKeyJwkJson)
  const sigBytes = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, canonicalBytes(agentId, verb, nonce, ts)))
  // Padded url-safe b64 — the host's base64.urlsafe_b64decode requires correct padding.
  return { agent_id: agentId, verb: verb as ControlVerb, nonce, ts, sig: b64urlEncode(sigBytes, true) }
}

/** TS-side verify (for round-trip tests + a future ack-verify). The host verifies in Python. */
export async function verifyControlRequest(publicKeyJwkJson: string, req: ControlRequest): Promise<boolean> {
  const jwk = JSON.parse(publicKeyJwkJson) as JsonWebKey
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || (jwk as { d?: string }).d) {
    throw new ControlRequestError('public key must be a PUBLIC Ed25519 OKP JWK')
  }
  validate(req.agent_id, req.verb, req.nonce, req.ts)
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, false, ['verify'])
  const sig = Uint8Array.from(atob(req.sig.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))
  return crypto.subtle.verify({ name: 'Ed25519' }, key, sig, canonicalBytes(req.agent_id, req.verb, req.nonce, req.ts))
}
