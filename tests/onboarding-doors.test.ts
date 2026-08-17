// tests/onboarding-doors.test.ts — self-service onboarding doors (migration 0107).
//
// Real D1/SQL via the sqlite-d1 harness with the full migration chain. The restore path
// and the same-batch receipt are SQL behaviour; a JS reimplementation would prove nothing
// about the statements that ship.
//
// Written against the failure modes Loom named in the door review, not against the happy
// path. The one that matters most is "revoking must RESTORE, never delete blind" — because
// capabilities upserts on conflict, so a self-grant can overwrite a legitimate grant, and
// an undo that deletes destroys real access.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  openDoor, getOpenDoor, selfGrant, closeDoor,
  listPendingReceipts, applyDisposition, crystallizeDoor, grantSignupDefault,
} from '../src/onboarding/doors'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const SUBJECT = 'member-newcomer'
const SQUAD = 'squad-alpha'

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // capabilities.member_id REFERENCES members(id) — seed the principals, or every write
  // dies on the foreign key and the test proves nothing about door logic.
  for (const id of [SUBJECT, 'member-owner', 'member-late']) {
    harness.sqlite
      .prepare("INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)")
      .run(id, `${id}@example.test`, id, TENANT)
  }
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    cap: (memberId: string, scopeId: string) =>
      harness.sqlite
        .prepare('SELECT capability, provisional_door_id FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id IS ?')
        .get(memberId, 'squad', scopeId) as { capability: string; provisional_door_id: string | null } | undefined,
    capCount: (memberId: string) =>
      (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ?').get(memberId) as { n: number }).n,
    orgCap: (memberId: string) =>
      harness.sqlite
        .prepare("SELECT capability, provisional_door_id FROM capabilities WHERE member_id = ? AND scope_type = 'org' AND scope_id IS NULL")
        .get(memberId) as { capability: string; provisional_door_id: string | null } | undefined,
    seedOrgCap: (memberId: string, capability: string) =>
      harness.sqlite
        .prepare("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'org', NULL, ?)")
        .run(`orgcap-${memberId}`, memberId, capability),
    setSignupCapability: (doorId: string, capability: string) =>
      harness.sqlite.prepare('UPDATE onboarding_doors SET signup_capability = ? WHERE id = ?').run(capability, doorId),
    seedCap: (memberId: string, scopeId: string, capability: string) =>
      harness.sqlite
        .prepare("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', ?, ?)")
        .run(`cap-${memberId}-${scopeId}`, memberId, scopeId, capability),
  }
}

async function open(db: ReturnType<typeof makeDb>, opts = {}) {
  const r = await openDoor(db.env, 'member-owner', opts)
  expect(r.ok).toBe(true)
  return r.ok ? r.value : (undefined as never)
}

describe('opening — one door per tenant', () => {
  it('a second open is refused while one is already open', async () => {
    const db = makeDb()
    await open(db)
    const second = await openDoor(db.env, 'member-owner')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('door_already_open')
    // Two generations would make "which door did this come through" ambiguous at review,
    // which is the one moment the answer has to be exact.
  })
})

describe('self-grant — access is immediate, and recorded in the same breath', () => {
  it('grants the capability AND writes a receipt carrying the prior value', async () => {
    const db = makeDb()
    const door = await open(db)

    const r = await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })
    expect(r.ok).toBe(true)

    // The newcomer can work immediately — this is the 403 that used to greet them.
    const cap = db.cap(SUBJECT, SQUAD)
    expect(cap?.capability).toBe('member')
    // …and it is marked PROVISIONAL, so nobody mistakes it for reviewed, earned access.
    expect(cap?.provisional_door_id).toBe(door.id)

    const pending = await listPendingReceipts(db.env, door.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      subject_member_id: SUBJECT, capability_before: null, capability_after: 'member',
    })
  })

  it('records the OVERWRITTEN prior capability, which is the whole restore key', async () => {
    const db = makeDb()
    const door = await open(db)
    db.seedCap(SUBJECT, SQUAD, 'observer') // a legitimate, pre-existing grant

    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'lead',
    })

    expect(db.cap(SUBJECT, SQUAD)?.capability).toBe('lead')
    const pending = await listPendingReceipts(db.env, door.id)
    // Without this value, undoing the door would have to delete the row — destroying the
    // observer grant that existed before anyone opened a door.
    expect(pending[0].capability_before).toBe('observer')
  })
})

