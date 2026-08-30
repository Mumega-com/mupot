// tests/dashboard-dispatch-picker.test.ts — Flight-008 Slice 3 (mupot#1062):
// disambiguated /send dispatch-now agent picker.
//
// THE DEFECT (mupot#1062): the /send "Dispatch now" picker offered every
// `agents.status='active'` row regardless of whether a real runtime was ever
// behind it — a not-runtime/unattached/stale-seat identity could be picked and
// "dispatched" (agent.wake fired) into the void. It also defaulted to whichever
// agent sorted first alphabetically by (squad_name, agent_name), with no
// indication that was happening.
//
// THE FIX: loadDispatchableAgents (src/dashboard/index.ts) narrows to agents
// with a LIVE runtime right now, reusing getFleetAgentRuntimeStates VERBATIM —
// the SAME dual-surface (fleet_agents ∪ module_registry) presence primitive the
// routine scheduler uses (mupot#732's either-surface fix) — never a reinvented
// liveness notion. pickDispatchDefault only ever pre-selects when exactly one
// live candidate exists, and always returns a human-readable reason.
//
// These tests execute REAL SQL against the full committed migration chain
// (tests/helpers/migrations.ts) — a hand-rolled schema would not catch a query
// naming a column production doesn't have (mupot#684).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  loadDispatchableAgents,
  pickDispatchDefault,
  isLiveRuntimeState,
  sendPageBody,
  type DispatchableAgent,
} from '../src/dashboard/index'
import type { FleetAgentRuntimeState } from '../src/fleet/registry'
import type { Env } from '../src/types'

const TENANT = 'tenant-a'
const NOW = Date.parse('2026-08-16T12:00:00Z')

// Presence TTL is 180s (DEFAULT_PRESENCE_TTL_SEC, src/fleet/registry.ts). Match the
// timestamp-format split documented in tests/fleet-liveness-either-surface.test.ts:
// fleet_agents stores SQLite 'YYYY-MM-DD HH:MM:SS'; module_registry stores ISO-8601.
const sqliteStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const isoStamp = (ms: number) => new Date(ms).toISOString()
const FRESH = NOW - 30_000
const STALE = NOW - 7 * 24 * 3600_000

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  harness.sqlite.exec(
    `INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Dept A');
     INSERT INTO squads (id, department_id, slug, name) VALUES
       ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
       ('squad-b', 'dept-a', 'squad-b', 'Squad Beta');`,
  )
})

afterEach(() => harness.close())

function agent(id: string, squadId: string, opts: { slug?: string; name?: string; model?: string } = {}) {
  const slug = opts.slug ?? id
  const name = opts.name ?? id
  const model = opts.model ?? '@cf/meta/llama-3.3'
  harness.sqlite.exec(
    `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
     VALUES ('${id}', '${squadId}', '${slug}', '${name}', 'member', '${model}', 'active')`,
  )
}

/** module_registry row keyed by an exact identity (usually the agent's own uuid). */
function moduleRow(identity: string, lastHeartbeatMs: number, status = 'online') {
  harness.sqlite.exec(
    `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at)
     VALUES ('mod-${identity}-${lastHeartbeatMs}', '${TENANT}', 'agent_system', 'claude-code', NULL, '${identity}', '${status}',
             '[]', '${isoStamp(lastHeartbeatMs)}', '${isoStamp(lastHeartbeatMs)}')`,
  )
}

/** fleet_agents row keyed by an exact identity (usually the agent's own uuid, but the
 *  ambiguous-duplicate test deliberately keys it by a shared SLUG instead). */
