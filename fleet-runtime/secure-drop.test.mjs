// fleet-runtime/secure-drop.test.mjs - the host side of secure drops (node --test fleet-runtime/secure-drop.test.mjs).
// RFC 9180 Appendix A.1 vector (DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, base mode), interop with the
// REAL vendored browser bundle, and every refusal the gate hunts: path traversal in the drop name, symlink overwrite,
// a server-named fingerprint that is not ours, tampered ciphertext, token handling (0600 file, never argv, never
// printed, never re-aimed), ack ordering (only after the file is durable) and shredding that really overwrites.
import assert from 'node:assert/strict'
import { createHash, createCipheriv, webcrypto } from 'node:crypto'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import * as drop from './secure-drop.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = readFileSync(join(here, '..', 'src', 'secure-drop', 'vendor', 'hpke-seal.v1.js'), 'utf8')
const TOKEN = 'mpt_live_0123456789abcdefTOKEN'
const SECRET = 'ghp_SuperSecretValue_1234567890'

function sealer() {
  const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(`${BUNDLE}\nglobalThis.__out = MupotHpke`, ctx)
  return sandbox.__out
}
const bundle = sealer()
const h = (s) => Buffer.from(s, 'hex')

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'secure-drop-test-'))
  mkdirSync(join(home, '.config', 'mupot'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.config', 'mupot', 'mumega.token'), `${TOKEN}\n`, { mode: 0o600 })
  chmodSync(join(home, '.config', 'mupot', 'mumega.token'), 0o600)
  return home
}
const cleanup = (home) => rmSync(home, { recursive: true, force: true })

function lines() {
  const out = []
  const fn = (s) => out.push(s)
  fn.out = out
  fn.text = () => out.join('\n')
  return fn
}

/** A fake mupot MCP endpoint: tools/call handlers by name; records every request (headers included). */
function fakeMcp(handlers) {
  const calls = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, redirect: init.redirect, name: body.params.name, args: body.params.arguments })
    const handler = handlers[body.params.name]
    if (!handler) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'x', data: { error: 'no_handler' } } }), { status: 200 })
    const r = handler(body.params.arguments, calls)
    if (r instanceof Response) return r
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: r }) }], structuredContent: r } }), { status: 200 })
  }
  fetch.calls = calls
  return fetch
}

async function makeDrop(hostKey, { name = 'github-token', id = crypto.randomUUID(), secret = SECRET, fingerprint = hostKey.fingerprint } = {}) {
  const s = await bundle.seal(hostKey.publicB64u, drop.INFO_PREFIX + id + '|' + hostKey.fingerprint, id, new TextEncoder().encode(secret))
  return { id, name, enc: s.enc, ct: s.ct, host_key_fingerprint: fingerprint }
}

// ── RFC 9180 Appendix A.1 ──────────────────────────────────────────────────────────────────────────────
test('RFC 9180 A.1 (DHKEM(X25519,HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode): key schedule and sequence-0 ciphertext', () => {
  const skRm = drop.privateKeyFromRaw(h('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'))
  assert.equal(drop.rawPublicOf(skRm).toString('hex'), '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d') // pkRm
  const pkEm = h('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431') // enc
  const info = h('4f6465206f6e2061204772656369616e2055726e')
  const ks = drop.hpkeKeySchedule({ privateKey: skRm, enc: pkEm, info })
  assert.equal(ks.sharedSecret.toString('hex'), 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc')
  assert.equal(ks.key.toString('hex'), '4531685d41d65f03dc48f6b8302c05b0')
  assert.equal(ks.baseNonce.toString('hex'), '56d890e5accaaf011cff4b7d')
  const pt = h('4265617574792069732074727574682c20747275746820626561757479')
  const aad = h('436f756e742d30')
  const ct = h('f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a')
  // The published ciphertext (seq 0) opens to the published plaintext...
  assert.equal(drop.hpkeOpen({ privateKey: skRm, enc: pkEm, info, aad, ct }).toString('hex'), pt.toString('hex'))
  // ...and re-sealing with the published key and nonce reproduces it byte for byte.
  const c = createCipheriv('aes-128-gcm', ks.key, ks.baseNonce)
  c.setAAD(aad)
  assert.equal(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]).toString('hex'), ct.toString('hex'))
  // Any change to info, aad or the ciphertext fails closed.
  assert.throws(() => drop.hpkeOpen({ privateKey: skRm, enc: pkEm, info: h('00'), aad, ct }))
  assert.throws(() => drop.hpkeOpen({ privateKey: skRm, enc: pkEm, info, aad: h('00'), ct }))
  const bad = Buffer.from(ct)
  bad[3] ^= 1
  assert.throws(() => drop.hpkeOpen({ privateKey: skRm, enc: pkEm, info, aad, ct: bad }))
})

