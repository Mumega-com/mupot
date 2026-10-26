// tests/verdict-grant-admin-waiver.test.ts — the supervisory waiver must use the org-admin predicate the gate
// checks use (isOrgAdmin), not auth.role alone. Over MCP auth.role is always 'member', so a grant-based org admin
// who merely OWNS the assignee agent was refused self_verdict while a legacy-role admin passed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'grant-admin-waiver'
const SQUAD = 'squad-1'
const GATE = 'gate:review'
const TASK = 'task-1'

const caps = (memberId: string, extra: CapabilityGrant[] = []): CapabilityGrant[] => [
  { member_id: memberId, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }, ...extra,
]
const memberAuth = (memberId: string, extra: CapabilityGrant[] = []): AuthContext => ({
  userId: memberId, email: `${memberId}@test.com`, role: 'member', tenant: TENANT,
  memberId, capabilities: caps(memberId, extra), boundAgentId: null,
} as AuthContext)

describe('supervisory waiver uses isOrgAdmin (grant-based org admins pass)', () => {
  let harness: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    const s = harness.sqlite
    s.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
    `)
    s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('A', ?, 'a', 'A', 'member', 'test', 'active')`).run(SQUAD)
    for (const m of ['GADMIN', 'SQADMIN']) {
      s.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`).run(m, `${m}@test.com`, m, TENANT)
      s.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'member', ?, 'g', datetime('now'))`).run(`g-${m}`, GATE, m)
    }
    s.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
       VALUES (?, ?, 'T', 'b', 'done', 'review', ?, 'A', datetime('now'), datetime('now'))`,
    ).run(TASK, SQUAD, GATE)
  })
  afterEach(() => harness.close())

  const decide = (auth: AuthContext) =>
    invokeTool(auth, env, 'task_verdict', { task_id: TASK, verdict: 'approved' }, 'https://pot.test') as unknown as Promise<{ ok: boolean; error?: string }>

  it('an ORG-scope admin GRANT holder who owns the assignee agent passes (admin_supervisory), as the legacy role does', async () => {
    harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'GADMIN' WHERE id = 'A'`).run()
    const res = await decide(memberAuth('GADMIN', [{ member_id: 'GADMIN', scope_type: 'org', scope_id: null, capability: 'admin' }]))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('a SQUAD-scope admin grant does not make an org admin: still self_verdict', async () => {
    harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'SQADMIN' WHERE id = 'A'`).run()
    const res = await decide(memberAuth('SQADMIN', [{ member_id: 'SQADMIN', scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }]))
    expect(res).toMatchObject({ ok: false, error: 'self_verdict' })
  })

  it('an AGENT-bound token carrying an admin member envelope never gets the human waiver', async () => {
    // AG is owned by GADMIN; the task is a human task assigned to GADMIN, so AG (acting for its owner) is affiliated.
    const s = harness.sqlite
    s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('AG', ?, 'ag', 'AG', 'member', 'test', 'active', 'GADMIN')`).run(SQUAD)
    s.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-ag', ?, 'agent', 'AG', 'g', datetime('now'))`).run(GATE)
    s.prepare(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'GADMIN' WHERE id = ?`).run(TASK)
    const envelope = (role: 'member' | 'admin'): AuthContext => ({
      userId: 'agent:AG', email: null, role, tenant: TENANT, memberId: 'token-minter', boundAgentId: 'AG',
      capabilities: caps('token-minter', [{ member_id: 'token-minter', scope_type: 'org', scope_id: null, capability: 'admin' }]),
    } as AuthContext)
    for (const role of ['member', 'admin'] as const) {
      expect(await decide(envelope(role)), role).toMatchObject({ ok: false, error: 'self_verdict' })
    }
    expect((s.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get() as { n: number }).n).toBe(0)
  })
})
