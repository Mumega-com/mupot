// tests/squad-seed.test.ts — S196 Slice A: squad-as-members seed + capability verification.
//
// Tests:
//   1. After seedSquadMembers(), resolveCapabilities(memberId) returns the expected
//      ladder rank for each agent (per §2A community map).
//   2. Idempotency: re-running the seed does not fail or duplicate rows.
//   3. Squad-scope grants: squad agents are granted at squad scope; hasCapability
//      at org scope is false for them (no upward bubble).
//   4. squadId is REQUIRED (fail-closed) — there is NO org-scope fallback, which
//      would escalate kasra to org-admin.
//   5. Agent↔agent messages round-trip + request/ack correlation (Slice D proof
//      that the existing service works for our agents).

import { afterEach, describe, it, expect } from 'vitest'
import { seedSquadMembers, deterministicMemberId, buildSquadDefs } from '../src/members/squad-seed'
import { resolveCapabilities, hasCapability, type SquadScope } from '../src/auth/capability'
import { sendAgentMessage, readAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// G-FP1b point 1: hasCapability's 'squad' overload requires a real SquadScope,
// not a bare id. Every check below is an EXACT squad-scope match (the seeded
// grant's own scope_id), which hasCapability resolves via `scope.id` alone —
// department_id/kind are irrelevant to that branch, so a minimal work-kind
// scope is sufficient here (none of these tests exercise inheritance or a
// home squad).
function squadScope(id: string): SquadScope {
  return { id, department_id: '', kind: 'work' }
}

// sendAgentMessage's authz param is a compile-time forcing function only (#401 WARN
// follow-up) — this file exercises the raw primitive directly, not through sendToRef's
// confinement.
const TEST_AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

// Canonical test squad id (all seed calls require a squadId — no org fallback).
const SQUAD_ID = 'sq-test-0001-0001-0001-000000000001'
const fixtures: SqliteD1Harness[] = []

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.close()
})

// ── migrated SQLite fixture ───────────────────────────────────────────────────

interface MemberRow {
  id: string
  email: string
  display_name: string
  status: string
  created_at: string
}

interface CapabilityRow {
  id: string
  member_id: string
  scope_type: string
  scope_id: string | null
  capability: string
  created_at: string
}

interface SquadSeedFixture {
  harness: SqliteD1Harness
  env: Env
  memberCount(): number
  capabilityCount(): number
  members(): MemberRow[]
  capabilities(): CapabilityRow[]
}

