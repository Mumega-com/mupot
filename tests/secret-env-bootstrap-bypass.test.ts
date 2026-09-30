// Round-2 hotfix tests (PR #1627): the secret-env gate must not be satisfiable by
// standing a stranger can self-mint through bootstrap_self (agent-bound bearer +
// squad:admin on a kind='home' squad). Real bootstrap flow, real sqlite, real REST bearer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool, mcpActionsApp } from '../src/mcp/index'
import {
  requestSecretEnv, bindSecretEnv, listPendingSecretEnvRequests, PENDING_REQUEST_TTL_MS,
} from '../src/secret-env/service'
import { secretEnvApprovalsSection } from '../src/dashboard/secret-env'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
const HUMAN = 'member-stranger-1'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

let harness: SqliteD1Harness
let env: Env

const dirAuth = (): AuthContext => ({
  userId: HUMAN, email: 'stranger@example.test', role: 'member', tenant: TENANT, memberId: HUMAN,
  channel: 'directory', capabilities: [], latentCapabilities: [], boundAgentId: null,
})
const REQ = (name: string) => ({ keys: [{ name, purpose: 'p' }], reason: 'r' })

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(
    `INSERT INTO members (id, email, display_name, status, created_at, tenant)
     VALUES ('${HUMAN}', 'stranger@example.test', 'Mallory <b>', 'active', '2026-08-11T00:00:00.000Z', '${TENANT}')`,
  )
  env = {
    DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(),
    SECRET_ENV_CF_ACCOUNT_ID: 'a', SECRET_ENV_CF_SCRIPT_NAME: 's', SECRET_ENV_CF_API_TOKEN: 't',
  } as unknown as Env
})
afterEach(() => { harness.close() })

async function bootstrapAndReveal(): Promise<{ raw: string; agentMemberId: string; squadId: string }> {
  const out = await invokeTool(dirAuth(), env, 'bootstrap_self', { agent_name: 'mallory' }, ORIGIN)
  if (!out.ok) throw new Error(`bootstrap_self failed: ${out.error}`)
  const r = out.result as { member_id: string; squad: { id: string }; credential_claim: { claim_id: string } }
  const rev = await invokeTool(dirAuth(), env, 'reveal_credential_claim', { claim_id: r.credential_claim.claim_id }, ORIGIN)
  if (!rev.ok) throw new Error(`reveal failed: ${rev.error}`)
  return { raw: (rev.result as { raw: string }).raw, agentMemberId: r.member_id, squadId: r.squad.id }
}

async function rest(raw: string, tool: string, body: Record<string, unknown>) {
  const res = await mcpActionsApp.request(`${ORIGIN}/actions/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const rows = (table: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('bootstrap_self standing does NOT satisfy the secret-env gate (real flow)', () => {
  it('session -> bootstrap_self -> reveal -> agent-bound bearer is refused on request AND status', async () => {
    const { raw } = await bootstrapAndReveal()
    // positive control: the bearer really authenticates as an agent-bound seat (not a 401/403 from auth)
    expect((await rest(raw, 'boot_context', {})).status).toBe(200)
    const req = await rest(raw, 'secret_env_request', REQ('DISCORD_APP_KEY'))
    expect(req.status).toBe(403)
    const st = await rest(raw, 'secret_env_status', { names: ['DISCORD_APP_KEY'] })
    expect(st.status).toBe(403)
    expect(rows('secret_env_requests')).toBe(0)
    expect(rows('secret_env_bindings')).toBe(0)
  })

  it('in-process: home-squad-only grants are refused for an agent-bound seat and for a human', async () => {
    const { agentMemberId, squadId } = await bootstrapAndReveal()
    const agentSeat: AuthContext = {
      ...dirAuth(), channel: 'workspace', memberId: agentMemberId, userId: agentMemberId, boundAgentId: 'agent-x',
      capabilities: [{ member_id: agentMemberId, scope_type: 'squad', scope_id: squadId, capability: 'admin' }],
    }
    const human: AuthContext = {
      ...dirAuth(), channel: 'workspace',
      capabilities: [{ member_id: HUMAN, scope_type: 'squad', scope_id: squadId, capability: 'admin' }],
    }
    for (const who of [agentSeat, human]) {
      for (const [tool, args] of [['secret_env_request', REQ('X_KEY')], ['secret_env_status', { names: ['X_KEY'] }]] as const) {
        const out = await invokeTool(who, env, tool, args, ORIGIN)
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.status).toBe(403)
      }
    }
  })
})

describe('legitimate standing on a real work squad still works', () => {
  beforeEach(() => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d-work', 'd-work', 'Work')`)
    harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-work', 'd-work', 'sq-work', 'Work')`)
  })
  const seat = (capability: 'observer' | 'member', bound: boolean): AuthContext => ({
    ...dirAuth(), channel: 'workspace', memberId: 'seat-1', userId: 'seat-1',
    boundAgentId: bound ? 'agent-1' : null,
    capabilities: [{ member_id: 'seat-1', scope_type: 'squad', scope_id: 'sq-work', capability }],
  })
  it.each([['observer', true], ['member', true], ['member', false]] as const)('%s bound=%s passes', async (cap, bound) => {
    const a = seat(cap, bound)
    expect((await invokeTool(a, env, 'secret_env_request', REQ('OK_KEY'), ORIGIN)).ok).toBe(true)
    expect((await invokeTool(a, env, 'secret_env_status', { names: ['OK_KEY'] }, ORIGIN)).ok).toBe(true)
  })
  it('observer UNBOUND is refused (needs member); agent-bound with ZERO grants is refused', async () => {
    for (const a of [seat('observer', false), { ...seat('member', true), capabilities: [] }]) {
      const out = await invokeTool(a, env, 'secret_env_request', REQ('NO_KEY'), ORIGIN)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.status).toBe(403)
    }
  })
  it('org-level grant passes', async () => {
    const a: AuthContext = { ...seat('member', false), capabilities: [{ member_id: 'seat-1', scope_type: 'org', scope_id: null, capability: 'member' }] }
    expect((await invokeTool(a, env, 'secret_env_request', REQ('ORG_KEY'), ORIGIN)).ok).toBe(true)
  })
})

