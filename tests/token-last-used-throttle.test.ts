// tests/token-last-used-throttle.test.ts — the last_used_at stamp is throttled to once per 60 s.
//
// The stamp is a D1 WRITE on every authenticated request. Both bearer lookups
// (src/auth/member-bearer.ts resolveMemberByToken, src/mcp/index.ts authenticateMember) now read
// `last_used_at` in the SAME query and skip the write when it is fresher than
// LAST_USED_STAMP_MIN_INTERVAL_MS. Real SQLite over the whole committed migration chain; the
// DB handed to production code is a thin recording proxy so the UPDATE count is observable, but
// every statement still executes for real.
//
// last_used_at is telemetry. Several cases assert the AUTH OUTCOME is identical whether or not
// the stamp is skipped or fails.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveMemberByToken } from '../src/auth/member-bearer'
import {
  LAST_USED_STAMP_MIN_INTERVAL_MS,
  nowSqlUtc,
  shouldStampLastUsed,
} from '../src/auth/token-lifecycle'
import { authenticateMember } from '../src/mcp'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'digid'
const RAW = 'throttle-test-key'
const HASH = createHash('sha256').update(RAW).digest('hex')

const sqlUtc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

describe('shouldStampLastUsed', () => {
  const NOW = Date.parse('2026-10-23T12:00:00Z')

  it('constant is 60 s', () => expect(LAST_USED_STAMP_MIN_INTERVAL_MS).toBe(60_000))

  it('stale stamp (1 h) => stamp', () => expect(shouldStampLastUsed('2026-10-23 11:00:00', NOW)).toBe(true))
  it('fresh (30 s, SQL UTC text) => skip', () => expect(shouldStampLastUsed('2026-10-23 11:59:30', NOW)).toBe(false))
  it('fresh (0 s) => skip', () => expect(shouldStampLastUsed('2026-10-23 12:00:00', NOW)).toBe(false))
  it('59 s => skip (just inside)', () => expect(shouldStampLastUsed('2026-10-23 11:59:01', NOW)).toBe(false))
  it('exactly 60 s => stamp (boundary is inclusive of the interval)', () =>
    expect(shouldStampLastUsed('2026-10-23 11:59:00', NOW)).toBe(true))
  it('61 s => stamp', () => expect(shouldStampLastUsed('2026-10-23 11:58:59', NOW)).toBe(true))

  it('ISO shape with Z and millis parses the same as SQL text', () => {
    expect(shouldStampLastUsed('2026-10-23T11:59:30.250Z', NOW)).toBe(false)
    expect(shouldStampLastUsed('2026-10-23T11:58:00.000Z', NOW)).toBe(true)
  })

  it('SQL text is read as UTC, not local time (no zone suffix)', () => {
    // If it were parsed as local time in a non-UTC zone, 30 s ago would be hours off.
    const stored = sqlUtc(Date.now() - 30_000)
    expect(shouldStampLastUsed(stored, Date.now())).toBe(false)
    expect(shouldStampLastUsed(nowSqlUtc(), Date.now())).toBe(false)
  })

  it('SQL text is UTC even when the host zone is not (TZ=Asia/Tokyo and America/Toronto)', () => {
    const prior = process.env.TZ
    try {
      for (const tz of ['Asia/Tokyo', 'America/Toronto']) {
        process.env.TZ = tz
        expect(shouldStampLastUsed('2026-10-23 11:59:30', NOW), tz).toBe(false)
        expect(shouldStampLastUsed('2026-10-23 11:58:00', NOW), tz).toBe(true)
      }
    } finally {
      if (prior === undefined) delete process.env.TZ
      else process.env.TZ = prior
    }
  })

  it('null / undefined / empty => stamp', () => {
    expect(shouldStampLastUsed(null, NOW)).toBe(true)
    expect(shouldStampLastUsed(undefined, NOW)).toBe(true)
    expect(shouldStampLastUsed('', NOW)).toBe(true)
  })

  it('malformed => stamp', () => {
    for (const bad of ['garbage', '2026-13-45 99:99:99', '12345', 'yesterday', '2026-10-23', '2026-10-23 11:59:30 +05:00']) {
      expect(shouldStampLastUsed(bad, NOW), bad).toBe(true)
    }
  })

  it('future timestamp => stamp (never trust a clock skew into suppressing writes)', () => {
    expect(shouldStampLastUsed('2026-10-23 12:00:01', NOW)).toBe(true)
    expect(shouldStampLastUsed('2099-01-01 00:00:00', NOW)).toBe(true)
  })

  it('non-string value (driver oddity) => stamp', () => {
    expect(shouldStampLastUsed(1_700_000_000 as unknown as string, NOW)).toBe(true)
  })
})

interface Probe {
  env: Env
  updates: () => number
}

function probe(h: SqliteD1Harness, opts: { failUpdates?: boolean } = {}): Probe {
  let n = 0
  const db = {
    prepare(sql: string) {
      const stmt = h.db.prepare(sql)
      if (!/^\s*UPDATE member_tokens SET last_used_at/.test(sql)) return stmt
      n += 1
      if (!opts.failUpdates) return stmt
      return { bind: () => ({ run: async () => { throw new Error('D1 write failed') } }) }
    },
  }
  return { env: { TENANT_SLUG: TENANT, DB: db } as unknown as Env, updates: () => n }
}

