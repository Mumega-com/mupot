import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../src/types'
import { dispatchRoutineRun } from '../src/routines/dispatch'
import { MAX_SCHEDULER_DB_STATEMENTS } from '../src/routines/scheduler'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const NOW = new Date('2026-07-19T16:00:00.000Z')

function makeHarness(options: { budgetMicroUsd?: number } = {}): SqliteD1Harness {
  const harness = createSqliteD1()
  const budgetMicroUsd = options.budgetMicroUsd ?? 100000
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-preferred', 'squad-1', 'preferred', 'Preferred', 'active'),
      ('agent-fallback', 'squad-1', 'fallback', 'Fallback', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-preferred', 'agent-preferred', 'squad-1', 'member'),
      ('membership-fallback', 'agent-fallback', 'squad-1', 'member');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('member-preferred', 'Preferred runtime', 'active', 'tenant-a'),
      ('member-fallback', 'Fallback runtime', 'active', 'tenant-a');
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
    VALUES
      ('token-preferred', 'member-preferred', 'hash-preferred', 'preferred', 'workspace', '${NOW.toISOString()}', NULL, 'agent-preferred', 'tenant-a'),
      ('token-fallback', 'member-fallback', 'hash-fallback', 'fallback', 'workspace', '${NOW.toISOString()}', NULL, 'agent-fallback', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-preferred', 'member-preferred', 'squad', 'squad-1', 'member'),
      ('cap-fallback', 'member-fallback', 'squad', 'squad-1', 'lead');
    INSERT INTO fleet_agents
      (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at)
    VALUES
      ('agent-preferred', 'tenant-a', 'Preferred', 'hermes-cron', '["squad-1"]', 'always_on', 'running', 'host', '2026-07-19 15:59:30', '2026-07-19 15:59:30'),
      ('agent-fallback', 'tenant-a', 'Fallback', 'codex', '["squad-1"]', 'always_on', 'running', 'host', '2026-07-19 15:59:30', '2026-07-19 15:59:30');
    INSERT INTO projects (id, slug, name, goal, status)
      VALUES ('project-1', 'project-1', 'Project One', 'Reach a verified outcome', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-1', 'squad-1', 'write');
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
      timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
      preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
      revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (
      'routine-1', 'tenant-a', 'project-1', 'Daily next action',
      'Find and propose the next accountable action', 'enabled', 'cron', '* * * * *',
      'UTC', '2026-07-19T16:01:00.000Z', 'skip', 'propose', 'squad-1',
      'agent-preferred', ${budgetMicroUsd}, 3, 300, 1, 'owner-1', '${NOW.toISOString()}',
      'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
    );
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
      created_at, updated_at
    ) VALUES (
      'run-1', 'tenant-a', 'project-1', 'routine-1', 1,
      '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-preferred","budget_micro_usd":${budgetMicroUsd},"max_attempts":3,"retry_backoff_seconds":300}',
      'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'leased',
      'scheduler-1', '2026-07-19T16:05:00.000Z', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'
    );
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, onPrepare?: () => void): Env {
  const db = onPrepare
    ? {
        prepare(sql: string) {
          onPrepare()
          return harness.db.prepare(sql)
        },
        batch: harness.db.batch.bind(harness.db),
      }
    : harness.db
  return {
    DB: db,
    TENANT_SLUG: 'tenant-a',
    PUBLIC_ORIGIN: 'https://mupot.example',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function envWithCancellationBeforeInsert(
  harness: SqliteD1Harness,
  pattern: RegExp,
  eventId: string,
): Env {
  const base = envFor(harness)
  const db = harness.db
  let injected = false
  return {
    ...base,
    DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql)
        if (!injected && pattern.test(sql)) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values)
              return {
                async run() {
                  injected = true
                  harness.sqlite.exec(`
                    INSERT INTO routine_run_events (
                      id, tenant, project_id, run_id, kind, actor_type, actor_id,
                      metadata_json, correlation_id
                    ) VALUES (
                      '${eventId}', 'tenant-a', 'project-1', 'run-1',
                      'cancellation_requested', 'member', 'owner-1', '{}', 'run-1'
                    );
                  `)
                  return bound.run()
                },
                async first<T>() { return bound.first<T>() },
                async all<T>() { return bound.all<T>() },
              } as unknown as D1PreparedStatement
            },
          } as unknown as D1PreparedStatement
        }
        return statement
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database,
  } as Env
}

function row(harness: SqliteD1Harness, sql: string, ...binds: unknown[]): Record<string, unknown> | undefined {
  return harness.sqlite.prepare(sql).get(...binds)
}

