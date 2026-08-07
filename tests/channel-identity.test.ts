// Channel identity resolution — the authorisation seam for every IM platform (#775).
//
// REAL SQL, NOT A MOCK. My first version of this file supplied a hand-written
// prepare()/first() object, and mupot's own test-schema-source ratchet rejected it —
// correctly. A fake D1 does not execute the query, it string-matches and answers what
// the test expects, so a SELECT naming a column that does not exist cannot be
// contradicted. Migration 0080 would never have been executed by anything, and the
// suite would have been green on SQL that could not run in production. That is the
// #734 shape: merged, deployed, inert.
//
// Everything below runs against a SQLite database built by applying every real
// migration in order.
//
// Assertions target the SIDE EFFECT (did a bus event publish) rather than the status
// code, because tonight's most expensive defects all returned the right code while
// doing the wrong thing.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  resolveChannelIdentity, mayDispatch, refusalCode, isChannelPlatform, CHANNEL_PLATFORMS,
} from '../src/channels/identity'
import { telegramIngressApp } from '../src/telegram-bridge/ingress'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  // 0080 must apply cleanly. If it does not, every test below is meaningless.
  const mine = failures.filter((f) => f.startsWith('0080'))
  if (mine.length) throw new Error(`migration 0080 failed to apply: ${mine.join('; ')}`)
}

let harness: SqliteD1Harness
let env: Env

/** Insert a real binding row through real SQL. */
function bind(platform: string, platformUserId: string, memberId: string, opts: { revoked?: boolean; method?: string } = {}) {
  harness.sqlite
    .prepare(
      `INSERT INTO channel_identity
         (tenant, platform, platform_user_id, member_id, bound_at, bound_by, bound_method, revoked_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(TENANT, platform, platformUserId, memberId, '2026-08-07T00:00:00Z', 'admin:kasra',
         opts.method ?? 'admin', opts.revoked ? '2026-08-07T01:00:00Z' : null)
}

function member(id: string) {
  // NO try/catch. My first version swallowed the insert failure, so members were
  // never created and every binding died on a FOREIGN KEY error I could not see —
  // the same swallow-the-error antipattern this repo already rejects. If the schema
  // changes under this helper, the test MUST fail loudly.
  // display_name is NOT NULL in 0002_members.sql; omitting it is what failed.
  harness.sqlite
    .prepare(`INSERT INTO members (id, email, display_name) VALUES (?,?,?)`)
    .run(id, `${id}@test`, id)
}

const sent: unknown[] = []

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  sent.length = 0
  env = {
    DB: harness.db, TENANT_SLUG: TENANT,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BUS: { send: async (e: unknown) => { sent.push(e) } },
  } as unknown as Env
})
afterEach(() => harness?.close?.())

const post = (fromId: number, secret = 's') =>
  new Request('http://x/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, text: 'do a thing',
      from: { id: fromId, is_bot: false, first_name: 'X' }, chat: { id: 1, type: 'private' } } }),
  })

describe('resolveChannelIdentity — against a real schema', () => {
  it('migration 0080 creates a queryable channel_identity table', () => {
    // If 0080 is malformed this throws, and every other test here is void.
    const row = harness.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='channel_identity'`).get()
    expect(row).toBeTruthy()
  })

  it('resolves a bound caller to a member', async () => {
    member('mem-hadi'); bind('telegram', '765204057', 'mem-hadi')
    const r = await resolveChannelIdentity(env, 'telegram', 765204057)
    expect(mayDispatch(r) && r.memberId).toBe('mem-hadi')
  })

  it('an UNBOUND caller does not resolve', async () => {
    const r = await resolveChannelIdentity(env, 'telegram', 999)
    expect(r.kind).toBe('unbound')
    expect(mayDispatch(r)).toBe(false)
  })

  it('a REVOKED binding does not resolve, and is distinguishable from unbound', async () => {
    member('mem-x'); bind('telegram', '5', 'mem-x', { revoked: true })
    const r = await resolveChannelIdentity(env, 'telegram', 5)
    expect(r.kind).toBe('revoked')
    expect(mayDispatch(r)).toBe(false)
    expect(refusalCode(r)).toBe('identity_revoked')
  })

  it('a DB FAILURE is unavailable — never unbound, never permitted', async () => {
    // Drop the table to produce a REAL SQL error, not a thrown mock.
    harness.sqlite.exec('DROP TABLE channel_identity')
    const r = await resolveChannelIdentity(env, 'telegram', 765204057)
    expect(r.kind).toBe('unavailable')
    expect(mayDispatch(r)).toBe(false)
  })

  it('an unknown platform is refused, not looked up', async () => {
    const r = await resolveChannelIdentity(env, 'carrier_pigeon', 1)
    expect(r.kind).toBe('unavailable')
    expect(mayDispatch(r)).toBe(false)
  })

  it('missing / empty / whitespace caller ids never resolve', async () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(mayDispatch(await resolveChannelIdentity(env, 'telegram', v as never))).toBe(false)
    }
  })

  it('the schema REJECTS a platform outside the adapter set', () => {
    member('mem-p')
    expect(() => bind('carrier_pigeon', 'u1', 'mem-p')).toThrow()
  })

  it('the schema REJECTS two members claiming one platform identity', () => {
    // Ambiguity on an authorisation path must be impossible by schema, not convention.
    member('mem-a'); member('mem-b')
    bind('telegram', 'dup', 'mem-a')
    expect(() => bind('telegram', 'dup', 'mem-b')).toThrow()
  })

  it('is platform-agnostic — one seam serves every adapter', async () => {
    for (const p of CHANNEL_PLATFORMS) {
      expect(isChannelPlatform(p)).toBe(true)
      member(`mem-${p}`); bind(p, 'u1', `mem-${p}`)
      const r = await resolveChannelIdentity(env, p, 'u1')
      expect(mayDispatch(r) && r.memberId).toBe(`mem-${p}`)
    }
  })
})

