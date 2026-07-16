// dashboard/radar-view — pure render layer for the fleet RADAR (#21 slice 1,
// VIEW LAYER ONLY). Renders the EXISTING FleetRadar/AgentCard data
// (dashboard/radar.ts, #23) as a visual surface: a character-sheet card per
// agent (renderAgentCard) and a compact fleet-map "brain image"
// (renderBrainImage) that groups agents by runtime_state and surfaces
// stale_signals as the airworthiness alarm — that's the whole point of a
// radar: you look at it BEFORE something collides, not after.
//
// Zero new data, zero migration: this module reads FleetRadar/AgentCard
// exactly as buildFleetRadar (dashboard/radar.ts) already produces them. It
// owns presentation only — no D1, no KV, no fetch, no env. Pure functions,
// fully unit-testable without a Worker runtime.
//
// Determinism: no Date.now() in the render path. renderAgentCard/renderBrainImage
// take an explicit `nowMs` (or an options bag carrying one) — radarPageBody
// below anchors every card AND the brain image to the SAME
// radar.generated_at_ms instant, so relative "last seen" times can never drift
// between two fragments of one response. A bare Date.now() default exists only
// as an ergonomic fallback for ad-hoc single-card callers (e.g. a REPL); the
// real page-render call path always passes it explicitly.
//
// ── Honest gaps (documented, not fabricated — see feedback_safety_flag_server_ignores
//    and the project's "no fake green" discipline) ──────────────────────────────
//
//   1. HOST ATTRIBUTION (physical machine — Mac / Hetzner / cloud): CLOSED, #21 slice 2.
//      Agents self-report `os.hostname()` in the fleet-report/attach(-signed) payload
//      (fleet-runtime/fleet-sign.mjs, fleet-runtime/attach-signed.mjs,
//      fleet-runtime/fleet-daemon.mjs); fleet/registry.ts + fleet/attach-routes.ts write
//      it into fleet_agents.host (migrations/0051_fleet_agents_host.sql); radar.ts
//      threads it into AgentCard.host. It is UNTRUSTED, agent-controlled, DISPLAY-ONLY
//      (never auth/routing) — '' means "never reported" (old runtime, or no fleet row
//      yet), rendered honestly as "unknown", never fabricated as a specific machine name.
//
//   2. MODEL TIER / ROLE / DOMAIN: AgentCard does not carry model, role, or
//      domain — loadFleetRadar's `agents` SELECT reads those columns off the
//      `agents` table but buildFleetRadar does not project them into
//      AgentCard's output shape (see radar.ts). This view does not fabricate
//      them. Slice 2 (or a radar.ts follow-up) could thread the fields
//      through additively (same rows already fetched, zero new SQL).
//
//   3. EXTERNAL RUNTIME TYPE ("pot-native" vs a coarse `runtime` slug): the
//      data exists in FleetAgentRuntimeView (fleet/registry.ts) — already an
//      INPUT to loadFleetRadar — but buildFleetRadar only extracts
//      `last_seen_ms` from those rows; AgentCard carries no `runtime` field.
//      The slice-1 brief explicitly freezes radar.ts/buildFleetRadar "as-is"
//      (no new fields), so this view OMITS the runtime-type row rather than
//      render "pot-native" for every card sight-unseen (that would be exactly
//      the kind of fabricated-honesty bug this codebase's culture forbids —
//      we don't actually know it's pot-native, we just never asked).
//      Flagged for Kasra-core: projecting fleetRuntimeRows[].runtime into
//      AgentCard is a ~3-line additive change to radar.ts with zero new SQL,
//      if that gap is worth closing before slice 2.

import { html, raw } from 'hono/html'
import type { Html } from './ui'
import type { AgentCard, FleetRadar, StaleSignal } from './radar'
import type { AgentRuntimeState } from './observatory'

