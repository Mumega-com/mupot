// tests/task-verdict-reversal.test.ts — FP-01 Slice 2 v2 round 2 (P0,
// kasra-review adversarial gate on PR #1490 + Athena's binding ordering
// rider): task_verdict_reverse used to do three sequential, independent
// writes (persistTaskUpdate status->review, an INSERT into
// verdict_reversals, THEN markVerdictReversed) — a failure of the LAST one
// left the task 'review' with an audit row but reversed_at still NULL (the
// grant could still replay), AND the admin could not even retry
// (existing.status was already 'review', so the ordinary transition matrix
// refused review->review as invalid_transition).
//
// reverseTaskVerdict (src/tasks/service.ts) replaces this with
// reversed_at-FIRST ordering (the gate-closing write lands before anything
// else is attempted) and full idempotency, so a retry after ANY partial
// failure — including its own migration (0162) not having been applied yet
// — completes cleanly rather than getting stuck.
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations), via the SAME shared
// makeReadyRoutineFixture helper tests/routine-project-access.test.ts uses
// for its real departments/squads/agents/members/tasks scaffolding — the
// routine machinery itself is unused here; 'control-task' is just a real,
// ordinary task this file drives directly through the REAL task_verdict /
// task_verdict_reverse MCP tools (invokeTool), never a hand-rolled mock.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

const MIGRATION_0162_SQL = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '0162_task_verdicts_reversal_update_exception.sql'),
  'utf8',
)

function row(fixture: ReadyRoutineFixture, sql: string): Record<string, unknown> | undefined {
  return fixture.harness.sqlite.prepare(sql).get() as Record<string, unknown> | undefined
}

