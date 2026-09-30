// The dashboard Access panel (POST /agents/:id/access) — service + in-batch guard.
//
// Two layers are proved separately on purpose:
//   - applyAgentAccessChange: the route's readable pre-checks, asserted by refusal CODE.
//   - receiptStatement driven straight through commitAgentSquadAccess /
//     commitRemoveAgentSquadAccess: the SAME guard re-asserted inside the D1 batch,
//     with a plan that violates exactly one leaf, so deleting a JS pre-check cannot
//     hide a missing SQL leaf and vice versa.
//
// Full committed migration chain (tests/helpers/migrations.ts) — no hand-built schema.
import { afterEach, describe, expect, it } from 'vitest'
import { applyAgentAccessChange, receiptStatement } from '../src/dashboard/agent-access-panel'
import type { AccessChangeInput, ReceiptPlan } from '../src/dashboard/agent-access-panel'
import { commitAgentSquadAccess, commitRemoveAgentSquadAccess } from '../src/members/agent-access'
import type { AgentAccessCapability } from '../src/members/agent-access'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'

let open: SqliteD1Harness | undefined
afterEach(() => {
  open?.close()
  open = undefined
})

function makeEnv(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  open = harness
  applyAllMigrations(harness.sqlite)
  const env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, kind) VALUES
      ('dept-eng', 'eng', 'Engineering', 'work'),
      ('dept-ops', 'ops', 'Operations', 'work');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('sq-home',  'dept-eng', 'rava-home',  'Rava Home',     'home'),
      ('sq-home2', 'dept-eng', 'other-home', 'Other Home',    'home'),
      ('sq-core',  'dept-eng', 'squad-core', 'Core Platform', 'work'),
      ('sq-ops',   'dept-ops', 'ops-desk',   'Ops Desk',      'work'),
      ('sq-old',   'dept-ops', 'old-desk',   'Old Desk',      'work');
    UPDATE squads SET status = 'archived', archived_at = '2026-09-01T00:00:00.000Z' WHERE id = 'sq-old';
    INSERT INTO members (id, display_name, status, tenant, email) VALUES
      ('m-hadi',     'Hadi',        'active', '${TENANT}', 'hadi@example.test'),
      ('m-owner',    'Owner',       'active', '${TENANT}', 'owner@example.test'),
      ('m-sqadmin',  'Squad Admin', 'active', '${TENANT}', 'sq@example.test'),
      ('m-rava',     'Rava',        'active', '${TENANT}', NULL),
      ('m-other',    'Other Agent', 'active', '${TENANT}', NULL),
      ('m-legacy',   'Legacy Owner','active', '${TENANT}', 'Legacy@Example.test');
    INSERT INTO users (id, email, role) VALUES ('u-legacy', 'legacy@example.test', 'owner');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('rava',    'sq-home', 'rava',    'Rava',        'member', 'test', 'active'),
      ('other',   'sq-ops',  'other',   'Other Agent', 'member', 'test', 'active'),
      ('unminted','sq-home', 'unminted','Unminted',    'member', 'test', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'rava',  'm-rava',  '2026-09-01T00:00:00.000Z'),
      ('${TENANT}', 'other', 'm-other', '2026-09-01T00:00:00.000Z');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-home', 'rava', 'sq-home', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-rava-home', 'm-rava', 'squad', 'sq-home', 'member'),
      ('cap-hadi',   'm-hadi',    'org',   NULL,      'admin'),
      ('cap-owner',  'm-owner',   'org',   NULL,      'owner'),
      ('cap-sqadm',  'm-sqadmin', 'squad', 'sq-core', 'admin');
  `)
  return { harness, env }
}

function grant(memberId: string, scope: 'org' | 'squad', scopeId: string | null, capability: CapabilityGrant['capability']): CapabilityGrant {
  return { member_id: memberId, scope_type: scope, scope_id: scopeId, capability } as CapabilityGrant
}

function humanAuth(memberId: string, grants: CapabilityGrant[], role: AuthContext['role'] = 'member'): AuthContext {
  return { userId: memberId, email: null, role, tenant: TENANT, memberId, capabilities: grants }
}

const hadi = (): AuthContext => humanAuth('m-hadi', [grant('m-hadi', 'org', null, 'admin')])
const owner = (): AuthContext => humanAuth('m-owner', [grant('m-owner', 'org', null, 'owner')])

function change(overrides: Partial<AccessChangeInput> = {}): AccessChangeInput {
  return {
    agentRef: 'rava',
    squadId: 'sq-core',
    action: 'set',
    capability: 'lead',
    expectedPrior: 'none',
    reason: '',
    ...overrides,
  }
}

function level(h: SqliteD1Harness, agent: string, memberId: string, squad: string): { cap: string | null; mem: string | null } {
  const c = h.sqlite.prepare(
    "SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?",
  ).get(memberId, squad) as { capability: string } | undefined
  const m = h.sqlite.prepare('SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?')
    .get(agent, squad) as { capability: string } | undefined
  return { cap: c?.capability ?? null, mem: m?.capability ?? null }
}

const rava = (h: SqliteD1Harness, squad = 'sq-core') => level(h, 'rava', 'm-rava', squad)

function receipts(h: SqliteD1Harness): Array<Record<string, unknown>> {
  return h.sqlite.prepare('SELECT * FROM agent_access_receipts ORDER BY created_at, id').all() as Array<Record<string, unknown>>
}

function seedRava(h: SqliteD1Harness, capability: AgentAccessCapability, squad = 'sq-core'): void {
  h.sqlite.exec(`
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-${squad}', 'rava', '${squad}', '${capability}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava-${squad}', 'm-rava', 'squad', '${squad}', '${capability}');
  `)
}

function expectUntouched(h: SqliteD1Harness, before: { cap: string | null; mem: string | null }, squad = 'sq-core'): void {
  expect(rava(h, squad)).toEqual(before)
  expect(receipts(h)).toHaveLength(0)
}

// ── happy paths ───────────────────────────────────────────────────────────────

describe('enroll, change, revoke', () => {
  it.each(['observer', 'member', 'lead', 'admin'] as const)('org admin can enroll an agent at %s', async (cap) => {
    const { harness, env } = makeEnv()
    const result = await applyAgentAccessChange(env, hadi(), change({ capability: cap, reason: 'Hadi asked' }))
    expect(result.ok).toBe(true)
    expect(rava(harness)).toEqual({ cap, mem: cap })
    const rows = receipts(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_member_id: 'm-hadi', agent_id: 'rava', squad_id: 'sq-core',
      prior_capability: null, new_capability: cap, action: 'enroll', reason: 'Hadi asked',
    })
  })

  it('an org owner can do the same', async () => {
    const { harness, env } = makeEnv()
    expect((await applyAgentAccessChange(env, owner(), change({ capability: 'admin' }))).ok).toBe(true)
    expect(rava(harness).cap).toBe('admin')
  })

  it('a legacy-role owner session (no org grant rows) works because the users.role bridge is read live in SQL', async () => {
    const { harness, env } = makeEnv()
    const legacy = humanAuth('m-legacy', [], 'owner')
    expect((await applyAgentAccessChange(env, legacy, change({ capability: 'member' }))).ok).toBe(true)
    expect(rava(harness).cap).toBe('member')
    expect(receipts(harness)[0]).toMatchObject({ actor_member_id: 'm-legacy' })
  })

  it('raising and lowering are both changes with prior and new recorded', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'observer')
    expect((await applyAgentAccessChange(env, hadi(), change({ capability: 'admin', expectedPrior: 'observer' }))).ok).toBe(true)
    expect((await applyAgentAccessChange(env, hadi(), change({ capability: 'member', expectedPrior: 'admin' }))).ok).toBe(true)
    expect(rava(harness)).toEqual({ cap: 'member', mem: 'member' })
    expect(receipts(harness).map((r) => [r.action, r.prior_capability, r.new_capability])).toEqual([
      ['change', 'observer', 'admin'],
      ['change', 'admin', 'member'],
    ])
  })

  it('revoke removes both rows and leaves exactly one revoke receipt', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    const result = await applyAgentAccessChange(env, hadi(), change({ action: 'revoke', capability: '', expectedPrior: 'lead', reason: 'left the team' }))
    expect(result.ok).toBe(true)
    expect(rava(harness)).toEqual({ cap: null, mem: null })
    expect(receipts(harness)).toHaveLength(1)
    expect(receipts(harness)[0]).toMatchObject({ action: 'revoke', prior_capability: 'lead', new_capability: null, reason: 'left the team' })
    // the home squad access is untouched
    expect(rava(harness, 'sq-home')).toEqual({ cap: 'member', mem: 'member' })
  })

  it('is refused when nothing exists to revoke, with no receipt', async () => {
    const { harness, env } = makeEnv()
    const result = await applyAgentAccessChange(env, hadi(), change({ action: 'revoke', expectedPrior: 'none' }))
    expect(result).toMatchObject({ ok: false, error: 'nothing_to_revoke' })
    expect(receipts(harness)).toHaveLength(0)
  })
})

// ── invariants, route layer (asserted by code) ───────────────────────────────

describe('invariants at the route layer', () => {
  it('(3) any agent-bound session is refused, at every level, even with org admin grants', async () => {
    const { harness, env } = makeEnv()
    for (const cap of ['observer', 'member', 'lead', 'admin']) {
      const bound: AuthContext = { ...hadi(), boundAgentId: 'other' }
      expect(await applyAgentAccessChange(env, bound, change({ capability: cap }))).toMatchObject({ ok: false, error: 'agent_session_forbidden', status: 403 })
    }
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('a session with no member id cannot act, even as a legacy-role owner: the change could not be recorded', async () => {
    const { harness, env } = makeEnv()
    const memberless: AuthContext = { userId: 'u-x', email: null, role: 'owner', tenant: TENANT }
    expect(await applyAgentAccessChange(env, memberless, change())).toMatchObject({ ok: false, error: 'actor_member_required', status: 403 })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(1) a squad admin who is not org admin is refused', async () => {
    const { harness, env } = makeEnv()
    const sq = humanAuth('m-sqadmin', [grant('m-sqadmin', 'squad', 'sq-core', 'admin')])
    expect(await applyAgentAccessChange(env, sq, change())).toMatchObject({ ok: false, error: 'org_admin_required' })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(1) cross-squad: a squad admin of sq-core cannot enroll on sq-ops', async () => {
    const { harness, env } = makeEnv()
    const sq = humanAuth('m-sqadmin', [grant('m-sqadmin', 'squad', 'sq-core', 'admin')])
    expect(await applyAgentAccessChange(env, sq, change({ squadId: 'sq-ops' }))).toMatchObject({ ok: false })
    expectUntouched(harness, { cap: null, mem: null }, 'sq-ops')
  })

  it('an org lead or member is refused', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead','m-sqadmin','org',NULL,'lead')")
    const lead = humanAuth('m-sqadmin', [grant('m-sqadmin', 'org', null, 'lead')])
    expect(await applyAgentAccessChange(env, lead, change())).toMatchObject({ ok: false, error: 'org_admin_required' })
  })

  it('(2) owner is never a valid level, and there is no default level', async () => {
    const { harness, env } = makeEnv()
    expect(await applyAgentAccessChange(env, owner(), change({ capability: 'owner' }))).toMatchObject({ ok: false, error: 'invalid_capability', status: 400 })
    expect(await applyAgentAccessChange(env, owner(), change({ capability: '' }))).toMatchObject({ ok: false, error: 'invalid_capability' })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(4) the agent home squad, any other home squad and an archived squad are refused', async () => {
    const { harness, env } = makeEnv()
    for (const squadId of ['sq-home', 'sq-home2']) {
      expect(await applyAgentAccessChange(env, hadi(), change({ squadId }))).toMatchObject({ ok: false, error: 'home_squad_immutable' })
    }
    expect(await applyAgentAccessChange(env, hadi(), change({ squadId: 'sq-old' }))).toMatchObject({ ok: false, error: 'squad_archived' })
    expect(receipts(harness)).toHaveLength(0)
    expect(rava(harness, 'sq-home')).toEqual({ cap: 'member', mem: 'member' })
    expect(rava(harness, 'sq-old')).toEqual({ cap: null, mem: null })
  })

  it('(4) revoking on the home squad or an archived squad is refused too', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'member', 'sq-old')
    expect(await applyAgentAccessChange(env, hadi(), change({ squadId: 'sq-home', action: 'revoke', expectedPrior: 'member' }))).toMatchObject({ ok: false })
    expect(await applyAgentAccessChange(env, hadi(), change({ squadId: 'sq-old', action: 'revoke', expectedPrior: 'member' }))).toMatchObject({ ok: false })
    expect(rava(harness, 'sq-home').cap).toBe('member')
    expect(rava(harness, 'sq-old').cap).toBe('member')
    expect(receipts(harness)).toHaveLength(0)
  })

  it('(5) an agent can never change its own access: the actor is the target agent\'s own member', async () => {
    const { harness, env } = makeEnv()
    const selfActor = humanAuth('m-rava', [grant('m-rava', 'org', null, 'admin')])
    expect(await applyAgentAccessChange(env, selfActor, change({ capability: 'admin' }))).toMatchObject({ ok: false, error: 'self_change_forbidden' })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(5) another agent identity (a bound member with org admin grants) cannot act either', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-other-org','m-other','org',NULL,'admin')")
    const otherAgent = humanAuth('m-other', [grant('m-other', 'org', null, 'admin')])
    expect(await applyAgentAccessChange(env, otherAgent, change())).toMatchObject({ ok: false, error: 'actor_is_agent' })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(6) a change against a level the admin did not see is refused, never silently widened', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'member')
    // the admin's page said "none"; the live row is member
    expect(await applyAgentAccessChange(env, hadi(), change({ capability: 'admin', expectedPrior: 'none' }))).toMatchObject({ ok: false, error: 'stale_state' })
    expect(await applyAgentAccessChange(env, hadi(), change({ capability: 'admin', expectedPrior: 'observer' }))).toMatchObject({ ok: false, error: 'stale_state' })
    expect(rava(harness)).toEqual({ cap: 'member', mem: 'member' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('(6) setting the level already held is refused and leaves no receipt', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    expect(await applyAgentAccessChange(env, hadi(), change({ capability: 'lead', expectedPrior: 'lead' }))).toMatchObject({ ok: false, error: 'unchanged' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('(7) a target holding standing above the actor elsewhere is refused for an org admin', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava-owner','m-rava','squad','sq-ops','owner')")
    expect(await applyAgentAccessChange(env, hadi(), change())).toMatchObject({ ok: false, error: 'target_outranks_actor' })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('owner access on the target squad is never touched, even by an org owner', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec(`
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-o', 'rava', 'sq-core', 'owner');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', 'm-rava', 'squad', 'sq-core', 'owner');
    `)
    expect(await applyAgentAccessChange(env, owner(), change({ expectedPrior: 'owner' }))).toMatchObject({ ok: false, error: 'owner_access_untouchable' })
    // whatever the admin's page claimed, a live owner row is refused as owner access
    expect(await applyAgentAccessChange(env, owner(), change({ expectedPrior: 'none' }))).toMatchObject({ ok: false, error: 'owner_access_untouchable' })
    expect(await applyAgentAccessChange(env, owner(), change({ expectedPrior: 'lead' }))).toMatchObject({ ok: false, error: 'owner_access_untouchable' })
    expect(await applyAgentAccessChange(env, owner(), change({ action: 'revoke', expectedPrior: 'lead' }))).toMatchObject({ ok: false, error: 'owner_access_untouchable' })
    expect(rava(harness)).toEqual({ cap: 'owner', mem: 'owner' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('an unminted agent, an unknown agent and an unknown squad are refused', async () => {
    const { harness, env } = makeEnv()
    expect(await applyAgentAccessChange(env, hadi(), change({ agentRef: 'unminted' }))).toMatchObject({ ok: false, error: 'agent_identity_unminted' })
    expect(await applyAgentAccessChange(env, hadi(), change({ agentRef: 'ghost' }))).toMatchObject({ ok: false, error: 'agent_not_found' })
    expect(await applyAgentAccessChange(env, hadi(), change({ squadId: 'ghost' }))).toMatchObject({ ok: false, error: 'squad_not_found' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('a reason over 500 characters is refused', async () => {
    const { harness, env } = makeEnv()
    expect(await applyAgentAccessChange(env, hadi(), change({ reason: 'x'.repeat(501) }))).toMatchObject({ ok: false, error: 'invalid_reason' })
    expectUntouched(harness, { cap: null, mem: null })
  })
})

// ── the in-batch guard, one leaf at a time (past the route's pre-checks) ─────

function plan(overrides: Partial<ReceiptPlan> = {}): ReceiptPlan {
  return {
    receiptId: crypto.randomUUID(),
    actorMemberId: 'm-hadi',
    agentId: 'rava',
    squadId: 'sq-core',
    agentMemberId: 'm-rava',
    prior: null,
    next: 'lead',
    action: 'enroll',
    reason: null,
    requiredRank: 4,
    ...overrides,
  }
}

/** Runs the real service with ONLY the receipt statement, returning whether the batch threw. */
async function driveSet(env: Env, p: ReceiptPlan, target: { squad?: string; capability?: AgentAccessCapability } = {}): Promise<'committed' | 'threw'> {
  try {
    const out = await commitAgentSquadAccess(
      env,
      { agentId: 'rava', memberId: 'm-rava', squadId: target.squad ?? p.squadId, capability: target.capability ?? p.next ?? 'lead' },
      () => [receiptStatement(env, p)],
    )
    return out.ok ? 'committed' : 'threw'
  } catch {
    return 'threw'
  }
}

async function driveRevoke(env: Env, p: ReceiptPlan): Promise<'committed' | 'threw'> {
  try {
    const out = await commitRemoveAgentSquadAccess(
      env,
      { agentId: 'rava', memberId: 'm-rava', squadId: p.squadId },
      () => [receiptStatement(env, p)],
      { evaluateExtrasWhenAbsent: true },
    )
    return out.ok ? 'committed' : 'threw'
  } catch {
    return 'threw'
  }
}

describe('the guard re-asserted inside the batch', () => {
  it('control: an unmodified plan commits, one receipt, both rows', async () => {
    const { harness, env } = makeEnv()
    expect(await driveSet(env, plan())).toBe('committed')
    expect(rava(harness)).toEqual({ cap: 'lead', mem: 'lead' })
    expect(receipts(harness)).toHaveLength(1)
  })

  it('(1) an inactive actor: the whole batch rolls back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'm-hadi'")
    expect(await driveSet(env, plan())).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(1) an actor whose org-admin rows are gone (stale session): rolled back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'cap-hadi'")
    expect(await driveSet(env, plan())).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(1) an actor who is only a squad admin on the target squad: rolled back', async () => {
    const { harness, env } = makeEnv()
    expect(await driveSet(env, plan({ actorMemberId: 'm-sqadmin' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(1) an actor who is only org lead: rolled back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("UPDATE capabilities SET capability = 'lead' WHERE id = 'cap-hadi'")
    expect(await driveSet(env, plan())).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(4) a home squad, even when the actor holds an exact admin grant on it: rolled back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h2','m-hadi','squad','sq-home2','admin')")
    expect(await driveSet(env, plan({ squadId: 'sq-home2' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null }, 'sq-home2')
  })

  it('(4) an archived squad: rolled back', async () => {
    const { harness, env } = makeEnv()
    expect(await driveSet(env, plan({ squadId: 'sq-old' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null }, 'sq-old')
  })

  it('(5) an actor that is the target\'s own member: rolled back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-self','m-rava','org',NULL,'admin')")
    expect(await driveSet(env, plan({ actorMemberId: 'm-rava' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(5) an actor that is any agent-bound member: rolled back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-oth','m-other','org',NULL,'admin')")
    expect(await driveSet(env, plan({ actorMemberId: 'm-other' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('a plan naming a member that is not the agent\'s welded identity: rolled back', async () => {
    const { harness, env } = makeEnv()
    expect(await driveSet(env, plan({ agentMemberId: 'm-other' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('owner membership row: rolled back even though the capability row matches the expected prior', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec(`
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-o', 'rava', 'sq-core', 'owner');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', 'm-rava', 'squad', 'sq-core', 'admin');
    `)
    expect(await driveSet(env, plan({ prior: 'admin', next: 'member', action: 'change' }))).toBe('threw')
    expect(rava(harness)).toEqual({ cap: 'admin', mem: 'owner' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('(7) target holds owner on a work squad elsewhere (floor of admin): rolled back even for an org owner', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ro','m-rava','squad','sq-ops','owner')")
    expect(await driveSet(env, plan({ actorMemberId: 'm-owner' }))).toBe('threw')
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(7) a home-squad owner grant on the target does not count toward its ceiling', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec("UPDATE capabilities SET capability = 'owner' WHERE id = 'cap-rava-home'")
    expect(await driveSet(env, plan())).toBe('committed')
    expect(rava(harness).cap).toBe('lead')
  })

  it('(6) compare-and-swap: expected none but a row exists: rolled back', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'member')
    expect(await driveSet(env, plan())).toBe('threw')
    expect(rava(harness)).toEqual({ cap: 'member', mem: 'member' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('(6) compare-and-swap: expected a level but the live level differs: rolled back', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'member')
    expect(await driveSet(env, plan({ prior: 'observer', next: 'admin', action: 'change' }))).toBe('threw')
    expect(rava(harness).cap).toBe('member')
    expect(receipts(harness)).toHaveLength(0)
  })

  it('a set to the level already held cannot leave a receipt (table CHECK prior <> new)', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    expect(await driveSet(env, plan({ prior: 'lead', next: 'lead', action: 'change' }))).toBe('threw')
    expect(receipts(harness)).toHaveLength(0)
  })

  it('revoke: a grant that landed after the service read nothing is not deleted without a receipt', async () => {
    const { harness, env } = makeEnv()
    // the plan expects "lead" (what the admin saw) but the rows are gone: rolled back, nothing deleted
    seedRava(harness, 'lead')
    const p = plan({ prior: 'lead', next: null, action: 'revoke' })
    harness.sqlite.exec("DELETE FROM memberships WHERE id = 'ms-sq-core'; DELETE FROM capabilities WHERE id = 'cap-rava-sq-core'")
    // a fresh grant lands at a different level than the admin saw
    seedRava(harness, 'admin')
    expect(await driveRevoke(env, p)).toBe('threw')
    expect(rava(harness)).toEqual({ cap: 'admin', mem: 'admin' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('revoke through the route: a grant that lands between the service read and the batch is not deleted without a receipt', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    let sawServiceRead = false
    const racing = {
      prepare: (sql: string) => {
        // the service's own prior read of the membership row: by then the route's
        // pre-checks have passed. A concurrent revoke removes the rows just before it.
        if (!sawServiceRead && sql.includes('FROM memberships') && sql.includes('LIMIT 1')) {
          sawServiceRead = true
          harness.sqlite.exec("DELETE FROM memberships WHERE id = 'ms-sq-core'; DELETE FROM capabilities WHERE id = 'cap-rava-sq-core'")
        }
        return env.DB.prepare(sql)
      },
      batch: async (statements: Parameters<Env['DB']['batch']>[0]) => {
        // and a fresh grant lands at a level the admin never saw, right before the batch
        seedRava(harness, 'admin')
        return env.DB.batch(statements)
      },
    }
    const raced = { ...env, DB: racing } as unknown as Env
    const result = await applyAgentAccessChange(raced, hadi(), change({ action: 'revoke', expectedPrior: 'lead' }))
    expect(sawServiceRead).toBe(true)
    expect(result.ok).toBe(false)
    expect(rava(harness)).toEqual({ cap: 'admin', mem: 'admin' })
    expect(receipts(harness)).toHaveLength(0)
  })

  it('revoke with rows absent still evaluates the guard (nothing to delete, nothing receipted)', async () => {
    const { harness, env } = makeEnv()
    expect(await driveRevoke(env, plan({ prior: 'lead', next: null, action: 'revoke' }))).toBe('threw')
    expect(receipts(harness)).toHaveLength(0)
  })

  it('revoke control: matching rows are removed with one receipt', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    expect(await driveRevoke(env, plan({ prior: 'lead', next: null, action: 'revoke' }))).toBe('committed')
    expect(rava(harness)).toEqual({ cap: null, mem: null })
    expect(receipts(harness)).toHaveLength(1)
  })
})

// ── receipt integrity ────────────────────────────────────────────────────────

describe('receipts', () => {
  it('(8) if the receipt insert fails for any reason, the access rows are not changed', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec(`
      CREATE TRIGGER test_receipt_fails BEFORE INSERT ON agent_access_receipts
      BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END;
    `)
    const result = await applyAgentAccessChange(env, hadi(), change())
    expect(result).toMatchObject({ ok: false })
    expectUntouched(harness, { cap: null, mem: null })
  })

  it('(8) a failing receipt also blocks a revoke', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'lead')
    harness.sqlite.exec(`
      CREATE TRIGGER test_receipt_fails BEFORE INSERT ON agent_access_receipts
      BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END;
    `)
    const result = await applyAgentAccessChange(env, hadi(), change({ action: 'revoke', expectedPrior: 'lead' }))
    expect(result).toMatchObject({ ok: false })
    expect(rava(harness)).toEqual({ cap: 'lead', mem: 'lead' })
  })

  it('(8) a failure on the access write itself also rolls the receipt back', async () => {
    const { harness, env } = makeEnv()
    harness.sqlite.exec(`
      CREATE TRIGGER test_caps_fail BEFORE INSERT ON capabilities
      WHEN NEW.scope_id = 'sq-core'
      BEGIN SELECT RAISE(ABORT, 'simulated capability failure'); END;
    `)
    const result = await applyAgentAccessChange(env, hadi(), change())
    expect(result).toMatchObject({ ok: false })
    expect(receipts(harness)).toHaveLength(0)
    expect(rava(harness)).toEqual({ cap: null, mem: null })
  })

  it('receipts are append-only: UPDATE and DELETE are refused', async () => {
    const { harness, env } = makeEnv()
    await applyAgentAccessChange(env, hadi(), change())
    expect(() => harness.sqlite.exec("UPDATE agent_access_receipts SET reason = 'edited'")).toThrow(/append-only/)
    expect(() => harness.sqlite.exec('DELETE FROM agent_access_receipts')).toThrow(/append-only/)
    expect(receipts(harness)).toHaveLength(1)
  })

  it('the table refuses owner and a label that disagrees with its capability columns', async () => {
    const { harness } = makeEnv()
    const insert = (prior: string | null, next: string | null, action: string) => () => harness.sqlite.prepare(
      `INSERT INTO agent_access_receipts (id, actor_member_id, agent_id, squad_id, prior_capability, new_capability, action)
       VALUES (?, 'm-hadi', 'rava', 'sq-core', ?, ?, ?)`,
    ).run(crypto.randomUUID(), prior, next, action)
    expect(insert(null, 'owner', 'enroll')).toThrow()
    expect(insert('lead', 'lead', 'change')).toThrow()
    expect(insert('lead', 'admin', 'enroll')).toThrow()
    expect(insert(null, 'lead', 'revoke')).toThrow()
    expect(insert(null, null, 'enroll')).toThrow()
    expect(insert(null, 'lead', 'enroll')).not.toThrow()
  })

  it('concurrent identical changes produce exactly one receipt and one ok', async () => {
    const { harness, env } = makeEnv()
    const results = await Promise.all([1, 2, 3, 4].map(() => applyAgentAccessChange(env, hadi(), change())))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(receipts(harness)).toHaveLength(1)
    expect(rava(harness)).toEqual({ cap: 'lead', mem: 'lead' })
  })

  it('concurrent different levels from the same starting point: one winner, one receipt', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'observer')
    const results = await Promise.all((['member', 'lead', 'admin'] as const).map((capability) =>
      applyAgentAccessChange(env, hadi(), change({ capability, expectedPrior: 'observer' })),
    ))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(receipts(harness)).toHaveLength(1)
    const winner = receipts(harness)[0]
    expect(rava(harness)).toEqual({ cap: winner.new_capability, mem: winner.new_capability })
  })

  it('concurrent revoke and change: rows and receipts agree', async () => {
    const { harness, env } = makeEnv()
    seedRava(harness, 'observer')
    const results = await Promise.all([
      applyAgentAccessChange(env, hadi(), change({ action: 'revoke', expectedPrior: 'observer' })),
      applyAgentAccessChange(env, hadi(), change({ capability: 'admin', expectedPrior: 'observer' })),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(receipts(harness)).toHaveLength(1)
    const only = receipts(harness)[0]
    expect(rava(harness)).toEqual(only.action === 'revoke' ? { cap: null, mem: null } : { cap: only.new_capability, mem: only.new_capability })
  })
})
