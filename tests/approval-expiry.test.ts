// tests/approval-expiry.test.ts — an unanswered gate ask expires (migrations/0232, src/gates/approval-expiry*.ts).
//
// Real SQLite + the full migration chain. The shared predicate, the verdict refusal, the sweep
// (transition, receipt, notify), gate_owner_dead vs approval_expired, the resubmit cap, idempotence,
// dry-run and archived-task behaviour are each proven here; the PR description lists the mutations
// (predicate in the verdict path, the cap) that make a named test fail.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { writeVerdict, persistTaskUpdate, ApprovalExpiredError, TaskUpdateConflictError } from '../src/tasks/service'
import {
  APPROVAL_EXPIRY,
  GATE_ASK_LIVE_PREDICATE,
  sweepExpiredApprovals,
  runApprovalExpiryTick,
  resetResubmitCap,
} from '../src/gates/approval-expiry'
import { loadApprovals } from '../src/dashboard/approvals'
import { listNeedsYou } from '../src/attention/service'
import { routinePrincipal } from '../src/routines/access'
import type { AuthContext, CapabilityGrant, Env, Task } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const OPERATOR = 'member-operator'
const DECIDER = 'member-decider'
const SQUAD = 'squad-1'
const LANE = 'gate:athena'
const BUILDER = 'agent-builder'
const SEAT = 'agent-seat'
const DAY = 86_400_000

const iso = (ms: number): string => new Date(ms).toISOString()
const ago = (days: number, extraMs = 0): string => iso(Date.now() - days * DAY - extraMs)

