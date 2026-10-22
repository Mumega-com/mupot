// mupot — ProjectOffice contract (Phase 0 of docs/plan-project-back-office-20261022).
//
// Three shapes, all pure data + one hash function, no I/O, no Env:
//
//   1. Notice          what an adapter tells the office happened in a source tool.
//   2. OfficeAdapter   the ONE interface every source tool (GitHub, Linear, Jira, ...) implements.
//   3. Doorbell        what the office sends toward a seat. A POINTER, never content.
//
// Rules this file encodes (so adapters and the office cannot drift apart):
//
//   - Content stays in the source. A Notice carries enough to dedupe, order and link
//     (ids, version, url, title, actor, hash). It never carries a body, a diff, or a comment text.
//   - A source tool proposes; only a mupot principal assigns. A Notice has no assignee field and
//     nothing in this file lets an adapter set one.
//   - Authority resolves in D1. A Doorbell carries {project, task_id, attempt, event, version, hash}
//     and nothing a receiver could mistake for a grant.
//   - `version` is OPAQUE and provider-defined (a PR head sha, an updated-at stamp, ...). It is
//     comparable for EQUALITY within one (provider, item_id). ORDERING is decided by `updated_at`.
//     When two notices share a timestamp (GitHub's resolution is one second) but carry different
//     versions, `version` is attacker-influenceable (a head sha can be ground), so it is NEVER used to
//     pick a winner: the order is 'tie', the holder keeps what it has and records the competing version
//     for a refetch from the source (see `noticeOrder`). An old webhook delivered late cannot overwrite
//     newer state, a future-dated `updated_at` is refused (see `NOTICE_MAX_FUTURE_SKEW_MS`), and anything
//     that cannot be ordered is rejected rather than applied.
//   - Every text field is data from a source tool a stranger may write to. Control, format and bidi
//     characters are refused (mappers strip them from title and actor first), and `url` must be https.

// ── Notice ───────────────────────────────────────────────────────────────────

export const NOTICE_PROVIDERS = ['github', 'linear', 'jira'] as const
export type NoticeProvider = (typeof NOTICE_PROVIDERS)[number]

export const NOTICE_KINDS = ['issue', 'pr', 'comment', 'deadline'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export interface Notice {
  /** Pot tenant slug. Stamped by the receiving pot from its own config, never read from the payload. */
  tenant: string
  /** The connection (installation / connector) the event arrived on. Adapter-scoped id. */
  connection: string
  provider: NoticeProvider
  /** Stable id of the item in the source tool (GitHub node id, Linear issue id, ...). */
  item_id: string
  /** Delivery-unique id used for dedup (GitHub x-github-delivery, Linear webhook id). */
  event_id: string
  /** Opaque, provider-defined version of the item. Equality only. */
  version: string
  kind: NoticeKind
  /** Human link to the item in the source tool. */
  url: string
  title: string
  /** Source-tool login/handle of whoever caused the event. Informational, never an identity. */
  actor: string
  /** ISO-8601 UTC. The only field that orders two notices for the same item. */
  updated_at: string
  /** sha-256 hex over the canonical form of the fields above; see `noticeHash`. */
  hash: string
}

/** Everything in a Notice except the hash; what an adapter's mapper assembles. */
export type NoticeFields = Omit<Notice, 'hash'>

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === 'string' && (NOTICE_KINDS as readonly string[]).includes(value)
}

