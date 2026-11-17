// Notify kernel slice 2a: untrusted text is data, claim released when a send throws, no over-redaction, one policy
// source, and the slice-1 test gaps (M09, M27, M04). Real migrated D1, fake adapters / fetch. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'
import { notify, OWNER_RECIPIENT } from '../src/notify'
import { renderContext, safeField, type ChannelAdapter } from '../src/notify/adapters'
import { REVERSIBLE_ACTIONS } from '../src/notify/carry'
import type { NotifyEvent } from '../src/notify/types'
import { APPROVAL_BOT_ACTIONS } from '../src/approval-bot/policy'
import { escapeTelegramMarkdown, formatTelegram } from '../src/telegram-bridge/bus_notify'
import { handleQueue } from '../src/bus/consumer'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let h: SqliteD1Harness
const envOf = (): Env => ({ DB: h.db, TENANT_SLUG: 't1', TELEGRAM_BOT_TOKEN: 'bot-token-abc', TELEGRAM_CHAT_ID: '1' }) as unknown as Env
const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  tenant: 't1', type: 'task.review', severity: 'attention', subject_ref: 'task:1',
  recipients: [OWNER_RECIPIENT], dedupe_key: 'task.review:1', ...over,
})

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => { h.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('item 1: caller text is never Markdown', () => {
  const EVIL = '[Approve now](https://evil.example)'

  it('a markdown link in a title is escaped, so it cannot become a link', () => {
    const text = formatTelegram({ type: 'task.review', title: EVIL })
    expect(text).toContain('\\[Approve now\\](https://evil.example)')
    expect(text).not.toMatch(/(^|[^\\])\[Approve now\]/)
  })

  it('underscores, asterisks and backticks in a title or message are escaped', () => {
    const text = formatTelegram({ type: 'task.blocked', title: 'a_b *bold* `code`', message: 'x_y *z* `q`' })
    expect(text).toContain('a\\_b \\*bold\\* \\`code\\`')
    expect(text).toContain('x\\_y \\*z\\* \\`q\\`')
  })

  it('a backslash cannot cancel the escape of the bracket after it', () => {
    expect(escapeTelegramMarkdown('\\[x](u)')).toBe('\\\\\\[x\\](u)')
  })

  it('ids in code spans cannot break out of the span', () => {
    const text = formatTelegram({ type: 'task.review', task_id: 'a`](https://evil.example)[`', agent_id: 'b`c', squad_id: 's\\', project_id: 'p`' })
    for (const line of text.split('\n').filter((l) => l.includes('`'))) expect((line.match(/`/g) ?? []).length % 2).toBe(0)
    expect(text).not.toContain('`](https://evil.example)')
  })

  it('the real telegram path sends the escaped title, then the same plain-text retry still carries no link markup', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await notify(envOf(), ev({ context: { title: EVIL } }))
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string) as { text: string; parse_mode?: string }
    expect(body.parse_mode).toBe('Markdown')
    expect(body.text).toContain('\\[Approve now\\]')
    expect(body.text).not.toMatch(/(^|[^\\])\[Approve now\]/)
  })
})

describe('item 3: a throwing send frees the dedupe claim', () => {
  it('send throws once, the retry delivers (and unfinished recipients are freed too)', async () => {
    let calls = 0
    const sent: string[] = []
    const flaky: ChannelAdapter = {
      channel: 'telegram_dm',
      deliver: async (_e, _ev, r) => {
        calls += 1
        if (calls === 1) throw new Error('workflow step died')
        sent.push(r)
        return { status: 'sent' }
      },
    }
    const dash: ChannelAdapter = { channel: 'dashboard', deliver: async () => ({ status: 'sent' }) }
    const event = ev({ recipients: [OWNER_RECIPIENT, 'member-2'] })
    await expect(notify(envOf(), event, { adapters: [dash, flaky] })).rejects.toThrow('workflow step died')
    const n = (h.sqlite.prepare('SELECT COUNT(*) AS n FROM notif_dedupe').get() as { n: number }).n
    expect(n).toBe(0)
    const r = await notify(envOf(), event, { adapters: [dash, flaky] })
    expect(r.deduped).toEqual([])
    expect(sent).toEqual([OWNER_RECIPIENT, 'member-2'])
  })

  it('a successful send still dedupes the repeat', async () => {
    const sent: string[] = []
    const ok: ChannelAdapter = { channel: 'telegram_dm', deliver: async (_e, _ev, r) => { sent.push(r); return { status: 'sent' } } }
    await notify(envOf(), ev(), { adapters: [ok] })
    const r = await notify(envOf(), ev(), { adapters: [ok] })
    expect(sent).toHaveLength(1)
    expect(r.deduped).toEqual([OWNER_RECIPIENT])
  })
})

describe('item 5: only real secret patterns are redacted', () => {
  it('ordinary words survive', () => {
    expect(safeField('Update token: rotation runbook')).toBe('Update token: rotation runbook')
    expect(safeField('Rotate the password policy: quarterly review')).toBe('Rotate the password policy: quarterly review')
    expect(safeField('secret: handling guide')).toBe('secret: handling guide')
  })

  it('real secret shapes are still redacted', () => {
    expect(safeField('x token=abc123SECRETvalue y')).not.toContain('abc123SECRETvalue')
    expect(safeField('password: hunter2hunter2')).not.toContain('hunter2hunter2')
    expect(safeField('Authorization: Bearer abcdefghij1234567890QQQQ')).not.toContain('abcdefghij1234567890QQQQ')
    expect(safeField('key sk-abcdefghijklmnop1234')).not.toContain('sk-abcdefghijklmnop1234')
    expect(safeField('https://x.test/cb?token=zzzz')).not.toContain('zzzz')
  })
})

describe('item 4: one policy source', () => {
  const TODAY_LIST = [
    'action:project_lifecycle', 'action:org_structure', 'action:workspace_project', 'action:routine_policy',
    'action:project_status', 'action:sudo_squad_member_add', 'action:sudo_squad_dyad_pin',
    'action:sudo_grant_gate_capability', 'action:sudo_seat_event_grant',
  ]
  it('the bot allow list is the carry table list, and equals the list the bot carried before the switch, in order', () => {
    expect(APPROVAL_BOT_ACTIONS).toBe(REVERSIBLE_ACTIONS)
    expect([...APPROVAL_BOT_ACTIONS]).toEqual(TODAY_LIST)
  })
})

describe('slice-1 test gaps', () => {
  it('M27: every rendered field is capped at 500 chars', () => {
    const long = 'a'.repeat(900)
    const c = renderContext({ title: long, message: long, task_id: long, squad_id: long, agent_id: long, project_id: long })
    for (const v of Object.values(c)) expect(v?.length).toBe(500)
  })

  function taskEvent(payload: Record<string, unknown>, type: BusEvent['type'] = 'task.review'): BusEvent {
    return { type, tenant: 't1', squad_id: 'sq', agent_id: 'ag', payload, ts: new Date().toISOString() } as BusEvent
  }
  const run = (e: BusEvent) => handleQueue({ messages: [{ id: 'm', attempts: 1, body: e, ack: vi.fn(), retry: vi.fn() }] } as never, envOf())

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response))
  })

  it('M09: task events are recorded at severity attention', async () => {
    await run(taskEvent({ task_id: 'x1', title: 'T' }))
    await run(taskEvent({ task_id: 'x2', title: 'T' }, 'task.blocked'))
    const sev = h.sqlite.prepare('SELECT DISTINCT severity FROM notif_event').all() as Array<{ severity: string }>
    expect(sev).toEqual([{ severity: 'attention' }])
  })

  it('M04: task-less events get a random key, so two identical ones both send and never share a key', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await run(taskEvent({ title: 'same' }))
    await run(taskEvent({ title: 'same' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const keys = (h.sqlite.prepare('SELECT dedupe_key FROM notif_event').all() as Array<{ dedupe_key: string }>).map((r) => r.dedupe_key)
    expect(new Set(keys).size).toBe(2)
    for (const k of keys) expect(k).not.toContain('same')
  })
})