test('hpkeOpen refuses a small-order enc (all-zero shared secret) and wrong lengths', () => {
  const sk = drop.privateKeyFromRaw(h('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'))
  const zero = Buffer.alloc(32)
  assert.throws(() => drop.hpkeOpen({ privateKey: sk, enc: zero, info: h('00'), aad: h('00'), ct: Buffer.alloc(40) }))
  assert.throws(() => drop.hpkeOpen({ privateKey: sk, enc: Buffer.alloc(31, 1), info: h('00'), aad: h('00'), ct: Buffer.alloc(40) }))
  assert.throws(() => drop.hpkeOpen({ privateKey: sk, enc: Buffer.alloc(32, 9), info: h('00'), aad: h('00'), ct: Buffer.alloc(15) }))
})

// ── keygen ─────────────────────────────────────────────────────────────────────────────────────────────
test('keygen writes a 0600 X25519 JWK, prints the public key and the fingerprint = sha256(raw public key)', async () => {
  const home = tmpHome()
  try {
    const out = lines()
    assert.equal(await drop.main(['keygen'], { home, env: {}, out }), 0)
    const path = join(home, '.mupot', 'host-key.json')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.mupot')).mode & 0o777, 0o700)
    const jwk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(jwk.kty, 'OKP')
    assert.equal(jwk.crv, 'X25519')
    const raw = Buffer.from(jwk.x, 'base64url')
    assert.equal(raw.length, 32)
    const fp = createHash('sha256').update(raw).digest('hex')
    assert.ok(out.text().includes(`public_key: ${jwk.x}`))
    assert.ok(out.text().includes(`fingerprint: ${fp.match(/.{4}/g).join(' ')}`))
    assert.ok(!out.text().includes(jwk.d), 'the private key is never printed')
    assert.deepEqual(readdirSync(join(home, '.mupot')), ['host-key.json'], 'no temp file is left behind')
    const loaded = drop.loadHostKey(home)
    assert.equal(loaded.fingerprint, fp)
    // A second keygen refuses to destroy the key; --rotate replaces it.
    const again = lines()
    assert.equal(await drop.main(['keygen'], { home, env: {}, out: again }), 1)
    assert.match(again.text(), /already exists/)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).d, jwk.d)
    assert.equal(await drop.main(['keygen', '--rotate'], { home, env: {}, out: lines() }), 0)
    assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).d, jwk.d)
  } finally { cleanup(home) }
})

test('loadHostKey refuses a loose-mode file, a symlink, junk and a key whose public half does not match', async () => {
  const home = tmpHome()
  try {
    await drop.main(['keygen'], { home, env: {}, out: lines() })
    const path = join(home, '.mupot', 'host-key.json')
    chmodSync(path, 0o644)
    assert.throws(() => drop.loadHostKey(home), /group\/others/)
    chmodSync(path, 0o600)
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, '{not json', { mode: 0o600 })
    assert.throws(() => drop.loadHostKey(home), /not valid JSON/)
    const jwk = JSON.parse(good)
    writeFileSync(path, JSON.stringify({ ...jwk, x: Buffer.alloc(32, 7).toString('base64url') }), { mode: 0o600 })
    assert.throws(() => drop.loadHostKey(home), /does not match/)
    rmSync(path)
    writeFileSync(join(home, 'real.json'), good, { mode: 0o600 })
    symlinkSync(join(home, 'real.json'), path)
    assert.throws(() => drop.loadHostKey(home))
  } finally { cleanup(home) }
})

