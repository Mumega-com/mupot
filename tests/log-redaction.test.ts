import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { redactForLog, safeConsole } from '../src/lib/log'
import { handleQueue } from '../src/bus/consumer'
import type { BusEvent, Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// mupot#985 / #986 — console output reaches Cloudflare Logs/Tail, which account members can read
// without the capability checks the pot enforces on D1. Anything printed must be scrubbed of
// token-shaped values, emails and phone numbers, and free-text task fields must not be printed.

const TOKENS = {
  mupot: 'mupot_live_AbCdEf0123456789xyz',
  // Assembled at runtime so the repo secret scanner does not flag these deliberately fake values.
  github: ['ghp', '_AbCdEf0123456789AbCdEf0123456789'].join(''),
  openai: ['sk', '-proj-AbCdEf0123456789AbCdEf'].join(''),
  slack: 'xoxb-1234567890-abcdefghij',
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.'),
  bearer: 'Bearer abc.def-ghi_123',
  telegram: 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
}
const EMAIL = 'jane.doe+tag@example.co.uk'
const PHONES = ['+1 (416) 555-0199', '416-555-0199', '(416) 555 0199', '+44 20 7946 0958']

afterEach(() => vi.restoreAllMocks())

describe('redactForLog strings', () => {
  for (const [name, value] of Object.entries(TOKENS)) {
    it(`redacts a ${name} token`, () => {
      const out = String(redactForLog(`request failed for ${value} while calling upstream`))
      expect(out).not.toContain(value.replace(/^Bearer /, '').replace(/^https:\/\/api\.telegram\.org\//, ''))
      expect(out).toContain('request failed')
    })
  }

  it('redacts an email address', () => {
    const out = String(redactForLog(`sent to ${EMAIL} ok`))
    expect(out).not.toContain(EMAIL)
    expect(out).not.toContain('jane.doe')
  })

  for (const phone of PHONES) {
    it(`redacts the phone number ${phone}`, () => {
      expect(String(redactForLog(`call ${phone} now`))).not.toMatch(/0199|0958/)
      expect(String(redactForLog(`call ${phone} now`))).toContain('[redacted-phone]')
    })
  }

  it('does not mangle ids, ISO timestamps or counts', () => {
    const s = 'task 3f2a9c1e-5b7d-4e1a-9c3b-0a1b2c3d4e5f at 2026-11-04T17:09:19.485Z attempt 3 took 1234567 ms'
    expect(redactForLog(s)).toBe(s)
  })
})

describe('redactForLog structures', () => {
  it('redacts sensitive keys, free-text task fields, emails and phones inside objects', () => {
    const out = redactForLog({
      tenant: 'acme',
      task_id: 't-1',
      status: 502,
      title: 'Phone Jane about the invoice',
      task_title: 'Renew contract for Jane',
      body: 'free text',
      authorization: 'Bearer zzz',
      'x-relay-secret': 'shh',
      headers: { cookie: 'sid=1', 'x-api-key': 'k' },
      note: `contact ${EMAIL}`,
      email: EMAIL,
      phone: PHONES[0],
      nested: [{ api_key: 'k', text: 'hello', detail: `dial ${PHONES[1]}` }],
    })
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/Jane|invoice|free text|zzz|shh|sid=1|"k"|hello|416|jane\.doe/)
    // Correlation fields an operator needs survive.
    expect(out).toMatchObject({ tenant: 'acme', task_id: 't-1', status: 502 })
  })

  it('redacts an Error message and stack and keeps the class name', () => {
    const err = new Error(`fetch https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/x failed: ${TOKENS.github}`)
    const out = redactForLog(err)
    expect(out).toBeInstanceOf(Error)
    const e = out as Error
    expect(e.message).not.toContain('AAHdqTcv')
    expect(e.message).not.toContain('ghp_')
    expect(String(e.stack)).not.toContain('ghp_')
    expect(e.name).toBe('Error')
  })

  it('returns the same Error instance when nothing needed redacting', () => {
    const err = new Error('plain failure')
    expect(redactForLog(err)).toBe(err)
  })

  it('redacts a Request and a Response down to method/url/status', () => {
    const req = new Request('https://x.example/a?token=abc123&q=1', { method: 'POST', headers: { authorization: 'Bearer abc' }, body: '{"email":"a@b.co"}' })
    const res = new Response('{"secret":"s"}', { status: 401, headers: { 'set-cookie': 'sid=abc' } })
    const json = JSON.stringify([redactForLog(req), redactForLog(res)])
    expect(json).not.toMatch(/abc123|Bearer|a@b\.co|sid=abc|"s"/)
    expect(json).toContain('401')
    expect(json).toContain('POST')
  })

  it('survives cycles and deep nesting', () => {
    const a: Record<string, unknown> = { id: 1 }
    a.self = a
    let deep: Record<string, unknown> = { leaf: TOKENS.mupot }
    for (let i = 0; i < 40; i += 1) deep = { child: deep }
    expect(() => redactForLog(a)).not.toThrow()
    expect(JSON.stringify(redactForLog(deep))).not.toContain('mupot_live')
  })

  it('passes primitives and null through', () => {
    expect(redactForLog(7)).toBe(7)
    expect(redactForLog(null)).toBeNull()
    expect(redactForLog(undefined)).toBeUndefined()
    expect(redactForLog(true)).toBe(true)
  })
})

describe('safeConsole', () => {
  it('forwards to console.* with every argument redacted', () => {
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
    for (const level of levels) {
      const spy = vi.spyOn(console, level).mockImplementation(() => undefined)
      safeConsole[level](`[x] ${EMAIL}`, { token: TOKENS.mupot, id: 'abc' }, new Error(TOKENS.github))
      const printed = JSON.stringify(spy.mock.calls[0]?.map((a) => (a instanceof Error ? a.message : a)))
      expect(printed).not.toMatch(/jane\.doe|mupot_live|ghp_/)
      expect(printed).toContain('abc')
      spy.mockRestore()
    }
  })

  it('never throws, even if redaction meets a hostile getter', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hostile = {}
    Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('getter') } })
    expect(() => safeConsole.error('x', hostile)).not.toThrow()
    expect(spy).toHaveBeenCalled()
  })
})

