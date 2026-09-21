// tests/project-access-reintake-and-needs.test.ts — FP-01 Slice 2 v2
// (successor to PR #1488).
//
// P1-6: the human decision surface (IM /needs) must show
// member/project/access_level/reason BEFORE /approve is possible — "the
// human approved it" is not defensible when the channel never showed them
// what "it" is (ADVERSARIAL PATTERN LIBRARY finding 6, kasra-review
// 2026-09-21, PR #1488).
//
// P2-8: re-intake requires human word — project_access_reintake_authorize
// writes a receipted row that flips a member's intake_state back to
// 'pending' after a prior completion, and CANNOT be produced any other way
// (the ledger itself is append-only; there is no delete/rollback path).
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations, via the SAME shared
// makeReadyRoutineFixture helper tests/routine-project-access.test.ts uses)
// — fixture.harness.sqlite.prepare() below runs against that real,
// migrated schema, never a hand-rolled mock.
import { afterEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { submitRoutineProposal } from '../src/routines/actions'
import { invokeTool } from '../src/mcp'
import { handleImMessage, memberIntakeEnvelope } from '../src/im'
import type { AuthContext, Member } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

function row(fixture: ReadyRoutineFixture, sql: string): Record<string, unknown> | undefined {
  return fixture.harness.sqlite.prepare(sql).get() as Record<string, unknown> | undefined
}

async function seedMember(fixture: ReadyRoutineFixture, id: string): Promise<Member> {
  await fixture.env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`,
  ).bind(id, 'tenant-a', `Member ${id}`).run()
  return { id, email: null, display_name: `Member ${id}`, telegram_chat_id: null, status: 'active', created_at: new Date().toISOString() }
}

function grantProposal(overrides: Partial<{ member_id: string; project_id: string; access_level: 'read' | 'write' | 'admin'; reason: string }> = {}) {
  return {
    key: 'grant-1' as const, kind: 'project_access' as const,
    input: {
      member_id: 'member-shadi', project_id: 'project-1', access_level: 'write' as const,
      reason: 'onboarding — first project', ...overrides,
    },
  }
}

function orgAdminAuth(): AuthContext {
  return {
    userId: 'admin-1', email: 'admin@example.com', role: 'admin', tenant: 'tenant-a', memberId: 'admin-1',
    capabilities: [{ member_id: 'admin-1', scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

describe('FP-01 Slice 2 v2 — P1-6 (IM /needs shows the decision) and P2-8 (re-intake)', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => {
    fixture?.harness.close()
    fixture = undefined
  })

  it('/needs renders member, project, access_level, and reason for a pending project_access proposal', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')

    const proposal = fixture.proposal(grantProposal({ reason: 'onboarding — Psychonom kickoff' }))
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

    // A real Telegram-bound human decider: member+ on squad-1 (read
    // visibility) AND a gate:routines grant (the ONE thing that makes
    // 'approve' appear in their /needs listing at all — see actionsFor,
    // src/attention/service.ts).
    fixture.harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, telegram_chat_id, status, created_at)
      VALUES ('human-decider', 'tenant-a', 'decider@example.com', 'Decider', '555', 'active', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-decider', 'human-decider', 'squad', 'squad-1', 'member');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('decider-gate-routines', 'gate:routines', 'member', 'human-decider', 'test', datetime('now'));
    `)

    const reply = await handleImMessage(fixture.env, '555', '/needs')
    expect(reply).toContain('/approve control-task')
    expect(reply).toContain('write')
    expect(reply).toContain('Project One')
    expect(reply).toContain('member-shadi')
    expect(reply).toContain('onboarding — Psychonom kickoff')
  })

  it('project_access_reintake_authorize: an org admin may authorize re-intake; the derivation flips back to \'pending\' for messages AFTER it, never before', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')

    const proposal = fixture.proposal(grantProposal())
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)

    // 'complete' once the proposal exists (regardless of its verdict).
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toMatchObject({ intake_state: 'complete' })

    // A NON-admin, NON-gate-holder member is refused.
    const refused = await invokeTool(
      { userId: 'plain-1', email: null, role: 'member', tenant: 'tenant-a', memberId: 'plain-1', capabilities: [] },
      fixture.env, 'project_access_reintake_authorize',
      { member_id: 'member-shadi', reason: 'not my call' },
    )
    expect(refused.ok).toBe(false)

    // An agent-bound caller is refused unconditionally (human word only).
    const agentRefused = await invokeTool(
      { userId: 'agent-x', email: null, role: 'member', tenant: 'tenant-a', memberId: null, boundAgentId: 'agent-x', capabilities: [] },
      fixture.env, 'project_access_reintake_authorize',
      { member_id: 'member-shadi', reason: 'agents cannot authorize this' },
    )
    expect(agentRefused.ok).toBe(false)

    // The org admin authorizes re-intake, with a reason.
    const authorized = await invokeTool(orgAdminAuth(), fixture.env, 'project_access_reintake_authorize', {
      member_id: 'member-shadi', reason: 'member changed teams, needs a fresh onboarding conversation',
    })
    expect(authorized.ok).toBe(true)

    const receiptRow = row(
      fixture,
      `SELECT kind, member_id, decided_by, decided_via, reason, proposal_id, verdict_id, access_level
         FROM project_access_grant_receipts WHERE kind = 'reintake_authorized'`,
    )
    expect(receiptRow).toEqual({
      kind: 'reintake_authorized', member_id: 'member-shadi', decided_by: 'admin-1', decided_via: 'org_admin',
      reason: 'member changed teams, needs a fresh onboarding conversation',
      proposal_id: null, verdict_id: null, access_level: null,
    })

    // Derivation flips to 'pending' for any read AFTER the reintake row —
    // and this row is append-only (no delete/update path), so the flip is
    // durable, not a one-off race.
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toMatchObject({ intake_state: 'pending' })

    // A new completion fact AFTER the reintake row flips it back to
    // 'complete' — re-intake is not a one-way kill switch. Direct SQL
    // insert of a second 'grant' receipt (rather than a full second
    // routine proposal, which would first require resolving grant-1's
    // still-'waiting' action — a run accepts only one live proposal at a
    // time — an orthogonal mechanic to what this test is proving) keeps the
    // proof focused on the derivation's own AND-NOT-reintake-after logic.
    fixture.harness.sqlite.exec(`
      INSERT INTO project_access_grant_receipts (
        id, tenant, kind, project_id, squad_id, member_id, access_level,
        proposal_id, verdict_id, decided_by, decided_via, created_at
      ) VALUES (
        'receipt-second', 'tenant-a', 'grant', 'project-1', '${home.squad.id}', 'member-shadi', 'write',
        'proposal-second', 'verdict-second', 'owner-1', NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 second')
      );
    `)
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toMatchObject({ intake_state: 'complete' })
  })

  it('project_access_reintake_authorize refuses an unknown member and a blank reason', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const missingMember = await invokeTool(orgAdminAuth(), fixture.env, 'project_access_reintake_authorize', {
      member_id: 'ghost-member', reason: 'anything',
    })
    expect(missingMember.ok).toBe(false)

    await seedMember(fixture, 'member-shadi')
    const blankReason = await invokeTool(orgAdminAuth(), fixture.env, 'project_access_reintake_authorize', {
      member_id: 'member-shadi', reason: '   ',
    })
    expect(blankReason.ok).toBe(false)
    expect(row(fixture, "SELECT COUNT(*) AS n FROM project_access_grant_receipts")).toEqual({ n: 0 })
  })
})
