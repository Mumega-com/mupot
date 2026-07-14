// tests/fleet-agent-liveness.test.ts — getFleetAgentRuntime / getFleetAgentLiveness
// (S353 v2, src/fleet/registry.ts).
//
// These read through the agents.id ↔ fleet_agents.agent_id identifier-space bridge: task
// assignment (and so every task_dispatch wake) always carries `agents.id` (a uuid), but the
// fleet-attach / signed-inbox surface is keyed by `agents.slug` — confirmed against the live
// mumega tenant DB (2026-07-14): kasra's `agents.id` is a uuid, `agents.slug='kasra'`, and its
// `fleet_agents.agent_id` / `agent_keys.agent_id` are BOTH `'kasra'`, never the uuid. Without
// the JOIN these functions do, a fleet-row read keyed directly on the caller's `agentId` would
// NEVER match a real external runtime's row. The mock below models BOTH tables (not just a flat
// fleet_agents map) so these tests exercise that exact join, not a simplification of it.

import { describe, it, expect } from 'vitest'
import { getFleetAgentRuntime, getFleetAgentLiveness, DEFAULT_PRESENCE_TTL_SEC } from '../src/fleet/registry'
import type { Env } from '../src/types'

interface AgentRow { id: string; slug: string }
interface FleetRow { agent_id: string; tenant: string; runtime: string; status: string; last_reported_at: string }

function makeDb(agents: AgentRow[] = [], fleet: FleetRow[] = []) {
  function first(sql: string, b: unknown[]) {
    if (sql.includes('FROM agents a') && sql.includes('LEFT JOIN fleet_agents')) {
      const [tenant, agentIdParam] = b as [string, string]
      const agent = agents.find((a) => a.id === agentIdParam)
      if (!agent) return null // WHERE a.id = ?2 matched nothing
      const matches = fleet
        .filter((f) => f.tenant === tenant && (f.agent_id === agent.id || f.agent_id === agent.slug))
        .sort((x, y) => (x.last_reported_at < y.last_reported_at ? 1 : -1)) // ORDER BY last_reported_at DESC
      const row = matches[0]
      // LEFT JOIN: the agents row always "exists" even with no fleet match — but a fleet-agent_id
      // column selected from a non-matching LEFT JOIN would be NULL, and getFleetAgentLiveness/
      // getFleetAgentRuntime both treat a null/empty runtime as "no external runtime" regardless.
      return row
        ? { agent_id: row.agent_id, runtime: row.runtime, status: row.status, last_reported_at: row.last_reported_at }
        : { agent_id: null, runtime: null, status: null, last_reported_at: null }
    }
    throw new Error('unhandled first: ' + sql)
  }
  return {
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return first(sql, binds) as T },
      }
      return api
    },
  }
}

function env(db: ReturnType<typeof makeDb>, over: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 't', DB: db, ...over } as unknown as Env
}

// SQLite datetime('now')-shaped UTC stamp (no 'T', no 'Z') — matches derivePresence's parsing.
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

const KASRA_UUID = 'ea2b0370-ff27-4371-9581-5bcaf322baa7'
const now = Date.parse('2026-07-14T12:00:00.000Z')

describe('getFleetAgentRuntime — id ↔ slug bridge', () => {
  it('resolves through agents.slug: the caller passes agents.id (uuid), the fleet row is keyed by slug', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: 'claude-code', status: 'running', last_reported_at: utcStamp(now) }],
    )
    expect(await getFleetAgentRuntime(env(db), KASRA_UUID)).toBe('claude-code')
  })

  it('also matches a fleet row keyed directly by the uuid (forward-compatible)', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: KASRA_UUID, tenant: 't', runtime: 'codex', status: 'running', last_reported_at: utcStamp(now) }],
    )
    expect(await getFleetAgentRuntime(env(db), KASRA_UUID)).toBe('codex')
  })

  it('returns empty string when no agents row matches the caller\'s id at all', async () => {
    const db = makeDb()
    expect(await getFleetAgentRuntime(env(db), 'ghost-uuid')).toBe('')
  })

  it('returns empty string when the agent exists but has no fleet_agents row', async () => {
    const db = makeDb([{ id: KASRA_UUID, slug: 'kasra' }], [])
    expect(await getFleetAgentRuntime(env(db), KASRA_UUID)).toBe('')
  })

  it('returns empty string for an empty runtime column', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: '', status: 'unknown', last_reported_at: '' }],
    )
    expect(await getFleetAgentRuntime(env(db), KASRA_UUID)).toBe('')
  })
})

describe('getFleetAgentLiveness', () => {
  it('no matching agents row → not external, not live, no delivery target', async () => {
    const db = makeDb()
    expect(await getFleetAgentLiveness(env(db), 'ghost-uuid', now)).toEqual({ runtime: '', live: false, agentId: '' })
  })

  it('agent exists, no fleet row → not external', async () => {
    const db = makeDb([{ id: KASRA_UUID, slug: 'kasra' }], [])
    expect(await getFleetAgentLiveness(env(db), KASRA_UUID, now)).toEqual({ runtime: '', live: false, agentId: '' })
  })

  it('external + running + within TTL → live, and reports the SLUG as the delivery target (not the caller\'s uuid)', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: 'claude-code', status: 'running', last_reported_at: utcStamp(now - 5_000) }],
    )
    expect(await getFleetAgentLiveness(env(db), KASRA_UUID, now)).toEqual({ runtime: 'claude-code', live: true, agentId: 'kasra' })
  })

  it('external + running but beyond TTL → not live (stale)', async () => {
    const staleMs = now - (DEFAULT_PRESENCE_TTL_SEC + 60) * 1000
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: 'claude-code', status: 'running', last_reported_at: utcStamp(staleMs) }],
    )
    expect(await getFleetAgentLiveness(env(db), KASRA_UUID, now)).toEqual({ runtime: 'claude-code', live: false, agentId: 'kasra' })
  })

  it('external + status=stopped → not live even with a fresh heartbeat (intent wins over recency)', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: 'claude-code', status: 'stopped', last_reported_at: utcStamp(now) }],
    )
    expect(await getFleetAgentLiveness(env(db), KASRA_UUID, now)).toEqual({ runtime: 'claude-code', live: false, agentId: 'kasra' })
  })

  it('tenant-scoped: a slug-matching fleet row in a different tenant is invisible', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 'other', runtime: 'claude-code', status: 'running', last_reported_at: utcStamp(now) }],
    )
    expect(await getFleetAgentLiveness(env(db, { TENANT_SLUG: 't' }), KASRA_UUID, now)).toEqual({ runtime: '', live: false, agentId: '' })
  })

  it('defaults nowMs to Date.now() when omitted', async () => {
    const db = makeDb(
      [{ id: KASRA_UUID, slug: 'kasra' }],
      [{ agent_id: 'kasra', tenant: 't', runtime: 'claude-code', status: 'running', last_reported_at: utcStamp(Date.now()) }],
    )
    const result = await getFleetAgentLiveness(env(db), KASRA_UUID)
    expect(result).toEqual({ runtime: 'claude-code', live: true, agentId: 'kasra' })
  })
})
