import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classify,
  humanAge,
  busConfigured,
  resolveFleetProject,
  resolveFleetSender,
  resolveFleetOpsAgent,
  fleetScoped,
  loadFleet,
  wakeFleetAgent,
  requestFleetControl,
} from '../src/dashboard/fleet'
import type { Env } from '../src/types'

const NOW = 1_780_000_000_000

describe('classify', () => {
  it('null → never', () => expect(classify(null, NOW)).toBe('never'))
  it('5m ago → active', () => expect(classify(NOW - 5 * 60_000, NOW)).toBe('active'))
  it('exactly 10m → active boundary', () => expect(classify(NOW - 10 * 60_000, NOW)).toBe('active'))
  it('2h ago → idle', () => expect(classify(NOW - 2 * 3_600_000, NOW)).toBe('idle'))
  it('3d ago → dead', () => expect(classify(NOW - 3 * 86_400_000, NOW)).toBe('dead'))
})

describe('humanAge', () => {
  it('never on null', () => expect(humanAge(null, NOW)).toBe('never'))
  it('just now under a minute', () => expect(humanAge(NOW - 10_000, NOW)).toBe('just now'))
  it('minutes', () => expect(humanAge(NOW - 7 * 60_000, NOW)).toBe('7m ago'))
  it('hours', () => expect(humanAge(NOW - 5 * 3_600_000, NOW)).toBe('5h ago'))
  it('days past 48h', () => expect(humanAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago'))
})

describe('busConfigured (SOS compat shim)', () => {
  it('false without token', () => {
    expect(busConfigured({} as Env)).toBe(false)
  })
  it('true with leftover SOS token (routes must not call the bridge)', () => {
    expect(busConfigured({ BUS_TOKEN: 'x' } as Env)).toBe(true)
  })
})

// ── tenant-scoping (Flock #43) ────────────────────────────────────────────────
// The fleet window must scope to the pot's OWN project + ops agent. A tenant
// pot must never address the company `sos` fleet or route control to our `kasra`
// by accident. The project string is env-derived (never request-derived).

describe('resolveFleetProject', () => {
  it('explicit FLEET_PROJECT wins', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: 'sos', TENANT_SLUG: 'mumega' } as Env)).toBe('sos')
  })
  it('falls back to TENANT_SLUG for a tenant pot', () => {
    expect(resolveFleetProject({ TENANT_SLUG: 'digid' } as Env)).toBe('digid')
  })
  it('null when nothing set (fail closed, never sos)', () => {
    expect(resolveFleetProject({} as Env)).toBeNull()
  })
  it('null on blank/whitespace env (no silent company fallback)', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: '   ', TENANT_SLUG: '  ' } as Env)).toBeNull()
  })
  it('trims whitespace', () => {
    expect(resolveFleetProject({ FLEET_PROJECT: '  digid ' } as Env)).toBe('digid')
  })
  it('digid pot never resolves to the company sos project', () => {
    expect(resolveFleetProject({ TENANT_SLUG: 'digid', FLEET_PROJECT: 'digid' } as Env)).not.toBe('sos')
  })
})

describe('resolveFleetSender', () => {
  it('tenant-specific HQ id', () => {
    expect(resolveFleetSender({ TENANT_SLUG: 'digid' } as Env)).toBe('mupot-digid-hq')
  })
  it('company id from mumega slug', () => {
    expect(resolveFleetSender({ TENANT_SLUG: 'mumega' } as Env)).toBe('mupot-mumega-hq')
  })
  it('null when slug missing (fail closed)', () => {
    expect(resolveFleetSender({} as Env)).toBeNull()
  })
})

describe('resolveFleetOpsAgent', () => {
  it('explicit FLEET_OPS_AGENT wins', () => {
    expect(resolveFleetOpsAgent({ FLEET_OPS_AGENT: 'digid' } as Env)).toBe('digid')
  })
  it('null when unset (never falls back to kasra)', () => {
    expect(resolveFleetOpsAgent({} as Env)).toBeNull()
  })
  it('digid pot routes control to its own ops agent, never kasra', () => {
    expect(resolveFleetOpsAgent({ FLEET_OPS_AGENT: 'digid' } as Env)).not.toBe('kasra')
  })
})

describe('fleetScoped (CF-native — no BUS_TOKEN required)', () => {
  it('false when pot unscoped (no project/slug)', () => {
    expect(fleetScoped({} as Env)).toBe(false)
  })
  it('true with TENANT_SLUG even without SOS BUS_TOKEN', () => {
    expect(fleetScoped({ TENANT_SLUG: 'digid' } as Env)).toBe(true)
  })
  it('true when FLEET_PROJECT + TENANT_SLUG set', () => {
    expect(fleetScoped({ FLEET_PROJECT: 'digid', TENANT_SLUG: 'digid' } as Env)).toBe(true)
  })
})

