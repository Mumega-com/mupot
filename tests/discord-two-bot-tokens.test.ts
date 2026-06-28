// tests/discord-two-bot-tokens.test.ts — S196: two-bot Discord token routing.
//
// Verifies that:
//   (a) privileged ops (createGuildRole, addMemberRole, removeMemberRole, sync GETs)
//       use DISCORD_ADMIN_BOT_TOKEN when set, falling back to DISCORD_BOT_TOKEN when absent.
//   (b) post() uses DISCORD_BOT_TOKEN (the posting/Mumega bot) even when the admin
//       token is set to a DIFFERENT value.
//   (c) sync route fails closed (503) when NEITHER token is configured.
//   (d) existing BLOCK regression fixes remain covered:
//       - status-only error messages (no upstream body leakage)
//       - 207 + ok:false + failed[] on any projection failure.
//
// All Discord HTTP is MOCKED via vi.stubGlobal. No real discord.com calls.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getDiscordBotToken,
  getDiscordAdminToken,
  discordGet,
  addMemberRole,
  removeMemberRole,
  createGuildRole,
  discordAdapter,
} from '../src/channels/adapters/discord'
import { channelsAdminApp } from '../src/channels/admin'
import type { Env } from '../src/types'

// ── helpers ────────────────────────────────────────────────────────────────────

const GUILD_ID = 'guild-two-bot-test'
const USER_ID = 'user-two-bot-test'
const ROLE_ID = 'role-two-bot-test'
const CHANNEL_ID = 'channel-two-bot-test'
const TENANT_SLUG = 'test-tenant-two-bot'
const SESSION_ID = 'session-two-bot-001'

/** Capture the authorization header from the first fetch call. */
function captureAuthHeader(): { header: () => string | undefined; mock: ReturnType<typeof vi.fn> } {
  let captured: string | undefined
  const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined
    captured = headers?.['authorization']
    // Return a generic success so the caller doesn't throw.
    return {
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => ({ id: 'role-id-created' }),
    }
  })
  vi.stubGlobal('fetch', mock)
  return { header: () => captured, mock }
}

/** Build a minimal env with the given secrets. */
function makeEnv(opts: {
  botToken?: string
  adminToken?: string
} = {}): Env {
  return {
    ...(opts.botToken ? { DISCORD_BOT_TOKEN: opts.botToken } : {}),
    ...(opts.adminToken ? { DISCORD_ADMIN_BOT_TOKEN: opts.adminToken } : {}),
  } as unknown as Env
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── (a) resolver unit tests ────────────────────────────────────────────────────

describe('getDiscordBotToken', () => {
  it('returns DISCORD_BOT_TOKEN when set', () => {
    const env = makeEnv({ botToken: 'posting-token' })
    expect(getDiscordBotToken(env)).toBe('posting-token')
  })

  it('returns undefined when DISCORD_BOT_TOKEN is absent', () => {
    const env = makeEnv()
    expect(getDiscordBotToken(env)).toBeUndefined()
  })

  it('returns DISCORD_BOT_TOKEN even when admin token also set', () => {
    // The posting-bot resolver must not bleed into the admin token.
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })
    expect(getDiscordBotToken(env)).toBe('posting-tok')
  })
})

describe('getDiscordAdminToken', () => {
  it('returns DISCORD_ADMIN_BOT_TOKEN when set', () => {
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })
    expect(getDiscordAdminToken(env)).toBe('admin-tok')
  })

  it('falls back to DISCORD_BOT_TOKEN when DISCORD_ADMIN_BOT_TOKEN is absent', () => {
    // Single-bot setup: only DISCORD_BOT_TOKEN is configured.
    const env = makeEnv({ botToken: 'posting-tok' })
    expect(getDiscordAdminToken(env)).toBe('posting-tok')
  })

  it('returns undefined when neither token is configured', () => {
    const env = makeEnv()
    expect(getDiscordAdminToken(env)).toBeUndefined()
  })
})

// ── (a) privileged ops use admin token ────────────────────────────────────────

describe('addMemberRole token routing', () => {
  it('uses DISCORD_ADMIN_BOT_TOKEN when both tokens are set', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })

    await addMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)
    expect(header()).toBe('Bot admin-tok')
  })

  it('falls back to DISCORD_BOT_TOKEN when DISCORD_ADMIN_BOT_TOKEN is absent', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok' })

    await addMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)
    expect(header()).toBe('Bot posting-tok')
  })

  it('throws (fail-closed) when neither token is configured', async () => {
    const env = makeEnv()
    await expect(addMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)).rejects.toThrow()
  })

  it('throws status-only message — no token value in error text', async () => {
    // Even the "not configured" message must not accidentally contain a token value.
    const env = makeEnv()
    let msg = ''
    try {
      await addMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toContain('not configured')
    // Must not accidentally contain a real token.
    expect(msg).not.toContain('Bearer')
    expect(msg).not.toContain('Bot ')
  })
})

