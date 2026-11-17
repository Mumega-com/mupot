// M08: if add-on event dispatch throws, the consumer still acks (no retry storm) and the owner notification went out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'

vi.mock('../src/addons/event-dispatch', () => ({ dispatchAddonEvent: vi.fn(async () => { throw new Error('addon down') }) }))

import { handleQueue } from '../src/bus/consumer'
import { dispatchAddonEvent } from '../src/addons/event-dispatch'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let h: SqliteD1Harness
beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite) })
afterEach(() => { h.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('consumer containment: add-on dispatch', () => {
  it('dispatchAddonEvent throwing does not retry the message; notify already ran', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const ack = vi.fn(); const retry = vi.fn()
    const body: BusEvent = { type: 'task.review', tenant: 't1', squad_id: 's', agent_id: 'a', payload: { task_id: 'x', project_id: null, title: 'T' }, ts: 'now' }
    const env = { DB: h.db, TENANT_SLUG: 't1', TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '1' } as unknown as Env
    await handleQueue({ messages: [{ id: 'm', attempts: 1, body, ack, retry }] } as never, env)
    expect(dispatchAddonEvent).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalled()
  })
})
