import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto as w } from 'node:crypto'
import { bootstrapFleetTrust } from './trust-bootstrap.mjs'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-trust-'))
  const control = join(dir, 'control.json')
  const panel = join(dir, 'panel.pub.jwk')
  writeFileSync(control, JSON.stringify({ poll_sec: 5 }), { mode: 0o600 })
  const kp = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = await w.subtle.exportKey('jwk', kp.publicKey)
  return { dir, control, panel, pub }
}

test('bootstrap installs canonical public-only trust and the exact consumer identity', async () => {
  const f = await fixture()
  let request
  const receipt = await bootstrapFleetTrust({
    baseUrl: 'https://pot.example.com/',
    controlPath: f.control,
    panelKeyPath: f.panel,
  }, {
    fetchFn: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({
        ok: true,
        tenant: 'tenant-a',
        consumer_agent_id: '05fb2b56-8332-4034-b311-e8d4100dc166',
        panel_public_key: f.pub,
      }))
    },
  })

  assert.equal(request.url, 'https://pot.example.com/api/fleet/trust')
  assert.deepEqual(request.init, { redirect: 'error' })
  assert.equal(receipt.status, 'pass')
  const key = JSON.parse(readFileSync(f.panel, 'utf8'))
  assert.deepEqual(key, { kty: 'OKP', crv: 'Ed25519', x: f.pub.x })
  assert.equal(key.d, undefined)
  const control = JSON.parse(readFileSync(f.control, 'utf8'))
  assert.equal(control.base_url, 'https://pot.example.com')
  assert.equal(control.tenant, 'tenant-a')
  assert.equal(control.consumer_agent_id, '05fb2b56-8332-4034-b311-e8d4100dc166')
  assert.equal(control.panel_public_key, f.panel)
  assert.equal(statSync(f.control).mode & 0o777, 0o600)
  assert.equal(statSync(f.panel).mode & 0o777, 0o644)
})

test('bootstrap refuses non-public, malformed, oversized, and unauthorized trust responses', async () => {
  const f = await fixture()
  const call = (response) => bootstrapFleetTrust({
    baseUrl: 'https://pot.example.com',
    controlPath: f.control, panelKeyPath: f.panel,
  }, { fetchFn: async () => response })

  await assert.rejects(call(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })), /forbidden/)
  await assert.rejects(call(new Response('{bad')), /not valid JSON/)
  await assert.rejects(call(new Response('x'.repeat(17 * 1024))), /too large/)
  await assert.rejects(call(new Response(JSON.stringify({
    ok: true, tenant: 'tenant-a', consumer_agent_id: 'fleet-consumer',
    panel_public_key: { ...f.pub, d: 'private' },
  }))), /invalid shape/)
})

test('bootstrap validates the base URL', async () => {
  const f = await fixture()
  const base = { controlPath: f.control, panelKeyPath: f.panel }
  await assert.rejects(bootstrapFleetTrust({ ...base, baseUrl: 'http://pot.example.com' }), /must use https/)
  await assert.rejects(bootstrapFleetTrust({ ...base, baseUrl: 'https://user:pass@pot.example.com' }), /must not contain/)
  await assert.rejects(bootstrapFleetTrust({ ...base, baseUrl: 'https://pot.example.com/path' }), /must not contain/)
  await assert.rejects(bootstrapFleetTrust({ ...base, baseUrl: 'https://pot.example.com', panelKeyPath: f.control }), /paths must differ/)
})
