// tests/discord-cap-sync.test.ts — S196 Slice B: Discord capability↔role sync.
//
// Covers §4 adversarial surfaces (S196 brief):
//   (a) spoofed/forged Discord sender must NOT bind to another member
//   (b) squad-scoped grant must NOT reach org scope (no escalation)
//   (c) projection is one-way (Discord role change never mutates capabilities)
//   (d) fail-closed: under-scoped user refused regardless of Discord role
//
// All Discord API calls are MOCKED. No real HTTP to discord.com.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveDiscordInboundMember,
  checkInboundDiscordCap,
  projectMemberCapabilitiesToDiscord,
  capToRoleKey,
  CAP_TO_DISCORD_ROLE,
  MANAGED_DISCORD_ROLES,
} from '../src/channels/discord-cap-sync'
import type { Env, CapabilityGrant } from '../src/types'

// ── minimal faithful in-memory D1 ─────────────────────────────────────────────

interface MemberRow {
  id: string
  email: string
  display_name: string
  status: string
}

interface IdentityRow {
  id: string
  member_id: string
  platform: string
  external_user_id: string
}

interface CapabilityRow {
  id: string
  member_id: string
  scope_type: string
  scope_id: string | null
  capability: string
}

function makeDb(opts: {
  members?: MemberRow[]
  identities?: IdentityRow[]
  capabilities?: CapabilityRow[]
}) {
  const members: MemberRow[] = opts.members ?? []
  const identities: IdentityRow[] = opts.identities ?? []
  const capabilities: CapabilityRow[] = opts.capabilities ?? []

  function prepare(sql: string) {
    const binds: unknown[] = []
    const api = {
      bind(...args: unknown[]) {
        binds.push(...args)
        return api
      },
      async first<T>(): Promise<T | null> {
        const s = sql.trim()

        // resolveDiscordInboundMember: SELECT m.id AS member_id, m.status FROM member_identities JOIN members
        if (/FROM member_identities mi/.test(s) && /platform = 'discord'/.test(s) && /external_user_id = \?1/.test(s)) {
          const [externalUserId] = binds as [string]
          const identity = identities.find(
            (i) => i.platform === 'discord' && i.external_user_id === externalUserId,
          )
          if (!identity) return null
          const member = members.find((m) => m.id === identity.member_id)
          if (!member) return null
          return { member_id: member.id, status: member.status } as unknown as T
        }

        // projectMemberCapabilitiesToDiscord: SELECT mi.external_user_id, m.status FROM member_identities WHERE member_id=?1
        if (
          /FROM member_identities mi/.test(s) &&
          /mi\.member_id = \?1/.test(s) &&
          /platform = 'discord'/.test(s)
        ) {
          const [memberId] = binds as [string]
          const identity = identities.find(
            (i) => i.platform === 'discord' && i.member_id === memberId,
          )
          if (!identity) return null
          const member = members.find((m) => m.id === identity.member_id)
          if (!member) return null
          return { external_user_id: identity.external_user_id, status: member.status } as unknown as T
        }

        throw new Error(`discord-cap-sync makeDb: unhandled first sql:\n${s}`)
      },
      async all<T>(): Promise<{ results: T[] }> {
        const s = sql.trim()

        // resolveCapabilities: SELECT member_id, scope_type, scope_id, capability FROM capabilities UNION channel_capability_grants
        if (/SELECT member_id, scope_type, scope_id, capability/.test(s)) {
          const [memberId] = binds as [string]
          const rows = capabilities
            .filter((c) => c.member_id === memberId)
            .map((c) => ({
              member_id: c.member_id,
              scope_type: c.scope_type,
              scope_id: c.scope_id,
              capability: c.capability,
            }))
          return { results: rows as unknown as T[] }
        }

        throw new Error(`discord-cap-sync makeDb: unhandled all sql:\n${s}`)
      },
      async run() {
        throw new Error('discord-cap-sync makeDb: unexpected run() call')
      },
    }
    return api
  }

  return { prepare, _members: members, _identities: identities, _capabilities: capabilities }
}

