// flight/service — the flight record lifecycle (the dispatch spine, Flight #61/#62).
//
// A flight = one bounded run of an agent toward a goal. Lifecycle:
//   preflight → held (NO-GO) | running → waiting (human gate) | sleeping → landed | failed
// All tenant-scoped. Transition guards live in each UPDATE's WHERE (a terminal flight
// cannot be revived; a held/landed flight cannot be re-landed) — same discipline as loops.

import type { Env } from '../types'
import { createBus } from '../bus'
import type { PreflightResult } from './preflight'
import type { FlightMetaV1 } from './meta'

const D1_TASK_ID_QUERY_CHUNK_SIZE = 90

export type FlightStatus =
  | 'preflight'
  | 'held'
  | 'running'
  | 'waiting'
  | 'sleeping'
  | 'landed'
  | 'failed'

export type TriggerSource = 'manual' | 'schedule' | 'api' | 'event' | 'cron'

export interface FlightRow {
  id: string
  tenant: string
  project_id: string | null
  agent: string
  // Who DISPATCHED this flight — may differ from `agent` (who FLIES it) when a
  // lead delegates the flight to another agent's seat (mupot flight_dispatch
  // executor-delegation; 0094_flight_dispatched_by.sql). Both are always
  // recoverable; neither field is ever overwritten to hide the other.
  dispatched_by_agent_id: string
  goal: string
  status: FlightStatus
  trigger_source: TriggerSource
  gate_verdict: string | null
  gate_reason: string
  score: number | null
  budget_micro_usd: number | null
  cost_micro_usd: number
  next_run_at: number | null
  created_at: number
  started_at: number | null
  ended_at: number | null
  meta: string
  // Server-joined canonical names (Flight-006 Slice 2). Absent on hand-built
  // rows / when the agent has since been deleted; callers fall back to `agent`.
  agent_name?: string | null
  squad_name?: string | null
}

export interface NewFlight {
  agent: string
  // Who is dispatching this flight, if different from `agent`. Omitted (the
  // common case — schedule/cron dispatch, or a member dispatching under their
  // own seat) defaults to `agent` itself in createFlight: self-dispatch is a
  // true fact, not a placeholder.
  dispatched_by?: string
  goal: string
  project_id?: string | null
  trigger_source?: TriggerSource
  budget_micro_usd?: number
  meta?: FlightMetaV1
}

export interface CreateFlightOptions {
  /** Internal deterministic identity for crash-safe control-plane replay. */
  id?: string
  /** Internal atomic fence used by Routine dispatch before creating control work. */
  routineRunFence?: { runId: string; tenant: string }
}

export class FlightCreateFenceError extends Error {
  constructor() {
    super('routine_dispatch_fenced')
    this.name = 'FlightCreateFenceError'
  }
}

export type FlightProjectErrorCode =
  | 'invalid_project_id'
  | 'invalid_flight_meta'
  | 'project_not_found'
  | 'archived_project'
  | 'project_access_forbidden'
  | 'flight_task_not_found'
  | 'flight_task_project_mismatch'

export class FlightProjectError extends Error {
  constructor(readonly code: FlightProjectErrorCode) {
    super(code)
    this.name = 'FlightProjectError'
  }
}

export async function validateFlightProjectTarget(
  env: Env,
  projectId: NewFlight['project_id'],
): Promise<void> {
  projectId = projectId ?? null
  if (projectId === null) return
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new FlightProjectError('invalid_project_id')
  }
  const project = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1')
    .bind(projectId)
    .first<{ status: string }>()
  if (!project) throw new FlightProjectError('project_not_found')
  if (project.status === 'archived') throw new FlightProjectError('archived_project')
}

