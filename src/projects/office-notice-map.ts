// mupot — webhook payload → Notice mappers for the ProjectOffice contract
// (./office-contract.ts). Pure functions over already-verified payloads: signature
// verification and delivery dedup stay where they already live (GitHub App route, Linear
// importer); this file only turns a verified payload into the one normalized shape.
//
// A mapper returns null for an event it does not turn into a Notice (unsupported type or
// action, or a payload missing a field the contract requires). It never throws on hostile
// input and never copies a body/description/comment text into the Notice.

import {
  buildNotice,
  noticeFieldsProblem,
  stripUnsafeText,
  type Notice,
  type NoticeFields,
  type NoticeKind,
  type NoticeState,
} from './office-contract'

export interface NoticeSource {
  /** Pot tenant slug, from the receiving pot's own config. Never taken from the payload. */
  tenant: string
  /** Installation / connector id the delivery arrived on. */
  connection: string
  /** Delivery-unique id (x-github-delivery / Linear-Delivery header). */
  eventId: string
}

type Rec = Record<string, unknown>

function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null // narrowed by the typeof/array checks
}

function text(o: Rec | null, key: string): string | null {
  const v = o?.[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function isoOrNull(v: string | null): string | null {
  return v !== null && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null
}

// Per event: the actions the office follows. Label removal is a change like label addition.
const GITHUB_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pull_request: new Set(['opened', 'reopened', 'edited', 'synchronize', 'closed', 'labeled', 'unlabeled', 'ready_for_review']),
  issues: new Set(['opened', 'reopened', 'edited', 'closed', 'labeled', 'unlabeled']),
  issue_comment: new Set(['created', 'edited']),
}

/** True when the office follows this GitHub event + action. Lets a caller drop an event before any I/O. */
export function followsGithubAction(eventName: string, action: unknown): boolean {
  return typeof action === 'string' && (GITHUB_ACTIONS[eventName]?.has(action) ?? false)
}

/**
 * Build the Notice, or null when the assembled fields are not a valid one (over-long, bad kind, bad time, a link
 * that is not https). Title and actor are free text from a tool a stranger can write to: control, format and bidi
 * characters are STRIPPED here (a title made only of them becomes empty and the event is dropped).
 */
async function toNotice(f: NoticeFields): Promise<Notice | null> {
  const clean: NoticeFields = { ...f, title: stripUnsafeText(f.title), actor: stripUnsafeText(f.actor) }
  return noticeFieldsProblem(clean) === null ? buildNotice(clean) : null
}

/**
 * GitHub `pull_request` / `issues` / `issue_comment` deliveries.
 * PR version is the head sha (a new push is a new version); issue and comment versions are
 * the item's updated_at, since GitHub has no content revision for them.
 */
export async function githubNotice(src: NoticeSource, eventName: string, payload: unknown): Promise<Notice | null> {
  const p = rec(payload)
  const action = text(p, 'action')
  if (!p || !action || !GITHUB_ACTIONS[eventName]?.has(action)) return null
  const actor = text(rec(p.sender), 'login')
  if (!actor) return null

  let kind: NoticeKind
  let item: Rec | null
  if (eventName === 'pull_request') {
    kind = 'pr'
    item = rec(p.pull_request)
  } else if (eventName === 'issues') {
    kind = 'issue'
    item = rec(p.issue)
  } else if (eventName === 'issue_comment') {
    kind = 'comment'
    item = rec(p.comment)
  } else {
    return null
  }
  if (!item) return null

  const itemId = text(item, 'node_id')
  const url = text(item, 'html_url')
  const updatedAt = isoOrNull(text(item, 'updated_at'))
  if (!itemId || !url || !updatedAt) return null

  // A comment's title is its parent issue's title: the Notice points at the thread, not the text.
  const title = kind === 'comment' ? text(rec(p.issue), 'title') : text(item, 'title')
  if (!title) return null

  const version = kind === 'pr' ? text(rec(item.head), 'sha') : updatedAt
  if (!version) return null

  // Lifecycle as GitHub reports it. A merged PR is `closed` with `merged: true`. A comment takes its thread's state.
  const stateOwner = kind === 'comment' ? rec(p.issue) : item
  let state: NoticeState = stateOwner?.state === 'closed' || action === 'closed' ? 'closed' : 'open'
  if (kind === 'pr' && item.merged === true) state = 'merged'

  return toNotice({
    tenant: src.tenant,
    connection: src.connection,
    provider: 'github',
    item_id: itemId,
    event_id: src.eventId,
    version,
    kind,
    state,
    url,
    title,
    actor,
    updated_at: updatedAt,
  })
}

/**
 * Linear webhook deliveries for `Issue` and `Comment` entities.
 * Version is the entity's updatedAt: Linear exposes no content revision.
 */
export async function linearNotice(src: NoticeSource, payload: unknown): Promise<Notice | null> {
  const p = rec(payload)
  const type = text(p, 'type')
  const action = text(p, 'action')
  if (!p || !action || (action !== 'create' && action !== 'update')) return null
  const data = rec(p.data)
  if (!data) return null

  let kind: NoticeKind
  if (type === 'Issue') kind = 'issue'
  else if (type === 'Comment') kind = 'comment'
  else return null

  const itemId = text(data, 'id')
  const updatedAt = isoOrNull(text(data, 'updatedAt'))
  const url = text(p, 'url') ?? text(data, 'url')
  const actor = text(rec(p.actor), 'name')
  // An issue carries its own title. A Linear Comment payload carries `issueId` (and sometimes a nested
  // `issue`), not the parent's title; the Notice points at the thread, so fall back to naming it by id.
  let title: string | null
  if (kind === 'comment') {
    const issueId = text(data, 'issueId') ?? text(rec(data.issue), 'id')
    title = issueId ? (text(rec(data.issue), 'title') ?? `Comment on issue ${issueId}`) : null
  } else {
    title = text(data, 'title')
  }
  if (!itemId || !updatedAt || !url || !actor || !title) return null

  return toNotice({
    tenant: src.tenant,
    connection: src.connection,
    provider: 'linear',
    item_id: itemId,
    event_id: src.eventId,
    version: updatedAt,
    kind,
    // Linear workflow state types: completed and canceled are closed; everything else is open.
    state: ['completed', 'canceled'].includes(text(rec(data.state), 'type') ?? '') ? 'closed' : 'open',
    url,
    title,
    actor,
    updated_at: updatedAt,
  })
}