function fleetRow(agentId: string, lastReportedAtMs: number, status = 'running') {
  harness.sqlite.exec(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, member_id, host, last_reported_at, updated_at)
     VALUES ('${agentId}', '${TENANT}', '', 'claude-code', '[]', 'on_demand', '${status}', 'reporter', 'builder', NULL, '', '${sqliteStamp(lastReportedAtMs)}', '${sqliteStamp(lastReportedAtMs)}')`,
  )
}

// ── isLiveRuntimeState — the reachability predicate, mutation-proof on its own ──

describe('isLiveRuntimeState — the ONE predicate the picker filter is built on', () => {
  const base: FleetAgentRuntimeState = { agent_id: 'a', runtime: 'claude-code', status: 'running', presence: 'live', host: '', last_seen: '' }

  it('true only for presence === "live"', () => {
    expect(isLiveRuntimeState(base)).toBe(true)
    expect(isLiveRuntimeState({ ...base, presence: 'stale' })).toBe(false)
    expect(isLiveRuntimeState({ ...base, presence: 'offline' })).toBe(false)
  })

  it('false when the agent has no presence row at all (undefined)', () => {
    expect(isLiveRuntimeState(undefined)).toBe(false)
  })
})

// ── done_when #1 / gate bar 1: unreachable identities never offered ────────────

describe('loadDispatchableAgents — reachability filter (mupot#1062 done_when #1, gate bar 1)', () => {
  it('offers a live agent, excludes a stale-seat agent and a never-connected (not-runtime/unattached) agent', async () => {
    agent('agent-live', 'squad-a', { name: 'Live Agent' })
    moduleRow('agent-live', FRESH)

    agent('agent-stale', 'squad-a', { name: 'Stale Agent' })
    moduleRow('agent-stale', STALE) // registered once, long decayed — a real stale seat

    agent('agent-none', 'squad-a', { name: 'Never Connected' })
    // no presence row anywhere — not-runtime / unattached

    const result = await loadDispatchableAgents(env, undefined, NOW)
    const ids = result.map((a) => a.id)
    expect(ids).toEqual(['agent-live'])
    expect(result[0].seat_status).toBe('live')
  })

  it('the exclusion is driven by isLiveRuntimeState, not a name/status coincidence — proving the filter is load-bearing', async () => {
    // Same fixture as above, but asserted at the RAW presence-signal level: the
    // stale and never-connected agents' states are demonstrably NOT live BEFORE
    // loadDispatchableAgents ever filters them. If the `isLiveRuntimeState(state)`
    // guard were ever deleted from loadDispatchableAgents, these two rows would
    // flow straight through into the picker — this test pins the exact signal
    // that guard reads.
    agent('agent-live', 'squad-a')
    moduleRow('agent-live', FRESH)
    agent('agent-stale', 'squad-a')
    moduleRow('agent-stale', STALE)
    agent('agent-none', 'squad-a')

    const { getFleetAgentRuntimeStates } = await import('../src/fleet/registry')
    const states = await getFleetAgentRuntimeStates(
      env,
      [
        { agent_id: 'agent-live', slug: 'agent-live' },
        { agent_id: 'agent-stale', slug: 'agent-stale' },
        { agent_id: 'agent-none', slug: 'agent-none' },
      ],
      NOW,
    )
    expect(isLiveRuntimeState(states.get('agent-live'))).toBe(true)
    expect(isLiveRuntimeState(states.get('agent-stale'))).toBe(false)
    expect(isLiveRuntimeState(states.get('agent-none'))).toBe(false)

    const result = await loadDispatchableAgents(env, undefined, NOW)
    expect(result.map((a) => a.id)).toEqual(['agent-live'])
  })

  it('a paused (non-active) agent is excluded even with a live presence row', async () => {
    harness.sqlite.exec(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
       VALUES ('agent-paused', 'squad-a', 'agent-paused', 'Paused Agent', 'member', '@cf/meta/llama-3.3', 'paused')`,
    )
    moduleRow('agent-paused', FRESH)
    const result = await loadDispatchableAgents(env, undefined, NOW)
    expect(result).toEqual([])
  })

  it('an empty roster returns an empty list, not an error', async () => {
    await expect(loadDispatchableAgents(env)).resolves.toEqual([])
  })
})

