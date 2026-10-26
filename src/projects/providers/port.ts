// mupot — external task-board port for project providers.
//
// Pot-native projects own identity + RBAC. Linear / GitHub Projects / Notion
// implement this port as adapters. They never become columns on `projects`.


import type { Env } from '../../types'
/**
 * A provider is identified by the string it registers under (registry-core.ts). The set is OPEN: a new
 * provider is one file that calls registerBoardProvider(), not an edit to a closed union or a switch.
 */
export type ProjectBoardProvider = string

export interface BoardItem {
  external_id: string
  title: string
  url: string | null
  status: string | null
  assignee_hint: string | null
}

export interface ProjectProviderBinding {
  project_id: string
  provider: ProjectBoardProvider
  external_id: string
  connector_id: string | null
  meta_json: string
  synced_at: string | null
  created_at: string
  updated_at: string
}

export interface TaskBoardListResult {
  ok: true
  items: BoardItem[]
}

export interface TaskBoardSyncResult {
  ok: true
  imported: number
  skipped: number
  // 'no_squad' (Linear): no admin-configured defaultSquadId to route to — distinct
  // from 'no_agent' (GitHub Projects: an item carries no Agent-field value at all).
  items: Array<{
    title: string
    status: 'created' | 'skipped' | 'no_agent' | 'unknown_agent' | 'no_squad' | 'error'
    detail?: string
  }>
}

export interface TaskBoardError {
  ok: false
  error: string
}

/** What a provider can do beyond the read/import baseline. Callers test `capabilities.has(...)`, never a provider name. */
export type BoardCapability = 'pushStatus' | 'postComment' | 'linkArtifact' | 'webhook'

/** A mupot transition and the receipt that proves it. A provider refuses to write status without one. */
export type TransitionKind = 'submitted' | 'approved' | 'rejected'

export interface TransitionReceipt {
  kind: TransitionKind
  /** task_result_submissions.id (submitted) or task_verdicts.id (approved/rejected). */
  receipt_id: string
  /** The gate that produced a verdict. Null for 'submitted'. A verdict receipt without one is refused. */
  gate_owner: string | null
}

/** The provider-side item a task is bound to (board_item_links). */
export interface BoardItemRef {
  /** Provider-stable id (Linear issue uuid). */
  native_id: string
  /** Human handle (Linear identifier). */
  ref: string
}

export interface BoardTaskRef {
  id: string
  item: BoardItemRef
}

export type WritebackResult =
  | { ok: true; applied: boolean; detail?: string }
  | { ok: false; error: string }

/** A provider-normalised inbound event. Only these shapes ever leave a provider's webhook parser. */
export type InboundBoardEvent =
  | { kind: 'item_created'; item: { native_id: string; ref: string; title: string; url: string | null; status: string | null } }
  | { kind: 'item_status_changed'; item: { native_id: string; ref: string; status: string | null }; from_status: string | null }
  | { kind: 'ignored' }

export type WebhookVerification =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: 'not_configured' | 'invalid' | 'stale' }

export interface WebhookOutcome {
  ok: boolean
  imported?: number
  noted?: number
  detail?: string
}

/** Adapter contract: one implementation per provider. Capability methods are present iff declared in `capabilities`. */
export interface TaskBoardPort {
  readonly provider: ProjectBoardProvider
  readonly capabilities: ReadonlySet<BoardCapability>
  listItems(binding: ProjectProviderBinding): Promise<TaskBoardListResult | TaskBoardError>
  syncIntoProject(
    binding: ProjectProviderBinding,
    opts: { project_id: string; dryRun: boolean },
  ): Promise<TaskBoardSyncResult | TaskBoardError>

  /** Move the bound item to the state mapped from `receipt`. Receipt-gated. */
  pushStatus?(binding: ProjectProviderBinding, task: BoardTaskRef, receipt: TransitionReceipt): Promise<WritebackResult>
  postComment?(binding: ProjectProviderBinding, item: BoardItemRef, text: string): Promise<WritebackResult>
  linkArtifact?(binding: ProjectProviderBinding, item: BoardItemRef, url: string): Promise<WritebackResult>

  /** Inbound. verify -> parse run before any binding is read; webhook runs per matched binding. */
  verifyWebhook?(env: Env, rawBody: string, headers: Headers): Promise<WebhookVerification>
  /** Pure parse. `bindingExternalId` selects bindings (Linear: team key). */
  parseWebhook?(rawBody: string): { bindingExternalId: string; event: InboundBoardEvent } | null
  webhook?(binding: ProjectProviderBinding, event: InboundBoardEvent): Promise<WebhookOutcome>
}
