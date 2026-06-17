// AAGATE capability-floor tests (#183).
//
// The MCP dispatch chokepoint enforces each tool's declared `min` capability
// CENTRALLY, before the handler runs — so a tool can never fail-open if its
// handler omits the inline scope check. Coverage:
//   1. holdsCapabilityFloor — pure ladder + legacy-role escape.
//   2. Registry completeness — every tool declares a valid `min`.
//   3. Dispatch wiring — a grantless caller is rejected at the floor (handler
//      never reached); a sufficiently-granted caller passes the floor through to
//      the handler.
import { describe, expect, it } from 'vitest'
import type { Env, AuthContext, Capability, CapabilityGrant } from '../src/types'
import { holdsCapabilityFloor } from '../src/auth/capability'
import { TOOLS, invokeTool } from '../src/mcp/index'

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
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

function grant(capability: Capability, scope_type = 'squad', scope_id: string | null = 'squad-X'): CapabilityGrant {
  return { member_id: 'member-1', scope_type, scope_id, capability } as CapabilityGrant
}

const VALID_MIN = new Set<string>(['authenticated', 'owner', 'admin', 'lead', 'member', 'observer'])

// ── 1. holdsCapabilityFloor — pure ────────────────────────────────────────────
describe('holdsCapabilityFloor — pure ladder + legacy-role escape', () => {
  it('grantless member → false (no grant at/above min)', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: [] }), 'member')).toBe(false)
  })

  it('member grant on some scope → meets a member floor', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: [grant('member')] }), 'member')).toBe(true)
  })

  it('observer grant does NOT meet a member floor (ladder)', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: [grant('observer')] }), 'member')).toBe(false)
  })

  it('a higher grant (owner) meets a lower floor (admin)', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: [grant('owner', 'org', null)] }), 'admin')).toBe(true)
  })

  it('floor is scope-agnostic — a squad grant satisfies the floor regardless of which scope', () => {
    // The handler\'s own check stops cross-scope; the floor only proves "holds min somewhere".
    expect(holdsCapabilityFloor(auth({ capabilities: [grant('member', 'squad', 'squad-A')] }), 'member')).toBe(true)
  })

  it('legacy web-login owner (no capabilities array) satisfies an admin floor by role', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: undefined, role: 'owner' }), 'admin')).toBe(true)
  })

  it('legacy web-login member (no capabilities array) does NOT satisfy an admin floor', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: undefined, role: 'member' }), 'admin')).toBe(false)
  })
})

// ── 2. registry completeness — no tool may ship without a declared min ─────────
describe('tool registry completeness', () => {
  it('every tool declares a valid `min`', () => {
    for (const t of TOOLS) {
      expect(VALID_MIN.has(t.min), `tool ${t.name} has invalid min: ${String(t.min)}`).toBe(true)
    }
  })

  it('there is at least one capability-gated tool (min above authenticated)', () => {
    expect(TOOLS.some((t) => t.min !== 'authenticated')).toBe(true)
  })
})

// ── 3. dispatch wiring — floor enforced before the handler ─────────────────────
describe('invokeTool — capability floor enforced at the chokepoint', () => {
  // A DB that THROWS if touched — proves a floor-rejected call never reaches the handler.
  const throwingDb = {
    prepare() {
      throw new Error('DB must not be touched — floor should reject first')
    },
  }
  // A DB that returns null for the squad lookup — proves a floor-passing call
  // reaches the handler (which then 404s on the missing squad).
  const nullSquadDb = {
    prepare() {
      return { bind: () => ({ async first() { return null }, async all() { return { results: [] } } }) }
    },
  }

  const gatedTool = 'task_create' // min: 'member'
  const args = { squad_id: 'squad-X', title: 'hi', done_when: 'GET /health returns 200' }

  it('grantless caller is rejected at the floor (403 forbidden, handler never reached)', async () => {
    const env = { TENANT_SLUG: 'test', DB: throwingDb } as unknown as Env
    const out = await invokeTool(auth({ capabilities: [] }), env, gatedTool, args, 'https://test')
    expect(out.ok).toBe(false)
    expect(out.status).toBe(403)
    expect(out.error).toBe('forbidden')
    expect((out.detail as { need?: string })?.need).toBe('member')
  })

  it('sufficiently-granted caller passes the floor through to the handler', async () => {
    const env = { TENANT_SLUG: 'test', DB: nullSquadDb } as unknown as Env
    const out = await invokeTool(auth({ capabilities: [grant('member')] }), env, gatedTool, args, 'https://test')
    // Past the floor → handler ran → loadSquad returned null → 404 (NOT a 403 floor reject).
    expect(out.status).toBe(404)
    expect(out.error).toBe('squad_not_found')
  })

  it('unknown tool → 400 (no floor bypass)', async () => {
    const env = { TENANT_SLUG: 'test', DB: throwingDb } as unknown as Env
    const out = await invokeTool(auth({ capabilities: [] }), env, 'no_such_tool', {}, 'https://test')
    expect(out.status).toBe(400)
    expect(out.error).toBe('unknown_tool')
  })
})
