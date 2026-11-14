// Board task 1e6d566f — MCP tool-call failures must not hang, and must keep the
// documented envelopes (#1667 / connect-mcp-client.md):
//   - tool-level 4xx refusals → HTTP 200 + result.isError
//   - unknown_tool / invalid_args / invalid_request → JSON-RPC -32602 at HTTP 200
//   - 5xx stay JSON-RPC errors carrying their HTTP status (#1692 / #2345)
//   - missing auth → real HTTP 401 (WWW-Authenticate is added by the OAuthProvider
//     wrapper; asserted in tests/composition/mcp-profile-needs-you-wrapper.test.ts)
//
// Historical hang root cause (two layers, both already closed):
//   1. Client-side: tools/call returned HTTP 4xx for tool refusals; connector
//      harnesses treated that as a transport block (mcp_request_blocked) and
//      hung / retried until client timeout. Fixed by #1667 (isError envelope).
//   2. Server-side side effects on the create/dispatch path: GitHub issue mirror
//      and webhook doorbell POSTs. Both are hard-bounded —
//      GITHUB_TASK_MIRROR_TIMEOUT_MS (5s) and DOORBELL_TIMEOUT_MS (3s) +
//      AWAIT_CEILING — with mutation-proof tests in tasks-service.test.ts
//      ("mirrorTaskCreate timeout") and webhook-doorbell-coverage.test.ts
//      ("a hung webhook cannot hold the caller past the bounded ceiling").
//
// This file proves the MCP envelopes return within a bound, and that a valid
// agent-bound task_create + flight_dispatch still succeed and can be read back
// through the real-schema sqlite D1 harness + invokeTool.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpApp, invokeTool } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { sha256Hex } from '../src/members/service'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { callToolOutcome } from './helpers/mcp-call'
import { seedLiveToken } from './helpers/live-token'
import { hashMemberToken } from '../src/auth/member-bearer'

const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'
const BOUND_MS = 2_000
const MEMBER_TOKEN = 'member-tok-1e6d'
const AGENT_TOKEN = 'agent-tok-1e6d'
const MEMBER_ID = 'member-1'
const AGENT_MEMBER_ID = 'member-agent'
const AGENT_ID = 'agent-1'
const SQUAD_ID = 'squad-1'

