// mupot — the CRO event grain: validated write + read over cro_events (epic #213, slice 1.5).
//
// CRO source adapters normalize their raw conversion-funnel data into CroEvent rows here;
// an aggregation job (a later slice, paired with the connector that produces the events)
// materializes segment-keyed metric_points from this grain. This module is the only write
// path — it BINDS tenant_id to the pot's own tenant (never caller-supplied, like the S4
// pot-publish fix), validates every row, and caps the batch so a connector returning a
// huge page of events can't amplify the write (same lesson as the collector cap).

import type { Env } from '../types'

/** Max rows accepted per write — bounds connector amplification (collector-cap lesson). */
export const MAX_EVENTS_PER_WRITE = 1000
/** Max rows returned per read. */
export const MAX_EVENTS_PER_READ = 2000
/** Max length of any adapter-controlled identity/key TEXT field (BLOCK-2 — bound D1/index bloat). */
export const MAX_FIELD_LEN = 256

/** A normalized CRO event as an adapter produces it (tenant is bound server-side). */
export interface CroEventInput {
  source: string // the producing source key (also a cro_events.source)
  event_name: string // funnel step / action
  occurred_at: number // epoch ms the event is FOR
  /**
   * The SOURCE's OWN stable id for this event (idempotency key, BLOCK-1). When present, a
   * retry with the same (source, event_key) is a no-op — no duplicate conversion grain.
   * Omit only for signals with no retry identity (deduped:false for those).
   */
  event_key?: string | null
  user_id?: string | null
  session_id?: string | null
  properties?: unknown // serialized to a JSON string; non-serializable → dropped to null
}

export interface CroEventRow {
  id: string
  tenant_id: string
  source: string
  event_name: string
  event_key: string | null
  user_id: string | null
  session_id: string | null
  occurred_at: number
  properties: string | null
  created_at: number
}

export interface RecordResult {
  written: number // rows actually inserted (after idempotency dedup)
  rejected: number // failed validation (bad/oversized fields, bad ts)
  deduped: number // valid rows that were no-ops because (source, event_key) already existed
  capped: boolean // input exceeded MAX_EVENTS_PER_WRITE (truncated)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** A required string field that's non-empty AND within the length bound (BLOCK-2). */
function validField(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_FIELD_LEN
}

/** An optional string field: absent/empty → null; present-but-oversized → invalid (caller rejects). */
function optField(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false }
  if (v.length > MAX_FIELD_LEN) return { ok: false }
  return { ok: true, value: v.trim().length > 0 ? v : null }
}

/** Serialize an arbitrary properties value to a JSON string, or null if absent/unserializable. */
function toPropsJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    const s = JSON.stringify(value)
    // Cap a pathological blob so one event can't bloat a row unbounded.
    return typeof s === 'string' ? s.slice(0, 8000) : null
  } catch {
    return null
  }
}

/**
 * recordCroEvents — validate + persist a batch of CRO events. tenant_id is forced to the
 * pot's own tenant (env.TENANT_SLUG) — a source can never write another tenant's grain.
 * Invalid rows (missing source/event_name, non-finite/≤0 occurred_at) are rejected and
 * counted, never inserted. The batch is capped at MAX_EVENTS_PER_WRITE.
 */
export async function recordCroEvents(env: Env, events: CroEventInput[]): Promise<RecordResult> {
  const tenantId = env.TENANT_SLUG
  if (!tenantId) return { written: 0, rejected: Array.isArray(events) ? events.length : 0, deduped: 0, capped: false }
  if (!Array.isArray(events) || events.length === 0) return { written: 0, rejected: 0, deduped: 0, capped: false }

  const capped = events.length > MAX_EVENTS_PER_WRITE
  const batch = capped ? events.slice(0, MAX_EVENTS_PER_WRITE) : events
  const now = Date.now()

  const stmts: D1PreparedStatement[] = []
  let rejected = 0
  for (const e of batch) {
    if (!e || typeof e !== 'object') {
      rejected++
      continue
    }
    // Required + length-bounded (BLOCK-2): source, event_name.
    if (!validField(e.source) || !validField(e.event_name)) {
      rejected++
      continue
    }
    if (typeof e.occurred_at !== 'number' || !Number.isFinite(e.occurred_at) || e.occurred_at <= 0) {
      rejected++
      continue
    }
    // Optional + length-bounded: event_key (idempotency), user_id, session_id. Oversized → reject.
    const ek = optField(e.event_key)
    const uid = optField(e.user_id)
    const sid = optField(e.session_id)
    if (!ek.ok || !uid.ok || !sid.ok) {
      rejected++
      continue
    }

    stmts.push(
      // INSERT OR IGNORE (BLOCK-1): a re-delivered event (same tenant, source, event_key)
      // hits idx_cro_events_dedup and is a no-op — no duplicate conversion grain.
      env.DB.prepare(
        `INSERT OR IGNORE INTO cro_events
           (id, tenant_id, source, event_name, event_key, user_id, session_id, occurred_at, properties, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        tenantId,
        e.source.trim(),
        e.event_name.trim(),
        ek.value,
        uid.value,
        sid.value,
        Math.floor(e.occurred_at),
        toPropsJson(e.properties),
        now,
      ),
    )
  }

  if (stmts.length === 0) return { written: 0, rejected, deduped: 0, capped }
  // INSERT OR IGNORE makes a duplicate insert 0 rows. Sum the ACTUAL changes so `written`
  // is honest and `deduped` reports the idempotent no-ops — downstream aggregation can't overcount.
  const results = await env.DB.batch(stmts)
  let written = 0
  for (const r of results) written += r.meta?.changes ?? 0
  return { written, rejected, deduped: stmts.length - written, capped }
}

export interface ReadCroEventsOpts {
  source?: string
  eventName?: string
  sinceMs?: number // only events with occurred_at >= this
  limit?: number
}

/**
 * readCroEvents — tenant-scoped read of the event grain, newest first. Filters are optional
 * and parameterized; limit is clamped to MAX_EVENTS_PER_READ.
 */
export async function readCroEvents(env: Env, opts: ReadCroEventsOpts = {}): Promise<CroEventRow[]> {
  const tenantId = env.TENANT_SLUG
  if (!tenantId) return []

  const where: string[] = ['tenant_id = ?']
  const binds: unknown[] = [tenantId]
  if (nonEmpty(opts.source)) {
    where.push('source = ?')
    binds.push(opts.source)
  }
  if (nonEmpty(opts.eventName)) {
    where.push('event_name = ?')
    binds.push(opts.eventName)
  }
  if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) {
    where.push('occurred_at >= ?')
    binds.push(Math.floor(opts.sinceMs))
  }

  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_EVENTS_PER_READ)
      : 500

  const result = await env.DB.prepare(
    `SELECT id, tenant_id, source, event_name, event_key, user_id, session_id, occurred_at, properties, created_at
       FROM cro_events
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC
      LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<CroEventRow>()

  return result.results ?? []
}
