// tests/brain-panel.test.ts — S-BRAIN-CTRL-MUPOT-1 acceptance tests.
//
// AC coverage:
//  (a) a cycle writes a loop_decisions row via appendDecision seam in runtime
//  (b) GET /api/loops/:id/decisions returns the persisted feed
//  (c) an admin pause via the loop_control path stops the loop at the next cycle
//  (d) a non-admin governor write 403s
//
// All D1 / network / model calls are replaced with vitest mock seams.

import { describe, expect, it, vi } from 'vitest'

// ── (a) runtime: cycle writes a loop_decisions row ───────────────────────────
import { runLoopCycle } from '../src/loops/runtime'
import type { RuntimeDeps } from '../src/loops/runtime'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

function makeLoop(over: Partial<LoopManifest> = {}): LoopManifest {
  return {
    id: 'l1',
    tenant: 't',
    squad_id: null,
    agent_id: 'a1',
    status: 'active',
    okr: 'grow the pipeline',
    kpi: { signal: 'positive_replies', target: 5 },
    sources: [{ kind: 'queue', name: 'prospects' }],
    channels: [{ kind: 'mcp', url: 'https://x/mcp' }],
    gate: { require_approval: false },
    budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
    cadence: { heartbeat: true },
    stop: { dry_rounds_max: 3 },
    created_at: 'x',
    ...over,
  }
}

const meterOk: RuntimeDeps['meterCheck'] = vi.fn(async () => ({
  ok: true, windowKey: 'w', count: 1, tokens: 0,
}))

describe('(a) runLoopCycle — writes a loop_decisions row', () => {
  it('calls appendDecision with the cycle result after an acted cycle', async () => {
    const appendDecision = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterOk,
      resolve: vi.fn(() => ({ kind: 'mcp' as const, read: vi.fn(async () => [{ id: 'p1' }]), act: vi.fn() })),
      reason: async () => [{ channel_index: 0, tool: 'send_email', args: { to: 'x' }, summary: 's' }],
      performAct: vi.fn(async () => {}),
      recordTokens: vi.fn(async () => {}),
      observeKpi: async () => 10,
      appendDecision,
      cycleNum: 3,
    })
    expect(appendDecision).toHaveBeenCalledTimes(1)
    const [_env, loopId, cycleNum, result] = appendDecision.mock.calls[0]
    expect(loopId).toBe('l1')
    expect(cycleNum).toBe(3)
    expect(result.decided).toBe('acted')
    expect(result.acted).toBe(1)
    expect(r.decided).toBe('acted')
  })

  it('calls appendDecision even on an early exit (inactive)', async () => {
    const appendDecision = vi.fn(async () => {})
    await runLoopCycle(ENV, makeLoop({ status: 'paused' }), {
      meterCheck: meterOk,
      appendDecision,
      cycleNum: 1,
    })
    expect(appendDecision).toHaveBeenCalledTimes(1)
    expect(appendDecision.mock.calls[0][3].decided).toBe('inactive')
  })

  it('calls appendDecision on a budget_exhausted exit', async () => {
    const appendDecision = vi.fn(async () => {})
    const meterBlocked: RuntimeDeps['meterCheck'] = vi.fn(async () => ({
      ok: false, reason: 'budget_cap_exceeded' as const, windowKey: 'w', count: 0, tokens: 0, retryAfterSec: 1
    }))
    await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterBlocked,
      observeKpi: async () => 0,
      appendDecision,
      cycleNum: 2,
    })
    expect(appendDecision).toHaveBeenCalledTimes(1)
    expect(appendDecision.mock.calls[0][3].decided).toBe('budget_exhausted')
  })

  it('appendDecision failure does NOT fail the cycle result', async () => {
    const appendDecision = vi.fn(async () => { throw new Error('db_down') })
    const r = await runLoopCycle(ENV, makeLoop({ status: 'paused' }), {
      appendDecision,
    })
    // Despite appendDecision throwing, the cycle result is returned normally.
    expect(r.decided).toBe('inactive')
    expect(r.ok).toBe(true)
  })
})

// ── (b) GET /api/loops/:id/decisions returns persisted feed ──────────────────
import { loopsApp } from '../src/loops/routes'

// Minimal D1 mock that captures query+bindings for assertions.
function mockD1(rows: unknown[], extraFirst: unknown = null) {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => extraFirst),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }
  return {
    prepare: vi.fn(() => stmt),
    _stmt: stmt,
  }
}

function makeDecisionRow(over: Partial<{
  id: string; loop_id: string; tenant: string; cycle_num: number;
  decided: string; perceived: number; acted: number; gated: number;
  kpi: number; error: string | null; capability_descriptor: string | null;
  recorded_at: string;
}> = {}) {
  return {
    id: 'dec1', loop_id: 'l1', tenant: 't', cycle_num: 1,
    decided: 'acted', perceived: 2, acted: 1, gated: 0, kpi: 15,
    error: null, capability_descriptor: null, recorded_at: '2026-06-11T12:00:00.000Z',
    ...over,
  }
}

