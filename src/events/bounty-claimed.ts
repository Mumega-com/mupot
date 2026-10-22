// mupot — `bounty.claimed` event: idempotent bounty -> task binding (seed B1).
//
// A mumega.com bounty claim is delivered over the HMAC event-ingest surface (src/events/ingest.ts)
// at-least-once. This module owns the two things that make that safe:
//
//   1. A CLOSED payload schema. Unknown keys are refused, not ignored: the payload is partner
//      content crossing a trust boundary, and a field nobody named must not ride along into a task.
//   2. Create-or-recover. The task is keyed by tasks.external_source = 'mumega-bounty:<bounty_id>'
//      (partial UNIQUE index, migration 0250) and a bounty_task_bindings row records the award
//      revision and a digest of the exact validated payload. The same binding returns the SAME task;
//      anything else against an existing key is a conflict. A task that already holds the key but has
//      no matching binding is NEVER adopted.
//
// Atomicity: the task INSERT and the binding INSERT go in one D1 batch (one transaction), so there is
// no state where the task exists without its binding. Two concurrent first deliveries race on the
// unique keys; the loser's batch rolls back whole and it re-reads the winner's binding.
//
// Privacy: claimant_ref is an opaque mumega.com identity id plus a sha256 of the email. Neither the
// raw email nor the identity ever enters the task title or body; they live in the binding row only.

import type { Env } from '../types'
import {
  emitTaskEvent,
  isPlaceholderDoneWhen,
  isValidGateOwnerForm,
  prepareGuardedTaskInsert,
  TaskProjectError,
} from '../tasks/service'
import type { CreateTaskOptions, TaskProjectErrorCode } from '../tasks/service'

export const BOUNTY_CLAIMED_EVENT = 'bounty.claimed'
export const BOUNTY_EXTERNAL_SOURCE_PREFIX = 'mumega-bounty:'

export function bountyExternalSource(bountyId: string): string {
  return `${BOUNTY_EXTERNAL_SOURCE_PREFIX}${bountyId}`
}

// ── Closed payload schema ───────────────────────────────────────────────────

export interface BountyClaimedPayload {
  readonly bounty_id: string
  readonly award_revision: number
  readonly issuer_tenant: string
  readonly claimant_ref: { readonly identity_id: string; readonly email_sha256: string }
  readonly title: string
  readonly done_when: string
  readonly price_minor: number
  readonly currency: string
  readonly gate_owner: string
  readonly project: string
}

export interface PayloadIssue {
  readonly field: string
  readonly reason: string
}

export type BountyPayloadParse =
  | { readonly ok: true; readonly value: BountyClaimedPayload }
  | { readonly ok: false; readonly issues: readonly PayloadIssue[] }

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'bounty_id', 'award_revision', 'issuer_tenant', 'claimant_ref', 'title', 'done_when',
  'price_minor', 'currency', 'gate_owner', 'project',
])
const CLAIMANT_KEYS: ReadonlySet<string> = new Set(['identity_id', 'email_sha256'])

