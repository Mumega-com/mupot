// mupot — GoHighLevel (GHL) gated act-channel (issue #8).
//
// IRON DOCTRINE — never route around:
//   1. Agents NEVER hold send keys. GHL_API_KEY lives in Worker secrets (env),
//      is read ONLY at the send boundary inside sendActToGHL(), never logged,
//      never returned, never included in any error message.
//   2. An outbound act fires ONLY after an approved gate verdict. runApprovedActs()
//      re-reads task_verdicts independently of the caller — defense in depth even
//      when the pipeline only calls this after approved.
//   3. Fails closed. Missing secret/config → 'not_configured', no send, no throw.
//
// SENSITIVE SURFACE: external-facing. Built to be attacked.
//   - No key in errors: sanitized status code only on GHL API failures.
//   - Constant-time secret compare on inbound webhook (see ghl-routes.ts).
//   - Redact by construction: if a tail is ever needed, slice by index.

import type { Env } from '../types'

// ── GHL Env extension ─────────────────────────────────────────────────────────
//
// These three are optional: absent means "not configured" (fails closed).
// They are NOT in wrangler.toml (they're secrets); see the commented block at
// the bottom of wrangler.toml for the `wrangler secret put` commands.
interface GHLSecrets {
  GHL_API_KEY?: string
  GHL_LOCATION_ID?: string
  GHL_WEBHOOK_SECRET?: string
}

/** Narrow Env to its GHL secret bindings (all optional — never trust presence). */
function ghlSecrets(env: Env): GHLSecrets {
  // as unknown cast: the GHL secrets are in Env (optional fields) but tsc may not
  // see them via the structural narrowing; this cast is safe because GHLSecrets
  // declares only optional fields — it cannot over-promise.
  return env as unknown as GHLSecrets
}

// ── Configuration check ───────────────────────────────────────────────────────

/**
 * Returns true only when BOTH GHL_API_KEY and GHL_LOCATION_ID are present and
 * non-empty. False on either missing → fails closed (no send path opens).
 */
export function ghlConfigured(env: Env): boolean {
  const s = ghlSecrets(env)
  return (
    typeof s.GHL_API_KEY === 'string' && s.GHL_API_KEY.length > 0 &&
    typeof s.GHL_LOCATION_ID === 'string' && s.GHL_LOCATION_ID.length > 0
  )
}

// ── Act payload types (discriminated union) ───────────────────────────────────

export interface SendEmailAct {
  kind: 'send_email'
  /** GHL contact id. Either contactId or email is required. */
  contactId?: string
  /** Recipient email (used when contactId is absent). */
  email?: string
  subject: string
  body: string
}

export interface AddContactAct {
  kind: 'add_contact'
  email: string
  name?: string
  tags?: string[]
}

export interface MoveStageAct {
  kind: 'move_stage'
  contactId: string
  pipelineId: string
  stageId: string
}

export type GHLAct = SendEmailAct | AddContactAct | MoveStageAct

// ── Act payload validation guard ──────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Validate the payload shape for a given kind. Returns null on valid,
 * or a human-readable reason string on invalid.
 */
function validateActPayload(kind: string, payload: unknown): string | null {
  if (kind === 'send_email') {
    const p = payload as Partial<SendEmailAct>
    if (!isNonEmptyString(p.subject)) return 'send_email requires subject'
    if (!isNonEmptyString(p.body)) return 'send_email requires body'
    if (!isNonEmptyString(p.contactId) && !isNonEmptyString(p.email)) {
      return 'send_email requires contactId or email'
    }
    return null
  }
  if (kind === 'add_contact') {
    const p = payload as Partial<AddContactAct>
    if (!isNonEmptyString(p.email)) return 'add_contact requires email'
    return null
  }
  if (kind === 'move_stage') {
    const p = payload as Partial<MoveStageAct>
    if (!isNonEmptyString(p.contactId)) return 'move_stage requires contactId'
    if (!isNonEmptyString(p.pipelineId)) return 'move_stage requires pipelineId'
    if (!isNonEmptyString(p.stageId)) return 'move_stage requires stageId'
    // P2 (adversarial gate): these ids are interpolated into the GHL request path
    // (e.g. /opportunities/${contactId}). Reject anything outside a safe id charset
    // so a crafted id cannot path-traverse within GHL's API (`../`, `?`, `/`).
    if (!isSafeId(p.contactId)) return 'move_stage contactId has invalid characters'
    if (!isSafeId(p.pipelineId)) return 'move_stage pipelineId has invalid characters'
    if (!isSafeId(p.stageId)) return 'move_stage stageId has invalid characters'
    return null
  }
  return `unknown kind: ${String(kind)}`
}

// Safe identifier charset for any value interpolated into a GHL request path.
// GHL/LeadConnector ids are opaque alphanumeric tokens — no slashes, dots, or
// URL metacharacters. Rejecting everything else blocks in-API path traversal.
function isSafeId(v: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(v)
}

