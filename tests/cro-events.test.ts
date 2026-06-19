// tests/cro-events.test.ts — the CRO event grain: validated, tenant-bound, capped write + read.

import { describe, it, expect } from 'vitest'
import { recordCroEvents, readCroEvents, MAX_EVENTS_PER_WRITE, MAX_EVENTS_PER_READ } from '../src/cro/events'
import type { CroEventInput, CroEventRow } from '../src/cro/events'
import type { Env } from '../src/types'

function makeEnv(opts: { tenant?: string; rows?: CroEventRow[] } = {}) {
  const inserts: unknown[][] = []
  let lastSql = ''
  let lastBinds: unknown[] = []
  const env = {
    TENANT_SLUG: opts.tenant ?? 'mumega',
    DB: {
      prepare(sql: string) {
        const stmt = {
          _binds: [] as unknown[],
          bind(...args: unknown[]) {
            stmt._binds = args
            lastSql = sql
            lastBinds = args
            return stmt
          },
          async all() {
            return { results: opts.rows ?? [] }
          },
        }
        return stmt
      },
      async batch(stmts: Array<{ _binds: unknown[] }>) {
        for (const s of stmts) inserts.push(s._binds)
        return stmts.map(() => ({ meta: { changes: 1 } }))
      },
    },
  } as unknown as Env
  return { env, inserts, sql: () => lastSql, binds: () => lastBinds }
}

const ev = (over: Partial<CroEventInput> = {}): CroEventInput => ({
  source: 'first_party',
  event_name: 'pageview',
  occurred_at: 1_750_000_000_000,
  ...over,
})

describe('recordCroEvents', () => {
  it('FORCES tenant_id to the pot tenant (a source can never write another tenant)', async () => {
    const { env, inserts } = makeEnv({ tenant: 'mumega' })
    // even if the input tried to carry a tenant, there is no field for it — bound server-side
    const res = await recordCroEvents(env, [ev()])
    expect(res.written).toBe(1)
    expect(inserts[0][1]).toBe('mumega') // bind position 1 = tenant_id
  })

  it('validates: rejects missing source / event_name / bad occurred_at, counts rejected', async () => {
    const { env, inserts } = makeEnv()
    const res = await recordCroEvents(env, [
      ev(),
      ev({ source: '' }), // missing source
      ev({ event_name: '  ' }), // blank event_name
      ev({ occurred_at: NaN }), // bad ts
      ev({ occurred_at: 0 }), // non-positive ts
    ])
    expect(res).toMatchObject({ written: 1, rejected: 4 })
    expect(inserts).toHaveLength(1)
  })

  it('caps the batch at MAX_EVENTS_PER_WRITE (truncate + flag)', async () => {
    const { env, inserts } = makeEnv()
    const many = Array.from({ length: MAX_EVENTS_PER_WRITE + 50 }, () => ev())
    const res = await recordCroEvents(env, many)
    expect(res).toMatchObject({ written: MAX_EVENTS_PER_WRITE, capped: true })
    expect(inserts).toHaveLength(MAX_EVENTS_PER_WRITE)
  })

  it('returns written:0 (never writes) when the pot has no tenant slug', async () => {
    const { env, inserts } = makeEnv({ tenant: '' })
    const res = await recordCroEvents(env, [ev(), ev()])
    expect(res).toMatchObject({ written: 0, rejected: 2 })
    expect(inserts).toHaveLength(0)
  })

  it('serializes properties to JSON; unserializable → null', async () => {
    const { env, inserts } = makeEnv()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await recordCroEvents(env, [
      ev({ properties: { variant: 'B', device: 'mobile' } }),
      ev({ properties: circular }),
    ])
    expect(inserts[0][7]).toBe(JSON.stringify({ variant: 'B', device: 'mobile' })) // bind 7 = properties
    expect(inserts[1][7]).toBeNull()
  })

  it('handles an empty / non-array input gracefully', async () => {
    const { env } = makeEnv()
    expect(await recordCroEvents(env, [])).toMatchObject({ written: 0 })
    expect(await recordCroEvents(env, undefined as unknown as CroEventInput[])).toMatchObject({ written: 0 })
  })
})

describe('readCroEvents', () => {
  it('is tenant-scoped and clamps the limit to MAX_EVENTS_PER_READ', async () => {
    const { env, sql, binds } = makeEnv({ rows: [] })
    await readCroEvents(env, { source: 'posthog', eventName: 'signup', sinceMs: 1000, limit: 999_999 })
    expect(sql()).toContain('FROM cro_events')
    expect(sql()).toContain(`LIMIT ${MAX_EVENTS_PER_READ}`) // clamped
    expect(binds()[0]).toBe('mumega') // tenant first
    expect(binds()).toContain('posthog')
    expect(binds()).toContain('signup')
  })

  it('returns [] (no unscoped read) when there is no tenant slug', async () => {
    const { env } = makeEnv({ tenant: '' })
    expect(await readCroEvents(env, {})).toEqual([])
  })

  it('defaults to a bounded limit when none given', async () => {
    const { env, sql } = makeEnv()
    await readCroEvents(env, {})
    expect(sql()).toContain('LIMIT 500')
  })
})
