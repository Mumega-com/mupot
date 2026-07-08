// node --test control-request.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as w } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalControlMessage,
  importPanelPublicKey,
  JsonNonceLedger,
  verifyControlRequest,
} from './control-request.mjs'

const b64url = (b) => Buffer.from(b).toString('base64url')

async function keys() {
  const kp = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  return {
    privateKey: kp.privateKey,
    publicJwk: JSON.stringify(await w.subtle.exportKey('jwk', kp.publicKey)),
  }
}

async function signed(privateKey, over = {}) {
  const req = {
    agent_id: 'agent-one',
    verb: 'start',
    nonce: over.nonce ?? b64url(w.getRandomValues(new Uint8Array(18))),
    ts: over.ts ?? 1_700_000_000,
    ...over,
  }
  const sig = await w.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonicalControlMessage(req)),
  )
  return { ...req, sig: b64url(sig) }
}

function memoryLedger() {
  const seen = new Set()
  return {
    burn(nonce) {
      if (seen.has(nonce)) return false
      seen.add(nonce)
      return true
    },
  }
}

test('verifyControlRequest: valid request verifies and burns nonce', async () => {
  const { privateKey, publicJwk } = await keys()
  const key = await importPanelPublicKey(publicJwk)
  const req = await signed(privateKey)
  const res = await verifyControlRequest(key, req, memoryLedger(), { nowSec: req.ts })
  assert.equal(res.ok, true)
  assert.equal(res.request.agent_id, 'agent-one')
  assert.equal(res.request.verb, 'start')
})

test('verifyControlRequest: replay of a valid request is rejected', async () => {
  const { privateKey, publicJwk } = await keys()
  const key = await importPanelPublicKey(publicJwk)
  const ledger = memoryLedger()
  const req = await signed(privateKey)
  assert.equal((await verifyControlRequest(key, req, ledger, { nowSec: req.ts })).ok, true)
  assert.deepEqual(await verifyControlRequest(key, req, ledger, { nowSec: req.ts }), { ok: false, reason: 'replay' })
})

test('verifyControlRequest: tampered verb and stale timestamp are rejected', async () => {
  const { privateKey, publicJwk } = await keys()
  const key = await importPanelPublicKey(publicJwk)
  const req = await signed(privateKey, { ts: 1_700_000_000 })
  assert.deepEqual(
    await verifyControlRequest(key, { ...req, verb: 'stop' }, memoryLedger(), { nowSec: req.ts }),
    { ok: false, reason: 'bad_signature' },
  )
  assert.deepEqual(
    await verifyControlRequest(key, req, memoryLedger(), { nowSec: req.ts + 999 }),
    { ok: false, reason: 'stale' },
  )
})

test('JsonNonceLedger persists and prunes nonce burns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-control-ledger-'))
  const path = join(dir, 'nonces.json')
  const ledger = new JsonNonceLedger(path, { nowSec: () => 1_000 })
  assert.equal(ledger.burn('fresh_nonce_000000'), true)
  assert.equal(ledger.burn('fresh_nonce_000000'), false)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.fresh_nonce_000000, 1_000)
})
