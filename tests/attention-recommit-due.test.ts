// tests/attention-recommit-due.test.ts — needs_you 'project_recommit_due' source.
//
// The circuit breaker (src/projects/circuit-breaker.ts) archives any
// non-exempt project at cycle_boundary_at unless a receipted recommit exists
// for that EXACT boundary — silently, with no prior warning. This suite
// covers the needs_you source that surfaces that fate ahead of time.
//
// Real-schema harness: every migration applies, and fixtures start where
// production starts — a `projects` row with cycle_boundary_at set directly
// (the same way every other needs_you source test in this repo seeds its
// entity rows — see tests/needs-you.test.ts's insertTask/insertWaitingRun).
// The one exception is the "has a recommit" state, which is NEVER
// hand-inserted as a workflow_receipts row — it is always produced by calling
// the real proposeProjectRecommit() / recordRecommitOrKill(), so a test
// proving "recommitted project is absent" is also proving hasReceiptedRecommit's
// read path and this source's SQL read the SAME receipt shape.
//
// ROUND 2 (adversarial P0-1, mupot PR #1533): the source has TWO independent
// triggers — BOUNDARY (cycle_boundary_at within 72h/overdue) and IDLE
// (live idleness approaching the stall detector's own threshold, because
// shouldEvaluateBreaker early-raises the breaker the SAME tick
// projects.stalled flips to 1, regardless of how far the boundary is). Both
// are covered below; the idle-trigger test drives the REAL runProjectLoopTick.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env, Task } from '../src/types'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import {
  BREAKER_EXEMPT_STATUSES,
  CIRCUIT_BREAKER_PRINCIPAL,
  KILL_REASON_NO_RECOMMIT,
  proposeProjectRecommit,
  recordRecommitOrKill,
  shouldEvaluateBreaker,
} from '../src/projects/circuit-breaker'
import { listProjectsDueAtBoundary, runProjectLoopTick } from '../src/projects/loop'
import { getProject, updateProject } from '../src/projects/service'
import {
  defaultStartGateDeps,
  recordStartGateActivation,
  START_GATE_ACTIVATION_STEP,
  startProject,
  type StartGateDeps,
} from '../src/projects/start-gate'
import { DEFAULT_STALL_THRESHOLD_DAYS } from '../src/projects/stall-detector'
import { writeReceiptToD1 } from '../src/workflows/pipeline'

// mupot #1532 (merged to main) now defines BREAKER_EXEMPT_STATUSES as THE
// canonical list directly (no separate isBreakerEligibleStatus wrapper) —
// mirror that inline check here rather than reintroducing a helper main
// doesn't have.
function isBreakerEligibleStatus(status: string): boolean {
  return !BREAKER_EXEMPT_STATUSES.includes(status as (typeof BREAKER_EXEMPT_STATUSES)[number])
}
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const NOW = '2026-09-23T12:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

function isoPlusHours(hours: number, base = NOW): string {
  return new Date(Date.parse(base) + hours * 60 * 60 * 1000).toISOString()
}

function isoPlusDays(days: number, base = NOW): string {
  return new Date(Date.parse(base) + days * DAY_MS).toISOString()
}

function sessions() {
  const rows = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = rows.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> {
      rows.set(key, value)
    },
    async delete(key: string): Promise<void> {
      rows.delete(key)
    },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-1', 'alpha', 'Alpha'),
      ('squad-b', 'dept-1', 'beta', 'Beta');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-worker', 'squad-a', 'agent-worker', 'Agent Worker', 'active');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: TENANT } as unknown as Env
}

