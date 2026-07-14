import { describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { handleQueue } from '../src/bus/consumer'
import type { BusEvent, Env } from '../src/types'
import { postAgentActivity } from '../src/channels'

vi.mock('../src/channels', () => ({ postAgentActivity: vi.fn(async () => undefined) }))

function message(event: BusEvent) {
  return {
    id: 'message-1',
    attempts: 1,
    body: event,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function envForWake(responseStatus: number): Env {
  return {
    AGENT: {
      idFromName: vi.fn(() => 'agent-do-id'),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status: responseStatus })) })),
    },
  } as unknown as Env
}

describe('bus queue consumer', () => {
  it('acknowledges terminal observation events', async () => {
    const item = message({
      type: 'task.updated',
      tenant: 'test',
      payload: {},
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, envForWake(200))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('retries a failed AgentDO wake so Cloudflare can apply the configured DLQ policy', async () => {
    const item = message({
      type: 'agent.wake',
      tenant: 'test',
      agent_id: 'missing-agent',
      payload: {},
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, envForWake(409))

    expect(item.retry).toHaveBeenCalledOnce()
    expect(item.ack).not.toHaveBeenCalled()
  })

  it('marks a task dispatch receipt consumed after the assigned AgentDO accepts the wake', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status: 200 })) })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: null, claim_expires_at: null, execution_receipt_id: null,
                  execution_claim_expires_at: null, task_status: 'open',
                }
              : null),
            run,
          })),
        })),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake',
      tenant: 'test',
      agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(run).toHaveBeenCalledTimes(2)
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('deduplicates repeated task dispatch receipts before waking AgentDO', async () => {
    let claimed = false
    let consumed = false
    const run = vi.fn(async (sql: string) => {
      if (sql.includes('SET claimed_at')) {
        if (claimed) return { meta: { changes: 0 } }
        claimed = true
        return { meta: { changes: 1 } }
      }
      if (sql.includes('SET consumed_at')) consumed = true
      return { meta: { changes: 1 } }
    })
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: consumed ? '2026-07-10T00:00:01.000Z' : null,
                  claim_expires_at: claimed ? Date.now() + 30_000 : null,
                  execution_receipt_id: null,
                  execution_claim_expires_at: null,
                  task_status: 'open',
                }
              : null),
            run: () => run(sql),
          })),
        })),
      },
    } as unknown as Env
    const event: BusEvent = {
      type: 'agent.wake',
      tenant: 'test',
      agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    }
    const first = message(event)
    const duplicate = message(event)

    await handleQueue({ messages: [first, duplicate] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(first.ack).toHaveBeenCalledOnce()
    expect(duplicate.ack).toHaveBeenCalledOnce()
    expect(first.retry).not.toHaveBeenCalled()
    expect(duplicate.retry).not.toHaveBeenCalled()
  })

  it('retries an active dispatch lease instead of acknowledging work another consumer may lose', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: null, claim_expires_at: Date.now() + 30_000, execution_receipt_id: null,
                  execution_claim_expires_at: null, task_status: 'open',
                }
              : null),
            run: vi.fn(async () => ({ meta: { changes: 0 } })),
          })),
        })),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledOnce()
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
    expect(item.ack).not.toHaveBeenCalled()
  })

  it('reclaims an expired dispatch lease and wakes the assigned AgentDO', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const run = vi.fn(async () => ({ meta: { changes: 1 } }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: null, claim_expires_at: Date.now() - 1, execution_receipt_id: null,
                  execution_claim_expires_at: null, task_status: 'open',
                }
              : null),
            run,
          })),
        })),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('recovers after AgentDO accepted the receipt without waking it a second time', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const run = vi.fn(async () => ({ meta: { changes: 1 } }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: null, claim_expires_at: Date.now() + 30_000,
                  execution_receipt_id: 'receipt-1', execution_claim_expires_at: null,
                  task_status: 'done',
                }
              : null),
            run,
          })),
        })),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('retries while the same receipt still owns an active task execution lease', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const run = vi.fn(async () => ({ meta: { changes: 0 } }))
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
              ? {
                  consumed_at: null, claim_expires_at: Date.now() - 1,
                  execution_receipt_id: 'receipt-1',
                  execution_claim_expires_at: Date.now() + 30_000,
                  task_status: 'in_progress',
                }
              : null),
            run,
          })),
        })),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledOnce()
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
    expect(item.ack).not.toHaveBeenCalled()
  })

  it('blocks an interrupted task after its execution lease expires without a second wake', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const run = vi.fn(async () => ({ meta: { changes: 1 } }))
    const statements: string[] = []
    const env = {
      AGENT: {
        idFromName: vi.fn(() => 'agent-do-id'),
        get: vi.fn(() => ({ fetch })),
      },
      DB: {
        prepare: vi.fn((sql: string) => {
          statements.push(sql)
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => sql.includes('FROM task_dispatch_receipts')
                ? {
                    consumed_at: null, claim_expires_at: Date.now() - 1,
                    execution_receipt_id: 'receipt-1', execution_claim_expires_at: Date.now() - 1,
                    task_status: 'in_progress',
                  }
                : null),
              run,
            })),
          }
        }),
      },
    } as unknown as Env
    const item = message({
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-10T00:00:00.000Z',
    })

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(statements.some((sql) => sql.includes("SET status = 'blocked'"))).toBe(true)
    expect(statements.find((sql) => sql.includes("SET status = 'blocked'"))).not.toContain('assignee_agent_id')
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent terminal flight events by durable outbox id', async () => {
    let consumed = false
    const run = vi.fn(async () => {
      if (consumed) return { meta: { changes: 0 } }
      consumed = true
      return { meta: { changes: 1 } }
    })
    const env = {
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })) },
    } as unknown as Env
    const event: BusEvent = {
      type: 'flight.landed', tenant: 'test', agent_id: 'agent-product',
      actor: { kind: 'agent', id: 'agent-product' },
      payload: { outbox_id: 'outbox-1', flight_id: 'flight-1' },
      ts: '2026-07-10T00:00:00.000Z',
    }
    const first = message(event)
    const duplicate = message(event)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await handleQueue({ messages: [first, duplicate] } as unknown as MessageBatch<BusEvent>, env)

    expect(run).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(postAgentActivity).toHaveBeenCalledTimes(1)
    expect(first.ack).toHaveBeenCalledOnce()
    expect(duplicate.ack).toHaveBeenCalledOnce()
    expect(first.retry).not.toHaveBeenCalled()
    expect(duplicate.retry).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

