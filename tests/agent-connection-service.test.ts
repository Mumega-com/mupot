import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  provisionAgentConnection,
  sweepAgentConnectionRetention,
} from '../src/members/agent-connection'
import { mcpApp } from '../src/mcp'
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
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-home', 'dept-1', 'home', 'Home'),
      ('squad-extra', 'dept-1', 'extra', 'Extra');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-24T00:00:00.000Z');
  `)
}

function seedExisting(
  sqlite: SqliteD1Harness['sqlite'],
  options: { bound?: boolean; token?: boolean } = {},
): void {
  sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-existing', 'squad-home', 'existing', 'Existing', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-existing', 'agent-existing', 'squad-home', 'member');
  `)
  if (options.bound) {
    sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('member-existing', 'Existing', 'active', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-existing', 'member-existing', '2026-07-24T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-existing', 'member-existing', 'squad', 'squad-home', 'member');
    `)
  }
  if (options.token) {
    sqlite.exec(`
      INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES
        ('token-existing', 'member-existing', '${'a'.repeat(64)}', 'old', 'workspace',
         '2026-07-24T00:00:00.000Z', 'agent-existing', '${TENANT}');
    `)
  }
}

function newInput(
  requestId: string,
  slug = 'New-Agent',
): Parameters<typeof provisionAgentConnection>[2] {
  return {
    requestId,
    target: {
      kind: 'new',
      homeSquadId: 'squad-home',
      agent: { slug, name: slug.replace('-', ' ') },
    },
    additionalAccess: [{ squadId: 'squad-extra', capability: 'lead' }],
    credential: {
      action: 'issue_if_missing',
      label: 'workspace',
      homeCapability: 'member',
    },
  }
}

function existingInput(
  requestId: string,
  action: 'issue_if_missing' | 'add' | 'replace' = 'issue_if_missing',
): Parameters<typeof provisionAgentConnection>[2] {
  return {
    requestId,
    target: { kind: 'existing', agentRef: 'agent-existing' },
    additionalAccess: [],
    credential: {
      action,
      label: 'workspace',
      homeCapability: 'member',
      ...(action === 'replace' ? { replaceTokenId: 'token-existing' } : {}),
    },
  }
}

function count(sqlite: SqliteD1Harness['sqlite'], table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function insertRetentionReceipt(
  sqlite: SqliteD1Harness['sqlite'],
  tenant: string,
  suffix: string,
  createdAt: string,
): void {
  const fingerprint = suffix.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a')
  sqlite.prepare(
    `INSERT INTO agent_connection_requests
      (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
       agent_mode, credential_action, status, created_at, updated_at, expires_at)
     VALUES (?, 'user', ?, ?, ?, ?, 'existing', 'add', 'pending', ?, ?, ?)`,
  ).run(
    tenant,
    `actor-${suffix}`,
    `request-${suffix}`,
    fingerprint,
    `agent:${suffix}`,
    createdAt,
    createdAt,
    '2027-07-24T00:00:00.000Z',
  )
  sqlite.prepare(
    `INSERT INTO agent_connection_receipts
      (id, tenant, actor_kind, actor_id, request_id, request_fingerprint,
       agent_id, agent_slug, agent_status_at_issue, member_id, token_id,
       agent_disposition, credential_action, home_squad_id, home_capability,
       additional_access_json, token_label, endpoint, transport,
       verification_status, checks_json, credential_issued_at, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'active', ?, ?, 'reused', 'add',
             'squad-home', 'member', '[]', 'test', 'https://pot.example/mcp',
             'streamable_http', 'pass', '{}', ?, ?, ?)`,
  ).run(
    `receipt-${suffix}`,
    tenant,
    `actor-${suffix}`,
    `request-${suffix}`,
    fingerprint,
    `agent-${suffix}`,
    `agent-${suffix}`,
    `member-${suffix}`,
    `token-${suffix}`,
    createdAt,
    createdAt,
    createdAt,
  )
  sqlite.prepare(
    `UPDATE agent_connection_requests
        SET status = 'credential_issued', finalized_at = ?
      WHERE tenant = ? AND actor_id = ? AND request_id = ?`,
  ).run(createdAt, tenant, `actor-${suffix}`, `request-${suffix}`)
}

describe('agent connection provisioning', () => {
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
    } as Env
  })

  afterEach(() => harness.close())

  it('atomically provisions a new agent, canonical identity, access, token, and receipt', async () => {
    const result = await provisionAgentConnection(env, OWNER, newInput('request-1'), NOW)

    expect(result).toMatchObject({
      status: 'credential_issued',
      credential: { shownOnce: true },
      endpoint: 'https://pot.example/mcp',
      receipt: {
        agent_slug: 'new-agent',
        home_squad_id: 'squad-home',
        verification_status: 'pending',
      },
    })
    expect((result as { credential: { raw: string } }).credential.raw).toMatch(/^mupot_/)
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_member_bindings').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM member_tokens').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_connection_receipts').get()).toEqual({ n: 1 })
  })

  it('creates a canonical identity for an existing unminted agent', async () => {
    seedExisting(harness.sqlite)
    const result = await provisionAgentConnection(env, OWNER, existingInput('existing-first'), NOW)
    expect(result).toMatchObject({
      status: 'credential_issued',
      receipt: { agent_disposition: 'reused', agent_id: 'agent-existing' },
    })
    expect(count(harness.sqlite, 'agents')).toBe(1)
    expect(count(harness.sqlite, 'agent_member_bindings')).toBe(1)
    expect(count(harness.sqlite, 'member_tokens')).toBe(1)
  })

  it('authorizes every affected squad before creating a reservation', async () => {
    const homeLead = {
      kind: 'member' as const,
      id: 'member-lead',
      grants: [{
        member_id: 'member-lead',
        scope_type: 'squad' as const,
        scope_id: 'squad-home',
        capability: 'lead' as const,
      }],
    }
    await expect(
      provisionAgentConnection(env, homeLead, newInput('denied-home'), NOW),
    ).resolves.toMatchObject({
      status: 'error',
      error: 'forbidden',
      details: { need: 'admin', squad_id: 'squad-home' },
    })

    const homeAdmin = {
      ...homeLead,
      grants: [{
        ...homeLead.grants[0],
        capability: 'admin' as const,
      }],
    }
    await expect(
      provisionAgentConnection(env, homeAdmin, newInput('denied-extra'), NOW),
    ).resolves.toMatchObject({
      status: 'error',
      error: 'forbidden',
      details: { need: 'admin', squad_id: 'squad-extra' },
    })
    expect(count(harness.sqlite, 'agent_connection_requests')).toBe(0)
    expect(count(harness.sqlite, 'agents')).toBe(0)
  })

  it('issue_if_missing refuses a bound agent without minting another token', async () => {
    seedExisting(harness.sqlite, { bound: true, token: true })
    await expect(
      provisionAgentConnection(env, OWNER, existingInput('already'), NOW),
    ).resolves.toEqual({ status: 'error', error: 'agent_already_connected' })
    expect(count(harness.sqlite, 'member_tokens')).toBe(1)
    expect(harness.sqlite.prepare(
      `SELECT status, error_code FROM agent_connection_requests WHERE request_id = 'already'`,
    ).get()).toEqual({ status: 'failed', error_code: 'agent_already_connected' })
  })

  it('adds a token on the same immutable member identity', async () => {
    seedExisting(harness.sqlite, { bound: true, token: true })
    const result = await provisionAgentConnection(env, OWNER, existingInput('add', 'add'), NOW)
    expect(result).toMatchObject({
      status: 'credential_issued',
      receipt: { member_id: 'member-existing', credential_action: 'add' },
    })
    expect(count(harness.sqlite, 'members')).toBe(1)
    expect(count(harness.sqlite, 'agent_member_bindings')).toBe(1)
    expect(count(harness.sqlite, 'member_tokens')).toBe(2)
  })

  it('refuses add or replace when no canonical identity exists', async () => {
    seedExisting(harness.sqlite)
    for (const action of ['add', 'replace'] as const) {
      await expect(
        provisionAgentConnection(env, OWNER, existingInput(`unminted-${action}`, action), NOW),
      ).resolves.toEqual({ status: 'error', error: 'agent_identity_unminted' })
    }
    expect(count(harness.sqlite, 'members')).toBe(0)
    expect(count(harness.sqlite, 'member_tokens')).toBe(0)
  })

  it('replaces exactly the selected live token in the provisioning batch', async () => {
    seedExisting(harness.sqlite, { bound: true, token: true })
    const result = await provisionAgentConnection(env, OWNER, existingInput('replace', 'replace'), NOW)
    expect(result).toMatchObject({
      status: 'credential_issued',
      receipt: { credential_action: 'replace', member_id: 'member-existing' },
    })
    const tokens = harness.sqlite.prepare(
      'SELECT id, revoked_at FROM member_tokens ORDER BY created_at, id',
    ).all() as Array<{ id: string; revoked_at: string | null }>
    expect(tokens).toHaveLength(2)
    expect(tokens.find((row) => row.id === 'token-existing')?.revoked_at).toBe(NOW.toISOString())
    expect(tokens.filter((row) => row.revoked_at === null)).toHaveLength(1)
  })

  it('replays a committed request without returning raw token or challenge', async () => {
    const input = newInput('lost-response')
    const issued = await provisionAgentConnection(env, OWNER, input, NOW)
    expect(issued.status).toBe('credential_issued')
    const replay = await provisionAgentConnection(env, OWNER, input, NOW)
    expect(replay).toMatchObject({
      status: 'credential_already_issued',
      receipt: { request_id: 'lost-response' },
    })
    expect(replay).not.toHaveProperty('credential')
    expect(replay).not.toHaveProperty('verification')
    expect(count(harness.sqlite, 'member_tokens')).toBe(1)

    harness.sqlite.prepare(
      `UPDATE agent_connection_requests
          SET status = 'messaging_verified'
        WHERE request_id = 'lost-response'`,
    ).run()
    await expect(
      provisionAgentConnection(env, OWNER, input, NOW),
    ).resolves.toMatchObject({ status: 'credential_already_issued' })
    expect(count(harness.sqlite, 'member_tokens')).toBe(1)
  })

  it('scopes request IDs to actor and rejects only same-actor fingerprint reuse', async () => {
    const first = await provisionAgentConnection(env, OWNER, newInput('shared', 'agent-one'), NOW)
    expect(first.status).toBe('credential_issued')
    await expect(
      provisionAgentConnection(env, OWNER, {
        ...newInput('shared', 'agent-one'),
        credential: { ...newInput('shared').credential, label: 'different' },
      }, NOW),
    ).resolves.toEqual({ status: 'error', error: 'request_id_conflict' })

    const secondActor = { ...OWNER, id: 'owner-2' }
    const second = await provisionAgentConnection(
      env,
      secondActor,
      newInput('shared', 'agent-two'),
      NOW,
    )
    expect(second.status).toBe('credential_issued')
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_connection_requests WHERE request_id = 'shared'`,
    ).get()).toEqual({ n: 2 })
  })

  it('returns in_progress for an identical concurrent actor-scoped request', async () => {
    const input = newInput('concurrent-same')
    const [a, b] = await Promise.all([
      provisionAgentConnection(env, OWNER, input, NOW),
      provisionAgentConnection(env, OWNER, input, NOW),
    ])
    expect([a.status, b.status].sort()).toEqual(['credential_issued', 'in_progress'])
    expect(count(harness.sqlite, 'member_tokens')).toBe(1)
  })

  it('hides another actor request identity when one target is already reserved', async () => {
    seedExisting(harness.sqlite)
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, created_at, updated_at, expires_at)
       VALUES (?, 'user', 'other-owner', 'secret-request', ?, 'agent:agent-existing',
               'existing', 'add', 'pending', ?, ?, ?)`,
    ).run(
      TENANT,
      'a'.repeat(64),
      NOW.toISOString(),
      NOW.toISOString(),
      '2026-07-25T12:00:00.000Z',
    )
    const result = await provisionAgentConnection(env, OWNER, existingInput('mine'), NOW)
    expect(result).toEqual({ status: 'error', error: 'agent_setup_in_progress' })
    expect(JSON.stringify(result)).not.toContain('secret-request')
    expect(JSON.stringify(result)).not.toContain('other-owner')
  })

  it('expires a stale target reservation before taking a new one', async () => {
    seedExisting(harness.sqlite)
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, created_at, updated_at, expires_at)
       VALUES (?, 'user', 'old-owner', 'old', ?, 'agent:agent-existing',
               'existing', 'issue_if_missing', 'pending', ?, ?, ?)`,
    ).run(
      TENANT,
      'b'.repeat(64),
      '2026-07-22T00:00:00.000Z',
      '2026-07-22T00:00:00.000Z',
      NOW.toISOString(),
    )
    const result = await provisionAgentConnection(env, OWNER, existingInput('fresh'), NOW)
    expect(result.status).toBe('credential_issued')
    expect(harness.sqlite.prepare(
      `SELECT status, error_code FROM agent_connection_requests WHERE request_id = 'old'`,
    ).get()).toEqual({ status: 'expired', error_code: 'reservation_expired' })
  })

  it('rolls back all provisioned rows and terminally fails the reservation', async () => {
    harness.sqlite.exec(`
      CREATE TRIGGER injected_receipt_failure
      BEFORE INSERT ON agent_connection_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected_receipt_failure');
      END;
    `)
    const result = await provisionAgentConnection(env, OWNER, newInput('rollback'), NOW)
    expect(result).toEqual({ status: 'error', error: 'provisioning_failed' })
    expect(count(harness.sqlite, 'agents')).toBe(0)
    expect(count(harness.sqlite, 'members')).toBe(0)
    expect(count(harness.sqlite, 'member_tokens')).toBe(0)
    expect(count(harness.sqlite, 'agent_connection_receipts')).toBe(0)
    expect(harness.sqlite.prepare(
      `SELECT status, error_code FROM agent_connection_requests WHERE request_id = 'rollback'`,
    ).get()).toEqual({ status: 'failed', error_code: 'provisioning_failed' })

    harness.sqlite.exec('DROP TRIGGER injected_receipt_failure')
    await expect(
      provisionAgentConnection(env, OWNER, newInput('rollback'), NOW),
    ).resolves.toEqual({ status: 'error', error: 'provisioning_failed' })
    expect(count(harness.sqlite, 'agents')).toBe(0)
    expect(count(harness.sqlite, 'member_tokens')).toBe(0)
  })

  it('persists no raw credential, token hash, challenge, or reusable config', async () => {
    const result = await provisionAgentConnection(env, OWNER, newInput('secret-check'), NOW)
    if (result.status !== 'credential_issued') throw new Error(result.status)
    const request = harness.sqlite.prepare(
      `SELECT * FROM agent_connection_requests WHERE request_id = 'secret-check'`,
    ).get()
    const receipt = harness.sqlite.prepare(
      `SELECT * FROM agent_connection_receipts WHERE request_id = 'secret-check'`,
    ).get()
    const persisted = JSON.stringify({ request, receipt })
    expect(persisted).not.toContain(result.credential.raw)
    expect(persisted).not.toContain(result.verification.challenge)
    expect(persisted).not.toContain('<MEMBER_TOKEN>')
    expect(Object.keys(receipt as object)).not.toContain('token_hash')
    expect(result.endpoint).toBe('https://pot.example/mcp')
    expect(JSON.stringify(result.configuration)).not.toContain(result.credential.raw)
  })

  it('exposes the same transaction through the authenticated MCP tool', async () => {
    const rawOperatorToken = 'operator-token'
    const operatorHash = createHash('sha256').update(rawOperatorToken).digest('hex')
    harness.sqlite.prepare(
      `INSERT INTO members (id, display_name, status, tenant)
       VALUES ('operator-member', 'Operator', 'active', ?)`,
    ).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('operator-admin', 'operator-member', 'org', NULL, 'admin')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, tenant)
       VALUES ('operator-token-id', 'operator-member', ?, 'operator', 'workspace', ?, ?)`,
    ).run(operatorHash, NOW.toISOString(), TENANT)

    const response = await mcpApp.request(
      'https://malicious-host.example/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rawOperatorToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'provision_agent_connection',
            arguments: {
              request_id: 'mcp-request',
              new_agent: {
                home_squad: 'home',
                slug: 'MCP-Agent',
                name: 'MCP Agent',
              },
              additional_access: [{
                squad: 'extra',
                capability: 'member',
              }],
              credential: {
                action: 'issue_if_missing',
                label: 'Codex',
              },
            },
          },
        }),
      },
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: {
        structuredContent: {
          status: string
          endpoint: string
          credential: { raw: string }
        }
      }
    }
    expect(body.result.structuredContent).toMatchObject({
      status: 'credential_issued',
      endpoint: 'https://pot.example/mcp',
    })
    expect(body.result.structuredContent.credential.raw).toMatch(/^mupot_/)
    expect(JSON.stringify(body)).not.toContain('malicious-host.example')
  })

  it('expires and purges only tenant-scoped lifecycle rows at exact boundaries', async () => {
    const issued = await provisionAgentConnection(env, OWNER, newInput('verify-expiry'), NOW)
    if (issued.status !== 'credential_issued') throw new Error(issued.status)
    harness.sqlite.prepare(
      `UPDATE agent_connection_receipts
          SET verification_expires_at = ?
        WHERE id = ?`,
    ).run(NOW.toISOString(), issued.receipt.id)

    const oldPending = '2026-07-23T12:00:00.000Z'
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, created_at, updated_at, expires_at)
       VALUES (?, 'user', 'pending-owner', 'pending-expiry', ?, 'agent:pending',
               'existing', 'add', 'pending', ?, ?, ?)`,
    ).run(TENANT, 'c'.repeat(64), oldPending, oldPending, NOW.toISOString())

    insertRetentionReceipt(harness.sqlite, TENANT, 'deadbeef', '2025-07-24T12:00:00.000Z')
    insertRetentionReceipt(harness.sqlite, TENANT, 'cafebabe', '2025-07-25T12:00:00.000Z')
    insertRetentionReceipt(harness.sqlite, 'tenant-b', 'facefeed', '2025-07-24T12:00:00.000Z')
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, error_code, created_at, updated_at,
         finalized_at, expires_at)
       VALUES (?, 'user', 'purge-owner', 'purge-30', ?, 'agent:purge-30',
               'existing', 'add', 'failed', 'test', ?, ?, ?, ?)`,
    ).run(
      TENANT,
      'd'.repeat(64),
      '2026-06-24T12:00:00.000Z',
      '2026-06-24T12:00:00.000Z',
      '2026-06-24T12:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    )
    harness.sqlite.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
         agent_mode, credential_action, status, error_code, created_at, updated_at,
         finalized_at, expires_at)
       VALUES (?, 'user', 'keep-owner', 'keep-29', ?, 'agent:keep-29',
               'existing', 'add', 'failed', 'test', ?, ?, ?, ?)`,
    ).run(
      TENANT,
      'e'.repeat(64),
      '2026-06-25T12:00:00.000Z',
      '2026-06-25T12:00:00.000Z',
      '2026-06-25T12:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    )

    const result = await sweepAgentConnectionRetention(env, NOW)
    expect(result).toMatchObject({
      requestsExpired: 1,
      challengesExpired: 1,
      receiptsPurged: 1,
    })
    expect(harness.sqlite.prepare(
      `SELECT verification_status, verification_challenge_hash
         FROM agent_connection_receipts WHERE id = ?`,
    ).get(issued.receipt.id)).toEqual({
      verification_status: 'expired',
      verification_challenge_hash: null,
    })
    expect(harness.sqlite.prepare(
      `SELECT id FROM agent_connection_receipts WHERE id = 'receipt-deadbeef'`,
    ).get()).toBeUndefined()
    expect(harness.sqlite.prepare(
      `SELECT id FROM agent_connection_receipts WHERE id = 'receipt-cafebabe'`,
    ).get()).toEqual({ id: 'receipt-cafebabe' })
    expect(harness.sqlite.prepare(
      `SELECT id FROM agent_connection_receipts WHERE id = 'receipt-facefeed'`,
    ).get()).toEqual({ id: 'receipt-facefeed' })
    expect(harness.sqlite.prepare(
      `SELECT request_id FROM agent_connection_requests WHERE request_id = 'purge-30'`,
    ).get()).toBeUndefined()
    expect(harness.sqlite.prepare(
      `SELECT request_id FROM agent_connection_requests WHERE request_id = 'keep-29'`,
    ).get()).toEqual({ request_id: 'keep-29' })
  })
})
