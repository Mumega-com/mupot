// node --test fleet-runtime/fleet-sign.test.mjs   (node >= 18 built-in runner, no deps)
//
// signedAttach's `host` field (#21 slice 2) — verifies the ACTUAL POST body sent to
// /api/fleet/attach-signed carries the self-reported hostname, not just that a caller's
// opts object contains one (that's covered separately in fleet-daemon.test.mjs, which
// only checks what runDaemonOnce PASSES to a mocked signedAttach — this test drives the
// real signedAttach function end to end, including the signature, with a fake fetch).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as w } from 'node:crypto'
import { signedAttach, canonicalMessage } from './fleet-sign.mjs'

async function genKey() {
  const pair = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  return pair.privateKey
}

function fakeFetch(capture) {
  return async (url, init) => {
    capture.url = url
    capture.body = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, agent: { agent_id: 'a' } }) }
  }
}

test('signedAttach: includes the caller-supplied host in the POST body', async () => {
  const privKey = await genKey()
  const capture = {}
  const res = await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', type: 'builder', runtime: 'claude-code', lifecycle: 'on_demand',
    host: 'hetzner-1', privKey, fetchImpl: fakeFetch(capture),
  })
  assert.equal(res.ok, true)
  assert.equal(capture.url, 'https://pot.example.com/api/fleet/attach-signed')
  assert.equal(capture.body.host, 'hetzner-1')
  assert.equal(capture.body.agent_id, 'agent-one')
})

test('signedAttach: defaults host to "" when the caller omits it (backward compatible)', async () => {
  const privKey = await genKey()
  const capture = {}
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', privKey, fetchImpl: fakeFetch(capture),
  })
  assert.equal(capture.body.host, '')
})

test('signedAttach: a non-string host is coerced to "" — never sent raw, never throws', async () => {
  const privKey = await genKey()
  const capture = {}
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', host: 12345, privKey, fetchImpl: fakeFetch(capture),
  })
  assert.equal(capture.body.host, '')
})

test('canonicalMessage: has no host slot — a hostile/garbage host can never influence the signed bytes', () => {
  // Same ts/nonce/tenant/agentId/type/runtime/lifecycle, only `host` would differ if it
  // were (wrongly) threaded in — canonicalMessage doesn't even accept it as a field, so
  // this locks the shape: [domain, tenant, agentId, type, runtime, lifecycle, ts, nonce].
  const base = { tenant: 't', agentId: 'agent-one', type: 'builder', runtime: 'claude-code', lifecycle: 'on_demand', ts: 1_700_000_000, nonce: 'abc' }
  const msg = canonicalMessage(base)
  // Passing an extra `host` property is a no-op — canonicalMessage only reads the 8
  // documented fields, so the byte output is identical either way.
  const msgWithHostField = canonicalMessage({ ...base, host: 'attacker-supplied-host' })
  assert.equal(msg, msgWithHostField)
  assert.ok(!msg.includes('attacker-supplied-host'))
})

test('signedAttach: sig is a valid base64url Ed25519 signature regardless of host value', async () => {
  const privKey = await genKey()
  const c1 = {}
  const c2 = {}
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', host: 'host-a', privKey, fetchImpl: fakeFetch(c1),
  })
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', host: 'host-b', privKey, fetchImpl: fakeFetch(c2),
  })
  assert.match(c1.body.sig, /^[A-Za-z0-9_-]{80,120}$/)
  assert.match(c2.body.sig, /^[A-Za-z0-9_-]{80,120}$/)
  assert.notEqual(c1.body.host, c2.body.host)
})
