// /dashboard/fleet — company-fleet roster and wake/control (ADR gh #473).
//
// Coordination substrate is mupot CF-native:
//   - roster/presence → D1 (fleet_agents / presence / module_registry)
//   - wake / control asks → agent_messages (send) + mupot-events Queue (agent.wake)
//   - host process control → signed emitControlRequest (src/fleet/control.ts)
//
// SOS Redis bus (BUS_URL + BUS_TOKEN → bus.mumega.com) is a documented compat
// shim only — see docs/architecture/sos-coordination-compat.md. Active fleet
// routes must not call it.

import type { Env } from '../types'
import { createBus } from '../bus'
import { sendAgentMessage } from '../agents/messages'
import { resolveAgentRef } from '../org/resolve'
import { listFleetAgentRuntimeView, type FleetAgentRuntimeView } from '../fleet/registry'

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

/** SQLite datetime('now') → epoch ms (local helper; public twin lives in fleet/presence). */
function sqliteUtcToMs(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : ms
}

/** Compat shim: true when legacy SOS bus secrets are still present (unused by routes). */
export function busConfigured(env: Env): boolean {
  return Boolean(env.BUS_TOKEN && (env.BUS_URL || DEFAULT_BUS_URL))
}

/** @deprecated SOS bridge default — retained only so busConfigured() can detect leftover secrets. */
const DEFAULT_BUS_URL = 'https://bus.mumega.com'

// Fleet project / sender / ops resolvers (Flock #43). Fail closed — never fall
// back to company `sos`/`kasra` from an unscoped pot.
export function resolveFleetProject(env: Env): string | null {
  return env.FLEET_PROJECT?.trim() || env.TENANT_SLUG?.trim() || null
}

export function resolveFleetSender(env: Env): string | null {
  const slug = env.TENANT_SLUG?.trim()
  return slug ? `mupot-${slug}-hq` : null
}

export function resolveFleetOpsAgent(env: Env): string | null {
  return env.FLEET_OPS_AGENT?.trim() || null
}

/** Pot is scoped for CF-native fleet messaging when tenant + sender resolve. */
export function fleetScoped(env: Env): boolean {
  return Boolean(resolveFleetProject(env)) && Boolean(resolveFleetSender(env))
}

function presenceToLiveness(p: FleetAgentRuntimeView['presence']): FleetLiveness {
  if (p === 'live') return 'active'
  if (p === 'stale') return 'idle'
  return 'dead'
}

function rowFromRuntime(view: FleetAgentRuntimeView, nowMs: number): FleetRow {
  const lastSeenMs = sqliteUtcToMs(view.last_seen)
  return {
    agent: view.agent_id,
    label: view.display || view.runtime || '—',
    project: null,
    active_token: view.status === 'running',
    last_seen_ms: lastSeenMs,
    messages: 0,
    liveness: presenceToLiveness(view.presence),
    last_seen_human: humanAge(lastSeenMs, nowMs),
  }
}

function rowFromPresence(
  row: {
    member_id: string
    display_name: string
    source: string
    label: string
    agent_id: string | null
    last_seen_at: string
  },
  nowMs: number,
): FleetRow {
  const lastSeenMs = sqliteUtcToMs(row.last_seen_at)
  return {
    agent: row.agent_id || row.member_id,
    label: row.label || row.source || row.display_name || '—',
    project: null,
    active_token: classify(lastSeenMs, nowMs) === 'active',
    last_seen_ms: lastSeenMs,
    messages: 0,
    liveness: classify(lastSeenMs, nowMs),
    last_seen_human: humanAge(lastSeenMs, nowMs),
  }
}

/** CF-native roster: fleet_agents registry first, else pot check-in presence. */
export async function loadFleet(env: Env, nowMs: number): Promise<FleetRow[]> {
  const runtime = await listFleetAgentRuntimeView(env, nowMs)
  if (runtime.length > 0) {
    return runtime.map((v) => rowFromRuntime(v, nowMs))
  }
  // Inline presence read (avoid importing listPresence — that module imports classify here).
  const res = await env.DB.prepare(
    `SELECT member_id, display_name, source, label, agent_id, last_seen_at
       FROM presence WHERE tenant = ?1 ORDER BY last_seen_at DESC LIMIT 200`,
  )
    .bind(env.TENANT_SLUG)
    .all<{
      member_id: string
      display_name: string
      source: string
      label: string
      agent_id: string | null
      last_seen_at: string
    }>()
  return (res.results ?? []).map((p) => rowFromPresence(p, nowMs))
}

export interface FleetActor {
  memberId: string
  boundAgentId: string | null
  label: string
}

/** Direct wake: durable inbox ping + agent.wake Queue event (no SOS bus). */
export async function wakeFleetAgent(env: Env, agent: string, by: FleetActor): Promise<boolean> {
  const from = resolveFleetSender(env)
  if (!from) return false

  const resolved = await resolveAgentRef(env, agent)
  if (!resolved.ok) return false

  const fromAgent = by.boundAgentId ?? from
  const body = `[fleet-dashboard] wake requested by ${by.label} — report status on the pot inbox.`
  const send = await sendAgentMessage(
    env,
    {
      fromAgent,
      fromMember: by.memberId,
      toAgent: resolved.value.id,
      kind: 'message',
      body,
      requestId: `fleet-wake:${resolved.value.id}:${crypto.randomUUID()}`,
    },
    {
      system: true,
      reason: 'target resolved server-side via resolveAgentRef for an org-admin dashboard action',
    },
  )
  if (!send.ok) return false

  try {
    await createBus(env).emit({
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: resolved.value.squad_id,
      agent_id: resolved.value.id,
      actor: { kind: 'member', id: by.memberId },
      payload: { by: by.label, reason: 'fleet-dashboard-wake' },
      ts: new Date().toISOString(),
    })
  } catch {
    // Inbox delivery is the durable path; Queue wake is best-effort.
  }
  return true
}

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'deactivate', 'delete'])

/**
 * Control request: receipted ask to the pot's ops agent via agent_messages.
 * Never a direct host action — host process control uses emitControlRequest.
 */
export async function requestFleetControl(
  env: Env,
  agent: string,
  action: string,
  by: FleetActor,
): Promise<{ ok: boolean; request_id?: string; error?: string }> {
  if (!CONTROL_ACTIONS.has(action)) return { ok: false, error: 'unknown_action' }
  const from = resolveFleetSender(env)
  const ops = resolveFleetOpsAgent(env)
  if (!from || !ops) return { ok: false, error: 'fleet_not_scoped' }

  const opsResolved = await resolveAgentRef(env, ops)
  if (!opsResolved.ok) return { ok: false, error: 'ops_agent_not_found' }

  const requestId = crypto.randomUUID()
  const fromAgent = by.boundAgentId ?? from
  const send = await sendAgentMessage(
    env,
    {
      fromAgent,
      fromMember: by.memberId,
      toAgent: opsResolved.value.id,
      kind: 'request',
      body: `[request_id:${requestId}] FLEET CONTROL from ${by.label} via dashboard: ${action.toUpperCase()} agent "${agent}". Execute server-side (token flag / service / tmux as appropriate) and ack with result.`,
      requestId: `fleet-ctl:${requestId}`,
    },
    {
      system: true,
      reason: 'ops target is env.FLEET_OPS_AGENT resolved server-side, never attacker-controlled id alone',
    },
  )
  return send.ok ? { ok: true, request_id: requestId } : { ok: false, error: send.reason }
}
