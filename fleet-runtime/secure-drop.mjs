#!/usr/bin/env node
// fleet-runtime/secure-drop.mjs - the HOST side of secure drops (secure moments W2, docs/architecture/secure-moments.md).
//
// A human pastes a secret into a mupot secure page; the browser seals it (HPKE, RFC 9180) to THIS host's public
// key and mupot stores ciphertext only. This script is the only thing that can open it:
//
//   keygen            create ~/.mupot/host-key.json (mode 0600, X25519 private key as a JWK); print the public key
//                     and its fingerprint (sha256 of the raw 32-byte public key). Hand the fingerprint to the human
//                     OUT OF BAND (not through the agent) so they can compare it with the secure page.
//   register          call the mupot MCP tool host_key_register with the agent's own token (public key only) and
//                     PIN this host to the agent id the server names (~/.mupot/agent.json, never re-pinned).
//   pull              fetch revoke instructions and pending drops; revokes FIRST (shred), then drops: open each one,
//                     write ~/.mupot/secrets/<agent id>/<name> (0600, atomic), then ack.
//   revoke <name>     shred that file locally (overwrite + unlink).
//   path <name>       print where <name> lives (a consumer reads it, or symlinks to it from its own config).
//
// FILES: this script writes ONLY inside ~/.mupot/secrets/<agent id>/, a directory it creates 0700. It never touches
// ~/.sos/keys or any other path, and it never replaces or shreds a file it did not create: a 0600 manifest records the
// drop id and sha256 of every version it wrote, and a file missing from it (or edited since) is refused.
//
// SUITE (exactly one, no negotiation): HPKE base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM
// (kem 0x0020, kdf 0x0001, aead 0x0001), hand-rolled from RFC 9180 section 4 / 5.1 on node:crypto only.
//   info = "mupot-secure-drop/v2|" + agent id + "|" + drop id + "|" + name + "|" + host key fingerprint
//          (lowercase hex, computed from OWN key; agent id from the pin; name chooses the file, so it is bound in)
//   aad  = drop id
// The fingerprint a drop is opened under is recomputed from this host's OWN key, never taken from the server;
// a server-supplied fingerprint that differs refuses the drop (a key-substitution signal).
//
// TOKEN RULES (same as cli/mupot.mjs): the bearer token comes from a 0600 regular file only, is never accepted on
// argv, never printed, never put in an error. The API must be https (http only for loopback); redirects are refused.
// Zero npm dependencies. Node >= 20.
import { createHmac, createPrivateKey, createPublicKey, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INFO_PREFIX = 'mupot-secure-drop/v2|'
/** info = prefix + agent id + "|" + drop id + "|" + name + "|" + fingerprint: everything the human saw on the page is bound in. */
export const dropInfo = (agentId, dropId, name, fingerprintHex) => `${INFO_PREFIX}${agentId}|${dropId}|${name}|${fingerprintHex}`
const DEFAULT_API = 'https://mupot.mumega.com'
const DEFAULT_POT = 'mumega'
/** A drop name is a safe filename slug: the ONLY form that is ever joined to a directory path. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const B64U_RE = /^[A-Za-z0-9_-]+$/
const MAX_CT_BYTES = 8 * 1024 + 16

export class DropError extends Error {}

// ------------------------------------------------------------------ small codecs
export const b64uEncode = (buf) => Buffer.from(buf).toString('base64url')
export function b64uDecode(s, what) {
  if (typeof s !== 'string' || s.length === 0 || !B64U_RE.test(s)) throw new DropError(`${what} is not base64url`)
  return Buffer.from(s, 'base64url')
}
const be16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff])

export function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new DropError('invalid drop name')
  return name
}

// ------------------------------------------------------------------ fingerprint
/** sha256 of the raw 32-byte public key, lowercase hex. */
export function fingerprintOf(rawPub) {
  if (rawPub.length !== 32) throw new DropError('public key must be 32 bytes')
  return createHash('sha256').update(rawPub).digest('hex')
}
/** The human-comparable spelling: 16 groups of 4 hex digits. */
export function groupFingerprint(hex) {
  return hex.match(/.{4}/g).join(' ')
}

// ------------------------------------------------------------------ HPKE (RFC 9180), the one suite
const SUITE_KEM = Buffer.concat([Buffer.from('KEM'), be16(0x0020)])
const SUITE = Buffer.concat([Buffer.from('HPKE'), be16(0x0020), be16(0x0001), be16(0x0001)])
const NH = 32
const NK = 16
const NN = 12
const LABEL = Buffer.from('HPKE-v1')

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
function extract(salt, ikm) {
  return hmac(salt.length === 0 ? Buffer.alloc(NH) : salt, ikm)
}
function expand(prk, info, len) {
  let t = Buffer.alloc(0)
  const out = []
  let n = 0
  for (let i = 1; n < len; i++) {
    t = hmac(prk, Buffer.concat([t, info, Buffer.from([i])]))
    out.push(t)
    n += t.length
  }
  return Buffer.concat(out).subarray(0, len)
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, Buffer.concat([LABEL, suite, Buffer.from(label), ikm]))
const labeledExpand = (suite, prk, label, info, len) =>
  expand(prk, Buffer.concat([be16(len), LABEL, suite, Buffer.from(label), info]), len)

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: jwk, format: 'jwk' })
}
function publicKeyFromRaw(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64uEncode(raw) }, format: 'jwk' })
}
export function rawPublicOf(privateKey) {
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x
  return b64uDecode(x, 'public key')
}

