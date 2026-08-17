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
import { resolveOrgAdmin } from '../auth/member-bearer'
import { dispatchFlight } from './dispatch'
import {
  deliverFlightLandedEvent,
  failFlight,
  getFlight,
  // landFlight is deliberately NOT imported here any more. It is the ungoverned land
  // primitive — a bare UPDATE to status='landed' with no gate, no actor and no receipt
  // — and this route was its only production caller (#911). It remains exported from
  // ../service and covered by tests/flight-service.test.ts, but nothing in production
  // calls it now; removing it outright is a follow-up, not part of this fix.
  landGovernedFlight,
  listFlights,
  listFlightProjectMismatchTaskIds,
  listIncompleteFlightTaskIds,
  FlightProjectError,
  type FlightStatus,
  type TriggerSource,
} from './service'
import type { FlightSignals, PreflightOptions } from './preflight'
import { FLIGHT_META_V1_SCHEMA, parseFlightMetaV1, validateFlightMetaReferences, type FlightMetaV1 } from './meta'
import { deriveActiveCollisions } from './board'

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
  flight: {
    agent: string
    dispatched_by?: string
    goal: string
    project_id?: string | null
    trigger_source?: TriggerSource
    budget_micro_usd?: number
    meta?: FlightMetaV1
  }
  signals: FlightSignals
  opts: PreflightOptions
}

export interface DispatchParseError {
  ok: false
  error: string
  /** Structured detail for the specific error (e.g. which key was unrecognised or missing). */
  detail?: unknown
}

// ── signals_json casing (mupot#940) ─────────────────────────────────────────
//
// The tool's args string never documented signals_json's shape, and meta_json in
// the SAME call uses snake_case — so snake_case is the natural guess, and it was
// silently wrong: an unrecognised key just read as `undefined`, coerced to a
// falsy default, and the readiness gate scored the (missing) input as if it had
// been CHECKED and found bad — 'tools_unreachable' when the truth was "you never
// told me". See docs on FlightSignals (preflight.ts) for the canonical
// (camelCase) field set. Fixed here, in priority order:
//   1. accept EITHER casing (normalise before scoring) — cheapest, kills the class
//   2. documented in the tool's args string (src/mcp/index.ts)
//   3. an unrecognised key is refused LOUDLY (signals_unknown_key), never scored
//   4. a MISSING key is refused LOUDLY (signals_missing_fields), never defaulted
//      into a "checked and failed" reason — that distinction is the actual fix;
//      1-3 just make the failure mode easy to find in seconds instead of an hour.
const SIGNAL_FIELD_ALIASES: ReadonlyArray<{ canonical: keyof FlightSignals; camel: string; snake: string }> = [
  { canonical: 'contextComplete', camel: 'contextComplete', snake: 'context_complete' },
  { canonical: 'toolsReachable', camel: 'toolsReachable', snake: 'tools_reachable' },
  { canonical: 'budgetRemainingMicroUsd', camel: 'budgetRemainingMicroUsd', snake: 'budget_remaining_micro_usd' },
  { canonical: 'budgetEstimateMicroUsd', camel: 'budgetEstimateMicroUsd', snake: 'budget_estimate_micro_usd' },
  { canonical: 'recentProgress', camel: 'recentProgress', snake: 'recent_progress' },
  { canonical: 'progressPerStep', camel: 'progressPerStep', snake: 'progress_per_step' },
  { canonical: 'wastePerStep', camel: 'wastePerStep', snake: 'waste_per_step' },
  { canonical: 'stepSeconds', camel: 'stepSeconds', snake: 'step_seconds' },
]
const SIGNAL_KEY_ALLOWLIST: ReadonlySet<string> = new Set(
  SIGNAL_FIELD_ALIASES.flatMap((f) => [f.camel, f.snake]),
)

/**
 * Normalise a signals object that may use either camelCase or snake_case keys
 * (mupot#940). Refuses (rather than silently drops) any key outside the known
 * camel/snake alias set, and refuses (rather than defaults) any of the 8
 * required fields that is absent under BOTH spellings — a MISSING signal is a
 * caller mistake, not evidence the thing it describes was checked and failed.
 */
