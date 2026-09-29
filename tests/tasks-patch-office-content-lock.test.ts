// tests/tasks-patch-office-content-lock.test.ts — mupot#1592 NEW-1 (r2 adversarial
// follow-up on PR #1588): REST parity with src/mcp/index.ts's task_update edit-lock.
// A gate:office task's title/body must not change while a human is reviewing it —
// the payload was already frozen (office_publish_freezes, keyed on review-entry,
// src/addons/office/service.ts) the moment this task entered review, and a human
// may already have read its hash off office.list_pending_approvals. Pattern mirrors
// tests/tasks-patch-artifact-gate.test.ts (real D1, tasksApp.fetch directly).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const DEPT_ID = 'dept-office-lock'
const SQUAD_ID = 'squad-office-lock'
const TASK_ID = 'task-office-lock'

let harness: SqliteD1Harness | null = null

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'office', 'Office');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'site-operator', 'Site Operator');
  `)
})

function seedTask(opts: { status: string; gateOwner: string | null }) {
  const gateOwnerLiteral = opts.gateOwner ? `'${opts.gateOwner}'` : 'NULL'
  harness!.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner)
    VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Publish: Q4 recap', 'original body', '${opts.status}', 'post is live', ${gateOwnerLiteral});
  `)
}

/** mupot#1602 r2: the edit lock now keys on "a live freeze exists for this task",
 *  not on gate_owner/status (see officeTaskContentLocked's own doc comment) — a
 *  test asserting the lock fires must actually seed a freeze row, a raw insert
 *  being enough since the lock only checks existence + voided_at, never the
 *  payload contents. */
function seedFreeze(taskId: string): void {
  harness!.sqlite.exec(`
    INSERT INTO office_publish_freezes (task_id, payload_json, payload_sha256, installation_id, connector_id, site_origin, frozen_by, frozen_at)
    VALUES ('${taskId}', '{}', 'deadbeef', 'inst-1', 'conn-1', 'https://wordpress.example.com', 'test-fixture', datetime('now'));
  `)
}