export function isNoticeProvider(value: unknown): value is NoticeProvider {
  return typeof value === 'string' && (NOTICE_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Canonical string the hash is taken over. Field order is fixed here, values are JSON-encoded
 * so a field that contains a newline or a separator cannot be shifted into its neighbour.
 * `event_id` is deliberately NOT part of the hash: two deliveries of the same item version
 * (a redelivery, a poll catching up with a webhook) hash identically, which is what lets the
 * office collapse them.
 */
export function canonicalNoticeString(f: NoticeFields): string {
  return JSON.stringify([
    f.tenant,
    f.connection,
    f.provider,
    f.item_id,
    f.version,
    f.kind,
    f.url,
    f.title,
    f.actor,
    f.updated_at,
  ])
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function noticeHash(f: NoticeFields): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNoticeString(f))
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** Per-field caps. A Notice is a pointer, not a document: anything longer is refused, not truncated. */
export const NOTICE_LIMITS = {
  tenant: 128,
  connection: 256,
  item_id: 256,
  event_id: 256,
  version: 256,
  url: 2048,
  title: 1024,
  actor: 256,
} as const

/**
 * How far past the receiver's clock an `updated_at` may be before the notice is refused. `updated_at` is the only
 * ordering field, so a far-future one would pin an item and make every genuine later notice look stale.
 */
export const NOTICE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * Control (Cc), format (Cf: bidi overrides and isolates, zero-width, BOM, tag characters) and line/paragraph
 * separator characters. None belongs in a one-line title, handle, id or link.
 */
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_RE.test(value)
}

/** Remove the characters `hasUnsafeText` refuses. For mappers, applied to title and actor before validation. */
export function stripUnsafeText(value: string): string {
  return value.replace(new RegExp(UNSAFE_TEXT_RE.source, 'gu'), '').trim()
}

/** https only, a real host, no embedded credentials, no whitespace or hidden characters anywhere in the text. */
export function isSafeNoticeUrl(value: string): boolean {
  if (/\s/.test(value) || hasUnsafeText(value)) return false
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === ''
}

/**
 * Why these fields are not a valid Notice, or null. `updated_at` must be the canonical UTC form
 * (`Date#toISOString`): ordering and the hash both depend on one spelling per instant.
 * With `nowMs`, a timestamp more than NOTICE_MAX_FUTURE_SKEW_MS ahead of it is refused ('updated_at_future').
 */
export function noticeFieldsProblem(f: NoticeFields, nowMs?: number): string | null {
  if (!isNoticeProvider(f.provider)) return 'provider'
  if (!isNoticeKind(f.kind)) return 'kind'
  for (const key of Object.keys(NOTICE_LIMITS) as (keyof typeof NOTICE_LIMITS)[]) {
    const v: unknown = f[key]
    if (typeof v !== 'string' || v.length === 0 || v.length > NOTICE_LIMITS[key]) return key
    if (hasUnsafeText(v)) return key
  }
  if (!isSafeNoticeUrl(f.url)) return 'url'
  const t = typeof f.updated_at === 'string' ? Date.parse(f.updated_at) : Number.NaN
  if (!Number.isFinite(t) || new Date(t).toISOString() !== f.updated_at) return 'updated_at'
  if (nowMs !== undefined && t > nowMs + NOTICE_MAX_FUTURE_SKEW_MS) return 'updated_at_future'
  return null
}

export async function buildNotice(f: NoticeFields): Promise<Notice> {
  const problem = noticeFieldsProblem(f)
  if (problem) throw new Error(`notice_invalid:${problem}`)
  return { ...f, hash: await noticeHash(f) }
}

/** The exact key set of a Notice. Anything else on an incoming object is refused, not ignored. */
const NOTICE_KEYS = [
  'actor', 'connection', 'event_id', 'hash', 'item_id', 'kind', 'provider', 'tenant', 'title', 'updated_at', 'url', 'version',
] as const

export type NoticeCheck = { ok: true; notice: Notice } | { ok: false; problem: string }

/**
 * Strict check for a Notice that crossed a trust boundary (the office RPC): a plain object with EXACTLY the Notice
 * keys, every field valid (`noticeFieldsProblem`), and a `hash` equal to the one recomputed here, so a notice whose
 * fields were edited after hashing, or built by something other than `buildNotice`, is refused.
 * Returns a fresh object holding only the validated values, so nothing else the caller attached survives.
 */
export async function checkNotice(value: unknown, nowMs?: number): Promise<NoticeCheck> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, problem: 'shape' }
  const v = value as Record<string, unknown> // shape-checked key by key below
  if (Object.keys(v).sort().join(',') !== NOTICE_KEYS.join(',')) return { ok: false, problem: 'keys' }
  const fields = {
    tenant: v.tenant, connection: v.connection, provider: v.provider, item_id: v.item_id, event_id: v.event_id,
    version: v.version, kind: v.kind, url: v.url, title: v.title, actor: v.actor, updated_at: v.updated_at,
  } as NoticeFields // field types are enforced by noticeFieldsProblem on the next line
  const problem = noticeFieldsProblem(fields, nowMs)
  if (problem) return { ok: false, problem }
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash)) return { ok: false, problem: 'hash' }
  if (v.hash !== (await noticeHash(fields))) return { ok: false, problem: 'hash' }
  return { ok: true, notice: { ...fields, hash: v.hash } }
}

export async function isNotice(value: unknown, nowMs?: number): Promise<boolean> {
  return (await checkNotice(value, nowMs)).ok
}

/**
 * 'tie': the same instant (GitHub's resolution is one second) with two different versions. Nothing the notice
 * itself carries can say which is current, so it is not ordered: see `noticeOrder`.
 */
export type NoticeOrder = 'newer' | 'same' | 'older' | 'tie' | 'invalid'

/**
 * Order an incoming notice against what the office holds for the same item.
 *   - an unparseable timestamp on either side is 'invalid' (never applied);
 *   - a later `updated_at` is 'newer', an earlier one 'older';
 *   - equal timestamps with equal versions are 'same' (a redelivery);
 *   - equal timestamps with different versions are a 'tie'. `version` is chosen by whoever pushed it (a head sha can
 *     be ground to sort high), so it must not decide a winner. The holder keeps what it has and resolves the tie
 *     by fetching the item from the source (`OfficeAdapter.fetch`), never from this field.
 */
