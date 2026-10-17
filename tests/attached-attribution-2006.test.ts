// tests/attached-attribution-2006.test.ts — mupot#2006. A thread attached to an existing agent X acts AS X by design;
// the writes it makes (send, task_submit_result, flight_land) must record the attachment + the attaching human, and that
// human must count as AFFILIATED with X for verdict independence (verdict predicate AND the runtime-gate check).
// Real sqlite D1 + every migration; entered through invokeTool.

import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { evaluateVerdictGates } from '../src/tasks'
import { landGovernedFlight } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { findVerdictIndependenceConflict, isMemberAffiliatedWithAssigneeAgent } from '../src/tasks/verdict-independence'
import { hasIndependentRuntimeGate } from '../src/tasks/runtime-receipts'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const SQUAD = 'squad-1'
const X = 'agent-x' // the attached-to agent (task assignee)
const PEER = 'agent-peer'
const GATE_AGENT = 'agent-gate'
const X_MEMBER = 'member-x'
const H = 'member-h' // the attaching human: squad admin, NOT X's owner
const INDEP = 'member-indep' // a genuinely independent human
const OWNER = 'member-owner'
const TASK = 'task-1'
const T0 = '2026-10-01T00:00:00.000Z'
const SHA = '46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88'
const RESULT = `done\nArtifact: /tmp/m.txt\nSHA256: ${SHA}`
const ATT = 'attachment-1'

function fresh(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const { sqlite } = harness
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${X_MEMBER}', 'X', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${H}', 'H', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${INDEP}', 'Indep', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OWNER}', 'Owner', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES ('${X}', '${SQUAD}', 'x', 'X', 'active', '${OWNER}');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${PEER}', '${SQUAD}', 'peer', 'Peer', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${GATE_AGENT}', '${SQUAD}', 'gate', 'Gate', 'active');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-x', '${X_MEMBER}', 'squad', '${SQUAD}', 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-h', '${H}', 'squad', '${SQUAD}', 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-i', '${INDEP}', 'squad', '${SQUAD}', 'member');
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner, assignee_agent_id)
      VALUES ('${TASK}', '${SQUAD}', 't', 'b', 'in_progress', 'p', 'gate:reviewer', '${X}');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-h', 'gate:reviewer', 'member', '${H}', '${OWNER}', '${T0}');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-i', 'gate:other', 'member', '${INDEP}', '${OWNER}', '${T0}');
  `)
  return { harness, env: { TENANT_SLUG: TENANT, DB: harness.db } as Env }
}

/** agent_seat_* rows reference seats/harnesses we do not need; FKs off for this fixture write only. */
function seedAttachment(sqlite: SqliteD1Harness['sqlite'], opts: { admissionStatus?: string; withAttachment?: boolean } = {}): void {
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, ceiling, requested_via, created_at)
      VALUES ('adm-1', '${TENANT}', '${X}', '${H}', 'h-1', '${opts.admissionStatus ?? 'revoked'}', 'member', 'tool', '${T0}');
  `)
  if (opts.withAttachment) {
    sqlite.exec(`
      INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at, detached_at, detach_reason)
        VALUES ('${ATT}', '${TENANT}', 'seat-1', '${H}', 'h-1', '${X}', 'adm-1', 'tok-1', '${T0}', '${T0}', 'human');
    `)
  }
  sqlite.exec('PRAGMA foreign_keys = ON')
}

