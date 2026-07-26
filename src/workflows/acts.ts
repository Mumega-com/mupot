// mupot — gated workflow acts (Port 5 outbound half).
//
// Iron doctrine (mirrors src/integrations/ghl.ts outbound_acts):
//   1. Agents NEVER hold webhook secrets. Auth headers live in Worker secrets.
//   2. An act fires ONLY after an approved gate verdict. runApprovedWorkflowActs()
//      re-reads task_verdicts independently of the caller.
//   3. Fails closed. Missing webhook config → 'not_configured', acts stay pending.
//   4. On success: write a workflow_receipts row (evidence) + link receipt_id.

import type { Env } from '../types'
import { getWorkflowAdapter, type WorkflowAdapterDeps } from './adapters'
import {
  isWorkflowAdapterKind,
  type WorkflowActPayload,
  type WorkflowAdapterKind,
} from './port'

export interface WorkflowActRunResult {
  ok: boolean
  reason?: string
  sent: number
  refused: number
  failed: number
  receipts: string[]
}

export interface WorkflowActsDeps extends WorkflowAdapterDeps {
  readLatestVerdict?: (
    env: Env,
    taskId: string,
  ) => Promise<{ id: string; verdict: string } | null>
  writeReceipt?: (
    env: Env,
    row: {
      instanceId: string
      taskId: string
      stepName: string
      status: string
      detail?: string
      projectId?: string | null
    },
  ) => Promise<string>
  nowIso?: () => string
}

async function readLatestVerdictFromD1(
  env: Env,
  taskId: string,
): Promise<{ id: string; verdict: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, verdict FROM task_verdicts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<{ id: string; verdict: string }>()
  return row ?? null
}

async function writeWorkflowReceipt(
  env: Env,
  row: {
    instanceId: string
    taskId: string
    stepName: string
    status: string
    detail?: string
    projectId?: string | null
  },
): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  // Prefer project_id from the task so evidence projections pick the receipt up.
  let projectId = row.projectId ?? null
  if (projectId === null) {
    const task = await env.DB.prepare(`SELECT project_id FROM tasks WHERE id = ? LIMIT 1`)
      .bind(row.taskId)
      .first<{ project_id: string | null }>()
    projectId = task?.project_id ?? null
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_receipts
       (id, instance_id, task_id, step_name, status, detail, created_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      row.instanceId,
      row.taskId,
      row.stepName,
      row.status,
      row.detail ?? null,
      now,
      projectId,
    )
    .run()
  return id
}

