// tests/project-circuit-breaker.test.ts — project lifecycle slice 1 (kill default).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
// Codex diverse-gate hardenings (P0-1..4, WARN-1..2): forged-receipt rejection,
// auth-derived principal + self-verdict block, TOCTOU re-read, canonical UTC epoch,
// migration applied-version guard, gated authenticated recommit action.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env, Project } from '../src/types'
import {
  KILL_REASON_NO_RECOMMIT,
  RECOMMIT_OR_KILL_SCHEMA,
  RECOMMIT_OR_KILL_STEP,
  RecordRecommitOrKillError,
  canonicalizeUtcIso,
  cycleInstanceId,
  defaultCircuitBreakerDeps,
  epochMs,
  evaluateProjectCircuitBreaker,
  hasReceiptedRecommit,
  isAuthorizedRecommitWriter,
  isAtCycleBoundary,
  isValidReceiptedRecommit,
  parseRecommitOrKillDetail,
  readRecommitOrKillReceipt,
  recordRecommitOrKill,
} from '../src/projects/circuit-breaker'
import { listProjectsDueAtBoundary, runProjectLoopTick } from '../src/projects/loop'
import { getProject } from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const BOUNDARY = '2026-07-01T00:00:00.000Z'
const NOW = '2026-07-23T12:00:00.000Z'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
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

function authFor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: overrides.userId ?? 'user-hadi',
    email: overrides.email ?? 'hadi@example.com',
    role: overrides.role ?? 'admin',
    tenant: overrides.tenant ?? TENANT,
    memberId: overrides.memberId ?? 'member-hadi',
    boundAgentId: overrides.boundAgentId,
    capabilities: overrides.capabilities,
    channel: overrides.channel,
  }
}

function insertProject(
  harness: SqliteD1Harness,
  overrides: {
    id?: string
    status?: string
    cycle_boundary_at?: string | null
  },
): void {
  const id = overrides.id ?? 'proj-1'
  const status = overrides.status ?? 'active'
  const boundary =
    overrides.cycle_boundary_at === undefined ? BOUNDARY : overrides.cycle_boundary_at
  const boundarySql = boundary === null ? 'NULL' : `'${boundary}'`
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', 'Ship it', '${status}', NULL, NULL,
      ${boundarySql}, 0, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
    );
  `)
}

function loadProjectRow(harness: SqliteD1Harness, id: string): Project {
  const row = harness.sqlite
    .prepare(
      `SELECT id, slug, name, description, goal, status, parent_project_id, target_date,
              cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
         FROM projects WHERE id = ?`,
    )
    .get(id) as Project
  return row
}

function insertRawReceipt(
  harness: SqliteD1Harness,
  args: {
    projectId: string
    boundaryAt: string
    status: string
    detail: string
  },
): void {
  harness.sqlite
    .prepare(
      `INSERT INTO workflow_receipts
         (id, instance_id, task_id, step_name, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      cycleInstanceId(args.projectId, args.boundaryAt),
      `project-cycle:${args.projectId}`,
      RECOMMIT_OR_KILL_STEP,
      args.status,
      args.detail,
      NOW,
    )
}

