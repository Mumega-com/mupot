// Notify kernel slice 2a: untrusted text is data, claim released when a send throws, no over-redaction, one policy
// source, and the slice-1 test gaps (M09, M27, M04). Real migrated D1, fake adapters / fetch. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'
import { notify, OWNER_RECIPIENT } from '../src/notify'
import { renderContext, safeField, type ChannelAdapter } from '../src/notify/adapters'
import { REVERSIBLE_ACTIONS } from '../src/notify/carry'
import { redactSecretPatterns } from '../src/lib/redact'
import type { NotifyEvent } from '../src/notify/types'
import { APPROVAL_BOT_ACTIONS } from '../src/approval-bot/policy'
import { TELEGRAM_MAX_CHARS, escapeTelegramHtml, formatTelegram, telegramHtmlToPlain } from '../src/telegram-bridge/bus_notify'
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

describe('item 1: caller text is never markup (parse_mode HTML)', () => {
  const EVIL = '[Approve now](https://evil.example)'
  const FIXED_TAG_RE = /<\/?(?:b|i|code)>/g
  // After removing the fixed constants, no < or > may remain, and every & must start a known entity.
  const leftovers = (html: string): string => html.replace(FIXED_TAG_RE, '')
  const wellFormed = (html: string): boolean => {
    const rest = leftovers(html)
    return !/[<>]/.test(rest) && !/&(?!(?:amp|lt|gt|quot);)/.test(rest)
  }

  it('hostile titles render literally: tags, entities, markdown links and code-span breakouts', () => {
    for (const t of ['<a href="https://evil.example">Approve</a>', '&lt;b&gt;', EVIL, '</code><b>x</b>', '"><script>', 'a & b']) {
      const html = formatTelegram({ type: 'task.review', title: t, message: t, task_id: t, agent_id: t })
      expect(wellFormed(html), t).toBe(true)
      expect(html).not.toContain('<a ')
      expect(telegramHtmlToPlain(html)).toContain(t) // renders back to exactly what was typed
    }
  })

  it('[WIP], C:\\Users, underscores and asterisks need no escaping and appear as typed', () => {
    const html = formatTelegram({ type: 'task.blocked', title: '[WIP] C:\\Users a_b *c* `d` [redacted]' })
    expect(html).toContain('[WIP] C:\\Users a_b *c* `d` [redacted]')
    expect(html).not.toContain('\\\\')
  })

  it('escaper covers & < > and " (the & first, so entities are not double-decoded)', () => {
    expect(escapeTelegramHtml('<a href="x">&amp;</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;')
    expect(telegramHtmlToPlain(escapeTelegramHtml('&lt; &amp;lt; <b>'))).toBe('&lt; &amp;lt; <b>')
  })

  it('fuzz: the rendered HTML contains no tag other than the fixed constants', () => {
    const atoms = ['<', '>', '&', '"', "'", '</code>', '<b>', '<a href="x">', '&lt;', '&#60;', '[', ']', '(', ')', '`', '\\', 'a', ' ', '\n']
    let seed = 987654
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    for (let k = 0; k < 3000; k++) {
      const t = Array.from({ length: 1 + rnd(14) }, () => atoms[rnd(atoms.length)]).join('')
      const html = formatTelegram({ type: rnd(2) ? 'task.created' : `task.${t}`, title: t, message: t, task_id: t, agent_id: t, squad_id: t, project_id: t })
      expect(wellFormed(html), JSON.stringify(t)).toBe(true)
    }
  })

  it('the bold header holds only constants: a hostile type or id never sits inside <b>', () => {
    const html = formatTelegram({ type: 'task.x*', task_id: '</code><b>[Approve](https://evil.example)' })
    const [header, idLine] = html.split('\n')
    expect(header).toBe('📌 <b>Task</b> x*')
    expect(idLine).toBe('<code>&lt;/code&gt;&lt;b&gt;[Approve](https://evil.example)</code>')
    expect(formatTelegram({ type: 'task.review' }).split('\n')[0]).toBe('🔍 <b>Task review</b>')
    expect(formatTelegram({ type: 'task.<b>' }).split('\n')[0]).toBe('📌 <b>Task</b> &lt;b&gt;')
  })

  it('over the length cap the HTML is clipped before escaping: never a cut tag or entity', () => {
    const t = '&<'.repeat(250)
    // vary the prefix so a naive cut would land inside a tag or entity at some offset
    for (let pad = 0; pad < 12; pad++) {
      const html = formatTelegram({ type: 'task.review', title: 'x'.repeat(pad) + t, message: t, task_id: t, agent_id: t, squad_id: t, project_id: t })
      expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS + 20)
      expect(wellFormed(html.replace('\n…(truncated)', '')), `pad ${pad}`).toBe(true)
    }
  })

  it('the real telegram path sends parse_mode HTML with the title escaped', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await notify(envOf(), ev({ context: { title: '<a href="https://evil.example">Approve</a>' } }))
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string) as { text: string; parse_mode?: string }
    expect(body.parse_mode).toBe('HTML')
    expect(body.text).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Approve&lt;/a&gt;')
    expect(body.text).not.toContain('<a ')
  })

  it('a 400 parse error retries once as plain text with the fixed tags dropped and entities decoded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "can't parse entities" } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await notify(envOf(), ev({ type: 'task.review', context: { title: 'a < b & c' } }))
    const second = JSON.parse(((fetchMock.mock.calls[1] as unknown[])[1] as RequestInit).body as string) as { text: string; parse_mode?: string }
    expect(second.parse_mode).toBeUndefined()
    expect(second.text).toContain('a < b & c')
    expect(second.text).not.toMatch(/<\/?(?:b|i|code)>/)
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

  it('M11: a recipient that already sent keeps its claim when a later recipient throws; the retry does not resend', async () => {
    const sent: string[] = []
    let thrown = false
    const tg: ChannelAdapter = {
      channel: 'telegram_dm',
      deliver: async (_e, _ev, r) => {
        if (r === 'member-2' && !thrown) { thrown = true; throw new Error('boom') }
        sent.push(r)
        return { status: 'sent' }
      },
    }
    const event = ev({ recipients: [OWNER_RECIPIENT, 'member-2'] })
    await expect(notify(envOf(), event, { adapters: [tg] })).rejects.toThrow('boom')
    const r = await notify(envOf(), event, { adapters: [tg] })
    expect(sent).toEqual([OWNER_RECIPIENT, 'member-2'])
    expect(r.deduped).toEqual([OWNER_RECIPIENT])
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

describe('item 5: Telegram field redaction is the strict redactor, nothing weaker', () => {
  // built at runtime so the secret scanner does not flag the fixture
  const PEM = ['-----BEGIN OPENSSH PRIVATE', 'KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE', 'KEY-----'].join(' ')
  const sk = ['sk', 'abcdefghijklmnop1234'].join('-') // built at runtime so the secret scanner does not flag the fixture
  const PROBES = [
    'Update token: rotation runbook',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Token 0123456789abcdef0123',
    'authorization: Bot MTIzNDU2GabcDE.xyz', 'curl -H Basic dXNlcjpwYXNz', 'curl -H bearer zXy9', 'curl -H Digest zXy9', 'ApiKey zXy9',
    'db password: hunter2', 'password: hunter2', 'password: correcthorsebatterystaple', 'password: "letmeinplease"',
    '{"password":"Sunshine"}', 'secret: is a8f9d0c1e2b3f4a5b6c7', 'api_key: the value X9f8Y7w6', 'apikey=AbCdEfGhIjKlMnOp',
    'api-key: abc', 'client_secret: AbCdEfGhIjKlMnOpQrSt', 'client_secret: 7f3a9c', 'pwd=letmein', 'passwd: letmein', 'auth: letmein',
    'cookie: session=abcdef', 'set-cookie: sid=zzz', 'private_key: MIIEvQIBADANBg', 'access_key: AKIAxyz',
    'connection_string: Server=db;Password=pw12', 'Server=db;Password=pw12',
    'x token=abc123SECRETvalue y', 'token: 12345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    PEM, `Bearer ${PEM}`, `token ${PEM}`, `Token ${PEM}`, `basic\n${PEM}`, `apikey\t${PEM}`, `auth: ${PEM}`, `pwd:= ${PEM}`,
    `Rotate key for the release bot\n${PEM}`, `deploy token ${PEM}`,
    `key ${sk}`, 'https://x.test/cb?token=zzzz', 'Authorization: Bearer abcdefghij1234567890QQQQ',
    'ordinary title with no secrets', '',
  ]

  it('safeField(x) is exactly redactSecretPatterns(x) (capped), for every leak probe from the gate reports', () => {
    for (const input of PROBES) expect(safeField(input), JSON.stringify(input)).toBe(redactSecretPatterns(input).slice(0, 500) || (input === '' ? '' : undefined))
  })

  it('M18: the strict redactor is not relaxed for prose after token:', () => {
    expect(redactSecretPatterns('Update token: rotation runbook')).not.toContain('rotation')
  })
})

describe('item 4: one policy source', () => {
  const TODAY_LIST = [
    'action:project_lifecycle', 'action:org_structure', 'action:workspace_project', 'action:routine_policy',
    'action:project_status', 'action:sudo_squad_member_add', 'action:sudo_squad_dyad_pin',
    'action:sudo_grant_gate_capability', 'action:sudo_seat_event_grant',
    'action:sudo_archive_row', 'action:sudo_project_repo', // W1-2 (council-20261121-authz)
  ]
  it('the bot allow list is the carry table list, and equals the list the bot carried before the switch, in order', () => {
    expect(APPROVAL_BOT_ACTIONS).toBe(REVERSIBLE_ACTIONS)
    expect([...APPROVAL_BOT_ACTIONS]).toEqual(TODAY_LIST)
  })

  it('the shared list is frozen: a runtime push throws', () => {
    expect(Object.isFrozen(REVERSIBLE_ACTIONS)).toBe(true)
    // as: the declared type is readonly; the cast is the point, proving the runtime freeze.
    expect(() => (APPROVAL_BOT_ACTIONS as string[]).push('action:mint_token')).toThrow(TypeError)
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
