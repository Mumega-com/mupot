// tests/dashboard-overview-header-chips.test.ts — Overview (GET /) header-chip
// live wiring. Overview is the highest-traffic page (the owner's landing page),
// so it uses the LIGHT reads only — loadBrainPhysics (bare KV get, same as
// brain.ts's coherence panel) and loadTodaySpendScalar (one D1 round trip),
// never the heavy loadBrainView / loadEconomy those other pages use.
//
// Full end-to-end: dispatches a real GET / through dashboardApp.fetch() with a
// permissive "empty pot" D1 mock (observatory/approvals/onboarding all read
// through .all()/.first() with honest-empty fallbacks already) plus a SESSIONS
// mock that branches on key — session cookie vs PHYSICS_KV_KEY — so the two KV
// reads a real request makes (auth session, physics snapshot) are independently
// controllable per test.

import { describe, it, expect, vi } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { PHYSICS_KV_KEY } from '../src/dashboard/brain'
import type { Env } from '../src/types'

// A D1 stub answering every query with an honest-empty shape (matches the
// zero-agents/zero-tasks/zero-approvals/never-onboarded pot state observatory.ts,
// approvals.ts, and settings.ts already handle gracefully) EXCEPT cc_spend_daily,
// which is driven by `spendRow` so loadTodaySpendScalar's single scalar read is
// independently testable per test case.
//
// FLIGHT-001 F2 — the dashboard's global capability floor now runs before every
// route, including GET /. The session below is a plain 'member' role (not
// owner/admin), so requireAuth's email→member bridge resolves it to a real
// member with ONE org-level capability grant — otherwise this fixture would be
// exactly the zero-capability drive-by signup the floor is built to reject, and
// every request in this file would 403 before ever reaching the header-chip
// code these tests exist to cover.
function makeD1(spendRow: { today_usd_micro: number; has_any: number } | null) {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: vi.fn(async () => spendRow),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  }
  const memberStmt = {
    bind: (..._args: unknown[]) => memberStmt,
    first: vi.fn(async () => ({ id: 'member-1' })),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  }
  const capabilitiesStmt = {
    bind: (..._args: unknown[]) => capabilitiesStmt,
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({
      results: [{ member_id: 'member-1', scope_type: 'org', scope_id: null, capability: 'member' }],
    })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  }
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM members')) return memberStmt
      if (sql.includes('FROM capabilities')) return capabilitiesStmt
      return stmt
    }),
  }
}

function makeEnv(opts: {
  physicsJson: string | null
  spendRow: { today_usd_micro: number; has_any: number } | null
}): Env {
  const sessionRecord = JSON.stringify({
    userId: 'u1',
    email: 'member@test',
    role: 'member', // non-owner so the un-onboarded pot doesn't redirect to /setup
    createdAt: '2026-01-01T00:00:00Z',
  })
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test Pot',
    DB: makeD1(opts.spendRow),
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key === PHYSICS_KV_KEY) return opts.physicsJson
        if (key.startsWith('sess:')) return sessionRecord
        return null
      }),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

function overviewReq(): Request {
  return new Request('https://pot.test/', {
    headers: { Cookie: 'mupot_session=s' },
  })
}

const LIVE_PHYSICS = JSON.stringify({
  C: 0.75, R: 0.9, Psi: 0.05, ARF: 0.038, regime: 'flow',
  raw_C: 0.7, completed: 4, failed: 0, backlog: 1, had_signal: true, ts: 1_700_000_000,
})

describe('GET / (Overview) — header chips wired live via the light reads', () => {
  it('shows the live regime chip when a physics snapshot exists in KV', async () => {
    const env = makeEnv({ physicsJson: LIVE_PHYSICS, spendRow: null })
    const res = await dashboardApp.fetch(overviewReq(), env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('regime-chip regime-flow')
    expect(html).toContain('Flow')
    expect(html).toContain('C(t) 0.750')
  })

  it('hides the regime chip honestly when KV has no snapshot', async () => {
    const env = makeEnv({ physicsJson: null, spendRow: null })
    const res = await dashboardApp.fetch(overviewReq(), env)
    const html = await res.text()
    expect(html).toMatch(/regime-chip"[^>]*style="display:none"/)
  })

  it('shows the live spend chip using the SAME today_usd_micro field economy.ts reads', async () => {
    const env = makeEnv({ physicsJson: null, spendRow: { today_usd_micro: 4_500_000, has_any: 1 } })
    const res = await dashboardApp.fetch(overviewReq(), env)
    const html = await res.text()
    expect(html).toContain('$4.50 today')
  })

  it('renders "no spend yet" (not a fabricated $0.00) when cc_spend_daily has never been configured', async () => {
    const env = makeEnv({ physicsJson: null, spendRow: { today_usd_micro: 0, has_any: 0 } })
    const res = await dashboardApp.fetch(overviewReq(), env)
    const html = await res.text()
    expect(html).toContain('no spend yet')
    expect(html).not.toContain('$0.00 today')
  })

  it('reads physics via a single SESSIONS.get (bare KV get) — never touches D1 for it', async () => {
    const env = makeEnv({ physicsJson: LIVE_PHYSICS, spendRow: null })
    await dashboardApp.fetch(overviewReq(), env)
    // Only the KV get was used for physics; D1 involvement is exclusively the
    // scalar spend read + the app's other Overview queries (observatory/
    // approvals/onboarding) — never a loadBrainView-style loops/decisions query.
    expect(env.SESSIONS.get).toHaveBeenCalledWith(PHYSICS_KV_KEY)
  })
})
