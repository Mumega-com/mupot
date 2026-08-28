// src/tasks/report-result.ts — External Runtime & Bound-Seat Task Result Reporting (FLIGHT A2A-01 / #1183).
//
// WHY THIS EXISTS
//
// Issue #1183: tasks.result is written by internal AgentDO execute-mode cortex cycle (finishTask),
// but external runtimes (Hadi-Grok on Mac, Codex CLI, Cursor Cloud) that receive dispatches via
// inbox/fleet-bridge had NO public API/MCP tool to report verifiable completion evidence into `result`.
//
// This module provides the authoritative reportTaskResult implementation for both MCP tool
// (`task_report_result`) and HTTP route (`POST /api/tasks/:id/result`).

import type { Env, AuthContext, Task } from '../types'
import { getTask, isSelfGatedConflict } from '../tasks/service'
import { verifyTaskArtifactShape, type ArtifactVerification } from './artifact-verification'
import { canOnSquad, isOrgAdmin, resolveCapabilities } from '../auth/capability'

export interface ReportTaskResultInput {
  taskId: string
  result: string
  /**
   * Optional status transition to perform atomically with result reporting.
   * Allowed: 'in_progress' | 'review' | 'done' (subject to standard transition and gate rules).
   */
  status?: 'in_progress' | 'review' | 'done'
  /**
   * Optional gate_owner string (e.g. 'gate:hadi-grok') if entering review.
   */
  gateOwner?: string | null
}

export interface ReportTaskResultOutput {
  ok: true
  task: Task
  artifact: ArtifactVerification
}

export class TaskReportResultError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'TaskReportResultError'
  }
}

/**
 * Report a verifiable execution result and artifact claim onto a task from an external runtime or operator.
 */
export async function reportTaskResult(
  env: Env,
  auth: AuthContext,
  input: ReportTaskResultInput,
): Promise<ReportTaskResultOutput> {
  const taskId = input.taskId.trim()
  if (!taskId) {
    throw new TaskReportResultError('invalid_args', 'taskId is required', 400)
  }

  const rawResult = input.result.trim()
  if (!rawResult) {
    throw new TaskReportResultError('invalid_result', 'result must be a non-empty string', 400)
  }

  const taskRes = await getTask(env, taskId)
  if (!taskRes.ok) {
    throw new TaskReportResultError('task_not_found', 'task not found', 404)
  }
  const task = taskRes.task

  // RBAC check: member+ on the task's squad or org admin
  let authorized = isOrgAdmin(auth)
  if (!authorized && auth.memberId) {
    const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
    authorized = await canOnSquad(env, grants, task.squad_id, 'member')
  }

  if (!authorized) {
    throw new TaskReportResultError('forbidden', 'caller lacks member capability on task squad', 403, {
      need: 'member',
      squad: task.squad_id,
    })
  }

  // Verification check of artifact shape (Artifact: <path> + SHA256: <64-hex>)
  const verification = verifyTaskArtifactShape(rawResult)
  if (!verification.verified) {
    throw new TaskReportResultError(
      'artifact_verification_failed',
      `result must contain valid Artifact: <path> and SHA256: <64-hex> (reason: ${verification.reason})`,
      409,
      {
        reason: verification.reason,
        ...(verification.path ? { path: verification.path } : {}),
      },
    )
  }

  const now = new Date().toISOString()
  let nextStatus = task.status
  let completedAt = task.completed_at
  let gateOwner = task.gate_owner

  if (input.gateOwner !== undefined) {
    gateOwner = input.gateOwner ? input.gateOwner.trim() : null
  }

  // Self-Gate Deadlock Prevention (Issue #1030 / FLIGHT EXEC-02)
  if (await isSelfGatedConflict(env, gateOwner, task.assignee_agent_id)) {
    throw new TaskReportResultError('self_gate_conflict', 'gate_owner cannot be the task assignee; self-approval is forbidden and causes deadlock', 409)
  }

  if (input.status) {
    if (input.status === 'review') {
      if (!gateOwner) {
        throw new TaskReportResultError('gate_required_for_review', 'entering review requires a gate_owner', 409)
      }
      nextStatus = 'review'
    } else if (input.status === 'done') {
      if (gateOwner) {
        throw new TaskReportResultError('gate_open', 'gated task must be approved via verdict before it can be marked done', 409)
      }
      nextStatus = 'done'
      completedAt = now
    } else if (input.status === 'in_progress') {
      nextStatus = 'in_progress'
    }
  }

  // Update DB row
  const updateRes = await env.DB.prepare(
    `UPDATE tasks
        SET result = ?1,
            status = ?2,
            gate_owner = ?3,
            completed_at = ?4,
            updated_at = ?5
      WHERE id = ?6`,
  )
    .bind(rawResult, nextStatus, gateOwner, completedAt, now, task.id)
    .run()

  if (!updateRes.meta?.changes) {
    throw new TaskReportResultError('update_failed', 'failed to update task row', 500)
  }

  const updatedTask: Task = {
    ...task,
    result: rawResult,
    status: nextStatus,
    gate_owner: gateOwner,
    completed_at: completedAt,
    updated_at: now,
  }

  return {
    ok: true,
    task: updatedTask,
    artifact: verification,
  }
}
