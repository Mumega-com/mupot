// tests/cursor-delivery.test.ts
//
// One test per Cursor return site, using the statuses Cursor's own client emits
// (src/cursor/client.ts:14-22) rather than words I invented. Review round 2 on mupot#2283:
// the previous suite let all six sites be mutated to `claimed` and still pass 56/56, which means
// it was testing the classifier and pretending that covered the adapter.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { deliveryStateOf } from '../src/harness/delivery'

const reserveMock = vi.fn()
const attachMock = vi.fn()
const getRunMock = vi.fn()
const getReservationMock = vi.fn()

vi.mock('../src/cursor/dispatch', () => ({
  reserveCursorCloudWork: (...args: unknown[]) => reserveMock(...args),
  attachCursorCloudExecution: (...args: unknown[]) => attachMock(...args),
}))
vi.mock('../src/harness/reservations', () => ({
  getReservation: (...args: unknown[]) => getReservationMock(...args),
  isReservationStuck: () => false,
}))
vi.mock('../src/cursor/client', () => ({
  getCursorRun: (...args: unknown[]) => getRunMock(...args),
  resolveCursorApiToken: () => 'test-token',
  CURSOR_AGENT_DASHBOARD_BASE: 'https://cursor.com/agents',
}))

const ROW = {
  id: 'res-1',
  tenant: 'mumega',
  adapter: 'cursor-cloud',
  idempotency_key: 'k1',
  request_digest: 'a'.repeat(64),
  task_id: 'task-1',
  flight_id: 'flight-1',
  agent_id: 'agent-builder',
  squad_id: 'squad-core',
  actor_kind: 'member',
  actor_id: 'member-builder',
  state: 'attached',
  vendor_agent_id: 'vendor-agent-1',
  vendor_run_id: 'vendor-run-1',
  vendor_url: 'https://cursor.com/agents/vendor-agent-1',
  last_vendor_status: 'accepted',
  attach_lease_until: null,
  attach_lease_id: null,
  last_error: null,
  reserved_at: '2026-11-02T00:00:00.000Z',
  attached_at: '2026-11-02T00:00:01.000Z',
  reconciled_at: null,
  updated_at: '2026-11-02T00:00:01.000Z',
}

function reserved(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: 'res-1',
    task: { id: 'task-1' },
    flight: { id: 'flight-1', accepted: true, state: 'reserved', reservationId: 'res-1', taskId: 'task-1', flightId: 'flight-1', adapter: 'cursor-cloud', idempotencyKey: 'k1', replay: false, delivery: 'reserved', labels: { harness: 'cursor-cloud', model: null, host: null } },
    replay: false,
    state: 'attached',
    row: ROW,
    ...overrides,
  }
}

const req = {
  name: 'work',
  prompt: 'do it',
  // cursor-cloud declares requiresRepoUrl, so a dispatch without one is rejected before mocks.
  repoUrl: 'https://github.com/Mumega-com/mupot',
  squadId: 'squad-core',
  agentId: 'agent-builder',
  actor: { kind: 'member' as const, id: 'member-builder' },
  idempotencyKey: 'k1',
  dryRun: false,
  model: 'composer-2',
  metadata: { host: 'muvps' },
}

let adapter: typeof import('../src/harness/adapters/cursor').cursorCloudAdapter
const env = { DB: {}, TENANT_SLUG: 'mumega', CURSOR_API_TOKEN: 'test-token' } as never

beforeEach(async () => {
  reserveMock.mockReset()
  attachMock.mockReset()
  getRunMock.mockReset()
  getReservationMock.mockReset()
  getReservationMock.mockResolvedValue(ROW)
  ;({ cursorCloudAdapter: adapter } = await import('../src/harness/adapters/cursor'))
})

