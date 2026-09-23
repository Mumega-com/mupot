// tests/attention-recommit-due.test.ts — needs_you 'project_recommit_due' source.
//
// The circuit breaker (src/projects/circuit-breaker.ts) archives any
// non-exempt project at cycle_boundary_at unless a receipted recommit exists
// for that EXACT boundary — silently, with no prior warning. This suite
// covers the needs_you source that surfaces that fate ahead of time, and the
// dashboard's Recommit button (a direct POST to the EXISTING
// POST /projects/:id/recommit route — no new write path).
//
// Real-schema harness: every migration applies, and fixtures start where
// production starts — a `projects` row with cycle_boundary_at set directly
// (the same way every other needs_you source test in this repo seeds its
// entity rows — see tests/needs-you.test.ts's insertTask/insertWaitingRun).
// The one exception is the "has a recommit" state, which is NEVER
// hand-inserted as a workflow_receipts row — it is always produced by calling
// the real proposeProjectRecommit(), so a test proving "recommitted project is
// absent" is also proving hasReceiptedRecommit's read path and this source's
// SQL read the SAME receipt shape.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import {
  BREAKER_EXEMPT_STATUSES,
  isBreakerEligibleStatus,
  proposeProjectRecommit,
  shouldEvaluateBreaker,
} from '../src/projects/circuit-breaker'
import { writeReceiptToD1 } from '../src/workflows/pipeline'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const NOW = '2026-09-23T12:00:00.000Z'

function isoPlusHours(hours: number): string {
  return new Date(Date.parse(NOW) + hours * 60 * 60 * 1000).toISOString()
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
}): void {
  const status = values.status ?? 'active'
  const boundary = values.cycleBoundaryAt === undefined ? null : values.cycleBoundaryAt
  const createdAt = values.createdAt ?? '2026-06-01T00:00:00.000Z'
  // A live invariant (migrations/0069, validate_project_squad_access_insert)
  // refuses to grant project_squad_access on an already-archived project —
  // insert as 'active', wire access, THEN archive, so the fixture goes
  // through the same sequence production would.
  harness.sqlite.prepare(
    `INSERT INTO projects (id, slug, name, status, cycle_boundary_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).run(values.id, values.id, `Project ${values.id}`, boundary, createdAt, createdAt)
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
    expect(overdue?.safe_url).toBe('/projects/proj-overdue')
    expect(overdue?.allowed_actions).toEqual(['view', 'recommit'])
  })

  it('boundary more than 72h out is absent', async () => {
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

  it('archived and completed projects are absent even when overdue; planned/active/paused/review match isBreakerEligibleStatus', async () => {
    harness = makeHarness()
    const statuses = ['planned', 'active', 'paused', 'review', 'completed', 'archived'] as const
    for (const status of statuses) {
      insertProject(harness, { id: `proj-${status}`, status, cycleBoundaryAt: isoPlusHours(-1) })
    }
    const page = await listNeedsYou(envFor(harness), owner(), {}, NOW)
    const present = new Set(page.items.filter(i => i.kind === 'project_recommit_due').map(i => i.source_id))

    for (const status of statuses) {
      const expected = isBreakerEligibleStatus(status)
      expect(present.has(`proj-${status}`)).toBe(expected)
      // Predicate parity: the SAME BREAKER_EXEMPT_STATUSES list gates both
      // shouldEvaluateBreaker (would the breaker itself look at this project
      // at this overdue boundary) and this source's SQL predicate — they
      // cannot diverge because both read the one exported list.
      expect(shouldEvaluateBreaker(status, isoPlusHours(-1), NOW, 0)).toBe(expected)
    }
    expect([...BREAKER_EXEMPT_STATUSES].sort()).toEqual(['archived', 'completed', 'review'])
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
