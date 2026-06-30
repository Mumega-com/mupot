#!/usr/bin/env node
// Generate an agent's Ed25519 signing keypair for pot signed-attach.
//
//   node agent-keygen.mjs <agent_id>
//
// Writes the PRIVATE key (JWK) to ~/.fleet/agents/<agent_id>.key with 0600 perms — it NEVER
// leaves this host. Prints ONLY the PUBLIC key x-coordinate (base64url) to stdout, which gets
// registered in the pot (agent_keys.pubkey). Refuses to overwrite an existing key (re-keying
// is deliberate — delete the old file first).
import { webcrypto as w } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const agentId = process.argv[2]
if (!agentId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) {
  console.error('usage: node agent-keygen.mjs <agent_id>   (lowercase slug a-z0-9-)')
  process.exit(2)
}

const dir = join(homedir(), '.fleet', 'agents')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const keyPath = join(dir, `${agentId}.key`)
if (existsSync(keyPath)) {
  console.error(`refusing to overwrite existing key: ${keyPath}\n` +
    `(delete it first to deliberately re-key '${agentId}')`)
  process.exit(3)
}

const kp = await w.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const priv = await w.subtle.exportKey('jwk', kp.privateKey)
const pub = await w.subtle.exportKey('jwk', kp.publicKey)

writeFileSync(keyPath, JSON.stringify(priv), { mode: 0o600 })
chmodSync(keyPath, 0o600)

process.stdout.write(`AGENT_PUBKEY=${pub.x}\n`)
console.error(`private key written 0600 → ${keyPath} (stays on this host)`)