function makeFleetDb(opts: {
  agents?: Array<{ id: string; squad_id: string; slug: string; name: string }>
  fleet?: Array<{
    agent_id: string
    display: string
    runtime: string
    status: string
    last_reported_at: string
    host?: string
  }>
  presence?: Array<{
    member_id: string
    display_name: string
    source: string
    label: string
    agent_id: string | null
    last_seen_at: string
    first_seen_at: string
  }>
  messages?: unknown[][]
}) {
  const messages = opts.messages ?? []
  const agents = opts.agents ?? []
  const fleet = opts.fleet ?? []
  const presence = opts.presence ?? []
  let seq = 0
  const db = {
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) {
          binds.push(...a)
          return api
        },
        async first<T>() {
          if (sql.includes('FROM agents') && sql.includes('WHERE id = ?1')) {
            const row = agents.find((a) => a.id === binds[0])
            return (row ?? null) as T
          }
          if (sql.includes('FROM agents') && sql.includes('WHERE slug = ?1')) {
            return null as T
          }
          if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
            return null as T
          }
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM agents') && sql.includes('WHERE slug = ?1')) {
            const rows = agents.filter((a) => a.slug === binds[0])
            return { results: rows as T[] }
          }
          if (sql.includes('FROM fleet_agents')) {
            return {
              results: fleet.map((f) => ({
                agent_id: f.agent_id,
                display: f.display,
                runtime: f.runtime,
                squads: '[]',
                lifecycle: '',
                status: f.status,
                last_reported_at: f.last_reported_at,
                host: f.host ?? '',
              })) as T[],
            }
          }
          if (sql.includes('FROM presence')) {
            return { results: presence as T[] }
          }
          if (sql.includes('FROM flights')) {
            return { results: [] as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          if (sql.includes('INSERT INTO agent_messages')) {
            seq += 1
            messages.push(binds)
            return { meta: { last_row_id: seq, changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
      }
      return api
    },
  }
  return { db, messages }
}

describe('loadFleet — CF-native roster (no SOS HTTP)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch bus.mumega.com', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db } = makeFleetDb({
      fleet: [
        {
          agent_id: 'agent-kasra',
          display: 'Kasra',
          runtime: 'tmux',
          status: 'running',
          last_reported_at: '2026-07-22 07:00:00',
        },
      ],
    })
    const env = { TENANT_SLUG: 'mumega', DB: db } as unknown as Env
    const rows = await loadFleet(env, Date.parse('2026-07-22T07:01:00Z'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe('agent-kasra')
    expect(rows[0].liveness).toBe('active')
  })

  it('falls back to presence check-ins when fleet_agents is empty', async () => {
    const { db } = makeFleetDb({
      presence: [
        {
          member_id: 'mbr-1',
          display_name: 'Cursor',
          source: 'claude-code',
          label: 'build',
          agent_id: 'agent-cursor',
          last_seen_at: '2026-07-22 07:00:00',
          first_seen_at: '2026-07-22 06:00:00',
        },
      ],
    })
    const env = { TENANT_SLUG: 'mumega', DB: db } as unknown as Env
    const rows = await loadFleet(env, Date.parse('2026-07-22T07:01:00Z'))
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe('agent-cursor')
  })
})

describe('wakeFleetAgent / requestFleetControl — agent_messages path', () => {
  it('wake writes agent_messages and does not call SOS fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db, messages } = makeFleetDb({
      agents: [{ id: 'id-kasra', squad_id: 'squad-core', slug: 'kasra', name: 'Kasra' }],
    })
    const queue: unknown[] = []
    const env = {
      TENANT_SLUG: 'mumega',
      DB: db,
      BUS: { send: async (e: unknown) => { queue.push(e) } },
    } as unknown as Env
    const ok = await wakeFleetAgent(env, 'kasra', {
      memberId: 'mbr-admin',
      boundAgentId: null,
      label: 'admin@test',
    })
    expect(ok).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0][2]).toBe('id-kasra') // to_agent
    expect(fetchMock).not.toHaveBeenCalled()
    expect(queue).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('control refuses when FLEET_OPS_AGENT unset', async () => {
    const { db } = makeFleetDb({})
    const env = { TENANT_SLUG: 'mumega', DB: db } as unknown as Env
    const r = await requestFleetControl(env, 'kasra', 'pause', {
      memberId: 'mbr-admin',
      boundAgentId: null,
      label: 'admin@test',
    })
    expect(r).toEqual({ ok: false, error: 'fleet_not_scoped' })
  })

  it('control sends a receipted request to the ops agent', async () => {
    const { db, messages } = makeFleetDb({
      agents: [{ id: 'id-ops', squad_id: 'squad-core', slug: 'kasra', name: 'Kasra' }],
    })
    const env = {
      TENANT_SLUG: 'mumega',
      FLEET_OPS_AGENT: 'kasra',
      DB: db,
    } as unknown as Env
    const r = await requestFleetControl(env, 'cursor', 'pause', {
      memberId: 'mbr-admin',
      boundAgentId: null,
      label: 'admin@test',
    })
    expect(r.ok).toBe(true)
    expect(r.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0][2]).toBe('id-ops')
    expect(String(messages[0][6])).toContain('PAUSE')
  })
})
