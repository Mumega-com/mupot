// mupot — outbound board write-back dispatcher (S3).
//
// Driven by the existing bus: the consumer calls writebackForBusEvent() on the task events that mark a
// transition (submit -> task.review / task.updated, verdict -> task.verdict). The event is only a doorbell:
// WHAT to write is re-derived from D1 receipts, never from the event payload, so a forged or replayed event
// cannot make mupot claim something its records don't prove.
//
// Guards, in order (each is a test in tests/board-writeback.test.ts):
//   1. BOARD_WRITEBACK === '1' (global, default off)            -> else ZERO reads/writes beyond this check.
//   2. the task is linked to a board item (board_item_links)    -> else skip.
//   3. the binding's meta.writeback === true (per-binding opt-in) -> else skip.
//   4. a receipt exists for the current state:
//        submitted : status 'review' + a task_result_submissions row
//        approved  : status 'approved' + latest task_verdicts row 'approved', unreversed, task gated
//        rejected  : status 'rejected' + latest task_verdicts row 'rejected', unreversed, task gated
//   5. (task, transition receipt, action) is claimed in board_writeback_ledger before the call (idempotent).
//   6. the provider declared the capability (`capabilities.has(...)`). This file never names a provider.
//      A provider without a capability is skipped cleanly.

import type { Env, BusEvent } from '../types'
import { linkForTask, writebackEnabledFromMeta } from './providers/board-links'
import { getProjectBinding } from './providers/bindings'
import { getTaskBoardPort } from './providers/registry'
import type { BoardTaskRef, TaskBoardPort, TransitionReceipt, WritebackResult } from './providers/port'

export type WritebackReport =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'ran'; transition: string; actions: Array<{ action: 'status' | 'comment'; result: 'done' | 'failed' | 'duplicate' | 'unsupported'; detail?: string }> }

const MAX_ATTEMPTS = 5
const PENDING_STALE_MS = 120_000
const WRITEBACK_EVENT_TYPES: ReadonlySet<string> = new Set(['task.review', 'task.updated', 'task.verdict', 'task.completed'])

export function boardWritebackEnabled(env: Env): boolean {
  return env.BOARD_WRITEBACK === '1'
}

interface Derived {
  receipt: TransitionReceipt
  /** receipt-bearing, e.g. submitted:<submission id> */
  key: string
  artifactUrl: string | null
}

interface TaskRow { id: string; status: string; gate_owner: string | null; result: string | null }

const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/