function insertProject(harness: SqliteD1Harness, values: {
  id: string
  status?: string
  cycleBoundaryAt?: string | null
  squadId?: string
  createdAt?: string
  stallThresholdDays?: number | null
}): void {
  const status = values.status ?? 'active'
  const boundary = values.cycleBoundaryAt === undefined ? null : values.cycleBoundaryAt
  // Recent by default (a couple hours before NOW) so idle stays near-zero and
  // never confounds a boundary-only test. Tests exercising the IDLE trigger
  // pass an explicit, deliberately-old createdAt instead.
  const createdAt = values.createdAt ?? isoPlusHours(-2)
  const stallThresholdDays = values.stallThresholdDays === undefined ? null : values.stallThresholdDays
  // A live invariant (migrations/0069, validate_project_squad_access_insert)
  // refuses to grant project_squad_access on an already-archived project —
  // insert as 'active', wire access, THEN archive, so the fixture goes
  // through the same sequence production would.
  harness.sqlite.prepare(
    `INSERT INTO projects (id, slug, name, status, cycle_boundary_at, stall_threshold_days, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(values.id, values.id, `Project ${values.id}`, boundary, stallThresholdDays, createdAt, createdAt)
  harness.sqlite.prepare(
    `INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, ?, 'write')`,
  ).run(values.id, values.squadId ?? 'squad-a')
  if (status !== 'active') {
    harness.sqlite.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, values.id)
  }
}

function owner(): RoutinePrincipal {
  return {
    tenant: TENANT, actor_type: 'member', actor_id: 'owner-a', workspace_admin: true,
    grants: [], project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    legacy_owner_admin: true,
  }
}

function member(squadIds: string[] = ['squad-a']): RoutinePrincipal {
  return {
    tenant: TENANT, actor_type: 'member', actor_id: 'member-a', workspace_admin: false,
    grants: squadIds.map(scope_id => ({ member_id: 'member-a', scope_type: 'squad' as const, scope_id, capability: 'member' as const })),
    project_read: { workspaceAdmin: false, orgRead: false, squadIds, departmentIds: [] },
  }
}

function findItem(page: Awaited<ReturnType<typeof listNeedsYou>>, sourceId: string) {
  return page.items.find(item => item.source_id === sourceId)
}

describe('Needs You — project_recommit_due source', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('surfaces a due project with no recommit, with urgency by time-to-boundary', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-overdue', cycleBoundaryAt: isoPlusHours(-1) }) // already past
    insertProject(harness, { id: 'proj-urgent', cycleBoundaryAt: isoPlusHours(10) }) // <=24h
    insertProject(harness, { id: 'proj-high', cycleBoundaryAt: isoPlusHours(50) }) // <=72h, >24h
    const env = envFor(harness)

    const page = await listNeedsYou(env, owner(), {}, NOW)

    const overdue = findItem(page, 'proj-overdue')
    const urgent = findItem(page, 'proj-urgent')
    const high = findItem(page, 'proj-high')
    expect(overdue).toMatchObject({ kind: 'project_recommit_due', source_type: 'project', urgency: 'urgent' })
    expect(urgent).toMatchObject({ kind: 'project_recommit_due', source_type: 'project', urgency: 'urgent' })
    expect(high).toMatchObject({ kind: 'project_recommit_due', source_type: 'project', urgency: 'high' })
    expect(overdue?.reason).toContain(isoPlusHours(-1))
    expect(overdue?.reason.toLowerCase()).toContain('archiv')
    expect(overdue?.reason.toLowerCase()).toContain('protects only through this boundary')
    expect(overdue?.safe_url).toBe('/projects/proj-overdue')
    expect(overdue?.allowed_actions).toEqual(['view', 'recommit'])
  })

  it('boundary more than 72h out is absent (and not idle)', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-far', cycleBoundaryAt: isoPlusHours(100) })
    const page = await listNeedsYou(envFor(harness), owner(), {}, NOW)
    expect(findItem(page, 'proj-far')).toBeUndefined()
  })

  it('a project with no cycle_boundary_at is absent', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-none', cycleBoundaryAt: null })
    const page = await listNeedsYou(envFor(harness), owner(), {}, NOW)
    expect(findItem(page, 'proj-none')).toBeUndefined()
  })

  it('a recommitted project is absent — receipt written via the REAL proposeProjectRecommit, not hand-inserted', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-recommitted', cycleBoundaryAt: isoPlusHours(10) })
    const env = envFor(harness)

    const before = await listNeedsYou(env, owner(), {}, NOW)
    expect(findItem(before, 'proj-recommitted')).toBeDefined()

    const result = await proposeProjectRecommit(env, 'proj-recommitted', 'member:distinct-owner', 'keep going', writeReceiptToD1)
    expect(result.ok).toBe(true)

    const after = await listNeedsYou(env, owner(), {}, NOW)
    expect(findItem(after, 'proj-recommitted')).toBeUndefined()
  })

  it('a KILL receipt (decision != recommit) does NOT silence the warning — pins the exact decision string, not "any receipt"', async () => {
    // Round 2 P1-3: simulates a breaker tick that recorded 'kill' via the
    // REAL recordRecommitOrKill() but whose follow-on archive UPDATE failed
    // (project.status is still 'active'). The item must still show — the
    // NOT EXISTS filter is pinned to decision = 'recommit', not "receipt
    // exists at all".
    harness = makeHarness()
    const boundary = isoPlusHours(-1)
    insertProject(harness, { id: 'proj-kill-no-archive', cycleBoundaryAt: boundary })
    const env = envFor(harness)

    await recordRecommitOrKill(env, {
      projectId: 'proj-kill-no-archive',
      boundaryAt: boundary,
      decision: 'kill',
      principal: CIRCUIT_BREAKER_PRINCIPAL,
      reason: KILL_REASON_NO_RECOMMIT,
    }, writeReceiptToD1)
    expect((await getProject(env, 'proj-kill-no-archive'))?.status).toBe('active')

    const page = await listNeedsYou(env, owner(), {}, NOW)
    expect(findItem(page, 'proj-kill-no-archive')).toBeDefined()
  })

  it('three-way status-exemption parity: isBreakerEligibleStatus, shouldEvaluateBreaker, needs_you, and listProjectsDueAtBoundary all agree', async () => {
    harness = makeHarness()
    const statuses = ['planned', 'active', 'paused', 'review', 'completed', 'archived'] as const
    const boundary = isoPlusHours(-1)
    for (const status of statuses) {
      insertProject(harness, { id: `proj-${status}`, status, cycleBoundaryAt: boundary })
    }
    const env = envFor(harness)
    const page = await listNeedsYou(env, owner(), {}, NOW)
    const presentInNeedsYou = new Set(page.items.filter(i => i.kind === 'project_recommit_due').map(i => i.source_id))
    const dueAtBoundary = await listProjectsDueAtBoundary(env, NOW)
    const presentInLoop = new Set(dueAtBoundary.map(p => p.id))

    for (const status of statuses) {
      const expected = isBreakerEligibleStatus(status)
      expect(presentInNeedsYou.has(`proj-${status}`)).toBe(expected)
      expect(shouldEvaluateBreaker(status, boundary, NOW, 0)).toBe(expected)
      // listProjectsDueAtBoundary additionally requires the boundary to have
      // ELAPSED (true here) — for these overdue fixtures that coincides
      // exactly with status eligibility, so the three cannot diverge.
      expect(presentInLoop.has(`proj-${status}`)).toBe(expected)
    }
    // Pin the actual membership — 'planned' joined round 2 to agree with
    // sibling PR #1532, which independently exempts it.
    expect([...BREAKER_EXEMPT_STATUSES].sort()).toEqual(['archived', 'completed', 'planned', 'review'])
  })

  it('a project a non-admin member cannot see is absent for them but visible to an org admin', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-hidden', cycleBoundaryAt: isoPlusHours(10), squadId: 'squad-b' })
    const env = envFor(harness)

    const memberPage = await listNeedsYou(env, member(['squad-a']), {}, NOW)
    expect(findItem(memberPage, 'proj-hidden')).toBeUndefined()

    const adminPage = await listNeedsYou(env, owner(), {}, NOW)
    expect(findItem(adminPage, 'proj-hidden')).toBeDefined()
  })

  it('a non-admin member never gets the recommit action even on a project they can see', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-a-due', cycleBoundaryAt: isoPlusHours(10), squadId: 'squad-a' })
    const page = await listNeedsYou(envFor(harness), member(['squad-a']), {}, NOW)
    const item = findItem(page, 'proj-a-due')
    expect(item).toBeDefined()
    expect(item?.allowed_actions).toEqual(['view'])
  })
})

describe('Needs You — IDLE trigger (round 2, adversarial P0-1)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  // Reproduces the exact adversarial probe: an idle ACTIVE project with a
  // cycle_boundary_at 30 DAYS out (far outside the 72h boundary window) still
  // gets killed in ONE real runProjectLoopTick, because shouldEvaluateBreaker
  // early-raises on projects.stalled=1 regardless of boundary distance, and
  // stall-detect + breaker run back-to-back in the same tick. The fix must
  // show the item BEFORE that tick, using LIVE idleness — not the (not yet
  // set) cached stalled column.
  it('warns before the SAME tick that stalls AND kills a boundary-far idle project', async () => {
    harness = makeHarness()
    const created = '2026-09-01T00:00:00.000Z'
    const farBoundary = isoPlusDays(30, created) // guarantees the BOUNDARY trigger never fires here
    insertProject(harness, { id: 'proj-idle', cycleBoundaryAt: farBoundary, createdAt: created })
    const env = envFor(harness)

    const threshold = DEFAULT_STALL_THRESHOLD_DAYS // 14
    const notYetIso = isoPlusDays(threshold - 3, created) // idle 11d — outside the 2d warning lead
    const warnIso = isoPlusDays(threshold - 1, created) // idle 13d — within the 2d warning lead, NOT yet stalled
    const killIso = isoPlusDays(threshold + 1, created) // idle 15d — past threshold

    const before = await listNeedsYou(env, owner(), {}, notYetIso)
    expect(findItem(before, 'proj-idle')).toBeUndefined()
    expect((await getProject(env, 'proj-idle'))?.stalled).toBe(0)

    const warned = await listNeedsYou(env, owner(), {}, warnIso)
    const item = findItem(warned, 'proj-idle')
    expect(item).toBeDefined()
    expect(item?.urgency).toBe('high')
    expect(item?.reason.toLowerCase()).toContain('stall threshold')
    expect((await getProject(env, 'proj-idle'))?.stalled).toBe(0) // still not flagged — this IS the early warning

    // Drive the REAL project loop at the kill instant — stall-flag and
    // archive happen in this ONE tick, matching the adversarial probe.
    const tick = await runProjectLoopTick(env, { nowIso: () => killIso })
    expect(tick.ok).toBe(true)
    expect(tick.stall_flagged).toBe(1)
    expect(tick.killed).toBe(1)
    const project = await getProject(env, 'proj-idle')
    expect(project?.stalled).toBe(1)
    expect(project?.status).toBe('archived')
  })

  it('a per-project stall_threshold_days override shifts the idle warning window', async () => {
    harness = makeHarness()
    const created = '2026-09-01T00:00:00.000Z'
    const farBoundary = isoPlusDays(30, created)
    insertProject(harness, {
      id: 'proj-idle-custom', cycleBoundaryAt: farBoundary, createdAt: created, stallThresholdDays: 5,
    })
    const env = envFor(harness)

    const notYetIso = isoPlusDays(2, created) // idle 2d — outside a 5d threshold's 2d lead
    const warnIso = isoPlusDays(3.5, created) // idle 3.5d — within the lead of a 5d threshold

    expect(findItem(await listNeedsYou(env, owner(), {}, notYetIso), 'proj-idle-custom')).toBeUndefined()
    expect(findItem(await listNeedsYou(env, owner(), {}, warnIso), 'proj-idle-custom')).toBeDefined()
  })

  it('recommitting an idle-triggered warning clears it for the current boundary, same as the boundary trigger', async () => {
    harness = makeHarness()
    const created = '2026-09-01T00:00:00.000Z'
    const farBoundary = isoPlusDays(30, created)
    insertProject(harness, { id: 'proj-idle-recommit', cycleBoundaryAt: farBoundary, createdAt: created })
    const env = envFor(harness)
    const warnIso = isoPlusDays(DEFAULT_STALL_THRESHOLD_DAYS - 1, created)

    expect(findItem(await listNeedsYou(env, owner(), {}, warnIso), 'proj-idle-recommit')).toBeDefined()
    const result = await proposeProjectRecommit(env, 'proj-idle-recommit', 'member:distinct-owner', 'still working it', writeReceiptToD1)
    expect(result.ok).toBe(true)
    expect(findItem(await listNeedsYou(env, owner(), {}, warnIso), 'proj-idle-recommit')).toBeUndefined()
  })
})

// Post-rebase verification (coordinator, round 3): mupot PR #1532 (merged to
// main, ab83ab5d) added recordStartGateActivation — startProject's per-
// activation receipt, keyed on the REAL seed task id so migration 0059's
// hydrate trigger populates workflow_receipts.project_id. That receipt is
// exactly the "fresh evidence" src/projects/stall-detector.ts's
// loadProjectIdleSignals (workflow_receipts branch) reads — the SAME
// function this file's IDLE trigger calls. This proves the two features
// compose correctly: reviving a long-idle, archived project through the
// REAL startProject clears this PR's idle-triggered needs_you warning,
// without either PR needing to know about the other.
describe('idle warning clears through a REAL revival (PR #1532 recordStartGateActivation, PR #1533 idle trigger)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  function insertPlannedProject(h: SqliteD1Harness, id: string, createdAt: string): void {
    h.sqlite.exec(`
      INSERT INTO projects (
        id, slug, name, description, goal, status, parent_project_id, target_date,
        cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
      ) VALUES (
        '${id}', '${id}', 'Project ${id}', '', 'Ship it', 'planned', NULL, NULL,
        NULL, 0, NULL, NULL, '${createdAt}', '${createdAt}'
      );
      INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
      VALUES ('${id}', 'squad-a', 'admin', '${createdAt}');
    `)
  }

  function revivalDeps(nowIso: string): StartGateDeps {
    return {
      ...defaultStartGateDeps(),
      mintAgentBoundToken: vi.fn(async () => ({ tokenId: 'tok-revival', memberId: 'mem-agent-revival' })),
      revokeMemberToken: vi.fn(async () => true),
      resolveActiveAgentMember: vi.fn(async () => 'unminted' as const),
      setAgentSquadAccess: vi.fn(async () => ({ ok: true as const, result: 'created' as const })),
      createTask: vi.fn(async (taskEnv: Env, input): Promise<Task> => {
        const id = `task-seed-${Math.random().toString(36).slice(2, 10)}`
        await taskEnv.DB.prepare(
          `INSERT INTO tasks (
             id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
             github_issue_url, result, completed_at, gate_owner, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).bind(
          id, input.squad_id, input.project_id, input.title, input.body, input.done_when,
          input.assignee_agent_id, nowIso, nowIso,
        ).run()
        return {
          id, squad_id: input.squad_id, project_id: input.project_id, title: input.title,
          body: input.body, done_when: input.done_when, status: 'open',
          assignee_agent_id: input.assignee_agent_id, github_issue_url: null, result: null,
          completed_at: null, gate_owner: null, created_at: nowIso, updated_at: nowIso,
        }
      }),
      nowIso: () => nowIso,
    }
  }

  it('recordStartGateActivation exists and a real revival clears the idle-triggered warning', async () => {
    expect(typeof recordStartGateActivation).toBe('function')

    harness = makeHarness()
    const T0 = '2026-06-01T00:00:00.000Z'
    const OLD_BOUNDARY = '2026-06-15T00:00:00.000Z'
    const REVIVE_NOW = '2026-09-15T00:00:00.000Z'
    insertPlannedProject(harness, 'proj-revival', T0)
    const env = envFor(harness)

    const firstActivation = await startProject(env, 'proj-revival', revivalDeps(T0))
    expect(firstActivation.ok).toBe(true)

    // BEFORE revival: confirm the source DOES fire on this project's stale,
    // pre-archive state (boundary and idle both trip at this exact instant —
    // either is fine) — the contrast that makes "clears after revival" a
    // meaningful assertion rather than a vacuous one.
    const staleIdleCheck = await listNeedsYou(envFor(harness), owner(), {}, OLD_BOUNDARY)
    expect(findItem(staleIdleCheck, 'proj-revival')).toBeDefined()

    // Simulate exactly what the real breaker leaves behind: stale elapsed
    // boundary, stalled=1, a receipted KILL, then archived.
    harness.sqlite.exec(`
      UPDATE projects SET cycle_boundary_at = '${OLD_BOUNDARY}', stalled = 1, status = 'archived'
       WHERE id = 'proj-revival'
    `)
    await recordRecommitOrKill(env, {
      projectId: 'proj-revival', boundaryAt: OLD_BOUNDARY, decision: 'kill',
      principal: CIRCUIT_BREAKER_PRINCIPAL, reason: KILL_REASON_NO_RECOMMIT,
    }, writeReceiptToD1)

    // Revival: archived -> planned (bare updateProject, as an operator/UI
    // does it) -> planned -> active (the REAL startProject).
    const toPlanned = await updateProject(env, 'proj-revival', { status: 'planned' })
    expect(toPlanned.ok).toBe(true)
    const revived = await startProject(env, 'proj-revival', revivalDeps(REVIVE_NOW))
    expect(revived.ok).toBe(true)

    const activationReceipt = await env.DB.prepare(
      `SELECT project_id FROM workflow_receipts WHERE step_name = ? AND instance_id LIKE ?`,
    ).bind(START_GATE_ACTIVATION_STEP, `%proj-revival%`).first<{ project_id: string | null }>()
    expect(activationReceipt?.project_id).toBe('proj-revival')

    // AFTER revival, queried right at REVIVE_NOW: the idle warning is GONE —
    // the activation receipt is fresh evidence loadProjectIdleSignals reads,
    // and the fresh cycle_boundary_at is weeks out.
    const afterRevival = await listNeedsYou(envFor(harness), owner(), {}, REVIVE_NOW)
    expect(findItem(afterRevival, 'proj-revival')).toBeUndefined()
    expect((await getProject(env, 'proj-revival'))?.status).toBe('active')
  })
})
