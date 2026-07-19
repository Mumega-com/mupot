import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listProjectActivity, listProjectEvidence, sanitizeProjectDetail } from '../src/projects/projections'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function harness(options: { includeKeysetMigration?: boolean } = {}) {
  const fixture = createSqliteD1()
  const includeKeysetMigration = options.includeKeysetMigration ?? true
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && (includeKeysetMigration || !name.startsWith('0059_')))
    .sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // Projection fixtures insert historical rows directly; authorization-trigger behavior is
  // covered by the project-link service tests.
  fixture.sqlite.exec('DROP TRIGGER trg_project_link_receipt_authorized')
  fixture.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept', 'a', 'A'),
      ('squad-b', 'dept', 'b', 'B');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-a', 'agent-a', 'squad-a', 'member'),
      ('membership-b', 'agent-b', 'squad-b', 'member');
    INSERT INTO projects (id, slug, name, status) VALUES ('project', 'project', 'Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project', 'squad-a', 'write'),
      ('project', 'squad-b', 'write');
    INSERT INTO tasks
      (id, squad_id, title, status, assignee_agent_id, result, completed_at, project_id, created_at, updated_at, execution_receipt_id)
    VALUES
      ('task-a', 'squad-a', 'Visible task', 'done', 'agent-a', 'Verified result <safe>', '2026-07-18T20:06:00Z', 'project', '2026-07-18T20:00:00Z', '2026-07-18T20:06:00Z', 'execution-a'),
      ('task-b', 'squad-b', 'Hidden task', 'open', 'agent-b', NULL, NULL, 'project', '2026-07-18T20:01:00Z', '2026-07-18T20:01:00Z', NULL);
    INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, project_id, created_at)
    VALUES
      ('message-a', 'tenant', 'agent-b', 'agent-a', 'member-a', 'request', 'Coordinate <work>', 'request-a', 'project', '2026-07-18T20:02:00Z'),
      ('dispatch-message', 'tenant', 'agent-a', 'mupot-dispatch', 'member-a', 'request', '{"type":"task_dispatch","task_id":"task-a","dispatch_receipt_id":"dispatch-a","squad_id":"squad-a"}', 'dispatch-inbox:dispatch-a', 'project', '2026-07-18T20:03:01Z'),
      ('forged-dispatch-message', 'tenant', 'agent-a', 'mupot-dispatch', 'member-a', 'request', '{"type":"task_dispatch","task_id":"task-a","dispatch_receipt_id":"missing","squad_id":"squad-a"}', 'dispatch-inbox:missing', 'project', '2026-07-18T20:03:02Z'),
      ('ack-a', 'tenant', 'agent-a', 'agent-b', 'member-b', 'ack', 'Completed safely', NULL, 'project', '2026-07-18T20:07:00Z'),
      ('partial-message', 'tenant', 'project-channel', 'agent-a', 'member-a', 'message', 'Unsafe partial scope', NULL, 'project', '2026-07-18T20:02:30Z'),
      ('project-message', 'tenant', 'project-channel', 'project-operator', 'member-a', 'message', 'Project announcement', NULL, 'project', '2026-07-18T20:02:45Z'),
      ('project-ack', 'tenant', 'project-operator', 'project-channel', 'member-a', 'ack', 'Project acknowledged', NULL, 'project', '2026-07-18T20:07:30Z');
    INSERT INTO flights
      (id, tenant, agent, goal, status, project_id, created_at, ended_at, meta)
    VALUES
      ('flight-a', 'tenant', 'agent-a', 'Governed flight', 'landed', 'project', 1784404980000, 1784405220000,
       '{"schema":"mupot.flight.meta/v1","goal_id":"goal","objective_id":"objective","squad_ids":["squad-a"],"task_ids":["task-a"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'),
      ('flight-b', 'tenant', 'agent-b', 'Hidden flight', 'running', 'project', 1784405040000, NULL,
       '{"schema":"mupot.flight.meta/v1","goal_id":"hidden","objective_id":"hidden","squad_ids":["squad-b"],"task_ids":["task-b"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}');
    INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
      VALUES ('verdict-a', 'task-a', 'approved', 'Evidence approved', 'member-a', '2026-07-18T20:08:00Z');
    INSERT INTO workflow_receipts (id, instance_id, task_id, step_name, status, detail, created_at)
      VALUES ('workflow-a', 'instance-a', 'task-a', 'execute', 'ok', '{"safe":true}', '2026-07-18T20:04:00Z');
    INSERT INTO task_dispatch_receipts
      (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at, attempts)
      VALUES ('dispatch-a', 'tenant', 'task-a', 'squad-a', 'agent-a', 'member', 'member-a', '2026-07-18T20:03:00Z', '2026-07-18T20:03:30Z', 1);
    INSERT INTO flight_event_outbox
      (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at, delivered_at)
      VALUES ('landing-a', 'tenant', 'flight-a', 'flight.landed', 'agent', 'agent-a', '{"status":"landed"}', '2026-07-18T20:09:00Z', '2026-07-18T20:09:01Z');
    INSERT INTO project_links (
      id, tenant, local_project_id, local_squad_id, local_agent_id, local_key_id,
      remote_pot, remote_project_id, remote_link_id, remote_agent_id, remote_key_id,
      remote_public_key, remote_base_url, capabilities_json, evidence_origins_json, state, stale_after_seconds,
      last_success_at, created_by, created_at
    ) VALUES (
      'link-a', 'tenant', 'project', 'squad-a', 'agent-a', 'local-key',
      'dme', 'dme-project', 'dme-link', 'dme-agent', 'remote-key',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'https://dme.example/', '["project.task.write"]', '[]', 'active', 86400,
      '2026-07-18T20:10:00Z', 'member-a', '2026-07-18T20:00:00Z'
    );
    INSERT INTO project_link_receipts (
      id, tenant, link_id, local_project_id, direction, idempotency_key,
      correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
      remote_project_id, source_agent_id, action_type, action_id,
      evidence_sha256, receipt_key_id, receipt_signature, status, created_at
    ) VALUES (
      'link-receipt-a', 'tenant', 'link-a', 'project', 'inbound', 'delivery-a',
      'correlation-a', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'dme',
      'dme-project', 'dme-agent', 'task', 'task-a', '${'c'.repeat(64)}', 'remote-key', '${'d'.repeat(86)}',
      'accepted', '2026-07-18T20:11:00Z'
    );
  `)
  return fixture
}

function env(db: Env['DB']): Env {
  return { DB: db, TENANT_SLUG: 'tenant' } as Env
}

function concurrencyProbe(database: Env['DB']): { db: Env['DB']; maxInFlight: () => number } {
  let inFlight = 0
  let maximum = 0
  type Statement = ReturnType<Env['DB']['prepare']>

  const wrap = (statement: Statement): Statement => ({
    bind(...values: unknown[]) {
      return wrap(statement.bind(...values))
    },
    async all<T>() {
      inFlight += 1
      maximum = Math.max(maximum, inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await statement.all<T>()
      } finally {
        inFlight -= 1
      }
    },
  }) as Statement

  return {
    db: {
      prepare(sql: string) {
        return wrap(database.prepare(sql))
      },
    } as Env['DB'],
    maxInFlight: () => maximum,
  }
}

function statementProbe(database: Env['DB']): {
  db: Env['DB']
  statements: Array<{ sql: string; values: unknown[] }>
} {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  type Statement = ReturnType<Env['DB']['prepare']>

  const wrap = (statement: Statement, sql: string, values: unknown[] = []): Statement => ({
    bind(...nextValues: unknown[]) {
      return wrap(statement.bind(...nextValues), sql, nextValues)
    },
    async all<T>() {
      statements.push({ sql, values })
      return statement.all<T>()
    },
  }) as Statement

  return {
    db: {
      prepare(sql: string) {
        return wrap(database.prepare(sql), sql)
      },
    } as Env['DB'],
    statements,
  }
}

describe('project Activity and Evidence projections', () => {
  it('redacts provider credentials and sensitive fields before projection', () => {
    const unsafe = [
      ['OPENAI_API_KEY=', 'sk', '-proj-abcdefghijklmnopqrstuvwxyz'].join(''),
      ['github=', 'ghp', '_abcdefghijklmnopqrstuvwxyz'].join(''),
      ['aws=', 'AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
      ['jwt=', 'eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturepart'].join(''),
      'password: correct-horse-battery-staple',
      'Authorization: Basic Zm9vOmJhcg==',
    ].join('; ')

    const sanitized = sanitizeProjectDetail(unsafe)
    expect(sanitized).not.toContain('sk-proj-')
    expect(sanitized).not.toContain('ghp_')
    expect(sanitized).not.toContain('AKIA')
    expect(sanitized).not.toContain('eyJhbGci')
    expect(sanitized).not.toContain('correct-horse')
    expect(sanitized).not.toContain('Zm9vOmJhcg')
    expect(sanitized.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it('recursively redacts sensitive values from structured projection detail', () => {
    const sanitized = sanitizeProjectDetail(JSON.stringify({
      password: 'abc"def',
      credentials: ['secret-one', 'secret-two'],
      provider: {
        accessToken: 'nested-access-token',
        publicLabel: 'safe',
      },
    }))
    const parsed = JSON.parse(sanitized)

    expect(parsed).toEqual({
      password: '[redacted]',
      credentials: '[redacted]',
      provider: {
        accessToken: '[redacted]',
        publicLabel: 'safe',
      },
    })
    expect(sanitized).not.toContain('abc')
    expect(sanitized).not.toContain('secret-one')
    expect(sanitized).not.toContain('secret-two')
    expect(sanitized).not.toContain('nested-access-token')
  })

  it('redacts plaintext connection credentials and provider tokens', () => {
    const unsafe = [
      'DefaultEndpointsProtocol=https',
      'AccountName=test',
      'AccountKey=marker-account-secret',
      'EndpointSuffix=core.windows.net',
      'slack=xoxb-123456789012-marker',
    ].join(';')

    const sanitized = sanitizeProjectDetail(unsafe)
    expect(sanitized).not.toContain('marker-account-secret')
    expect(sanitized).not.toContain('xoxb-')
    expect(sanitized).toContain('AccountName=test')
  })

  it('redacts credentials embedded in URL query parameters', () => {
    const sanitized = sanitizeProjectDetail(
      'https://provider.example/callback?api_key=query-secret&mode=safe&access_token=access-secret#done',
    )

    expect(sanitized).not.toContain('query-secret')
    expect(sanitized).not.toContain('access-secret')
    expect(sanitized).toContain('mode=safe')
  })

  it('sanitizes every free-text title and detail exposed by project projections', async () => {
    const fixture = harness()
    try {
      fixture.sqlite.exec(`
        UPDATE tasks SET title = 'Task password=title-secret' WHERE id = 'task-a';
        UPDATE squads SET name = 'api_key=squad-secret' WHERE id = 'squad-a';
        UPDATE flights SET goal = 'Bearer flight-goal-secret' WHERE id = 'flight-a';
      `)
      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      const evidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      const exposed = JSON.stringify([...activity.rows, ...evidence.rows])

      expect(exposed).not.toContain('title-secret')
      expect(exposed).not.toContain('squad-secret')
      expect(exposed).not.toContain('flight-goal-secret')
      expect(exposed).toContain('[redacted]')
    } finally {
      fixture.close()
    }
  })

  it('merges project tasks, messages, and flights in stable newest-first order', async () => {
    const fixture = harness()
    try {
      const projection = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      expect(projection.hasMore).toBe(false)
      expect(projection.rows.map((row) => row.source_type)).toEqual(expect.arrayContaining(['task', 'message', 'flight', 'project_link']))
      expect(projection.rows.find((row) => row.source_id === 'message-a')).toMatchObject({
        source_type: 'message', status: 'request', detail: 'Coordinate <work>', correlation_id: 'request-a',
      })
      expect(projection.rows.find((row) => row.source_id === 'flight-a')).toMatchObject({
        source_type: 'flight', status: 'landed', title: 'Governed flight', actor: 'agent-a',
      })
      expect(projection.rows.find((row) => row.source_id === 'link-a')).toMatchObject({
        source_type: 'project_link', status: 'healthy', title: 'Linked project: dme / dme-project',
      })
      expect(projection.rows.map((row) => Date.parse(row.occurred_at)))
        .toEqual([...projection.rows.map((row) => Date.parse(row.occurred_at))].sort((a, b) => b - a))
    } finally {
      fixture.close()
    }
  })

  it('orders and cursors a Project Link by a failure later than its retained success', async () => {
    const fixture = harness()
    try {
      fixture.sqlite.exec(`
        UPDATE project_links
           SET last_success_at = '2026-07-18T20:10:00Z',
               last_failure_at = '2026-07-18 20:13:00',
               last_error = 'remote_http_503'
         WHERE id = 'link-a';
      `)

      const first = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 1,
      })
      expect(first.rows).toEqual([
        expect.objectContaining({
          source_id: 'link-a', status: 'failed', occurred_at: '2026-07-18T20:13:00.000Z',
        }),
      ])
      expect(first.nextCursor).toEqual({
        occurred_at: '2026-07-18T20:13:00.000Z',
        source_type: 'project_link',
        source_id: 'link-a',
      })

      const second = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20, after: first.nextCursor!,
      })
      expect(second.rows.some((row) => row.source_id === 'link-a')).toBe(false)
      expect(second.rows.length).toBeGreaterThan(0)
      expect(second.rows.every((row) => (
        Date.parse(row.occurred_at) < Date.parse(first.nextCursor!.occurred_at)
      ))).toBe(true)
    } finally {
      fixture.close()
    }
  })

  it('projects a revocation later than a retained success as the newest Project Link event', async () => {
    const fixture = harness()
    try {
      fixture.sqlite.exec(`
        UPDATE project_links
           SET state = 'revoked',
               last_success_at = '2026-07-18T20:10:00Z',
               revoked_at = '2026-07-18T20:14:00Z',
               revoked_by = 'member-a'
         WHERE id = 'link-a';
      `)

      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      expect(activity.rows[0]).toMatchObject({
        source_id: 'link-a', status: 'revoked', occurred_at: '2026-07-18T20:14:00.000Z',
      })
    } finally {
      fixture.close()
    }
  })

  it('keeps unchanged Project Link Activity stable when wall time crosses the stale boundary', async () => {
    const fixture = harness()
    const clock = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-07-18T20:10:29.999Z'))
      .mockReturnValueOnce(Date.parse('2026-07-18T20:10:30.001Z'))
    try {
      fixture.sqlite.exec(`
        UPDATE project_links
           SET stale_after_seconds = 30,
               last_success_at = '2026-07-18T20:10:00Z',
               last_failure_at = NULL
         WHERE id = 'link-a';
      `)
      const input = { projectId: 'project', readableSquadIds: null, limit: 20 } as const
      const before = await listProjectActivity(env(fixture.db), input)
      const after = await listProjectActivity(env(fixture.db), input)

      expect(after).toEqual(before)
      expect(before.rows.find((row) => row.source_id === 'link-a')).toMatchObject({ status: 'healthy' })
    } finally {
      clock.mockRestore()
      fixture.close()
    }
  })

  it('projects retained results and every supported linked receipt without fabricating success', async () => {
    const fixture = harness()
    try {
      const projection = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      expect(projection.rows.map((row) => row.source_type)).toEqual(expect.arrayContaining([
        'task_result', 'task_verdict', 'workflow_receipt', 'dispatch_receipt', 'flight_receipt', 'message_ack', 'project_link_receipt',
      ]))
      expect(projection.rows.find((row) => row.source_id === 'task-a')).toMatchObject({
        source_type: 'task_result', status: 'done', detail: 'Verified result <safe>', correlation_id: 'execution-a',
      })
      expect(projection.rows.find((row) => row.source_id === 'dispatch-a')).toMatchObject({
        source_type: 'dispatch_receipt', status: 'consumed', actor: 'member-a',
      })
      expect(projection.rows.find((row) => row.source_id === 'landing-a')).toMatchObject({
        source_type: 'flight_receipt', status: 'delivered', actor: 'agent-a',
      })
      expect(projection.rows.find((row) => row.source_id === 'link-receipt-a')).toMatchObject({
        source_type: 'project_link_receipt', status: 'accepted', actor: 'dme-agent',
        correlation_id: 'correlation-a',
        proof: {
          schema: 'mupot.project-link-receipt-proof/v1',
          direction: 'inbound',
          shared_receipt_sha256: 'b'.repeat(64),
          envelope_sha256: 'a'.repeat(64),
          evidence_sha256: 'c'.repeat(64),
          remote_pot: 'dme',
          remote_project_id: 'dme-project',
          source_agent_id: 'dme-agent',
          action_type: 'task',
          action_id: 'task-a',
          receipt_key_id: 'remote-key',
          receipt_signature: 'd'.repeat(86),
        },
      })
    } finally {
      fixture.close()
    }
  })

  it('hides message Activity and acknowledgement Evidence when only one endpoint squad is readable', async () => {
    const fixture = harness()
    try {
      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-a'], limit: 20,
      })
      const evidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-a'], limit: 20,
      })
      expect(activity.rows.some((row) => row.source_id === 'task-b' || row.source_id === 'flight-b')).toBe(false)
      expect(activity.rows.some((row) => row.source_id === 'message-a')).toBe(false)
      expect(evidence.rows.some((row) => row.source_id === 'ack-a')).toBe(false)
      expect(evidence.rows.some((row) => row.source_id === 'task-b')).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('hides message Activity and acknowledgement Evidence when neither endpoint squad is readable', async () => {
    const fixture = harness()
    try {
      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: [], limit: 20,
      })
      const evidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: [], limit: 20,
      })
      expect(activity.rows.some((row) => row.source_id === 'message-a')).toBe(false)
      expect(evidence.rows.some((row) => row.source_id === 'ack-a')).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('shows scoped messages only when both endpoint squads are readable', async () => {
    const fixture = harness()
    try {
      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-a', 'squad-b'], limit: 20,
      })
      const evidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-a', 'squad-b'], limit: 20,
      })
      expect(activity.rows.some((row) => row.source_id === 'message-a')).toBe(true)
      expect(evidence.rows.some((row) => row.source_id === 'ack-a')).toBe(true)
    } finally {
      fixture.close()
    }
  })

  it('always excludes a malformed newest flight from Activity for unrestricted readers', async () => {
    const fixture = harness()
    try {
      fixture.sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
        VALUES ('malformed-newest', 'tenant', 'agent-a', 'Malformed newest', 'running', 'project', ?, ?)
      `).run(
        Date.parse('2026-07-19T23:59:59Z'),
        JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }),
      )

      const activity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })

      expect(activity.rows.some((row) => row.source_id === 'malformed-newest')).toBe(false)
      expect(activity.rows[0]?.source_id).not.toBe('malformed-newest')
    } finally {
      fixture.close()
    }
  })

  it('shows a receipt-backed system dispatch to readers of its recipient squad only', async () => {
    const fixture = harness()
    try {
      const recipientReader = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-a'], limit: 20,
      })
      const otherReader = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: ['squad-b'], limit: 20,
      })
      const admin = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })

      expect(recipientReader.rows.find((row) => row.source_id === 'dispatch-message')).toMatchObject({
        source_type: 'message', actor: 'mupot-dispatch', correlation_id: 'dispatch-inbox:dispatch-a',
      })
      expect(otherReader.rows.some((row) => row.source_id === 'dispatch-message')).toBe(false)
      expect(admin.rows.some((row) => row.source_id === 'dispatch-message')).toBe(true)
      expect(admin.rows.some((row) => row.source_id === 'forged-dispatch-message')).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('hides messages and acknowledgements whenever either endpoint identity is unresolved', async () => {
    const fixture = harness()
    try {
      const scopedActivity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: [], limit: 20,
      })
      const scopedEvidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: [], limit: 20,
      })
      const adminActivity = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      const adminEvidence = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })

      for (const activity of [scopedActivity, adminActivity]) {
        expect(activity.rows.some((row) => row.source_id === 'partial-message')).toBe(false)
        expect(activity.rows.some((row) => row.source_id === 'project-message')).toBe(false)
      }
      for (const evidence of [scopedEvidence, adminEvidence]) {
        expect(evidence.rows.some((row) => row.source_id === 'project-ack')).toBe(false)
      }
    } finally {
      fixture.close()
    }
  })

  it('walks equal-time mixed Activity and Evidence sources exactly once', async () => {
    const fixture = harness()
    try {
      fixture.sqlite.exec(`
        DROP TRIGGER task_verdicts_no_update;
        INSERT INTO tasks (id, squad_id, title, status, project_id, created_at, updated_at)
        VALUES
          ('tie_a', 'squad-a', 'Underscore tie', 'open', 'project', '2026-07-18T20:00:00Z', '2026-07-18T20:00:00Z'),
          ('tie-a', 'squad-a', 'Hyphen tie', 'open', 'project', '2026-07-18T20:00:00Z', '2026-07-18T20:00:00Z');
        UPDATE tasks SET created_at = '2026-07-18T20:00:00Z', updated_at = '2026-07-18T20:00:00Z',
          completed_at = CASE WHEN result IS NOT NULL THEN '2026-07-18T20:00:00Z' ELSE completed_at END;
        UPDATE agent_messages SET created_at = '2026-07-18T20:00:00Z';
        UPDATE flights SET created_at = 1784404800000;
        UPDATE project_links SET last_success_at = '2026-07-18T20:00:00Z';
        UPDATE task_verdicts SET decided_at = '2026-07-18T20:00:00Z';
        UPDATE workflow_receipts SET created_at = '2026-07-18T20:00:00Z';
        UPDATE task_dispatch_receipts SET created_at = '2026-07-18T20:00:00Z';
        UPDATE flight_event_outbox SET created_at = '2026-07-18T20:00:00Z';
        UPDATE project_link_receipts SET created_at = '2026-07-18T20:00:00Z';
      `)

      for (const list of [listProjectActivity, listProjectEvidence]) {
        const complete = await list(env(fixture.db), {
          projectId: 'project', readableSquadIds: null, limit: 100,
        })
        const seen: string[] = []
        let after = undefined
        for (let pageNumber = 0; pageNumber <= complete.rows.length; pageNumber += 1) {
          const page = await list(env(fixture.db), {
            projectId: 'project', readableSquadIds: null, limit: 1, after,
          })
          seen.push(...page.rows.map((row) => `${row.source_type}:${row.source_id}`))
          after = page.nextCursor ?? undefined
          if (!after) break
        }
        expect(seen).toEqual(complete.rows.map((row) => `${row.source_type}:${row.source_id}`))
        expect(new Set(seen).size).toBe(seen.length)
      }
    } finally {
      fixture.close()
    }
  })

  it('uses ordered keyset indexes without temporary projection sorts', async () => {
    const fixture = harness()
    try {
      const probe = statementProbe(fixture.db)
      const after = {
        occurred_at: '2026-07-18T20:05:00.000Z',
        source_type: 'task',
        source_id: 'cursor-id',
      }
      await listProjectActivity(env(probe.db), {
        projectId: 'project', readableSquadIds: null, limit: 20, after,
      })
      await listProjectEvidence(env(probe.db), {
        projectId: 'project', readableSquadIds: null, limit: 20, after: {
          ...after, source_type: 'task_result',
        },
      })

      const projectionStatements = probe.statements.filter((statement) => statement.sql.includes('ORDER BY'))
      expect(projectionStatements).toHaveLength(11)
      for (const statement of projectionStatements) {
        const plan = fixture.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.values)
        const details = plan.map((row) => String(row.detail ?? '')).join('\n')
        expect(details, statement.sql).not.toContain('USE TEMP B-TREE FOR ORDER BY')
        if (statement.sql.includes('FROM task_verdicts')) {
          expect(details).toContain('SEARCH v USING INDEX idx_task_verdicts_evidence_keyset (project_id=?)')
        }
        if (statement.sql.includes('FROM workflow_receipts')) {
          expect(details).toContain('SEARCH w USING INDEX idx_workflow_receipts_evidence_keyset (project_id=?)')
        }
        if (statement.sql.includes('SELECT d.id, d.task_id')) {
          expect(details).toContain('SEARCH d USING INDEX idx_task_dispatch_receipts_evidence_keyset (tenant=? AND project_id=?)')
        }
        if (statement.sql.includes('FROM flight_event_outbox')) {
          expect(details).toContain('SEARCH o USING INDEX idx_flight_event_outbox_evidence_keyset (tenant=? AND project_id=?)')
        }
      }
    } finally {
      fixture.close()
    }
  })

  it('keeps Evidence readable when code arrives before keyset index migration', async () => {
    const fixture = harness({ includeKeysetMigration: false })
    try {
      const projection = await listProjectEvidence(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
        after: {
          occurred_at: '2026-07-18T20:12:00.000Z',
          source_type: 'project_link_receipt',
          source_id: 'cursor-id',
        },
      })
      expect(projection.rows.length).toBeGreaterThan(0)
    } finally {
      fixture.close()
    }
  })

  it('hydrates immutable project attribution on legacy receipt inserts', () => {
    const fixture = harness()
    try {
      fixture.sqlite.exec("INSERT INTO projects (id, slug, name, status) VALUES ('other-project', 'other-project', 'Other', 'active')")
      for (const [table, id] of [
        ['task_verdicts', 'verdict-a'],
        ['workflow_receipts', 'workflow-a'],
        ['task_dispatch_receipts', 'dispatch-a'],
        ['flight_event_outbox', 'landing-a'],
      ]) {
        const row = fixture.sqlite.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id)
        expect(row?.project_id).toBe('project')
        expect(() => fixture.sqlite.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ?`).run('other-project', id))
          .toThrow()
      }
      expect(() => fixture.sqlite.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run('other-project', 'task-a'))
        .toThrow(/task project locked by flight/)
      expect(() => fixture.sqlite.prepare('UPDATE flights SET project_id = ? WHERE id = ?').run('other-project', 'flight-a'))
        .toThrow(/flight project attribution downgrade/)
    } finally {
      fixture.close()
    }
  })

  it('runs no more than six Evidence source queries concurrently', async () => {
    const fixture = harness()
    try {
      const probe = concurrencyProbe(fixture.db)
      await listProjectEvidence(env(probe.db), {
        projectId: 'project', readableSquadIds: null, limit: 20,
      })
      expect(probe.maxInFlight()).toBeLessThanOrEqual(6)
    } finally {
      fixture.close()
    }
  })

  it('reports when a bounded page has additional rows', async () => {
    const fixture = harness()
    try {
      const projection = await listProjectActivity(env(fixture.db), {
        projectId: 'project', readableSquadIds: null, limit: 2,
      })
      expect(projection.rows).toHaveLength(2)
      expect(projection.hasMore).toBe(true)
    } finally {
      fixture.close()
    }
  })
})
