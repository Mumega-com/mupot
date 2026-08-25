import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpApp } from '../src/mcp'
import { handleImMessage } from '../src/im'
import type { BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const MEMBER_ID = 'member-wake-operator'
const AGENT_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_AGENT_ID = '66666666-7777-4888-8999-000000000000'
const AGENT_SLUG = 'hadi-river'
const WAKE_TOKEN_HASH = '15262cc64a0a02d7c114cd40cb31ed04e1848f956dc7cc7c7d6385a1168da667'

type StoredMessage = {
  seq: number
  to_agent: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
}

const harnesses: SqliteD1Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
})

function seedCore(harness: SqliteD1Harness): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-hadi', 'hadi', 'Hadi');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-hadi-mac', 'dept-hadi', 'hadi-mac', 'Hadi Mac');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES (
        '${AGENT_ID}', 'squad-hadi-mac', '${AGENT_SLUG}', 'Hadi River',
        'receiver engineer', 'test-model', 'active'
      );
    INSERT INTO members (
      id, email, display_name, telegram_chat_id, status, tenant
    ) VALUES (
      '${MEMBER_ID}', 'wake@example.test', 'Wake Operator', '123456789', 'active', '${TENANT}'
    );
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, agent_id, tenant, expires_at
    ) VALUES (
      'token-wake', '${MEMBER_ID}', '${WAKE_TOKEN_HASH}', 'wake test', 'workspace', NULL,
      '${TENANT}', NULL
    );
    INSERT INTO capabilities (
      id, member_id, scope_type, scope_id, capability
    ) VALUES (
      'cap-wake-owner', '${MEMBER_ID}', 'org', NULL, 'owner'
    );
  `)
}

function addFleetRow(harness: SqliteD1Harness, live: boolean): void {
  harness.sqlite.prepare(
    `INSERT INTO fleet_agents (
       agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    AGENT_SLUG,
    TENANT,
    'Hadi River',
    'hermes',
    '["squad-hadi-mac"]',
    'always_on',
    'running',
    'test-host',
    live ? new Date().toISOString().replace('T', ' ').slice(0, 19) : '2020-01-01 00:00:00',
  )
}

function addDuplicateSlugAgent(harness: SqliteD1Harness): void {
  harness.sqlite.exec(`
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-other', 'dept-hadi', 'other', 'Other');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES (
        '${OTHER_AGENT_ID}', 'squad-other', '${AGENT_SLUG}', 'Other River',
        'member', 'test-model', 'active'
      );
  `)
}

function fillInbox(harness: SqliteD1Harness, recipient: string): void {
  harness.sqlite.prepare(
    `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000
     )
     INSERT INTO agent_messages (
       id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at
     )
     SELECT 'prefill-' || x, ?, ?, 'prefill-sender', 'prefill-member', 'message', 'x', NULL,
            '2026-08-25 00:00:00'
       FROM n`,
  ).run(TENANT, recipient)
}

function storedMessages(harness: SqliteD1Harness): StoredMessage[] {
  return harness.sqlite.prepare(
    `SELECT seq, to_agent, from_agent, from_member, kind, body, request_id
       FROM agent_messages
      WHERE from_agent = 'mupot-wake-router'
      ORDER BY seq`,
  ).all() as StoredMessage[]
}

