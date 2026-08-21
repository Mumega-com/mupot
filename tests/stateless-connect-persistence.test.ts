import { createHash } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// Issue #1192: Stateless Connect Persistence & Security Invariant Test Suite
//
// Real SQLite schema via applyAllMigrations (satisfies test-schema-source ratchet).
// Verifies that:
// 1. connect() by an authorized caller atomically updates member_tokens.agent_id in D1.
// 2. Subsequent stateless tool calls (orient, send) automatically read bound_agent_id.
// 3. Unauthorized squad claims refuse D1 mutation and fail closed with 403.
// 4. Directory unbound tokens fail closed on writes.
// 5. explicit orient({agent}) never grants write authority.

const TENANT = 'mumega'
const SQUAD_ID = 'squad-hadi-mac'
const AGENT_ID = 'agent-chatgpt-surface'
const AGENT_SLUG = 'hadi-chatgpt'
const RAW_TOKEN = 'test-stateless-bearer'
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex')

function makeEnv(harness: SqliteD1Harness): Env {
  return {
    TENANT_SLUG: TENANT,
    CANONICAL_HOST: 'mupot.mumega.com',
    DB: harness.db,
    VEC: { query: async () => ({ matches: [] }) } as unknown as Env['VEC'],
    BUS: { send: async () => {} } as unknown as Env['BUS'],
    SESSIONS: {} as unknown as Env['SESSIONS'],
    OAUTH_KV: {} as unknown as Env['OAUTH_KV'],
    BLOBS: {} as unknown as Env['BLOBS'],
    AI: {} as unknown as Env['AI'],
    AGENT: {} as unknown as Env['AGENT'],
    SQUAD: {} as unknown as Env['SQUAD'],
  } as unknown as Env
}

