// tests/gardener-preview.test.ts — read-only gardener_preview (first slice of mupot#1544).
// Real SQLite + full migration chain; every call enters through invokeTool (check-mcp-tool-seam).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { PUBLIC_TOOL_ALLOWLIST } from '../src/mcp/openapi-public-allowlist'
import { interceptDb, sqlGet, sqlRun } from './helpers/db-intercept'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const AS_OF = '2026-10-25T12:00:00.000Z'
const NOW = Date.parse(AS_OF)
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString()

function caller(capabilities: CapabilityGrant[], memberId = 'mem-caller'): AuthContext {
  return {
    userId: 'caller', email: 'c@example.com', role: 'member', tenant: TENANT, channel: 'workspace',
    memberId, capabilities, boundAgentId: null,
  } as AuthContext
}
const SQUAD_READER = caller([{ member_id: 'mem-caller', scope_type: 'squad', scope_id: 'sq-1', capability: 'member' }])
const SQUAD_LEAD = caller([{ member_id: 'mem-lead', scope_type: 'squad', scope_id: 'sq-1', capability: 'lead' }], 'mem-lead')
const OTHER_SQUAD_ONLY = caller([{ member_id: 'mem-caller', scope_type: 'squad', scope_id: 'sq-2', capability: 'member' }])

