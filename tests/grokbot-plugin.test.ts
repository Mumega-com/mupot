// Grok Bot seat (mupot#1521): connect order, harness 'grokbot', flock presence, wake behind the flag.
//
// Schema from the migration chain. MCP calls go through mcpApp / invokeTool, never spec.run().
// WEBHOOK_DOORBELL is set only on the test env. This file does not touch a live flag.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { invokeTool, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { canonicalHarness } from '../src/fleet/reported-values'
import { sendAgentMessage } from '../src/agents/messages'
import { setAgentWebhookDoorbell } from '../src/agents/webhook-doorbell'
import { ATTACH_CONNECT_ORDER } from '../src/mcp/whoami'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const OWNER = 'member-org-owner'
const AGENT = 'agent-grokbot'
const ORIGIN = 'https://pot.test'
const DOORBELL_BEARER = 'super-secret-doorbell-key-XYZ'
const AUTHZ = { system: true, reason: 'test: grokbot wake' } as const

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      return v === undefined ? null : type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db,
    TENANT_SLUG: TENANT,
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: memoryKv(),
    SEAT_AUTO_ENROLL: '1',
    SEAT_ATTACH: '1',
    SEAT_ATTACH_DESIGNATED: '1',
    SEAT_MAX_PER_MEMBER: '100',
    ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let tokCounter = 0

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-25T00:00:00.000Z', '${TENANT}')`)
}

function seedAgent(): void {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', 'squad-core', 'grokbot-ceo', 'Grok Bot', 'r', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('mem-${AGENT}', 'Grok Bot', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AGENT}', 'mem-${AGENT}', '2026-10-25T00:00:00.000Z');
  `)
}

interface Grant { memberId: string; tokenId: string; ctx: AuthContext }

async function grant(env: Env, memberId: string): Promise<Grant> {
  const harness = await upsertHarness(env, memberId, 'client-grok', 'Grok')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-grok', 'directory', '2026-10-25T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, ctx }
}

interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  const result = (body.result ?? {}) as { structuredContent?: Record<string, unknown> }
  return { status: res.status, body, sc: result.structuredContent ?? {} }
}

const errOf = (r: Rpc): string => String(r.sc.error ?? '')
const whoamiOf = (r: Rpc): { state?: string; next_step_plain?: string } =>
  (r.sc.whoami ?? {}) as { state?: string; next_step_plain?: string }

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(OWNER)
  seedAgent()
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-owner-org', '${OWNER}', 'org', NULL, 'admin'), ('cap-human-org', '${HUMAN}', 'org', NULL, 'admin')`)
  resetHarnessProbeSampling()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

describe('grokbot is a recognised harness', () => {
  it('maps grokbot spellings to grokbot and leaves the Grok CLI on grok-cli', () => {
    expect(canonicalHarness('grokbot')).toBe('grokbot')
    expect(canonicalHarness('Grok-Bot')).toBe('grokbot')
    expect(canonicalHarness('grok bot')).toBe('grokbot')
    expect(canonicalHarness('grok')).toBe('grok-cli')
    expect(canonicalHarness('grok-tui')).toBe('grok-cli')
    expect(canonicalHarness('my-new-harness')).toBe('other')
  })
})

