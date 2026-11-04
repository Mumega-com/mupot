import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { redactForLog, safeConsole } from '../src/lib/log'
import { redactSecretPatterns } from '../src/lib/redact'
import { handleQueue } from '../src/bus/consumer'
import type { BusEvent, Env } from '../src/types'
import { findConsoleUses } from './helpers/console-guard'
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

  it('always rebuilds an Error, so clean message/stack still cannot carry secret own properties', () => {
    const err = Object.assign(new Error('upstream 401'), {
      headers: { authorization: 'Bearer LEAKME' },
      token: 'LEAKME2',
      status: 401,
    })
    const out = redactForLog(err) as Error & { status?: number }
    expect(out).not.toBe(err)
    expect(out.message).toBe('upstream 401')
    expect(out.status).toBe(401)
    expect(JSON.stringify(out)).not.toContain('LEAKME')
    expect(JSON.stringify(Object.entries(out))).not.toContain('LEAKME')
  })

  it('recurses into AggregateError.errors and cause, with a depth limit', () => {
    const inner = new Error(`inner ${TOKENS.bearer}`)
    const agg = new AggregateError([inner, new Error('b')], 'outer clean')
    const out = redactForLog(agg) as AggregateError
    expect(out.errors.map((e: Error) => e.message).join('|')).not.toContain('abc.def')
    let chain: Error = new Error(`leaf ${TOKENS.github}`)
    for (let i = 0; i < 30; i += 1) chain = new Error(`n${i}`, { cause: chain })
    const messages: string[] = []
    for (let e: unknown = redactForLog(chain); e instanceof Error; e = (e as { cause?: unknown }).cause) messages.push(e.message)
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.join('|')).not.toContain('ghp_')
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

  it('redacts Map, Set and URL contents', () => {
    const out = JSON.stringify([
      redactForLog(new Map([['authorization', 'Bearer MAPLEAK'], ['id', 'keep-1']])),
      redactForLog(new Set([`mail ${EMAIL}`, 'ok-2'])),
      redactForLog(new URL('https://user:pw@api.example/x?access_token=URLLEAK&page=2')),
    ])
    expect(out).not.toMatch(/MAPLEAK|jane\.doe|URLLEAK|user:pw/)
    expect(out).toMatch(/keep-1/)
    expect(out).toMatch(/ok-2/)
    expect(out).toMatch(/page=2/)
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

describe('src has no raw console use', () => {
  // AST-based (tests/helpers/console-guard.ts): any `console` identifier outside src/lib/log.ts
  // fails, whatever the call shape. Mutation-verified per shape below.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (full.endsWith('.ts')) out.push(full.replace(/\\/g, '/'))
    }
    return out
  }
  it('only src/lib/log.ts (and allow-raw-console lines) touch console', () => {
    const offenders = walk('src')
      .filter((f) => f !== 'src/lib/log.ts')
      .flatMap((f) => findConsoleUses(readFileSync(f, 'utf8'), f).map((line) => `${f}:${line}`))
    expect(offenders).toEqual([])
  })

  const SHAPES: Record<string, string> = {
    'dot call': "console.log('x')",
    'bracket call': "console['log']('x')",
    'computed bracket call': "console[ok ? 'info' : 'warn']('x')",
    'callback': 'p.catch(console.error)',
    'alias': 'const c = console\nc.log(1)',
    'trace': 'console.trace()',
    'dir/table/assert': 'console.table([1])',
    'slash earlier on the line': "const r = a / b; console.log(r)",
    'url earlier on the line': "const u = 'https://x.example/a'; console.log(u)",
    'destructured': 'const { log } = console',
    'globalThis access': "globalThis.console.log('x')",
  }
  for (const [name, code] of Object.entries(SHAPES)) {
    it(`the guard flags: ${name}`, () => {
      expect(findConsoleUses(code).length).toBeGreaterThan(0)
    })
  }
  it('ignores the word in strings, comments and member names, and honours the marker', () => {
    expect(findConsoleUses("const s = 'console.log(1)' // console.log(2)\nconst o = { console: 1 }; o.console")).toEqual([])
    expect(findConsoleUses("console.log(1) // allow-raw-console: dev only")).toEqual([])
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


describe('additional secret shapes (mupot#985 round 2)', () => {
  const FAKE = {
    stripeLive: ['sk', '_live_', 'A1b2C3d4E5f6G7h8I9j0'].join(''),
    stripeTest: ['sk', '_test_', 'A1b2C3d4E5f6G7h8I9j0'].join(''),
    stripeRestricted: ['rk', '_live_', 'A1b2C3d4E5f6G7h8I9j0'].join(''),
    whsec: ['whsec', '_A1b2C3d4E5f6G7h8I9j0K1l2'].join(''),
    ghPat: ['github', '_pat_', '11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789'].join(''),
    gho: ['gho', '_AbCdEf0123456789AbCdEf0123'].join(''),
    ghs: ['ghs', '_AbCdEf0123456789AbCdEf0123'].join(''),
    google: ['AI', 'zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7'].join(''),
    slack: ['https://hooks.slack.com', '/services/T000/B000/XXXXXXXXXXXXXXXX'].join(''),
    discord: ['https://discord.com', '/api/webhooks/123456789/AbCdEfGhIjKlMnOp'].join(''),
    hex: 'a'.repeat(32) + 'b1'.repeat(16),
  }
  for (const [name, value] of Object.entries(FAKE)) {
    it(`redacts ${name}`, () => {
      const text = name === 'hex' ? `signing secret: ${value}` : `failed with ${value} end`
      const out = String(redactForLog(text))
      expect(out).not.toContain(value.slice(8, 30))
    })
  }

  for (const q of ['code', 'key', 'token', 'sig', 'signature', 'X-Amz-Signature', 'access_token']) {
    it(`redacts the ${q} query parameter and keeps the others`, () => {
      const out = String(redactForLog(`GET https://api.example/cb?page=2&${q}=SECRETVALUE123&limit=5`))
      expect(out).not.toContain('SECRETVALUE123')
      expect(out).toContain('page=2')
      expect(out).toContain('limit=5')
    })
  }

  for (const key of ['summary', 'goal', 'note', 'description']) {
    it(`replaces the free-text key ${key}`, () => {
      expect(JSON.stringify(redactForLog({ id: 'i-1', [key]: 'customer words here' }))).not.toContain('customer words')
    })
  }

  it('keeps ids, statuses, counts and timestamps', () => {
    const input = { id: 'i-1', task_id: 't-2', status: 'blocked', count: 3, http_status: 502, at: '2026-11-04T17:09:19.485Z', uuid: '3f2a9c1e-5b7d-4e1a-9c3b-0a1b2c3d4e5f' }
    expect(redactForLog(input)).toEqual(input)
  })
})

describe('redaction cost is bounded (mupot#985 round 2)', () => {
  const ms = (fn: () => void): number => {
    const t = process.hrtime.bigint()
    fn()
    return Number(process.hrtime.bigint() - t) / 1e6
  }
  const SHAPES: Record<string, string> = {
    'alnum run': 'a'.repeat(32 * 1024),
    'hex run': 'deadbeef'.repeat(4 * 1024),
    'dots and at-less local parts': 'a.'.repeat(16 * 1024),
    'equals run': '='.repeat(32 * 1024),
    'query-ish run': '?a=&'.repeat(8 * 1024),
    'digit run': '1'.repeat(32 * 1024),
  }
  for (const [name, input] of Object.entries(SHAPES)) {
    it(`32 KB ${name} redacts in under 50 ms`, () => {
      redactForLog(input)
      expect(ms(() => { redactForLog(input) })).toBeLessThan(50)
    })
  }
  it('caps very long strings and marks the cut', () => {
    const out = String(redactForLog('x'.repeat(50_000)))
    expect(out.length).toBeLessThan(9_000)
    expect(out.endsWith('…[truncated]')).toBe(true)
  })
})


describe('assignment redaction anywhere in the string (src/lib/redact.ts regression)', () => {
  const CASES: Array<[string, string]> = [
    ['Error: upstream rejected secret=abc123def', 'abc123def'],
    ['status: 401 password=hunter2hunter2', 'hunter2hunter2'],
    ['D1_ERROR: token=abcdef secret', 'abcdef'],
  ]
  for (const [input, leak] of CASES) {
    it(`redacts ${JSON.stringify(input)}`, () => {
      expect(redactSecretPatterns(input)).not.toContain(leak)
      expect(String(redactForLog(input))).not.toContain(leak)
    })
  }
  it('still keeps the harmless leading words', () => {
    expect(redactSecretPatterns('Error: upstream rejected secret=abc123def')).toContain('Error: upstream rejected')
  })
  it('redacts several pairs in one string', () => {
    const out = redactSecretPatterns('a: 1, token=AAAA1111, b: 2, password=BBBB2222, c=3')
    expect(out).not.toMatch(/AAAA1111|BBBB2222/)
    expect(out).toContain('c=3')
  })
  it('does not redact boolean/null flags such as has_token', () => {
    expect(redactSecretPatterns('has_token=true')).toBe('has_token=true')
    expect(redactForLog({ has_token: true, token: 'zzz' })).toEqual({ has_token: true, token: '[redacted]' })
  })
})

describe('more patterns and false positives (round 2)', () => {
  it('redacts Resend keys and URL passwords', () => {
    const resend = ['re', '_AbCdEf12_GhIjKlMnOpQrStUvWx'].join('')
    const out = String(redactForLog(`mail failed ${resend} via postgres://app:s3cr3tpass@db.example:5432/x`))
    expect(out).not.toContain('AbCdEf12')
    expect(out).not.toContain('s3cr3tpass')
    expect(out).toContain('db.example')
  })
  it('does not treat digit runs, sequence numbers, short refs or timestamps as PII', () => {
    for (const s of [
      'processed 100 200 3000 rows',
      'processed 400 200 3000 rows',
      'seq +12345 then +987',
      'ref x@y.z and agent@squad',
      'at +1 2026-11-04T17:09:19Z ok',
      'sizes 1024 2048 4096 8192',
    ]) {
      expect(redactForLog(s)).toBe(s)
    }
  })
  it('still redacts real phone formats', () => {
    for (const p of ['+1 (416) 555-0199', '416-555-0199', '416.555.0199', '(416) 555 0199', '+44 20 7946 0958']) {
      expect(String(redactForLog(`call ${p} now`))).toContain('[redacted-phone]')
    }
  })
})

describe('ops-key allowlist with scrubbed, capped unknown strings (round 2)', () => {
  it('keeps allowlisted ops keys intact', () => {
    const ops = { id: 'a', message_id: 'm', task_id: 't', status: 'blocked', http_status: 502, code: 'E1', count: 3, ms: 12, kind: 'k', type: 'task.blocked', seq: 4, attempt: 2, tenant: 'acme', slug: 'pot-1', created_at: '2026-11-04T17:09:19.485Z', route: 'external_inbox', metric: 'm.x' }
    expect(redactForLog(ops)).toEqual(ops)
  })
  it('caps and scrubs unknown string keys instead of dropping them', () => {
    const out = redactForLog({ reason: 'x'.repeat(500), detail_text: `ping ${EMAIL} please`, note_len: 5 }) as Record<string, string | number>
    expect(String(out.reason).length).toBeLessThanOrEqual(130)
    expect(String(out.reason).length).toBeGreaterThan(20)
    expect(String(out.detail_text)).toContain('ping')
    expect(String(out.detail_text)).not.toContain('jane.doe')
    expect(out.note_len).toBe(5)
  })
  it('caps name and message but keeps them readable', () => {
    const out = redactForLog({ name: 'a'.repeat(400), message: 'upstream down' }) as Record<string, string>
    expect(out.name.length).toBeLessThanOrEqual(130)
    expect(out.message).toBe('upstream down')
  })
  it('the consumer free-text fields are bounded', () => {
    const out = JSON.stringify(redactForLog({ reason: 'r'.repeat(1000), slug: 'pot-1' }))
    expect(out.length).toBeLessThan(400)
  })
})