function makeEnv(opts: {
  external?: 'live' | 'stale' | 'none'
  doStatus?: number
  doBody?: string
  throwDoFetch?: boolean
  duplicateSlug?: boolean
  fullInbox?: boolean
} = {}) {
  const harness = createSqliteD1()
  harnesses.push(harness)
  applyAllMigrations(harness.sqlite)
  seedCore(harness)
  if (opts.external === 'live' || opts.external === 'stale') {
    addFleetRow(harness, opts.external === 'live')
  }
  if (opts.duplicateSlug) addDuplicateSlugAgent(harness)
  if (opts.fullInbox) fillInbox(harness, AGENT_ID)

  const busEvents: BusEvent[] = []
  const doFetch = vi.fn(async () => {
    if (opts.throwDoFetch) throw new Error('observed AgentDO transport failure')
    return new Response(opts.doBody ?? '{"cycle":"ok"}', {
      status: opts.doStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const env = {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    BUS: { send: vi.fn(async (event: BusEvent) => { busEvents.push(event) }) },
    AGENT: {
      idFromName: vi.fn((id: string) => `do:${id}`),
      get: vi.fn(() => ({ fetch: doFetch })),
    },
  } as unknown as Env
  return { env, harness, busEvents, doFetch }
}

async function wakeViaMcp(env: Env, args: Record<string, unknown> = {}) {
  return mcpApp.request('https://pot.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wake-token' },
    body: JSON.stringify({ tool: 'wake_agent', args: { agent_id: AGENT_ID, ...args } }),
  }, env)
}

function wakeObservation(events: BusEvent[]) {
  return events.find((event) => event.type === 'agent.wake')
}

describe('shared external-agent wake routing', () => {
  it('routes a live external runtime to one durable envelope at its resolved identity without AgentDO', async () => {
    const { env, harness, busEvents, doFetch } = makeEnv({ external: 'live' })

    const response = await wakeViaMcp(env, { reason: 'continue-flight' })
    const messages = storedMessages(harness)

    expect(response.status).toBe(200)
    expect(doFetch).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0].to_agent).toBe(AGENT_SLUG)
    expect(messages[0].request_id).toMatch(/^wake:[A-Za-z0-9-]+$/)
    expect(JSON.parse(messages[0].body)).toMatchObject({
      type: 'agent.wake/v1',
      agent_id: AGENT_ID,
      reason: 'continue-flight',
      idempotency_key: messages[0].request_id,
    })
    expect(wakeObservation(busEvents)?.payload).toMatchObject({ already_routed: true, route: 'external_inbox' })
  })

  it('routes an internal runtime through AgentDO exactly once without a fallback envelope', async () => {
    const { env, harness, doFetch } = makeEnv({ external: 'none', doStatus: 200 })

    const response = await wakeViaMcp(env, { reason: 'internal-cycle' })

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(storedMessages(harness)).toHaveLength(0)
  })

  it('falls back after a failed AgentDO to one durable envelope at the stale resolved fleet identity', async () => {
    const { env, harness, doFetch } = makeEnv({ external: 'stale', doStatus: 503 })

    const response = await wakeViaMcp(env, { reason: 'recover-receiver' })
    const body = await response.json() as { result: Record<string, unknown> }
    const messages = storedMessages(harness)

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
    expect(messages[0].to_agent).toBe(AGENT_SLUG)
    expect(body.result).toMatchObject({ route: 'fallback_inbox', delivered: true, duplicate: false })
  })

  it('falls back to the canonical UUID when a cross-squad duplicate slug makes fleet identity ambiguous', async () => {
    const { env, harness, doFetch } = makeEnv({
      external: 'stale',
      doStatus: 503,
      duplicateSlug: true,
    })

    const response = await wakeViaMcp(env, { reason: 'collision-safe-fallback' })
    const messages = storedMessages(harness)

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
    expect(messages[0].to_agent).toBe(AGENT_ID)
    expect(messages[0].to_agent).not.toBe(AGENT_SLUG)
  })

  it('performs the same durable fallback when AgentDO fetch rejects before returning a response', async () => {
    const { env, harness, doFetch } = makeEnv({ external: 'stale', throwDoFetch: true })

    const response = await wakeViaMcp(env, { reason: 'transport-failure-fallback' })
    const messages = storedMessages(harness)

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
    expect(messages[0].to_agent).toBe(AGENT_SLUG)
  })

  it('returns fixed wake_failed when AgentDO and fallback both fail without reflecting raw bodies', async () => {
    const { env, harness, doFetch } = makeEnv({
      external: 'none',
      doStatus: 500,
      doBody: '{"secret":"do-private-detail"}',
      fullInbox: true,
    })

    const response = await wakeViaMcp(env, { reason: 'fail-closed' })
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(storedMessages(harness)).toHaveLength(0)
    expect(text).toContain('wake_failed')
    expect(text).not.toContain('do-private-detail')
  })

  it('preserves reason, context, maxActions, canonical UUID and one idempotency key in a fallback envelope', async () => {
    const { env, harness } = makeEnv({ external: 'none', doStatus: 409 })

    await wakeViaMcp(env, {
      reason: 'flight-03-task-6',
      context: 'Resume from the durable checkpoint.',
      maxActions: 7.9,
    })

    const messages = storedMessages(harness)
    expect(messages).toHaveLength(1)
    expect(messages[0].to_agent).toBe(AGENT_ID)
    const envelope = JSON.parse(messages[0].body) as Record<string, unknown>
    expect(envelope).toEqual({
      type: 'agent.wake/v1',
      agent_id: AGENT_ID,
      reason: 'flight-03-task-6',
      context: 'Resume from the durable checkpoint.',
      maxActions: 7,
      idempotency_key: messages[0].request_id,
    })
  })

  it('reports synchronous execution from IM only for the AgentDO route', async () => {
    const { env, harness, doFetch } = makeEnv({ external: 'none', doStatus: 200 })

    const reply = await handleImMessage(env, '123456789', `wake ${AGENT_SLUG}`)

    expect(reply).toBe("Woke Hadi River. It's running one cycle now.")
    expect(doFetch).toHaveBeenCalledOnce()
    expect(storedMessages(harness)).toHaveLength(0)
  })

  it('reports durable acceptance from IM without claiming an external cycle is running', async () => {
    const { env, harness, doFetch } = makeEnv({ external: 'live' })

    const reply = await handleImMessage(env, '123456789', `wake ${AGENT_SLUG}`)

    expect(reply).toBe('Wake request for Hadi River was durably queued.')
    expect(doFetch).not.toHaveBeenCalled()
    expect(storedMessages(harness)).toHaveLength(1)
  })
})