export async function validateFlightTaskProjectConsistency(
  env: Env,
  projectId: NewFlight['project_id'],
  meta: NewFlight['meta'],
): Promise<void> {
  projectId = projectId ?? null
  if (projectId !== null && meta) {
    const tasks = new Map<string, { id: string; project_id: string | null }>()
    for (let offset = 0; offset < meta.task_ids.length; offset += D1_TASK_ID_QUERY_CHUNK_SIZE) {
      const chunk = meta.task_ids.slice(offset, offset + D1_TASK_ID_QUERY_CHUNK_SIZE)
      const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',')
      const rows = await env.DB.prepare(
        `SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`,
      ).bind(...chunk).all<{ id: string; project_id: string | null }>()
      for (const task of rows.results ?? []) tasks.set(task.id, task)
    }
    if (meta.task_ids.some((taskId) => !tasks.has(taskId))) {
      throw new FlightProjectError('flight_task_not_found')
    }
    if (meta.task_ids.some((taskId) => tasks.get(taskId)?.project_id !== projectId)) {
      throw new FlightProjectError('flight_task_project_mismatch')
    }
  }
}

export async function validateFlightProjectAttribution(env: Env, flight: NewFlight): Promise<void> {
  await validateFlightProjectTarget(env, flight.project_id)
  await validateFlightTaskProjectConsistency(env, flight.project_id, flight.meta)
}

function mapFlightProjectInsertError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('flight meta invalid')) throw new FlightProjectError('invalid_flight_meta')
  if (message.includes('flight project not found')) throw new FlightProjectError('project_not_found')
  if (message.includes('flight project archived')) throw new FlightProjectError('archived_project')
  if (message.includes('flight project access denied')) {
    throw new FlightProjectError('project_access_forbidden')
  }
  if (message.includes('flight task not found')) {
    throw new FlightProjectError('flight_task_not_found')
  }
  if (message.includes('flight task project mismatch')) {
    throw new FlightProjectError('flight_task_project_mismatch')
  }
  throw error
}

// Create a flight in `preflight` — it has not launched; the gate decides next.
export async function createFlight(env: Env, f: NewFlight, options: CreateFlightOptions = {}): Promise<string> {
  await validateFlightProjectAttribution(env, f)
  const id = options.id ?? crypto.randomUUID()
  let result
  try {
    const fence = options.routineRunFence
    // Self-dispatch (dispatched_by omitted) is a true fact, not a placeholder —
    // see NewFlight.dispatched_by's docstring.
    const dispatchedBy = f.dispatched_by ?? f.agent
    const values = [
      id,
      env.TENANT_SLUG,
      f.project_id ?? null,
      f.agent,
      dispatchedBy,
      f.goal,
      f.trigger_source ?? 'manual',
      f.budget_micro_usd ?? null,
      JSON.stringify(f.meta ?? {}),
    ]
    if (fence) {
      result = await env.DB.prepare(
        `INSERT INTO flights (id, tenant, project_id, agent, dispatched_by_agent_id, goal, status, trigger_source, budget_micro_usd, meta)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'preflight', ?7, ?8, ?9
          WHERE EXISTS (
            SELECT 1 FROM routine_runs rr
             WHERE rr.id = ?10 AND rr.tenant = ?11 AND rr.project_id = ?3
               AND rr.status IN ('leased','observing')
               AND NOT EXISTS (
                 SELECT 1 FROM routine_run_events requested
                  WHERE requested.run_id = rr.id AND requested.tenant = rr.tenant
                    AND requested.kind = 'cancellation_requested'
               )
          )`,
      ).bind(...values, fence.runId, fence.tenant).run()
    } else {
      result = await env.DB.prepare(
        `INSERT INTO flights (id, tenant, project_id, agent, dispatched_by_agent_id, goal, status, trigger_source, budget_micro_usd, meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'preflight', ?7, ?8, ?9)`,
      ).bind(...values).run()
    }
  } catch (error) {
    mapFlightProjectInsertError(error)
  }
  if (options.routineRunFence && (result?.meta?.changes ?? 0) === 0) {
    throw new FlightCreateFenceError()
  }
  return id
}

// Record the preflight gate (#60) outcome. GO → running (caller does the work then
// lands/fails). NO-GO → held (cheap; zero expensive spend). Only from `preflight`.
export async function applyPreflight(env: Env, id: string, r: PreflightResult): Promise<FlightStatus> {
  const now = Date.now()
  if (r.go) {
    await env.DB.prepare(
      `UPDATE flights SET status='running', gate_verdict='go', gate_reason='', score=?3, started_at=?4
       WHERE id=?1 AND tenant=?2 AND status='preflight'`,
    )
      .bind(id, env.TENANT_SLUG, r.score, now)
      .run()
    return 'running'
  }
  await env.DB.prepare(
    `UPDATE flights SET status='held', gate_verdict='no_go', gate_reason=?3, score=?4, ended_at=?5
     WHERE id=?1 AND tenant=?2 AND status='preflight'`,
  )
    .bind(id, env.TENANT_SLUG, r.reasons.join(','), r.score, now)
    .run()
  return 'held'
}