describe('check_in presence for harness grokbot', () => {
  const attached = (): AuthContext => ({
    userId: 'mem-agent',
    email: 'a@e.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'mem-agent',
    channel: 'directory',
    capabilities: [],
    boundAgentId: AGENT,
    seatBinding: {
      seatId: 'seat-1',
      label: 'grokbot-thread',
      harnessId: 'h1',
      grantTokenId: 't1',
      humanMemberId: HUMAN,
      source: 'handle',
      attached: {
        attachmentId: 'att-1',
        admissionId: 'adm-1',
        agentId: AGENT,
        seatAgentId: 'seat-agent',
        ceiling: 'member',
      },
    },
  }) as AuthContext

  beforeEach(() => {
    h.sqlite.exec(`
      INSERT INTO members (id, display_name, email, status, tenant) VALUES ('mem-agent', 'Grok Bot', 'a@e.test', 'active', '${TENANT}');
      INSERT INTO fleet_agents (agent_id, tenant, runtime, status, reported_by, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT}', '${TENANT}', 'claude-code', 'running', '${AGENT}', 'poll', 90, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    `)
  })

  const presence = () => h.sqlite.prepare(
    `SELECT harness, harness_canonical, source FROM presence WHERE label = 'grokbot-seat'`,
  ).get() as { harness: string; harness_canonical: string; source: string } | undefined
  const lastReported = () => (h.sqlite.prepare(`SELECT last_reported_at AS t FROM fleet_agents WHERE agent_id = ?`).get(AGENT) as { t: string }).t

  it('an attached grokbot check_in records flock presence and does not touch fleet liveness', async () => {
    const env = envFor(h)
    const out = await invokeTool(attached(), env, 'check_in', {
      seat: 'grokbot-seat',
      harness: 'grokbot',
      machine: 'grok-bot',
      model: 'grok-4',
      provider: 'xai',
      effort: 'high',
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({
      harness: 'grokbot',
      harness_canonical: 'grokbot',
      presence_recorded: true,
      debounced: false,
    })
    expect(presence()).toEqual({ harness: 'grokbot', harness_canonical: 'grokbot', source: 'grokbot' })
    expect(lastReported()).toBe('2026-01-01 00:00:00')
    const poll = await invokeTool(attached(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 30, harness: 'grokbot' }, ORIGIN)
    expect(JSON.stringify(poll)).toContain('attached_seat_cannot_set_presence_mode')
    expect(lastReported()).toBe('2026-01-01 00:00:00')
  })

  it('an attached check_in as any other harness still records nothing', async () => {
    const env = envFor(h)
    const out = await invokeTool(attached(), env, 'check_in', {
      seat: 'grokbot-seat',
      harness: 'claude-code',
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({ harness_canonical: 'claude-code', presence_recorded: false })
    expect(presence()).toBeUndefined()
    // A second check_in on the same seat label is debounced for 30s and omits presence_recorded.
    // 'grok' (Grok CLI) must still record nothing, on its own seat, and stay grok-cli.
    const cli = await invokeTool(attached(), env, 'check_in', { seat: 'grok-cli-seat', harness: 'grok' }, ORIGIN)
    expect(cli.ok).toBe(true)
    if (cli.ok) expect(cli.result).toMatchObject({ harness_canonical: 'grok-cli', presence_recorded: false, debounced: false })
    expect(presence()).toBeUndefined()
    const cliRow = h.sqlite.prepare(`SELECT harness FROM presence WHERE label = 'grok-cli-seat'`).get()
    expect(cliRow).toBeUndefined()
    expect(lastReported()).toBe('2026-01-01 00:00:00')
  })
})

describe('boot_context prints the connect order before seat_attach', () => {
  it('an unattached own seat names Allow for me, the 409, admit, and peek-only', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const cold = await rpc(env, g.ctx, 'boot_context', {})
    expect(whoamiOf(cold).state).toBe('harness_unseated')
    expect(whoamiOf(cold).next_step_plain).toContain('seat_select {project, folder, thread}')
    expect(whoamiOf(cold).next_step_plain).toContain(ATTACH_CONNECT_ORDER)

    const selected = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', thread: 'grok-thread', squad: 'core' })
    const handle = selected.sc.seat_handle
    expect(typeof handle).toBe('string')
    expect(String(handle)).toMatch(/^mseat_/)

    const seated = await rpc(env, g.ctx, 'boot_context', { seat: String(handle) })
    expect(whoamiOf(seated).state).toBe('own_seat')
    expect(whoamiOf(seated).next_step_plain).toContain(ATTACH_CONNECT_ORDER)
    expect(String(seated.sc.next_step)).toContain('agent_not_designated_for_you')
    expect(String(seated.sc.next_step)).toContain('Allow for me')
    expect(String(seated.sc.next_step)).toContain('/connections')
    expect(String(seated.sc.next_step)).toContain('inbox {peek:true}')
    const door = (seated.sc.available_doors as Array<{ tool: string; does: string }>)
      .find((d) => d.tool === 'seat_attach')
    expect(door?.does).toMatch(/Allow for me/)
    expect(door?.does).toMatch(/passkey/)
  })

  it('an agent-bound boot records runtime grokbot with canonical grokbot', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO fleet_agents (agent_id, tenant, runtime, status, reported_by, last_reported_at)
      VALUES ('${AGENT}', '${TENANT}', 'grok', 'running', 'daemon', datetime('now'))`)
    const auth = {
      userId: 'mem-agent', email: 'a@e.test', role: 'member', tenant: TENANT,
      memberId: `mem-${AGENT}`, channel: 'workspace', capabilities: [], boundAgentId: AGENT,
    } as AuthContext
    const out = await invokeTool(auth, env, 'boot_context', { runtime: 'grokbot', model: 'grok-4', host: 'grok-bot' }, ORIGIN)
    expect(out.ok).toBe(true)
    const row = h.sqlite.prepare(`SELECT runtime, runtime_canonical FROM fleet_agents WHERE agent_id = ?`).get(AGENT) as
      { runtime: string; runtime_canonical: string }
    expect(row).toEqual({ runtime: 'grokbot', runtime_canonical: 'grokbot' })
  })
})

describe('seat_attach before designation is refused', () => {
  it('returns 409 agent_not_designated_for_you, then pending_admission once the human presses Allow for me', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const selected = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', thread: 'grok-thread', squad: 'core' })
    const handle = String(selected.sc.seat_handle)
    expect(handle).toMatch(/^mseat_/)

    const refused = await rpc(env, g.ctx, 'seat_attach', { agent: 'grokbot-ceo', seat: handle })
    expect(refused.sc.ok).toBe(false)
    expect(errOf(refused)).toBe('agent_not_designated_for_you')
    const detail = (refused.sc.detail ?? {}) as { next_step?: string; who_acts?: string }
    expect(detail.who_acts).toBe('owner')
    expect(detail.next_step).toContain('Allow for me')
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_seat_admissions`).get() as { n: number }).toMatchObject({ n: 0 })

    const owner: AuthContext = {
      userId: OWNER, email: 'op@example.test', role: 'member', tenant: TENANT, channel: 'workspace',
      memberId: OWNER, boundAgentId: null,
      capabilities: [{ member_id: OWNER, scope_type: 'org', scope_id: null, capability: 'admin' }],
    } as AuthContext
    const designated = await invokeTool(owner, env, 'update_agent', { agent: AGENT, attach_designated_member_id: HUMAN }, ORIGIN)
    expect(designated.ok, JSON.stringify(designated)).toBe(true)

    const pending = await rpc(env, g.ctx, 'seat_attach', { agent: 'grokbot-ceo', seat: handle })
    expect(pending.sc.status, JSON.stringify(pending.sc)).toBe('pending_admission')
    expect(pending.sc.attach_code ?? pending.sc.approve_url).toBeTruthy()
    expect((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_seat_admissions`).get() as { n: number }).n).toBe(1)
  })
})

describe('wake behind WEBHOOK_DOORBELL', () => {
  const SENDER = 'agent-sender'

  beforeEach(() => {
    h.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${SENDER}', 'squad-core', 'sender', 'Sender', 'r', 'm', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('mem-sender', 'Sender', 'active', '${TENANT}');
    `)
  })

  it('flag on: a landed send POSTs mupot.inbox.wake with the bearer; flag off: no register and no POST', async () => {
    const master = 'a'.repeat(64)
    const on = envFor(h, { WEBHOOK_DOORBELL: '1', CONNECTOR_MASTER_KEY: master })
    const set = await setAgentWebhookDoorbell(on, {
      agentId: AGENT,
      webhookUrl: 'https://webhook.example/grokbot/wake',
      bearer: DOORBELL_BEARER,
      createdByMemberId: OWNER,
    })
    expect(set.ok).toBe(true)

    const fetches: Array<{ url: string; init: RequestInit }> = []
    const pending: Promise<unknown>[] = []
    const res = await sendAgentMessage(on, {
      fromAgent: SENDER,
      fromMember: OWNER,
      toAgent: AGENT,
      body: 'wake the bot',
      kind: 'message',
      requestId: 'rid-grokbot-wake',
    }, AUTHZ, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        fetches.push({ url: String(url), init: init ?? {} })
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await Promise.all(pending)
    expect(fetches).toHaveLength(1)
    expect(fetches[0].url).toBe('https://webhook.example/grokbot/wake')
    const headers = fetches[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${DOORBELL_BEARER}`)
    expect(JSON.parse(String(fetches[0].init.body))).toEqual({
      type: 'mupot.inbox.wake',
      agent_id: AGENT,
      seq: res.seq,
      message_id: res.id,
      kind: 'message',
    })

    const off = envFor(h, { WEBHOOK_DOORBELL: undefined, CONNECTOR_MASTER_KEY: master })
    const refused = await setAgentWebhookDoorbell(off, {
      agentId: SENDER,
      webhookUrl: 'https://webhook.example/other',
      bearer: DOORBELL_BEARER,
      createdByMemberId: OWNER,
    })
    expect(refused).toEqual({ ok: false, error: 'webhook_doorbell_disabled' })
    let calls = 0
    const quiet = await sendAgentMessage(off, {
      fromAgent: SENDER, fromMember: OWNER, toAgent: AGENT,
      body: 'flag off', kind: 'message', requestId: 'rid-grokbot-off',
    }, AUTHZ, {
      fetch: (async () => { calls += 1; return new Response('ok') }) as typeof fetch,
      waitUntil: (p) => { pending.push(p) },
    })
    await Promise.all(pending)
    expect(quiet.ok).toBe(true)
    // The flag-off send does not add a POST. The earlier flag-on send already fetched once.
    expect(calls).toBe(0)
    expect(fetches).toHaveLength(1)
  })
})
