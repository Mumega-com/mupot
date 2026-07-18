import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listProjectActivity, listProjectEvidence } from '../src/projects/projections'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function harness() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
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

describe('project Activity and Evidence projections', () => {
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
