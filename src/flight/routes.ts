// flight/routes — the coherence-loop connector API (#70, v0.20).
//
// This is the WIRE that closes the loop without forking the brain. The brain
// (SOS/sovereign, the sole coherence organ) detects a defect and calls these
// endpoints INBOUND; the pot stays sealed (no egress) because the brain pulls.
//
//   POST /api/flights         brain detects defect → dispatch (create + readiness gate + record)
//   POST /api/flights/:id/land   executor reports a successful outcome (cost + coherence score)
//   POST /api/flights/:id/fail   executor reports a failed outcome (reason)
//   GET  /api/flights          brain pulls outcomes (status/since cursor) → re-measures C(t)
//
// SECURITY SURFACE — dispatch SPENDS MONEY, so all four endpoints require org-admin
// (the brain is an org-admin service principal). Auth is the pot member-token bearer
// (same path as check-in), never a session; tenant is environment-derived. The pot
// does NOT compute coherence here — it records flights + serves outcomes; the brain
// measures. See docs/coherence-model.md + docs/coherence-loop-brain-caller.md.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken, type AgentIdentity } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { dispatchFlight } from './dispatch'
import { landFlight, failFlight, getFlight, listFlights, type FlightStatus, type TriggerSource } from './service'
import type { FlightSignals, PreflightOptions } from './preflight'

// ── input parsing (pure, exported for tests) ──────────────────────────────────

const TRIGGERS: ReadonlySet<string> = new Set(['manual', 'schedule', 'api', 'event', 'cron'])
const STATUSES: ReadonlySet<string> = new Set(['preflight', 'held', 'running', 'waiting', 'sleeping', 'landed', 'failed'])

function asBool(v: unknown): boolean {
  return v === true
}
// Finite number in [min,max], else fallback. Never trusts NaN/Infinity/string in.
function asNum(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(Math.max(n, min), max)
}
function asStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max).trim() : ''
}

export interface DispatchBody {
  flight: { agent: string; goal: string; trigger_source?: TriggerSource; budget_micro_usd?: number }
  signals: FlightSignals
  opts: PreflightOptions
}

/**
 * Parse + validate a dispatch request body. Returns the typed dispatch inputs, or an
 * error string. The brain MUST supply the full signal set (it owns context/budget);
 * a missing signal block is rejected rather than defaulted to a launch.
 */
export function parseDispatchBody(raw: unknown): { ok: true; value: DispatchBody } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body_required' }
  const b = raw as Record<string, unknown>
  const agent = asStr(b.agent, 120)
  const goal = asStr(b.goal, 2000)
  if (!agent) return { ok: false, error: 'agent_required' }
  if (!goal) return { ok: false, error: 'goal_required' }
  if (typeof b.signals !== 'object' || b.signals === null) return { ok: false, error: 'signals_required' }
  const s = b.signals as Record<string, unknown>

  const trigger = typeof b.trigger_source === 'string' && TRIGGERS.has(b.trigger_source) ? (b.trigger_source as TriggerSource) : 'api'
  const budget = b.budget_micro_usd == null ? undefined : asNum(b.budget_micro_usd, 0, 0)

  const signals: FlightSignals = {
    contextComplete: asBool(s.contextComplete),
    toolsReachable: asBool(s.toolsReachable),
    budgetRemainingMicroUsd: asNum(s.budgetRemainingMicroUsd, 0, 0),
    budgetEstimateMicroUsd: asNum(s.budgetEstimateMicroUsd, 0, 0),
    recentProgress: asNum(s.recentProgress, 0, 0, 1),
    progressPerStep: asNum(s.progressPerStep, 0, 0, 1),
    wastePerStep: asNum(s.wastePerStep, 0, 0, 1),
    stepSeconds: asNum(s.stepSeconds, 0, 0),
  }

  const o = (typeof b.opts === 'object' && b.opts !== null ? b.opts : {}) as Record<string, unknown>
  const opts: PreflightOptions = {}
  if (o.scoreThreshold != null) opts.scoreThreshold = asNum(o.scoreThreshold, 0.5, 0, 1)
  if (o.cacheWindowSeconds != null) opts.cacheWindowSeconds = asNum(o.cacheWindowSeconds, 300, 0)
  if (o.minProgressRatio != null) opts.minProgressRatio = asNum(o.minProgressRatio, 1, 0)

  return {
    ok: true,
    value: { flight: { agent, goal, trigger_source: trigger, budget_micro_usd: budget }, signals, opts },
  }
}

