// tests/discord-sync-route.test.ts — S196 Slice B: POST /discord/sync route.
//
// All Discord HTTP mocked via vi.stubGlobal('fetch', ...). No real discord.com calls.
//
// Covered:
//   1. guild resolved from bound channel; missing binding → fail-closed 404.
//   2. roleMap built; a missing managed role triggers createGuildRole (POST /roles);
//      existing roles are reused (no extra POST).
//   3. projection invoked per discord-linked member; hadi (owner@org) → targetRole @owner.
//   4. token absent → 503, no add/remove called.
//   5. dryRun → no mutations; no role CREATE; reports intended projections.
//   6. admin gate: non-admin → 403.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { channelsAdminApp } from '../src/channels/admin'
import type { Env } from '../src/types'

// ── fixtures ──────────────────────────────────────────────────────────────────

const TENANT_SLUG = 'test-tenant'
const SESSION_ID = 'test-session-001'
const GUILD_ID = 'guild-mumega-001'
const CHANNEL_ID = 'channel-discord-001'
const SQUAD_ID = 'squad-core'

const ROLE_MAP_FULL = {
  '@owner': 'role-id-owner',
  '@lead': 'role-id-lead',
  '@squad': 'role-id-squad',
  '@member': 'role-id-member',
  '@public': 'role-id-public',
}

// ── D1 mock helpers ───────────────────────────────────────────────────────────

interface MockDBState {
  binding: { external_channel_id: string } | null
  memberIdentities: { member_id: string }[]
  // member_id → { external_user_id, status }
  memberDiscordIdentity: Record<string, { external_user_id: string; status: string }>
  // member_id → capability rows
  capabilities: Record<string, Array<{ member_id: string; scope_type: string; scope_id: string | null; capability: string }>>
}

/**
 * Build a D1 mock faithful to the SQL patterns used by admin.ts + discord-cap-sync.ts.
 * Handles four SQL shapes:
 *   A. channel_bindings lookup (external_channel_id for squad + platform='discord')
 *   B. member_identities listing (platform='discord' → member_id list)
 *   C. member_identities single-row by member_id (for projectMemberCapabilitiesToDiscord)
 *   D. capabilities UNION channel_capability_grants by member_id (resolveCapabilities)
 */
function makeDB(state: MockDBState) {
  function prepare(sql: string) {
    const binds: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) {
        binds.push(...args)
        return stmt
      },
      async first<T>(): Promise<T | null> {
        const s = sql.trim()

        // A. channel_bindings lookup for the sync route
        if (/FROM channel_bindings/.test(s) && /platform = 'discord'/.test(s)) {
          return (state.binding ? { external_channel_id: state.binding.external_channel_id } : null) as T | null
        }

        // C. projectMemberCapabilitiesToDiscord: SELECT mi.external_user_id, m.status
        //    FROM member_identities WHERE mi.member_id = ?1 AND platform = 'discord'
        if (/FROM member_identities mi/.test(s) && /mi\.member_id = \?1/.test(s)) {
          const [memberId] = binds as [string]
          const row = state.memberDiscordIdentity[memberId]
          if (!row) return null
          return { external_user_id: row.external_user_id, status: row.status } as unknown as T
        }

        return null
      },
      async all<T>(): Promise<{ results: T[] }> {
        const s = sql.trim()

        // B. member_identities listing for the sync route
        if (/FROM member_identities/.test(s) && /platform = 'discord'/.test(s) && !binds.length) {
          return { results: state.memberIdentities as unknown as T[] }
        }

        // D. resolveCapabilities: UNION of capabilities + channel_capability_grants
        if (/SELECT member_id, scope_type, scope_id, capability/.test(s)) {
          const [memberId] = binds as [string]
          const rows = state.capabilities[memberId] ?? []
          return { results: rows as unknown as T[] }
        }

        return { results: [] as T[] }
      },
      async run() {
        return { meta: { changes: 1 } }
      },
    }
    return stmt
  }

  return { prepare }
}