describe('routine runtime-neutral dispatch', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('selects the preferred eligible welded live agent', async () => {
    harness = makeHarness()

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-preferred' })
    expect(row(harness, "SELECT assigned_agent_id, status FROM routine_runs WHERE id = 'run-1'")).toEqual({
      assigned_agent_id: 'agent-preferred', status: 'running',
    })
  })

  it('falls back deterministically when the preferred agent lacks member capability', async () => {
    harness = makeHarness()
    harness.sqlite.prepare("UPDATE capabilities SET capability = 'observer' WHERE id = 'cap-preferred'").run()

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-fallback' })
  })

  it('waits for a human when no eligible welded teammate exists', async () => {
    harness = makeHarness()
    harness.sqlite.prepare('DELETE FROM capabilities').run()

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toEqual({ ok: true, status: 'waiting', reason: 'agent', run_id: 'run-1' })
    expect(row(harness, "SELECT status, waiting_reason FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'waiting', waiting_reason: 'agent',
    })
  })

  it('retries the same run when eligible runtimes are offline', async () => {
    harness = makeHarness()
    harness.sqlite.prepare("UPDATE fleet_agents SET status = 'stopped'").run()

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toEqual({ ok: true, status: 'retry_scheduled', reason: 'agent_offline', run_id: 'run-1' })
    expect(row(harness, "SELECT status, retry_at, attempt FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'queued', retry_at: '2026-07-19T16:05:00.000Z', attempt: 1,
    })
  })

  it('retries inbox backpressure without creating another occurrence', async () => {
    harness = makeHarness()
    const send = vi.fn(async () => ({ ok: false as const, reason: 'inbox_full' as const }))

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW, { sendAgentMessage: send })

    expect(result).toEqual({ ok: true, status: 'retry_scheduled', reason: 'inbox_full', run_id: 'run-1' })
    expect(row(harness, "SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = 'routine-1'")).toEqual({ count: 1 })
    expect(row(harness, 'SELECT status FROM flights LIMIT 1')).toEqual({ status: 'preflight' })
    expect(row(harness, 'SELECT status FROM tasks LIMIT 1')).toEqual({ status: 'open' })
  })

  it('waits for a budget decision instead of asserting headroom for a zero budget', async () => {
    harness = makeHarness({ budgetMicroUsd: 0 })

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toEqual({ ok: true, status: 'waiting', reason: 'budget', run_id: 'run-1' })
    expect(row(harness, "SELECT status, waiting_reason FROM routine_runs WHERE id = 'run-1'")).toEqual({
      status: 'waiting', waiting_reason: 'budget',
    })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 0 })
  })

  it('keeps the reserved executor stable across a failed delivery retry', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const failedSend = vi.fn(async () => ({ ok: false as const, reason: 'inbox_full' as const }))
    await dispatchRoutineRun(env, 'run-1', NOW, { sendAgentMessage: failedSend })
    harness.sqlite.prepare(
      `UPDATE routine_runs SET status = 'leased', waiting_reason = NULL,
          lease_owner = 'scheduler-2', lease_expires_at = '2026-07-19T16:10:00.000Z',
          retry_at = NULL, attempt = 2 WHERE id = 'run-1'`,
    ).run()
    harness.sqlite.prepare("UPDATE fleet_agents SET status = 'stopped' WHERE agent_id = 'agent-preferred'").run()

    const retry = await dispatchRoutineRun(env, 'run-1', new Date('2026-07-19T16:01:00.000Z'))

    expect(retry).toEqual({ ok: true, status: 'retry_scheduled', reason: 'agent_offline', run_id: 'run-1' })
    expect(row(harness, "SELECT assigned_agent_id FROM routine_runs WHERE id = 'run-1'")).toEqual({
      assigned_agent_id: 'agent-preferred',
    })
    expect(row(harness, 'SELECT assignee_agent_id FROM tasks LIMIT 1')).toEqual({
      assignee_agent_id: 'agent-preferred',
    })
  })

  it('attributes Task, Flight, references, digest, and inbox envelope to the exact Project', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const result = await dispatchRoutineRun(env, 'run-1', NOW)
    expect(result).toMatchObject({ ok: true, status: 'dispatched' })
    if (!result.ok || result.status !== 'dispatched') return

    expect(row(harness, 'SELECT project_id, squad_id, assignee_agent_id FROM tasks WHERE id = ?', result.task_id)).toEqual({
      project_id: 'project-1', squad_id: 'squad-1', assignee_agent_id: result.agent_id,
    })
    const flight = row(harness, 'SELECT project_id, agent, status, meta FROM flights WHERE id = ?', result.flight_id)
    expect(flight).toMatchObject({ project_id: 'project-1', agent: result.agent_id, status: 'running' })
    expect(JSON.parse(String(flight?.meta))).toMatchObject({
      routine_run_id: 'run-1', routine_revision: 1, task_ids: [result.task_id],
    })
    expect(row(harness, "SELECT COUNT(*) AS count FROM routine_run_refs WHERE run_id = 'run-1'")).toEqual({ count: 3 })

    const message = row(harness, "SELECT body, request_id, project_id FROM agent_messages WHERE from_agent = 'mupot-routines'")
    expect(message?.request_id).toBe('routine-run:run-1')
    expect(message?.project_id).toBe('project-1')
    const body = JSON.parse(String(message?.body))
    expect(body).toMatchObject({
      version: 'routine.run/v1', run_id: 'run-1', project_id: 'project-1', routine_revision: 1,
      objective: 'Find and propose the next accountable action',
      situation_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      mcp_endpoint: 'https://mupot.example/mcp',
      proposal_schema: { version: 'routine.proposal/v1' },
    })
    expect(Object.keys(body).sort()).toEqual([
      'mcp_endpoint', 'objective', 'project_id', 'proposal_schema', 'routine_revision',
      'run_id', 'situation_digest', 'version',
    ])
    expect(message?.body).not.toMatch(/token|credential|thread_id|api_key|password|secret/i)
    expect(env.BUS?.send).not.toHaveBeenCalled()
  })

  it('uses a stable inbox request id when delivery is replayed', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const first = await dispatchRoutineRun(env, 'run-1', NOW)
    const replay = await dispatchRoutineRun(env, 'run-1', NOW)

    expect(first).toMatchObject({ ok: true, status: 'dispatched', duplicate: false })
    expect(replay).toMatchObject({ ok: true, status: 'dispatched', duplicate: true })
    expect(row(harness, "SELECT COUNT(*) AS count FROM agent_messages WHERE request_id = 'routine-run:run-1'")).toEqual({ count: 1 })
  })

  it('rejects a stale Routine revision or revoked Project write edge before creating work', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.prepare("UPDATE routines SET revision = 2 WHERE id = 'routine-1'").run()

    await expect(dispatchRoutineRun(env, 'run-1', NOW)).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 0 })

    harness.sqlite.prepare("UPDATE routines SET revision = 1 WHERE id = 'routine-1'").run()
    harness.sqlite.prepare("UPDATE project_squad_access SET access_level = 'read'").run()
    await expect(dispatchRoutineRun(env, 'run-1', NOW)).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 0 })
  })

  it('does not record dispatched evidence when the run changes concurrently after delivery', async () => {
    harness = makeHarness()
    const send = vi.fn(async () => {
      harness?.sqlite.prepare(
        "UPDATE routine_runs SET status = 'skipped', result_summary = 'cancelled' WHERE id = 'run-1'",
      ).run()
      return { ok: true as const, id: 'message-concurrent', duplicate: false }
    })

    await expect(dispatchRoutineRun(envFor(harness), 'run-1', NOW, { sendAgentMessage: send })).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'dispatched'")).toEqual({ count: 0 })
    expect(row(harness, "SELECT COUNT(*) AS count FROM routine_run_refs WHERE run_id = 'run-1'")).toEqual({ count: 0 })
  })

  it('does not report a retry when the run changes concurrently during failed delivery', async () => {
    harness = makeHarness()
    const send = vi.fn(async () => {
      harness?.sqlite.prepare(
        "UPDATE routine_runs SET status = 'skipped', result_summary = 'cancelled' WHERE id = 'run-1'",
      ).run()
      return { ok: false as const, reason: 'inbox_full' as const }
    })

    await expect(dispatchRoutineRun(envFor(harness), 'run-1', NOW, { sendAgentMessage: send })).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'retry_scheduled'")).toEqual({ count: 0 })
  })

  it('atomically refuses inbox delivery when cancellation lands immediately before the message insert', async () => {
    harness = makeHarness()
    const env = envWithCancellationBeforeInsert(harness, /INSERT INTO agent_messages/, 'cancel-before-message')

    await expect(dispatchRoutineRun(env, 'run-1', NOW)).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, "SELECT COUNT(*) AS count FROM agent_messages WHERE request_id = 'routine-run:run-1'")).toEqual({ count: 0 })
    expect(row(harness, "SELECT status FROM routine_runs WHERE id = 'run-1'")).toEqual({ status: 'observing' })
  })

  it('atomically refuses Task creation when cancellation lands immediately before the Task insert', async () => {
    harness = makeHarness()
    const env = envWithCancellationBeforeInsert(harness, /INSERT INTO tasks/, 'cancel-before-task')

    await expect(dispatchRoutineRun(env, 'run-1', NOW)).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 0 })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM flights')).toEqual({ count: 0 })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM agent_messages')).toEqual({ count: 0 })
  })

  it('atomically refuses Flight creation when cancellation lands immediately before the Flight insert', async () => {
    harness = makeHarness()
    const env = envWithCancellationBeforeInsert(harness, /INSERT INTO flights/, 'cancel-before-flight')

    await expect(dispatchRoutineRun(env, 'run-1', NOW)).resolves.toEqual({
      ok: false, error: 'run_not_dispatchable',
    })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 1 })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM flights')).toEqual({ count: 0 })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM agent_messages')).toEqual({ count: 0 })
  })

  it('leaves D1 statement headroom for dispatch in the scheduler invocation', async () => {
    harness = makeHarness()
    let statements = 0

    await expect(dispatchRoutineRun(envFor(harness, () => { statements += 1 }), 'run-1', NOW))
      .resolves.toMatchObject({ ok: true, status: 'dispatched' })

    expect(statements).toBeLessThanOrEqual(50 - MAX_SCHEDULER_DB_STATEMENTS)
  })
})
