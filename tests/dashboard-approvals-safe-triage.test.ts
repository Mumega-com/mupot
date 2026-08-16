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
    -- 'orphan-task': gate:orphan has NO grant at all → nobody can be "waiting on"
    --   a named holder, so the reason must say so. An owner/admin caller still
    --   gets the control (the write path's legacy owner/admin bypass would honor
    --   their verdict — see makeStaleHolderHarness below for the caller for whom
    --   the control must be structurally absent).
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at) VALUES
      ('resolved-task', 'squad-a', 'Ship the release', 'body', 'done', 'review', 'gate:athena', NULL, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'),
      ('orphan-task', 'squad-a', 'Rogue capability', 'body', 'done', 'review', 'gate:orphan', NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z');
  `)
  return harness
}

/**
 * The NON-ADMIN unresolvable case — the one that actually exercises River gate
 * bar #1 ("no verdict without an owner") end to end.
 *
 * A plain member caller only ever SEES a row they hold a gate_grants row for
 * (loadApprovals' non-admin branch is an EXISTS filter on that principal), so
 * "row with zero grants" is unreachable for them by construction. The reachable
 * unresolvable shape is: the caller holds the grant, but the principal behind it
 * is no longer active — the capability nominally has a holder, nobody who can
 * act. resolveGateOwner returns reason='inactive', can_verdict stays false, and
 * the verdict control must be STRUCTURALLY absent from the HTML.
 */
function makeStaleHolderHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
    INSERT INTO members (id, email, display_name, status) VALUES
      ('member-owner', 'owner@test.com', 'Ophelia Owner', 'active'),
      ('member-stale', 'stale@test.com', 'Sam Suspended', 'suspended');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
      ('grant-stale', 'gate:stale', 'member', 'member-stale', 'member-owner', '2026-08-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, created_at, updated_at) VALUES
      ('stale-task', 'squad-a', 'Held by a suspended owner', 'body', 'done', 'review', 'gate:stale', NULL, '2026-08-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

function owner(): AuthContext {
  return { userId: 'member-owner', memberId: 'member-owner', email: 'owner@test.com', role: 'owner', tenant: 'tenant-a' }
}

/**
 * A plain member (NOT owner/admin) — no legacy bypass, so can_verdict is decided
 * purely by whether the gate lane has a live holder.
 *
 * The explicit `capabilities` grant is what gets this caller PAST the dashboard's
 * baseline observer floor (src/dashboard/index.ts, the `holdsCapabilityFloor(auth,
 * 'observer')` middleware) — a role:'member' session with no fine-grained grants
 * is 403'd before any route handler runs, so without it this fixture would prove
 * the guard, not the gate bar. An org-scope 'member' grant is the minimum
 * realistic shape for a human who can open /approvals but holds no admin rank.
 */
function staleHolder(): AuthContext {
  return {
    userId: 'member-stale',
    memberId: 'member-stale',
    email: 'stale@test.com',
    role: 'member',
    tenant: 'tenant-a',
    capabilities: [{ member_id: 'member-stale', scope_type: 'org', scope_id: null, capability: 'member' }],
  } as AuthContext
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

  it('a row with NO gate_grants row for its capability: no named owner, reason names the capability, not generic', async () => {
    harness = makeHarness()
    const items = await loadApprovals(envFor(harness), owner())
    const orphan = items.find((i) => i.id === 'orphan-task')
    expect(orphan).toBeDefined()
    // No holder resolved → nobody to name, and the reason must say WHICH
    // capability is unowned rather than a blanket "blocked".
    expect(orphan!.gate_owner_name).toBeNull()
    expect(orphan!.blocker_reason).toContain('gate:orphan')
    expect(orphan!.blocker_reason.toLowerCase()).not.toBe('blocked')
    expect(orphan!.blocker_reason.toLowerCase()).not.toBe('')
  })

  it('owner/admin caller keeps the verdict control on an unowned row — can_verdict mirrors the WRITE path, not just resolvability', async () => {
    harness = makeHarness()
    const items = await loadApprovals(envFor(harness), owner())
    const orphan = items.find((i) => i.id === 'orphan-task')
    expect(orphan).toBeDefined()
    // tasks/index.ts callerHoldsGateCapability lets an org owner/admin verdict
    // ANY review task (the legacy bypass). If the read side suppressed the
    // button here, the UI would contradict the backend and strand every task on
    // a zero-grant capability — the real regression this flight shipped and
    // caught in CI (gate:routines has zero grants in the CI seed, which hung the
    // Project-Routine E2E approve click).
    expect(orphan!.can_verdict).toBe(true)
    // …but the row must still EXPLAIN the broken gate lane; a bypassing admin
    // is not flying blind.
    expect(orphan!.blocker_reason).toContain('gate:orphan')
  })

  it('non-admin holder whose grant points at an inactive principal: can_verdict=false (River gate bar #1)', async () => {
    harness = makeStaleHolderHarness()
    const items = await loadApprovals(envFor(harness), staleHolder())
    const stale = items.find((i) => i.id === 'stale-task')
    // The row IS visible — the caller holds the grant — but there is no live
    // holder, so no safe decision is possible and no control may be offered.
    expect(stale).toBeDefined()
    expect(stale!.can_verdict).toBe(false)
    expect(stale!.gate_owner_name).toBeNull()
    expect(stale!.blocker_reason).toContain('gate:stale')
    expect(stale!.blocker_reason).toContain('Sam Suspended')
    expect(stale!.blocker_reason.toLowerCase()).not.toBe('blocked')
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

    // Orphan row, ADMIN caller: the control stays (the backend's owner/admin
    // bypass would honor the verdict), but there is no owner to name and the
    // reason states which capability is unowned. The structurally-absent case
    // is proven below with a non-admin caller, where it is actually reachable.
    expect(orphanCard).not.toContain('Owner:')
    expect(orphanCard).toContain('gate:orphan')

    // Gate bar #1: no blanket "Urgent" label anywhere on this surface.
    expect(body).not.toContain('Urgent')
  })

  it('non-admin, no live gate owner: Approve/Reject are STRUCTURALLY ABSENT, not disabled (River gate bar #1)', async () => {
    harness = makeStaleHolderHarness()
    authState.current = staleHolder()
    const response = await dashboardApp.fetch(new Request('https://pot.test/approvals'), envFor(harness))
    const body = await response.text()

    expect(response.status).toBe(200)
    const idx = body.indexOf('data-task="stale-task"')
    expect(idx).toBeGreaterThan(-1)
    // Bound the slice at the page's first <script> after this card. The
    // approvals page always ships its verdict-wiring script, and that script
    // legitimately mentions the .appr-approve/.appr-reject SELECTORS — a naive
    // fixed-width window would swallow it and the assertion below would pass
    // (or fail) for the wrong reason.
    const scriptIdx = body.indexOf('<script', idx)
    const card = body.slice(idx, scriptIdx > -1 ? scriptIdx : body.length)
    expect(card).toContain('data-can-verdict="0"')

    // The control must not exist in the markup at all — a disabled or
    // display:none button is still one CSS/devtools flip away from a verdict
    // this caller has no live authority to give.
    expect(card).not.toContain('appr-approve')
    expect(card).not.toContain('appr-reject')
    expect(card).not.toContain('<button')
    expect(card).toContain('No verdict action available')
    // …and the row explains WHY, naming the capability and the dead holder.
    expect(card).toContain('gate:stale')
    expect(card).toContain('Sam Suspended')
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
    // Non-admin caller whose one visible row has no live gate owner: the queue
    // renders, but zero rows are verdictable, so the batch toolbar must not
    // appear at all. (An owner/admin caller is deliberately NOT the fixture
    // here — the bypass makes every row verdictable for them, so "nothing
    // verdictable" is not a state they can be in while rows exist.)
    harness = makeStaleHolderHarness()
    authState.current = staleHolder()
    const response = await dashboardApp.fetch(new Request('https://pot.test/approvals'), envFor(harness))
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('data-task="stale-task"')
    expect(body).not.toContain('id="appr-batch-toolbar"')
  })
})
