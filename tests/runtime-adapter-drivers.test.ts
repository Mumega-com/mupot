import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8')

const adapter = read('scripts/runtime_adapter_v1.py')
const cursorWorker = read('scripts/cursor-worker.py')
const mumcpWorker = read('scripts/mumcp-worker.py')
const attachRoutes = read('src/fleet/attach-routes.ts')
const contractMd = read('docs/runtime-adapter-contract.md')

describe('runtime-adapter/v1 reference drivers (BYOA slice 1 de-drift)', () => {
  it('ships a shared reference adapter declaring the contract + signed attach domain', () => {
    expect(adapter).toContain('CONTRACT_ID = "runtime-adapter/v1"')
    expect(adapter).toContain('SIGNED_ATTACH_DOMAIN = "fleet-attach:v1"')
    expect(adapter).toContain('SIGNED_DETACH_DOMAIN = "fleet-detach:v1"')
    expect(adapter).toContain('SIGNED_INBOX_DOMAIN = "agent-inbox:v1"')
    expect(adapter).toContain('LAND_AT_STATUS = "review"')
    expect(adapter).toContain('ATTACH_SIGNED_PATH = "/api/fleet/attach-signed"')
    expect(adapter).toContain('ATTACH_PATH = "/api/fleet/attach"')
    expect(adapter).toContain('def resolve_identity(')
    expect(adapter).toContain('boot_context')
    expect(adapter).toContain('def signed_attach(')
    expect(adapter).toContain('def bearer_attach(')
    expect(adapter).toContain('def land_at_review(')
    expect(adapter).toContain('FORBIDDEN_ADAPTER_ACTIONS')
    expect(adapter).toContain('"merge"')
    expect(adapter).toContain('"deploy"')
    expect(adapter).toContain('"self_verdict"')
  })

  it('refactors cursor-worker onto the reference adapter with runtime=cursor', () => {
    expect(cursorWorker).toContain('from runtime_adapter_v1 import')
    expect(cursorWorker).toContain('CONTRACT_ID')
    expect(cursorWorker).toContain('SIGNED_ATTACH_DOMAIN')
    expect(cursorWorker).toContain('RUNTIME_TYPE = "cursor"')
    expect(cursorWorker).toContain('boot_session(')
    expect(cursorWorker).toContain('poll_open_tasks(')
    expect(cursorWorker).toContain('land_at_review(')
    expect(cursorWorker).toContain('claim_in_progress(')
    // Behavior rails preserved.
    expect(cursorWorker).toContain('worktree", "add"')
    expect(cursorWorker).toContain('npx", "tsc", "--noEmit"')
    expect(cursorWorker).toContain('gh", "pr", "create"')
    expect(cursorWorker).toContain('Do NOT push, do NOT open a PR')
    expect(cursorWorker).not.toContain('CURSOR_AGENT_ID')
    expect(cursorWorker).not.toContain('task_verdict')
    expect(cursorWorker).not.toMatch(/npm run deploy|gh pr merge/)
  })

  it('keeps own-assignee polling on the shared adapter (server-derived agent_id)', () => {
    expect(adapter).toContain('"assignee_agent_id": identity.agent_id')
    expect(adapter).toContain('Own-assignee filter')
  })

  it('refactors mumcp-worker onto the reference adapter with runtime=claude-code', () => {
    expect(mumcpWorker).toContain('from runtime_adapter_v1 import')
    expect(mumcpWorker).toContain('CONTRACT_ID')
    expect(mumcpWorker).toContain('SIGNED_ATTACH_DOMAIN')
    expect(mumcpWorker).toContain('RUNTIME_TYPE = "claude-code"')
    expect(mumcpWorker).toContain('boot_session(')
    expect(mumcpWorker).toContain('poll_open_tasks(')
    expect(mumcpWorker).toContain('land_at_review(')
    expect(mumcpWorker).toContain('MUMCP_RESULT')
    expect(mumcpWorker).toContain('draft_only')
    expect(mumcpWorker).toContain('Never publish')
    expect(mumcpWorker).not.toContain('MUMCP_AGENT_ID')
    expect(mumcpWorker).not.toContain('task_verdict')
    expect(mumcpWorker).not.toMatch(/npm run deploy|gh pr merge/)
  })

  it('accepts cursor as a declared attach runtime type on the pot', () => {
    expect(attachRoutes).toMatch(/VALID_RUNTIMES = new Set\(\[[\s\S]*'cursor'/)
    expect(contractMd).toContain('`cursor`')
  })

  it('keeps both drivers as the only topology-A worker entrypoints (no new bespoke *-worker.py)', () => {
    expect(cursorWorker).toContain('runtime-adapter/v1')
    expect(mumcpWorker).toContain('runtime-adapter/v1')
    expect(adapter).toContain('REFERENCE adapter')
  })
})