describe('src has no raw console.* calls', () => {
  // Source-shape guard: a new console.* call in src bypasses redaction. lib/log.ts is the one
  // place allowed to call it. (Mutation-verified: re-adding a raw call turns this red.)
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (full.endsWith('.ts')) out.push(full.replace(/\\/g, '/'))
    }
    return out
  }
  it('only src/lib/log.ts calls console directly', () => {
    const RAW = /^[^/\n]*\bconsole\.(log|info|warn|error|debug)\s*\(/m
    const offenders = walk('src')
      .filter((f) => f !== 'src/lib/log.ts')
      .filter((f) => RAW.test(readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.includes('allow-raw-console')).join('\n')))
    expect(offenders).toEqual([])
  })
})

describe('bus consumer logs correlation ids, never task free text (mupot#986)', () => {
  it('task.blocked / task.review log lines carry no title, body or contact data', async () => {
    const lines: unknown[][] = []
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args) })
    }
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = { DB: harness.db } as unknown as Env
    for (const type of ['task.blocked', 'task.review'] as const) {
      const event: BusEvent = {
        type, tenant: 'acme', squad_id: 'sq-1', agent_id: 'ag-1',
        payload: { task_id: 't-9', task_title: `Call ${EMAIL} ${PHONES[1]}`, project_id: 'p-1', body: 'private body text' },
        ts: '2026-11-04T00:00:00.000Z',
      } as unknown as BusEvent
      const item = { id: 'm', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
      await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
    }
    const printed = JSON.stringify(lines.map((l) => l.map((a) => (a instanceof Error ? a.message : a))))
    expect(printed).toContain('t-9')
    expect(printed).not.toMatch(/Call |jane\.doe|555|private body/)
  })
})
