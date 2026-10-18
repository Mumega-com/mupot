// Admission by observation, P0 (SHADOW ONLY): the post-call tap and the seat_tape writer.
// Flag ADMISSION_TAPE (strict '1'), default off. With the flag off nothing here is called (see invokeTool).
//
// INVARIANTS (each has a test in tests/admission-tape.test.ts):
//   - The tap never throws into, and never delays, the tool response: it runs inside waitUntil (or, without a
//     waitUntil, is fired and not awaited), every error is swallowed and COUNTED (tapeStats().errors).
//   - It records SHAPE only (describeArgs): no raw argument value reaches D1.
//   - It never blocks a call, never writes agent_seats.admission_status, never creates a card or notification.

import type { AuthContext, Env } from '../types'
import { TAPE_THRESHOLDS, describeArgs, scoreWindow, windowIsFull, type TapeEvent } from './tape-rules'

export const ADMISSION_STATUSES = ['observed', 'trusted', 'held'] as const
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number]

export function admissionTapeEnabled(env: Pick<Env, 'ADMISSION_TAPE'>): boolean {
  return env.ADMISSION_TAPE === '1'
}

const stats = { events: 0, windows: 0, errors: 0 }
export function tapeStats(): Readonly<typeof stats> {
  return { ...stats }
}
export function resetTapeStatsForTest(): void {
  stats.events = 0
  stats.windows = 0
  stats.errors = 0
}

/** Keys that name a target squad in a tool's arguments. Only squads in P0 (a project target needs a lookup: P1). */
const SQUAD_TARGET_KEYS: readonly string[] = ['squad', 'squad_id', 'target_squad', 'to_squad']

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface TapeCall {
  tool: string
  min: string
  args: Record<string, unknown>
  /** the tool's inputSchema property names: the ONLY key names the tape may keep */
  allowedKeys: ReadonlySet<string>
  outcome: { ok: true } | { ok: false; status: number; error: string }
  now: number
}

interface SeatFacts {
  squadId: string | null
  squadSlug: string | null
  status: AdmissionStatus | null
}

async function loadSeatFacts(env: Env, auth: AuthContext, seatId: string): Promise<SeatFacts> {
  const row = await env.DB.prepare(
    `SELECT sq.id AS squad_id, sq.slug AS squad_slug, s.admission_status AS status
       FROM agent_seats s
       LEFT JOIN agents a ON a.id = ?2
       LEFT JOIN squads sq ON sq.id = a.squad_id
      WHERE s.id = ?1 AND s.tenant = ?3`,
  ).bind(seatId, auth.boundAgentId ?? '', auth.tenant).first<{ squad_id: string | null; squad_slug: string | null; status: string | null }>()
  const status = (ADMISSION_STATUSES as readonly string[]).includes(row?.status ?? '') ? (row?.status as AdmissionStatus) : null // validated against the closed list on the line above
  return { squadId: row?.squad_id ?? null, squadSlug: row?.squad_slug ?? null, status }
}