/** RFC 9180 base-mode receiver, sequence 0 only (a drop is sealed once). Throws DropError on any failure. */
export function hpkeOpen({ privateKey, enc, info, aad, ct }) {
  if (enc.length !== 32) throw new DropError('enc must be 32 bytes')
  if (ct.length < 16) throw new DropError('ciphertext too short')
  const pkR = rawPublicOf(privateKey)
  let dh
  try {
    dh = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(enc) })
  } catch {
    throw new DropError('key agreement failed')
  }
  if (dh.every((b) => b === 0)) throw new DropError('key agreement produced the all-zero secret')
  const kemContext = Buffer.concat([enc, pkR])
  const eaePrk = labeledExtract(SUITE_KEM, Buffer.alloc(0), 'eae_prk', dh)
  const sharedSecret = labeledExpand(SUITE_KEM, eaePrk, 'shared_secret', kemContext, NH)
  const pskIdHash = labeledExtract(SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0))
  const infoHash = labeledExtract(SUITE, Buffer.alloc(0), 'info_hash', info)
  const ksContext = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash])
  const secret = labeledExtract(SUITE, sharedSecret, 'secret', Buffer.alloc(0))
  const key = labeledExpand(SUITE, secret, 'key', ksContext, NK)
  const nonce = labeledExpand(SUITE, secret, 'base_nonce', ksContext, NN) // seq 0: nonce = base_nonce xor 0
  const d = createDecipheriv('aes-128-gcm', key, nonce)
  d.setAAD(aad)
  d.setAuthTag(ct.subarray(ct.length - 16))
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  } catch {
    throw new DropError('decryption failed')
  }
}

/** Test/support helper: the key schedule outputs for a given recipient key, enc and info (RFC 9180 section 5.1). */
export function hpkeKeySchedule({ privateKey, enc, info }) {
  const pkR = rawPublicOf(privateKey)
  const dh = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(enc) })
  const eaePrk = labeledExtract(SUITE_KEM, Buffer.alloc(0), 'eae_prk', dh)
  const sharedSecret = labeledExpand(SUITE_KEM, eaePrk, 'shared_secret', Buffer.concat([enc, pkR]), NH)
  const pskIdHash = labeledExtract(SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0))
  const infoHash = labeledExtract(SUITE, Buffer.alloc(0), 'info_hash', info)
  const ksContext = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash])
  const secret = labeledExtract(SUITE, sharedSecret, 'secret', Buffer.alloc(0))
  return {
    sharedSecret,
    key: labeledExpand(SUITE, secret, 'key', ksContext, NK),
    baseNonce: labeledExpand(SUITE, secret, 'base_nonce', ksContext, NN),
  }
}

export function privateKeyFromRaw(raw32) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw32]), format: 'der', type: 'pkcs8' })
}