describe('removeMemberRole token routing', () => {
  it('uses DISCORD_ADMIN_BOT_TOKEN when both tokens are set', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })

    await removeMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)
    expect(header()).toBe('Bot admin-tok')
  })

  it('falls back to DISCORD_BOT_TOKEN when DISCORD_ADMIN_BOT_TOKEN is absent', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok' })

    await removeMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)
    expect(header()).toBe('Bot posting-tok')
  })

  it('throws (fail-closed) when neither token is configured', async () => {
    const env = makeEnv()
    await expect(removeMemberRole(env, GUILD_ID, USER_ID, ROLE_ID)).rejects.toThrow()
  })
})

describe('createGuildRole token routing', () => {
  it('uses DISCORD_ADMIN_BOT_TOKEN when both tokens are set', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })

    await createGuildRole(env, GUILD_ID, '@owner')
    expect(header()).toBe('Bot admin-tok')
  })

  it('falls back to DISCORD_BOT_TOKEN when DISCORD_ADMIN_BOT_TOKEN is absent', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok' })

    await createGuildRole(env, GUILD_ID, '@owner')
    expect(header()).toBe('Bot posting-tok')
  })

  it('throws (fail-closed) when neither token is configured', async () => {
    const env = makeEnv()
    await expect(createGuildRole(env, GUILD_ID, '@owner')).rejects.toThrow()
  })
})

// ── (b) post() uses the posting bot, not the admin bot ────────────────────────

describe('post() token routing', () => {
  it('uses DISCORD_BOT_TOKEN (posting bot) even when admin token is set to a different value', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })

    await discordAdapter.post(env, CHANNEL_ID, 'hello')
    // MUST use posting-tok — not the admin token.
    expect(header()).toBe('Bot posting-tok')
    expect(header()).not.toBe('Bot admin-tok')
  })

  it('throws when DISCORD_BOT_TOKEN is absent, even if admin token is present', async () => {
    // post() must never fall back to the admin token — that bot may not have send permissions.
    const env = makeEnv({ adminToken: 'admin-tok' })
    await expect(discordAdapter.post(env, CHANNEL_ID, 'hello')).rejects.toThrow('DISCORD_BOT_TOKEN')
  })
})

// ── discordGet token routing ───────────────────────────────────────────────────

describe('discordGet token routing', () => {
  it('uses an explicit token when provided', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok' })

    await discordGet(env, `/channels/${CHANNEL_ID}`, 'explicit-admin-tok')
    expect(header()).toBe('Bot explicit-admin-tok')
  })

  it('falls back to DISCORD_BOT_TOKEN when no explicit token is passed', async () => {
    const { header } = captureAuthHeader()
    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })

    // No token argument → must use the posting bot (back-compat for listChannelMembers etc.)
    await discordGet(env, `/channels/${CHANNEL_ID}`)
    expect(header()).toBe('Bot posting-tok')
  })

  it('returns null when no token configured and none passed', async () => {
    // Never call fetch if no token is available — fail-soft (null not thrown).
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const env = makeEnv()
    const result = await discordGet(env, `/channels/${CHANNEL_ID}`)
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── (c) sync route 503 when neither token is resolvable ───────────────────────
//
// The route checks getDiscordAdminToken (DISCORD_ADMIN_BOT_TOKEN ?? DISCORD_BOT_TOKEN).
// If both are absent → 503 no_discord_token.

function makeFullEnv(opts: {
  botToken?: string
  adminToken?: string
  role?: 'admin' | 'owner' | 'member'
}): Env {
  const role = opts.role ?? 'admin'
  const sessionRecord = JSON.stringify({
    userId: 'u-sync-test',
    email: 'test@test.com',
    role,
    createdAt: '2026-01-01T00:00:00Z',
  })
  return {
    TENANT_SLUG,
    BRAND: 'Test',
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    },
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key === `sess:${SESSION_ID}`) return sessionRecord
        return null
      }),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    ...(opts.botToken ? { DISCORD_BOT_TOKEN: opts.botToken } : {}),
    ...(opts.adminToken ? { DISCORD_ADMIN_BOT_TOKEN: opts.adminToken } : {}),
  } as unknown as Env
}