function normalizeSignalsInput(s: Record<string, unknown>): { ok: true; value: FlightSignals } | DispatchParseError {
  for (const key of Object.keys(s)) {
    if (!SIGNAL_KEY_ALLOWLIST.has(key)) {
      return { ok: false, error: 'signals_unknown_key', detail: { key } }
    }
  }

  const missing: string[] = []
  const raw: Record<string, unknown> = {}
  for (const field of SIGNAL_FIELD_ALIASES) {
    // Both spellings present is treated as caller redundancy, not conflict —
    // prefer camelCase (the documented canonical form) when both are given.
    if (field.camel in s) {
      raw[field.canonical] = s[field.camel]
    } else if (field.snake in s) {
      raw[field.canonical] = s[field.snake]
    } else {
      missing.push(field.canonical)
    }
  }
  if (missing.length > 0) {
    return { ok: false, error: 'signals_missing_fields', detail: { missing } }
  }

  return {
    ok: true,
    value: {
      contextComplete: asBool(raw.contextComplete),
      toolsReachable: asBool(raw.toolsReachable),
      budgetRemainingMicroUsd: asNum(raw.budgetRemainingMicroUsd, 0, 0),
      budgetEstimateMicroUsd: asNum(raw.budgetEstimateMicroUsd, 0, 0),
      recentProgress: asNum(raw.recentProgress, 0, 0, 1),
      progressPerStep: asNum(raw.progressPerStep, 0, 0, 1),
      wastePerStep: asNum(raw.wastePerStep, 0, 0, 1),
      stepSeconds: asNum(raw.stepSeconds, 0, 0),
    },
  }
}

/**
 * Parse + validate a dispatch request body. Returns the typed dispatch inputs, or an
 * error string. The brain MUST supply the full signal set (it owns context/budget);
 * a missing signal block — or a missing individual field within it — is rejected
 * rather than defaulted to a launch (mupot#940).
 */
