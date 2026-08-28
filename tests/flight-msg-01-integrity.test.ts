// tests/flight-msg-01-integrity.test.ts — FLIGHT MSG-01 / #1043 & #1046
//
// Fleet Message Integrity, Truncation Detection & Honest Error Boundaries.
// Real SQLite D1 migration chain schema.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import { sendAgentMessage, readAgentInbox, leaseAgentInbox } from '../src/agents/messages'
import { sha256Hex } from '../src/lib/crypto'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const DEPT_ID = 'dept-eng'
const SQUAD_A_ID = 'squad-hadi-mac'
const SQUAD_B_ID = 'squad-core'

const DARA_AGENT_ID = 'agent-dara'
const DARA_MEMBER_ID = 'member-dara'
const KASRA_AGENT_ID = 'agent-kasra'
const KASRA_MEMBER_ID = 'member-kasra'
const GHOST_INACTIVE_ID = 'agent-ghost-inactive'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

function seedData(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'eng', 'Engineering');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${SQUAD_A_ID}', '${DEPT_ID}', 'hadi-mac', 'Hadi Mac'),
      ('${SQUAD_B_ID}', '${DEPT_ID}', 'squad-core', 'Core Platform');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES
      ('${DARA_AGENT_ID}', '${SQUAD_A_ID}', 'dara', 'Dara', 'active'),
      ('${KASRA_AGENT_ID}', '${SQUAD_B_ID}', 'kasra', 'Kasra', 'active'),
      ('${GHOST_INACTIVE_ID}', '${SQUAD_A_ID}', 'ghost', 'Ghost', 'inactive');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${DARA_MEMBER_ID}', 'Dara Member', 'active', '${TENANT}'),
      ('${KASRA_MEMBER_ID}', 'Kasra Member', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${DARA_AGENT_ID}', '${DARA_MEMBER_ID}', '2026-08-20T00:00:00Z'),
      ('${TENANT}', '${KASRA_AGENT_ID}', '${KASRA_MEMBER_ID}', '2026-08-20T00:00:00Z');

    -- Dara only has capability on squad-hadi-mac (no access to squad-core)
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-dara-squad-a', '${DARA_MEMBER_ID}', 'squad', '${SQUAD_A_ID}', 'member'),
      ('cap-kasra-squad-b', '${KASRA_MEMBER_ID}', 'squad', '${SQUAD_B_ID}', 'admin');

    -- Memberships
    INSERT INTO memberships (id, agent_id, squad_id, capability)
    VALUES
      ('mem-dara-a', '${DARA_AGENT_ID}', '${SQUAD_A_ID}', 'member'),
      ('mem-kasra-b', '${KASRA_AGENT_ID}', '${SQUAD_B_ID}', 'admin');
  `)
}

function daraAuth(options: { withCoreObserver?: boolean } = {}): AuthContext {
  const capabilities = [
    {
      member_id: DARA_MEMBER_ID,
      scope_type: 'squad' as const,
      scope_id: SQUAD_A_ID,
      capability: 'member' as const,
    },
  ]
  if (options.withCoreObserver) {
    capabilities.push({
      member_id: DARA_MEMBER_ID,
      scope_type: 'squad' as const,
      scope_id: SQUAD_B_ID,
      capability: 'observer' as const,
    })
  }

  return {
    userId: DARA_MEMBER_ID,
    memberId: DARA_MEMBER_ID,
    email: 'dara@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: DARA_AGENT_ID,
    capabilities,
  }
}

function kasraAuth(): AuthContext {
  return {
    userId: KASRA_MEMBER_ID,
    memberId: KASRA_MEMBER_ID,
    email: 'kasra@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: KASRA_AGENT_ID,
    capabilities: [
      {
        member_id: KASRA_MEMBER_ID,
        scope_type: 'squad' as const,
        scope_id: SQUAD_B_ID,
        capability: 'admin' as const,
      },
    ],
  }
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedData(harness.sqlite)
  env = {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    BUS: { send: async () => {}, emit: async () => {} },
  } as unknown as Env
})

afterEach(() => {
  harness.sqlite.close()
})

describe('FLIGHT MSG-01 / #1046 — Message Integrity & Truncation Detection', () => {
  it('send returns deterministic body_length and sha256 checksum', async () => {
    const testBody = 'FIRST LINE: Decisions reversed.\nExplanation of reversal with full payload details.'
    const expectedSha256 = await sha256Hex(testBody)

    const result = await invokeTool(
      daraAuth({ withCoreObserver: true }),
      env,
      'send',
      { to: KASRA_AGENT_ID, body: testBody },
      'https://pot.test',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result).toMatchObject({
      to: KASRA_AGENT_ID,
      body_length: testBody.length,
      checksum_sha256: expectedSha256,
    })
  })

  it('inbox delivery returns intact verification and matching checksums', async () => {
    const testBody = 'Full unbroken instruction payload from Dara to Kasra'
    const expectedSha256 = await sha256Hex(testBody)

    await invokeTool(
      daraAuth({ withCoreObserver: true }),
      env,
      'send',
      { to: KASRA_AGENT_ID, body: testBody },
      'https://pot.test',
    )

    // Kasra consumes inbox
    const inboxRes = await invokeTool(
      kasraAuth(),
      env,
      'inbox',
      {},
      'https://pot.test',
    )

    expect(inboxRes.ok).toBe(true)
    if (!inboxRes.ok) return
    const messages = (inboxRes.result as { messages: Array<{ body: string; body_length: number; checksum_sha256: string; is_intact: boolean }> }).messages
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe(testBody)
    expect(messages[0].body_length).toBe(testBody.length)
    expect(messages[0].checksum_sha256).toBe(expectedSha256)
    expect(messages[0].is_intact).toBe(true)
  })

  it('inbox_lease and dead-letters return payload verification metadata', async () => {
    const testBody = 'Leased task payload for kasra'
    const expectedSha256 = await sha256Hex(testBody)

    await invokeTool(
      daraAuth({ withCoreObserver: true }),
      env,
      'send',
      { to: KASRA_AGENT_ID, body: testBody },
      'https://pot.test',
    )

    const leaseRes = await invokeTool(
      kasraAuth(),
      env,
      'inbox_lease',
      { lease_seconds: 60 },
      'https://pot.test',
    )

    expect(leaseRes.ok).toBe(true)
    if (!leaseRes.ok) return
    const messages = (leaseRes.result as { messages: Array<{ body: string; body_length: number; checksum_sha256: string; is_intact: boolean }> }).messages
    expect(messages).toHaveLength(1)
    expect(messages[0].body_length).toBe(testBody.length)
    expect(messages[0].checksum_sha256).toBe(expectedSha256)
    expect(messages[0].is_intact).toBe(true)
  })
})

describe('FLIGHT MSG-01 / #1043 — Honest Error Boundaries & No Fake Session Expired Errors', () => {
  it('send to non-visible cross-squad target returns send_target_not_visible (404), never transport session expired', async () => {
    // Dara has NO observer capability on squad-core -> sending to kasra fails with send_target_not_visible
    const result = await invokeTool(
      daraAuth({ withCoreObserver: false }),
      env,
      'send',
      { to: KASRA_AGENT_ID, body: 'Hello Kasra' },
      'https://pot.test',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('send_target_not_visible')
  })

  it('send to inactive/retired agent returns target_agent_inactive (409)', async () => {
    const result = await invokeTool(
      daraAuth({ withCoreObserver: false }),
      env,
      'send',
      { to: GHOST_INACTIVE_ID, body: 'Hello Ghost' },
      'https://pot.test',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('target_agent_inactive')
  })

  it('unauthenticated or unbound sender gets honest error codes (not_agent_bound, unauthenticated)', async () => {
    const unboundAuth: AuthContext = {
      ...daraAuth(),
      boundAgentId: null,
    }

    const unboundResult = await invokeTool(
      unboundAuth,
      env,
      'send',
      { to: KASRA_AGENT_ID, body: 'Hi' },
      'https://pot.test',
    )

    expect(unboundResult.ok).toBe(false)
    if (unboundResult.ok) return
    expect(unboundResult.status).toBe(403)
    expect(unboundResult.error).toBe('not_agent_bound')
  })
})