describe('ceilings — self-service is bounded, by allowlist not by prefix', () => {
  it('refuses a capability above the door ceiling', async () => {
    const db = makeDb()
    await open(db, { maxCapability: 'member' })
    const r = await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'lead',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('above_door_ceiling')
  })

  it('refuses admin and owner outright — they are not in the allowlist at any ceiling', async () => {
    const db = makeDb()
    await open(db, { maxCapability: 'lead' })
    for (const capability of ['admin', 'owner'] as unknown as Array<'lead'>) {
      const r = await selfGrant(db.env, {
        actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
        scopeType: 'squad', scopeId: SQUAD, capability,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('capability_not_self_selectable')
    }
    // Self-granted admin can grant anything to anyone, so it is an authority multiplier
    // rather than fine-grained access. It is absent from the enum, not merely capped.
  })

  it('refuses department scope unless the door explicitly allows it', async () => {
    const db = makeDb()
    await open(db) // defaults to ['squad']
    const r = await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'department', scopeId: 'dept-1', capability: 'lead',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('scope_not_allowed')
    // A department grant covers every squad in it INCLUDING FUTURE ONES — an authority
    // generator. Opening that must be a conscious act by whoever opens the door.
  })

  it('allows department scope when the door was opened for it', async () => {
    const db = makeDb()
    await open(db, { allowedScopes: ['squad', 'department'] })
    const r = await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'department', scopeId: 'dept-1', capability: 'lead',
    })
    expect(r.ok).toBe(true)
  })
})

describe('closing — freezes new writes, does NOT yank working access', () => {
  it('after close, self-grant fails but existing provisional access still works', async () => {
    const db = makeDb()
    const door = await open(db)
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })

    const closed = await closeDoor(db.env, door.id, 'member-owner')
    expect(closed.ok).toBe(true)
    if (closed.ok) expect(closed.value.sealed).toBe(1)

    const after = await selfGrant(db.env, {
      actorMemberId: 'member-late', subjectMemberId: 'member-late',
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error).toBe('door_closed')

    // Closing must not be an outage: everyone onboarded through the door keeps working
    // until review rules. Close freezes and produces the review set; it does not revoke.
    expect(db.cap(SUBJECT, SQUAD)?.capability).toBe('member')
    expect(await getOpenDoor(db.env)).toBeNull()
  })
})

describe('crystallize — Athena approves, and the access stops being provisional', () => {
  it('an approved grant becomes an ordinary permanent capability', async () => {
    const db = makeDb()
    const door = await open(db)
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })
    await closeDoor(db.env, door.id, 'member-owner')

    const [receipt] = await listPendingReceipts(db.env, door.id)
    const applied = await applyDisposition(db.env, receipt.id, 'crystallized', 'agent:athena', 'reviewed, legitimate')
    expect(applied.ok).toBe(true)

    const cap = db.cap(SUBJECT, SQUAD)
    expect(cap?.capability).toBe('member')
    // "Crystal the access" is exactly this: the door marker clears and the grant is now
    // indistinguishable from one that was earned or invited.
    expect(cap?.provisional_door_id).toBeNull()

    const done = await crystallizeDoor(db.env, door.id, 'agent:athena')
    expect(done.ok).toBe(true)
  })

  it('a REVOKED grant restores the overwritten prior capability EXACTLY', async () => {
    const db = makeDb()
    const door = await open(db)
    db.seedCap(SUBJECT, SQUAD, 'observer')
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'lead',
    })
    await closeDoor(db.env, door.id, 'member-owner')

    const [receipt] = await listPendingReceipts(db.env, door.id)
    await applyDisposition(db.env, receipt.id, 'revoked', 'agent:athena', 'over-reach')

    const cap = db.cap(SUBJECT, SQUAD)
    // THE TEST LOOM ASKED FOR. A blind delete here would have destroyed a legitimate
    // observer grant that predated the door entirely.
    expect(cap?.capability).toBe('observer')
    expect(cap?.provisional_door_id).toBeNull()
  })

  it('a REVOKED grant with no prior capability removes the row entirely', async () => {
    const db = makeDb()
    const door = await open(db)
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'lead',
    })
    await closeDoor(db.env, door.id, 'member-owner')

    const [receipt] = await listPendingReceipts(db.env, door.id)
    await applyDisposition(db.env, receipt.id, 'revoked', 'agent:athena')

    // capability_before was NULL, so there is nothing to restore TO — the access must go.
    expect(db.cap(SUBJECT, SQUAD)).toBeUndefined()
    expect(db.capCount(SUBJECT)).toBe(0)
  })

  it('refuses to crystallize the door while any receipt is unreviewed', async () => {
    const db = makeDb()
    const door = await open(db)
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })
    await closeDoor(db.env, door.id, 'member-owner')

    const r = await crystallizeDoor(db.env, door.id, 'agent:athena')
    expect(r.ok).toBe(false)
    // Otherwise "crystallized" would come to mean "we stopped looking".
    if (!r.ok) expect(r.error).toBe('receipts_pending')
  })

  it('a receipt cannot be disposed twice', async () => {
    const db = makeDb()
    const door = await open(db)
    await selfGrant(db.env, {
      actorMemberId: SUBJECT, subjectMemberId: SUBJECT,
      scopeType: 'squad', scopeId: SQUAD, capability: 'member',
    })
    await closeDoor(db.env, door.id, 'member-owner')
    const [receipt] = await listPendingReceipts(db.env, door.id)

    await applyDisposition(db.env, receipt.id, 'crystallized', 'agent:athena')
    const again = await applyDisposition(db.env, receipt.id, 'revoked', 'agent:athena')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toBe('already_disposed')
  })
})