// ── interop with the real browser bundle ───────────────────────────────────────────────────────────────
test('the vendored browser bundle seals; this script opens (and nothing else does)', async () => {
  const home = tmpHome()
  try {
    await drop.main(['keygen'], { home, env: {}, out: lines() })
    const key = drop.loadHostKey(home)
    assert.equal(await bundle.fingerprint(key.publicB64u), key.fingerprint)
    const id = crypto.randomUUID()
    const s = await bundle.seal(key.publicB64u, `${drop.INFO_PREFIX}${id}|${key.fingerprint}`, id, new TextEncoder().encode(SECRET))
    const open = (otherId, fp) => drop.hpkeOpen({
      privateKey: key.privateKey, enc: Buffer.from(s.enc, 'base64url'), info: Buffer.from(`${drop.INFO_PREFIX}${otherId}|${fp}`),
      aad: Buffer.from(otherId), ct: Buffer.from(s.ct, 'base64url'),
    })
    assert.equal(open(id, key.fingerprint).toString(), SECRET)
    assert.throws(() => open(crypto.randomUUID(), key.fingerprint))
    assert.throws(() => open(id, 'f'.repeat(64)))
  } finally { cleanup(home) }
})

// ── pull ───────────────────────────────────────────────────────────────────────────────────────────────
async function setup() {
  const home = tmpHome()
  await drop.main(['keygen'], { home, env: {}, out: lines() })
  return { home, key: drop.loadHostKey(home), keys: join(home, '.sos', 'keys') }
}
const pullWith = (home, fetch, out = lines(), extra = []) => drop.main(['pull', ...extra], { home, env: {}, fetch, out })

test('pull: opens, writes ~/.sos/keys/<name> 0600 atomically, THEN acks; token only in the Authorization header; no secret printed', async () => {
  const { home, key, keys } = await setup()
  try {
    const d = await makeDrop(key)
    const acked = []
    const fetch = fakeMcp({
      secure_drop_pull: () => ({ ok: true, drops: [d], revokes: [] }),
      secure_drop_ack: (args) => {
        // ORDER: by the time the ack is sent the file must already be durable and complete.
        assert.equal(readFileSync(join(keys, 'github-token'), 'utf8'), SECRET)
        acked.push(args.id)
        return { ok: true, result: 'delivered' }
      },
    })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 0)
    assert.deepEqual(acked, [d.id])
    assert.equal(statSync(join(keys, 'github-token')).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(keys), ['github-token'], 'no temp file is left behind')
    assert.ok(!out.text().includes(SECRET))
    assert.ok(!out.text().includes(TOKEN))
    assert.equal(fetch.calls[0].url, 'https://mupot.mumega.com/mcp')
    assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(fetch.calls[0].redirect, 'manual')
    for (const c of fetch.calls) assert.ok(!JSON.stringify(c.args).includes(TOKEN), 'the token is never in a request body')
    // A drop the server re-offers (an ack that was lost) overwrites idempotently.
    assert.equal(await pullWith(home, fetch), 0)
    assert.equal(readFileSync(join(keys, 'github-token'), 'utf8'), SECRET)
  } finally { cleanup(home) }
})

test('pull replaces an existing regular file atomically (new content, still 0600)', async () => {
  const { home, key, keys } = await setup()
  try {
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    writeFileSync(join(keys, 'github-token'), 'old-value', { mode: 0o644 })
    const d = await makeDrop(key)
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: () => ({ ok: true }) })
    assert.equal(await pullWith(home, fetch), 0)
    assert.equal(readFileSync(join(keys, 'github-token'), 'utf8'), SECRET)
    assert.equal(statSync(join(keys, 'github-token')).mode & 0o777, 0o600)
  } finally { cleanup(home) }
})