// Land a flight (completed OK). Only from an in-air state.
export async function landFlight(
  env: Env,
  id: string,
  opts: { cost_micro_usd?: number; score?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='landed', cost_micro_usd=?3, score=COALESCE(?4, score), ended_at=?5
     WHERE id=?1 AND tenant=?2 AND status IN ('running','waiting','sleeping')`,
  )
    .bind(id, env.TENANT_SLUG, opts.cost_micro_usd ?? 0, opts.score ?? null, Date.now())
    .run()
}

function routineCostAggregationStatement(env: Env, flightId: string, updatedAt: string) {
  return env.DB.prepare(
    `UPDATE routine_runs
        SET cost_micro_usd = (
              SELECT COALESCE(SUM(f.cost_micro_usd), 0)
                FROM flights f
               WHERE f.tenant = routine_runs.tenant AND (
                 f.id = routine_runs.flight_id OR f.id IN (
                   SELECT ref_id FROM routine_run_refs
                    WHERE run_id = routine_runs.id AND ref_type = 'flight'
                 )
               )
            ),
            updated_at = ?3
      WHERE tenant = ?1
        AND EXISTS (
          SELECT 1 FROM routine_run_refs
           WHERE tenant = ?1 AND run_id = routine_runs.id
             AND ref_type = 'flight' AND ref_id = ?2
        )`,
  ).bind(env.TENANT_SLUG, flightId, updatedAt)
}

/**
 * Outcome of a governed landing. The two fields are deliberately separate (#916): a
 * refused transition and a missing receipt are different failures with opposite
 * remedies — the first means the flight did NOT land and the caller should diagnose
 * why; the second means it DID land and the receipt needs repair, not a retry. The
 * previous `Promise<boolean>` collapsed them, and every caller read the collapsed
 * false as "the landing was refused", which is how a 100%-reproducible receipt bug
 * spent its whole life being reported as `flight_transition_conflict`.
 */
export interface GovernedLandingResult {
  /** The flight moved to 'landed' in this call. */
  transitioned: boolean
  /** The flight.landed receipt exists (written now, or already present). */
  receipt: boolean
}

export async function landGovernedFlight(
  env: Env,
  id: string,
  opts: {
    cost_micro_usd: number
    score?: number
    expected_agent?: string
    agent_id: string
    meta: FlightMetaV1
    actor: { kind: 'member' | 'agent'; id: string }
  },
): Promise<GovernedLandingResult> {
  const endedAt = Date.now()
  const createdAt = new Date(endedAt).toISOString()
  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    outbox_id: eventId,
    flight_id: id,
    agent_id: opts.agent_id,
    squad_ids: opts.meta.squad_ids,
    task_ids: opts.meta.task_ids,
    cost_micro_usd: opts.cost_micro_usd,
    score: opts.score ?? null,
  })
  const transition = env.DB.prepare(
    `UPDATE flights SET status='landed', cost_micro_usd=?4, score=COALESCE(?5, score), ended_at=?6
     WHERE id=?1 AND tenant=?2
       AND (?3 IS NULL OR agent=?3)
       AND status IN ('running','waiting','sleeping')
       AND budget_micro_usd IS NOT NULL AND ?4 <= budget_micro_usd
       AND json_valid(meta)
       AND json_extract(meta, '$.schema') = 'mupot.flight.meta/v1'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(flights.meta, '$.task_ids') AS task_ref
           LEFT JOIN tasks AS task ON task.id = task_ref.value
          WHERE task.id IS NULL
             OR (flights.project_id IS NOT NULL AND task.project_id IS NOT flights.project_id)
             OR task.status <> 'done'
             OR (
               task.gate_owner IS NOT NULL
               AND COALESCE((
                 SELECT verdict
                   FROM task_verdicts
                  WHERE task_id = task.id
                  ORDER BY decided_at DESC, id DESC
                  LIMIT 1
               ), '') <> 'approved'
             )
       )
     RETURNING score, cost_micro_usd`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      opts.expected_agent ?? null,
      opts.cost_micro_usd,
      opts.score ?? null,
      endedAt,
    )
  // SEQUENTIAL, NOT BATCHED (#916). The previous version put the transition and this
  // INSERT in one env.DB.batch(), and the INSERT read back the row the transition had
  // just written (`SELECT ... FROM flights WHERE status='landed' AND ended_at=?`).
  //
  // WHAT WAS ACTUALLY OBSERVED, and it is narrower than this comment used to claim: two
  // live flights (b4126c91, ab98f1d1) landed and the caller got a 409. That is all that
  // was ever observed.
  //
  // WHAT WAS INFERRED AND IS FALSE: that no receipt row was written. It was written. Both
  // rows exist in flight_event_outbox and BOTH WERE DELIVERED by the maintenance cron
  // roughly six minutes after landing, with created_at matching each flight's ended_at to
  // the millisecond — so this INSERT ran in the same batch as the transition and
  // COMMITTED. Verified against production D1 on 2026-08-12.
  //
  // The "missing receipt" was inferred from `outboxResult.meta?.changes !== 1` and then
  // treated as a fact. meta.changes misreported; everything downstream inherited it. An
  // entire 46-site audit (mupot#919), a strict-mode test harness, PR #927 and a fleet-wide
  // migration deadline were built on a phenomenon that never occurred. All withdrawn.
  //
  // WHY meta.changes WAS WRONG — SETTLED 2026-08-12, proven with a control, no longer a
  // candidate. migrations/0059 defines flight_event_outbox_project_hydrate_insert, an
  // AFTER INSERT trigger that UPDATEs this same table. D1 derives meta.changes from a
  // total-changes delta, which COUNTS TRIGGER-PROGRAM ROWS; SQLite's changes() does not.
  // Measured on a throwaway D1 reproducing this table's exact shape:
  //     receipt INSERT, flight HAS a project        -> changes 2
  //     receipt INSERT, flight has NO project       -> changes 2   (subselect NULL, UPDATE still runs)
  //     CONTROL: same INSERT, table with NO trigger -> changes 1
  //     ON CONFLICT hit                             -> changes 0
  // So `changes === 1` could never be true here. Not "unlikely" — unsatisfiable. The old
  // success test could not have passed on any run, which is the whole of #916.
  //
  // SO WHY IS THIS STILL SEQUENTIAL? Not because of any same-batch read behaviour — that
  // premise is retracted and the phenomenon it explained did not happen. It is sequential
  // because not trusting meta.changes is correct regardless of which mechanism broke it,
  // and sequential is the simpler thing to reason about.
  //
  // CORRECTION, 2026-08-12: this comment previously also claimed "the success test below
  // depends on the split" and told you not to re-batch on that basis. THAT WAS FALSE and
  // was never tested. batch() preserves per-statement `results`, so a RETURNING row count
  // works identically inside a batch (measured: batch with RETURNING -> results.length 1;
  // batch, RETURNING matching nothing -> results.length 0, changes 0). The conclusion
  // survives, the stated reason did not. Noted plainly because an unverified mechanism
  // asserted as fact, one paragraph below the retraction of an unverified mechanism
  // asserted as fact, is exactly the habit #916 was supposed to break.
  // Decide from the RETURNING rows, NOT from meta.changes. Adversarial review caught the
  // first draft reading `meta.changes` off `.all()` of a RETURNING write — an unverified
  // platform behaviour of exactly the class that caused #916, and one no local harness can
  // check (tests/helpers/sqlite-d1.ts fabricates `changes` with its own SELECT changes()).
  // Row count is derived from the statement's own output, and it is this codebase's
  // established idiom for conditional-UPDATE-with-RETURNING: see the fence write at
  // src/mcp/index.ts:2652 and consumeAgentInbox in src/agents/messages.ts.
  const transitionResult = await transition.all<{ score: number | null; cost_micro_usd: number }>()
  const landedRows = transitionResult.results ?? []
  if (landedRows.length !== 1) return { transitioned: false, receipt: false }

  // The transition committed. From here the flight IS landed, and every remaining failure
  // is a receipt problem, never a landing problem — the caller must be able to tell those
  // apart, because they have opposite remedies (retry vs. repair).
  //
  // The landed values come back from the transition's own RETURNING clause. That matters
  // for `score`: the UPDATE uses COALESCE(?5, score), so when the caller supplies no score
  // the stored one survives and only the row knows the final value. RETURNING hands it
  // over without a second query and, unlike the old INSERT...SELECT, without depending on
  // one statement observing another's write.
  const landedRow = landedRows[0]

  const receiptPayload = JSON.stringify({
    ...JSON.parse(payload) as Record<string, unknown>,
    score: landedRow?.score ?? opts.score ?? null,
    cost_micro_usd: landedRow?.cost_micro_usd ?? opts.cost_micro_usd,
  })

  let receipt = false
  try {
    // ON CONFLICT keeps this idempotent: a retry after a partial failure re-uses the
    // existing receipt rather than duplicating it, and a conflict is still receipt=true
    // because the receipt genuinely exists.
    //
    // The receipt is decided by QUERYING FOR IT, never by meta.changes. This used to read
    // `(outboxResult.meta?.changes ?? 0) === 1 || (await flightReceiptExists(env, id))`.
    // The first clause was dead — see the settled measurement above: this table's AFTER
    // INSERT trigger makes changes 2 on success and 0 on conflict, so `=== 1` never fired
    // and flightReceiptExists carried every call anyway. Removing it changes no behaviour;
    // it removes a claim that reads as a working fast path and is not one.
    //
    // DO NOT "restore the fast path" and drop the query to save a round trip. That inverts
    // the failure: receipt would become false on every landing, and per the catch block
    // below there is NO BACKFILL — flushFlightEventOutbox only iterates rows that already
    // exist. A wrong `false` here is a permanent audit gap, not a retryable blip.
    await env.DB.prepare(
      `INSERT INTO flight_event_outbox
         (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at)
       VALUES (?1, ?2, ?3, 'flight.landed', ?4, ?5, ?6, ?7)
       ON CONFLICT (tenant, flight_id, event_type) DO NOTHING`,
    ).bind(eventId, env.TENANT_SLUG, id, opts.actor.kind, opts.actor.id, receiptPayload, createdAt).run()
    receipt = await flightReceiptExists(env, id)
  } catch (error) {
    // A receipt that fails to write must not un-land a landed flight — that is the whole
    // point of separating the two outcomes. Be honest about the consequence though: there
    // is NO backfill today. flushFlightEventOutbox only iterates outbox rows that already
    // exist, and landGovernedFlight is their only producer, so `receipt: false` is a
    // PERMANENT audit gap until a repair path exists (tracked separately). Callers must
    // treat it as an alarm, not as a transient.
    console.error('flight.landed receipt insert failed', {
      flight_id: id,
      error: error instanceof Error ? error.message : 'unknown_error',
    })
  }

  // Also sequential. NOTE the claim that used to be here — that inside the batch this SUM
  // read pre-update values, so every routine run's rolled-up cost was silently wrong — was
  // never independently observed. It was asserted by analogy to the receipt INSERT above,
  // whose own "missing row" turned out to be false (see the note there). Treat stale-SUM
  // as UNVERIFIED, not as a known past defect.
  //
  // Kept sequential anyway: it costs nothing, and a statement that reads a value an
  // earlier statement wrote is worth isolating on its own merits rather than on a
  // mechanism nobody has established.
  if (opts.meta.routine_run_id) {
    try {
      await routineCostAggregationStatement(env, id, createdAt).run()
    } catch (error) {
      // Must not throw past a committed transition. Throwing here would 500 the caller
      // after the flight already landed, and the retry would get flight_not_in_air —
      // precisely the "successful action reported as failure" shape this issue exists to
      // remove. The statement is a recompute-from-SUM, so it is idempotent and a later
      // report_run_usage converges it.
      console.error('routine cost aggregation failed after landing', {
        flight_id: id,
        routine_run_id: opts.meta.routine_run_id,
        error: error instanceof Error ? error.message : 'unknown_error',
      })
    }
  }

  return { transitioned: true, receipt }
}

/** True when this flight already carries its landed receipt. */
export async function flightReceiptExists(env: Env, flightId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM flight_event_outbox
      WHERE tenant=?1 AND flight_id=?2 AND event_type='flight.landed' LIMIT 1`,
  ).bind(env.TENANT_SLUG, flightId).first<{ present: number }>()
  return row !== null
}