describe('0068_project_cycle_boundary migration', () => {
  it('adds cycle_boundary_at, stalled, and stall_threshold_days on projects', () => {
    const harness = makeHarness()
    try {
      const columns = harness.sqlite
        .prepare("SELECT name FROM pragma_table_info('projects') ORDER BY cid")
        .all() as Array<{ name: string }>
      const names = columns.map((row) => row.name)
      expect(names).toContain('cycle_boundary_at')
      expect(names).toContain('stalled')
      expect(names).toContain('stall_threshold_days')
      const stalled = harness.sqlite
        .prepare("SELECT \"notnull\", dflt_value FROM pragma_table_info('projects') WHERE name = 'stalled'")
        .get() as { notnull: number; dflt_value: string }
      expect(stalled.notnull).toBe(1)
      expect(String(stalled.dflt_value)).toContain('0')
    } finally {
      harness.close()
    }
  })

  it('WARN-1: documents single-apply via runner applied-version guard (d1_migrations)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0068_project_cycle_boundary.sql'), 'utf8')
    expect(sql).toMatch(/applied-version[\s\S]*guard/i)
    expect(sql).toMatch(/d1_migrations/)
    expect(sql).toMatch(/Single-apply migration/)
    expect(sql).toContain('ADD COLUMN cycle_boundary_at')
    // Re-executing ADD COLUMN without the runner guard fails — prove the hazard exists
    // so the applied-version contract remains load-bearing.
    const harness = makeHarness()
    try {
      expect(() => {
        harness.sqlite.exec('ALTER TABLE projects ADD COLUMN cycle_boundary_at TEXT')
      }).toThrow(/duplicate column/i)
    } finally {
      harness.close()
    }
  })
})

describe('P0-4 canonical UTC boundary timestamps', () => {
  it('canonicalizeUtcIso normalizes offsets and rejects NaN', () => {
    expect(canonicalizeUtcIso('2026-07-23T14:00:00+03:00')).toBe('2026-07-23T11:00:00.000Z')
    expect(canonicalizeUtcIso('not-a-date')).toBeNull()
    expect(canonicalizeUtcIso('')).toBeNull()
    expect(epochMs('2026-07-23T14:00:00+03:00')).toBe(Date.parse('2026-07-23T11:00:00.000Z'))
    expect(isAtCycleBoundary('not-a-date', NOW)).toBe(false)
  })

  it('listProjectsDueAtBoundary uses epoch compare and clears invalid boundaries', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      // Offset form is already due at NOW via epoch, even though it sorts after NOW lexicographically.
      insertProject(harness, {
        id: 'proj-offset',
        cycle_boundary_at: '2026-07-23T14:00:00+03:00',
      })
      insertProject(harness, {
        id: 'proj-invalid',
        cycle_boundary_at: 'never',
      })
      insertProject(harness, {
        id: 'proj-future',
        cycle_boundary_at: '2099-01-01T00:00:00.000Z',
      })

      const due = await listProjectsDueAtBoundary(env, NOW)
      expect(due.map((p) => p.id)).toEqual(['proj-offset'])
      expect(due[0]?.cycle_boundary_at).toBe('2026-07-23T11:00:00.000Z')

      const invalid = await getProject(env, 'proj-invalid')
      expect(invalid?.cycle_boundary_at).toBeNull()
    } finally {
      harness.close()
    }
  })
})

describe('P0-1 hasReceiptedRecommit rejects forged detail', () => {
  it('requires status=ok, boundary_at match, and authorized writer', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {})

      insertRawReceipt(harness, {
        projectId: 'proj-1',
        boundaryAt: BOUNDARY,
        status: 'ok',
        detail: JSON.stringify({
          schema: RECOMMIT_OR_KILL_SCHEMA,
          project_id: 'proj-1',
          boundary_at: '2099-01-01T00:00:00.000Z',
          decision: 'recommit',
          principal: 'member:forger',
          reason: 'forged_boundary',
        }),
      })
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(false)

      harness.sqlite.exec(`DELETE FROM workflow_receipts`)
      insertRawReceipt(harness, {
        projectId: 'proj-1',
        boundaryAt: BOUNDARY,
        status: 'waiting',
        detail: JSON.stringify({
          schema: RECOMMIT_OR_KILL_SCHEMA,
          project_id: 'proj-1',
          boundary_at: BOUNDARY,
          decision: 'recommit',
          principal: 'member:forger',
          reason: 'bad_status',
        }),
      })
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(false)

      harness.sqlite.exec(`DELETE FROM workflow_receipts`)
      insertRawReceipt(harness, {
        projectId: 'proj-1',
        boundaryAt: BOUNDARY,
        status: 'ok',
        detail: JSON.stringify({
          schema: RECOMMIT_OR_KILL_SCHEMA,
          project_id: 'proj-1',
          boundary_at: BOUNDARY,
          decision: 'recommit',
          principal: 'system:project-loop',
          reason: 'system_forged',
        }),
      })
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(false)
      expect(isAuthorizedRecommitWriter('system:project-loop')).toBe(false)
      expect(isAuthorizedRecommitWriter('member:hadi')).toBe(true)
    } finally {
      harness.close()
    }
  })
})

