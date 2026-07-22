// tests/presence-realtime.test.ts — gated DO+WebSocket live-roster pub/sub
// (ADR #473 follow-through). Pure helpers + publish gate; no workerd required.
// PresenceChannelDO itself is a thin hibernation shell over these helpers.

import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import type { ModulePresence } from '../src/registry/service'
import {
  REALTIME_PRESENCE_FLAG,
  encodeRosterPush,
  fanOutWebSockets,
  isRealtimePresenceEnabled,
  parseRosterPush,
  presenceChannelName,
  publishRosterPush,
  reciprocateWebSocketClose,
  sanitizeWebSocketCloseCode,
} from '../src/registry/realtime'

const NOW = new Date('2026-07-22T12:00:00.000Z')

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
    const env = { TENANT_SLUG: 't', DB: {} } as Env
    const result = await publishRosterPush(env, 'proj-a', NOW)
    expect(result).toEqual({ ok: true, skipped: true, reason: 'disabled' })
  })

  it('publishes a roster frame to the project channel when gated on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, sent: 3 }))
    const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId)
    const get = vi.fn(() => ({ fetch: fetchMock }))
    const env = {
      TENANT_SLUG: 'tenant-a',
      REALTIME_PRESENCE: REALTIME_PRESENCE_FLAG,
      PRESENCE_CHANNEL: { idFromName, get },
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as unknown as Env

    const result = await publishRosterPush(env, 'proj-a', NOW)
    expect(result).toEqual({ ok: true, skipped: false, sent: 3 })
    expect(idFromName).toHaveBeenCalledWith('tenant-a:presence:proj-a')
    expect(fetchMock).toHaveBeenCalledOnce()
    const req = fetchMock.mock.calls[0][0] as Request
    expect(req.method).toBe('POST')
    expect(new URL(req.url).pathname).toBe('/publish')
    const body = parseRosterPush(await req.text())
    expect(body.type).toBe('roster')
    expect(body.project_id).toBe('proj-a')
  })

  it('returns ok:false (does not throw) when the DO fetch fails', async () => {
    const env = {
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
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as unknown as Env

    const result = await publishRosterPush(env, null, NOW)
    expect(result).toEqual({ ok: false, error: 'do_down' })
  })
})

describe('PresenceChannelDO export + wrangler contract (structural)', () => {
  it('PresenceChannelDO is a named export from its module source', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/registry/presence-channel-do.ts', 'utf8')
    expect(src).toContain('export class PresenceChannelDO')
    expect(src).toContain('acceptWebSocket')
    expect(src).toContain('fanOutWebSockets')
    expect(src).toContain('reciprocateWebSocketClose')
    expect(src).not.toMatch(/ws\.close\(code,\s*reason\)/)
    const entry = readFileSync('src/index.ts', 'utf8')
    expect(entry).toContain("export { PresenceChannelDO } from './registry/presence-channel-do'")
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