describe('cursor dispatch return sites', () => {
  it('site 1 — replay of a delivered run is delivered, not reserved (CREATING)', async () => {
    reserveMock.mockResolvedValue(reserved({ replay: true, row: { ...ROW, last_vendor_status: 'CREATING' } }))
    const out = await adapter.dispatch(env, req)
    expect(out.accepted).toBe(true)
    if (!out.accepted) return
    expect(out.delivery).toBe('delivered')
  })

  // Site 2 (the waitUntil branch) is NOT covered here: it could not be driven through the adapter
  // with these seams, and a test I cannot make fail on mutation is worse than no test. The branch
  // hard-codes `delivery: 'reserved'`, and the classifier test proves that value is what an
  // unlaunched reservation gets. Recorded as a known gap in the PR rather than dressed up.

  it('site 3 — a launch we could not bind is unconfirmed, never accepted+reserved', async () => {
    reserveMock.mockResolvedValue(reserved({ state: 'attaching', row: { ...ROW, state: 'attaching' } }))
    attachMock.mockResolvedValue({ reservationId: 'res-1', state: 'attaching', error: 'bind_lost_lease', replay: false })
    const out = await adapter.dispatch(env, req)
    // A launch we could not confirm is NOT an accepted dispatch — the lease fence pins that.
    expect(out.accepted).toBe(false)
    if (out.accepted) return
    expect(out.error).toBe('bind_lost_lease')
    expect(out.detail).toMatchObject({ delivery: 'unknown', unconfirmed: true })
  })

  it('site 3b — launch_unconfirmed is unconfirmed too, in the form the writer emits', async () => {
    reserveMock.mockResolvedValue(reserved({ state: 'attaching', row: { ...ROW, state: 'attaching' } }))
    // src/cursor/dispatch.ts:386 writes `launch_unconfirmed: <detail>`, never a bare code.
    attachMock.mockResolvedValue({
      reservationId: 'res-1',
      state: 'failed',
      error: 'launch_unconfirmed: maybe_launched after an aborted launch',
      replay: false,
    })
    const out = await adapter.dispatch(env, req)
    // The writer appends a detail to the persisted string; the code the caller sees stays bare.
    expect(out.accepted).toBe(false)
    if (out.accepted) return
    expect(out.error).toBe('launch_unconfirmed')
    expect(out.detail).toMatchObject({ delivery: 'unknown', unconfirmed: true })
  })

  it('site 4 — a confirmed launch is delivered', async () => {
    reserveMock.mockResolvedValue(reserved({ state: 'attaching', row: { ...ROW, state: 'attaching' } }))
    attachMock.mockResolvedValue({ reservationId: 'res-1', state: 'attached', replay: false })
    const out = await adapter.dispatch(env, req)
    if (!out.accepted) throw new Error('expected accepted')
    expect(out.delivery).toBe('delivered')
    expect(out.unconfirmed).toBeUndefined()
  })
})

describe('cursor status return sites', () => {
  it('site 5 — a polled FINISHED run is delivered, and the vendor status is passed through', async () => {
    getRunMock.mockResolvedValue({ status: 'FINISHED', result: 'done' })
    const out = await adapter.status(env, { reservationId: 'res-1' })
    expect(out.delivery).toBe('delivered')
    expect(out.vendorStatus).toBe('FINISHED')
  })

  it('site 5b — ERROR, CANCELLED and EXPIRED are delivered, not reserved', async () => {
    for (const status of ['ERROR', 'CANCELLED', 'EXPIRED', 'CREATING', 'RUNNING']) {
      getRunMock.mockResolvedValue({ status })
      const out = await adapter.status(env, { reservationId: 'res-1' })
      expect(out.delivery, `${status} must not read as reserved`).toBe('delivered')
    }
  })

  it('site 5c — an unrecognised vendor status is unknown, not a guess in either direction', async () => {
    getRunMock.mockResolvedValue({ status: 'SOMETHING_NEW' })
    const out = await adapter.status(env, { reservationId: 'res-1' })
    expect(out.delivery).toBe('unknown')
  })

  it('site 6 — a vendor 500 does not flip the state', async () => {
    getRunMock.mockRejectedValue(new Error('cursor 500'))
    const out = await adapter.status(env, { reservationId: 'res-1' })
    // The row says the run was accepted, so the delivery stays delivered even though this read failed.
    expect(out.delivery).toBe('delivered')
    expect(out.error).toContain('500')
  })
})

describe('persisted launch uncertainty decides the status answer', () => {
  it('a reservation whose launch may have happened is unknown, not reserved', async () => {
    // The exact string markReservationFailed persists (src/cursor/dispatch.ts:386,421).
    for (const last_error of [
      'launch_unconfirmed: maybe_launched after an aborted launch',
      'bind_unconfirmed: D1 timeout while binding',
    ]) {
      getReservationMock.mockResolvedValue({
        ...ROW,
        state: 'failed',
        last_vendor_status: null,
        last_error,
      })
      const out = await adapter.status(env, { reservationId: 'res-1' })
      expect(out.delivery, last_error).toBe('unknown')
    }
  })

  it('a clean failure with no uncertainty stays reserved', async () => {
    getReservationMock.mockResolvedValue({
      ...ROW,
      state: 'failed',
      last_vendor_status: null,
      last_error: 'flight_gate_held',
    })
    const out = await adapter.status(env, { reservationId: 'res-1' })
    expect(out.delivery).toBe('reserved')
  })
})

describe('the classifier against the statuses writers actually emit', () => {
  it('every Cursor lifecycle status is recognised', () => {
    for (const status of ['CREATING', 'RUNNING', 'FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']) {
      expect(deliveryStateOf({ state: 'attached', last_vendor_status: status }), status).toBe('delivered')
    }
    expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'recorded' })).toBe('reserved')
    expect(deliveryStateOf({ state: 'attached', last_vendor_status: null })).toBe('reserved')
    expect(deliveryStateOf({ state: 'attached', last_vendor_status: 'MADE_UP' })).toBe('unknown')
  })
})