// ── The ghlFetch seam ─────────────────────────────────────────────────────────
//
// The real implementation passes Authorization: Bearer <GHL_API_KEY>.
// The key is read here and NEVER put into any error message, log, or response.
// Tests inject a mock ghlFetch to avoid real network calls.

export type GHLFetch = (
  path: string,
  method: string,
  body: unknown,
  apiKey: string,
  idempotencyKey: string,
) => Promise<{ ok: boolean; status: number }>

async function realGHLFetch(
  path: string,
  method: string,
  body: unknown,
  apiKey: string,
  idempotencyKey: string,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
      // Deterministic per-act key — defense in depth against a double-send if the
      // provider honours it (#8 P1). The claim-before-send state machine is the
      // primary guard; this is the belt-and-suspenders.
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status }
}

// ── GHL API call router ───────────────────────────────────────────────────────

function actToRequest(act: GHLAct, locationId: string): { path: string; method: string; body: unknown } {
  switch (act.kind) {
    case 'send_email':
      return {
        path: '/conversations/messages/inbound',
        method: 'POST',
        body: {
          type: 'Email',
          subject: act.subject,
          message: act.body,
          ...(act.contactId ? { contactId: act.contactId } : {}),
          ...(act.email && !act.contactId ? { to: act.email } : {}),
          locationId,
        },
      }
    case 'add_contact':
      return {
        path: '/contacts/',
        method: 'POST',
        body: {
          email: act.email,
          ...(act.name ? { firstName: act.name } : {}),
          ...(act.tags && act.tags.length > 0 ? { tags: act.tags } : {}),
          locationId,
        },
      }
    case 'move_stage':
      return {
        path: `/opportunities/${act.contactId}`,
        method: 'PUT',
        body: {
          pipelineId: act.pipelineId,
          pipelineStageId: act.stageId,
          locationId,
        },
      }
  }
}

// ── Verdict row seam ──────────────────────────────────────────────────────────

export interface VerdictReadRow {
  id: string
  verdict: string
}

export type ReadLatestVerdict = (env: Env, taskId: string) => Promise<VerdictReadRow | null>

async function readLatestVerdictFromD1(env: Env, taskId: string): Promise<VerdictReadRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, verdict FROM task_verdicts WHERE task_id = ? ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<{ id: string; verdict: string }>()
  return row ?? null
}

// ── Act result types ──────────────────────────────────────────────────────────

export interface ActRunResult {
  ok: boolean
  reason?: string
  sent: number
  refused: number
  failed: number
}

// ── Injectable deps ───────────────────────────────────────────────────────────

export interface GHLDeps {
  readLatestVerdict?: ReadLatestVerdict
  ghlFetch?: GHLFetch
}

// ── createOutboundAct ─────────────────────────────────────────────────────────

/**
 * Queue a pending outbound act for a task.
 *
 * The act starts 'pending'. It will only move to 'sent' when runApprovedActs()
 * confirms an approved verdict and a live GHL config. Validates kind + payload
 * shape before writing — rejects unknown kinds or malformed payloads.
 *
 * Returns { id } of the created act row.
 */