// ── gate bar 2: same slug, different squads — disambiguated, never collapsed ───

describe('loadDispatchableAgents — cross-squad same-slug disambiguation (gate bar 2)', () => {
  it('two agents sharing a slug in different squads, each with its OWN live presence row, both surface distinctly', async () => {
    agent('agent-a1', 'squad-a', { slug: 'kasra', name: 'Kasra (Squad A)', model: 'claude-sonnet-5' })
    agent('agent-b1', 'squad-b', { slug: 'kasra', name: 'Kasra (Squad B)', model: 'claude-opus-5' })
    moduleRow('agent-a1', FRESH) // keyed by agent-a1's OWN uuid, not the shared slug
    moduleRow('agent-b1', FRESH) // keyed by agent-b1's OWN uuid, not the shared slug

    const result = await loadDispatchableAgents(env, undefined, NOW)
    expect(result).toHaveLength(2) // a collapse bug would leave exactly 1
    const byId = new Map(result.map((a) => [a.id, a]))
    expect(byId.get('agent-a1')?.squad_name).toBe('Squad Alpha')
    expect(byId.get('agent-b1')?.squad_name).toBe('Squad Beta')
    expect(byId.get('agent-a1')?.model).toBe('claude-sonnet-5')
    expect(byId.get('agent-b1')?.model).toBe('claude-opus-5')
    // Rendered HTML must carry BOTH sets of distinguishing badges, not one merged row.
    const html = String(sendPageBody([], result, pickDispatchDefault(result)))
    expect(html).toContain('Squad Alpha')
    expect(html).toContain('Squad Beta')
    expect((html.match(/badge-squad/g) ?? []).length).toBe(2)
  })

  it('ambiguous-duplicate: presence reachable ONLY via the shared slug (not either agent\'s own id) excludes BOTH', async () => {
    agent('agent-a1', 'squad-a', { slug: 'kasra', name: 'Kasra (Squad A)' })
    agent('agent-b1', 'squad-b', { slug: 'kasra', name: 'Kasra (Squad B)' })
    // A single legacy-style row keyed by the bare slug, not by either agent's uuid —
    // getFleetAgentRuntimeStates cannot safely attribute it to one of two same-slug
    // agents (readFleetAgentRow's cardinality refusal), so this must resolve to
    // "neither is live," never an arbitrary pick of one.
    fleetRow('kasra', FRESH)

    const result = await loadDispatchableAgents(env, undefined, NOW)
    expect(result).toEqual([])
  })
})

// ── done_when #3 / gate bar 3: deterministic default, never first-row ──────────

describe('pickDispatchDefault — deterministic default + visible reason (done_when #3, gate bar 3)', () => {
  function fixture(id: string, squadName: string): DispatchableAgent {
    return {
      id,
      slug: id,
      name: id,
      role: 'member',
      model: '@cf/meta/llama-3.3',
      squad_id: `${squadName}-id`,
      squad_name: squadName,
      seat_status: 'live',
      last_seen: isoStamp(NOW),
    }
  }

  it('zero live agents -> no default, honest empty reason', () => {
    const result = pickDispatchDefault([])
    expect(result.agent_id).toBeNull()
    expect(result.reason.toLowerCase()).toContain('no reachable')
  })

  it('exactly one live agent -> that agent is the default, reason names it', () => {
    const only = fixture('agent-only', 'Squad Alpha')
    const result = pickDispatchDefault([only])
    expect(result.agent_id).toBe('agent-only')
    expect(result.reason).toContain('agent-only')
  })

  it('more than one live agent -> NO default (never a hard-coded first row), reason names the count', () => {
    // Ordered so a "just pick index 0" mutation would visibly return 'agent-a'.
    const agents = [fixture('agent-a', 'Squad Alpha'), fixture('agent-b', 'Squad Beta'), fixture('agent-c', 'Squad Gamma')]
    const result = pickDispatchDefault(agents)
    expect(result.agent_id).toBeNull()
    expect(result.agent_id).not.toBe('agent-a')
    expect(result.reason).toContain('3 live runtimes')
  })
})

