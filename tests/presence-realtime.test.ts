// tests/presence-realtime.test.ts — gated DO+WebSocket live-roster pub/sub
// (ADR #473 follow-through). Pure helpers + publish gate; no workerd required.
// PresenceChannelDO itself is a thin hibernation shell over these helpers.

import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { ModulePresence } from '../src/registry/service'
import { PRESENCE_STALE_SECONDS } from '../src/registry/service'
import {
  REALTIME_PRESENCE_FLAG,
  encodeRosterPush,
  fanOutWebSockets,
  isRealtimePresenceEnabled,
  nextPresenceExpiryMs,
  parseRosterPush,
  presenceChannelName,
  publishRosterPush,
  reciprocateWebSocketClose,
  sanitizeWebSocketCloseCode,
} from '../src/registry/realtime'
import {
  encodePresenceSocketTags,
  fanOutAuthorizedRoster,
  parsePresenceSocketTags,
  PRESENCE_AUTH_REVOKED_CLOSE_CODE,
  subscriptionStillAuthorized,
} from '../src/registry/presence-subscription-auth'

const NOW = new Date('2026-07-22T12:00:00.000Z')
const TENANT = 't'

function realDbEnv(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  return { harness, env }
}

function seedMember(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  hash: string,
  opts: { revoked?: boolean; orgAdmin?: boolean } = {},
): void {
  sqlite.exec(
    `INSERT INTO members (id, email, display_name, status, tenant)
     VALUES ('${id}', '${id}@t.local', '${id}', 'active', '${TENANT}')`,
  )
  const revoked = opts.revoked ? "'2026-01-01 00:00:00'" : 'NULL'
  sqlite.exec(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, expires_at, tenant)
     VALUES ('tok-${id}', '${id}', '${hash}', 'test', 'workspace', datetime('now'), ${revoked}, NULL, '${TENANT}')`,
  )
  if (opts.orgAdmin) {
    sqlite.exec(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('cap-${id}', '${id}', 'org', NULL, 'admin')`,
    )
  }
}

function seedProject(sqlite: SqliteD1Harness['sqlite'], id = 'proj-a'): void {
  sqlite.exec(
    `INSERT INTO projects (id, slug, name, status) VALUES ('${id}', '${id}', 'A', 'active')`,
  )
}

const sampleModule: ModulePresence = {
  id: 'm1',
  kind: 'agent_system',
  adapter: 'cursor',
  project_id: 'proj-a',
  identity: 'agent-1',
  status: 'online',
  capabilities: ['build'],
  last_heartbeat: NOW.toISOString(),
  registered_at: NOW.toISOString(),
}

describe('isRealtimePresenceEnabled', () => {
  it('false when flag unset (default deferred path)', () => {
    expect(
      isRealtimePresenceEnabled({
        TENANT_SLUG: 't',
        PRESENCE_CHANNEL: {} as Env['PRESENCE_CHANNEL'],
      } as Env),
    ).toBe(false)
  })

  it('false when flag on but binding absent', () => {
    expect(
      isRealtimePresenceEnabled({
        TENANT_SLUG: 't',
        REALTIME_PRESENCE: REALTIME_PRESENCE_FLAG,
      } as Env),
    ).toBe(false)
  })

  it('true only when flag=1 AND binding present', () => {
    expect(
      isRealtimePresenceEnabled({
        TENANT_SLUG: 't',
        REALTIME_PRESENCE: REALTIME_PRESENCE_FLAG,
        PRESENCE_CHANNEL: {} as NonNullable<Env['PRESENCE_CHANNEL']>,
      } as Env),
    ).toBe(true)
  })

  it('rejects non-1 flag values', () => {
    expect(
      isRealtimePresenceEnabled({
        TENANT_SLUG: 't',
        REALTIME_PRESENCE: 'true',
        PRESENCE_CHANNEL: {} as NonNullable<Env['PRESENCE_CHANNEL']>,
      } as Env),
    ).toBe(false)
  })
})