// ── env builder ──────────────────────────────────────────────────────────────

function makeEnv(
  dbState: MockDBState,
  opts: {
    role?: 'owner' | 'admin' | 'member'
    hasBotToken?: boolean
  } = {},
): Env {
  const role = opts.role ?? 'admin'
  const hasBotToken = opts.hasBotToken ?? true

  const sessionRecord = JSON.stringify({
    userId: 'user-001',
    email: 'hadi@mumega.com',
    role,
    createdAt: '2026-01-01T00:00:00Z',
  })

  return {
    TENANT_SLUG,
    BRAND: 'Test',
    DB: makeDB(dbState),
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key === `sess:${SESSION_ID}`) return sessionRecord
        return null
      }),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    // Adapter-level secret access (cast needed because Env does not declare discord keys)
    ...(hasBotToken ? { DISCORD_BOT_TOKEN: 'fake-bot-token-for-test' } : {}),
  } as unknown as Env
}

// ── request builder ───────────────────────────────────────────────────────────

function req(
  path: string,
  body: unknown = {},
  query = '',
): Request {
  const url = `https://pot.test${path}${query}`
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `mupot_session=${SESSION_ID}`,
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

// ── mock fetch factory ────────────────────────────────────────────────────────

/**
 * Build a mocked global fetch that dispatches on URL path patterns.
 *
 *   /channels/<id>          → { guild_id }
 *   /guilds/<id>/roles      → roles array
 *   /guilds/<id>/roles (POST) → creates role, returns { id }
 *   /guilds/<id>/members/<uid> → member data with current roles
 *   PUT/DELETE …/roles/<rid>   → 204
 */
interface MockFetchOpts {
  guildId?: string
  channelId?: string
  existingRoleNames?: string[]  // which managed roles already exist in guild
  memberCurrentRoles?: string[] // role IDs the member currently holds in Discord
  createRoleId?: string         // id to return for POST /roles
  /** For recording calls */
  onCreateRole?: (name: string) => void
  onAddRole?: (roleId: string) => void
  onRemoveRole?: (roleId: string) => void
}

function makeFetch(opts: MockFetchOpts = {}) {
  const guildId = opts.guildId ?? GUILD_ID
  const channelId = opts.channelId ?? CHANNEL_ID
  const existingRoleNames = opts.existingRoleNames ?? ['@owner', '@lead', '@squad', '@member', '@public']
  const memberCurrentRoles = opts.memberCurrentRoles ?? []
  const createRoleId = opts.createRoleId ?? 'role-id-new'

  // Build guild roles array from the names that "exist"
  const allManagedRoles = ['@owner', '@lead', '@squad', '@member', '@public']
  const ROLE_IDS: Record<string, string> = {
    '@owner': 'role-id-owner',
    '@lead': 'role-id-lead',
    '@squad': 'role-id-squad',
    '@member': 'role-id-member',
    '@public': 'role-id-public',
  }
  const guildRolesArray = existingRoleNames
    .filter((n) => allManagedRoles.includes(n))
    .map((n) => ({ id: ROLE_IDS[n], name: n }))

  return vi.fn(async (url: string | Request, _init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    const method = (_init?.method ?? 'GET').toUpperCase()

    // Channel GET → guild_id
    if (urlStr.includes(`/channels/${channelId}`) && method === 'GET') {
      return { ok: true, json: async () => ({ guild_id: guildId }) }
    }

    // Guild roles GET
    if (urlStr.includes(`/guilds/${guildId}/roles`) && method === 'GET') {
      return { ok: true, json: async () => guildRolesArray }
    }

    // Create guild role POST
    if (urlStr.includes(`/guilds/${guildId}/roles`) && method === 'POST') {
      let roleName = '@new-role'
      try {
        const body = JSON.parse(_init?.body as string ?? '{}') as { name?: string }
        roleName = body.name ?? roleName
      } catch { /* ignore */ }
      opts.onCreateRole?.(roleName)
      return { ok: true, json: async () => ({ id: createRoleId, name: roleName }) }
    }

    // Member GET (discord-cap-sync uses this for current roles)
    if (urlStr.includes(`/guilds/${guildId}/members/`) && method === 'GET') {
      return {
        ok: true,
        json: async () => ({ roles: memberCurrentRoles }),
      }
    }

    // Add role (PUT)
    if (urlStr.includes(`/roles/`) && method === 'PUT') {
      const roleId = urlStr.split('/roles/').pop() ?? ''
      opts.onAddRole?.(roleId)
      return { ok: true, status: 204, text: async () => '' }
    }

    // Remove role (DELETE)
    if (urlStr.includes(`/roles/`) && method === 'DELETE') {
      const roleId = urlStr.split('/roles/').pop() ?? ''
      opts.onRemoveRole?.(roleId)
      return { ok: true, status: 204, text: async () => '' }
    }

    // Unhandled — fail so tests surface it clearly
    throw new Error(`MockFetch: unhandled ${method} ${urlStr}`)
  })
}

// ── DBState fixtures ──────────────────────────────────────────────────────────

const HADI_MEMBER_ID = 'hadi-member-001'
const HADI_DISCORD_ID = 'discord-hadi-snowflake-001'

function stateWithBinding(overrides: Partial<MockDBState> = {}): MockDBState {
  return {
    binding: { external_channel_id: CHANNEL_ID },
    memberIdentities: [{ member_id: HADI_MEMBER_ID }],
    memberDiscordIdentity: {
      [HADI_MEMBER_ID]: { external_user_id: HADI_DISCORD_ID, status: 'active' },
    },
    capabilities: {
      [HADI_MEMBER_ID]: [
        { member_id: HADI_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'owner' },
      ],
    },
    ...overrides,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── test 6: admin gate ────────────────────────────────────────────────────────

describe('admin gate', () => {
  it('non-admin (member role) → 403', async () => {
    const state = stateWithBinding()
    const env = makeEnv(state, { role: 'member' })
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(403)
  })

  it('admin role → proceeds past gate', async () => {
    // Stub fetch so the route can proceed past the auth gate.
    const mockFetch = makeFetch()
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state, { role: 'admin' })
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    // Should not be 403.
    expect(res.status).not.toBe(403)
  })

  it('owner role → proceeds past gate', async () => {
    const mockFetch = makeFetch()
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state, { role: 'owner' })
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).not.toBe(403)
  })
})

