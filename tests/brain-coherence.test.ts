// tests/brain-coherence.test.ts — C(t)/regime coherence panel acceptance tests (#138).
//
// done_when:
//   (a) parsePhysicsSnapshot returns a typed snapshot from valid JSON; null for invalid.
//   (b) loadBrainView includes physics from loadPhysicsFn — injects a mock to avoid KV.
//   (c) brainBody renders C/regime/Psi/ARF scalars from a stored physics snapshot.
//   (d) brainBody renders a "no data yet" panel when physics is null.
//   (e) POST /api/brain/physics — 401 on no token, 200 + stores on valid admin token.
//   (f) POST /api/brain/physics — 422 on a malformed payload.
//   (g) isSparseSnapshot — detection logic for fed-not-rich dead signal.
//   (h) brainBody renders sparse/carried qualifier when signal is sparse (ARF=0, C=1.0).
//   (i) brainBody renders normally (no sparse qualifier) when signal is rich (ARF!=0).
//   (j) brainBody sparse: surfaces completion count when present; "unknown" caveat when absent.

import { describe, expect, it, vi } from 'vitest'

// ── (a) parsePhysicsSnapshot ─────────────────────────────────────────────────
import { parsePhysicsSnapshot } from '../src/dashboard/brain'

const VALID_SNAPSHOT = {
  C: 0.912, R: 0.5, Psi: 0.012, ARF: 0.00547,
  regime: 'flow' as const,
  raw_C: 0.95, completed: 42, failed: 4, backlog: 1,
  had_signal: true, ts: 1720000000,
}

describe('(a) parsePhysicsSnapshot', () => {
  it('returns a typed snapshot from valid JSON', () => {
    const p = parsePhysicsSnapshot(JSON.stringify(VALID_SNAPSHOT))
    expect(p).not.toBeNull()
    expect(p?.C).toBe(0.912)
    expect(p?.regime).toBe('flow')
    expect(p?.ARF).toBe(0.00547)
    expect(p?.ts).toBe(1720000000)
  })

  it('returns null for null input', () => {
    expect(parsePhysicsSnapshot(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parsePhysicsSnapshot('')).toBeNull()
  })

  it('returns null when required numeric fields are missing', () => {
    const bad = { ...VALID_SNAPSHOT, C: 'not-a-number' }
    expect(parsePhysicsSnapshot(JSON.stringify(bad))).toBeNull()
  })

  it('returns null when regime is missing', () => {
    const { regime: _r, ...rest } = VALID_SNAPSHOT
    expect(parsePhysicsSnapshot(JSON.stringify(rest))).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parsePhysicsSnapshot('{bad json')).toBeNull()
  })
})

// ── (b) loadBrainView includes physics ──────────────────────────────────────
import { loadBrainView } from '../src/dashboard/brain'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

describe('(b) loadBrainView includes physics from loadPhysicsFn', () => {
  it('returns the physics snapshot when loadPhysicsFn resolves a snapshot', async () => {
    const view = await loadBrainView(ENV, {
      listLoopsFn: async () => [],
      listDecisionsFn: async () => [],
      loadPhysicsFn: async () => VALID_SNAPSHOT,
    })
    expect(view.physics).not.toBeNull()
    expect(view.physics?.regime).toBe('flow')
    expect(view.physics?.C).toBe(0.912)
  })

  it('returns null physics when loadPhysicsFn resolves null', async () => {
    const view = await loadBrainView(ENV, {
      listLoopsFn: async () => [],
      listDecisionsFn: async () => [],
      loadPhysicsFn: async () => null,
    })
    expect(view.physics).toBeNull()
  })

  it('returns null physics when loadPhysicsFn throws (fail-safe)', async () => {
    const view = await loadBrainView(ENV, {
      listLoopsFn: async () => [],
      listDecisionsFn: async () => [],
      loadPhysicsFn: async () => { throw new Error('kv_down') },
    })
    expect(view.physics).toBeNull()
  })
})

// ── (c) brainBody renders coherence scalars from a physics snapshot ──────────
import { brainBody } from '../src/dashboard/brain'

describe('(c) brainBody renders coherence scalars from physics snapshot', () => {
  it('contains regime badge with "flow"', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    expect(html).toContain('regime-flow')
    expect(html).toContain('flow')
  })

  it('renders C(t) value', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    expect(html).toContain('0.912')
  })

  it('renders R value', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    expect(html).toContain('0.500')
  })

  it('renders Psi value', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    expect(html).toContain('0.012')
  })

  it('renders ARF value', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    // ARF = 0.00547, rendered as toFixed(4) = "0.0055"
    expect(html).toContain('0.0055')
  })

  it('renders scalar labels (C(t), R, Ψ, ARF)', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: VALID_SNAPSHOT }, false))
    expect(html).toContain('C(t)')
    expect(html).toContain('ARF')
  })
})

