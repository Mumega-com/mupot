// If notify() itself throws, the consumer must still ack (no retry storm) and still run add-on dispatch.
import { describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'

vi.mock('../src/notify', async (orig) => ({
  ...(await orig<typeof import('../src/notify')>()),
  notify: vi.fn(async () => { throw new Error('boom') }),
}))
vi.mock('../src/addons/event-dispatch', () => ({ dispatchAddonEvent: vi.fn(async () => []) }))

import { handleQueue } from '../src/bus/consumer'
import { notify } from '../src/notify'
import { dispatchAddonEvent } from '../src/addons/event-dispatch'

describe('consumer containment', () => {
  it('notify() throwing does not retry the message and add-on dispatch still runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ack = vi.fn(); const retry = vi.fn()
    const body: BusEvent = { type: 'task.review', tenant: 't1', squad_id: 's', agent_id: 'a', payload: { task_id: 'x', project_id: null, title: 'T' }, ts: 'now' }
    await handleQueue({ messages: [{ id: 'm', attempts: 1, body, ack, retry }] } as never, { DB: {} } as unknown as Env)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
    expect(dispatchAddonEvent).toHaveBeenCalledTimes(1)
  })
})