export async function createOutboundAct(
  env: Env,
  taskId: string,
  kind: string,
  payload: unknown,
): Promise<{ id: string }> {
  // Whitelist kinds.
  const KNOWN_KINDS = new Set(['send_email', 'add_contact', 'move_stage'])
  if (!KNOWN_KINDS.has(kind)) {
    throw Object.assign(new Error(`unknown_act_kind: ${kind}`), { code: 'unknown_act_kind' })
  }

  const validationErr = validateActPayload(kind, payload)
  if (validationErr) {
    throw Object.assign(new Error(`invalid_act_payload: ${validationErr}`), {
      code: 'invalid_act_payload',
    })
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO outbound_acts (id, task_id, kind, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, taskId, kind, JSON.stringify(payload), now)
    .run()

  return { id }
}

// ── runApprovedActs ───────────────────────────────────────────────────────────

/**
 * The ONLY path that fires outbound GHL acts.
 *
 * Gate logic (enforced independently — defense in depth):
 *   a. Re-reads task_verdicts from D1. If verdict is not 'approved' → mark every
 *      pending act 'refused' (detail: gate_not_approved). No send. Returns.
 *   b. If !ghlConfigured → leave pending acts as-is (inert until operator sets
 *      the secrets). Returns { ok: false, reason: 'not_configured', sent: 0 }.
 *   c. For each pending act: call GHL API (key read here, never logged).
 *      2xx → status 'sent', verdict_id set, sent_at set.
 *      non-2xx/throw → status 'failed', detail = sanitized status code only
 *      (NEVER echo the api key or auth header).
 *
 * @param env    - Worker Env (DB + secret bindings)
 * @param taskId - The task whose pending acts to run
 * @param deps   - Injectable seams for unit tests
 */
export async function runApprovedActs(
  env: Env,
  taskId: string,
  deps: GHLDeps = {},
): Promise<ActRunResult> {
  const doReadVerdict = deps.readLatestVerdict ?? readLatestVerdictFromD1
  const doFetch = deps.ghlFetch ?? realGHLFetch

  // ── a. Independent gate re-check ─────────────────────────────────────────
  const verdictRow = await doReadVerdict(env, taskId)
  if (!verdictRow || verdictRow.verdict !== 'approved') {
    // Mark every pending act refused. Even if the caller already checked,
    // this function re-checks for defense in depth.
    const pendingActs = await env.DB.prepare(
      `SELECT id FROM outbound_acts WHERE task_id = ? AND status = 'pending'`,
    )
      .bind(taskId)
      .all<{ id: string }>()

    const ids = pendingActs.results ?? []
    for (const act of ids) {
      await env.DB.prepare(
        `UPDATE outbound_acts SET status = 'refused', detail = ?, sent_at = NULL WHERE id = ?`,
      )
        .bind('gate_not_approved', act.id)
        .run()
    }

    return { ok: false, reason: 'gate_not_approved', sent: 0, refused: ids.length, failed: 0 }
  }

  const verdictId = verdictRow.id

  // ── b. Config check — fails closed ───────────────────────────────────────
  if (!ghlConfigured(env)) {
    // Leave acts pending — they will be retried when the operator sets the secrets.
    return { ok: false, reason: 'not_configured', sent: 0, refused: 0, failed: 0 }
  }

  // Safe: ghlConfigured() verified both are non-empty strings.
  const secrets = ghlSecrets(env)
  const apiKey = secrets.GHL_API_KEY as string
  const locationId = secrets.GHL_LOCATION_ID as string

  // ── c. Send each pending act ──────────────────────────────────────────────
  const pendingActs = await env.DB.prepare(
    `SELECT id, kind, payload FROM outbound_acts WHERE task_id = ? AND status = 'pending'`,
  )
    .bind(taskId)
    .all<{ id: string; kind: string; payload: string }>()

  const acts = pendingActs.results ?? []
  let sent = 0
  let failed = 0

  for (const row of acts) {
    let parsed: GHLAct
    try {
      // Parse the stored JSON and re-attach the kind from the DB column
      // (the canonical source of truth for kind). We build the object with
      // a literal `kind` so TypeScript can narrow the discriminant correctly.
      const base = JSON.parse(row.payload) as Omit<GHLAct, 'kind'>
      const kind = row.kind as GHLAct['kind']
      parsed = { ...base, kind } as GHLAct
    } catch {
      // Corrupted payload — mark failed, never crash.
      await env.DB.prepare(
        `UPDATE outbound_acts SET status = 'failed', detail = ? WHERE id = ?`,
      )
        .bind('payload_parse_error', row.id)
        .run()
      failed++
      continue
    }

    // ── CLAIM before send (#8 P1) ────────────────────────────────────────────
    // Atomically move pending→sending, conditioned on the row still being
    // pending. If a previous (crashed/retried) run already claimed and sent this
    // act, this UPDATE changes 0 rows and we SKIP — the external send never
    // happens twice. The claim records the authorizing verdict + the claim time.
    const claimedAt = new Date().toISOString()
    const claim = await env.DB.prepare(
      `UPDATE outbound_acts
          SET status = 'sending', verdict_id = ?, sent_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
      .bind(verdictId, claimedAt, row.id)
      .run()
    const claimed = (claim.meta?.changes ?? 0) === 1
    if (!claimed) {
      // Already claimed/sent by a prior attempt — do NOT re-send.
      continue
    }

    const { path, method, body } = actToRequest(parsed, locationId)

    let result: { ok: boolean; status: number }
    try {
      // The API key is passed to ghlFetch here and NOWHERE else. It never
      // appears in any log, error message, or returned object. The act id is the
      // deterministic idempotency key.
      result = await doFetch(path, method, body, apiKey, row.id)
    } catch {
      // Network/runtime error — sanitize: status not available, record the
      // exception type only (never the error message which may echo headers).
      await env.DB.prepare(
        `UPDATE outbound_acts SET status = 'failed', detail = ? WHERE id = ?`,
      )
        .bind('fetch_error', row.id)
        .run()
      failed++
      continue
    }

    if (result.ok) {
      const now = new Date().toISOString()
      await env.DB.prepare(
        `UPDATE outbound_acts
            SET status = 'sent', verdict_id = ?, sent_at = ?, detail = NULL
          WHERE id = ?`,
      )
        .bind(verdictId, now, row.id)
        .run()
      sent++
    } else {
      // Non-2xx: record the status CODE only — never the response body or auth header.
      await env.DB.prepare(
        `UPDATE outbound_acts SET status = 'failed', detail = ? WHERE id = ?`,
      )
        .bind(`ghl_${result.status}`, row.id)
        .run()
      failed++
    }
  }

  return { ok: true, sent, refused: 0, failed }
}