describe('/approvals names the human behind an agent requester', () => {
  it('shows agent name + owner email/display/id, all escaped', async () => {
    const { agentMemberId } = await bootstrapAndReveal()
    const made = await requestSecretEnv(env, {
      keys: [{ name: 'NOTION_KEY', purpose: 'p' }], reason: 'r', adapterHint: null,
      requestedBy: agentMemberId, requestedChannel: 'workspace',
    })
    expect(made.ok).toBe(true)
    const list = await listPendingSecretEnvRequests(env)
    expect(list).toHaveLength(1)
    expect(list[0]!.requester_agent_name).toBe('mallory')
    expect(list[0]!.requester_owners?.map((o) => o.email)).toEqual(['stranger@example.test'])
    const html = String(secretEnvApprovalsSection(list))
    expect(html).toContain('agent <code>mallory</code>')
    expect(html).toContain('stranger@example.test')
    expect(html).toContain(HUMAN)
    expect(html).toContain('Mallory &lt;b&gt;')
    expect(html).not.toContain('Mallory <b>')
  })
})

describe('reserved prefixes are pinned through the tool path', () => {
  beforeEach(() => {
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d-work', 'd-work', 'Work')`)
    harness.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-work', 'd-work', 'sq-work', 'Work')`)
  })
  const ok: AuthContext = {
    ...dirAuth(), channel: 'workspace', memberId: 'seat-1', userId: 'seat-1',
    capabilities: [{ member_id: 'seat-1', scope_type: 'squad', scope_id: 'sq-work', capability: 'member' }],
  }
  it.each(['LOOP_SECRET_ABC_HOST', 'DISCORD_BOT_TOKEN_KASRA', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN',
    'DISCORD_ADMIN_BOT_TOKEN', 'DISCORD_ADMIN_AGENT', 'GOOGLE_CHAT_SA_KEY', 'GOOGLE_CHAT_VERIFY_TOKEN',
    'GOOGLE_CHAT_PROJECT_NUMBER', 'GITHUB_LABEL_SQUAD_MAP', 'GITHUB_SYNC_PROJECT', 'GITHUB_PLAN_TIER',
    'GITHUB_ENTERPRISE_FEATURES'])('refuses %s', async (name) => {
    const out = await invokeTool(ok, env, 'secret_env_request', REQ(name), ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('reserved_binding_name')
  })
  it('a legitimate STEM_* style name is still accepted', async () => {
    expect((await invokeTool(ok, env, 'secret_env_request', REQ('STEM_API_KEY'), ORIGIN)).ok).toBe(true)
  })
})

describe('pending cap ignores EXPIRED pending rows', () => {
  it('5 expired pending requests do not lock the requester out', async () => {
    const old = new Date(Date.now() - PENDING_REQUEST_TTL_MS - 60_000).toISOString()
    for (let i = 0; i < 5; i++) {
      harness.sqlite.exec(
        `INSERT INTO secret_env_requests (id, tenant, reason, schema_json, status, requested_by, created_at)
         VALUES ('old-${i}', '${TENANT}', 'r', '{"keys":[],"adapterHint":null}', 'pending', 'req-1', '${old}')`,
      )
    }
    const out = await requestSecretEnv(env, { keys: [{ name: 'FRESH_KEY', purpose: 'p' }], reason: 'r', adapterHint: null, requestedBy: 'req-1' })
    expect(out.ok).toBe(true)
  })
})

describe('bindSecretEnv closes the TTL-boundary race at the write', () => {
  it('a name re-taken during the CF round-trip is NOT flipped to bound under the old request', async () => {
    const first = await requestSecretEnv(env, { keys: [{ name: 'RACE_KEY', purpose: 'p' }], reason: 'r', adapterHint: null, requestedBy: 'req-a' })
    if (!first.ok) throw new Error('setup')
    const old = new Date(Date.now() - PENDING_REQUEST_TTL_MS + 5_000).toISOString() // 5s from expiry: passes the read check
    harness.sqlite.exec(`UPDATE secret_env_requests SET created_at = '${old}'`)
    harness.sqlite.exec(`UPDATE secret_env_bindings SET created_at = '${old}'`)
    let second: Awaited<ReturnType<typeof requestSecretEnv>> | null = null
    const fetchImpl = (async () => {
      // during the CF PUT: TTL elapses and another requester re-takes the name
      const expired = new Date(Date.now() - PENDING_REQUEST_TTL_MS - 1_000).toISOString()
      harness.sqlite.exec(`UPDATE secret_env_requests SET created_at = '${expired}' WHERE id = '${first.request.id}'`)
      harness.sqlite.exec(`UPDATE secret_env_bindings SET created_at = '${expired}' WHERE request_id = '${first.request.id}'`)
      second = await requestSecretEnv(env, { keys: [{ name: 'RACE_KEY', purpose: 'p' }], reason: 'r', adapterHint: null, requestedBy: 'req-b' })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await bindSecretEnv(env, { requestId: first.request.id, values: { RACE_KEY: 'old-admin-value' }, actorId: 'admin-1', fetchImpl })
    expect(second?.ok).toBe(true)
    expect(res).toEqual({ ok: false, error: 'request_state_changed' })
    const binding = harness.sqlite.prepare(`SELECT status, request_id FROM secret_env_bindings WHERE binding_name = 'RACE_KEY'`).get() as { status: string; request_id: string }
    expect(binding.status).toBe('pending')
    expect(binding.request_id).toBe(second && second.ok ? second.request.id : 'x')
    const oldReq = harness.sqlite.prepare(`SELECT status FROM secret_env_requests WHERE id = ?`).get(first.request.id) as { status: string }
    expect(oldReq.status).toBe('pending')
  })
})

describe('bindSecretEnv commit guards, each isolated', () => {
  const okFetch = (during: () => void) => (async () => {
    during()
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }) as unknown as typeof fetch
  const state = (name: string) => harness.sqlite.prepare(
    `SELECT b.status AS b, r.status AS r FROM secret_env_bindings b JOIN secret_env_requests r ON r.id = b.request_id WHERE b.binding_name = ?`,
  ).get(name) as { b: string; r: string }

  it('request expires during the CF round-trip (name NOT re-taken): nothing flips', async () => {
    const first = await requestSecretEnv(env, { keys: [{ name: 'EXP_KEY', purpose: 'p' }], reason: 'r', adapterHint: null, requestedBy: 'req-a' })
    if (!first.ok) throw new Error('setup')
    const res = await bindSecretEnv(env, {
      requestId: first.request.id, values: { EXP_KEY: 'v' }, actorId: 'admin-1',
      fetchImpl: okFetch(() => {
        const expired = new Date(Date.now() - PENDING_REQUEST_TTL_MS - 1_000).toISOString()
        harness.sqlite.exec(`UPDATE secret_env_requests SET created_at = '${expired}'`)
      }),
    })
    expect(res).toEqual({ ok: false, error: 'request_state_changed' })
    expect(state('EXP_KEY')).toEqual({ b: 'pending', r: 'pending' })
  })

  it('binding re-taken during the round-trip while the request row is still fresh: nothing flips', async () => {
    const first = await requestSecretEnv(env, { keys: [{ name: 'TAKE_KEY', purpose: 'p' }], reason: 'r', adapterHint: null, requestedBy: 'req-a' })
    if (!first.ok) throw new Error('setup')
    const res = await bindSecretEnv(env, {
      requestId: first.request.id, values: { TAKE_KEY: 'v' }, actorId: 'admin-1',
      fetchImpl: okFetch(() => {
        // only the binding row ages out and is re-owned by another request
        const expired = new Date(Date.now() - PENDING_REQUEST_TTL_MS - 1_000).toISOString()
        harness.sqlite.exec(`UPDATE secret_env_bindings SET created_at = '${expired}' WHERE binding_name = 'TAKE_KEY'`)
        harness.sqlite.exec(
          `UPDATE secret_env_bindings SET request_id = 'other-req', requested_by = 'req-b', created_at = '${new Date().toISOString()}' WHERE binding_name = 'TAKE_KEY'`,
        )
      }),
    })
    expect(res).toEqual({ ok: false, error: 'request_state_changed' })
    const b = harness.sqlite.prepare(`SELECT status, request_id FROM secret_env_bindings WHERE binding_name = 'TAKE_KEY'`).get() as { status: string; request_id: string }
    expect(b).toEqual({ status: 'pending', request_id: 'other-req' })
    const r = harness.sqlite.prepare(`SELECT status FROM secret_env_requests WHERE id = ?`).get(first.request.id) as { status: string }
    expect(r.status).toBe('pending')
  })
})