// ------------------------------------------------------------------ files and directories
function lstatOrNull(p) {
  try { return lstatSync(p) } catch (e) { if (e && e.code === 'ENOENT') return null; throw e }
}
const lstatExists = (p) => lstatOrNull(p) !== null

/** Open a file without following a symlink at the final component. */
function openNoFollow(path, flags, mode) {
  return openSync(path, flags | (constants.O_NOFOLLOW ?? 0), mode)
}

/** A file this script creates: exclusive, never through a symlink, and EXPLICITLY mode 0600 (a umask or a default ACL cannot widen it). */
function createFile0600(path) {
  const fd = openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  fchmodSync(fd, 0o600)
  return fd
}

function mode600Regular(fd, where) {
  const st = fstatSync(fd)
  if (!st.isFile()) throw new DropError(`${where} is not a regular file`)
  if (st.mode & 0o077) throw new DropError(`${where} is accessible by group/others; refusing to use it (chmod 600)`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new DropError(`${where} is not owned by this user`)
}

function ownedByUs(st) {
  return typeof process.getuid !== 'function' || st.uid === process.getuid()
}

/**
 * A directory THIS script owns (the secrets tree): created 0700 with an explicit chmod (a umask or a default ACL cannot
 * widen it), and refused if it is a symlink, not ours, or has any group/other bit.
 */
function ensureOwnDir(path, what) {
  if (!lstatExists(path)) {
    mkdirSync(path, { mode: 0o700 })
    chmodSync(path, 0o700)
  }
  const st = lstatSync(path)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new DropError(`${what} is not a plain directory`)
  if (!ownedByUs(st)) throw new DropError(`${what} is not owned by this user`)
  if (st.mode & 0o077) throw new DropError(`${what} is accessible by group/others; refusing to use it (chmod 700)`)
}

/**
 * A parent directory the operator may already have (~/.mupot): created 0700 if absent, otherwise only required to be a
 * real directory we own. Its group bits are NOT checked (a shared host may give it a default ACL); everything secret in it
 * is a 0600 file we own, or lives in a subdirectory we created 0700.
 */
function ensureParentDir(path, what) {
  if (!lstatExists(path)) {
    mkdirSync(path, { mode: 0o700 })
    chmodSync(path, 0o700)
  }
  const st = lstatSync(path)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new DropError(`${what} is not a plain directory`)
  if (!ownedByUs(st)) throw new DropError(`${what} is not owned by this user`)
}

function fsyncDir(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY)
    fsyncSync(fd)
  } catch {
    // best effort: directory fsync is not supported everywhere
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function writeAll(fd, bytes) {
  let off = 0
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
}

/** tmp file (0600) + fsync + rename: the target is never half-written. */
function replaceFileAtomic0600(dir, finalName, bytes, beforeRename) {
  const tmp = join(dir, `.${finalName}.${randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = createFile0600(tmp)
    writeAll(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (beforeRename) beforeRename()
    renameSync(tmp, join(dir, finalName))
    fsyncDir(dir)
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw e
  }
}

// ------------------------------------------------------------------ the host key file
export function mupotDir(home) {
  return join(home, '.mupot')
}
export function hostKeyPath(home) {
  return join(mupotDir(home), 'host-key.json')
}

export function loadHostKey(home) {
  const path = hostKeyPath(home)
  let fd
  try {
    fd = openNoFollow(path, constants.O_RDONLY)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new DropError(`no host key at ${path}; run keygen first`)
    throw new DropError(`cannot open the host key file (${e && e.code ? e.code : 'error'})`)
  }
  try {
    mode600Regular(fd, 'host key file')
    let jwk
    try {
      jwk = JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      throw new DropError('host key file is not valid JSON')
    }
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'X25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
      throw new DropError('host key file is not an X25519 JWK')
    }
    const privateKey = privateKeyFromJwk({ kty: 'OKP', crv: 'X25519', d: jwk.d, x: jwk.x })
    const raw = rawPublicOf(privateKey)
    if (b64uEncode(raw) !== jwk.x) throw new DropError('host key file public part does not match its private part')
    return { privateKey, rawPublic: raw, publicB64u: b64uEncode(raw), fingerprint: fingerprintOf(raw) }
  } finally {
    closeSync(fd)
  }
}

export function keygen(home, { rotate = false } = {}) {
  const path = hostKeyPath(home)
  ensureParentDir(mupotDir(home), '~/.mupot')
  if (lstatExists(path) && !rotate) {
    throw new DropError(`a host key already exists at ${path}; pass --rotate to replace it (drops sealed to the old key become unreadable)`)
  }
  const { privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const body = Buffer.from(`${JSON.stringify({ kty: 'OKP', crv: 'X25519', d: jwk.d, x: jwk.x })}\n`)
  replaceFileAtomic0600(mupotDir(home), 'host-key.json', body, () => {
    const st = lstatOrNull(path)
    if (st && st.isSymbolicLink()) throw new DropError('refusing to replace a symlink')
  })
  return loadHostKey(home)
}

// ------------------------------------------------------------------ the pinned agent (which agent this host serves)
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export function validateAgentId(v) {
  if (typeof v !== 'string' || !AGENT_ID_RE.test(v)) throw new DropError('invalid agent id')
  return v
}
export function agentPinPath(home) {
  return join(mupotDir(home), 'agent.json')
}
/** The agent id this host is pinned to (written once, by `register`, from the answer to the agent's OWN token). */
export function loadAgentPin(home) {
  const path = agentPinPath(home)
  let fd
  try {
    fd = openNoFollow(path, constants.O_RDONLY)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new DropError('this host is not pinned to an agent yet; run register first')
    throw new DropError(`cannot open the agent pin (${e && e.code ? e.code : 'error'})`)
  }
  try {
    mode600Regular(fd, 'agent pin')
    let j
    try { j = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new DropError('agent pin is not valid JSON') }
    return validateAgentId(j && j.agent_id)
  } finally {
    closeSync(fd)
  }
}
export function pinAgent(home, agentId) {
  validateAgentId(agentId)
  ensureParentDir(mupotDir(home), '~/.mupot')
  const path = agentPinPath(home)
  if (lstatExists(path)) {
    const pinned = loadAgentPin(home)
    if (pinned !== agentId) throw new DropError(`this host is pinned to agent ${pinned}; refusing to re-pin it to ${agentId}`)
    return
  }
  replaceFileAtomic0600(mupotDir(home), 'agent.json', Buffer.from(`${JSON.stringify({ v: 1, agent_id: agentId })}\n`))
}

// ------------------------------------------------------------------ the secrets tree and its manifest
// Everything this script writes lives in ~/.mupot/secrets/<agent id>/ , a directory IT creates 0700. It never touches
// ~/.sos/keys or any other file, and it will not replace or shred a file it did not create: a 0600 manifest records, per
// name, the drop id and the sha256 of every version it wrote. A file absent from the manifest, or whose hash differs, is
// someone else's (or was edited) and is refused. (All agents on a shared host run as one Unix user; the manifest is
// what keeps one agent's governor from replacing or shredding another agent's, or an operator's, files.)
export function secretsDir(home, agentId) {
  return join(mupotDir(home), 'secrets', validateAgentId(agentId))
}
export function ensureSecretsDir(home, agentId) {
  ensureParentDir(mupotDir(home), '~/.mupot')
  ensureOwnDir(join(mupotDir(home), 'secrets'), '~/.mupot/secrets')
  const dir = secretsDir(home, agentId)
  ensureOwnDir(dir, `~/.mupot/secrets/${agentId}`)
  return dir
}
const MANIFEST = '.manifest.json'
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

function loadManifest(dir) {
  const path = join(dir, MANIFEST)
  let fd
  try {
    fd = openNoFollow(path, constants.O_RDONLY)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { v: 1, files: {} }
    throw new DropError(`cannot open the manifest (${e && e.code ? e.code : 'error'})`)
  }
  try {
    mode600Regular(fd, 'manifest')
    let j
    try { j = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new DropError('manifest is not valid JSON') }
    if (!j || j.v !== 1 || typeof j.files !== 'object' || j.files === null || Array.isArray(j.files)) throw new DropError('manifest has an unknown shape')
    const files = Object.create(null)
    for (const [name, e] of Object.entries(j.files)) {
      if (!NAME_RE.test(name) || !e || typeof e.drop_id !== 'string' || !Array.isArray(e.hashes) || !e.hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
        throw new DropError('manifest has a malformed entry')
      }
      files[name] = { drop_id: e.drop_id, hashes: e.hashes, written_at: typeof e.written_at === 'string' ? e.written_at : '' }
    }
    return { v: 1, files }
  } finally {
    closeSync(fd)
  }
}
function saveManifest(dir, manifest) {
  replaceFileAtomic0600(dir, MANIFEST, Buffer.from(`${JSON.stringify({ v: 1, files: manifest.files })}\n`))
}
function hashFileNoFollow(path) {
  const fd = openNoFollow(path, constants.O_RDONLY)
  try {
    return sha256Hex(readFileSync(fd))
  } finally {
    closeSync(fd)
  }
}
/** Refuse unless dir/name is absent or a regular file this script wrote (manifest hash match). Returns the manifest entry, if any. */
function assertOursOrAbsent(dir, name, manifest) {
  const target = join(dir, name)
  const st = lstatOrNull(target)
  if (!st) return null
  if (st.isSymbolicLink()) throw new DropError('refusing to overwrite a symlink')
  if (!st.isFile()) throw new DropError('refusing to overwrite a non-regular file')
  const entry = manifest.files[name]
  if (!entry) throw new DropError('refusing to replace a file secure-drop did not create')
  if (!entry.hashes.includes(hashFileNoFollow(target))) throw new DropError('refusing to replace a file that changed since secure-drop wrote it')
  return entry
}

/** Write a secret into the secrets dir: only over its own earlier version, atomically, 0600, manifest first (crash-safe). */
export function writeSecret(dir, name, dropId, bytes) {
  validateName(name)
  const manifest = loadManifest(dir)
  const prior = assertOursOrAbsent(dir, name, manifest)
  const hash = sha256Hex(bytes)
  const writtenAt = new Date().toISOString()
  // 1. the manifest learns the new hash BEFORE the file changes, so a crash between the steps never orphans our own file.
  manifest.files[name] = { drop_id: dropId, hashes: [...new Set([...(prior ? prior.hashes : []), hash])], written_at: writtenAt }
  saveManifest(dir, manifest)
  // 2. the file, atomically; the target is re-checked as late as possible (rename itself never follows a symlink).
  replaceFileAtomic0600(dir, name, bytes, () => assertOursOrAbsent(dir, name, manifest))
  // 3. only the new version is current.
  manifest.files[name] = { drop_id: dropId, hashes: [hash], written_at: writtenAt }
  saveManifest(dir, manifest)
}

/**
 * Shred dir/name: overwrite in place with random bytes of the same length, fsync, unlink, forget it. Only a file this
 * script wrote and that is unchanged. With `dropId`, a file that now belongs to a DIFFERENT (newer) drop is left alone
 * ('superseded'): a stale revoke can never destroy a newer credential. A missing file is already shredded ('absent').
 */
export function shredSecret(dir, name, { dropId } = {}) {
  validateName(name)
  const manifest = loadManifest(dir)
  const target = join(dir, name)
  const st = lstatOrNull(target)
  if (!st) {
    if (manifest.files[name] && (!dropId || manifest.files[name].drop_id === dropId)) {
      delete manifest.files[name]
      saveManifest(dir, manifest)
    }
    return 'absent'
  }
  const entry = assertOursOrAbsent(dir, name, manifest)
  if (dropId && entry.drop_id !== dropId) return 'superseded'
  const fd = openNoFollow(target, constants.O_WRONLY)
  try {
    const size = fstatSync(fd).size
    let off = 0
    while (off < size) {
      const chunk = randomBytes(Math.min(65536, size - off))
      off += writeSync(fd, chunk, 0, chunk.length, off)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  unlinkSync(target)
  fsyncDir(dir)
  delete manifest.files[name]
  saveManifest(dir, manifest)
  return 'shredded'
}

// ------------------------------------------------------------------ token + transport (same rules as cli/mupot.mjs)
function readTokenFile(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new DropError(`cannot open token file ${path} (${e && e.code ? e.code : 'error'})`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new DropError(`token file ${path} is not a regular file`)
    if (st.mode & 0o077) {
      throw new DropError(`token file ${path} is accessible by group/others (mode ${(st.mode & 0o777).toString(8).padStart(3, '0')}); refusing to use it. Fix with: chmod 600 ${path}`)
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (!token) throw new DropError(`token file ${path} is empty`)
    if (!/^[\x21-\x7e]+$/.test(token)) throw new DropError(`token file ${path} contains characters not valid in a bearer token`)
    return token
  } finally {
    closeSync(fd)
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new DropError(`cannot read ${path}`)
  }
}

function expandHome(home, p) {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p
}

function parseApi(api) {
  let url
  try { url = new URL(api) } catch { throw new DropError('invalid API URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new DropError('refusing a non-https API (the bearer token would cross the network in cleartext); http:// is allowed for loopback only')
  }
  if (url.username || url.password) throw new DropError('credentials in the API URL are not accepted')
  return url
}

/** Resolve {api, token} for a pot from ~/.config/mupot (config.json + <pot>.token) or MUPOT_TOKEN_FILE (default pot only). */
export function resolveTarget({ home, env, pot: potFlag, api: apiFlag }) {
  const cfg = readJson(join(home, '.config', 'mupot', 'config.json')) ?? {}
  const pots = cfg && typeof cfg.pots === 'object' && cfg.pots !== null ? cfg.pots : {}
  const defaultPot = typeof cfg.default === 'string' ? cfg.default : DEFAULT_POT
  const pot = potFlag ?? defaultPot
  if (!/^[A-Za-z0-9_.-]+$/.test(pot) || pot.startsWith('.')) throw new DropError('invalid --pot name')
  const entry = Object.prototype.hasOwnProperty.call(pots, pot) && pots[pot] && typeof pots[pot] === 'object' ? pots[pot] : undefined
  if (!entry && pot !== DEFAULT_POT) throw new DropError(`pot "${pot}" is not defined in the mupot config`)
  const bound = parseApi(entry && typeof entry.api === 'string' ? entry.api : DEFAULT_API)
  const url = apiFlag !== undefined ? parseApi(apiFlag) : bound
  const defPath = join(home, '.config', 'mupot', `${pot}.token`)
  const ownPath = entry && typeof entry.token_file === 'string' ? expandHome(home, entry.token_file) : lstatExists(defPath) ? defPath : undefined
  let token = null
  if (ownPath !== undefined) {
    // A pot's own credential is bound to the origin its config declares and is never re-aimed.
    if (url.origin !== bound.origin) throw new DropError(`the token of pot "${pot}" is bound to ${bound.origin}; drop --api`)
    token = readTokenFile(ownPath)
    if (token === null) throw new DropError(`token_file ${ownPath} does not exist`)
  } else if (env.MUPOT_TOKEN_FILE) {
    if (pot !== defaultPot) throw new DropError('MUPOT_TOKEN_FILE applies only to the default pot')
    token = readTokenFile(expandHome(home, env.MUPOT_TOKEN_FILE))
    if (token === null) throw new DropError('MUPOT_TOKEN_FILE does not exist')
  }
  if (token === null) throw new DropError(`no token file found for pot "${pot}" (a 0600 file at ~/.config/mupot/${pot}.token or MUPOT_TOKEN_FILE)`)
  return { api: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, token }
}

async function callTool(io, target, name, args) {
  const url = `${target.api}/mcp`
  let res
  try {
    res = await io.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${target.token}`,
        'user-agent': 'mupot-secure-drop/1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new DropError(`network error contacting ${new URL(url).host}`)
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new DropError(`${new URL(url).host} answered with a redirect; refusing to follow it with credentials`)
  }
  if (res.status === 401 || res.status === 403) throw new DropError(`authentication/authorization failed (HTTP ${res.status})`)
  let msg
  try { msg = JSON.parse(await res.text()) } catch { msg = undefined }
  if (!msg || typeof msg !== 'object' || msg.id !== 1) throw new DropError(`unexpected response (HTTP ${res.status})`)
  if (msg.error) {
    const code = msg.error && typeof msg.error === 'object' && msg.error.data && typeof msg.error.data.error === 'string' ? msg.error.data.error : 'error'
    throw new DropError(`${name} refused: ${code.slice(0, 80)}`)
  }
  const r = msg.result
  if (r && r.isError) {
    const code = r.structuredContent && typeof r.structuredContent.error === 'string' ? r.structuredContent.error : 'error'
    throw new DropError(`${name} refused: ${code.slice(0, 80)}`)
  }
  if (r && typeof r.structuredContent === 'object' && r.structuredContent !== null) return r.structuredContent
  try {
    return JSON.parse(r.content[0].text).result
  } catch {
    throw new DropError(`${name}: unreadable result`)
  }
}

// ------------------------------------------------------------------ pull
function openDrop(hostKey, agentId, drop) {
  if (!drop || typeof drop !== 'object') throw new DropError('malformed drop')
  const name = validateName(drop.name)
  if (typeof drop.id !== 'string' || !UUID_RE.test(drop.id)) throw new DropError('malformed drop id')
  // A drop for another agent is not ours, whatever the server says; the agent id is also bound into the HPKE info below.
  if (drop.agent_id !== agentId) throw new DropError('drop belongs to a different agent than this host is pinned to')
  // The fingerprint is OURS. A server that names a different one is substituting keys or is confused: refuse.
  if (typeof drop.host_key_fingerprint !== 'string' || drop.host_key_fingerprint.replace(/\s+/g, '').toLowerCase() !== hostKey.fingerprint) {
    throw new DropError('drop was sealed to a different host key than this host holds')
  }
  const enc = b64uDecode(drop.enc, 'enc')
  const ct = b64uDecode(drop.ct, 'ct')
  if (ct.length > MAX_CT_BYTES) throw new DropError('ciphertext too large')
  // agent id + drop id + NAME + fingerprint are all inside the HPKE info: a relabelled drop (another name, another agent)
  // does not open, so the name that picks the file is cryptographically the one the human saw.
  const info = Buffer.from(dropInfo(agentId, drop.id, name, hostKey.fingerprint))
  const plaintext = hpkeOpen({ privateKey: hostKey.privateKey, enc, info, aad: Buffer.from(drop.id), ct })
  return { name, plaintext }
}

export async function pull({ home, env, pot, api, fetch: fetchFn, out }) {
  const hostKey = loadHostKey(home)
  const agentId = loadAgentPin(home)
  const target = resolveTarget({ home, env, pot, api })
  const io = { fetch: fetchFn }
  const res = await callTool(io, target, 'secure_drop_pull', {})
  const drops = Array.isArray(res.drops) ? res.drops : []
  const revokes = Array.isArray(res.revokes) ? res.revokes : []
  let failed = 0
  let dir
  const ready = () => { dir = dir ?? ensureSecretsDir(home, agentId); return dir }
  // REVOKES FIRST. A rotation delivers a new credential under the same name as an older revoked one; processing the
  // shred after the write would destroy the new file. (The manifest's drop id is a second guard: a revoke for an older
  // drop never touches a file that now belongs to a newer one.)
  for (const rv of revokes) {
    const idForLog = rv && typeof rv.id === 'string' && UUID_RE.test(rv.id) ? rv.id : '(invalid id)'
    try {
      const name = validateName(rv && rv.name)
      if (typeof rv.id !== 'string' || !UUID_RE.test(rv.id)) throw new DropError('malformed revoke id')
      const r = shredSecret(ready(), name, { dropId: rv.id })
      await callTool(io, target, 'secure_drop_ack', { id: rv.id })
      out(`${r} ${name} (revoked)`)
    } catch (e) {
      failed += 1
      out(`skipped revoke ${idForLog}: ${e instanceof DropError ? e.message : 'unexpected error'}`)
    }
  }
  for (const drop of drops) {
    const idForLog = drop && typeof drop.id === 'string' && UUID_RE.test(drop.id) ? drop.id : '(invalid id)'
    let plaintext
    try {
      const opened = openDrop(hostKey, agentId, drop)
      plaintext = opened.plaintext
      const d = ready()
      writeSecret(d, opened.name, drop.id, plaintext)
      // The file is durable (fsynced + renamed, manifest updated): only now is the drop acknowledged, which deletes the ciphertext.
      await callTool(io, target, 'secure_drop_ack', { id: drop.id })
      out(`delivered ${opened.name} (${plaintext.length} bytes) -> ${join(d, opened.name)}`)
    } catch (e) {
      failed += 1
      out(`skipped ${idForLog}: ${e instanceof DropError ? e.message : 'unexpected error'}`)
    } finally {
      if (plaintext) plaintext.fill(0)
    }
  }
  if (drops.length === 0 && revokes.length === 0) out('nothing pending')
  return failed === 0 ? 0 : 1
}

export async function register({ home, env, pot, api, agent, fetch: fetchFn, out }) {
  const hostKey = loadHostKey(home)
  const target = resolveTarget({ home, env, pot, api })
  const res = await callTool({ fetch: fetchFn }, target, 'host_key_register', { public_key: hostKey.publicB64u })
  const agentId = validateAgentId(res && res.agent_id)
  if (agent !== undefined && agent !== agentId) throw new DropError(`the server says this token is agent ${agentId}, not ${agent}`)
  pinAgent(home, agentId)
  out(`registered host key ${groupFingerprint(hostKey.fingerprint)} for agent ${agentId}${res && res.rotated ? ' (rotated; the previous key is revoked)' : ''}`)
  if (res && typeof res.governors_notified === 'number') out(`governors notified: ${res.governors_notified}`)
  return 0
}

// ------------------------------------------------------------------ CLI
const USAGE = `usage: secure-drop.mjs <command> [options]
  keygen [--rotate]      create ~/.mupot/host-key.json and print the public key + fingerprint
  register [--agent id]  register the host public key with mupot (uses the agent's token file) and pin this host to that agent
  pull                   fetch pending drops, write ~/.mupot/secrets/<agent id>/<name> (0600), ack; act on revokes first
  revoke <name>          shred ~/.mupot/secrets/<agent id>/<name> (only a file this script wrote)
  path <name>            print where <name> is written (never its content)
options: --pot <name>  --api <url>   (the token is read from a 0600 file; it is never accepted on the command line)`

export async function main(argv, io = {}) {
  const home = io.home ?? homedir()
  const env = io.env ?? process.env
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`))
  const fetchFn = io.fetch ?? globalThis.fetch
  const args = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--rotate') opts.rotate = true
    else if (a === '--pot' || a === '--api' || a === '--agent') {
      if (i + 1 >= argv.length) { out(`${a} needs a value`); return 2 }
      opts[a.slice(2)] = argv[++i]
    } else if (/^--(token|bearer|secret|password)/i.test(a)) {
      out('credentials are never accepted on the command line; use a 0600 token file')
      return 2
    } else args.push(a)
  }
  const [cmd, ...rest] = args
  try {
    if (cmd === 'keygen' && rest.length === 0) {
      const k = keygen(home, { rotate: opts.rotate === true })
      out(`public_key: ${k.publicB64u}`)
      out(`fingerprint: ${groupFingerprint(k.fingerprint)}`)
      out('Give this fingerprint to whoever will paste the secret OUT OF BAND (not through the agent). They compare it with the secure page.')
      return 0
    }
    if (cmd === 'register' && rest.length === 0) return await register({ home, env, pot: opts.pot, api: opts.api, agent: opts.agent, fetch: fetchFn, out })
    if (cmd === 'pull' && rest.length === 0) return await pull({ home, env, pot: opts.pot, api: opts.api, fetch: fetchFn, out })
    if (cmd === 'revoke' && rest.length === 1) {
      const name = validateName(rest[0])
      const dir = ensureSecretsDir(home, loadAgentPin(home))
      out(`${shredSecret(dir, name)} ${name}`)
      return 0
    }
    if (cmd === 'path' && rest.length === 1) {
      out(join(secretsDir(home, loadAgentPin(home)), validateName(rest[0])))
      return 0
    }
  } catch (e) {
    out(`error: ${e instanceof DropError ? e.message : 'unexpected error'}`)
    return 1
  }
  out(USAGE)
  return 2
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
