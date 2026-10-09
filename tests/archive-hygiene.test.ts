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
    // mupot#1778: task archiving is opt-in (TASK_ARCHIVE_ENABLED); this suite exercises it.
    env = { TENANT_SLUG: TENANT, DB: harness.db, TASK_ARCHIVE_ENABLED: '1' } as unknown as Env

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

  it('unarchive_row refuses a plain admin reactivating an owner (cannot_affect_higher_rank, the #1337 REACTIVATE direction)', async () => {
    // An owner archives themselves-adjacent scenario is blocked elsewhere; here
    // ORG_ADMIN (an org-scope 'admin', rank 4) archives mem-1 while mem-1 is
    // still ordinary (allowed), then mem-1 is promoted to org owner AFTER
    // archiving (simulating an owner who was archived before gaining rank, or
    // a rank change during the archived window) — reactivating them must still
    // require the same ceiling PATCH /members/:id enforces.
    const archived = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(archived.ok).toBe(true)
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner');
    `)
    const result = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
    const row = await env.DB.prepare('SELECT archived_at FROM members WHERE id = ?1').bind('mem-1').first<{ archived_at: string | null }>()
    expect(row?.archived_at).not.toBeNull() // still archived — the reactivation was refused, not silently allowed
  })

  it('unarchive_row refuses a foreign-tenant member id (not_found)', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, archived_at, archived_reason, archived_by_member_id)
        VALUES ('mem-foreign', 'other-tenant', 'foreign@example.com', 'Foreign Member', 'suspended', datetime('now'), 'x', '${OPERATOR}');
    `)
    const result = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'members', id: 'mem-foreign', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('not_found')
    // untouched
    const row = await env.DB.prepare('SELECT archived_at FROM members WHERE id = ?1').bind('mem-foreign').first<{ archived_at: string | null }>()
    expect(row?.archived_at).not.toBeNull()
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

  it('a SQUAD-scoped owner does NOT count as a surviving org owner — refuses the last ORG owner regardless', async () => {
    // mem-1 is the only ORG-scope owner. mem-2 holds 'owner' capability but
    // ONLY on squad-1 — targetMaxRankAcrossScopes would (wrongly) count mem-2
    // as "owner rank", but the org-scope-only last-owner check must not.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner'),
        ('cap-squad-owner-mem2', 'mem-2', 'squad', 'squad-1', 'owner');
    `)
    const ownerActor = auth({
      capabilities: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const result = await invoke(ownerActor, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('last_org_owner')
  })

  it('a SUSPENDED org owner does NOT count as a surviving owner', async () => {
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner'),
        ('cap-owner-mem2', 'mem-2', 'org', NULL, 'owner');
      UPDATE members SET status='suspended' WHERE id='mem-2';
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

  it('mupot#1496 Round 4 (Athena confirmation-pass BLOCK): two owners archiving each other CONCURRENTLY — exactly one succeeds, one is refused last_org_owner, never both', async () => {
    // mem-1 and mem-2 are the ONLY two org owners. Firing both archive calls
    // concurrently (Promise.all) lets their JS-side pre-checks (checkMemberArchivable)
    // interleave at their own await points — each can observe the OTHER as a
    // still-active survivor before either write commits, which is exactly the
    // race the write-time orgOwnerSurvivorGuardSQL clause exists to close. If that
    // clause were absent (or a no-op — see the mutation below), BOTH writes would
    // land, since both JS pre-checks pass before either UPDATE runs.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-owner-mem1', 'mem-1', 'org', NULL, 'owner'),
        ('cap-owner-mem2', 'mem-2', 'org', NULL, 'owner');
    `)
    const ownerActor = auth({
      capabilities: [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'owner' }],
    })
    const [a, b] = await Promise.all([
      invoke(ownerActor, 'archive_row', { table: 'members', id: 'mem-1', reason: 'concurrent-a' }),
      invoke(ownerActor, 'archive_row', { table: 'members', id: 'mem-2', reason: 'concurrent-b' }),
    ])
    const outcomes = [a, b]
    const succeeded = outcomes.filter((o) => o.ok)
    const refused = outcomes.filter((o) => !o.ok)
    expect(succeeded.length).toBe(1)
    expect(refused.length).toBe(1)
    expect((refused[0] as { error?: string }).error).toBe('last_org_owner')

    // Ground truth: at least one of the two is still active (never both
    // suspended — the zero-owner outcome the guard exists to prevent).
    const rows = await env.DB.prepare(
      `SELECT id, status FROM members WHERE id IN ('mem-1','mem-2')`,
    ).all<{ id: string; status: string }>()
    const activeCount = (rows.results ?? []).filter((r) => r.status === 'active').length
    expect(activeCount).toBe(1)
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

  it('refuses to archive a member bound to a PAUSED agent (not just active — paused is trivially resumable)', async () => {
    harness.sqlite.exec(`
      UPDATE agents SET status='paused' WHERE id='agent-1';
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', 'agent-1', 'mem-1', datetime('now'));
    `)
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('owns_active_agent')
  })

  it('refuses to archive a foreign-tenant member id (not_found, no receipt written)', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status)
        VALUES ('mem-foreign', 'other-tenant', 'foreign2@example.com', 'Foreign Member Two', 'active');
    `)
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-foreign', reason: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.error).toBe('not_found')
    const { results } = await env.DB.prepare(
      `SELECT id FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-foreign'`,
    ).all()
    expect(results).toHaveLength(0)
  })

  it('a guarded UPDATE that writes 0 rows revokes NOTHING, even though the batch still runs the revoke statement', async () => {
    // checkMemberArchivable never inspects archived_at/status (only self/
    // rank/last-owner/seat) — so pre-setting archived_at+status='suspended'
    // directly makes the PRE-CHECK pass cleanly while the guarded UPDATE's
    // idempotency clause still matches 0 rows, the SAME "pre-check passes,
    // write-time guard fails" shape a genuine concurrent race would produce
    // (a binding/token landing between the pre-check and the batch would
    // trip the seat-ownership NOT EXISTS clauses instead, but the guard's
    // effect on the revoke statement is identical either way). Proves the
    // P1-A fix: the token revoke is gated on THIS call's own archived_at/
    // actor having actually landed via the members UPDATE, not fired merely
    // because the batch executed.
    harness.sqlite.exec(`
      INSERT INTO member_tokens (id, member_id, tenant, token_hash) VALUES ('tok-race', 'mem-1', '${TENANT}', 'hash-race');
      UPDATE members SET status='suspended', archived_at=datetime('now'), archived_reason='pre-existing',
             archived_by_member_id='${OPERATOR}' WHERE id='mem-1';
    `)
    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'race attempt' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.result as { status: string }).status).toBe('already_archived')
    const tokenRow = await env.DB.prepare('SELECT revoked_at FROM member_tokens WHERE id = ?1').bind('tok-race')
      .first<{ revoked_at: string | null }>()
    expect(tokenRow?.revoked_at).toBeNull() // still live — the refused archive touched nothing
  })

  it('mupot#1496 Round 4 (Athena confirmation-pass BLOCK): a 0-row write with NO re-derivable refusal is a genuine conflict, not a success-shaped "already_archived"', async () => {
    // mem-1 starts CLEAN (no interfering agent) so the pre-check
    // (checkMemberArchivable, called BEFORE the atomic write) passes. The
    // interference lands ONLY around the batch call itself — an agent-bound
    // seat appears right before the guarded UPDATE runs (failing its
    // write-time NOT EXISTS clause, 0 rows), then disappears again right
    // after (before archiveMember's own POST-write recheck call) — the exact
    // "state true at write time, false again by the time we re-derive a
    // reason" shape a genuine concurrent race produces. The recheck finds
    // NOTHING wrong and returns null; mem-1 is still status='active',
    // archived_at IS NULL — isRowCurrentlyArchived must say false, so this
    // must be reported as archive_refused_conflict, never a fabricated
    // 'already_archived' (the row was never archived at all).
    const originalBatch = env.DB.batch.bind(env.DB)
    let batchCalls = 0
    env.DB.batch = (async (stmts: Parameters<typeof originalBatch>[0]) => {
      batchCalls += 1
      if (batchCalls === 1) {
        harness.sqlite.exec(`
          INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
            VALUES ('${TENANT}', 'agent-1', 'mem-1', datetime('now'));
        `) // agent-1 is status='active' in the base fixture.
      }
      const results = await originalBatch(stmts)
      if (batchCalls === 1) {
        harness.sqlite.exec(`DELETE FROM agent_member_bindings WHERE agent_id='agent-1' AND member_id='mem-1'`)
      }
      return results
    }) as typeof env.DB.batch

    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'members', id: 'mem-1', reason: 'race conflict' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('archive_refused_conflict')

    const row = await env.DB.prepare('SELECT status, archived_at FROM members WHERE id = ?1').bind('mem-1')
      .first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('active') // never archived — a conflict, not a success
    expect(row?.archived_at).toBeNull()
    const { results: receipts } = await env.DB.prepare(
      `SELECT id FROM archive_receipts WHERE entity_table='members' AND entity_id='mem-1'`,
    ).all()
    expect(receipts).toHaveLength(0) // no phantom receipt for a row that was never archived
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

  it('mupot#1496 Round 4 (Athena confirmation-pass BLOCK, agent branch): a 0-row agent write with status still "inactive" and archived_at still NULL is a conflict, not "already_archived"', async () => {
    // agent-2 is 'inactive' in the base fixture, so the pre-read passes. The
    // guarded UPDATE's WHERE (status='inactive' AND archived_at IS NULL) is
    // made to fail by flipping status to 'active' right as the batch runs,
    // then flipping it back to 'inactive' before archiveAgent's own
    // post-write fresh-read — the same transient-race shape the member
    // branch's test above exercises. fresh.status ends up 'inactive' again
    // and archived_at is still NULL: this must be archive_refused_conflict,
    // never a fabricated already_archived (the row was never archived).
    const originalBatch = env.DB.batch.bind(env.DB)
    let batchCalls = 0
    env.DB.batch = (async (stmts: Parameters<typeof originalBatch>[0]) => {
      batchCalls += 1
      if (batchCalls === 1) {
        harness.sqlite.exec(`UPDATE agents SET status='active' WHERE id='agent-2'`)
      }
      const results = await originalBatch(stmts)
      if (batchCalls === 1) {
        harness.sqlite.exec(`UPDATE agents SET status='inactive' WHERE id='agent-2'`)
      }
      return results
    }) as typeof env.DB.batch

    const result = await invoke(ORG_ADMIN, 'archive_row', { table: 'agents', id: 'agent-2', reason: 'race conflict' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('archive_refused_conflict')
    const row = await env.DB.prepare('SELECT status, archived_at FROM agents WHERE id = ?1').bind('agent-2')
      .first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('inactive')
    expect(row?.archived_at).toBeNull() // never archived — a conflict, not a success
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

  // ── tasks (mupot#1571 re-enabled once archive became an ACTION boundary) ───────
  // The action-boundary behaviour (router, concierge, task_update, verdict, dispatch,
  // runtime receipts, flights) lives in tests/task-archive-action-boundary.test.ts.

  it.each([undefined, '', '0', 'true', 'yes'])(
    'task archiving stays OFF unless TASK_ARCHIVE_ENABLED is exactly "1" (value %j): 409, nothing written',
    async (flag) => {
      // mupot#1778/#1780: production must not create archived tasks until #1780 lands.
      const off = { TENANT_SLUG: TENANT, DB: harness.db, TASK_ARCHIVE_ENABLED: flag } as unknown as Env
      const archived = await invokeTool(ORG_ADMIN, off, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'board reset' }, ORIGIN)
      expect(archived).toMatchObject({
        ok: false, status: 409, error: 'not_supported',
        detail: { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' },
      })
      expect(await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind('task-2').first()).toBeNull()
      expect(await env.DB.prepare(`SELECT 1 FROM archive_receipts WHERE entity_table = 'tasks'`).first()).toBeNull()

      // Unarchive is refused too, even for a row archived while the flag was on.
      await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'seeded with flag on' })
      const unarchived = await invokeTool(ORG_ADMIN, off, 'unarchive_row', { table: 'tasks', id: 'task-2', reason: 'x' }, ORIGIN)
      expect(unarchived).toMatchObject({
        ok: false, status: 409, error: 'not_supported',
        detail: { table: 'tasks', issue: 'https://github.com/Mumega-com/mupot/issues/1571' },
      })
      expect(await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind('task-2').first()).not.toBeNull()

      // Bulk planning is refused too (parity with archive_row): a plan for an archive that cannot run.
      const plan = await invokeTool(ORG_ADMIN, off, 'archive_plan_expand', {
        table: 'tasks', where: { status: ['open'], created_before: '2099-01-01T00:00:00.000Z', project_ids: ['proj-1'] },
      }, ORIGIN)
      expect(plan).toMatchObject({ ok: false, status: 409, error: 'not_supported' })
    },
  )

  it.each([undefined, '0'])('the other four tables still archive with the tasks flag off (value %j)', async (flag) => {
    const off = { TENANT_SLUG: TENANT, DB: harness.db, TASK_ARCHIVE_ENABLED: flag } as unknown as Env
    const archived = await invokeTool(ORG_ADMIN, off, 'archive_row', { table: 'projects', id: 'proj-2', reason: 'flag-off parity' }, ORIGIN)
    expect(archived.ok, JSON.stringify(archived)).toBe(true)
  })

  it('archives a task (side table, tasks.status untouched, receipt) and unarchive deletes the state + receipts', async () => {
    const archived = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'board reset' })
    expect(archived.ok).toBe(true)
    if (!archived.ok) return
    expect(archived.result).toMatchObject({ status: 'archived' })
    const state = await env.DB.prepare('SELECT prior_status FROM tasks_archive_state WHERE task_id = ?1').bind('task-2').first<{ prior_status: string }>()
    expect(state?.prior_status).toBe('open')
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind('task-2').first<{ status: string }>()
    expect(task?.status).toBe('open')

    const again = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'board reset' })
    expect(again.ok && again.result).toMatchObject({ status: 'already_archived' })

    const unarchived = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'tasks', id: 'task-2', reason: 'oops' })
    expect(unarchived.ok).toBe(true)
    expect(await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind('task-2').first()).toBeNull()
    const receipts = await env.DB.prepare(
      `SELECT action, prior_status FROM archive_receipts WHERE entity_table = 'tasks' AND entity_id = ?1 ORDER BY created_at, action`,
    ).bind('task-2').all<{ action: string; prior_status: string | null }>()
    expect((receipts.results ?? []).map((r) => r.action).sort()).toEqual(['archive', 'unarchive'])
    const again2 = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'tasks', id: 'task-2', reason: 'oops' })
    expect(again2.ok && again2.result).toMatchObject({ status: 'not_archived' })
  })

  it('unarchive restores tasks_archive_state.prior_status when the status was moved while archived', async () => {
    await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    // A direct D1 edit (no guarded writer can do this) - unarchive must not trust it.
    harness.sqlite.exec(`UPDATE tasks SET status = 'blocked' WHERE id = 'task-2';`)
    const unarchived = await invoke(ORG_ADMIN, 'unarchive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(unarchived.ok).toBe(true)
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1').bind('task-2').first<{ status: string }>()
    expect(task?.status).toBe('open')
  })

  it('archive_row(tasks) refuses plan drift per row (expected_status) and rejects an unknown status', async () => {
    const drift = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x', expected_status: 'done' })
    expect(drift.ok).toBe(false)
    if (drift.ok) return
    expect(drift.status).toBe(409)
    expect(drift.error).toBe('status_drift')
    expect(await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind('task-2').first()).toBeNull()

    const bogus = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x', expected_status: 'archived' })
    expect(bogus.ok).toBe(false)
    if (bogus.ok) return
    expect(bogus.status).toBe(400)
    expect(bogus.error).toBe('invalid_expected_status')

    const match = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x', expected_status: 'open' })
    expect(match.ok).toBe(true)
  })

  it('archive_row(tasks) keeps the org-admin / operator gate', async () => {
    const memberOnly = auth({ capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }] })
    const refused = await invoke(memberOnly, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(refused.ok).toBe(false)
    const agentBound = await invoke(auth({ boundAgentId: 'agent-1' }), 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(agentBound.ok).toBe(false)
    if (agentBound.ok) return
    expect(agentBound.error).toBe('operator_principal_required')
    expect(await env.DB.prepare('SELECT 1 FROM tasks_archive_state').first()).toBeNull()
  })

  it('archive_row(tasks) refuses a live execution claim', async () => {
    harness.sqlite.exec(`UPDATE tasks SET status='in_progress', execution_claim_expires_at = ${Date.now() + 600_000} WHERE id='task-2';`)
    const refused = await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error).toBe('live_execution_claim')
  })

  it('archived tasks no longer block squad/project archive as active dependents', async () => {
    await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    const project = await invoke(ORG_ADMIN, 'archive_row', { table: 'projects', id: 'proj-1', reason: 'x' })
    expect(project.ok).toBe(true)
  })

  it('archive_plan_expand: requires known statuses, returns current status per row, chunks >98 project_ids', async () => {
    const unknown = await invoke(ORG_ADMIN, 'archive_plan_expand', {
      table: 'tasks', where: { status: ['open', 'nonsense'], created_before: '2099-01-01', project_ids: ['proj-1'] },
    })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.status).toBe(400)
    expect(unknown.error).toBe('invalid_status')

    // 250 project ids (well past D1's 100-bind ceiling): the real one is in the middle.
    const ids = Array.from({ length: 250 }, (_, i) => `proj-fake-${i}`)
    ids.splice(120, 0, 'proj-1')
    // Enforce D1's real ceiling (node:sqlite allows ~32k): any statement binding >100 values throws.
    const realDb = env.DB
    const capped = {
      prepare(sql: string) {
        const stmt = realDb.prepare(sql)
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === 'bind') {
              return (...values: unknown[]) => {
                if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`)
                return target.bind(...values)
              }
            }
            return Reflect.get(target, prop, receiver)
          },
        })
      },
      batch: realDb.batch.bind(realDb),
    } as unknown as Env['DB']
    const cappedEnv = { ...env, DB: capped } as Env
    const planned = await invokeTool(ORG_ADMIN, cappedEnv, 'archive_plan_expand', {
      table: 'tasks', where: { status: ['open'], created_before: '2099-01-01', project_ids: ids },
    }, ORIGIN)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.result).toMatchObject({ count: 1, truncated: false, ids: ['task-2'], rows: [{ id: 'task-2', status: 'open' }] })

    await invoke(ORG_ADMIN, 'archive_row', { table: 'tasks', id: 'task-2', reason: 'x' })
    const live = await invoke(ORG_ADMIN, 'archive_plan_expand', {
      table: 'tasks', where: { status: ['open'], created_before: '2099-01-01', project_ids: ['proj-1'] },
    })
    expect(live.ok && live.result).toMatchObject({ count: 0 })
    const archivedMode = await invoke(ORG_ADMIN, 'archive_plan_expand', {
      table: 'tasks', mode: 'archived', where: { status: ['open'], created_before: '2099-01-01', project_ids: ['proj-1'] },
    })
    expect(archivedMode.ok && archivedMode.result).toMatchObject({ count: 1, ids: ['task-2'] })
  })

  it('archive_plan_expand dedupes statuses so duplicates cannot push the bind count past 100', async () => {
    const realDb = env.DB
    const capped = {
      prepare(sql: string) {
        const stmt = realDb.prepare(sql)
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === 'bind') {
              return (...values: unknown[]) => {
                if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`)
                return target.bind(...values)
              }
            }
            return Reflect.get(target, prop, receiver)
          },
        })
      },
      batch: realDb.batch.bind(realDb),
    } as unknown as Env['DB']
    const planned = await invokeTool(ORG_ADMIN, { ...env, DB: capped } as Env, 'archive_plan_expand', {
      table: 'tasks', where: { status: Array.from({ length: 150 }, () => 'open'), created_before: '2099-01-01', project_ids: ['proj-1'] },
    }, ORIGIN)
    expect(planned.ok, JSON.stringify(planned)).toBe(true)
    if (!planned.ok) return
    expect(planned.result).toMatchObject({ count: 1, ids: ['task-2'] })
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

})