function makeEnv(db: ReturnType<typeof makeDb>): Env {
  return { DB: db } as unknown as Env
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const ALICE_MEMBER_ID = 'alice-member-0001'
const BOB_MEMBER_ID = 'bob-member-0001'
const ALICE_DISCORD_ID = 'discord-user-alice-123'
const BOB_DISCORD_ID = 'discord-user-bob-456'
const SQUAD_ID = 'squad-0001'
const GUILD_ID = 'guild-mumega-001'

const ROLE_MAP = {
  '@owner': 'role-id-owner',
  '@lead': 'role-id-lead',
  '@squad': 'role-id-squad',
  '@member': 'role-id-member',
  '@public': 'role-id-public',
}

function aliceMember(cap: string, scopeType: string, scopeId: string | null = null) {
  return {
    members: [{ id: ALICE_MEMBER_ID, email: 'alice@test.com', display_name: 'Alice', status: 'active' }],
    identities: [{ id: 'id-alice', member_id: ALICE_MEMBER_ID, platform: 'discord', external_user_id: ALICE_DISCORD_ID }],
    capabilities: [{ id: 'cap-alice', member_id: ALICE_MEMBER_ID, scope_type: scopeType, scope_id: scopeId, capability: cap }],
  }
}

// ── §4(a) — spoofed sender must NOT bind to another member ────────────────────

describe('§4(a) — inbound identity: spoofed Discord sender is refused', () => {
  it('an unknown Discord user id returns null (no binding forged)', async () => {
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    // A spoofed/unknown Discord user id that has no member_identities row.
    const result = await resolveDiscordInboundMember(env, 'discord-user-unknown-spoofer')
    expect(result).toBeNull()
  })

  it('the binding is by member_identities — a message claiming to be from Alice using Bob\'s token is refused', async () => {
    // Bob has a member_identities row; Alice does not for this test.
    // If someone sends a Discord message as ALICE_DISCORD_ID but that id is not in member_identities → null.
    const db = makeDb({
      members: [
        { id: ALICE_MEMBER_ID, email: 'alice@test.com', display_name: 'Alice', status: 'active' },
        { id: BOB_MEMBER_ID, email: 'bob@test.com', display_name: 'Bob', status: 'active' },
      ],
      identities: [
        // Only Bob is bound; Alice has no Discord identity.
        { id: 'id-bob', member_id: BOB_MEMBER_ID, platform: 'discord', external_user_id: BOB_DISCORD_ID },
      ],
      capabilities: [
        { id: 'cap-bob', member_id: BOB_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'member' },
      ],
    })
    const env = makeEnv(db)

    // Alice's Discord id has no binding — cannot forge Bob's member.
    const aliceResult = await resolveDiscordInboundMember(env, ALICE_DISCORD_ID)
    expect(aliceResult).toBeNull()

    // Bob's Discord id correctly resolves to Bob only.
    const bobResult = await resolveDiscordInboundMember(env, BOB_DISCORD_ID)
    expect(bobResult).not.toBeNull()
    expect(bobResult?.memberId).toBe(BOB_MEMBER_ID)
    // And NOT to Alice (the mapping is exact).
    expect(bobResult?.memberId).not.toBe(ALICE_MEMBER_ID)
  })

  it('checkInboundDiscordCap: unbound Discord user is refused with reason=unbound', async () => {
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    // A Discord user id with no member_identities row.
    const result = await checkInboundDiscordCap(env, 'unknown-discord-user', 'org', null, 'observer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unbound')
  })

  it('checkInboundDiscordCap: suspended member is refused even if bound', async () => {
    const db = makeDb({
      members: [{ id: ALICE_MEMBER_ID, email: 'a@t.com', display_name: 'Alice', status: 'suspended' }],
      identities: [{ id: 'id-a', member_id: ALICE_MEMBER_ID, platform: 'discord', external_user_id: ALICE_DISCORD_ID }],
      capabilities: [{ id: 'cap-a', member_id: ALICE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'member' }],
    })
    const env = makeEnv(db)

    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'observer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('suspended')
  })
})

// ── §4(b) — squad-scoped grant must NOT reach org scope ──────────────────────

describe('§4(b) — no scope escalation: squad grant cannot satisfy org-scope check', () => {
  it('hasCapability: squad-scope member grant does NOT satisfy org-scope check', async () => {
    const db = makeDb(aliceMember('member', 'squad', SQUAD_ID))
    const env = makeEnv(db)

    // Alice has member at squad scope only.
    const { resolveCapabilities, hasCapability } = await import('../src/auth/capability')
    const grants = await resolveCapabilities(env, ALICE_MEMBER_ID)

    // Squad-scope check passes.
    expect(hasCapability(grants, 'squad', SQUAD_ID, 'member')).toBe(true)

    // Org-scope check FAILS — grants do NOT bubble up.
    expect(hasCapability(grants, 'org', null, 'member')).toBe(false)
    expect(hasCapability(grants, 'org', null, 'observer')).toBe(false)
  })

  it('checkInboundDiscordCap: squad-scoped member refused for org-scope action', async () => {
    const db = makeDb(aliceMember('member', 'squad', SQUAD_ID))
    const env = makeEnv(db)

    // Alice has squad-scope member; check is for org-scope member action.
    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'member')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('insufficient')
  })

  it('checkInboundDiscordCap: squad-scoped member CAN satisfy squad-scope check', async () => {
    const db = makeDb(aliceMember('member', 'squad', SQUAD_ID))
    const env = makeEnv(db)

    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'squad', SQUAD_ID, 'member')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memberId).toBe(ALICE_MEMBER_ID)
  })

  it('capToRoleKey: squad-scoped member maps to @squad (not @member)', () => {
    const squadGrants: CapabilityGrant[] = [
      { member_id: ALICE_MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ]
    const orgGrants: CapabilityGrant[] = [
      { member_id: ALICE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'member' },
    ]
    // Squad-scoped member → @squad (internal)
    expect(capToRoleKey(squadGrants)).toBe('@squad')
    // Org-scoped member → @member (community)
    expect(capToRoleKey(orgGrants)).toBe('@member')
  })
})

