// tests/fleet-registry.test.ts — fleet agent registry (Deliverable 2 panel data layer).
// The report/list service + the /report (consumer-only) and /agents routes.
import { describe, it, expect, beforeAll } from 'vitest'
import { reportFleetAgents, listFleetAgents } from '../src/fleet/registry'
import { fleetControlApp } from '../src/fleet/control-routes'
import type { Env } from '../src/types'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface FleetRow {
  agent_id: string; tenant: string; display: string; runtime: string; squads: string
  lifecycle: string; provider_contract: string | null; status: string; reported_by: string; last_reported_at: string
}
interface TokenRow { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }

function makeDb(tokens: Record<string, TokenRow> = {}) {
  const fleet = new Map<string, FleetRow>()
  function first(sql: string, b: unknown[]) {
    if (sql.includes('FROM member_tokens t')) return tokens[b[0] as string] ?? null
    throw new Error('unhandled first: ' + sql)
  }
  function all(sql: string, b: unknown[]) {
    if (sql.includes('FROM fleet_agents')) {
      const [tenant] = b as [string]
      return [...fleet.values()].filter((r) => r.tenant === tenant).sort((x, y) => (x.agent_id < y.agent_id ? -1 : 1))
    }
    throw new Error('unhandled all: ' + sql)
  }
  function run(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO fleet_agents')) {
      const [agent_id, tenant, display, runtime, squads, lifecycle, pc, status, reported_by] = b as string[]
      fleet.set(agent_id, {
        agent_id, tenant, display, runtime, squads, lifecycle,
        provider_contract: (pc as string | null) ?? null, status, reported_by, last_reported_at: 'now',
      })
      return { meta: { changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }
  const db = {
    _fleet: fleet,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return first(sql, binds) as T },
        async all<T>() { return { results: all(sql, binds) as T[] } },
        async run() { return run(sql, binds) },
      }
      return api
    },
  }
  return db
}

function env(db: ReturnType<typeof makeDb>, over: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 't', DB: db, FLEET_CONSUMER_AGENT: 'fleet-consumer', ...over } as unknown as Env
}

const GOOD = { agent_id: 'image-gen', display: 'Image Gen', runtime: 'codex', squads: ['media'], lifecycle: 'on_demand', provider_contract: 'openai', status: 'stopped' }

// ── service ─────────────────────────────────────────────────────────────────────
describe('reportFleetAgents / listFleetAgents', () => {
  it('upserts a valid batch and lists it', async () => {
    const db = makeDb()
    const r = await reportFleetAgents(env(db), 'fleet-consumer', [GOOD, { agent_id: 'mumega-brain', status: 'running' }])
    expect(r).toEqual({ ok: true, count: 2 })
    const rows = await listFleetAgents(env(db))
    expect(rows.map((x) => x.agent_id)).toEqual(['image-gen', 'mumega-brain'])
    expect(rows[0].squads).toEqual(['media'])
    expect(rows[0].status).toBe('stopped')
  })

  it('upsert updates status on a second report', async () => {
    const db = makeDb()
    await reportFleetAgents(env(db), 'fleet-consumer', [GOOD])
    await reportFleetAgents(env(db), 'fleet-consumer', [{ ...GOOD, status: 'running' }])
    const rows = await listFleetAgents(env(db))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('running')
  })

  it('rejects a malformed batch wholesale (never silent-drops)', async () => {
    const db = makeDb()
    expect(await reportFleetAgents(env(db), 'c', [{ agent_id: '../evil', status: 'running' }])).toEqual({ ok: false, reason: 'invalid agent in batch' })
    expect(await reportFleetAgents(env(db), 'c', [{ agent_id: 'ok', status: 'bogus' }])).toEqual({ ok: false, reason: 'invalid agent in batch' })
    expect(await reportFleetAgents(env(db), 'c', 'nope')).toEqual({ ok: false, reason: 'agents must be an array' })
    expect(db._fleet.size).toBe(0)
  })

  it('caps the batch size', async () => {
    const db = makeDb()
    const many = Array.from({ length: 201 }, (_, i) => ({ agent_id: `a${i}`, status: 'unknown' }))
    expect((await reportFleetAgents(env(db), 'c', many)).ok).toBe(false)
  })
})

// ── routes ──────────────────────────────────────────────────────────────────────
const CONSUMER = 'consumer-token'
const OTHER = 'other-token'
let consumerHash = ''
let otherHash = ''
beforeAll(async () => {
  consumerHash = await sha256Hex(CONSUMER)
  otherHash = await sha256Hex(OTHER)
})

function routeDb() {
  return makeDb({
    [consumerHash]: { member_id: 'm-c', display_name: 'Daemon', email: null, status: 'active', bound_agent_id: 'fleet-consumer' },
    [otherHash]: { member_id: 'm-o', display_name: 'Other', email: null, status: 'active', bound_agent_id: 'kasra' },
  })
}

function req(app: typeof fleetControlApp, path: string, method: string, token: string | null, body: unknown, e: Env) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return app.request(path, init, e)
}

describe('POST /api/fleet/report + GET /agents', () => {
  it('report 401 without token, 403 for a non-consumer agent', async () => {
    const db = routeDb()
    expect((await req(fleetControlApp, '/report', 'POST', null, { agents: [] }, env(db))).status).toBe(401)
    expect((await req(fleetControlApp, '/report', 'POST', OTHER, { agents: [GOOD] }, env(db))).status).toBe(403)
  })

  it('report 403 when FLEET_CONSUMER_AGENT is unset', async () => {
    const db = routeDb()
    const res = await req(fleetControlApp, '/report', 'POST', CONSUMER, { agents: [GOOD] }, env(db, { FLEET_CONSUMER_AGENT: undefined }))
    expect(res.status).toBe(403)
  })

  it('report 200 from the consumer, then /agents lists it', async () => {
    const db = routeDb()
    const e = env(db)
    const res = await req(fleetControlApp, '/report', 'POST', CONSUMER, { agents: [GOOD] }, e)
    expect(res.status).toBe(200)
    const list = await req(fleetControlApp, '/agents', 'GET', CONSUMER, undefined, e)
    const json = (await list.json()) as { ok: boolean; agents: Array<{ agent_id: string }> }
    expect(json.ok).toBe(true)
    expect(json.agents[0].agent_id).toBe('image-gen')
  })

  it('report 413 on an oversized body', async () => {
    const db = routeDb()
    const huge = JSON.stringify({ agents: [], pad: 'x'.repeat(70000) })
    const res = await req(fleetControlApp, '/report', 'POST', CONSUMER, huge, env(db))
    expect(res.status).toBe(413)
  })

  it('report 400 on invalid batch (bad status)', async () => {
    const db = routeDb()
    const res = await req(fleetControlApp, '/report', 'POST', CONSUMER, { agents: [{ agent_id: 'x', status: 'nope' }] }, env(db))
    expect(res.status).toBe(400)
  })

  it('agents 401 without a token', async () => {
    expect((await req(fleetControlApp, '/agents', 'GET', null, undefined, env(routeDb()))).status).toBe(401)
  })
})
