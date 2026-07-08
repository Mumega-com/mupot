// mupot — generic pot-side inbound EVENT → TASK ingestion (feedback-loop "act" wiring).
//
// This is the canonical, tenant-agnostic path for turning any external signal
// (a lead captured, a form submission, a webhook event) into a mupot TASK that
// carries a verifiable done_when predicate. It is intentionally decoupled from
// GHL, viamar, and any other specific source.
//
// Design principles:
//   1. ADDITIVE — calls createTask(), never bypasses it. All existing guards
//      (done_when required, status constraints, bus emit) apply.
//   2. REGISTRY — event-type → done_when derivation is a small, extensible
//      registry. No hardcoded strings at the call site.
//   3. FAILS CLOSED — if no registry entry matches the event type, the call
//      is rejected with `unmapped_event_type` (NOT a silent placeholder).
//   4. SOURCE-AUTHORIZED — the caller must supply a squad_id that it has
//      already verified belongs to this tenant. The ingest function does a
//      hard tenant-slug cross-check (the squad row carries no tenant column —
//      that is the pot's isolation — but we verify the squad exists in this DB).
//   5. NO LIVE EXTERNAL CALLS — pure logic + createTask. No fetch().
//
// Auth model (HTTP surface):
//   POST /api/events/ingest — verified by HMAC-SHA256 of the raw body using
//   EVENT_INGEST_SECRET (same constant-time pattern as GHL webhook). The
//   endpoint does NOT require a session cookie. External workers (e.g. viamar
//   CF worker) sign their payloads with the shared secret.

import { Hono } from 'hono'
import type { Env } from '../types'
import { createTask } from '../tasks/service'
import type { CreateTaskOptions } from '../tasks/service'

// ── Normalized inbound event ────────────────────────────────────────────────
//
// Every source (GHL, PostHog, CF worker, bus event) normalizes to this shape
// before calling ingestEvent(). The raw payload is carried as an opaque record
// so the registry derivers can read source-specific fields.

export interface InboundEvent {
  /** Canonical event type. Drives the done_when registry lookup. */
  type: string
  /** Source system identifier (e.g. 'ghl', 'posthog', 'viamar-worker'). */
  source: string
  /** Squad to create the task in. Caller must be authorized for this squad. */
  squad_id: string
  /**
   * Opaque payload from the source system. Registry derivers read this to
   * build the done_when predicate and task title.
   */
  payload: Record<string, unknown>
}

// ── done_when registry ────────────────────────────────────────────────────────
//
// Maps event type → a deriver function that returns a { title, done_when }
// for the task. The done_when MUST be a real, checkable predicate — never a
// placeholder sentinel (the PLACEHOLDER_SENTINELS set in service.ts governs).
//
// Adding support for a new event type = add one entry here. No other file changes.
//
// Naming convention for done_when: imperative verb + measurable outcome.
// "Lead <id> contacted and replied OR moved to won/lost" is checkable.
// "Task complete" is NOT (it is a sentinel, not a predicate).

export type DoneWhenDeriver = (payload: Record<string, unknown>) => {
  title: string
  done_when: string
  /** Optional extra body text (raw payload excerpt, etc.) */
  body?: string
}

function safeStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback
}

/**
 * The registry: event type → deriver.
 *
 * To extend: add an entry for your event type. The deriver receives the raw
 * payload and must return a non-empty, non-placeholder done_when string.
 */
