// Brief v0.33-4 (Hadi): needs_you shows mem-hadi's aged review rows, or a written rule
// says why not. Investigation (see PR body): a review task whose gate ask has aged past
// APPROVAL_EXPIRY.gate_verdict_days (14d) is EXCLUDED from the approvals source by the
// expiry rule ("expiry is never approval"), and the sweep that should move it to blocked
// needs an admin to run before it leaves review status — so a human's own aged review
// rows are silent in BOTH approvals and blocked, and needs_you reads 0. A gate lane with
// no registered holder at all (e.g. `gate:hadi`) is worst: it is classified as human-held
// through the "no agent lane exists" branch, so it never resurfaces in the admin stuck
// view either — and no inbox lists it, because its viewer cannot vote.
//
// THE RULE UNDER TEST (one assignment lens — mupot#1590-adjacent but its own rule):
// an aged review row assigned to a HUMAN member appears in THAT human's own
// needs_you list — and in no other human's list — as an information-only item:
//   - the assignee rule: `tasks.assignee_member_id = principal.actor_id` and actor_type
//     = 'member' (never another member's assignment; never agent rows at all);
//   - aged = the gate ask is NOT live (past the expiry window) OR the lane has no
//     registered holder of any kind — both mean "no one can answer this ask";
//   - the item is view-only (expiry is never approval — the verdict write keeps
//     refusing aged asks, so no verb is offered).
// Failure to REMOVE the source or the rule (mutation-proven, below):
//   * dropping the source empties the viewer's own rows from the list;
//   * widening the rule (assignee check removed) would surface another member's rows to
//     the viewer — the exclusion pin keeps that red.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CapabilityGrant, Env } from '../src/types'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

// Pinned server clock — AFTER the fixture dates, so age math is deterministic.
const NOW_ISO = '2026-08-20T00:00:00.000Z'

