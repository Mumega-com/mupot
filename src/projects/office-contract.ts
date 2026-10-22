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

/**
 * Version of the Notice SHAPE (the key set, the hash recipe, the field rules). Intake stamps the current one on every
 * notice (`buildNotice`); the office accepts only the versions it knows (`NOTICE_CONTRACT_VERSIONS_ACCEPTED`) and refuses
 * the rest with a reason that names the problem (`contract_missing`, `contract_unsupported`) instead of the generic
 * `keys` refusal. This is what lets the main Worker and the office Worker deploy in either order: a notice built by a
 * newer Worker is refused loudly, never half-understood.
 *
 *   1  the original shape (no `contract`, no `scope`): never persisted anywhere, the office refuses it as contract_missing
 *   2  adds `contract` and `scope` (the canonical source scope the item belongs to, e.g. 'github:owner/repo')
 *
 * Bump it WITH any change to NOTICE_KEYS or the hash recipe. To roll a new version out without lockstep, ship the office
 * Worker that ACCEPTS both versions first, then the main Worker that stamps the new one, then drop the old version.
 */
export const NOTICE_CONTRACT_VERSION = 2
export const NOTICE_CONTRACT_VERSIONS_ACCEPTED: readonly number[] = [2]

export const NOTICE_PROVIDERS = ['github', 'linear', 'jira'] as const
export type NoticeProvider = (typeof NOTICE_PROVIDERS)[number]

