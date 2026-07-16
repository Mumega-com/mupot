// tests/dashboard-radar-view.test.ts — pure render layer for the fleet RADAR
// (#21 slice 1, VIEW LAYER ONLY). renderAgentCard/renderBrainImage are pure
// string builders (no I/O), so these fixture FleetRadar/AgentCard values
// directly — same discipline as tests/dashboard-radar.test.ts, which drives
// buildFleetRadar (the data layer) with fixtures shaped like today's real
// fleet state.

import { describe, it, expect } from 'vitest'
import { renderAgentCard, renderBrainImage } from '../src/dashboard/radar-view'
import type { AgentCard, FleetRadar, StaleSignal } from '../src/dashboard/radar'

const NOW = 1_900_000_000_000 // fixed reference (Unix ms) — matches dashboard-radar.test.ts's NOW

function card(p: Partial<AgentCard> & { agent_id: string; display: string }): AgentCard {
  return {
    agent_id: p.agent_id,
    display: p.display,
    runtime_state: p.runtime_state ?? 'live',
    last_seen_ms: p.last_seen_ms !== undefined ? p.last_seen_ms : NOW - 60_000,
    current_flight: p.current_flight ?? null,
    recent_activity: p.recent_activity ?? { tasks_done: 0, tasks_in_progress: 0, last_task_at: null },
    airworthiness: p.airworthiness ?? { error_rate: null, budget_remaining_micro_usd: null, stale: p.runtime_state ? p.runtime_state !== 'live' : false },
    // '' (unknown/never self-reported) by default — matches AgentCard.host's honest default
    // (radar.ts). Individual tests override with a real hostname where the host signal
    // itself is under test.
    host: p.host ?? '',
  }
}

function radar(p: Partial<FleetRadar> = {}): FleetRadar {
  return {
    generated_at_ms: p.generated_at_ms ?? NOW,
    agents: p.agents ?? [],
    squads: p.squads ?? [],
    summary: p.summary ?? {
      agents_total: (p.agents ?? []).length,
      live: 0,
      stale: 0,
      offline: 0,
      unattached: 0,
      active_flights: 0,
      stale_signals: [],
      open_collisions_count: 0,
    },
  }
}

// ── honesty guard: no model/role/domain, no fabricated runtime-type ────────────
// Shared assertion helper — every scenario below runs this on its rendered HTML.
//
// Host (#21 slice 2) is DELIBERATELY NOT banned here anymore — it now has a real signal
// behind it (agent self-report, see radar-view.ts's honest-gaps note 1) and is rendered
// on every card/row. What this guard still protects against is fabricating a SPECIFIC
// machine name the fixture never supplied (e.g. rendering "macbook"/"hetzner" for a card
// whose `host` is '' — that would be exactly the fake-green this module's honesty
// contract forbids). Tests that DO set a real host assert its presence explicitly instead
// of running this guard, or pass it through unaffected (the guard only bans specific
// unset-signal placeholders, not the word "host" itself).
function assertNoFabrication(html: string) {
  const lower = html.toLowerCase()
  for (const banned of ['model:', 'role:', 'domain:', 'pot-native']) {
    expect(lower).not.toContain(banned)
  }
}

