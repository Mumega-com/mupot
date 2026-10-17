// tests/attribution-followups-2009.test.ts — mupot#2009. (1) review-entry liveness: gate-holder AGENTS linked to the
// submission's consenting human are not eligible deciders, so the submit is refused up front; (2) the agent-decider
// KEY leg of the direct conflict. Real sqlite D1 + every migration; entered through invokeTool.

import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { findVerdictIndependenceConflict } from '../src/tasks/verdict-independence'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const SQUAD = 'squad-1'
const X = 'agent-x'
const OWNER = 'member-owner'
const H = 'member-h'
const X_MEMBER = 'member-x'
const TASK = 'task-1'
const T0 = '2026-10-01T00:00:00.000Z'
const SHA = '46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88'
const RESULT = `done\nArtifact: /tmp/m.txt\nSHA256: ${SHA}`

function fresh(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${X_MEMBER}', 'X', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${H}', 'H', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OWNER}', 'Owner', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES ('${X}', '${SQUAD}', 'x', 'X', 'active', '${OWNER}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-x', '${X_MEMBER}', 'squad', '${SQUAD}', 'admin');
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner, assignee_agent_id)
      VALUES ('${TASK}', '${SQUAD}', 't', 'b', 'in_progress', 'p', 'gate:agent-reviewer', '${X}');
  `)
  return { harness, env: { TENANT_SLUG: TENANT, DB: harness.db } as Env }
}

/** A live, credentialed gate-holder agent (the same shape the 2006 tests seed), optionally linked to a member. */
function seedGateAgent(sqlite: SqliteD1Harness['sqlite'], id: string, link?: { ownerMemberId?: string; boundMemberId?: string; keyMemberId?: string }): void {
  const bound = link?.boundMemberId ?? `member-${id}`
  sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES ('${id}', '${SQUAD}', '${id}', '${id}', 'active', ${link?.ownerMemberId ? `'${link.ownerMemberId}'` : 'NULL'});
    ${link?.boundMemberId ? '' : `INSERT INTO members (id, display_name, status, tenant) VALUES ('${bound}', 'G', 'active', '${TENANT}');`}
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-${id}', '${bound}', 'squad', '${SQUAD}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${id}', '${bound}', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
      VALUES ('tok-${id}', '${bound}', 'hash-${id}', 'gate', 'workspace', '${T0}', NULL, '${id}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-${id}', 'gate:agent-reviewer', 'agent', '${id}', '${OWNER}', '${T0}');
  `)
  if (link?.keyMemberId) {
    sqlite.exec(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', '${id}', 'pk-${id}', '${link.keyMemberId}', unixepoch())`)
  }
}

function auth(attached: boolean): AuthContext {
  const base: AuthContext = {
    userId: X_MEMBER, memberId: X_MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'directory',
    boundAgentId: X,
    capabilities: [{ member_id: X_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
  }
  if (!attached) return base
  return {
    ...base,
    consentedByMemberId: H,
    seatBinding: {
      seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: H, source: 'handle',
      attached: { attachmentId: 'attachment-1', admissionId: 'adm-1', agentId: X, seatAgentId: 'seat-agent', ceiling: 'member' },
    },
  }
}

const submit = (env: Env, a: AuthContext) => invokeTool(a, env, 'task_submit_result', { task_id: TASK, result: RESULT }, 'https://pot.test')

describe('review-entry liveness (#2009): gate-holder agents linked to the consenting human do not count', () => {
  it('H attaches, the only gate holder is an H-OWNED agent -> refused at submit (independent_gate_required), task stays in_progress', async () => {
    const { harness, env } = fresh()
    seedGateAgent(harness.sqlite, 'agent-gate', { ownerMemberId: H })
    expect(await submit(env, auth(true))).toMatchObject({ ok: false, error: 'independent_gate_required' })
    const row = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(TASK).first<{ status: string }>()
    expect(row?.status).toBe('in_progress')
  })

  it('same for an agent BOUND to H and an agent KEYED to H', async () => {
    for (const link of [{ boundMemberId: H }, { keyMemberId: H }]) {
      const { harness, env } = fresh()
      seedGateAgent(harness.sqlite, 'agent-gate', link)
      expect(await submit(env, auth(true))).toMatchObject({ ok: false, error: 'independent_gate_required' })
    }
  })

  it('an unrelated agent holder is accepted on the attached submit', async () => {
    const { harness, env } = fresh()
    seedGateAgent(harness.sqlite, 'agent-gate')
    const res = await submit(env, auth(true))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('one linked + one unrelated holder -> accepted (an eligible decider remains)', async () => {
    const { harness, env } = fresh()
    seedGateAgent(harness.sqlite, 'agent-linked', { ownerMemberId: H })
    seedGateAgent(harness.sqlite, 'agent-clean')
    const res = await submit(env, auth(true))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('non-attached submit is unchanged: an H-owned holder still counts', async () => {
    const { harness, env } = fresh()
    seedGateAgent(harness.sqlite, 'agent-gate', { ownerMemberId: H })
    const res = await submit(env, auth(false))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })
})

describe('agent-decider direct conflict, KEY leg (#2009)', () => {
  it('an agent keyed (agent_keys.member_id) to the consenting member conflicts; keyed to another member does not', async () => {
    const { harness, env } = fresh()
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-k1', '${SQUAD}', 'k1', 'k1', 'active');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-k2', '${SQUAD}', 'k2', 'k2', 'active');
      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', 'agent-k1', 'pk1', '${H}', unixepoch());
      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', 'agent-k2', 'pk2', '${OWNER}', unixepoch());
      INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, consenting_member_id)
        VALUES ('s1', '${TENANT}', '${TASK}', '${SQUAD}', '${X}', '/x', '${SHA}', '${SHA}', 'r', '${H}');
    `)
    expect(await findVerdictIndependenceConflict(env, 'agent-k1', TASK)).toBe('direct')
    expect(await findVerdictIndependenceConflict(env, 'agent-k2', TASK)).toBeNull()
  })
})