// Identifier charset: no whitespace, no control characters, nothing that could be read as SQL/JSON
// punctuation. bounty_id becomes part of a DB key, so it is held to the strictest form.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const CURRENCY_RE = /^[A-Z]{3}$/
// C0 controls and DEL. done_when may span lines (tab/newline allowed); everything else may not.
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const CONTROL_EXCEPT_NEWLINE_TAB_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
const TITLE_MAX = 200
const DONE_WHEN_MAX = 2000
const MAX_SAFE_REVISION = 2_147_483_647
const MAX_PRICE_MINOR = Number.MAX_SAFE_INTEGER

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function parseBountyClaimedPayload(input: unknown): BountyPayloadParse {
  const issues: PayloadIssue[] = []
  if (!isRecord(input)) {
    return { ok: false, issues: [{ field: 'payload', reason: 'must be an object' }] }
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) issues.push({ field: key, reason: 'unknown field' })
  }

  const id = (field: string, v: unknown): string => {
    if (typeof v !== 'string' || !ID_RE.test(v)) {
      issues.push({ field, reason: 'must be a 1-128 char identifier [A-Za-z0-9._:-]' })
      return ''
    }
    return v
  }
  const int = (field: string, v: unknown, max: number): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) {
      issues.push({ field, reason: `must be an integer between 0 and ${max}` })
      return 0
    }
    return v
  }
  const text = (field: string, v: unknown, max: number, allowNewlines: boolean): string => {
    const bad = allowNewlines ? CONTROL_EXCEPT_NEWLINE_TAB_RE : CONTROL_RE
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max || bad.test(v)) {
      issues.push({ field, reason: `must be a non-empty string of at most ${max} chars without control characters` })
      return ''
    }
    return v.trim()
  }

  const bounty_id = id('bounty_id', input.bounty_id)
  const award_revision = int('award_revision', input.award_revision, MAX_SAFE_REVISION)
  const issuer_tenant = id('issuer_tenant', input.issuer_tenant)
  const title = text('title', input.title, TITLE_MAX, false)
  const done_when = text('done_when', input.done_when, DONE_WHEN_MAX, true)
  if (done_when !== '' && isPlaceholderDoneWhen(done_when)) {
    issues.push({ field: 'done_when', reason: 'must be a real predicate' })
  }
  const price_minor = int('price_minor', input.price_minor, MAX_PRICE_MINOR)
  let currency = ''
  if (typeof input.currency === 'string' && CURRENCY_RE.test(input.currency)) {
    currency = input.currency
  } else {
    issues.push({ field: 'currency', reason: 'must be a 3-letter upper-case ISO 4217 code' })
  }
  let gate_owner = ''
  if (typeof input.gate_owner === 'string' && isValidGateOwnerForm(input.gate_owner)) {
    gate_owner = input.gate_owner
  } else {
    // gate_owner is looked up RAW as a gate capability ('gate:<owner>'); any other form can never be
    // verdicted (see isValidGateOwnerForm in tasks/service.ts), so it is refused at the door.
    issues.push({ field: 'gate_owner', reason: "must be a gate capability of the form 'gate:<owner>'" })
  }
  const project = id('project', input.project)

  let identity_id = ''
  let email_sha256 = ''
  const ref = input.claimant_ref
  if (!isRecord(ref)) {
    issues.push({ field: 'claimant_ref', reason: 'must be an object {identity_id, email_sha256}' })
  } else {
    for (const key of Object.keys(ref)) {
      if (!CLAIMANT_KEYS.has(key)) issues.push({ field: `claimant_ref.${key}`, reason: 'unknown field' })
    }
    identity_id = id('claimant_ref.identity_id', ref.identity_id)
    if (typeof ref.email_sha256 === 'string' && SHA256_HEX_RE.test(ref.email_sha256)) {
      email_sha256 = ref.email_sha256
    } else {
      issues.push({ field: 'claimant_ref.email_sha256', reason: 'must be a lower-case hex sha256 (never the raw email)' })
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      bounty_id, award_revision, issuer_tenant,
      claimant_ref: { identity_id, email_sha256 },
      title, done_when, price_minor, currency, gate_owner, project,
    },
  }
}

// ── Digest ──────────────────────────────────────────────────────────────────

/**
 * sha256 over the validated payload plus the destination squad, in a FIXED key order (never the
 * caller's key order, so a re-serialized replay still matches). The squad is part of the binding: the
 * same bounty aimed at a different squad is a different request, not a replay.
 */
