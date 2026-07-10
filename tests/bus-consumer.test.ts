import { describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { handleQueue } from '../src/bus/consumer'
import type { BusEvent, Env } from '../src/types'

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
})