function operator(opts: { boundAgentId?: string | null; capabilities?: CapabilityGrant[]; role?: 'owner' | 'member' } = {}): AuthContext {
  return {
    userId: 'operator-caller',
    email: 'operator@example.com',
    role: opts.role ?? 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId: OPERATOR,
    capabilities: opts.capabilities ?? [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

describe('approval expiry', () => {
  let harness: SqliteD1Harness
  let env: Env
  const sql = harness_sql
  function harness_sql(q: string, ...args: unknown[]): unknown[] {
    return harness.sqlite.prepare(q).all(...args)
  }
  const one = (q: string, ...args: unknown[]): Record<string, unknown> => harness.sqlite.prepare(q).get(...args) as Record<string, unknown>
  const task = (id: string): Record<string, unknown> => one('SELECT * FROM tasks WHERE id = ?', id)
  const receipts = (id?: string) => sql(`SELECT * FROM approval_expiry_receipts ${id ? 'WHERE task_id = ?' : ''} ORDER BY seq`, ...(id ? [id] : [])) as Array<Record<string, unknown>>
  const asTask = (id: string): Task => task(id) as unknown as Task // fixture row read straight from the tasks table

  // A review task whose ask entered review `days` ago (review_entered_at is what the clock reads;
  // updated_at is deliberately FRESH, as after a stall rewake).
  function seedReview(id: string, days: number, opts: { gateOwner?: string | null; assignee?: string | null; extraMs?: number } = {}): void {
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, updated_at)
       VALUES (?, ?, ?, 'b', 'done', 'review', ?, ?, ?)`,
    ).run(id, SQUAD, `Task ${id}`, opts.gateOwner === undefined ? LANE : opts.gateOwner, opts.assignee === undefined ? BUILDER : opts.assignee, iso(Date.now()))
    harness.sqlite.prepare('UPDATE tasks SET review_entered_at = ? WHERE id = ?').run(ago(days, opts.extraMs ?? 0), id)
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('${OPERATOR}', '${TENANT}', 'op@example.com', 'Operator', 'active');
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('${DECIDER}', '${TENANT}', 'dec@example.com', 'Decider', 'active');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${BUILDER}', '${SQUAD}', 'builder', 'builder', 'active');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${SEAT}', '${SQUAD}', 'seat', 'seat', 'active');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('g1', '${LANE}', 'agent', '${SEAT}', 'owner-1', '2026-08-15T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op', '${OPERATOR}', 'org', NULL, 'admin');
    `)
  })
  afterEach(() => {
    vi.useRealTimers()
    harness.close()
  })

  describe('review_entered_at (the clock)', () => {
    it('is stamped on every transition INTO review and survives updated_at bumps', () => {
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id)
        VALUES ('t1', '${SQUAD}', 'T', 'b', 'done', 'in_progress', '${BUILDER}')`)
      expect(task('t1').review_entered_at).toBeNull()
      harness.sqlite.exec(`UPDATE tasks SET status = 'review', gate_owner = '${LANE}' WHERE id = 't1'`)
      const entered = task('t1').review_entered_at as string
      expect(entered).toMatch(/^\d{4}-\d\d-\d\dT/)
      // A stall rewake / notice bumps updated_at; the entry time must not move.
      harness.sqlite.exec(`UPDATE tasks SET updated_at = '2030-01-01T00:00:00.000Z', gate_wake_notice = 'x' WHERE id = 't1'`)
      expect(task('t1').review_entered_at).toBe(entered)
    })

    it('is stamped on INSERT as review too', () => {
      seedReview('t2', 0)
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner) VALUES ('t3', '${SQUAD}', 'T', 'b', 'done', 'review', '${LANE}')`)
      expect(task('t3').review_entered_at).toBeTruthy()
    })

    const backfillSql = (): string => {
      const migration = readFileSync(join(__dirname, '..', 'migrations', '0232_approval_expiry.sql'), 'utf8')
      return migration.slice(migration.indexOf('-- BACKFILL-BEGIN'), migration.indexOf('-- BACKFILL-END'))
    }
    const submission = (id: string, taskId: string, at: string): string =>
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, created_at)
         VALUES ('${id}', '${TENANT}', '${taskId}', '${SQUAD}', '${BUILDER}', 'a.md', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '${at}');`

    it('backfill: the LATER of (latest entry event, updated_at) - never earlier than updated_at', () => {
      for (const id of ['b-later-event', 'b-earlier-event', 'b-none']) seedReview(id, 0)
      harness.sqlite.exec(`
        UPDATE tasks SET updated_at = '2026-09-20T00:00:00.000Z', review_entered_at = NULL;
        ${submission('s1', 'b-later-event', '2026-09-25T10:00:00.000Z')}
        ${submission('s2', 'b-earlier-event', '2026-09-01T10:00:00.000Z')}`)
      harness.sqlite.exec(backfillSql())
      expect(task('b-later-event').review_entered_at).toBe('2026-09-25T10:00:00.000Z')
      expect(task('b-earlier-event').review_entered_at).toBe('2026-09-20T00:00:00.000Z')
      expect(task('b-none').review_entered_at).toBe('2026-09-20T00:00:00.000Z')
    })

    it('backfill repro: submitted 20d ago, CI-fail bounce, re-entered 3d ago by a receiptless writer - the first sweep must NOT block it', async () => {
      seedReview('bounced', 0)
      const reentered = ago(3)
      harness.sqlite.exec(`
        UPDATE tasks SET updated_at = '${reentered}', review_entered_at = NULL WHERE id = 'bounced';
        ${submission('s-old', 'bounced', ago(20))}`)
      harness.sqlite.exec(backfillSql())
      expect(task('bounced').review_entered_at).toBe(reentered)
      const res = await sweepExpiredApprovals(env)
      expect(res.expired).toBe(0)
      expect(task('bounced').status).toBe('review')
    })
  })

  describe('shared predicate GATE_ASK_LIVE_PREDICATE', () => {
    it('is strict at the window: live strictly before entered+14d, expired at exactly the window', () => {
      const entered = '2026-10-01T00:00:00.000Z'
      const at = (now: string): number => {
        const q = `SELECT ${GATE_ASK_LIVE_PREDICATE('t', `'${now}'`)} AS live FROM (SELECT '${entered}' AS review_entered_at, '2030-01-01T00:00:00.000Z' AS updated_at, 'gate:x' AS gate_owner) t`
        return (harness.sqlite.prepare(q).get() as { live: number }).live
      }
      expect(at('2026-10-14T23:59:59.000Z')).toBe(1)
      expect(at('2026-10-15T00:00:00.000Z')).toBe(0)
      expect(at('2026-10-15T00:00:01.000Z')).toBe(0)
    })

    it('reads review_entered_at, NOT updated_at', () => {
      seedReview('old', APPROVAL_EXPIRY.gate_verdict_days + 1) // updated_at fresh, entry old
      expect(one(`SELECT ${GATE_ASK_LIVE_PREDICATE('tasks', "datetime('now')")} AS live FROM tasks WHERE id = 'old'`).live).toBe(0)
    })

    it('refuses a caller-shaped now / alias (no string reaches the statement)', () => {
      expect(() => GATE_ASK_LIVE_PREDICATE('t', "'x'); DROP TABLE tasks;--")).toThrow('invalid_gate_ask_now_sql')
      expect(() => GATE_ASK_LIVE_PREDICATE('t; --', "datetime('now')")).toThrow('invalid_gate_ask_alias')
    })

    it('read side and verdict agree at the boundary (visible+approvable just inside, hidden+refused just outside)', async () => {
      const days = APPROVAL_EXPIRY.gate_verdict_days
      seedReview('inside', days, { extraMs: -60_000 }) // 1 minute of life left
      seedReview('outside', days, { extraMs: 60_000 }) // expired 1 minute ago
      const owner = { userId: 'o', memberId: OPERATOR, email: null, role: 'owner', tenant: TENANT, channel: 'workspace', boundAgentId: null } as AuthContext
      const queue = await loadApprovals(env, owner)
      const ids = JSON.stringify(queue)
      expect(ids).toContain('inside')
      expect(ids).not.toContain('"id":"outside"')
      await expect(writeVerdict(env, { task: asTask('inside'), verdict: 'approved', note: 'ok', decidedBy: DECIDER })).resolves.toBeTruthy()
      await expect(writeVerdict(env, { task: asTask('outside'), verdict: 'approved', note: 'ok', decidedBy: DECIDER })).rejects.toBeInstanceOf(ApprovalExpiredError)
    })

    it('Needs You (read side) hides an expired ask too', async () => {
      harness.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('p1', 'p1', 'P', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', '${SQUAD}', 'write');`)
      seedReview('live', 1)
      seedReview('dead', APPROVAL_EXPIRY.gate_verdict_days + 1)
      harness.sqlite.exec(`UPDATE tasks SET project_id = 'p1'`)
      const auth = { userId: 'o', memberId: 'o', email: null, role: 'owner', tenant: TENANT, channel: 'workspace', boundAgentId: null } as AuthContext
      const items = (await listNeedsYou(env, routinePrincipal(auth), { view: 'stuck', auth }, new Date().toISOString())).items
      const sources = items.map((i) => i.source_id)
      expect(sources).toContain('live')
      expect(sources).not.toContain('dead')
    })
  })

  describe('a verdict after expiry is refused', () => {
    it('writeVerdict throws ApprovalExpiredError, writes no verdict, task stays in review', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      await expect(writeVerdict(env, { task: asTask('t1'), verdict: 'approved', note: 'late', decidedBy: DECIDER }))
        .rejects.toBeInstanceOf(ApprovalExpiredError)
      expect(task('t1').status).toBe('review')
      expect(sql('SELECT * FROM task_verdicts WHERE task_id = ?', 't1')).toHaveLength(0)
    })

    it('a REJECT after expiry is refused too (the ask is gone, not just approvable)', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      await expect(writeVerdict(env, { task: asTask('t1'), verdict: 'rejected', note: 'late', decidedBy: DECIDER }))
        .rejects.toBeInstanceOf(ApprovalExpiredError)
    })

    it('task_verdict over MCP answers approval_expired (409)', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      const out = await invokeTool(operator({ role: 'owner' }), env, 'task_verdict', { task_id: 't1', verdict: 'approved', note: 'late' }, ORIGIN)
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.status).toBe(409)
        expect(out.error).toBe('approval_expired')
      }
      expect(task('t1').status).toBe('review')
    })
  })

  describe('the sweep', () => {
    it('moves an expired ask review -> blocked, receipts it (system:sweeper), notifies the assignee', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      const res = await sweepExpiredApprovals(env, { via: 'cron' })
      expect(res).toMatchObject({ scanned: 1, expired: 1, approval_expired: 1, gate_owner_dead: 0, notified: 1, errors: 0, dry_run: false })
      expect(task('t1')).toMatchObject({ status: 'blocked', expired_count: 1 })
      expect(String(task('t1').gate_wake_notice)).toContain('approval expired unanswered')
      const [r] = receipts('t1')
      expect(r).toMatchObject({
        task_id: 't1', from_status: 'review', to_status: 'blocked', reason: 'approval_expired',
        actor: 'system:sweeper', via: 'cron', expired_count_after: 1, notify_target: BUILDER, gate_owner: LANE,
      })
      expect(r.created_at).toBeTruthy()
      expect(r.expires_at).toBeTruthy()
      const msg = one(`SELECT body, to_agent FROM agent_messages WHERE request_id LIKE 'approval-expired:t1:%'`)
      expect(msg.to_agent).toBe(BUILDER)
      expect(String(msg.body)).toContain('approval expired unanswered')
      // never a verdict
      expect(sql('SELECT * FROM task_verdicts WHERE task_id = ?', 't1')).toHaveLength(0)
    })

    it('does not touch a live ask, a task without a gate, or a non-review task', async () => {
      seedReview('young', 13)
      seedReview('nogate', 30, { gateOwner: null })
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, updated_at) VALUES ('open1', '${SQUAD}', 'T', 'b', 'd', 'open', '${LANE}', '2020-01-01T00:00:00.000Z')`)
      const res = await sweepExpiredApprovals(env)
      expect(res.scanned).toBe(0)
      expect(task('young').status).toBe('review')
      expect(task('nogate').status).toBe('review')
    })

    it('a stall-rewake bump of updated_at does NOT extend the ask', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      harness.sqlite.exec(`UPDATE tasks SET updated_at = '${iso(Date.now())}'`)
      expect((await sweepExpiredApprovals(env)).expired).toBe(1)
    })

    it('classifies: gate with grants but no live holder = gate_owner_dead; no grants or live holder = approval_expired', async () => {
      harness.sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-gone', '${SQUAD}', 'gone', 'gone', 'paused');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g2', 'gate:dead', 'agent', 'agent-gone', 'o', '2026-08-15T00:00:00.000Z');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g3', 'gate:ghost', 'agent', 'agent-missing', 'o', '2026-08-15T00:00:00.000Z');`)
      const d = APPROVAL_EXPIRY.gate_verdict_days + 1
      seedReview('dead-paused', d, { gateOwner: 'gate:dead' })
      seedReview('dead-missing', d, { gateOwner: 'gate:ghost' })
      seedReview('live-holder', d) // LANE has an active seat
      seedReview('admin-lane', d, { gateOwner: 'gate:routines' }) // no grants at all: org-admin lane, live admin exists
      seedReview('revoked', d, { gateOwner: 'gate:revoked' }) // grants all revoked + (below) no live admin => dead
      const res0 = await sweepExpiredApprovals(env, { dryRun: true })
      expect(res0).toMatchObject({ expired: 5, gate_owner_dead: 2, approval_expired: 3 }) // with a live org admin, a grantless lane is just unanswered
      harness.sqlite.exec(`DELETE FROM capabilities WHERE id = 'cap-op'`)
      const res = await sweepExpiredApprovals(env)
      expect(res).toMatchObject({ expired: 5, gate_owner_dead: 4, approval_expired: 1 })
      expect(receipts('admin-lane')[0].reason).toBe('gate_owner_dead')
      expect(receipts('revoked')[0].reason).toBe('gate_owner_dead')
      expect(receipts('dead-paused')[0].reason).toBe('gate_owner_dead')
      expect(receipts('dead-missing')[0].reason).toBe('gate_owner_dead')
      expect(receipts('live-holder')[0].reason).toBe('approval_expired')
    })

    it('an archived task is untouched (no transition, no receipt, no notice)', async () => {
      seedReview('arch', APPROVAL_EXPIRY.gate_verdict_days + 5)
      harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
        VALUES ('arch', '${iso(Date.now())}', 'housekeeping', '${OPERATOR}', 'review')`)
      const res = await sweepExpiredApprovals(env)
      expect(res.scanned).toBe(0)
      expect(task('arch')).toMatchObject({ status: 'review', expired_count: 0 })
      expect(receipts()).toHaveLength(0)
    })

    it('an archive landing between the scan and the write is a no-op (guard is in the UPDATE)', async () => {
      seedReview('race', APPROVAL_EXPIRY.gate_verdict_days + 5)
      const realPrepare = harness.db.prepare.bind(harness.db)
      let archived = false
      const spyDb = new Proxy(harness.db, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (q: string) => {
              if (!archived && q.includes(`SET status = 'blocked'`)) {
                archived = true
                harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
                  VALUES ('race', '${iso(Date.now())}', 'r', '${OPERATOR}', 'review')`)
              }
              return realPrepare(q)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const res = await sweepExpiredApprovals({ ...env, DB: spyDb } as Env)
      expect(res).toMatchObject({ expired: 0, skipped_claimed: 1 })
      expect(task('race').status).toBe('review')
      expect(receipts()).toHaveLength(0)
    })

    it('is idempotent: a re-run transitions nothing and writes no second receipt', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      expect((await sweepExpiredApprovals(env)).expired).toBe(1)
      const again = await sweepExpiredApprovals(env)
      expect(again).toMatchObject({ scanned: 0, expired: 0 })
      expect(receipts('t1')).toHaveLength(1)
      expect(task('t1').expired_count).toBe(1)
    })

    it('two concurrent sweeps transition exactly once', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      const [a, b] = await Promise.all([sweepExpiredApprovals(env), sweepExpiredApprovals(env)])
      expect(a.expired + b.expired).toBe(1)
      expect(receipts('t1')).toHaveLength(1)
      expect(task('t1').expired_count).toBe(1)
    })

    it('is bounded per run and reports what remains', async () => {
      for (let i = 0; i < 5; i += 1) seedReview(`t${i}`, APPROVAL_EXPIRY.gate_verdict_days + 1 + i)
      const first = await sweepExpiredApprovals(env, { limit: 2 })
      expect(first).toMatchObject({ scanned: 2, expired: 2, remaining: 3 })
      const second = await sweepExpiredApprovals(env, { limit: 10 })
      expect(second).toMatchObject({ expired: 3, remaining: 0 })
    })

    it('dry-run writes nothing', async () => {
      seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
      seedReview('t2', APPROVAL_EXPIRY.gate_verdict_days + 2, { gateOwner: 'gate:routines' })
      const dump = () => JSON.stringify([
        sql('SELECT * FROM tasks ORDER BY id'),
        sql('SELECT * FROM approval_expiry_receipts'),
        sql('SELECT * FROM agent_messages'),
      ])
      const before = dump()
      const res = await sweepExpiredApprovals(env, { dryRun: true })
      expect(res).toMatchObject({ dry_run: true, scanned: 2, expired: 2, approval_expired: 2, notified: 0 })
      expect(dump()).toBe(before)
    })
  })

  describe('resubmit cap', () => {
    const expireOnce = async (id: string): Promise<void> => {
      harness.sqlite.prepare('UPDATE tasks SET review_entered_at = ? WHERE id = ?').run(ago(APPROVAL_EXPIRY.gate_verdict_days + 1), id)
      expect((await sweepExpiredApprovals(env)).expired).toBe(1)
    }
    const resubmit = async (id: string): Promise<void> => {
      // blocked -> in_progress -> review through the REAL update path.
      const inProgress = { ...asTask(id), status: 'in_progress' as const }
      await persistTaskUpdate(env, asTask(id), inProgress)
      await persistTaskUpdate(env, asTask(id), { ...asTask(id), status: 'review' })
    }

    it('two resubmissions after expiry are fine; the third is refused with resubmit_cap_needs_human', async () => {
      expect(APPROVAL_EXPIRY.resubmit_cap).toBe(2)
      seedReview('t1', 0)
      await expireOnce('t1') // expiry 1
      await resubmit('t1')
      expect(task('t1').status).toBe('review')
      await expireOnce('t1') // expiry 2
      expect(task('t1').expired_count).toBe(2)
      const inProgress = { ...asTask('t1'), status: 'in_progress' as const }
      await persistTaskUpdate(env, asTask('t1'), inProgress)
      await expect(persistTaskUpdate(env, asTask('t1'), { ...asTask('t1'), status: 'review' }))
        .rejects.toMatchObject({ code: 'resubmit_cap_needs_human' })
      await expect(persistTaskUpdate(env, asTask('t1'), { ...asTask('t1'), status: 'review' })).rejects.toBeInstanceOf(TaskUpdateConflictError)
      expect(task('t1').status).toBe('in_progress')
    })

    it('the trigger itself refuses a raw write to review at the cap (no writer can route around it)', () => {
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, expired_count)
        VALUES ('t9', '${SQUAD}', 'T', 'b', 'd', 'in_progress', '${BUILDER}', ${APPROVAL_EXPIRY.resubmit_cap})`)
      expect(() => harness.sqlite.exec(`UPDATE tasks SET status = 'review' WHERE id = 't9'`)).toThrow('resubmit_cap_needs_human')
      harness.sqlite.exec(`UPDATE tasks SET expired_count = ${APPROVAL_EXPIRY.resubmit_cap - 1} WHERE id = 't9'`)
      expect(() => harness.sqlite.exec(`UPDATE tasks SET status = 'review' WHERE id = 't9'`)).not.toThrow()
    })

    it('a verdict reversal back to review is not a resubmission (human act, not capped)', () => {
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, expired_count)
        VALUES ('t8', '${SQUAD}', 'T', 'b', 'd', 'rejected', '${LANE}', 5)`)
      expect(() => harness.sqlite.exec(`UPDATE tasks SET status = 'review' WHERE id = 't8'`)).not.toThrow()
    })

    it('the migration literal and APPROVAL_EXPIRY.resubmit_cap are the same number', () => {
      const migration = readFileSync(join(__dirname, '..', 'migrations', '0232_approval_expiry.sql'), 'utf8')
      expect(migration).toContain(`OLD.expired_count >= ${APPROVAL_EXPIRY.resubmit_cap}`)
    })

    it('approval_resubmit_cap_reset: operator org-admin only, receipted, lets the task resubmit', async () => {
      seedReview('t1', 0)
      await expireOnce('t1')
      await resubmit('t1')
      await expireOnce('t1')
      await persistTaskUpdate(env, asTask('t1'), { ...asTask('t1'), status: 'in_progress' })
      const agentCall = await invokeTool(operator({ boundAgentId: BUILDER }), env, 'approval_resubmit_cap_reset', { task_id: 't1' }, ORIGIN)
      expect(agentCall.ok).toBe(false)
      const memberCall = await invokeTool(operator({ capabilities: [] }), env, 'approval_resubmit_cap_reset', { task_id: 't1' }, ORIGIN)
      expect(memberCall.ok).toBe(false)
      expect(task('t1').expired_count).toBe(2)
      const ok = await invokeTool(operator(), env, 'approval_resubmit_cap_reset', { task_id: 't1' }, ORIGIN)
      expect(ok.ok).toBe(true)
      expect(task('t1').expired_count).toBe(0)
      expect(receipts('t1').filter((r) => r.reason === 'resubmit_cap_reset')).toHaveLength(1)
      await persistTaskUpdate(env, asTask('t1'), { ...asTask('t1'), status: 'review' })
      expect(task('t1').status).toBe('review')
    })
  })

  describe('approval_expiry_sweep (one-time backfill through the same transition code)', () => {
    it('defaults to dry run, records dead vs expired distinctly when it acts, refuses agent-bound and non-admin callers', async () => {
      harness.sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-gone', '${SQUAD}', 'gone', 'gone', 'paused');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g2', 'gate:dead', 'agent', 'agent-gone', 'o', '2026-08-15T00:00:00.000Z');`)
      seedReview('a', APPROVAL_EXPIRY.gate_verdict_days + 3)
      seedReview('b', APPROVAL_EXPIRY.gate_verdict_days + 3, { gateOwner: 'gate:dead' })

      const noArgs = await invokeTool(operator(), env, 'approval_expiry_sweep', {}, ORIGIN)
      expect(noArgs.ok && noArgs.result).toMatchObject({ dry_run: true, expired: 2, approval_expired: 1, gate_owner_dead: 1 })
      expect(task('a').status).toBe('review')
      expect(receipts()).toHaveLength(0)

      expect((await invokeTool(operator({ boundAgentId: BUILDER }), env, 'approval_expiry_sweep', { dry_run: false }, ORIGIN)).ok).toBe(false)
      expect((await invokeTool(operator({ capabilities: [] }), env, 'approval_expiry_sweep', { dry_run: false }, ORIGIN)).ok).toBe(false)
      expect(task('a').status).toBe('review')

      const real = await invokeTool(operator(), env, 'approval_expiry_sweep', { dry_run: false }, ORIGIN)
      expect(real.ok && real.result).toMatchObject({ dry_run: false, expired: 2 })
      expect(receipts().map((r) => [r.task_id, r.reason, r.via, r.actor])).toEqual([
        ['a', 'approval_expired', 'backfill', 'system:sweeper'],
        ['b', 'gate_owner_dead', 'backfill', 'system:sweeper'],
      ])
    })
  })

  describe('review fixes (gate round 1)', () => {
    it('an UNGATED review task 30 days old can still be verdicted, and the sweep never touches it', async () => {
      seedReview('ungated', 30, { gateOwner: null })
      const res = await sweepExpiredApprovals(env)
      expect(res.scanned).toBe(0)
      expect(task('ungated').status).toBe('review')
      await expect(writeVerdict(env, { task: asTask('ungated'), verdict: 'approved', note: 'ok', decidedBy: DECIDER })).resolves.toBeTruthy()
      expect(task('ungated').status).toBe('approved')
    })

    it('an unreadable review time counts as EXPIRED: refused as approval_expired and picked up by the sweep', async () => {
      seedReview('garbled', 0)
      harness.sqlite.exec(`UPDATE tasks SET review_entered_at = 'not-a-date' WHERE id = 'garbled'`)
      await expect(writeVerdict(env, { task: asTask('garbled'), verdict: 'approved', note: 'x', decidedBy: DECIDER })).rejects.toBeInstanceOf(ApprovalExpiredError)
      expect((await sweepExpiredApprovals(env)).expired).toBe(1)
      expect(task('garbled').status).toBe('blocked')
    })

    it('Needs You reads the SQL clock, not the caller-supplied now (cannot disagree with the verdict)', async () => {
      harness.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('p1', 'p1', 'P', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', '${SQUAD}', 'write');`)
      seedReview('fresh', 1)
      harness.sqlite.exec(`UPDATE tasks SET project_id = 'p1'`)
      const auth = { userId: 'o', memberId: 'o', email: null, role: 'owner', tenant: TENANT, channel: 'workspace', boundAgentId: null } as AuthContext
      const farFuture = '2099-01-01T00:00:00.000Z'
      const items = (await listNeedsYou(env, routinePrincipal(auth), { view: 'stuck', auth }, farFuture)).items
      expect(items.map((i) => i.source_id)).toContain('fresh')
    })

    it('CI-fail bounce + resubmit keeps the ORIGINAL clock and bumps the count', async () => {
      seedReview('ci', 0)
      harness.sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/pull/77' WHERE id = 'ci'`)
      const original = ago(10)
      harness.sqlite.prepare('UPDATE tasks SET review_entered_at = ? WHERE id = ?').run(original, 'ci')
      const { syncCiResultToTask } = await import('../src/tasks/service')
      expect((await syncCiResultToTask(env, 77, 'failure')).updated).toBe(true)
      expect(task('ci')).toMatchObject({ status: 'in_progress', expired_count: 1, review_clock_carry: original })
      await persistTaskUpdate(env, asTask('ci'), { ...asTask('ci'), status: 'review' })
      expect(task('ci')).toMatchObject({ status: 'review', review_entered_at: original, review_clock_carry: null, expired_count: 1 })
    })

    it('a bounce counts toward the resubmit cap like an expiry', async () => {
      seedReview('cap', 0)
      harness.sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/pull/78', expired_count = 1 WHERE id = 'cap'`)
      const { syncCiResultToTask } = await import('../src/tasks/service')
      await syncCiResultToTask(env, 78, 'failure') // count 1 -> 2
      expect(task('cap').expired_count).toBe(2)
      await expect(persistTaskUpdate(env, asTask('cap'), { ...asTask('cap'), status: 'review' }))
        .rejects.toMatchObject({ code: 'resubmit_cap_needs_human' })
    })

    it('a carried clock does not leak: leaving through any other status clears it, a rejected-rework gets a fresh clock', () => {
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id)
        VALUES ('c1', '${SQUAD}', 'T', 'b', 'd', 'review', '${LANE}', '${BUILDER}')`)
      harness.sqlite.exec(`UPDATE tasks SET review_entered_at = '2020-01-01T00:00:00.000Z' WHERE id = 'c1'`)
      harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = 'c1'`) // bounce: carry set
      expect(task('c1').review_clock_carry).toBe('2020-01-01T00:00:00.000Z')
      harness.sqlite.exec(`UPDATE tasks SET status = 'blocked' WHERE id = 'c1'`)
      expect(task('c1').review_clock_carry).toBeNull()
      harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = 'c1'`)
      harness.sqlite.exec(`UPDATE tasks SET status = 'review' WHERE id = 'c1'`)
      expect(Date.parse(String(task('c1').review_entered_at))).toBeGreaterThan(Date.now() - 60_000)
    })

    // Pins the `review_entered_at IS ?` guard in the sweep's UPDATE. The predicate alone cannot catch
    // this: the swapped-in clock is ALSO expired, so only the clock-identity guard refuses the write.
    it('the sweep refuses a row whose review_entered_at changed between scan and write (clock-identity guard)', async () => {
      seedReview('swap', APPROVAL_EXPIRY.gate_verdict_days + 5)
      const realPrepare = harness.db.prepare.bind(harness.db)
      let swapped = false
      const spyDb = new Proxy(harness.db, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (q: string) => {
              if (!swapped && q.includes(`SET status = 'blocked'`)) {
                swapped = true
                harness.sqlite.prepare('UPDATE tasks SET review_entered_at = ? WHERE id = ?').run(ago(APPROVAL_EXPIRY.gate_verdict_days + 9), 'swap')
              }
              return realPrepare(q)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const res = await sweepExpiredApprovals({ ...env, DB: spyDb } as Env)
      expect(res).toMatchObject({ expired: 0, skipped_claimed: 1 })
      expect(task('swap').status).toBe('review')
      expect(receipts()).toHaveLength(0)
    })

    it('resetResubmitCap answers lost_race (distinct from archived) when a concurrent reset wins', async () => {
      harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, expired_count)
        VALUES ('lr', '${SQUAD}', 'T', 'b', 'd', 'blocked', 2)`)
      const realPrepare = harness.db.prepare.bind(harness.db)
      const spyDb = new Proxy(harness.db, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (q: string) => {
              if (q.includes('UPDATE tasks SET expired_count = 0')) harness.sqlite.exec(`UPDATE tasks SET expired_count = 0 WHERE id = 'lr'`)
              return realPrepare(q)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const out = await resetResubmitCap({ ...env, DB: spyDb } as Env, 'lr', OPERATOR)
      expect(out).toMatchObject({ ok: false, error: 'lost_race' })
      harness.sqlite.exec(`UPDATE tasks SET expired_count = 2 WHERE id = 'lr'`)
      harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES ('lr', '${iso(Date.now())}', 'r', '${OPERATOR}', 'blocked')`)
      expect(await resetResubmitCap(env, 'lr', OPERATOR)).toMatchObject({ ok: false, error: 'archived' })
    })

    it('the cron tick is a DRY RUN by default: nothing written unless APPROVAL_EXPIRY_ENFORCE is exactly 1', async () => {
      seedReview('cron', APPROVAL_EXPIRY.gate_verdict_days + 2)
      const dump = () => JSON.stringify([sql('SELECT * FROM tasks'), sql('SELECT * FROM approval_expiry_receipts'), sql('SELECT * FROM agent_messages')])
      const before = dump()
      expect(await runApprovalExpiryTick(env)).toMatchObject({ dry_run: true, expired: 1 })
      expect(await runApprovalExpiryTick({ ...env, APPROVAL_EXPIRY_ENFORCE: 'true' } as Env)).toMatchObject({ dry_run: true })
      expect(await runApprovalExpiryTick({ ...env, APPROVAL_EXPIRY_ENFORCE: '0' } as Env)).toMatchObject({ dry_run: true })
      expect(dump()).toBe(before)
      expect(await runApprovalExpiryTick({ ...env, APPROVAL_EXPIRY_ENFORCE: '1' } as Env)).toMatchObject({ dry_run: false, expired: 1 })
      expect(task('cron').status).toBe('blocked')
    })
  })

  it('receipts are append-only', async () => {
    seedReview('t1', APPROVAL_EXPIRY.gate_verdict_days + 1)
    await sweepExpiredApprovals(env)
    expect(() => harness.sqlite.exec(`UPDATE approval_expiry_receipts SET reason = 'approval_expired'`)).toThrow(/append-only/)
    expect(() => harness.sqlite.exec('DELETE FROM approval_expiry_receipts')).toThrow(/append-only/)
  })
})
