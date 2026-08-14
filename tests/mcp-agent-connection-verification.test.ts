import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import {
  provisionAgentConnection,
  type AgentConnectionIssued,
} from '../src/members/agent-connection'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const NOW = new Date()
const OWNER = {
  kind: 'user' as const,
  id: 'owner-1',
  grants: [],
  legacyOrgRole: 'owner' as const,
}

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-home', 'dept-1', 'home', 'Home');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-24T00:00:00.000Z');
  `)
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

describe('verify_agent_connection MCP callback', () => {
  let harness: SqliteD1Harness
  let env: Env
  let issued: AgentConnectionIssued

  beforeEach(async () => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
    } as Env
    const outcome = await provisionAgentConnection(env, OWNER, {
      requestId: 'mcp-verify',
      target: {
        kind: 'new',
        homeSquadId: 'squad-home',
        agent: { slug: 'mcp-agent', name: 'MCP Agent' },
      },
      additionalAccess: [],
      credential: {
        action: 'issue_if_missing',
        label: 'workspace',
        homeCapability: 'member',
      },
    }, NOW)
    if (outcome.status !== 'credential_issued') throw new Error(outcome.status)
    issued = outcome
  })

  afterEach(() => harness.close())

  async function call(
    rawToken: string,
    args: Record<string, unknown>,
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await mcpApp.request(
      'https://attacker-host.invalid/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rawToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'verify_agent_connection', arguments: args },
        }),
      },
      env,
    )
    return {
      response,
      body: await response.json() as Record<string, unknown>,
    }
  }

  it('is advertised with only receipt_id and challenge arguments', async () => {
    const response = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      env,
    )
    const body = await response.json() as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> }
    }
    expect(body.result.tools.find((tool) => tool.name === 'verify_agent_connection')).toEqual({
      name: 'verify_agent_connection',
      description: expect.any(String),
      inputSchema: {
        type: 'object',
        properties: {
          receipt_id: { type: 'string' },
          challenge: { type: 'string' },
        },
        required: ['receipt_id', 'challenge'],
        additionalProperties: false,
      },
    })
  })

  it('derives all identity from the issued key and returns only non-secret proof', async () => {
    const { response, body } = await call(issued.credential.raw, {
      receipt_id: issued.receipt.id,
      challenge: issued.verification.challenge,
    })
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          status: 'messaging_verified',
          receiptId: issued.receipt.id,
          replay: false,
        },
      },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(issued.credential.raw)
    expect(serialized).not.toContain(issued.verification.challenge)
    expect(serialized).not.toContain(hash(issued.credential.raw))
    expect(serialized).not.toContain('Mupot agent connection verification')
    expect(serialized).not.toContain('attacker-host.invalid')
  })

  it('refuses an unbound human credential before reading the receipt', async () => {
    const raw = 'human-workspace-token'
    harness.sqlite.prepare(
      `INSERT INTO members (id, display_name, status, tenant)
       VALUES ('human-member', 'Human', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, tenant)
       VALUES ('human-token', 'human-member', ?, 'human', 'workspace', ?, ?)`,
    ).run(hash(raw), NOW.toISOString(), TENANT)

    const { response, body } = await call(raw, {
      receipt_id: issued.receipt.id,
      challenge: issued.verification.challenge,
    })
    expect(response.status).toBe(403)
    expect(body).toMatchObject({ error: { message: 'agent_bound_credential_required' } })
    expect(harness.sqlite.prepare(
      'SELECT verification_attempts FROM agent_connection_receipts WHERE id = ?',
    ).get(issued.receipt.id)).toEqual({ verification_attempts: 0 })
  })

  it('collapses another token for the same agent to not found without consuming attempts', async () => {
    const raw = 'second-agent-token'
    harness.sqlite.prepare(
      `INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('second-token', ?, ?, 'second', 'workspace', ?, ?, ?)`,
    ).run(
      issued.receipt.member_id,
      hash(raw),
      NOW.toISOString(),
      issued.receipt.agent_id,
      TENANT,
    )

    const { response, body } = await call(raw, {
      receipt_id: issued.receipt.id,
      challenge: issued.verification.challenge,
    })
    expect(response.status).toBe(404)
    expect(body).toMatchObject({ error: { message: 'verification_not_found' } })
    expect(JSON.stringify(body)).not.toContain(issued.receipt.token_id)
    expect(harness.sqlite.prepare(
      'SELECT verification_attempts FROM agent_connection_receipts WHERE id = ?',
    ).get(issued.receipt.id)).toEqual({ verification_attempts: 0 })
  })

  it('rejects client-supplied identity fields at schema validation', async () => {
    const { response, body } = await call(issued.credential.raw, {
      receipt_id: issued.receipt.id,
      challenge: issued.verification.challenge,
      token_id: issued.receipt.token_id,
      agent_id: issued.receipt.agent_id,
    })
    expect(response.status).toBe(400)
    expect(body).toMatchObject({ error: { message: 'invalid_args' } })
  })

  it('maps challenge mismatch, exhaustion, expiry, and replay to stable outcomes', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const { response, body } = await call(issued.credential.raw, {
        receipt_id: issued.receipt.id,
        challenge: `wrong-${attempt}`,
      })
      expect(response.status).toBe(attempt < 5 ? 409 : 410)
      expect(body).toMatchObject({
        error: { message: attempt < 5 ? 'challenge_mismatch' : 'challenge_exhausted' },
      })
    }

    const expired = await provisionAgentConnection(env, OWNER, {
      requestId: 'mcp-expired',
      target: {
        kind: 'new',
        homeSquadId: 'squad-home',
        agent: { slug: 'expired-agent', name: 'Expired Agent' },
      },
      additionalAccess: [],
      credential: { action: 'issue_if_missing', label: 'workspace' },
    }, new Date(NOW.getTime() - 60 * 60 * 1000))
    if (expired.status !== 'credential_issued') throw new Error(expired.status)
    const expiredCall = await call(expired.credential.raw, {
      receipt_id: expired.receipt.id,
      challenge: expired.verification.challenge,
    })
    expect(expiredCall.response.status).toBe(410)
    expect(expiredCall.body).toMatchObject({ error: { message: 'challenge_expired' } })

    const replayed = await provisionAgentConnection(env, OWNER, {
      requestId: 'mcp-replay',
      target: {
        kind: 'new',
        homeSquadId: 'squad-home',
        agent: { slug: 'replay-agent', name: 'Replay Agent' },
      },
      additionalAccess: [],
      credential: { action: 'issue_if_missing', label: 'workspace' },
    }, NOW)
    if (replayed.status !== 'credential_issued') throw new Error(replayed.status)
    const first = await call(replayed.credential.raw, {
      receipt_id: replayed.receipt.id,
      challenge: replayed.verification.challenge,
    })
    expect(first.response.status).toBe(200)
    const replay = await call(replayed.credential.raw, {
      receipt_id: replayed.receipt.id,
      challenge: 'unused-after-success',
    })
    expect(replay.response.status).toBe(200)
    expect(replay.body).toMatchObject({
      result: { structuredContent: { status: 'messaging_verified', replay: true } },
    })
  })
})
