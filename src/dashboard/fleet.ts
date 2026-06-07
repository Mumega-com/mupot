// /dashboard/fleet — the company-fleet roster (Hadi 2026-06-07: "all mumega
// agents: who is active, who is dead, last active, role — and pause/delete/run").
//
// Data: the SOS bus bridge REST (env.BUS_URL + env.BUS_TOKEN secret). The pot
// is the WINDOW here, not the runtime — fleet agents live on the bus (tmux,
// systemd, remote workspaces), so:
//   - Wake/Run  = a direct bus message to the agent (immediate, receipted on
//     the bus itself).
//   - Pause / Deactivate / Delete = a CONTROL REQUEST bus message to the
//     operations agent (kasra) carrying a request_id — gates-not-routers: the
//     window asks, an accountable agent executes server-side. The dashboard
//     never gets host-level kill powers.
//
// Fail-soft: if BUS_TOKEN/BUS_URL are absent (e.g. the house pot) the page
// renders a "bus not connected" notice instead of erroring.

import type { Env } from '../types'

export interface FleetEntry {
  agent: string
  label: string
  project: string | null
  active_token: boolean
  last_seen_ms: number | null
  messages: number
}

export type FleetLiveness = 'active' | 'idle' | 'dead' | 'never'

export interface FleetRow extends FleetEntry {
  liveness: FleetLiveness
  last_seen_human: string
}

const ACTIVE_MS = 10 * 60 * 1000 // heartbeat convention: stale at 10 min
const IDLE_MS = 24 * 60 * 60 * 1000

export function classify(lastSeenMs: number | null, nowMs: number): FleetLiveness {
  if (!lastSeenMs) return 'never'
  const age = nowMs - lastSeenMs
  if (age <= ACTIVE_MS) return 'active'
  if (age <= IDLE_MS) return 'idle'
  return 'dead'
}

export function humanAge(lastSeenMs: number | null, nowMs: number): string {
  if (!lastSeenMs) return 'never'
  const m = Math.max(0, Math.floor((nowMs - lastSeenMs) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function busConfigured(env: Env): boolean {
  return Boolean(env.BUS_TOKEN && (env.BUS_URL || DEFAULT_BUS_URL))
}

const DEFAULT_BUS_URL = 'https://bus.mumega.com'
// Pin fleet bus traffic to one project so an admin-scoped HQ token cannot
// fan out across tenants (adversarial P2). The company fleet lives on `sos`.
const FLEET_PROJECT = 'sos'

function busUrl(env: Env): string {
  return (env.BUS_URL || DEFAULT_BUS_URL).replace(/\/$/, '')
}

export async function loadFleet(env: Env, nowMs: number): Promise<FleetRow[]> {
  const res = await fetch(`${busUrl(env)}/fleet`, {
    headers: { authorization: `Bearer ${env.BUS_TOKEN}` },
  })
  if (!res.ok) throw new Error(`bus_fleet_${res.status}`)
  const data = (await res.json()) as { fleet: FleetEntry[] }
  return (data.fleet ?? []).map((e) => ({
    ...e,
    liveness: classify(e.last_seen_ms, nowMs),
    last_seen_human: humanAge(e.last_seen_ms, nowMs),
  }))
}

// Direct wake: a bus message to the agent itself.
export async function wakeFleetAgent(env: Env, agent: string, by: string): Promise<boolean> {
  const res = await fetch(`${busUrl(env)}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.BUS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: agent,
      from: 'mupot-hq',
      project: FLEET_PROJECT,
      text: `[fleet-dashboard] wake requested by ${by} — report status on the bus.`,
    }),
  })
  return res.ok
}

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'deactivate', 'delete'])

// Control request: routed to the operations agent (kasra) with a request_id —
// the receipted, human-attributed ask. Never a direct host action from a worker.
export async function requestFleetControl(
  env: Env,
  agent: string,
  action: string,
  by: string,
): Promise<{ ok: boolean; request_id?: string; error?: string }> {
  if (!CONTROL_ACTIONS.has(action)) return { ok: false, error: 'unknown_action' }
  const requestId = crypto.randomUUID()
  const res = await fetch(`${busUrl(env)}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.BUS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: 'kasra',
      from: 'mupot-hq',
      project: FLEET_PROJECT,
      text: `[request_id:${requestId}] FLEET CONTROL from ${by} via dashboard: ${action.toUpperCase()} agent "${agent}". Execute server-side (token flag / service / tmux as appropriate) and ack with result.`,
    }),
  })
  return res.ok ? { ok: true, request_id: requestId } : { ok: false, error: `bus_${res.status}` }
}