interface FlightTaskCompletionRow {
  id: string
  status: string
  gate_owner: string | null
  latest_verdict: string | null
}

export async function listIncompleteFlightTaskIds(env: Env, taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return []
  const byId = new Map<string, FlightTaskCompletionRow>()
  for (let offset = 0; offset < taskIds.length; offset += D1_TASK_ID_QUERY_CHUNK_SIZE) {
    const chunk = taskIds.slice(offset, offset + D1_TASK_ID_QUERY_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = await env.DB.prepare(
      `SELECT id, status, gate_owner,
              (SELECT verdict
                 FROM task_verdicts
                WHERE task_id = tasks.id
                ORDER BY decided_at DESC, id DESC
                LIMIT 1) AS latest_verdict
         FROM tasks WHERE id IN (${placeholders})`,
    ).bind(...chunk).all<FlightTaskCompletionRow>()
    for (const task of rows.results ?? []) byId.set(task.id, task)
  }
  return taskIds.filter((taskId) => {
    const task = byId.get(taskId)
    return !task || task.status !== 'done' || (task.gate_owner !== null && task.latest_verdict !== 'approved')
  })
}

export async function listFlightProjectMismatchTaskIds(
  env: Env,
  projectId: string | null,
  taskIds: string[],
): Promise<string[]> {
  if (projectId === null || taskIds.length === 0) return []
  const byId = new Map<string, string | null>()
  const queries = []
  for (let offset = 0; offset < taskIds.length; offset += D1_TASK_ID_QUERY_CHUNK_SIZE) {
    const chunk = taskIds.slice(offset, offset + D1_TASK_ID_QUERY_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    queries.push(
      env.DB.prepare(`SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`).bind(...chunk)
    )
  }
  if (queries.length > 0) {
    const batchResults = await env.DB.batch<{ id: string; project_id: string | null }>(queries)
    for (const rows of batchResults) {
      for (const task of rows.results ?? []) {
        byId.set(task.id, task.project_id)
      }
    }
  }
  return taskIds.filter((taskId) => byId.has(taskId) && byId.get(taskId) !== projectId)
}

interface FlightEventOutboxRow {
  id: string
  tenant: string
  flight_id: string
  event_type: 'flight.landed'
  actor_kind: 'member' | 'agent'
  actor_id: string
  payload: string
  created_at: string
  delivered_at: string | null
  consumed_at: string | null
  attempts: number
  last_error: string | null
}

export async function deliverFlightLandedEvent(env: Env, flightId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT * FROM flight_event_outbox
      WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, flightId).first<FlightEventOutboxRow>()
  if (!row) return true
  try {
    const payload = JSON.parse(row.payload) as { squad_ids?: unknown; [key: string]: unknown }
    const squadIds = Array.isArray(payload.squad_ids)
      ? payload.squad_ids.filter((value): value is string => typeof value === 'string')
      : []
    await createBus(env).emit({
      type: 'flight.landed',
      tenant: env.TENANT_SLUG,
      squad_id: squadIds[0],
      agent_id: typeof payload.agent_id === 'string' ? payload.agent_id : undefined,
      actor: { kind: row.actor_kind, id: row.actor_id },
      payload,
      ts: row.created_at,
    })
    await env.DB.prepare(
      `UPDATE flight_event_outbox
          SET delivered_at = ?3, attempts = attempts + 1, last_error = NULL
        WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL`,
    ).bind(env.TENANT_SLUG, flightId, new Date().toISOString()).run()
    return true
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'unknown_error').slice(0, 500)
    await env.DB.prepare(
      `UPDATE flight_event_outbox
          SET last_error = ?3, attempts = attempts + 1
        WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL`,
    ).bind(env.TENANT_SLUG, flightId, message).run()
    console.error('flight.landed event delivery failed', { flight_id: flightId, error: message })
    return false
  }
}

