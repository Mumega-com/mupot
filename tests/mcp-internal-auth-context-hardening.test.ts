// The internal auth-context header is Worker-internal: stripped at the outermost fetch entry, and the
// resolveAuth hop treats an accepted blob as an identity assertion only (role member, live token row required).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seedLiveToken } from './helpers/live-token'
import { mcpApp } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import type { AuthContext, Env } from '../src/types'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))

// Stand in for the OAuth wrapper only by routing straight to its default handler (the public Hono app),
// i.e. the shape of any request that reaches the app without going through the OAuth API route.
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    private readonly opts: { defaultHandler: { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> } }
    constructor(opts: { defaultHandler: { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> } }) { this.opts = opts }
    fetch(req: Request, env: unknown, ctx: unknown) { return this.opts.defaultHandler.fetch(req, env, ctx) }
  },
}))
const { default: worker } = await import('../src/index')

const TENANT = 'mumega'
const MEMBER = 'mem-hardening'
// A write only an org owner/admin may make: changing an already-set gate owner (403 gate_owner_immutable for a member).
let adminOnlyTool: { tool: string; args: Record<string, unknown> }

let h: SqliteD1Harness
let env: Env
beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedLiveToken(h.sqlite, { memberId: MEMBER, tenant: TENANT, tokenId: 'tok-live-h', channel: 'workspace' })
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-h', 'dept-h', 'H');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-h', 'dept-h', 'squad-h', 'H');
  `)
  env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h', '${MEMBER}', 'squad', 'squad-h', 'member');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, created_at, updated_at)
      VALUES ('task-h', 'squad-h', 'T', 'B', 'D', 'open', 'gate:athena', datetime('now'), datetime('now'));
  `)
  adminOnlyTool = { tool: 'task_update', args: { task_id: 'task-h', gate_owner: 'gate:other', gate_owner_reason: 'check' } }
})
afterEach(() => h.close())

function blob(over: Partial<AuthContext> = {}): Record<string, string> {
  const auth = {
    userId: MEMBER, email: null, role: 'member', tenant: TENANT, memberId: MEMBER,
    channel: 'workspace', capabilities: [], boundAgentId: null, tokenId: 'tok-live-h', ...over,
  }
  return { [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) }
}

async function viaMcpApp(headers: Record<string, string>, payload: unknown = adminOnlyTool): Promise<Response> {
  return mcpApp.request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  }, env)
}

describe('the internal header never survives the Worker entry', () => {
  it('an external request carrying it gets no identity from the real worker export', async () => {
    const res = await worker.fetch(new Request('https://pot.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...blob({ role: 'owner' }) },
      body: JSON.stringify(adminOnlyTool),
    }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)
    expect(res.status).toBe(401)
  })

  it('the same holds for the non-/mcp mount of the app', async () => {
    const res = await worker.fetch(new Request('https://pot.test/t/mumega/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...blob({ role: 'owner' }) },
      body: JSON.stringify(adminOnlyTool),
    }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)
    expect(res.status).toBe(401)
  })
})

