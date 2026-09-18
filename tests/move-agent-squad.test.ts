// tests/move-agent-squad.test.ts — move_agent_squad (the re-provision path
// update_agent's comment promised and never built).
//
// agents.squad_id is one FK. update_agent excludes it from every patchable
// list. This tool is the governed move: dual-squad admin, explicit destination
// capability (no carryover), old-squad grant severance, owner_member_id left
// untouched, agent_audit written in the same transaction as the home-row
// UPDATE.
//
// Pattern follows tests/agent-self-update.test.ts: real SQLite, full migration
// chain, tool invoked via `invokeTool` (the production dispatch seam:
// capability floor → schema validation → run()). Rank / cross-squad admin /
// negative cases are pinned by dedicated tests so a mutation of the
// fine-grained checks cannot stay green.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { createAgent } from '../src/org/service'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const ORIGIN = 'https://pot.test'
const TENANT = 'test'
const FROM_SQUAD = 'sq-from'
const TO_SQUAD = 'sq-to'
const OTHER_SQUAD = 'sq-other'
const OPERATOR = 'member-operator'
const AGENT_MEMBER = 'member-agent-moved'
const OWNER_MEMBER = 'member-owner-attestation'

interface AuthOpts {
  boundAgentId?: string | null
  memberId?: string
  capabilities?: CapabilityGrant[]
  role?: AuthContext['role']
}

