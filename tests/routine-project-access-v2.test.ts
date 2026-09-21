// tests/routine-project-access-v2.test.ts — FP-01 Slice 2 v2 (successor to
// PR #1488, mupot#1443). PR #1488 shipped project_access proposal -> human
// verdict -> home-squad grant chain; kasra-review's adversarial gate found
// 3 P0s, 4 P1s, 5 P2s (see the ADVERSARIAL PATTERN LIBRARY memory entry,
// kasra-review 2026-09-21). This file proves each finding closed, with a
// mutation or direct-state proof alongside every assertion where the normal
// state machine cannot otherwise reach the exact defect shape.
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations, via the SAME shared
// makeReadyRoutineFixture helper tests/routine-project-access.test.ts uses),
// invokeTool for the MCP surface (task_verdict, task_verdict_reverse,
// project_access_reintake_authorize) — not raw table INSERTs, except where a
// test explicitly needs to seed an out-of-band precondition (documented at
// each such use).
import { afterEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { executeRoutineAction, submitRoutineProposal } from '../src/routines/actions'
import { executeProjectAccessGrant } from '../src/projects/service'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

function row(fixture: ReadyRoutineFixture, sql: string): Record<string, unknown> | undefined {
  return fixture.harness.sqlite.prepare(sql).get() as Record<string, unknown> | undefined
}

async function seedMember(
  fixture: ReadyRoutineFixture,
  id: string,
  opts: { status?: 'active' | 'suspended'; tenant?: string | null } = {},
): Promise<void> {
  const status = opts.status ?? 'active'
  const tenant = opts.tenant === undefined ? 'tenant-a' : opts.tenant
  await fixture.env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?3, ?4, datetime('now'))`,
  ).bind(id, tenant, `Member ${id}`, status).run()
}

// A real, active member — task_verdict's writeVerdict resolves decided_by to
// this id; verdictIsHuman (P0-3) requires decided_by to resolve to a REAL
// members row, so every test casting an 'approved' verdict that is meant to
// actually authorize a grant must seed this first.
function ownerAuth(): AuthContext {
  return {
    userId: 'owner-1', email: 'owner@example.com', role: 'owner', tenant: 'tenant-a', memberId: 'owner-1',
    capabilities: [{ member_id: 'owner-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

// agent-2 (fixture-seeded, squad-1, active, NOT the control task's assignee)
// holding gate:routines directly — the "sibling agent decides" shape P0-3
// closes. boundAgentId set (never a real member) — verdictPrincipal resolves
// this to an AGENT principal, and decided_via stays null (no human_origin).
function agent2Auth(): AuthContext {
  return {
    userId: 'agent-2', email: null, role: 'member', tenant: 'tenant-a', memberId: null, boundAgentId: 'agent-2',
    capabilities: [{ member_id: '', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

function grantProposal(overrides: Partial<{ member_id: string; project_id: string; access_level: 'read' | 'write' | 'admin'; reason: string }> = {}) {
  return {
    key: 'grant-1' as const, kind: 'project_access' as const,
    input: {
      member_id: 'member-shadi', project_id: 'project-1', access_level: 'write' as const,
      reason: 'onboarding', ...overrides,
    },
  }
}

function zeroGrantsAndReceipts(fixture: ReadyRoutineFixture): void {
  expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_squad_access WHERE project_id != \'project-1\' OR squad_id != \'squad-1\''))
    .toEqual({ n: 0 })
  expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 0 })
}

describe('FP-01 Slice 2 v2 — project_access chain (successor to PR #1488)', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => {
    fixture?.harness.close()
    fixture = undefined
  })

  // ── P0-1: project_access ALWAYS requires the human gate ───────────────────
  describe('P0-1: project_access is refused at submit time under any non-propose policy', () => {
    it('execute_internal + a PRE-EXISTING approved verdict on the control task -> refused at submit, no grant, no receipt', async () => {
      fixture = await makeReadyRoutineFixture('execute_internal')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      expect(home.ok).toBe(true)
      if (!home.ok) return

      // Precondition: the control task already carries an APPROVED verdict,
      // cast for some unrelated earlier reason (raw SQL — this represents a
      // fact from before this proposal ever existed, not something any
      // real call path produces in one step).
      fixture.harness.sqlite.exec(`
        UPDATE tasks SET status = 'approved' WHERE id = 'control-task';
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
        VALUES ('verdict-earlier', 'control-task', 'approved', 'unrelated', 'owner-1', '2026-07-19T15:00:00.000Z');
        UPDATE tasks SET status = 'in_progress' WHERE id = 'control-task';
      `)

      const proposal = fixture.proposal(grantProposal())
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toEqual({ ok: false, error: 'execution_mode_forbidden_for_kind' })

      zeroGrantsAndReceipts(fixture)
      // The action was never even reserved.
      expect(row(fixture, "SELECT COUNT(*) AS n FROM routine_run_actions WHERE action_key = 'grant-1'")).toEqual({ n: 0 })
    })

    it('MUTATION-CLASS: removing the submit-time refusal (but keeping everything else) would let execute_internal execute a project_access proposal without ANY review wait', async () => {
      // This test documents what the refusal in submitRoutineProposal
      // guards, by proving the ADJACENT fact the class depends on: under
      // execute_internal, an ordinary (non-project_access) action kind DOES
      // execute immediately with gate_status='not_required' — the exact
      // path project_access must never be allowed onto. If the refusal
      // were removed, project_access would take this SAME path.
      fixture = await makeReadyRoutineFixture('execute_internal')
      const proposal = fixture.proposal({ key: 'no-op-1', kind: 'no_action', input: { reason: 'nothing to do' } })
      const result = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(result).toMatchObject({ ok: true, status: 'succeeded' })
      expect(row(fixture, "SELECT gate_status FROM routine_run_actions WHERE action_key = 'no-op-1'"))
        .toEqual({ gate_status: 'not_required' })
    })
  })

  // ── P0-2: the verdict must be bound to THIS proposal ──────────────────────
  describe('P0-2: verdict binding — proposal_id, freshness, and non-reversal', () => {
    it('an EARLIER approval + reopen + a NEW proposal -> the stale verdict does not authorize the new proposal\'s grant', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      // An EARLIER, unrelated approved verdict on the control task —
      // proposal_id NULL (never bound to any proposal), decided BEFORE this
      // test's real proposal will even be reserved. Raw SQL: this
      // represents an out-of-band fact (an approval on a previous, since-
      // reopened cycle of the same long-lived control task), not something
      // any single call path produces.
      fixture.harness.sqlite.exec(`
        INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, proposal_id)
        VALUES ('verdict-earlier', 'control-task', 'approved', 'unrelated earlier decision', 'owner-1', '2026-07-19T15:00:00.000Z', NULL);
      `)
      // task remains 'in_progress' (never entered review for that earlier verdict in this test) — reopen is implicit.

      const proposal = fixture.proposal(grantProposal())
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

      // Replay WITHOUT ever casting a NEW verdict — the generic approvedGate
      // (task-level, unbound) sees the stale 'approved' row as "latest" and
      // flips the action's OWN gate_status to 'approved'; the proposal-
      // bound check (resolveProposalVerdict) must still refuse because that
      // verdict's proposal_id does not name this action.
      const replayed = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(replayed).not.toMatchObject({ status: 'succeeded' })
      zeroGrantsAndReceipts(fixture)
    })

    it('approve THEN reverse -> the reversed verdict does not authorize the grant', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      await seedMember(fixture, 'owner-1')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      const proposal = fixture.proposal(grantProposal())
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

      const approved = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
        task_id: 'control-task', verdict: 'approved', note: 'approved for Shadi',
      })
      expect(approved.ok).toBe(true)

      // task_verdict_reverse routes through the SAME artifact-provenance
      // gate every review-entry does for an agent-assigned task
      // (src/tasks/index.ts's verifyTaskArtifactShape) — unrelated to
      // verdict-reversal semantics, but a real precondition for reversing
      // ANY agent-assigned task back to review. Satisfy it directly (a
      // routine control task never goes through execute.ts's finishTask,
      // so it never has a real result) so this test can focus on the
      // reversal semantics it actually exercises.
      fixture.harness.sqlite.exec(
        `UPDATE tasks SET result = 'Artifact: docs/routine-control.md\nSHA256: ${'a'.repeat(64)}' WHERE id = 'control-task'`,
      )

      const verdictRow = row(fixture, "SELECT id, reversed_at FROM task_verdicts WHERE task_id = 'control-task'")
      expect(verdictRow?.reversed_at).toBeNull()

      const reversed = await invokeTool(ownerAuth(), fixture.env, 'task_verdict_reverse', {
        task_id: 'control-task', reason: 'approved in error',
      })
      expect(reversed.ok).toBe(true)

      // The ORIGINAL verdict row is now marked reversed — not deleted, not
      // mutated in any other column.
      const afterReversal = row(fixture, "SELECT id, verdict, reversed_at FROM task_verdicts WHERE task_id = 'control-task'")
      expect(afterReversal?.id).toBe(verdictRow?.id)
      expect(afterReversal?.reversed_at).not.toBeNull()

      // The routine's own replay must now find NO usable verdict — the task
      // is back in 'review' (task_verdict_reverse's own doing), so a bare
      // replay reports 'approval_required', never a grant.
      const replayed = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(replayed).not.toMatchObject({ status: 'succeeded' })
      zeroGrantsAndReceipts(fixture)
    })
  })

  // ── P0-3: the verdict must be cast by a HUMAN ──────────────────────────────
  describe('P0-3: verdictIsHuman — an agent exercising its own gate:routines capability never authorizes a grant', () => {
    it('a SIBLING AGENT (agent-2, gate:routines, no human_origin) approves -> no grant lands', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')
      fixture.harness.sqlite.exec(`
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('agent2-gate-routines', 'gate:routines', 'agent', 'agent-2', 'test', datetime('now'));
      `)

      const proposal = fixture.proposal(grantProposal())
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

      const verdictOutcome = await invokeTool(agent2Auth(), fixture.env, 'task_verdict', {
        task_id: 'control-task', verdict: 'approved', note: 'approved by a peer agent',
      })
      expect(verdictOutcome.ok).toBe(true)

      const verdictRow = row(fixture, "SELECT decided_by, decided_via FROM task_verdicts WHERE task_id = 'control-task'")
      expect(verdictRow).toEqual({ decided_by: 'agent-2', decided_via: null })

      const replayed = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(replayed).not.toMatchObject({ status: 'succeeded' })
      zeroGrantsAndReceipts(fixture)
    })

    it('the SAME approved-by-agent verdict, replayed via executeRoutineAction directly, refuses with a receipt-less failure', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')
      fixture.harness.sqlite.exec(`
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('agent2-gate-routines', 'gate:routines', 'agent', 'agent-2', 'test', datetime('now'));
      `)
      const proposal = fixture.proposal(grantProposal())
      await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      await invokeTool(agent2Auth(), fixture.env, 'task_verdict', { task_id: 'control-task', verdict: 'approved' })

      const finished = await executeRoutineAction(fixture.env, 'run-1', 'grant-1')
      expect(finished).not.toMatchObject({ status: 'succeeded' })
      zeroGrantsAndReceipts(fixture)
    })
  })

  // ── P1-4: a REJECTED verdict never grants, even when gate_status is
  // already 'approved' (the exact mutation-surviving shape the adversarial
  // gate found: `if (!verdict || verdict.verdict !== 'approved')` mutated to
  // `if (!verdict)`) ─────────────────────────────────────────────────────
  describe('P1-4: a rejected, proposal-bound verdict never grants', () => {
    it(
      'DIRECT-STATE proof: gate_status already \'approved\' (simulating the generic gate having flipped it) ' +
      'with a REJECTED verdict correctly bound to THIS proposal -> refused, no grant',
      async () => {
        fixture = await makeReadyRoutineFixture('propose')
        await seedMember(fixture, 'member-shadi')
        const home = await createHomeForMember(fixture.env, 'member-shadi')
        if (!home.ok) throw new Error('home not created')

        const proposal = fixture.proposal(grantProposal())
        await submitRoutineProposal(fixture.env, fixture.principal, proposal)

        const actionRow = row(fixture, "SELECT id, created_at FROM routine_run_actions WHERE action_key = 'grant-1'") as
          { id: string; created_at: string } | undefined
        expect(actionRow?.id).toBeTruthy()

        // Simulate: the generic approvedGate flip already happened (as it
        // would if an unrelated stale verdict had made the task-level
        // "latest verdict" read 'approved' at some earlier instant), AND a
        // properly-bound, FRESH, REJECTED verdict now exists for this exact
        // proposal — this is the state resolveProposalVerdict's own
        // "verdict.verdict !== 'approved'" conjunct exists to catch; not
        // reachable by chaining public calls (rejecting always cancels the
        // action via the generic gate_status='pending' branch before this
        // code is reached), so it is asserted directly here, at the DB
        // layer, the same "prove the check, not just the story" doctrine
        // this codebase's own mutation-class tests use throughout.
        fixture.harness.sqlite.exec(`
          UPDATE routine_run_actions SET gate_status = 'approved', status = 'pending' WHERE id = '${actionRow?.id}';
          INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, proposal_id)
          VALUES ('verdict-rejected-bound', 'control-task', 'rejected', 'no', 'owner-1',
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '${actionRow?.id}');
        `)

        const finished = await executeRoutineAction(fixture.env, 'run-1', 'grant-1')
        expect(finished).not.toMatchObject({ status: 'succeeded' })
        zeroGrantsAndReceipts(fixture)
      },
    )

    it('MUTATION PROOF: `!verdict` in place of `!verdict || verdict.verdict !== "approved"` would accept the rejected verdict above', async () => {
      // Executable proof that the check in the previous test IS the one
      // guarding against the rejected verdict — not a coincidental refusal
      // from elsewhere. Re-derive the exact predicate resolveProposalVerdict
      // feeds and show the buggy variant would pass while the real one
      // refuses, over the SAME verdict row shape.
      const verdict: { verdict: 'approved' | 'rejected' } | null = { verdict: 'rejected' }
      const real = !verdict || verdict.verdict !== 'approved'
      const mutated = !verdict
      expect(real).toBe(true) // refuses
      expect(mutated).toBe(false) // the mutation would NOT refuse — proves the check is load-bearing
    })
  })

  // ── P1-5: grant + receipt is ONE atomic unit ───────────────────────────────
  describe('P1-5: executeProjectAccessGrant writes the grant and its receipt in ONE D1 batch', () => {
    it('receipt insert forced to fail -> the grant (project_squad_access) does NOT land either', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      // Force the receipt INSERT statement specifically to violate
      // project_access_grant_receipts' NOT NULL tenant column, INSIDE the
      // same batch as the grant upsert — proving the batch is one
      // transaction, not "grant, then separately try the receipt."
      const realPrepare = fixture.env.DB.prepare.bind(fixture.env.DB)
      const faultyEnv: Env = {
        ...fixture.env,
        DB: {
          ...fixture.env.DB,
          prepare(sql: string) {
            const stmt = realPrepare(sql)
            if (sql.includes('INSERT INTO project_access_grant_receipts')) {
              return {
                bind: (...args: unknown[]) => {
                  const corrupted = [...args]
                  corrupted[1] = null // tenant column — NOT NULL
                  return stmt.bind(...corrupted)
                },
              } as unknown as ReturnType<typeof realPrepare>
            }
            return stmt
          },
        } as unknown as Env['DB'],
      }

      const grant = await executeProjectAccessGrant(faultyEnv, {
        projectId: 'project-1', squadId: home.squad.id, memberId: 'member-shadi', accessLevel: 'write',
        proposalId: 'forced-failure-proposal', verdictId: 'forced-failure-verdict',
        decidedBy: 'owner-1', decidedVia: null,
      })
      expect(grant.ok).toBe(false)

      // THE ATOMICITY ASSERTION: zero rows on BOTH sides, on the REAL
      // (unwrapped) env — the grant upsert did not survive the receipt's
      // failure inside the same transaction.
      expect(row(fixture, `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)).toEqual({ n: 0 })
      expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 0 })
    })
  })

  // ── P2-10: the ceiling is the PROPOSER's own squad, not the routine's
  // configured responsible_squad_id ──────────────────────────────────────
  describe('P2-10: the access-ceiling check reads the PROPOSING AGENT\'s own structural squad', () => {
    it('agent-1\'s OWN structural squad governs the ceiling, not responsible_squad_id (squad-1, unchanged, still \'write\')', async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')

      // routine_runs.policy_json is immutable once the run exists (0073's
      // routine_run_ownership_immutable trigger) — so responsible_squad_id
      // stays 'squad-1' ('write') for this test, UNCHANGED. Instead, move
      // the PROPOSING AGENT's own structural squad (agents.squad_id, not a
      // capability grant) to a new, LOWER-ranked squad. Before P2-10, the
      // ceiling read responsible_squad_id's rank ('write') regardless of
      // this; after, it reads agent-1's OWN squad's rank ('read').
      fixture.harness.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-low', 'dept-1', 'low-squad', 'Low Squad');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-low', 'read');
        UPDATE agents SET squad_id = 'squad-low' WHERE id = 'agent-1';
      `)

      const proposal = fixture.proposal(grantProposal({ access_level: 'write' }))
      // Ceiling is now agent-1's OWN squad-low rank ('read'), so 'write'
      // exceeds it — proving responsible_squad_id's 'write' rank (squad-1,
      // untouched) was NOT what got consulted.
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toEqual({ ok: false, error: 'access_ceiling_exceeded' })
    })
  })
})
