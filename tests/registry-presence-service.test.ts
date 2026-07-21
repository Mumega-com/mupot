// tests/registry-presence-service.test.ts — module_registry / presence service layer
// (src/registry/service.ts, migration 0066). Module Kernel Port 1: the durable
// presence primitive. Design: docs/architecture/mupot-module-kernel.md.
//
// Coverage (against REAL D1/SQL via the sqlite-d1 test harness — no JS-reimplemented
// mock of the queries):
//   1. register -> appears online in listPresence.
//   2. heartbeat keeps a module online across time.
//   3. no heartbeat past the stale window -> listPresence reports it OFFLINE, and
//      CRITICALLY without any write ever happening (asserted directly against the raw
//      stored `status` column) — the test that would FAIL if stale-derivation were a
//      cron/sweep instead of query-time-derived, since no sweep ever runs here.
//   4. re-registering the SAME identity+project is an upsert (same row id, same
//      registered_at), never a duplicate.
//   5. project-scoped roster filtering: a project's roster excludes another
//      project's/unassigned modules, and vice versa.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  registerModule,
  heartbeatModule,
  deregisterModule,
  listPresence,
  getModule,
  PRESENCE_STALE_SECONDS,
} from '../src/registry/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'

// Full migration chain (mirrors tests/project-projections.test.ts's harness()) rather
// than a curated subset — 0055_projects.sql's triggers touch tasks/flights columns
// that accumulate across many later migrations, so cherry-picking risks a schema that
// doesn't match any real deploy. Loading everything in order is the safe default.
function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec("INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A')")
  harness.sqlite.exec("INSERT INTO projects (id, slug, name) VALUES ('proj-b', 'proj-b', 'Project B')")
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    rows: () => harness.sqlite.prepare('SELECT * FROM module_registry ORDER BY registered_at').all() as Array<Record<string, unknown>>,
    rawStatus: (identity: string, projectId: string | null) =>
      (harness.sqlite
        .prepare('SELECT status FROM module_registry WHERE tenant = ? AND identity = ? AND project_id IS ?')
        .get(TENANT, identity, projectId) as { status: string } | undefined)?.status,
  }
}

describe('registerModule — register appears online', () => {
  it('a fresh registration is online immediately', async () => {
    const db = makeDb()
    const result = await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('online')
      expect(result.value.project_id).toBe('proj-a')
      expect(result.value.adapter).toBe('claude_code')
    }
    const roster = await listPresence(db.env, { projectId: 'proj-a' })
    expect(roster).toHaveLength(1)
    expect(roster[0].identity).toBe('agent-1')
    expect(roster[0].status).toBe('online')
  })

  it('rejects an invalid kind and an empty adapter', async () => {
    const db = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badKind = await registerModule(db.env, { identity: 'a', kind: 'not_a_kind' as any, adapter: 'x', projectId: null })
    expect(badKind.ok).toBe(false)
    const badAdapter = await registerModule(db.env, { identity: 'a', kind: 'agent_system', adapter: '  ', projectId: null })
    expect(badAdapter.ok).toBe(false)
  })
})

describe('heartbeatModule — keeps a module online', () => {
  it('a heartbeat within the stale window keeps status online at read time', async () => {
    const db = makeDb()
    const t0 = new Date('2026-07-21T00:00:00.000Z')
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' }, t0)

    // Advance most of the way through the stale window, then heartbeat — the module
    // must still read online right up to (and just past) the ORIGINAL window edge.
    const t1 = new Date(t0.getTime() + (PRESENCE_STALE_SECONDS - 5) * 1000)
    const beat = await heartbeatModule(db.env, 'agent-1', 'proj-a', t1)
    expect(beat).toBe(true)

    const t2 = new Date(t1.getTime() + (PRESENCE_STALE_SECONDS - 5) * 1000) // past t0's window, within t1's
    const roster = await listPresence(db.env, { projectId: 'proj-a' }, t2)
    expect(roster[0].status).toBe('online')
  })

  it('heartbeating an unregistered identity returns false (register first)', async () => {
    const db = makeDb()
    const beat = await heartbeatModule(db.env, 'ghost', 'proj-a')
    expect(beat).toBe(false)
  })

  it('a heartbeat re-announces a module that had been explicitly deregistered', async () => {
    const db = makeDb()
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: null })
    await deregisterModule(db.env, 'agent-1', null)
    expect(db.rawStatus('agent-1', null)).toBe('offline')

    await heartbeatModule(db.env, 'agent-1', null)
    expect(db.rawStatus('agent-1', null)).toBe('online')
  })
})

