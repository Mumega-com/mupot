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

// ── 4. status — `authenticated` floor exempt, but the cross-agent branch is gated ─
// (#183 adversarial review P1: the floor cannot gate min:'authenticated' tools, so
// the status agent_id lookup must carry its own observer-on-squad check.)
describe('status — self-echo open, cross-agent lookup gated in-handler', () => {
  // DB answering the status agent_id path: an agent row + a (dept-less) squad.
  const agentDb = {
    prepare(sql: string) {
      return {
        bind: () => ({
          async first() {
            if (sql.includes('FROM agents')) return { id: 'agent-9', name: 'a', role: 'r', model: 'm', status: 'idle', squad_id: 'squad-Z' }
            if (sql.includes('FROM squads')) return { department_id: null }
            return null
          },
          async all() { return { results: [] } },
        }),
      }
    },
  }

  it('self-echo (no agent_id) is open to any authenticated member — no 403', async () => {
    const noTouchDb = { prepare() { throw new Error('self-echo must not touch DB') } }
    const env = { TENANT_SLUG: 'test', DB: noTouchDb } as unknown as Env
    const out = await invokeTool(auth({ capabilities: [] }), env, 'status', {}, 'https://test')
    expect(out.ok).toBe(true) // returns the caller's own principal, touches no DB
  })

  it('cross-agent lookup by a grantless member → 403 forbidden (observer-on-squad required)', async () => {
    const env = { TENANT_SLUG: 'test', DB: agentDb } as unknown as Env
    const out = await invokeTool(auth({ capabilities: [] }), env, 'status', { agent_id: 'agent-9' }, 'https://test')
    expect(out.ok).toBe(false)
    expect(out.status).toBe(403)
    expect(out.error).toBe('forbidden')
    expect((out.detail as { need?: string })?.need).toBe('observer')
  })
})

// ── 5. OAuth-path invariant — capabilities:[] is NOT the legacy-role escape ────
// The directory/OAuth channel intentionally yields capabilities:[] (a resolved,
// non-undefined array). An org admin going through that door must be floored out of
// admin-gated tools — the legacy-role escape fires ONLY for capabilities===undefined
// (web-login seam that cannot reach MCP dispatch). Documents the B1 isolation.
describe('OAuth/directory channel — resolved empty array does not inherit the role escape', () => {
  it('capabilities:[] with role admin does NOT satisfy an admin floor', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: [], role: 'admin' }), 'admin')).toBe(false)
  })
  it('only capabilities===undefined takes the legacy-role branch', () => {
    expect(holdsCapabilityFloor(auth({ capabilities: undefined, role: 'admin' }), 'admin')).toBe(true)
  })
})