/** Production-schema fixture with query-backed views for the assertions below. */
function makeFixture(squadId = SQUAD_ID, squadKind: 'work' | 'home' = 'work'): SquadSeedFixture {
  const harness = createSqliteD1()
  fixtures.push(harness)
  applyAllMigrations(harness.sqlite)
  harness.sqlite.prepare(
    `INSERT INTO departments (id, slug, name, kind) VALUES (?, ?, ?, 'work')`,
  ).run('dept-squad-seed', 'squad-seed', 'Squad seed test')
  harness.sqlite.prepare(
    `INSERT INTO squads (id, department_id, slug, name, kind) VALUES (?, 'dept-squad-seed', ?, ?, ?)`,
  ).run(squadId, `squad-${squadId}`, 'Squad seed test', squadKind)

  return {
    harness,
    env: { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env,
    memberCount: () => Number(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get()?.n ?? 0),
    capabilityCount: () => Number(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM capabilities').get()?.n ?? 0),
    members: () => harness.sqlite.prepare(
      'SELECT id, email, display_name, status, created_at FROM members ORDER BY id',
    ).all() as unknown as MemberRow[],
    capabilities: () => harness.sqlite.prepare(
      'SELECT id, member_id, scope_type, scope_id, capability, created_at FROM capabilities ORDER BY id',
    ).all() as unknown as CapabilityRow[],
  }
}

// ── Slice A: seed + capability verification ───────────────────────────────────

describe('seedSquadMembers — Slice A', () => {
  it('creates all 6 member rows on first seed', async () => {
    const fixture = makeFixture()
    const { env } = fixture
    const result = await seedSquadMembers(env, SQUAD_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.seeded.length).toBe(6)
    expect(fixture.memberCount()).toBe(6)
    const slugs = result.seeded.map((s) => s.slug).sort()
    expect(slugs).toEqual(['codex', 'hadi', 'kasra', 'loom', 'mumega-brain', 'river'])
  })

  it('all 6 members get exactly 1 capability grant each', async () => {
    const fixture = makeFixture()
    const { env } = fixture
    await seedSquadMembers(env, SQUAD_ID)
    expect(fixture.capabilityCount()).toBe(6)
  })

  it('resolveCapabilities → hadi has owner at org scope', async () => {
    const { env } = makeFixture()
    await seedSquadMembers(env, SQUAD_ID)
    const hadiId = await deterministicMemberId('hadi')
    const grants = await resolveCapabilities(env, hadiId)
    expect(grants.length).toBeGreaterThan(0)
    expect(hasCapability(grants, 'org', null, 'owner')).toBe(true)
    // org owner covers everything
    expect(hasCapability(grants, 'org', null, 'lead')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'member')).toBe(true)
    expect(hasCapability(grants, 'org', null, 'observer')).toBe(true)
  })

  it('resolveCapabilities → kasra has admin @ squad (bounded — NOT org-admin)', async () => {
    const { env } = makeFixture()
    await seedSquadMembers(env, SQUAD_ID)
    const kasraId = await deterministicMemberId('kasra')
    const grants = await resolveCapabilities(env, kasraId)
    // admin covers lead/member on the squad scope…
    expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'admin')).toBe(true)
    expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'lead')).toBe(true)
    expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'member')).toBe(true)
    // …but is BOUNDED: squad-admin does NOT satisfy an org-scope admin check.
    expect(hasCapability(grants, 'org', null, 'admin')).toBe(false)
    expect(hasCapability(grants, 'org', null, 'owner')).toBe(false)
  })

  it('resolveCapabilities → loom/river have lead @ squad, NOT admin', async () => {
    const { env } = makeFixture()
    await seedSquadMembers(env, SQUAD_ID)
    for (const slug of ['loom', 'river']) {
      const id = await deterministicMemberId(slug)
      const grants = await resolveCapabilities(env, id)
      expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'lead')).toBe(true)
      expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'member')).toBe(true)
      expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'admin')).toBe(false) // not admin
      expect(hasCapability(grants, 'org', null, 'lead')).toBe(false) // no org bubble
    }
  })

  it('resolveCapabilities → codex/mumega-brain have member @ squad, NOT lead', async () => {
    const { env } = makeFixture()
    await seedSquadMembers(env, SQUAD_ID)
    for (const slug of ['codex', 'mumega-brain']) {
      const id = await deterministicMemberId(slug)
      const grants = await resolveCapabilities(env, id)
      expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'member')).toBe(true)
      expect(hasCapability(grants, 'squad', squadScope(SQUAD_ID), 'lead')).toBe(false) // not lead
      expect(hasCapability(grants, 'org', null, 'member')).toBe(false) // no org bubble
    }
  })

  it('resolveCapabilities → squad-scope grants do NOT bubble to org (with squadId)', async () => {
    const { env } = makeFixture()
    const squadId = 'sq-test-0001-0001-0001-000000000001'
    await seedSquadMembers(env, squadId)
    // kasra=admin@squad, codex=member@squad — each satisfies its squad check,
    // and NONE satisfy the org check (no upward bubble).
    const kasraGrants = await resolveCapabilities(env, await deterministicMemberId('kasra'))
    expect(hasCapability(kasraGrants, 'squad', squadScope(squadId), 'admin')).toBe(true)
    expect(hasCapability(kasraGrants, 'org', null, 'admin')).toBe(false)
    for (const slug of ['codex', 'mumega-brain']) {
      const grants = await resolveCapabilities(env, await deterministicMemberId(slug))
      expect(hasCapability(grants, 'squad', squadScope(squadId), 'member')).toBe(true)
      expect(hasCapability(grants, 'org', null, 'member')).toBe(false)
    }
  })

  it('idempotency: re-seeding returns ok with 0 inserts (no duplicates)', async () => {
    const fixture = makeFixture()
    const { env } = fixture
    const r1 = await seedSquadMembers(env, SQUAD_ID)
    const r2 = await seedSquadMembers(env, SQUAD_ID)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    // On re-seed: no new rows
    for (const s of r2.seeded) {
      expect(s.inserted).toBe(false)
      expect(s.grantInserted).toBe(false)
    }
    // DB still has exactly 6 members + 6 grants (no duplicates)
    expect(fixture.memberCount()).toBe(6)
    expect(fixture.capabilityCount()).toBe(6)
  })

  it('deterministicMemberId is stable across calls', async () => {
    const id1 = await deterministicMemberId('kasra')
    const id2 = await deterministicMemberId('kasra')
    expect(id1).toBe(id2)
    // Different slugs produce different ids
    const id3 = await deterministicMemberId('loom')
    expect(id1).not.toBe(id3)
  })

  it('buildSquadDefs returns 6 defs with the confirmed cap map; squad scope sets scope_id', () => {
    const squadId = 'test-squad-id'
    const defs = buildSquadDefs(squadId)
    expect(defs.length).toBe(6)
    expect(defs.map((d) => d.slug).sort()).toEqual(
      ['codex', 'hadi', 'kasra', 'loom', 'mumega-brain', 'river'],
    )
    // Confirmed capability map.
    const cap = (slug: string) => defs.find((d) => d.slug === slug)!.capability
    expect(cap('hadi')).toBe('owner')
    expect(cap('kasra')).toBe('admin')
    expect(cap('loom')).toBe('lead')
    expect(cap('river')).toBe('lead')
    expect(cap('codex')).toBe('member')
    expect(cap('mumega-brain')).toBe('member')
    // hadi ALWAYS org scope; agents get squad scope when squadId provided.
    const hadi = defs.find((d) => d.slug === 'hadi')!
    expect(hadi.scope_type).toBe('org')
    expect(hadi.scope_id).toBeNull()
    const kasra = defs.find((d) => d.slug === 'kasra')!
    expect(kasra.scope_type).toBe('squad')
    expect(kasra.scope_id).toBe(squadId)
    // ALL non-hadi agents are squad-scoped — NO org-scope fallback (would escalate
    // kasra to org-admin). Only hadi is org-scoped.
    const nonHadi = defs.filter((d) => d.slug !== 'hadi')
    for (const d of nonHadi) {
      expect(d.scope_type).toBe('squad')
      expect(d.scope_id).toBe(squadId)
    }
  })

  it('seedSquadMembers fails closed without a squadId (no org-scope fallback)', async () => {
    const fixture = makeFixture()
    const { env } = fixture
    // Empty squadId exercises the runtime fail-closed guard.
    const result = await seedSquadMembers(env, '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('squad_required')
    // Nothing written.
    expect(fixture.memberCount()).toBe(0)
    expect(fixture.capabilityCount()).toBe(0)
  })

  // Athena's §2e-9 sharpening (Round 2 on #1472): squad-seed.ts is dev/
  // fixture-only today (its only callers are scripts/seed-squad.ts, a
  // documentation/dry-run reference never invoked automatically, and this
  // test file — see the guard's own doc comment in src/members/squad-seed.ts)
  // but it writes squad-scope `capabilities` rows the same way every other
  // writer in this PR does, so it gets the same table-exhaustive refusal:
  // never grant squad-scope capability into a home squad, reachable or not.
  it('refuses a home-kind squad: home_scope_not_grantable, zero rows written', async () => {
    const homeSquadId = 'sq-home-0001-0001-0001-000000000001'
    const fixture = makeFixture(homeSquadId, 'home')
    const { env } = fixture
    const result = await seedSquadMembers(env, homeSquadId)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('home_scope_not_grantable')
    expect(fixture.memberCount()).toBe(0)
    expect(fixture.capabilityCount()).toBe(0)
  })
})

