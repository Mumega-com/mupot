// tests/im-intake-state.test.ts — mupot-plugin PR #17 contract addendum
// (FP-01 Slice 2, mupot#1443): the webhook's `intake_state` field
// (src/im/index.ts's memberIntakeEnvelope) is entirely SERVER-derived so the
// plugin never decides "is this member new" locally.
//
//   'none'     — chatId maps to no member.
//   'pending'  — bound, no project_access proposal submitted for this member yet
//                (regardless of whether a home squad exists yet).
//   'complete' — a project_access routine proposal naming this member EXISTS
//                (routine_run_actions.kind='project_access'), independent of
//                that proposal's own approved/rejected/waiting outcome.
//
// NO MIGRATION: reuses routine_run_actions.input_json (already storing
// member_id on a project_access action, migrations/0073+0158) rather than a
// new members column or engram marker.
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations) — via the SAME shared
// makeReadyRoutineFixture helper tests/routine-actions.test.ts and
// tests/routine-project-access.test.ts use, not a hand-rolled schema or mock.
import { afterEach, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { submitRoutineProposal } from '../src/routines/actions'
import { invokeTool } from '../src/mcp'
import { memberIntakeEnvelope } from '../src/im'
import type { AuthContext, Member } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

// Squad-1's fixture member+admin — see tests/helpers/routine-actions.ts.
// Holds squad-1 member+ so task_verdict's base guard passes; legacy owner
// role bypasses the gate:routines ownership check.
function ownerAuth(): AuthContext {
  return {
    userId: 'owner-1', email: 'owner@example.com', role: 'owner', tenant: 'tenant-a', memberId: 'owner-1',
    capabilities: [{ member_id: 'owner-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

async function seedMember(fixture: ReadyRoutineFixture, id: string): Promise<Member> {
  await fixture.env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?3, 'active', datetime('now'))`,
  ).bind(id, 'tenant-a', `Member ${id}`).run()
  return { id, email: null, display_name: `Member ${id}`, telegram_chat_id: null, status: 'active', created_at: new Date().toISOString() }
}

describe('memberIntakeEnvelope (FP-01 Slice 2, mupot-plugin PR #17)', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => { fixture?.harness.close(); fixture = undefined })

  it("'none' for an unbound chat (no member row)", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    await expect(memberIntakeEnvelope(fixture.env, null)).resolves.toEqual({
      bound: false, member_id: null, home_squad_id: null, intake_state: 'none',
    })
  })

  it("'pending' for a bound member with no home yet — memberIntakeEnvelope is READ-ONLY (FP-01 Slice 2 v2 round 2, P1-a) and never provisions one itself", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    // memberIntakeEnvelope no longer self-heals a missing home — that write
    // moved to provisionHomeOnFirstContact, called ONLY from
    // handleImMessage's 'join' case (see tests/im-webhook-idempotency.test.ts
    // for that path). A bare read against a member who never joined via
    // Telegram stays home_squad_id: null, and — critically — writes nothing
    // (no home, no capability, no receipt row).
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
      bound: true, member_id: 'member-shadi', home_squad_id: null, intake_state: 'pending',
    })
    expect(fixture.harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM member_home_provisioning_receipts',
    ).get()).toEqual({ n: 0 })
  })

  it("'pending' for a bound member WITH a home but no project_access proposal yet", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
      bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'pending',
    })
  })

  it(
    "P2-6 (FP-01 Slice 2 v2 round 2, kasra-review adversarial gate on PR #1490): " +
    "a project_access proposal ALONE — no human verdict yet — stays 'pending', " +
    "never 'complete'; closes the cross-member DoS where naming a VICTIM in an " +
    "undecided proposal used to permanently lock their intake_state",
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      const member = await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      const proposal = fixture.proposal({
        key: 'grant-1', kind: 'project_access',
        input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'first thing I want done' },
      })
      await expect(submitRoutineProposal(fixture.env, fixture.principal, proposal))
        .resolves.toMatchObject({ ok: true, status: 'waiting', reason: 'review' })

      // The proposal exists, but NO human has decided it — must stay 'pending'.
      await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
        bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'pending',
      })
    },
  )

  it("'complete' once a HUMAN VERDICT decides the proposal (approved) — not merely on the proposal existing", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')
    await seedMember(fixture, 'owner-1') // P0-3: a real human decider

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'first thing I want done' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    const verdictOutcome = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
      task_id: 'control-task', verdict: 'approved',
    })
    expect(verdictOutcome.ok).toBe(true)

    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
      bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'complete',
    })
  })

  it("P2-6 CLOSED: a proposal naming a VICTIM who never contacted the bot stays 'pending' for them until a human actually decides it", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const victim = await seedMember(fixture, 'victim-member')
    const home = await createHomeForMember(fixture.env, 'victim-member')
    if (!home.ok) throw new Error('home not created')

    // Mubot (or any proposer) names the victim in a proposal the victim
    // never asked for and no human has seen yet.
    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'victim-member', project_id: 'project-1', access_level: 'write', reason: 'proposed on their behalf' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)

    // The victim's OWN first-person intake must still read 'pending' — the
    // plugin's §2f gate (only offer intake while 'pending') is not
    // permanently defeated by someone else's undecided proposal about them.
    await expect(memberIntakeEnvelope(fixture.env, victim)).resolves.toMatchObject({ intake_state: 'pending' })
  })

  it(
    "'complete' survives a DENIED verdict — a rejected proposal must never flip the member back to 'pending' " +
    '(Athena round-2 condition 1: re-intake requires human word, never an automatic reset)',
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      const member = await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      await seedMember(fixture, 'owner-1') // P2-4: a real human decider (the verdict WRITE itself now requires one)
      const proposal = fixture.proposal({
        key: 'grant-1', kind: 'project_access',
        input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
      })
      await submitRoutineProposal(fixture.env, fixture.principal, proposal)

      const rejection = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
        task_id: 'control-task', verdict: 'rejected', note: 'not yet',
      })
      expect(rejection.ok).toBe(true)

      await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
        bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'complete',
      })
    },
  )

  it(
    "'complete' via the project_access_grant_receipts fallback when the routine_run_actions row " +
    "no longer exists (Athena round-2 condition 1: robust to a rolled-back/deleted proposal row)",
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      const member = await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      const proposal = fixture.proposal({
        key: 'grant-1', kind: 'project_access',
        input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
      })
      await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      await seedMember(fixture, 'owner-1') // P0-3 (FP-01 Slice 2 v2): a real human decider
      await invokeTool(ownerAuth(), fixture.env, 'task_verdict', { task_id: 'control-task', verdict: 'approved' })
      const finished = await submitRoutineProposal(fixture.env, fixture.principal, proposal)
      expect(finished).toMatchObject({ ok: true, status: 'succeeded' })

      // The receipt is append-only (migrations/0157's own triggers refuse
      // UPDATE/DELETE on it), but the PROPOSAL row (routine_run_actions) is
      // ordinary application data with no such protection — simulate a
      // rollback/cleanup by deleting it directly.
      expect(fixture.harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM project_access_grant_receipts WHERE member_id = 'member-shadi'`,
      ).get()).toEqual({ n: 1 })
      fixture.harness.sqlite.exec(`DELETE FROM routine_run_actions WHERE action_key = 'grant-1'`)
      expect(fixture.harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM routine_run_actions WHERE action_key = 'grant-1'`,
      ).get()).toEqual({ n: 0 })

      await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
        bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'complete',
      })
    },
  )

  it('does not mark ANOTHER member complete from a proposal (and its verdict) naming someone else', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    await seedMember(fixture, 'member-other')
    await seedMember(fixture, 'owner-1') // P0-3/P2-4: a real human decider
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')
    await createHomeForMember(fixture.env, 'member-other')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)
    const verdictOutcome = await invokeTool(ownerAuth(), fixture.env, 'task_verdict', {
      task_id: 'control-task', verdict: 'approved',
    })
    expect(verdictOutcome.ok).toBe(true)

    const other = await fixture.env.DB.prepare(
      `SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE id = 'member-other'`,
    ).first<Member>()
    await expect(memberIntakeEnvelope(fixture.env, other!)).resolves.toMatchObject({ intake_state: 'pending' })
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toMatchObject({ intake_state: 'complete' })
  })

  it(
    'TOLERATES ITS OWN MIGRATIONS NOT HAVING RUN YET: with task_verdicts.proposal_id (0159) missing, ' +
    'memberIntakeEnvelope degrades to \'pending\' instead of throwing — runs on EVERY /im/webhook message',
    async () => {
      fixture = await makeReadyRoutineFixture('propose')
      const member = await seedMember(fixture, 'member-shadi')
      const home = await createHomeForMember(fixture.env, 'member-shadi')
      if (!home.ok) throw new Error('home not created')

      // Simulate "0159 has not been applied yet" against the REAL,
      // otherwise fully-migrated schema (applyAllMigrations already ran
      // inside makeReadyRoutineFixture) — drop just the one new column the
      // completion query's JOIN depends on.
      fixture.harness.sqlite.exec(`
        DROP INDEX IF EXISTS idx_task_verdicts_proposal;
        DROP TRIGGER IF EXISTS task_verdicts_no_update;
        ALTER TABLE task_verdicts DROP COLUMN proposal_id;
      `)

      await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
        bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'pending',
      })
    },
  )
})
