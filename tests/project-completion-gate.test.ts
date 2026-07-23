// tests/project-completion-gate.test.ts — project lifecycle slice 2.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal (all child tasks
// terminal with gate PASS + completion evidence) via a different-principal verdict.
// Self-verdict blocked. completed → archived writes lessons-capture receipt.
// Ungated / gate:agent-self-completion tasks are NOT completion evidence.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import {
  AGENT_SELF_COMPLETION_GATE,
  LESSONS_CAPTURE_SCHEMA,
  LESSONS_CAPTURE_STEP,
  applyProjectCompletionVerdict,
  applyProjectCompletionVerdictFromAuth,
  completionInstanceId,
  defaultCompletionGateDeps,
  enterProjectReview,
  evaluateStructuralSignal,
  isProjectSelfVerdict,
  lifecyclePrincipalFromAuth,
  parseLessonsCaptureDetail,
  taskCountsAsCompletionEvidence,
  type ChildTaskRow,
} from '../src/projects/completion-gate'
import { getProject, sanitizeExternalProjectUpdate, updateProject } from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO members (id, email, display_name, status)
    VALUES ('member-operator', 'op@example.com', 'Operator', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at)
    VALUES
      ('agent-builder', 'squad-a', 'builder', 'Builder', 'worker', 'active', '2026-06-01T00:00:00.000Z'),
      ('agent-reviewer', 'squad-a', 'reviewer', 'Reviewer', 'worker', 'active', '2026-06-01T00:00:00.000Z'),
      ('ghost-agent', 'squad-a', 'ghost', 'Ghost', 'worker', 'active', '2026-06-01T00:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function insertProject(harness: SqliteD1Harness, id: string, status = 'active'): void {
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', 'Ship it', '${status}', NULL, NULL,
      NULL, 0, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
    );
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
    VALUES ('${id}', 'squad-a', 'write', '2026-06-01T00:00:00.000Z');
  `)
}

function insertDoneTask(
  harness: SqliteD1Harness,
  opts: {
    id: string
    projectId: string
    result: string | null
    gateOwner: string | null
    verdict: 'approved' | 'rejected' | null
    assigneeAgentId?: string | null
    decidedBy?: string
  },
): void {
  const resultSql = opts.result === null ? 'NULL' : `'${opts.result.replace(/'/g, "''")}'`
  const gateSql = opts.gateOwner === null ? 'NULL' : `'${opts.gateOwner}'`
  const assignee = opts.assigneeAgentId === undefined || opts.assigneeAgentId === null
    ? 'NULL'
    : `'${opts.assigneeAgentId}'`
  const decidedBy = opts.decidedBy ?? 'agent-reviewer'
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, title, body, done_when, status, assignee_agent_id, result, completed_at,
      gate_owner, project_id, created_at, updated_at
    ) VALUES (
      '${opts.id}', 'squad-a', 'Task ${opts.id}', '', 'done', 'done', ${assignee},
      ${resultSql}, '2026-07-01T00:00:00.000Z', ${gateSql}, '${opts.projectId}',
      '2026-06-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
  `)
  if (opts.verdict !== null) {
    harness.sqlite.exec(`
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
      VALUES (
        'verdict-${opts.id}', '${opts.id}', '${opts.verdict}', NULL, '${decidedBy}',
        '2026-07-01T01:00:00.000Z', '${opts.projectId}'
      );
    `)
  }
}

function childRow(partial: Partial<ChildTaskRow> & Pick<ChildTaskRow, 'id'>): ChildTaskRow {
  return {
    status: 'done',
    gate_owner: 'gate:dev',
    result: 'pr#1 merged',
    assignee_agent_id: 'agent-builder',
    latest_verdict: 'approved',
    latest_decided_by: 'agent-reviewer',
    decided_by_is_member: 0,
    ...partial,
  }
}

describe('sanitizeExternalProjectUpdate', () => {
  it('strips via_completion_gate, via_start_gate, lifecycle_principal, and completion_proposed_by', () => {
    expect(sanitizeExternalProjectUpdate({
      status: 'completed',
      via_completion_gate: true,
      via_start_gate: true,
      lifecycle_principal: 'forged',
      completion_proposed_by: 'forged',
      name: 'Keep me',
    })).toEqual({ status: 'completed', name: 'Keep me' })
  })
})

describe('evaluateStructuralSignal (pure)', () => {
  it('is ready when all children have real-gate different-principal PASS + evidence', () => {
    expect(evaluateStructuralSignal([
      childRow({ id: 't1', gate_owner: 'gate:dev', result: 'pr#1 merged' }),
      childRow({
        id: 't2',
        gate_owner: 'gate:docs',
        result: 'docs shipped',
        latest_decided_by: 'member-operator',
        decided_by_is_member: 1,
      }),
    ]).ready).toBe(true)
  })

  it('blocks ungated done tasks even with non-empty result', () => {
    const signal = evaluateStructuralSignal([
      childRow({
        id: 't1',
        gate_owner: null,
        result: 'sensor/lidar filler',
        latest_verdict: null,
        latest_decided_by: null,
      }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('gate_not_pass')
  })

  it('rejects gate:agent-self-completion as evidence even when approved', () => {
    expect(taskCountsAsCompletionEvidence(childRow({
      id: 't1',
      gate_owner: AGENT_SELF_COMPLETION_GATE,
      latest_verdict: 'approved',
      latest_decided_by: 'member-operator',
      decided_by_is_member: 1,
    }))).toBe(false)
    const signal = evaluateStructuralSignal([
      childRow({
        id: 't1',
        gate_owner: AGENT_SELF_COMPLETION_GATE,
        latest_verdict: 'approved',
        latest_decided_by: 'member-operator',
        decided_by_is_member: 1,
      }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('gate_not_pass')
  })

  it('accepts ungated task only with explicit human/operator sign-off', () => {
    expect(taskCountsAsCompletionEvidence(childRow({
      id: 't1',
      gate_owner: null,
      latest_verdict: 'approved',
      latest_decided_by: 'member-operator',
      decided_by_is_member: 1,
    }))).toBe(true)
  })

  it('blocks on missing evidence even when gates PASS', () => {
    const signal = evaluateStructuralSignal([
      childRow({ id: 't1', result: null }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('missing_evidence')
  })

  it('blocks self-approved gated tasks (decider === assignee)', () => {
    expect(taskCountsAsCompletionEvidence(childRow({
      id: 't1',
      assignee_agent_id: 'agent-builder',
      latest_decided_by: 'agent-builder',
    }))).toBe(false)
  })
})

describe('isProjectSelfVerdict / lifecyclePrincipalFromAuth', () => {
  it('blocks when decider equals completion_proposed_by', () => {
    expect(isProjectSelfVerdict('agent-builder', 'agent-builder')).toBe(true)
  })
  it('allows a different principal', () => {
    expect(isProjectSelfVerdict('agent-builder', 'agent-reviewer')).toBe(false)
  })
  it('derives principal from auth, preferring bound agent then member', () => {
    expect(lifecyclePrincipalFromAuth({
      userId: 'user-1',
      email: null,
      role: 'member',
      tenant: TENANT,
      memberId: 'member-operator',
      boundAgentId: 'agent-bound',
    })).toBe('agent-bound')
    expect(lifecyclePrincipalFromAuth({
      userId: 'user-1',
      email: null,
      role: 'admin',
      tenant: TENANT,
      memberId: 'member-operator',
      boundAgentId: null,
    })).toBe('member-operator')
  })
})

describe('project structural completion gate', () => {
  it('pass-path: structural signal → review → different-principal verdict → completed → archive writes lessons', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-pass')
      insertDoneTask(harness, {
        id: 'task-1',
        projectId: 'proj-pass',
        result: 'shipped artifact',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: 'agent-builder',
        decidedBy: 'agent-reviewer',
      })

      // Bare self-report of completed is blocked (not a legal transition).
      await expect(updateProject(env, 'proj-pass', { status: 'completed' }))
        .resolves.toEqual({ ok: false, error: 'invalid_status_transition' })

      // Forged via_completion_gate on a bare update (simulating stripped REST body
      // still somehow reaching service without the flag) — with sanitizer applied:
      const forged = sanitizeExternalProjectUpdate({
        status: 'review',
        via_completion_gate: true,
      })
      await expect(updateProject(env, 'proj-pass', forged))
        .resolves.toEqual({ ok: false, error: 'completion_gate_required' })

      const entered = await enterProjectReview(
        env,
        'proj-pass',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered.ok).toBe(true)
      if (!entered.ok) throw new Error(entered.error)
      expect(entered.value.status).toBe('review')
      expect(entered.value.completion_proposed_by).toBe('agent-builder')

      const verdict = await applyProjectCompletionVerdict(
        env,
        'proj-pass',
        { verdict: 'approved', note: 'LGTM' },
        'agent-reviewer',
        defaultCompletionGateDeps(),
      )
      expect(verdict.ok).toBe(true)
      if (!verdict.ok) throw new Error(verdict.error)
      expect(verdict.value.status).toBe('completed')
      expect(verdict.value.completion_proposed_by).toBeNull()

      const archived = await updateProject(env, 'proj-pass', {
        status: 'archived',
        lifecycle_principal: 'member:owner',
      })
      expect(archived.ok).toBe(true)
      expect((await getProject(env, 'proj-pass'))?.status).toBe('archived')

      const row = harness.sqlite
        .prepare(
          `SELECT detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(completionInstanceId('proj-pass'), LESSONS_CAPTURE_STEP) as { detail: string }
      const lessons = parseLessonsCaptureDetail(row.detail)
      expect(lessons?.schema).toBe(LESSONS_CAPTURE_SCHEMA)
      expect(lessons?.principal).toBe('member:owner')
      expect(lessons?.from_status).toBe('completed')
      expect(lessons?.to_status).toBe('archived')
    } finally {
      harness.close()
    }
  })

  it('REST-boundary forge: via_completion_gate in body is stripped → completion_gate_required', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-forge')
      insertDoneTask(harness, {
        id: 'task-forge',
        projectId: 'proj-forge',
        result: 'done work',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: 'agent-builder',
      })

      // Simulate REST PATCH handler: sanitize then update.
      const body = {
        status: 'review',
        via_completion_gate: true,
        completion_proposed_by: 'attacker',
        lifecycle_principal: 'attacker',
      }
      const result = await updateProject(env, 'proj-forge', sanitizeExternalProjectUpdate(body))
      expect(result).toEqual({ ok: false, error: 'completion_gate_required' })
      expect((await getProject(env, 'proj-forge'))?.status).toBe('active')
      expect((await getProject(env, 'proj-forge'))?.completion_proposed_by).toBeNull()

      // Second hop forge to completed also blocked.
      const completedForge = await updateProject(
        env,
        'proj-forge',
        sanitizeExternalProjectUpdate({ status: 'completed', via_completion_gate: true }),
      )
      expect(completedForge).toEqual({ ok: false, error: 'invalid_status_transition' })
    } finally {
      harness.close()
    }
  })

  it('missing-evidence block: cannot enter review without completion evidence', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-no-ev')
      insertDoneTask(harness, {
        id: 'task-empty', projectId: 'proj-no-ev', result: null, gateOwner: 'gate:dev', verdict: 'approved',
      })

      const entered = await enterProjectReview(
        env,
        'proj-no-ev',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'missing_completion_evidence',
        signal: { ready: false, reason: 'missing_evidence' },
      })
      expect((await getProject(env, 'proj-no-ev'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('ungated done tasks with filler result cannot enter review', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-ungated')
      insertDoneTask(harness, {
        id: 'task-ungated',
        projectId: 'proj-ungated',
        result: 'sensor/lidar LLM filler',
        gateOwner: null,
        verdict: null,
      })

      const entered = await enterProjectReview(
        env,
        'proj-ungated',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'gate_not_pass',
        signal: { ready: false, reason: 'gate_not_pass' },
      })
      expect((await getProject(env, 'proj-ungated'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('gate:agent-self-completion tasks cannot enter review', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-self-gate')
      insertDoneTask(harness, {
        id: 'task-self-gate',
        projectId: 'proj-self-gate',
        result: 'ghost agent filler',
        gateOwner: AGENT_SELF_COMPLETION_GATE,
        verdict: 'approved',
        assigneeAgentId: 'ghost-agent',
        decidedBy: 'member-operator',
      })

      const entered = await enterProjectReview(
        env,
        'proj-self-gate',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'gate_not_pass',
      })
    } finally {
      harness.close()
    }
  })

  it('self-verdict block: proposer cannot approve their own completion', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-self')
      insertDoneTask(harness, {
        id: 'task-self',
        projectId: 'proj-self',
        result: 'done work',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: 'agent-builder',
        decidedBy: 'agent-reviewer',
      })

      const entered = await enterProjectReview(
        env,
        'proj-self',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered.ok).toBe(true)

      const selfVerdict = await applyProjectCompletionVerdict(
        env,
        'proj-self',
        { verdict: 'approved', note: null },
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(selfVerdict).toEqual({ ok: false, error: 'self_verdict' })
      expect((await getProject(env, 'proj-self'))?.status).toBe('review')
    } finally {
      harness.close()
    }
  })

  it('WARN-2: FromAuth derives principal from auth, ignoring any body principal field', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-auth')
      insertDoneTask(harness, {
        id: 'task-auth',
        projectId: 'proj-auth',
        result: 'done work',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: 'agent-builder',
      })
      const entered = await enterProjectReview(
        env,
        'proj-auth',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered.ok).toBe(true)

      const auth: AuthContext = {
        userId: 'user-reviewer',
        email: null,
        role: 'admin',
        tenant: TENANT,
        memberId: 'member-operator',
        boundAgentId: null,
      }
      // Body-shaped object must not carry a forgeable principal — API takes auth.
      const verdict = await applyProjectCompletionVerdictFromAuth(
        env,
        'proj-auth',
        { verdict: 'approved', note: null },
        auth,
        defaultCompletionGateDeps(),
      )
      expect(verdict.ok).toBe(true)
      if (!verdict.ok) throw new Error(verdict.error)
      expect(verdict.value.status).toBe('completed')
    } finally {
      harness.close()
    }
  })

  it('TOCTOU: incomplete child task blocks status flip via trigger/CAS', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-toctou')
      insertDoneTask(harness, {
        id: 'task-ok',
        projectId: 'proj-toctou',
        result: 'done',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: 'agent-builder',
      })
      // Concurrent incomplete child appears before the write.
      harness.sqlite.exec(`
        INSERT INTO tasks (
          id, squad_id, title, body, done_when, status, assignee_agent_id, result, completed_at,
          gate_owner, project_id, created_at, updated_at
        ) VALUES (
          'task-open', 'squad-a', 'Open', '', 'done', 'open', NULL,
          NULL, NULL, 'gate:dev', 'proj-toctou',
          '2026-06-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        );
      `)

      const entered = await enterProjectReview(
        env,
        'proj-toctou',
        'agent-builder',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'task_not_terminal',
      })
      expect((await getProject(env, 'proj-toctou'))?.status).toBe('active')

      // Direct via_completion_gate write also refused by CAS incomplete check / trigger.
      await expect(updateProject(env, 'proj-toctou', {
        status: 'review',
        via_completion_gate: true,
        completion_proposed_by: 'agent-builder',
      })).resolves.toEqual({ ok: false, error: 'completion_gate_required' })
    } finally {
      harness.close()
    }
  })

  it('WARN-1: parent_project_id self-FK is restored after migration 0069', () => {
    const harness = makeHarness()
    try {
      const row = harness.sqlite
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
        .get() as { sql: string }
      expect(row.sql).toMatch(/parent_project_id\s+TEXT\s+REFERENCES\s+"?projects"?\s*\(\s*id\s*\)\s+ON DELETE RESTRICT/i)
    } finally {
      harness.close()
    }
  })
})