export function parseDispatchBody(raw: unknown): { ok: true; value: DispatchBody } | DispatchParseError {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body_required' }
  const b = raw as Record<string, unknown>
  const agent = asStr(b.agent, 120)
  const goal = asStr(b.goal, 2000)
  if (!agent) return { ok: false, error: 'agent_required' }
  if (!goal) return { ok: false, error: 'goal_required' }
  if (typeof b.signals !== 'object' || b.signals === null) return { ok: false, error: 'signals_required' }
  const dispatchedBy = b.dispatched_by == null ? undefined : asStr(b.dispatched_by, 120)

  const trigger = typeof b.trigger_source === 'string' && TRIGGERS.has(b.trigger_source) ? (b.trigger_source as TriggerSource) : 'api'
  const budget = b.budget_micro_usd == null ? undefined : asNum(b.budget_micro_usd, 0, 0)
  const projectId = b.project_id == null
    ? undefined
    : typeof b.project_id === 'string' && b.project_id.trim().length > 0 && b.project_id.length <= 200
      ? b.project_id.trim()
      : null
  if (projectId === null) return { ok: false, error: 'invalid_project_id' }
  const meta = b.meta == null ? undefined : parseFlightMetaV1(b.meta)
  if (b.meta != null && !meta) return { ok: false, error: 'invalid_flight_meta' }

  const normalized = normalizeSignalsInput(b.signals as Record<string, unknown>)
  if (!normalized.ok) return normalized
  const signals = normalized.value

  const o = (typeof b.opts === 'object' && b.opts !== null ? b.opts : {}) as Record<string, unknown>
  const opts: PreflightOptions = {}
  if (o.scoreThreshold != null) opts.scoreThreshold = asNum(o.scoreThreshold, 0.5, 0, 1)
  if (o.cacheWindowSeconds != null) opts.cacheWindowSeconds = asNum(o.cacheWindowSeconds, 300, 0)
  if (o.minProgressRatio != null) opts.minProgressRatio = asNum(o.minProgressRatio, 1, 0)

  return {
    ok: true,
    value: {
      flight: {
        agent,
        ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
        goal,
        project_id: projectId,
        trigger_source: trigger,
        budget_micro_usd: budget,
        meta: meta ?? undefined,
      },
      signals,
      opts,
    },
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

// auth: org-admin via member-token bearer — shared with the orient field-push
// (resolveOrgAdmin in auth/member-bearer). No session; dispatch spends money.
const requireOrgAdmin = resolveOrgAdmin

// ── the connector app ──────────────────────────────────────────────────────────

export const flightsApp = new Hono<{ Bindings: Env }>()

// Dispatch — the brain tees up a gated, recorded flight on a detected defect.
flightsApp.post('/', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const raw = await c.req.json().catch(() => null)
  const parsed = parseDispatchBody(raw)
  if (!parsed.ok) return c.json({ error: parsed.error, ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}) }, 400)

  const { flight, signals, opts } = parsed.value
  if (flight.meta) {
    const references = await validateFlightMetaReferences(c.env, flight.meta, flight.project_id)
    if (!references.ok) {
      return c.json(
        { error: references.error },
        references.error === 'flight_task_not_found' ? 404 : 400,
      )
    }
  }
  let result
  try {
    result = await dispatchFlight(c.env, flight, signals, opts)
  } catch (error) {
    if (!(error instanceof FlightProjectError)) throw error
    const status = error.code === 'project_not_found' || error.code === 'flight_task_not_found'
      ? 404
      : error.code === 'project_access_forbidden'
        ? 403
        : 400
    return c.json(
      error.code === 'project_access_forbidden'
        ? { error: 'forbidden', need: 'project_write' }
        : { error: error.code },
      status,
    )
  }
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

  const storedMetaShape = await c.env.DB.prepare(`
    WITH parsed(meta) AS (
      SELECT CASE
        WHEN json_valid(?1) AND json_type(?1) = 'object' THEN ?1
        ELSE '{}'
      END
    ), top_level AS (
      SELECT key, type, value FROM parsed, json_each(parsed.meta)
    )
    SELECT COUNT(*) AS key_count,
           COUNT(DISTINCT key) AS distinct_key_count,
           COALESCE(SUM(CASE
             WHEN key = 'schema' AND type = 'text' AND value = ?2 THEN 1
             ELSE 0
           END), 0) AS v1_schema_count
      FROM top_level
  `).bind(existing.meta, FLIGHT_META_V1_SCHEMA).first<{
    key_count: number
    distinct_key_count: number
    v1_schema_count: number
  }>()
  const hasDuplicateMetaKeys = Number(storedMetaShape?.key_count ?? 0)
    !== Number(storedMetaShape?.distinct_key_count ?? 0)
  const declaresGovernedV1 = Number(storedMetaShape?.v1_schema_count ?? 0) > 0

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  let governedMeta: FlightMetaV1 | null = null
  let storedMeta: unknown = null
  try {
    storedMeta = JSON.parse(existing.meta)
    governedMeta = parseFlightMetaV1(storedMeta)
  } catch {
    governedMeta = null
  }
  if (hasDuplicateMetaKeys || (declaresGovernedV1 && !governedMeta)) {
    return c.json({ error: 'flight_meta_incompatible' }, 409)
  }
  if (governedMeta) {
    const cost = b.cost_micro_usd == null ? 0 : b.cost_micro_usd
    const score = b.score
    if (!Number.isSafeInteger(cost) || (cost as number) < 0) {
      return c.json({ error: 'invalid_flight_cost' }, 400)
    }
    if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      return c.json({ error: 'invalid_flight_score' }, 400)
    }
    if (!['running', 'waiting', 'sleeping'].includes(existing.status)) {
      return c.json({ error: 'flight_not_in_air', status: existing.status }, 409)
    }
    if (!Number.isSafeInteger(existing.budget_micro_usd) || (existing.budget_micro_usd as number) < 0) {
      return c.json({ error: 'flight_budget_policy_missing' }, 409)
    }
    if ((cost as number) > (existing.budget_micro_usd as number)) {
      return c.json({ error: 'flight_budget_exceeded', budget_micro_usd: existing.budget_micro_usd }, 409)
    }
    const landing = await landGovernedFlight(c.env, id, {
      cost_micro_usd: cost as number,
      score: score as number | undefined,
      agent_id: existing.agent,
      meta: governedMeta,
      actor: { kind: 'member', id: auth.id.memberId },
    })
    // See the note in src/mcp/index.ts — a missing receipt is not a failed landing (#916).
    if (!landing.transitioned) {
      const projectMismatchTaskIds = await listFlightProjectMismatchTaskIds(
        c.env,
        existing.project_id,
        governedMeta.task_ids,
      )
      if (projectMismatchTaskIds.length > 0) {
        return c.json({ error: 'flight_task_project_conflict', task_ids: projectMismatchTaskIds }, 409)
      }
      const incompleteTaskIds = await listIncompleteFlightTaskIds(c.env, governedMeta.task_ids)
      if (incompleteTaskIds.length > 0) {
        return c.json({ error: 'flight_tasks_incomplete', task_ids: incompleteTaskIds }, 409)
      }
      return c.json({ error: 'flight_transition_conflict' }, 409)
    }
    const landed = await getFlight(c.env, id)
    if (!landed || landed.status !== 'landed') return c.json({ error: 'flight_record_missing' }, 500)
    if (!landing.receipt) {
      // Same signal the MCP path emits. Without it the org-admin land surface can open a
      // permanent audit gap with no trace anywhere.
      console.error('flight landed without a receipt', { flight_id: landed.id })
    }
    await deliverFlightLandedEvent(c.env, landed.id)
    return c.json({ ok: true, id, status: landed.status })
  }

  // NON-v1 META — REFUSED (mupot#911).
  //
  // Control used to FALL THROUGH to here and call landFlight() directly. Every gate
  // above was skipped: no in-air status check, no budget policy check, no budget
  // ceiling check, no task-completion check, no gate-verdict check, no actor
  // attribution — and, most importantly, NO RECEIPT and no flight.landed event. The
  // flight went to status='landed' with a cost recorded against it and nothing
  // anywhere attesting that it was allowed to.
  //
  // The console.error thirty lines above already called that outcome "a permanent
  // audit gap with no trace anywhere" — for the case where a GOVERNED landing merely
  // loses its receipt. This path produced the same gap unconditionally, by design,
  // and was the only land path in the codebase with no test covering it. That is not
  // a coincidence: an untested branch is how a known-bad path survives being written
  // down next to a warning about itself.
  //
  // WHY REFUSE RATHER THAN GOVERN-BY-DEFAULT. There is no meta to govern with. The
  // gates need task_ids, squad_ids and a goal/objective to check anything; a flight
  // that never declared them cannot be checked, only waved through. Fabricating an
  // empty FlightMetaV1 to satisfy the type would make the gates pass vacuously — a
  // check whose query entails its own answer is not a check.
  //
  // WHY 409 AND NOT 400. The request body is fine; the STORED FLIGHT is what cannot
  // be governed. Every other refusal in this handler is a 409 on resource state
  // (flight_not_in_air, flight_budget_exceeded, flight_meta_incompatible,
  // flight_transition_conflict) and this is the same kind of thing. A lone 400 among
  // them reads as "fix your request and retry", which is advice the caller cannot act
  // on. `flight_meta_incompatible` directly above — meta that DECLARES v1 but fails
  // to parse — is the same refusal for the adjacent case, at the same status.
  //
  // WHAT A CALLER DOES NOW. An ungoverned flight can still reach a terminal state via
  // POST /:id/fail, which is the honest one: a flight nobody can attest to did not
  // land successfully. To land, dispatch with `meta` (mupot.flight.meta/v1).
  //
  // NOT CLOSED HERE, deliberately, and left for the gate: POST /api/flights still
  // ACCEPTS a dispatch with no meta (`b.meta == null` → undefined → stored as '{}'),
  // so this surface can still mint a flight that is born unlandable. The MCP twin
  // requires v1 meta at BOTH ends already (flight_dispatch → 400 invalid_flight_meta,
  // flight_land → 404), so closing dispatch here is what brings the two surfaces to
  // one predicate. It is not in this PR because it changes the published contract in
  // docs/coherence-loop-brain-caller.md and touches ~25 dispatch call sites — a scope
  // decision, not a defect fix. See the doc note added alongside this change.
  const observedSchema = typeof (storedMeta as Record<string, unknown> | null)?.schema === 'string'
    ? ((storedMeta as Record<string, unknown>).schema as string).slice(0, 100)
    : null
  return c.json(
    {
      error: 'flight_meta_ungoverned',
      detail:
        'This flight did not declare governed metadata, so budget, task-completion and ' +
        'gate checks cannot be evaluated and no landing receipt can be written. Landing ' +
        'it would record a terminal outcome with nothing attesting to it. Use POST ' +
        '/:id/fail to close an ungoverned flight, or dispatch with meta to land one.',
      expected_schema: FLIGHT_META_V1_SCHEMA,
      observed_schema: observedSchema,
    },
    409,
  )
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

  const params = new URL(c.req.url).searchParams
  const q = parseOutcomeQuery(params)
  const rawProjectId = params.get('project_id')
  const projectId = rawProjectId === null ? undefined : rawProjectId.trim()
  if (projectId !== undefined && (projectId.length === 0 || projectId.length > 200)) return c.json({ error: 'invalid_project_id' }, 400)
  const all = await listFlights(c.env, 500, projectId)
  const statusSet = q.statuses ? new Set<FlightStatus>(q.statuses) : null
  const flights = all
    .filter((f) => (statusSet ? statusSet.has(f.status) : true))
    .filter((f) => (q.sinceMs == null ? true : (f.ended_at ?? f.created_at) > q.sinceMs))
    .slice(0, q.limit)
    .map((f) => ({
      id: f.id,
      project_id: f.project_id,
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

// Collisions — the ATC tower's current cross-flight HOLD/WARN view (read-only,
// tenant-scoped via listFlights, same auth as the other flight reads).
flightsApp.get('/collisions', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const flights = await listFlights(c.env, 500)
  const { holds, warns } = deriveActiveCollisions(flights)
  return c.json({ holds, warns })
})
