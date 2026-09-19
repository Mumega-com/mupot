// tests/agent-lifecycle.test.ts — PILOT composite router for one tool family.
//
// agent_lifecycle wraps move_agent_squad / grant_agent_capability /
// deactivate_agent / mint_agent_token. Explicit action is a deterministic
// delegate (zero new authz). Free-text intent is classified and declined on
// low confidence. The safety property is the decline, not the happy path.
//
// NOTE ON ENTRY ORDER: `../src/mcp` (index) must be the first module entered —
// same circular-import reason as tests/provision-real-schema.test.ts.

import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import {
  applyLifecycleConfidenceGate,
  classifyLifecycleIntentWithJev,
  JEV_MIN_MARGIN,
  JEV_MIN_TOP_PROBABILITY,
  runAgentLifecycle,
  toolAgentLifecycle,
  type JevChoiceAnswer,
} from '../src/mcp/agent-lifecycle'
import {
  toolDeactivateAgent,
  toolGrantAgentCapability,
  toolMintAgentToken,
  toolMoveAgentSquad,
} from '../src/mcp/provision'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const ORIGIN = 'https://pot.test'
const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const HOME_SQUAD = 'squad-home'
const DEST_SQUAD = 'squad-dest'
const AGENT_ID = 'agent-test'
const AGENT_SLUG = 'test-agent'
const OPERATOR = 'member-operator'
const AGENT_MEMBER = 'member-agent'
const MEMBER_ONLY = 'member-only'

function grant(
  memberId: string,
  scopeType: CapabilityGrant['scope_type'],
  scopeId: string | null,
  capability: CapabilityGrant['capability'],
): CapabilityGrant {
  return { member_id: memberId, scope_type: scopeType, scope_id: scopeId, capability }
}

function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR,
    memberId: OPERATOR,
    email: 'operator@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [grant(OPERATOR, 'org', null, 'admin')],
  } as AuthContext
}

function memberAuth(): AuthContext {
  return {
    userId: MEMBER_ONLY,
    memberId: MEMBER_ONLY,
    email: 'member@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [grant(MEMBER_ONLY, 'squad', HOME_SQUAD, 'member')],
  } as AuthContext
}