function auth(opts: AuthOpts = {}): AuthContext {
  return {
    userId: opts.boundAgentId ? `agent:${opts.boundAgentId}` : 'operator-caller',
    email: opts.boundAgentId ? null : 'operator@example.com',
    role: opts.role ?? 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId: opts.memberId ?? OPERATOR,
    capabilities: opts.capabilities ?? [],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

function grant(scopeId: string, capability: CapabilityGrant['capability'], memberId = OPERATOR): CapabilityGrant {
  return { member_id: memberId, scope_type: 'squad', scope_id: scopeId, capability }
}

interface MoveResult {
  agent?: { id: string; squad_id: string }
  from_squad?: { id: string }
  to_squad?: { id: string }
  member_id?: string
  capability?: string
  audit_id?: string
  grant?: { capability: string; scope_id: string }
  grant_impact?: {
    no_longer_applies: Array<{
      kind: 'membership' | 'capability'
      squad_id: string
      capability: string
    }>
    destination_grant: { squad_id: string; capability: string; opt_in: string }
    tasks_reassigned: boolean
    flights_reassigned: boolean
  }
}

describe('move_agent_squad', () => {
  let harness: SqliteD1Harness
  let env: Env
  let events: unknown[]
  let agentId: string

  const invoke = (a: AuthContext, args: Record<string, unknown>) =>
    invokeTool(a, env, 'move_agent_squad', args, ORIGIN)

  async function agentRow(id: string) {
    return env.DB.prepare(
      'SELECT squad_id, owner_member_id, slug FROM agents WHERE id = ?',
    ).bind(id).first<{ squad_id: string; owner_member_id: string | null; slug: string }>()
  }

  async function accessOn(squadId: string) {
    const [membership, capability] = await Promise.all([
      env.DB.prepare(
        'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
      ).bind(agentId, squadId).first<{ capability: string }>(),
      env.DB.prepare(
        `SELECT capability FROM capabilities
          WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
      ).bind(AGENT_MEMBER, squadId).first<{ capability: string }>(),
    ])
    return { membership: membership?.capability ?? null, capability: capability?.capability ?? null }
  }

  async function auditRows() {
    const { results } = await env.DB.prepare(
      `SELECT actor_id, actor_type, action, fields_changed, before_state, after_state
         FROM agent_audit WHERE agent_id = ? ORDER BY seq ASC`,
    ).bind(agentId).all<{
      actor_id: string
      actor_type: string
      action: string
      fields_changed: string
      before_state: string
      after_state: string
    }>()
    return results
  }

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('${FROM_SQUAD}', 'dept-1', 'from', 'From Squad'),
        ('${TO_SQUAD}', 'dept-1', 'to', 'To Squad'),
        ('${OTHER_SQUAD}', 'dept-1', 'other', 'Other Squad');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
      INSERT INTO members (id, display_name, status, tenant) VALUES
        ('${OPERATOR}', 'Operator', 'active', '${TENANT}'),
        ('${AGENT_MEMBER}', 'Moved Agent Member', 'active', '${TENANT}'),
        ('${OWNER_MEMBER}', 'Attestation Owner', 'active', '${TENANT}');
    `)
    events = []
    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      BUS: { send: async (event: unknown) => { events.push(event) } },
    } as unknown as Env

    const created = await createAgent(env, FROM_SQUAD, {
      slug: 'moved-agent',
      name: 'Moved Agent',
      role: 'member',
      model: 'gpt-5.6-terra',
    })
    if (!created.ok) throw new Error(`fixture create failed: ${created.error}`)
    agentId = created.value.id

    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${agentId}', '${AGENT_MEMBER}', '2026-09-18T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-agent-home', '${AGENT_MEMBER}', 'squad', '${FROM_SQUAD}', 'member');
      UPDATE agents SET owner_member_id = '${OWNER_MEMBER}' WHERE id = '${agentId}';
    `)
  })

  afterEach(() => harness.close())

  const bothAdmin: CapabilityGrant[] = [
    grant(FROM_SQUAD, 'admin'),
    grant(TO_SQUAD, 'admin'),
  ]

  it('happy path: moves home, writes dest grant, severs old-squad access, audits, leaves owner_member_id', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'lead',
      reason: 'fold personal-tool bucket into project squad',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as MoveResult
    expect(output.agent).toEqual({ id: agentId, squad_id: TO_SQUAD })
    expect(output.from_squad).toEqual({ id: FROM_SQUAD })
    expect(output.to_squad).toEqual({ id: TO_SQUAD })
    expect(output.capability).toBe('lead')
    expect(output.member_id).toBe(AGENT_MEMBER)
    expect(output.audit_id).toEqual(expect.any(String))

    const row = await agentRow(agentId)
    expect(row?.squad_id).toBe(TO_SQUAD)
    expect(row?.owner_member_id).toBe(OWNER_MEMBER)

    expect(await accessOn(FROM_SQUAD)).toEqual({ membership: null, capability: null })
    expect(await accessOn(TO_SQUAD)).toEqual({ membership: 'lead', capability: 'lead' })

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(OPERATOR)
    expect(rows[0].actor_type).toBe('user')
    expect(rows[0].action).toBe('move_agent_squad')
    const fields = JSON.parse(rows[0].fields_changed) as {
      squad_id: { from: string; to: string }
      capability: string
      reason: string | null
    }
    expect(fields).toEqual({
      squad_id: { from: FROM_SQUAD, to: TO_SQUAD },
      capability: 'lead',
      reason: 'fold personal-tool bucket into project squad',
    })
    const before = JSON.parse(rows[0].before_state) as { squad_id: string; owner_member_id: string | null }
    const after = JSON.parse(rows[0].after_state) as { squad_id: string; owner_member_id: string | null }
    expect(before.squad_id).toBe(FROM_SQUAD)
    expect(after.squad_id).toBe(TO_SQUAD)
    expect(before.owner_member_id).toBe(OWNER_MEMBER)
    expect(after.owner_member_id).toBe(OWNER_MEMBER)

    expect(events).toHaveLength(1)
    const payload = (events[0] as { payload: { kind: string; reason?: string } }).payload
    expect(payload.kind).toBe('agent_moved')
    expect(payload.reason).toBe('fold personal-tool bucket into project squad')
  })

  it('accepts agent and to_squad by slug', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: 'moved-agent',
      to_squad: 'to',
      capability: 'member',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as MoveResult).agent?.squad_id).toBe(TO_SQUAD)
  })

  it('org-wide admin grant satisfies both squad checks (inheritance, no per-squad rows)', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await invoke(auth({ capabilities: orgAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'observer',
    })
    expect(result.ok).toBe(true)
  })

  it('403 admin-on-old-only: admin on to_squad, nothing on the current home', async () => {
    const toOnly: CapabilityGrant[] = [grant(TO_SQUAD, 'admin')]
    const before = await agentRow(agentId)
    const result = await invoke(auth({ capabilities: toOnly }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', scope: 'squad', side: 'from' })
    expect(await agentRow(agentId)).toEqual(before)
    expect(events).toHaveLength(0)
  })

  it('403 admin-on-new-only: admin on current home, only lead on destination, capability within that lead rank', async () => {
    // Clears the grant-height ceiling (member <= lead) so this IS the
    // admin-on-to gate, not cannot_grant_above_own_rank. Mutation of the
    // destination admin check to 'lead' turns this green.
    const fromAdminToLead: CapabilityGrant[] = [
      grant(FROM_SQUAD, 'admin'),
      grant(TO_SQUAD, 'lead'),
    ]
    const result = await invoke(auth({ capabilities: fromAdminToLead }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', scope: 'squad', side: 'to' })
    expect((await agentRow(agentId))?.squad_id).toBe(FROM_SQUAD)
  })

  it('403 rank-ceiling exceeded on destination: admin on old, lead on new, requesting admin', async () => {
    // Distinct from admin-on-new-only: the grant-height check runs FIRST, so
    // requesting above the actor's rank on to_squad is cannot_grant_above_
    // own_rank (the /members/:id/capabilities predicate), not forbidden/side:to.
    // Mutation of capabilityRank(capability) > actorRank to >=, or deleting
    // the check, turns this into the admin-on-to 403 and this test goes red.
    const fromAdminToLead: CapabilityGrant[] = [
      grant(FROM_SQUAD, 'admin'),
      grant(TO_SQUAD, 'lead'),
    ]
    const result = await invoke(auth({ capabilities: fromAdminToLead }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'admin',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('cannot_grant_above_own_rank')
    expect(result.detail).toEqual({ capability: 'admin', scope: 'squad', side: 'to' })
    expect((await agentRow(agentId))?.squad_id).toBe(FROM_SQUAD)
    expect(await accessOn(FROM_SQUAD)).toEqual({ membership: 'member', capability: 'member' })
  })

  it('old-squad grants are actually cleared, not just a new grant added — and a third-squad guest grant survives', async () => {
    harness.sqlite.exec(`
      INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('mem-guest', '${agentId}', '${OTHER_SQUAD}', 'observer');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-guest', '${AGENT_MEMBER}', 'squad', '${OTHER_SQUAD}', 'observer');
    `)

    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'admin',
    })
    expect(result.ok).toBe(true)

    expect(await accessOn(FROM_SQUAD)).toEqual({ membership: null, capability: null })
    expect(await accessOn(TO_SQUAD)).toEqual({ membership: 'admin', capability: 'admin' })
    expect(await accessOn(OTHER_SQUAD)).toEqual({ membership: 'observer', capability: 'observer' })
  })

  it('owner_member_id survives unchanged (the 0155 human-attestation binding is not a move field)', async () => {
    const before = await agentRow(agentId)
    expect(before?.owner_member_id).toBe(OWNER_MEMBER)

    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(true)

    const after = await agentRow(agentId)
    expect(after?.owner_member_id).toBe(OWNER_MEMBER)
    expect(after?.owner_member_id).toBe(before?.owner_member_id)
  })

  it('audit record is correct: action, actor, old/new squad, capability, reason, snapshots', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: 'moved-agent',
      to_squad: 'to',
      capability: 'observer',
      reason: 'close sprawl',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('move_agent_squad')
    expect(rows[0].actor_type).toBe('user')
    expect(rows[0].actor_id).toBe(OPERATOR)
    const fields = JSON.parse(rows[0].fields_changed) as {
      squad_id: { from: string; to: string }
      capability: string
      reason: string | null
    }
    expect(fields.squad_id.from).toBe(FROM_SQUAD)
    expect(fields.squad_id.to).toBe(TO_SQUAD)
    expect(fields.capability).toBe('observer')
    expect(fields.reason).toBe('close sprawl')
    expect(JSON.parse(rows[0].before_state)).toEqual(expect.objectContaining({
      squad_id: FROM_SQUAD,
      owner_member_id: OWNER_MEMBER,
      slug: 'moved-agent',
    }))
    expect(JSON.parse(rows[0].after_state)).toEqual(expect.objectContaining({
      squad_id: TO_SQUAD,
      owner_member_id: OWNER_MEMBER,
      slug: 'moved-agent',
    }))
    expect((result.result as MoveResult).audit_id).toBeTruthy()
  })

  it('same_squad is 400, not a silent no-op — this tool is a move, not a grant update', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: FROM_SQUAD,
      capability: 'admin',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('same_squad')
    expect(await accessOn(FROM_SQUAD)).toEqual({ membership: 'member', capability: 'member' })
    expect(await auditRows()).toHaveLength(0)
  })

  it('bound-agent caller is operator_principal_required even with org admin (no self-lane)', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: AGENT_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await invoke(
      auth({ boundAgentId: agentId, memberId: AGENT_MEMBER, capabilities: orgAdmin }),
      { agent: agentId, to_squad: TO_SQUAD, capability: 'member' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('operator_principal_required')
    expect((await agentRow(agentId))?.squad_id).toBe(FROM_SQUAD)
  })

  it('unminted agent is 409 before any write', async () => {
    harness.sqlite.exec(`DELETE FROM agent_member_bindings WHERE agent_id = '${agentId}'`)
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('agent_identity_unminted')
    expect((await agentRow(agentId))?.squad_id).toBe(FROM_SQUAD)
    expect(await auditRows()).toHaveLength(0)
  })

  it('missing capability is 400 at the schema seam (required, no carryover)', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect((await agentRow(agentId))?.squad_id).toBe(FROM_SQUAD)
  })

  it('invalid capability is 400 invalid_capability', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'owner',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error).toBe('invalid_capability')
  })

  it('admin on a third squad only is refused (clears the AAGATE floor, fails from-side admin)', async () => {
    const elsewhere: CapabilityGrant[] = [grant(OTHER_SQUAD, 'admin')]
    const result = await invoke(auth({ capabilities: elsewhere }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.detail).toEqual({ need: 'admin', scope: 'squad', side: 'from' })
  })

  it('AAGATE floor: a caller with no admin anywhere never reaches run() (403 need=admin)', async () => {
    const leadOnly: CapabilityGrant[] = [grant(FROM_SQUAD, 'lead')]
    const result = await invoke(auth({ capabilities: leadOnly }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin' })
  })

  it('Athena HARD-BLOCK 2: tenant wall — token tenant must match this pot, not the request', async () => {
    const before = await agentRow(agentId)
    const result = await invoke(
      { ...auth({ capabilities: bothAdmin }), tenant: 'other-pot' },
      { agent: agentId, to_squad: TO_SQUAD, capability: 'member' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ reason: 'tenant_scope' })
    expect(await agentRow(agentId)).toEqual(before)
    expect(await auditRows()).toHaveLength(0)
  })

  it('Athena HARD-BLOCK 3: response lists grant_impact; dest grant is the capability opt-in; tasks/flights are not reassigned', async () => {
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'observer',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const impact = (result.result as MoveResult).grant_impact
    expect(impact).toBeDefined()
    expect(impact?.no_longer_applies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'capability', squad_id: FROM_SQUAD, capability: 'member' }),
      ]),
    )
    expect(impact?.destination_grant).toEqual({
      squad_id: TO_SQUAD,
      capability: 'observer',
      opt_in: 'capability',
    })
    expect(impact?.tasks_reassigned).toBe(false)
    expect(impact?.flights_reassigned).toBe(false)
    // dest grant is exactly the opt-in, not a carryover of old home 'member'
    expect(await accessOn(TO_SQUAD)).toEqual({ membership: 'observer', capability: 'observer' })
  })

  it('Athena HARD-BLOCK 3 bonus: a revoked dest-squad grant is not resurrected — dest is only the explicit capability', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-dest-revoked', '${AGENT_MEMBER}', 'squad', '${TO_SQUAD}', 'admin');
    `)
    harness.sqlite.exec(`DELETE FROM capabilities WHERE id = 'cap-dest-revoked'`)

    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'observer',
    })
    expect(result.ok).toBe(true)
    expect(await accessOn(TO_SQUAD)).toEqual({ membership: 'observer', capability: 'observer' })
  })

  it('Athena HARD-BLOCK 4: refuse move when the agent has a status=review task gating itself', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner)
        VALUES (
          'task-self-gate',
          '${FROM_SQUAD}',
          'Needs verdict',
          '',
          'verdict lands',
          'review',
          '${agentId}',
          'gate:agent-self-completion'
        );
    `)
    const before = await agentRow(agentId)
    const result = await invoke(auth({ capabilities: bothAdmin }), {
      agent: agentId,
      to_squad: TO_SQUAD,
      capability: 'member',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('gate_owner_dodge')
    expect(result.detail).toEqual(expect.objectContaining({
      task_id: 'task-self-gate',
      gate_owner: 'gate:agent-self-completion',
    }))
    expect(await agentRow(agentId)).toEqual(before)
    expect(await auditRows()).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})