describe('presenceChannelName', () => {
  it('scopes by tenant + project', () => {
    expect(presenceChannelName('mumega', 'proj-a')).toBe('mumega:presence:proj-a')
  })

  it('uses _ for the no-project bucket', () => {
    expect(presenceChannelName('mumega', null)).toBe('mumega:presence:_')
    expect(presenceChannelName('mumega', '')).toBe('mumega:presence:_')
  })

  it('refuses a blank tenant (no cross-pot channel collision)', () => {
    expect(() => presenceChannelName('  ', 'proj-a')).toThrow('presence_channel_tenant_required')
  })
})

describe('encodeRosterPush / parseRosterPush', () => {
  it('round-trips a roster snapshot', () => {
    const raw = encodeRosterPush('proj-a', [sampleModule], NOW)
    const parsed = parseRosterPush(raw)
    expect(parsed).toEqual({
      type: 'roster',
      project_id: 'proj-a',
      modules: [sampleModule],
      at: '2026-07-22T12:00:00.000Z',
    })
  })

  it('rejects non-roster payloads', () => {
    expect(() => parseRosterPush('{"type":"other"}')).toThrow('roster_push_wrong_type')
    expect(() => parseRosterPush('not-json')).toThrow('roster_push_invalid_json')
  })
})

describe('fanOutWebSockets', () => {
  it('sends to every live socket and skips dead ones', () => {
    const a = { send: vi.fn() }
    const b = {
      send: vi.fn(() => {
        throw new Error('closed')
      }),
    }
    const c = { send: vi.fn() }
    expect(fanOutWebSockets([a, b, c], 'hello')).toBe(2)
    expect(a.send).toHaveBeenCalledWith('hello')
    expect(c.send).toHaveBeenCalledWith('hello')
  })
})

describe('sanitizeWebSocketCloseCode / reciprocateWebSocketClose', () => {
  it('maps reserved/abnormal codes (1005/1006/1015) to 1000', () => {
    expect(sanitizeWebSocketCloseCode(1005)).toBe(1000)
    expect(sanitizeWebSocketCloseCode(1006)).toBe(1000)
    expect(sanitizeWebSocketCloseCode(1015)).toBe(1000)
  })

  it('passes through normal application codes unchanged', () => {
    expect(sanitizeWebSocketCloseCode(1000)).toBe(1000)
    expect(sanitizeWebSocketCloseCode(1001)).toBe(1001)
    expect(sanitizeWebSocketCloseCode(4000)).toBe(4000)
  })

  it('never feeds reserved codes into ws.close (RangeError guard)', () => {
    const close = vi.fn()
    reciprocateWebSocketClose({ close }, 1006, 'abnormal')
    expect(close).toHaveBeenCalledWith(1000, 'abnormal')
    close.mockClear()
    reciprocateWebSocketClose({ close }, 1000, 'bye')
    expect(close).toHaveBeenCalledWith(1000, 'bye')
  })
})

