// tests/control-request.test.ts — fleet-control panel-side signer (Deliverable 2).
// Round-trip + the committed CROSS-LANGUAGE vector that pins TS-signer ↔ Python-verifier
// compatibility (the same vector is verified by the host in agents/fleet-control/test_control_request.py).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  signControlRequest,
  verifyControlRequest,
  canonicalBytes,
  genNonce,
  ControlRequestError,
  panelPublicJwk,
  _ID_RE,
  _NONCE_RE,
  signSquadControlRequest,
  verifySquadControlRequest,
  canonicalSquadBytes,
  CANON_VERSION,
  CANON_VERSION_SQUAD,
} from '../src/fleet/control-request'

async function freshKeys(): Promise<{ priv: string; pub: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey)),
  }
}

const vector = JSON.parse(readFileSync(new URL('./fleet-control-vector.json', import.meta.url), 'utf8'))

describe('fleet control-request signer', () => {
  it('round-trips sign → verify', async () => {
    const { priv, pub } = await freshKeys()
    const req = await signControlRequest(priv, { agent_id: 'image-gen', verb: 'status' })
    expect(req.agent_id).toBe('image-gen')
    expect(await verifyControlRequest(pub, req)).toBe(true)
  })

  it('a tampered field breaks the signature', async () => {
    const { priv, pub } = await freshKeys()
    const req = await signControlRequest(priv, { agent_id: 'image-gen', verb: 'stop' })
    expect(await verifyControlRequest(pub, { ...req, verb: 'start' })).toBe(false)
    expect(await verifyControlRequest(pub, { ...req, agent_id: 'mumega-brain' })).toBe(false)
  })

  it('rejects malformed input and an unconfigured key (fail-closed)', async () => {
    const { priv } = await freshKeys()
    await expect(signControlRequest(priv, { agent_id: '../evil', verb: 'status' })).rejects.toThrow(ControlRequestError)
    await expect(signControlRequest(priv, { agent_id: 'bad/slug', verb: 'status' })).rejects.toThrow(ControlRequestError)
    await expect(signControlRequest(priv, { agent_id: 'image-gen', verb: 'rm -rf /' })).rejects.toThrow(ControlRequestError)
    await expect(signControlRequest(undefined, { agent_id: 'image-gen', verb: 'status' })).rejects.toThrow(ControlRequestError)
  })

  it('rejects a public key passed where a private key is required', async () => {
    const { pub } = await freshKeys()
    await expect(signControlRequest(pub, { agent_id: 'image-gen', verb: 'status' })).rejects.toThrow(ControlRequestError)
  })

  it('exports only the public panel JWK from the configured private key', async () => {
    const { priv, pub } = await freshKeys()
    const expected = JSON.parse(pub) as JsonWebKey
    const exported = await panelPublicJwk(priv)
    expect(exported).toEqual({ kty: 'OKP', crv: 'Ed25519', x: expected.x })
    expect(exported).not.toHaveProperty('d')
    await expect(panelPublicJwk(undefined)).rejects.toThrow(ControlRequestError)
    await expect(panelPublicJwk(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: expected.x }))).rejects.toThrow(ControlRequestError)
  })

  it('normalizes accepted JWK metadata before WebCrypto import', async () => {
    const { priv, pub } = await freshKeys()
    const parsed = JSON.parse(priv) as JsonWebKey
    const standardAlg = JSON.stringify({ ...parsed, alg: 'EdDSA', key_ops: ['sign'] })
    expect(await panelPublicJwk(standardAlg)).toMatchObject({
      kty: 'OKP', crv: 'Ed25519', x: (JSON.parse(pub) as JsonWebKey).x,
    })
    await expect(panelPublicJwk(JSON.stringify({ ...parsed, alg: 'RS256' }))).rejects.toThrow(/alg/)
    await expect(panelPublicJwk(JSON.stringify({ ...parsed, key_ops: ['verify'] }))).rejects.toThrow(/key_ops/)
  })

  it('canonical bytes match the committed vector string', () => {
    const r = vector.request
    const got = new TextDecoder().decode(canonicalBytes(r.agent_id, r.verb, r.nonce, r.ts))
    expect(got).toBe(vector.canonical)
  })

  it('verifies the committed cross-language vector', async () => {
    expect(await verifyControlRequest(JSON.stringify(vector.public_jwk), vector.request)).toBe(true)
  })

  it('genNonce is url-safe and within the host bounds (16-128)', () => {
    for (let i = 0; i < 50; i++) expect(genNonce()).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  })

  // Cross-language anchor parity (Opus NOTE): JS `$` (no `/m`) must reject a trailing newline
  // exactly like the host's Python `\Z` — else a '\n' could be smuggled past the signer.
  it('regex anchors reject a trailing newline (must equal host \\Z behavior)', () => {
    expect(_ID_RE.test('image-gen\n')).toBe(false)
    expect(_ID_RE.test('image-gen')).toBe(true)
    expect(_NONCE_RE.test('vectornonce000000000\n')).toBe(false)
    expect(_NONCE_RE.test('vectornonce000000000')).toBe(true)
    // also confirm no `/m` flag is set on either
    expect(_ID_RE.flags).toBe('')
    expect(_NONCE_RE.flags).toBe('')
  })
})