function seedFixture(
  sqlite: SqliteD1Harness['sqlite'],
  opts: {
    memberId: string
    tokenId: string
    tokenChannel?: string
    squadCapability?: 'member' | 'admin' | null
  },
): void {
  // 1. Department & Squad
  sqlite
    .prepare('INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)')
    .run('dept-eng', 'dept-eng', 'Engineering')
  sqlite
    .prepare('INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)')
    .run(SQUAD_ID, 'dept-eng', 'hadi-mac', 'Hadi Mac')

  // 2. Agent
  sqlite
    .prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
       VALUES (?, ?, ?, ?, 'chat surface', 'test', 'active')`,
    )
    .run(AGENT_ID, SQUAD_ID, AGENT_SLUG, 'Hadi ChatGPT')

  // 3. Member & Token
  sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant)
       VALUES (?, ?, ?, 'active', ?)`,
    )
    .run(opts.memberId, `${opts.memberId}@mumega.test`, 'Hadi', TENANT)

  sqlite
    .prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES (?, ?, ?, 'test', ?, datetime('now'), NULL, ?)`,
    )
    .run(opts.tokenId, opts.memberId, TOKEN_HASH, opts.tokenChannel ?? 'workspace', TENANT)

  // 4. Agent Member Binding (for dedicated agent tokens)
  if (opts.pairedAgentMember) {
    sqlite
      .prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(TENANT, AGENT_ID, opts.memberId)
  }

  // 5. Capability grant
  if (opts.squadCapability) {
    sqlite
      .prepare(
        `INSERT INTO capabilities (member_id, scope_type, scope_id, capability, created_at)
         VALUES (?, 'squad', ?, ?, datetime('now'))`,
      )
      .run(opts.memberId, SQUAD_ID, opts.squadCapability)
  }
}

async function callTool(env: Env, toolName: string, args: Record<string, unknown> = {}) {
  return mcpApp.request(
    'https://mupot.mumega.com/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${RAW_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `req-${Date.now()}`,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    },
    env,
  )
}

describe('Issue #1192 — Stateless Connect Persistence (Real Schema)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('connect_then_orient_returns_claimed_agent across stateless calls', async () => {
    seedFixture(harness.sqlite, {
      memberId: 'member-hadi-1',
      tokenId: 'tok-hadi-1',
      tokenChannel: 'workspace',
      squadCapability: 'member',
      pairedAgentMember: true,
    })
    const env = makeEnv(harness)

    // Step 1: Stateless connect call
    const connectRes = await callTool(env, 'connect', { agent_name: AGENT_SLUG })
    expect(connectRes.status).toBe(200)
    const connectBody = (await connectRes.json()) as any
    expect(connectBody.result.structuredContent.connection_status).toBe('hot')
    expect(connectBody.result.structuredContent.binding).toBe('durable')

    // Verify D1 row was updated in real SQLite
    const row = harness.sqlite
      .prepare('SELECT agent_id FROM member_tokens WHERE id = ?')
      .get('tok-hadi-1') as { agent_id: string | null }
    expect(row.agent_id).toBe(AGENT_ID)

    // Step 2: Next completely stateless orient call
    const orientRes = await callTool(env, 'orient', {})
    expect(orientRes.status).toBe(200)
    const orientBody = (await orientRes.json()) as any
    expect(orientBody.result.structuredContent.packet.agent.id).toBe(AGENT_ID)
    expect(orientBody.result.structuredContent.packet.agent.name).toBe('Hadi ChatGPT')
  })

  it('unpaired_squad_capable_caller_connect_returns_session_local_and_retains_null_agent_id', async () => {
    // Caller is an authorized squad member, but NOT the dedicated member registered in agent_member_bindings
    seedFixture(harness.sqlite, {
      memberId: 'member-peer-operator',
      tokenId: 'tok-peer-operator',
      tokenChannel: 'workspace',
      squadCapability: 'member',
      pairedAgentMember: false,
    })
    // Pair agent with a different dedicated member
    harness.sqlite
      .prepare(
        `INSERT INTO members (id, email, display_name, status, tenant)
         VALUES ('member-dedicated-agent', 'agent@mumega.test', 'Dedicated Agent Member', 'active', ?)`,
      )
      .run(TENANT)
    harness.sqlite
      .prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, 'member-dedicated-agent', datetime('now'))`,
      )
      .run(TENANT, AGENT_ID)

    const env = makeEnv(harness)

    const connectRes = await callTool(env, 'connect', { agent_name: AGENT_SLUG })
    expect(connectRes.status).toBe(200)
    const connectBody = (await connectRes.json()) as any
    expect(connectBody.result.structuredContent.connection_status).toBe('hot')
    expect(connectBody.result.structuredContent.binding).toBe('session_local')

    // D1 member_tokens row MUST remain null
    const row = harness.sqlite
      .prepare('SELECT agent_id FROM member_tokens WHERE id = ?')
      .get('tok-peer-operator') as { agent_id: string | null }
    expect(row.agent_id).toBeNull()
  })

  it('unauthorized_squad_claim_refuses_d1_weld', async () => {
    seedFixture(harness.sqlite, {
      memberId: 'member-unauthorized',
      tokenId: 'tok-unauth',
      tokenChannel: 'workspace',
      squadCapability: null, // No squad capability
    })
    const env = makeEnv(harness)

    const res = await callTool(env, 'connect', { agent_name: AGENT_SLUG })
    expect(res.status).toBe(403)

    // D1 must NOT have updated
    const row = harness.sqlite
      .prepare('SELECT agent_id FROM member_tokens WHERE id = ?')
      .get('tok-unauth') as { agent_id: string | null }
    expect(row.agent_id).toBeNull()
  })

  it('directory_unbound_bearer_writes_fail_closed', async () => {
    seedFixture(harness.sqlite, {
      memberId: 'member-directory-unbound',
      tokenId: 'tok-dir-unbound',
      tokenChannel: 'directory',
      squadCapability: null,
    })
    const env = makeEnv(harness)

    const sendRes = await callTool(env, 'send', {
      to: 'peer-agent-id',
      body: 'Hello from unbound',
      kind: 'message',
    })
    expect(sendRes.status).toBe(403)
  })

  it('explicit_orient_agent_never_grants_write', async () => {
    seedFixture(harness.sqlite, {
      memberId: 'member-reader',
      tokenId: 'tok-reader',
      tokenChannel: 'workspace',
      squadCapability: 'member',
    })
    const env = makeEnv(harness)

    // Calling orient with explicit agent does NOT bind the token for writes
    const orientRes = await callTool(env, 'orient', { agent: AGENT_SLUG })
    expect(orientRes.status).toBe(200)

    // Token remains unbound in D1
    const row = harness.sqlite
      .prepare('SELECT agent_id FROM member_tokens WHERE id = ?')
      .get('tok-reader') as { agent_id: string | null }
    expect(row.agent_id).toBeNull()
  })
})