describe('publishRosterPush', () => {
  it('no-ops when the gate is off (query-time presence stays sufficient)', async () => {
    const { harness, env } = realDbEnv()
    try {
      const result = await publishRosterPush(env, 'proj-a', NOW)
      expect(result).toEqual({ ok: true, skipped: true, reason: 'disabled' })
    } finally {
      harness.close()
    }
  })

  it('publishes a roster frame to the project channel when gated on', async () => {
    const { harness, env } = realDbEnv()
    try {
      const fetchMock = vi.fn(async () => Response.json({ ok: true, sent: 3 }))
      const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId)
      const get = vi.fn(() => ({ fetch: fetchMock }))
      const gated = {
        ...env,
        TENANT_SLUG: 'tenant-a',
        REALTIME_PRESENCE: REALTIME_PRESENCE_FLAG,
        PRESENCE_CHANNEL: { idFromName, get },
      } as unknown as Env

      const result = await publishRosterPush(gated, 'proj-a', NOW)
      expect(result).toEqual({ ok: true, skipped: false, sent: 3 })
      expect(idFromName).toHaveBeenCalledWith('tenant-a:presence:proj-a')
      expect(fetchMock).toHaveBeenCalledOnce()
      const req = fetchMock.mock.calls[0][0] as Request
      expect(req.method).toBe('POST')
      expect(new URL(req.url).pathname).toBe('/publish')
      const body = parseRosterPush(await req.text())
      expect(body.type).toBe('roster')
      expect(body.project_id).toBe('proj-a')
    } finally {
      harness.close()
    }
  })

  it('returns ok:false (does not throw) when the DO fetch fails', async () => {
    const { harness, env } = realDbEnv()
    try {
      const gated = {
        ...env,
        TENANT_SLUG: 'tenant-a',
        REALTIME_PRESENCE: REALTIME_PRESENCE_FLAG,
        PRESENCE_CHANNEL: {
          idFromName: () => ({}),
          get: () => ({
            fetch: async () => {
              throw new Error('do_down')
            },
          }),
        },
      } as unknown as Env

      const result = await publishRosterPush(gated, null, NOW)
      expect(result).toEqual({ ok: false, error: 'do_down' })
    } finally {
      harness.close()
    }
  })
})

describe('nextPresenceExpiryMs (stale-expiry publication schedule)', () => {
  it('returns earliest online heartbeat + stale window', () => {
    const nowMs = NOW.getTime()
    const earlier = new Date(nowMs - 30_000).toISOString()
    const later = new Date(nowMs - 10_000).toISOString()
    const next = nextPresenceExpiryMs(
      [
        { status: 'online', last_heartbeat: later },
        { status: 'online', last_heartbeat: earlier },
        { status: 'offline', last_heartbeat: earlier },
      ],
      nowMs,
      PRESENCE_STALE_SECONDS,
    )
    expect(next).toBe(Date.parse(earlier) + PRESENCE_STALE_SECONDS * 1000)
  })

  it('returns null when nobody is online (no alarm needed)', () => {
    expect(
      nextPresenceExpiryMs(
        [{ status: 'offline', last_heartbeat: NOW.toISOString() }],
        NOW.getTime(),
        PRESENCE_STALE_SECONDS,
      ),
    ).toBeNull()
  })

  it('returns nowMs when an online row is already past expiry', () => {
    const nowMs = NOW.getTime()
    const staleHb = new Date(nowMs - (PRESENCE_STALE_SECONDS + 5) * 1000).toISOString()
    expect(
      nextPresenceExpiryMs(
        [{ status: 'online', last_heartbeat: staleHb }],
        nowMs,
        PRESENCE_STALE_SECONDS,
      ),
    ).toBe(nowMs)
  })
})

