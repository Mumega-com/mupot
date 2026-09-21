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
import { memberIntakeEnvelope } from '../src/im'
import type { Member } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

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

  it("'pending' for a bound member with no home yet", async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
      bound: true, member_id: 'member-shadi', home_squad_id: null, intake_state: 'pending',
    })
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

  it("'complete' once a project_access proposal naming this member exists, regardless of its own verdict", async () => {
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

    // 'complete' fires on the PROPOSAL existing — before any human verdict at all.
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toEqual({
      bound: true, member_id: 'member-shadi', home_squad_id: home.squad.id, intake_state: 'complete',
    })
  })

  it('does not mark ANOTHER member complete from a proposal naming someone else', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const member = await seedMember(fixture, 'member-shadi')
    await seedMember(fixture, 'member-other')
    const home = await createHomeForMember(fixture.env, 'member-shadi')
    if (!home.ok) throw new Error('home not created')
    await createHomeForMember(fixture.env, 'member-other')

    const proposal = fixture.proposal({
      key: 'grant-1', kind: 'project_access',
      input: { member_id: 'member-shadi', project_id: 'project-1', access_level: 'write', reason: 'onboarding' },
    })
    await submitRoutineProposal(fixture.env, fixture.principal, proposal)

    const other = await fixture.env.DB.prepare(
      `SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE id = 'member-other'`,
    ).first<Member>()
    await expect(memberIntakeEnvelope(fixture.env, other!)).resolves.toMatchObject({ intake_state: 'pending' })
    await expect(memberIntakeEnvelope(fixture.env, member)).resolves.toMatchObject({ intake_state: 'complete' })
  })
})
