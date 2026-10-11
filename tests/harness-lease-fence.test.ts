import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { grokCliAdapter } from '../src/harness/adapters/grok'
import { attachCursorCloudExecution, reserveCursorCloudWork } from '../src/cursor/dispatch'
import { launchCursorAgent } from '../src/cursor/client'
import {
  bindVendorExecution,
  bindVendorExecutionWithTaskBinding,
  markReservationFailed,
  claimAttachLease,
  getReservation,
  insertReservation,
  markReconciled,
  releaseAttachLease,
  taskBindingStatement,
} from '../src/harness/reservations'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core Squad');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-two', 'dept-core', 'squad-two', 'Second Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-builder', 'squad-core', 'agent-builder', 'Agent Builder', 'builder', 'test', 'active'),
      ('agent-two', 'squad-two', 'agent-two', 'Agent Two', 'builder', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-builder', 'builder@test.com', 'Builder Member', 'active', 'mumega');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-builder', 'member-builder', 'squad', 'squad-core', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('mumega', 'agent-builder', 'member-builder', datetime('now'));
  `)
  const env = { DB: harness.db, TENANT_SLUG: 'mumega', CURSOR_API_TOKEN: 'tok', BUS: { send: async () => {} } } as unknown as Env
  return { harness, env }
}

type Harness = ReturnType<typeof setup>['harness']

const req = {
  name: 'Lease',
  repoUrl: 'https://github.com/mumega/mupot',
  prompt: 'p',
  squadId: 'squad-core',
  agentId: 'agent-builder',
  actor: { kind: 'agent' as const, id: 'agent-builder' },
  idempotencyKey: 'lease-key',
}

const OK_BODY = JSON.stringify({
  agent: { id: 'bc-1', name: 'a', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-1', createdAt: 'x', updatedAt: 'x', latestRunId: 'r1', repos: [] },
  run: { id: 'r1', agentId: 'bc-1', status: 'CREATING', createdAt: 'x', updatedAt: 'x' },
})
const okResponse = () => new Response(OK_BODY, { status: 200, headers: { 'content-type': 'application/json' } })

function rowOf(h: Harness, id: string) {
  return h.sqlite.prepare('SELECT * FROM harness_reservations WHERE id = ?').get(id) as Record<string, unknown>
}
function expireLease(h: Harness, id: string) {
  h.sqlite.prepare(`UPDATE harness_reservations SET attach_lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(id)
}
function count(h: Harness, table: string): number {
  return (h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}
function taskBody(h: Harness, id: string): string {
  return (h.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(id) as { body: string }).body
}

describe('attach lease is a lock, not a timer (P1-a)', () => {
  it('a live lease cannot be stolen', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    const lease1 = await claimAttachLease(env, r.reservationId)
    expect(lease1).toBeTruthy()
    expect(await claimAttachLease(env, r.reservationId)).toBeNull()
    const row = rowOf(harness, r.reservationId)
    expect(row.state).toBe('attaching')
    expect(row.attach_lease_id).toBe(lease1)

    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const attach = await attachCursorCloudExecution(env, r.reservationId)
    expect(attach.state).toBe('attaching')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an expired lease NEVER re-launches: fetch count stays 1, row fails launch_unconfirmed', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    // Attacher A: vendor POST lands but A is evicted before the bind (its fetch response is held back).
    let resolveA: (res: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveA = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const attachA = attachCursorCloudExecution(env, r.reservationId)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expireLease(harness, r.reservationId)

    const retry = await cursorCloudAdapter.dispatch(env, req)
    expect(retry.accepted).toBe(false)
    expect(retry.accepted === false && retry.error).toBe('launch_unconfirmed')
    const direct = await attachCursorCloudExecution(env, r.reservationId)
    expect(direct.state).toBe('failed')
    expect(fetchMock).toHaveBeenCalledOnce() // never a second vendor launch

    const row = rowOf(harness, r.reservationId)
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('launch_unconfirmed: lease_expired')

    // The stale attacher finally returns: its bind is fenced out and writes nothing to the task.
    resolveA(okResponse())
    const a = await attachA
    expect(a.state).toBe('failed')
    expect(a.cursor).toBeUndefined()
    expect(taskBody(harness, r.task!.id)).not.toContain('cursor_run')
  })

  it('a stale attacher bind returns false; the fresh attacher binds', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    const stale = await claimAttachLease(env, r.reservationId)
    expect(await releaseAttachLease(env, r.reservationId, stale!)).toBe(true)
    const fresh = await claimAttachLease(env, r.reservationId)
    expect(fresh).not.toBe(stale)
    const cursor = { agentId: 'bc-s', runId: 'rs', agentUrl: 'https://cursor.com/agents/bc-s' }
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, stale!, r.task!.id, cursor)).toBe(false)
    expect(rowOf(harness, r.reservationId).state).toBe('attaching')
    expect(taskBody(harness, r.task!.id)).not.toContain('cursor_run')
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, fresh!, r.task!.id, cursor)).toBe(true)
    expect(rowOf(harness, r.reservationId).state).toBe('attached')
  })

  it('a stale attacher can neither bind (plain) nor fail the row; the lease holder can', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    const stale = await claimAttachLease(env, r.reservationId)
    await releaseAttachLease(env, r.reservationId, stale!)
    const fresh = await claimAttachLease(env, r.reservationId)
    expect(await bindVendorExecution(env, r.reservationId, stale!, { agentId: 'a', runId: 'r' })).toBe(false)
    expect(await markReservationFailed(env, r.reservationId, 'stale_says_failed', { leaseId: stale! })).toBe(false)
    expect(await markReservationFailed(env, r.reservationId, 'no_lease_cannot_fail_attaching')).toBe(false)
    expect(rowOf(harness, r.reservationId).state).toBe('attaching')
    expect(await bindVendorExecution(env, r.reservationId, fresh!, { agentId: 'a', runId: 'r' })).toBe(true)
  })

  it('a bind repeated with the same lease and run id appends the task body once', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    const lease = await claimAttachLease(env, r.reservationId)
    const cursor = { agentId: 'bc-d', runId: 'rd', agentUrl: 'https://cursor.com/agents/bc-d' }
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, lease!, r.task!.id, cursor)).toBe(true)
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, lease!, r.task!.id, cursor)).toBe(false)
    expect(taskBody(harness, r.task!.id).split('cursor_run: rd').length - 1).toBe(1)
  })

  it('the task-body statement refuses a run id that differs from the attached row (vendor_run_id predicate)', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    const lease = await claimAttachLease(env, r.reservationId)
    const now = new Date().toISOString()
    // Legit flip to run X, then a task-body statement carrying a DIFFERENT run Y in the same batch.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE harness_reservations SET state='attached', vendor_run_id='run-X', vendor_agent_id='bc-x', updated_at=?
         WHERE id=? AND state='attaching' AND attach_lease_id=?`,
      ).bind(now, r.reservationId, lease),
      taskBindingStatement(env, r.reservationId, lease!, r.task!.id, { agentId: 'bc-x', runId: 'run-Y', agentUrl: 'u' }, now),
    ])
    expect(taskBody(harness, r.task!.id)).not.toContain('run-Y')
  })

  it('a reservation not yet bound to a Task is never leased', async () => {
    const { env } = setup()
    const out = await insertReservation(env, {
      id: 'res-unbound', adapter: 'cursor-cloud', idempotencyKey: 'k-unbound', requestDigest: 'a'.repeat(64),
      agentId: 'agent-builder', squadId: 'squad-core', actor: req.actor,
    })
    expect(out.outcome).toBe('inserted')
    expect(await claimAttachLease(env, 'res-unbound')).toBeNull()
  })

  it('launch fetch carries a 20s abort signal; an abort is maybe_launched', async () => {
    const seen: (AbortSignal | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined)
      throw new DOMException('timed out', 'TimeoutError')
    }))
    const outcome = await launchCursorAgent('tok', { name: 'n', repoUrl: 'https://github.com/a/b', prompt: 'p' })
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.aborted).toBe(false)
    expect(outcome.state).toBe('maybe_launched')
  })
})

describe('insert-first reservation (P1-b)', () => {
  it('createTask failure fails the reservation (not left reserved) and the MCP never echoes raw DB text', async () => {
    const { harness, env } = setup()
    const realDb = env.DB
    const failing = new Proxy(realDb, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            if (/^\s*INSERT INTO tasks/i.test(sql)) throw new Error('SQLITE_ERROR: SECRET_COLUMN_LEAK no such column')
            return target.prepare(sql)
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const failingEnv = { ...env, DB: failing } as unknown as Env
    const auth: AuthContext = {
      userId: 'member-builder', memberId: 'member-builder', email: 'builder@test.com', role: 'member', tenant: 'mumega',
      channel: 'workspace', boundAgentId: 'agent-builder',
      capabilities: [{ member_id: 'member-builder', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
    }
    const out = await invokeTool(auth, failingEnv, 'cursor_dispatch', { name: 'n', repo_url: req.repoUrl, prompt: 'p', idempotency_key: 'k-fail' })
    expect(JSON.stringify(out)).not.toContain('SECRET_COLUMN_LEAK')
    const row = harness.sqlite.prepare('SELECT state, last_error FROM harness_reservations').get() as { state: string; last_error: string }
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('reserve_failed')
  })

  it('replay reads the REAL flight row, not a fabricated go verdict', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    harness.sqlite.prepare(`UPDATE flights SET status='held', gate_verdict='no_go', gate_reason='budget_low,x' WHERE id = ?`).run(r.flight!.id)
    const again = await reserveCursorCloudWork(env, req)
    expect(again.replay).toBe(true)
    expect(again.flight?.go).toBe(false)
    expect(again.flight?.reasons).toEqual(['budget_low', 'x'])
  })

  it('the same key in two squads is two reservations (squad-scoped key, no cross-squad oracle)', async () => {
    const { harness, env } = setup()
    const a = await reserveCursorCloudWork(env, req)
    const b = await reserveCursorCloudWork(env, { ...req, squadId: 'squad-two', agentId: 'agent-two' })
    expect(a.replay).toBe(false)
    expect(b.replay).toBe(false)
    expect(a.reservationId).not.toBe(b.reservationId)
    expect(count(harness, 'harness_reservations')).toBe(2)
  })
})

describe('P2 fences', () => {
  it('markReconciled only moves an attached row', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    expect(await markReconciled(env, r.reservationId, 'FINISHED')).toBe(false)
    expect(rowOf(harness, r.reservationId).state).toBe('reserved')
    const lease = await claimAttachLease(env, r.reservationId)
    await bindVendorExecutionWithTaskBinding(env, r.reservationId, lease!, r.task!.id, { agentId: 'a', runId: 'r', agentUrl: 'u' })
    expect(await markReconciled(env, r.reservationId, 'FINISHED')).toBe(true)
    expect(rowOf(harness, r.reservationId).state).toBe('reconciled')
  })

  it('grok: dry-run by default, reserved -> lease -> bind stores the real run id', async () => {
    const { harness, env } = setup()
    const base = { name: 'G', prompt: 'p', squadId: 'squad-core', agentId: 'agent-builder', actor: req.actor, idempotencyKey: 'g-1' }
    const dry = await grokCliAdapter.dispatch(env, base)
    expect(dry.accepted).toBe(false)
    expect(dry.accepted === false && dry.error).toBe('dry_run')
    expect(count(harness, 'harness_reservations')).toBe(0)
    expect(count(harness, 'tasks')).toBe(0)

    const live = await grokCliAdapter.dispatch(env, { ...base, dryRun: false })
    expect(live.accepted).toBe(true)
    if (!live.accepted) return
    const row = rowOf(harness, live.reservationId)
    expect(row.state).toBe('attached')
    expect(row.vendor_run_id).toBe(live.vendorRunId)
    expect(row.attach_lease_id).toBeTruthy()
  })

  it('pause fence: grok and cursor create nothing; a pause landing between reserve and attach blocks the vendor call', async () => {
    const { harness, env } = setup()
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    harness.sqlite.exec(`INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
      VALUES ('p1', 'mumega', 'agent', 'agent-builder', 'test', 'member-builder', '2026-01-01T00:00:00.000Z')`)
    const grok = await grokCliAdapter.dispatch(env, { name: 'G', prompt: 'p', squadId: 'squad-core', agentId: 'agent-builder', actor: req.actor, idempotencyKey: 'g-p', dryRun: false })
    expect(grok.accepted === false && grok.error).toBe('execution_paused')
    const cursor = await cursorCloudAdapter.dispatch(env, req)
    expect(cursor.accepted === false && cursor.error).toBe('execution_paused')
    expect(count(harness, 'harness_reservations')).toBe(0)
    expect(count(harness, 'tasks')).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()

    // pause lands AFTER reserve
    harness.sqlite.exec(`UPDATE execution_pauses SET resumed_at = '2026-01-02T00:00:00.000Z', resumed_by_member_id = 'member-builder', resume_reason = 'x'`)
    const r = await reserveCursorCloudWork(env, req)
    harness.sqlite.exec(`UPDATE execution_pauses SET resumed_at = NULL, resumed_by_member_id = NULL, resume_reason = NULL`)
    const attach = await attachCursorCloudExecution(env, r.reservationId)
    expect(attach.error).toBe('execution_paused')
    expect(attach.state).toBe('reserved')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rowOf(harness, r.reservationId).attach_lease_id).toBeNull() // lease handed back, not stranded
  })

  it('status surfaces a reserved/attaching row older than 10 minutes as stuck', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, req)
    expect((await cursorCloudAdapter.status(env, { reservationId: r.reservationId })).stuck).toBeUndefined()
    harness.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), r.reservationId)
    expect((await cursorCloudAdapter.status(env, { reservationId: r.reservationId })).stuck).toBe(true)
  })

  it('reconcile fails an unbound reservation past the stuck horizon and leaves a fresh one alone', async () => {
    const { harness, env } = setup()
    await insertReservation(env, {
      id: 'res-orphan', adapter: 'cursor-cloud', idempotencyKey: 'k-orphan', requestDigest: 'b'.repeat(64),
      agentId: 'agent-builder', squadId: 'squad-core', actor: req.actor,
    })
    expect((await cursorCloudAdapter.reconcile(env, 'res-orphan')).changed).toBe(false)
    harness.sqlite.prepare(`UPDATE harness_reservations SET updated_at = ? WHERE id = 'res-orphan'`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString())
    const rec = await cursorCloudAdapter.reconcile(env, 'res-orphan')
    expect(rec.changed).toBe(true)
    expect((await getReservation(env, 'res-orphan'))?.state).toBe('failed')
  })
})
