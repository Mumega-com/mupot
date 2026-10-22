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
//     comparable for EQUALITY within one (provider, item_id). ORDERING is decided only by
//     `updated_at`, so an old webhook delivered late cannot overwrite newer state
//     (see `isStale`).

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

export async function buildNotice(f: NoticeFields): Promise<Notice> {
  return { ...f, hash: await noticeHash(f) }
}

/** True when `incoming` is not newer than what the office already holds for the same item. */
export function isStale(held: Pick<Notice, 'updated_at'>, incoming: Pick<Notice, 'updated_at'>): boolean {
  return Date.parse(incoming.updated_at) < Date.parse(held.updated_at)
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

export function isDoorbell(value: unknown): value is Doorbell {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const keys = Object.keys(v).sort().join(',')
  if (keys !== 'attempt,event,hash,project,task_id,version') return false
  return (
    typeof v.project === 'string' &&
    v.project.length > 0 &&
    typeof v.task_id === 'string' &&
    v.task_id.length > 0 &&
    typeof v.attempt === 'number' &&
    Number.isInteger(v.attempt) &&
    v.attempt >= 0 &&
    typeof v.event === 'string' &&
    (DOORBELL_EVENTS as readonly string[]).includes(v.event) &&
    typeof v.version === 'string' &&
    typeof v.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(v.hash)
  )
}