// ── §4(c) — projection is one-way ────────────────────────────────────────────

describe('§4(c) — projection is one-way: Discord role change cannot mutate capabilities', () => {
  it('projectMemberCapabilitiesToDiscord NEVER writes to capabilities table', async () => {
    // Mock Discord GET: return @member role for Alice even though her mupot cap was revoked.
    // The sync should REMOVE the Discord role — NOT restore the mupot capability.
    const db = makeDb({
      members: [{ id: ALICE_MEMBER_ID, email: 'a@t.com', display_name: 'Alice', status: 'active' }],
      identities: [{ id: 'id-a', member_id: ALICE_MEMBER_ID, platform: 'discord', external_user_id: ALICE_DISCORD_ID }],
      capabilities: [], // Alice's mupot grant was REVOKED — no capability rows.
    })
    const env = makeEnv(db)

    // Track role mutations via injectable fns — no real HTTP, no DISCORD_BOT_TOKEN needed.
    const removedRoles: string[] = []
    const addedRoles: string[] = []

    // Discord GET returns Alice with @member role (the stale Discord state).
    const discordGetFn = async (_path: string) => ({ roles: [ROLE_MAP['@member']] })
    const addRoleFn = async (_g: string, _u: string, roleId: string) => { addedRoles.push(roleId) }
    const removeRoleFn = async (_g: string, _u: string, roleId: string) => { removedRoles.push(roleId) }

    const result = await projectMemberCapabilitiesToDiscord(
      env, ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      { discordGetFn, addRoleFn, removeRoleFn },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The sync should REMOVE @member (no mupot grant → no Discord role).
    expect(result.targetRole).toBeNull()
    expect(result.removed).toContain('@member')
    expect(result.added).toHaveLength(0)
    expect(removedRoles).toContain(ROLE_MAP['@member'])
    expect(addedRoles).toHaveLength(0)

    // CRITICAL: capabilities table was NOT mutated. The sync only touched Discord.
    expect(db._capabilities.length).toBe(0)
  })

  it('Discord role escalation by a guild admin does NOT widen mupot capabilities', async () => {
    // Alice only has observer in mupot. A rogue Discord admin gave her @owner.
    // The sync should demote her Discord role back to @public.
    const db = makeDb(aliceMember('observer', 'org'))
    const env = makeEnv(db)

    const removedRoles: string[] = []
    const addedRoles: string[] = []

    // Discord currently shows @owner (rogue admin escalation).
    const discordGetFn = async (_path: string) => ({ roles: [ROLE_MAP['@owner']] })
    const addRoleFn = async (_g: string, _u: string, roleId: string) => { addedRoles.push(roleId) }
    const removeRoleFn = async (_g: string, _u: string, roleId: string) => { removedRoles.push(roleId) }

    const result = await projectMemberCapabilitiesToDiscord(
      env, ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      { discordGetFn, addRoleFn, removeRoleFn },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Sync demotes: removes @owner, adds @public.
    expect(result.removed).toContain('@owner')
    expect(result.added).toContain('@public')
    expect(removedRoles).toContain(ROLE_MAP['@owner'])
    expect(addedRoles).toContain(ROLE_MAP['@public'])

    // Alice's mupot capability remains observer — UNCHANGED.
    expect(db._capabilities.find((c) => c.member_id === ALICE_MEMBER_ID)?.capability).toBe('observer')
  })

  it('checkInboundDiscordCap uses mupot grants (D1), NOT Discord roles', async () => {
    // Alice has @lead Discord role but her mupot grant was revoked.
    // The inbound check must look at D1 capabilities only.
    const db = makeDb({
      members: [{ id: ALICE_MEMBER_ID, email: 'a@t.com', display_name: 'Alice', status: 'active' }],
      identities: [{ id: 'id-a', member_id: ALICE_MEMBER_ID, platform: 'discord', external_user_id: ALICE_DISCORD_ID }],
      capabilities: [], // revoked
    })
    const env = makeEnv(db)

    // Even if Alice has the @lead Discord role, the check must fail (no mupot grant).
    // checkInboundDiscordCap does NOT read Discord roles — it reads D1 capabilities only.
    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'observer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // insufficient (not unbound: Alice IS bound, but has no capability)
    expect(result.reason).toBe('insufficient')
  })
})

// ── §4(d) — fail-closed: under-scoped user refused regardless of Discord role ─

describe('§4(d) — fail-closed: under-scoped user refused regardless of Discord role', () => {
  it('observer member cannot satisfy member-level action', async () => {
    const db = makeDb(aliceMember('observer', 'org'))
    const env = makeEnv(db)

    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'member')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('insufficient')
  })

  it('member cannot satisfy lead-level action', async () => {
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    const result = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'lead')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('insufficient')
  })

  it('lead member satisfies lead-level and below', async () => {
    const db = makeDb(aliceMember('lead', 'org'))
    const env = makeEnv(db)

    const leadResult = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'lead')
    expect(leadResult.ok).toBe(true)

    const memberResult = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'member')
    expect(memberResult.ok).toBe(true)

    const ownerResult = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, 'owner')
    expect(ownerResult.ok).toBe(false)
  })

  it('no grants → ALL actions refused (fail-closed, no capability = no access)', async () => {
    const db = makeDb({
      members: [{ id: ALICE_MEMBER_ID, email: 'a@t.com', display_name: 'Alice', status: 'active' }],
      identities: [{ id: 'id-a', member_id: ALICE_MEMBER_ID, platform: 'discord', external_user_id: ALICE_DISCORD_ID }],
      capabilities: [],
    })
    const env = makeEnv(db)

    for (const cap of ['observer', 'member', 'lead', 'owner'] as const) {
      const r = await checkInboundDiscordCap(env, ALICE_DISCORD_ID, 'org', null, cap)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('insufficient')
    }
  })
})