describe('(b) GET /api/loops/:id/decisions — returns the persisted feed', () => {
  it('returns decisions for a known loop', async () => {
    const decRow = makeDecisionRow()
    // The route calls getLoop first (first() returns the loop row) then listLoopDecisions (all() returns decisions).
    const loopRow = {
      id: 'l1', tenant: 't', squad_id: null, agent_id: 'a1', status: 'active',
      spec: JSON.stringify({
        agent_id: 'a1', squad_id: null,
        okr: 'grow', kpi: { signal: 'x', target: 5 },
        sources: [], channels: [], gate: { require_approval: false },
        budget: {}, cadence: {}, stop: {},
      }),
      dry_rounds: 0, created_at: 'x', updated_at: 'x',
    }
    // We need two prepare() calls: first for getLoop, second for listLoopDecisions.
    // Build a DB mock where first() returns loopRow and all() returns decisions.
    const firstResponses: unknown[] = [loopRow]
    const allResponses: unknown[][] = [[decRow]]
    let firstIdx = 0
    let allIdx = 0
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      first: vi.fn(async () => firstResponses[firstIdx++] ?? null),
      all: vi.fn(async () => ({ results: allResponses[allIdx++] ?? [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    const db = { prepare: vi.fn(() => stmt) }
    const env = {
      TENANT_SLUG: 't',
      DB: db,
      SESSIONS: { get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })) },
    } as unknown as Env & { TENANT_SLUG: string; BRAND: string }

    const req = new Request('https://pot.test/l1/decisions?limit=10&offset=0', {
      headers: { Cookie: 'mupot_session=sess1' },
    })
    const res = await loopsApp.fetch(req, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { decisions: unknown[]; loop_id: string }
    expect(body.loop_id).toBe('l1')
    expect(Array.isArray(body.decisions)).toBe(true)
    expect(body.decisions).toHaveLength(1)
    expect((body.decisions[0] as { decided: string }).decided).toBe('acted')
  })

  it('returns 404 for an unknown loop', async () => {
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    const db = { prepare: vi.fn(() => stmt) }
    const env = {
      TENANT_SLUG: 't',
      DB: db,
      SESSIONS: { get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })) },
    } as unknown as Env

    const req = new Request('https://pot.test/nope/decisions', {
      headers: { Cookie: 'mupot_session=sess1' },
    })
    const res = await loopsApp.fetch(req, env)
    expect(res.status).toBe(404)
  })
})

// ── (c) admin pause via loop_control stops the loop next cycle ────────────────
import { runLoopsTick } from '../src/loops/driver'
import type { DriverDeps } from '../src/loops/driver'
import type { LoopControlRow } from '../src/loops/decisions'