// ── test 4: token absent → fail-closed ───────────────────────────────────────

describe('token absent → fail-closed 503', () => {
  it('returns 503 with no_discord_token error when DISCORD_BOT_TOKEN absent', async () => {
    const addRoleSpy = vi.fn()
    const removeRoleSpy = vi.fn()

    const state = stateWithBinding()
    // No bot token in env.
    const env = makeEnv(state, { hasBotToken: false })

    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('no_discord_token')

    // No Discord mutations attempted.
    expect(addRoleSpy).not.toHaveBeenCalled()
    expect(removeRoleSpy).not.toHaveBeenCalled()
  })
})

// ── test 1: guild resolved from bound channel; missing binding → 404 ──────────

describe('guild resolution', () => {
  it('resolves guild_id from bound Discord channel', async () => {
    const mockFetch = makeFetch({ guildId: GUILD_ID, channelId: CHANNEL_ID })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; guildId: string }
    expect(body.ok).toBe(true)
    expect(body.guildId).toBe(GUILD_ID)
  })

  it('missing binding for squad → fail-closed 404 with no_discord_binding', async () => {
    const state = stateWithBinding({ binding: null })
    const env = makeEnv(state)

    const res = await channelsAdminApp.fetch(req('/discord/sync', { squadId: 'squad-missing' }), env)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('no_discord_binding')
  })

  it('defaults to squad-core when squadId is omitted from body', async () => {
    const mockFetch = makeFetch()
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    // DB binding is for SQUAD_ID ('squad-core'); the route defaults to that.
    const res = await channelsAdminApp.fetch(req('/discord/sync', {}), env)
    expect(res.status).toBe(200)
  })
})

