import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import { canonicalJsonDigest } from '../../src/lib/canonical-json'
import { loadProjectSituation } from '../../src/projects/situation'
import type { RoutinePrincipal } from '../../src/routines/access'
import type { RoutineProposal, RoutineProposalAction } from '../../src/routines/proposal'
import type { Env, Project } from '../../src/types'
import { createSqliteD1, type SqliteD1Harness } from './sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations')

export interface ReadyRoutineFixture {
  harness: SqliteD1Harness
  env: Env
  principal: RoutinePrincipal
  digest: string
  proposal(action: RoutineProposalAction): RoutineProposal
}

export async function makeReadyRoutineFixture(
  executionMode: 'propose' | 'execute_internal' = 'execute_internal',
): Promise<ReadyRoutineFixture> {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  const policy = JSON.stringify({
    execution_mode: executionMode,
    overlap_policy: 'skip',
    responsible_squad_id: 'squad-1',
    preferred_agent_id: 'agent-1',
    budget_micro_usd: 100000,
    max_attempts: 3,
    retry_backoff_seconds: 300,
  })
  const meta = JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'routine-1',
    objective_id: 'run-1',
    squad_ids: ['squad-1'],
    task_ids: ['control-task'],
    done_when: ['A correlated proposal is accepted.'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
    routine_run_id: 'run-1',
    routine_revision: 1,
  })
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active'),
      ('agent-2', 'squad-1', 'agent-2', 'Agent Two', 'active');
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
      'routine-1', 'tenant-a', 'project-1', 'Next action', 'Advance the Project',
      'enabled', 'cron', '* * * * *', 'UTC', '2026-07-20T00:00:00.000Z',
      'skip', '${executionMode}', 'squad-1', 'agent-1', 100000, 3, 300, 1,
      'owner-1', '2026-07-19T16:00:00.000Z', 'owner-1',
      '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
    );
    INSERT INTO tasks (
      id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
      created_at, updated_at
    ) VALUES (
      'control-task', 'squad-1', 'project-1', 'Routine control', '',
      'A correlated proposal is accepted.', 'in_progress', 'agent-1',
      '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
    );
    INSERT INTO flights (
      id, tenant, project_id, agent, goal, status, trigger_source, gate_verdict,
      score, budget_micro_usd, cost_micro_usd, created_at, started_at, meta
    ) VALUES (
      'control-flight', 'tenant-a', 'project-1', 'agent-1', 'Advance the Project',
      'running', 'schedule', 'go', 1, 100000, 0, 1752940800000, 1752940800000,
      '${meta.replaceAll("'", "''")}'
    );
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, scheduled_for, status, attempt, assigned_agent_id, task_id, flight_id,
      cost_micro_usd, started_at, created_at, updated_at
    ) VALUES (
      'run-1', 'tenant-a', 'project-1', 'routine-1', 1, '${policy.replaceAll("'", "''")}',
      'cron:2026-07-19T16:00:00[UTC]', 'cron', '2026-07-19T16:00:00.000Z',
      'running', 1, 'agent-1', 'control-task', 'control-flight', 0,
      '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
    );
    INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation)
    VALUES
      ('ref-control-task', 'tenant-a', 'project-1', 'run-1', 'task', 'control-task', 'dispatch_task'),
      ('ref-control-flight', 'tenant-a', 'project-1', 'run-1', 'flight', 'control-flight', 'dispatch_flight');
  `)

  const env = {
    DB: harness.db,
    TENANT_SLUG: 'tenant-a',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
  const project = harness.sqlite.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id,
            target_date, created_at, updated_at FROM projects WHERE id = 'project-1'`,
  ).get() as unknown as Project
  const situation = await loadProjectSituation(env, project, ['squad-1'], {
    excludeTaskIds: ['control-task'],
    excludeFlightIds: ['control-flight'],
  })
  const digest = await canonicalJsonDigest(situation)
  harness.sqlite.prepare("UPDATE routine_runs SET situation_digest = ? WHERE id = 'run-1'").run(digest)

  const grants = [{ member_id: 'member-1', scope_type: 'squad' as const, scope_id: 'squad-1', capability: 'member' as const }]
  const principal: RoutinePrincipal = {
    tenant: 'tenant-a', actor_type: 'agent', actor_id: 'agent-1', workspace_admin: false,
    grants,
    project_read: { workspaceAdmin: false, orgRead: false, squadIds: ['squad-1'], departmentIds: [] },
  }
  return {
    harness,
    env,
    principal,
    digest,
    proposal(action) {
      return {
        version: 'routine.proposal/v1',
        run_id: 'run-1',
        project_id: 'project-1',
        situation_digest: digest,
        summary: 'This is the next accountable action.',
        action,
      }
    },
  }
}
