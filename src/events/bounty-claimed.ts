// mupot — `bounty.claimed` event: idempotent bounty -> task binding (seed B1).
//
// A mumega.com bounty claim is delivered over a dedicated HMAC channel (see events/ingest.ts:
// BOUNTY_INGEST_SECRET, never the shared event secret) at-least-once. This module owns what makes
// that safe:
//
//   1. A CLOSED payload schema. Unknown keys are refused, not ignored: the payload is partner content
//      crossing a trust boundary, and a field nobody named must not ride along into a task.
//   2. An AUDIENCE. The signed payload names `destination_tenant`; it must equal this pot's
//      TENANT_SLUG (403 wrong_tenant), the same rule as src/economy/cc-spend.ts. A delivery signed
//      for another pot cannot create work here.
//   3. Create-or-recover. The task is keyed by tasks.external_source = 'mumega-bounty:<bounty_id>'
//      (partial UNIQUE index, migration 0250) and a bounty_task_bindings row records the award
//      revision and a digest of the exact validated payload. The same binding returns the SAME task;
//      anything else against an existing key is a conflict. A task that already holds the key but has
//      no matching binding is NEVER adopted.
//   4. A reserved namespace. No other writer may stamp 'mumega-bounty:' (tasks/provenance.ts,
//      enforced at prepareGuardedTaskInsert and again by triggers in migration 0250).
//
// RE-AWARDS. A higher `award_revision` for an existing bounty_id is deliberately a 409
// `revision_mismatch` here. Replacing the claimant of a bounty (a re-award) changes who the work
// belongs to, which is an authority decision with consequences for the live task, its verdicts and
// the receipt chain. B2 (member-path result submission / replaced attempts) owns that; B1 never
// rewrites an existing binding.
//
// Atomicity: the task INSERT and the binding INSERT go in one D1 batch (one transaction), so there is
// no state where the task exists without its binding. Two concurrent first deliveries race on the
// unique keys; the loser's batch rolls back whole and it re-reads the winner's binding.
//
// Wake delivery: `task.created` is emitted AFTER the commit, so the emit can fail while the task
// stands. The binding records `created_event_emitted_at`; any later delivery of the same binding
// that finds it NULL re-emits (at-least-once: a duplicate wake is harmless, a lost one is not) and
// then marks it. A failed emit is never silent: it is retried on the next delivery.
//
// Privacy: claimant_ref is an opaque mumega.com identity id. No email, hash of an email, or other
// personal data is accepted: an unkeyed hash of a low-entropy value is a reversible identifier, and
// nothing in B1 needs one. If B2 needs email matching it will add a KEYED digest by agreement.

import type { Env, Task } from '../types'
import { isReservedForHumansOrSubsystems } from '../gates/lanes'
import {
  emitTaskEvent,
  isPlaceholderDoneWhen,
  isValidGateOwnerForm,
  mapTaskProjectInsertError,
  prepareGuardedTaskInsert,
  ReservedProvenanceError,
  TaskIntakeContractError,
  TaskProjectError,
} from '../tasks/service'
import type { CreateTaskOptions, TaskProjectErrorCode } from '../tasks/service'
import { currencyExponent, formatMinorUnits } from './currency'

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
  readonly destination_tenant: string
  readonly claimant_ref: { readonly identity_id: string }
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
  'bounty_id', 'award_revision', 'issuer_tenant', 'destination_tenant', 'claimant_ref', 'title', 'done_when',
  'price_minor', 'currency', 'gate_owner', 'project',
])
const CLAIMANT_KEYS: ReadonlySet<string> = new Set(['identity_id'])

