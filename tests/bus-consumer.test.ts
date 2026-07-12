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