export const EVENT_REGISTRY: ReadonlyMap<string, DoneWhenDeriver> = new Map([

  // ── lead.captured ─────────────────────────────────────────────────────────
  // A new lead arrived (from CRM, form, ad-platform, etc.).
  // done_when: the lead has been contacted AND their response is recorded.
  ['lead.captured', (payload) => {
    const id = safeStr(payload.lead_id ?? payload.contact_id ?? payload.id, 'unknown')
    const email = safeStr(payload.email ?? payload.contact_email, '')
    const ref = email || id
    return {
      title: `[lead] ${safeStr(payload.source ?? payload.type, 'inbound')} · ${ref}`,
      done_when: `lead ${ref} contacted and reply or outcome (won/lost/unqualified) recorded in CRM`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── lead.reply_received ───────────────────────────────────────────────────
  // A prospect replied to an outreach. done_when: the reply is triaged and
  // a next-step (meeting booked, deal moved, unsubscribe honored) is logged.
  ['lead.reply_received', (payload) => {
    const id = safeStr(payload.contact_id ?? payload.lead_id ?? payload.id, 'unknown')
    return {
      title: `[reply] contact ${id} replied`,
      done_when: `reply from contact ${id} triaged — next step logged (meeting, deal update, or opt-out honored)`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── form.submitted ────────────────────────────────────────────────────────
  // A web form was submitted (contact, intake, qualification, etc.).
  ['form.submitted', (payload) => {
    const formId = safeStr(payload.form_id ?? payload.form, 'unknown-form')
    const submitter = safeStr(payload.email ?? payload.name ?? payload.submitter, 'submitter')
    return {
      title: `[form] ${formId} · ${submitter}`,
      done_when: `form submission from ${submitter} (form: ${formId}) reviewed and follow-up sent or declined`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── booking.created ───────────────────────────────────────────────────────
  // A meeting or appointment was booked.
  ['booking.created', (payload) => {
    const id = safeStr(payload.booking_id ?? payload.id, 'unknown')
    const contact = safeStr(payload.contact_id ?? payload.email, 'contact')
    const time = safeStr(payload.start_time ?? payload.scheduled_at, '')
    const when = time ? ` at ${time}` : ''
    return {
      title: `[booking] ${id} · ${contact}${when}`,
      done_when: `booking ${id} attended or rescheduled/cancelled and outcome logged`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── pipeline.stage_changed ────────────────────────────────────────────────
  // A CRM contact moved to a new pipeline stage (e.g. Proposal Sent, Closed Won).
  ['pipeline.stage_changed', (payload) => {
    const contact = safeStr(payload.contact_id ?? payload.id, 'unknown')
    const stage = safeStr(payload.stage ?? payload.to_stage ?? payload.pipeline_stage, 'new-stage')
    return {
      title: `[crm] contact ${contact} → ${stage}`,
      done_when: `contact ${contact} advances past stage "${stage}" or stage is marked final (won/lost)`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── analytics.signal ──────────────────────────────────────────────────────
  // A behavioural signal from an analytics platform (PostHog, GA, etc.)
  // that warrants a follow-up task. done_when: the signal is acted on.
  ['analytics.signal', (payload) => {
    const event = safeStr(payload.event ?? payload.signal_type, 'unknown-signal')
    const userId = safeStr(payload.distinct_id ?? payload.user_id ?? payload.userId, 'user')
    return {
      title: `[signal] ${event} · ${userId}`,
      done_when: `signal "${event}" from ${userId} investigated and response action taken or dismissed`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],

  // ── memory.insight_captured ───────────────────────────────────────────────
  // The colony captured a new insight (agent observation, pattern, retro
  // finding, or brain suggestion) and needs it durably recorded as a memory
  // node — committed to git, tier-set, provenance-linked, and confirmed present.
  // done_when: the insight is a durable, retrievable memory node (not just a
  // bus message or ephemeral log line).
  ['memory.insight_captured', (payload) => {
    const ref = safeStr(
      payload.insight_id ?? payload.id ?? payload.title,
      'unknown-insight',
    )
    return {
      title: `[insight] ${ref}`,
      done_when: `insight "${ref}" recorded as a durable memory node — committed to git, tier-set, provenance-linked, and confirmed present`,
      body: JSON.stringify(payload).slice(0, 2000),
    }
  }],
])

// ── Core ingest function ─────────────────────────────────────────────────────

export interface IngestResult {
  ok: true
  task_id: string
  done_when: string
}

export type IngestError =
  | { ok: false; code: 'unmapped_event_type'; event_type: string }
  | { ok: false; code: 'squad_not_found'; squad_id: string }
  | { ok: false; code: 'create_failed'; detail: string }

/**
 * ingestEvent — the single generic entry point for event → task creation.
 *
 * RBAC note: the caller (HTTP route or bus consumer) is responsible for
 * verifying that the event source is authorized to create tasks in `squad_id`.
 * This function trusts a pre-authorized squad_id and verifies only that the
 * squad row exists in this DB (existence = this tenant owns it).
 *
 * Returns an IngestResult on success, or an IngestError on failure (never throws).
 */
export async function ingestEvent(
  env: Env,
  event: InboundEvent,
  options: CreateTaskOptions = {},
): Promise<IngestResult | IngestError> {
  // 1. Registry lookup — reject unmapped types rather than silently sentinel-ing.
  const deriver = EVENT_REGISTRY.get(event.type)
  if (!deriver) {
    return { ok: false, code: 'unmapped_event_type', event_type: event.type }
  }

  // 2. Verify the squad exists in this pot's DB (tenant isolation — one DB per pot).
  const squadRow = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1 LIMIT 1')
    .bind(event.squad_id)
    .first<{ id: string }>()
  if (!squadRow) {
    return { ok: false, code: 'squad_not_found', squad_id: event.squad_id }
  }

  // 3. Derive the task fields. The deriver is responsible for a non-placeholder done_when.
  const derived = deriver(event.payload)

  // 4. Create the task via the canonical path. This enforces:
  //    - done_when non-empty (Door 3)
  //    - status constraints
  //    - bus emit (task.created)
  //    - GitHub mirror (if configured)
  try {
    const task = await createTask(
      env,
      {
        squad_id: event.squad_id,
        title: derived.title,
        done_when: derived.done_when,
        body: derived.body ?? '',
        status: 'open',
      },
      {
        ...options,
        // Events arriving from external sources should not loop back through GitHub
        // (same rationale as skipMirror in ghl-routes: would reflect external data
        // out under our token). Callers may override this if they want GH mirroring.
        skipMirror: options.skipMirror ?? true,
      },
    )
    return { ok: true, task_id: task.id, done_when: task.done_when }
  } catch (err) {
    return {
      ok: false,
      code: 'create_failed',
      detail: err instanceof Error ? err.message : 'unknown_error',
    }
  }
}

// ── HTTP surface ──────────────────────────────────────────────────────────────
//
// POST /api/events/ingest
//
// Auth: HMAC-SHA256 of the raw request body, delivered in `x-mupot-signature`
// header (hex). Verified against EVENT_INGEST_SECRET (wrangler secret put).
// If the secret is not configured → 503. Bad/missing signature → 401.
//
// Body (JSON):
//   { type, source, squad_id, payload }
//
// Returns:
//   201 { ok: true, task_id, done_when }       — task created
//   400 { error: 'unmapped_event_type', ... }  — no registry entry, not a silent drop
//   400 { error: 'squad_not_found', ... }
//   401 { error: 'unauthorized' }
//   503 { error: 'not_configured' }

interface EventRouteEnv {
  EVENT_INGEST_SECRET?: string
}

export const EVENT_INGEST_MAX_BODY_BYTES = 256 * 1024

function eventRouteEnv(env: Env): EventRouteEnv {
  // Same adapter pattern as GHL route (optional extras not in core Env).
  return env as unknown as EventRouteEnv
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

async function computeHmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function verifyEventSignature(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<'not_configured' | 'invalid' | 'ok'> {
  const secret = eventRouteEnv(env).EVENT_INGEST_SECRET
  if (!secret || secret.length === 0) return 'not_configured'
  if (!signatureHeader || signatureHeader.length === 0) return 'invalid'
  const expected = await computeHmacHex(secret, rawBody)
  if (!timingSafeEqual(expected, signatureHeader.toLowerCase())) return 'invalid'
  return 'ok'
}

export const eventIngestApp = new Hono<{ Bindings: Env }>()

eventIngestApp.post('/ingest', async (c) => {
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > EVENT_INGEST_MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (new TextEncoder().encode(rawBody).byteLength > EVENT_INGEST_MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  const signatureHeader = c.req.header('x-mupot-signature') ?? null
  const verifyResult = await verifyEventSignature(c.env, rawBody, signatureHeader)

  if (verifyResult === 'not_configured') {
    return c.json({ error: 'not_configured', detail: 'EVENT_INGEST_SECRET is not configured on this pot' }, 503)
  }
  if (verifyResult === 'invalid') {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Validate required fields.
  if (typeof body.type !== 'string' || body.type.trim().length === 0) {
    return c.json({ error: 'missing_field', field: 'type' }, 400)
  }
  if (typeof body.source !== 'string' || body.source.trim().length === 0) {
    return c.json({ error: 'missing_field', field: 'source' }, 400)
  }
  if (typeof body.squad_id !== 'string' || body.squad_id.trim().length === 0) {
    return c.json({ error: 'missing_field', field: 'squad_id' }, 400)
  }

  const payload = body.payload !== null && typeof body.payload === 'object'
    ? (body.payload as Record<string, unknown>)
    : {}

  const event: InboundEvent = {
    type: body.type.trim(),
    source: body.source.trim(),
    squad_id: body.squad_id.trim(),
    payload,
  }

  const result = await ingestEvent(c.env, event, {
    actor: { kind: 'agent', id: event.source },
  })

  if (!result.ok) {
    if (result.code === 'unmapped_event_type') {
      return c.json({
        error: 'unmapped_event_type',
        event_type: result.event_type,
        detail: 'no done_when registry entry for this event type — add one to EVENT_REGISTRY in src/events/ingest.ts',
      }, 400)
    }
    if (result.code === 'squad_not_found') {
      return c.json({ error: 'squad_not_found', squad_id: result.squad_id }, 404)
    }
    return c.json({ error: 'create_failed', detail: result.detail }, 500)
  }

  return c.json({ ok: true, task_id: result.task_id, done_when: result.done_when }, 201)
})