// ── capToRoleKey unit tests ───────────────────────────────────────────────────

describe('capToRoleKey — §2A capability→role mapping', () => {
  function grant(cap: string, scopeType: string, scopeId: string | null = null): CapabilityGrant {
    return { member_id: 'm', scope_type: scopeType as 'org' | 'department' | 'squad', scope_id: scopeId, capability: cap as CapabilityGrant['capability'] }
  }

  it('owner at org → @owner', () => {
    expect(capToRoleKey([grant('owner', 'org')])).toBe('@owner')
  })

  it('lead at org → @lead', () => {
    expect(capToRoleKey([grant('lead', 'org')])).toBe('@lead')
  })

  it('lead at squad → null (WARN-1: @lead requires org scope only)', () => {
    // WARN-1 fix: squad-scoped lead does NOT project to @lead. @lead/#admin is an
    // org-level Discord role — only org-scoped lead should receive it. A dept/squad
    // lead operates within that scope and must not gain org-level Discord visibility.
    expect(capToRoleKey([grant('lead', 'squad', SQUAD_ID)])).toBeNull()
  })

  it('member at squad scope → @squad', () => {
    expect(capToRoleKey([grant('member', 'squad', SQUAD_ID)])).toBe('@squad')
  })

  it('member at org scope → @member', () => {
    expect(capToRoleKey([grant('member', 'org')])).toBe('@member')
  })

  it('observer at org → @public', () => {
    expect(capToRoleKey([grant('observer', 'org')])).toBe('@public')
  })

  it('no grants → null (no Discord role)', () => {
    expect(capToRoleKey([])).toBeNull()
  })

  it('highest rank wins: owner + member → @owner', () => {
    expect(capToRoleKey([grant('member', 'org'), grant('owner', 'org')])).toBe('@owner')
  })

  it('managed Discord roles list is correct', () => {
    expect(MANAGED_DISCORD_ROLES).toContain('@owner')
    expect(MANAGED_DISCORD_ROLES).toContain('@lead')
    expect(MANAGED_DISCORD_ROLES).toContain('@squad')
    expect(MANAGED_DISCORD_ROLES).toContain('@member')
    expect(MANAGED_DISCORD_ROLES).toContain('@public')
    expect(MANAGED_DISCORD_ROLES.length).toBe(5)
  })
})

