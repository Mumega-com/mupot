// tests/task-incident-revert.test.ts — task_incident_revert (mupot#1780 incident recovery, option C).
//
// Real SQLite + the full migration chain (migration 0201 applies as part of it). Every tool call goes
// through invokeTool (scripts/check-mcp-tool-seam.mjs). Each guard here was MUTATED in the source to
// prove the test that names it fails without it (ledger in the PR description).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { TASK_ROW_COLUMNS, INCIDENT_REVERT_MAX_ROWS, SNAPSHOT_PART_SIZE, SNAPSHOT_PART_KEYS, SNAPSHOT_JSON_SQL } from '../src/tasks/incident-revert'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const OPERATOR = 'member-operator'
const MUMCP = 'agent-mumcp'
const T0 = '2026-10-09T03:30:05.398Z'

function auth(opts: { boundAgentId?: string | null; capabilities?: CapabilityGrant[]; tenant?: string } = {}): AuthContext {
  return {
    userId: opts.boundAgentId ? `agent:${opts.boundAgentId}` : 'operator-caller',
    email: opts.boundAgentId ? null : 'operator@example.com',
    role: 'member',
    tenant: opts.tenant ?? TENANT,
    channel: 'workspace',
    memberId: OPERATOR,
    capabilities: opts.capabilities ?? [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

interface Snap { task_id: string; expected_status: string; expected_assignee_agent_id: string | null; expected_updated_at: string }
const snap = (id: string, status = 'blocked', assignee: string | null = MUMCP, at = T0): Snap =>
  ({ task_id: id, expected_status: status, expected_assignee_agent_id: assignee, expected_updated_at: at })

describe('task_incident_revert', () => {
  let harness: SqliteD1Harness
  let env: Env
  const call = (a: AuthContext, args: Record<string, unknown>) => invokeTool(a, env, 'task_incident_revert', args, ORIGIN)
  const revert = (rows: Snap[], a: AuthContext = auth()) =>
    call(a, { reason: 'undo accidental router_tick', incident_ref: 'mupot#1780', rows })
  const row = (id: string) => harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
  const receipts = (id?: string) =>
    harness.sqlite.prepare(`SELECT * FROM task_incident_revert_receipts ${id ? 'WHERE task_id = ?' : ''}`).all(...(id ? [id] : [])) as Record<string, unknown>[]
  const result = (o: Awaited<ReturnType<typeof call>>) => {
    if (!o.ok) throw new Error(`tool failed: ${o.status} ${o.error} ${JSON.stringify(o.detail)}`)
    return o.result as { reverted: number; drifted: number; not_found: number; archived: number; receipt_ids: string[]; rows: Array<Record<string, unknown>> }
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('${OPERATOR}', '${TENANT}', 'op@example.com', 'Operator', 'active');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq1', 'Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${MUMCP}', 'squad-1', 'mumcp', 'mumcp', 'active');
      INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, result, completed_at, updated_at, execution_receipt_id) VALUES
        ('t-blocked', 'squad-1', 'Blocked', 'blocked', 'n/a', '${MUMCP}', 'artifact_verification_failed: no_artifact_claimed', '2026-10-09T03:30:05.000Z', '${T0}', 'exec-old'),
        ('t-orphan', 'squad-1', 'Orphan in_progress', 'in_progress', 'n/a', NULL, NULL, NULL, '${T0}', NULL),
        ('t-open', 'squad-1', 'Open', 'open', 'n/a', NULL, NULL, NULL, '${T0}', NULL);
    `)
  })
  afterEach(() => harness.close())

  // ── gate ────────────────────────────────────────────────────────────────────
  it('refuses an agent-bound caller, a non-admin, and a foreign-tenant principal; nothing is written', async () => {
    const bound = await revert([snap('t-blocked')], auth({ boundAgentId: MUMCP }))
    expect(bound).toMatchObject({ ok: false, status: 403, error: 'operator_principal_required' })
    const nonAdmin = await revert([snap('t-blocked')], auth({ capabilities: [] }))
    expect(nonAdmin).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    const foreign = await revert([snap('t-blocked')], auth({ tenant: 'other-tenant' }))
    expect(foreign).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(row('t-blocked').status).toBe('blocked')
    expect(receipts()).toHaveLength(0)
  })

  it('validates input: cap, duplicates, unknown status, missing assignee field, unknown key, empty reason', async () => {
    const many = Array.from({ length: INCIDENT_REVERT_MAX_ROWS + 1 }, (_, i) => snap(`t-${i}`))
    expect(await revert(many)).toMatchObject({ ok: false, status: 400 })
    expect(await revert([snap('t-blocked'), snap('t-blocked')])).toMatchObject({ ok: false, status: 400 })
    expect(await revert([snap('t-blocked', 'not_a_status')])).toMatchObject({ ok: false, status: 400 })
    expect(await revert([{ task_id: 't-blocked', expected_status: 'blocked', expected_updated_at: T0 } as unknown as Snap])).toMatchObject({ ok: false, status: 400 })
    expect(await revert([{ ...snap('t-blocked'), extra: 1 } as unknown as Snap])).toMatchObject({ ok: false, status: 400 })
    expect(await call(auth(), { reason: '  ', incident_ref: 'x', rows: [snap('t-blocked')] })).toMatchObject({ ok: false, status: 400 })
    expect(await call(auth(), { reason: 'r', incident_ref: '', rows: [snap('t-blocked')] })).toMatchObject({ ok: false, status: 400 })
    expect(receipts()).toHaveLength(0)
  })

  // ── happy path ──────────────────────────────────────────────────────────────
  it('reverts blocked+assigned and in_progress+unassigned rows: status open, assignee NULL, updated_at moved, result untouched', async () => {
    const out = result(await revert([snap('t-blocked'), snap('t-orphan', 'in_progress', null)]))
    expect(out).toMatchObject({ reverted: 2, drifted: 0, not_found: 0, archived: 0 })
    expect(out.receipt_ids).toHaveLength(2)

    const blocked = row('t-blocked')
    expect(blocked).toMatchObject({ status: 'open', assignee_agent_id: null })
    expect(blocked.updated_at).not.toBe(T0)
    // Never invent a prior value: result / completed_at / execution pointer are left exactly as found.
    expect(blocked.result).toBe('artifact_verification_failed: no_artifact_claimed')
    expect(blocked.completed_at).toBe('2026-10-09T03:30:05.000Z')
    expect(blocked.execution_receipt_id).toBe('exec-old')
    expect(row('t-orphan')).toMatchObject({ status: 'open', assignee_agent_id: null })
  })

  it('the receipt holds the FULL pre-revert row (every column, NULLs included) plus the CAS expectation and actor', async () => {
    const before = row('t-blocked')
    const out = result(await revert([snap('t-blocked')]))
    const [rec] = receipts('t-blocked')
    expect(rec).toMatchObject({
      id: out.receipt_ids[0], tenant: TENANT, incident_ref: 'mupot#1780', actor_member_id: OPERATOR,
      expected_status: 'blocked', expected_assignee_agent_id: MUMCP, expected_updated_at: T0,
      new_updated_at: row('t-blocked').updated_at,
    })
    const parts = JSON.parse(String(rec.pre_row_json)) as Record<string, Record<string, unknown>>
    const flat: Record<string, unknown> = Object.assign({}, ...Object.values(parts))
    expect(Object.keys(flat).sort()).toEqual([...TASK_ROW_COLUMNS].sort())
    for (const [k, v] of Object.entries(before)) expect(flat[k], `column ${k}`).toEqual(v)
    expect(flat.gate_owner).toBeNull() // a NULL column survives as an explicit null, it is not dropped
  })

  it('TASK_ROW_COLUMNS covers every column of the real tasks table (a new column fails here until the snapshot learns it)', () => {
    const live = (harness.sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name)
    expect([...TASK_ROW_COLUMNS].sort()).toEqual(live.sort())
  })

  // ── narrowed statuses ───────────────────────────────────────────────────────
  it.each(['open', 'review', 'approved', 'rejected', 'done'])(
    'expected_status %s is refused per row as status_not_revertable: no write, no receipt, the CAS-matching row is untouched',
    async (status) => {
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, updated_at) VALUES (?, 'squad-1', 't', ?, 'n/a', ?, ?)`)
        .run(`s-${status}`, status, MUMCP, T0)
      const out = result(await revert([snap(`s-${status}`, status), snap('t-blocked')]))
      expect(out.rows[0]).toMatchObject({ outcome: 'status_not_revertable', status })
      expect(out.rows[1]).toMatchObject({ outcome: 'reverted' }) // the other row is unaffected
      expect(row(`s-${status}`)).toMatchObject({ status, assignee_agent_id: MUMCP, updated_at: T0 })
      expect(receipts(`s-${status}`)).toHaveLength(0)
    },
  )

  // ── runtime-held / in-flight / member-owned ─────────────────────────────────
  it('refuses an in_progress task holding an execution_receipt_id with NO claim (runtime_held); an EXPIRED claim does not hold it', async () => {
    harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, updated_at, execution_receipt_id, execution_claim_expires_at)
      VALUES ('rt-held', 'squad-1', 't', 'in_progress', 'n/a', ?, ?, 'exec-live', NULL)`).run(MUMCP, T0)
    const out = result(await revert([snap('rt-held', 'in_progress', MUMCP)]))
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', reason: 'runtime_held' })
    expect(row('rt-held')).toMatchObject({ status: 'in_progress', assignee_agent_id: MUMCP })
    expect(receipts()).toHaveLength(0)
    harness.sqlite.prepare('UPDATE tasks SET execution_claim_expires_at = ? WHERE id = ?').run(Date.now() - 1000, 'rt-held')
    expect(result(await revert([snap('rt-held', 'in_progress', MUMCP)])).reverted).toBe(1)
  })

  it('refuses a task whose dispatch is still in flight (the archive_row predicate), blocked or not', async () => {
    harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at)
      VALUES ('disp-1', '${TENANT}', 't-blocked', 'squad-1', '${MUMCP}', 'member', '${OPERATOR}', '${T0}', NULL)`)
    const out = result(await revert([snap('t-blocked')]))
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', reason: 'in_flight_dispatch' })
    expect(row('t-blocked')).toMatchObject({ status: 'blocked', assignee_agent_id: MUMCP })
    expect(receipts()).toHaveLength(0)
  })

  it('a human assignee_member_id is part of the compare-and-set: the task is not "unassigned", so it is skipped', async () => {
    harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, assignee_member_id, updated_at)
      VALUES ('mem-owned', 'squad-1', 't', 'blocked', 'n/a', NULL, ?, ?)`).run(OPERATOR, T0)
    const out = result(await revert([snap('mem-owned', 'blocked', null)]))
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', reason: 'mismatch', actual: { assignee_member_id: OPERATOR } })
    expect(row('mem-owned').assignee_member_id).toBe(OPERATOR)
    expect(receipts()).toHaveLength(0)
  })

  // ── per-row isolation ───────────────────────────────────────────────────────
  it('a row that throws is reported as error and the loop continues; every row has an outcome', async () => {
    let calls = 0
    const realBatch = harness.db.batch.bind(harness.db)
    const spy = {
      ...harness.db,
      prepare: harness.db.prepare.bind(harness.db),
      batch: async (stmts: D1PreparedStatement[]) => {
        calls += 1
        if (calls === 1) throw new Error('D1_ERROR: simulated failure with secret-ish detail')
        return realBatch(stmts)
      },
    } as unknown as D1Database
    const o = await invokeTool(auth(), { ...env, DB: spy } as Env, 'task_incident_revert',
      { reason: 'r', incident_ref: 'i', rows: [snap('t-blocked'), snap('t-orphan', 'in_progress', null)] }, ORIGIN)
    const out = result(o)
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0]).toEqual({ task_id: 't-blocked', outcome: 'error', code: 'row_failed' }) // message not echoed
    expect(out.rows[1]).toMatchObject({ outcome: 'reverted' })
    expect(row('t-blocked').status).toBe('blocked')
    expect(row('t-orphan').status).toBe('open')
  })

  // ── same-millisecond updated_at ─────────────────────────────────────────────
  it('updated_at always MOVES, even when the clock reads the exact expected_updated_at millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(T0))
      const out = result(await revert([snap('t-blocked')]))
      expect(out.rows[0]).toMatchObject({ outcome: 'reverted' })
      expect(row('t-blocked').updated_at).toBe(new Date(Date.parse(T0) + 1).toISOString())
      expect(row('t-blocked').updated_at).not.toBe(T0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── D1 32-argument function limit ───────────────────────────────────────────
  it('no json_object call in the snapshot SQL exceeds D1\'s 32-argument function limit', () => {
    expect(SNAPSHOT_PART_SIZE * 2).toBeLessThanOrEqual(32)
    expect(SNAPSHOT_PART_KEYS.length * 2).toBeLessThanOrEqual(32)
    const sql = SNAPSHOT_JSON_SQL
    const widest: number[] = []
    for (let i = sql.indexOf('json_object('); i !== -1; i = sql.indexOf('json_object(', i + 1)) {
      let depth = 0
      let args = 1
      for (let j = i + 'json_object'.length; j < sql.length; j++) {
        const ch = sql[j]
        if (ch === '(') depth += 1
        else if (ch === ')') { depth -= 1; if (depth === 0) break }
        else if (ch === ',' && depth === 1) args += 1
      }
      widest.push(args)
    }
    expect(widest.length).toBeGreaterThan(1)
    expect(Math.max(...widest)).toBeLessThanOrEqual(32)
  })

  // ── compare-and-set ─────────────────────────────────────────────────────────
  it('SKIPS drifted rows (status, assignee, updated_at each), reports actual values, writes no receipt', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, updated_at) VALUES
        ('d-status', 'squad-1', 'a', 'in_progress', 'n/a', '${MUMCP}', '${T0}'),
        ('d-assignee', 'squad-1', 'b', 'blocked', 'n/a', NULL, '${T0}'),
        ('d-updated', 'squad-1', 'c', 'blocked', 'n/a', '${MUMCP}', '2026-10-09T05:00:00.000Z');
    `)
    const out = result(await revert([snap('d-status'), snap('d-assignee'), snap('d-updated'), snap('t-blocked')]))
    expect(out).toMatchObject({ reverted: 1, drifted: 3 })
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', reason: 'mismatch', actual: { status: 'in_progress', assignee_agent_id: MUMCP, updated_at: T0 } })
    expect(out.rows[1]).toMatchObject({ outcome: 'drifted', actual: { assignee_agent_id: null } })
    expect(out.rows[2]).toMatchObject({ outcome: 'drifted', actual: { updated_at: '2026-10-09T05:00:00.000Z' } })
    for (const id of ['d-status', 'd-assignee', 'd-updated']) {
      expect(receipts(id)).toHaveLength(0)
    }
    expect(row('d-status').status).toBe('in_progress')
    expect(row('d-assignee').status).toBe('blocked')
    expect(row('d-updated').assignee_agent_id).toBe(MUMCP)
  })

  it('IFNULL-safe assignee: expected null matches an unassigned row and does NOT match an assigned one', async () => {
    const ok = result(await revert([snap('t-orphan', 'in_progress', null)]))
    expect(ok.reverted).toBe(1)
    const bad = result(await revert([snap('t-blocked', 'blocked', null)]))
    expect(bad.rows[0]).toMatchObject({ outcome: 'drifted' })
    expect(row('t-blocked').assignee_agent_id).toBe(MUMCP)
  })

  it('reports not_found, and refuses an ARCHIVED task (no write, no receipt)', async () => {
    harness.sqlite.exec(`
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
        VALUES ('t-blocked', '2026-10-09T04:00:00.000Z', 'archived', '${OPERATOR}', 'blocked');
    `)
    const out = result(await revert([snap('t-blocked'), snap('nope')]))
    expect(out.rows).toMatchObject([{ outcome: 'archived' }, { outcome: 'not_found' }])
    expect(row('t-blocked')).toMatchObject({ status: 'blocked', assignee_agent_id: MUMCP })
    expect(receipts()).toHaveLength(0)
  })

  it('refuses a task with a LIVE execution claim (never pulls a task from under a running executor)', async () => {
    harness.sqlite.prepare('UPDATE tasks SET execution_claim_expires_at = ? WHERE id = ?').run(Date.now() + 60_000, 't-orphan')
    const out = result(await revert([snap('t-orphan', 'in_progress', null)]))
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', reason: 'live_execution_claim' })
    expect(row('t-orphan').status).toBe('in_progress')
    expect(receipts()).toHaveLength(0)
    // an EXPIRED claim does not block
    harness.sqlite.prepare('UPDATE tasks SET execution_claim_expires_at = ? WHERE id = ?').run(Date.now() - 60_000, 't-orphan')
    expect(result(await revert([snap('t-orphan', 'in_progress', null)])).reverted).toBe(1)
  })

  // ── evidence integrity ──────────────────────────────────────────────────────
  it('receipts are append-only (UPDATE and DELETE are refused)', async () => {
    result(await revert([snap('t-blocked')]))
    expect(() => harness.sqlite.exec(`UPDATE task_incident_revert_receipts SET reason = 'x'`)).toThrow(/append-only/)
    expect(() => harness.sqlite.exec('DELETE FROM task_incident_revert_receipts')).toThrow(/append-only/)
  })

  it('the UPDATE cannot land without its receipt: with the receipt INSERT neutralised, the row is not mutated', async () => {
    const realBatch = harness.db.batch.bind(harness.db)
    const spy = { ...harness.db, prepare: harness.db.prepare.bind(harness.db), batch: async (stmts: D1PreparedStatement[]) => realBatch(stmts.slice(1)) } as unknown as D1Database
    const e = { ...env, DB: spy } as Env
    const o = await invokeTool(auth(), e, 'task_incident_revert', { reason: 'r', incident_ref: 'i', rows: [snap('t-blocked')] }, ORIGIN)
    expect(result(o).rows[0]).toMatchObject({ outcome: 'drifted' })
    expect(row('t-blocked')).toMatchObject({ status: 'blocked', assignee_agent_id: MUMCP })
  })

  it('the UPDATE carries its OWN archive guard: a task archived between the receipt INSERT and the UPDATE is not reverted, and the orphan receipt is reported', async () => {
    // Simulates a non-atomic gap (D1 batches are atomic; this proves the UPDATE does not rely on that).
    const spy = {
      ...harness.db,
      prepare: harness.db.prepare.bind(harness.db),
      batch: async (stmts: D1PreparedStatement[]) => {
        const out: D1Result[] = []
        for (const [i, s] of stmts.entries()) {
          out.push(await s.run())
          if (i === 0) {
            harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
              VALUES ('t-blocked', '2026-10-09T04:00:00.000Z', 'archived mid-flight', '${OPERATOR}', 'blocked')`)
          }
        }
        return out
      },
    } as unknown as D1Database
    const o = await invokeTool(auth(), { ...env, DB: spy } as Env, 'task_incident_revert', { reason: 'r', incident_ref: 'i', rows: [snap('t-blocked')] }, ORIGIN)
    expect(result(o).rows[0]).toMatchObject({ outcome: 'drifted', reason: 'receipt_without_update' })
    expect(row('t-blocked')).toMatchObject({ status: 'blocked', assignee_agent_id: MUMCP })
  })

  it('stays under the 100-bind limit on every statement (50-row call)', async () => {
    const seen: number[] = []
    const realPrepare = harness.db.prepare.bind(harness.db)
    const spy = {
      ...harness.db,
      batch: harness.db.batch.bind(harness.db),
      prepare: (sql: string) => {
        const stmt = realPrepare(sql)
        const realBind = stmt.bind.bind(stmt)
        stmt.bind = (...vals: unknown[]) => { seen.push(vals.length); return realBind(...vals) }
        return stmt
      },
    } as unknown as D1Database
    const rows: Snap[] = []
    for (let i = 0; i < INCIDENT_REVERT_MAX_ROWS; i++) {
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, updated_at) VALUES (?, 'squad-1', 't', 'blocked', 'n/a', ?, ?)`).run(`bulk-${i}`, MUMCP, T0)
      rows.push(snap(`bulk-${i}`))
    }
    const o = await invokeTool(auth(), { ...env, DB: spy } as Env, 'task_incident_revert', { reason: 'r', incident_ref: 'i', rows }, ORIGIN)
    expect(result(o).reverted).toBe(INCIDENT_REVERT_MAX_ROWS)
    expect(Math.max(...seen)).toBeLessThanOrEqual(100)
  })

  // ── concurrency ─────────────────────────────────────────────────────────────
  it('Promise.all of two identical reverts: exactly one reverts, the other is drifted, one receipt', async () => {
    const [a, b] = await Promise.all([revert([snap('t-blocked')]), revert([snap('t-blocked')])])
    const outcomes = [result(a).rows[0]?.outcome, result(b).rows[0]?.outcome].sort()
    expect(outcomes).toEqual(['drifted', 'reverted'])
    expect(receipts('t-blocked')).toHaveLength(1)
    expect(row('t-blocked')).toMatchObject({ status: 'open', assignee_agent_id: null })
  })

  it('a revert racing a legitimate update never overwrites it and never leaves an orphan receipt', async () => {
    for (const legitFirst of [true, false]) {
      harness.sqlite.exec(`DELETE FROM tasks WHERE id LIKE 'race-%'`)
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id, updated_at) VALUES ('race-1', 'squad-1', 'r', 'blocked', 'n/a', ?, ?)`).run(MUMCP, T0)
      const legit = async () => {
        harness.sqlite.prepare(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = 'race-1' AND status = 'blocked'`).run('2026-10-09T06:00:00.000Z')
      }
      const settled = legitFirst
        ? await Promise.all([legit(), revert([snap('race-1')])])
        : await Promise.all([revert([snap('race-1')]), legit()])
      const outcome = result(settled[legitFirst ? 1 : 0] as Awaited<ReturnType<typeof call>>).rows[0]?.outcome
      const final = row('race-1')
      const recs = receipts('race-1')
      if (outcome === 'reverted') {
        expect(final).toMatchObject({ status: 'open', assignee_agent_id: null })
        expect(recs).toHaveLength(1)
      } else {
        // the legitimate update won: it is intact, and no evidence of a revert that never happened
        expect(outcome).toBe('drifted')
        expect(final).toMatchObject({ status: 'in_progress', updated_at: '2026-10-09T06:00:00.000Z' })
        expect(recs).toHaveLength(0)
      }
      expect(recs.length).toBe(outcome === 'reverted' ? 1 : 0)
    }
  })

  it('a legitimate update landing between the caller reading its snapshot and the revert is skipped as drifted', async () => {
    harness.sqlite.prepare(`UPDATE tasks SET updated_at = '2026-10-09T07:00:00.000Z' WHERE id = 't-blocked'`).run()
    const out = result(await revert([snap('t-blocked')]))
    expect(out.rows[0]).toMatchObject({ outcome: 'drifted', actual: { updated_at: '2026-10-09T07:00:00.000Z' } })
    expect(receipts()).toHaveLength(0)
  })
})