describe('renderAgentCard', () => {
  it('renders an honest empty-radar-adjacent single card with no fabricated fields', () => {
    const c = card({ agent_id: 'agent-solo', display: 'Solo' })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('Solo')
    expect(out).toContain('unassigned') // no squadName passed
    assertNoFabrication(out)
  })

  it('one live agent on a flight — shows goal, status, live state, squad', () => {
    const c = card({
      agent_id: 'agent-hermes',
      display: 'Hermes',
      runtime_state: 'live',
      current_flight: { id: 'fl-1', goal: 'ship the radar view', status: 'running' },
      recent_activity: { tasks_done: 9, tasks_in_progress: 1, last_task_at: null },
      airworthiness: { error_rate: 0.1, budget_remaining_micro_usd: 500_000, stale: false },
    })
    const out = renderAgentCard(c, { squadName: 'Core', nowMs: NOW })
    expect(out).toContain('Hermes')
    expect(out).toContain('Core')
    expect(out).toContain('ship the radar view')
    expect(out).toContain('running')
    expect(out).toContain('live')
    expect(out).toContain('9 done')
    expect(out).toContain('1 in progress')
    expect(out).toContain('10.0%') // error_rate 0.1 -> 10.0%
    expect(out).toContain('$0.50 left') // 500_000 micro-usd
    expect(out).not.toContain('stale data')
    assertNoFabrication(out)
  })

  it('one stale agent — idle, stale badge, warn-tone state label', () => {
    const c = card({
      agent_id: 'agent-kasra',
      display: 'Kasra',
      runtime_state: 'stale',
      current_flight: null,
      airworthiness: { error_rate: 0.5, budget_remaining_micro_usd: null, stale: true },
    })
    const out = renderAgentCard(c, { squadName: 'Core', nowMs: NOW })
    expect(out).toContain('Kasra')
    expect(out).toContain('stale')
    expect(out).toContain('stale data') // the airworthiness.stale badge
    expect(out).toContain('idle') // no current_flight
    expect(out).toContain('no budget set')
    assertNoFabrication(out)
  })

  it('one unattached agent — over-budget renders honestly negative, not clamped to $0', () => {
    const c = card({
      agent_id: 'agent-codex',
      display: 'Codex',
      runtime_state: 'unattached',
      airworthiness: { error_rate: null, budget_remaining_micro_usd: -250_000, stale: true },
    })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('Codex')
    expect(out).toContain('unattached')
    expect(out).toContain('—') // error_rate null -> em dash
    expect(out).toContain('over budget')
    expect(out).toContain('$0.25 over budget')
    expect(out).not.toContain('$0.00') // must not silently clamp a negative budget to zero
    assertNoFabrication(out)
  })

  it('relative last-seen: never (null), just now (<60s), and Nm/Nh/Nd ago', () => {
    const never = renderAgentCard(card({ agent_id: 'a1', display: 'A1', last_seen_ms: null }), { nowMs: NOW })
    expect(never).toContain('never')

    const justNow = renderAgentCard(card({ agent_id: 'a2', display: 'A2', last_seen_ms: NOW - 5_000 }), { nowMs: NOW })
    expect(justNow).toContain('just now')

    const minutesAgo = renderAgentCard(card({ agent_id: 'a3', display: 'A3', last_seen_ms: NOW - 5 * 60_000 }), { nowMs: NOW })
    expect(minutesAgo).toContain('5m ago')

    const hoursAgo = renderAgentCard(card({ agent_id: 'a4', display: 'A4', last_seen_ms: NOW - 3 * 3_600_000 }), { nowMs: NOW })
    expect(hoursAgo).toContain('3h ago')

    const daysAgo = renderAgentCard(card({ agent_id: 'a5', display: 'A5', last_seen_ms: NOW - 2 * 86_400_000 }), { nowMs: NOW })
    expect(daysAgo).toContain('2d ago')
  })

  it('escapes a hostile agent name (no raw HTML injection)', () => {
    const c = card({ agent_id: 'agent-x', display: '<script>alert(1)</script>' })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  // ── host (#21 slice 2) ──────────────────────────────────────────────────────
  it('host: renders "unknown" when never self-reported (host === "")', () => {
    const c = card({ agent_id: 'agent-x', display: 'X', host: '' })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('Host')
    expect(out).toContain('unknown')
  })

  it('host: renders the reported hostname', () => {
    const c = card({ agent_id: 'agent-x', display: 'X', host: 'hetzner-1' })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('hetzner-1')
  })

  it('host: a hostile value (quotes/slashes/angle-brackets) is escaped, never raw HTML — agent-controlled, untrusted', () => {
    const hostile = `<img src=x onerror=alert(1)> "'/evil`
    const c = card({ agent_id: 'agent-x', display: 'X', host: hostile })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).not.toContain(hostile)
    expect(out).not.toContain('<img')
    expect(out).not.toContain('"\'')
    expect(out).toContain('&lt;img')
    expect(out).toContain('&quot;')
    expect(out).toContain('&#39;')
    expect(out).toContain('&#x2F;')
  })
})

describe('escHtml hardening (#21 slice 2 gate note)', () => {
  it("escapes ' and / in addition to the original & < > \" chain", () => {
    // Exercised indirectly through renderAgentCard's display field — escHtml itself is
    // module-private, so drive it via a rendered field the same way the other escaping
    // tests in this file do.
    const c = card({ agent_id: 'agent-y', display: `it's a/b & <c> "d"` })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('it&#39;s a&#x2F;b &amp; &lt;c&gt; &quot;d&quot;')
    expect(out).not.toContain(`it's a/b`)
  })

  it('data-runtime-state attribute is escaped defensively (enum-typed today, hardened regardless)', () => {
    const c = card({ agent_id: 'agent-z', display: 'Z', runtime_state: 'live' })
    const out = renderAgentCard(c, { nowMs: NOW })
    expect(out).toContain('data-runtime-state="live"')
  })
})

describe('renderBrainImage', () => {
  it('empty radar — honest empty state, no fabricated agents, no stale alarm', () => {
    const out = renderBrainImage(radar())
    expect(out).toContain('No agents on the fleet yet.')
    expect(out).toContain('No stale signals — fleet airworthy.')
    expect(out).toContain('0') // agents_total
    assertNoFabrication(out)
  })

  it('one live agent on a flight — grouped under Live, flight goal visible', () => {
    const c = card({
      agent_id: 'agent-hermes',
      display: 'Hermes',
      runtime_state: 'live',
      current_flight: { id: 'fl-1', goal: 'radar dogfood', status: 'running' },
    })
    const r = radar({
      agents: [c],
      squads: [{ squad_id: 'squad-core', name: 'Core', member_agent_ids: ['agent-hermes'], active_flight_count: 1, live_member_count: 1 }],
      summary: {
        agents_total: 1, live: 1, stale: 0, offline: 0, unattached: 0,
        active_flights: 1, stale_signals: [], open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('Live (1)')
    expect(out).toContain('Hermes')
    expect(out).toContain('Core')
    expect(out).toContain('radar dogfood')
    expect(out).not.toContain('Stale (')
    assertNoFabrication(out)
  })

  it('one stale agent — grouped under Stale, no live/offline/unattached sections rendered', () => {
    const c = card({ agent_id: 'agent-kasra', display: 'Kasra', runtime_state: 'stale' })
    const r = radar({
      agents: [c],
      summary: {
        agents_total: 1, live: 0, stale: 1, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: [{ kind: 'agent_presence_stale', id: 'agent-kasra', detail: 'Kasra — no heartbeat within 120s TTL' }],
        open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('Stale (1)')
    expect(out).toContain('Kasra')
    expect(out).not.toContain('Live (')
    expect(out).not.toContain('Offline (')
    expect(out).not.toContain('Unattached (')
    assertNoFabrication(out)
  })

  it('one unattached agent — grouped under Unattached', () => {
    const c = card({ agent_id: 'agent-codex', display: 'Codex', runtime_state: 'unattached' })
    const r = radar({
      agents: [c],
      summary: {
        agents_total: 1, live: 0, stale: 0, offline: 0, unattached: 1,
        active_flights: 0, stale_signals: [{ kind: 'agent_unattached', id: 'agent-codex', detail: 'Codex — no signing key bound; catalog entry only' }],
        open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('Unattached (1)')
    expect(out).toContain('Codex')
    assertNoFabrication(out)
  })

  it('stale_signals present — surfaced PROMINENTLY at the top with kind + detail + collision count', () => {
    const signals: StaleSignal[] = [
      { kind: 'agent_presence_stale', id: 'agent-kasra', detail: 'Kasra — no heartbeat within 120s TTL' },
      { kind: 'agent_unattached', id: 'agent-codex', detail: 'Codex — no signing key bound; catalog entry only' },
      { kind: 'flight_stalled', id: 'fl-9', detail: 'agent-x — running for 180m (goal: fix the thing)' },
    ]
    const r = radar({
      agents: [],
      summary: {
        agents_total: 0, live: 0, stale: 0, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: signals, open_collisions_count: 2,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('Stale signals (3)')
    expect(out).toContain('agent_presence_stale')
    expect(out).toContain('Kasra — no heartbeat within 120s TTL')
    expect(out).toContain('agent_unattached')
    expect(out).toContain('flight_stalled')
    expect(out).toContain('2 open flight collisions')
    // The alarm section must appear before the (empty) group sections textually.
    expect(out.indexOf('Stale signals (3)')).toBeLessThan(out.indexOf('No agents on the fleet yet.'))
    assertNoFabrication(out)
  })

  it('mixed fleet — all four runtime states grouped correctly in one render', () => {
    const live = card({ agent_id: 'a-live', display: 'Live1', runtime_state: 'live' })
    const stale = card({ agent_id: 'a-stale', display: 'Stale1', runtime_state: 'stale' })
    const offline = card({ agent_id: 'a-off', display: 'Off1', runtime_state: 'offline' })
    const unattached = card({ agent_id: 'a-un', display: 'Un1', runtime_state: 'unattached' })
    const r = radar({
      agents: [live, stale, offline, unattached],
      summary: {
        agents_total: 4, live: 1, stale: 1, offline: 1, unattached: 1,
        active_flights: 0, stale_signals: [], open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('Live (1)')
    expect(out).toContain('Stale (1)')
    expect(out).toContain('Offline (1)')
    expect(out).toContain('Unattached (1)')
    expect(out).toContain('Live1')
    expect(out).toContain('Stale1')
    expect(out).toContain('Off1')
    expect(out).toContain('Un1')
    assertNoFabrication(out)
  })

  // ── host grouping (#21 slice 2 — the point of this slice) ──────────────────
  it('groups agents by host — "some on my Mac, some on this server" picture', () => {
    const macAgent = card({ agent_id: 'a-mac', display: 'MacAgent', host: 'kays-mbp' })
    const serverAgent1 = card({ agent_id: 'a-srv1', display: 'ServerAgent1', host: 'hetzner-1' })
    const serverAgent2 = card({ agent_id: 'a-srv2', display: 'ServerAgent2', host: 'hetzner-1' })
    const r = radar({
      agents: [macAgent, serverAgent1, serverAgent2],
      summary: {
        agents_total: 3, live: 3, stale: 0, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: [], open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('By host')
    expect(out).toContain('kays-mbp (1)')
    expect(out).toContain('hetzner-1 (2)')
    expect(out).toContain('MacAgent')
    expect(out).toContain('ServerAgent1')
    expect(out).toContain('ServerAgent2')
  })

  it('host grouping: agents with no self-reported host bucket under "unknown host", never a fabricated name', () => {
    const noHost = card({ agent_id: 'a-nohost', display: 'NoHost', host: '' })
    const r = radar({
      agents: [noHost],
      summary: {
        agents_total: 1, live: 1, stale: 0, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: [], open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('unknown host (1)')
    expect(out).toContain('NoHost')
  })

  it('host grouping: a hostile host value is escaped in the group label, never raw HTML', () => {
    const hostile = card({ agent_id: 'a-hostile', display: 'Hostile', host: `<img src=x onerror=alert(1)>` })
    const r = radar({
      agents: [hostile],
      summary: {
        agents_total: 1, live: 1, stale: 0, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: [], open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).not.toContain('<img src=x onerror=alert(1)>')
    expect(out).toContain('&lt;img')
  })

  it('host grouping: runtime-state grouping is preserved alongside host grouping (both surfaced, not replaced)', () => {
    const c = card({ agent_id: 'a-both', display: 'Both', runtime_state: 'stale', host: 'hetzner-1' })
    const r = radar({
      agents: [c],
      summary: {
        agents_total: 1, live: 0, stale: 1, offline: 0, unattached: 0,
        active_flights: 0, stale_signals: [{ kind: 'agent_presence_stale', id: 'a-both', detail: 'Both — no heartbeat within 120s TTL' }],
        open_collisions_count: 0,
      },
    })
    const out = renderBrainImage(r)
    expect(out).toContain('By runtime state')
    expect(out).toContain('Stale (1)')
    expect(out).toContain('By host')
    expect(out).toContain('hetzner-1 (1)')
  })
})
