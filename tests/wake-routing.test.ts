import { describe, expect, it, vi } from 'vitest'
import { mcpApp } from '../src/mcp'
import { handleImMessage } from '../src/im'
import type { Agent, BusEvent, CapabilityGrant, Env } from '../src/types'

const MEMBER_ID = 'member-wake-operator'
const AGENT_ID = '11111111-2222-4333-8444-555555555555'
const AGENT_SLUG = 'hadi-river'

const agent: Agent = {
  id: AGENT_ID,
  squad_id: 'squad-hadi-mac',
  slug: AGENT_SLUG,
  name: 'Hadi River',
  role: 'receiver engineer',
  model: 'test-model',
  status: 'active',
  kind: 'team',
  okr: null,
  kpi_target: null,
  kpi_progress: 0,
  effort: 'medium',
  autonomy: 'supervised',
  budget_cap_cents: null,
  budget_window: 'weekly',
  created_at: '2026-08-25 00:00:00',
  purpose: null,
  owner: null,
  model_fallback: null,
  capabilities: null,
  skills: null,
  parent_agent_id: null,
  qnft_ref: null,
  death_condition: null,
}

type StoredMessage = {
  seq: number
  toAgent: string
  fromAgent: string
  fromMember: string
  kind: string
  body: string
  requestId: string | null
}

