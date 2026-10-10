import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../src/types'
import { leaseAgentInbox, sendAgentMessage } from '../src/agents/messages'
import { cancelFlight } from '../src/flight/watchdog'
import { dispatchRoutineRun } from '../src/routines/dispatch'
import { cancelRoutineRun } from '../src/routines/actions'
import { runRouterTick } from '../src/router/engine'
import { runProjectConcierge, BUILD_CAPABILITY } from '../src/concierge/service'
import { registerModule } from '../src/registry/service'
import type { Project } from '../src/types'
import type { RoutinePrincipal } from '../src/routines/access'
import { MAX_SCHEDULER_DB_STATEMENTS } from '../src/routines/scheduler'
import { loadProjectSituation } from '../src/projects/situation'
import { loadOpsHealth } from '../src/dashboard/health'
import { loadTaskStatusCounts } from '../src/dashboard/operator-counts'
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
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('tenant-a', 'agent-preferred', 'member-preferred', '${NOW.toISOString()}'),
      ('tenant-a', 'agent-fallback', 'member-fallback', '${NOW.toISOString()}');
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
    VALUES
      ('token-preferred', 'member-preferred', 'hash-preferred', 'preferred', 'workspace', '${NOW.toISOString()}', NULL, 'agent-preferred', 'tenant-a'),
      ('token-fallback', 'member-fallback', 'hash-fallback', 'fallback', 'workspace', '${NOW.toISOString()}', NULL, 'agent-fallback', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-preferred', 'member-preferred', 'squad', 'squad-1', 'member'),
      ('cap-fallback', 'member-fallback', 'squad', 'squad-1', 'member');
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

  it('selects the canonical welded runtime after its bootstrap token is revoked', async () => {
    harness = makeHarness()
    harness.sqlite.prepare("UPDATE member_tokens SET revoked_at = ? WHERE agent_id = 'agent-preferred'")
      .run(NOW.toISOString())

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-preferred' })
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
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fromAgent: 'mupot-routines',
        projectId: 'project-1',
      }),
      expect.objectContaining({
        system: true,
        reason: expect.any(String),
      }),
      expect.objectContaining({
        systemProjectAttribution: true,
        routineRunFence: { runId: 'run-1', projectId: 'project-1', agentId: 'agent-preferred' },
      }),
    )
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

  // #1738 round 2 regression: ask_human -> answer lands the control flight and re-queues the
  // run with flight_id NULL, the old flight still in routine_run_refs. Re-dispatch must proceed.
  it('re-dispatches a run re-queued after ask_human was answered (landed control flight in refs)', async () => {
    harness = makeHarness()
    harness.sqlite.prepare(
      `INSERT INTO flights (id, tenant, project_id, agent, goal, status, budget_micro_usd,
         cost_micro_usd, created_at, started_at, meta)
       VALUES ('old-control', 'tenant-a', 'project-1', 'agent-preferred', 'g', 'landed', 100000, 0, 1, 1, '{}')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation, created_at)
       VALUES ('ref-old', 'tenant-a', 'project-1', 'run-1', 'flight', 'old-control', 'dispatch_flight', '${NOW.toISOString()}')`,
    ).run()
    harness.sqlite.prepare("UPDATE routine_runs SET flight_id = NULL, task_id = NULL WHERE id = 'run-1'").run()

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

    expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-preferred' })
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
    const lease = await leaseAgentInbox(env, {
      agent: 'agent-preferred', limit: 1, leaseSeconds: 60,
    })
    expect(lease).toMatchObject({
      ok: true,
      messages: [{
        kind: 'request',
        request_id: 'routine-run:run-1',
        project_id: 'project-1',
        expects_reply: true,
        reply_basis: 'request_id_field',
      }],
    })
    // mumega-com#970: this dispatch's own sendAgentMessage insert (asserted above via the
    // agent_messages row) now emits its own message.created event — the same plumbing
    // exercised by every other real dispatch/wake path in this codebase, not something
    // specific to routines. The ORIGINAL assertion here ("BUS.send never called") predates
    // that emit existing at all and was never a deliberate project-isolation check — no
    // other test in this file makes that claim, and dispatchRoutineRun's D1 writes above
    // are already what proves project attribution. What's actually worth pinning, and
    // fits this test's own stated purpose ("attributes ... to the exact Project"), is that
    // the EMITTED event carries the correct project/tenant — i.e. attribution survives
    // onto the bus, not just into D1.
    expect(env.BUS?.send).toHaveBeenCalledOnce()
    const emitted = (env.BUS?.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; tenant: string; payload: { project_id: string | null; request_id: string | null }
    }
    expect(emitted.type).toBe('message.created')
    expect(emitted.tenant).toBe('tenant-a')
    expect(emitted.payload.project_id).toBe('project-1')
    expect(emitted.payload.request_id).toBe('routine-run:run-1')
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

  it('uses a fresh request envelope with the durable human answer on a resumed attempt', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      UPDATE routine_runs SET attempt = 2 WHERE id = 'run-1';
      INSERT INTO routine_run_actions (
        id, tenant, project_id, run_id, action_key, kind, input_json,
        validation_status, gate_status, status, receipt_id, result_json
      ) VALUES (
        'answered-action', 'tenant-a', 'project-1', 'run-1', 'question-1', 'ask_human',
        '{"question":"Which event is authoritative?","choices":["Booked","Paid"],"references":[]}',
        'accepted', 'not_required', 'succeeded', 'answer-receipt',
        '{"answer":"Paid","answered_by":"member-1"}'
      );
    `)

    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)
    expect(result).toMatchObject({ ok: true, status: 'dispatched' })
    const message = row(harness, "SELECT request_id, body FROM agent_messages WHERE request_id = 'routine-run:run-1:attempt:2'")
    expect(message?.request_id).toBe('routine-run:run-1:attempt:2')
    expect(JSON.parse(String(message?.body))).toMatchObject({
      human_response: { question: 'Which event is authoritative?', answer: 'Paid' },
    })
  })

  it('reconstructs deterministic children after dispatch crashes before binding them to the run', async () => {
    harness = makeHarness()
    const base = envFor(harness)
    const db = harness.db
    const crashingEnv: Env = {
      ...base,
      DB: {
        prepare: db.prepare.bind(db),
        async batch() { throw new Error('simulated crash before child binding') },
      } as unknown as D1Database,
    }

    await expect(dispatchRoutineRun(crashingEnv, 'run-1', NOW)).rejects.toThrow(/child binding/)
    expect(row(harness, 'SELECT COUNT(*) AS count FROM tasks')).toEqual({ count: 1 })
    expect(row(harness, 'SELECT COUNT(*) AS count FROM flights')).toEqual({ count: 1 })
    expect(row(harness, "SELECT task_id, flight_id FROM routine_runs WHERE id = 'run-1'")).toEqual({
      task_id: null, flight_id: null,
    })

    const administrator: RoutinePrincipal = {
      tenant: 'tenant-a', actor_type: 'member', actor_id: 'owner-1', workspace_admin: true,
      grants: [],
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }
    await expect(cancelRoutineRun(base, administrator, 'run-1')).resolves.toEqual({
      ok: true, run_id: 'run-1', duplicate: false, outcome: 'unconfirmed',
    })
    expect(row(harness, 'SELECT status FROM tasks LIMIT 1')).toEqual({ status: 'blocked' })
    expect(row(harness, 'SELECT status, gate_reason FROM flights LIMIT 1')).toEqual({
      status: 'failed', gate_reason: 'routine_cancelled',
    })
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

    // Account for telemetry recording statement (32 statements total, well under free-tier 50 limit)
    expect(statements).toBeLessThanOrEqual(50 - MAX_SCHEDULER_DB_STATEMENTS + 1)
  })

  // mupot#611 item 3, end-to-end: loadCandidates (src/routines/dispatch.ts) used
  // to join ONLY on the agent's home squad column, so an agent added to a squad
  // via the separate `memberships` table while homed elsewhere was invisible to
  // dispatch — reachable by message (src/agents/messages.ts already trusts
  // `memberships`), unreachable by dispatch. These pin BOTH halves through the
  // real selectAgent/dispatchRoutineRun path (tests/routine-dispatch-candidates.test.ts
  // covers the SQL shape directly): the widened pool actually gets dispatched to,
  // AND the capability gate — now the sole authority on the widened pool — still
  // blocks a membership-only agent whose only grant is on its own home
  // department, which has nothing to do with the target squad.
  describe('mupot#611 item 3 — membership-only candidates (widened pool, gate stays authoritative)', () => {
    function addMembershipOnlyAgent(h: SqliteD1Harness): void {
      h.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-2', 'other-dept', 'Other Dept');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept-2', 'other', 'Other');
        INSERT INTO agents (id, squad_id, slug, name, status)
          VALUES ('agent-member-only', 'squad-2', 'member-only', 'Member Only', 'active');
        INSERT INTO memberships (id, agent_id, squad_id, capability)
          VALUES ('membership-only', 'agent-member-only', 'squad-1', 'member');
        INSERT INTO members (id, display_name, status, tenant)
          VALUES ('member-only', 'Member-only runtime', 'active', 'tenant-a');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
          VALUES ('tenant-a', 'agent-member-only', 'member-only', '${NOW.toISOString()}');
        INSERT INTO member_tokens
          (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES
          ('token-member-only', 'member-only', 'hash-member-only', 'member-only', 'workspace', '${NOW.toISOString()}', NULL, 'agent-member-only', 'tenant-a');
        INSERT INTO fleet_agents
          (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at)
        VALUES
          ('agent-member-only', 'tenant-a', 'Member Only', 'codex', '["squad-2"]', 'always_on', 'running', 'host', '2026-07-19 15:59:30', '2026-07-19 15:59:30');
        -- neither preferred nor fallback is eligible — forces selection down to
        -- whatever the widened pool contributes.
        DELETE FROM capabilities WHERE id IN ('cap-preferred', 'cap-fallback');
      `)
    }

    it('dispatches to a membership-only agent once it holds real authority on the target squad', async () => {
      harness = makeHarness()
      addMembershipOnlyAgent(harness)
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
          VALUES ('cap-member-only', 'member-only', 'squad', 'squad-1', 'member');
      `)

      const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

      expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-member-only' })
    })

    it('does NOT dispatch to a membership-only agent whose only grant is admin on its OWN home department', async () => {
      // This is the exact shape a naive fix (pulling department_id from the
      // candidate's home squad instead of the target squad) would have gotten
      // wrong: dept-2 is agent-member-only's home department and has nothing to
      // do with squad-1 (dept-1). If loadCandidates handed selectAgent the
      // candidate's OWN department here, this grant would incorrectly satisfy
      // hasCapability's department-inheritance branch — an authority leak, not
      // a missed dispatch.
      harness = makeHarness()
      addMembershipOnlyAgent(harness)
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
          VALUES ('cap-member-only', 'member-only', 'department', 'dept-2', 'admin');
      `)

      const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

      expect(result).toEqual({ ok: true, status: 'waiting', reason: 'agent', run_id: 'run-1' })
    })

    it("DOES dispatch when the grant is department-admin on the TARGET squad's department", async () => {
      // Sanity companion to the negative test above: department inheritance
      // works correctly when the grant is actually on squad-1's department
      // (dept-1), proving the fix narrows WHICH department is checked rather
      // than breaking department inheritance altogether.
      harness = makeHarness()
      addMembershipOnlyAgent(harness)
      harness.sqlite.exec(`
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
          VALUES ('cap-member-only', 'member-only', 'department', 'dept-1', 'admin');
      `)

      const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)

      expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-member-only' })
    })
  })
})