// ── Slice D: agent↔agent inbox round-trip (proves Slice D works for our agents) ─

/**
 * Real agent_messages schema for the round-trip test.
 */
describe('agent↔agent inbox round-trip (Slice D proof — S196)', () => {
  it('kasra sends to loom → loom reads inbox → message delivered', async () => {
    const { env } = makeFixture()

    const kasraId = await deterministicMemberId('kasra')
    const loomId = await deterministicMemberId('loom')

    // Kasra sends a message to Loom.
    const send = await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-loom',
      body: 'S196 A+B shipped. Diff attached.',
    }, TEST_AUTHZ)
    expect(send.ok).toBe(true)

    // Loom reads its inbox.
    const inbox = await readAgentInbox(env, { agent: 'ag-loom' })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.messages.length).toBe(1)
    expect(inbox.messages[0].body).toBe('S196 A+B shipped. Diff attached.')
    expect(inbox.messages[0].from_agent).toBe('ag-kasra')
    expect(inbox.messages[0].from_member).toBe(kasraId)
    expect(inbox.remaining).toBe(0)
  })

  it('request/ack correlation: kasra sends [request_id:...] → loom ACKs with in_reply_to', async () => {
    const { env } = makeFixture()

    const kasraId = await deterministicMemberId('kasra')
    const loomId = await deterministicMemberId('loom')
    const requestId = 's196-gate-abc123'

    // Kasra sends a request (kind=request, requestId set).
    const req = await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-loom',
      body: '[request_id:s196-gate-abc123] Gate S196 Slice A — is RBAC correct?',
      kind: 'request',
      requestId,
    }, TEST_AUTHZ)
    expect(req.ok).toBe(true)

    // Loom reads and ACKs.
    const inbox = await readAgentInbox(env, { agent: 'ag-loom', peek: true })
    if (!inbox.ok) return
    expect(inbox.messages[0].kind).toBe('request')
    expect(inbox.messages[0].request_id).toBe(requestId)

    // Loom sends ACK back with in_reply_to.
    const ack = await sendAgentMessage(env, {
      fromAgent: 'ag-loom',
      fromMember: loomId,
      toAgent: 'ag-kasra',
      body: `{ack_for:${requestId}, ok: true} RBAC looks correct per §2A. GREEN.`,
      kind: 'ack',
      inReplyTo: requestId,
    }, TEST_AUTHZ)
    expect(ack.ok).toBe(true)

    // Kasra reads its ACK inbox.
    const kasraInbox = await readAgentInbox(env, { agent: 'ag-kasra' })
    if (!kasraInbox.ok) return
    expect(kasraInbox.messages.length).toBe(1)
    expect(kasraInbox.messages[0].kind).toBe('ack')
    expect(kasraInbox.messages[0].in_reply_to).toBe(requestId)
    expect(kasraInbox.messages[0].from_agent).toBe('ag-loom')
  })

  it('consume-once: inbox consumed on read; second read returns empty', async () => {
    const { env } = makeFixture()
    const kasraId = await deterministicMemberId('kasra')

    await sendAgentMessage(env, {
      fromAgent: 'ag-kasra',
      fromMember: kasraId,
      toAgent: 'ag-river',
      body: 'Design review needed.',
    }, TEST_AUTHZ)

    const first = await readAgentInbox(env, { agent: 'ag-river' })
    if (!first.ok) return
    expect(first.messages.length).toBe(1)

    // Second read → empty (consumed-once)
    const second = await readAgentInbox(env, { agent: 'ag-river' })
    if (!second.ok) return
    expect(second.messages.length).toBe(0)
  })

  it('inbox isolation: each agent only sees its own messages', async () => {
    const { env } = makeFixture()
    const kasraId = await deterministicMemberId('kasra')

    await sendAgentMessage(env, { fromAgent: 'ag-kasra', fromMember: kasraId, toAgent: 'ag-loom', body: 'for loom' }, TEST_AUTHZ)
    await sendAgentMessage(env, { fromAgent: 'ag-kasra', fromMember: kasraId, toAgent: 'ag-river', body: 'for river' }, TEST_AUTHZ)

    const loom = await readAgentInbox(env, { agent: 'ag-loom' })
    if (!loom.ok) return
    expect(loom.messages.map((m) => m.body)).toEqual(['for loom'])
    // River's inbox untouched by Loom's read
    const river = await readAgentInbox(env, { agent: 'ag-river' })
    if (!river.ok) return
    expect(river.messages.map((m) => m.body)).toEqual(['for river'])
  })
})