test('PATH TRAVERSAL: a server-supplied name that is not a safe slug is refused; nothing is written outside the keys dir, nothing is acked', async () => {
  const { home, key, keys } = await setup()
  try {
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    const names = ['../escape', '..', '.', '.env', 'a/b', '/etc/cron.d/x', 'A', 'a b', '', 'a'.repeat(64), '-lead', 'a\u0000b', 'a.b', '..%2fx']
    const acks = []
    for (const name of names) {
      const d = await makeDrop(key, { name })
      const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
      const out = lines()
      assert.equal(await pullWith(home, fetch, out), 1, JSON.stringify(name))
      assert.match(out.text(), /skipped .*invalid drop name/)
    }
    assert.deepEqual(acks, [])
    assert.deepEqual(readdirSync(keys), [])
    assert.ok(!existsSync(join(home, 'escape')) && !existsSync(join(dirname(keys), 'escape')))
  } finally { cleanup(home) }
})

test('SYMLINK: a symlink (or directory) at the target is never overwritten or followed; no ack; the link target is untouched', async () => {
  const { home, key, keys } = await setup()
  try {
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    const victim = join(home, 'victim.txt')
    writeFileSync(victim, 'victim-original', { mode: 0o600 })
    symlinkSync(victim, join(keys, 'github-token'))
    mkdirSync(join(keys, 'a-directory'))
    const acks = []
    for (const name of ['github-token', 'a-directory']) {
      const d = await makeDrop(key, { name })
      const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
      const out = lines()
      assert.equal(await pullWith(home, fetch, out), 1)
      assert.match(out.text(), /refusing to overwrite/)
    }
    assert.deepEqual(acks, [])
    assert.equal(readFileSync(victim, 'utf8'), 'victim-original')
    assert.ok(lstatSync(join(keys, 'github-token')).isSymbolicLink())
    assert.ok(!readdirSync(keys).some((f) => f.endsWith('.tmp')), 'no temp file is left behind')
  } finally { cleanup(home) }
})

test('the keys directory itself must be a plain directory owned by us and not group/world writable', async () => {
  const { home, key, keys } = await setup()
  try {
    const real = join(home, 'elsewhere')
    mkdirSync(real, { mode: 0o700 })
    mkdirSync(join(home, '.sos'), { mode: 0o700 })
    symlinkSync(real, keys)
    const d = await makeDrop(key)
    const acks = []
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
    let out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.match(out.text(), /not a plain directory/)
    assert.deepEqual(readdirSync(real), [])
    rmSync(keys)
    mkdirSync(keys, { mode: 0o700 })
    chmodSync(keys, 0o777)
    out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.match(out.text(), /group\/world writable/)
    assert.deepEqual(readdirSync(keys), [])
    assert.deepEqual(acks, [])
  } finally { cleanup(home) }
})

test('FINGERPRINT: a drop whose server-named fingerprint is not this host\'s own is refused (no write, no ack)', async () => {
  const { home, key, keys } = await setup()
  try {
    const d = await makeDrop(key, { fingerprint: 'a'.repeat(64) })
    const acks = []
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.match(out.text(), /different host key/)
    assert.deepEqual(acks, [])
    assert.ok(!existsSync(join(keys, 'github-token')))
  } finally { cleanup(home) }
})

test('a drop sealed to ANOTHER key (server fingerprint spoofed to ours) fails to open: no write, no ack', async () => {
  const { home, key, keys } = await setup()
  try {
    const other = await setup()
    try {
      const d = await makeDrop(other.key, { fingerprint: key.fingerprint })
      const acks = []
      const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
      const out = lines()
      assert.equal(await pullWith(home, fetch, out), 1)
      assert.match(out.text(), /decryption failed/)
      assert.deepEqual(acks, [])
      assert.ok(!existsSync(keys) || readdirSync(keys).length === 0)
    } finally { cleanup(other.home) }
  } finally { cleanup(home) }
})

