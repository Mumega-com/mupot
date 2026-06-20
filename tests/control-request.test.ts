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
})