function attachedAuth(): AuthContext {
  return {
    userId: X_MEMBER, memberId: X_MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'directory',
    boundAgentId: X, consentedByMemberId: H,
    capabilities: [{ member_id: X_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
    seatBinding: {
      seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: H, source: 'handle',
      attached: { attachmentId: ATT, admissionId: 'adm-1', agentId: X, seatAgentId: 'seat-agent', ceiling: 'member' },
    },
  }
}

function plainAuth(): AuthContext {
  const { seatBinding: _s, consentedByMemberId: _c, ...rest } = attachedAuth()
  void _s; void _c
  return rest
}

function seedIndependentAgentGate(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-gate', 'G', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-g', 'member-gate', 'squad', '${SQUAD}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${GATE_AGENT}', 'member-gate', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
      VALUES ('tok-gate', 'member-gate', 'hash-g', 'gate', 'workspace', '${T0}', NULL, '${GATE_AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-agent', 'gate:agent-reviewer', 'agent', '${GATE_AGENT}', '${OWNER}', '${T0}');
    UPDATE tasks SET gate_owner = 'gate:agent-reviewer' WHERE id = '${TASK}';
  `)
}

type Row = { attachment_id: string | null; consenting_member_id: string | null }

describe('independence: the attaching human is affiliated with the attached agent', () => {
  it('issue scenario: H attached a chat to X (not owner), submitted via it, then holds the gate -> refused (direct party)', async () => {
    const { harness, env } = fresh()
    seedIndependentAgentGate(harness.sqlite)
    expect(await findVerdictIndependenceConflict(env, H, TASK)).toBeNull() // baseline: nothing links H to X yet
    const sub = await invokeTool(attachedAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    expect(sub.ok, JSON.stringify(sub)).toBe(true)
    // no attachment/admission rows exist here: ONLY the submission row's consenting_member_id can make H affiliated
    expect(await findVerdictIndependenceConflict(env, H, TASK)).toBe('direct')
    expect(await findVerdictIndependenceConflict(env, INDEP, TASK)).toBeNull()
  })

  it('a member-held gate whose holder attached to X is not an independent gate (runtime-gate check)', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { withAttachment: true })
    expect(await isMemberAffiliatedWithAssigneeAgent(env, H, X)).toBe(true)
    expect(await hasIndependentRuntimeGate(env, 'gate:reviewer', X, SQUAD, { allowMemberHolders: true })).toBe(false)
    // submit through the tool is refused up front for the same reason
    const sub = await invokeTool(attachedAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    expect(sub).toMatchObject({ ok: false, error: 'independent_gate_required' })
  })

  it('pre-column defense: a past (revoked) admission alone, with no submission attribution, still makes H affiliated', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { admissionStatus: 'revoked' })
    harness.sqlite.exec(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
      VALUES ('s-old', '${TENANT}', '${TASK}', '${SQUAD}', '${X}', '/tmp/m.txt', '${SHA}', '${SHA}', 'r')`)
    expect(await findVerdictIndependenceConflict(env, H, TASK)).toBe('affiliated')
  })

  it('an attachment row alone (admission not live/revoked/expired) still makes H affiliated', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { admissionStatus: 'pending', withAttachment: true })
    expect(await isMemberAffiliatedWithAssigneeAgent(env, H, X)).toBe(true)
  })

  it('an expired admission (a pending one that lapsed: never approved) does not count', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { admissionStatus: 'expired' })
    expect(await isMemberAffiliatedWithAssigneeAgent(env, H, X)).toBe(false)
  })

  it('injected-thread scenario: a lapsed admission request cannot taint H; H stays an independent gate and X can still submit', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { admissionStatus: 'expired' })
    expect(await hasIndependentRuntimeGate(env, 'gate:reviewer', X, SQUAD, { allowMemberHolders: true })).toBe(true)
    const sub = await invokeTool(plainAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    expect(sub.ok, JSON.stringify(sub)).toBe(true)
    expect(await findVerdictIndependenceConflict(env, H, TASK)).toBeNull()
  })

  it('a pending admission never attached anything and does not count', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { admissionStatus: 'pending' })
    expect(await isMemberAffiliatedWithAssigneeAgent(env, H, X)).toBe(false)
  })

  it('a genuinely independent member still passes; existing owner affiliation intact', async () => {
    const { harness, env } = fresh()
    seedAttachment(harness.sqlite, { withAttachment: true })
    expect(await isMemberAffiliatedWithAssigneeAgent(env, INDEP, X)).toBe(false)
    expect(await isMemberAffiliatedWithAssigneeAgent(env, OWNER, X)).toBe(true)
    harness.sqlite.exec(`UPDATE tasks SET gate_owner = 'gate:other' WHERE id = '${TASK}'`)
    expect(await hasIndependentRuntimeGate(env, 'gate:other', X, SQUAD, { allowMemberHolders: true })).toBe(true)
    expect(await findVerdictIndependenceConflict(env, INDEP, TASK)).toBeNull()
  })
})