describe('fleet squad control-request signer', () => {
  it('round-trips sign → verify', async () => {
    const { priv, pub } = await freshKeys()
    const req = await signSquadControlRequest(priv, { squad_id: 'yang', verb: 'start' })
    expect(req.squad_id).toBe('yang')
    expect(await verifySquadControlRequest(pub, req)).toBe(true)
  })

  it('a tampered field breaks the signature', async () => {
    const { priv, pub } = await freshKeys()
    const req = await signSquadControlRequest(priv, { squad_id: 'yang', verb: 'stop' })
    expect(await verifySquadControlRequest(pub, { ...req, verb: 'start' })).toBe(false)
    expect(await verifySquadControlRequest(pub, { ...req, squad_id: 'yin' })).toBe(false)
  })

  it('rejects malformed input and an unconfigured key (fail-closed)', async () => {
    const { priv } = await freshKeys()
    await expect(signSquadControlRequest(priv, { squad_id: '../evil', verb: 'status' })).rejects.toThrow(ControlRequestError)
    await expect(signSquadControlRequest(priv, { squad_id: 'bad/slug', verb: 'status' })).rejects.toThrow(ControlRequestError)
    await expect(signSquadControlRequest(priv, { squad_id: 'yang', verb: 'rm -rf /' })).rejects.toThrow(ControlRequestError)
    await expect(signSquadControlRequest(undefined, { squad_id: 'yang', verb: 'status' })).rejects.toThrow(ControlRequestError)
  })

  // Distinctness from the agent-targeted canonical string — pinned as a literal string on BOTH
  // sides (this file and the host's test_control_request.py::test_squad_canon_version_pinned)
  // so a drift in either language's format is caught even without a shared committed fixture
  // (the way the single-agent path is pinned via fleet-control-vector.json — a genuine
  // cross-language squad vector is a natural follow-up, not required for this to be safe: both
  // sides independently assert the exact same literal string).
  it('canonical squad bytes use a DISTINCT versioned prefix, pinned literal', () => {
    expect(CANON_VERSION_SQUAD).toBe('fleet-control-squad.v1')
    expect(CANON_VERSION_SQUAD).not.toBe(CANON_VERSION)
    const got = new TextDecoder().decode(canonicalSquadBytes('yang', 'start', 'abcdefghijklmnop1234', 1_700_000_000))
    expect(got).toBe('fleet-control-squad.v1\nyang\nstart\nabcdefghijklmnop1234\n1700000000')
  })

  it('a squad-signed request does not verify as an agent-targeted request (distinct canon)', async () => {
    const { priv, pub } = await freshKeys()
    const squadReq = await signSquadControlRequest(priv, { squad_id: 'yang', verb: 'start' })
    const relabeled = { agent_id: squadReq.squad_id, verb: squadReq.verb, nonce: squadReq.nonce, ts: squadReq.ts, sig: squadReq.sig }
    expect(await verifyControlRequest(pub, relabeled)).toBe(false)
  })
})