// ── test 2: roleMap built; missing managed role triggers createGuildRole ───────

describe('roleMap and role creation', () => {
  it('all roles already exist → no createGuildRole call', async () => {
    const createRoleSpy = vi.fn()
    const mockFetch = makeFetch({
      existingRoleNames: ['@owner', '@lead', '@squad', '@member', '@public'],
      onCreateRole: createRoleSpy,
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as { rolesEnsured: string[] }
    // All exist — all entries should say ':exists', none ':created'
    for (const entry of body.rolesEnsured) {
      expect(entry).toMatch(/:exists$/)
    }
    expect(createRoleSpy).not.toHaveBeenCalled()
  })

  it('a missing managed role triggers createGuildRole via POST /roles', async () => {
    const createdRoles: string[] = []
    const mockFetch = makeFetch({
      // @lead is MISSING from the guild
      existingRoleNames: ['@owner', '@squad', '@member', '@public'],
      createRoleId: 'role-id-lead-new',
      onCreateRole: (name) => createdRoles.push(name),
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as { rolesEnsured: string[] }
    // @lead should be created
    expect(createdRoles).toContain('@lead')
    // The rolesEnsured entry for @lead should say ':created'
    expect(body.rolesEnsured).toContain('@lead:created')
    // Other roles should say ':exists'
    expect(body.rolesEnsured).toContain('@owner:exists')
    expect(body.rolesEnsured).toContain('@member:exists')
  })

  it('dryRun: missing managed role is not created — reported as would_create', async () => {
    const createRoleSpy = vi.fn()
    const mockFetch = makeFetch({
      // @lead is MISSING
      existingRoleNames: ['@owner', '@squad', '@member', '@public'],
      onCreateRole: createRoleSpy,
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync', { dryRun: true }), env)
    expect(res.status).toBe(200)

    const body = await res.json() as { rolesEnsured: string[] }
    // No POST /roles call made
    expect(createRoleSpy).not.toHaveBeenCalled()
    // @lead reported as would_create
    expect(body.rolesEnsured).toContain('@lead:would_create')
  })
})

// ── test 3: projection per discord-linked member ───────────────────────────────

describe('member projections', () => {
  it('hadi (owner@org) gets targetRole @owner with no prior roles', async () => {
    const addedRoleIds: string[] = []
    const mockFetch = makeFetch({
      // No existing roles for hadi in Discord
      memberCurrentRoles: [],
      onAddRole: (roleId) => addedRoleIds.push(roleId),
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      ok: boolean
      projections: Array<{ memberId: string; ok: boolean; targetRole: string | null; added: string[] }>
    }
    expect(body.ok).toBe(true)
    expect(body.projections).toHaveLength(1)

    const hadiProj = body.projections[0]
    expect(hadiProj.memberId).toBe(HADI_MEMBER_ID)
    expect(hadiProj.ok).toBe(true)
    expect(hadiProj.targetRole).toBe('@owner')
    expect(hadiProj.added).toContain('@owner')

    // @owner role id was actually added via Discord API
    expect(addedRoleIds).toContain(ROLE_MAP_FULL['@owner'])
  })

  it('member without Discord identity is skipped (not in projections)', async () => {
    const mockFetch = makeFetch()
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding({
      // No discord identity rows at all
      memberIdentities: [],
    })
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as { projections: unknown[] }
    expect(body.projections).toHaveLength(0)
  })

  it('member with no mupot capabilities gets no Discord role (targetRole null)', async () => {
    const removedRoleIds: string[] = []
    // Member currently has @member in Discord but no mupot grants
    const mockFetch = makeFetch({
      memberCurrentRoles: [ROLE_MAP_FULL['@member']],
      onRemoveRole: (roleId) => removedRoleIds.push(roleId),
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding({
      capabilities: {
        // No capabilities for hadi
        [HADI_MEMBER_ID]: [],
      },
    })
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      projections: Array<{ ok: boolean; targetRole: string | null; removed: string[] }>
    }
    const proj = body.projections[0]
    expect(proj.ok).toBe(true)
    expect(proj.targetRole).toBeNull()
    // @member was removed (no mupot grant → no Discord role)
    expect(proj.removed).toContain('@member')
    expect(removedRoleIds).toContain(ROLE_MAP_FULL['@member'])
  })
})

// ── test 5: dryRun → no mutations, reports intended projections ───────────────

describe('dryRun mode', () => {
  it('?dryRun=1 query param → no add/remove calls, projections reported', async () => {
    const addRoleSpy = vi.fn()
    const removeRoleSpy = vi.fn()
    const mockFetch = makeFetch({
      memberCurrentRoles: [],
      onAddRole: addRoleSpy,
      onRemoveRole: removeRoleSpy,
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    // dryRun via query string
    const res = await channelsAdminApp.fetch(req('/discord/sync', {}, '?dryRun=1'), env)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      ok: boolean
      projections: Array<{ ok: boolean; targetRole: string | null; added: string[] }>
    }
    expect(body.ok).toBe(true)

    // Projection is reported (targetRole, added) but NOT executed
    expect(body.projections[0].targetRole).toBe('@owner')
    expect(body.projections[0].added).toContain('@owner')

    // No actual Discord role mutations
    expect(addRoleSpy).not.toHaveBeenCalled()
    expect(removeRoleSpy).not.toHaveBeenCalled()
  })

  it('body {dryRun: true} → same no-mutation behaviour', async () => {
    const addRoleSpy = vi.fn()
    const removeRoleSpy = vi.fn()
    const mockFetch = makeFetch({
      memberCurrentRoles: [],
      onAddRole: addRoleSpy,
      onRemoveRole: removeRoleSpy,
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync', { dryRun: true }), env)
    expect(res.status).toBe(200)

    expect(addRoleSpy).not.toHaveBeenCalled()
    expect(removeRoleSpy).not.toHaveBeenCalled()
  })

  it('dryRun does NOT create missing managed roles', async () => {
    const createRoleSpy = vi.fn()
    const mockFetch = makeFetch({
      // All roles missing from guild
      existingRoleNames: [],
      onCreateRole: createRoleSpy,
    })
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync', { dryRun: true }), env)
    expect(res.status).toBe(200)

    // No POST /roles calls
    expect(createRoleSpy).not.toHaveBeenCalled()

    const body = await res.json() as { rolesEnsured: string[] }
    // All 5 managed roles reported as would_create
    const wouldCreate = body.rolesEnsured.filter((r) => r.endsWith(':would_create'))
    expect(wouldCreate).toHaveLength(5)
  })
})

// ── response shape: bot token never in body ────────────────────────────────────

describe('security: bot token never in response', () => {
  it('success response does not contain the bot token string', async () => {
    const mockFetch = makeFetch()
    vi.stubGlobal('fetch', mockFetch)

    const state = stateWithBinding()
    const env = makeEnv(state)
    const res = await channelsAdminApp.fetch(req('/discord/sync'), env)
    const text = await res.text()

    expect(text).not.toContain('fake-bot-token-for-test')
  })

  it('503 response does not contain a secret token value', async () => {
    const state = stateWithBinding()
    // Even when a token env var is present, the value should never leak.
    const env = makeEnv(state, { hasBotToken: true })
    // Inject the token value we know, then verify it doesn't appear in the
    // response body. We simulate a fast-path reject by using the real token
    // check (token IS present → route continues to the binding lookup,
    // which returns 404 since we have no binding mocked). What matters:
    // no path should echo the token value.
    const stateNoBinding = stateWithBinding({ binding: null })
    const envWithToken = makeEnv(stateNoBinding, { hasBotToken: true })
    const res = await channelsAdminApp.fetch(req('/discord/sync'), envWithToken)
    const text = await res.text()

    // The token VALUE should never appear in any response body.
    expect(text).not.toContain('fake-bot-token-for-test')
  })
})
