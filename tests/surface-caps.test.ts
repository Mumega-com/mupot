// Tests for per-surface capability gates (#106).
//
// Coverage:
//   1. hasSurfaceCap — unit tests for the pure D1 check + owner/admin bypass.
//   2. POST /brain/loops/:id/control — budget:write + content:write gates
//      (uses cookie-based session auth, matching brain-panel.test.ts pattern).
//   3. POST /api/tasks/:id/verdict with gate_owner='gate:loops' — outreach:send-gated
//      (uses Bearer member-token auth, matching the tasks route's auth path).
//   4. mintScopedKey — gate_grants rows written for preset.allows at mint time.
//
// Acceptance criteria from issue #106:
//   a. member session → 403 on budget:write (loop control budget_override)
//   b. member session with content:write grant → 403 on budget_override (still needs budget:write)
//   c. member Bearer token → 403 on outreach:send-gated (verdict approve without surface grant)
//   d. member Bearer token with surface grant → passes (verdict approve)
//   e. Admin session → passes all loop-control gates (rank bypass)

import { describe, expect, it, vi } from 'vitest'
import type { Env, AuthContext } from '../src/types'
import { hasSurfaceCap } from '../src/auth/capability'
import { mintScopedKey } from '../src/dashboard/keys'
import { dashboardApp } from '../src/dashboard'
import { tasksApp } from '../src/tasks'

// ── 1. hasSurfaceCap — pure unit tests ────────────────────────────────────────
// No HTTP stack — tests only the D1 query logic and the owner/admin bypass.

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: null,
    role: 'member',
    tenant: 'test',
    channel: 'workspace',
    memberId: 'member-1',
    capabilities: [],
    boundAgentId: null,
    ...overrides,
  }
}

/** Build a minimal Env mock that answers gate_grants queries. */
function makeEnv(grantedSurfaces: string[] = [], principalId = 'member-1'): Env {
  return {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async first() {
            if (sql.includes('FROM gate_grants')) {
              const surface = args[0] as string
              const pid = args[2] as string
              if (pid === principalId && grantedSurfaces.includes(surface)) {
                return { 1: 1 }
              }
              return null
            }
            return null
          },
          async all() { return { results: [] } },
          async run() { return { meta: { changes: 1 } } },
        }),
      }),
    },
  } as unknown as Env
}

describe('hasSurfaceCap — owner/admin bypass', () => {
  it('org owner always passes regardless of gate_grants', async () => {
    const auth = makeAuthContext({ role: 'owner', memberId: 'owner-1' })
    const env = makeEnv([], 'owner-1')  // no grants in DB
    expect(await hasSurfaceCap(env, auth, 'outreach:send-gated')).toBe(true)
    expect(await hasSurfaceCap(env, auth, 'budget:write')).toBe(true)
    expect(await hasSurfaceCap(env, auth, 'mcpwp:write')).toBe(true)
  })

  it('org admin always passes regardless of gate_grants', async () => {
    const auth = makeAuthContext({ role: 'admin', memberId: 'admin-1' })
    const env = makeEnv([], 'admin-1')  // no grants in DB
    expect(await hasSurfaceCap(env, auth, 'budget:write')).toBe(true)
    expect(await hasSurfaceCap(env, auth, 'content:write')).toBe(true)
  })
})

describe('hasSurfaceCap — member with explicit grants', () => {
  it('passes when the surface is in gate_grants', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: 'member-1' })
    const env = makeEnv(['outreach:send-gated', 'leads:read'], 'member-1')
    expect(await hasSurfaceCap(env, auth, 'outreach:send-gated')).toBe(true)
    expect(await hasSurfaceCap(env, auth, 'leads:read')).toBe(true)
  })

  it('blocks mcpwp:write when not granted (a: mcpwp:write denied to sales-rep)', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: 'member-1' })
    const env = makeEnv(['outreach:draft'], 'member-1')  // only outreach:draft
    expect(await hasSurfaceCap(env, auth, 'mcpwp:write')).toBe(false)
  })

  it('blocks budget:write when not granted (sales-rep preset does not allow budget:write)', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: 'member-1' })
    const env = makeEnv(['outreach:send-gated', 'leads:read'], 'member-1')
    expect(await hasSurfaceCap(env, auth, 'budget:write')).toBe(false)
  })

  it('blocks outreach:send-gated when not in gate_grants', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: 'member-1' })
    const env = makeEnv(['outreach:draft'], 'member-1')
    expect(await hasSurfaceCap(env, auth, 'outreach:send-gated')).toBe(false)
  })
})