function makeEnv(opts: {
  external?: 'live' | 'stale' | 'none'
  doStatus?: number
  doBody?: string
  failInbox?: boolean
} = {}) {
  const grants: CapabilityGrant[] = [
    { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'owner' },
  ]
  const messages: StoredMessage[] = []
  const busEvents: BusEvent[] = []
  const doFetch = vi.fn(async () => new Response(opts.doBody ?? '{"cycle":"ok"}', {
    status: opts.doStatus ?? 200,
    headers: { 'content-type': 'application/json' },
  }))
  let seq = 0

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM member_tokens')) {
                return {
                  member_id: MEMBER_ID,
                  token_id: 'token-wake',
                  email: 'wake@example.test',
                  display_name: 'Wake Operator',
                  telegram_chat_id: '123456789',
                  status: 'active',
                  created_at: '2026-08-25 00:00:00',
                  channel: 'workspace',
                  bound_agent_id: null,
                } as T
              }
              if (sql.includes('SELECT * FROM agents WHERE id = ?1')) {
                return (args[0] === AGENT_ID ? agent : null) as T
              }
              if (sql.includes('SELECT slug FROM agents WHERE id')) {
                return (args[0] === AGENT_ID ? { slug: AGENT_SLUG } : null) as T
              }
              if (sql.includes('SELECT COUNT(*) AS n FROM agents WHERE slug')) {
                return { n: args[0] === AGENT_SLUG ? 1 : 0 } as T
              }
              if (sql.includes('FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2')) {
                const requested = String(args[1])
                if (requested !== AGENT_SLUG || opts.external === 'none' || opts.external === undefined) return null as T
                return {
                  agent_id: AGENT_SLUG,
                  runtime: 'hermes',
                  status: 'running',
                  last_reported_at: opts.external === 'live'
                    ? new Date().toISOString().replace('T', ' ').slice(0, 19)
                    : '2020-01-01 00:00:00',
                } as T
              }
              if (sql.includes('FROM members') && sql.includes('telegram_chat_id')) {
                return {
                  id: MEMBER_ID,
                  email: 'wake@example.test',
                  display_name: 'Wake Operator',
                  telegram_chat_id: '123456789',
                  status: 'active',
                  created_at: '2026-08-25 00:00:00',
                } as T
              }
              if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
                const found = messages.find((row) => row.fromAgent === args[1] && row.requestId === args[2])
                return found
                  ? ({
                      id: `message-${found.seq}`,
                      seq: found.seq,
                      to_agent: found.toAgent,
                      kind: found.kind,
                      body: found.body,
                      in_reply_to: null,
                    } as T)
                  : null as T
              }
              return null as T
            },
            async all<T>() {
              if (sql.includes('FROM capabilities')) return { results: grants as T[] }
              if (sql.includes('FROM agents') && sql.includes('WHERE slug = ?1')) {
                return { results: args[0] === AGENT_SLUG ? [agent as T] : [] }
              }
              return { results: [] as T[] }
            },
            async run() {
              if (sql.includes('INSERT INTO agent_messages')) {
                if (opts.failInbox) throw new Error('D1_ERROR: private-database-detail')
                const row = {
                  seq: ++seq,
                  toAgent: String(args[2]),
                  fromAgent: String(args[3]),
                  fromMember: String(args[4]),
                  kind: String(args[5]),
                  body: String(args[6]),
                  requestId: args[7] == null ? null : String(args[7]),
                }
                messages.push(row)
                return { meta: { changes: 1, last_row_id: row.seq } }
              }
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }

  const env = {
    TENANT_SLUG: 'mumega',
    DB,
    BUS: { send: vi.fn(async (event: BusEvent) => { busEvents.push(event) }) },
    AGENT: {
      idFromName: vi.fn((id: string) => `do:${id}`),
      get: vi.fn(() => ({ fetch: doFetch })),
    },
  } as unknown as Env
  return { env, messages, busEvents, doFetch }
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
    const { env, messages, busEvents, doFetch } = makeEnv({ external: 'live' })

    const response = await wakeViaMcp(env, { reason: 'continue-flight' })

    expect(response.status).toBe(200)
    expect(doFetch).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0].toAgent).toBe(AGENT_SLUG)
    expect(messages[0].requestId).toMatch(/^wake:[A-Za-z0-9-]+$/)
    expect(JSON.parse(messages[0].body)).toMatchObject({
      type: 'agent.wake/v1',
      agent_id: AGENT_ID,
      reason: 'continue-flight',
      idempotency_key: messages[0].requestId,
    })
    expect(wakeObservation(busEvents)?.payload).toMatchObject({ already_routed: true, route: 'external_inbox' })
  })

  it('routes an internal runtime through AgentDO exactly once without a fallback envelope', async () => {
    const { env, messages, doFetch } = makeEnv({ external: 'none', doStatus: 200 })

    const response = await wakeViaMcp(env, { reason: 'internal-cycle' })

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(0)
  })

  it('falls back after a failed AgentDO to one durable envelope addressed to the canonical slug', async () => {
    const { env, messages, doFetch } = makeEnv({ external: 'stale', doStatus: 503 })

    const response = await wakeViaMcp(env, { reason: 'recover-receiver' })
    const body = await response.json() as { result: Record<string, unknown> }

    expect(response.status).toBe(200)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(1)
    expect(messages[0].toAgent).toBe(AGENT_SLUG)
    expect(body.result).toMatchObject({ route: 'fallback_inbox', delivered: true, seq: 1, duplicate: false })
  })

  it('returns fixed wake_failed when AgentDO and fallback both fail without reflecting raw bodies', async () => {
    const { env, messages, doFetch } = makeEnv({
      external: 'none',
      doStatus: 500,
      doBody: '{"secret":"do-private-detail"}',
      failInbox: true,
    })

    const response = await wakeViaMcp(env, { reason: 'fail-closed' })
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(doFetch).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(0)
    expect(text).toContain('wake_failed')
    expect(text).not.toContain('do-private-detail')
    expect(text).not.toContain('private-database-detail')
  })

  it('preserves reason, context, maxActions, canonical UUID and one idempotency key in a fallback envelope', async () => {
    const { env, messages } = makeEnv({ external: 'none', doStatus: 409 })

    await wakeViaMcp(env, {
      reason: 'flight-03-task-6',
      context: 'Resume from the durable checkpoint.',
      maxActions: 7.9,
    })

    expect(messages).toHaveLength(1)
    const envelope = JSON.parse(messages[0].body) as Record<string, unknown>
    expect(envelope).toEqual({
      type: 'agent.wake/v1',
      agent_id: AGENT_ID,
      reason: 'flight-03-task-6',
      context: 'Resume from the durable checkpoint.',
      maxActions: 7,
      idempotency_key: messages[0].requestId,
    })
  })

  it('uses the same durable external route from IM', async () => {
    const { env, messages, doFetch } = makeEnv({ external: 'live' })

    const reply = await handleImMessage(env, '123456789', `wake ${AGENT_SLUG}`)

    expect(reply).toBe("Woke Hadi River. It's running one cycle now.")
    expect(doFetch).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0].toAgent).toBe(AGENT_SLUG)
  })
})