// ── (d) brainBody renders "no data yet" when physics is null ────────────────
describe('(d) brainBody renders "no data yet" when physics is null', () => {
  it('shows the no-data message', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: null }, false))
    expect(html).toContain('no data yet')
    expect(html).toContain('/api/brain/physics')
  })

  it('does NOT render scalar elements when physics is null', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: null }, false))
    // The HTML body must not contain the scalar container div or individual scalar cells.
    // (CSS class definitions in <style> are always emitted; check for rendered elements.)
    expect(html).not.toContain('class="coherence-scalars"')
    expect(html).not.toContain('class="scalar-cell"')
  })
})

// ── (e) POST /api/brain/physics — 401 / 200 ─────────────────────────────────
import { brainPhysicsIngestApp } from '../src/dashboard/brain-ingest'
import { PHYSICS_KV_KEY } from '../src/dashboard/brain'

function makeIngestEnv(opts: {
  adminTokenHash?: string | null
  kvPutResult?: 'ok' | 'fail'
} = {}) {
  const { adminTokenHash = null, kvPutResult = 'ok' } = opts

  // sha256 of literal "admin-token" pre-computed to avoid async in mock setup.
  // We inject a DB that recognises the hash directly.
  const storedHash = adminTokenHash

  const kvStore: Record<string, string> = {}

  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: vi.fn(async () => {
      // Return a member row if a hash was given (simulating a valid admin token lookup).
      if (!storedHash) return null
      return {
        member_id: 'm1',
        display_name: 'Brain Daemon',
        email: null,
        status: 'active',
        bound_agent_id: null,
      }
    }),
    all: vi.fn(async () => ({
      results: storedHash
        ? [{ member_id: 'm1', scope_type: 'org', scope_id: null, capability: 'admin' }]
        : [],
    })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }

  return {
    TENANT_SLUG: 't',
    DB: { prepare: vi.fn(() => stmt) },
    SESSIONS: {
      get: vi.fn(async (k: string) => kvStore[k] ?? null),
      put: vi.fn(async (k: string, v: string) => {
        if (kvPutResult === 'fail') throw new Error('kv_error')
        kvStore[k] = v
      }),
    },
  } as unknown as Env & { TENANT_SLUG: string }
}

describe('(e) POST /api/brain/physics — auth + ingest', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const env = makeIngestEnv()
    const req = new Request('https://pot.test/physics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_SNAPSHOT),
    })
    const res = await brainPhysicsIngestApp.fetch(req, env)
    expect(res.status).toBe(401)
  })

  it('returns 200 and stores the snapshot when a valid admin token is provided', async () => {
    // Provide a non-null hash so the DB mock returns a valid admin member.
    const env = makeIngestEnv({ adminTokenHash: 'some-hash' })
    const req = new Request('https://pot.test/physics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-admin-token',
      },
      body: JSON.stringify(VALID_SNAPSHOT),
    })
    const res = await brainPhysicsIngestApp.fetch(req, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; regime: string; C: number }
    expect(body.ok).toBe(true)
    expect(body.regime).toBe('flow')
    expect(body.C).toBe(0.912)
    // Verify KV.put was called with the correct key.
    expect((env.SESSIONS as ReturnType<typeof makeIngestEnv>['SESSIONS']).put)
      .toHaveBeenCalledWith(PHYSICS_KV_KEY, expect.any(String), expect.objectContaining({ expirationTtl: expect.any(Number) }))
  })
})

// ── (f) POST /api/brain/physics — 422 on malformed payload ──────────────────
describe('(f) POST /api/brain/physics — 422 on malformed payload', () => {
  it('returns 422 when payload is missing required fields', async () => {
    const env = makeIngestEnv({ adminTokenHash: 'some-hash' })
    const req = new Request('https://pot.test/physics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-admin-token',
      },
      body: JSON.stringify({ C: 'not-a-number', regime: 'flow' }),
    })
    const res = await brainPhysicsIngestApp.fetch(req, env)
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_physics_payload')
  })
})

// ── (g) isSparseSnapshot — detection logic ───────────────────────────────────
import { isSparseSnapshot } from '../src/dashboard/brain'
import type { PhysicsSnapshot } from '../src/dashboard/brain'

function makeSparse(over: Partial<PhysicsSnapshot> = {}): PhysicsSnapshot {
  return {
    C: 1.0, R: 0.5, Psi: 0.0, ARF: 0.0,
    regime: 'coercion',
    raw_C: 1.0, completed: 0, failed: 0, backlog: 2,
    had_signal: false, ts: 1720000000,
    ...over,
  }
}

function makeRich(over: Partial<PhysicsSnapshot> = {}): PhysicsSnapshot {
  return {
    C: 0.85, R: 0.6, Psi: 0.05, ARF: 0.0255,
    regime: 'flow',
    raw_C: 0.9, completed: 12, failed: 2, backlog: 1,
    had_signal: true, ts: 1720000000,
    ...over,
  }
}