function seed(h: SqliteD1Harness, lastUsedAt: string | null): void {
  h.sqlite
    .prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-t', 'mem-t@digid.test', 'T', 'active', ?)`)
    .run(TENANT)
  h.sqlite
    .prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, last_used_at, tenant)
       VALUES ('tok-t', 'mem-t', ?, 'test', 'workspace', datetime('now'), ?, ?)`,
    )
    .run(HASH, lastUsedAt, TENANT)
}

const storedStamp = (h: SqliteD1Harness): string | null =>
  (h.sqlite.prepare(`SELECT last_used_at AS v FROM member_tokens WHERE id = 'tok-t'`).get() as { v: string | null }).v

const request = (rawToken: string) => ({
  req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${rawToken}` : undefined) },
})

type Door = { name: string; auth: (env: Env) => Promise<{ memberId: string; tokenId: string } | null> }

const doors: Door[] = [
  { name: 'resolveMemberByToken (REST)', auth: (env) => resolveMemberByToken(env, RAW) },
  { name: 'authenticateMember (MCP)', auth: async (env) => authenticateMember({ ...request(RAW), env }) },
]

describe.each(doors)('last_used_at throttle at $name', ({ auth }) => {
  let h: SqliteD1Harness
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
  })
  afterEach(() => h.close())

  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('stale stamp => exactly one UPDATE issued, and it lands', async () => {
    seed(h, sqlUtc(Date.now() - 3_600_000))
    const p = probe(h)
    const out = await auth(p.env)
    await tick()
    expect(out).toMatchObject({ memberId: 'mem-t', tokenId: 'tok-t' })
    expect(p.updates()).toBe(1)
    expect(Date.parse(`${storedStamp(h)!.replace(' ', 'T')}Z`)).toBeGreaterThan(Date.now() - 5_000)
  })

  it('fresh (<60 s) stamp => NO UPDATE issued, stored value untouched', async () => {
    const fresh = sqlUtc(Date.now() - 5_000)
    seed(h, fresh)
    const p = probe(h)
    const out = await auth(p.env)
    await tick()
    expect(out).toMatchObject({ memberId: 'mem-t', tokenId: 'tok-t' })
    expect(p.updates()).toBe(0)
    expect(storedStamp(h)).toBe(fresh)
  })

  it('NULL stamp (never used) => UPDATE issued', async () => {
    seed(h, null)
    const p = probe(h)
    await auth(p.env)
    await tick()
    expect(p.updates()).toBe(1)
    expect(storedStamp(h)).not.toBeNull()
  })

  it('malformed stored stamp => UPDATE issued', async () => {
    seed(h, 'not-a-timestamp')
    const p = probe(h)
    await auth(p.env)
    await tick()
    expect(p.updates()).toBe(1)
  })

  it('future stored stamp => UPDATE issued', async () => {
    seed(h, sqlUtc(Date.now() + 3_600_000))
    const p = probe(h)
    await auth(p.env)
    await tick()
    expect(p.updates()).toBe(1)
  })

  it('auth outcome is identical whether the stamp is skipped or issued', async () => {
    seed(h, sqlUtc(Date.now() - 5_000))
    const skipped = await auth(probe(h).env)
    h.sqlite.prepare(`UPDATE member_tokens SET last_used_at = ? WHERE id = 'tok-t'`).run(sqlUtc(Date.now() - 3_600_000))
    const stamped = await auth(probe(h).env)
    expect(skipped).toEqual(stamped)
    expect(skipped).not.toBeNull()
  })

  it('a fresh stamp never rescues a dead token (telemetry, not authorization)', async () => {
    seed(h, sqlUtc(Date.now() - 5_000))
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now', '-1 hour') WHERE id = 'tok-t'`).run()
    expect(await auth(probe(h).env)).toBeNull()
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = NULL, expires_at = '2020-01-01 00:00:00' WHERE id = 'tok-t'`).run()
    expect(await auth(probe(h).env)).toBeNull()
  })

  it('a stale stamp does not demote a live token', async () => {
    seed(h, '2020-01-01 00:00:00')
    expect(await auth(probe(h).env)).not.toBeNull()
  })

  it('a FAILED stamp (stale row, UPDATE rejects) still authenticates', async () => {
    seed(h, sqlUtc(Date.now() - 3_600_000))
    const p = probe(h, { failUpdates: true })
    const out = await auth(p.env)
    await tick()
    expect(p.updates()).toBe(1)
    expect(out).toMatchObject({ memberId: 'mem-t', tokenId: 'tok-t' })
  })

  it('repeated calls inside the window write once (the seatlink revalidation shape)', async () => {
    seed(h, null)
    const p = probe(h)
    for (let i = 0; i < 5; i++) {
      await auth(p.env)
      await tick()
    }
    expect(p.updates()).toBe(1)
  })
})
