// Notify kernel slice 1: real migrated schema, fake adapters and fake fetch. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { notify, wasDelivered, OWNER_RECIPIENT } from '../src/notify'
import { renderContext, type ChannelAdapter } from '../src/notify/adapters'
import { isDuplicate, isRateCapped } from '../src/notify/policy'
import type { NotifyEvent } from '../src/notify/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let h: SqliteD1Harness
let pushed: string[]
let pushOk: boolean

const dash: ChannelAdapter = { channel: 'dashboard', deliver: async () => ({ status: 'sent' }) }
const tg: ChannelAdapter = {
  channel: 'telegram_dm',
  deliver: async (_e, ev) => {
    pushed.push(ev.dedupe_key)
    return pushOk ? { status: 'sent' } : { status: 'failed', error_code: 'send_failed' }
  },
}
const adapters = [dash, tg]
const envOf = (): Env => ({ DB: h.db, TENANT_SLUG: 't1' }) as unknown as Env
const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  tenant: 't1', type: 'task.review', severity: 'attention', subject_ref: 'task:1',
  recipients: [OWNER_RECIPIENT], dedupe_key: 'task.review:1', ...over,
})
const count = (t: string) => (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  pushed = []
  pushOk = true
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => { h.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('pipeline', () => {
  it('routes info/attention to telegram_dm and dashboard and writes event + delivery rows', async () => {
    const r = await notify(envOf(), ev(), { adapters })
    expect(r.deliveries.map((d) => d.channel)).toEqual(['telegram_dm', 'dashboard'])
    expect(wasDelivered(r, 'telegram_dm')).toBe(true)
    expect(count('notif_event')).toBe(1)
    expect(count('notif_delivery')).toBe(2)
  })

  it('a channel with no adapter (approval_bot, miniapp) produces no delivery', async () => {
    const r = await notify(envOf(), ev({ severity: 'decision', action_class: 'reversible' }), { adapters })
    expect(r.deliveries.map((d) => d.channel)).toEqual(['dashboard'])
  })

  it('a failed send frees the dedupe window so a retry is not swallowed', async () => {
    pushOk = false
    await notify(envOf(), ev(), { adapters })
    pushOk = true
    const r = await notify(envOf(), ev(), { adapters })
    expect(wasDelivered(r, 'telegram_dm')).toBe(true)
  })

  it('degrades to sending when the store is down', async () => {
    const broken = { DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    const r = await notify(broken, ev(), { adapters })
    expect(pushed).toHaveLength(1)
    expect(wasDelivered(r, 'telegram_dm')).toBe(true)
  })
})

describe('guard: dedupe', () => {
  it('same recipient + key within 10 minutes sends once; after the window it sends again', async () => {
    let now = 1_000_000
    await notify(envOf(), ev(), { adapters, now: () => now })
    now += 9 * 60_000
    const second = await notify(envOf(), ev(), { adapters, now: () => now })
    expect(pushed).toHaveLength(1)
    expect(second.deduped).toEqual([OWNER_RECIPIENT])
    now += 2 * 60_000
    await notify(envOf(), ev(), { adapters, now: () => now })
    expect(pushed).toHaveLength(2)
  })

  it('a different key is not deduped', async () => {
    await notify(envOf(), ev(), { adapters })
    await notify(envOf(), ev({ dedupe_key: 'task.blocked:1' }), { adapters })
    expect(pushed).toHaveLength(2)
  })

  it('pure: isDuplicate honours the window', () => {
    expect(isDuplicate(null, 5)).toBe(false)
    expect(isDuplicate(0, 599_999)).toBe(true)
    expect(isDuplicate(0, 600_000)).toBe(false)
  })
})

describe('guard: rate cap', () => {
  it('holds push channels back at the cap, still records the dashboard row', async () => {
    const opts = { adapters, rateCapPerHour: 3 }
    for (let i = 0; i < 3; i++) await notify(envOf(), ev({ dedupe_key: `k${i}` }), opts)
    const r = await notify(envOf(), ev({ dedupe_key: 'k3' }), opts)
    expect(pushed).toHaveLength(3)
    expect(r.rate_capped).toEqual([OWNER_RECIPIENT])
    expect(r.deliveries.find((d) => d.channel === 'telegram_dm')).toMatchObject({ status: 'failed', error_code: 'rate_capped' })
    expect(r.deliveries.find((d) => d.channel === 'dashboard')?.status).toBe('sent')
  })

  it('default cap is 20 per hour per recipient, and the window rolls', async () => {
    let now = 5_000_000
    for (let i = 0; i < 21; i++) await notify(envOf(), ev({ dedupe_key: `k${i}` }), { adapters, now: () => now })
    expect(pushed).toHaveLength(20)
    now += 61 * 60_000
    await notify(envOf(), ev({ dedupe_key: 'later' }), { adapters, now: () => now })
    expect(pushed).toHaveLength(21)
  })

  it('pure: isRateCapped', () => {
    expect(isRateCapped('attention', 19)).toBe(false)
    expect(isRateCapped('attention', 20)).toBe(true)
  })
})

describe('guard: critical bypass', () => {
  it('critical is delivered past the cap', async () => {
    const opts = { adapters, rateCapPerHour: 2 }
    for (let i = 0; i < 2; i++) await notify(envOf(), ev({ dedupe_key: `k${i}` }), opts)
    const r = await notify(envOf(), ev({ dedupe_key: 'crit', severity: 'critical', action_class: 'reversible' }), opts)
    expect(wasDelivered(r, 'telegram_dm')).toBe(true)
    expect(r.rate_capped).toEqual([])
    expect(pushed).toHaveLength(3)
  })

  it('pure: critical is never capped', () => {
    expect(isRateCapped('critical', 10_000)).toBe(false)
  })
})

describe('guard: no secrets in rendered text', () => {
  it('redacts secret-shaped content from every field before an adapter renders it', () => {
    const ctx = renderContext({
      title: 'deploy with token=abc123SECRETvalue ok',
      message: 'Authorization: Bearer sk-live-1234567890abcdefghij and password=hunter2hunter2',
      task_id: 't-1',
    })
    const all = JSON.stringify(ctx)
    expect(all).not.toContain('abc123SECRETvalue')
    expect(all).not.toContain('hunter2hunter2')
    expect(all).not.toContain('sk-live-1234567890abcdefghij')
    expect(ctx.task_id).toBe('t-1')
  })

  it('the real telegram adapter sends redacted text and the event/delivery rows hold no body', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const env = { ...envOf(), TELEGRAM_BOT_TOKEN: 'bot-token-abc', TELEGRAM_CHAT_ID: '1' } as unknown as Env
    await notify(env, ev({ context: { title: 'x', message: 'client_secret=ZZZ-very-secret-ZZZ' } }))
    const sent = JSON.stringify(fetchMock.mock.calls)
    expect(sent).not.toContain('ZZZ-very-secret-ZZZ')
    const stored = JSON.stringify([
      h.sqlite.prepare('SELECT * FROM notif_event').all(), h.sqlite.prepare('SELECT * FROM notif_delivery').all(),
    ])
    expect(stored).not.toContain('ZZZ-very-secret-ZZZ')
    expect(stored).not.toContain('bot-token-abc')
  })
})