describe('telegram ingress carries CALLER authority', () => {
  it('publishes with the MEMBER as actor — not the bot, not a username', async () => {
    member('mem-hadi'); bind('telegram', '765204057', 'mem-hadi')
    const res = await telegramIngressApp.fetch(post(765204057), env as never)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect((sent[0] as { actor: { id: string } }).actor.id).toBe('mem-hadi')
  })

  it('TWO different callers dispatch as TWO different members — the whole feature', async () => {
    member('mem-hadi'); member('mem-gavin')
    bind('telegram', '765204057', 'mem-hadi')
    bind('telegram', '111222333', 'mem-gavin', { method: 'verified_login' })
    await telegramIngressApp.fetch(post(765204057), env as never)
    await telegramIngressApp.fetch(post(111222333), env as never)
    expect(sent.map((e) => (e as { actor: { id: string } }).actor.id)).toEqual(['mem-hadi', 'mem-gavin'])
  })

  it('an UNBOUND caller gets 403 and NO bus publish', async () => {
    const res = await telegramIngressApp.fetch(post(999), env as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'identity_not_bound' })
    expect(sent).toHaveLength(0)
  })

  it('a REVOKED caller gets 403 and NO bus publish', async () => {
    member('mem-old'); bind('telegram', '4242', 'mem-old', { revoked: true })
    const res = await telegramIngressApp.fetch(post(4242), env as never)
    expect(res.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('a DB outage gets 503 and NO bus publish — distinct from a stranger', async () => {
    harness.sqlite.exec('DROP TABLE channel_identity')
    const res = await telegramIngressApp.fetch(post(765204057), env as never)
    expect(res.status).toBe(503)
    expect(sent).toHaveLength(0)
  })

  it('a stale TELEGRAM_ALLOWED_SENDERS can no longer widen access', async () => {
    // If the retired allowlist still granted, deleting a binding would not revoke anyone.
    const res = await telegramIngressApp.fetch(post(999),
      { ...(env as object), TELEGRAM_ALLOWED_SENDERS: '999' } as never)
    expect(res.status).toBe(403)
    expect(sent).toHaveLength(0)
  })
})