test('tampered ciphertext, wrong drop id, oversized ciphertext and malformed fields are skipped without a write or an ack', async () => {
  const { home, key, keys } = await setup()
  try {
    const good = await makeDrop(key)
    const flipped = Buffer.from(good.ct, 'base64url')
    flipped[1] ^= 1
    const bad = [
      { ...good, ct: flipped.toString('base64url') },
      { ...good, id: crypto.randomUUID() },
      { ...good, id: 'not-a-uuid' },
      { ...good, ct: Buffer.alloc(8 * 1024 + 17, 1).toString('base64url') },
      { ...good, enc: 'AAAA' },
      { ...good, enc: undefined },
      { ...good, ct: '!!!' },
      null,
      'a string',
    ]
    const acks = []
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: bad, revokes: [] }), secure_drop_ack: (a) => { acks.push(a.id); return {} } })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.equal(out.out.filter((l) => l.startsWith('skipped')).length, bad.length)
    assert.deepEqual(acks, [])
    assert.ok(!existsSync(keys) || readdirSync(keys).length === 0)
    assert.ok(!out.text().includes(SECRET))
  } finally { cleanup(home) }
})

test('if the ack fails after the file is written the run reports failure and exits 1 (the server re-offers it)', async () => {
  const { home, key, keys } = await setup()
  try {
    const d = await makeDrop(key)
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [d], revokes: [] }), secure_drop_ack: () => new Response('boom', { status: 500 }) })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.equal(readFileSync(join(keys, 'github-token'), 'utf8'), SECRET)
  } finally { cleanup(home) }
})

test('nothing pending is not an error', async () => {
  const { home } = await setup()
  try {
    const out = lines()
    assert.equal(await pullWith(home, fakeMcp({ secure_drop_pull: () => ({ drops: [], revokes: [] }) }), out), 0)
    assert.match(out.text(), /nothing pending/)
  } finally { cleanup(home) }
})

// ── revoke / shred ─────────────────────────────────────────────────────────────────────────────────────
test('revoke <name> overwrites the file IN PLACE with random bytes of the same length, then unlinks it', async () => {
  const { home, keys } = await setup()
  try {
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    const original = `${SECRET}${'x'.repeat(5000)}`
    writeFileSync(join(keys, 'old-key'), original, { mode: 0o600 })
    const witness = join(home, 'witness-hardlink') // same inode: survives the unlink and shows what was left on disk
    linkSync(join(keys, 'old-key'), witness)
    const out = lines()
    assert.equal(await drop.main(['revoke', 'old-key'], { home, env: {}, out }), 0)
    assert.ok(!existsSync(join(keys, 'old-key')))
    const left = readFileSync(witness)
    assert.equal(left.length, Buffer.byteLength(original))
    assert.ok(!left.toString('latin1').includes('ghp_SuperSecret'), 'the old bytes were overwritten, not just unlinked')
    assert.match(out.text(), /^shredded old-key/m)
    // already gone is fine; a traversal name and a symlink are refused
    assert.equal(await drop.main(['revoke', 'old-key'], { home, env: {}, out: lines() }), 0)
    const bad = lines()
    assert.equal(await drop.main(['revoke', '../victim'], { home, env: {}, out: bad }), 1)
    assert.match(bad.text(), /invalid drop name/)
    writeFileSync(join(home, 'victim'), 'v', { mode: 0o600 })
    symlinkSync(join(home, 'victim'), join(keys, 'linked'))
    assert.equal(await drop.main(['revoke', 'linked'], { home, env: {}, out: lines() }), 1)
    assert.equal(readFileSync(join(home, 'victim'), 'utf8'), 'v')
    assert.ok(lstatSync(join(keys, 'linked')).isSymbolicLink())
  } finally { cleanup(home) }
})

