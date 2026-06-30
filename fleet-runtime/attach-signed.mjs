#!/usr/bin/env node
// Signed-attach CLI — proves an agent's identity to the pot WITHOUT a bearer secret.
//
//   node attach-signed.mjs <base_url> <agent_id> --tenant SLUG [--type T] [--runtime R] [--lifecycle L]
//   (tenant may also come from the FLEET_TENANT env var)
//
// Reads the host-held Ed25519 private key from ~/.fleet/agents/<agent_id>.key (0600), signs a
// tenant-bound, time-boxed, single-use message, and POSTs it to /api/fleet/attach-signed. The
// key is used only to sign — never sent, never logged. STERILE: tenant is required.
import { signedAttach } from './fleet-sign.mjs'

function arg(flag, def) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const baseUrl = process.argv[2]
const agentId = process.argv[3]
const tenant = arg('--tenant', process.env.FLEET_TENANT)
if (!baseUrl || !agentId || !tenant) {
  console.error('usage: node attach-signed.mjs <base_url> <agent_id> --tenant SLUG [--type T] [--runtime R] [--lifecycle L]')
  console.error('  (tenant required — via --tenant or FLEET_TENANT env; this runtime hardcodes no tenant)')
  process.exit(2)
}

const res = await signedAttach(baseUrl, agentId, {
  type: arg('--type', 'generic'),
  runtime: arg('--runtime', 'claude-code'),
  tenant,
  lifecycle: arg('--lifecycle', 'on_demand'),
}).catch((e) => {
  console.error(String(e && e.message ? e.message : e))
  process.exit(3)
})

if (!res.ok) {
  console.error(`attach-signed FAILED: HTTP ${res.status} ${JSON.stringify(res.json)}`)
  process.exit(1)
}
console.log(JSON.stringify({ attached: res.json.agent ?? res.json }, null, 2))