function artifactUrlFrom(path: string | null, result: string | null): string | null {
  if (path && /^https:\/\//.test(path) && path.length <= 500) return path
  const m = result ? PR_URL_RE.exec(result) : null
  return m ? m[0] : null
}

export async function deriveTransition(env: Env, taskId: string): Promise<Derived | null> {
  const task = await env.DB.prepare(`SELECT id, status, gate_owner, result FROM tasks WHERE id = ?1`)
    .bind(taskId)
    .first<TaskRow>()
  if (!task) return null

  if (task.status === 'review') {
    const sub = await env.DB.prepare(
      `SELECT id, artifact_path FROM task_result_submissions WHERE tenant = ?1 AND task_id = ?2 ORDER BY seq DESC LIMIT 1`,
    )
      .bind(env.TENANT_SLUG, taskId)
      .first<{ id: string; artifact_path: string | null }>()
    if (!sub) return null // a review with no submission receipt proves nothing
    return {
      receipt: { kind: 'submitted', receipt_id: sub.id, gate_owner: null },
      key: `submitted:${sub.id}`,
      artifactUrl: artifactUrlFrom(sub.artifact_path, task.result),
    }
  }

  if (task.status === 'approved' || task.status === 'rejected') {
    if (!task.gate_owner) return null // never move a board item on an ungated task's verdict
    const verdict = await env.DB.prepare(
      `SELECT id, verdict, reversed_at FROM task_verdicts WHERE task_id = ?1 ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
    )
      .bind(taskId)
      .first<{ id: string; verdict: string; reversed_at: string | null }>()
    if (!verdict || verdict.reversed_at !== null) return null
    if (verdict.verdict !== task.status) return null // task state and the verdict row must agree
    const kind = verdict.verdict === 'approved' ? 'approved' : 'rejected'
    return {
      receipt: { kind, receipt_id: verdict.id, gate_owner: task.gate_owner },
      key: `${kind}:${verdict.id}`,
      artifactUrl: null,
    }
  }
  return null
}

type Claim = 'claimed' | 'duplicate'

async function claim(env: Env, taskId: string, key: string, action: 'status' | 'comment', provider: string): Promise<Claim> {
  const now = new Date().toISOString()
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO board_writeback_ledger (tenant, task_id, transition_key, action, provider, status, attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 1, ?6, ?6)`,
  )
    .bind(env.TENANT_SLUG, taskId, key, action, provider, now)
    .run()
  if (Number(ins.meta?.changes ?? 0) === 1) return 'claimed'
  const stale = new Date(Date.now() - PENDING_STALE_MS).toISOString()
  const retry = await env.DB.prepare(
    `UPDATE board_writeback_ledger SET status = 'pending', attempts = attempts + 1, updated_at = ?1
      WHERE tenant = ?2 AND task_id = ?3 AND transition_key = ?4 AND action = ?5 AND attempts < ?6
        AND (status = 'failed' OR (status = 'pending' AND updated_at < ?7))`,
  )
    .bind(now, env.TENANT_SLUG, taskId, key, action, MAX_ATTEMPTS, stale)
    .run()
  return Number(retry.meta?.changes ?? 0) === 1 ? 'claimed' : 'duplicate'
}

async function settle(env: Env, taskId: string, key: string, action: 'status' | 'comment', result: WritebackResult): Promise<void> {
  // The detail is an opaque code from the provider layer, never a response body.
  const detail = result.ok ? (result.detail ?? (result.applied ? 'applied' : 'noop')) : result.error
  await env.DB.prepare(
    `UPDATE board_writeback_ledger SET status = ?1, detail = ?2, updated_at = ?3
      WHERE tenant = ?4 AND task_id = ?5 AND transition_key = ?6 AND action = ?7`,
  )
    .bind(result.ok ? 'done' : 'failed', detail.slice(0, 100), new Date().toISOString(), env.TENANT_SLUG, taskId, key, action)
    .run()
}

function commentFor(d: Derived): string {
  const short = d.receipt.receipt_id.slice(0, 8)
  switch (d.receipt.kind) {
    case 'submitted':
      return `mupot: submitted for review (receipt ${short}).`
    case 'approved':
      return `mupot: gate verdict APPROVED by ${d.receipt.gate_owner ?? 'gate'} (receipt ${short}).`
    case 'rejected':
      return `mupot: gate verdict REJECTED by ${d.receipt.gate_owner ?? 'gate'}; back to work (receipt ${short}).`
  }
}

export async function runBoardWriteback(env: Env, taskId: string): Promise<WritebackReport> {
  if (!boardWritebackEnabled(env)) return { outcome: 'skipped', reason: 'flag_off' }

  const link = await linkForTask(env, taskId)
  if (!link) return { outcome: 'skipped', reason: 'no_link' }
  const binding = await getProjectBinding(env, link.project_id, link.provider)
  if (!binding || !writebackEnabledFromMeta(binding.meta_json)) return { outcome: 'skipped', reason: 'binding_not_enabled' }

  const derived = await deriveTransition(env, taskId)
  if (!derived) return { outcome: 'skipped', reason: 'no_receipt' }

  let port: TaskBoardPort
  try {
    port = getTaskBoardPort(env, link.provider)
  } catch {
    return { outcome: 'skipped', reason: 'provider_unavailable' }
  }

  const actions: Array<{ action: 'status' | 'comment'; result: 'done' | 'failed' | 'duplicate' | 'unsupported'; detail?: string }> = []
  const taskRef: BoardTaskRef = { id: taskId, item: link.item }
  let statusOk = true

  if (port.capabilities.has('pushStatus') && port.pushStatus) {
    if ((await claim(env, taskId, derived.key, 'status', link.provider)) === 'duplicate') {
      actions.push({ action: 'status', result: 'duplicate' })
      // A prior refusal (human cancel, wrong team, any unsettled/failed status) stays a refusal on redelivery:
      // only a status row that settled 'done' and was not a human cancel lets the comment path run.
      const prior = await env.DB.prepare(
        `SELECT status, detail FROM board_writeback_ledger WHERE tenant = ?1 AND task_id = ?2 AND transition_key = ?3 AND action = 'status'`,
      )
        .bind(env.TENANT_SLUG, taskId, derived.key)
        .first<{ status: string; detail: string | null }>()
      statusOk = prior !== null && prior.status === 'done' && prior.detail !== 'human_canceled'
    } else {
      const res = await port.pushStatus(binding, taskRef, derived.receipt)
      await settle(env, taskId, derived.key, 'status', res)
      // A human cancel on the board is final: no status move, and no comment either.
      statusOk = res.ok && res.detail !== 'human_canceled'
      actions.push({ action: 'status', result: res.ok ? 'done' : 'failed', detail: res.ok ? res.detail : res.error })
    }
  } else {
    actions.push({ action: 'status', result: 'unsupported' })
  }

  if (statusOk) {
    const canLink = derived.artifactUrl !== null && port.capabilities.has('linkArtifact') && port.linkArtifact
    const canComment = port.capabilities.has('postComment') && port.postComment
    if (canLink || canComment) {
      if ((await claim(env, taskId, derived.key, 'comment', link.provider)) === 'duplicate') {
        actions.push({ action: 'comment', result: 'duplicate' })
      } else {
        let res: WritebackResult
        if (canLink && derived.artifactUrl && port.linkArtifact) res = await port.linkArtifact(binding, link.item, derived.artifactUrl)
        else if (port.postComment) res = await port.postComment(binding, link.item, commentFor(derived))
        else res = { ok: false, error: 'unsupported' }
        await settle(env, taskId, derived.key, 'comment', res)
        actions.push({ action: 'comment', result: res.ok ? 'done' : 'failed', detail: res.ok ? res.detail : res.error })
      }
    } else {
      actions.push({ action: 'comment', result: 'unsupported' })
    }
  }
  return { outcome: 'ran', transition: derived.key, actions }
}

/** Bus hook. Never throws: a write-back problem must not retry or poison the queue message. */
export async function writebackForBusEvent(env: Env, event: BusEvent): Promise<WritebackReport> {
  if (!boardWritebackEnabled(env)) return { outcome: 'skipped', reason: 'flag_off' }
  if (!WRITEBACK_EVENT_TYPES.has(event.type)) return { outcome: 'skipped', reason: 'event_not_a_transition' }
  const taskId = (event.payload as { task_id?: unknown } | null | undefined)?.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) return { outcome: 'skipped', reason: 'no_task' }
  try {
    return await runBoardWriteback(env, taskId)
  } catch {
    return { outcome: 'skipped', reason: 'error' }
  }
}

/** Cron retry: re-drive tasks whose ledger rows failed or were left pending. Bounded; the ledger caps attempts. */
export async function retryFailedWritebacks(env: Env, limit = 5): Promise<number> {
  if (!boardWritebackEnabled(env)) return 0
  const before = new Date(Date.now() - 60_000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT DISTINCT task_id FROM board_writeback_ledger
      WHERE tenant = ?1 AND status <> 'done' AND attempts < ?2 AND updated_at < ?3 LIMIT ?4`,
  )
    .bind(env.TENANT_SLUG, MAX_ATTEMPTS, before, limit)
    .all<{ task_id: string }>()
  let n = 0
  for (const r of rows.results ?? []) {
    try {
      await runBoardWriteback(env, r.task_id)
      n++
    } catch {
      // next tick
    }
  }
  return n
}
