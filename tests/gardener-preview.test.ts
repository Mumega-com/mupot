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

function caller(capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: 'caller', email: 'c@example.com', role: 'member', tenant: TENANT, channel: 'workspace',
    memberId: 'mem-caller', capabilities, boundAgentId: null,
  } as AuthContext
}
const SQUAD_READER = caller([{ member_id: 'mem-caller', scope_type: 'squad', scope_id: 'sq-1', capability: 'member' }])
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
    sqlRun(harness, `INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept')`)
    sqlRun(harness, `INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'one-sqd', 'One'), ('sq-2', 'dept-1', 'two-sqd', 'Two')`)

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
    sqlRun(harness, `INSERT INTO flights (id, tenant, agent, goal, status, waiting_since) VALUES ('fl-wait', ?, 'ag-wait', 'g', 'waiting', ?)`, TENANT, NOW - 5 * 86_400_000)
    // Dormant, nothing holding it: eligible agent archive candidate.
    seedAgent('ag-dormant')
    // Dormant but exempt, one reason each.
    seedAgent('ag-gate'); sqlRun(harness, `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:hadi', 'agent', 'ag-gate', 'mem-hadi', ?)`, ago(90))
    seedAgent('ag-designated'); sqlRun(harness, `UPDATE agents SET attach_designated_member_id = 'mem-hadi' WHERE id = 'ag-designated'`)
    seedAgent('ag-flying')
    sqlRun(harness, `INSERT INTO flights (id, tenant, agent, goal, status) VALUES ('fl-run', ?, 'ag-flying', 'g', 'running')`, TENANT)
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

  const preview = async (a = SQUAD_READER, args: Record<string, unknown> = { squad_id: 'sq-1' }) => {
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
    for (const sql of seen) expect(sql.trimStart(), sql).toMatch(/^SELECT\b/i)
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
    expect(await call(SQUAD_READER, { squad_id: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })
})