export async function flushFlightEventOutbox(env: Env, limit = 50): Promise<{ attempted: number; delivered: number }> {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100)
  const rows = await env.DB.prepare(
    `SELECT * FROM flight_event_outbox
      WHERE tenant=?1 AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?2`,
  ).bind(env.TENANT_SLUG, boundedLimit).all<FlightEventOutboxRow>()
  let delivered = 0
  for (const row of rows.results ?? []) {
    if (await deliverFlightLandedEvent(env, row.flight_id)) delivered += 1
  }
  return { attempted: rows.results?.length ?? 0, delivered }
}

// Fail a flight (errored). From any non-terminal state.
export async function failFlight(env: Env, id: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='failed', gate_reason=?3, ended_at=?4
     WHERE id=?1 AND tenant=?2 AND status IN ('preflight','running','waiting','sleeping')`,
  )
    .bind(id, env.TENANT_SLUG, reason.slice(0, 500), Date.now())
    .run()
}

// Put a flight to sleep until next_run_at (Unix ms). Only from an in-air state.
export async function sleepFlight(env: Env, id: string, nextRunAt: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='sleeping', next_run_at=?3
     WHERE id=?1 AND tenant=?2 AND status IN ('running','waiting')`,
  )
    .bind(id, env.TENANT_SLUG, nextRunAt)
    .run()
}