test('pull acts on revoke instructions: shreds the file, then acks; a symlink is refused and not acked', async () => {
  const { home, keys } = await setup()
  try {
    mkdirSync(keys, { recursive: true, mode: 0o700 })
    writeFileSync(join(keys, 'cloud-key'), SECRET, { mode: 0o600 })
    writeFileSync(join(home, 'victim'), 'v', { mode: 0o600 })
    symlinkSync(join(home, 'victim'), join(keys, 'linked-key'))
    const r1 = crypto.randomUUID()
    const r2 = crypto.randomUUID()
    const r3 = crypto.randomUUID()
    const acks = []
    const fetch = fakeMcp({
      secure_drop_pull: () => ({ drops: [], revokes: [{ id: r1, name: 'cloud-key' }, { id: r2, name: 'linked-key' }, { id: r3, name: '../bad' }] }),
      secure_drop_ack: (a) => { acks.push(a.id); return { ok: true, result: 'revoke_acked' } },
    })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.deepEqual(acks, [r1])
    assert.ok(!existsSync(join(keys, 'cloud-key')))
    assert.equal(readFileSync(join(home, 'victim'), 'utf8'), 'v')
  } finally { cleanup(home) }
})

// ── token and transport rules (same as cli/mupot.mjs) ──────────────────────────────────────────────────
test('a group/world-readable token file is refused and its content is never printed', async () => {
  const { home } = await setup()
  try {
    chmodSync(join(home, '.config', 'mupot', 'mumega.token'), 0o644)
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [], revokes: [] }) })
    const out = lines()
    assert.equal(await pullWith(home, fetch, out), 1)
    assert.match(out.text(), /accessible by group\/others/)
    assert.ok(!out.text().includes(TOKEN))
    assert.equal(fetch.calls.length, 0, 'no request is made with a token the file rules refuse')
  } finally { cleanup(home) }
})

test('the token is never accepted on argv (any spelling), and a missing token file is a clear error', async () => {
  const { home } = await setup()
  try {
    for (const argv of [['pull', '--token', TOKEN], ['pull', '--token=' + TOKEN], ['pull', '--bearer', TOKEN], ['register', '--secret', 'x'], ['pull', '--password', 'x']]) {
      const out = lines()
      assert.equal(await drop.main(argv, { home, env: {}, fetch: fakeMcp({}), out }), 2)
      assert.match(out.text(), /never accepted on the command line/)
      assert.ok(!out.text().includes(TOKEN))
    }
    rmSync(join(home, '.config', 'mupot', 'mumega.token'))
    const out = lines()
    assert.equal(await pullWith(home, fakeMcp({}), out), 1)
    assert.match(out.text(), /no token file found/)
  } finally { cleanup(home) }
})