describe('P0-2 recordRecommitOrKill auth principal + self-verdict', () => {
  it('derives principal from authenticated context; system cannot recommit', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {})
      const detail = await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-1',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          reason: 'continue_betting_table',
          writer: { kind: 'authenticated', auth: authFor(), overrideSelfVerdict: false },
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )
      expect(detail.principal).toBe('member:member-hadi')
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(true)

      await expect(
        recordRecommitOrKill(
          env,
          {
            projectId: 'proj-2',
            boundaryAt: BOUNDARY,
            decision: 'recommit',
            reason: 'nope',
            writer: { kind: 'system_kill' },
          },
          defaultCircuitBreakerDeps().writeReceipt,
        ),
      ).rejects.toBeInstanceOf(RecordRecommitOrKillError)
    } finally {
      harness.close()
    }
  })

  it('blocks self-recommit unless org owner override is explicit and audited', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-self' })
      const selfAuth = authFor({ memberId: 'proj-self', role: 'admin' })
      await expect(
        recordRecommitOrKill(
          env,
          {
            projectId: 'proj-self',
            boundaryAt: BOUNDARY,
            decision: 'recommit',
            reason: 'i_am_the_project',
            writer: { kind: 'authenticated', auth: selfAuth, overrideSelfVerdict: false },
          },
          defaultCircuitBreakerDeps().writeReceipt,
        ),
      ).rejects.toMatchObject({ code: 'self_verdict' })

      const ownerAuth = authFor({ memberId: 'proj-self', role: 'owner' })
      const detail = await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-self',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          reason: 'continue',
          writer: { kind: 'authenticated', auth: ownerAuth, overrideSelfVerdict: true },
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )
      expect(detail.reason).toContain('[self_verdict_override by org owner proj-self]')
      expect(detail.principal).toBe('member:proj-self')
    } finally {
      harness.close()
    }
  })
})

describe('P0-3 atomic check/kill/archive (re-read winning receipt)', () => {
  it('does not archive when a recommit wins the UNIQUE race mid-sequence', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { status: 'active', cycle_boundary_at: BOUNDARY })

      const deps = defaultCircuitBreakerDeps()
      const writeReceipt = vi.fn(async () => {
        // Simulate a concurrent authenticated recommit that landed first.
        await deps.writeReceipt(env, {
          instanceId: cycleInstanceId('proj-1', BOUNDARY),
          taskId: 'project-cycle:proj-1',
          stepName: RECOMMIT_OR_KILL_STEP,
          status: 'ok',
          detail: JSON.stringify({
            schema: RECOMMIT_OR_KILL_SCHEMA,
            project_id: 'proj-1',
            boundary_at: BOUNDARY,
            decision: 'recommit',
            principal: 'member:racer',
            reason: 'won_the_race',
          }),
        })
      })

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        { ...deps, writeReceipt },
      )
      expect(outcome).toBe('recommitted')
      expect((await getProject(env, 'proj-1'))?.status).toBe('active')
      const winning = await readRecommitOrKillReceipt(env, 'proj-1', BOUNDARY)
      expect(winning?.detail.decision).toBe('recommit')
      expect(isValidReceiptedRecommit(winning!, 'proj-1', BOUNDARY)).toBe(true)
    } finally {
      harness.close()
    }
  })
})