export async function getFlight(env: Env, id: string): Promise<FlightRow | null> {
  return (
    (await env.DB.prepare(`SELECT * FROM flights WHERE id=?1 AND tenant=?2`)
      .bind(id, env.TENANT_SLUG)
      .first<FlightRow>()) ?? null
  )
}

export async function listFlights(env: Env, limit = 100, projectId?: string): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const statement = projectId === undefined
    ? env.DB.prepare(
        `SELECT f.*, a.name AS agent_name, s.name AS squad_name
           FROM flights f
           LEFT JOIN agents a ON a.id = f.agent
           LEFT JOIN squads s ON s.id = a.squad_id
          WHERE f.tenant=?1 ORDER BY f.created_at DESC LIMIT ?2`,
      ).bind(env.TENANT_SLUG, boundedLimit)
    : env.DB.prepare(
        `SELECT f.*, a.name AS agent_name, s.name AS squad_name
           FROM flights f
           LEFT JOIN agents a ON a.id = f.agent
           LEFT JOIN squads s ON s.id = a.squad_id
          WHERE f.tenant=?1 AND f.project_id=?2 ORDER BY f.created_at DESC LIMIT ?3`,
      ).bind(env.TENANT_SLUG, projectId, boundedLimit)
  const res = await statement
    .all<FlightRow>()
  return res.results ?? []
}