describe('gardener_preview (read-only)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const seen: string[] = []

  const call = (a: AuthContext, args: Record<string, unknown>) =>
    invokeTool(a, env, 'gardener_preview', { as_of: AS_OF, ...args }, ORIGIN)

  function seedAgent(id: string, extra = ''): void {
    sqlRun(harness, `INSERT INTO agents (id, squad_id, slug, name, status, created_at ${extra ? ',' + extra.split('=')[0] : ''}) VALUES (?, 'sq-1', ?, ?, 'active', '2026-01-01 00:00:00' ${extra ? ', ' + extra.split('=')[1] : ''})`, id, id, id)
  }
  function seedTask(id: string, agent: string | null, status: string, updatedDaysAgo: number, extra: Record<string, unknown> = {}): void {
    const ts = ago(updatedDaysAgo)
    sqlRun(harness, `INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, created_at, updated_at, parent_task_id, gate_owner, execution_claim_expires_at, review_entered_at) VALUES (?, 'sq-1', ?, ?, 'n/a', ?, ?, ?, ?, ?, ?, ?)`,
      id, id, status, agent, ts, ts, (extra.parent as string) ?? null, (extra.gate_owner as string) ?? null, (extra.claim as number) ?? null, (extra.review_entered_at as string) ?? null)
  }
  function seedSubmission(id: string, agent: string, daysAgo: number): void {
    sqlRun(harness, `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, created_at) VALUES (?, ?, 'x', 'sq-1', ?, 'a.md', ?, ?, ?)`,
      id, TENANT, agent, 'a'.repeat(64), 'b'.repeat(64), ago(daysAgo))
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seen.length = 0
    env = { TENANT_SLUG: TENANT, DB: interceptDb(harness.db, /./, 'observe', seen) } as unknown as Env
    sqlRun(harness, `INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-caller', ?, 'c@example.com', 'Caller', 'active')`, TENANT)
    sqlRun(harness, `INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-hadi', ?, 'h@example.com', 'Hadi', 'active')`, TENANT)
    sqlRun(harness, `INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-lead', ?, 'l@example.com', 'Lead', 'active')`, TENANT)
    sqlRun(harness, `INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept')`)
    sqlRun(harness, `INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'one-sqd', 'One'), ('sq-2', 'dept-1', 'two-sqd', 'Two')`)

    sqlRun(harness, `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead', 'mem-lead', 'squad', 'sq-1', 'lead')`)
    sqlRun(harness, `INSERT INTO projects (id, slug, name) VALUES ('proj-1', 'p1', 'P1'), ('proj-2', 'p2', 'P2')`)
    sqlRun(harness, `INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-1', 'sq-1'), ('proj-2', 'sq-2')`)
    // Active agent: submitted 2 days ago, two fresh open tasks, metered spend yesterday.
    seedAgent('ag-active'); seedSubmission('sub-active', 'ag-active', 2)
    seedTask('t-a1', 'ag-active', 'in_progress', 1); seedTask('t-a2', 'ag-active', 'open', 1)
    sqlRun(harness, `INSERT INTO execution_meter (id, window_key, count, tokens, window_start, cost_micro_usd) VALUES ('m1', ?, 3, 900, ?, 1500)`,
      `${TENANT}:ag-active:${ago(1).slice(0, 10)}`, ago(1))
    // Idle agent: one verdict 20 days ago, nothing since, no assignments.
    seedAgent('ag-idle')
    // Stale-backlog agent: no output ever, two assignments untouched for 60 days.
    seedAgent('ag-stale'); seedTask('t-s1', 'ag-stale', 'open', 60); seedTask('t-s2', 'ag-stale', 'in_progress', 61)
    // Feed agent: submitted 3 days ago, empty queue.
    seedAgent('ag-feed'); seedSubmission('sub-feed', 'ag-feed', 3)
    // Waiting agent: a flight waiting for 5 days.
    seedAgent('ag-wait')
    sqlRun(harness, `INSERT INTO flights (id, tenant, project_id, agent, goal, status, waiting_since) VALUES ('fl-wait', ?, 'proj-1', 'ag-wait', 'g', 'waiting', ?)`, TENANT, NOW - 5 * 86_400_000)
    // Dormant, nothing holding it: eligible agent archive candidate.
    seedAgent('ag-dormant')
    // Dormant but exempt, one reason each.
    seedAgent('ag-gate'); sqlRun(harness, `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:hadi', 'agent', 'ag-gate', 'mem-hadi', ?)`, ago(90))
    seedAgent('ag-designated'); sqlRun(harness, `UPDATE agents SET attach_designated_member_id = 'mem-hadi' WHERE id = 'ag-designated'`)
    seedAgent('ag-flying')
    sqlRun(harness, `INSERT INTO flights (id, tenant, project_id, agent, goal, status) VALUES ('fl-run', ?, 'proj-1', 'ag-flying', 'g', 'running')`, TENANT)
    seedAgent('ag-home'); sqlRun(harness, `UPDATE agents SET kind = 'home' WHERE id = 'ag-home'`)
    // A sole gate holder is NOT sole when a second principal holds the capability.
    seedAgent('ag-shared'); sqlRun(harness, `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg2', 'gate:shared', 'agent', 'ag-shared', 'mem-hadi', ?), ('gg3', 'gate:shared', 'member', 'mem-hadi', 'mem-hadi', ?)`, ago(90), ago(90))

    // Stale tasks for archive candidates.
    seedTask('t-done-old', null, 'done', 45)
    sqlRun(harness, `INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v-idle', 't-done-old', 'approved', 'ag-idle', ?)`, ago(20))
    seedTask('t-claimed', 'ag-stale', 'open', 40, { claim: NOW + 3_600_000 })
    seedTask('t-review', null, 'review', 50, { gate_owner: 'gate:hadi', review_entered_at: ago(50) })
    seedTask('t-parent', null, 'done', 45); seedTask('t-child', null, 'open', 2, { parent: 't-parent' })
    sqlRun(harness, `INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, held_at) VALUES ('t-held', 'esc', 'ag-stale', 1, ?)`, ago(41)) // FK-less table
    seedTask('t-held', null, 'open', 41)
  })
  afterEach(() => harness.close())

  const preview = async (a = SQUAD_LEAD, args: Record<string, unknown> = { squad_id: 'sq-1' }) => {
    const res = await call(a, args)
    if (!res.ok) throw new Error(`tool failed: ${JSON.stringify(res)}`)
    return res.result as Record<string, any> // test-only: JSON shape asserted field by field below
  }
  const agent = (p: Record<string, any>, id: string) => p.agents.find((a: any) => a.agent_id === id)
  const agentCand = (p: Record<string, any>, id: string) => p.archive_candidates.agents.find((a: any) => a.agent_id === id)
  const taskCand = (p: Record<string, any>, id: string) => p.archive_candidates.tasks.find((a: any) => a.task_id === id)

  it('active, idle, stale-backlog, feed and waiting agents get the expected rule-named recommendations', async () => {
    const p = await preview()
    expect(agent(p, 'ag-active').recommendation).toMatchObject({ action: 'rest', rule: 'active_on_track' })
    expect(agent(p, 'ag-idle').recommendation).toMatchObject({ action: 'rest', rule: 'dormant_no_demand' })
    expect(agent(p, 'ag-stale').recommendation).toMatchObject({ action: 'shrink', rule: 'stale_backlog_no_recent_output' })
    expect(agent(p, 'ag-stale').recommendation.evidence).toEqual(expect.arrayContaining([{ table: 'tasks', id: 't-s1' }, { table: 'tasks', id: 't-s2' }]))
    expect(agent(p, 'ag-feed').recommendation).toMatchObject({ action: 'feed', rule: 'productive_empty_queue' })
    expect(agent(p, 'ag-wait').recommendation).toMatchObject({ action: 'ask', rule: 'blocked_on_wait' })
    expect(agent(p, 'ag-wait').waits[0]).toMatchObject({ kind: 'flight_waiting', id: 'fl-wait', age_hours: 120 })
  })

  it('reports last meaningful activity with evidence, measured cost, and "unknown" plus a gap otherwise', async () => {
    const p = await preview()
    expect(agent(p, 'ag-active').last_meaningful_activity).toMatchObject({ kind: 'result_submission', evidence: { table: 'task_result_submissions', id: 'sub-active' } })
    expect(agent(p, 'ag-idle').last_meaningful_activity).toMatchObject({ kind: 'verdict', evidence: { table: 'task_verdicts', id: 'v-idle' } })
    expect(agent(p, 'ag-stale').last_meaningful_activity).toBeNull()
    expect(agent(p, 'ag-active').cost).toMatchObject({ micro_usd: 1500, tokens: 900 })
    expect(agent(p, 'ag-stale').cost).toMatchObject({ micro_usd: 'unknown', gap: 'execution_meter_no_rows_in_window' })
    expect(p.gaps).toEqual(expect.arrayContaining(['substantive_task_note_activity', 'merge_receipt_agent_attribution']))
  })

  it('agent archive candidates: eligible only when nothing exempts them, each exemption named with evidence', async () => {
    const p = await preview()
    expect(agentCand(p, 'ag-dormant')).toMatchObject({ eligible: true, exceptions: [] })
    expect(agentCand(p, 'ag-idle')).toBeUndefined() // active within 30 days
    expect(agentCand(p, 'ag-stale')).toMatchObject({ eligible: false })
    expect(agentCand(p, 'ag-stale').exceptions.map((e: any) => e.reason)).toContain('owns_open_tasks')
    expect(agentCand(p, 'ag-gate').exceptions).toEqual([{ reason: 'sole_gate_holder', evidence: [{ table: 'gate_grants', id: 'gate:hadi' }] }])
    expect(agentCand(p, 'ag-designated').exceptions).toEqual([{ reason: 'designated_owner', evidence: [{ table: 'members', id: 'mem-hadi' }] }])
    expect(agentCand(p, 'ag-flying').exceptions).toEqual([{ reason: 'live_flight', evidence: [{ table: 'flights', id: 'fl-run' }] }])
    expect(agentCand(p, 'ag-home').exceptions.map((e: any) => e.reason)).toEqual(['standing_record'])
    // gate:shared has a second holder, so ag-shared is not a SOLE holder.
    expect(agentCand(p, 'ag-shared')).toMatchObject({ eligible: true })
  })

  it('task archive candidates: 30-day quiescent tasks, exemptions hold', async () => {
    const p = await preview()
    expect(taskCand(p, 't-done-old')).toMatchObject({ eligible: true, age_days: 45, exceptions: [] })
    expect(taskCand(p, 't-claimed')).toMatchObject({ eligible: false })
    expect(taskCand(p, 't-claimed').exceptions.map((e: any) => e.reason)).toContain('live_claim')
    expect(taskCand(p, 't-held').exceptions.map((e: any) => e.reason)).toEqual(['execution_hold'])
    expect(taskCand(p, 't-review').exceptions.map((e: any) => e.reason)).toEqual(['unresolved_approval'])
    expect(taskCand(p, 't-parent').exceptions).toEqual([{ reason: 'standing_record', evidence: [{ table: 'tasks', id: 't-child' }] }])
    expect(taskCand(p, 't-s2').exceptions.map((e: any) => e.reason)).toEqual(['active_status_in_progress'])
    expect(taskCand(p, 't-s1')).toMatchObject({ eligible: true }) // untouched open, 60d
    expect(taskCand(p, 't-a1')).toBeUndefined() // fresh work is not a candidate
    expect(taskCand(p, 't-child')).toBeUndefined()
  })

  it('is deterministic for an identical snapshot and renders a short card', async () => {
    const a = await preview()
    const b = await preview()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.markdown).toContain('| ag-stale | shrink | stale_backlog_no_recent_output |')
    expect(a.markdown.split('\n').length).toBeLessThan(60)
  })

  it('performs ZERO writes: only SELECTs, and no row changes', async () => {
    const before = Number(sqlGet(harness, 'SELECT total_changes() AS c')?.c)
    seen.length = 0
    await preview()
    expect(seen.length).toBeGreaterThan(5)
    for (const sql of seen) {
      expect(sql.trimStart(), sql).toMatch(/^(SELECT|WITH)\b/i)
      expect(sql, sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i)
    }
    expect(Number(sqlGet(harness, 'SELECT total_changes() AS c')?.c)).toBe(before)
  })

  it('reads are bounded: statement count grows with chunks, not agents (no N+1)', async () => {
    seen.length = 0
    await preview()
    const small = seen.length
    for (let i = 0; i < 150; i += 1) seedAgent(`ag-bulk-${String(i).padStart(3, '0')}`)
    seen.length = 0
    await preview()
    const large = seen.length
    expect(small).toBeLessThan(40)
    expect(large).toBeLessThanOrEqual(small + 20) // 165 agents = 2 chunks per chunked fact, never 150 extra statements
  })

  it('stays private by default: not in the unauthenticated OpenAPI allowlist', () => {
    expect(PUBLIC_TOOL_ALLOWLIST).not.toContain('gardener_preview')
  })

  it('refuses a caller without read on the squad; rejects bad args', async () => {
    const denied = await call(OTHER_SQUAD_ONLY, { squad_id: 'sq-1' })
    expect(denied).toMatchObject({ ok: false, status: 403 })
    expect(await call(caller([]), { squad_id: 'sq-1' })).toMatchObject({ ok: false })
    expect(await call(SQUAD_READER, {})).toMatchObject({ ok: false, status: 400 })
    expect(await call(SQUAD_READER, { squad_id: 'sq-1', window_days: 5 })).toMatchObject({ ok: false, status: 400 })
    expect(await call(SQUAD_READER, { squad_id: 'sq-1', as_of: 'not-a-date' })).toMatchObject({ ok: false, status: 400 })
    // as_of: not in the future, not older than 365 days
    expect(await call(SQUAD_READER, { squad_id: 'sq-1', as_of: new Date(Date.now() + 86_400_000).toISOString() })).toMatchObject({ ok: false, status: 400 })
    expect(await call(SQUAD_READER, { squad_id: 'sq-1', as_of: new Date(Date.now() - 366 * 86_400_000).toISOString() })).toMatchObject({ ok: false, status: 400 })
    expect(await call(SQUAD_READER, { squad_id: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })

  // ── round-1 fixes ───────────────────────────────────────────────────────────────────────────
  describe('round 1', () => {
    const iso = (d: number) => ago(d)

    it('[P1-1 Codex] cost is "restricted" without meter:read; visible to a squad lead', async () => {
      const member = await preview(SQUAD_READER)
      for (const a of member.agents) expect(a.cost).toBe('restricted')
      expect(JSON.stringify(member)).not.toContain('1500')
      const lead = await preview(SQUAD_LEAD)
      expect(agent(lead, 'ag-active').cost).toMatchObject({ micro_usd: 1500 })
    })

    it('[P1-2 gate] other-squad work shows only as activity_elsewhere: no ids, no timestamps, no waits', async () => {
      sqlRun(harness, `INSERT INTO tasks (id, squad_id, title, status, done_when, created_at, updated_at) VALUES ('t-other', 'sq-2', 't', 'done', 'n/a', ?, ?)`, iso(1), iso(1))
      seedAgent('ag-x')
      const stamp = iso(4.5)
      sqlRun(harness, `INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v-LEAK', 't-other', 'approved', 'ag-x', ?)`, stamp)
      sqlRun(harness, `INSERT INTO project_deployments (id, project_id, deployment_id, status, dispatched_by, created_at) VALUES ('dep-LEAK', 'proj-2', 'd1', 'healthy', 'ag-x', ?)`, stamp)
      sqlRun(harness, `INSERT INTO flights (id, tenant, project_id, agent, goal, status, waiting_since) VALUES ('fl-LEAK', ?, 'proj-2', 'ag-x', 'g', 'waiting', ?)`, TENANT, NOW - 9 * 86_400_000)
      sqlRun(harness, `INSERT INTO routines (id, tenant, project_id, name, objective, trigger_kind, responsible_squad_id, created_by) VALUES ('rt-LEAK', ?, 'proj-2', 'n', 'o', 'manual', 'sq-2', 'x')`, TENANT)
      sqlRun(harness, `INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind, status, waiting_reason, assigned_agent_id) VALUES ('rr-LEAK', ?, 'proj-2', 'rt-LEAK', 1, '{}', 'k', 'manual', 'waiting', 'agent', 'ag-x')`, TENANT)
      sqlRun(harness, `INSERT INTO decision_requests (id, tenant, decision_class, decision_cause, dedupe_key, exact_authority_required, question, options_json, consequences_json, evidence_json, task_id, requested_by_principal_kind, requested_by_principal_id, expires_at, created_at) VALUES ('dr-LEAK', ?, 'spend', 'spend.increase', 'dk', 'x', 'q', '[]', '{}', '{}', 't-other', 'agent', 'ag-x', ?, ?)`, TENANT, iso(-5), stamp)
      const p = await preview()
      const card = agent(p, 'ag-x')
      expect(card.last_meaningful_activity).toBeNull()
      expect(card.waits).toEqual([])
      expect(card.activity_elsewhere).toBe(true)
      expect(agentCand(p, 'ag-x').exceptions).toContainEqual({ reason: 'activity_elsewhere', evidence: [] })
      expect(agentCand(p, 'ag-x').eligible).toBe(false)
      const out = JSON.stringify(p)
      for (const leak of ['LEAK', stamp.slice(0, 16), 'proj-2', 't-other']) expect(out, leak).not.toContain(leak)
    })

    it('[P1-3 tenant] flights, routine_runs and decision_requests of another tenant never count', async () => {
      seedAgent('ag-t')
      sqlRun(harness, `INSERT INTO flights (id, tenant, project_id, agent, goal, status, waiting_since) VALUES ('fl-ot', 'other-tenant', 'proj-1', 'ag-t', 'g', 'waiting', ?)`, NOW - 86_400_000)
      sqlRun(harness, `INSERT INTO routines (id, tenant, project_id, name, objective, trigger_kind, responsible_squad_id, created_by) VALUES ('rt-ot', 'other-tenant', 'proj-1', 'n', 'o', 'manual', 'sq-1', 'x')`)
      sqlRun(harness, `INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind, status, waiting_reason, assigned_agent_id) VALUES ('rr-ot', 'other-tenant', 'proj-1', 'rt-ot', 1, '{}', 'k', 'manual', 'waiting', 'agent', 'ag-t')`)
      sqlRun(harness, `INSERT INTO tasks (id, squad_id, title, status, done_when, created_at, updated_at) VALUES ('t-ot', 'sq-1', 't', 'open', 'n/a', ?, ?)`, iso(1), iso(1))
      sqlRun(harness, `INSERT INTO decision_requests (id, tenant, decision_class, decision_cause, dedupe_key, exact_authority_required, question, options_json, consequences_json, evidence_json, task_id, requested_by_principal_kind, requested_by_principal_id, expires_at, created_at) VALUES ('dr-ot', 'other-tenant', 'spend', 'spend.increase', 'dk', 'x', 'q', '[]', '{}', '{}', 't-ot', 'agent', 'ag-t', ?, ?)`, iso(-5), iso(2))
      const p = await preview()
      expect(agent(p, 'ag-t').waits).toEqual([])
      expect(agent(p, 'ag-t').activity_elsewhere).toBe(false)
      expect(agentCand(p, 'ag-t')).toMatchObject({ eligible: true, exceptions: [] })
    })

    it('[P2 gate holder] only LIVE, visible principals count toward "sole"', async () => {
      // gate:dual: ag-a plus a SUSPENDED member and an INACTIVE agent -> ag-a is still the sole live holder.
      seedAgent('ag-a'); seedAgent('ag-dead'); sqlRun(harness, `UPDATE agents SET status = 'inactive' WHERE id = 'ag-dead'`)
      sqlRun(harness, `INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-susp', ?, 's@example.com', 'S', 'suspended')`, TENANT)
      sqlRun(harness, `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('d1', 'gate:dual', 'agent', 'ag-a', 'mem-hadi', ?), ('d2', 'gate:dual', 'member', 'mem-susp', 'mem-hadi', ?), ('d3', 'gate:dual', 'agent', 'ag-dead', 'mem-hadi', ?)`, iso(90), iso(90), iso(90))
      // gate:hidden: ag-b plus a live agent in a squad the caller cannot read -> still sole for the caller.
      seedAgent('ag-b')
      sqlRun(harness, `INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('ag-hidden', 'sq-2', 'ag-hidden', 'h', 'active', '2026-01-01 00:00:00')`)
      sqlRun(harness, `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('h1', 'gate:hidden', 'agent', 'ag-b', 'mem-hadi', ?), ('h2', 'gate:hidden', 'agent', 'ag-hidden', 'mem-hadi', ?)`, iso(90), iso(90))
      const p = await preview()
      expect(agentCand(p, 'ag-a').exceptions.map((e: any) => e.reason)).toEqual(['sole_gate_holder'])
      expect(agentCand(p, 'ag-b').exceptions.map((e: any) => e.reason)).toEqual(['sole_gate_holder'])
      // A second LIVE, visible agent holder ends soleness.
      sqlRun(harness, `UPDATE agents SET squad_id = 'sq-1' WHERE id = 'ag-hidden'`)
      const p2 = await preview()
      expect(agentCand(p2, 'ag-b')).toMatchObject({ eligible: true })
    })

    it('[P2 as_of] activity after as_of is ignored', async () => {
      seedAgent('ag-late'); seedSubmission('sub-late', 'ag-late', -1) // one day AFTER as_of
      const p = await preview()
      expect(agent(p, 'ag-late').last_meaningful_activity).toBeNull()
      expect(agent(p, 'ag-late').meaningful_activity_count).toBe(0)
      sqlRun(harness, `INSERT INTO tasks (id, squad_id, title, status, done_when, created_at, updated_at) VALUES ('t-v', 'sq-1', 't', 'done', 'n/a', ?, ?)`, iso(50), iso(50))
      sqlRun(harness, `INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v-late', 't-v', 'approved', 'ag-late', ?)`, iso(-1))
      sqlRun(harness, `INSERT INTO project_deployments (id, project_id, deployment_id, status, dispatched_by, created_at) VALUES ('dep-late', 'proj-1', 'd', 'healthy', 'ag-late', ?)`, iso(-1))
      sqlRun(harness, `INSERT INTO execution_receipts (id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id, task_id, idempotency_key, claims_json, canonical_payload, payload_digest, receipt_hash, server_timestamp) VALUES ('rc-late', ?, 'result.reported', 'mupot', 'x', 'agent', 'ag-late', 't-v', 'k', '{}', '{}', ?, ?, ?)`, TENANT, 'a'.repeat(64), 'b'.repeat(64), iso(-1))
      const p2 = await preview()
      expect(agent(p2, 'ag-late').meaningful_activity_count).toBe(0)
      expect(agent(p2, 'ag-late').activity_elsewhere).toBe(false)
    })

    it('[P2 truncation] a truncated activity read makes affected facts unknown and nothing archive-eligible', async () => {
      sqlRun(harness, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
        INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, created_at)
        SELECT 'bulk-' || i, '${TENANT}', 'x', 'sq-1', 'ag-active', 'a.md', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${ago(1)}' FROM n`)
      const p = await preview()
      expect(p.truncated.events).toBe(true)
      expect(p.gaps).toContain('activity_events_truncated')
      expect(agent(p, 'ag-dormant')).toMatchObject({ activity_known: false })
      expect(agent(p, 'ag-dormant').recommendation.rule).toBe('unknown_due_to_truncation')
      expect(agentCand(p, 'ag-dormant')).toMatchObject({ eligible: false, days_without_meaningful_activity: 'unknown' })
      expect(agentCand(p, 'ag-dormant').exceptions.map((e: any) => e.reason)).toContain('unknown_due_to_truncation')
      for (const c of p.archive_candidates.agents) expect(c.eligible).toBe(false)
    })

    it('[P2 truncation] a truncated task read makes assignments unknown and no task archive-eligible', async () => {
      sqlRun(harness, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 505)
        INSERT INTO tasks (id, squad_id, title, status, done_when, created_at, updated_at)
        SELECT 'z-bulk-' || i, 'sq-1', 't', 'done', 'n/a', '${ago(60)}', '${ago(60)}' FROM n`)
      const p = await preview()
      expect(p.truncated.tasks).toBe(true)
      expect(agent(p, 'ag-active').open_assignments).toMatchObject({ count: 'unknown', stale_count: 'unknown' })
      expect(agent(p, 'ag-active').recommendation.rule).toBe('unknown_due_to_truncation')
      expect(p.archive_candidates.tasks.length).toBeGreaterThan(0)
      for (const c of p.archive_candidates.tasks) expect(c.eligible, c.task_id).toBe(false)
      for (const c of p.archive_candidates.agents) expect(c.eligible, c.agent_id).toBe(false)
    })

    it('[P2 dispatch] the canonical archive-blocking dispatch predicate exempts a task with an unsettled dispatch', async () => {
      seedTask('t-disp', null, 'open', 45); seedTask('t-settled', null, 'open', 45)
      sqlRun(harness, `INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at) VALUES ('dr1', ?, 't-disp', 'sq-1', 'ag-active', 'member', 'mem-hadi', ?)`, TENANT, ago(44))
      sqlRun(harness, `INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at, settled_at) VALUES ('dr2', ?, 't-settled', 'sq-1', 'ag-active', 'member', 'mem-hadi', ?, ?, ?)`, TENANT, ago(44), ago(43), ago(43))
      const p = await preview()
      expect(taskCand(p, 't-disp').exceptions.map((e: any) => e.reason)).toEqual(['live_dispatch'])
      expect(taskCand(p, 't-settled')).toMatchObject({ eligible: true, exceptions: [] })
    })

    it('[P2 binds] no statement binds more than 100 parameters, even with the 200-agent cap', async () => {
      for (let i = 0; i < 230; i += 1) seedAgent(`ag-b${String(i).padStart(3, '0')}`)
      const counts: number[] = []
      const real = env.DB
      env = { ...env, DB: new Proxy(real, { get(t, k, r) {
        if (k !== 'prepare') return Reflect.get(t, k, r)
        return (sql: string) => {
          const st = t.prepare(sql)
          return new Proxy(st, { get(st2, k2, r2) {
            if (k2 !== 'bind') return Reflect.get(st2, k2, r2)
            return (...args: unknown[]) => { counts.push(args.length); return st2.bind(...args) }
          } })
        }
      } }) } as unknown as Env
      const p = await preview()
      expect(p.truncated.agents).toBe(true)
      expect(Math.max(...counts)).toBeLessThanOrEqual(100)
    })
  })

  // ── round 2 ─────────────────────────────────────────────────────────────────────────────────
  describe('round 2', () => {
    it('[Codex P2] a truncated read withholds eligibility from an agent whose own facts are not in the page', async () => {
      seedAgent('ag-older'); seedSubmission('sub-older', 'ag-older', 20) // recent activity, but hidden by truncation
      sqlRun(harness, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
        INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, created_at)
        SELECT 'bulk-' || i, '${TENANT}', 'x', 'sq-1', 'ag-active', 'a.md', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${ago(1)}' FROM n`)
      const p = await preview()
      expect(agentCand(p, 'ag-older')).toMatchObject({ eligible: false })
      expect(agent(p, 'ag-older')).toMatchObject({ activity_known: false })
    })

    it('[Codex P2] a settled dispatch whose inbox envelope is still unread blocks archival (canonical predicate)', async () => {
      seedTask('t-env', null, 'open', 45)
      sqlRun(harness, `INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at, settled_at) VALUES ('dr-env', ?, 't-env', 'sq-1', 'ag-active', 'member', 'mem-hadi', ?, ?, ?)`, TENANT, ago(44), ago(43), ago(43))
      sqlRun(harness, `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body, request_id, created_at) VALUES ('msg-env', ?, 'ag-active', 'mupot-dispatch', 'mem-hadi', 'b', 'dispatch-inbox:dr-env', ?)`, TENANT, ago(44))
      const p = await preview()
      expect(taskCand(p, 't-env').exceptions.map((e: any) => e.reason)).toEqual(['live_dispatch'])
      sqlRun(harness, `UPDATE agent_messages SET read_at = ? WHERE id = 'msg-env'`, ago(43))
      expect(taskCand(await preview(), 't-env')).toMatchObject({ eligible: true })
    })

    it('[Codex P2] an assigned waiting routine run exempts an otherwise dormant agent from archival', async () => {
      seedAgent('ag-run')
      sqlRun(harness, `INSERT INTO routines (id, tenant, project_id, name, objective, trigger_kind, responsible_squad_id, created_by) VALUES ('rt-in', ?, 'proj-1', 'n', 'o', 'manual', 'sq-1', 'x')`, TENANT)
      sqlRun(harness, `INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind, status, waiting_reason, assigned_agent_id) VALUES ('rr-in', ?, 'proj-1', 'rt-in', 1, '{}', 'k', 'manual', 'waiting', 'agent', 'ag-run')`, TENANT)
      const p = await preview()
      expect(agent(p, 'ag-run').recommendation).toMatchObject({ action: 'ask', rule: 'blocked_on_wait' })
      expect(agentCand(p, 'ag-run')).toMatchObject({ eligible: false, exceptions: [{ reason: 'waiting_routine_run', evidence: [{ table: 'routine_runs', id: 'rr-in' }] }] })
    })

    it('[Codex P2] cost never includes the as_of UTC day (a mutable whole-day bucket); full prior days are summed', async () => {
      const today = AS_OF.slice(0, 10)
      sqlRun(harness, `INSERT INTO execution_meter (id, window_key, count, tokens, window_start, cost_micro_usd) VALUES ('m-today', ?, 1, 123, ?, 999)`, `${TENANT}:ag-active:${today}`, AS_OF)
      const p = await preview()
      expect(agent(p, 'ag-active').cost).toMatchObject({ micro_usd: 1500, tokens: 900 })
      expect(p.gaps).toContain('cost_excludes_as_of_utc_day')
    })

    it('[Codex P2] a stale task linked to a live flight only via meta.task_ids is exempt (canonical in-air linkage)', async () => {
      seedTask('t-meta', null, 'open', 45)
      sqlRun(harness, `INSERT INTO flights (id, tenant, project_id, agent, goal, status, meta) VALUES ('fl-meta', ?, 'proj-1', 'ag-flying', 'g', 'running', '{"task_ids":["t-meta"]}')`, TENANT)
      const p = await preview()
      expect(taskCand(p, 't-meta').exceptions).toEqual([{ reason: 'live_flight', evidence: [{ table: 'flights', id: 'fl-meta' }] }])
    })

    it('[Opus P1-2] the meter is read with ONE statement however many agents there are', async () => {
      for (let i = 0; i < 150; i += 1) seedAgent(`ag-m${String(i).padStart(3, '0')}`)
      seen.length = 0
      await preview()
      expect(seen.filter((q) => /FROM execution_meter/.test(q)).length).toBe(1)
    })
  })
})
