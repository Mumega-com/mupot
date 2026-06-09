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

// SECURITY — where tenant isolation actually lives:
// The REAL isolation boundary is the per-pot BUS_TOKEN's SCOPE, enforced by the
// bus bridge, NOT the strings below. The bridge `_project()` honors the body
// `project` field ONLY for an admin/null-scoped token; for a project-scoped
// token it ignores the body and pins the token's own project. It also enforces
// `from == token.agent`. So the load-bearing invariant (see #44) is:
//
//   every pot's BUS_TOKEN MUST be project-scoped (project=<slug>) AND
//   agent-bound to `mupot-<slug>-hq` — NEVER an admin/null-scoped token.
//
// The resolvers below are defense-in-depth: they set the body `project`/`from`
// to the pot's own values so a correctly-scoped token has nothing to override,
// and they FAIL CLOSED — if the pot is not explicitly scoped, they return null
// and the send is refused rather than falling back to the company `sos`/`kasra`
// (a misconfigured tenant must NOT silently address our roster).
//
//   FLEET_PROJECT (explicit)  →  TENANT_SLUG  →  null (refuse)
//
// The company pot pins FLEET_PROJECT='sos' / FLEET_OPS_AGENT='kasra' explicitly
// in wrangler.toml (its TENANT_SLUG is 'mumega' but its fleet lives on `sos`).
export function resolveFleetProject(env: Env): string | null {
  return env.FLEET_PROJECT?.trim() || env.TENANT_SLUG?.trim() || null
}

// Sender identity on fleet bus messages — tenant-specific so receipts attribute
// to the right pot. Null when no slug is configured (fail closed).
export function resolveFleetSender(env: Env): string | null {
  const slug = env.TENANT_SLUG?.trim()
  return slug ? `mupot-${slug}-hq` : null
}

// The accountable ops agent that executes control requests server-side
// (gates-not-routers). Null unless explicitly set — no fallback to our `kasra`.
export function resolveFleetOpsAgent(env: Env): string | null {
  return env.FLEET_OPS_AGENT?.trim() || null
}

// A pot's fleet is fully scoped only when it has a bus connection AND an
// explicit project + sender. Used to fail closed before any bus send.
export function fleetScoped(env: Env): boolean {
  return busConfigured(env) && Boolean(resolveFleetProject(env)) && Boolean(resolveFleetSender(env))
}

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
  const project = resolveFleetProject(env)
  const from = resolveFleetSender(env)
  // Fail closed: never send to a default/company project from an unscoped pot.
  if (!project || !from) return false
  const res = await fetch(`${busUrl(env)}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.BUS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: agent,
      from,
      project,
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
  const project = resolveFleetProject(env)
  const from = resolveFleetSender(env)
  const ops = resolveFleetOpsAgent(env)
  // Fail closed: a pot with no explicit ops agent / project must NOT route
  // control to the company default (`kasra`/`sos`).
  if (!project || !from || !ops) return { ok: false, error: 'fleet_not_scoped' }
  const requestId = crypto.randomUUID()
  const res = await fetch(`${busUrl(env)}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.BUS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: ops,
      from,
      project,
      text: `[request_id:${requestId}] FLEET CONTROL from ${by} via dashboard: ${action.toUpperCase()} agent "${agent}". Execute server-side (token flag / service / tmux as appropriate) and ack with result.`,
    }),
  })
  return res.ok ? { ok: true, request_id: requestId } : { ok: false, error: `bus_${res.status}` }
}
