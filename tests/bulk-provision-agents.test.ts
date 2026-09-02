import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import { revealCredentialClaim } from '../src/auth/credential-claim'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { validateRoster } from '../scripts/lib/bulk-provision-core.mjs'
import { runBulkProvision } from '../scripts/bulk-provision-agents.mjs'

// tests/bulk-provision-agents.test.ts — proves the bulk provisioner
// (scripts/bulk-provision-agents.mjs + scripts/lib/bulk-provision-core.mjs)
// against the REAL migration chain and the REAL MCP tool/capability behavior,
// not a mock of either — same discipline as tests/agent-connection-service.test.ts.
//
// Every call goes through mcpApp.request(...) with a real Bearer token
// resolved against a real member_tokens row, exactly the JSON-RPC seam a real
// MCP client uses. This is what makes "an agent-bound caller is refused" and
// "a duplicate slug is refused" true statements about the SHIPPED gates
// (src/mcp/provision.ts's `operator_principal_required`, src/org/resolve.ts's
// slug-ambiguity handling) rather than about a test double that merely agrees
// with them today.

const TENANT = 'tenant-a'
const NOW = new Date('2026-09-02T00:00:00.000Z')

function seedOrg(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-home', 'dept-1', 'home', 'Home'),
      ('squad-other', 'dept-1', 'other', 'Other');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-09-02T00:00:00.000Z');
  `)
}

/** Insert an unbound OPERATOR member token (org-admin). Returns the raw bearer. */
function seedOperatorToken(sqlite: SqliteD1Harness['sqlite'], memberId = 'operator-1'): string {
  const raw = `operator-token-${memberId}`
  const hash = createHash('sha256').update(raw).digest('hex')
  sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', 'Operator', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('${memberId}-admin', '${memberId}', 'org', NULL, 'admin');
  `)
  sqlite.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
     VALUES (?, ?, ?, 'operator', 'workspace', ?, ?)`,
  ).run(`${memberId}-token`, memberId, hash, NOW.toISOString(), TENANT)
  return raw
}

/** Insert an existing agent + its own AGENT-BOUND token (auth.boundAgentId set). */
function seedAgentBoundToken(sqlite: SqliteD1Harness['sqlite']): string {
  const raw = 'agent-bound-token'
  const hash = createHash('sha256').update(raw).digest('hex')
  sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-x', 'squad-home', 'agent-x', 'Agent X', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-x', 'Agent X', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-x', 'member-x', '2026-09-01T00:00:00.000Z');
  `)
  sqlite.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
     VALUES (?, 'member-x', ?, 'agent-x', 'workspace', ?, 'agent-x', ?)`,
  ).run('agent-x-token', hash, NOW.toISOString(), TENANT)
  return raw
}

function makeMcpCall(env: Env, token: string) {
  let id = 1
  return async function mcpCall(name: string, args: unknown) {
    const response = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
      },
      env,
    )
    const body = await response.json() as {
      error?: { message: string; data?: unknown }
      result?: { structuredContent?: unknown }
    }
    if (body.error) return { ok: false as const, error: body.error.message, detail: body.error.data }
    return { ok: true as const, result: body.result?.structuredContent }
  }
}

function count(sqlite: SqliteD1Harness['sqlite'], table: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

function silentLog() {
  const lines: string[] = []
  return { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')), lines }
}

function memoryReceipts() {
  const records: Record<string, unknown>[] = []
  return { writeReceipt: (_path: string, record: Record<string, unknown>) => { records.push(record) }, records }
}

describe('bulk-provision-agents: roster validation (pure, no DB)', () => {
  it('refuses a roster with the same slug used for two different squads, naming the slug', () => {
    const result = validateRoster({
      agents: [
        { slug: 'dup-agent', name: 'Dup One', squad: 'home' },
        { slug: 'dup-agent', name: 'Dup Two', squad: 'other' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e: string) => e.includes('dup-agent') && e.includes('home') && e.includes('other'))).toBe(true)
  })

  it('refuses a capability above member', () => {
    const result = validateRoster({ agents: [{ slug: 'a', name: 'A', squad: 'home', capability: 'admin' }] })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('observer')
  })

  it('refuses an invalid slug format', () => {
    const result = validateRoster({ agents: [{ slug: 'Not_Valid!', name: 'A', squad: 'home' }] })
    expect(result.ok).toBe(false)
  })

  it('accepts a well-formed roster', () => {
    const result = validateRoster({ agents: [{ slug: 'ok-agent', name: 'OK', squad: 'home' }] })
    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(1)
  })
})

describe('bulk-provision-agents: against the real migration chain', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://pot.example',
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

  it('an agent-bound caller is refused with a clear message, before any roster row is touched', async () => {
    const boundToken = seedAgentBoundToken(harness.sqlite)
    const { log, lines } = silentLog()
    const { writeReceipt } = memoryReceipts()
    const outcome = await runBulkProvision({
      doc: { agents: [{ slug: 'new-agent', name: 'New Agent', squad: 'home' }] },
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall: makeMcpCall(env, boundToken),
      writeReceipt,
      log,
    })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.fatal).toBe('operator_principal_required')
    expect(lines.some((l) => l.includes('AGENT-BOUND'))).toBe(true)
    expect(count(harness.sqlite, 'agents')).toBe(1) // only the pre-seeded agent-x — nothing new created
  })

  it('dry-run touches nothing: zero new agents, members, tokens, or receipts', async () => {
    const rawOperator = seedOperatorToken(harness.sqlite)
    const before = {
      agents: count(harness.sqlite, 'agents'),
      members: count(harness.sqlite, 'members'),
      tokens: count(harness.sqlite, 'member_tokens'),
      receipts: count(harness.sqlite, 'agent_connection_receipts'),
      requests: count(harness.sqlite, 'agent_connection_requests'),
    }
    const { log, lines } = silentLog()
    const { writeReceipt, records } = memoryReceipts()
    const outcome = await runBulkProvision({
      doc: {
        agents: [
          { slug: 'dry-agent-a', name: 'Dry Agent A', squad: 'home' },
          { slug: 'dry-agent-b', name: 'Dry Agent B', squad: 'other', capability: 'observer' },
        ],
      },
      apply: false,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall: makeMcpCall(env, rawOperator),
      writeReceipt,
      log,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.summary.dry_run).toBe(2)
    expect(count(harness.sqlite, 'agents')).toBe(before.agents)
    expect(count(harness.sqlite, 'members')).toBe(before.members)
    expect(count(harness.sqlite, 'member_tokens')).toBe(before.tokens)
    expect(count(harness.sqlite, 'agent_connection_receipts')).toBe(before.receipts)
    expect(count(harness.sqlite, 'agent_connection_requests')).toBe(before.requests)
    expect(records.every((r) => r.status === 'dry_run')).toBe(true)
    expect(lines.some((l) => l.includes('WOULD create_and_mint'))).toBe(true)
  })

  it('provisions for real under --apply, verifies, and never prints or persists a raw token', async () => {
    const rawOperator = seedOperatorToken(harness.sqlite)
    const { log, lines } = silentLog()
    const { writeReceipt, records } = memoryReceipts()
    const mcpCall = makeMcpCall(env, rawOperator)
    const outcome = await runBulkProvision({
      doc: { agents: [{ slug: 'real-agent', name: 'Real Agent', squad: 'home', role: 'member' }] },
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall,
      writeReceipt,
      log,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.summary.created).toBe(1)
    expect(outcome.summary.verified).toBe(1)
    expect(count(harness.sqlite, 'agents')).toBe(1)
    expect(count(harness.sqlite, 'agent_member_bindings')).toBe(1)
    expect(count(harness.sqlite, 'member_tokens')).toBe(2) // operator + the new agent's

    const claimId = records[0].claim_id as string
    expect(typeof claimId).toBe('string')
    // Independently fetch the TRUE raw value (test-only escape hatch) purely to
    // prove it is absent from everything the script emitted.
    const revealed = await revealCredentialClaim(env, claimId, 'operator-1')
    expect(revealed.ok).toBe(true)
    const raw = (revealed as { ok: true; raw: string }).raw
    expect(raw).toMatch(/^mupot_/)
    expect(JSON.stringify(records)).not.toContain(raw)
    expect(lines.join('\n')).not.toContain(raw)
    expect(JSON.stringify(records[0])).not.toMatch(/"raw"\s*:/)
  })

  it('re-running after a partial failure skips what exists and completes the rest', async () => {
    const rawOperator = seedOperatorToken(harness.sqlite)
    const mcpCall = makeMcpCall(env, rawOperator)
    const roster = {
      agents: [
        { slug: 'resume-a', name: 'Resume A', squad: 'home' },
        { slug: 'resume-b', name: 'Resume B', squad: 'home' },
      ],
    }

    // First run: only the first row.
    const run1 = await runBulkProvision({
      doc: { agents: [roster.agents[0]] },
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall,
      writeReceipt: () => {},
      log: () => {},
    })
    expect(run1.summary.created).toBe(1)
    expect(count(harness.sqlite, 'agents')).toBe(1)

    // Second run: the FULL roster (both rows) — must skip resume-a (already
    // connected) and provision resume-b, never duplicating resume-a.
    const { writeReceipt, records } = memoryReceipts()
    const run2 = await runBulkProvision({
      doc: roster,
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall,
      writeReceipt,
      log: () => {},
    })
    expect(run2.exitCode).toBe(0)
    expect(run2.summary.skipped_already_connected).toBe(1)
    expect(run2.summary.created).toBe(1)
    expect(count(harness.sqlite, 'agents')).toBe(2)
    expect(count(harness.sqlite, 'agent_member_bindings')).toBe(2)
    const statuses = records.map((r) => r.status)
    expect(statuses).toEqual(['skipped_already_connected', 'provisioned'])
  })

  it('refuses a roster slug that already exists live in a DIFFERENT squad, and says which', async () => {
    const rawOperator = seedOperatorToken(harness.sqlite)
    const mcpCall = makeMcpCall(env, rawOperator)

    const run1 = await runBulkProvision({
      doc: { agents: [{ slug: 'shared-slug', name: 'Original', squad: 'home' }] },
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall,
      writeReceipt: () => {},
      log: () => {},
    })
    expect(run1.summary.created).toBe(1)

    const { log, lines } = silentLog()
    const { writeReceipt, records } = memoryReceipts()
    const run2 = await runBulkProvision({
      doc: { agents: [{ slug: 'shared-slug', name: 'Impostor', squad: 'other' }] },
      apply: true,
      continueOnError: false,
      requestIdPrefix: 'test',
      receiptsPath: '/dev/null',
      mcpCall,
      writeReceipt,
      log,
    })
    expect(run2.exitCode).toBe(1)
    expect(run2.summary.collisions).toBe(1)
    expect(records[0].status).toBe('collision')
    expect(lines.some((l) => l.includes('shared-slug') && l.includes('REFUSED'))).toBe(true)
    // Still exactly one live agent with that slug — no duplicate created.
    expect(count(harness.sqlite, 'agents')).toBe(1)
  })
})