// bounty_id becomes part of a DB key and of the case-sensitive 'mumega-bounty:' namespace, so it is
// held to ONE canonical form: lower-case alphanumerics and hyphens. Anything else is rejected, not
// normalised (a silent lower-casing would make 'ABC' and 'abc' the same binding without anyone
// having said so).
const BOUNTY_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
// Other identifiers: no whitespace, no control characters, nothing read as SQL/JSON punctuation.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Characters a human reader cannot see or that reorder/reflow what they do see, refused in anything
// that is displayed or becomes a predicate: C0 controls and DEL, C1 controls (incl. U+0085), zero-width
// and directional marks (U+200B-200F), line/paragraph separators and bidi embeddings/overrides
// (U+2028-202E), word joiner and invisible operators (U+2060-2064), bidi isolates (U+2066-2069), BOM.
// done_when may span lines, so tab/LF/CR are carved out of the C0 range for it alone.
const INVISIBLE_RE = '\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff'
const FORBIDDEN_SINGLE_LINE_RE = new RegExp(`[\\u0000-\\u001f${INVISIBLE_RE}]`)
const FORBIDDEN_MULTI_LINE_RE = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f${INVISIBLE_RE}]`)
const TITLE_MAX = 200
const DONE_WHEN_MIN = 5 // mirrors assertValidIntakeContract (tasks/service.ts): shorter is not verifiable
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

  const ident = (field: string, v: unknown, re: RegExp, shape: string): string => {
    if (typeof v !== 'string' || !re.test(v)) {
      issues.push({ field, reason: `must be ${shape}` })
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
  const text = (field: string, v: unknown, min: number, max: number, multiLine: boolean): string => {
    const forbidden = multiLine ? FORBIDDEN_MULTI_LINE_RE : FORBIDDEN_SINGLE_LINE_RE
    if (typeof v !== 'string' || v.trim().length < min || v.length > max || forbidden.test(v)) {
      issues.push({
        field,
        reason: `must be a string of ${min}-${max} chars without control, zero-width or bidi/line-separator characters`,
      })
      return ''
    }
    return v.trim()
  }

  const bounty_id = ident('bounty_id', input.bounty_id, BOUNTY_ID_RE, 'a 1-128 char id of lower-case [a-z0-9-]')
  const award_revision = int('award_revision', input.award_revision, MAX_SAFE_REVISION)
  const issuer_tenant = ident('issuer_tenant', input.issuer_tenant, ID_RE, 'a 1-128 char identifier [A-Za-z0-9._:-]')
  const destination_tenant = ident('destination_tenant', input.destination_tenant, ID_RE, 'a 1-128 char identifier [A-Za-z0-9._:-]')
  const title = text('title', input.title, 1, TITLE_MAX, false)
  const done_when = text('done_when', input.done_when, DONE_WHEN_MIN, DONE_WHEN_MAX, true)
  if (done_when !== '' && isPlaceholderDoneWhen(done_when)) {
    issues.push({ field: 'done_when', reason: 'must be a real predicate' })
  }
  const price_minor = int('price_minor', input.price_minor, MAX_PRICE_MINOR)
  let currency = ''
  if (typeof input.currency === 'string' && currencyExponent(input.currency) !== null) {
    currency = input.currency
  } else {
    issues.push({ field: 'currency', reason: 'must be an allowlisted ISO 4217 code (upper-case)' })
  }

  let gate_owner = ''
  if (typeof input.gate_owner !== 'string' || !isValidGateOwnerForm(input.gate_owner)) {
    // gate_owner is looked up RAW as a gate capability ('gate:<owner>'); any other form can never be
    // verdicted (see isValidGateOwnerForm in tasks/service.ts), so it is refused at the door.
    issues.push({ field: 'gate_owner', reason: "must be a gate capability of the form 'gate:<owner>'" })
  } else if (isReservedForHumansOrSubsystems(input.gate_owner)) {
    // Subsystem lanes (gate:office, gate:routines, gate:agent-self-completion, gate:self-*) have their
    // own completion machinery, and gate:hadi is the human gate: human approval is not a gate an
    // external partner may assign work to. Same reserved set as task_create and the dyad default.
    issues.push({ field: 'gate_owner', reason: 'this gate is reserved for its own subsystem or for humans and cannot be assigned by a bounty' })
  } else {
    gate_owner = input.gate_owner
  }
  const project = ident('project', input.project, ID_RE, 'a project id [A-Za-z0-9._:-]')

  let identity_id = ''
  const ref = input.claimant_ref
  if (!isRecord(ref)) {
    issues.push({ field: 'claimant_ref', reason: 'must be an object {identity_id}' })
  } else {
    for (const key of Object.keys(ref)) {
      if (!CLAIMANT_KEYS.has(key)) issues.push({ field: `claimant_ref.${key}`, reason: 'unknown field' })
    }
    identity_id = ident('claimant_ref.identity_id', ref.identity_id, ID_RE, 'an opaque identity id [A-Za-z0-9._:-]')
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      bounty_id, award_revision, issuer_tenant, destination_tenant,
      claimant_ref: { identity_id },
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
    squadId, p.bounty_id, p.award_revision, p.issuer_tenant, p.destination_tenant,
    p.claimant_ref.identity_id,
    p.title, p.done_when, p.price_minor, p.currency, p.gate_owner, p.project,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Registry deriver ────────────────────────────────────────────────────────

/**
 * The EVENT_REGISTRY deriver. The route sends `bounty.claimed` to ingestBountyClaimed (on its own
 * secret) and ingestEvent refuses the type outright; this entry exists so the registry stays the
 * single list of accepted event types and any generic reader gets the same validated title/done_when.
 * It throws on an invalid payload rather than inventing a placeholder.
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

function bountyTaskBody(p: BountyClaimedPayload): string {
  return [
    `Mumega bounty ${p.bounty_id} (award revision ${p.award_revision}), issued by tenant ${p.issuer_tenant}.`,
    `Award: ${formatMinorUnits(p.price_minor, p.currency)} (${p.price_minor} minor units).`,
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
  | { readonly ok: false; readonly code: 'wrong_tenant' }
  | { readonly ok: false; readonly code: 'squad_not_found'; readonly squad_id: string }
  | { readonly ok: false; readonly code: 'binding_conflict'; readonly reason: BountyConflictReason }
  | { readonly ok: false; readonly code: 'project_rejected'; readonly project_code: TaskProjectErrorCode }
  | { readonly ok: false; readonly code: 'create_failed'; readonly detail: string }

interface BindingRow {
  readonly task_id: string
  readonly award_revision: number
  readonly payload_sha256: string
  readonly done_when: string
  readonly created_event_emitted_at: string | null
}

async function readBinding(env: Env, bountyId: string): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT b.task_id AS task_id, b.award_revision AS award_revision,
            b.payload_sha256 AS payload_sha256, t.done_when AS done_when,
            b.created_event_emitted_at AS created_event_emitted_at
       FROM bounty_task_bindings b
       JOIN tasks t ON t.id = b.task_id
      WHERE b.bounty_id = ?1`,
  ).bind(bountyId).first<BindingRow>()
}

