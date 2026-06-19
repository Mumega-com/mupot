// tests/cro-events.test.ts — the CRO event grain: validated, tenant-bound, capped write + read.

import { describe, it, expect } from 'vitest'
import { recordCroEvents, readCroEvents, MAX_EVENTS_PER_WRITE, MAX_EVENTS_PER_READ, MAX_FIELD_LEN } from '../src/cro/events'
import type { CroEventInput, CroEventRow } from '../src/cro/events'
import type { Env } from '../src/types'

// Mock that SIMULATES the unique-index dedup: INSERT OR IGNORE on a (tenant, source, event_key)
// already seen → 0 changes (the no-op). `seen` persists across batch() calls on the same env,
// so a second recordCroEvents (a retry) is correctly deduped. bind layout:
// [0]id [1]tenant [2]source [3]event_name [4]event_key [5]user_id [6]session_id [7]occurred_at [8]properties [9]created_at
function makeEnv(opts: { tenant?: string; rows?: CroEventRow[] } = {}) {
  const inserts: unknown[][] = []
  const seen = new Set<string>()
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
        return stmts.map((s) => {
          inserts.push(s._binds)
          const tenant = s._binds[1]
          const source = s._binds[2]
          const eventKey = s._binds[4]
          if (eventKey != null) {
            const k = `${tenant}|${source}|${eventKey}`
            if (seen.has(k)) return { meta: { changes: 0 } } // idempotent no-op
            seen.add(k)
          }
          return { meta: { changes: 1 } }
        })
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
    expect(inserts[0][8]).toBe(JSON.stringify({ variant: 'B', device: 'mobile' })) // bind 8 = properties
    expect(inserts[1][8]).toBeNull()
  })

  it('handles an empty / non-array input gracefully', async () => {
    const { env } = makeEnv()
    expect(await recordCroEvents(env, [])).toMatchObject({ written: 0 })
    expect(await recordCroEvents(env, undefined as unknown as CroEventInput[])).toMatchObject({ written: 0 })
  })

  it('BLOCK-1: idempotent on (source, event_key) — a connector RETRY is a no-op, never overcounts', async () => {
    const { env } = makeEnv()
    const e = ev({ event_key: 'ph-evt-abc123' })
    expect(await recordCroEvents(env, [e])).toMatchObject({ written: 1, deduped: 0 })
    // same env (same dedup state) = a re-delivery → 0 written, counted as deduped
    expect(await recordCroEvents(env, [e])).toMatchObject({ written: 0, deduped: 1 })
  })

  it('BLOCK-1: dedups duplicate event_keys WITHIN a single batch', async () => {
    const { env } = makeEnv()
    const res = await recordCroEvents(env, [
      ev({ event_key: 'k1' }),
      ev({ event_key: 'k1' }), // dup in same batch
      ev({ event_key: 'k2' }),
    ])
    expect(res).toMatchObject({ written: 2, deduped: 1 })
  })

  it('keyless events are never deduped (no retry identity)', async () => {
    const { env } = makeEnv()
    const res = await recordCroEvents(env, [ev(), ev()]) // no event_key on either
    expect(res).toMatchObject({ written: 2, deduped: 0 })
  })

  it('BLOCK-2: rejects events with an oversized adapter field (>MAX_FIELD_LEN)', async () => {
    const { env, inserts } = makeEnv()
    const big = 'x'.repeat(MAX_FIELD_LEN + 1)
    const res = await recordCroEvents(env, [
      ev({ source: big }),
      ev({ event_name: big }),
      ev({ user_id: big }),
      ev({ session_id: big }),
      ev({ event_key: big }),
      ev(), // the one valid event
    ])
    expect(res).toMatchObject({ written: 1, rejected: 5 })
    expect(inserts).toHaveLength(1)
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
