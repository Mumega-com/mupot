#!/usr/bin/env node
/**
 * Offline conformance smoke for topology-A runtime-adapter/v1 drivers
 * (cursor-worker.py + mumcp-worker.py + codex-worker.py + claude-code-worker.py).
 *
 * Does not require a live pot — asserts the shared adapter + drivers
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
const codex = read('scripts/codex-worker.py')
const claudeCode = read('scripts/claude-code-worker.py')
const attach = read('src/fleet/attach-routes.ts')
const codexToml = read('connectors/codex/config.toml')
const claudeMcp = read('connectors/claude/.mcp.json')
const flockMcp = read('packs/claude-code/flock-agent/.mcp.json.template')

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

check('codex-worker imports reference adapter', codex.includes('from runtime_adapter_v1 import'))
check('codex-worker declares runtime=codex', codex.includes('RUNTIME_TYPE = "codex"'))
check('codex-worker boots + lands at review', codex.includes('boot_session(') && codex.includes('land_at_review('))
check('codex-worker dispatches via codex exec', codex.includes('"exec"') && codex.includes('"--sandbox"') && codex.includes('"--json"'))
check('codex-worker keeps worktree isolation', codex.includes('worktree", "add"'))
check('codex-worker keeps tsc verify', codex.includes('npx", "tsc", "--noEmit"'))
check('codex-worker driver opens PR', codex.includes('gh", "pr", "create"'))
check('codex-worker never self-verdicts', !codex.includes('task_verdict'))
check('codex-worker never deploys/merges', !codex.includes('npm run deploy') && !codex.includes('gh pr merge'))
check('codex-worker uses bearer_token_env_var MCP', codex.includes('bearer_token_env_var') && codex.includes('mcp_config_stanza') && codex.includes('streamable-HTTP'))
check('codex-worker has mint-attach dry-run path', codex.includes('run_mint_attach') && codex.includes('DRY_RUN'))
check(
  'codex connector is streamable-HTTP (no SSE)',
  codexToml.includes('bearer_token_env_var') &&
    codexToml.includes('url = ') &&
    !/^type\s*=\s*"sse"/m.test(codexToml) &&
    !/^transport\s*=\s*"sse"/m.test(codexToml),
)

check('claude-code-worker imports reference adapter', claudeCode.includes('from runtime_adapter_v1 import'))
check('claude-code-worker declares runtime=claude-code', claudeCode.includes('RUNTIME_TYPE = "claude-code"'))
check('claude-code-worker boots + lands at review', claudeCode.includes('boot_session(') && claudeCode.includes('land_at_review('))
check(
  'claude-code-worker dispatches via claude -p stream-json',
  claudeCode.includes('"-p"') &&
    claudeCode.includes('"--output-format"') &&
    claudeCode.includes('stream-json'),
)
check('claude-code-worker keeps worktree isolation', claudeCode.includes('worktree", "add"'))
check('claude-code-worker keeps tsc verify', claudeCode.includes('npx", "tsc", "--noEmit"'))
check('claude-code-worker driver opens PR', claudeCode.includes('gh", "pr", "create"'))
check('claude-code-worker never self-verdicts', !claudeCode.includes('task_verdict'))
check('claude-code-worker never deploys/merges', !claudeCode.includes('npm run deploy') && !claudeCode.includes('gh pr merge'))
check(
  'claude-code-worker writes type:http .mcp.json',
  claudeCode.includes('mcp_json_document') &&
    claudeCode.includes('"type": "http"') &&
    claudeCode.includes('headers.Authorization') &&
    claudeCode.includes('Authorization'),
)
check('claude-code-worker has mint-attach dry-run path', claudeCode.includes('run_mint_attach') && claudeCode.includes('DRY_RUN'))
check(
  'claude connector .mcp.json is type:http (no SSE)',
  claudeMcp.includes('"type": "http"') &&
    claudeMcp.includes('"Authorization"') &&
    !claudeMcp.includes('"type": "sse"'),
)
check(
  'flock-agent pack .mcp.json.template is type:http (no SSE)',
  flockMcp.includes('"type": "http"') &&
    flockMcp.includes('"Authorization"') &&
    !flockMcp.includes('"type": "sse"'),
)

check('pot accepts cursor runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'cursor'/.test(attach))
check('pot accepts codex runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'codex'/.test(attach))
check('pot accepts claude-code runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'claude-code'/.test(attach))

const failed = checks.filter((c) => !c.ok)
console.log('')
console.log(`runtime-adapter driver conformance: ${checks.length - failed.length}/${checks.length} passed (${contract})`)
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}
