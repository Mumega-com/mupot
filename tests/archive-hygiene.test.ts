// tests/archive-hygiene.test.ts — receipted archive substrate (mupot#1496).
//
// Real SQLite, full migration chain (createSqliteD1 + applyAllMigrations) —
// migration 0173 applies as part of that chain, so every test here is also
// proof the migration lands cleanly on a populated fixture. Every MCP tool
// call goes through invokeTool (src/mcp), never a ToolSpec's run() directly
// (scripts/check-mcp-tool-seam.mjs).
//
// migrations/0173 deliberately does NOT rebuild members or tasks (see that
// file's header for the full FK/trigger inventory and why) — so "prove
// existing triggers still fire" here means: (a) member row identity (ids,
// emails) is byte-for-byte unchanged after 0173 applies (trivially true for
// plain ADD COLUMNs, asserted anyway), and (b) the two triggers that validate
// AGAINST members from another table (token_binding_attestations_validate_
// identity, seat_attestations_validate_identity — the closest thing to a
// "member trigger" that exists, per this session's introspection) still
// enforce correctly post-migration.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { archiveRow, unarchiveRow } from '../src/hygiene/archive'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const OPERATOR = 'member-operator'

function auth(opts: { boundAgentId?: string | null; capabilities?: CapabilityGrant[]; role?: AuthContext['role'] } = {}): AuthContext {
  return {
    userId: opts.boundAgentId ? `agent:${opts.boundAgentId}` : 'operator-caller',
    email: opts.boundAgentId ? null : 'operator@example.com',
    role: opts.role ?? 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId: OPERATOR,
    capabilities: opts.capabilities ?? [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

const ORG_ADMIN = auth()

describe('archive substrate (mupot#1496)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const invoke = (a: AuthContext, tool: string, args: Record<string, unknown>) => invokeTool(a, env, tool, args, ORIGIN)

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env

    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES
        ('${OPERATOR}', '${TENANT}', 'op@example.com', 'Operator', 'active'),
        ('mem-1', '${TENANT}', 'mem1@example.com', 'Member One', 'active'),
        ('mem-2', '${TENANT}', 'mem2@example.com', 'Member Two', 'active');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-1', 'dept-1', 'sq1-sqd', 'Squad One'),
        ('squad-2', 'dept-1', 'sq2-sqd', 'Squad Two');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES
        ('agent-1', 'squad-1', 'ag1', 'Agent One', 'active'),
        ('agent-2', 'squad-2', 'ag2', 'Agent Two', 'inactive');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('proj-1', 'proj-one', 'Project One', 'active'),
        ('proj-2', 'proj-two', 'Project Two', 'planned');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('proj-1', 'squad-1', 'admin'),
        ('proj-2', 'squad-2', 'admin');
      INSERT INTO tasks (id, squad_id, title, status, done_when, project_id) VALUES
        ('task-1', 'squad-2', 'Task One', 'done', 'n/a', 'proj-2'),
        ('task-2', 'squad-1', 'Task Two', 'open', 'n/a', 'proj-1');
    `)
  })

  afterEach(() => harness.close())

  // ── 0173 migration proof ──────────────────────────────────────────────────

  it('0173 lands cleanly on a populated fixture: member rows preserved byte-for-byte, columns present', async () => {
    const before = await env.DB.prepare('SELECT id, email, display_name, status FROM members WHERE id = ?1')
      .bind('mem-1').first()
    expect(before).toMatchObject({ id: 'mem-1', email: 'mem1@example.com', display_name: 'Member One', status: 'active' })

    const cols = harness.sqlite.prepare('PRAGMA table_info(members)').all() as { name: string }[]
    const names = cols.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['archived_at', 'archived_reason', 'archived_by_member_id']))

    const squadCols = (harness.sqlite.prepare('PRAGMA table_info(squads)').all() as { name: string }[]).map((c) => c.name)
    expect(squadCols).toEqual(expect.arrayContaining(['status', 'archived_at', 'archived_reason', 'archived_by_member_id']))
  })

  it('member-referencing triggers still enforce correctly post-0173 (token_binding_attestations_validate_identity)', async () => {
    // The trigger validates a claimed identity provider/subject against a real
    // human_login_identities row for the member — insert a mismatched identity
    // and confirm the trigger still ABORTs after 0173 applies.
    harness.sqlite.exec(`
      INSERT INTO human_login_identities (id, tenant, member_id, provider, provider_subject)
        VALUES ('lid-1', '${TENANT}', 'mem-1', 'google', 'sub-1');
    `)
    expect(() => {
      harness.sqlite.exec(`
        INSERT INTO token_binding_attestations
          (id, tenant, member_id, login_identity_id, provider, provider_subject, credential_id, created_at)
          VALUES ('tba-1', '${TENANT}', 'mem-1', 'lid-1', 'google', 'WRONG-SUBJECT', 'cred-1', datetime('now'));
      `)
    }).toThrow()
  })

  // ── happy path: one per table ─────────────────────────────────────────────

  it('archives and unarchives a member (orthogonal signal, status untouched)', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'test debris' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('archived')

    const row = await env.DB.prepare('SELECT status, archived_at, archived_reason, archived_by_member_id FROM members WHERE id = ?1')
      .bind('mem-1').first<{ status: string; archived_at: string | null; archived_reason: string | null; archived_by_member_id: string | null }>()
    expect(row?.status).toBe('active') // untouched
    expect(row?.archived_at).not.toBeNull()
    expect(row?.archived_reason).toBe('test debris')
    expect(row?.archived_by_member_id).toBe(OPERATOR)

    const receipt = await env.DB.prepare(
      `SELECT action, reason, actor_member_id FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-1'`,
    ).first<{ action: string; reason: string; actor_member_id: string }>()
    expect(receipt).toMatchObject({ action: 'archive', reason: 'test debris', actor_member_id: OPERATOR })

    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-1', reason: 'restore' })
    expect(un.ok).toBe(true)
    if (!un.ok) return
    expect((un.result as { status: string }).status).toBe('unarchived')
    const after = await env.DB.prepare('SELECT archived_at FROM members WHERE id = ?1').bind('mem-1').first<{ archived_at: string | null }>()
    expect(after?.archived_at).toBeNull()
  })

  it('archives an agent with no live tokens', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-2', reason: 'dead agent' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('archived')
    const row = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1').bind('agent-2')
      .first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('inactive') // untouched
    expect(row?.archived_at).not.toBeNull()
  })

  it('archives an empty squad (no active agents/members/tasks) and unarchives it back to active', async () => {
    harness.sqlite.exec(`UPDATE agents SET status='inactive' WHERE squad_id='squad-2';`) // squad-2 has no active deps
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'squads', id: 'squad-2', reason: 'empty scaffold' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('archived')
    const row = await env.DB.prepare('SELECT status FROM squads WHERE id = ?1').bind('squad-2').first<{ status: string }>()
    expect(row?.status).toBe('archived')

    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'squads', id: 'squad-2', reason: 'restore' })
    expect(un.ok).toBe(true)
    const after = await env.DB.prepare('SELECT status FROM squads WHERE id = ?1').bind('squad-2').first<{ status: string }>()
    expect(after?.status).toBe('active')
  })

  it('archives a project (no open tasks) and unarchive restores the true prior status', async () => {
    harness.sqlite.exec(`UPDATE tasks SET status='done' WHERE project_id='proj-2';`)
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'projects', id: 'proj-2', reason: 'stale planned project' })
    expect(result.ok).toBe(true)
    const row = await env.DB.prepare('SELECT status, archived_prior_status FROM projects WHERE id = ?1').bind('proj-2')
      .first<{ status: string; archived_prior_status: string }>()
    expect(row?.status).toBe('archived')
    expect(row?.archived_prior_status).toBe('planned')

    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'projects', id: 'proj-2', reason: 'restore' })
    expect(un.ok).toBe(true)
    const after = await env.DB.prepare('SELECT status, archived_prior_status FROM projects WHERE id = ?1').bind('proj-2')
      .first<{ status: string; archived_prior_status: string | null }>()
    expect(after?.status).toBe('planned') // restored to the TRUE prior value, not a hardcoded 'active'
    expect(after?.archived_prior_status).toBeNull()
  })

  it('archives a terminal task via the side table, leaving tasks.status completely untouched', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-1', reason: 'old done task' })
    expect(result.ok).toBe(true)
    const taskRow = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind('task-1').first<{ status: string }>()
    expect(taskRow?.status).toBe('done') // untouched, exactly as before archiving

    const stateRow = await env.DB.prepare('SELECT prior_status, archived_reason FROM tasks_archive_state WHERE task_id = ?1')
      .bind('task-1').first<{ prior_status: string; archived_reason: string }>()
    expect(stateRow).toMatchObject({ prior_status: 'done', archived_reason: 'old done task' })

    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'tasks', id: 'task-1', reason: 'restore' })
    expect(un.ok).toBe(true)
    const gone = await env.DB.prepare('SELECT task_id FROM tasks_archive_state WHERE task_id = ?1').bind('task-1').first()
    expect(gone).toBeNull()
    const stillDone = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind('task-1').first<{ status: string }>()
    expect(stillDone?.status).toBe('done')
  })

  // ── refusals ───────────────────────────────────────────────────────────────

  it('refuses to archive a member with live tokens/sessions unless revoke:true', async () => {
    harness.sqlite.exec(`
      INSERT INTO member_tokens (id, member_id, tenant, token_hash) VALUES ('tok-1', 'mem-1', '${TENANT}', 'hash-1');
    `)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('live_credentials')
    expect(refused.detail).toMatchObject({ tokens: 1 })

    const revoked = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x', revoke: true })
    expect(revoked.ok).toBe(true)
    if (!revoked.ok) return
    expect((revoked.result as { revoked?: { tokens: number } }).revoked?.tokens).toBe(1)
    const tokenRow = await env.DB.prepare('SELECT revoked_at FROM member_tokens WHERE id = ?1').bind('tok-1')
      .first<{ revoked_at: string | null }>()
    expect(tokenRow?.revoked_at).not.toBeNull()
  })

  it('refuses to archive an agent with live tokens unless revoke:true', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-1', 'mem-1', datetime('now'));
      INSERT INTO member_tokens (id, member_id, agent_id, tenant, token_hash)
        VALUES ('tok-a1', 'mem-1', 'agent-1', '${TENANT}', 'hash-a1');
    `)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-1', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('live_credentials')

    const revoked = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-1', reason: 'x', revoke: true })
    expect(revoked.ok).toBe(true)
  })

  it('refuses to archive a squad with an active agent, active member, or open task — reports counts', async () => {
    // squad-1 has agent-1 (active) + a capability grant for mem-1 + task-2 (open)
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-1', 'mem-1', 'squad', 'squad-1', 'member');
    `)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'squads', id: 'squad-1', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('active_dependents')
    expect(refused.detail).toEqual({ agents: 1, members: 1, tasks: 1 })
  })

  it('refuses to archive a project with an open/in_progress/review task', async () => {
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'projects', id: 'proj-1', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('active_dependents')
    expect(refused.detail).toEqual({ tasks: 1 })
  })

  it('refuses to archive a task with a live (unexpired) execution claim', async () => {
    harness.sqlite.exec(`
      UPDATE tasks SET status='in_progress', execution_claim_expires_at = ${Date.now() + 60_000} WHERE id='task-2';
    `)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('live_execution_claim')
  })

  it('refuses to archive a task that is on an in-air flight (status running/waiting)', async () => {
    harness.sqlite.exec(`UPDATE tasks SET status='review' WHERE id='task-2';`)
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, meta)
        VALUES ('flight-1', '${TENANT}', 'agent-1', 'goal', 'running', '{"task_ids":["task-2"]}');
    `)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('in_air_flight')
  })

  it('rejects an unknown table at the schema level', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'squad_packs', id: 'x', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  // ── idempotency ──────────────────────────────────────────────────────────

  it('archiving an already-archived member is idempotent: no new receipt, reason unchanged', async () => {
    const first = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'first reason' })
    expect(first.ok).toBe(true)

    const second = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'second reason' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect((second.result as { status: string }).status).toBe('already_archived')

    const row = await env.DB.prepare('SELECT archived_reason FROM members WHERE id = ?1').bind('mem-1')
      .first<{ archived_reason: string }>()
    expect(row?.archived_reason).toBe('first reason') // untouched by the second call

    const { results } = await env.DB.prepare(
      `SELECT id FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-1' AND action='archive'`,
    ).all()
    expect(results).toHaveLength(1)
  })

  it('archiving an already-archived task is idempotent: no new receipt', async () => {
    const first = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-1', reason: 'r1' })
    expect(first.ok).toBe(true)
    const second = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-1', reason: 'r2' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect((second.result as { status: string }).status).toBe('already_archived')
    const { results } = await env.DB.prepare(
      `SELECT id FROM archive_receipts WHERE entity_table='tasks' AND entity_id='task-1' AND action='archive'`,
    ).all()
    expect(results).toHaveLength(1)
  })

  it('unarchiving a row that is not archived returns not_archived, writes no receipt', async () => {
    const result = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('not_archived')
    const { results } = await env.DB.prepare(
      `SELECT id FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-1'`,
    ).all()
    expect(results).toHaveLength(0)
  })

  it('archive_row on a nonexistent row returns 404 not_found', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'nope', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })

  // ── receipts are immutable ───────────────────────────────────────────────

  it('archive_receipts rows cannot be updated or deleted', async () => {
    await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(() => harness.sqlite.exec(`UPDATE archive_receipts SET reason='tampered' WHERE entity_id='mem-1'`)).toThrow()
    expect(() => harness.sqlite.exec(`DELETE FROM archive_receipts WHERE entity_id='mem-1'`)).toThrow()
  })

  // ── org-admin gate ─────────────────────────────────────────────────────────

  it('403s a non-admin caller', async () => {
    const nonAdmin = auth({ capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }] })
    const result = await invoke(nonAdmin, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('403s a bound-agent caller (operator_principal_required) even if it holds org admin', async () => {
    const boundAgent = auth({
      boundAgentId: 'agent-1',
      capabilities: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const result = await invoke(boundAgent, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('operator_principal_required')
  })

  it('403s unarchive_row for a non-admin caller', async () => {
    const nonAdmin = auth({ capabilities: [] })
    const result = await invoke(nonAdmin, 'unarchive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  // ── archive_plan_expand (bulk plan, tasks only) ──────────────────────────

  it('archive_plan_expand filters by status/created_before/project_ids and excludes already-archived tasks', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, status, done_when, project_id, created_at) VALUES
        ('task-3', 'squad-2', 'Task Three', 'done', 'n/a', 'proj-2', '2020-01-01 00:00:00');
    `)
    await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-1', reason: 'already archived' })

    const result = await invoke(ORG_ADMIN, 'archive_plan_expand', {
      table: 'tasks',
      where: { status: ['done'], created_before: '2021-01-01 00:00:00', project_ids: ['proj-2'] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { ids } = result.result as { ids: string[] }
    expect(ids).toEqual(['task-3']) // task-1 matches the filter but is already archived; excluded
  })

  it('archive_plan_expand refuses a table other than tasks', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_plan_expand', { table: 'members', where: {} })
    expect(result.ok).toBe(false)
  })
})