describe('listPresence — stale heartbeat reads offline WITHOUT any write (query-time, not cron)', () => {
  it('a module past the stale window reads offline, and the stored row is untouched', async () => {
    const db = makeDb()
    const t0 = new Date('2026-07-21T00:00:00.000Z')
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' }, t0)

    // Sanity: the RAW stored status column is 'online' — nothing has ever set it to
    // 'offline'. If staleness were derived by a cron/sweep, this is the row a sweep
    // would need to visit and flip; NO sweep runs in this test.
    expect(db.rawStatus('agent-1', 'proj-a')).toBe('online')

    const wellPastWindow = new Date(t0.getTime() + (PRESENCE_STALE_SECONDS + 60) * 1000)
    const roster = await listPresence(db.env, { projectId: 'proj-a' }, wellPastWindow)
    expect(roster).toHaveLength(1)
    // THE test that fails if staleness were cron-derived: no write/sweep ran between
    // registration and this read, yet the roster already reports the module offline.
    expect(roster[0].status).toBe('offline')

    // And the stored column is STILL 'online' — proving the offline read came from
    // comparing last_heartbeat to `now` at read time, not from a background mutation.
    expect(db.rawStatus('agent-1', 'proj-a')).toBe('online')

    // getModule (self-lookup) derives the same way.
    const self = await getModule(db.env, 'agent-1', 'proj-a', wellPastWindow)
    expect(self?.status).toBe('offline')
  })

  it('exactly at the stale-window boundary still reads online; one second past reads offline', async () => {
    const db = makeDb()
    const t0 = new Date('2026-07-21T00:00:00.000Z')
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: null }, t0)

    const atBoundary = new Date(t0.getTime() + PRESENCE_STALE_SECONDS * 1000)
    const justPast = new Date(t0.getTime() + (PRESENCE_STALE_SECONDS + 1) * 1000)

    expect((await listPresence(db.env, {}, atBoundary))[0].status).toBe('online')
    expect((await listPresence(db.env, {}, justPast))[0].status).toBe('offline')
  })
})

describe('registerModule — re-register is an upsert, never a duplicate', () => {
  it('re-registering the same identity+project updates the SAME row in place', async () => {
    const db = makeDb()
    const first = await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })
    expect(first.ok).toBe(true)
    const firstId = first.ok ? first.value.id : null
    const firstRegisteredAt = first.ok ? first.value.registered_at : null

    const second = await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'cursor', projectId: 'proj-a' })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.id).toBe(firstId) // same row, not a new insert
      expect(second.value.adapter).toBe('cursor') // fields update in place
      expect(second.value.registered_at).toBe(firstRegisteredAt) // first-seen is preserved
    }

    expect(db.rows()).toHaveLength(1) // never a duplicate row
  })

  it('the SAME identity under a DIFFERENT project is a distinct registration (not a collision)', async () => {
    const db = makeDb()
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-b' })
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: null })
    expect(db.rows()).toHaveLength(3) // proj-a, proj-b, and "no project selected" are 3 distinct buckets
  })
})

describe('listPresence — project-scoped roster filtering', () => {
  it('a project roster only includes that project\'s registrations', async () => {
    const db = makeDb()
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })
    await registerModule(db.env, { identity: 'agent-2', kind: 'agent_system', adapter: 'cursor', projectId: 'proj-b' })
    await registerModule(db.env, { identity: 'agent-3', kind: 'agent_system', adapter: 'codex', projectId: null })

    const rosterA = await listPresence(db.env, { projectId: 'proj-a' })
    expect(rosterA.map((m) => m.identity)).toEqual(['agent-1'])

    const rosterB = await listPresence(db.env, { projectId: 'proj-b' })
    expect(rosterB.map((m) => m.identity)).toEqual(['agent-2'])

    const rosterNone = await listPresence(db.env, { projectId: null })
    expect(rosterNone.map((m) => m.identity)).toEqual(['agent-3'])

    const rosterAll = await listPresence(db.env, {})
    expect(rosterAll.map((m) => m.identity).sort()).toEqual(['agent-1', 'agent-2', 'agent-3'])
  })

  it('tenant scope: a second tenant\'s registrations never leak into this tenant\'s roster', async () => {
    const db = makeDb()
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })
    const otherTenantEnv = { ...db.env, TENANT_SLUG: 'tenant-b' }
    await registerModule(otherTenantEnv, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' })

    const roster = await listPresence(db.env, { projectId: 'proj-a' })
    expect(roster).toHaveLength(1)
    const otherRoster = await listPresence(otherTenantEnv, { projectId: 'proj-a' })
    expect(otherRoster).toHaveLength(1)
    expect(db.rows()).toHaveLength(2) // both rows exist, scoped by tenant, never merged
  })
})

describe('deregisterModule', () => {
  it('marks a module explicitly offline, independent of heartbeat freshness', async () => {
    const db = makeDb()
    const t0 = new Date('2026-07-21T00:00:00.000Z')
    await registerModule(db.env, { identity: 'agent-1', kind: 'agent_system', adapter: 'claude_code', projectId: 'proj-a' }, t0)
    const ok = await deregisterModule(db.env, 'agent-1', 'proj-a')
    expect(ok).toBe(true)
    // Read immediately (heartbeat is fresh) — still offline, because deregister is explicit.
    const roster = await listPresence(db.env, { projectId: 'proj-a' }, t0)
    expect(roster[0].status).toBe('offline')
  })

  it('deregistering an unregistered identity returns false', async () => {
    const db = makeDb()
    expect(await deregisterModule(db.env, 'ghost', 'proj-a')).toBe(false)
  })
})
