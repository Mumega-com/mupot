import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteAgentConnectionMessage } from '../src/agents/messages'
import { dashboardApp } from '../src/dashboard'
import { mcpApp } from '../src/mcp'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const OPERATOR_RAW = 'operator-agent-connection-key'

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

interface RpcSuccess<T> {
  result: {
    structuredContent: T
  }
}

describe('issued agent connection key end-to-end', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-home', 'dept-1', 'home', 'Home'),
        ('squad-extra', 'dept-1', 'extra', 'Extra');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-24T00:00:00.000Z');
      INSERT INTO members (id, display_name, email, status, tenant)
        VALUES ('operator-member', 'Operator', 'operator@example.com', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('operator-admin', 'operator-member', 'org', NULL, 'admin');
      INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, tenant)
        VALUES (
          'operator-token',
          'operator-member',
          '${hash(OPERATOR_RAW)}',
          'operator',
          'workspace',
          '2026-07-24T00:00:00.000Z',
          '${TENANT}'
        );
    `)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
      // Real in-memory KV (not a fixed-response stub) — mupot#987's credential-claim
      // path does get/put/delete against SESSIONS (see src/auth/credential-claim.ts),
      // so the mock needs to actually store what it's given. Any key nothing put()
      // falls back to the same fixed JSON the old stub always returned, preserving
      // whatever pre-existing (untested-by-name) code path relied on that default.
      SESSIONS: (() => {
        const store = new Map<string, string>()
        const fallback = JSON.stringify({
          userId: 'operator-web',
          email: 'operator@example.com',
          role: 'member',
          createdAt: '2026-07-24T00:00:00.000Z',
        })
        return {
          async get(key: string) {
            return store.has(key) ? (store.get(key) as string) : fallback
          },
          async put(key: string, value: string) {
            store.set(key, value)
          },
          async delete(key: string) {
            store.delete(key)
          },
        }
      })(),
    } as unknown as Env
  })

  afterEach(() => harness.close())

  async function rpc<T>(
    rawToken: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ response: Response; body: RpcSuccess<T> }> {
    const response = await mcpApp.request(
      'https://malicious-request-host.invalid/',
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
          params: { name, arguments: args },
        }),
      },
      env,
    )
    return {
      response,
      body: await response.json() as RpcSuccess<T>,
    }
  }

  // mupot#987: provision_agent_connection no longer returns the raw credential —
  // it returns a single-use claim (credential.claim.claim_id). Redeem it through
  // the same bearer that minted it, exactly as a real caller would.
  async function revealClaim(claimId: string): Promise<string> {
    const revealed = await rpc<{ raw: string }>(OPERATOR_RAW, 'reveal_credential_claim', {
      claim_id: claimId,
    })
    expect(revealed.response.status).toBe(200)
    return revealed.body.result.structuredContent.raw
  }

  it('provisions once, reconnects, proves public messaging, verifies, and polls', async () => {
    const provisioned = await rpc<{
      status: string
      credential: { claim: { claim_id: string; fingerprint: string; expires_at: string }; tokenId: string; shownOnce: boolean }
      verification: { receiptId: string; challenge: string; expiresAt: string }
      endpoint: string
      configuration: { claudeCode: string; codex: string; cursor: string }
      receipt: {
        id: string
        agent_id: string
        member_id: string
        token_id: string
      }
    }>(OPERATOR_RAW, 'provision_agent_connection', {
      request_id: 'e2e-issued-key',
      new_agent: {
        home_squad: 'home',
        slug: 'e2e-agent',
        name: 'E2E Agent',
      },
      additional_access: [{
        squad: 'extra',
        capability: 'member',
      }],
      credential: {
        action: 'issue_if_missing',
        label: 'Codex',
        home_capability: 'member',
      },
    })
    expect(provisioned.response.status).toBe(200)
    const connection = provisioned.body.result.structuredContent
    expect(connection.status).toBe('credential_issued')
    expect(connection.endpoint).toBe('https://pot.example/mcp')
    // The structural proof for #987: no raw secret anywhere in this tool result.
    expect(JSON.stringify(provisioned.body)).not.toMatch(/"raw"\s*:/)
    expect(connection.credential.claim.claim_id).toBeTruthy()
    expect(connection.credential.claim.fingerprint).toMatch(/^[0-9a-f]{16}$/)

    const rawToken = await revealClaim(connection.credential.claim.claim_id)
    expect(rawToken).toMatch(/^mupot_/)
    for (const config of Object.values(connection.configuration)) {
      expect(config).toContain('https://pot.example/mcp')
      expect(config).not.toContain('malicious-request-host.invalid')
      expect(config).not.toContain(rawToken)
    }

    // A second reveal of the SAME claim must fail — single-use, burned on first read.
    const secondReveal = await rpc<Record<string, unknown>>(OPERATOR_RAW, 'reveal_credential_claim', {
      claim_id: connection.credential.claim.claim_id,
    })
    expect(secondReveal.response.status).toBe(410)
    expect(JSON.stringify(secondReveal.body)).toContain('claim_not_found_or_consumed')

    const boot = await rpc<{
      identity_status: string
      bound_agent_id: string
      mcp_endpoint: string
    }>(rawToken, 'boot_context', {})
    expect(boot.response.status).toBe(200)
    expect(boot.body.result.structuredContent).toMatchObject({
      identity_status: 'minted',
      bound_agent_id: connection.receipt.agent_id,
      mcp_endpoint: 'https://pot.example/mcp',
    })

    const oriented = await rpc<{
      packet: { agent: { id: string } }
    }>(rawToken, 'orient', {})
    expect(oriented.response.status).toBe(200)
    expect(oriented.body.result.structuredContent.packet.agent.id)
      .toBe(connection.receipt.agent_id)

    const sent = await rpc<{
      id: string
      to: string
      duplicate: boolean
    }>(rawToken, 'send', {
      to: connection.receipt.agent_id,
      body: 'Public messaging surface proof',
      kind: 'request',
      request_id: 'e2e-public-loopback',
    })
    expect(sent.response.status).toBe(200)
    expect(sent.body.result.structuredContent).toMatchObject({
      to: connection.receipt.agent_id,
      duplicate: false,
    })
    const publicMessageId = sent.body.result.structuredContent.id

    const inbox = await rpc<{
      messages: Array<{ id: string; request_id: string }>
      consumed: boolean
    }>(rawToken, 'inbox', { peek: true })
    expect(inbox.response.status).toBe(200)
    expect(inbox.body.result.structuredContent.consumed).toBe(false)
    expect(inbox.body.result.structuredContent.messages).toContainEqual(
      expect.objectContaining({
        id: publicMessageId,
        request_id: 'e2e-public-loopback',
      }),
    )

    await expect(deleteAgentConnectionMessage(env, {
      messageId: publicMessageId,
      agentId: connection.receipt.agent_id,
      requestId: 'e2e-public-loopback',
    })).resolves.toEqual({ ok: true })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE id = ?',
    ).get(publicMessageId)).toEqual({ n: 0 })

    const verified = await rpc<{
      status: string
      receiptId: string
      replay: boolean
    }>(rawToken, 'verify_agent_connection', {
      receipt_id: connection.verification.receiptId,
      challenge: connection.verification.challenge,
    })
    expect(verified.response.status).toBe(200)
    expect(verified.body.result.structuredContent).toMatchObject({
      status: 'messaging_verified',
      receiptId: connection.receipt.id,
      replay: false,
    })

    const status = await dashboardApp.request(
      `https://pot.example/api/agent-connections/${connection.receipt.id}/status`,
      { headers: { Cookie: 'mupot_session=session-1' } },
      env,
    )
    expect(status.status).toBe(200)
    const publicStatus = await status.json() as {
      verification: { status: string }
      current: { token_revoked: boolean }
    }
    expect(publicStatus).toMatchObject({
      verification: { status: 'pass' },
      current: { token_revoked: false },
    })

    const persisted = JSON.stringify({
      request: harness.sqlite.prepare(
        'SELECT * FROM agent_connection_requests WHERE receipt_id = ?',
      ).get(connection.receipt.id),
      receipt: harness.sqlite.prepare(
        'SELECT * FROM agent_connection_receipts WHERE id = ?',
      ).get(connection.receipt.id),
    })
    expect(persisted).not.toContain(rawToken)
    expect(persisted).not.toContain(connection.verification.challenge)
    expect(persisted).not.toContain('Public messaging surface proof')
    expect(persisted).not.toContain('Mupot agent connection verification')
  })

  it('fails closed for a human key, another same-agent key, and another agent key', async () => {
    const first = await rpc<{
      credential: { claim: { claim_id: string } }
      verification: { receiptId: string; challenge: string }
      receipt: { agent_id: string; member_id: string }
    }>(OPERATOR_RAW, 'provision_agent_connection', {
      request_id: 'negative-first',
      new_agent: { home_squad: 'home', slug: 'negative-one', name: 'Negative One' },
      credential: { action: 'issue_if_missing' },
    })
    expect(first.response.status).toBe(200)
    const connection = first.body.result.structuredContent

    const human = await rpc<Record<string, unknown>>(
      OPERATOR_RAW,
      'verify_agent_connection',
      {
        receipt_id: connection.verification.receiptId,
        challenge: connection.verification.challenge,
      },
    )
    expect(human.response.status).toBe(403)
    expect(JSON.stringify(human.body)).toContain('agent_bound_credential_required')

    const sameAgentRaw = 'same-agent-other-key'
    harness.sqlite.prepare(
      `INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('same-agent-other-token', ?, ?, 'other', 'workspace', ?, ?, ?)`,
    ).run(
      connection.receipt.member_id,
      hash(sameAgentRaw),
      new Date().toISOString(),
      connection.receipt.agent_id,
      TENANT,
    )
    const sameAgent = await rpc<Record<string, unknown>>(
      sameAgentRaw,
      'verify_agent_connection',
      {
        receipt_id: connection.verification.receiptId,
        challenge: connection.verification.challenge,
      },
    )
    expect(sameAgent.response.status).toBe(404)
    expect(JSON.stringify(sameAgent.body)).toContain('verification_not_found')

    const second = await rpc<{
      credential: { claim: { claim_id: string } }
    }>(OPERATOR_RAW, 'provision_agent_connection', {
      request_id: 'negative-second',
      new_agent: { home_squad: 'home', slug: 'negative-two', name: 'Negative Two' },
      credential: { action: 'issue_if_missing' },
    })
    expect(second.response.status).toBe(200)
    const secondRawToken = await revealClaim(second.body.result.structuredContent.credential.claim.claim_id)
    const otherAgent = await rpc<Record<string, unknown>>(
      secondRawToken,
      'verify_agent_connection',
      {
        receipt_id: connection.verification.receiptId,
        challenge: connection.verification.challenge,
      },
    )
    expect(otherAgent.response.status).toBe(404)
    const serialized = JSON.stringify(otherAgent.body)
    expect(serialized).toContain('verification_not_found')
    expect(serialized).not.toContain(connection.receipt.agent_id)

    expect(harness.sqlite.prepare(
      'SELECT verification_attempts FROM agent_connection_receipts WHERE id = ?',
    ).get(connection.verification.receiptId)).toEqual({ verification_attempts: 0 })
  })
})
