#!/usr/bin/env node
/**
 * Offline conformance smoke for the topology-A reference drivers
 * (cursor-worker.py + mumcp-worker.py) against runtime-adapter/v1.
 *
 * Does not require a live pot — asserts the shared adapter + both drivers
 * declare the contract, signed attach domain, land-at-review rails, and
 * preserve the proven behavior markers.
 *
 * npm run conformance:runtime:drivers
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

const contract = 'runtime-adapter/v1'
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const adapter = read('scripts/runtime_adapter_v1.py')
const cursor = read('scripts/cursor-worker.py')
const mumcp = read('scripts/mumcp-worker.py')
const attach = read('src/fleet/attach-routes.ts')

check('adapter declares contract id', adapter.includes(`CONTRACT_ID = "${contract}"`))
check('adapter declares fleet-attach:v1', adapter.includes('SIGNED_ATTACH_DOMAIN = "fleet-attach:v1"'))
check('adapter lands at review', adapter.includes('LAND_AT_STATUS = "review"'))
check('adapter forbids merge/deploy/self_verdict', ['merge', 'deploy', 'self_verdict'].every((a) => adapter.includes(`"${a}"`)))
check('adapter resolves identity via boot_context', adapter.includes('boot_context') && adapter.includes('def resolve_identity('))
check('adapter implements signed + bearer attach', adapter.includes('def signed_attach(') && adapter.includes('def bearer_attach('))

check('cursor-worker imports reference adapter', cursor.includes('from runtime_adapter_v1 import'))
check('cursor-worker declares runtime=cursor', cursor.includes('RUNTIME_TYPE = "cursor"'))
check('cursor-worker boots + lands at review', cursor.includes('boot_session(') && cursor.includes('land_at_review('))
check('cursor-worker keeps worktree isolation', cursor.includes('worktree", "add"'))
check('cursor-worker keeps tsc verify', cursor.includes('npx", "tsc", "--noEmit"'))
check('cursor-worker driver opens PR', cursor.includes('gh", "pr", "create"'))
check('cursor-worker never self-verdicts', !cursor.includes('task_verdict'))
check('cursor-worker drops hardcoded AGENT_ID authority', !cursor.includes('CURSOR_AGENT_ID'))

check('mumcp-worker imports reference adapter', mumcp.includes('from runtime_adapter_v1 import'))
check('mumcp-worker declares runtime=claude-code', mumcp.includes('RUNTIME_TYPE = "claude-code"'))
check('mumcp-worker boots + lands at review', mumcp.includes('boot_session(') && mumcp.includes('land_at_review('))
check('mumcp-worker keeps draft-only rail', mumcp.includes('draft_only') && mumcp.includes('Never publish'))
check('mumcp-worker never self-verdicts', !mumcp.includes('task_verdict'))
check('mumcp-worker drops hardcoded AGENT_ID authority', !mumcp.includes('MUMCP_AGENT_ID'))

check('pot accepts cursor runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'cursor'/.test(attach))

const failed = checks.filter((c) => !c.ok)
console.log('')
console.log(`runtime-adapter driver conformance: ${checks.length - failed.length}/${checks.length} passed (${contract})`)
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}
