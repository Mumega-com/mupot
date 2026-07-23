// tests/project-completion-gate.test.ts — project lifecycle slice 2.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal (all child tasks
// terminal with gated different-principal PASS or human sign-off + evidence).
// Self-verdict blocked. completed → archived writes lessons-capture receipt.
// Ungated / gate:agent-self-completion self-reports do NOT count as evidence.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import {
  AGENT_SELF_COMPLETION_GATE,
  LESSONS_CAPTURE_SCHEMA,
  LESSONS_CAPTURE_STEP,
  applyProjectCompletionVerdict,
  completionInstanceId,
  completionPrincipalFromAuth,
  defaultCompletionGateDeps,
  enterProjectReview,
  evaluateStructuralSignal,
  isProjectSelfVerdict,
  parseLessonsCaptureDetail,
  taskCountsAsCompletionEvidence,
  type ChildTaskRow,
} from '../src/projects/completion-gate'
import { getProject, updateProject } from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { projectsApp } = await import('../src/projects')

const projectApi = new Hono<{ Bindings: Env }>()
projectApi.route('/api/projects', projectsApp)

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
    INSERT INTO members (id, email, display_name, status, created_at)
    VALUES ('member-reviewer', 'reviewer@test', 'Reviewer', 'active', '2026-06-01T00:00:00.000Z');
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

function adminAuth(): AuthContext {
  return {
    userId: 'usr-admin',
    memberId: 'member-reviewer',
    email: 'reviewer@test',
    role: 'admin',
    tenant: TENANT,
    capabilities: [{
      member_id: 'member-reviewer',
      scope_type: 'org',
      scope_id: null,
      capability: 'admin',
    }],
  }
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
    assigneeAgentId: string | null
    decidedBy: string | null
  },
): void {
  const resultSql = opts.result === null ? 'NULL' : `'${opts.result.replace(/'/g, "''")}'`
  const gateSql = opts.gateOwner === null ? 'NULL' : `'${opts.gateOwner}'`
  const assigneeSql = opts.assigneeAgentId === null ? 'NULL' : `'${opts.assigneeAgentId}'`
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
  if (opts.verdict !== null && opts.decidedBy !== null) {
    harness.sqlite.exec(`
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
      VALUES (
        'verdict-${opts.id}', '${opts.id}', '${opts.verdict}', NULL, '${opts.decidedBy}',
        '2026-07-01T01:00:00.000Z', '${opts.projectId}'
      );
    `)
  }
}

function gatedPassRow(overrides: Partial<ChildTaskRow> = {}): ChildTaskRow {
  return {
    id: 't1',
    status: 'done',
    gate_owner: 'gate:dev',
    result: 'pr#1 merged',
    assignee_agent_id: 'agent-builder',
    latest_verdict: 'approved',
    latest_decided_by: 'agent-reviewer',
    latest_decider_is_human: false,
    ...overrides,
  }
}

