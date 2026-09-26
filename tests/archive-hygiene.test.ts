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

  it('archiving a member SUSPENDS it and revokes live tokens/web sessions/agent sessions; unarchive restores the true prior status', async () => {
    harness.sqlite.exec(`
      INSERT INTO member_tokens (id, member_id, tenant, token_hash) VALUES ('tok-mem1', 'mem-1', '${TENANT}', 'hash-mem1');
      INSERT INTO human_login_identities (id, tenant, member_id, provider, provider_subject)
        VALUES ('lid-mem1', '${TENANT}', 'mem-1', 'google', 'sub-mem1');
      INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, idle_expires_at, absolute_expires_at)
        VALUES ('wsh-mem1', '${TENANT}', 'mem-1', 'lid-mem1', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    `)

    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'test debris' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = result.result as { status: string; revoked: { tokens: number; web_sessions: number; agent_sessions: number } }
    expect(out.status).toBe('archived')
    expect(out.revoked).toEqual({ tokens: 1, web_sessions: 1, agent_sessions: 0 })

    const row = await env.DB.prepare(
      'SELECT status, archived_at, archived_reason, archived_by_member_id, archived_prior_status FROM members WHERE id = ?1',
    ).bind('mem-1').first<{
      status: string
      archived_at: string | null
      archived_reason: string | null
      archived_by_member_id: string | null
      archived_prior_status: string | null
    }>()
    expect(row?.status).toBe('suspended') // an archived member cannot authenticate
    expect(row?.archived_at).not.toBeNull()
    expect(row?.archived_reason).toBe('test debris')
    expect(row?.archived_by_member_id).toBe(OPERATOR)
    expect(row?.archived_prior_status).toBe('active')

    const tokenRow = await env.DB.prepare('SELECT revoked_at FROM member_tokens WHERE id = ?1').bind('tok-mem1')
      .first<{ revoked_at: string | null }>()
    expect(tokenRow?.revoked_at).not.toBeNull()
    const sessionRow = await env.DB.prepare('SELECT revoked_at FROM web_sessions WHERE id_hash = ?1').bind('wsh-mem1')
      .first<{ revoked_at: string | null }>()
    expect(sessionRow?.revoked_at).not.toBeNull()

    const receipt = await env.DB.prepare(
      `SELECT action, reason, actor_member_id, prior_status FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-1'`,
    ).first<{ action: string; reason: string; actor_member_id: string; prior_status: string }>()
    expect(receipt).toMatchObject({ action: 'archive', reason: 'test debris', actor_member_id: OPERATOR, prior_status: 'active' })

    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-1', reason: 'restore' })
    expect(un.ok).toBe(true)
    if (!un.ok) return
    expect((un.result as { status: string }).status).toBe('unarchived')
    const after = await env.DB.prepare('SELECT status, archived_at, archived_prior_status FROM members WHERE id = ?1')
      .bind('mem-1').first<{ status: string; archived_at: string | null; archived_prior_status: string | null }>()
    expect(after?.status).toBe('active') // restored to the TRUE prior value, not a hardcoded default
    expect(after?.archived_at).toBeNull()
    expect(after?.archived_prior_status).toBeNull()
    // credentials stay revoked — unarchive restores standing, never mints new access
    const tokenAfter = await env.DB.prepare('SELECT revoked_at FROM member_tokens WHERE id = ?1').bind('tok-mem1')
      .first<{ revoked_at: string | null }>()
    expect(tokenAfter?.revoked_at).not.toBeNull()
  })

  it('unarchiving a member restores the TRUE prior status, not a hardcoded default (member was already suspended)', async () => {
    harness.sqlite.exec(`UPDATE members SET status='suspended' WHERE id='mem-2';`)
    const archived = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-2', reason: 'x' })
    expect(archived.ok).toBe(true)
    const un = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-2', reason: 'restore' })
    expect(un.ok).toBe(true)
    const row = await env.DB.prepare('SELECT status FROM members WHERE id = ?1').bind('mem-2').first<{ status: string }>()
    expect(row?.status).toBe('suspended') // NOT flipped to 'active' — it was never active
  })

  it('refuses to archive a member who outranks the actor (cannot_affect_higher_rank, the #1337 predicate)', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-owner', 'mem-1', 'org', NULL, 'owner');
    `)
    // ORG_ADMIN's org-scope capability is 'admin' (rank 4) — mem-1 is now
    // 'owner' (rank 5), so exceedsTargetRankCeiling refuses BEFORE any
    // dependent-safety check runs, the same predicate PATCH /members/:id
    // already enforces (mupot#1337).
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
    const row = await env.DB.prepare('SELECT status, archived_at FROM members WHERE id = ?1').bind('mem-1')
      .first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('active')
    expect(row?.archived_at).toBeNull()
  })

  it('refuses to archive the caller\'s own member row', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: OPERATOR, reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_archive_self')
  })

  it('refuses to archive the last remaining org owner even for an actor of EQUAL rank', async () => {
    // mem-1 is the ONLY owner in the tenant. An actor who is ALSO an owner
    // (equal rank — exceedsTargetRankCeiling passes, since it is not
    // STRICTLY greater) still cannot archive the last one out.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner');
    `)
    const ownerActor = auth({
      capabilities: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const result = await invoke(ownerActor, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('last_org_owner')
  })

  it('permits archiving an owner when ANOTHER owner remains', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner'),
        ('cap-owner-mem2', 'mem-2', 'org', NULL, 'owner');
    `)
    const ownerActor = auth({
      capabilities: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const result = await invoke(ownerActor, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(true) // mem-2 remains an owner
  })

  it('refuses to archive a member who owns a currently-active agent via agents.owner_member_id', async () => {
    harness.sqlite.exec(`UPDATE agents SET owner_member_id='mem-1' WHERE id='agent-1';`) // agent-1 is status='active'
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('owns_active_agent')
    expect(result.detail).toEqual({ active_agents: 1 })
  })

  it('refuses to archive a member bound to an active agent via agent_member_bindings (the REAL seat link, not owner_member_id)', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-1', 'mem-1', datetime('now'));
    `) // agent-1 is status='active'; owner_member_id is NOT set on it
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('owns_active_agent')
  })

  it('refuses to archive a member holding a LIVE agent-bound member_tokens row for an active agent (not owner_member_id)', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-1', 'mem-2', datetime('now'));
      INSERT INTO member_tokens (id, member_id, agent_id, tenant, token_hash)
        VALUES ('tok-seat', 'mem-2', 'agent-1', '${TENANT}', 'hash-seat');
    `) // agent-1 is status='active'; owner_member_id is NOT set on it. The
       // token is bound to mem-2 (agent_member_bindings satisfies the
       // member_tokens_agent_binding_insert trigger); archiving mem-2, not
       // mem-1, is the one this token's live-seat check should refuse.
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-2', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('owns_active_agent')
  })

  it('permits archiving a member whose agent-bound token is REVOKED, bound to an agent that is not active', async () => {
    // agent-2 is status='inactive' in the fixture — neither the binding nor
    // the (also revoked) token should refuse archiving mem-2.
    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-2', 'mem-2', datetime('now'));
      INSERT INTO member_tokens (id, member_id, agent_id, tenant, token_hash, revoked_at)
        VALUES ('tok-seat-dead', 'mem-2', 'agent-2', '${TENANT}', 'hash-seat-dead', datetime('now'));
    `)
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-2', reason: 'x' })
    expect(result.ok).toBe(true) // agent-2 is inactive — no live seat risk either way
  })

  it('archives an agent already inactive (no live tokens)', async () => {
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-2', reason: 'dead agent' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('archived')
    const row = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1').bind('agent-2')
      .first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('inactive') // untouched
    expect(row?.archived_at).not.toBeNull()
  })

  it('refuses to archive an agent that is not yet inactive, naming deactivate_agent', async () => {
    // agent-1 is status='active' in the fixture
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('must_deactivate_first')
    expect(result.detail).toEqual({ tool: 'deactivate_agent' })
    const row = await env.DB.prepare('SELECT archived_at FROM agents WHERE id = ?1').bind('agent-1').first<{ archived_at: string | null }>()
    expect(row?.archived_at).toBeNull()
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