describe('WARN-2 gated authenticated recommit action is wired', () => {
  it('exposes HTTP + MCP recommit surfaces before breaker cron can archive', () => {
    const httpSrc = readFileSync(join(__dirname, '..', 'src/projects/index.ts'), 'utf8')
    const mcpSrc = readFileSync(join(__dirname, '..', 'src/mcp/projects.ts'), 'utf8')
    expect(httpSrc).toContain("projectsApp.post('/:id/recommit'")
    expect(httpSrc).toContain('override_self_verdict')
    expect(httpSrc).toContain("writer: { kind: 'authenticated'")
    expect(mcpSrc).toContain("name: 'project_recommit'")
    expect(mcpSrc).toContain('toolProjectRecommit')
    expect(mcpSrc).toMatch(/PROJECT_TOOLS[\s\S]*toolProjectRecommit/)
  })

  it('authenticated recommit keeps project active under the cron kill-default', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-keep', status: 'active', cycle_boundary_at: BOUNDARY })
      insertProject(harness, { id: 'proj-kill', status: 'active', cycle_boundary_at: BOUNDARY })

      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-keep',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          reason: 'continue',
          writer: { kind: 'authenticated', auth: authFor(), overrideSelfVerdict: false },
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )

      const tick = await runProjectLoopTick(env, { nowIso: () => NOW })
      expect(tick.ok).toBe(true)
      expect(tick.killed).toBe(1)
      expect(tick.recommitted).toBe(1)
      expect((await getProject(env, 'proj-kill'))?.status).toBe('archived')
      expect((await getProject(env, 'proj-keep'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })
})

describe('recommit_or_kill receipt path (workflow_receipts)', () => {
  it('records a recommit_or_kill decision through writeReceiptToD1', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {})
      const detail = await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-1',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          reason: 'continue_betting_table',
          writer: { kind: 'authenticated', auth: authFor({ memberId: 'agent-owner' }), overrideSelfVerdict: false },
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )
      expect(detail.schema).toBe(RECOMMIT_OR_KILL_SCHEMA)
      expect(detail.decision).toBe('recommit')
      expect(detail.principal).toBe('member:agent-owner')

      const row = harness.sqlite
        .prepare(
          `SELECT instance_id, step_name, status, detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(cycleInstanceId('proj-1', BOUNDARY), RECOMMIT_OR_KILL_STEP) as {
        instance_id: string
        step_name: string
        status: string
        detail: string
      }
      expect(row.step_name).toBe(RECOMMIT_OR_KILL_STEP)
      expect(row.status).toBe('ok')
      const parsed = parseRecommitOrKillDetail(row.detail)
      expect(parsed).toEqual(detail)
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(true)
    } finally {
      harness.close()
    }
  })
})

describe('project circuit breaker', () => {
  it('recommit-keeps-active: receipted recommit leaves status active', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { status: 'active', cycle_boundary_at: BOUNDARY })
      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-1',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          reason: 'reshape_and_rebet',
          writer: { kind: 'authenticated', auth: authFor(), overrideSelfVerdict: false },
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('recommitted')
      const project = await getProject(env, 'proj-1')
      expect(project?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('no-recommit-kills: absent recommit archives with kill receipt + reason', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { status: 'active', cycle_boundary_at: BOUNDARY })

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('killed')

      const project = await getProject(env, 'proj-1')
      expect(project?.status).toBe('archived')

      const row = harness.sqlite
        .prepare(
          `SELECT detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(cycleInstanceId('proj-1', BOUNDARY), RECOMMIT_OR_KILL_STEP) as { detail: string }
      const detail = parseRecommitOrKillDetail(row.detail)
      expect(detail?.decision).toBe('kill')
      expect(detail?.reason).toBe(KILL_REASON_NO_RECOMMIT)
      expect(detail?.principal).toBe('system:project-loop')
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(false)
    } finally {
      harness.close()
    }
  })
})