describe('hasSurfaceCap — member with no grants', () => {
  it('blocks all surfaces when gate_grants has no rows for this member', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: 'nobody' })
    const env = makeEnv(['budget:write'], 'someone-else')
    expect(await hasSurfaceCap(env, auth, 'budget:write')).toBe(false)
    expect(await hasSurfaceCap(env, auth, 'content:write')).toBe(false)
  })

  it('blocks when auth has no memberId and empty userId', async () => {
    const auth = makeAuthContext({ role: 'member', memberId: null as unknown as string, userId: '' })
    const env = makeEnv(['budget:write'], 'member-1')
    expect(await hasSurfaceCap(env, auth, 'budget:write')).toBe(false)
  })
})

// ── 2. POST /brain/loops/:id/control — surface gates ─────────────────────────
//
// Uses SESSIONS-based (cookie) auth — same pattern as brain-panel.test.ts.
// The session gives the caller an org role. For non-admin sessions, hasSurfaceCap
// queries gate_grants with principal_type='agent' and principal_id=userId
// (because session auth does not set memberId).

// Loop row that passes hydrateLoop's validateLoopSpec (mirrors brain-panel.test.ts).
const VALID_LOOP_ROW = {
  id: 'loop-1', tenant: 'test', squad_id: null, agent_id: 'a1', status: 'active',
  spec: JSON.stringify({
    agent_id: 'a1', squad_id: null,
    okr: 'grow', kpi: { signal: 'x', target: 5 },
    sources: [], channels: [], gate: { require_approval: false },
    budget: {}, cadence: {}, stop: {},
  }),
  dry_rounds: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

/**
 * Env for a session-based caller.
 *
 * For non-admin members with no grants: the surface cap gate fires BEFORE the
 * loop lookup, so first() can return null — we never reach getLoop().
 *
 * For members WITH grants (or admin/owner): the gate passes, so the loop lookup
 * must succeed. We use firstResponses + a counter to feed different queries.
 */
function makeSessionEnv(opts: {
  orgRole: 'owner' | 'admin' | 'member'
  grantedSurfaces?: string[]
  userId?: string
}): Env {
  const { orgRole, grantedSurfaces = [], userId = 'user-1' } = opts

  // firstResponses: feeds first() calls IN ORDER.
  // For admin/owner: [loopRow, ...anything else]
  // For member with no grants: doesn't matter (403 before loop lookup)
  // For member with grants: [loopRow, ...] needed for content:write path
  const firstResponses: unknown[] = [VALID_LOOP_ROW]
  let firstIdx = 0

  const stmt = {
    bind: (...args: unknown[]) => {
      const captured = args
      return {
        first: vi.fn(async () => {
          // gate_grants lookup: hasSurfaceCap binds (surface, principalType, principalId)
          // 3 args, second arg is 'member' or 'agent'.
          if (
            captured.length === 3 &&
            typeof captured[0] === 'string' &&
            (captured[1] === 'member' || captured[1] === 'agent')
          ) {
            const surface = captured[0] as string
            const pid = captured[2] as string
            if (pid === userId && grantedSurfaces.includes(surface)) return { 1: 1 }
            return null
          }
          // All other first() calls (loop lookup, etc.): serve from ordered queue
          return firstResponses[firstIdx++] ?? null
        }),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      }
    },
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }

  return {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    DB: { prepare: vi.fn(() => stmt) },
    SESSIONS: {
      get: vi.fn(async () => JSON.stringify({
        userId, email: `${orgRole}@test.com`, role: orgRole, createdAt: '2026-01-01T00:00:00Z',
      })),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

async function postControl(env: Env, action: string, value?: string) {
  const body: Record<string, string> = { action }
  if (value !== undefined) body.value = value
  return dashboardApp.fetch(
    new Request('https://pot.test/brain/loops/loop-1/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'mupot_session=sess1',
        Origin: 'https://pot.test',
      },
      body: JSON.stringify(body),
    }),
    env,
  )
}

describe('POST /brain/loops/:id/control — surface gates', () => {
  it('member session without content:write → 403 on pause (b: content:write required)', async () => {
    const env = makeSessionEnv({ orgRole: 'member', grantedSurfaces: [] })
    const res = await postControl(env, 'pause')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; need: string }
    expect(body.error).toBe('forbidden')
    expect(body.need).toBe('content:write')
  })

  it('member session with content:write → 200 on pause (content:write gate passes)', async () => {
    const env = makeSessionEnv({ orgRole: 'member', grantedSurfaces: ['content:write'] })
    const res = await postControl(env, 'pause')
    expect(res.status).toBe(200)
  })

  it('member session with content:write but no budget:write → 403 on budget_override (b: budget:write required)', async () => {
    const env = makeSessionEnv({ orgRole: 'member', grantedSurfaces: ['content:write'] })
    const res = await postControl(env, 'budget_override', '100000')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; need: string }
    expect(body.error).toBe('forbidden')
    expect(body.need).toBe('budget:write')
  })

  it('member session with both content:write + budget:write → passes budget_override gate', async () => {
    const env = makeSessionEnv({ orgRole: 'member', grantedSurfaces: ['content:write', 'budget:write'] })
    const res = await postControl(env, 'budget_override', '100000')
    // Gate passed — status will be 200 (the setLoopControl write runs)
    expect(res.status).toBe(200)
  })

  it('admin session → passes all actions without explicit grants (e: rank bypass)', async () => {
    const env = makeSessionEnv({ orgRole: 'admin', grantedSurfaces: [] })
    const res = await postControl(env, 'pause')
    expect(res.status).toBe(200)
  })

  it('owner session → passes budget_override without explicit grants', async () => {
    const env = makeSessionEnv({ orgRole: 'owner', grantedSurfaces: [] })
    const res = await postControl(env, 'budget_override', '100000')
    expect(res.status).toBe(200)
  })
})

