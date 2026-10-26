import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleInboundEmail, summarizeHeaders, SPIKE_REJECT_MESSAGE, MAX_RECEIPTS_PER_HOUR } from '../src/email-decisions/inbound'
import type { Env } from '../src/types'

let h: SqliteD1Harness | undefined
afterEach(() => { h?.close(); h = undefined })

function setup(flag: string | undefined): { env: Env; rows: () => Record<string, unknown>[] } {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  // Env is wide; the handler reads only DB + EMAIL_DECISIONS. Cast is test-only.
  const env = { DB: h.db, EMAIL_DECISIONS: flag } as unknown as Env
  return { env, rows: () => h!.sqlite.prepare('SELECT * FROM email_inbound_receipts').all() as Record<string, unknown>[] }
}

function msg(headers: Record<string, string>, extra: Partial<{ from: string; to: string; rawSize: number }> = {}) {
  const rejects: string[] = []
  return {
    rejects,
    m: { from: extra.from ?? 'hadi@example.com', to: extra.to ?? 'approve+TOKEN123@decide.mumega.com', rawSize: extra.rawSize ?? 1234, headers: new Headers(headers), setReject: (r: string) => { rejects.push(r) } },
  }
}

describe('spike handler', () => {
  it('flag off: rejects early and writes no row', async () => {
    const { env, rows } = setup(undefined)
    const { m, rejects } = msg({ 'authentication-results': 'dmarc=pass' })
    await handleInboundEmail(m, env)
    expect(rejects).toEqual([SPIKE_REJECT_MESSAGE])
    expect(rows()).toEqual([])
  })
  it.each(['0', 'true', ''])('flag %j is off', async (v) => {
    const { env, rows } = setup(v)
    await handleInboundEmail(msg({}).m, env)
    expect(rows()).toEqual([])
  })

  it('flag on: one row, names + whitelisted values only, keeps +token, rejects', async () => {
    const { env, rows } = setup('1')
    const { m, rejects } = msg({
      'Authentication-Results': 'mx.cf; dkim=pass header.d=gmail.com; dmarc=pass',
      'Received-SPF': 'pass',
      'DKIM-Signature': 'v=1; a=rsa-sha256; d=gmail.com; s=20230601; b=SECRETSIGBLOB; bh=BODYHASH',
      'X-CF-Spam': 'ok',
      'Subject': 'Re: Decision needed SENSITIVE-SUBJECT',
      'From': 'Hadi <hadi@example.com>',
      'To': 'approve+TOKEN123@decide.mumega.com',
      'Message-ID': '<abc@mail.gmail.com>',
    })
    await handleInboundEmail(m, env)
    expect(rejects).toEqual([SPIKE_REJECT_MESSAGE])
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].envelope_to).toBe('approve+TOKEN123@decide.mumega.com')
    expect(r[0].envelope_from).toBe('hadi@example.com')
    expect(r[0].raw_size).toBe(1234)
    const names = JSON.parse(String(r[0].header_names)) as string[]
    expect(names).toEqual(expect.arrayContaining(['subject', 'from', 'to', 'dkim-signature', 'x-cf-spam']))
    const values = JSON.parse(String(r[0].header_values)) as Record<string, string[]>
    expect(Object.keys(values).sort()).toEqual(['authentication-results', 'dkim-signature', 'message-id', 'received-spf', 'x-cf-spam'])
    expect(values['dkim-signature']).toEqual(['d=gmail.com; s=20230601'])
    const blob = JSON.stringify(r[0])
    expect(blob).not.toContain('SENSITIVE-SUBJECT')
    expect(blob).not.toContain('SECRETSIGBLOB')
  })

  it('redacts a header value over 2 KB', () => {
    const { values } = summarizeHeaders(new Headers({ 'Authentication-Results': 'x'.repeat(3000) }))
    expect(values['authentication-results'][0]).toMatch(/^\[redacted: 3000 chars\]$/)
  })

  it('oversize mail is recorded as oversize and never read', async () => {
    const { env, rows } = setup('1')
    await handleInboundEmail(msg({}, { rawSize: 10_000_000 }).m, env)
    expect(rows()[0].outcome).toBe('spike_rejected_oversize')
  })

  it('hourly cap bounds the unauthenticated writer', async () => {
    const { env, rows } = setup('1')
    const now = new Date('2026-10-26T12:00:00Z')
    for (let i = 0; i < MAX_RECEIPTS_PER_HOUR + 5; i += 1) await handleInboundEmail(msg({}).m, env, now)
    expect(rows()).toHaveLength(MAX_RECEIPTS_PER_HOUR)
  })
})

describe('0260 schema', () => {
  it('task_verdict_channels is append-only and task_verdicts is untouched', () => {
    setup('1')
    const cols = (h!.sqlite.prepare('PRAGMA table_info(task_verdicts)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('decided_channel')
    h!.sqlite.exec(`PRAGMA foreign_keys = OFF; INSERT INTO task_verdict_channels (verdict_id, channel, created_at) VALUES ('v1', 'email_reply', 'now')`)
    expect(() => h!.sqlite.exec(`UPDATE task_verdict_channels SET channel = 'email_reply'`)).toThrow(/append-only/)
    expect(() => h!.sqlite.exec(`DELETE FROM task_verdict_channels`)).toThrow(/append-only/)
    expect(() => h!.sqlite.exec(`INSERT INTO task_verdict_channels (verdict_id, channel, created_at) VALUES ('v2', 'sms', 'now')`)).toThrow()
  })
  it('one live binding per mailbox', () => {
    setup('1')
    const ins = (id: string, member: string, unbound: string | null) =>
      h!.sqlite.exec(`INSERT INTO email_decision_bindings (id, tenant, member_id, email_normalized, unbound_at, created_at) VALUES ('${id}', 't', '${member}', 'a@b.com', ${unbound ? `'${unbound}'` : 'NULL'}, 'now')`)
    ins('b1', 'm1', null)
    expect(() => ins('b2', 'm2', null)).toThrow()
    ins('b3', 'm3', 'then')
  })
})
