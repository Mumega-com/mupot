// tests/webhook-doorbell.test.ts — Grok Bot inbox-wake doorbell.
//
// Schema from the migration chain (createSqliteD1 + applyAllMigrations).
// MCP tools go through invokeTool (capability floor + schema), never spec.run().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendAgentMessage } from '../src/agents/messages'
import {
  fireWebhookDoorbell,
  getAgentWebhookDoorbell,
  setAgentWebhookDoorbell,
} from '../src/agents/webhook-doorbell'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-a'
const MEMBER_ID = 'member-1'
const OTHER_MEMBER_ID = 'member-2'
const DEPT_ID = 'dept-a'
const SQUAD_ID = 'squad-a'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'
const T0 = '2026-09-06T18:00:00.000Z'
const TEST_MASTER_KEY = 'a'.repeat(64)
const DOORBELL_BEARER = 'super-secret-doorbell-key-XYZ'
const DOORBELL_URL = 'https://webhook.example/grokbot/wake?token=should-not-leak'
const AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_A,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

function adminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return auth({
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
    ...overrides,
  })
}

/** A human (not agent-bound) admin; `scope` picks org-wide or one squad. */
function humanAdminAuth(scope: { type: 'org' } | { type: 'squad'; id: string }): AuthContext {
  return {
    userId: OTHER_MEMBER_ID,
    memberId: OTHER_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [
      scope.type === 'org'
        ? { member_id: OTHER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }
        : { member_id: OTHER_MEMBER_ID, scope_type: 'squad', scope_id: scope.id, capability: 'admin' },
    ],
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_A}', '${SQUAD_ID}', 'grokbot-ceo', 'CEO', 'operator', 'test', 'active'),
      ('${AGENT_B}', '${SQUAD_ID}', 'grokbot-staff', 'Staff', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${MEMBER_ID}', 'owner@pot.test', 'Owner', 'active', '${TENANT}'),
      ('${OTHER_MEMBER_ID}', 'other@pot.test', 'Other', 'active', '${TENANT}');
  `)
}

function collectLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'info').mockImplementation(capture),
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'debug').mockImplementation(capture),
  ]
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

function assertNoSecretLeak(haystack: string): void {
  expect(haystack).not.toContain(DOORBELL_BEARER)
  expect(haystack).not.toContain('should-not-leak')
}

describe('Grok Bot webhook doorbell', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: async () => {} },
      CONNECTOR_MASTER_KEY: TEST_MASTER_KEY,
      WEBHOOK_DOORBELL: '1',
    } as unknown as Env
  })

  afterEach(() => {
    harness.close()
  })

  it('advertises set/get on the MCP surface', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'set_agent_webhook_doorbell',
      'get_agent_webhook_doorbell',
    ]))
    expect(TOOLS.find((t) => t.name === 'set_agent_webhook_doorbell')?.min).toBe('authenticated')
    expect(TOOLS.find((t) => t.name === 'get_agent_webhook_doorbell')?.min).toBe('authenticated')
  })

  it('self can set and get own doorbell; get never returns bearer or ciphertext', async () => {
    const set = await invokeTool(auth(), env, 'set_agent_webhook_doorbell', {
      webhook_url: DOORBELL_URL,
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(set.ok).toBe(true)
    const stored = set.result as {
      configured: boolean
      agent_id: string
      webhook_url: string
      auth_last4: string
    }
    expect(stored.configured).toBe(true)
    expect(stored.agent_id).toBe(AGENT_A)
    expect(stored.auth_last4).toBe('-XYZ')
    expect(stored.webhook_url).toBe('https://webhook.example/grokbot/wake')
    assertNoSecretLeak(JSON.stringify(set))

    const got = await invokeTool(auth(), env, 'get_agent_webhook_doorbell', {}, 'https://pot.example')
    expect(got.ok).toBe(true)
    expect(got.result).toMatchObject({
      configured: true,
      agent_id: AGENT_A,
      webhook_url: 'https://webhook.example/grokbot/wake',
      auth_last4: '-XYZ',
    })
    assertNoSecretLeak(JSON.stringify(got))

    const raw = harness.sqlite.prepare(
      `SELECT auth_ciphertext, webhook_url FROM agent_webhook_doorbells WHERE agent_id = ?`,
    ).get(AGENT_A) as { auth_ciphertext: string; webhook_url: string }
    expect(raw.auth_ciphertext).toBeTruthy()
    expect(raw.auth_ciphertext).not.toContain(DOORBELL_BEARER)
    expect(raw.webhook_url).toContain('should-not-leak')
  })

  it('member cannot set or get another agent; a human admin can', async () => {
    const deniedSet = await invokeTool(auth(), env, 'set_agent_webhook_doorbell', {
      agent: AGENT_B,
      webhook_url: 'https://webhook.example/staff',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(deniedSet.ok).toBe(false)
    expect(deniedSet.status).toBe(403)

    const deniedGet = await invokeTool(auth(), env, 'get_agent_webhook_doorbell', {
      agent: 'grokbot-staff',
    }, 'https://pot.example')
    expect(deniedGet.ok).toBe(false)
    expect(deniedGet.status).toBe(403)

    // an org-admin AGENT (agent-bound, no delegation) is refused through the W0 chokepoint
    const agentAdminSet = await invokeTool(adminAuth(), env, 'set_agent_webhook_doorbell', {
      agent: 'grokbot-staff',
      webhook_url: 'https://webhook.example/staff',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(agentAdminSet.ok).toBe(false)
    expect(agentAdminSet.status).toBe(403)
    expect(agentAdminSet.error).toBe('operator_principal_required')

    const adminSet = await invokeTool(humanAdminAuth({ type: 'org' }), env, 'set_agent_webhook_doorbell', {
      agent: 'grokbot-staff',
      webhook_url: 'https://webhook.example/staff',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(adminSet.ok).toBe(true)
    expect((adminSet.result as { agent_id: string }).agent_id).toBe(AGENT_B)

    const adminGet = await invokeTool(humanAdminAuth({ type: 'org' }), env, 'get_agent_webhook_doorbell', {
      agent: AGENT_B,
    }, 'https://pot.example')
    expect(adminGet.ok).toBe(true)
    expect((adminGet.result as { configured: boolean }).configured).toBe(true)
  })

  it('clear removes the mapping', async () => {
    await invokeTool(auth(), env, 'set_agent_webhook_doorbell', {
      webhook_url: 'https://webhook.example/ceo',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')

    const cleared = await invokeTool(auth(), env, 'set_agent_webhook_doorbell', {
      clear: true,
    }, 'https://pot.example')
    expect(cleared.ok).toBe(true)
    expect(cleared.result).toEqual({ configured: false, agent_id: AGENT_A })

    const got = await invokeTool(auth(), env, 'get_agent_webhook_doorbell', {}, 'https://pot.example')
    expect(got.result).toEqual({ configured: false, agent_id: AGENT_A })
  })

  it('refuses http URLs and missing CONNECTOR_MASTER_KEY', async () => {
    const http = await invokeTool(auth(), env, 'set_agent_webhook_doorbell', {
      webhook_url: 'http://webhook.example/insecure',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(http.ok).toBe(false)
    expect(http.status).toBe(400)
    expect(http.error).toBe('invalid_webhook_url')

    const noKeyEnv = { ...env, CONNECTOR_MASTER_KEY: undefined } as unknown as Env
    const missing = await invokeTool(auth(), noKeyEnv, 'set_agent_webhook_doorbell', {
      webhook_url: 'https://webhook.example/ceo',
      bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(missing.ok).toBe(false)
    expect(missing.status).toBe(503)
    expect(missing.error).toBe('doorbell_crypto_unavailable')
  })

  it('send succeeds when the doorbell webhook returns 500; payload is a hint; no secret in logs', async () => {
    const logs = collectLogs()
    const set = await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A,
      webhookUrl: DOORBELL_URL,
      bearer: DOORBELL_BEARER,
      createdByMemberId: MEMBER_ID,
      now: T0,
    })
    expect(set.ok).toBe(true)

    const fetches: Array<{ url: string; init: RequestInit }> = []
    const pending: Promise<unknown>[] = []
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), init: init ?? {} })
      return new Response('nope', { status: 500 })
    }

    const res = await sendAgentMessage(env, {
      fromAgent: AGENT_B,
      fromMember: MEMBER_ID,
      toAgent: AGENT_A,
      body: 'hello from staff',
      kind: 'request',
      requestId: 'rid-wake-1',
    }, AUTHZ, {
      now: () => T0,
      idGen: () => 'msg-wake-1',
      fetch: fetchImpl as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('send failed')
    await Promise.all(pending)

    expect(fetches).toHaveLength(1)
    expect(fetches[0].url).toBe('https://webhook.example/grokbot/wake?token=should-not-leak')
    expect(fetches[0].init.method).toBe('POST')
    const headers = fetches[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${DOORBELL_BEARER}`)
    expect(JSON.parse(String(fetches[0].init.body))).toEqual({
      type: 'mupot.inbox.wake',
      agent_id: AGENT_A,
      seq: res.seq,
      message_id: res.id,
      kind: 'request',
    })

    const row = harness.sqlite.prepare(
      `SELECT id FROM agent_messages WHERE id = ?`,
    ).get(res.id)
    expect(row).toBeTruthy()

    assertNoSecretLeak(logs.lines.join('\n'))
    expect(logs.lines.join('\n')).toMatch(/wake failed/)
    logs.restore()
  })

  it('does not POST on an idempotent duplicate send', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A,
      webhookUrl: 'https://webhook.example/ceo',
      bearer: DOORBELL_BEARER,
      createdByMemberId: MEMBER_ID,
    })

    let calls = 0
    const pending: Promise<unknown>[] = []
    const fetchImpl = async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    }
    const opts = {
      fetch: fetchImpl as typeof fetch,
      waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    }

    const first = await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A,
      body: 'once', kind: 'message', requestId: 'rid-dup',
    }, AUTHZ, opts)
    const second = await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A,
      body: 'once', kind: 'message', requestId: 'rid-dup',
    }, AUTHZ, opts)
    await Promise.all(pending)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect((second as { duplicate: boolean }).duplicate).toBe(true)
    expect(calls).toBe(1)
  })

  it('does not POST when CONNECTOR_MASTER_KEY is missing on send', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A,
      webhookUrl: 'https://webhook.example/ceo',
      bearer: DOORBELL_BEARER,
      createdByMemberId: MEMBER_ID,
    })
    const noKey = { ...env, CONNECTOR_MASTER_KEY: undefined } as unknown as Env
    let calls = 0
    const res = await sendAgentMessage(noKey, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A,
      body: 'no crypto', kind: 'message', requestId: 'rid-nokey',
    }, AUTHZ, {
      fetch: (async () => {
        calls += 1
        return new Response('ok')
      }) as typeof fetch,
    })
    expect(res.ok).toBe(true)
    expect(calls).toBe(0)
  })

  it('send still succeeds when fetch throws; no doorbell row means no POST', async () => {
    const pending: Promise<unknown>[] = []
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      throw new Error(`network down ${DOORBELL_BEARER}`)
    }

    const noRow = await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A,
      body: 'no doorbell', kind: 'message', requestId: 'rid-none',
    }, AUTHZ, {
      fetch: fetchImpl as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    await Promise.all(pending)
    expect(noRow.ok).toBe(true)
    expect(calls).toBe(0)

    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A,
      webhookUrl: 'https://webhook.example/ceo',
      bearer: DOORBELL_BEARER,
      createdByMemberId: MEMBER_ID,
    })
    const logs = collectLogs()
    const threw = await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A,
      body: 'doorbell down', kind: 'message', requestId: 'rid-throw',
    }, AUTHZ, {
      fetch: fetchImpl as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    await Promise.all(pending)
    expect(threw.ok).toBe(true)
    expect(calls).toBe(1)
    assertNoSecretLeak(logs.lines.join('\n'))
    logs.restore()
  })

  it('service get redacts query and never exposes ciphertext', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A,
      webhookUrl: DOORBELL_URL,
      bearer: DOORBELL_BEARER,
      createdByMemberId: MEMBER_ID,
    })
    const view = await getAgentWebhookDoorbell(env, AGENT_A)
    expect(view).toMatchObject({
      configured: true,
      webhook_url: 'https://webhook.example/grokbot/wake',
      auth_last4: '-XYZ',
    })
    assertNoSecretLeak(JSON.stringify(view))
  })
  it('squad admin of the agent squad may set; squad admin of another squad may not', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', '${DEPT_ID}', 'squad-b', 'Squad Beta');
    `)
    const own = await invokeTool(humanAdminAuth({ type: 'squad', id: SQUAD_ID }), env, 'set_agent_webhook_doorbell', {
      agent: AGENT_B, webhook_url: 'https://webhook.example/staff', bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(own.ok).toBe(true)
    const other = await invokeTool(humanAdminAuth({ type: 'squad', id: 'squad-b' }), env, 'set_agent_webhook_doorbell', {
      agent: AGENT_B, webhook_url: 'https://webhook.example/staff2', bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(other.ok).toBe(false)
    expect(other.status).toBe(403)
    const otherClear = await invokeTool(humanAdminAuth({ type: 'squad', id: 'squad-b' }), env, 'set_agent_webhook_doorbell', {
      agent: AGENT_B, clear: true,
    }, 'https://pot.example')
    expect(otherClear.ok).toBe(false)
    expect(otherClear.status).toBe(403)
    const row = harness.sqlite.prepare('SELECT webhook_url FROM agent_webhook_doorbells WHERE agent_id = ?').get(AGENT_B) as { webhook_url: string }
    expect(row.webhook_url).toBe('https://webhook.example/staff')
  })

  it('flag off: set is refused and a send makes no POST and no receipt', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: 'https://webhook.example/ceo', bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
    })
    const off = { ...env, WEBHOOK_DOORBELL: undefined } as unknown as Env
    const refused = await invokeTool(auth(), off, 'set_agent_webhook_doorbell', {
      webhook_url: 'https://webhook.example/ceo', bearer: DOORBELL_BEARER,
    }, 'https://pot.example')
    expect(refused.ok).toBe(false)
    expect(refused.error).toBe('webhook_doorbell_disabled')
    let calls = 0
    const res = await sendAgentMessage(off, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A, body: 'x', kind: 'message', requestId: 'rid-off',
    }, AUTHZ, { fetch: (async () => { calls += 1; return new Response('ok') }) as typeof fetch })
    expect(res.ok).toBe(true)
    expect(calls).toBe(0)
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM agent_webhook_doorbell_receipts').get()).toEqual({ n: 0 })
  })

  it('fireWebhookDoorbell itself is flag-gated (not only the scheduler in front of it)', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: 'https://webhook.example/ceo', bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
    })
    let calls = 0
    await fireWebhookDoorbell(
      { ...env, WEBHOOK_DOORBELL: undefined } as unknown as Env,
      { type: 'mupot.task.assigned', agent_id: AGENT_A, task_id: 't-1' },
      { fetch: (async () => { calls += 1; return new Response('ok') }) as typeof fetch },
    )
    expect(calls).toBe(0)
  })

  it.each([
    'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x',
    'https://169.254.169.254/latest', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:10.0.0.1]/x',
    'https://metadata.google.internal/x', 'https://svc.internal/x', 'https://webhook.example:8443/x',
    'https://user:pw@webhook.example/x',
  ])('set refuses %s', async (url) => {
    const out = await invokeTool(auth(), env, 'set_agent_webhook_doorbell', { webhook_url: url, bearer: DOORBELL_BEARER }, 'https://pot.example')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('invalid_webhook_url')
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM agent_webhook_doorbells').get()).toEqual({ n: 0 })
  })

  it('fire time re-checks the guard: a stored private URL is skipped, never fetched', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: 'https://webhook.example/ceo', bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
    })
    harness.sqlite.prepare('UPDATE agent_webhook_doorbells SET webhook_url = ? WHERE agent_id = ?').run('https://169.254.169.254/latest', AGENT_A)
    let calls = 0
    const pending: Promise<unknown>[] = []
    await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A, body: 'x', kind: 'message', requestId: 'rid-ssrf',
    }, AUTHZ, { fetch: (async () => { calls += 1; return new Response('ok') }) as typeof fetch, waitUntil: (p) => { pending.push(p) } })
    await Promise.all(pending)
    expect(calls).toBe(0)
    expect(harness.sqlite.prepare('SELECT outcome, reason FROM agent_webhook_doorbell_receipts').all()).toEqual([
      { outcome: 'skipped', reason: 'invalid_url' },
    ])
  })

  it('never follows redirects; a 3xx is a failed receipt; receipts hold status only', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: DOORBELL_URL, bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
    })
    const inits: RequestInit[] = []
    const pending: Promise<unknown>[] = []
    const logs = collectLogs()
    await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A, body: 'x', kind: 'message', requestId: 'rid-redir',
    }, AUTHZ, {
      fetch: (async (_u: string, init?: RequestInit) => { inits.push(init ?? {}); return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }) }) as unknown as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    await Promise.all(pending)
    logs.restore()
    expect(inits).toHaveLength(1)
    expect(inits[0].redirect).toBe('manual')
    const rows = harness.sqlite.prepare('SELECT * FROM agent_webhook_doorbell_receipts').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'failed', http_status: 302, event_type: 'mupot.inbox.wake', agent_id: AGENT_A })
    assertNoSecretLeak(JSON.stringify(rows))
  })

  it('a landed send writes a posted receipt', async () => {
    await setAgentWebhookDoorbell(env, {
      agentId: AGENT_A, webhookUrl: DOORBELL_URL, bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
    })
    const pending: Promise<unknown>[] = []
    await sendAgentMessage(env, {
      fromAgent: AGENT_B, fromMember: MEMBER_ID, toAgent: AGENT_A, body: 'x', kind: 'message', requestId: 'rid-ok',
    }, AUTHZ, { fetch: (async () => new Response('ok', { status: 200 })) as typeof fetch, waitUntil: (p) => { pending.push(p) } })
    await Promise.all(pending)
    expect(harness.sqlite.prepare('SELECT outcome, http_status FROM agent_webhook_doorbell_receipts').all()).toEqual([
      { outcome: 'posted', http_status: 200 },
    ])
  })

  describe('task assignment doorbell (mupot#1882)', () => {
    async function ring(args: Record<string, unknown>, toolAuth = humanAdminAuth({ type: 'org' })) {
      await setAgentWebhookDoorbell(env, {
        agentId: AGENT_B, webhookUrl: 'https://webhook.example/staff', bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
      })
      const bodies: unknown[] = []
      const pending: Promise<unknown>[] = []
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response('ok', { status: 200 })
      }) as typeof fetch
      try {
        const out = await invokeTool(toolAuth, env, 'task_create', {
          squad_id: SQUAD_ID, title: 'T', done_when: 'the task passes review checks', assignee_agent_id: AGENT_B, ...args,
        }, { origin: 'https://pot.example', transport: 'mcp', waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
        await Promise.all(pending)
        return { out, bodies }
      } finally {
        globalThis.fetch = realFetch
      }
    }

    it('task_create to an agent with a doorbell posts mupot.task.assigned with task_id', async () => {
      const { out, bodies } = await ring({})
      expect(out.ok).toBe(true)
      const taskId = (out.result as { task: { id: string } }).task.id
      expect(bodies).toEqual([{ type: 'mupot.task.assigned', agent_id: AGENT_B, task_id: taskId }])
    })

    it('a backlog-only create (dispatch:false) does not ring', async () => {
      const { out, bodies } = await ring({ dispatch: false })
      expect(out.ok).toBe(true)
      expect(bodies).toEqual([])
    })

    it('task_update ringing only on a real assignee change', async () => {
      await setAgentWebhookDoorbell(env, {
        agentId: AGENT_B, webhookUrl: 'https://webhook.example/staff', bearer: DOORBELL_BEARER, createdByMemberId: MEMBER_ID,
      })
      const created = await invokeTool(humanAdminAuth({ type: 'org' }), env, 'task_create', {
        squad_id: SQUAD_ID, title: 'T2', done_when: 'the task passes review checks', dispatch: false,
      }, 'https://pot.example')
      const taskId = (created.result as { task: { id: string } }).task.id
      const bodies: unknown[] = []
      const pending: Promise<unknown>[] = []
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('ok') }) as typeof fetch
      try {
        const ctx = { origin: 'https://pot.example', transport: 'mcp' as const, waitUntil: (p: Promise<unknown>) => { pending.push(p) } }
        const a = await invokeTool(humanAdminAuth({ type: 'org' }), env, 'task_update', { task_id: taskId, assignee_agent_id: AGENT_B }, ctx)
        expect(a.ok).toBe(true)
        const same = await invokeTool(humanAdminAuth({ type: 'org' }), env, 'task_update', { task_id: taskId, assignee_agent_id: AGENT_B }, ctx)
        expect(same.ok).toBe(true)
        await Promise.all(pending)
      } finally {
        globalThis.fetch = realFetch
      }
      expect(bodies).toEqual([{ type: 'mupot.task.assigned', agent_id: AGENT_B, task_id: taskId }])
    })
  })
})