// Admin on the DESTINATION only. That clears invokeTool's scope-agnostic
// min:'admin' floor (admin on ANY scope) and still fails move_agent_squad's
// from-squad admin check — so the composite's refusal is the delegate's, not
// the floor's, and both calls go through the production seam.
function destOnlyAdminAuth(): AuthContext {
  return {
    userId: MEMBER_ONLY,
    memberId: MEMBER_ONLY,
    email: 'member@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [grant(MEMBER_ONLY, 'squad', DEST_SQUAD, 'admin')],
  } as AuthContext
}

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD}', '${DEPT_ID}', 'home', 'Home Squad'),
      ('${DEST_SQUAD}', '${DEPT_ID}', 'dest', 'Dest Squad');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_ID}', '${HOME_SQUAD}', '${AGENT_SLUG}', 'Test Agent', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${OPERATOR}', 'Operator', 'active', '${TENANT}'),
      ('${AGENT_MEMBER}', 'Agent Member', 'active', '${TENANT}'),
      ('${MEMBER_ONLY}', 'Member Only', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', '2026-08-05T00:00:00Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-op-org-admin', '${OPERATOR}', 'org', NULL, 'admin'),
      ('cap-agent-home', '${AGENT_MEMBER}', 'squad', '${HOME_SQUAD}', 'member'),
      ('cap-member-home', '${MEMBER_ONLY}', 'squad', '${HOME_SQUAD}', 'member');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-agent-home', '${AGENT_ID}', '${HOME_SQUAD}', 'member');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-live', '${AGENT_MEMBER}', 'hash-live', 'workspace', 'workspace',
              '2026-08-05T00:00:00Z', '${AGENT_ID}', '${TENANT}');
  `)
}

function confident(choice: JevChoiceAnswer['choice']): JevChoiceAnswer {
  const probabilities: Record<string, number> = {
    move_squad: 0.05,
    grant_capability: 0.05,
    deactivate: 0.05,
    mint_token: 0.05,
  }
  probabilities[choice] = 0.85
  return { choice, probabilities, confidence: 0.8, model: 'jev-test' }
}

function loadTypesafeKey(): string | null {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim()
  const path = '/home/mumega/.secrets/typesafe-api.key'
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8').trim()
  return raw || null
}

describe('agent_lifecycle confidence gate', () => {
  it('accepts a majority top mass with a 0.2+ margin', () => {
    const gated = applyLifecycleConfidenceGate({
      choice: 'deactivate',
      probabilities: { deactivate: 0.7, move_squad: 0.2, grant_capability: 0.05, mint_token: 0.05 },
    })
    expect(gated.ok).toBe(true)
    if (!gated.ok) return
    expect(gated.action).toBe('deactivate')
    expect(gated.topProbability).toBeCloseTo(0.7)
    expect(gated.margin).toBeCloseTo(0.5)
  })

  it('declines when top probability is below the named floor', () => {
    const gated = applyLifecycleConfidenceGate({
      choice: 'move_squad',
      probabilities: { move_squad: 0.55, grant_capability: 0.25, deactivate: 0.1, mint_token: 0.1 },
    })
    expect(gated.ok).toBe(false)
    if (gated.ok) return
    expect(gated.reason).toBe('low_confidence')
    expect(gated.topProbability).toBeLessThan(JEV_MIN_TOP_PROBABILITY)
  })

  it('declines a near-tie even when the top mass clears 0.6', () => {
    const gated = applyLifecycleConfidenceGate({
      choice: 'move_squad',
      probabilities: { move_squad: 0.52, grant_capability: 0.48 },
    })
    expect(gated.ok).toBe(false)
    if (gated.ok) return
    expect(gated.reason).toBe('low_confidence')
    expect(gated.margin).toBeLessThan(JEV_MIN_MARGIN)
  })

  it('declines an unknown choice even at high probability', () => {
    const gated = applyLifecycleConfidenceGate({
      choice: 'relocate_task',
      probabilities: { relocate_task: 0.9, move_squad: 0.1 },
    })
    expect(gated).toMatchObject({ ok: false, reason: 'unknown_action' })
  })
})

describe('agent_lifecycle', () => {
  let harness: SqliteD1Harness
  let env: Env
  const ctx = { origin: ORIGIN, transport: 'mcp' as const }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      PUBLIC_ORIGIN: ORIGIN,
      SESSIONS: memoryKv(),
      BUS: { send: async () => {} },
    } as unknown as Env
  })

  afterEach(() => harness.close())

  it('declares min: admin — the shared floor of all four delegates, not a new bar', () => {
    expect(toolAgentLifecycle.min).toBe('admin')
    expect(toolMoveAgentSquad.min).toBe('admin')
    expect(toolGrantAgentCapability.min).toBe('admin')
    expect(toolDeactivateAgent.min).toBe('admin')
    expect(toolMintAgentToken.min).toBe('admin')
  })

  it('is advertised next to the four flat tools and does not remove them', async () => {
    const names = [
      'agent_lifecycle',
      'move_agent_squad',
      'grant_agent_capability',
      'deactivate_agent',
      'mint_agent_token',
    ]
    for (const name of names) {
      const listed = await invokeTool(operatorAuth(), env, name, {}, ORIGIN)
      expect(listed.tool).toBe(name)
      expect(listed.ok === false && listed.error === 'unknown_tool').toBe(false)
    }
  })

  it('400 when neither action nor intent is given', async () => {
    const out = await invokeTool(operatorAuth(), env, 'agent_lifecycle', { agent: AGENT_ID }, ORIGIN)
    expect(out).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
  })

  it('explicit action move_squad reaches move_agent_squad and moves home', async () => {
    const out = await invokeTool(operatorAuth(), env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'move_squad',
      params: { to_squad: DEST_SQUAD, capability: 'lead', reason: 'composite explicit' },
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({
      agent: { id: AGENT_ID, squad_id: DEST_SQUAD },
      from_squad: { id: HOME_SQUAD },
      to_squad: { id: DEST_SQUAD },
      capability: 'lead',
    })
    const row = harness.sqlite.prepare('SELECT squad_id FROM agents WHERE id = ?').get(AGENT_ID) as { squad_id: string }
    expect(row.squad_id).toBe(DEST_SQUAD)
  })

  it('explicit action grant_capability reaches grant_agent_capability', async () => {
    const out = await invokeTool(operatorAuth(), env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'grant_capability',
      params: { squad: DEST_SQUAD, capability: 'member' },
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({
      agent: { id: AGENT_ID },
      squad: { id: DEST_SQUAD },
      member_id: AGENT_MEMBER,
      grant: { capability: 'member', scope_id: DEST_SQUAD },
    })
    const home = harness.sqlite.prepare('SELECT squad_id FROM agents WHERE id = ?').get(AGENT_ID) as { squad_id: string }
    expect(home.squad_id).toBe(HOME_SQUAD)
  })

  it('explicit action deactivate reaches deactivate_agent', async () => {
    const out = await invokeTool(operatorAuth(), env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'deactivate',
      params: { reason: 'retired via composite' },
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({ status: 'deactivated', agent: { id: AGENT_ID } })
    const row = harness.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID) as { status: string }
    expect(row.status).toBe('inactive')
  })

  it('explicit action mint_token reaches mint_agent_token without exposing the raw secret', async () => {
    const out = await invokeTool(operatorAuth(), env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'mint_token',
      params: { label: 'via-composite' },
    }, ORIGIN)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const dumped = JSON.stringify(out.result)
    expect(dumped).not.toMatch(/"raw"\s*:/)
    expect(out.result).toMatchObject({
      credential_claim: { claim_id: expect.any(String), fingerprint: expect.any(String) },
      token: { agent_id: AGENT_ID },
    })
  })

  it('surfaces the underlying tool\'s authz refusal unchanged (delegation, not a new gate)', async () => {
    const caller = destOnlyAdminAuth()
    const direct = await invokeTool(caller, env, 'move_agent_squad', {
      agent: AGENT_ID,
      to_squad: DEST_SQUAD,
      capability: 'member',
    }, ORIGIN)
    const via = await invokeTool(caller, env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'move_squad',
      params: { to_squad: DEST_SQUAD, capability: 'member' },
    }, ORIGIN)
    expect(direct.ok).toBe(false)
    expect(via.ok).toBe(false)
    if (direct.ok || via.ok) return
    // invokeTool stamps `tool`; the refusal body must be the delegate's.
    expect(direct.error).toBe('forbidden')
    expect(direct.detail).toEqual({ need: 'admin', scope: 'squad', side: 'from' })
    expect(via.status).toBe(direct.status)
    expect(via.error).toBe(direct.error)
    expect(via.detail).toEqual(direct.detail)
  })

  it('invokeTool floor still refuses a caller who holds no admin anywhere', async () => {
    const out = await invokeTool(memberAuth(), env, 'agent_lifecycle', {
      agent: AGENT_ID,
      action: 'deactivate',
    }, ORIGIN)
    expect(out).toMatchObject({ ok: false, status: 403, error: 'forbidden', detail: { need: 'admin' } })
  })

  it('explicit action wins over intent — classifier is never called', async () => {
    let called = 0
    const out = await runAgentLifecycle(operatorAuth(), env, {
      agent: AGENT_ID,
      action: 'deactivate',
      intent: 'mint a brand new token for this agent immediately',
    }, ctx, {
      classify: async () => {
        called += 1
        return confident('mint_token')
      },
    })
    expect(called).toBe(0)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({ status: 'deactivated' })
  })

  const intentCases: Array<{
    action: 'move_squad' | 'grant_capability' | 'deactivate' | 'mint_token'
    intent: string
    params?: Record<string, unknown>
    assert: (out: { ok: boolean; result?: unknown }) => void
  }> = [
    {
      action: 'move_squad',
      intent: 'Move this agent to the destination squad and grant it lead there.',
      params: { to_squad: DEST_SQUAD, capability: 'lead' },
      assert: (out) => expect(out.result).toMatchObject({ agent: { squad_id: DEST_SQUAD } }),
    },
    {
      action: 'grant_capability',
      intent: 'Grant this agent member access on the destination squad; do not change its home squad.',
      params: { squad: DEST_SQUAD, capability: 'member' },
      assert: (out) => expect(out.result).toMatchObject({ grant: { capability: 'member', scope_id: DEST_SQUAD } }),
    },
    {
      action: 'deactivate',
      intent: 'Deactivate this agent and revoke its credentials; it is retired.',
      assert: (out) => expect(out.result).toMatchObject({ status: 'deactivated' }),
    },
    {
      action: 'mint_token',
      intent: 'Mint a new workspace bearer token for this agent.',
      params: { label: 'intent-mint' },
      assert: (out) => expect(out.result).toMatchObject({ token: { agent_id: AGENT_ID } }),
    },
  ]

  for (const c of intentCases) {
    it(`intent path: unambiguous ${c.action} phrase classifies and executes`, async () => {
      const out = await runAgentLifecycle(operatorAuth(), env, {
        agent: AGENT_ID,
        intent: c.intent,
        params: c.params,
      }, ctx, { classify: async () => confident(c.action) })
      expect(out.ok, `${c.action}: ${JSON.stringify(out)}`).toBe(true)
      c.assert(out)
    })
  }

  it('adversarial low-confidence intent declines to route and does not execute', async () => {
    const out = await runAgentLifecycle(operatorAuth(), env, {
      agent: AGENT_ID,
      intent: 'Update this agent\'s access to the destination squad',
      params: { to_squad: DEST_SQUAD, capability: 'member', squad: DEST_SQUAD },
    }, ctx, {
      classify: async () => ({
        choice: 'move_squad',
        probabilities: { move_squad: 0.48, grant_capability: 0.47, deactivate: 0.03, mint_token: 0.02 },
        confidence: 0.12,
      }),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({
      status: 'ambiguous',
      reason: 'low_confidence',
      hint: expect.stringContaining('explicit action'),
    })
    const tools = (out.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(tools).toEqual([
      'move_agent_squad',
      'grant_agent_capability',
      'deactivate_agent',
      'mint_agent_token',
    ])
    const row = harness.sqlite.prepare('SELECT squad_id, status FROM agents WHERE id = ?').get(AGENT_ID) as {
      squad_id: string
      status: string
    }
    expect(row.squad_id).toBe(HOME_SQUAD)
    expect(row.status).toBe('active')
  })

  it('classifier transport failure is 503, not a guess', async () => {
    const out = await runAgentLifecycle(operatorAuth(), env, {
      agent: AGENT_ID,
      intent: 'move the agent',
    }, ctx, {
      classify: async () => {
        throw new Error('network down')
      },
    })
    expect(out).toMatchObject({ ok: false, status: 503, error: 'classifier_unavailable' })
    const row = harness.sqlite.prepare('SELECT squad_id FROM agents WHERE id = ?').get(AGENT_ID) as { squad_id: string }
    expect(row.squad_id).toBe(HOME_SQUAD)
  })
})

const liveKey = loadTypesafeKey()

describe.skipIf(!liveKey)('agent_lifecycle live Jev classification (no execute)', () => {
  const env = { TYPESAFE_API_KEY: liveKey ?? '' } as Env

  it('classifies four unambiguous phrases onto the matching action above the gate', async () => {
    const phrases: Array<{ action: string; intent: string }> = [
      { action: 'move_squad', intent: 'Move this agent to the QA squad and grant it lead there. This is a home-squad transfer.' },
      { action: 'grant_capability', intent: 'Grant this agent member capability on the marketing squad. Do not move its home squad.' },
      { action: 'deactivate', intent: 'Deactivate this agent permanently and revoke every live token. It is retired.' },
      { action: 'mint_token', intent: 'Mint a new agent-bound bearer token credential for this agent. Do not move or deactivate it.' },
    ]
    for (const phrase of phrases) {
      const answer = await classifyLifecycleIntentWithJev(env, phrase.intent, AGENT_ID)
      const gated = applyLifecycleConfidenceGate(answer)
      expect(gated.ok, `${phrase.action} ok=${JSON.stringify(gated)} choice=${answer.choice}`).toBe(true)
      if (!gated.ok) continue
      expect(gated.action).toBe(phrase.action)
    }
  })

  it('declines an adversarial phrase that is genuinely two actions at once', async () => {
    const answer = await classifyLifecycleIntentWithJev(
      env,
      'Update this agent\'s access to the QA squad — either move it there or just grant access, whatever you think is right',
      AGENT_ID,
    )
    const gated = applyLifecycleConfidenceGate(answer)
    expect(gated.ok, `expected decline, got ${JSON.stringify({ gated, answer })}`).toBe(false)
  })
})