export async function bountyPayloadDigest(squadId: string, p: BountyClaimedPayload): Promise<string> {
  const canonical = JSON.stringify([
    squadId, p.bounty_id, p.award_revision, p.issuer_tenant,
    p.claimant_ref.identity_id, p.claimant_ref.email_sha256,
    p.title, p.done_when, p.price_minor, p.currency, p.gate_owner, p.project,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Registry deriver ────────────────────────────────────────────────────────

/**
 * The EVENT_REGISTRY deriver. ingestEvent routes `bounty.claimed` to ingestBountyClaimed before it
 * would call this; it exists so the registry stays the single list of accepted event types and so
 * any generic caller gets the same (validated) title/done_when. It throws on an invalid payload
 * rather than inventing a placeholder.
 */
export function deriveBountyClaimed(payload: Record<string, unknown>): {
  title: string
  done_when: string
  body: string
} {
  const parsed = parseBountyClaimedPayload(payload)
  if (!parsed.ok) throw new Error('invalid_bounty_claimed_payload')
  return {
    title: bountyTaskTitle(parsed.value),
    done_when: parsed.value.done_when,
    body: bountyTaskBody(parsed.value),
  }
}

function bountyTaskTitle(p: BountyClaimedPayload): string {
  return `[bounty] ${p.title}`
}

function formatMinor(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100)
  const cents = String(minor % 100).padStart(2, '0')
  return `${whole}.${cents} ${currency}`
}

function bountyTaskBody(p: BountyClaimedPayload): string {
  return [
    `Mumega bounty ${p.bounty_id} (award revision ${p.award_revision}), issued by tenant ${p.issuer_tenant}.`,
    `Award: ${formatMinor(p.price_minor, p.currency)} (${p.price_minor} minor units).`,
    `Gate: ${p.gate_owner}.`,
  ].join('\n')
}

// ── Create-or-recover ───────────────────────────────────────────────────────

export type BountyConflictReason =
  | 'revision_mismatch'
  | 'payload_mismatch'
  | 'external_source_taken'

export interface BountyBindingResult {
  readonly ok: true
  readonly task_id: string
  readonly done_when: string
  /** true when this call found an existing identical binding instead of creating. */
  readonly replayed: boolean
}

export type BountyBindingError =
  | { readonly ok: false; readonly code: 'invalid_payload'; readonly issues: readonly PayloadIssue[] }
  | { readonly ok: false; readonly code: 'binding_conflict'; readonly reason: BountyConflictReason }
  | { readonly ok: false; readonly code: 'project_rejected'; readonly project_code: TaskProjectErrorCode }
  | { readonly ok: false; readonly code: 'create_failed'; readonly detail: string }

interface BindingRow {
  readonly task_id: string
  readonly award_revision: number
  readonly payload_sha256: string
  readonly done_when: string
}

async function readBinding(env: Env, bountyId: string): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT b.task_id AS task_id, b.award_revision AS award_revision,
            b.payload_sha256 AS payload_sha256, t.done_when AS done_when
       FROM bounty_task_bindings b
       JOIN tasks t ON t.id = b.task_id
      WHERE b.bounty_id = ?1`,
  ).bind(bountyId).first<BindingRow>()
}

function compareBinding(
  existing: BindingRow,
  revision: number,
  digest: string,
): BountyBindingResult | BountyBindingError {
  if (existing.award_revision !== revision) {
    return { ok: false, code: 'binding_conflict', reason: 'revision_mismatch' }
  }
  if (existing.payload_sha256 !== digest) {
    return { ok: false, code: 'binding_conflict', reason: 'payload_mismatch' }
  }
  return { ok: true, task_id: existing.task_id, done_when: existing.done_when, replayed: true }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(message)
}

/**
 * Bind a claimed bounty to exactly one task. The caller (ingestEvent) has already verified that the
 * squad exists in this pot's DB.
 */
export async function ingestBountyClaimed(
  env: Env,
  squadId: string,
  rawPayload: Record<string, unknown>,
  options: CreateTaskOptions = {},
): Promise<BountyBindingResult | BountyBindingError> {
  const parsed = parseBountyClaimedPayload(rawPayload)
  if (!parsed.ok) return { ok: false, code: 'invalid_payload', issues: parsed.issues }
  const p = parsed.value
  const digest = await bountyPayloadDigest(squadId, p)

  // Recover: an existing binding is either this same delivery again, or a conflict.
  const existing = await readBinding(env, p.bounty_id)
  if (existing) return compareBinding(existing, p.award_revision, digest)

  // Create. prepareGuardedTaskInsert runs the full createTask validation (done_when contract,
  // provenance normalisation, project attribution) and forces assignee=null for external provenance.
  let prepared
  try {
    prepared = await prepareGuardedTaskInsert(
      env,
      {
        squad_id: squadId,
        project_id: p.project,
        title: bountyTaskTitle(p),
        body: bountyTaskBody(p),
        done_when: p.done_when,
        status: 'open',
        gate_owner: p.gate_owner,
      },
      { ...options, externalSource: bountyExternalSource(p.bounty_id) },
    )
  } catch (err) {
    if (err instanceof TaskProjectError) {
      return { ok: false, code: 'project_rejected', project_code: err.code }
    }
    return { ok: false, code: 'create_failed', detail: err instanceof Error ? err.message : 'unknown_error' }
  }

  const task = prepared.task
  try {
    await env.DB.batch([
      env.DB.prepare(prepared.sql).bind(...prepared.bindings),
      env.DB.prepare(
        `INSERT INTO bounty_task_bindings
           (bounty_id, task_id, award_revision, payload_sha256, issuer_tenant,
            claimant_identity_id, claimant_email_sha256, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        p.bounty_id, task.id, p.award_revision, digest, p.issuer_tenant,
        p.claimant_ref.identity_id, p.claimant_ref.email_sha256, task.created_at,
      ),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a race (or a lost-response retry landed between our read and write). The whole batch
      // rolled back, so re-read: the winner's binding decides replay vs conflict.
      const winner = await readBinding(env, p.bounty_id)
      if (winner) return compareBinding(winner, p.award_revision, digest)
      // The key is held by a task that has NO binding. Never adopt it.
      return { ok: false, code: 'binding_conflict', reason: 'external_source_taken' }
    }
    return { ok: false, code: 'create_failed', detail: err instanceof Error ? err.message : 'unknown_error' }
  }

  if (!options.skipEvent) {
    try {
      await emitTaskEvent(env, 'task.created', task, options.actor)
    } catch {
      // The task and binding are already committed. A bus hiccup must not turn a created binding into a
      // 5xx: the retry would see the binding and answer 200 anyway, with the same task id.
    }
  }
  return { ok: true, task_id: task.id, done_when: task.done_when, replayed: false }
}
