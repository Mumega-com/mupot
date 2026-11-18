import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { listProjectActivity, listProjectEvidence } from '../src/projects/projections'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'continuity-project-test'
let harness: SqliteD1Harness

function env(): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as Env
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad', 'dept', 'squad', 'Squad');
    INSERT INTO members (id, display_name, status) VALUES ('human', 'Human', 'active'), ('agent-member', 'Agent member', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('sender', 'squad', 'sender', 'Sender', 'role', 'model', 'active'),
      ('recipient', 'squad', 'recipient', 'Recipient', 'role', 'model', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project', 'project', 'Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project', 'squad', 'read');
    INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind, grant_id, created_at)
      VALUES ('harness', '${TENANT}', 'human', 'client', 'Harness', 'test', 'oauth:grant', '2026-01-01 00:00:00');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'recipient', 'agent-member', '2026-01-01 00:00:00');
    INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live, created_at)
      VALUES ('seat', '${TENANT}', 'human', 'harness', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'recipient', 'seat', 1, '2026-01-01 00:00:00');
    INSERT INTO member_tokens (id, tenant, member_id, token_hash, label, channel, created_at, agent_id)
      VALUES ('grant', '${TENANT}', 'human', 'grant-hash', 'grant', 'directory', '2026-01-01 00:00:00', NULL),
             ('seat-token', '${TENANT}', 'agent-member', 'seat-hash', 'seat', 'directory', '2026-01-01 00:00:00', 'recipient');
    INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, gates, gate_authority, ceiling, requested_via, requested_seat_id, created_at, decided_at, decided_by_member_id, decided_via, scope, authority_level, authority_expires_at)
      VALUES ('admission', '${TENANT}', 'recipient', 'human', 'harness', 'live', 0, 0, 'member', 'tool', 'seat', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'human', 'webauthn', 'harness', 'helper', '2099-01-01 00:00:00');
    INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at)
      VALUES ('attachment', '${TENANT}', 'seat', 'human', 'harness', 'recipient', 'admission', 'seat-token', '2026-01-01 00:00:00');
    INSERT INTO agent_seat_authority_decisions (id, tenant, admission_id, attachment_id, seat_id, agent_id, harness_id, decided_by_member_id, authority_level, authority_expires_at, decided_at, decided_via, continuity_approved)
      VALUES ('decision', '${TENANT}', 'admission', 'attachment', 'seat', 'recipient', 'harness', 'human', 'helper', '2099-01-01 00:00:00', '2026-01-01 00:00:00', 'webauthn', 1);
    INSERT INTO attachment_continuity_scopes (id, tenant, admission_id, agent_id, human_member_id, harness_id, source_grant_token_id, authority_decision_id, created_at)
      VALUES ('scope', '${TENANT}', 'admission', 'recipient', 'human', 'harness', 'grant', 'decision', '2026-01-01 00:00:00');
    INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at, project_id, target_seat, target_continuity_scope_id)
      VALUES ('legacy-activity', '${TENANT}', 'recipient', 'sender', 'agent-member', 'request', 'legacy activity', '2026-02-01 00:00:00', 'project', NULL, NULL),
             ('scoped-activity', '${TENANT}', 'recipient', 'sender', 'agent-member', 'request', 'scoped activity', '2026-03-01 00:00:00', 'project', 'continuity:scope', 'scope'),
             ('legacy-ack', '${TENANT}', 'recipient', 'sender', 'agent-member', 'ack', 'legacy acknowledgement', '2026-01-02 00:00:00', 'project', NULL, NULL),
             ('scoped-ack', '${TENANT}', 'recipient', 'sender', 'agent-member', 'ack', 'scoped acknowledgement', '2026-01-03 00:00:00', 'project', 'continuity:scope', 'scope');
  `)
})

afterEach(() => harness.close())

describe('attachment continuity project projections', () => {
  it('keeps legacy messages but hides scoped activity and acknowledgement bodies for attached callers before paging', async () => {
    const input = { projectId: 'project', readableSquadIds: ['squad'], limit: 1 }

    const ordinaryActivity = await listProjectActivity(env(), input)
    const attachedActivity = await listProjectActivity(env(), { ...input, excludeContinuityScopedMessages: true })
    expect(ordinaryActivity.rows.map(row => row.source_id)).toEqual(['scoped-activity'])
    expect(attachedActivity.rows.map(row => row.source_id)).toEqual(['legacy-activity'])

    const ordinaryEvidence = await listProjectEvidence(env(), input)
    const attachedEvidence = await listProjectEvidence(env(), { ...input, excludeContinuityScopedMessages: true })
    expect(ordinaryEvidence.rows.filter(row => row.source_type === 'message_ack').map(row => row.source_id)).toEqual(['scoped-ack'])
    expect(attachedEvidence.rows.filter(row => row.source_type === 'message_ack').map(row => row.source_id)).toEqual(['legacy-ack'])
  })

  it.each(['project_get', 'project_context'])('%s carries the server-bound attachment exclusion into its situation', async (tool) => {
    const base: AuthContext = {
      userId: 'agent-member', memberId: 'agent-member', email: null, role: 'member', tenant: TENANT,
      channel: 'directory', boundAgentId: 'recipient',
      capabilities: [{ member_id: 'agent-member', scope_type: 'squad', scope_id: 'squad', capability: 'member' }],
    }
    const attached: AuthContext = {
      ...base,
      seatBinding: {
        seatId: 'seat', label: 'seat', harnessId: 'harness', grantTokenId: 'seat-token', humanMemberId: 'human', source: 'handle',
        attached: { attachmentId: 'attachment', admissionId: 'admission', agentId: 'recipient', seatAgentId: 'recipient', ceiling: 'member' },
      },
    }
    const ordinary = await invokeTool(base, env(), tool, { project_id: 'project' }, 'https://pot.test')
    const scoped = await invokeTool(attached, env(), tool, { project_id: 'project' }, 'https://pot.test')
    expect(ordinary).toMatchObject({ ok: true })
    expect(scoped).toMatchObject({ ok: true })
    const ordinaryActivity = (ordinary.result as { situation: { latest_activity: { source_id: string } | null } }).situation.latest_activity
    const attachedActivity = (scoped.result as { situation: { latest_activity: { source_id: string } | null } }).situation.latest_activity
    expect(ordinaryActivity?.source_id).toBe('scoped-activity')
    expect(attachedActivity?.source_id).toBe('legacy-activity')
  })
})
