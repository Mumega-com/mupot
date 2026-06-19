// tests/cro-collect.test.ts — the CRO ingest runner (slice 2): persist EXTERNAL signal into
// metric_points, with the first-party write-amplification guard and per-point fail-soft.

import { describe, it, expect } from 'vitest'
import { runCroCollection } from '../src/cro/collect'
import type { CroSource, CroMetric } from '../src/cro/sources'
import { FIRST_PARTY_KEY } from '../src/cro/first-party'
import type { Env } from '../src/types'

// A fake D1 that records every metric_points INSERT and lets a test force duplicate / error.
function fakeDb(opts?: { mode?: 'ok' | 'duplicate' | 'throw' }) {
  const mode = opts?.mode ?? 'ok'
  const inserts: Array<{ tenant: string; key: string; value: number; occurred_at: string; source: string }> = []
  const db = {
    prepare(sql: string) {
      const binds: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          binds.push(...a)
          return stmt
        },
        async run() {
          // emitMetric binds: (id, tenant, metric_key, value, occurred_at, source, created_at)
          if (sql.includes('INSERT INTO metric_points')) {
            if (mode === 'throw') throw new Error('disk full')
            if (mode === 'duplicate') {
              throw new Error(
                'UNIQUE constraint failed: metric_points.tenant_id, metric_points.metric_key, metric_points.occurred_at, metric_points.source',
              )
            }
            inserts.push({
              tenant: binds[1] as string,
              key: binds[2] as string,
              value: binds[3] as number,
              occurred_at: binds[4] as string,
              source: binds[5] as string,
            })
            return { success: true, meta: { changes: 1, rows_written: 1 } }
          }
          return { success: true, meta: { changes: 0 } }
        },
      }
      return stmt
    },
  }
  return { db: db as unknown as Env['DB'], inserts }
}

function env(db: Env['DB'], over: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 'mumega', DB: db, ...over } as unknown as Env
}

// A deterministic fake source (no network) — its key becomes the metric_points.source stamp.
function fakeSource(key: string, metrics: CroMetric[], over: Partial<CroSource> = {}): CroSource {
  return {
    key,
    label: key,
    available: async () => true,
    collect: async () => metrics,
    ...over,
  }
}

const NOW = '2026-06-19T12:00:00.000Z'
const M = (k: string, v: number): CroMetric => ({ metric_key: k, value: v, occurred_at: NOW })

describe('runCroCollection — persist external CRO signal', () => {
  it('writes each external point into metric_points, tenant-bound + source-stamped', async () => {
    const { db, inserts } = fakeDb()
    const src = fakeSource('posthog', [M('cro.posthog.events_24h', 100), M('cro.posthog.users_24h', 9)])
    const summary = await runCroCollection(env(db), [src])

    expect(summary).toMatchObject({ emitted: 2, duplicate: 0, failed: 0, skippedFirstParty: 0 })
    expect(inserts).toHaveLength(2)
    expect(inserts.every((r) => r.tenant === 'mumega')).toBe(true)
    expect(inserts.every((r) => r.source === 'posthog')).toBe(true)
    expect(inserts.map((r) => r.key)).toEqual(['cro.posthog.events_24h', 'cro.posthog.users_24h'])
  })

  it('NEVER persists a first-party-keyed point (write-amplification guard)', async () => {
    const { db, inserts } = fakeDb()
    // a source masquerading with the first-party key — its points must be skipped, not written
    const fp = fakeSource(FIRST_PARTY_KEY, [M('growth.leads', 5)])
    const ph = fakeSource('posthog', [M('cro.posthog.events_24h', 7)])
    const summary = await runCroCollection(env(db), [fp, ph])

    expect(summary.skippedFirstParty).toBe(1)
    expect(summary.emitted).toBe(1)
    expect(inserts.map((r) => r.source)).toEqual(['posthog']) // first-party never hit the DB
  })

  it('a broken source degrades — the sweep still persists the healthy one, never crashes', async () => {
    const { db, inserts } = fakeDb()
    const broken = fakeSource('crm', [], { collect: async () => { throw new Error('crm 503') } })
    const ph = fakeSource('posthog', [M('cro.posthog.events_24h', 3)])
    const summary = await runCroCollection(env(db), [broken, ph])

    expect(summary.emitted).toBe(1)
    expect(inserts).toHaveLength(1)
  })

  it('counts duplicates (idempotent re-tick) without failing', async () => {
    const { db } = fakeDb({ mode: 'duplicate' })
    const ph = fakeSource('posthog', [M('cro.posthog.events_24h', 1), M('cro.posthog.users_24h', 1)])
    const summary = await runCroCollection(env(db), [ph])
    expect(summary).toMatchObject({ emitted: 0, duplicate: 2, failed: 0 })
  })

  it('per-point fail-soft: one emit error is counted, the rest is unaffected', async () => {
    const { db } = fakeDb({ mode: 'throw' })
    const ph = fakeSource('posthog', [M('cro.posthog.events_24h', 1), M('cro.posthog.users_24h', 1)])
    const summary = await runCroCollection(env(db), [ph])
    expect(summary).toMatchObject({ emitted: 0, failed: 2 })
  })

  it('fail-closed when the pot has no tenant slug (writes nothing)', async () => {
    const { db, inserts } = fakeDb()
    const ph = fakeSource('posthog', [M('cro.posthog.events_24h', 1)])
    const summary = await runCroCollection(env(db, { TENANT_SLUG: '' }), [ph])
    expect(summary).toMatchObject({ emitted: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('defaults to EXTERNAL_CRO_SOURCES when no sources injected (PostHog unavailable ⇒ no writes, no crash)', async () => {
    const { db, inserts } = fakeDb()
    // no POSTHOG creds ⇒ posthog source available()=false ⇒ nothing collected/persisted
    const summary = await runCroCollection(env(db))
    expect(summary).toMatchObject({ emitted: 0, duplicate: 0, failed: 0 })
    expect(inserts).toHaveLength(0)
  })
})
