import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/types'

// Same Worker-boundary stubs the other root-app tests use (no DO runtime in node).
vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by route tests') }
  },
}))

const { app } = await import('../src/index')
// @ts-expect-error - plain .mjs generator script
const { generateCliBundleModule } = await import('../scripts/gen-cli-bundle.mjs')
// @ts-expect-error - plain .mjs check script
const { checkCliBundleFresh } = await import('../scripts/check-cli-bundle-fresh.mjs')

const ENV = { TENANT_SLUG: 'tenant-a' } as Env
const CLI_FILE = join(__dirname, '..', 'cli', 'mupot.mjs')
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('GET /cli', () => {
  it('serves the exact file bytes with a matching X-Content-SHA256, public, cacheable 5 minutes', async () => {
    // No Authorization header, no cookie: it must be reachable anonymously.
    const res = await app.request('https://pot.test/cli', {}, ENV)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const onDisk = readFileSync(CLI_FILE)
    expect(Buffer.from(bytes).equals(onDisk)).toBe(true)
    expect(res.headers.get('x-content-sha256')).toBe(sha256(bytes))
    expect(res.headers.get('x-content-sha256')).toBe(sha256(onDisk))
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('does not disturb /health or the auth-gated /mcp route', async () => {
    const health = await app.request('https://pot.test/health', {}, ENV)
    expect(health.status).toBe(200)
    expect((await health.json() as { service: string }).service).toBe('mupot')
    const mcp = await app.request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status' } }) }, ENV)
    expect(mcp.status).toBe(401)
  })

  it('only answers GET', async () => {
    const res = await app.request('https://pot.test/cli', { method: 'POST' }, ENV)
    expect(res.status).not.toBe(200)
  })
})

describe('bundle in sync', () => {
  it('src/cli/bundle.generated.ts is exactly what the generator emits from cli/mupot.mjs', () => {
    expect(checkCliBundleFresh().ok).toBe(true)
    const generated = readFileSync(join(__dirname, '..', 'src', 'cli', 'bundle.generated.ts'), 'utf8')
    expect(generated).toBe(generateCliBundleModule(readFileSync(CLI_FILE, 'utf8')))
  })

  it('the freshness check goes red when the CLI changes without regenerating', () => {
    const real = readFileSync(CLI_FILE, 'utf8')
    expect(generateCliBundleModule(`${real}\n// drift`)).not.toBe(generateCliBundleModule(real))
  })

  it('the generator refuses non-ASCII source (served bytes must equal file bytes)', () => {
    expect(() => generateCliBundleModule('const x = "é"')).toThrow(/ASCII/)
  })
})