export const NOTICE_KINDS = ['issue', 'pr', 'comment', 'deadline'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/** Lifecycle of the item in the source tool. Part of the hash: a close at the same instant is a different notice. */
export const NOTICE_STATES = ['open', 'closed', 'merged'] as const
export type NoticeState = (typeof NOTICE_STATES)[number]

export interface Notice {
  /** Notice contract version, stamped by `buildNotice`. Part of the hash. See NOTICE_CONTRACT_VERSION. */
  contract: number
  /** Pot tenant slug. Stamped by the receiving pot from its own config, never read from the payload. */
  tenant: string
  /** The connection (installation / connector) the event arrived on. Adapter-scoped id. */
  connection: string
  /**
   * The source scope this item belongs to, canonical and provider-prefixed: for GitHub the repository key from
   * `repoKeyFromUrl` ('github:owner/repo'). The office stores it with the item and re-asks D1 whether this project
   * still owns it, so items of a repository the project gave up stop being served (#2137 item 2).
   */
  scope: string
  provider: NoticeProvider
  /** Stable id of the item in the source tool (GitHub node id, Linear issue id, ...). */
  item_id: string
  /** Delivery-unique id used for dedup (GitHub x-github-delivery, Linear webhook id). */
  event_id: string
  /** Opaque, provider-defined version of the item. Equality only. */
  version: string
  kind: NoticeKind
  /** open | closed | merged, as the source tool reports it. Informational for ordering: ordering is `updated_at`. */
  state: NoticeState
  /** Human link to the item in the source tool. */
  url: string
  title: string
  /** Source-tool login/handle of whoever caused the event. Informational, never an identity. */
  actor: string
  /** ISO-8601 UTC. The only field that orders two notices for the same item. */
  updated_at: string
  /**
   * sha-256 hex over the canonical form of the fields above; see `noticeHash`. UNKEYED: it guards integrity
   * (a notice edited or truncated after hashing is refused), not authenticity (anyone can compute it). Who sent a
   * notice is decided by the caller's own checks, never by this field.
   */
  hash: string
}

/** Everything in a Notice except the hash; what an adapter's mapper assembles. */
export type NoticeFields = Omit<Notice, 'hash' | 'contract'>

export function isNoticeState(value: unknown): value is NoticeState {
  return typeof value === 'string' && (NOTICE_STATES as readonly string[]).includes(value)
}

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
export function canonicalNoticeString(f: NoticeFields, contract: number = NOTICE_CONTRACT_VERSION): string {
  return JSON.stringify([
    contract,
    f.tenant,
    f.connection,
    f.scope,
    f.provider,
    f.item_id,
    f.version,
    f.kind,
    f.state,
    f.url,
    f.title,
    f.actor,
    f.updated_at,
  ])
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function noticeHash(f: NoticeFields, contract: number = NOTICE_CONTRACT_VERSION): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNoticeString(f, contract))
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** Per-field caps. A Notice is a pointer, not a document: anything longer is refused, not truncated. */
export const NOTICE_LIMITS = {
  tenant: 128,
  connection: 256,
  scope: 512,
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

/**
 * The same, except U+200C (ZWNJ) and U+200D (ZWJ). Persian and other scripts need ZWNJ to spell ordinary words, and emoji
 * sequences need ZWJ; neither reorders text, so neither is a spoofing vector like the bidi overrides and isolates.
 * ONLY free text a person reads may use this (title, actor: `JOINER_ALLOWED_FIELDS`). An identifier, a link, a tenant or
 * a version has no use for an invisible joiner, and in one it makes two different strings look identical.
 */
const UNSAFE_TEXT_ALLOWING_JOINERS_RE = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** The only Notice fields in which ZWNJ and ZWJ are allowed. */
export const JOINER_ALLOWED_FIELDS = ['title', 'actor'] as const

/** True when `value` holds any control/format/separator character, ZWNJ and ZWJ included. The default, for every field. */
export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_RE.test(value)
}

/** `hasUnsafeText` for a free-text field: ZWNJ and ZWJ are tolerated. Call it for title and actor only. */
export function hasUnsafeTextAllowingJoiners(value: string): boolean {
  return UNSAFE_TEXT_ALLOWING_JOINERS_RE.test(value)
}

/** Remove the characters `hasUnsafeTextAllowingJoiners` refuses. For mappers, applied to title and actor ONLY. */
export function stripUnsafeText(value: string): string {
  return value.replace(new RegExp(UNSAFE_TEXT_ALLOWING_JOINERS_RE.source, 'gu'), '').trim()
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

/** A scope names its provider: 'github:...' for GitHub, 'linear:...' for Linear, 'jira:...' for Jira. */
function scopeMatchesProvider(provider: NoticeProvider, scope: string): boolean {
  return scope.startsWith(`${provider}:`) && scope.length > provider.length + 1 && !/\s/.test(scope)
}

/**
 * Why these fields are not a valid Notice, or null. `updated_at` must be the canonical UTC form
 * (`Date#toISOString`): ordering and the hash both depend on one spelling per instant.
 * With `nowMs`, a timestamp more than NOTICE_MAX_FUTURE_SKEW_MS ahead of it is refused ('updated_at_future').
 */
export function noticeFieldsProblem(f: NoticeFields, nowMs?: number): string | null {
  if (!isNoticeProvider(f.provider)) return 'provider'
  if (!isNoticeKind(f.kind)) return 'kind'
  if (!isNoticeState(f.state)) return 'state'
  for (const key of Object.keys(NOTICE_LIMITS) as (keyof typeof NOTICE_LIMITS)[]) {
    const v: unknown = f[key]
    if (typeof v !== 'string' || v.length === 0 || v.length > NOTICE_LIMITS[key]) return key
    const joinersOk = (JOINER_ALLOWED_FIELDS as readonly string[]).includes(key)
    if (joinersOk ? hasUnsafeTextAllowingJoiners(v) : hasUnsafeText(v)) return key
  }
  if (!scopeMatchesProvider(f.provider, f.scope)) return 'scope'
  if (!isSafeNoticeUrl(f.url)) return 'url'
  const t = typeof f.updated_at === 'string' ? Date.parse(f.updated_at) : Number.NaN
  if (!Number.isFinite(t) || new Date(t).toISOString() !== f.updated_at) return 'updated_at'
  if (nowMs !== undefined && t > nowMs + NOTICE_MAX_FUTURE_SKEW_MS) return 'updated_at_future'
  return null
}

/** Validate the fields, stamp the current contract version, and hash. The one way an adapter makes a Notice. */
export async function buildNotice(f: NoticeFields): Promise<Notice> {
  const problem = noticeFieldsProblem(f)
  if (problem) throw new Error(`notice_invalid:${problem}`)
  return { ...f, contract: NOTICE_CONTRACT_VERSION, hash: await noticeHash(f, NOTICE_CONTRACT_VERSION) }
}

/** The exact key set of a Notice. Anything else on an incoming object is refused, not ignored. */
/** Changing this list is a contract change: bump NOTICE_CONTRACT_VERSION with it. */
const NOTICE_KEYS = [
  'actor', 'connection', 'contract', 'event_id', 'hash', 'item_id', 'kind', 'provider', 'scope', 'state', 'tenant', 'title', 'updated_at', 'url', 'version',
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
  // Version before shape: a notice from a Worker that speaks another contract is named as such, not as "bad keys".
  if (!('contract' in v)) return { ok: false, problem: 'contract_missing' }
  const contract = v.contract
  if (typeof contract !== 'number' || !NOTICE_CONTRACT_VERSIONS_ACCEPTED.includes(contract)) {
    return { ok: false, problem: 'contract_unsupported' }
  }
  if (Object.keys(v).sort().join(',') !== NOTICE_KEYS.join(',')) return { ok: false, problem: 'keys' }
  const fields = {
    tenant: v.tenant, connection: v.connection, scope: v.scope, provider: v.provider, item_id: v.item_id, event_id: v.event_id,
    version: v.version, kind: v.kind, state: v.state, url: v.url, title: v.title, actor: v.actor, updated_at: v.updated_at,
  } as NoticeFields // field types are enforced by noticeFieldsProblem on the next line
  const problem = noticeFieldsProblem(fields, nowMs)
  if (problem) return { ok: false, problem }
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash)) return { ok: false, problem: 'hash' }
  if (v.hash !== (await noticeHash(fields, contract))) return { ok: false, problem: 'hash' }
  return { ok: true, notice: { ...fields, contract, hash: v.hash } }
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
 *   - equal timestamps with equal versions (and equal hashes, when both are given) are 'same' (a redelivery);
 *   - equal timestamps with different versions, or the same version but different content (hash), are a 'tie'. `version` is chosen by whoever pushed it (a head sha can
 *     be ground to sort high), so it must not decide a winner. The holder keeps what it has and resolves the tie
 *     by fetching the item from the source (`OfficeAdapter.fetch`), never from this field.
 */
export function noticeOrder(
  held: Pick<Notice, 'updated_at' | 'version'> & { hash?: string },
  incoming: Pick<Notice, 'updated_at' | 'version'> & { hash?: string },
): NoticeOrder {
  const h = Date.parse(held.updated_at)
  const i = Date.parse(incoming.updated_at)
  if (!Number.isFinite(h) || !Number.isFinite(i)) return 'invalid'
  if (i > h) return 'newer'
  if (i < h) return 'older'
  if (incoming.version !== held.version) return 'tie'
  // Same instant, same version, but the content differs (a close or a retitle inside the same second): not a
  // redelivery. Callers that hold the hash pass it; without both hashes only the version can be compared.
  if (held.hash !== undefined && incoming.hash !== undefined && held.hash !== incoming.hash) return 'tie'
  return 'same'
}

/** True unless `incoming` is strictly newer than what is held. Fails closed: 'invalid' and 'tie' are stale. */
export function isStale(
  held: Pick<Notice, 'updated_at' | 'version'> & { hash?: string },
  incoming: Pick<Notice, 'updated_at' | 'version'> & { hash?: string },
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