// ── S353 v2 — route-to-one-executor dispatch bridge ─────────────────────────────────────────
// v1 (commit bbec719) failed the adversarial gate with 2 HIGH blockers: silent delivery loss
// (BLOCK-1) and double execution (BLOCK-2) — see src/bus/fleet-bridge.ts's header comment and
// issue #353 for the full trap writeups. These tests drive the REAL consumer path (handleQueue
// → routeEvent) against a faithful in-memory D1 covering task_dispatch_receipts/tasks (the
// pre-existing state machine, unchanged) PLUS fleet_agents + agent_messages (the new route
// decision + delivery) — not a mock of the functions under test.
describe('S353 v2 — route-to-one-executor dispatch bridge', () => {
  interface ReceiptState {
    consumedAt: string | null
    claimExpiresAt: number | null
    executionReceiptId: string | null
    executionClaimExpiresAt: number | null
    taskStatus: string
  }
  interface MsgRow {
    seq: number; id: string; tenant: string; to_agent: string; from_agent: string
    from_member: string; kind: string; body: string; request_id: string | null; created_at: string; read_at: string | null
  }
  // `agent_id` is the fleet_agents row's OWN identity — deliberately DIFFERENT from the
  // dispatch event's `agent_id` (event.agent_id is always agents.id, a uuid; fleet_agents rows
  // are keyed by whatever the real attach call declared — a slug, per the live mumega tenant DB,
  // 2026-07-14). This lets the tests prove delivery targets the RESOLVED identity, not the raw
  // event.agent_id (the identifier-space bridge fix in src/fleet/registry.ts).
  interface FleetRow { agentId: string; runtime: string; status: string; last_reported_at: string }

  function makeWorld(opts: {
    receipt?: Partial<ReceiptState>
    fleet?: FleetRow | null
    fleetTenant?: string
    /** Force the first N `INSERT INTO agent_messages` calls to throw a generic (non-cap,
     *  non-unique) failure — simulates a transient delivery failure for the BLOCK-1 regression. */
    failInsertNTimes?: number
    prefillUnread?: number
  } = {}) {
    const receipt: ReceiptState = {
      consumedAt: null, claimExpiresAt: null, executionReceiptId: null,
      executionClaimExpiresAt: null, taskStatus: 'open',
      ...opts.receipt,
    }
    const fleet = opts.fleet ?? null
    const fleetTenant = opts.fleetTenant ?? 'test'
    const messages: MsgRow[] = []
    let seqCounter = 0
    let insertFailuresLeft = opts.failInsertNTimes ?? 0
    if (opts.prefillUnread) {
      for (let i = 0; i < opts.prefillUnread; i++) {
        seqCounter++
        messages.push({
          seq: seqCounter, id: `pre-${i}`, tenant: 'test', to_agent: 'agent-1-ext', from_agent: 'someone-else',
          from_member: 'm', kind: 'message', body: 'x', request_id: null,
          created_at: '2026-07-14T00:00:00.000Z', read_at: null,
        })
      }
    }

    function first(sql: string, b: unknown[]) {
      if (sql.includes('FROM task_dispatch_receipts')) {
        return {
          consumed_at: receipt.consumedAt,
          claim_expires_at: receipt.claimExpiresAt,
          execution_receipt_id: receipt.executionReceiptId,
          execution_claim_expires_at: receipt.executionClaimExpiresAt,
          task_status: receipt.taskStatus,
        }
      }
      // readFleetAgentRow (src/fleet/registry.ts) now does up to 3 sequential queries instead of
      // one JOIN: (1) exact fleet_agents.agent_id match, (2) this agent's own slug, (3) a
      // tenant-wide slug-collision COUNT, (4) the slug-keyed fleet_agents match. (1) and (4) are
      // the SAME sql text (only the bound agent_id differs), so both are handled by the first
      // branch below. This mock models a single dispatched agent ('agent-1', standing in for
      // agents.id) whose slug is 'agent-1-ext' — the id↔slug ambiguity-refusal logic itself is
      // exercised for real (real SQLite, not this string-matched mock) in
      // tests/fleet-agent-liveness.test.ts.
      if (sql.includes('FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2')) {
        const [tenant, agentIdParam] = b as [string, string]
        if (!fleet || tenant !== fleetTenant || agentIdParam !== fleet.agentId) return null
        return { agent_id: fleet.agentId, runtime: fleet.runtime, status: fleet.status, last_reported_at: fleet.last_reported_at }
      }
      if (sql.includes('SELECT slug FROM agents WHERE id')) {
        const [agentIdParam] = b as [string]
        return agentIdParam === 'agent-1' ? { slug: 'agent-1-ext' } : null
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM agents WHERE slug')) {
        const [slugParam] = b as [string]
        return slugParam === 'agent-1-ext' ? { n: 1 } : { n: 0 }
      }
      if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
        const [tenant, fromAgent, requestId] = b as [string, string, string]
        const m = messages.find((x) => x.tenant === tenant && x.from_agent === fromAgent && x.request_id === requestId)
        return m ? { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: null } : null
      }
      throw new Error('unhandled first: ' + sql)
    }

    function run(sql: string, b: unknown[]) {
      if (sql.includes('SET claimed_at = ?, claim_expires_at = ?, last_error = NULL')) {
        const [, expiresAt, , , , , now] = b as [string, number, string, string, string, string, number]
        if (receipt.consumedAt !== null) return { meta: { changes: 0 } }
        if (receipt.claimExpiresAt !== null && receipt.claimExpiresAt > now) return { meta: { changes: 0 } }
        receipt.claimExpiresAt = expiresAt
        return { meta: { changes: 1 } }
      }
      if (sql.includes('attempts = attempts + 1')) {
        const [, , , , , leaseExpiresAt] = b as [string, string, string, string, string, number]
        if (receipt.claimExpiresAt !== leaseExpiresAt) return { meta: { changes: 0 } }
        receipt.claimExpiresAt = null
        return { meta: { changes: 1 } }
      }
      if (sql.includes('SET consumed_at = ?')) {
        if (receipt.consumedAt !== null) return { meta: { changes: 0 } }
        receipt.consumedAt = '2026-07-14T00:00:01.000Z'
        receipt.claimExpiresAt = null
        return { meta: { changes: 1 } }
      }
      if (sql.includes('INSERT INTO agent_messages')) {
        if (insertFailuresLeft > 0) {
          insertFailuresLeft--
          throw new Error('D1_ERROR: simulated transient failure')
        }
        const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, , created_at, maxUnread] =
          b as [string, string, string, string, string, string, string, string | null, string | null, string, number]
        const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
        if (typeof maxUnread === 'number' && unread >= maxUnread) return { meta: { changes: 0 } }
        if (request_id != null && messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)) {
          throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
        }
        const seq = ++seqCounter
        messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at, read_at: null })
        return { meta: { last_row_id: seq, changes: 1 } }
      }
      throw new Error('unhandled run: ' + sql)
    }

    return {
      _messages: messages,
      _receipt: receipt,
      prepare(sql: string) {
        const binds: unknown[] = []
        const api = {
          bind(...a: unknown[]) { binds.push(...a); return api },
          async first<T>() { return first(sql, binds) as T },
          async run() { return run(sql, binds) },
        }
        return api
      },
    }
  }

  function envWith(db: ReturnType<typeof makeWorld>, fetchStatus = 200, tenant = 'test') {
    const fetch = vi.fn(async () => new Response(null, { status: fetchStatus }))
    const env = {
      TENANT_SLUG: tenant,
      AGENT: { idFromName: vi.fn(() => 'agent-do-id'), get: vi.fn(() => ({ fetch })) },
      DB: db,
    } as unknown as Env
    return { env, fetch }
  }

  function dispatchEvent(overrides: Partial<BusEvent> = {}): BusEvent {
    return {
      type: 'agent.wake', tenant: 'test', agent_id: 'agent-1',
      actor: { kind: 'member', id: 'member-1' },
      payload: { task_id: 'task-1', dispatch_receipt_id: 'receipt-1' },
      ts: '2026-07-14T00:00:00.000Z',
      ...overrides,
    }
  }

  // agentId is deliberately NOT 'agent-1' (the dispatch event's agent_id, a stand-in for the
  // agents.id uuid) — it stands in for the SLUG a real fleet_agents row is keyed by, so these
  // tests prove delivery targets the resolved identity, not the raw event.agent_id.
  const LIVE_RUNTIME: FleetRow = { agentId: 'agent-1-ext', runtime: 'claude-code', status: 'running', last_reported_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }
  const STALE_RUNTIME: FleetRow = { agentId: 'agent-1-ext', runtime: 'claude-code', status: 'running', last_reported_at: '2020-01-01 00:00:00' }

  it('external route: delivers to the RESOLVED fleet identity (not the raw event.agent_id), does NOT wake in-Worker, consumes the receipt', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(db._messages).toHaveLength(1)
    // The dispatch event's agent_id is 'agent-1' (stand-in for agents.id, a uuid) — delivery
    // must land on the fleet row's OWN identity ('agent-1-ext', stand-in for its slug), which is
    // the identity a real signed-inbox poll actually queries by (the id↔slug bridge fix).
    expect(db._messages[0].to_agent).toBe('agent-1-ext')
    expect(db._messages[0].request_id).toBe('dispatch-inbox:receipt-1')
    expect(db._receipt.consumedAt).not.toBeNull()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('in-Worker route (no fleet row): executes in-Worker, no inbox message', async () => {
    const db = makeWorld({ fleet: null })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
    expect(db._receipt.consumedAt).not.toBeNull()
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('in-Worker route (stale external runtime — dead heartbeat): falls back, no inbox message', async () => {
    const db = makeWorld({ fleet: STALE_RUNTIME })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
    expect(db._receipt.consumedAt).not.toBeNull()
  })

  it('BLOCK-1 regression: a failed external delivery retries and RE-REACHES delivery (v1 silently lost this)', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME, failInsertNTimes: 1 })
    const { env, fetch } = envWith(db)
    const item1 = message(dispatchEvent())

    await handleQueue({ messages: [item1] } as unknown as MessageBatch<BusEvent>, env)

    // First attempt: delivery failed → retried. Crucially, execution_receipt_id was NEVER set
    // (the external route never touches it) — v1's bug was wakeAgent setting it, so a retry hit
    // the execution-receipt recovery branch and consumed without ever re-attempting delivery.
    expect(item1.retry).toHaveBeenCalledOnce()
    expect(item1.ack).not.toHaveBeenCalled()
    expect(db._receipt.executionReceiptId).toBeNull()
    expect(db._receipt.consumedAt).toBeNull()
    expect(fetch).not.toHaveBeenCalled() // in-Worker execute never ran as a side effect of the failure

    // Redelivery must RE-REACH delivery — this is the fix under test.
    const item2 = message(dispatchEvent())
    await handleQueue({ messages: [item2] } as unknown as MessageBatch<BusEvent>, env)

    expect(db._messages).toHaveLength(1) // delivery succeeded on the 2nd attempt
    expect(db._receipt.consumedAt).not.toBeNull()
    expect(item2.ack).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled() // still never executed in-Worker
  })

  it('sticky EXTERNAL (BLOCK-2 regression, ordering A): a delivered-but-uncomsumed retry finishes external even if the runtime now looks dead', async () => {
    // Simulates attempt 1 delivering externally then crashing before consuming the receipt: the
    // agent_messages row exists, the receipt is still unconsumed, execution_receipt_id is still
    // null. The runtime now reads STALE — a naive re-decision would wrongly fall back in-Worker.
    const db = makeWorld({ fleet: STALE_RUNTIME })
    // Body must match EXACTLY what deliverDispatchToInbox would construct for this dispatch —
    // sendAgentMessage's idempotency check compares content, not just the request_id, so a
    // mismatched seed body here would (correctly) surface as request_id_conflict rather than
    // simulating "attempt 1 already delivered this exact dispatch."
    const body = JSON.stringify({
      type: 'task_dispatch', task_id: 'task-1', dispatch_receipt_id: 'receipt-1', squad_id: '',
    })
    db._messages.push({
      seq: 1, id: 'm1', tenant: 'test', to_agent: 'agent-1-ext', from_agent: 'mupot-dispatch',
      from_member: 'member-1', kind: 'request', body, request_id: 'dispatch-inbox:receipt-1',
      created_at: '2026-07-14T00:00:00.000Z', read_at: null,
    })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled() // MUST NOT fall through to in-Worker
    expect(db._messages).toHaveLength(1) // idempotent re-delivery attempt is a no-op
    expect(db._receipt.consumedAt).not.toBeNull() // the interrupted attempt is finished
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('sticky IN-WORKER (BLOCK-2 regression, ordering B): an in-Worker-committed retry stays in-Worker even if the runtime now looks live', async () => {
    // Simulates attempt 1 already executing in-Worker (execution_receipt_id set, task done). A
    // retry with a NOW-live external runtime must take the pre-existing recovery/consume branch
    // — never deliver externally (that would be a second executor for the same task).
    const db = makeWorld({
      fleet: LIVE_RUNTIME,
      receipt: { executionReceiptId: 'receipt-1', taskStatus: 'done' },
    })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled() // no re-execute
    expect(db._messages).toHaveLength(0) // no external delivery either
    expect(db._receipt.consumedAt).not.toBeNull()
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('WARN-1: a whitespace-only dispatch_receipt_id is not treated as a task dispatch (no false dedup)', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent({ payload: { task_id: 'task-1', dispatch_receipt_id: '   ' } }))

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    // Falls through to the generic agent.wake path — no receipt machinery, no bridge at all.
    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('WARN-1: an empty task_id is likewise rejected as an identity', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent({ payload: { task_id: '', dispatch_receipt_id: 'receipt-1' } }))

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
  })

  it('WARN-1 (re-gate): a receiptId outside sendAgentMessage\'s request_id charset is rejected at the identity gate, not retried into a tight loop', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    // A space is outside [A-Za-z0-9_.:-] — would otherwise reach deliverDispatchToInbox and
    // throw a plain Error (not InboxFullError) on every single retry attempt.
    const item = message(dispatchEvent({ payload: { task_id: 'task-1', dispatch_receipt_id: 'bad receipt id' } }))

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    // Falls through to the generic agent.wake path — rejected once, up front, never enters the
    // receipt state machine or the bridge at all.
    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('WARN-1 (re-gate): a receiptId that would push dispatch-inbox:<id> past sendAgentMessage\'s 128-char limit is rejected at the identity gate', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    // DISPATCH_INBOX_PREFIX ('dispatch-inbox:') is 15 chars, so a 114-char receiptId (1 over the
    // 113-char headroom) would push the combined request_id to 129 chars — over RID_RE's cap.
    const oversized = 'a'.repeat(114)
    const item = message(dispatchEvent({ payload: { task_id: 'task-1', dispatch_receipt_id: oversized } }))

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce()
    expect(db._messages).toHaveLength(0)
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('WARN-1 (re-gate): a 113-char receiptId (exactly at the boundary) is accepted', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    const atBoundary = 'a'.repeat(113)
    const item = message(dispatchEvent({ payload: { task_id: 'task-1', dispatch_receipt_id: atBoundary } }))

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    // Accepted as a real task dispatch identity — routes normally (external route here).
    expect(fetch).not.toHaveBeenCalled()
    expect(db._messages).toHaveLength(1)
    expect(db._messages[0].request_id).toBe(`dispatch-inbox:${atBoundary}`)
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('tenant isolation: a same-agent_id fleet row in a DIFFERENT tenant is not treated as external', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME, fleetTenant: 'other-tenant' })
    const { env, fetch } = envWith(db, 200, 'test') // the dispatch itself is for tenant 'test'
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).toHaveBeenCalledOnce() // falls back in-Worker — the foreign-tenant row is invisible
    expect(db._messages).toHaveLength(0)
  })

  it('idempotent redelivery on the external route: exactly one inbox message for two deliveries of the same event', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME })
    const { env, fetch } = envWith(db)
    const event = dispatchEvent()
    const first = message(event)
    const second = message(event)

    await handleQueue({ messages: [first, second] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(db._messages).toHaveLength(1)
    expect(first.ack).toHaveBeenCalledOnce()
    expect(second.ack).toHaveBeenCalledOnce()
  })

  it('WARN-2: inbox_full backs off with a RetryAfterError delay instead of hot-looping', async () => {
    const db = makeWorld({ fleet: LIVE_RUNTIME, prefillUnread: 1000 })
    const { env, fetch } = envWith(db)
    const item = message(dispatchEvent())

    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)

    expect(fetch).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) })
    expect(item.ack).not.toHaveBeenCalled()
    expect(db._receipt.consumedAt).toBeNull()
  })
})
