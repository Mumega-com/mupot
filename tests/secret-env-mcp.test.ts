// tests/secret-env-mcp.test.ts — secret_env_request / secret_env_status MCP tools.
// Custody discipline: neither tool ever returns a secret VALUE. request returns
// only names + a request id; status returns only the state enum per name.

import { describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  // the real work squad the fixture members/agents hold grants on (the gate reads squads.kind)
  harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'D')`)
  harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'S')`)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    count: (table: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    exec: (sql: string) => { harness.sqlite.exec(sql) },
    bindingRow: (name: string) => harness.sqlite
      .prepare('SELECT * FROM secret_env_bindings WHERE tenant = ? AND binding_name = ?')
      .get(TENANT, name) as Record<string, unknown> | undefined,
  }
}

function auth(memberId: string): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    // member on a squad: the floor the secret-env tools now require (hotfix — a
    // zero-capability directory session is refused, see the authz describe below).
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    boundAgentId: null,
  }
}

const member = auth('member-1')

describe('secret-env MCP tools — registry', () => {
  it('registers secret_env_request and secret_env_status as authenticated tools', () => {
    for (const name of ['secret_env_request', 'secret_env_status']) {
      const spec = TOOLS.find((t) => t.name === name)
      expect(spec).toBeDefined()
      expect(spec?.min).toBe('authenticated')
    }
  })
})

describe('secret_env_request', () => {
  it('creates a pending request and returns only names — never a value field', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { request_id: string; keys: string[] }
    expect(typeof result.request_id).toBe('string')
    expect(result.keys).toEqual(['STRIPE_API_KEY'])
    expect(JSON.stringify(result)).not.toContain('value')

    const row = db.bindingRow('STRIPE_API_KEY')
    expect(row?.status).toBe('pending')
    expect(row?.requested_by).toBe('member-1')
  })

  it('rejects an unauthenticated caller', async () => {
    const db = makeDb()
    const anon = { ...member, memberId: undefined, userId: '' } as AuthContext
    const out = await invokeTool(anon, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })

  it('rejects missing reason with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: '',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an empty keys array with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an invalid binding name with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'not-a-valid-name', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects a key entry missing purpose with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('passes adapter_hint through when provided', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
      adapter_hint: 'stripe',
    }, ORIGIN)
    expect(out.ok).toBe(true)
    const row = db.bindingRow('STRIPE_API_KEY')
    expect(row?.adapter_hint).toBe('stripe')
  })
})

describe('secret_env_status', () => {
  it('returns bound/unbound/pending statuses and never a value field', async () => {
    const db = makeDb()
    await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)

    const out = await invokeTool(member, db.env, 'secret_env_status', {
      names: ['STRIPE_API_KEY', 'NEVER_REQUESTED'],
    }, ORIGIN)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { statuses: Record<string, string> }
    expect(result.statuses.STRIPE_API_KEY).toBe('pending')
    expect(result.statuses.NEVER_REQUESTED).toBe('unbound')
    expect(JSON.stringify(result)).not.toContain('"value"')
  })

  it('rejects an empty names array with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_status', { names: [] }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects more than 20 names with 400', async () => {
    const db = makeDb()
    const names = Array.from({ length: 21 }, (_, i) => `KEY_${i}`)
    const out = await invokeTool(member, db.env, 'secret_env_status', { names }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an unauthenticated caller', async () => {
    const db = makeDb()
    const anon = { ...member, memberId: undefined, userId: '' } as AuthContext
    const out = await invokeTool(anon, db.env, 'secret_env_status', { names: ['STRIPE_API_KEY'] }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })
})

// ── hotfix: caller gate, rate limit/cap, reserved names, requester visibility ─

