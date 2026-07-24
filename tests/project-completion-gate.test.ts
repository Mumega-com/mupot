// tests/project-completion-gate.test.ts — project lifecycle slice 2.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal (all child tasks
// terminal with gate PASS + completion evidence) via a different-principal verdict.
// Self-verdict blocked. completed → archived writes lessons-capture receipt.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import {
  LESSONS_CAPTURE_SCHEMA,
  LESSONS_CAPTURE_STEP,
  applyProjectCompletionVerdict,
  completionInstanceId,
  defaultCompletionGateDeps,
  enterProjectReview,
  evaluateStructuralSignal,
  isProjectSelfVerdict,
  parseLessonsCaptureDetail,
} from '../src/projects/completion-gate'
import { getProject, updateProject } from '../src/projects/service'
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
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
    VALUES ('agent-builder', 'squad-a', 'agent-builder', 'Builder', 'active', '2026-06-01T00:00:00.000Z');
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
    verdictBy?: string
  },
): void {
  const resultSql = opts.result === null ? 'NULL' : `'${opts.result.replace(/'/g, "''")}'`
  const gateSql = opts.gateOwner === null ? 'NULL' : `'${opts.gateOwner}'`
  const assignee = opts.assigneeAgentId === undefined ? 'agent-builder' : opts.assigneeAgentId
  const assigneeSql = assignee === null ? 'NULL' : `'${assignee}'`
  const verdictBy = opts.verdictBy ?? 'agent-reviewer'
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, title, body, done_when, status, assignee_agent_id, result, completed_at,
      gate_owner, project_id, created_at, updated_at
    ) VALUES (
      '${opts.id}', 'squad-a', 'Task ${opts.id}', '', 'done', 'done', ${assigneeSql},
      ${resultSql}, '2026-07-01T00:00:00.000Z', ${gateSql}, '${opts.projectId}',
      '2026-06-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
  `)
  if (opts.verdict !== null) {
    harness.sqlite.exec(`
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
      VALUES (
        'verdict-${opts.id}', '${opts.id}', '${opts.verdict}', NULL, '${verdictBy}',
        '2026-07-01T01:00:00.000Z', '${opts.projectId}'
      );
    `)
  }
}

describe('evaluateStructuralSignal (pure)', () => {
  it('is ready when all children are done, gated PASS by different principal, and evidence present', () => {
    expect(evaluateStructuralSignal([
      {
        id: 't1',
        status: 'done',
        gate_owner: 'gate:dev',
        result: 'pr#1 merged',
        assignee_agent_id: 'agent-builder',
        latest_verdict: 'approved',
        latest_verdict_by: 'agent-reviewer',
      },
    ]).ready).toBe(true)
  })

  it('rejects ungated done+result as completion evidence', () => {
    const signal = evaluateStructuralSignal([
      {
        id: 't2',
        status: 'done',
        gate_owner: null,
        result: 'docs shipped',
        assignee_agent_id: 'agent-builder',
        latest_verdict: null,
        latest_verdict_by: null,
      },
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('gate_not_pass')
  })

  it('rejects gate:agent-self-completion as evidence', () => {
    const signal = evaluateStructuralSignal([
      {
        id: 't3',
        status: 'done',
        gate_owner: 'gate:agent-self-completion',
        result: 'llm filler',
        assignee_agent_id: 'agent-builder',
        latest_verdict: 'approved',
        latest_verdict_by: 'agent-builder',
      },
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('self_gated')
  })

  it('rejects assignee self-verdict even with a real gate', () => {
    const signal = evaluateStructuralSignal([
      {
        id: 't4',
        status: 'done',
        gate_owner: 'gate:dev',
        result: 'shipped',
        assignee_agent_id: 'agent-builder',
        latest_verdict: 'approved',
        latest_verdict_by: 'agent-builder',
      },
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('self_verdict')
  })

  it('blocks on missing evidence even when gates PASS', () => {
    const signal = evaluateStructuralSignal([
      {
        id: 't1',
        status: 'done',
        gate_owner: 'gate:dev',
        result: null,
        assignee_agent_id: 'agent-builder',
        latest_verdict: 'approved',
        latest_verdict_by: 'agent-reviewer',
      },
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('missing_evidence')
  })
})

describe('isProjectSelfVerdict', () => {
  it('blocks when decider equals completion_proposed_by', () => {
    expect(isProjectSelfVerdict('agent-builder', 'agent-builder')).toBe(true)
  })
  it('allows a different principal', () => {
    expect(isProjectSelfVerdict('agent-builder', 'agent-reviewer')).toBe(false)
  })
})

describe('project structural completion gate', () => {
  it('pass-path: structural signal → review → different-principal verdict → completed → archive writes lessons', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-pass')
      insertDoneTask(harness, {
        id: 'task-1', projectId: 'proj-pass', result: 'shipped artifact', gateOwner: 'gate:dev', verdict: 'approved',
      })

      // Bare self-report of completed is blocked (not a legal transition).
      await expect(updateProject(env, 'proj-pass', { status: 'completed' }))
        .resolves.toEqual({ ok: false, error: 'invalid_status_transition' })

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
        { verdict: 'approved', principal: 'agent-reviewer', note: 'LGTM' },
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
        verdictBy: 'agent-reviewer',
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
        { verdict: 'approved', principal: 'agent-builder', note: null },
        defaultCompletionGateDeps(),
      )
      expect(selfVerdict).toEqual({ ok: false, error: 'self_verdict' })
      expect((await getProject(env, 'proj-self'))?.status).toBe('review')
    } finally {
      harness.close()
    }
  })

  it('P0-c TOCTOU: status compare-and-set rejects a stale completion write', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-race')
      const existing = await getProject(env, 'proj-race')
      expect(existing?.status).toBe('active')

      // Concurrent writer flips status between the caller's read and persist.
      harness.sqlite.prepare(
        "UPDATE projects SET status = 'paused', updated_at = ? WHERE id = ?",
      ).run('2026-07-23T18:00:00.000Z', 'proj-race')

      // Stale CAS targeting the pre-race (active, old updated_at) must write 0 rows.
      const cas = await env.DB.prepare(
        `UPDATE projects SET status = 'review', updated_at = ?
          WHERE id = ? AND updated_at = ? AND status = ?`,
      ).bind(
        '2026-07-23T18:00:01.000Z',
        'proj-race',
        existing!.updated_at,
        'active',
      ).run()
      expect(Number(cas.meta?.changes ?? 0)).toBe(0)
      expect((await getProject(env, 'proj-race'))?.status).toBe('paused')
    } finally {
      harness.close()
    }
  })
})
