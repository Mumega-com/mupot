// tests/mubot-capability-floor.test.ts — FP-01 Slice 2 (mupot#1443, brief §2
// Task B). Mubot proposes; it never grants, mints, or merges (brief §4).
// This suite pins that as a TESTED floor, not a doc comment.
//
// MUBOT'S LIVE GRANT SHAPE (verified this session via mupot MCP
// `resolve_agent`/`get_agent_profile` against the live pot, 2026-09-21):
// agent id d3fd65b6-d514-46e6-9378-b1dcca2230cd, slug 'mubot', squad_id
// 'squad-core', role "VPS Hermes operator runtime", owner_member_id null.
// Those read-only tools do not expose the RBAC `capabilities`/`memberships`
// rows themselves (no generic SQL surface is offered over MCP), so the
// EXACT capability row could not be read directly — modeled here as the
// standard mint-time grant every squad-scoped agent gets (`member` on its
// own squad, src/members/agent-access.ts's addSquadMember default floor),
// with NO elevation grant on record (Mubot runs as a headless VPS operator
// with no interactive agent_sessions/elevation history). This is the
// STRONGER test of the two plausible readings — proving even a 'member'
// grant (not 'observer') cannot reach these surfaces.
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations via the shared
// routine-actions fixture helper for the ALLOWED case), invokeTool for every
// MCP call, mutation ledger for the manage_access flip.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import { hasElevatedAction } from '../src/auth/elevation'
import { submitRoutineProposal } from '../src/routines/actions'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

