// tests/harness-delivery-classifier.test.ts
//
// The delivery CLASSIFIER, and the Grok adapter's record-only path.
//
// This suite does not prove Codex or Claude conform to anything: neither has an adapter in this
// tree, no process is started, and the two labels only vary a scalar passed to one pure function.
// It also does not test revocation, replay-of-labels or an attached runtime's claim protocol —
// those need a live walk. Review round 2 asked for the old filename and its claims to be cut down
// to what is actually exercised, so the file is now named for the classifier it tests.
import { describe, expect, it } from 'vitest'
import { deliveryStateOf, attemptLabels } from '../src/harness/delivery'
import type { HarnessKind } from '../src/harness/types'

type Fixture = { name: string; kind: HarnessKind }

const FIXTURES: Fixture[] = [
  { name: 'codex', kind: 'codex-cli' },
  { name: 'claude', kind: 'claude-code' },
]

// The same five cases run against both fixtures.
// Scalar classifications, not protocol cases. The names are kept only so the round-1 cases stay
// traceable; several of them (interruption, revocation) are classified here, not exercised.
const CASES = ['held reservation', 'duplicate dispatch', 'interrupted run', 'finished run', 'revoked run'] as const

describe('harness delivery classifier', () => {
  for (const fixture of FIXTURES) {
    describe(`fixture: ${fixture.name} (${fixture.kind})`, () => {
      it(`${CASES[0]}: a held reservation is reserved, not delivered`, () => {
        for (const state of ['reserved', 'attaching']) {
          expect(deliveryStateOf({ state, last_vendor_status: null })).toBe('reserved')
        }
        // An attached vendor row with no status is still only a record.
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: null })).toBe('reserved')
      })

      it(`${CASES[1]}: replaying a duplicate dispatch cannot upgrade the delivery`, () => {
        const recorded = deliveryStateOf({ state: 'attached', last_vendor_status: 'recorded' })
        expect(recorded).toBe('reserved')
        // Same row replayed: identical answer, so idempotency cannot turn a record into a handover.
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'recorded' })).toBe(recorded)
      })

      it(`${CASES[2]}: an interruption does not read as delivery either way`, () => {
        // A failed attach never left Mupot.
        expect(deliveryStateOf({ state: 'failed', last_vendor_status: null })).toBe('reserved')
        // A run that reached the worker and then broke was still delivered once.
        expect(deliveryStateOf({ state: 'failed', last_vendor_status: 'running' })).toBe('delivered')
      })

      it(`${CASES[3]}: a vendor that accepted the work is delivered; a worker that took it is claimed`, () => {
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'accepted' })).toBe('delivered')
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'running' })).toBe('delivered')
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'claimed' })).toBe('claimed')
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'in_progress' })).toBe('claimed')
      })

      it(`${CASES[4]}: a revoked reservation is reserved unless the work had already gone out`, () => {
        expect(deliveryStateOf({ state: 'reconciled', last_vendor_status: null })).toBe('reserved')
        expect(deliveryStateOf({ state: 'reconciled', last_vendor_status: 'queued' })).toBe('delivered')
      })

      it('an unknown vendor status proves nothing, so it is unknown — not reserved, not delivered', () => {
        expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'whatever-new-vendor-says' })).toBe(
          'unknown',
        )
      })

      it('records model, harness and host — and the labels grant no authority', () => {
        const first = attemptLabels({ harness: fixture.kind, model: 'some-model', host: 'muvps' })
        expect(first).toEqual({ harness: fixture.kind, model: 'some-model', host: 'muvps' })

        // Labels must not move the delivery decision: the same row with different labels answers
        // identically. If a fence ever reads labels, this is the test that should break.
        const row = { state: 'attached' as const, last_vendor_status: 'recorded' }
        const withLabels = { ...row, labels: first }
        const withoutLabels = { ...row, labels: attemptLabels({ harness: fixture.kind }) }
        expect(deliveryStateOf(withLabels)).toBe(deliveryStateOf(withoutLabels))
        expect(deliveryStateOf(withLabels)).toBe('reserved')

        // Missing labels are null, not a made-up identity.
        expect(attemptLabels({ harness: fixture.kind })).toEqual({
          harness: fixture.kind,
          model: null,
          host: null,
        })
      })
    })
  }

  it('the two labels cannot change the answer, because only one function decides', () => {
    const rows = [
      { state: 'reserved', last_vendor_status: null },
      { state: 'attaching', last_vendor_status: null },
      { state: 'attached', last_vendor_status: null },
      { state: 'attached', last_vendor_status: 'recorded' },
      { state: 'attached', last_vendor_status: 'accepted' },
      { state: 'attached', last_vendor_status: 'claimed' },
      { state: 'failed', last_vendor_status: null },
      { state: 'failed', last_vendor_status: 'running' },
      { state: 'reconciled', last_vendor_status: 'queued' },
      { state: 'attached', last_vendor_status: 'unheard-of' },
    ]
    // The decision is made once, in one place, so it cannot differ by vendor.
    const answers = rows.map((row) => deliveryStateOf(row))
    expect(answers).toEqual([
      'reserved', // reserved
      'reserved', // attaching
      'reserved', // attached, no status
      'reserved', // attached, record-only
      'delivered', // attached, accepted
      'claimed', // attached, claimed
      'reserved', // failed, no status
      'delivered', // failed, running
      'delivered', // reconciled, queued
      'unknown', // attached, unheard-of status
    ])
  })
})

