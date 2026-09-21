// tests/routine-project-access.test.ts — FP-01 Slice 2 (mupot#1443, brief §2
// Task A: `agents/kasra/briefs/flight-first-person-mubot-meets-shadi-20260920.md`).
//
// PROOF RULE UNDER TEST: proposal_id -> verdict_id -> grant receipt id, and
// the grant row exists ONLY after a human verdict — a mutation that grants at
// submit time must turn this suite red (see "mutation-class" test below).
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations, via the shared
// makeReadyRoutineFixture helper — the same harness tests/routine-actions.test.ts
// uses for every other routine-proposal action kind), invokeTool for the MCP
// surface (task_verdict), createHomeForMember for the home squad (dogfooding
// the real Slice-1 write path rather than hand-rolling department/squad rows).
import { afterEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { executeRoutineAction, submitRoutineProposal } from '../src/routines/actions'
import { invokeTool } from '../src/mcp'
import type { AuthContext } from '../src/types'
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

// An org owner with squad-1 member+ capability — task_verdict's base guard
// (memberCanOnSquad) reads ONLY `auth.capabilities`, never `auth.role`, so an
// owner-role auth object still needs a real grant to pass it; the gate-
// ownership check (gate:routines) and self-verdict fall through the
// legacyOwnerAdmin(auth) bypass on `auth.role` alone.
function ownerAuth(): AuthContext {
  return {
    userId: 'owner-1', email: 'owner@example.com', role: 'owner', tenant: 'tenant-a', memberId: 'owner-1',
    capabilities: [{ member_id: 'owner-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

describe('project_access routine proposal (FP-01 Slice 2, mupot#1443)', () => {
  let fixture: ReadyRoutineFixture | undefined

  afterEach(() => {
    fixture?.harness.close()
    fixture = undefined
  })

  it('refuses an unknown member before ever reaching review', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'ghost-member', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toEqual({ ok: false, error: 'member_not_eligible' })
    expect(row(fixture, "SELECT status FROM tasks WHERE id = 'control-task'")).toEqual({ status: 'in_progress' })
  })

  it('refuses a suspended member', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-suspended', { status: 'suspended' })
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-suspended', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toEqual({ ok: false, error: 'member_not_eligible' })
  })

  it('refuses a proposal naming a project other than the run\'s own', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'some-other-project', access_level: 'write', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toEqual({ ok: false, error: 'reference_out_of_scope' })
  })

  it('refuses access_level above the proposing squad\'s own ceiling on the project', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    // Fixture seeds squad-1 at 'write' on project-1 (see tests/helpers/routine-actions.ts) — 'admin' exceeds it.
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'admin', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toEqual({ ok: false, error: 'access_ceiling_exceeded' })
  })

  it('allows access_level AT the proposing squad\'s ceiling (write == write)', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })
  })

  it(
    'lands a valid proposal in review and grants NOTHING until a human verdict ' +
    '(mutation-class: a grant executed at submit time turns this red)',
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      expect(home.ok).toBe(true)
      if (!home.ok) return

      const proposal = fixture.proposal({
        key: 'grant-1', kind: 'project_access',
        input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
      })
      const result = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(result).toMatchObject({ ok: true, status: 'waiting', reason: 'review' })
      expect(row(fixture, "SELECT status, gate_owner FROM tasks WHERE id = 'control-task'")).toEqual({
        status: 'review', gate_owner: 'gate:routines',
      })
      // THE MUTATION-CLASS ASSERTION: the home squad has zero project access,
      // and zero grant receipts, while the proposal sits in review.
      expect(row(fixture, `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)).toEqual({ n: 0 })
      expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 0 })
    },
  )

  it('rejection path: no grant lands, and the record says rejected', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

    const rejection = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
      task_id: 'control-task', verdict: 'rejected', note: 'not yet',
    })
    expect(rejection.ok).toBe(true)

    expect(row(fixture, "SELECT status, verdict FROM tasks t JOIN task_verdicts v ON v.task_id = t.id WHERE t.id = 'control-task'"))
      .toMatchObject({ status: 'rejected', verdict: 'rejected' })

    // The rejection is only PROCESSED (routine_run_actions flipped to
    // 'cancelled') the next time the assigned agent re-submits/re-checks —
    // same generic replay path the approval side of this suite exercises.
    const replayed = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    expect(replayed).toMatchObject({ ok: false, error: 'approval_required' })

    expect(row(fixture, `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)).toEqual({ n: 0 })
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 0 })
    // The routine's own action record IS the rejection receipt.
    expect(row(fixture, "SELECT status, result_json FROM routine_run_actions WHERE action_key = 'grant-1'"))
      .toMatchObject({ status: 'cancelled', result_json: expect.stringContaining('proposal_rejected') })
  })

  it('chain: proposal_id -> verdict_id -> grant receipt id, landing write access on the member\'s HOME squad', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'first thing I want done' },
    })
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

    // The REAL task_verdict MCP tool — not a raw task_verdicts INSERT.
    const verdictOutcome = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
      task_id: 'control-task', verdict: 'approved', note: 'approved for Shadi',
    })
    expect(verdictOutcome.ok).toBe(true)

    const verdictRow = row(fixture, "SELECT id, decided_by FROM task_verdicts WHERE task_id = 'control-task'") as
      { id: string; decided_by: string } | undefined
    expect(verdictRow?.id).toBeTruthy()

    const proposalRow = row(fixture, "SELECT id FROM routine_run_actions WHERE action_key = 'grant-1'") as { id: string } | undefined
    expect(proposalRow?.id).toBeTruthy()

    // Re-submitting the SAME proposal is how the assigned agent (Mubot) observes
    // the verdict and finalizes — the generic routine-proposal replay path
    // (src/routines/actions.ts's replayWaitingAction), unmodified for this kind.
    const finished = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    expect(finished).toMatchObject({
      ok: true,
      status: 'succeeded',
      result: {
        project_id: 'project-1',
        member_id: 'member-shadi',
        squad_id: home.squad.id,
        access_level: 'write',
        proposal_id: proposalRow?.id,
        verdict_id: verdictRow?.id,
        grant_receipt_id: expect.any(String),
      },
    })

    const access = row(fixture, `SELECT project_id, squad_id, access_level FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)
    expect(access).toEqual({ project_id: 'project-1', squad_id: home.squad.id, access_level: 'write' })

    const receipt = row(
      fixture,
      `SELECT project_id, squad_id, member_id, access_level, proposal_id, verdict_id, decided_by
         FROM project_access_grant_receipts WHERE verdict_id = '${verdictRow?.id}'`,
    )
    expect(receipt).toEqual({
      project_id: 'project-1',
      squad_id: home.squad.id,
      member_id: 'member-shadi',
      access_level: 'write',
      proposal_id: proposalRow?.id,
      verdict_id: verdictRow?.id,
      decided_by: verdictRow?.decided_by,
    })

    // Idempotent finalize: a second replay of the same proposal must not write
    // a second grant receipt or a second access row.
    await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
      .resolves.toMatchObject({ ok: true, status: 'succeeded', duplicate: true })
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 1 })
    expect(row(fixture, `SELECT COUNT(*) AS n FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)).toEqual({ n: 1 })
  })

  it('grants exactly the member\'s HOME squad, never an arbitrary squad named elsewhere', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')
    expect(home.squad.id).not.toBe('squad-1')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    await invokeTool(ownerAuth(), fixture.env, 'task_verdict', { task_id: 'control-task', verdict: 'approved' })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)

    // squad-1 (Mubot's own responsible squad) never receives a NEW edge from
    // this action — it already held 'write' from the fixture seed, unchanged.
    const squadOneAccess = row(fixture, "SELECT access_level FROM project_squad_access WHERE squad_id = 'squad-1'")
    expect(squadOneAccess).toEqual({ access_level: 'write' })
    const homeAccess = row(fixture, `SELECT access_level FROM project_squad_access WHERE squad_id = '${home.squad.id}'`)
    expect(homeAccess).toEqual({ access_level: 'write' })
  })

  it('fails closed when the member has no home yet (createHomeForMember never ran)', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await seedMember(fixture, 'member-no-home')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-no-home', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    await invokeTool(ownerAuth(), fixture.env, 'task_verdict', { task_id: 'control-task', verdict: 'approved' })

    const finished = await executeRoutineAction(fixture.env, 'run-1', 'grant-1')
    // Never a "succeeded" grant — either an outright failure or a scheduled
    // retry, never the happy-path result shape (which always carries
    // grant_receipt_id).
    expect(finished).not.toMatchObject({ status: 'succeeded' })
    expect(row(fixture, 'SELECT COUNT(*) AS n FROM project_access_grant_receipts')).toEqual({ n: 0 })
    expect(row(fixture, "SELECT COUNT(*) AS n FROM project_squad_access WHERE project_id = 'project-1'"))
      .toEqual({ n: 1 }) // only the pre-existing squad-1 edge from the fixture seed
  })
})