// ── small pure helpers (self-contained — no cross-module CSS-class deps, so
//    renderAgentCard/renderBrainImage stay usable/testable standalone) ─────────

// Hardened (#21 slice 2 gate note): ' and / added to the replace chain. host is a NEW
// agent-controlled, untrusted string rendered here (see honest-gaps note 1 above) — an
// attribute-breakout payload like `" onmouseover="..."` or a `</script>`-style close-tag
// trick through a bare '/' both needed closing. & MUST stay first so the entities this
// function itself inserts are never re-escaped.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;')
}

/**
 * relativeAge — "3m ago" / "2h ago" / "5d ago" style string. Both timestamps
 * are caller-supplied (deterministic); returns "never" for a null timestamp
 * (no heartbeat/presence row ever seen — NOT the same as "just seen").
 */
function relativeAge(nowMs: number, thenMs: number | null): string {
  if (thenMs === null) return 'never'
  const deltaMs = nowMs - thenMs
  if (deltaMs < 60_000) return deltaMs < 0 ? 'just now' : 'just now' // clock-skew guard: never show negative age
  const min = Math.floor(deltaMs / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

/**
 * fmtBudgetRemaining — honest micro-USD formatter for AgentAirworthiness.
 * budget_remaining_micro_usd. Deliberately NOT reusing agents/cost.ts's
 * formatUsd: that helper clamps non-positive values to "$0.00" (correct for a
 * spend/burn-rate display, where "no spend yet" really is $0), but budget
 * remaining can legitimately go NEGATIVE — an agent that blew its cap.
 * Clamping that to "$0.00" would silently hide an over-budget agent behind a
 * healthy-looking number, exactly the fake-green this module's honesty
 * contract forbids.
 */
function fmtBudgetRemaining(microUsd: number | null): string {
  if (microUsd === null) return 'no budget set'
  const dollars = microUsd / 1_000_000
  if (dollars < 0) return `-$${Math.abs(dollars).toFixed(2)} over budget`
  return `$${dollars.toFixed(2)} left`
}

function fmtErrorRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

// ── status-dot tone ──────────────────────────────────────────────────────────
// live/stale reuse the console's ALREADY-CANONICAL runtime_state→tone pairing
// (dashboard/index.ts observatoryBody's runtimeTone + fleet-host.ts's
// PRESENCE_TONE both map live→ok, stale→warn) — we do not invent a second
// mapping for those two. offline/unattached diverge from that pairing on
// purpose: the existing convention collapses both to 'dim', but radar.ts's own
// module header calls unattached-vs-stale "the 'who's a ghost'
// collision-precursor case[s] #23 asks the radar to surface explicitly," and
// only 'unattached' (not 'offline') emits a dedicated stale_signal
// (agent_unattached) — offline is an intentional detach, not a decayed
// signal (buildFleetRadar's own comment). This view mirrors that split using
// the brief's suggested semantic fallback (grey offline / red
// unattached-as-alarm), via the SAME existing CSS vars every other tone
// mapping in this console already uses.
const RUNTIME_TONE: Record<AgentRuntimeState, string> = {
  live: 'var(--ok)',
  stale: 'var(--warn)',
  offline: 'var(--dim)',
  unattached: 'var(--danger)',
}

function statusDotHtml(state: AgentRuntimeState): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${RUNTIME_TONE[state]};flex:none" aria-hidden="true"></span>`
}

function flightSummary(flight: AgentCard['current_flight']): string {
  if (!flight) return `<span style="color:var(--dim)">idle</span>`
  return `<span style="color:var(--text)">${escHtml(flight.goal)}</span> <span style="color:var(--dim);font-size:11px">(${escHtml(
    flight.status,
  )})</span>`
}

// ── renderAgentCard ──────────────────────────────────────────────────────────

export interface AgentCardRenderOpts {
  /** Squad display name, resolved by the caller from FleetRadar.squads —
   *  AgentCard carries no squad reference of its own (see radar.ts). null or
   *  omitted renders "unassigned". */
  squadName?: string | null
  /** Anchor instant for "last seen" relative-time formatting. See module
   *  header: production callers always pass radar.generated_at_ms. */
  nowMs?: number
}

/**
 * renderAgentCard — a character-sheet for one agent: status dot + runtime
 * state, current flight (or "idle"), squad, last-seen (relative), recent
 * activity (tasks done/in-progress), and airworthiness (error rate, budget
 * remaining, stale badge). Pure string builder: no I/O, no template-engine
 * dependency, trivially unit-testable by substring assertion.
 *
 * Deliberately omits model/role/domain/runtime-type — see the module header's
 * "honest gaps" section for why. Host (#21 slice 2) IS shown now — see honest-gaps
 * note 1: it has a real signal behind it (agent self-report), rendered honestly
 * as "unknown" when '' (never reported).
 */
export function renderAgentCard(card: AgentCard, opts: AgentCardRenderOpts = {}): string {
  const nowMs = opts.nowMs ?? Date.now()
  const squadLabel = opts.squadName ? escHtml(opts.squadName) : 'unassigned'
  const state = card.runtime_state
  const hostLabel = card.host ? escHtml(card.host) : 'unknown'
  const staleBadge = card.airworthiness.stale
    ? `<span style="font-size:10px;font-weight:700;color:var(--warn2);border:1px solid color-mix(in srgb,var(--warn2) 40%,var(--border));border-radius:999px;padding:1px 7px;margin-left:6px">stale data</span>`
    : ''

  return `<div class="card" style="padding:14px 16px" data-agent-id="${escHtml(card.agent_id)}" data-runtime-state="${escHtml(state)}">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${statusDotHtml(state)}
      <span style="font-weight:700;font-size:14px;color:var(--text)">${escHtml(card.display)}</span>
      <span style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em">${state}</span>
      ${staleBadge}
    </div>
    <div style="font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:4px">
      <div><span style="color:var(--dim)">Squad</span> ${squadLabel}</div>
      <div><span style="color:var(--dim)">Host</span> ${hostLabel}</div>
      <div><span style="color:var(--dim)">Flight</span> ${flightSummary(card.current_flight)}</div>
      <div><span style="color:var(--dim)">Last seen</span> ${relativeAge(nowMs, card.last_seen_ms)}</div>
      <div><span style="color:var(--dim)">Tasks</span> ${card.recent_activity.tasks_done} done · ${
    card.recent_activity.tasks_in_progress
  } in progress</div>
      <div><span style="color:var(--dim)">Error rate</span> ${fmtErrorRate(card.airworthiness.error_rate)}</div>
      <div><span style="color:var(--dim)">Budget</span> ${fmtBudgetRemaining(
        card.airworthiness.budget_remaining_micro_usd,
      )}</div>
    </div>
  </div>`
}

// ── renderBrainImage ─────────────────────────────────────────────────────────

const RUNTIME_GROUPS: { state: AgentRuntimeState; label: string }[] = [
  { state: 'live', label: 'Live' },
  { state: 'stale', label: 'Stale' },
  { state: 'offline', label: 'Offline' },
  { state: 'unattached', label: 'Unattached' },
]

/**
 * agentRowHtml — the single-line roster row shared by BOTH grouping schemes below
 * (runtime-state and, #21 slice 2, host). Factored out so the two groupings can't drift
 * in what a "row" shows; status dot uses the agent's OWN runtime_state (not the group's
 * label), so a host bucket mixing live/stale agents still renders each one honestly.
 */
function agentRowHtml(a: AgentCard, squadNameByAgent: Map<string, string>, nowMs: number): string {
  const squadLabel = squadNameByAgent.has(a.agent_id) ? escHtml(squadNameByAgent.get(a.agent_id)!) : 'unassigned'
  return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
        ${statusDotHtml(a.runtime_state)}
        <span style="font-weight:600;color:var(--text);min-width:120px">${escHtml(a.display)}</span>
        <span style="color:var(--dim);font-size:12px;min-width:100px">${squadLabel}</span>
        <span style="font-size:12px">${flightSummary(a.current_flight)}</span>
        <span style="color:var(--dim);font-size:11px;margin-left:auto">${relativeAge(nowMs, a.last_seen_ms)}</span>
      </div>`
}

/**
 * renderHostGroups — buckets agents by their self-reported `host` (#21 slice 2: "some on
 * my Mac, some on this server" picture). '' (never reported — old runtime, or no fleet
 * row yet) buckets under "unknown host", sorted LAST so real machines are seen first;
 * known hosts are alpha-sorted for a stable, deterministic render (no Date.now()/Map-
 * iteration-order dependence). Untrusted, agent-controlled string: always through
 * escHtml, never used to key anything auth-relevant.
 */
function renderHostGroups(agents: AgentCard[], squadNameByAgent: Map<string, string>, nowMs: number): string {
  const buckets = new Map<string, AgentCard[]>()
  for (const a of agents) {
    const key = a.host || ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(a)
    else buckets.set(key, [a])
  }
  const knownHosts = [...buckets.keys()].filter((h) => h !== '').sort((x, y) => x.localeCompare(y))
  const orderedKeys = buckets.has('') ? [...knownHosts, ''] : knownHosts

  return orderedKeys
    .map((hostKey) => {
      const rows = buckets.get(hostKey)!
      const label = hostKey ? escHtml(hostKey) : 'unknown host'
      const rowsHtml = rows.map((a) => agentRowHtml(a, squadNameByAgent, nowMs)).join('')
      return `<div style="margin-bottom:14px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600;margin-bottom:4px">${label} (${rows.length})</div>
      ${rowsHtml}
    </div>`
    })
    .join('')
}

function renderStaleSignals(signals: StaleSignal[], openCollisions: number): string {
  if (signals.length === 0 && openCollisions === 0) {
    return `<div style="font-size:12px;color:var(--ok);margin-bottom:12px">No stale signals — fleet airworthy.</div>`
  }
  const rows = signals
    .map(
      (s) =>
        `<div style="font-size:12px;color:var(--text);padding:3px 0"><span style="font-weight:700;color:var(--danger)">${escHtml(
          s.kind,
        )}</span> — ${escHtml(s.detail)}</div>`,
    )
    .join('')
  const collisionRow =
    openCollisions > 0
      ? `<div style="font-size:12px;color:var(--danger);font-weight:700;padding:3px 0">${openCollisions} open flight collision${
          openCollisions === 1 ? '' : 's'
        }</div>`
      : ''
  return `<div style="border:1px solid color-mix(in srgb,var(--danger) 40%,var(--border));background:color-mix(in srgb,var(--danger) 8%,var(--surface));border-radius:var(--radius);padding:10px 14px;margin-bottom:14px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--danger);font-weight:700;margin-bottom:4px">Stale signals (${
      signals.length
    })</div>
    ${rows}
    ${collisionRow}
  </div>`
}

/**
 * renderBrainImage — the compact fleet map. Groups agents TWO ways:
 *   1. By runtime_state (live / stale / offline / unattached — the SAME 4-state
 *      classifier radar.ts derives, not a second liveness definition) — "who's on".
 *   2. By host (#21 slice 2) — "some on my Mac, some on this server, some in the
 *      cloud", the physical-machine picture a token alone can't give the pot.
 * Per agent: status dot, name, squad, current flight. Surfaces `summary.stale_signals`
 * PROMINENTLY at the top — that's the airworthiness alarm, the whole point of a radar:
 * you check it before a collision, not after (mupot #353's kasra/codex collision shape
 * is exactly the case this alarm exists to catch early).
 *
 * Pure: nowMs defaults to radar.generated_at_ms (no Date.now() call), so this
 * function never needs a runtime clock — see module header.
 */
export function renderBrainImage(radar: FleetRadar, nowMs: number = radar.generated_at_ms): string {
  const squadNameByAgent = new Map<string, string>()
  for (const s of radar.squads) {
    for (const id of s.member_agent_ids) squadNameByAgent.set(id, s.name)
  }

  const groupSections = RUNTIME_GROUPS.map(({ state, label }) => {
    const rows = radar.agents.filter((a) => a.runtime_state === state)
    if (rows.length === 0) return ''
    const rowsHtml = rows.map((a) => agentRowHtml(a, squadNameByAgent, nowMs)).join('')
    return `<div style="margin-bottom:14px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600;margin-bottom:4px">${label} (${rows.length})</div>
      ${rowsHtml}
    </div>`
  }).join('')

  const hostSections = renderHostGroups(radar.agents, squadNameByAgent, nowMs)

  const summaryLine = `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:14px">
    <span><strong style="color:var(--text)">${radar.summary.agents_total}</strong> agents</span>
    <span style="color:var(--ok)"><strong>${radar.summary.live}</strong> live</span>
    <span style="color:var(--warn)"><strong>${radar.summary.stale}</strong> stale</span>
    <span style="color:var(--dim)"><strong>${radar.summary.offline}</strong> offline</span>
    <span style="color:var(--danger)"><strong>${radar.summary.unattached}</strong> unattached</span>
    <span><strong style="color:var(--text)">${radar.summary.active_flights}</strong> active flights</span>
  </div>`

  const groupedBody = radar.agents.length
    ? `<div style="margin-bottom:18px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin-bottom:8px">By runtime state</div>
        ${groupSections}
      </div>
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin-bottom:8px">By host</div>
        ${hostSections}
      </div>`
    : '<p style="color:var(--dim);font-size:13px">No agents on the fleet yet.</p>'

  return `<div class="card" style="padding:16px 18px">
    ${renderStaleSignals(radar.summary.stale_signals, radar.summary.open_collisions_count)}
    ${summaryLine}
    ${groupedBody}
  </div>`
}

// ── radarPageBody — the /radar page assembler ────────────────────────────────
// Composes the brain image (top, alarm-first) + a responsive grid of
// character-sheet cards (one per agent). This is the ONLY function in this
// module that returns hono's Html (the two render fns above return plain
// `string` per the brief, so they stay trivially unit-testable without an
// html-template dependency); radarPageBody wraps their output with `raw()`
// since both already escape every dynamic field they interpolate.

export function radarPageBody(radar: FleetRadar): Html {
  const squadNameByAgent = new Map<string, string>()
  for (const s of radar.squads) {
    for (const id of s.member_agent_ids) squadNameByAgent.set(id, s.name)
  }
  const nowMs = radar.generated_at_ms

  const cards = radar.agents.map((a) =>
    raw(renderAgentCard(a, { squadName: squadNameByAgent.get(a.agent_id) ?? null, nowMs })),
  )
  const generatedLabel = new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'

  return html`
    <style>
      .radar-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px;
      }
    </style>

    <p class="crumbs"><a href="/">Overview</a> / Radar</p>
    <h1>Fleet Radar</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      Read-only fleet + squad awareness (#23): who's on, what they're flying, and where the
      stale signals are — before they collide. Same data the brain's ATC tower reads at
      <code>GET /api/radar</code>.
    </p>
    <div style="font-size:11px;color:var(--dim);margin-bottom:14px">generated ${generatedLabel}</div>

    ${raw(renderBrainImage(radar, nowMs))}

    <h2 style="margin-top:24px">Agents</h2>
    ${
      radar.agents.length
        ? html`<div class="radar-grid">${cards}</div>`
        : html`<div class="card"><p class="empty">No agents in this pot yet.</p></div>`
    }
  `
}
