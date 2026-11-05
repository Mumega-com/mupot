#!/usr/bin/env node
// seatlink-hostkey-gen — generate the host Ed25519 key for SeatEventsDO tickets.
//   node seatlink-hostkey-gen.mjs [private-key-path]   (default ~/.fleet/agents/seatlink-host.key)
// Writes the PKCS8 PEM private key to <path> with mode 600 (refuses if the file exists) and prints ONLY
// the public key (canonical Ed25519 JWK `x`, base64url, 43 chars: the exact `public_key` value for
// register_agent_key, src/mcp/provision.ts:1951, validated by isValidEd25519PublicX in
// src/fleet/agent-keys.ts) and its fingerprint (sha256 hex of that string: agentKeyFingerprint).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_KEY_PATH = path.join(os.homedir(), '.fleet', 'agents', 'seatlink-host.key')

export function generate(file) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.statSync(dir).mode & 0o022) { const e = new Error('parent dir group/other writable'); e.code = 'EDIRPERM'; throw e }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  // 'wx' = O_CREAT|O_EXCL: refuses an existing file (and a symlink) atomically; mode set at creation.
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, pem) } finally { fs.closeSync(fd) }
  const x = publicKey.export({ format: 'jwk' }).x
  const fingerprint = crypto.createHash('sha256').update(x).digest('hex')
  return { public_key: x, fingerprint }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || DEFAULT_KEY_PATH
  try {
    const { public_key, fingerprint } = generate(target)
    console.log(JSON.stringify({ public_key, fingerprint }))
  } catch (e) {
    console.error(e.code === 'EEXIST' ? `refusing: ${target} already exists` : e.code === 'EDIRPERM' ? 'refusing: parent dir is group/other writable' : `failed: ${e.code ?? 'error'}`)
    process.exit(1)
  }
}
