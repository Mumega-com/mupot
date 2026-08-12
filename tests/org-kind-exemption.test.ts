// tests/org-kind-exemption.test.ts — mupot#925 P0-N1 (second adversarial pass).
//
// org-create-limits.test.ts covers the GATE LOGIC (checkCreateLimit wiring,
// kind='home' skipping the gate call entirely) against a hand-rolled mock DB
// that returns the SAME configured count regardless of the query's WHERE
// clause — so it cannot prove the count query itself actually FILTERS by
// kind='work' rather than counting every row. This file drives the real
// migration chain (tests/helpers/migrations.ts) against real SQLite to prove
// that filtering for real: a 'home' row sitting in the table does NOT inflate
// the count a 'work' create's gate reads, and a 'work' row DOES.
//
// It also proves migration 0093's backfill directly: a department/squad/agent
// row inserted against the pre-0093 schema reads back as kind='work' once
// 0093 applies on top — the exact "pre-existing rows are 'work' after the
// migration" requirement from the build brief.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error Node 22 provides node:sqlite; see tests/helpers/sqlite-d1.ts
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { createDepartment, createSquad, createAgent } from '../src/org/service'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'test' } as unknown as Env
}

function seedFreeTier(harness: SqliteD1Harness): void {
  // No billing_state row -> resolveTier fails closed to 'free' already; this
  // is here for readability at call sites, not because it changes behavior.
  void harness
}

describe('migration 0093 backfill — pre-existing rows default to kind=\'work\'', () => {
  it('a department/squad/agent inserted against the PRE-0093 schema reads back as kind=\'work\' after 0093 applies', () => {
    const db = new DatabaseSync(':memory:') as { exec(sql: string): void; prepare(sql: string): { get(...v: unknown[]): Record<string, unknown> | undefined } }
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'))
    db.exec(`INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1')`)
    db.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S1')`)
    db.exec(`INSERT INTO agents (id, squad_id, slug, name) VALUES ('a1', 's1', 'a1', 'A1')`)

    // Sanity: the columns genuinely do not exist yet before 0093.
    expect(() => db.prepare('SELECT kind FROM departments').get()).toThrow()

    db.exec(readFileSync(join(MIGRATIONS_DIR, '0093_org_kind_home_exemption.sql'), 'utf8'))

    expect(db.prepare('SELECT kind FROM departments WHERE id = ?').get('d1')?.kind).toBe('work')
    expect(db.prepare('SELECT kind FROM squads WHERE id = ?').get('s1')?.kind).toBe('work')
    expect(db.prepare('SELECT kind FROM agents WHERE id = ?').get('a1')?.kind).toBe('work')
  })
})

describe('kind filtering is REAL — a home row never inflates a work-gate\'s count, on the real schema', () => {
  it('createSquad (kind:work, implicit): 1 EXISTING HOME squad does not count — the 1st work squad on free still succeeds', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedFreeTier(harness)
    const env = envFor(harness)

    const dept = await createDepartment(env, { slug: 'dept-1', name: 'Dept 1', kind: 'home' })
    if (!dept.ok) throw new Error('setup failed')
    const home = await createSquad(env, dept.value.id, { slug: 'home-squad', name: 'Home', kind: 'home' })
    expect(home.ok).toBe(true)

    // Free ceiling is 1 work squad. The home squad above must not count toward it.
    const work = await createSquad(env, dept.value.id, { slug: 'work-squad', name: 'Work', kind: 'work' })
    expect(work.ok).toBe(true)

    harness.close()
  })

  it('createSquad: a SECOND work squad IS blocked once one work squad already exists (home ones still don\'t count)', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    const dept = await createDepartment(env, { slug: 'dept-1', name: 'Dept 1', kind: 'home' })
    if (!dept.ok) throw new Error('setup failed')
    // Two home squads (should never count) + one work squad (should count).
    expect((await createSquad(env, dept.value.id, { slug: 'home-a', name: 'Home A', kind: 'home' })).ok).toBe(true)
    expect((await createSquad(env, dept.value.id, { slug: 'home-b', name: 'Home B', kind: 'home' })).ok).toBe(true)
    expect((await createSquad(env, dept.value.id, { slug: 'work-a', name: 'Work A', kind: 'work' })).ok).toBe(true)

    const blocked = await createSquad(env, dept.value.id, { slug: 'work-b', name: 'Work B', kind: 'work' })
    expect(blocked).toEqual({ ok: false, error: 'squad_limit_reached' })

    harness.close()
  })

  it('createDepartment: home departments never count toward maxDepartments', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    for (let i = 0; i < 3; i += 1) {
      const res = await createDepartment(env, { slug: `home-dept-${i}`, name: `Home ${i}`, kind: 'home' })
      expect(res.ok).toBe(true)
    }
    // Free ceiling is 1 work department; none of the 3 home ones above count.
    const workDept = await createDepartment(env, { slug: 'work-dept', name: 'Work Dept', kind: 'work' })
    expect(workDept.ok).toBe(true)
    const blocked = await createDepartment(env, { slug: 'work-dept-2', name: 'Work Dept 2' })
    expect(blocked).toEqual({ ok: false, error: 'department_limit_reached' })

    harness.close()
  })

  it('createAgent: home agents never count toward maxAgents', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    const dept = await createDepartment(env, { slug: 'dept-1', name: 'Dept 1', kind: 'home' })
    if (!dept.ok) throw new Error('setup failed')
    const squad = await createSquad(env, dept.value.id, { slug: 'squad-1', name: 'Squad 1', kind: 'home' })
    if (!squad.ok) throw new Error('setup failed')

    for (let i = 0; i < 3; i += 1) {
      const res = await createAgent(env, squad.value.id, { slug: `home-agent-${i}`, name: `Home ${i}`, kind: 'home' })
      expect(res.ok).toBe(true)
    }
    // Free ceiling is 2 work agents; none of the 3 home ones above count.
    expect((await createAgent(env, squad.value.id, { slug: 'work-agent-1', name: 'Work 1', kind: 'work' })).ok).toBe(true)
    expect((await createAgent(env, squad.value.id, { slug: 'work-agent-2', name: 'Work 2', kind: 'work' })).ok).toBe(true)
    const blocked = await createAgent(env, squad.value.id, { slug: 'work-agent-3', name: 'Work 3', kind: 'work' })
    expect(blocked).toEqual({ ok: false, error: 'agent_limit_reached' })

    harness.close()
  })
})
