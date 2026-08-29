// tests/loop-runtime.test.ts — the manifest-driven Loop runtime (P2, #33).
// Decision flow over the migration-backed tenant DB plus injected model/network seams:
// guards, owner resolution, budget gate, perceive (incl. failing-source tolerance),
// reason→act routing, dry/acted, and the default act router's gated-vs-ungated behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLoopCycle } from '../src/loops/runtime'
import type { RuntimeDeps, ProposedAct } from '../src/loops/runtime'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness
let ENV: Env

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

function seedRuntimeOwners(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('d1', 'department', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('s1', 'd1', 'squad-one', 'Squad One'),
      ('s2', 'd1', 'squad-two', 'Squad Two');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('a1', 's1', 'agent-one', 'Agent One', 'active'),
      ('a-paused', 's2', 'agent-paused', 'Agent Paused', 'paused');
    INSERT INTO loops (id, tenant, squad_id, agent_id, status, spec, created_at, updated_at)
    VALUES ('l1', 't', NULL, 'a1', 'active', '{}', datetime('now'), datetime('now'));
  `)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedRuntimeOwners(harness.sqlite)
  ENV = { TENANT_SLUG: 't', DB: harness.db } as Env
  vi.clearAllMocks()
})

afterEach(() => harness.close())

const meterOk: RuntimeDeps['meterCheck'] = vi.fn(async () => ({
  ok: true, windowKey: 'w', count: 1, tokens: 0,
}))
const meterBlocked = (reason: 'budget_cap_exceeded' | 'rate_limited'): RuntimeDeps['meterCheck'] =>
  vi.fn(async () => ({ ok: false, reason, windowKey: 'w', count: 0, tokens: 0, retryAfterSec: 1 }))

// a resolve seam returning a controllable handle
function resolveReturning(items: { id: string }[], act = vi.fn()) {
  return vi.fn(() => ({ kind: 'mcp' as const, read: vi.fn(async () => items), act }))
}

const noRecord: RuntimeDeps['recordTokens'] = vi.fn(async () => {})

describe('runLoopCycle — guards', () => {
  it('inactive status → inactive, nothing runs', async () => {
    const r = await runLoopCycle(ENV, makeLoop({ status: 'paused' }), { meterCheck: meterOk })
    expect(r.decided).toBe('inactive')
  })

  it('kpi already met → kpi-met', async () => {
    const r = await runLoopCycle(ENV, makeLoop(), { observeKpi: async () => 100, meterCheck: meterOk })
    expect(r.decided).toBe('kpi-met')
    expect(r.kpi).toBe(100)
  })

  it('no owner → error', async () => {
    const r = await runLoopCycle(ENV, makeLoop({ agent_id: null, squad_id: null }), { meterCheck: meterOk })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('loop_has_no_owner')
  })
})

describe('runLoopCycle — canonical meter owner resolution', () => {
  it('maps an active agent subject to its canonical squad without changing the meter key', async () => {
    const meterCheck = vi.fn(async () => ({
      ok: false as const,
      reason: 'rate_limited' as const,
      windowKey: 't:a1:2026-08-29',
      count: 200,
      tokens: 0,
      retryAfterSec: 1,
    }))

    await runLoopCycle(ENV, makeLoop(), { meterCheck, observeKpi: async () => 0 })

    expect(meterCheck).toHaveBeenCalledWith(ENV, {
      tenant: 't',
      meterSubjectId: 'a1',
      squadId: 's1',
      projectId: null,
      maxDispatchDay: 200,
      maxTokensDay: 200_000,
      maxCostMicroUsd: 5_000_000,
      costWindow: 'week',
      estimateMicroUsd: expect.any(Number),
    })
  })

  it('preserves a canonical squad as both meter subject and squad attribution', async () => {
    const meterCheck = vi.fn(async () => ({
      ok: false as const,
      reason: 'rate_limited' as const,
      windowKey: 't:s2:2026-08-29',
      count: 200,
      tokens: 0,
      retryAfterSec: 1,
    }))

    await runLoopCycle(ENV, makeLoop({ agent_id: null, squad_id: 's2' }), {
      meterCheck,
      observeKpi: async () => 0,
    })

    expect(meterCheck).toHaveBeenCalledWith(ENV, expect.objectContaining({
      tenant: 't',
      meterSubjectId: 's2',
      squadId: 's2',
    }))
  })

  it('records a successful agent-owned cycle against the reserved meter subject', async () => {
    const meterCheck = vi.fn(async () => ({
      ok: true as const,
      windowKey: 't:a1:2026-08-29',
      count: 1,
      tokens: 0,
    }))
    const recordTokens = vi.fn(async () => undefined)

    const result = await runLoopCycle(ENV, makeLoop(), {
      meterCheck,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [],
      recordTokens,
      observeKpi: async () => 0,
    })

    expect(result.ok).toBe(true)
    expect(meterCheck).toHaveBeenCalledTimes(1)
    expect(recordTokens).toHaveBeenCalledWith(
      ENV,
      'a1',
      expect.any(Number),
      expect.any(Number),
    )
    expect(recordTokens.mock.calls[0][1]).toBe(meterCheck.mock.calls[0][1].meterSubjectId)
  })

  it('records a successful squad-owned cycle against the reserved meter subject', async () => {
    const meterCheck = vi.fn(async () => ({
      ok: true as const,
      windowKey: 't:s2:2026-08-29',
      count: 1,
      tokens: 0,
    }))
    const recordTokens = vi.fn(async () => undefined)

    const result = await runLoopCycle(ENV, makeLoop({ agent_id: null, squad_id: 's2' }), {
      meterCheck,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [],
      recordTokens,
      observeKpi: async () => 0,
    })

    expect(result.ok).toBe(true)
    expect(meterCheck).toHaveBeenCalledTimes(1)
    expect(recordTokens).toHaveBeenCalledWith(
      ENV,
      's2',
      expect.any(Number),
      expect.any(Number),
    )
    expect(recordTokens.mock.calls[0][1]).toBe(meterCheck.mock.calls[0][1].meterSubjectId)
  })

  it.each([
    ['inactive agent', { agent_id: 'a-paused', squad_id: null }],
    ['missing agent', { agent_id: 'a-missing', squad_id: null }],
    ['missing squad', { agent_id: null, squad_id: 's-missing' }],
  ])('fails closed for a %s before meter reservation', async (_name, owner) => {
    const meterCheck = vi.fn(async () => ({
      ok: true as const,
      windowKey: 'must-not-reserve',
      count: 1,
      tokens: 0,
    }))

    const result = await runLoopCycle(ENV, makeLoop(owner), {
      meterCheck,
      observeKpi: async () => 0,
    })

    expect(result).toMatchObject({
      ok: false,
      decided: 'inactive',
      error: 'loop_owner_unavailable',
    })
    expect(meterCheck).not.toHaveBeenCalled()
  })
})

describe('runLoopCycle — budget gate', () => {
  it('dollar cap block → budget_exhausted, zero perceive', async () => {
    const resolve = resolveReturning([{ id: 'p1' }])
    const r = await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterBlocked('budget_cap_exceeded'),
      resolve,
      observeKpi: async () => 10,
    })
    expect(r.decided).toBe('budget_exhausted')
    expect(resolve).not.toHaveBeenCalled() // gate is BEFORE perceive — no spend
  })

  it('rate limit block → rate_limited', async () => {
    const r = await runLoopCycle(ENV, makeLoop(), { meterCheck: meterBlocked('rate_limited'), observeKpi: async () => 0 })
    expect(r.decided).toBe('rate_limited')
  })
})

describe('runLoopCycle — perceive', () => {
  it('effort=low is observe-only → dry, no perceive', async () => {
    const resolve = resolveReturning([{ id: 'p1' }])
    const r = await runLoopCycle(ENV, makeLoop({ budget: { effort: 'low' } }), {
      meterCheck: meterOk, resolve, observeKpi: async () => 0,
    })
    expect(r.decided).toBe('dry')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('empty perceive → dry (no reason call)', async () => {
    const reason = vi.fn(async () => [])
    const r = await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterOk, resolve: resolveReturning([]), reason, observeKpi: async () => 0,
    })
    expect(r.decided).toBe('dry')
    expect(reason).not.toHaveBeenCalled()
  })

  it('tolerates a failing source and perceives from the others', async () => {
    const goodHandle = { kind: 'mcp' as const, read: vi.fn(async () => [{ id: 'p2' }]), act: vi.fn() }
    const resolve = vi.fn((_env: Env, ref) => {
      if (ref.name === 'broken') throw new Error('source_down')
      return goodHandle
    })
    const reason = vi.fn(async () => [])
    const loop = makeLoop({ sources: [{ kind: 'queue', name: 'broken' }, { kind: 'queue', name: 'prospects' }] })
    const r = await runLoopCycle(ENV, loop, { meterCheck: meterOk, resolve, reason, recordTokens: noRecord, observeKpi: async () => 0 })
    expect(r.perceived).toBe(1) // the broken source skipped, the good one read
  })
})

describe('runLoopCycle — reason + act', () => {
  const act: ProposedAct = { channel_index: 0, tool: 'send_email', args: { to: 'x' }, summary: 'reach out' }

  it('reason proposes acts → performAct each → acted, records spend', async () => {
    const performAct = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterOk,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [act],
      performAct,
      recordTokens: noRecord,
      observeKpi: async () => 20,
    })
    expect(r.decided).toBe('acted')
    expect(r.acted).toBe(1)
    expect(performAct).toHaveBeenCalledTimes(1)
    expect(noRecord).toHaveBeenCalled()
    expect(r.kpi).toBe(20)
  })

  it('caps acts at the effort budget (standard = 1)', async () => {
    const performAct = vi.fn(async () => {})
    await runLoopCycle(ENV, makeLoop(), {
      meterCheck: meterOk,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [act, act, act],
      performAct,
      recordTokens: noRecord,
      observeKpi: async () => 0,
    })
    expect(performAct).toHaveBeenCalledTimes(1) // budget=1
  })

  it('a failing act does not abort the cycle', async () => {
    const performAct = vi.fn(async () => { throw new Error('send failed') })
    const r = await runLoopCycle(ENV, makeLoop({ budget: { effort: 'high' } }), {
      meterCheck: meterOk,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [act, act],
      performAct,
      recordTokens: noRecord,
      observeKpi: async () => 0,
    })
    expect(r.ok).toBe(true)
    expect(r.acted).toBe(0) // both failed, but cycle completed
    expect(r.decided).toBe('dry')
  })
})

describe('runLoopCycle — structural gate (cannot be bypassed)', () => {
  const oneAct: ProposedAct = { channel_index: 0, tool: 't', args: {}, summary: 's' }

  it('a gated loop NEVER reaches performAct even when one is injected', async () => {
    // The guarantee is structural in runLoopCycle, NOT in the seam: inject a performAct
    // that WOULD fire — it must never be called for a gated loop.
    const performAct = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop({ gate: { require_approval: true } }), {
      meterCheck: meterOk,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [oneAct],
      performAct, // would fire — must be bypassed
      recordTokens: noRecord,
      observeKpi: async () => 0,
    })
    expect(performAct).not.toHaveBeenCalled() // gate held structurally
    // default queueGatedAct throws (pipeline unwired) → gated stays 0 → dry
    expect(r.acted).toBe(0)
    expect(r.gated).toBe(0)
    expect(r.decided).toBe('dry')
  })

  it('a gated loop with a wired queue → gated_pending, nothing fires', async () => {
    const performAct = vi.fn(async () => {})
    const queueGatedAct = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop({ gate: { require_approval: true } }), {
      meterCheck: meterOk,
      resolve: resolveReturning([{ id: 'p1' }]),
      reason: async () => [oneAct],
      performAct,
      queueGatedAct,
      recordTokens: noRecord,
      observeKpi: async () => 0,
    })
    expect(queueGatedAct).toHaveBeenCalledTimes(1)
    expect(performAct).not.toHaveBeenCalled()
    expect(r.gated).toBe(1)
    expect(r.acted).toBe(0)
    expect(r.decided).toBe('gated_pending')
  })

  it('fires an ungated act on the resolved channel', async () => {
    const channelAct = vi.fn(async () => ({ ok: true }))
    const resolve = vi.fn(() => ({ kind: 'mcp' as const, read: vi.fn(async () => [{ id: 'p1' }]), act: channelAct }))
    const r = await runLoopCycle(ENV, makeLoop({ gate: { require_approval: false } }), {
      meterCheck: meterOk,
      resolve,
      reason: async () => [{ channel_index: 0, tool: 'send_email', args: { to: 'x' }, summary: 's' }],
      recordTokens: noRecord,
      observeKpi: async () => 0,
    })
    expect(r.acted).toBe(1)
    expect(channelAct).toHaveBeenCalledWith('send_email', { to: 'x' })
  })
})

// ── Fix 3: terminal loops do NOT write a loop_decisions row ──────────────────
// runLoopCycle on a 'done' or 'killed' loop must return inactive WITHOUT calling
// appendDecision. Otherwise every driver tick (or standalone call) on a terminal
// loop writes an unbounded stream of `inactive` decision rows.

describe('runLoopCycle — terminal loops do not persist inactive decisions', () => {
  it('done loop: decided=inactive, appendDecision NOT called', async () => {
    const appendDecision = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop({ status: 'done' }), { appendDecision })
    expect(r.decided).toBe('inactive')
    expect(r.ok).toBe(true)
    expect(appendDecision).not.toHaveBeenCalled()
  })

  it('killed loop: decided=inactive, appendDecision NOT called', async () => {
    const appendDecision = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop({ status: 'killed' }), { appendDecision })
    expect(r.decided).toBe('inactive')
    expect(r.ok).toBe(true)
    expect(appendDecision).not.toHaveBeenCalled()
  })

  it('paused loop (transient, not terminal): appendDecision IS called', async () => {
    const appendDecision = vi.fn(async () => {})
    const r = await runLoopCycle(ENV, makeLoop({ status: 'paused' }), { appendDecision, cycleNum: 1 })
    expect(r.decided).toBe('inactive')
    // Paused is a transient hold — the admin can see the loop is waiting.
    expect(appendDecision).toHaveBeenCalledTimes(1)
    expect(appendDecision.mock.calls[0][3].decided).toBe('inactive')
  })
})