export async function listFlightsForSquad(
  env: Env,
  squadId: string,
  limit = 100,
  before?: { createdAt: number; id: string },
  projectId?: string,
): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const beforeCreatedAt = before?.createdAt ?? Number.MAX_SAFE_INTEGER
  const beforeId = before?.id ?? '\uffff'
  const statement = projectId === undefined
    ? env.DB.prepare(
      `SELECT f.*, a.name AS agent_name, s.name AS squad_name
        FROM flights f
        LEFT JOIN agents a ON a.id = f.agent
        LEFT JOIN squads s ON s.id = a.squad_id
      WHERE f.tenant = ?1
        AND EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
           WHERE squad_ref.value = ?2
        )
        AND (f.created_at < ?3 OR (f.created_at = ?4 AND f.id < ?5))
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ?6`,
    ).bind(env.TENANT_SLUG, squadId, beforeCreatedAt, beforeCreatedAt, beforeId, boundedLimit)
    : env.DB.prepare(
      `SELECT f.*, a.name AS agent_name, s.name AS squad_name
        FROM flights f
        LEFT JOIN agents a ON a.id = f.agent
        LEFT JOIN squads s ON s.id = a.squad_id
      WHERE f.tenant = ?1
        AND f.project_id = ?2
        AND EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
           WHERE squad_ref.value = ?3
        )
        AND (f.created_at < ?4 OR (f.created_at = ?5 AND f.id < ?6))
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ?7`,
    ).bind(env.TENANT_SLUG, projectId, squadId, beforeCreatedAt, beforeCreatedAt, beforeId, boundedLimit)
  const res = await statement.all<FlightRow>()
  return res.results ?? []
}