describe('signup default — the half of OAuth onboarding that was missing', () => {
  it('grants nothing when no door is open (today\'s behaviour, unchanged)', async () => {
    const db = makeDb()
    const r = await grantSignupDefault(db.env, SUBJECT)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.granted).toBe(false)
    expect(db.capCount(SUBJECT)).toBe(0)
  })

  it('grants nothing when a door is open but signup_capability is unset', async () => {
    const db = makeDb()
    await open(db) // signup_capability defaults to NULL
    const r = await grantSignupDefault(db.env, SUBJECT)
    if (r.ok) expect(r.value.granted).toBe(false)
    // Merging this migration must not open a pot by itself. Opening is an explicit act.
    expect(db.capCount(SUBJECT)).toBe(0)
  })

  it('grants the owner-configured capability, with a receipt, when configured', async () => {
    const db = makeDb()
    const door = await open(db)
    db.setSignupCapability(door.id, 'member')

    const r = await grantSignupDefault(db.env, SUBJECT)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.granted).toBe(true)
      expect(r.value.capability).toBe('member')
    }
    // THIS is the 403 disappearing: the new user now holds real, usable access.
    expect(db.orgCap(SUBJECT)?.capability).toBe('member')
    expect(db.orgCap(SUBJECT)?.provisional_door_id).toBe(door.id)

    const pending = await listPendingReceipts(db.env, door.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ scope_type: 'org', capability_after: 'member' })
  })

  it('never overwrites access the member already has', async () => {
    const db = makeDb()
    const door = await open(db)
    db.setSignupCapability(door.id, 'observer')
    db.seedOrgCap(SUBJECT, 'lead') // earned earlier, by some other path

    const r = await grantSignupDefault(db.env, SUBJECT)
    if (r.ok) expect(r.value.granted).toBe(false)
    // A returning user must not be knocked back to the signup default by logging in again.
    expect(db.orgCap(SUBJECT)?.capability).toBe('lead')
  })

  it('a signup grant reverses through the same review path as any other receipt', async () => {
    const db = makeDb()
    const door = await open(db)
    db.setSignupCapability(door.id, 'member')
    await grantSignupDefault(db.env, SUBJECT)
    await closeDoor(db.env, door.id, 'member-owner')

    const [receipt] = await listPendingReceipts(db.env, door.id)
    await applyDisposition(db.env, receipt.id, 'revoked', 'agent:athena', 'not needed')

    // capability_before was NULL, so revoking removes it entirely — baseline restored.
    expect(db.orgCap(SUBJECT)).toBeUndefined()
  })
})