export function buildTapeEvent(auth: AuthContext, call: TapeCall, facts: Pick<SeatFacts, 'squadId' | 'squadSlug'>): TapeEvent | null {
  const seat = auth.seatBinding
  if (!seat) return null
  const targets = SQUAD_TARGET_KEYS.map((k) => call.args[k]).filter((v): v is string => typeof v === 'string' && v.length > 0)
  const drift = targets.some((t) => t !== facts.squadId && t !== facts.squadSlug)
  return {
    seat_id: seat.seatId,
    member_id: seat.humanMemberId,
    squad: facts.squadSlug ?? facts.squadId,
    tool: call.tool,
    min: call.min,
    status: call.outcome.ok ? 200 : call.outcome.status,
    error: call.outcome.ok ? null : call.outcome.error,
    arg_shape: describeArgs(call.args, call.allowedKeys),
    target_drift: drift,
    t: call.now,
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Append one event to the seat's window; when the window is full, score it and append a seat_tape row. */
export async function recordTapeCall(env: Env, auth: AuthContext, call: TapeCall): Promise<void> {
  const seat = auth.seatBinding
  if (!seat || !env.DB) return
  const facts = await loadSeatFacts(env, auth, seat.seatId)
  const ev = buildTapeEvent(auth, call, facts)
  if (!ev) return
  stats.events++

  const cur = await env.DB.prepare('SELECT events_json FROM seat_tape_window WHERE seat_id = ?1').bind(seat.seatId).first<{ events_json: string }>()
  let events: TapeEvent[] = []
  if (cur?.events_json) {
    try {
      const parsed: unknown = JSON.parse(cur.events_json)
      if (Array.isArray(parsed)) events = parsed as TapeEvent[] // our own serialisation of TapeEvent[]; only length/fields we wrote are read
    } catch {
      events = [] // a corrupt scratch window restarts; the record (seat_tape) is untouched
    }
  }
  events.push(ev)

  const serialised = JSON.stringify(events)
  // Close early on size too, so a window row can never approach D1's row limit.
  if (!windowIsFull(events, ev.t) && serialised.length < TAPE_THRESHOLDS.windowBytes) {
    await env.DB.prepare(
      `INSERT INTO seat_tape_window (seat_id, events_json) VALUES (?1, ?2)
       ON CONFLICT(seat_id) DO UPDATE SET events_json = excluded.events_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(seat.seatId, serialised).run()
    return
  }

  const scored = scoreWindow(events)
  // The chain head is the row no other row names as its prev_hash (never "latest by time": a row can be inserted out of order).
  const prev = await env.DB.prepare(
    `SELECT t.row_hash FROM seat_tape t WHERE t.seat_id = ?1
        AND NOT EXISTS (SELECT 1 FROM seat_tape n WHERE n.seat_id = t.seat_id AND n.prev_hash = t.row_hash) LIMIT 1`,
  ).bind(seat.seatId).first<{ row_hash: string }>()
  const prevHash = prev?.row_hash ?? ''
  const id = crypto.randomUUID()
  const fields = {
    id, seat_id: seat.seatId, member_id: seat.humanMemberId,
    window_start: iso(events[0].t), window_end: iso(events[events.length - 1].t), event_count: events.length,
    score: scored.score, signals: JSON.stringify({ ...scored.signals, hard_trips: scored.hard_trips }),
    // SHADOW: status is never changed in P0, so before == after.
    status_before: facts.status, status_after: facts.status, would_hold: scored.would_hold ? 1 : 0,
  }
  const rowHash = await sha256Hex(`${prevHash}|${tapeCanonical(fields)}`)
  // One batch: the tape row and the window reset land together, so a failed append keeps the window to retry.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seat_tape (id, seat_id, member_id, window_start, window_end, event_count, score, signals, status_before, status_after, would_hold, prev_hash, row_hash)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    ).bind(fields.id, fields.seat_id, fields.member_id, fields.window_start, fields.window_end, fields.event_count, fields.score, fields.signals, fields.status_before, fields.status_after, fields.would_hold, prevHash, rowHash),
    env.DB.prepare('DELETE FROM seat_tape_window WHERE seat_id = ?1').bind(seat.seatId),
  ])
  stats.windows++
}

/** Canonical, order-fixed serialisation of the hashed fields. Exported so a verifier recomputes the same bytes. */
export function tapeCanonical(f: {
  id: string; seat_id: string; member_id: string; window_start: string; window_end: string; event_count: number
  score: number; signals: string; status_before: string | null; status_after: string | null; would_hold: number
}): string {
  return JSON.stringify([f.id, f.seat_id, f.member_id, f.window_start, f.window_end, f.event_count, f.score, f.signals, f.status_before, f.status_after, f.would_hold])
}

export async function computeTapeHash(prevHash: string, f: Parameters<typeof tapeCanonical>[0]): Promise<string> {
  return sha256Hex(`${prevHash}|${tapeCanonical(f)}`)
}

/**
 * The tap. Call at the single exit of invokeTool, only with the flag on. Fire-and-forget: it returns synchronously
 * (never awaited by the caller), registers the work with waitUntil when one exists, and swallows + counts every error.
 */
export function tapToolCall(env: Env, auth: AuthContext, call: TapeCall, waitUntil: ((p: Promise<unknown>) => void) | undefined): void {
  try {
    if (!auth.seatBinding) return
    const work = recordTapeCall(env, auth, call).catch(() => {
      stats.errors++
    })
    if (waitUntil) waitUntil(work)
  } catch {
    stats.errors++
  }
}

/** The reason class a seat is shown for its status. A class, never the score, signals or thresholds (gaming surface). */
export const ADMISSION_REASON_CLASS: Readonly<Record<AdmissionStatus, string>> = {
  observed: 'new_seat_observed',
  trusted: 'clean_history',
  held: 'owner_review',
}

/** whoami.admission: ONLY with ADMISSION_TAPE on AND a seat that has a status. Best-effort, never throws. */
export async function gatherAdmission(env: Env, auth: AuthContext): Promise<{ status: AdmissionStatus; reason_class: string } | null> {
  if (!admissionTapeEnabled(env) || !auth.seatBinding || !env.DB) return null
  try {
    const row = await env.DB.prepare('SELECT admission_status AS status FROM agent_seats WHERE id = ?1 AND tenant = ?2').bind(auth.seatBinding.seatId, auth.tenant).first<{ status: string | null }>()
    const status = ADMISSION_STATUSES.find((s) => s === row?.status)
    return status ? { status, reason_class: ADMISSION_REASON_CLASS[status] } : null
  } catch {
    return null
  }
}
