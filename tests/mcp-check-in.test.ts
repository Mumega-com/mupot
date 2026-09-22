import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-1'

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'member@example.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [],
    ...overrides,
  }
}

function makeEnv(opts: { debounced?: boolean; memberRow?: { display_name: string; email: string | null } | null } = {}) {
  const writes: unknown[][] = []
  const fleetUpserts: unknown[][] = []
  const fleetTouches: unknown[][] = []
  const kv: { get: string[]; put: Array<{ key: string; value: string; opts: { expirationTtl: number } }> } = {
    get: [],
    put: [],
  }
  const memberRow = opts.memberRow === undefined
    ? { display_name: 'Kasra Code', email: 'code@example.com' }
    : opts.memberRow

  const env = {
    TENANT_SLUG: TENANT,
    SESSIONS: {
      async get(key: string) {
        kv.get.push(key)
        return opts.debounced ? '1' : null
      },
      async put(key: string, value: string, putOpts: { expirationTtl: number }) {
        kv.put.push({ key, value, opts: putOpts })
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM members WHERE id = ?1')) return memberRow
                return null
              },
              async run() {
                if (sql.includes('INSERT INTO presence')) writes.push(args)
                // upsertPollFleetPresence (mupot#1494 establish) vs touchPollFleetPresence
                // (mupot#1494 refresh-only) — distinct SQL shapes, captured separately so
                // tests can assert exactly which one fired.
                if (sql.includes('INSERT INTO fleet_agents')) fleetUpserts.push(args)
                else if (sql.includes('UPDATE fleet_agents') && sql.includes("presence_mode = 'poll'")) {
                  fleetTouches.push(args)
                }
                return { meta: { changes: 1 } }
              },
              async all() {
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, writes, kv, fleetUpserts, fleetTouches }
}

describe('MCP check_in tool', () => {
  it('is advertised on the MCP surface', () => {
    expect(TOOLS.map((t) => t.name)).toContain('check_in')
  })

  it('records pot-native presence using authenticated member identity, not args', async () => {
    const { env, writes, kv } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'check_in',
      { source: 'codex', label: 'primary runtime' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect((res.result as { ok: boolean; agent: string; agent_id: string | null; debounced: boolean })).toMatchObject({
      ok: true,
      agent: 'Kasra Code',
      agent_id: AGENT_ID,
      debounced: false,
    })
    expect(kv.get).toEqual([`checkin:${TENANT}:${MEMBER_ID}:primary runtime`])
    expect(kv.put).toEqual([
      { key: `checkin:${TENANT}:${MEMBER_ID}:primary runtime`, value: '1', opts: { expirationTtl: 30 } },
    ])
    expect(writes).toHaveLength(1)
    expect(writes[0].slice(0, 6)).toEqual([
      TENANT,
      MEMBER_ID,
      'Kasra Code',
      'codex',
      'primary runtime',
      AGENT_ID,
    ])
  })

  it('debounces rapid repeats without touching the presence table', async () => {
    const { env, writes, kv } = makeEnv({ debounced: true })

    const res = await invokeTool(auth(), env, 'check_in', { source: 'hermes' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect((res.result as { debounced: boolean }).debounced).toBe(true)
    expect(kv.get).toEqual([`checkin:${TENANT}:${MEMBER_ID}`])
    expect(kv.put).toEqual([])
    expect(writes).toEqual([])
  })

  it('normalizes unknown source and caps label through the shared presence service', async () => {
    const { env, writes } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'check_in',
      { source: 'evil-runtime', label: 'x'.repeat(500) },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect(writes[0][3]).toBe('unknown')
    expect((writes[0][4] as string).length).toBe(120)
  })

  it('refuses a principal with no member id', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(
      auth({ memberId: undefined, capabilities: [] }),
      env,
      'check_in',
      {},
      'https://pot.example',
    )

    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_member_bound')
  })

  // mupot#1494 — poll-mode presence: a runner with no resident heartbeat daemon declares its
  // delivery cadence so task_dispatch can route it inbox work without a 180s heartbeat.
  describe('presence_mode: poll (mupot#1494)', () => {
    it('establishes a poll-mode fleet row keyed by the caller\'s OWN agent id, and echoes the derived TTL', async () => {
      const { env, fleetUpserts } = makeEnv()

      const res = await invokeTool(
        auth(),
        env,
        'check_in',
        { presence_mode: 'poll', poll_interval_sec: 300 },
        'https://pot.example',
      )

      expect(res.ok).toBe(true)
      expect(res.result).toMatchObject({
        ok: true,
        presence_mode: 'poll',
        poll_interval_sec: 300,
        presence_ttl_sec: 600, // 2 * 300
      })
      expect(fleetUpserts).toHaveLength(1)
      // upsertPollFleetPresence.bind(agentId, tenant, display, memberId, ttlSec)
      expect(fleetUpserts[0]).toEqual([AGENT_ID, TENANT, 'Kasra Code', MEMBER_ID, 600])
    })

    it('clamps an out-of-bounds poll_interval_sec instead of storing it verbatim (bounded TTL derivation)', async () => {
      const { env } = makeEnv()

      const tooSmall = await invokeTool(
        auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 1 }, 'https://pot.example',
      )
      expect(tooSmall.ok).toBe(true)
      expect(tooSmall.result).toMatchObject({ poll_interval_sec: 60, presence_ttl_sec: 180 })

      const tooLarge = await invokeTool(
        auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 999_999 }, 'https://pot.example',
      )
      expect(tooLarge.ok).toBe(true)
      expect(tooLarge.result).toMatchObject({ poll_interval_sec: 3600, presence_ttl_sec: 7200 })
    })

    it('defaults poll_interval_sec to 300s when omitted', async () => {
      const { env } = makeEnv()

      const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll' }, 'https://pot.example')

      expect(res.ok).toBe(true)
      expect(res.result).toMatchObject({ poll_interval_sec: 300, presence_ttl_sec: 600 })
    })

    it('refuses presence_mode: poll for a caller with no agent-bound credential', async () => {
      const { env } = makeEnv()

      const res = await invokeTool(
        auth({ boundAgentId: undefined }),
        env,
        'check_in',
        { presence_mode: 'poll' },
        'https://pot.example',
      )

      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid_args')
    })

    it('rejects an unknown presence_mode value (validateArgs does not enforce enum; the tool must)', async () => {
      const { env } = makeEnv()

      const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'always-on' }, 'https://pot.example')

      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid_args')
    })

    it('presence_mode: resident does not establish a poll-mode fleet row (resident semantics unchanged)', async () => {
      const { env, fleetUpserts } = makeEnv()

      const res = await invokeTool(
        auth(), env, 'check_in', { presence_mode: 'resident' }, 'https://pot.example',
      )

      expect(res.ok).toBe(true)
      expect(res.result).not.toHaveProperty('presence_mode')
      expect(fleetUpserts).toHaveLength(0)
    })

    it('a plain check_in (no presence_mode) still attempts the cheap poll-touch, never the establishing upsert', async () => {
      const { env, fleetUpserts, fleetTouches } = makeEnv()

      const res = await invokeTool(auth(), env, 'check_in', { source: 'codex' }, 'https://pot.example')

      expect(res.ok).toBe(true)
      expect(fleetUpserts).toHaveLength(0)
      expect(fleetTouches).toHaveLength(1)
      expect(fleetTouches[0]).toEqual([TENANT, AGENT_ID])
    })
  })
})
