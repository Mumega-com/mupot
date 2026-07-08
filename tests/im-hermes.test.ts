import { beforeAll, describe, expect, it, vi } from 'vitest'
import { handleImMessage } from '../src/im'
import { verifyControlRequest } from '../src/fleet/control-request'
import type { Env } from '../src/types'

let panelPrivJwk = ''
let panelPubJwk = ''

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  panelPrivJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey))
  panelPubJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey))
})

function makeEnv(opts: { capability?: 'owner' | 'admin' | 'member' } = {}) {
  const inserts: unknown[][] = []
  const busEvents: unknown[] = []
  const messages: Array<{
    id: string
    seq: number
    tenant: string
    to_agent: string
    from_agent: string
    from_member: string
    kind: string
    body: string
    request_id: string | null
    in_reply_to: string | null
  }> = []
  const controlLog: unknown[][] = []
  let seq = 0

  const member = {
    id: 'mbr-hermes-user',
    email: 'hermes@mupot.test',
    display_name: 'Hermes Test Operator',
    telegram_chat_id: '123456789',
    status: 'active',
    created_at: '2026-07-07T00:00:00.000Z',
  }
  const squad = {
    id: 'sq-growth',
    department_id: 'dept-growth',
    slug: 'growth',
    name: 'Growth Local',
    charter: 'Local smoke squad',
    created_at: '2026-07-07T00:00:00.000Z',
  }
  const grants = [
    { member_id: member.id, scope_type: 'org', scope_id: null, capability: opts.capability ?? 'owner' },
  ]
  const fleetAgents = [
    {
      agent_id: 'hermes-local',
      display: 'Hermes Local Relay',
      runtime: 'hermes-cron',
      squads: '["growth"]',
      lifecycle: 'always_on',
      provider_contract: null,
      status: 'running',
      reported_by: 'local-seed',
      last_reported_at: '2026-07-07 00:00:00',
      agent_type: 'comms',
      member_id: member.id,
    },
  ]

  const DB = {
    prepare(sql: string) {
      const api = {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM members') && sql.includes('telegram_chat_id')) return member as T
              if (sql.includes('SELECT department_id FROM squads')) return { department_id: squad.department_id } as T
              if (sql.includes('FROM agent_messages') && sql.includes('from_agent = ?2 AND request_id = ?3')) {
                const [tenant, fromAgent, requestId] = args as [string, string, string]
                const found = messages.find(
                  (m) => m.tenant === tenant && m.from_agent === fromAgent && m.request_id === requestId,
                )
                return found
                  ? ({
                      id: found.id,
                      seq: found.seq,
                      to_agent: found.to_agent,
                      kind: found.kind,
                      body: found.body,
                      in_reply_to: found.in_reply_to,
                    } as T)
                  : null as T | null
              }
              return null as T | null
            },
            async all<T>() {
              if (sql.includes('FROM capabilities')) return { results: grants } as { results: T[] }
              if (sql.includes('FROM squads') && sql.includes('slug = ?1')) return { results: [squad] } as { results: T[] }
              if (sql.includes('FROM fleet_agents')) return { results: fleetAgents } as { results: T[] }
              return { results: [] } as { results: T[] }
            },
            async run() {
              if (sql.includes('INSERT INTO tasks')) inserts.push(args)
              if (sql.includes('INSERT INTO agent_messages')) {
                const [
                  id,
                  tenant,
                  toAgent,
                  fromAgent,
                  fromMember,
                  kind,
                  body,
                  requestId,
                  inReplyTo,
                ] = args as string[]
                const rowSeq = ++seq
                messages.push({
                  id,
                  seq: rowSeq,
                  tenant,
                  to_agent: toAgent,
                  from_agent: fromAgent,
                  from_member: fromMember,
                  kind,
                  body,
                  request_id: requestId ?? null,
                  in_reply_to: inReplyTo ?? null,
                })
                return { meta: { changes: 1, last_row_id: rowSeq } }
              }
              if (sql.includes('INSERT INTO fleet_control_log')) controlLog.push(args)
              return { meta: { changes: 1 } }
            },
          }
        },
      }
      return api
    },
  }

  const env = {
    TENANT_SLUG: 'local',
    DB,
    FLEET_PANEL_SK: panelPrivJwk,
    FLEET_CONSUMER_AGENT: 'agent-conformance',
    BUS: {
      send: vi.fn(async (event: unknown) => {
        busEvents.push(event)
      }),
    },
  } as unknown as Env

  return { env, inserts, busEvents, messages, controlLog }
}

describe('Hermes IM control', () => {
  it('quick-add creates a task with a real done_when predicate', async () => {
    const { env, inserts, busEvents } = makeEnv()

    const reply = await handleImMessage(env, 123456789, 'task: Ship local smoke @growth')

    expect(reply).toBe('Added to Growth Local: "Ship local smoke".')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toBe('sq-growth')
    expect(inserts[0][2]).toBe('Ship local smoke')
    expect(inserts[0][4]).toBe(
      'A task result or linked artifact provides evidence that the requested IM task is complete.',
    )
    expect(inserts[0][4]).not.toBe('(set via task update)')
    expect(busEvents).toEqual([
      expect.objectContaining({
        type: 'task.created',
        tenant: 'local',
        squad_id: 'sq-growth',
        actor: { kind: 'member', id: 'mbr-hermes-user' },
      }),
    ])
  })

  it('queues signed fleet control from an owner IM command', async () => {
    const { env, messages, controlLog, busEvents } = makeEnv()

    const reply = await handleImMessage(env, 123456789, 'fleet status hermes')

    expect(reply).toBe('Queued fleet status for Hermes Local Relay.')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      to_agent: 'agent-conformance',
      from_agent: 'fleet-panel',
      from_member: 'mbr-hermes-user',
      kind: 'request',
    })
    const request = JSON.parse(messages[0].body)
    expect(request).toMatchObject({ agent_id: 'hermes-local', verb: 'status' })
    expect(await verifyControlRequest(panelPubJwk, request)).toBe(true)
    expect(controlLog).toHaveLength(1)
    expect(busEvents).toContainEqual(
      expect.objectContaining({
        type: 'fleet.control.requested',
        tenant: 'local',
        agent_id: 'hermes-local',
        actor: { kind: 'member', id: 'mbr-hermes-user' },
      }),
    )
  })

  it('refuses fleet control without owner capability', async () => {
    const { env, messages, controlLog, busEvents } = makeEnv({ capability: 'admin' })

    const reply = await handleImMessage(env, 123456789, 'fleet stop hermes')

    expect(reply).toBe("You don't have permission to control fleet agents (need owner on the org).")
    expect(messages).toHaveLength(0)
    expect(controlLog).toHaveLength(0)
    expect(busEvents).toHaveLength(0)
  })
})