const TENANT = 'tenant-mubot'
const AGENT_ID = 'agent-mubot'
const MEMBER_ID = 'member-mubot'
const SQUAD_ID = 'squad-core'
const TARGET_SQUAD_ID = 'squad-target'
const DEPT_ID = 'dept-core'
const PROJECT_ID = 'project-psychonom'
const TOKEN_ID = 'token-mubot'

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_ID}', '${DEPT_ID}', 'squad-core', 'Squad Core'),
      ('${TARGET_SQUAD_ID}', '${DEPT_ID}', 'target', 'Target Squad');
    INSERT INTO projects (id, slug, name, status) VALUES ('${PROJECT_ID}', 'psychonom', 'Psychonom', 'active');

    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', 'mubot', 'mubot', 'active'),
      ('agent-other', '${SQUAD_ID}', 'other', 'Other Agent', 'active');
    INSERT INTO members (id, tenant, email, display_name, status) VALUES
      ('${MEMBER_ID}', '${TENANT}', NULL, 'mubot', 'active'),
      ('member-other', '${TENANT}', NULL, 'Other Agent Member', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', datetime('now')),
      ('${TENANT}', 'agent-other', 'member-other', datetime('now'));

    -- Mubot's ONLY standing grant: ordinary 'member' on its own squad.
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('mem-mubot-core', '${AGENT_ID}', '${SQUAD_ID}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-mubot-core', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
  `)
}

function mubotAuth(): AuthContext {
  return {
    userId: MEMBER_ID, email: null, role: 'member', tenant: TENANT,
    memberId: MEMBER_ID, channel: 'workspace', boundAgentId: AGENT_ID, tokenId: TOKEN_ID,
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

describe('Mubot capability floor (FP-01 Slice 2, mupot#1443, brief §2 Task B)', () => {
  let harness: SqliteD1Harness
  let env: Env

  afterEach(() => { try { harness?.close() } catch { /* already closed by a test using its own harness */ } })

  function setup(): void {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  }

  it('refuses project_squad_set outright — no elevation ever covers this tool (verified in src/mcp/projects.ts: requireWorkspaceAdmin only)', async () => {
    setup()
    const result = await invokeTool(mubotAuth(), env, 'project_squad_set', {
      project_id: PROJECT_ID, squad_id: TARGET_SQUAD_ID, access_level: 'write',
    })
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM project_squad_access WHERE project_id = '${PROJECT_ID}'`,
    ).get()).toEqual({ n: 0 })
  })

  it('refuses grant_agent_capability — bound-agent collapse gate, no live elevation grant on record', async () => {
    setup()
    const result = await invokeTool(mubotAuth(), env, 'grant_agent_capability', {
      agent: 'agent-other', squad: TARGET_SQUAD_ID, capability: 'admin',
    })
    // Refused at the shared AAGATE floor (src/mcp/index.ts invokeTool) before
    // the handler's own operator_principal_required check ever runs — the
    // floor never even resolves whether the target agent/squad exist.
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden', detail: { need: 'admin' } })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM capabilities WHERE scope_id = '${TARGET_SQUAD_ID}'`,
    ).get()).toEqual({ n: 0 })
  })

  it('refuses squad_member_add — EVERY bound-agent caller is refused unconditionally, before any target is resolved', async () => {
    setup()
    const result = await invokeTool(mubotAuth(), env, 'squad_member_add', {
      agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member',
    })
    // squad_member_add is NOT in ELEVATION_FLOOR_BYPASS_TOOLS at all — refused
    // at the same shared floor, no elevation escape hatch exists for it.
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden', detail: { need: 'lead' } })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM memberships WHERE squad_id = '${TARGET_SQUAD_ID}'`,
    ).get()).toEqual({ n: 0 })
  })

  it("holds no live elevation for action:manage_access on its own squad", async () => {
    setup()
    const elevated = await hasElevatedAction(env, mubotAuth(), 'action:manage_access', 'squad', SQUAD_ID, {
      toolName: 'test-floor-probe',
    })
    expect(elevated).toMatchObject({ granted: false })
  })

  it('MUTATION: granting Mubot a live action:manage_access elevation flips the grant_agent_capability refusal to allowed (proves the floor is load-bearing, not dead code)', async () => {
    setup()
    // Refused before the mutation (repeats the assertion above for a clean before/after pair).
    await expect(invokeTool(mubotAuth(), env, 'grant_agent_capability', {
      agent: 'agent-other', squad: TARGET_SQUAD_ID, capability: 'member',
    })).resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden', detail: { need: 'admin' } })

    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const future = new Date(now + 60 * 60 * 1000).toISOString()
    // A real approver: a member holding standing 'admin' on the target scope
    // (hasElevatedAction re-derives THIS live, not the grant row's frozen copy).
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('member-approver', '${TENANT}', 'approver@test.com', 'Approver', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-approver-core-admin', 'member-approver', 'squad', '${TARGET_SQUAD_ID}', 'admin');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, member_id, created_at)
        VALUES ('login-approver', '${TENANT}', 'test', 'approver-subject', 'member-approver', '${nowIso}');
      INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES ('web-session-approver', '${TENANT}', 'member-approver', 'login-approver', '${nowIso}', '${nowIso}', '${future}', '${future}');
      -- Mubot's own LIVE agent session (workspace-token auth, credential = its tokenId).
      INSERT INTO agent_sessions (id, tenant, agent_id, member_id, auth_kind, credential_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES ('session-mubot', '${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', 'workspace_token', '${TOKEN_ID}', '${nowIso}', '${nowIso}', '${future}', '${future}');
      INSERT INTO elevation_requests (
        id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
        requested_scope_type, requested_scope_id, requested_duration_minutes, reason,
        status, created_at, decision_expires_at, decided_at, decided_by_member_id, decided_by_web_session_hash
      ) VALUES (
        'req-manage-access', '${TENANT}', 'session-mubot', '${AGENT_ID}', '${MEMBER_ID}', '["action:manage_access"]',
        'squad', '${SQUAD_ID}', 60, 'FP-01 Slice 2 floor mutation test',
        'approved', '${nowIso}', '${future}', '${nowIso}', 'member-approver', 'web-session-approver'
      );
      INSERT INTO elevation_grants (
        id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id,
        effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at
      ) VALUES (
        'grant-manage-access', '${TENANT}', 'req-manage-access', 'session-mubot', 'action:manage_access', 'squad', '${TARGET_SQUAD_ID}',
        'reversible', 'member-approver', 'web-session-approver', '${nowIso}', '${future}'
      );
    `)

    // Independently: the floor probe now sees a live grant.
    const elevated = await hasElevatedAction(env, mubotAuth(), 'action:manage_access', 'squad', TARGET_SQUAD_ID, {
      toolName: 'test-floor-probe',
    })
    expect(elevated).toMatchObject({ granted: true })

    // The SAME call that was refused above now succeeds — RED->GREEN on the mutation.
    const afterMutation = await invokeTool(mubotAuth(), env, 'grant_agent_capability', {
      agent: 'agent-other', squad: TARGET_SQUAD_ID, capability: 'member',
    })
    expect(afterMutation.ok).toBe(true)
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities WHERE member_id = 'member-other' AND scope_id = '${TARGET_SQUAD_ID}'`,
    ).get()).toEqual({ capability: 'member' })
  })

  it('ALLOWS routine_proposal_submit with kind project_access under the exact same grant shape (member-only, no elevation)', async () => {
    // Reuses the routine-actions fixture: agent-1 on squad-1 holds ONLY
    // 'member' capability there (tests/helpers/routine-actions.ts) — the
    // same shape as Mubot above, exercised here via the actual proposal
    // submission path (routine_proposal_submit's MCP wrapper is a thin
    // pass-through to submitRoutineProposal, tested directly here and via
    // invokeTool in tests/mcp-routine-tools.test.ts).
    const fixture: ReadyRoutineFixture = await makeReadyRoutineFixture('propose')
    try {
      await harness2Member(fixture)
      const proposal = fixture.proposal({
        key: 'grant-1', kind: 'project_access',
        input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
      })
      const result = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(result).toMatchObject({ ok: true, status: 'waiting', reason: 'review' })
    } finally {
      fixture.harness.close()
    }
  })
})

async function harness2Member(fixture: ReadyRoutineFixture): Promise<void> {
  await fixture.env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('member-shadi', 'tenant-a', NULL, 'Shadi', 'active', datetime('now'))`,
  ).run()
}