function sessions() {
  const rows = new Map<string, string>()
  return {
    async get<T = unknown>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = rows.get(key)
      if (value === undefined) return null
      return (type === 'json' && typeof value === 'string' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { rows.set(key, value) },
    async delete(key: string): Promise<void> { rows.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-a', 'dept-1', 'alpha', 'Alpha');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-a', 'squad-a', 'write');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner-human', 'owner@example.test', 'Owner Human', 'active', 'tenant-b'),
      ('holder-human', 'holder@example.test', 'Holder', 'active', 'tenant-b'),
      ('assignee-own', 'assignee@example.test', 'Assignee Own', 'active', 'tenant-b'),
      ('squad-mate', 'mate@example.test', 'Squad Mate', 'active', 'tenant-b');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-holder', 'holder-human', 'org', NULL, 'member'),
      ('cap-owner', 'owner-human', 'org', NULL, 'owner'),
      ('cap-assignee', 'assignee-own', 'squad', 'squad-a', 'member'),
      ('cap-mate', 'squad-mate', 'squad', 'squad-a', 'member');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
      ('holder-content', 'gate:content', 'member', 'holder-human', 'owner-human', '2026-07-01T00:00:00Z');
    -- gate:age-lane (a held - but REGISTERED lane) deliberately has NO gate_grants row:
    -- that is the mem-hadi shape the investigation found.
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-b' } as unknown as Env
}

const ASSIGNEE_GRANT: CapabilityGrant = { member_id: 'assignee-own', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }

function assigneeOwn(): RoutinePrincipal {
  return {
    tenant: 'tenant-b', actor_type: 'member', actor_id: 'assignee-own', workspace_admin: false,
    grants: [ASSIGNEE_GRANT],
    project_read: { workspaceAdmin: false, orgRead: false, squadIds: ['squad-a'], departmentIds: [] },
  } as RoutinePrincipal
}

const MATES_GRANT: CapabilityGrant = { member_id: 'squad-mate', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }

function squadMate(): RoutinePrincipal {
  return {
    tenant: 'tenant-b', actor_type: 'member', actor_id: 'squad-mate', workspace_admin: false,
    grants: [MATES_GRANT],
    project_read: { workspaceAdmin: false, orgRead: false, squadIds: ['squad-a'], departmentIds: [] },
  } as RoutinePrincipal
}

let env: Env
let harness: SqliteD1Harness

beforeEach(async () => {
  harness = makeHarness()
  env = envFor(harness)
})

function seedTask(seed: {
  id: string
  status?: string
  gate_owner?: string | null
  assignee_member_id?: string | null
  assignee_agent_id?: string | null
  created_at: string
  review_entered_at?: string | null
  title?: string
}): void {
  // mupot#1590 note: the 0232 review-stamp trigger fires on INSERT-when-review and on
  // any status transition into review — it writes strftime('now'). A fixture that needs a
  // BACKDATED review entry inserts parked (in_progress), flips to review (stamp fires),
  // then overrides review_entered_at directly — the third UPDATE leaves status untouched,
  // so the trigger never refires and the backdated clock survives (same as
  // tests/approval-expiry.test.ts's clock fixtures).
  const entered = seed.review_entered_at === undefined ? seed.created_at : seed.review_entered_at
  harness.sqlite.exec(
    `INSERT INTO tasks (id, project_id, squad_id, title, done_when, body, status, priority,
        gate_owner, assignee_member_id, assignee_agent_id, created_at, updated_at)
     VALUES ('${seed.id}', 'project-a', 'squad-a', '${seed.title ?? seed.id}', 'done when', '',
             '${seed.status ?? 'in_progress'}', NULL,
             ${seed.gate_owner ? `'${seed.gate_owner}'` : 'NULL'},
             ${seed.assignee_member_id ? `'${seed.assignee_member_id}'` : 'NULL'},
             ${seed.assignee_agent_id ? `'${seed.assignee_agent_id}'` : 'NULL'},
             '${seed.created_at}', '${seed.created_at}')`,
  )
  if ((seed.status ?? 'review') === 'review') {
    harness.sqlite.exec(`UPDATE tasks SET status='review' WHERE id='${seed.id}'`)
    if (entered !== null) {
      harness.sqlite.exec(`UPDATE tasks SET review_entered_at='${entered}' WHERE id='${seed.id}'`)
    }
  }
}

describe('needs_you shows the human assignee their own aged review rows (brief v0.33-4)', () => {
  it('lists an aged review row in the human assignee inbox, view-only, with the expiry reason', async () => {
    // 20-day-old ask: past the 14-day expiry window, so the approvals source refuses it —
    // this is exactly the baseline shape (mem-hadi's rows invisible).
    seedTask({ id: 'task-aged-own', gate_owner: 'gate:content', assignee_member_id: 'assignee-own',
      created_at: '2026-07-25T00:00:00Z', review_entered_at: '2026-07-30T00:00:00Z' })

    const page = await listNeedsYou(env, assigneeOwn(), {}, NOW_ISO)
    const item = page.items.find(entry => entry.source_id.startsWith('task-aged-own'))
    expect(item).toBeDefined()
    expect(item!.kind).toBe('aged_review')
    expect(item!.allowed_actions).toEqual(['view'])
    expect(item!.reason).toContain('expired')
    expect(item!.reason).toContain('cannot be approved')
    // agent text is data: the reason carries the LANE name (a system identifier), never a
    // quoted agent utterance.
    expect(item!.reason).toContain('gate:content')
  })

  it('NEVER shows another members own aged row — the assignee rule does not widen visibility (exclusion pin)', async () => {
    seedTask({ id: 'task-aged-other', gate_owner: 'gate:content', assignee_member_id: 'assignee-own',
      created_at: '2026-07-25T00:00:00Z', review_entered_at: '2026-07-30T00:00:00Z' })

    // squad-mate can read squad-a tasks (same read lens as resolveTaskDecisions demands)
    // but is NOT the assignee: the row is not theirs to act on, so it must NOT be listed.
    const othersPage = await listNeedsYou(env, squadMate(), {}, NOW_ISO)
    expect(othersPage.items.find(entry => entry.source_id.startsWith('task-aged-other'))).toBeUndefined()
  })

  it('lists a holderless-lane review row too — no grants row of any kind for the lane, the human assignee sees their own', async () => {
    // gate:age-lane has NO gate_grants row (agent or human): the mem-hadi lane shape.
    // Even though the ask clock is still LIVE, no one can ever answer it.
    seedTask({ id: 'task-holderless-own', gate_owner: 'gate:age-lane', assignee_member_id: 'assignee-own',
      created_at: '2026-08-14T00:00:00Z' })

    const ownPage = await listNeedsYou(env, assigneeOwn(), {}, NOW_ISO)
    const item = ownPage.items.find(entry => entry.source_id.startsWith('task-holderless-own'))
    expect(item).toBeDefined()
    expect(item!.kind).toBe('aged_review')
    expect(item!.allowed_actions).toEqual(['view'])
    expect(item!.reason).toContain('No holder of any kind')
  })

  it('does NOT surface fresh (still-live) gated review rows — those belong to the approvals source', async () => {
    seedTask({ id: 'task-fresh', gate_owner: 'gate:content', assignee_member_id: 'assignee-own',
      created_at: '2026-08-19T00:00:00Z' })
    // the approvals source: has a holder (holder-human holds gate:content) and it is live

    const page = await listNeedsYou(env, assigneeOwn(), {}, NOW_ISO)
    expect(page.items.find(entry => entry.source_id.startsWith('task-fresh') && entry.kind === 'aged_review')).toBeUndefined()
  })

  it('never lists aged review rows assigned to an AGENT, even for an admin viewer', async () => {
    seedTask({ id: 'task-aged-agent', gate_owner: 'gate:content', assignee_agent_id: 'agent-a',
      created_at: '2026-07-25T00:00:00Z', review_entered_at: '2026-07-30T00:00:00Z' })
    const owner = await listNeedsYou(env, {
      tenant: 'tenant-b', actor_type: 'member', actor_id: 'owner-human', workspace_admin: true,
      grants: [],
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
      legacy_owner_admin: true,
    } as RoutinePrincipal, {}, NOW_ISO)
    expect(owner.items.find(entry => entry.source_id.startsWith('task-aged-agent') && entry.kind === 'aged_review')).toBeUndefined()
  })
})