// ── done_when #2: every offered row shows model + squad + seat status ──────────

describe('sendPageBody — offered rows carry server-derived model/squad/seat badges (done_when #2)', () => {
  it('renders MODEL, SQUAD, and SEAT STATUS badges per offered agent, and the default reason', () => {
    const agents: DispatchableAgent[] = [
      {
        id: 'agent-live', slug: 'agent-live', name: 'Live Agent', role: 'builder',
        model: 'claude-sonnet-5', squad_id: 'squad-a', squad_name: 'Squad Alpha',
        seat_status: 'live', last_seen: isoStamp(NOW),
      },
    ]
    const dispatchDefault = pickDispatchDefault(agents)
    const html = String(sendPageBody([], agents, dispatchDefault))
    expect(html).toContain('badge-model')
    expect(html).toContain('claude-sonnet-5')
    expect(html).toContain('badge-squad')
    expect(html).toContain('Squad Alpha')
    expect(html).toContain('badge-seat-live')
    expect(html).toContain(dispatchDefault.reason)
    // Exactly one live candidate -> that radio (and only that one) is checked.
    expect((html.match(/ checked/g) ?? []).length).toBe(1)
    expect(html).toContain('value="agent-live|squad-a" checked')
  })

  it('with multiple live agents, NO radio is pre-checked — forces an explicit choice', () => {
    const agents: DispatchableAgent[] = [
      { id: 'agent-a', slug: 'agent-a', name: 'A', role: 'member', model: 'm', squad_id: 'squad-a', squad_name: 'Squad Alpha', seat_status: 'live', last_seen: '' },
      { id: 'agent-b', slug: 'agent-b', name: 'B', role: 'member', model: 'm', squad_id: 'squad-b', squad_name: 'Squad Beta', seat_status: 'live', last_seen: '' },
    ]
    const html = String(sendPageBody([], agents, pickDispatchDefault(agents)))
    expect((html.match(/ checked/g) ?? []).length).toBe(0)
    expect(html).toContain('choose one')
  })

  it('zero dispatchable agents renders the honest empty state, not an empty picker', () => {
    const html = String(sendPageBody([], [], pickDispatchDefault([])))
    expect(html).toContain('No reachable agents')
    // No agent-option rows and no rendered badge SPAN (the CSS block itself still
    // defines .badge-seat-* selectors, so this checks for a rendered element, not
    // just the substring).
    expect(html).not.toContain('class="agent-option')
    expect(html).not.toContain('class="badge badge-seat')
  })

  it('requires and submits the operator exact done_when and renders review as awaiting gate', () => {
    const agents: DispatchableAgent[] = [
      {
        id: 'agent-live', slug: 'agent-live', name: 'Live Agent', role: 'builder',
        model: 'codex', squad_id: 'squad-a', squad_name: 'Squad Alpha',
        seat_status: 'live', last_seen: isoStamp(NOW),
      },
    ]
    const html = String(sendPageBody([], agents, pickDispatchDefault(agents)))
    expect(html).toContain('id="send-done"')
    expect(html).toContain('id="send-gate"')
    expect(html).toContain('A verifiable done-when is required.')
    expect(html).toContain('An independent gate owner is required.')
    expect(html).toContain('Self-completion is not an independent gate.')
    expect(html).toContain("gateOwner === 'gate:agent-self-completion'")
    expect(html).toContain('done_when: doneWhen')
    expect(html).toContain('gate_owner: gateOwner')
    expect(html).not.toContain('The task result explains the completed work and names any follow-up needed.')
    expect(html).toContain("t.status === 'review'")
    expect(html).toContain('Awaiting independent gate')
    expect(html).toContain('Transport delivered')
    expect(html).toContain('Runtime consumed')
    expect(html).toContain('Runtime completed')
    expect(html).toContain('Gate verdict')
  })
})