describe('evaluateStructuralSignal (pure)', () => {
  it('is ready when all children are gated PASS by a different principal with evidence', () => {
    expect(evaluateStructuralSignal([
      gatedPassRow(),
      gatedPassRow({
        id: 't2',
        gate_owner: 'gate:docs',
        result: 'docs shipped',
        latest_decided_by: 'agent-docs-reviewer',
      }),
    ]).ready).toBe(true)
  })

  it('accepts human/operator sign-off even without a real gate', () => {
    expect(evaluateStructuralSignal([
      gatedPassRow({
        gate_owner: null,
        latest_decided_by: 'member-reviewer',
        latest_decider_is_human: true,
      }),
    ]).ready).toBe(true)
  })

  it('rejects ungated self-reported done tasks as completion evidence', () => {
    const signal = evaluateStructuralSignal([
      gatedPassRow({
        gate_owner: null,
        latest_verdict: null,
        latest_decided_by: null,
        latest_decider_is_human: false,
      }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('ungated_self_report')
    expect(taskCountsAsCompletionEvidence(gatedPassRow({
      gate_owner: null,
      latest_verdict: null,
      latest_decided_by: null,
    }))).toBe(false)
  })

  it('rejects gate:agent-self-completion as different-principal evidence', () => {
    const signal = evaluateStructuralSignal([
      gatedPassRow({
        gate_owner: AGENT_SELF_COMPLETION_GATE,
        latest_decided_by: 'agent-reviewer',
      }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('ungated_self_report')
  })

  it('rejects same-principal approved verdict on a gated task', () => {
    const signal = evaluateStructuralSignal([
      gatedPassRow({
        assignee_agent_id: 'agent-builder',
        latest_decided_by: 'agent-builder',
      }),
    ])
    expect(signal.ready).toBe(false)
    expect(signal.reason).toBe('gate_not_pass')
  })

  it('blocks on missing evidence even when gates PASS', () => {
    const signal = evaluateStructuralSignal([
      gatedPassRow({ result: null }),
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

describe('completionPrincipalFromAuth', () => {
  it('prefers boundAgentId, then memberId, then userId', () => {
    expect(completionPrincipalFromAuth({
      userId: 'usr-1', memberId: 'mbr-1', boundAgentId: 'ag-1', role: 'member', tenant: TENANT,
    })).toBe('ag-1')
    expect(completionPrincipalFromAuth({
      userId: 'usr-1', memberId: 'mbr-1', role: 'member', tenant: TENANT,
    })).toBe('mbr-1')
    expect(completionPrincipalFromAuth({
      userId: 'usr-1', role: 'member', tenant: TENANT,
    })).toBe('usr-1')
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
        assigneeAgentId: null,
        decidedBy: 'agent-reviewer',
      })

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
        'agent-reviewer',
        { verdict: 'approved', note: 'LGTM' },
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
        id: 'task-empty',
        projectId: 'proj-no-ev',
        result: null,
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: null,
        decidedBy: 'agent-reviewer',
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
        assigneeAgentId: null,
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
        'agent-builder',
        { verdict: 'approved', note: null },
        defaultCompletionGateDeps(),
      )
      expect(selfVerdict).toEqual({ ok: false, error: 'self_verdict' })
      expect((await getProject(env, 'proj-self'))?.status).toBe('review')
    } finally {
      harness.close()
    }
  })

  it('rejects ungated self-report tasks as project completion evidence', async () => {
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
        assigneeAgentId: null,
        decidedBy: null,
      })

      const entered = await enterProjectReview(
        env,
        'proj-ungated',
        'ghost-agent',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'ungated_self_report',
        signal: { ready: false, reason: 'ungated_self_report' },
      })
      expect((await getProject(env, 'proj-ungated'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('rejects gate:agent-self-completion self-report as project completion evidence', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-self-gate')
      insertDoneTask(harness, {
        id: 'task-self-gate',
        projectId: 'proj-self-gate',
        result: 'filler result',
        gateOwner: AGENT_SELF_COMPLETION_GATE,
        verdict: 'approved',
        assigneeAgentId: null,
        decidedBy: 'ghost-agent',
      })

      const entered = await enterProjectReview(
        env,
        'proj-self-gate',
        'ghost-agent',
        defaultCompletionGateDeps(),
      )
      expect(entered).toMatchObject({
        ok: false,
        error: 'ungated_self_report',
      })
    } finally {
      harness.close()
    }
  })

  it('atomic flip: concurrent incomplete child blocks active→review after signal read', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-race')
      insertDoneTask(harness, {
        id: 'task-race-1',
        projectId: 'proj-race',
        result: 'shipped',
        gateOwner: 'gate:dev',
        verdict: 'approved',
        assigneeAgentId: null,
        decidedBy: 'agent-reviewer',
      })

      // Simulate TOCTOU: reopen a child between signal read and status flip by
      // injecting an incomplete task after evaluate would have passed, then
      // forcing the flip path to re-check via require_structural_ready.
      const deps = defaultCompletionGateDeps()
      const signalOk = await enterProjectReview(env, 'proj-race', 'agent-builder', {
        ...deps,
        updateProject: async (e, id, input) => {
          harness.sqlite.exec(`
            INSERT INTO tasks (
              id, squad_id, title, body, done_when, status, assignee_agent_id, result,
              completed_at, gate_owner, project_id, created_at, updated_at
            ) VALUES (
              'task-race-reopen', 'squad-a', 'Late task', '', 'done', 'open', NULL, NULL,
              NULL, NULL, 'proj-race', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'
            );
          `)
          return deps.updateProject(e, id, input)
        },
      })
      expect(signalOk).toMatchObject({ ok: false, error: 'structural_completion_required' })
      expect((await getProject(env, 'proj-race'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })
})

describe('REST PATCH strips via_completion_gate (P0 bypass)', () => {
  afterEach(() => {
    authState.current = null
  })

  it('ignores via_completion_gate in body and returns completion_gate_required for review', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, 'proj-bypass')
      authState.current = adminAuth()

      const res = await projectApi.request(
        'https://pot.test/api/projects/proj-bypass',
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            origin: 'https://pot.test',
          },
          body: JSON.stringify({
            status: 'review',
            via_completion_gate: true,
            completion_proposed_by: 'forged-principal',
            lifecycle_principal: 'forged-lifecycle',
          }),
        },
        env,
      )
      expect(res.status).toBe(409)
      await expect(res.json()).resolves.toEqual({ error: 'completion_gate_required' })
      expect((await getProject(env, 'proj-bypass'))?.status).toBe('active')
      expect((await getProject(env, 'proj-bypass'))?.completion_proposed_by).toBeNull()
    } finally {
      harness.close()
    }
  })
})
