// node --test fleet-runtime/fleet-sign.test.mjs   (Node 22.15+ for CLI module hooks, no deps)
//
// signedAttach's `host` field (#21 slice 2) — verifies the ACTUAL POST body sent to
// /api/fleet/attach-signed carries the self-reported hostname, not just that a caller's
// opts object contains one (that's covered separately in fleet-daemon.test.mjs, which
// only checks what runDaemonOnce PASSES to a mocked signedAttach — this test drives the
// real signedAttach function end to end, including the signature, with a fake fetch).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as w } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { signedAttach, canonicalMessage, validatePrivateKeyStat } from './fleet-sign.mjs'

test('signedAttach: model is sent raw and covered by the actual signature', async () => {
  const pair = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const capture = {}
  const model = ' preview\nmodel\u0000' + 'x'.repeat(130)
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', model, privKey: pair.privateKey, fetchImpl: fakeFetch(capture),
  })
  const b = capture.body
  assert.equal(b.model, model)
  const legacy = ['fleet-attach:v1', 't', b.agent_id, b.type, b.runtime, b.lifecycle, String(b.ts), b.nonce].join('\n')
  const sig = Buffer.from(b.sig, 'base64url')
  const verify = (msg) => w.subtle.verify('Ed25519', pair.publicKey, sig, new TextEncoder().encode(msg))
  assert.equal(await verify(legacy + '\nmodel\n' + JSON.stringify(model)), true)
  assert.equal(await verify(legacy), false)
  assert.equal(await verify(legacy + '\nmodel\n' + JSON.stringify('other')), false)
})

test('signedAttach: omitted model keeps the legacy signature and omits the body field', async () => {
  const pair = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const capture = {}
  await signedAttach('https://pot.example.com', 'agent-one', {
    tenant: 't', privKey: pair.privateKey, fetchImpl: fakeFetch(capture),
  })
  const b = capture.body
  assert.equal(Object.hasOwn(b, 'model'), false)
  const legacy = ['fleet-attach:v1', 't', b.agent_id, b.type, b.runtime, b.lifecycle, String(b.ts), b.nonce].join('\n')
  assert.equal(canonicalMessage({ tenant: 't', agentId: b.agent_id, ...b }), legacy)
  assert.equal(await w.subtle.verify('Ed25519', pair.publicKey, Buffer.from(b.sig, 'base64url'), new TextEncoder().encode(legacy)), true)
})

test('signedAttach: refuses non-string model', async () => {
  const privKey = await genKey()
  for (const model of [null, 42, {}, []]) {
    await assert.rejects(signedAttach('https://pot.example.com', 'agent-one', {
      tenant: 't', model, privKey, fetchImpl: fakeFetch({}),
    }), /model.*string/)
  }
})

test('attach-signed CLI: FLEET_ATTACH_MODEL forwards unchanged, default omits it (no key access)', () => {
  // Intercept only the signing module in the child: exercise the real CLI argument/env
  // handling while guaranteeing the test cannot load a host private key or send HTTP.
  const mockSource = 'export async function signedAttach(base, agent, opts) { return { ok:true, json:{ agent:opts } } }'
  const preload = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './fleet-sign.mjs') return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(mockSource))}, shortCircuit:true };
      return next(specifier, context);
    } });`
  const run = (model) => {
    const env = { ...process.env, FLEET_TENANT: 't' }
    delete env.FLEET_ATTACH_MODEL
    if (model !== undefined) env.FLEET_ATTACH_MODEL = model
    const res = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
      new URL('./attach-signed.mjs', import.meta.url).pathname, 'https://pot.example.com', 'agent-one'], { env, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    return JSON.parse(res.stdout).attached
  }
  assert.equal(run('claude-opus-4-6').model, 'claude-opus-4-6')
  assert.equal(Object.hasOwn(run(), 'model'), false)
  assert.equal(Object.hasOwn(run(''), 'model'), false)
})

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

test('private key permissions accept only owner 0600 or root:trusted-group 0440', () => {
  const file = (uid, gid, mode) => ({ uid, gid, mode: 0o100000 | mode, isFile: () => true })

  assert.doesNotThrow(() => validatePrivateKeyStat(file(10001, 10001, 0o600), { uid: 10001, gid: 10001 }))
  assert.doesNotThrow(() => validatePrivateKeyStat(file(0, 10001, 0o440), { uid: 10001, gid: 10001 }))
  assert.throws(() => validatePrivateKeyStat(file(0, 10002, 0o440), { uid: 10001, gid: 10001 }), /ownership or mode invalid/)
  assert.throws(() => validatePrivateKeyStat(file(0, 10001, 0o400), { uid: 10001, gid: 10001 }), /ownership or mode invalid/)
  assert.throws(() => validatePrivateKeyStat(file(0, 10001, 0o460), { uid: 10001, gid: 10001 }), /ownership or mode invalid/)
  assert.throws(() => validatePrivateKeyStat({ ...file(0, 10001, 0o440), isFile: () => false }, { uid: 10001, gid: 10001 }), /regular file/)
})