// #1756 r2: flight_cancel in the create-before-observe window must fail closed (no message, sane run state).
describe('#1756 control flight cancelled before the run observes it', () => {
  function envCancellingAtObserve(harness: SqliteD1Harness): { env: Env; cancelled: () => boolean } {
    const base = envFor(harness)
    let armed = false
    let done = false
    const db = harness.db
    return {
      cancelled: () => done,
      env: {
        ...base,
        DB: {
          prepare(sql: string) {
            if (!done && /SET status = 'observing', assigned_agent_id = \?, task_id = \?/.test(sql)) armed = true
            return db.prepare(sql)
          },
          async batch(statements: D1PreparedStatement[]) {
            if (armed && !done) {
              done = true
              // The control flight exists (preflight) but routine_runs.flight_id is still NULL: the cancel matches no run.
              const row = harness.sqlite.prepare("SELECT id FROM flights WHERE status = 'preflight'").get() as { id: string }
              const res = await cancelFlight(base, row.id, { actor: { kind: 'member', id: 'm-admin' }, isOrgAdmin: true }, 'stop')
              expect(res).toMatchObject({ transitioned: true })
            }
            return db.batch(statements)
          },
        } as unknown as D1Database,
      } as Env,
    }
  }
  const delivered = (h: SqliteD1Harness) =>
    (h.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'mupot-routines'").get() as { n: number }).n

  it('cancel in the window: no message delivered, run ends terminal with a reason', async () => {
    const harness = makeHarness()
    const { env, cancelled } = envCancellingAtObserve(harness)
    const result = await dispatchRoutineRun(env, 'run-1', NOW)
    expect(cancelled()).toBe(true)
    expect(result).toEqual({ ok: false, error: 'run_not_dispatchable' })
    expect(delivered(harness)).toBe(0)
    expect(harness.sqlite.prepare("SELECT status, result_summary, finished_at IS NOT NULL AS fin, flight_id FROM routine_runs WHERE id='run-1'").get())
      .toMatchObject({ status: 'cancelled', result_summary: 'control_flight_cancelled_before_dispatch', fin: 1, flight_id: null })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind = 'observed'").get()).toEqual({ n: 0 })
  })

  it('the routine send fence refuses a non-live control flight on its own (dispatch_fenced)', async () => {
    const harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, cost_metered, created_at, project_id)
        VALUES ('cf-1', 'tenant-a', 'agent-preferred', 'g', 'failed', 100, '{}', 1, 1, 'project-1');
      UPDATE routine_runs SET status = 'observing', flight_id = 'cf-1' WHERE id = 'run-1';
    `)
    const send = () => sendAgentMessage(envFor(harness), {
      fromAgent: 'mupot-routines', fromMember: 'system:routines', toAgent: 'agent-preferred', body: 'do it', kind: 'request',
      requestId: 'routine-run:run-1', projectId: 'project-1',
    }, { system: true, reason: 'test' }, { systemProjectAttribution: true, routineRunFence: { runId: 'run-1', projectId: 'project-1', agentId: 'agent-preferred' } })
    expect(await send()).toEqual({ ok: false, reason: 'dispatch_fenced' })
    expect(delivered(harness)).toBe(0)
    harness.sqlite.exec("UPDATE flights SET status = 'running' WHERE id = 'cf-1'")
    expect(await send()).toMatchObject({ ok: true })
    expect(delivered(harness)).toBe(1)
  })
})

describe('mupot#1571 archived task is inert at the routine delivery', () => {
  it('a control task archived before the observe write: no agent message is delivered, run is not dispatched', async () => {
    const harness = makeHarness()
    const base = envFor(harness)
    const db = harness.db
    let armed = true
    const env = {
      ...base,
      DB: {
        prepare(sql: string) {
          if (armed && /SET status = 'observing', assigned_agent_id = \?, task_id = \?/.test(sql)) {
            armed = false
            harness.sqlite.exec(`
              INSERT INTO members (id, tenant, email, display_name, status) VALUES ('arch-op', 'tenant-a', 'arch@example.com', 'A', 'active');
              INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
                SELECT id, '2026-10-08T00:00:00.000Z', 'test', 'arch-op', status FROM tasks;
            `)
          }
          return db.prepare(sql)
        },
        batch: db.batch.bind(db),
      } as unknown as D1Database,
    } as Env
    const result = await dispatchRoutineRun(env, 'run-1', NOW)
    expect(armed).toBe(false)
    expect(result).toEqual({ ok: false, error: 'run_not_dispatchable' })
    expect((harness.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'mupot-routines'").get() as { n: number }).n).toBe(0)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind = 'dispatched'").get()).toEqual({ n: 0 })
    harness.close()
  })
})

// mupot#1812 P2-2 - the execution pause reaches routine dispatch (selection AND the writes).
describe('routine dispatch respects execution_pauses', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })
  const pause = (h: SqliteD1Harness, scope: 'agent' | 'squad', id: string) => h.sqlite.exec(
    `INSERT INTO members (id, tenant, display_name, status) VALUES ('op-1', 'tenant-a', 'Op', 'active') ON CONFLICT DO NOTHING;
     INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
     VALUES ('p-${scope}', 'tenant-a', '${scope}', '${id}', 'r', 'op-1', '2026-07-19T15:00:00.000Z')`)
  const sent = (h: SqliteD1Harness) =>
    (h.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'mupot-routines'").get() as { n: number }).n

  it('a paused preferred agent is skipped for the live unpaused alternative', async () => {
    harness = makeHarness()
    pause(harness, 'agent', 'agent-preferred')
    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)
    expect(result).toMatchObject({ ok: true, status: 'dispatched', agent_id: 'agent-fallback' })
  })

  it('a squad pause covers every agent: the run settles with a clear reason, no task, flight or envelope', async () => {
    harness = makeHarness()
    pause(harness, 'squad', 'squad-1')
    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)
    expect(result).toEqual({ ok: true, status: 'retry_scheduled', reason: 'execution_paused', run_id: 'run-1' })
    expect(row(harness, "SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'"))
      .toEqual({ status: 'queued', result_summary: 'execution_paused' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
    expect(sent(harness)).toBe(0)
  })

  it('after max attempts a paused run waits on agent (not looping) with the pause reason', async () => {
    harness = makeHarness()
    pause(harness, 'squad', 'squad-1')
    harness.sqlite.prepare("UPDATE routine_runs SET attempt = 3 WHERE id = 'run-1'").run()
    const result = await dispatchRoutineRun(envFor(harness), 'run-1', NOW)
    expect(result).toEqual({ ok: true, status: 'waiting', reason: 'agent', run_id: 'run-1' })
    expect(row(harness, "SELECT status, waiting_reason, result_summary FROM routine_runs WHERE id = 'run-1'"))
      .toEqual({ status: 'waiting', waiting_reason: 'agent', result_summary: 'execution_paused' })
  })

  it('a resumed pause lets the run dispatch', async () => {
    harness = makeHarness()
    pause(harness, 'squad', 'squad-1')
    harness.sqlite.prepare("UPDATE execution_pauses SET resumed_at = '2026-07-19T15:30:00.000Z', resumed_by_member_id = 'op-1'").run()
    expect(await dispatchRoutineRun(envFor(harness), 'run-1', NOW)).toMatchObject({ ok: true, status: 'dispatched' })
  })

  it('RACE: a pause landing after selection is refused by the observing UPDATE: no envelope, settled paused', async () => {
    harness = makeHarness()
    const h = harness
    let armed = true
    const env = envFor(h)
    const real = h.db
    const raced = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (armed && sql.includes("SET status = 'observing'")) { armed = false; pause(h, 'squad', 'squad-1') }
          return real.prepare(sql)
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env
    const result = await dispatchRoutineRun(raced, 'run-1', NOW)
    expect(armed).toBe(false)
    expect(result).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'execution_paused' })
    expect(sent(h)).toBe(0)
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind = 'dispatched'").get()).toEqual({ n: 0 })
  })

  it('RACE: a pause landing after the envelope is refused by the in_progress UPDATE: task not in_progress, run not running', async () => {
    harness = makeHarness()
    const h = harness
    let armed = true
    const env = envFor(h)
    const real = h.db
    const raced = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (armed && sql.includes("SET status = 'running'")) { armed = false; pause(h, 'squad', 'squad-1') }
          return real.prepare(sql)
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env
    const result = await dispatchRoutineRun(raced, 'run-1', NOW)
    expect(armed).toBe(false)
    expect(result).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'execution_paused' })
    expect(harness.sqlite.prepare("SELECT status FROM routine_runs WHERE id = 'run-1'").get()).toEqual({ status: 'queued' })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'in_progress'").get()).toEqual({ n: 0 })
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind = 'dispatched'").get()).toEqual({ n: 0 })
  })

  // mupot#1814 - the routine.run/v1 envelope INSERT is itself pause-fenced.
  it('RACE: a pause landing between the observing UPDATE and the envelope INSERT: no envelope, settled paused, no orphan task left assigned', async () => {
    harness = makeHarness()
    const h = harness
    let armed = true
    const env = envFor(h)
    const real = h.db
    const raced = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (armed && sql.includes('INSERT INTO agent_messages')) { armed = false; pause(h, 'agent', 'agent-preferred') }
          return real.prepare(sql)
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env
    const result = await dispatchRoutineRun(raced, 'run-1', NOW)
    expect(armed).toBe(false)
    expect(result).toEqual({ ok: true, status: 'retry_scheduled', reason: 'execution_paused', run_id: 'run-1' })
    expect(row(h, "SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'"))
      .toEqual({ status: 'queued', result_summary: 'execution_paused' })
    expect(sent(h)).toBe(0)
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind = 'dispatched'").get()).toEqual({ n: 0 })
    // the control task the attempt created is released, never left assigned to the paused agent
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee_agent_id = 'agent-preferred'").get()).toEqual({ n: 0 })
    expect(h.sqlite.prepare("SELECT status, assignee_agent_id AS a FROM tasks WHERE title LIKE 'Routine:%'").all())
      .toEqual([{ status: 'blocked', a: null }])
    expect(h.sqlite.prepare("SELECT status FROM flights WHERE agent = 'agent-preferred'").all()).toEqual([{ status: 'failed' }])
  })

  it('RACE: the same envelope-insert pause via the agent\'s SQUAD', async () => {
    harness = makeHarness()
    const h = harness
    let armed = true
    const real = h.db
    const raced = {
      ...envFor(h),
      DB: {
        prepare(sql: string) {
          if (armed && sql.includes('INSERT INTO agent_messages')) { armed = false; pause(h, 'squad', 'squad-1') }
          return real.prepare(sql)
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env
    expect(await dispatchRoutineRun(raced, 'run-1', NOW)).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'execution_paused' })
    expect(sent(h)).toBe(0)
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee_agent_id IS NOT NULL").get()).toEqual({ n: 0 })
  })

  // ---- mupot#1814 round 2 ----
  const raceBefore = (h: SqliteD1Harness, fragment: string, action: () => void): Env => {
    let armed = true
    const real = h.db
    return {
      ...envFor(h),
      DB: {
        prepare(sql: string) {
          if (armed && sql.includes(fragment)) { armed = false; action() }
          return real.prepare(sql)
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env
  }
  // The fleet row keyed by SLUG (registry slug fallback): selected.inboxAgentId is then 'preferred'.
  const slugKeyFleet = (h: SqliteD1Harness) => h.sqlite.exec(
    `UPDATE fleet_agents SET agent_id = 'preferred' WHERE agent_id = 'agent-preferred';
     UPDATE fleet_agents SET agent_id = 'fallback' WHERE agent_id = 'agent-fallback'`)
  const tasksOf = (h: SqliteD1Harness) => h.sqlite.prepare(
    "SELECT status, assignee_agent_id AS a FROM tasks WHERE title LIKE 'Routine:%'").all()
  const releaseAudits = (h: SqliteD1Harness) => (h.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE handler = 'routine_dispatch_pause_release'").get() as { n: number }).n

  it('slug-keyed fleet row control: the envelope goes to the SLUG inbox when no pause is active', async () => {
    harness = makeHarness()
    slugKeyFleet(harness)
    expect(await dispatchRoutineRun(envFor(harness), 'run-1', NOW)).toMatchObject({ ok: true, status: 'dispatched' })
    expect(harness.sqlite.prepare("SELECT to_agent FROM agent_messages WHERE from_agent = 'mupot-routines'").all())
      .toEqual([{ to_agent: 'preferred' }])
  })

  for (const scope of ['agent', 'squad'] as const) {
    it(`RACE r2: slug-keyed fleet row + ${scope} pause before the envelope INSERT -> no envelope (canonical id fenced)`, async () => {
      harness = makeHarness()
      const h = harness
      slugKeyFleet(h)
      const raced = raceBefore(h, 'INSERT INTO agent_messages', () => pause(h, scope, scope === 'agent' ? 'agent-preferred' : 'squad-1'))
      expect(await dispatchRoutineRun(raced, 'run-1', NOW)).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'execution_paused' })
      expect(sent(h)).toBe(0)
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    })
  }

  it('the released orphan is blocked + unassigned with an audit row (envelope-insert path)', async () => {
    harness = makeHarness()
    const h = harness
    await dispatchRoutineRun(raceBefore(h, 'INSERT INTO agent_messages', () => pause(h, 'agent', 'agent-preferred')), 'run-1', NOW)
    expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    expect(h.sqlite.prepare("SELECT result FROM tasks WHERE title LIKE 'Routine:%'").get()).toMatchObject({ result: expect.stringContaining('execution_paused') })
    expect(releaseAudits(h)).toBe(1)
  })

  it('the released orphan is released on the OBSERVING-UPDATE pause path too', async () => {
    harness = makeHarness()
    const h = harness
    const raced = raceBefore(h, "SET status = 'observing'", () => pause(h, 'squad', 'squad-1'))
    expect(await dispatchRoutineRun(raced, 'run-1', NOW)).toMatchObject({ reason: 'execution_paused' })
    expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    expect(releaseAudits(h)).toBe(1)
  })

  it('the released orphan is released on the POST-ENVELOPE pause path too', async () => {
    harness = makeHarness()
    const h = harness
    const raced = raceBefore(h, "SET status = 'running'", () => pause(h, 'squad', 'squad-1'))
    expect(await dispatchRoutineRun(raced, 'run-1', NOW)).toMatchObject({ reason: 'execution_paused' })
    expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    expect(releaseAudits(h)).toBe(1)
  })

  it('release guard: an agent that moved the task to in_progress during the window keeps it (not blocked, not unassigned, no audit)', async () => {
    harness = makeHarness()
    const h = harness
    const raced = raceBefore(h, 'INSERT INTO agent_messages', () => {
      pause(h, 'agent', 'agent-preferred')
      h.sqlite.exec("UPDATE tasks SET status = 'in_progress' WHERE title LIKE 'Routine:%'")
    })
    await dispatchRoutineRun(raced, 'run-1', NOW)
    expect(tasksOf(h)).toEqual([{ status: 'in_progress', a: 'agent-preferred' }])
    expect(releaseAudits(h)).toBe(0)
  })

  it('release guard: a task reassigned to another agent during the window is left alone', async () => {
    harness = makeHarness()
    const h = harness
    const raced = raceBefore(h, 'INSERT INTO agent_messages', () => {
      pause(h, 'agent', 'agent-preferred')
      h.sqlite.exec("UPDATE tasks SET assignee_agent_id = 'agent-fallback' WHERE title LIKE 'Routine:%'")
    })
    await dispatchRoutineRun(raced, 'run-1', NOW)
    expect(tasksOf(h)).toEqual([{ status: 'open', a: 'agent-fallback' }])
    expect(releaseAudits(h)).toBe(0)
  })

  describe('the released orphan is non-routable (r2 P3-1)', () => {
    async function orphan(h: SqliteD1Harness) {
      await dispatchRoutineRun(raceBefore(h, 'INSERT INTO agent_messages', () => pause(h, 'agent', 'agent-preferred')), 'run-1', NOW)
      // the pause is lifted: only the task's shape may keep it from being re-picked
      h.sqlite.exec("UPDATE execution_pauses SET resumed_at = '2026-07-19T16:30:00.000Z', resumed_by_member_id = 'op-1'")
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    }

    it('router_tick skips it (a plain open unassigned task IS scanned: control)', async () => {
      harness = makeHarness()
      const h = harness
      await orphan(h)
      h.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id)
          VALUES ('plain-1', 'squad-1', 'project-1', 'Plain', 'b', 'done', 'open', NULL);
        INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
          VALUES ('tenant-a', 'seat-f', 'F', 'test', 'seat-f', 'agent-fallback', datetime('now'), datetime('now'))`)
      const out = await runRouterTick(envFor(h),
        { ok: true, tenant: 'tenant-a', squadId: 'squad-1', agentId: null, source: 'principal' },
        { squadId: 'squad-1', dryRun: false }, { memberId: 'op-1' })
      expect(out.decisions.map(d => d.task_id)).toEqual(['plain-1'])
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    })

    it('the concierge router does not re-assign it', async () => {
      harness = makeHarness()
      const h = harness
      await orphan(h)
      const env = envFor(h)
      expect((await registerModule(env, {
        identity: 'agent-fallback', kind: 'agent_system', adapter: 'cursor', projectId: null, capabilities: [BUILD_CAPABILITY],
      })).ok).toBe(true)
      const project: Project = {
        id: 'project-1', slug: 'project-1', name: 'Project One', description: '', goal: 'Reach a verified outcome',
        status: 'active', parent_project_id: null, target_date: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      }
      await runProjectConcierge(env, project)
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
    })
  })

  // ---- mupot#1821 ----
  // A pause lifted AFTER the refusing write must not change what the refusal is reported as, nor leave the
  // control task assigned with a live control flight. The pause lands just before `pauseAt` is prepared and is
  // lifted the moment the refusing write has run (after the batch that carries it, or - for any re-read that is
  // issued afterwards - just before that re-read executes), so only an outcome decided at the write survives.
  describe('mupot#1821 pause lifted between the refusing write and its diagnosis', () => {
    function liftRace(h: SqliteD1Harness, pauseAt: string): Env {
      const real = h.db
      const sqlOf = new WeakMap<object, string>()
      let paused = false
      let lifted = false
      const lift = () => {
        lifted = true
        h.sqlite.prepare("UPDATE execution_pauses SET resumed_at = '2026-07-19T16:00:01.000Z', resumed_by_member_id = 'op-1' WHERE resumed_at IS NULL").run()
      }
      return {
        ...envFor(h),
        DB: {
          prepare(sql: string) {
            if (!paused && sql.includes(pauseAt)) { paused = true; pause(h, 'agent', 'agent-preferred') }
            // a post-refusal re-read of the pause (the pre-fix diagnosis) sees it already lifted
            if (paused && !lifted && sql.includes('SELECT 1 AS paused WHERE')) lift()
            const statement = real.prepare(sql)
            sqlOf.set(statement, sql)
            return statement
          },
          async batch(statements: D1PreparedStatement[]) {
            const out = await real.batch(statements)
            if (paused && !lifted && statements.some(st => sqlOf.get(st)?.includes(pauseAt))) lift()
            return out
          },
        } as unknown as D1Database,
      } as Env
    }
    const liveControlFlights = (h: SqliteD1Harness) => (h.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM flights WHERE status IN ('preflight','running')").get() as { n: number }).n
    const expectSettledPaused = (h: SqliteD1Harness, result: unknown) => {
      expect(result).toEqual({ ok: true, status: 'retry_scheduled', reason: 'execution_paused', run_id: 'run-1' })
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
      expect(liveControlFlights(h)).toBe(0)
      expect(releaseAudits(h)).toBe(1)
    }

    it('envelope INSERT refused by the pause, pause lifted before the diagnosis: reported paused, task released, flight failed (not inbox_full)', async () => {
      harness = makeHarness()
      const result = await dispatchRoutineRun(liftRace(harness, 'INSERT INTO agent_messages'), 'run-1', NOW)
      expectSettledPaused(harness, result)
      expect(sent(harness)).toBe(0)
    })

    it('observing UPDATE refused by the pause, pause lifted before the diagnosis: task released, flight failed (not left assigned + live)', async () => {
      harness = makeHarness()
      const result = await dispatchRoutineRun(liftRace(harness, "SET status = 'observing'"), 'run-1', NOW)
      expectSettledPaused(harness, result)
      expect(sent(harness)).toBe(0)
    })

    it('post-envelope UPDATE refused by the pause, pause lifted before the diagnosis: task released, flight failed', async () => {
      harness = makeHarness()
      const result = await dispatchRoutineRun(liftRace(harness, "SET status = 'running'"), 'run-1', NOW)
      expectSettledPaused(harness, result)
    })

    it('sendAgentMessage under the routine fence reports execution_paused (not inbox_full) when the pause lifts after the refusal', async () => {
      harness = makeHarness()
      const h = harness
      h.sqlite.exec(`
        INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, cost_metered, created_at, project_id)
          VALUES ('cf-1', 'tenant-a', 'agent-preferred', 'g', 'running', 100, '{}', 1, 1, 'project-1');
        UPDATE routine_runs SET status = 'observing', flight_id = 'cf-1' WHERE id = 'run-1'`)
      const result = await sendAgentMessage(liftRace(h, 'INSERT INTO agent_messages'), {
        fromAgent: 'mupot-routines', fromMember: 'system:routines', toAgent: 'agent-preferred', body: 'do it', kind: 'request',
        requestId: 'routine-run:run-1', projectId: 'project-1',
      }, { system: true, reason: 'test' }, {
        systemProjectAttribution: true,
        routineRunFence: { runId: 'run-1', projectId: 'project-1', agentId: 'agent-preferred' },
      })
      expect(result).toMatchObject({ ok: false, reason: 'execution_paused' })
      expect(sent(h)).toBe(0)
    })

    it('control: a genuinely full inbox with no pause is still reported inbox_full', async () => {
      harness = makeHarness()
      const h = harness
      h.sqlite.exec(`
        INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, cost_metered, created_at, project_id)
          VALUES ('cf-1', 'tenant-a', 'agent-preferred', 'g', 'running', 100, '{}', 1, 1, 'project-1');
        UPDATE routine_runs SET status = 'observing', flight_id = 'cf-1' WHERE id = 'run-1'`)
      const result = await sendAgentMessage(envFor(h), {
        fromAgent: 'mupot-routines', fromMember: 'system:routines', toAgent: 'agent-preferred', body: 'do it', kind: 'request',
        requestId: 'routine-run:run-1', projectId: 'project-1',
      }, { system: true, reason: 'test' }, {
        systemProjectAttribution: true, maxUnread: 0,
        routineRunFence: { runId: 'run-1', projectId: 'project-1', agentId: 'agent-preferred' },
      })
      expect(result).toMatchObject({ ok: false, reason: 'inbox_full' })
    })
  })

  // The not-archived guard in releasePausedControlTask is NOT redundant: the observing step's own check runs
  // BEFORE the window in which an archive can land, so the release itself must refuse an archived task.
  it('mupot#1821 release guard: a control task archived during the window is inert - not blocked, not unassigned, no audit', async () => {
    harness = makeHarness()
    const h = harness
    const raced = raceBefore(h, 'INSERT INTO agent_messages', () => {
      pause(h, 'agent', 'agent-preferred')
      h.sqlite.exec(`
        INSERT INTO members (id, tenant, email, display_name, status) VALUES ('arch-op', 'tenant-a', 'arch@example.com', 'A', 'active');
        INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
          SELECT id, '2026-10-08T00:00:00.000Z', 'test', 'arch-op', status FROM tasks WHERE title LIKE 'Routine:%'`)
    })
    expect(await dispatchRoutineRun(raced, 'run-1', NOW)).toMatchObject({ reason: 'execution_paused' })
    expect(tasksOf(h)).toEqual([{ status: 'open', a: 'agent-preferred' }])
    expect(releaseAudits(h)).toBe(0)
  })

  describe('mupot#1821 released control orphans stay out of human-facing blocked lists and totals', () => {
    const REAL_IDS = ['real-1', 'real-2', 'real-3', 'real-4', 'real-5']
    async function orphanPlusRealBlocked(h: SqliteD1Harness): Promise<void> {
      // the ORPHAN comes from the real dispatch pause-race path (never a hand-written row)
      await dispatchRoutineRun(raceBefore(h, 'INSERT INTO agent_messages', () => pause(h, 'agent', 'agent-preferred')), 'run-1', NOW)
      expect(tasksOf(h)).toEqual([{ status: 'blocked', a: null }])
      // real blockers are OLDER than the orphan, so the orphan is the newest failure and the freshest blocked row
      REAL_IDS.forEach((id, i) => h.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, result, updated_at)
          VALUES ('${id}', 'squad-1', 'project-1', 'Real ${id}', 'b', 'done', 'blocked', NULL, 'needs a human', '2026-07-19T10:0${i}:00.000Z')`))
    }
    const project: Project = {
      id: 'project-1', slug: 'project-1', name: 'Project One', description: '', goal: 'Reach a verified outcome',
      status: 'active', parent_project_id: null, target_date: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }

    it('project situation: blocked count and blocker list carry only the real blocked tasks', async () => {
      harness = makeHarness()
      await orphanPlusRealBlocked(harness)
      const situation = await loadProjectSituation(envFor(harness), project, null)
      expect(situation.task_counts.blocked).toBe(REAL_IDS.length)
      expect(situation.blockers.map(b => b.id).sort()).toEqual([...REAL_IDS].sort())
    })

    it('project situation: a project whose only blocked task is an orphan is not reported blocked', async () => {
      harness = makeHarness()
      await dispatchRoutineRun(raceBefore(harness, 'INSERT INTO agent_messages', () => pause(harness!, 'agent', 'agent-preferred')), 'run-1', NOW)
      const situation = await loadProjectSituation(envFor(harness), project, null)
      expect(situation.task_counts.blocked).toBe(0)
      expect(situation.health).not.toBe('blocked')
    })

    it('dashboard totals and recent failures count only the real ones (limit 5 is not consumed by the orphan)', async () => {
      harness = makeHarness()
      await orphanPlusRealBlocked(harness)
      const env = envFor(harness)
      expect((await loadTaskStatusCounts(env)).get('blocked')).toBe(REAL_IDS.length)
      const health = await loadOpsHealth(env, { userId: 'owner-1', email: 'o@test', role: 'owner', tenant: 'tenant-a' }, NOW.getTime())
      expect(health.kpis.blockedOrRejected).toBe(REAL_IDS.length)
      const failureTitles = health.recentFailures.map(f => f.title).filter(t => t.startsWith('Real') || t.startsWith('Routine:'))
      expect(failureTitles.sort()).toEqual(REAL_IDS.map(id => `Real ${id}`).sort())
    })

    it('an orphan a human re-works under a new result is counted again (the stamp, not the title, identifies it)', async () => {
      harness = makeHarness()
      await orphanPlusRealBlocked(harness)
      harness.sqlite.exec("UPDATE tasks SET result = 'human picked this up' WHERE title LIKE 'Routine:%'")
      expect((await loadTaskStatusCounts(envFor(harness))).get('blocked')).toBe(REAL_IDS.length + 1)
    })

    it('a human task merely TITLED "Routine:" is never treated as an orphan', async () => {
      harness = makeHarness()
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, result, updated_at)
          VALUES ('lookalike', 'squad-1', 'project-1', 'Routine: look-alike', 'b', 'done', 'blocked', NULL, 'execution_paused: routine dispatch refused by an execution pause; task released', '2026-07-19T10:00:00.000Z')`)
      expect((await loadTaskStatusCounts(envFor(harness))).get('blocked')).toBe(1)
    })
  })

  // mupot#1821 item 3: the post-envelope pause path legitimately costs more than the success path (it has already
  // run preflight + telemetry before the finishing batch refuses, then settles). Counted as prepared statements.
  describe('mupot#1821 D1 statement budget is pinned per path', () => {
    // 50 free-tier statements minus the scheduler's worst case, plus the telemetry statement: the success path is
    // exactly AT this budget, so nothing may be added to it (the pause diagnoses below ride only on refusals).
    const SUCCESS_CAP = 50 - MAX_SCHEDULER_DB_STATEMENTS + 1
    // The post-envelope pause path has already prepared the whole finishing batch (6) plus preflight + telemetry
    // before it is refused, then spends pause read + failFlight + release (2) + settle (2). Its measured cost is
    // 38; that is ACCEPTED (it only bites a 50-statement plan whose scheduler also did worst-case work in the same
    // invocation, on a rare pause race) and pinned here so it cannot grow unnoticed.
    const POST_ENVELOPE_PAUSE_CAP = 38
    async function count(h: SqliteD1Harness, raceAt?: string): Promise<{ n: number; result: unknown }> {
      let n = 0
      const real = h.db
      let armed = raceAt !== undefined
      const env = {
        ...envFor(h),
        DB: {
          prepare(sql: string) {
            n += 1
            if (armed && raceAt && sql.includes(raceAt)) { armed = false; pause(h, 'squad', 'squad-1') }
            return real.prepare(sql)
          },
          batch: real.batch.bind(real),
        } as unknown as D1Database,
      } as Env
      const result = await dispatchRoutineRun(env, 'run-1', NOW)
      return { n, result }
    }
    it('success path stays at or under its cap', async () => {
      harness = makeHarness()
      const { n, result } = await count(harness)
      expect(result).toMatchObject({ ok: true, status: 'dispatched' })
      expect(n).toBeLessThanOrEqual(SUCCESS_CAP)
    })
    it('post-envelope pause path stays at or under its own (documented, accepted) cap', async () => {
      harness = makeHarness()
      const { n, result } = await count(harness, "SET status = 'running'")
      expect(result).toMatchObject({ reason: 'execution_paused' })
      expect(n).toBeLessThanOrEqual(POST_ENVELOPE_PAUSE_CAP)
    })
    it('envelope-insert and observing pause paths stay under the success cap', async () => {
      for (const at of ['INSERT INTO agent_messages', "SET status = 'observing'"]) {
        const h = makeHarness()
        const { n } = await count(h, at)
        h.close()
        expect(n).toBeLessThanOrEqual(SUCCESS_CAP)
      }
    })
  })
})