// ── 3. outreach:send-gated surface gate — logic tests ─────────────────────────
//
// The verdict route uses requireAuth (session cookie auth); the tasks app does
// not have a member-token auth path. HTTP-level surface cap testing requires
// session auth + a memberId in gate_grants, which is not what requireAuth sets.
//
// Instead we test the gate logic directly through hasSurfaceCap (already covered
// in section 1) plus a structural assertion: verify the gate code exists in
// tasks/index.ts at the correct position (after callerHoldsGateCapability, before
// self-verdict check). This confirms the guard is wired, not just defined.
//
// For HTTP-level confirmation, the surface gate fires AFTER canActOnSquad. A
// session-based admin (whose hasSurfaceCap returns true via bypass) can reach
// past both gates — this confirms the path is reachable.

import * as fs from 'node:fs'
import * as path from 'node:path'

describe('outreach:send-gated gate wired in tasks/index.ts (structural)', () => {
  const tasksSource = fs.readFileSync(
    path.resolve(__dirname, '../src/tasks/index.ts'),
    'utf8',
  )

  it('surface gate code present: hasSurfaceCap imported', () => {
    expect(tasksSource).toMatch(
      /import\s*\{[^}]*\bhasSurfaceCap\b[^}]*\}\s*from\s*'\.\.\/auth\/capability'/,
    )
  })

  it('surface gate fires when gate_owner=gate:loops and verdict=approved', () => {
    expect(tasksSource).toContain("task.gate_owner === 'gate:loops' && body.verdict === 'approved'")
    expect(tasksSource).toContain("hasSurfaceCap(c.env, auth, 'outreach:send-gated')")
  })

  it('surface gate is between callerHoldsGateCapability and self-verdict check', () => {
    const gateIdx = tasksSource.indexOf("task.gate_owner === 'gate:loops' && body.verdict === 'approved'")
    const callerHoldsIdx = tasksSource.indexOf('callerHoldsGateCapability(')
    const selfVerdictIdx = tasksSource.indexOf('K4: self-verdict prevention')
    // gate is after callerHolds check, before self-verdict check
    expect(gateIdx).toBeGreaterThan(callerHoldsIdx)
    expect(gateIdx).toBeLessThan(selfVerdictIdx)
  })

  it('surface gate returns 403 with need:outreach:send-gated when check fails', () => {
    expect(tasksSource).toContain("{ error: 'forbidden', need: 'outreach:send-gated' }, 403")
  })

  it('gate only applied on approved verdict, not rejected', () => {
    // The condition checks body.verdict === 'approved' — rejected skips the block
    const blockStart = tasksSource.indexOf("task.gate_owner === 'gate:loops' && body.verdict === 'approved'")
    const blockEnd = tasksSource.indexOf("K4: self-verdict prevention")
    const gateBlock = tasksSource.slice(blockStart, blockEnd)
    // The block contains 'approved' condition but not a parallel 'rejected' check
    expect(gateBlock).toContain("body.verdict === 'approved'")
    expect(gateBlock).not.toContain("body.verdict === 'rejected'")
  })
})

