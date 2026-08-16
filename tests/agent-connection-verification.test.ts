import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  provisionAgentConnection,
  type AgentConnectionIssued,
} from '../src/members/agent-connection'
import {
  verifyAgentConnection,
  type AgentConnectionVerificationDeps,
  type AgentConnectionVerificationPrincipal,
} from '../src/members/agent-connection-verification'
import { deleteAgentConnectionMessage } from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const NOW = new Date('2026-07-24T12:00:00.000Z')
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

function connectionInput(requestId: string) {
  return {
    requestId,
    target: {
      kind: 'new' as const,
      homeSquadId: 'squad-home',
      agent: { slug: `agent-${requestId}`, name: `Agent ${requestId}` },
    },
    additionalAccess: [],
    credential: {
      action: 'issue_if_missing' as const,
      label: 'workspace',
      homeCapability: 'member' as const,
    },
  }
}

function principal(issued: AgentConnectionIssued): AgentConnectionVerificationPrincipal {
  return {
    tenant: TENANT,
    tokenId: issued.credential.tokenId,
    memberId: issued.receipt.member_id,
    agentId: issued.receipt.agent_id,
  }
}

describe('agent connection verification service', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
      // mupot#987: provisionAgentConnection stores the raw credential behind a
      // one-time SESSIONS-KV claim (src/auth/credential-claim.ts).
      SESSIONS: (() => {
        const store = new Map<string, string>()
        return {
          async get(key: string) { return store.get(key) ?? null },
          async put(key: string, value: string) { store.set(key, value) },
          async delete(key: string) { store.delete(key) },
        }
      })(),
    } as unknown as Env
  })

  afterEach(() => harness.close())

  async function issue(requestId: string): Promise<AgentConnectionIssued> {
    const outcome = await provisionAgentConnection(env, OWNER, connectionInput(requestId), NOW)
    if (outcome.status !== 'credential_issued') throw new Error(outcome.status)
    return outcome
  }

  it('orients, sends a deterministic self-request, peeks, cleans up, commits pass, and replays', async () => {
    const issued = await issue('success')
    const outcome = await verifyAgentConnection(
      env,
      principal(issued),
      {
        receiptId: issued.receipt.id,
        challenge: issued.verification.challenge,
      },
      new Date('2026-07-24T12:05:00.000Z'),
    )

    expect(outcome).toMatchObject({
      status: 'messaging_verified',
      receiptId: issued.receipt.id,
      replay: false,
      checks: {
        challenge: { status: 'pass' },
        orient: { status: 'pass' },
        send: { status: 'pass' },
        inbox_peek: { status: 'pass' },
        cleanup: { status: 'pass' },
      },
    })
    const requestId = `agent-connection:${issued.receipt.id}`
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?',
    ).get(requestId)).toEqual({ n: 0 })
    expect(harness.sqlite.prepare(
      `SELECT verification_status, verification_challenge_hash,
              verification_message_id, verification_request_id,
              verification_attempts
         FROM agent_connection_receipts WHERE id = ?`,
    ).get(issued.receipt.id)).toMatchObject({
      verification_status: 'pass',
      verification_challenge_hash: null,
      verification_request_id: requestId,
      verification_attempts: 0,
    })
    expect(harness.sqlite.prepare(
      'SELECT status FROM agent_connection_requests WHERE receipt_id = ?',
    ).get(issued.receipt.id)).toEqual({ status: 'messaging_verified' })

    const replay = await verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: 'not-used-after-pass' },
      new Date('2026-07-24T12:06:00.000Z'),
    )
    expect(replay).toMatchObject({
      status: 'messaging_verified',
      receiptId: issued.receipt.id,
      replay: true,
      messageId: outcome.status === 'messaging_verified' ? outcome.messageId : '',
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?',
    ).get(requestId)).toEqual({ n: 0 })
  })

  it('collapses wrong tenant, token, member, and agent without consuming attempts', async () => {
    const issued = await issue('identity')
    const base = principal(issued)
    for (const wrong of [
      { ...base, tenant: 'tenant-b' },
      { ...base, tokenId: 'another-token' },
      { ...base, memberId: 'another-member' },
      { ...base, agentId: 'another-agent' },
    ]) {
      await expect(verifyAgentConnection(
        env,
        wrong,
        { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
        new Date('2026-07-24T12:05:00.000Z'),
      )).resolves.toEqual({
        status: 'verification_incomplete',
        error: 'verification_not_found',
        retryable: false,
      })
    }
    expect(harness.sqlite.prepare(
      'SELECT verification_attempts FROM agent_connection_receipts WHERE id = ?',
    ).get(issued.receipt.id)).toEqual({ verification_attempts: 0 })
  })

  it('keeps four challenge mismatches retryable and terminally fails the fifth', async () => {
    const issued = await issue('attempts')
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const outcome = await verifyAgentConnection(
        env,
        principal(issued),
        { receiptId: issued.receipt.id, challenge: `wrong-${attempt}` },
        new Date('2026-07-24T12:05:00.000Z'),
      )
      expect(outcome).toEqual({
        status: 'verification_incomplete',
        error: attempt < 5 ? 'challenge_mismatch' : 'challenge_exhausted',
        retryable: attempt < 5,
      })
    }
    expect(harness.sqlite.prepare(
      `SELECT verification_status, verification_attempts,
              verification_challenge_hash, verification_error_code
         FROM agent_connection_receipts WHERE id = ?`,
    ).get(issued.receipt.id)).toEqual({
      verification_status: 'fail',
      verification_attempts: 5,
      verification_challenge_hash: null,
      verification_error_code: 'challenge_mismatch',
    })
    expect(harness.sqlite.prepare(
      'SELECT status, error_code FROM agent_connection_requests WHERE receipt_id = ?',
    ).get(issued.receipt.id)).toEqual({
      status: 'failed',
      error_code: 'challenge_mismatch',
    })
  })

  it('expires the challenge terminally without attempting messaging', async () => {
    const issued = await issue('expired')
    const outcome = await verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
      new Date('2026-07-24T12:16:00.000Z'),
    )
    expect(outcome).toEqual({
      status: 'verification_incomplete',
      error: 'challenge_expired',
      retryable: false,
    })
    expect(harness.sqlite.prepare(
      `SELECT verification_status, verification_challenge_hash
         FROM agent_connection_receipts WHERE id = ?`,
    ).get(issued.receipt.id)).toEqual({
      verification_status: 'expired',
      verification_challenge_hash: null,
    })
  })

  it('receipts a transient send failure and retries with the same challenge', async () => {
    const issued = await issue('retry-send')
    const deps: Partial<AgentConnectionVerificationDeps> = {
      sendAgentMessage: async () => ({ ok: false, reason: 'db_error' }),
    }
    const failed = await verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
      new Date('2026-07-24T12:05:00.000Z'),
      deps,
    )
    expect(failed).toEqual({
      status: 'verification_incomplete',
      error: 'send_failed',
      retryable: true,
    })
    const pending = harness.sqlite.prepare(
      `SELECT verification_status, client_connected_at,
              verification_challenge_hash, verification_error_code, checks_json
         FROM agent_connection_receipts WHERE id = ?`,
    ).get(issued.receipt.id) as Record<string, unknown>
    expect(pending.verification_status).toBe('pending')
    expect(pending.client_connected_at).not.toBeNull()
    expect(pending.verification_challenge_hash).not.toBeNull()
    expect(pending.verification_error_code).toBe('send_failed')
    expect(JSON.parse(String(pending.checks_json))).toMatchObject({
      challenge: { status: 'pass' },
      orient: { status: 'pass' },
      send: { status: 'fail', error: 'send_failed' },
    })
    expect(harness.sqlite.prepare(
      'SELECT status FROM agent_connection_requests WHERE receipt_id = ?',
    ).get(issued.receipt.id)).toEqual({ status: 'client_connected' })

    await expect(verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
      new Date('2026-07-24T12:06:00.000Z'),
    )).resolves.toMatchObject({ status: 'messaging_verified', replay: false })
  })

  it('reuses the deterministic send after a cleanup failure and then passes', async () => {
    const issued = await issue('retry-cleanup')
    let cleanupCalls = 0
    const deps: Partial<AgentConnectionVerificationDeps> = {
      deleteAgentConnectionMessage: async (...args) => {
        cleanupCalls += 1
        if (cleanupCalls === 1) return { ok: false, reason: 'db_error' }
        return deleteAgentConnectionMessage(...args)
      },
    }
    const first = await verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
      new Date('2026-07-24T12:05:00.000Z'),
      deps,
    )
    expect(first).toEqual({
      status: 'verification_incomplete',
      error: 'cleanup_failed',
      retryable: true,
    })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?',
    ).get(`agent-connection:${issued.receipt.id}`)).toEqual({ n: 1 })

    const second = await verifyAgentConnection(
      env,
      principal(issued),
      { receiptId: issued.receipt.id, challenge: issued.verification.challenge },
      new Date('2026-07-24T12:06:00.000Z'),
      deps,
    )
    expect(second).toMatchObject({ status: 'messaging_verified', replay: false })
    expect(cleanupCalls).toBe(2)
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?',
    ).get(`agent-connection:${issued.receipt.id}`)).toEqual({ n: 0 })
  })
})