test('MUPOT_TOKEN_FILE works for the default pot; a bare MUPOT_TOKEN env var is NOT a token source', async () => {
  const { home } = await setup()
  try {
    rmSync(join(home, '.config', 'mupot', 'mumega.token'))
    let out = lines()
    assert.equal(await drop.main(['pull'], { home, env: { MUPOT_TOKEN: TOKEN }, fetch: fakeMcp({}), out }), 1)
    assert.match(out.text(), /no token file found/)
    const f = join(home, 'tok')
    writeFileSync(f, TOKEN, { mode: 0o600 })
    out = lines()
    const fetch = fakeMcp({ secure_drop_pull: () => ({ drops: [], revokes: [] }) })
    assert.equal(await drop.main(['pull'], { home, env: { MUPOT_TOKEN_FILE: f }, fetch, out }), 0)
    assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`)
  } finally { cleanup(home) }
})

test('transport: non-https API refused (loopback http allowed), credentials in the URL refused, redirects refused, the bound origin cannot be re-aimed', async () => {
  const { home } = await setup()
  try {
    const ok = fakeMcp({ secure_drop_pull: () => ({ drops: [], revokes: [] }) })
    let out = lines()
    assert.equal(await drop.main(['pull', '--api', 'http://evil.example.test'], { home, env: {}, fetch: ok, out }), 1)
    assert.match(out.text(), /non-https/)
    out = lines()
    assert.equal(await drop.main(['pull', '--api', 'https://user:pw@evil.example.test'], { home, env: {}, fetch: ok, out }), 1)
    out = lines()
    assert.equal(await drop.main(['pull', '--api', 'https://evil.example.test'], { home, env: {}, fetch: ok, out }), 1)
    assert.match(out.text(), /bound to https:\/\/mupot\.mumega\.com/)
    assert.equal(ok.calls.length, 0, 'the token never left for an origin it is not bound to')
    out = lines()
    const redirect = async () => new Response('', { status: 302, headers: { location: 'https://evil.example.test/' } })
    assert.equal(await drop.main(['pull'], { home, env: {}, fetch: redirect, out }), 1)
    assert.match(out.text(), /redirect/)
    // loopback http is fine for a pot whose config names it
    writeFileSync(join(home, '.config', 'mupot', 'config.json'), JSON.stringify({ pots: { mumega: { api: 'http://127.0.0.1:8787' } } }))
    const local = fakeMcp({ secure_drop_pull: () => ({ drops: [], revokes: [] }) })
    assert.equal(await drop.main(['pull'], { home, env: {}, fetch: local, out: lines() }), 0)
    assert.equal(local.calls[0].url, 'http://127.0.0.1:8787/mcp')
  } finally { cleanup(home) }
})

test('a tool error is reported by code only; a 401 is an auth error; neither prints the token', async () => {
  const { home } = await setup()
  try {
    let out = lines()
    const refused = async (_u, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { isError: true, structuredContent: { error: 'host_key_required' }, content: [] } }), { status: 200 })
    assert.equal(await pullWith(home, refused, out), 1)
    assert.match(out.text(), /host_key_required/)
    out = lines()
    assert.equal(await pullWith(home, async () => new Response('no', { status: 401 }), out), 1)
    assert.match(out.text(), /authentication\/authorization failed/)
    assert.ok(!out.text().includes(TOKEN))
  } finally { cleanup(home) }
})

test('register sends ONLY the public key', async () => {
  const { home, key } = await setup()
  try {
    const fetch = fakeMcp({ host_key_register: () => ({ ok: true, rotated: false }) })
    const out = lines()
    assert.equal(await drop.main(['register'], { home, env: {}, fetch, out }), 0)
    assert.deepEqual(fetch.calls[0].args, { public_key: key.publicB64u })
    const jwk = JSON.parse(readFileSync(join(home, '.mupot', 'host-key.json'), 'utf8'))
    assert.ok(!JSON.stringify(fetch.calls).includes(jwk.d), 'the private key never leaves the host')
    assert.ok(out.text().includes(drop.groupFingerprint(key.fingerprint)))
  } finally { cleanup(home) }
})

test('usage and unknown commands exit 2', async () => {
  const out = lines()
  assert.equal(await drop.main(['frobnicate'], { home: tmpdir(), env: {}, out }), 2)
  assert.match(out.text(), /usage:/)
  assert.equal(await drop.main(['revoke'], { home: tmpdir(), env: {}, out: lines() }), 2)
  assert.equal(await drop.main(['pull', 'extra'], { home: tmpdir(), env: {}, out: lines() }), 2)
})

test('the drop name rule and the fingerprint spelling', () => {
  for (const ok of ['a', 'github-token', 'a_b-c9', 'a'.repeat(63)]) assert.doesNotThrow(() => drop.validateName(ok))
  for (const bad of ['', '.a', 'a.b', 'a/b', '../x', 'A', '-a', '_a', 'a'.repeat(64), 5, null, undefined]) assert.throws(() => drop.validateName(bad), /invalid drop name/)
  assert.equal(drop.groupFingerprint('0123456789abcdef'.repeat(4)), Array(4).fill('0123 4567 89ab cdef').join(' '))
})