/**
 * Emit task.created for a bound task and record that it happened. Never throws: a failed emit leaves
 * created_event_emitted_at NULL so the next delivery of the same binding retries it.
 */
async function emitCreatedAndMark(
  env: Env,
  bountyId: string,
  task: Task,
  options: CreateTaskOptions,
): Promise<void> {
  try {
    await emitTaskEvent(env, 'task.created', task, options.actor)
    await env.DB.prepare(
      `UPDATE bounty_task_bindings SET created_event_emitted_at = ?2
        WHERE bounty_id = ?1 AND created_event_emitted_at IS NULL`,
    ).bind(bountyId, new Date().toISOString()).run()
  } catch {
    // Committed task + binding stand. The unmarked binding is the repair record.
  }
}

/** A replay whose original task.created never went out repairs the wake. */
async function repairMissingCreatedEvent(
  env: Env,
  bountyId: string,
  row: BindingRow,
  options: CreateTaskOptions,
): Promise<void> {
  if (options.skipEvent || row.created_event_emitted_at !== null) return
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(row.task_id).first<Task>()
  if (!task) return
  await emitCreatedAndMark(env, bountyId, task, options)
}

async function compareBinding(
  env: Env,
  bountyId: string,
  existing: BindingRow,
  revision: number,
  digest: string,
  options: CreateTaskOptions,
): Promise<BountyBindingResult | BountyBindingError> {
  if (existing.award_revision !== revision) {
    return { ok: false, code: 'binding_conflict', reason: 'revision_mismatch' }
  }
  if (existing.payload_sha256 !== digest) {
    return { ok: false, code: 'binding_conflict', reason: 'payload_mismatch' }
  }
  await repairMissingCreatedEvent(env, bountyId, existing, options)
  return { ok: true, task_id: existing.task_id, done_when: existing.done_when, replayed: true }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(message)
}