describe('(g) isSparseSnapshot', () => {
  it('returns true when ARF=0 and C=1.0 (canonical dead-signal)', () => {
    expect(isSparseSnapshot(makeSparse({ completed: undefined as unknown as number }))).toBe(true)
  })

  it('returns true when completed=0 (explicit zero, regardless of ARF)', () => {
    // Even if ARF is nonzero (e.g. rounding), explicit zero completions = sparse.
    expect(isSparseSnapshot(makeSparse({ ARF: 0.001, completed: 0 }))).toBe(true)
  })

  it('returns false when ARF!=0 (activation force present)', () => {
    expect(isSparseSnapshot(makeRich())).toBe(false)
  })

  it('returns false when completed>0 (real completions in window)', () => {
    expect(isSparseSnapshot(makeRich({ completed: 5 }))).toBe(false)
  })

  it('returns false when C!=1.0 and ARF=0 and no completed field (C decayed — not a carry)', () => {
    // ARF=0 but C already decayed to 0.7 and there is no completed count in the
    // snapshot: the EMA moved (prior cycles had completions), and C is not at the
    // carried-1.0 starting point, so this is not the dead-signal case.
    expect(isSparseSnapshot(makeSparse({
      C: 0.7, ARF: 0.0,
      completed: undefined as unknown as number,
    }))).toBe(false)
  })
})

// ── (h) brainBody renders sparse qualifier when snapshot is sparse ────────────
describe('(h) brainBody: sparse snapshot renders carried qualifier, not confident-healthy style', () => {
  it('C(t) cell uses scalar-value-sparse class (muted), not scalar-value (bold)', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeSparse() }, false))
    expect(html).toContain('scalar-value-sparse')
    // The plain scalar-value class must NOT appear for the C cell when sparse.
    // (Other cells — R, Psi, ARF — still use scalar-value, so we check for the sparse label instead.)
    expect(html).toContain('carried · sparse')
  })

  it('renders the human label "fed, not rich" and "pilot-scale throughput"', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeSparse() }, false))
    expect(html).toContain('fed, not rich')
    expect(html).toContain('pilot-scale throughput')
  })

  it('surfaces completion count when completed is present in snapshot', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeSparse({ completed: 0 }) }, false))
    expect(html).toContain('based on 0 completions in window')
  })

  it('does NOT render confident-green style for a sparse C=1.0', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeSparse() }, false))
    // The panel must not use a style that implies health (regime-flow badge is
    // coercion for sparse fixture; the C cell must be muted not bold).
    expect(html).toContain('scalar-value-sparse')
    expect(html).not.toContain('"scalar-value">1.000') // no confident bold 1.000
  })
})

// ── (i) brainBody renders normally when signal is rich ───────────────────────
describe('(i) brainBody: rich snapshot renders C normally without sparse qualifier', () => {
  it('does NOT render "carried · sparse" or "fed, not rich" for a rich signal', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeRich() }, false))
    // The sparse qualifier text must not appear in the rendered HTML body.
    // (The CSS style block defines .scalar-value-sparse but that is a definition,
    // not a usage — we check the human-readable qualifier text instead.)
    expect(html).not.toContain('carried · sparse')
    expect(html).not.toContain('fed, not rich')
  })

  it('uses the class attribute "scalar-value" (not sparse variant) on the C cell for a rich signal', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeRich() }, false))
    // Rich: the C cell renders with plain scalar-value, not scalar-value-sparse.
    // Hono html`` renders: class="scalar-value">0.850
    expect(html).toContain('"scalar-value">0.850')
    expect(html).not.toContain('"scalar-value-sparse">0.850')
  })

  it('still renders the C value in the panel', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: makeRich() }, false))
    expect(html).toContain('0.850')
  })
})

// ── (j) brainBody sparse: "sample size unknown" when completed absent ─────────
describe('(j) brainBody sparse: caveat when completed field is absent from snapshot', () => {
  it('shows "sample size unknown — interpret C as directional only" when completed is absent', () => {
    // Snapshot triggers ARF=0 + C=1.0 path but has no `completed` field.
    const noCompleted: PhysicsSnapshot = {
      C: 1.0, R: 0.5, Psi: 0.0, ARF: 0.0,
      regime: 'coercion',
      raw_C: 1.0,
      // completed deliberately omitted to simulate older snapshot shape
      completed: undefined as unknown as number,
      failed: 0, backlog: 2,
      had_signal: false, ts: 1720000000,
    }
    const html = String(brainBody({ loops: [], decisions: [], physics: noCompleted }, false))
    expect(html).toContain('sample size unknown')
    expect(html).toContain('directional only')
  })
})

// ── no data still shows "no data yet" (regression guard) ────────────────────
describe('no-data panel: unchanged behaviour', () => {
  it('shows "no data yet" when physics is null', () => {
    const html = String(brainBody({ loops: [], decisions: [], physics: null }, false))
    expect(html).toContain('no data yet')
  })
})
