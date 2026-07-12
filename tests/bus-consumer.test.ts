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