// ── the Grok adapter itself: a record-only dispatch is not a delivery ───────────────────────
// Requirement (1) names src/harness/adapters/grok.ts:7-10 and :222-251 explicitly, so the guard
// is asserted against the real adapter and a real D1, not against the decision helper alone.
describe('grok-cli record-only dispatch (mupot#2283)', () => {
  it('reports reserved, never delivered, and says so on replay too', async () => {
    const { createSqliteD1 } = await import('./helpers/sqlite-d1')
    const { applyAllMigrations } = await import('./helpers/migrations')
    const { grokCliAdapter } = await import('../src/harness/adapters/grok')
    type Env = import('../src/types').Env

    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core Squad');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
        ('agent-builder', 'squad-core', 'agent-builder', 'Agent Builder', 'builder', 'test', 'active');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES
        ('member-builder', 'builder@test.com', 'Builder Member', 'active', 'mumega');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('mumega', 'agent-builder', 'member-builder', datetime('now'));
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
    const req = {
      name: 'bounded task',
      prompt: 'do the thing',
      squadId: 'squad-core',
      agentId: 'agent-builder',
      actor: { kind: 'member' as const, id: 'member-builder' },
      idempotencyKey: 'conformance-grok-1',
      // The adapter plans without writing unless dryRun is explicitly false (same default as
      // router_tick, #1780/#1807). A conformance case about delivery has to actually dispatch.
      dryRun: false,
      model: 'grok-5',
      metadata: { host: 'muvps' },
    }

    const first = await grokCliAdapter.dispatch(env, req)
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    // It does bind a vendor execution record — that part is honest.
    expect(first.state).toBe('attached')
    // But nothing was enqueued, so it is not a delivery.
    expect(first.delivery).toBe('reserved')
    expect(first.labels).toEqual({ harness: 'grok-cli', model: 'grok-5', host: 'muvps' })

    const replay = await grokCliAdapter.dispatch(env, req)
    expect(replay.accepted).toBe(true)
    if (!replay.accepted) return
    expect(replay.replay).toBe(true)
    expect(replay.delivery).toBe('reserved')

    // And status must not quietly upgrade it either.
    const status = await grokCliAdapter.status(env, { reservationId: first.reservationId })
    expect(status.delivery).toBe('reserved')
  })
})