const zeroCap: AuthContext = {
  userId: 'stranger-1',
  email: 'stranger@example.test',
  role: 'member',
  tenant: TENANT,
  channel: 'directory',
  memberId: 'stranger-1',
  capabilities: [],
  latentCapabilities: [],
  boundAgentId: null,
  tokenId: 'tok-1',
}
const agentBound: AuthContext = {
  ...zeroCap,
  memberId: 'agent-member-1',
  userId: 'agent-member-1',
  boundAgentId: 'agent-1',
  // observer-rank agent seat: below `member`, must still work.
  capabilities: [{ member_id: 'agent-member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'observer' }],
}
const REQ = (name: string) => ({ keys: [{ name, purpose: 'p' }], reason: 'r' })

describe('secret-env caller gate (zero-capability directory session)', () => {
  it('denies a zero-cap unbound session on secret_env_request with 403 and writes nothing', async () => {
    const db = makeDb()
    const out = await invokeTool(zeroCap, db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
    expect(db.bindingRow('OPENAI_API_KEY')).toBeUndefined()
  })
  it('denies a zero-cap unbound session on secret_env_status with 403 (no name probe)', async () => {
    const db = makeDb()
    const out = await invokeTool(zeroCap, db.env, 'secret_env_status', { names: ['OPENAI_API_KEY'] }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })
  it('allows an agent-bound seat (even observer rank) on both tools', async () => {
    const db = makeDb()
    const req = await invokeTool(agentBound, db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)
    expect(req.ok).toBe(true)
    const st = await invokeTool(agentBound, db.env, 'secret_env_status', { names: ['OPENAI_API_KEY'] }, ORIGIN)
    expect(st.ok).toBe(true)
  })
  it('allows a member on some squad on both tools', async () => {
    const db = makeDb()
    expect((await invokeTool(member, db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)).ok).toBe(true)
    expect((await invokeTool(member, db.env, 'secret_env_status', { names: ['OPENAI_API_KEY'] }, ORIGIN)).ok).toBe(true)
  })
  it('observer-only unbound principal is denied', async () => {
    const db = makeDb()
    const observer = { ...zeroCap, capabilities: [{ member_id: 'stranger-1', scope_type: 'squad' as const, scope_id: 's', capability: 'observer' as const }] }
    const out = await invokeTool(observer, db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })
})

describe('secret_env_request — reserved names via the real tool path', () => {
  it.each([
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'RESEND_API_KEY',
    'MEMBER_TOKEN_FINGERPRINT_SECRET', 'OAUTH_CLIENT_ID', 'PUBLIC_ORIGIN', 'IDP_PROVIDER',
    'EMAIL_PROVIDER', 'LOCAL_TEST_AUTH', 'POT_SELF_SERVE_CHECKOUT_ENABLED', 'SOS_TOKEN',
  ])('refuses %s', async (name) => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', REQ(name), ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('reserved_binding_name')
    expect(db.bindingRow(name)).toBeUndefined()
  })
})

describe('secret_env_request — per-requester cap and hourly limit (atomic)', () => {
  it('caps pending requests per requester under Promise.all (exactly 5 land)', async () => {
    const db = makeDb()
    const outs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => invokeTool(member, db.env, 'secret_env_request', REQ(`SVC_${i}_KEY`), ORIGIN)),
    )
    expect(outs.filter((o) => o.ok)).toHaveLength(5)
    const refused = outs.filter((o) => !o.ok)
    expect(refused).toHaveLength(7)
    for (const o of refused) if (!o.ok) expect(o.error).toBe('too_many_pending_requests')
    expect(db.count('secret_env_requests')).toBe(5)
    expect(db.count('secret_env_bindings')).toBe(5) // refused requests leave no orphan binding rows
  })
  it('cap is per requester: another member is unaffected', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i++) await invokeTool(member, db.env, 'secret_env_request', REQ(`A_${i}_KEY`), ORIGIN)
    const other = auth('member-2')
    expect((await invokeTool(other, db.env, 'secret_env_request', REQ('B_KEY'), ORIGIN)).ok).toBe(true)
  })
  it('hourly limit holds even when requests are not pending (rejected ones still count)', async () => {
    const db = makeDb()
    const { rejectSecretEnv } = await import('../src/secret-env/service')
    let ok = 0
    for (let i = 0; i < 12; i++) {
      const out = await invokeTool(member, db.env, 'secret_env_request', REQ(`R_${i}_KEY`), ORIGIN)
      if (out.ok) {
        ok++
        await rejectSecretEnv(db.env, { requestId: (out.result as { request_id: string }).request_id, actorId: 'admin' })
      } else {
        expect(out.error).toBe('rate_limited')
      }
    }
    expect(ok).toBe(10)
  })
})

describe('secret_env_request — a rejected request frees the name', () => {
  it('rejected request frees the name for another requester', async () => {
    const db = makeDb()
    const { rejectSecretEnv } = await import('../src/secret-env/service')
    const first = await invokeTool(member, db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const clash = await invokeTool(auth('member-2'), db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.error).toBe('binding_name_conflict')
    await rejectSecretEnv(db.env, { requestId: (first.result as { request_id: string }).request_id, actorId: 'admin' })
    expect((await invokeTool(auth('member-2'), db.env, 'secret_env_request', REQ('OPENAI_API_KEY'), ORIGIN)).ok).toBe(true)
  })
})