function parsePayload(raw: string): WorkflowActPayload {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const rec = parsed as Record<string, unknown>
    const out: WorkflowActPayload = {}
    if (typeof rec.webhook_url === 'string') out.webhook_url = rec.webhook_url
    if (typeof rec.label === 'string') out.label = rec.label
    if (rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body)) {
      out.body = rec.body as Record<string, unknown>
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Queue a pending workflow act for a gated task. Validates adapter; payload is
 * stored as JSON (no secrets). Returns the new act id.
 */
export async function createWorkflowAct(
  env: Env,
  taskId: string,
  adapter: WorkflowAdapterKind,
  payload: WorkflowActPayload,
): Promise<{ id: string }> {
  if (!isWorkflowAdapterKind(adapter)) {
    throw Object.assign(new Error(`unknown_workflow_adapter: ${String(adapter)}`), {
      code: 'unknown_workflow_adapter',
    })
  }
  if (adapter === 'cf') {
    throw Object.assign(new Error('cf_adapter_not_queued'), {
      code: 'cf_adapter_not_queued',
      detail: 'use POST /api/tasks/:id/pipeline for the CF default adapter',
    })
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO workflow_acts (id, task_id, adapter, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, taskId, adapter, JSON.stringify(payload), now)
    .run()
  return { id }
}

/**
 * The ONLY path that fires external workflow adapters (n8n / zapier / make).
 * Re-checks the latest verdict independently (defense in depth).
 */
export async function runApprovedWorkflowActs(
  env: Env,
  taskId: string,
  deps: WorkflowActsDeps = {},
): Promise<WorkflowActRunResult> {
  const doReadVerdict = deps.readLatestVerdict ?? readLatestVerdictFromD1
  const doWriteReceipt = deps.writeReceipt ?? writeWorkflowReceipt
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())

  const verdictRow = await doReadVerdict(env, taskId)
  if (!verdictRow || verdictRow.verdict !== 'approved') {
    const pending = await env.DB.prepare(
      `SELECT id FROM workflow_acts WHERE task_id = ? AND status = 'pending'`,
    )
      .bind(taskId)
      .all<{ id: string }>()
    const ids = pending.results ?? []
    for (const act of ids) {
      await env.DB.prepare(
        `UPDATE workflow_acts SET status = 'refused', detail = ? WHERE id = ?`,
      )
        .bind('gate_not_approved', act.id)
        .run()
    }
    return { ok: false, reason: 'gate_not_approved', sent: 0, refused: ids.length, failed: 0, receipts: [] }
  }

  const pendingActs = await env.DB.prepare(
    `SELECT id, adapter, payload FROM workflow_acts WHERE task_id = ? AND status = 'pending'`,
  )
    .bind(taskId)
    .all<{ id: string; adapter: string; payload: string }>()

  const acts = pendingActs.results ?? []
  let sent = 0
  let failed = 0
  const receipts: string[] = []

  for (const row of acts) {
    if (!isWorkflowAdapterKind(row.adapter) || row.adapter === 'cf') {
      await env.DB.prepare(
        `UPDATE workflow_acts SET status = 'failed', detail = ? WHERE id = ?`,
      )
        .bind('invalid_adapter', row.id)
        .run()
      failed++
      continue
    }

    // Claim: pending → sending (atomic). Skip if another runner won the race.
    const claim = await env.DB.prepare(
      `UPDATE workflow_acts SET status = 'sending' WHERE id = ? AND status = 'pending'`,
    )
      .bind(row.id)
      .run()
    if ((claim.meta?.changes ?? 0) === 0) continue

    const adapter = getWorkflowAdapter(row.adapter)
    const payload = parsePayload(row.payload)
    const result = await adapter.run(
      env,
      { taskId, actId: row.id, adapter: row.adapter, payload },
      deps,
    )

    if (result.status === 'not_configured') {
      // Leave re-queueable: roll back to pending so an operator can set the webhook.
      await env.DB.prepare(
        `UPDATE workflow_acts SET status = 'pending', detail = ? WHERE id = ?`,
      )
        .bind(result.detail, row.id)
        .run()
      return {
        ok: false,
        reason: 'not_configured',
        sent,
        refused: 0,
        failed,
        receipts,
      }
    }

    if (!result.ok) {
      await env.DB.prepare(
        `UPDATE workflow_acts SET status = 'failed', detail = ? WHERE id = ?`,
      )
        .bind(result.detail, row.id)
        .run()
      failed++
      continue
    }

    const receiptDetail = JSON.stringify({
      adapter: row.adapter,
      detail: result.detail,
      external_ref: result.externalRef ?? null,
      label: payload.label ?? null,
    })
    const receiptId = await doWriteReceipt(env, {
      instanceId: row.id,
      taskId,
      stepName: 'adapter-run',
      status: 'ok',
      detail: receiptDetail,
    })

    await env.DB.prepare(
      `UPDATE workflow_acts
         SET status = 'sent', verdict_id = ?, receipt_id = ?, detail = ?, sent_at = ?
       WHERE id = ?`,
    )
      .bind(verdictRow.id, receiptId, result.detail, nowIso(), row.id)
      .run()

    receipts.push(receiptId)
    sent++
  }

  return {
    ok: failed === 0 && sent > 0,
    reason: sent === 0 && failed === 0 ? 'no_pending_acts' : undefined,
    sent,
    refused: 0,
    failed,
    receipts,
  }
}
