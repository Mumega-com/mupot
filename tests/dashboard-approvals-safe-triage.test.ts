// mupot — Flight-008 Slice 2 (mupot#1061, Safe Approvals Triage). Proves the
// three done_when items + the three River gate bars against REAL data:
//   1. A blocked row shows a concrete blocker reason + its gate owner; no
//      blanket "Urgent" label.
//   2. A row with NO resolvable gate owner renders NO Approve/Reject action —
//      and the control must be STRUCTURALLY ABSENT from the HTML, not just
//      disabled/hidden.
//   3. (Batch idempotency is covered separately in tests/tasks-batch-verdict.test.ts,
//      at the data layer.)
//
// Uses the real SQLite-backed D1 harness (all migrations applied) so this
// exercises the actual gate_grants/agents/members schema end to end, both at
// the data layer (loadApprovals) and through the real /approvals HTML route.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { loadApprovals } from '../src/dashboard/approvals'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: {
    set: (key: 'auth', value: AuthContext) => void
    json: (body: unknown, status: 401) => Response
  }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function sessions() {
  const values = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = values.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { values.set(key, value) },
    async delete(key: string): Promise<void> { values.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-athena', 'squad-a', 'athena', 'Athena', 'active');
    INSERT INTO members (id, email, display_name, status) VALUES
      ('member-owner', 'owner@test.com', 'Ophelia Owner', 'active');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
      ('grant-1', 'gate:athena', 'agent', 'agent-athena', 'member-owner', '2026-08-01T00:00:00.000Z');
    -- 'resolved-task': gate:athena has exactly one active holder → verdictable.
    -- 'orphan-task': gate:orphan has NO grant at all → must render no button.
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at) VALUES
      ('resolved-task', 'squad-a', 'Ship the release', 'body', 'done', 'review', 'gate:athena', NULL, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'),
      ('orphan-task', 'squad-a', 'Rogue capability', 'body', 'done', 'review', 'gate:orphan', NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

function owner(): AuthContext {
  return { userId: 'member-owner', memberId: 'member-owner', email: 'owner@test.com', role: 'owner', tenant: 'tenant-a' }
}

describe('loadApprovals — blocker_reason / gate_owner_name / can_verdict (data layer)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('a row with a resolvable owner: can_verdict=true, names the owner, concrete reason', async () => {
    harness = makeHarness()
    const items = await loadApprovals(envFor(harness), owner())
    const resolved = items.find((i) => i.id === 'resolved-task')
    expect(resolved).toBeDefined()
    expect(resolved!.can_verdict).toBe(true)
    expect(resolved!.gate_owner_name).toBe('Athena')
    expect(resolved!.blocker_reason).toContain('Athena')
    expect(resolved!.blocker_reason).toContain('gate:athena')
    // Never a generic placeholder.
    expect(resolved!.blocker_reason.toLowerCase()).not.toBe('blocked')
    expect(resolved!.blocker_reason.trim().length).toBeGreaterThan(0)
  })

  it('a row with NO gate_grants row for its capability: can_verdict=false, reason names the capability, not generic', async () => {
    harness = makeHarness()
    const items = await loadApprovals(envFor(harness), owner())
    const orphan = items.find((i) => i.id === 'orphan-task')
    expect(orphan).toBeDefined()
    expect(orphan!.can_verdict).toBe(false)
    expect(orphan!.gate_owner_name).toBeNull()
    expect(orphan!.blocker_reason).toContain('gate:orphan')
    expect(orphan!.blocker_reason.toLowerCase()).not.toBe('blocked')
    expect(orphan!.blocker_reason.toLowerCase()).not.toBe('')
  })
})

describe('GET /approvals — verdict controls are structurally gated (HTML layer)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders Approve/Reject for the resolved row and OMITS them entirely for the unresolved row', async () => {
    harness = makeHarness()
    authState.current = owner()
    const response = await dashboardApp.fetch(new Request('https://pot.test/approvals'), envFor(harness))
    const body = await response.text()

    expect(response.status).toBe(200)

    // Split the rendered list into the two per-task card fragments so button
    // presence/absence is checked against the RIGHT row, not the page as a whole
    // (the page as a whole legitimately contains an appr-approve button for the
    // OTHER, resolvable row). loadApprovals orders by created_at ASC, so
    // orphan-task (09:00) renders before resolved-task (10:00) — order-independent
    // slicing rather than assuming which marker comes first in the HTML.
    const resolvedIdx = body.indexOf('data-task="resolved-task"')
    const orphanIdx = body.indexOf('data-task="orphan-task"')
    expect(resolvedIdx).toBeGreaterThan(-1)
    expect(orphanIdx).toBeGreaterThan(-1)
    const [firstIdx, secondIdx] = resolvedIdx < orphanIdx ? [resolvedIdx, orphanIdx] : [orphanIdx, resolvedIdx]
    const firstCard = body.slice(firstIdx, secondIdx)
    const secondCard = body.slice(secondIdx, secondIdx + 2000)
    const resolvedCard = resolvedIdx < orphanIdx ? firstCard : secondCard
    const orphanCard = resolvedIdx < orphanIdx ? secondCard : firstCard

    // Resolved row: real verdict controls, real owner name, real reason.
    expect(resolvedCard).toContain('class="btn appr-approve"')
    expect(resolvedCard).toContain('class="btn btn-reject appr-reject"')
    expect(resolvedCard).toContain('Owner: Athena')
    expect(resolvedCard).toContain('Waiting on Athena')

    // Orphan row: structurally NO verdict buttons — not just disabled/hidden.
    expect(orphanCard).not.toContain('appr-approve')
    expect(orphanCard).not.toContain('appr-reject')
    expect(orphanCard).not.toContain('<button')
    expect(orphanCard).toContain('No verdict action available')
    expect(orphanCard).toContain('gate:orphan')

    // Gate bar #1: no blanket "Urgent" label anywhere on this surface.
    expect(body).not.toContain('Urgent')
  })

  it('the batch toolbar appears (there is a verdictable row) and targets /api/tasks/batch-verdict', async () => {
    harness = makeHarness()
    authState.current = owner()
    const response = await dashboardApp.fetch(new Request('https://pot.test/approvals'), envFor(harness))
    const body = await response.text()
    expect(body).toContain('id="appr-batch-toolbar"')
    expect(body).toContain('/api/tasks/batch-verdict')
  })

  it('no batch toolbar when nothing is verdictable', async () => {
    harness = createSqliteD1()
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at) VALUES
        ('orphan-only', 'squad-a', 'Rogue capability', 'body', 'done', 'review', 'gate:orphan', NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z');
    `)
    authState.current = owner()
    const response = await dashboardApp.fetch(new Request('https://pot.test/approvals'), envFor(harness))
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toContain('id="appr-batch-toolbar"')
  })
})
