// mupot#1765 — harness capacity snapshots. Real schema (createSqliteD1 + applyAllMigrations), tools via mcpApp.
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpApp } from '../src/mcp/index'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { dispatchFlight } from '../src/flight/dispatch'
import { CAPACITY_FRESH_MS, isSaturated, toView, type CapacityRow } from '../src/harness/capacity'
import type { AuthContext, Env } from '../src/types'
import type { FlightSignals } from '../src/flight/preflight'

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

function setup(): { h: SqliteD1Harness; env: Env } {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'operator', 'test', 'active'),
      ('agent-b', 'squad-a', 'agent-b', 'Agent B', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-agent-a', 'a@test.com', 'A', 'active', 'mumega'), ('m-agent-b', 'b@test.com', 'B', 'active', 'mumega'), ('m-none', 'n@test.com', 'N', 'active', 'mumega');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-a', 'm-agent-a', 'squad', 'squad-a', 'member'), ('cap-b', 'm-agent-b', 'squad', 'squad-a', 'member'), ('cap-n', 'm-none', 'squad', 'squad-a', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('mumega', 'agent-a', 'm-agent-a', datetime('now')), ('mumega', 'agent-b', 'm-agent-b', datetime('now'));
  `)
  harness = h
  return { h, env: { DB: h.db, TENANT_SLUG: 'mumega' } as unknown as Env }
}

const authFor = (agent: string | undefined): AuthContext => ({
  userId: agent ? `m-${agent}` : 'm-none', tenant: 'mumega', channel: 'workspace', memberId: agent ? `m-${agent}` : 'm-none', role: 'member',
  ...(agent ? { boundAgentId: agent } : {}),
  capabilities: [{ scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
})

function call(tool: string, args: Record<string, unknown>, auth: AuthContext): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
    body: JSON.stringify({ tool, args }),
  })
}

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  harness: 'orca', host_key: 'hadi-mac', observed_at: Date.now(),
  live_terminals: 5, agent_sessions: 3, busy_recent: 1, orphaned_terminals: 0,
  workers_active: 0, workers_release_unknown: 0, worktrees_with_live: 2, ...over,
})

async function report(env: Env, args: Record<string, unknown>, auth: AuthContext): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await mcpApp.fetch(call('harness_capacity_report', args, auth), env)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const count = (h: SqliteD1Harness): number =>
  (h.sqlite.prepare('SELECT COUNT(*) AS n FROM harness_capacity_snapshots').get() as { n: number }).n

describe('harness_capacity_report', () => {
  it('upsert is idempotent: one row per (harness, host, reporter), latest wins', async () => {
    const { h, env } = setup()
    expect((await report(env, base({ agent_sessions: 3 }), authFor('agent-a'))).status).toBe(200)
    expect((await report(env, base({ agent_sessions: 7 }), authFor('agent-a'))).status).toBe(200)
    expect(count(h)).toBe(1)
    const row = h.sqlite.prepare('SELECT agent_sessions, reporter_agent_id FROM harness_capacity_snapshots').get() as { agent_sessions: number; reporter_agent_id: string }
    expect(row).toEqual({ agent_sessions: 7, reporter_agent_id: 'agent-a' })
  })

  it('a different reporter or host gets its own row', async () => {
    const { h, env } = setup()
    await report(env, base(), authFor('agent-a'))
    await report(env, base(), authFor('agent-b'))
    await report(env, base({ host_key: 'mumega-vps', harness: 'herdr' }), authFor('agent-a'))
    expect(count(h)).toBe(3)
  })

  it('an out-of-order (older observed_at) report does not overwrite newer data', async () => {
    const { h, env } = setup()
    const t = Date.now()
    await report(env, base({ observed_at: t, agent_sessions: 9 }), authFor('agent-a'))
    await report(env, base({ observed_at: t - 60_000, agent_sessions: 1 }), authFor('agent-a'))
    expect((h.sqlite.prepare('SELECT agent_sessions AS n FROM harness_capacity_snapshots').get() as { n: number }).n).toBe(9)
  })

  it('unbound caller is refused and nothing is written', async () => {
    const { h, env } = setup()
    const r = await report(env, base(), authFor(undefined))
    expect(r.status).toBe(403)
    expect(count(h)).toBe(0)
  })

  it('reporter cannot name another agent: reporter_agent_id arg is rejected, row is the caller', async () => {
    const { h, env } = setup()
    const spoof = await report(env, base({ reporter_agent_id: 'agent-b' }), authFor('agent-a'))
    expect(spoof.status).toBe(400)
    expect(count(h)).toBe(0)
    await report(env, base(), authFor('agent-a'))
    expect((h.sqlite.prepare('SELECT reporter_agent_id AS r FROM harness_capacity_snapshots').get() as { r: string }).r).toBe('agent-a')
  })

  it.each([
    ['bad harness', { harness: 'tmux' }],
    ['bad host_key (path)', { host_key: '../etc/passwd' }],
    ['bad host_key (upper/space)', { host_key: 'Hadi Mac' }],
    ['negative count', { live_terminals: -1 }],
    ['fractional count', { agent_sessions: 1.5 }],
    ['string count', { busy_recent: '3' }],
    ['huge count', { workers_active: 1e12 }],
    ['future observed_at', { observed_at: Date.now() + 3_600_000 }],
    ['summary with text value', { summary: { note: 'rm -rf / token sk-123' } }],
    ['summary with bad key', { summary: { 'Free Text Key!': 1 } }],
    ['summary too many keys', { summary: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) }],
    ['summary nested', { summary: { a: { b: 1 } } }],
    ['negative max_agents', { max_agents: -1 }],
  ])('rejects %s', async (_n, over) => {
    const { h, env } = setup()
    const r = await report(env, base(over), authFor('agent-a'))
    expect(r.status).toBe(400)
    expect(count(h)).toBe(0)
  })

  it('DB CHECK constraints refuse negative counts and oversize summary even if code were bypassed', () => {
    const { h } = setup()
    const ins = (cols: string): void => {
      h.sqlite.exec(`INSERT INTO harness_capacity_snapshots (id, tenant, harness, host_key, reporter_agent_id, observed_at, received_at, live_terminals, agent_sessions, busy_recent, orphaned_terminals, workers_active, workers_release_unknown, worktrees_with_live, summary_json) VALUES (${cols})`)
    }
    expect(() => ins("'x','mumega','orca','h','agent-a',1,1,-1,0,0,0,0,0,0,'{}'")).toThrow()
    expect(() => ins("'y','mumega','tmux','h','agent-a',1,1,0,0,0,0,0,0,0,'{}'")).toThrow()
    expect(() => ins(`'z','mumega','orca','h','agent-a',1,1,0,0,0,0,0,0,0,'${'a'.repeat(5000)}'`)).toThrow()
  })
})

describe('harness_capacity_list freshness + saturation', () => {
  const row = (over: Partial<CapacityRow>): CapacityRow => ({
    id: 'i', tenant: 'mumega', harness: 'orca', host_key: 'h', reporter_agent_id: 'a', observed_at: 0, received_at: 0,
    live_terminals: 0, agent_sessions: 0, busy_recent: 0, orphaned_terminals: 0, workers_active: 0,
    workers_release_unknown: 0, worktrees_with_live: 0, max_agents: null, summary_json: '{}', ...over,
  })
  const NOW = 10_000_000

  it('math: fresh boundary, saturated needs max_agents and sessions >= max', () => {
    expect(toView(row({ received_at: NOW - CAPACITY_FRESH_MS }), NOW).fresh).toBe(true)
    expect(toView(row({ received_at: NOW - CAPACITY_FRESH_MS - 1 }), NOW).fresh).toBe(false)
    expect(isSaturated({ max_agents: null, agent_sessions: 99 })).toBe(false)
    expect(isSaturated({ max_agents: 4, agent_sessions: 3 })).toBe(false)
    expect(isSaturated({ max_agents: 4, agent_sessions: 4 })).toBe(true)
    expect(isSaturated({ max_agents: 0, agent_sessions: 0 })).toBe(true)
  })

  it('stale snapshot is never saturated (unknown, not a verdict) and keeps its counts', () => {
    const v = toView(row({ received_at: 0, max_agents: 2, agent_sessions: 9 }), NOW)
    expect(v.fresh).toBe(false)
    expect(v.saturated).toBe(false)
  })

  it('list tool end to end through the real report path', async () => {
    const { env } = setup()
    await report(env, base({ agent_sessions: 4, max_agents: 4 }), authFor('agent-a'))
    await report(env, base({ host_key: 'other', agent_sessions: 1, max_agents: 4 }), authFor('agent-a'))
    const res = await mcpApp.fetch(call('harness_capacity_list', {}, authFor('agent-a')), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { snapshots: Array<{ host_key: string; fresh: boolean; saturated: boolean }> } }
    const by = Object.fromEntries(body.result.snapshots.map((s) => [s.host_key, s]))
    expect(by['hadi-mac']).toMatchObject({ fresh: true, saturated: true })
    expect(by.other).toMatchObject({ fresh: true, saturated: false })
    const bad = await mcpApp.fetch(call('harness_capacity_list', { harness: 'tmux' }, authFor('agent-a')), env)
    expect(bad.status).toBe(400)
  })
})

describe('dispatch advisory (non-blocking)', () => {
  const SIGNALS: FlightSignals = {
    contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 1_000_000, budgetEstimateMicroUsd: 1000,
    recentProgress: 0.9, progressPerStep: 0.9, wastePerStep: 0.1, stepSeconds: 30,
  }
  const flight = { agent: 'agent-a', goal: 'g', trigger_source: 'manual' as const, budget_micro_usd: 1000 }
  const put = (h: SqliteD1Harness, receivedAgo: number, sessions: number, max: number | null): void => {
    h.sqlite.prepare(
      `INSERT INTO harness_capacity_snapshots (id, tenant, harness, host_key, reporter_agent_id, observed_at, received_at, live_terminals, agent_sessions, busy_recent, orphaned_terminals, workers_active, workers_release_unknown, worktrees_with_live, max_agents, summary_json)
       VALUES ('s', 'mumega', 'orca', 'hadi-mac', 'agent-a', ?1, ?1, 0, ?2, 0, 0, 0, 0, 0, ?3, '{}')`,
    ).run(Date.now() - receivedAgo, sessions, max)
  }

  it('fresh + saturated: advisory present, dispatch still GO', async () => {
    const { h, env } = setup()
    put(h, 1000, 4, 4)
    const r = await dispatchFlight(env, flight, SIGNALS)
    expect(r.advisories).toEqual(['harness_capacity_saturated:orca:hadi-mac'])
    expect(r.go).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('fresh but under ceiling, no ceiling, or stale-saturated: no advisory', async () => {
    for (const [ago, sessions, max] of [[1000, 3, 4], [1000, 99, null], [CAPACITY_FRESH_MS + 60_000, 9, 4]] as const) {
      const { h, env } = setup()
      put(h, ago, sessions, max)
      const r = await dispatchFlight(env, flight, SIGNALS)
      expect(r.advisories).toBeUndefined()
      expect(r.go).toBe(true)
      harness?.close(); harness = undefined
    }
  })

  it('advisory read failure never breaks dispatch', async () => {
    const { h, env } = setup()
    h.sqlite.exec('DROP TABLE harness_capacity_snapshots')
    const r = await dispatchFlight(env, flight, SIGNALS)
    expect(r.go).toBe(true)
    expect(r.advisories).toBeUndefined()
  })
})