export function noticeOrder(
  held: Pick<Notice, 'updated_at' | 'version'>,
  incoming: Pick<Notice, 'updated_at' | 'version'>,
): NoticeOrder {
  const h = Date.parse(held.updated_at)
  const i = Date.parse(incoming.updated_at)
  if (!Number.isFinite(h) || !Number.isFinite(i)) return 'invalid'
  if (i > h) return 'newer'
  if (i < h) return 'older'
  return incoming.version === held.version ? 'same' : 'tie'
}

/** True unless `incoming` is strictly newer than what is held. Fails closed: 'invalid' and 'tie' are stale. */
export function isStale(
  held: Pick<Notice, 'updated_at' | 'version'>,
  incoming: Pick<Notice, 'updated_at' | 'version'>,
): boolean {
  return noticeOrder(held, incoming) !== 'newer'
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** What a given adapter can do. The office only asks for a capability the adapter declared. */
export interface AdapterCapabilities {
  /** Receives signed webhooks. */
  webhook: boolean
  /** Can be polled / reconciled from a cursor. */
  poll: boolean
  /** publish() may post a comment carrying a verdict or receipt link. */
  comment: boolean
  /** publish() may change item status. Off by default; behind a gate and per-project policy. */
  status: boolean
}

export interface ItemRef {
  connection: string
  provider: NoticeProvider
  item_id: string
}

/** A pointer-sized snapshot of an item at a version. Content is NOT included. */
export interface ItemSnapshot {
  ref: ItemRef
  version: string
  kind: NoticeKind
  url: string
  title: string
  updated_at: string
}

/**
 * The only write-back the contract allows. The v1 variant is one comment with a link;
 * `status` exists in the type so the capability is declared, but `capabilities.status` gates it.
 */
export type AllowedUpdate =
  | { type: 'comment'; ref: ItemRef; version: string; link: string; summary: string }
  | { type: 'status'; ref: ItemRef; version: string; status: string }

export type PublishResult =
  | { ok: true; external_id: string }
  | { ok: false; error: 'unsupported' | 'stale_version' | 'rejected' | 'unavailable' }

export interface ReconcileResult {
  notices: Notice[]
  /** Opaque cursor to resume from. Absent when the source has no cursor semantics. */
  next_cursor?: string
}

export interface OfficeAdapter {
  readonly provider: NoticeProvider
  readonly capabilities: AdapterCapabilities
  /**
   * Catch up with the source. Webhook adapters use this to repair missed deliveries;
   * poll adapters use it as their only driver. Resumes from `cursor` when given.
   */
  reconcile(connection: string, cursor?: string): Promise<ReconcileResult>
  /** Read an item at a version. `null` when the source no longer has that version. */
  fetch(item: ItemRef, version: string): Promise<ItemSnapshot | null>
  /** Write back one allowed update. Must refuse (`stale_version`) when `version` is no longer current. */
  publish(update: AllowedUpdate): Promise<PublishResult>
}

// ── Doorbell ─────────────────────────────────────────────────────────────────

export const DOORBELL_EVENTS = ['assigned', 'follow_up', 'verdict_needed', 'cancelled'] as const
export type DoorbellEvent = (typeof DOORBELL_EVENTS)[number]

/**
 * office → SeatEventsDO → seat wake. Pointers only: the receiver resolves everything it is
 * allowed to know from D1 using `task_id`, so a forged or replayed doorbell grants nothing.
 */
export interface Doorbell {
  project: string
  task_id: string
  attempt: number
  event: DoorbellEvent
  version: string
  hash: string
}

/** Doorbell bounds. A pointer is short; anything bigger is not one. */
export const DOORBELL_LIMITS = { project: 256, task_id: 128, version: 256, attempt: 1000 } as const

export function isDoorbell(value: unknown): value is Doorbell {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown> // shape-checked key by key below
  const keys = Object.keys(v).sort().join(',')
  if (keys !== 'attempt,event,hash,project,task_id,version') return false
  return (
    typeof v.project === 'string' &&
    v.project.length > 0 &&
    v.project.length <= DOORBELL_LIMITS.project &&
    typeof v.task_id === 'string' &&
    v.task_id.length > 0 &&
    v.task_id.length <= DOORBELL_LIMITS.task_id &&
    typeof v.attempt === 'number' &&
    Number.isInteger(v.attempt) &&
    v.attempt >= 0 &&
    v.attempt <= DOORBELL_LIMITS.attempt &&
    typeof v.event === 'string' &&
    (DOORBELL_EVENTS as readonly string[]).includes(v.event) &&
    typeof v.version === 'string' &&
    v.version.length > 0 &&
    v.version.length <= DOORBELL_LIMITS.version &&
    typeof v.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(v.hash)
  )
}