/**
 * Bind a claimed bounty to exactly one task. The caller has authenticated the delivery with the
 * bounty channel's own secret; this function checks the audience and the squad, then create-or-recovers.
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

  // AUDIENCE (src/economy/cc-spend.ts rule): the signed payload must be addressed to THIS pot.
  if (p.destination_tenant !== env.TENANT_SLUG) return { ok: false, code: 'wrong_tenant' }

  // Squad existence (tenant isolation: one DB per pot, a squad row exists only if this pot owns it).
  const squadRow = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1 LIMIT 1')
    .bind(squadId).first<{ id: string }>()
  if (!squadRow) return { ok: false, code: 'squad_not_found', squad_id: squadId }

  const digest = await bountyPayloadDigest(squadId, p)

  // Recover: an existing binding is either this same delivery again, or a conflict.
  const existing = await readBinding(env, p.bounty_id)
  if (existing) return compareBinding(env, p.bounty_id, existing, p.award_revision, digest, options)

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
      {
        ...options,
        externalSource: bountyExternalSource(p.bounty_id),
        reservedProvenanceAuthority: 'mumega-bounty-ingest',
      },
    )
  } catch (err) {
    if (err instanceof TaskProjectError) {
      return { ok: false, code: 'project_rejected', project_code: err.code }
    }
    if (err instanceof TaskIntakeContractError) {
      return { ok: false, code: 'invalid_payload', issues: [{ field: 'done_when', reason: err.code }] }
    }
    if (err instanceof ReservedProvenanceError) {
      return { ok: false, code: 'create_failed', detail: 'external_source_reserved' }
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
            claimant_identity_id, created_event_emitted_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
      ).bind(
        p.bounty_id, task.id, p.award_revision, digest, p.issuer_tenant,
        p.claimant_ref.identity_id, task.created_at,
      ),
    ])
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a race (or a lost-response retry landed between our read and write). The whole batch
      // rolled back, so re-read: the winner's binding decides replay vs conflict.
      const winner = await readBinding(env, p.bounty_id)
      if (winner) return compareBinding(env, p.bounty_id, winner, p.award_revision, digest, options)
      // The key is held by a task that has NO binding. Never adopt it.
      return { ok: false, code: 'binding_conflict', reason: 'external_source_taken' }
    }
    // A project fence that fired between validation and the write (archived, access revoked, trigger)
    // is the caller's 404/403/409, not a 500.
    try {
      mapTaskProjectInsertError(err)
    } catch (mapped) {
      if (mapped instanceof TaskProjectError) {
        return { ok: false, code: 'project_rejected', project_code: mapped.code }
      }
    }
    return { ok: false, code: 'create_failed', detail: err instanceof Error ? err.message : 'unknown_error' }
  }

  if (!options.skipEvent) await emitCreatedAndMark(env, p.bounty_id, task, options)
  return { ok: true, task_id: task.id, done_when: task.done_when, replayed: false }
}