function makeEnv(): Env {
  return {
    TENANT_SLUG: 'mumega',
    BRAND: 'Mupot',
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'sess:owner-session') return null
        return JSON.stringify({
          userId: 'owner-1',
          email: 'owner@mupot.test',
          role: 'owner',
          createdAt: '2026-07-14T00:00:00.000Z',
        })
      }),
      delete: vi.fn(async () => undefined),
    },
    DB: harness!.db,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function patch(body: unknown) {
  return new Request(`https://pot.test/${TASK_ID}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      Cookie: 'mupot_session=owner-session',
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

describe('PATCH /:id — office content lock (REST parity with MCP task_update)', () => {
  it('refuses a title edit while a gate:office task is in review', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    seedFreeze(TASK_ID)
    const res = await tasksApp.fetch(patch({ title: 'swapped title' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('office_payload_frozen')
    const row = harness!.sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(TASK_ID) as { title: string }
    expect(row.title).toBe('Publish: Q4 recap')
  })

  it('refuses a body edit while a gate:office task is in review', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    seedFreeze(TASK_ID)
    const res = await tasksApp.fetch(patch({ body: '<script>alert(1)</script>' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('office_payload_frozen')
    const row = harness!.sqlite.prepare(`SELECT body FROM tasks WHERE id = ?`).get(TASK_ID) as { body: string }
    expect(row.body).toBe('original body')
  })

  it('does NOT lock a task gated under a different namespace, with no freeze row', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:reviewer' })
    const res = await tasksApp.fetch(patch({ title: 'legit edit' }), makeEnv())
    expect(res.status).toBe(200)
  })

  // mupot#1602 r2 BLOCK P1 (R3): the OLD lock keyed on gate_owner === 'gate:office'
  // — reassigning gate_owner away turned the lock off regardless of whether a
  // freeze existed. The NEW lock keys on freeze existence alone: a live freeze
  // still locks editing even when gate_owner currently reads something else
  // (this is exactly the state R3's repro passes through mid-attack).
  it('R3 regression: STILL locks a live freeze even when gate_owner has been reassigned away from gate:office', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:reviewer' })
    seedFreeze(TASK_ID)
    const res = await tasksApp.fetch(patch({ title: 'swapped while gate reassigned' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('office_payload_frozen')
  })

  // The converse: a gate:office task with NO live freeze (never entered review
  // through a path that could freeze it, or the freeze was voided) is not locked
  // — there is nothing this lock protects yet/any more.
  it('does NOT lock a gate:office task with no live freeze at all', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    const res = await tasksApp.fetch(patch({ title: 'no freeze yet' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('does NOT lock a gate:office task before it reaches review (in_progress is editable)', async () => {
    seedTask({ status: 'in_progress', gateOwner: 'gate:office' })
    const res = await tasksApp.fetch(patch({ title: 'still drafting' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('does NOT refuse an unrelated field edit (priority) on a gate:office task in review', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    // P2/P3 skip the P0/P1 intake-contract gate entirely (Issue #1040 Phase 2) —
    // unrelated to this lock, which is what this test isolates.
    const res = await tasksApp.fetch(patch({ priority: 'P2' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('freezes the payload on entering review even with no title/body change in the same call, and does not error when no WordPress addon is installed at all', async () => {
    seedTask({ status: 'in_progress', gateOwner: 'gate:office' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), makeEnv())
    expect(res.status).toBe(200)
    // No office addon installed in this harness — buildOfficePublishFreeze
    // returns addon_inactive and freezeOfficeTaskOnReviewEntry silently leaves no
    // row; the call itself must still succeed (a human's review-entry is not
    // blocked on WordPress infra readiness).
    const freeze = harness!.sqlite.prepare(`SELECT * FROM office_publish_freezes WHERE task_id = ?`).get(TASK_ID)
    expect(freeze).toBeUndefined()
  })
})

// mupot#1602 r1 adversarial gate P3-1: "the HTTP /:id/verdict 409 mapping ...
// [is] not referenced by any test." src/tasks/service.ts's writeVerdict refuses
// ANY gate:office task unconditionally (before any capability check), so the
// generic verdict route must map that refusal to a clean 409, never an
// unhandled 500 — every OTHER verdict surface (MCP task_verdict, the Telegram
// human_origin path) has this covered by mcpwp-office-tools.test.ts and
// task-verdict-human-origin.test.ts respectively; this is the HTTP twin.
describe('POST /:id/verdict — refuses gate:office outright (REST parity with MCP task_verdict)', () => {
  function verdictRequest(body: unknown) {
    return new Request(`https://pot.test/${TASK_ID}/verdict`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: 'mupot_session=owner-session',
        Origin: 'https://pot.test',
      },
      body: JSON.stringify(body),
    })
  }

  it('refuses to approve a gate:office task with a clean 409, not a 500', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    const res = await tasksApp.fetch(verdictRequest({ verdict: 'approved' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('dedicated_gate_predicate_required')

    const row = harness!.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(TASK_ID) as { status: string }
    expect(row.status).toBe('review')
    const verdictCount = harness!.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get(TASK_ID) as { n: number }
    expect(verdictCount.n).toBe(0)
  })

  it('refuses to reject a gate:office task the same way', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:office' })
    const res = await tasksApp.fetch(verdictRequest({ verdict: 'rejected' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('dedicated_gate_predicate_required')
  })

  it('does NOT refuse an ordinary gate on the same route (regression pin — the refusal is scoped to gate:office only)', async () => {
    seedTask({ status: 'review', gateOwner: 'gate:reviewer' })
    const res = await tasksApp.fetch(verdictRequest({ verdict: 'approved' }), makeEnv())
    // Whatever this refuses/allows for an unrelated gate is out of scope here;
    // the point is it must NOT be 'dedicated_gate_predicate_required'.
    if (res.status === 409) {
      const json = (await res.json()) as { error: string }
      expect(json.error).not.toBe('dedicated_gate_predicate_required')
    }
  })
})