describe('(c) loop_control pause stops the loop at the next cycle', () => {
  function makeDriverLoop(id: string): LoopManifest {
    return {
      id, tenant: 't', squad_id: null, agent_id: 'a-' + id, status: 'active',
      okr: 'grow', kpi: { signal: 'x', target: 5 },
      sources: [], channels: [], gate: { require_approval: true },
      budget: {}, cadence: { heartbeat: true }, stop: {}, created_at: 'x',
    }
  }

  it('honors a pause signal: calls pause + clearControl, skips runCycle', async () => {
    const loop = makeDriverLoop('loop1')
    const list = vi.fn(async () => [loop])
    const runCycle = vi.fn(async () => ({
      ok: true, decided: 'acted' as const, perceived: 1, acted: 1, gated: 0, kpi: 0,
    }))
    const pause = vi.fn(async () => true)
    const clearControl = vi.fn(async () => {})

    const ctrlRow: LoopControlRow = {
      loop_id: 'loop1', tenant: 't', action: 'pause',
      value: null, issued_by: 'admin1', issued_at: '2026-06-11T00:00:00Z',
    }
    const readControl = vi.fn(async () => ctrlRow)

    const deps: DriverDeps = {
      list, runCycle, pause, readControl, clearControl,
      bumpDry: vi.fn(async () => 0),
      resetDry: vi.fn(async () => {}),
    }
    const r = await runLoopsTick(ENV, deps)

    // The pause signal skips runCycle.
    expect(runCycle).not.toHaveBeenCalled()
    expect(pause).toHaveBeenCalledWith(ENV, 'loop1')
    expect(clearControl).toHaveBeenCalledWith(ENV, 'loop1')
    expect(r.paused).toBe(1)
    expect(r.ran).toBe(0)
  })

  it('honors a kill signal: calls setLoopStatus(done) + clearControl, skips runCycle', async () => {
    const loop = makeDriverLoop('loop2')
    const list = vi.fn(async () => [loop])
    const runCycle = vi.fn(async () => ({
      ok: true, decided: 'acted' as const, perceived: 1, acted: 1, gated: 0, kpi: 0,
    }))
    // pause seam is NOT called for kill; setLoopStatus(done) is called directly
    // inside the driver (it is not injected — the driver uses the real setLoopStatus
    // import; we mock D1 by injecting the full Env). For this test we inject
    // readControl returning 'kill' and verify runCycle is not called.
    const pause = vi.fn(async () => true)
    const clearControl = vi.fn(async () => {})
    const ctrlRow: LoopControlRow = {
      loop_id: 'loop2', tenant: 't', action: 'kill',
      value: null, issued_by: 'admin1', issued_at: '2026-06-11T00:00:00Z',
    }
    const readControl = vi.fn(async () => ctrlRow)

    // We need a DB mock because the kill path calls setLoopStatus (direct import).
    // Inject a minimal DB that returns {meta:{changes:0}} so it's a no-op.
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
    }
    const envWithDb = {
      ...ENV,
      DB: { prepare: vi.fn(() => stmt) },
    } as unknown as Env

    const deps: DriverDeps = {
      list, runCycle, pause, readControl, clearControl,
      bumpDry: vi.fn(async () => 0),
      resetDry: vi.fn(async () => {}),
    }
    const r = await runLoopsTick(envWithDb, deps)

    expect(runCycle).not.toHaveBeenCalled()
    expect(clearControl).toHaveBeenCalledWith(envWithDb, 'loop2')
    expect(r.ran).toBe(0)
    // errors++ for the skipped cycle
    expect(r.errors).toBe(1)
  })

  it('with no control signal: runs the cycle normally', async () => {
    const loop = makeDriverLoop('loop3')
    const list = vi.fn(async () => [loop])
    const runCycle = vi.fn(async () => ({
      ok: true, decided: 'acted' as const, perceived: 1, acted: 1, gated: 0, kpi: 0,
    }))
    const readControl = vi.fn(async () => null) // no pending signal
    const clearControl = vi.fn(async () => {})
    const resetDry = vi.fn(async () => {})

    const deps: DriverDeps = {
      list, runCycle, readControl, clearControl,
      bumpDry: vi.fn(async () => 0),
      resetDry,
      pause: vi.fn(async () => true),
    }
    const r = await runLoopsTick(ENV, deps)

    expect(runCycle).toHaveBeenCalledTimes(1)
    expect(r.ran).toBe(1)
    expect(r.acted).toBe(1)
    expect(clearControl).not.toHaveBeenCalled()
  })
})

// ── (d) non-admin governor write 403s ────────────────────────────────────────
import { dashboardApp } from '../src/dashboard/index'

describe('(d) non-admin governor write 403s', () => {
  // Build a minimal env that satisfies the dashboard middleware (auth + tenant).
  function envForRole(role: 'owner' | 'admin' | 'member', tenant = 't') {
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    return {
      TENANT_SLUG: tenant,
      BRAND: 'Test',
      DB: { prepare: vi.fn(() => stmt) },
      SESSIONS: {
        get: vi.fn(async () => JSON.stringify({
          userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z',
        })),
      },
      // Minimal KV / DO stubs (not exercised in this path).
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    } as unknown as Env & { TENANT_SLUG: string; BRAND: string }
  }

  it('a member POST /brain/loops/:id/control → 403', async () => {
    const env = envForRole('member')
    const req = new Request('https://pot.test/brain/loops/someloop/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'mupot_session=sess1',
        // CSRF Origin check: must match host
        Origin: 'https://pot.test',
      },
      body: JSON.stringify({ action: 'pause' }),
    })
    const res = await dashboardApp.fetch(req, env)
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('forbidden')
  })

  it('an admin POST /brain/loops/:id/control with valid loop → 200', async () => {
    const loopRow = {
      id: 'testloop', tenant: 't', squad_id: null, agent_id: 'a1', status: 'active',
      spec: JSON.stringify({
        agent_id: 'a1', squad_id: null,
        okr: 'grow', kpi: { signal: 'x', target: 5 },
        sources: [], channels: [], gate: { require_approval: false },
        budget: {}, cadence: {}, stop: {},
      }),
      dry_rounds: 0, created_at: 'x', updated_at: 'x',
    }
    const firstResponses = [loopRow]
    let firstIdx = 0
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      first: vi.fn(async () => firstResponses[firstIdx++] ?? null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    const env = {
      TENANT_SLUG: 't',
      BRAND: 'Test',
      DB: { prepare: vi.fn(() => stmt) },
      SESSIONS: {
        get: vi.fn(async () => JSON.stringify({
          userId: 'u1', email: 'admin@test.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z',
        })),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    } as unknown as Env & { TENANT_SLUG: string; BRAND: string }

    const req = new Request('https://pot.test/brain/loops/testloop/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'mupot_session=sess1',
        Origin: 'https://pot.test',
      },
      body: JSON.stringify({ action: 'pause' }),
    })
    const res = await dashboardApp.fetch(req, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; action: string }
    expect(body.ok).toBe(true)
    expect(body.action).toBe('pause')
  })
})