function memberAuthRole(memberId: string, role: AuthContext['role']): AuthContext {
  return {
    userId: memberId, memberId, email: null, role, tenant: TENANT, channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
  }
}

describe('consenting human is a DIRECT party of the submission', () => {
  function submitted() {
    const f = fresh()
    seedIndependentAgentGate(f.harness.sqlite)
    f.harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-h2', 'gate:agent-reviewer', 'member', '${H}', '${OWNER}', '${T0}')`)
    return f
  }

  it('H (consenting) is direct, not affiliated; an org admin H gets self_verdict, not the admin_supervisory waiver', async () => {
    const { harness, env } = submitted()
    const sub = await invokeTool(attachedAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    expect(sub.ok, JSON.stringify(sub)).toBe(true)
    expect(await findVerdictIndependenceConflict(env, H, TASK)).toBe('direct')
    const task = { id: TASK, squad_id: SQUAD, gate_owner: 'gate:agent-reviewer', assignee_agent_id: X }
    expect(await evaluateVerdictGates(env, memberAuthRole(H, 'admin'), task, 'approved'))
      .toMatchObject({ allowed: false, code: 'self_verdict' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get()).toEqual({ n: 0 })
  })

  it('an agent decider owned by / bound to / keyed to the consenting human conflicts; an unrelated agent does not', async () => {
    const { harness, env } = submitted()
    await invokeTool(attachedAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    harness.sqlite.exec(`UPDATE agents SET owner_member_id = '${H}' WHERE id = '${PEER}'`)
    expect(await findVerdictIndependenceConflict(env, PEER, TASK)).toBe('direct')
    harness.sqlite.exec(`UPDATE agents SET owner_member_id = NULL WHERE id = '${PEER}';
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${PEER}', '${H}', '${T0}')`)
    expect(await findVerdictIndependenceConflict(env, PEER, TASK)).toBe('direct')
    harness.sqlite.exec(`DELETE FROM agent_member_bindings WHERE agent_id = '${PEER}'`)
    expect(await findVerdictIndependenceConflict(env, PEER, TASK)).toBeNull()
  })
})

describe('attribution columns', () => {
  it('broadcast: attached caller stamps every delivery; non-attached stays NULL', async () => {
    const { harness, env } = fresh()
    const a = await invokeTool(attachedAuth(), env, 'broadcast', { squad_id: SQUAD, body: 'hello all' }, 'https://pot.test')
    expect(a.ok, JSON.stringify(a)).toBe(true)
    const p = await invokeTool(plainAuth(), env, 'broadcast', { squad_id: SQUAD, body: 'plain' }, 'https://pot.test')
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const rows = harness.sqlite.prepare('SELECT body, attachment_id, consenting_member_id FROM agent_messages ORDER BY seq').all() as Array<Row & { body: string }>
    expect(rows.filter((r) => r.body === 'hello all').length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.attachment_id).toBe(r.body === 'hello all' ? ATT : null)
      expect(r.consenting_member_id).toBe(r.body === 'hello all' ? H : null)
    }
  })

  it('task_submit_result: attached caller stamps attachment + consenting human', async () => {
    const { harness, env } = fresh()
    seedIndependentAgentGate(harness.sqlite)
    const res = await invokeTool(attachedAuth(), env, 'task_submit_result', {
      task_id: TASK, result: RESULT,
    }, 'https://pot.test')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const row = harness.sqlite.prepare('SELECT attachment_id, consenting_member_id FROM task_result_submissions WHERE task_id = ?').get(TASK) as Row
    expect(row).toEqual({ attachment_id: ATT, consenting_member_id: H })
  })

  it('task_submit_result: a non-attached caller writes NULL; the columns are not accepted as args', async () => {
    const { harness, env } = fresh()
    seedIndependentAgentGate(harness.sqlite)
    const forged = await invokeTool(plainAuth(), env, 'task_submit_result', {
      task_id: TASK, result: RESULT, attachment_id: 'forged', consenting_member_id: H,
    }, 'https://pot.test')
    expect(forged).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_result_submissions').get()).toEqual({ n: 0 })
    const res = await invokeTool(plainAuth(), env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const row = harness.sqlite.prepare('SELECT attachment_id, consenting_member_id FROM task_result_submissions WHERE task_id = ?').get(TASK) as Row
    expect(row).toEqual({ attachment_id: null, consenting_member_id: null })
  })

  it('send: attached caller stamps the row; non-attached stays NULL; the columns are not accepted as args', async () => {
    const { harness, env } = fresh()
    const forged = await invokeTool(attachedAuth(), env, 'send', { to: PEER, body: 'x', attachment_id: 'forged', consenting_member_id: 'forged' }, 'https://pot.test')
    expect(forged).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    const a = await invokeTool(attachedAuth(), env, 'send', { to: PEER, body: 'hi' }, 'https://pot.test')
    expect(a.ok, JSON.stringify(a)).toBe(true)
    const p = await invokeTool(plainAuth(), env, 'send', { to: PEER, body: 'yo' }, 'https://pot.test')
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const rows = harness.sqlite.prepare('SELECT body, attachment_id, consenting_member_id FROM agent_messages ORDER BY seq').all() as Array<Row & { body: string }>
    expect(rows).toEqual([
      { body: 'hi', attachment_id: ATT, consenting_member_id: H },
      { body: 'yo', attachment_id: null, consenting_member_id: null },
    ])
  })

  function flightFixture() {
    const { harness, env } = fresh()
    const meta = parseFlightMetaV1({
      schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: ['t-done'],
      done_when: ['d'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
    })
    if (!meta) throw new Error('fixture meta')
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, status) VALUES ('t-done', '${SQUAD}', 't', 'done')`)
    harness.sqlite.prepare(
      `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, cost_micro_usd, meta, created_at, started_at)
       VALUES ('f-1', ?, ?, 'g', 'running', 100000, 0, ?, ?, ?)`,
    ).run(TENANT, X, JSON.stringify(meta), Date.now(), Date.now())
    return { harness, env, meta }
  }
  const outbox = (h: SqliteD1Harness) =>
    h.sqlite.prepare(`SELECT attachment_id, consenting_member_id FROM flight_event_outbox WHERE flight_id = 'f-1'`).get() as Row

  it('flight_land: attached caller stamps the landing receipt; the columns are not accepted as args', async () => {
    const { harness, env } = flightFixture()
    const forged = await invokeTool(attachedAuth(), env, 'flight_land', { flight_id: 'f-1', cost_micro_usd: 0, attachment_id: 'forged', consenting_member_id: 'forged' }, 'https://pot.test')
    expect(forged).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    const res = await invokeTool(attachedAuth(), env, 'flight_land', { flight_id: 'f-1', cost_micro_usd: 0 }, 'https://pot.test')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(outbox(harness)).toEqual({ attachment_id: ATT, consenting_member_id: H })
  })

  it('flight_land: a non-attached caller writes NULL', async () => {
    const { harness, env } = flightFixture()
    const res = await invokeTool(plainAuth(), env, 'flight_land', { flight_id: 'f-1', cost_micro_usd: 0 }, 'https://pot.test')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(outbox(harness)).toEqual({ attachment_id: null, consenting_member_id: null })
  })

  it('landGovernedFlight service: attribution omitted -> NULL; supplied -> stored', async () => {
    const a = flightFixture()
    await landGovernedFlight(a.env, 'f-1', { cost_micro_usd: 1, agent_id: X, meta: a.meta, actor: { kind: 'agent', id: X } })
    expect(outbox(a.harness)).toEqual({ attachment_id: null, consenting_member_id: null })
    const b = flightFixture()
    await landGovernedFlight(b.env, 'f-1', { cost_micro_usd: 1, agent_id: X, meta: b.meta, actor: { kind: 'agent', id: X }, attribution: { attachmentId: ATT, consentingMemberId: H } })
    expect(outbox(b.harness)).toEqual({ attachment_id: ATT, consenting_member_id: H })
  })
})
