// tests/verdict-owner-self.test.ts — mom-walk D1 (mupot task 7ae27377): an owner (a member) may give the verdict on
// their OWN agent's task result, with a distinct auditable waiver 'owner_self' on the verdict row.
//
// Floors that must keep refusing (each has a negative test below):
//   the agent itself / any agent that is a party; an attached seat acting for the human (pinned in
//   tests/seat-attach.test.ts "builder != gate: refused on the ATTACHING HUMAN's own work ... an agent they own");
//   a member who is NOT the owner (another member, a key minter, a bound member); a forged waiver at the write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/auth')>()
  return {
    ...orig,
    requireAuth: async (c: { req: { header: (n: string) => string | undefined }; set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', JSON.parse(c.req.header('x-test-auth') ?? '{}'))
      await next()
    },
  }
})

import { invokeTool } from '../src/mcp/index'
import { evaluateVerdictGates, tasksApp } from '../src/tasks'
import { hasIndependentRuntimeGate } from '../src/tasks/runtime-receipts'
import { VerdictIndependenceError, writeVerdict } from '../src/tasks/service'
import type { AuthContext, CapabilityGrant, Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'owner-self'
const SQUAD = 'squad-1'
const GATE = 'gate:review'
const TASK = 'task-1'
const ORIGIN = 'https://pot.test'

const floor = (memberId: string): CapabilityGrant[] => [{ member_id: memberId, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }]
const memberAuth = (memberId: string): AuthContext => ({
  userId: memberId, email: `${memberId}@test.com`, role: 'member', tenant: TENANT,
  memberId, capabilities: floor(memberId), boundAgentId: null,
} as AuthContext)
const agentAuth = (agentId: string): AuthContext => ({
  userId: `agent:${agentId}`, email: null, role: 'member', tenant: TENANT,
  memberId: 'token-minter', capabilities: floor('token-minter'), boundAgentId: agentId,
} as AuthContext)

describe('mom-walk D1: owner_self verdict waiver', () => {
  let harness: SqliteD1Harness
  let env: Env
  const sql = () => harness.sqlite
  const task = (): Task => sql().prepare('SELECT * FROM tasks WHERE id = ?').get(TASK) as unknown as Task
  const rows = (): number => (sql().prepare('SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?').get(TASK) as { n: number }).n
  const waiver = (): string | null => (sql().prepare('SELECT independence_waiver AS w FROM task_verdicts WHERE task_id = ?').get(TASK) as { w: string | null } | undefined)?.w ?? null
  const status = (): string => (sql().prepare('SELECT status FROM tasks WHERE id = ?').get(TASK) as { status: string }).status
  const decide = (auth: AuthContext, extra: Record<string, unknown> = {}) =>
    invokeTool(auth, env, 'task_verdict', { task_id: TASK, verdict: 'approved', ...extra }, ORIGIN) as unknown as Promise<{ ok: boolean; status?: number; error?: string }>
  let seq = 0
  const submit = (id: string, text: string): void => {
    seq += 1
    sql().prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
       VALUES (?, ?, ?, ?, 'A', '/tmp/x', ?, ?, ?, ?)`,
    ).run(id, TENANT, TASK, SQUAD, '9f'.repeat(32), seq.toString(16).padStart(64, '0'), text, new Date(Date.UTC(2026, 9, 20, 0, 0, seq)).toISOString())
    sql().prepare('UPDATE tasks SET result = ? WHERE id = ?').run(text, TASK)
  }
  const currentSub = (): { id: string; digest: string } => {
    const r = sql().prepare('SELECT s.id AS id, s.result_digest AS digest FROM task_result_submissions s WHERE s.task_id = ? ORDER BY s.created_at DESC LIMIT 1').get(TASK) as { id: string; digest: string }
    return r
  }
  const lens = (reviewer: string, name: string, outcome: 'pass' | 'fail' = 'pass', kind: 'agent' | 'member' = 'agent'): void => {
    const sub = currentSub()
    seq += 1
    sql().prepare(
      `INSERT INTO task_review_lenses (id, task_id, submission_id, result_digest, gate_owner, lens, reviewer_kind, reviewer_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`lens-${seq}`, TASK, sub.id, sub.digest, GATE, name, kind, reviewer, outcome, new Date().toISOString())
  }
  const dropLenses = (): void => { sql().exec('DROP TRIGGER IF EXISTS task_review_lenses_no_delete'); sql().exec('DELETE FROM task_review_lenses') }
  const rest = (auth: AuthContext, body: unknown): Promise<Response> =>
    tasksApp.fetch(new Request(`https://pot.test/${TASK}/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(auth), Origin: ORIGIN },
      body: JSON.stringify(body),
    }), env)

  const gateTask = () => ({ id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: 'A' })

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    sql().exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
    `)
    // A: the assignee, owned by OWN. S: a second agent owned by SOMEONE ELSE (OTHER_OWNER). G: an independent gate agent.
    for (const a of ['A', 'S', 'G', 'L1', 'L2', 'OWN_AGENT']) {
      sql().prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')`).run(a, SQUAD, a.toLowerCase(), a)
    }
    for (const m of ['OWN', 'OTHER_OWNER', 'MINTER', 'BOUND', 'STRANGER', 'OWN_KEYS_S']) {
      sql().prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`).run(m, `${m}@test.com`, m, TENANT)
      sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'member', ?, 'g', datetime('now'))`).run(`g-${m}`, GATE, m)
    }
    for (const a of ['A', 'S', 'G', 'L1', 'L2', 'OWN_AGENT']) {
      sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'agent', ?, 'g', datetime('now'))`).run(`ga-${a}`, GATE, a)
    }
    sql().prepare(`UPDATE agents SET owner_member_id = 'OWN' WHERE id = 'A'`).run()
    sql().prepare(`UPDATE agents SET owner_member_id = 'OTHER_OWNER' WHERE id = 'S'`).run()
    sql().prepare(`UPDATE agents SET owner_member_id = 'OWN' WHERE id = 'OWN_AGENT'`).run() // another agent of the same owner
    sql().prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'A', 'pk1', 'MINTER', unixepoch())`).run(TENANT)
    sql().prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'A', 'BOUND', datetime('now'))`).run(TENANT)
    sql().prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
       VALUES (?, ?, 'T', 'b', 'done', 'review', ?, 'A', datetime('now'), datetime('now'))`,
    ).run(TASK, SQUAD, GATE)
    // A produced the CURRENT submission; two independent lens reviewers (L1, L2: agents holding the lane, unrelated to OWN
    // and to the task) have passed it. Every test below starts from "the owner may decide" and takes one thing away.
    submit('sub-cur', 'RESULT-1')
    lens('L1', 'correctness')
    lens('L2', 'adversarial')
  })
  afterEach(() => harness.close())

  describe('allowed', () => {
    it('the OWNER of the assignee agent approves via task_verdict; the verdict row records waiver owner_self', async () => {
      const res = await decide(memberAuth('OWN'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(status()).toBe('approved')
      expect(rows()).toBe(1)
      expect(waiver()).toBe('owner_self')
    })

    it('the owner may reject too (same rule, same waiver)', async () => {
      const res = await decide(memberAuth('OWN'), { verdict: 'rejected' })
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(waiver()).toBe('owner_self')
    })

    it('the pre-check (the read side behind can_approve) agrees with the write: allowed with owner_self', async () => {
      expect(await evaluateVerdictGates(env, memberAuth('OWN'), gateTask(), 'approved')).toMatchObject({ allowed: true, independenceWaiver: 'owner_self' })
    })

    it('an independent verdict carries NO waiver (column NULL)', async () => {
      const res = await decide(agentAuth('G'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(waiver()).toBeNull()
    })

    it('the existing "review" precondition is untouched: a task NOT in review refuses the owner (no verdict row)', async () => {
      sql().prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(TASK)
      const res = await decide(memberAuth('OWN'))
      expect(res.ok).toBe(false)
      expect(rows()).toBe(0)
    })

    it('the owner still needs the gate lane: without a gate grant they are refused (no_gate_capability), owner_self grants no lane', async () => {
      sql().prepare(`DELETE FROM gate_grants WHERE principal_id = 'OWN'`).run()
      expect(await evaluateVerdictGates(env, memberAuth('OWN'), gateTask(), 'approved')).toMatchObject({ allowed: false, code: 'no_gate_capability' })
      expect((await decide(memberAuth('OWN'))).ok).toBe(false)
      expect(rows()).toBe(0)
    })
  })

  describe('floors that keep refusing', () => {
    it('the assignee agent itself', async () => {
      expect(await decide(agentAuth('A'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('an agent that is a party (submitted a result, then was reassigned off) cannot decide, even though its owner could', async () => {
      sql().prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
         VALUES ('sub-1', ?, ?, ?, 'S', '/tmp/x', ?, ?)`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      expect(await decide(agentAuth('S'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('a member who merely MINTED a key for the agent but is not the owner (issue #2094)', async () => {
      expect(await decide(memberAuth('MINTER'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('a member BOUND to the agent (the agent\'s own identity)', async () => {
      expect(await decide(memberAuth('BOUND'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('the OWNER who is also the agent\'s bound member is refused: bound means the agent grading itself', async () => {
      sql().prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('A2', ?, 'a2', 'A2', 'member', 'test', 'active', 'OWN')`).run(SQUAD)
      sql().prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'A2', 'OWN', datetime('now'))`).run(TENANT)
      sql().prepare(`UPDATE tasks SET assignee_agent_id = 'A2' WHERE id = ?`).run(TASK)
      expect(await decide(memberAuth('OWN'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('an owner of A who ALSO holds a key to ANOTHER party agent (S) they do not own is refused: the exemption needs ownership of EVERY party agent they are tied to', async () => {
      sql().prepare(`UPDATE agents SET owner_member_id = 'OWN_KEYS_S' WHERE id = 'A'`).run()
      sql().prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'S', 'pk2', 'OWN_KEYS_S', unixepoch())`).run(TENANT)
      sql().prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
         VALUES ('sub-1', ?, ?, ?, 'S', '/tmp/x', ?, ?)`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      expect(await decide(memberAuth('OWN_KEYS_S'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('the owner who is a DIRECT party (consented to the submission) is refused: owner_self never waives direct', async () => {
      sql().prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, consenting_member_id)
         VALUES ('sub-1', ?, ?, ?, 'S', '/tmp/x', ?, ?, 'OWN')`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      expect(await decide(memberAuth('OWN'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('a member deciding on ANOTHER member\'s agent gets no waiver: the owner of a different agent is independent, and the row says so', async () => {
      const res = await decide(memberAuth('OTHER_OWNER'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(waiver()).toBeNull() // independent, not exempted
    })
  })

  describe('the WRITE chokepoint re-asserts it (a caller cannot just claim the waiver)', () => {
    it('a forged owner_self waiver for the key minter, the bound member and a stranger-owner of a party agent is refused by the UPDATE\'s own WHERE', async () => {
      for (const decidedBy of ['MINTER', 'BOUND']) {
        await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy, independenceWaiver: 'owner_self' }), decidedBy)
          .rejects.toBeInstanceOf(VerdictIndependenceError)
      }
      expect(rows()).toBe(0)
      expect(status()).toBe('review')
    })

    it('a forged owner_self waiver for an AGENT decider (the assignee) is refused', async () => {
      await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'A', independenceWaiver: 'owner_self' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError)
      expect(rows()).toBe(0)
    })

    it('without the waiver the owner is refused at the write (the caller must carry it), with it the verdict lands and records it', async () => {
      await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'OWN' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError)
      const out = await writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'OWN', independenceWaiver: 'owner_self' })
      expect(out.verdict.independence_waiver).toBe('owner_self')
      expect(waiver()).toBe('owner_self')
    })

    it('ownership lost between the pre-check and the write (agent transferred) refuses the owner_self write', async () => {
      const t = task()
      // The agent is transferred away, but OWN still holds a key to it: affiliated, no longer the owner.
      sql().prepare(`UPDATE agents SET owner_member_id = 'OTHER_OWNER' WHERE id = 'A'`).run()
      sql().prepare(`UPDATE agent_keys SET member_id = 'OWN' WHERE agent_id = 'A'`).run()
      await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'OWN', independenceWaiver: 'owner_self' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError)
      expect(rows()).toBe(0)
    })

    it('the verdict row\'s waiver column is append-only', async () => {
      await decide(memberAuth('OWN'))
      expect(() => sql().exec(`UPDATE task_verdicts SET independence_waiver = NULL WHERE task_id = '${TASK}'`)).toThrow(/append-only/)
    })
  })

  describe('lens evidence is required, current, independent and live', () => {
    const refusedAndUntouched = async (auth: AuthContext = memberAuth('OWN')) => {
      expect(await decide(auth)).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
      expect(status()).toBe('review')
    }

    it('no lenses at all', async () => { dropLenses(); await refusedAndUntouched() })
    it('only ONE passing lens', async () => { dropLenses(); lens('L1', 'correctness'); await refusedAndUntouched() })
    it('two lenses from the SAME reviewer do not count as two reviewers', async () => { dropLenses(); lens('L1', 'correctness'); lens('L1', 'adversarial'); await refusedAndUntouched() })
    it('two reviewers under the SAME lens name do not count as two lenses', async () => { dropLenses(); lens('L1', 'correctness'); lens('L2', 'correctness'); await refusedAndUntouched() })
    it('a later FAIL by a reviewer withdraws their earlier pass', async () => { lens('L1', 'correctness', 'fail'); await refusedAndUntouched() })
    it('a fail from any eligible reviewer blocks, even with two passes', async () => { lens('G', 'security', 'fail'); await refusedAndUntouched() })
    it('a later pass after a fail restores that reviewer (latest row per reviewer+lens wins)', async () => {
      lens('L1', 'correctness', 'fail'); lens('L1', 'correctness', 'pass')
      expect((await decide(memberAuth('OWN'))).ok).toBe(true)
    })

    it('STALE: a NEW submission orphans every earlier lens (lenses bind the submission id and digest)', async () => {
      submit('sub-new', 'RESULT-2')
      await refusedAndUntouched()
      lens('L1', 'correctness'); lens('L2', 'adversarial') // re-reviewed on the new content
      expect((await decide(memberAuth('OWN'))).ok).toBe(true)
    })

    it('STALE: lenses on the right submission id but a DIFFERENT digest do not count', async () => {
      sql().exec('DROP TRIGGER task_review_lenses_no_update')
      sql().prepare(`UPDATE task_review_lenses SET result_digest = ?`).run('ee'.repeat(32))
      await refusedAndUntouched()
    })

    it('re-gating the task (changing the reviewer lane) orphans lenses recorded for the old lane', async () => {
      sql().prepare(`UPDATE tasks SET gate_owner = 'gate:other' WHERE id = ?`).run(TASK)
      sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('go', 'gate:other', 'member', 'OWN', 'g', datetime('now'))`).run()
      for (const r of ['L1', 'L2']) { // the same reviewers also hold the NEW lane: only the lens's recorded lane can orphan it
        sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, 'gate:other', 'agent', ?, 'g', datetime('now'))`).run(`go-${r}`, r)
      }
      await refusedAndUntouched()
    })

    it('SELF-AUTHORED: a lens from another agent OWNED by the deciding owner does not count', async () => {
      dropLenses(); lens('L1', 'correctness'); lens('OWN_AGENT', 'adversarial')
      await refusedAndUntouched()
    })

    it('SELF-AUTHORED: a lens from an agent the owner holds a KEY to does not count', async () => {
      sql().prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'L2', 'pk-l2', 'OWN', unixepoch())`).run(TENANT)
      await refusedAndUntouched()
    })

    it('SELF-AUTHORED: a lens from the owner themself, or from the task\'s own party (the producing agent A), does not count', async () => {
      dropLenses(); lens('L1', 'correctness'); lens('OWN', 'adversarial', 'pass', 'member')
      await refusedAndUntouched()
      dropLenses(); lens('L1', 'correctness'); lens('A', 'adversarial')
      await refusedAndUntouched()
    })

    it('PARTY: a lens from a task party NOT linked to the owner (S, a past submitter owned by someone else) does not count', async () => {
      sql().prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
         VALUES ('sub-old', ?, ?, ?, 'S', '/tmp/x', ?, ?, 'OLD', '2026-10-19T00:00:00.000Z')`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      submit('sub-cur2', 'RESULT-1') // the current submission again, AFTER S\\'s earlier one
      dropLenses(); lens('L1', 'correctness'); lens('S', 'adversarial')
      await refusedAndUntouched()
    })

    it('LIVE: a reviewer who lost the gate lane no longer counts', async () => {
      sql().prepare(`DELETE FROM gate_grants WHERE principal_id = 'L2'`).run()
      await refusedAndUntouched()
    })

    it('LIVE: a deactivated reviewer agent no longer counts', async () => {
      sql().prepare(`UPDATE agents SET status = 'paused' WHERE id = 'L1'`).run()
      await refusedAndUntouched()
    })

    it('the ledger is append-only', () => {
      expect(() => sql().exec(`UPDATE task_review_lenses SET outcome = 'pass'`)).toThrow(/append-only/)
      expect(() => sql().exec(`DELETE FROM task_review_lenses`)).toThrow(/append-only/)
    })
  })

  describe('every surface agrees (REST API, MCP, pre-check, write, Telegram origin is in task-verdict-human-origin)', () => {
    it('REST POST /:id/verdict: the owner with lenses is approved and the waiver recorded; without lenses 409 self_verdict', async () => {
      dropLenses()
      const no = await rest(memberAuth('OWN'), { verdict: 'approved' })
      expect(no.status).toBe(409)
      expect(await no.json()).toMatchObject({ error: 'self_verdict' })
      expect(rows()).toBe(0)
      lens('L1', 'correctness'); lens('L2', 'adversarial')
      const ok = await rest(memberAuth('OWN'), { verdict: 'approved' })
      expect(ok.status, await ok.clone().text()).toBe(201)
      expect(waiver()).toBe('owner_self')
    })

    it('REST: a key minter, a bound member and the agent itself stay 409 even with lenses', async () => {
      for (const who of [memberAuth('MINTER'), memberAuth('BOUND'), agentAuth('A')]) {
        const r = await rest(who, { verdict: 'approved' })
        expect(r.status).toBe(409)
        expect(await r.json()).toMatchObject({ error: 'self_verdict' })
      }
      expect(rows()).toBe(0)
    })

    it('an agent token carrying an ADMIN member envelope never gets a human waiver (admin_supervisory nor owner_self)', async () => {
      // AG2 is owned by OWN; the task is a HUMAN task assigned to OWN: the agent acts for its owner (affiliated).
      sql().prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('AG2', ?, 'ag2', 'AG2', 'member', 'test', 'active', 'OWN')`).run(SQUAD)
      sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('ga-ag2', ?, 'agent', 'AG2', 'g', datetime('now'))`).run(GATE)
      sql().prepare(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'OWN' WHERE id = ?`).run(TASK)
      const adminEnvelope: AuthContext = {
        ...agentAuth('AG2'), role: 'admin',
        capabilities: [...floor('token-minter'), { member_id: 'token-minter', scope_type: 'org', scope_id: null, capability: 'admin' }],
      } as AuthContext
      expect(await evaluateVerdictGates(env, adminEnvelope, { id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: null }, 'approved'))
        .toMatchObject({ allowed: false, code: 'self_verdict' })
      expect(await decide(adminEnvelope)).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
    })

    it('exceptions are not widened: the self-completion lane does not admit the owner even with lenses present', async () => {
      sql().prepare(`UPDATE tasks SET gate_owner = 'gate:agent-self-completion' WHERE id = ?`).run(TASK)
      const res = await decide(memberAuth('OWN'))
      expect(res.ok).toBe(false)
      expect(rows()).toBe(0)
    })
  })

  describe('lens recording (task_review_lens)', () => {
    const record = (auth: AuthContext, args: Record<string, unknown> = {}) =>
      invokeTool(auth, env, 'task_review_lens', { task_id: TASK, lens: 'security', outcome: 'pass', expected_submission_id: currentSub().id, ...args }, ORIGIN) as unknown as Promise<{ ok: boolean; status?: number; error?: string }>
    const lensRows = (): number => (sql().prepare('SELECT COUNT(*) AS n FROM task_review_lenses').get() as { n: number }).n

    it('an independent lane holder records a lens on the current submission', async () => {
      const before = lensRows()
      const res = await record(agentAuth('G'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(lensRows()).toBe(before + 1)
    })

    it.each([
      ['member', 'pass'], ['member', 'fail'], ['agent', 'pass'], ['agent', 'fail'],
    ] as const)('requires task-squad membership for a %s recording a %s lens', async (kind, outcome) => {
      dropLenses()
      sql().prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('other-squad', 'dept-1', 'other', 'Other')`).run()
      const auth = kind === 'member' ? memberAuth('STRANGER') : agentAuth('G')
      auth.capabilities = floor(auth.memberId!).map((grant) => ({ ...grant, scope_id: 'other-squad' }))
      expect(await record(auth, { outcome })).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
      expect(lensRows()).toBe(0)
      expect(await decide(memberAuth('OWN'))).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(rows()).toBe(0)
      expect(status()).toBe('review')
    })

    it('requires member access on the task squad even for an independent lane holder with observer access', async () => {
      const auth = memberAuth('STRANGER')
      auth.capabilities = floor('STRANGER').map((grant) => ({ ...grant, capability: 'observer' }))
      const before = lensRows()
      expect(await record(auth)).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
      expect(lensRows()).toBe(before)
    })

    it.each(['department', 'org'] as const)('accepts task-squad member access inherited from %s', async (scopeType) => {
      const auth = memberAuth('STRANGER')
      auth.capabilities = [{ member_id: 'STRANGER', scope_type: scopeType, scope_id: scopeType === 'org' ? null : 'dept-1', capability: 'member' }]
      const before = lensRows()
      expect(await record(auth)).toMatchObject({ ok: true })
      expect(lensRows()).toBe(before + 1)
    })

    it('refuses: a party to the task (the producing agent, a key minter), a non-holder, a stale submission id, a task not in review', async () => {
      const before = lensRows()
      expect((await record(agentAuth('A'))).ok).toBe(false)
      expect((await record(memberAuth('MINTER'))).ok).toBe(false)
      expect((await record(memberAuth('STRANGER'), {})).ok).toBe(true) // STRANGER holds the lane and is independent: control
      expect(lensRows()).toBe(before + 1)
      expect(await record(agentAuth('G'), { expected_submission_id: 'sub-old' })).toMatchObject({ ok: false, status: 409, error: 'submission_mismatch' })
      sql().prepare(`DELETE FROM gate_grants WHERE principal_id = 'G'`).run()
      expect((await record(agentAuth('G'))).ok).toBe(false)
      sql().prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(TASK)
      expect(await record(memberAuth('STRANGER'))).toMatchObject({ ok: false, status: 409, error: 'not_in_review' })
    })

    it('end to end: lenses recorded through the tool unlock the owner, and the owner cannot mint their own lens', async () => {
      dropLenses()
      expect((await record(memberAuth('OWN'))).ok).toBe(false) // a party (owner) is not an independent lens
      await record(agentAuth('L1'), { lens: 'correctness' })
      await record(agentAuth('L2'), { lens: 'adversarial' })
      const res = await decide(memberAuth('OWN'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(waiver()).toBe('owner_self')
    })

    it('the self-completion lane takes no lenses', async () => {
      sql().prepare(`UPDATE tasks SET gate_owner = 'gate:agent-self-completion' WHERE id = ?`).run(TASK)
      expect(await record(agentAuth('G'))).toMatchObject({ ok: false, error: 'dedicated_lane' })
    })
  })

  describe('RACES between the pre-check and the write each fail atomically (no verdict row, task stays in review)', () => {
    const owner = memberAuth('OWN')
    const precheckThenWrite = async (disturb: () => void): Promise<unknown> => {
      const gate = await evaluateVerdictGates(env, owner, gateTask(), 'approved')
      expect(gate).toMatchObject({ allowed: true, independenceWaiver: 'owner_self' })
      const t = task()
      disturb()
      return writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'OWN', independenceWaiver: 'owner_self' })
    }
    const assertAtomic = (): void => {
      expect(rows()).toBe(0)
      expect(status()).toBe('review')
    }

    it('a reviewer\'s lane is revoked', async () => {
      await expect(precheckThenWrite(() => sql().prepare(`DELETE FROM gate_grants WHERE principal_id = 'L1'`).run())).rejects.toBeInstanceOf(Error)
      assertAtomic()
    })
    it('a reviewer flips to fail', async () => {
      await expect(precheckThenWrite(() => lens('L2', 'adversarial', 'fail'))).rejects.toBeInstanceOf(Error)
      assertAtomic()
    })
    it('ownership changes (agent transferred; owner keeps only a key)', async () => {
      await expect(precheckThenWrite(() => {
        sql().prepare(`UPDATE agents SET owner_member_id = 'OTHER_OWNER' WHERE id = 'A'`).run()
        sql().prepare(`UPDATE agent_keys SET member_id = 'OWN' WHERE agent_id = 'A'`).run()
      })).rejects.toBeInstanceOf(VerdictIndependenceError)
      assertAtomic()
    })
    it('the submission is replaced', async () => {
      await expect(precheckThenWrite(() => submit('sub-new', 'RESULT-2'))).rejects.toBeInstanceOf(Error)
      assertAtomic()
    })
    it('the task is re-gated', async () => {
      await expect(precheckThenWrite(() => sql().prepare(`UPDATE tasks SET gate_owner = 'gate:other' WHERE id = ?`).run(TASK))).rejects.toBeInstanceOf(Error)
      assertAtomic()
    })
    it('control: with no disturbance the same sequence lands', async () => {
      await expect(precheckThenWrite(() => undefined)).resolves.toMatchObject({ verdict: { independence_waiver: 'owner_self' } })
    })
  })

  describe('review entry is NOT widened', () => {
    const humanGate = (holder: string) => {
      sql().prepare(`DELETE FROM gate_grants WHERE capability = ? AND principal_type = 'agent'`).run(GATE)
      sql().prepare(`DELETE FROM gate_grants WHERE capability = ? AND principal_type = 'member'`).run(GATE)
      sql().prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('only', ?, 'member', ?, 'g', datetime('now'))`).run(GATE, holder)
      sql().prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', ?, 'member')`).run(`cap-${holder}`, holder, SQUAD)
      return hasIndependentRuntimeGate(env, GATE, 'A', SQUAD, { allowMemberHolders: true })
    }
    it('a task whose ONLY human gate holder is the agent\'s owner still cannot enter review (an independent reviewer must exist for the lenses)', async () => {
      expect(await humanGate('OWN')).toBe(false)
    })
    it('an unrelated human holder still can', async () => {
      expect(await humanGate('STRANGER')).toBe(true)
    })
  })
})