export interface OutcomeQuery {
  statuses: FlightStatus[] | null // null = all
  sinceMs: number | null
  limit: number
}

/** Parse the outcome-feed query (?status=landed,failed&since=<ms>&limit=N). */
export function parseOutcomeQuery(q: URLSearchParams): OutcomeQuery {
  const statusRaw = q.get('status')
  const statuses = statusRaw
    ? (statusRaw.split(',').map((x) => x.trim()).filter((x) => STATUSES.has(x)) as FlightStatus[])
    : null
  const sinceRaw = q.get('since')
  const sinceN = sinceRaw == null ? NaN : Number(sinceRaw)
  const sinceMs = Number.isFinite(sinceN) && sinceN > 0 ? sinceN : null
  // q.get('limit') is null when absent; Number(null) is 0 (finite!), so guard on presence.
  const limitRaw = q.get('limit')
  const limitN = limitRaw == null ? NaN : Number(limitRaw)
  const limit = Number.isFinite(limitN) && limitN >= 1 ? Math.min(limitN, 500) : 200
  return { statuses: statuses && statuses.length > 0 ? statuses : null, sinceMs, limit }
}

// ── auth: org-admin via member-token bearer (no session; dispatch spends money) ─

async function requireOrgAdmin(
  env: Env,
  authHeader: string | null | undefined,
): Promise<{ ok: true; id: AgentIdentity } | { ok: false; status: 401 | 403 }> {
  const id = await resolveMemberByToken(env, bearerToken(authHeader))
  if (!id) return { ok: false, status: 401 } // generic — no auth oracle
  const caps = await resolveCapabilities(env, id.memberId)
  if (!hasCapability(caps, 'org', null, 'admin')) return { ok: false, status: 403 }
  return { ok: true, id }
}

// ── the connector app ──────────────────────────────────────────────────────────

export const flightsApp = new Hono<{ Bindings: Env }>()

// Dispatch — the brain tees up a gated, recorded flight on a detected defect.
flightsApp.post('/', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const raw = await c.req.json().catch(() => null)
  const parsed = parseDispatchBody(raw)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const { flight, signals, opts } = parsed.value
  const result = await dispatchFlight(c.env, flight, signals, opts)
  // 201 on launch (GO), 200 on a recorded NO-GO hold (not an error — the gate worked).
  return c.json(result, result.go ? 201 : 200)
})

// Land — executor reports a successful outcome (cost + coherence score) for re-measure.
flightsApp.post('/:id/land', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const id = c.req.param('id')
  const existing = await getFlight(c.env, id)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const cost_micro_usd = b.cost_micro_usd == null ? undefined : asNum(b.cost_micro_usd, 0, 0)
  const score = b.score == null ? undefined : asNum(b.score, 0, 0, 1)
  await landFlight(c.env, id, { cost_micro_usd, score })
  const after = await getFlight(c.env, id)
  return c.json({ ok: true, id, status: after?.status ?? 'landed' })
})

// Fail — executor reports a failed outcome.
flightsApp.post('/:id/fail', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const id = c.req.param('id')
  const existing = await getFlight(c.env, id)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const reason = asStr(b.reason, 500) || 'unspecified'
  await failFlight(c.env, id, reason)
  const after = await getFlight(c.env, id)
  return c.json({ ok: true, id, status: after?.status ?? 'failed' })
})

// Outcome feed — the brain pulls landed/failed flights since its cursor to re-measure.
flightsApp.get('/', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const q = parseOutcomeQuery(new URL(c.req.url).searchParams)
  const all = await listFlights(c.env, 500)
  const statusSet = q.statuses ? new Set<FlightStatus>(q.statuses) : null
  const flights = all
    .filter((f) => (statusSet ? statusSet.has(f.status) : true))
    .filter((f) => (q.sinceMs == null ? true : (f.ended_at ?? f.created_at) > q.sinceMs))
    .slice(0, q.limit)
    .map((f) => ({
      id: f.id,
      agent: f.agent,
      goal: f.goal,
      status: f.status,
      score: f.score,
      cost_micro_usd: f.cost_micro_usd,
      created_at: f.created_at,
      ended_at: f.ended_at,
    }))
  // cursor = max ended_at/created_at seen, so the brain can poll incrementally.
  const cursor = flights.reduce((m, f) => Math.max(m, f.ended_at ?? f.created_at), q.sinceMs ?? 0)
  return c.json({ flights, cursor })
})