// ── projection: add/remove diff ───────────────────────────────────────────────

describe('projectMemberCapabilitiesToDiscord — diff + idempotency', () => {
  it('adds the correct role when member has none yet', async () => {
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    const addedRoles: string[] = []
    // Discord GET: member has NO roles yet.
    const discordGetFn = async (_path: string) => ({ roles: [] })
    const addRoleFn = async (_g: string, _u: string, roleId: string) => { addedRoles.push(roleId) }
    const removeRoleFn = async (_g: string, _u: string, _roleId: string) => {}

    const result = await projectMemberCapabilitiesToDiscord(
      env, ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      { discordGetFn, addRoleFn, removeRoleFn },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toContain('@member')
    expect(result.removed).toHaveLength(0)
    expect(result.targetRole).toBe('@member')
    expect(addedRoles).toContain(ROLE_MAP['@member'])
  })

  it('idempotent: already has correct role → no add/remove', async () => {
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    const addedRoles: string[] = []
    const removedRoles: string[] = []
    // Discord already has @member — no change needed.
    const discordGetFn = async (_path: string) => ({ roles: [ROLE_MAP['@member']] })
    const addRoleFn = async (_g: string, _u: string, roleId: string) => { addedRoles.push(roleId) }
    const removeRoleFn = async (_g: string, _u: string, roleId: string) => { removedRoles.push(roleId) }

    const result = await projectMemberCapabilitiesToDiscord(
      env, ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      { discordGetFn, addRoleFn, removeRoleFn },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toHaveLength(0)
    expect(result.removed).toHaveLength(0)
    expect(addedRoles).toHaveLength(0)
    expect(removedRoles).toHaveLength(0)
  })

  it('unbound member (no Discord identity) returns ok:false, reason:unbound', async () => {
    const db = makeDb({
      members: [{ id: ALICE_MEMBER_ID, email: 'a@t.com', display_name: 'Alice', status: 'active' }],
      identities: [], // no Discord identity
      capabilities: [{ id: 'cap-a', member_id: ALICE_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'member' }],
    })
    const env = makeEnv(db)

    const result = await projectMemberCapabilitiesToDiscord(env, ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unbound')
  })

  it('CAP_TO_DISCORD_ROLE export is consistent with the mapping', () => {
    expect(CAP_TO_DISCORD_ROLE['owner']).toBe('@owner')
    expect(CAP_TO_DISCORD_ROLE['lead']).toBe('@lead')
    expect(CAP_TO_DISCORD_ROLE['member']).toBe('@member')
    expect(CAP_TO_DISCORD_ROLE['observer']).toBe('@public')
  })
})

// ── BLOCK-2 + BLOCK-3 regression: fail-closed GET discipline ─────────────────
//
// BLOCK-2 BUG: production GET default was noopGet (always null) — stale Discord
// roles could never be removed in production. Fix: default to real discordGet.
//
// BLOCK-3 BUG: null from discordGet was treated as "member has no roles" (empty
// array) — revoked members kept their @owner/@lead in Discord because the sync
// thought there was nothing to remove. Fix:
//   - No token + no injected getter  -> ok:false 'no_token', zero add/remove.
//   - Token present but GET returns null -> ok:false 'api_error', zero add/remove.
//   - Real empty-roles member (roles:[]) -> proceed normally (add target, no remove).

describe('BLOCK-2+3 regression — production GET path + fail-closed discipline', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('BLOCK-2: no injected discordGetFn, stale @owner removed via real discordGet (mocked fetch)', async () => {
    // Alice: demoted owner->member in mupot. Discord still shows @owner (stale).
    const db = makeDb(aliceMember('member', 'org'))
    // DISCORD_BOT_TOKEN must be set so discordGet does not short-circuit to null.
    const env = { DB: db, DISCORD_BOT_TOKEN: 'fake-bot-token-for-test' } as unknown as Env

    // Stub global fetch: Discord GET returns Alice with stale @owner role.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roles: [ROLE_MAP['@owner']] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const addedRoles: string[] = []
    const removedRoles: string[] = []
    // NO discordGetFn injected -- production default path.
    const result = await projectMemberCapabilitiesToDiscord(
      env,
      ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      {
        addRoleFn: async (_g, _u, roleId) => { addedRoles.push(roleId) },
        removeRoleFn: async (_g, _u, roleId) => { removedRoles.push(roleId) },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Fetch was called (real discordGet, not noopGet or null).
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain(`/guilds/${GUILD_ID}/members/${ALICE_DISCORD_ID}`)

    // Stale @owner REMOVED; @member ADDED.
    expect(result.removed).toContain('@owner')
    expect(result.added).toContain('@member')
    expect(removedRoles).toContain(ROLE_MAP['@owner'])
    expect(addedRoles).toContain(ROLE_MAP['@member'])
  })

  it('BLOCK-3a: absent DISCORD_BOT_TOKEN returns ok:false reason:no_token, zero add/remove', async () => {
    // Alice: stale @owner in Discord, demoted to member in mupot. No bot token set.
    // The sync must refuse entirely, not silently claim no stale roles exist.
    const db = makeDb(aliceMember('member', 'org'))
    const env = { DB: db } as unknown as Env  // no DISCORD_BOT_TOKEN

    const addRoleSpy = vi.fn()
    const removeRoleSpy = vi.fn()

    const result = await projectMemberCapabilitiesToDiscord(
      env,
      ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      // No discordGetFn -- production getter path requires the token.
      { addRoleFn: addRoleSpy, removeRoleFn: removeRoleSpy },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no_token')

    // CRITICAL: no add or remove was called. The sync did not report false success.
    expect(addRoleSpy).not.toHaveBeenCalled()
    expect(removeRoleSpy).not.toHaveBeenCalled()
  })

  it('BLOCK-3b: token present but GET returns null returns ok:false reason:api_error, no removals', async () => {
    // Alice: stale @owner in Discord, demoted to member in mupot. GET fails (null).
    // Treating null as "no roles" would suppress the removal of @owner. Must not.
    const db = makeDb(aliceMember('member', 'org'))
    const env = makeEnv(db)

    const addRoleSpy = vi.fn()
    const removeRoleSpy = vi.fn()

    const result = await projectMemberCapabilitiesToDiscord(
      env,
      ALICE_MEMBER_ID, GUILD_ID, ROLE_MAP,
      {
        discordGetFn: async (_path) => null,  // simulates API error / 404 / timeout
        addRoleFn: addRoleSpy,
        removeRoleFn: removeRoleSpy,
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('api_error')

    // No add or remove -- sync did not proceed without confirmed current roles.
    expect(addRoleSpy).not.toHaveBeenCalled()
    expect(removeRoleSpy).not.toHaveBeenCalled()
  })
})

// ── WARN-1 regression: @lead requires ORG scope only ─────────────────────────
//
// BUG: capToRoleKey used `hasCapability(g,'org',null,'lead') || grants.some(g=>g.capability==='lead')`
// — the any-scope fallback granted @lead to squad/dept-scoped leads, giving them
// org-level Discord (#admin) visibility. Fix: use hasCapability(,'org',null,'lead') ONLY.

describe('WARN-1 regression — @lead requires org-scope lead, not any-scope', () => {
  function grant(cap: string, scopeType: string, scopeId: string | null = null): CapabilityGrant {
    return {
      member_id: 'm',
      scope_type: scopeType as 'org' | 'department' | 'squad',
      scope_id: scopeId,
      capability: cap as CapabilityGrant['capability'],
    }
  }

  it('squad-scoped lead does NOT project to @lead (returns null)', () => {
    // A lead at squad scope must not receive #admin-level Discord visibility.
    expect(capToRoleKey([grant('lead', 'squad', SQUAD_ID)])).toBeNull()
  })

  it('dept-scoped lead does NOT project to @lead (returns null)', () => {
    // Same invariant for department scope: only org-scope lead → @lead.
    expect(capToRoleKey([grant('lead', 'department', 'dept-001')])).toBeNull()
  })

  it('org-scoped lead DOES project to @lead', () => {
    // The happy path must still work: org-scope lead → @lead.
    expect(capToRoleKey([grant('lead', 'org')])).toBe('@lead')
  })
})