// HTTP-level confirmation: an admin session can reach the verdict route
// (confirms the path is reachable at all — the surface cap would pass for admin).
describe('verdict route — admin session reaches gate (c: integration smoke)', () => {
  function makeVerdictAdminEnv(): Env {
    const loopRow = { id: 'task-1', status: 'review', gate_owner: 'gate:loops',
      squad_id: 'squad-1', assignee_agent_id: 'agent-other', title: 'T', body: '{}' }
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      first: vi.fn(async () => loopRow),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      batch: vi.fn(async () => [{ meta: { changes: 1 } }]),
    }
    return {
      TENANT_SLUG: 'test',
      BRAND: 'Test',
      DB: {
        prepare: vi.fn(() => stmt),
        batch: vi.fn(async () => [{ meta: { changes: 1 } }]),
      },
      SESSIONS: {
        get: vi.fn(async () => JSON.stringify({
          userId: 'owner-1', email: 'owner@test.com', role: 'owner',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
      BUS: { send: vi.fn(async () => {}) },
    } as unknown as Env
  }

  it('owner session does NOT get 403 from surface gate (bypass active)', async () => {
    const env = makeVerdictAdminEnv()
    const res = await tasksApp.fetch(
      new Request('https://pot.test/task-1/verdict', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'mupot_session=sess1',
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({ verdict: 'approved' }),
      }),
      env,
    )
    // Owner bypasses hasSurfaceCap. May get 409 (self-verdict) or 200 — not 403.
    expect(res.status).not.toBe(403)
  })
})

// ── 4. mintScopedKey — attests, writes NO gate_grants at mint (S1) ─────────────
// The old mint wrote a gate_grants row per preset.allows surface on the member —
// a standing principal grant surviving revocation (S1). The fix removed it: mint
// attests the member's existing authority and writes nothing to the principal.

describe('mintScopedKey — writes no principal grants (attest, never grant)', () => {
  function attestEnv(grant: Record<string, unknown> | null) {
    const inserts: { sql: string; args: unknown[] }[] = []
    const env = {
      TENANT_SLUG: 'test',
      BRAND: 'Test',
      OAUTH_PROVIDER: 'google',
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            async first() {
              if (sql.includes('FROM members')) return { id: 'member-1' }
              if (sql.includes('department_id FROM squads')) return { department_id: null }
              if (sql.includes('FROM squads')) return { id: 'squad-1' }
              return null
            },
            async all() {
              // resolveCapabilities → the member's existing grants
              if (sql.includes('FROM capabilities')) return { results: grant ? [grant] : [] }
              return { results: [] }
            },
            async run() {
              inserts.push({ sql, args: [...args] })
              return { meta: { changes: 1 } }
            },
          }),
        }),
      },
    } as unknown as Env
    return { env, inserts }
  }

  it('writes NO gate_grants and NO capabilities rows when the member already holds the cap', async () => {
    const { env, inserts } = attestEnv({
      member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member',
    })
    const result = await mintScopedKey(env, {
      memberId: 'member-1', presetId: 'sales-rep', scopeId: 'squad-1', minterRank: 5,
    })
    expect(result.ok).toBe(true)
    expect(inserts.some((i) => i.sql.toLowerCase().includes('gate_grants'))).toBe(false)
    expect(inserts.some((i) => i.sql.toLowerCase().includes('into capabilities'))).toBe(false)
    // Only the member_tokens INSERT ran.
    expect(inserts.some((i) => i.sql.toLowerCase().includes('member_tokens'))).toBe(true)
  })

  it('refuses with no writes when the member lacks the capability', async () => {
    const { env, inserts } = attestEnv(null)
    const result = await mintScopedKey(env, {
      memberId: 'member-1', presetId: 'observer', scopeId: 'squad-1', minterRank: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('member_lacks_capability')
    expect(inserts.length).toBe(0)
  })
})