let harness: SqliteD1Harness

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const memberHash = await sha256Hex(MEMBER_TOKEN)
  const agentHash = await hashMemberToken(AGENT_TOKEN)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 'core', 'Core');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_ID}', NULL, 'Plain member', 'active', '${T0}', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${AGENT_MEMBER_ID}', NULL, 'Agent member', 'active', '${T0}', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id)
      VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'worker', 'Worker', 'active', '${MEMBER_ID}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER_ID}', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-member', '${MEMBER_ID}', '${memberHash}', 't', 'workspace', '${T0}', NULL, '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-member', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-agent', '${AGENT_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
  `)
  const tokenId = seedLiveToken(harness.sqlite, {
    memberId: AGENT_MEMBER_ID,
    tenant: TENANT,
    tokenId: 'tok-agent',
    channel: 'workspace',
    boundAgentId: AGENT_ID,
  })
  harness.sqlite.prepare(`UPDATE member_tokens SET token_hash = ? WHERE id = ?`).run(agentHash, tokenId)
})

afterEach(() => harness.close())

function makeEnv(down?: { value: boolean }): Env {
  const db = down
    ? {
        prepare: (sql: string) => {
          if (down.value && sql.includes('has_caps')) throw new Error('d1 down')
          return harness.db.prepare(sql)
        },
        batch: harness.db.batch.bind(harness.db),
      }
    : harness.db
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    LAND_REQUIRES_EVIDENCE: '0',
    DB: db,
    BUS: { send: async () => {} },
  } as unknown as Env
}

function rpc(method: string, params: unknown, bearer = MEMBER_TOKEN) {
  return mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    },
    makeEnv(),
  )
}

async function withinBound<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  const value = await work()
  return { value, ms: Date.now() - started }
}

const flightSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 999_000_000,
  budgetEstimateMicroUsd: 999_000_000,
  recentProgress: 0.9,
  progressPerStep: 0.8,
  wastePerStep: 0.1,
  stepSeconds: 10,
}

function flightMeta() {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'g-1e6d',
    objective_id: 'o-1e6d',
    squad_ids: [SQUAD_ID],
    task_ids: [] as string[],
    done_when: ['the envelope proof passes'],
    artifact_refs: [] as string[],
    receipt_refs: [] as string[],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  }
}

function agentAuth(): AuthContext {
  return {
    userId: AGENT_MEMBER_ID,
    memberId: AGENT_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: 'tok-agent',
    capabilities: [
      { member_id: AGENT_MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
  }
}

describe('1e6d566f MCP error envelopes stay bounded', () => {
  it('unauthorized admin tool: HTTP 200 + isError + refusal code, within bound', async () => {
    const { value: res, ms } = await withinBound(() =>
      rpc('tools/call', { name: 'pot_list', arguments: {} }),
    )
    expect(ms).toBeLessThan(BOUND_MS)
    expect(res.status).toBe(200)
    const outcome = await callToolOutcome(res.clone())
    const body = (await res.json()) as {
      error?: unknown
      result: { isError: boolean; structuredContent: { error: string; status: number } }
    }
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent).toMatchObject({ error: 'forbidden', status: 403 })
    expect(outcome).toMatchObject({ status: 403, error: 'forbidden', isToolRefusal: true })
  })

  it('schema-invalid args: JSON-RPC -32602 at HTTP 200 within bound (not isError)', async () => {
    const { value: res, ms } = await withinBound(() =>
      rpc('tools/call', { name: 'status', arguments: { bogus: 1 } }),
    )
    expect(ms).toBeLessThan(BOUND_MS)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { error?: { code: number; message: string }; result?: { isError?: boolean } }
    expect(body.result?.isError).toBeUndefined()
    expect(body.error).toMatchObject({ code: -32602, message: 'invalid_args' })
  })

  it('unknown tool: JSON-RPC -32602 at HTTP 200 within bound (not isError)', async () => {
    const { value: res, ms } = await withinBound(() =>
      rpc('tools/call', { name: 'no_such_tool_1e6d', arguments: {} }),
    )
    expect(ms).toBeLessThan(BOUND_MS)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { error?: { code: number; message: string }; result?: { isError?: boolean } }
    expect(body.result?.isError).toBeUndefined()
    expect(body.error).toMatchObject({ code: -32602, message: 'unknown_tool' })
  })

  it('unauthenticated tools/call stays HTTP 401 within bound', async () => {
    const { value: res, ms } = await withinBound(() =>
      rpc('tools/call', { name: 'status', arguments: {} }, ''),
    )
    expect(ms).toBeLessThan(BOUND_MS)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { message: string }; result?: unknown }
    expect(body.error.message).toBe('unauthenticated')
    expect(body.result).toBeUndefined()
  })

  it('5xx agent_check_unavailable stays HTTP 503 + Retry-After within bound', async () => {
    const down = { value: true }
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${AGENT_TOKEN}`,
      [AUTH_CONTEXT_HEADER]: JSON.stringify(agentAuth()),
    }
    const { value: res, ms } = await withinBound(() =>
      mcpApp.request(
        'https://pot.example/',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'inbox', arguments: {} },
          }),
        },
        makeEnv(down),
      ),
    )
    expect(ms).toBeLessThan(BOUND_MS)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    const body = (await res.json()) as { error: { message: string }; result?: { isError?: boolean } }
    expect(body.result?.isError).toBeUndefined()
    expect(body.error.message).toBe('agent_check_unavailable')
  })
})

describe('1e6d566f valid agent-bound task_create + flight_dispatch', () => {
  it('creates a task, dispatches a flight, and reads both back via invokeTool', async () => {
    const env = makeEnv()
    const auth = agentAuth()

    const created = await invokeTool(
      auth,
      env,
      'task_create',
      {
        title: '1e6d envelope proof',
        done_when: 'task is readable after create',
        body: 'prove no hang on the success path',
        squad_id: SQUAD_ID,
        assignee_agent_id: AGENT_ID,
        dispatch: false,
      },
      'https://pot.example',
    )
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const taskId = (created.result as { task: { id: string } }).task.id
    expect(taskId).toMatch(/\S/)

    const listed = await invokeTool(auth, env, 'task_list', { squad_id: SQUAD_ID, limit: 10 }, 'https://pot.example')
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    const tasks = (listed.result as { tasks: Array<{ id: string; title: string }> }).tasks
    expect(tasks.some((t) => t.id === taskId && t.title === '1e6d envelope proof')).toBe(true)

    const meta = flightMeta()
    meta.task_ids = [taskId]
    const dispatched = await invokeTool(
      auth,
      env,
      'flight_dispatch',
      {
        squad_id: SQUAD_ID,
        goal: 'Prove flight_dispatch still succeeds',
        budget_micro_usd: 0,
        meta_json: JSON.stringify(meta),
        signals_json: JSON.stringify(flightSignals),
      },
      'https://pot.example',
    )
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    const flightId = (dispatched.result as { flight: { id: string }; delivered: boolean }).flight.id
    expect((dispatched.result as { delivered: boolean }).delivered).toBe(true)

    const got = await invokeTool(auth, env, 'flight_get', { flight_id: flightId }, 'https://pot.example')
    expect(got.ok, JSON.stringify(got)).toBe(true)
    expect(got.result).toMatchObject({ flight: { id: flightId, status: 'running', agent: AGENT_ID } })
  })
})