describe('presence socket lease tags + revocation revalidation (mupot#545)', () => {
  it('round-trips lease tags (project / member / token_hash)', () => {
    const tags = encodePresenceSocketTags({
      projectId: 'proj-a',
      memberId: 'mem-1',
      tokenHash: 'abc123',
    })
    expect(tags).toEqual(['proj-a', 'mem-1', 'abc123'])
    expect(parsePresenceSocketTags(tags)).toEqual({
      projectId: 'proj-a',
      memberId: 'mem-1',
      tokenHash: 'abc123',
    })
  })

  it('encodes null project as empty tag key', () => {
    expect(
      parsePresenceSocketTags(
        encodePresenceSocketTags({ projectId: null, memberId: 'm', tokenHash: 'h' }),
      ),
    ).toEqual({ projectId: null, memberId: 'm', tokenHash: 'h' })
  })

  it('rejects incomplete tags (legacy project-only sockets)', () => {
    expect(parsePresenceSocketTags(['proj-a'])).toBeNull()
    expect(parsePresenceSocketTags(['proj-a', 'mem-1'])).toBeNull()
  })

  it('subscriptionStillAuthorized is false when the token hash is revoked', async () => {
    // orgAdmin + existing project: canReadProject would succeed. Fail-closed
    // must be memberTokenHashIsLive (M1: always-live would make this true).
    const { harness, env } = realDbEnv()
    try {
      seedMember(harness.sqlite, 'mem-1', 'dead', { revoked: true, orgAdmin: true })
      seedProject(harness.sqlite)
      await expect(
        subscriptionStillAuthorized(env, {
          projectId: 'proj-a',
          memberId: 'mem-1',
          tokenHash: 'dead',
        }),
      ).resolves.toBe(false)
    } finally {
      harness.close()
    }
  })

  it('subscriptionStillAuthorized is false when project access is gone', async () => {
    const { harness, env } = realDbEnv()
    try {
      seedMember(harness.sqlite, 'mem-1', 'live')
      seedProject(harness.sqlite)
      await expect(
        subscriptionStillAuthorized(env, {
          projectId: 'proj-a',
          memberId: 'mem-1',
          tokenHash: 'live',
        }),
      ).resolves.toBe(false)
    } finally {
      harness.close()
    }
  })

  it('fanOutAuthorizedRoster closes revoked sockets and skips their send', async () => {
    // Revoked principal keeps orgAdmin + project row so close is revocation,
    // not the project-access path (M1: always-live would send to both).
    const { harness, env } = realDbEnv()
    try {
      seedMember(harness.sqlite, 'mem-live', 'hash-live', { orgAdmin: true })
      seedMember(harness.sqlite, 'mem-revoked', 'hash-revoked', { revoked: true, orgAdmin: true })
      seedProject(harness.sqlite)
      const live = {
        send: vi.fn(),
        close: vi.fn(),
        tags: ['proj-a', 'mem-live', 'hash-live'],
      }
      const revoked = {
        send: vi.fn(),
        close: vi.fn(),
        tags: ['proj-a', 'mem-revoked', 'hash-revoked'],
      }
      const sent = await fanOutAuthorizedRoster(
        env,
        [live, revoked],
        (s) => s.tags,
        'roster-frame',
      )
      expect(sent).toBe(1)
      expect(live.send).toHaveBeenCalledWith('roster-frame')
      expect(revoked.send).not.toHaveBeenCalled()
      expect(revoked.close).toHaveBeenCalledWith(PRESENCE_AUTH_REVOKED_CLOSE_CODE, 'auth_revoked')
    } finally {
      harness.close()
    }
  })
})

describe('PresenceChannelDO export + wrangler contract (structural)', () => {
  it('PresenceChannelDO is a named export from its module source', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/registry/presence-channel-do.ts', 'utf8')
    expect(src).toContain('export class PresenceChannelDO')
    expect(src).toContain('acceptWebSocket')
    expect(src).toContain('fanOutAuthorizedRoster')
    expect(src).toContain('subscriptionStillAuthorized')
    expect(src).toContain('nextPresenceExpiryMs')
    expect(src).toContain('async alarm(')
    expect(src).toContain('setAlarm')
    expect(src).toContain('reciprocateWebSocketClose')
    expect(src).toContain('token_hash')
    expect(src).not.toMatch(/ws\.close\(code,\s*reason\)/)
    const entry = readFileSync('src/index.ts', 'utf8')
    expect(entry).toContain("export { PresenceChannelDO } from './registry/presence-channel-do'")
    const routes = readFileSync('src/registry/presence-routes.ts', 'utf8')
    expect(routes).toContain("doUrl.searchParams.set('member'")
    expect(routes).toContain("doUrl.searchParams.set('token_hash'")
  })

  it('wrangler templates declare the binding + v2 migration (not CF Pub/Sub)', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync('wrangler.example.toml', 'utf8')
    const local = readFileSync('wrangler-local-test.toml', 'utf8')
    for (const src of [example, local]) {
      expect(src).toContain('name = "PRESENCE_CHANNEL"')
      expect(src).toContain('class_name = "PresenceChannelDO"')
      expect(src).toContain('tag = "v2"')
      expect(src).toContain('new_classes = ["PresenceChannelDO"]')
      expect(src.toLowerCase()).not.toContain('pubsub')
    }
  })
})