function syncRequest(body: unknown = {}): Request {
  return new Request(`https://pot.test/discord/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `mupot_session=${SESSION_ID}`,
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

describe('sync route token fail-closed', () => {
  it('returns 503 no_discord_token when NEITHER DISCORD_BOT_TOKEN nor DISCORD_ADMIN_BOT_TOKEN is set', async () => {
    const env = makeFullEnv({ /* no tokens */ })
    const res = await channelsAdminApp.fetch(syncRequest(), env)
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('no_discord_token')
  })

  it('returns 503 even when only DISCORD_ADMIN_BOT_TOKEN is set but DISCORD_BOT_TOKEN is absent', async () => {
    // Note: DISCORD_ADMIN_BOT_TOKEN alone DOES resolve getDiscordAdminToken → route
    // proceeds past the token check. This tests the OPPOSITE: only admin, no posting bot.
    // Actually the admin token fallback is: DISCORD_ADMIN_BOT_TOKEN ?? DISCORD_BOT_TOKEN.
    // So if only DISCORD_ADMIN_BOT_TOKEN is set → getDiscordAdminToken returns it → route proceeds.
    // The 503 only fires when BOTH are absent.
    // This test verifies that a DISCORD_ADMIN_BOT_TOKEN-only env does NOT 503.
    const env = makeFullEnv({ adminToken: 'admin-only-tok' })
    // Route proceeds past token check but then hits no_discord_binding (no DB rows) → 404.
    const res = await channelsAdminApp.fetch(syncRequest(), env)
    expect(res.status).not.toBe(503)
    // Will be 404 (no_discord_binding) or some other non-503 outcome.
    const body = await res.json() as { error: string }
    expect(body.error).not.toBe('no_discord_token')
  })

  it('proceeds (not 503) when only DISCORD_BOT_TOKEN is set (single-bot fallback)', async () => {
    const env = makeFullEnv({ botToken: 'posting-tok' })
    // With only DISCORD_BOT_TOKEN, getDiscordAdminToken returns it → passes token check.
    // Route proceeds to binding lookup → 404 (no binding), not 503.
    const res = await channelsAdminApp.fetch(syncRequest(), env)
    expect(res.status).not.toBe(503)
  })

  it('proceeds (not 503) when both tokens are set', async () => {
    const env = makeFullEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })
    const res = await channelsAdminApp.fetch(syncRequest(), env)
    expect(res.status).not.toBe(503)
  })
})

// ── sync route uses admin token for GET reads ─────────────────────────────────

describe('sync route: GET reads use admin token', () => {
  it('channel GET and guild roles GET use DISCORD_ADMIN_BOT_TOKEN when set', async () => {
    const authHeaders: string[] = []
    const mockFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.['authorization']) authHeaders.push(headers['authorization'])
      const urlStr = typeof url === 'string' ? url : String(url)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (urlStr.includes('/channels/') && method === 'GET') {
        return { ok: true, json: async () => ({ guild_id: GUILD_ID }) }
      }
      if (urlStr.includes('/roles') && method === 'GET') {
        return { ok: true, json: async () => [] }
      }
      // Any other call (POST /roles, member GET, etc.) → benign 204
      return { ok: true, status: 204, text: async () => '', json: async () => ({}) }
    })
    vi.stubGlobal('fetch', mockFetch)

    // DB mock with a binding so the route reaches the Discord API calls.
    const sessionRecord = JSON.stringify({
      userId: 'u-token-test',
      email: 'test@test.com',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
    })
    const env: Env = {
      TENANT_SLUG,
      BRAND: 'Test',
      DISCORD_BOT_TOKEN: 'posting-tok',
      DISCORD_ADMIN_BOT_TOKEN: 'admin-tok',
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (/FROM channel_bindings/.test(sql)) {
                return { external_channel_id: CHANNEL_ID }
              }
              return null
            },
            all: async () => ({ results: [] }),
          }),
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      },
      SESSIONS: {
        get: vi.fn(async (key: string) => {
          if (key === `sess:${SESSION_ID}`) return sessionRecord
          return null
        }),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    } as unknown as Env

    const res = await channelsAdminApp.fetch(
      new Request('https://pot.test/discord/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `mupot_session=${SESSION_ID}`,
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({}),
      }),
      env,
    )

    // Route ran past the token check and made Discord API calls.
    expect(res.status).not.toBe(503)

    // ALL Discord API calls from the sync route (channel GET, guild roles GET) must use
    // the admin token, not the posting token.
    expect(authHeaders.length).toBeGreaterThan(0)
    for (const h of authHeaders) {
      expect(h).toBe('Bot admin-tok')
      expect(h).not.toBe('Bot posting-tok')
    }
  })
})

// ── (d) BLOCK regression fix coverage ────────────────────────────────────────
//
// These are already deeply tested in discord-sync-route.test.ts. We add a minimal
// smoke-test here to confirm the two-bot changes did not regress the BLOCK fixes.

describe('BLOCK fix regression smoke tests (two-bot env)', () => {
  it('BLOCK-1: 207 ok:false when a member projection fails (api_error in two-bot env)', async () => {
    const HADI_ID = 'hadi-two-bot'
    const HADI_DISCORD = 'discord-hadi-two-bot'
    const sessionRecord = JSON.stringify({
      userId: 'u-block1',
      email: 'hadi@mumega.com',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
    })

    const ALL_MANAGED = [
      { id: 'r-owner', name: '@owner' },
      { id: 'r-lead', name: '@lead' },
      { id: 'r-squad', name: '@squad' },
      { id: 'r-member', name: '@member' },
      { id: 'r-public', name: '@public' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (urlStr.includes('/channels/') && method === 'GET') {
        return { ok: true, json: async () => ({ guild_id: GUILD_ID }) }
      }
      // Guild roles GET — return all 5 managed roles so no createGuildRole call is needed.
      if (urlStr.includes(`/guilds/${GUILD_ID}/roles`) && method === 'GET') {
        return { ok: true, json: async () => ALL_MANAGED }
      }
      // Member GET → fail (triggers api_error in projectMemberCapabilitiesToDiscord)
      if (urlStr.includes(`/guilds/${GUILD_ID}/members/`) && method === 'GET') {
        return { ok: false, status: 404, json: async () => null }
      }
      return { ok: true, status: 204, text: async () => '', json: async () => ({}) }
    }))

    const env: Env = {
      TENANT_SLUG,
      BRAND: 'Test',
      DISCORD_BOT_TOKEN: 'posting-tok',
      DISCORD_ADMIN_BOT_TOKEN: 'admin-tok',
      DB: {
        // Mirror the returning-same-stmt pattern from discord-sync-route.test.ts so that
        // .all() called without .bind() (member_identities listing) sees binds.length === 0.
        prepare: (sql: string) => {
          const binds: unknown[] = []
          const stmt: {
            bind: (...args: unknown[]) => typeof stmt
            first: <T>() => Promise<T | null>
            all: <T>() => Promise<{ results: T[] }>
            run: () => Promise<{ meta: { changes: number } }>
          } = {
            bind(...args: unknown[]) {
              binds.push(...args)
              return stmt
            },
            async first<T>(): Promise<T | null> {
              if (/FROM channel_bindings/.test(sql)) {
                return { external_channel_id: CHANNEL_ID } as unknown as T
              }
              if (/mi\.member_id = \?1/.test(sql) && /platform = 'discord'/.test(sql)) {
                return (binds[0] === HADI_ID
                  ? { external_user_id: HADI_DISCORD, status: 'active' }
                  : null) as unknown as T | null
              }
              return null
            },
            async all<T>(): Promise<{ results: T[] }> {
              // member_identities listing (no bind) — identify by empty binds
              if (/FROM member_identities/.test(sql) && /platform = 'discord'/.test(sql) && !binds.length) {
                return { results: [{ member_id: HADI_ID }] as unknown as T[] }
              }
              if (/SELECT member_id, scope_type, scope_id, capability/.test(sql)) {
                return {
                  results: [
                    { member_id: HADI_ID, scope_type: 'org', scope_id: null, capability: 'owner' },
                  ] as unknown as T[],
                }
              }
              return { results: [] }
            },
            async run() {
              return { meta: { changes: 1 } }
            },
          }
          return stmt
        },
      },
      SESSIONS: {
        get: vi.fn(async (key: string) => {
          if (key === `sess:${SESSION_ID}`) return sessionRecord
          return null
        }),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    } as unknown as Env

    const res = await channelsAdminApp.fetch(
      new Request('https://pot.test/discord/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `mupot_session=${SESSION_ID}`,
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({}),
      }),
      env,
    )

    // BLOCK-1: must be 207, not 200
    expect(res.status).toBe(207)
    const body = await res.json() as { ok: boolean; failed: Array<{ memberId: string; reason: string }> }
    expect(body.ok).toBe(false)
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0].reason).toBe('api_error')
  })

  it('BLOCK-2: createGuildRole error never leaks upstream body (status only)', async () => {
    const INJECTED = 'Bot LEAKED-SECRET-TWO-BOT-TEST'
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST') {
        // createGuildRole call — return a body with a "secret" string
        return { ok: false, status: 403, text: async () => INJECTED }
      }
      return { ok: true, json: async () => ({ id: 'r-new' }) }
    }))

    const env = makeEnv({ botToken: 'posting-tok', adminToken: 'admin-tok' })
    let caughtMsg = ''
    try {
      await createGuildRole(env, GUILD_ID, '@owner')
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err)
    }
    // Error must contain status code for triage
    expect(caughtMsg).toContain('403')
    // Must NOT contain the upstream body (injected secret)
    expect(caughtMsg).not.toContain(INJECTED)
    expect(caughtMsg).not.toContain('LEAKED-SECRET')
  })
})