// ── BLOCK-1 regression: pre-existing member with different UUID ───────────────
//
// BUG: seedSquadMembers used the synthetic deterministic UUID for both the member
// INSERT and the capability INSERT. If hadi was already in the DB (onboarded earlier
// with a different UUID), the member INSERT no-ops but the capability INSERT would
// use the synthetic UUID → orphan row (member_id with no matching members.id).
// FIX: after a no-op INSERT, look up the real existing id by email, bind that to
// the capability INSERT.

describe('BLOCK-1 regression — pre-existing member with different UUID', () => {
  it('seed with pre-existing hadi (different UUID) attaches capability to real id', async () => {
    const fixture = makeFixture()
    const { env } = fixture

    const REAL_HADI_ID = 'real-hadi-uuid-pre-existing-0001'

    // Pre-seed the DB: hadi already exists with a REAL id (not the synthetic one).
    fixture.harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, created_at, tenant)
       VALUES (?, 'hadi@mumega.com', 'Hadi Servat (pre-existing)', 'active', '2026-01-01T00:00:00.000Z', 'mumega')`,
    ).run(REAL_HADI_ID)

    // Now run the squad seed.
    const result = await seedSquadMembers(env, SQUAD_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Find hadi's seeded result.
    const hadiEntry = result.seeded.find((s) => s.slug === 'hadi')
    expect(hadiEntry).toBeDefined()
    if (!hadiEntry) return

    // BLOCK-1 assertion: capability must be bound to the REAL pre-existing id.
    expect(hadiEntry.memberId).toBe(REAL_HADI_ID)
    // Member was not re-inserted (INSERT OR IGNORE was a no-op).
    expect(hadiEntry.inserted).toBe(false)
    // Grant was inserted (new capability row with the correct real id).
    expect(hadiEntry.grantInserted).toBe(true)

    // Critical: no orphan capability row (all capability member_ids must exist in members).
    for (const cap of fixture.capabilities()) {
      const memberExists = fixture.members().some((m) => m.id === cap.member_id)
      expect(memberExists).toBe(true)
    }

    // The capability for hadi references REAL_HADI_ID, not any synthetic UUID.
    const hadiCap = fixture.capabilities().find((c) => c.member_id === REAL_HADI_ID)
    expect(hadiCap).toBeDefined()
    expect(hadiCap?.capability).toBe('owner')
    expect(hadiCap?.scope_type).toBe('org')
  })

  it('re-seed with pre-existing hadi is fully idempotent (0 inserts on second run)', async () => {
    const fixture = makeFixture()
    const { env } = fixture

    const REAL_HADI_ID = 'real-hadi-uuid-pre-existing-0001'
    fixture.harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, created_at, tenant)
       VALUES (?, 'hadi@mumega.com', 'Hadi Servat', 'active', '2026-01-01T00:00:00.000Z', 'mumega')`,
    ).run(REAL_HADI_ID)

    // First seed: inserts 5 new members + 1 capability on real id + 5 synthetic caps.
    await seedSquadMembers(env, SQUAD_ID)
    const capCountAfterFirst = fixture.capabilityCount()

    // Second seed: all INSERT OR IGNORE no-ops.
    const second = await seedSquadMembers(env, SQUAD_ID)
    expect(second.ok).toBe(true)
    if (!second.ok) return

    // No new rows on second run.
    expect(fixture.capabilityCount()).toBe(capCountAfterFirst)
    for (const entry of second.seeded) {
      expect(entry.inserted).toBe(false)
      expect(entry.grantInserted).toBe(false)
    }
  })
})