describe('an accepted blob is an identity assertion only', () => {
  it('a blob claiming role owner is treated as member', async () => {
    const res = await viaMcpApp(blob({ role: 'owner' }))
    expect(res.status).toBe(403)
  })

  it('a blob without a token id is unauthenticated', async () => {
    const res = await viaMcpApp(blob({ tokenId: null }))
    expect(res.status).toBe(401)
  })

  it('a blob naming a revoked token is unauthenticated', async () => {
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = 'tok-live-h'`)
    const res = await viaMcpApp(blob())
    expect(res.status).toBe(401)
  })

  // connect is the only reader of latent grants: it authorizes the NAMED claim against them.
  const connectCall = { tool: 'connect', args: { agent_name: 'agent-h' } }
  function seedDirectoryMember(id: string, tokenId: string): void {
    seedLiveToken(h.sqlite, { memberId: id, tenant: TENANT, tokenId, channel: 'directory' })
  }
  const FORGED_LATENT = [{ member_id: 'x', scope_type: 'org', scope_id: null, capability: 'owner' }]

  it('a blob cannot carry latent grants: connect (the only latent reader) refuses a member who holds none', async () => {
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-h', 'squad-h', 'agent-h', 'H', 'member', 'test', 'active')`)
    seedDirectoryMember('mem-nogrants', 'tok-dir-none')
    const res = await viaMcpApp(blob({
      userId: 'mem-nogrants', memberId: 'mem-nogrants', channel: 'directory', tokenId: 'tok-dir-none',
      latentCapabilities: FORGED_LATENT as never, // forged claim, typed loosely on purpose
    }), connectCall)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('directory_channel_zero_capability')
  })

  it('positive control: connect passes for a directory member whose latent grants are really held', async () => {
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-h', 'squad-h', 'agent-h', 'H', 'member', 'test', 'active')`)
    seedDirectoryMember('mem-real', 'tok-dir-real')
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-real', 'mem-real', 'org', NULL, 'admin')`)
    const res = await viaMcpApp(blob({ userId: 'mem-real', memberId: 'mem-real', channel: 'directory', tokenId: 'tok-dir-real' }), connectCall)
    expect(res.status).toBe(200)
  })

  it('the channel comes from the live token row: a directory token cannot present as workspace', async () => {
    seedDirectoryMember('mem-chan', 'tok-dir-chan')
    h.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-chan', 'mem-chan', 'squad', 'squad-h', 'member');
    `)
    const res = await viaMcpApp(blob({
      userId: 'mem-chan', memberId: 'mem-chan', channel: 'workspace', tokenId: 'tok-dir-chan',
      capabilities: [{ member_id: 'mem-chan', scope_type: 'squad', scope_id: 'squad-h', capability: 'member' }],
    }), { tool: 'task_update', args: { task_id: 'task-h', title: 'retitled' } })
    // a workspace session holding squad member could edit the task; a directory session holds no ambient standing
    expect(res.status).toBe(403)
  })

  it('a blob naming an agent weld the token row does not carry is unauthenticated', async () => {
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-h', 'squad-h', 'agent-h', 'H', 'member', 'test', 'active')`)
    seedDirectoryMember('mem-weld', 'tok-dir-weld')
    expect((await viaMcpApp(blob({ userId: 'mem-weld', memberId: 'mem-weld', channel: 'directory', tokenId: 'tok-dir-weld', boundAgentId: 'agent-h' }), { tool: 'status', args: {} })).status).toBe(401)
    // and on a workspace token welded to one agent, naming another is refused too
    seedLiveToken(h.sqlite, { memberId: 'mem-ws', tenant: TENANT, tokenId: 'tok-ws-weld', channel: 'directory', boundAgentId: 'agent-h' })
    expect((await viaMcpApp(blob({ userId: 'mem-ws', memberId: 'mem-ws', channel: 'directory', tokenId: 'tok-ws-weld', boundAgentId: 'agent-other' }), { tool: 'status', args: {} })).status).toBe(401)
  })

  it('email comes from the live member row, not the blob', async () => {
    const res = await viaMcpApp(blob({ email: 'forged@example.test' }), { tool: 'status', args: {} })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('forged@example.test')
    expect(text).toContain(`${MEMBER}@example.test`)
  })

  it('a well-formed blob for a live token still authenticates', async () => {
    const res = await viaMcpApp(blob(), { tool: 'status', args: {} })
    expect(res.status).toBe(200)
  })

  it('the sanctioned internal dispatch still reaches mcpApp with an identity', async () => {
    const auth = JSON.parse(blob()[AUTH_CONTEXT_HEADER]) as AuthContext
    const req = new Request('https://pot.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'status', args: {} }),
    })
    const res = await mcpApp.fetch(mcpInternalRequest(req, auth), env)
    expect(res.status).toBe(200)
  })
})