function ownerAuth(): AuthContext {
  return {
    userId: 'owner-1', email: 'owner@example.com', role: 'owner', tenant: 'tenant-a', memberId: 'owner-1',
    capabilities: [{ member_id: 'owner-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

async function seedMember(fixture: ReadyRoutineFixture, id: string): Promise<void> {
  await fixture.env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`,
  ).bind(id, 'tenant-a', `Member ${id}`).run()
}

// The OLD 0069-shaped trigger, with NEITHER the reversed_at exception NOR
// the P2-7 column pins 0162 adds — reverting to this simulates "0162 has
// not been applied yet" against an otherwise fully-migrated, real schema
// (code and migrations here deploy as separate manual steps).
const PRE_0162_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS task_verdicts_no_update;
  CREATE TRIGGER task_verdicts_no_update
  BEFORE UPDATE ON task_verdicts
  WHEN NOT (
    OLD.project_id IS NULL
    AND NEW.project_id IS (SELECT project_id FROM tasks WHERE id = OLD.task_id)
    AND NEW.id IS OLD.id
    AND NEW.task_id IS OLD.task_id
    AND NEW.verdict IS OLD.verdict
    AND NEW.note IS OLD.note
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
  END;
`

async function approveControlTask(fixture: ReadyRoutineFixture): Promise<void> {
  await seedMember(fixture, 'owner-1')
  // makeReadyRoutineFixture's control-task starts 'in_progress' with no
  // gate_owner (the routine machinery itself is unused in this file — these
  // tests are about ordinary task_verdict/task_verdict_reverse behavior,
  // not project_access proposals) — put it in review under an UNRELATED
  // gate directly, exactly as any ordinary gated task would arrive there.
  // task_verdict_reverse routes review-entry through the SAME artifact-
  // provenance gate every review-entry does for an agent-assigned task
  // (src/tasks/index.ts's verifyTaskArtifactShape) — unrelated to verdict-
  // reversal semantics, but a real precondition. Satisfy it directly (the
  // routine machinery is unused here, so this task never goes through
  // execute.ts's finishTask, which is what normally writes a real result).
  fixture.harness.sqlite.exec(
    `UPDATE tasks SET status = 'review', gate_owner = 'gate:outreach', ` +
    `result = 'Artifact: docs/fixture.md\nSHA256: ${'a'.repeat(64)}' WHERE id = 'control-task'`,
  )
  const outcome = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
    task_id: 'control-task', verdict: 'approved', note: 'approved for testing',
  })
  expect(outcome.ok).toBe(true)
}

describe('task_verdict_reverse — reversed_at-first, atomic, idempotent (FP-01 Slice 2 v2 round 2, P0)', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => {
    fixture?.harness.close()
    fixture = undefined
  })

  it('a fresh reversal lands all three facts together: reversed_at, status=review, and the audit receipt', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await approveControlTask(fixture)

    const reversed = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
      task_id: 'control-task', reason: 'approved in error',
    })
    expect(reversed.ok).toBe(true)

    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'review' })
    const verdict = row(fixture, "SELECT verdict, reversed_at FROM task_verdicts WHERE task_id = 'control-task'")
    expect(verdict?.verdict).toBe('approved')
    expect(verdict?.reversed_at).not.toBeNull()
    expect(row(fixture, "SELECT COUNT(*) AS n FROM verdict_reversals WHERE task_id = 'control-task'")).toEqual({ n: 1 })
  })

  it(
    'TOLERATES ITS OWN MIGRATION NOT HAVING RUN YET: with the pre-0162 trigger live, the reversal fails ' +
    'CLEANLY — zero partial writes — and a retry AFTER 0162 lands succeeds outright',
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await approveControlTask(fixture)

      // Simulate "0162 has not been applied yet" against the REAL,
      // otherwise fully-migrated schema (applyAllMigrations already ran
      // inside makeReadyRoutineFixture) — revert ONLY this one trigger to
      // its pre-0162 (0069) shape.
      fixture.harness.sqlite.exec(PRE_0162_TRIGGER_SQL)

      const failedAttempt = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
        task_id: 'control-task', reason: 'approved in error',
      })
      expect(failedAttempt.ok).toBe(false)

      // ZERO partial state: task still 'approved', verdict still
      // unreversed, no audit row — nothing for an admin to reconcile, and
      // nothing that could authorize a grant it shouldn't.
      expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'approved' })
      expect(row(fixture, "SELECT reversed_at FROM task_verdicts WHERE task_id = 'control-task'")).toEqual({ reversed_at: null })
      expect(row(fixture, 'SELECT COUNT(*) AS n FROM verdict_reversals')).toEqual({ n: 0 })

      // 0162 lands (the real migration file, applied for real).
      fixture.harness.sqlite.exec(MIGRATION_0162_SQL)

      const retried = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
        task_id: 'control-task', reason: 'approved in error',
      })
      expect(retried.ok).toBe(true)
      expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'review' })
      expect(row(fixture, "SELECT reversed_at FROM task_verdicts WHERE task_id = 'control-task'")).not.toEqual({ reversed_at: null })
      expect(row(fixture, 'SELECT COUNT(*) AS n FROM verdict_reversals')).toEqual({ n: 1 })
    },
  )

  it('RETRY-COMPLETION: reversed_at + status already landed on a prior attempt, only the audit receipt is missing — the retry completes it, never invalid_transition', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await approveControlTask(fixture)

    // Simulate "steps 1+2 landed, step 3 (the audit insert) failed" —
    // directly, since normal call paths (after this fix) cannot produce
    // this exact partial state on their own; it is the state a retry must
    // recognize and complete.
    const verdictRow = row(fixture, "SELECT id FROM task_verdicts WHERE task_id = 'control-task'") as { id: string }
    fixture.harness.sqlite.exec(`
      UPDATE task_verdicts SET reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = '${verdictRow.id}';
      UPDATE tasks SET status = 'review', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'control-task';
    `)
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM verdict_reversals')).toEqual({ n: 0 })

    // The retry: SAME shape of call an admin would re-send. Must NOT be
    // refused as invalid_transition (review->review) — it must complete.
    const retried = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
      task_id: 'control-task', reason: 'approved in error',
    })
    expect(retried.ok).toBe(true)
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM verdict_reversals WHERE task_id = \'control-task\'')).toEqual({ n: 1 })
  })

  it('IDEMPOTENT full replay: reversing an already-fully-reversed task twice writes nothing extra and never errors the caller into a bad state', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await approveControlTask(fixture)

    const first = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
      task_id: 'control-task', reason: 'approved in error',
    })
    expect(first.ok).toBe(true)

    const second = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
      task_id: 'control-task', reason: 'approved in error, retried',
    })
    // Idempotent completion (task already 'review' + already reversed) —
    // never a second audit row, never an error.
    expect(second.ok).toBe(true)
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM verdict_reversals')).toEqual({ n: 1 })
    expect(row(fixture, "SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'control-task'")).toEqual({ n: 1 })
  })

  // ── P2-7: 0162's shape-1 (kept 0069 exception) now pins the four newer
  // columns too, so it cannot be abused to sneak a change through them ────
  describe('P2-7: 0162 shape 1 (the historical project_id backfill exception) pins decided_via/origin_agent_id/proposal_id/reversed_at', () => {
    it('PROVEN INERT: shape 1\'s own precondition (project_id IS NULL) can never be true — 0059\'s hydrate trigger backfills it immediately on every INSERT', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      // Attempt the exact precondition shape 1 requires: INSERT a verdict
      // with project_id NULL. 0059's task_verdicts_project_hydrate_insert
      // (AFTER INSERT ... WHEN NEW.project_id IS NULL) backfills it in the
      // SAME transaction, before any later statement could ever observe a
      // NULL — so no UPDATE can ever find `OLD.project_id IS NULL` true on
      // any row this schema can produce. Shape 1 is dead code by construction,
      // and pinning it further (this file's other test) is pure
      // defense-in-depth, never a live path.
      fixture.harness.sqlite.exec(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
        VALUES ('legacy-verdict-1', 'control-task', 'approved', 'legacy', 'owner-1', datetime('now'), NULL)
      `)
      const hydrated = row(fixture, "SELECT project_id FROM task_verdicts WHERE id = 'legacy-verdict-1'")
      expect(hydrated?.project_id).toBe('project-1') // already backfilled — never NULL.
    })

    it('P2-7 CLOSED (defense-in-depth): IF shape 1\'s precondition were ever reached, it still could not be abused to sneak a change to decided_via/origin_agent_id/proposal_id/reversed_at', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      // Force the otherwise-unreachable precondition by temporarily
      // disabling 0059's hydrate trigger — the ONLY way to get a
      // project_id-IS-NULL row past the point of INSERT, given the
      // previous test's own proof that it is otherwise immediate.
      fixture.harness.sqlite.exec('DROP TRIGGER task_verdicts_project_hydrate_insert')
      fixture.harness.sqlite.exec(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
        VALUES ('legacy-verdict-2', 'control-task', 'approved', 'legacy', 'owner-1', datetime('now'), NULL)
      `)
      expect(row(fixture, "SELECT project_id FROM task_verdicts WHERE id = 'legacy-verdict-2'")).toEqual({ project_id: null })

      // The legitimate backfill (project_id only) still works...
      expect(() => {
        fixture!.harness.sqlite.exec(`
          UPDATE task_verdicts
             SET project_id = (SELECT project_id FROM tasks WHERE id = task_verdicts.task_id)
           WHERE id = 'legacy-verdict-2'
        `)
      }).not.toThrow()
      expect(row(fixture, "SELECT project_id FROM task_verdicts WHERE id = 'legacy-verdict-2'")).not.toEqual({ project_id: null })

      // ...but the SAME backfill-shaped UPDATE cannot ALSO sneak a change
      // to decided_via — must be refused (proving the pin), not silently
      // accepted as "the backfill".
      fixture.harness.sqlite.exec(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id)
        VALUES ('legacy-verdict-3', 'control-task', 'approved', 'legacy', 'owner-1', datetime('now'), NULL)
      `)
      expect(() => {
        fixture!.harness.sqlite.exec(`
          UPDATE task_verdicts
             SET project_id = (SELECT project_id FROM tasks WHERE id = task_verdicts.task_id),
                 decided_via = 'agent_attested_origin'
           WHERE id = 'legacy-verdict-3'
        `)
      }).toThrow(/append-only/)
      // decided_via is untouched.
      expect(row(fixture, "SELECT decided_via FROM task_verdicts WHERE id = 'legacy-verdict-3'"))
        .toEqual({ decided_via: null })
    })
  })
})
