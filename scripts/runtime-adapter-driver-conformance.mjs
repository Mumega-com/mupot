#!/usr/bin/env node
/**
 * Offline conformance for topology-A runtime-adapter/v1 drivers
 * (cursor-worker.py + mumcp-worker.py + codex-worker.py).
 *
 * Two layers:
 *   1. Structural markers (contract ids, land-at-review rails, runtime types)
 *   2. Behavioral proofs via runtime-adapter-driver-conformance-proof.py —
 *      attach fail-closed, child-env scrub, detach/inbox implemented (not just declared)
 *
 * npm run conformance:runtime:drivers
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
const childEnv = read('scripts/codex_child_env.py')
const attach = read('src/fleet/attach-routes.ts')
const presence = read('src/mcp/presence.ts')
const codexToml = read('connectors/codex/config.toml')

check('adapter declares contract id', adapter.includes(`CONTRACT_ID = "${contract}"`))
check('adapter declares fleet-attach:v1', adapter.includes('SIGNED_ATTACH_DOMAIN = "fleet-attach:v1"'))
check('adapter declares fleet-detach:v1', adapter.includes('SIGNED_DETACH_DOMAIN = "fleet-detach:v1"'))
check('adapter declares agent-inbox:v1', adapter.includes('SIGNED_INBOX_DOMAIN = "agent-inbox:v1"'))
check('adapter lands at review', adapter.includes('LAND_AT_STATUS = "review"'))
check('adapter forbids merge/deploy/self_verdict', ['merge', 'deploy', 'self_verdict'].every((a) => adapter.includes(`"${a}"`)))
check('adapter resolves identity via boot_context', adapter.includes('boot_context') && adapter.includes('def resolve_identity('))
check('adapter implements signed + bearer attach', adapter.includes('def signed_attach(') && adapter.includes('def bearer_attach('))
check('adapter implements signed + bearer detach', adapter.includes('def signed_detach(') && adapter.includes('def bearer_detach('))
check('adapter implements signed inbox', adapter.includes('def signed_inbox(') && adapter.includes('def canonical_inbox_message('))
check(
  'adapter attach is fail-closed (no soft swallow)',
  adapter.includes('Attach / signature verification failure is TERMINAL') &&
    !adapter.includes('attach failed (non-fatal this cycle)') &&
    !adapter.includes('attach failure must not block task work'),
)
check(
  'adapter does not client-assert presence capabilities',
  !adapter.includes('presence_capabilities') &&
    !/["']capabilities["']\s*:/.test(adapter.split('def register_port1_presence')[1]?.split('def boot_session')[0] ?? ''),
)

check('cursor-worker imports reference adapter', cursor.includes('from runtime_adapter_v1 import'))
check('cursor-worker declares runtime=cursor', cursor.includes('RUNTIME_TYPE = "cursor"'))
check('cursor-worker boots + lands at review', cursor.includes('boot_session(') && cursor.includes('land_at_review('))
check('cursor-worker keeps worktree isolation', cursor.includes('worktree", "add"'))
check('cursor-worker keeps tsc verify', cursor.includes('npx", "tsc", "--noEmit"'))
check('cursor-worker driver opens PR', cursor.includes('gh", "pr", "create"'))
check('cursor-worker never self-verdicts', !cursor.includes('task_verdict'))
check('cursor-worker drops hardcoded AGENT_ID authority', !cursor.includes('CURSOR_AGENT_ID'))
check('cursor-worker does not assert presence capabilities', !cursor.includes('presence_capabilities'))

check('mumcp-worker imports reference adapter', mumcp.includes('from runtime_adapter_v1 import'))
check('mumcp-worker declares runtime=claude-code', mumcp.includes('RUNTIME_TYPE = "claude-code"'))
check('mumcp-worker boots + lands at review', mumcp.includes('boot_session(') && mumcp.includes('land_at_review('))
check('mumcp-worker keeps draft-only rail', mumcp.includes('draft_only') && mumcp.includes('Never publish'))
check('mumcp-worker never self-verdicts', !mumcp.includes('task_verdict'))
check('mumcp-worker drops hardcoded AGENT_ID authority', !mumcp.includes('MUMCP_AGENT_ID'))
check('mumcp-worker does not assert presence capabilities', !mumcp.includes('presence_capabilities'))

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
check('codex-worker does not assert presence capabilities', !codex.includes('presence_capabilities'))
check('codex-worker builds allowlisted child env', codex.includes('build_codex_child_env(') && !/env = dict\(os\.environ\)\s*\n\s*env\[CODEX_MCP_ENV_VAR\]/.test(codex))
check('codex child env disallow danger-full-access', childEnv.includes('danger-full-access') && childEnv.includes('DISALLOWED_SANDBOX'))
check('codex child env allowlist excludes GITHUB_', childEnv.includes('GITHUB_') && childEnv.includes('CODEX_CHILD_ENV_ALLOWLIST'))
check(
  'codex connector is streamable-HTTP (no SSE)',
  codexToml.includes('bearer_token_env_var') &&
    codexToml.includes('url = ') &&
    !/^type\s*=\s*"sse"/m.test(codexToml) &&
    !/^transport\s*=\s*"sse"/m.test(codexToml),
)

check('pot accepts cursor runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'cursor'/.test(attach))
check('pot accepts codex runtime type', /VALID_RUNTIMES = new Set\(\[[\s\S]*'codex'/.test(attach))
check(
  'presence capabilities are server-derived',
  presence.includes('derivePresenceCapabilities') &&
    presence.includes('ALWAYS server-derived') &&
    presence.includes('Client-supplied args.capabilities are ignored'),
)

const failed = checks.filter((c) => !c.ok)
console.log('')
console.log(`runtime-adapter driver structural checks: ${checks.length - failed.length}/${checks.length} passed (${contract})`)
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}

console.log('')
console.log('--- behavioral proofs ---')
const proof = spawnSync(
  process.env.PYTHON || 'python3',
  [path.join(root, 'scripts/runtime-adapter-driver-conformance-proof.py')],
  { cwd: root, encoding: 'utf8', env: process.env },
)
if (proof.stdout) process.stdout.write(proof.stdout)
if (proof.stderr) process.stderr.write(proof.stderr)
if (proof.status !== 0) {
  console.error('behavioral proofs FAILED')
  process.exit(proof.status ?? 1)
}
console.log('')
console.log(`runtime-adapter driver conformance: structural+behavioral PASSED (${contract})`)
