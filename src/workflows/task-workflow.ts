// mupot — CF Workflows adapter (issue #7).
//
// This is deliberately a thin glue file.  ALL pipeline logic lives in
// pipeline.ts (no cloudflare:workers import there, so it is fully testable with
// Vitest).  This file imports 'cloudflare:workers' and delegates immediately.
//
// It is intentionally not covered by unit tests — the runtime is
// local-dev-unconfirmed for waitForEvent resume behaviour, so we mock the step
// seam in tests instead (see tests/workflow-pipeline.test.ts).

import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import type { Env } from '../types'
import { runTaskPipeline } from './pipeline'
import { runNightlyBackup } from '../backup/nightly'
import type { BackupParams, BackupStep } from '../backup/nightly'
import type { TaskPipelineParams } from './pipeline'

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskPipelineParams> {
  async run(
    event: Readonly<WorkflowEvent<TaskPipelineParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    // WorkflowStep (cloudflare:workers) satisfies StepLike: its do() and
    // waitForEvent() overloads are compatible.  The return type of waitForEvent
    // is WorkflowStepEvent<T> = { payload: T; timestamp: Date; type: string }
    // which is structurally assignable to { payload: T } (StepLike.waitForEvent).
    // We delegate entirely; the pipeline ignores the event payload and re-reads
    // D1 for the authoritative verdict.
    return runTaskPipeline(
      this.env,
      event.payload,
      step as unknown as import('./pipeline').StepLike, // CF runtime satisfies the seam; see StepLike jsdoc
      event.instanceId,
    )
  }
}

// Nightly D1 -> R2 backup (src/backup/nightly.ts holds ALL the logic and is unit-tested). It lives in THIS file, not its own, on
// purpose: ~8 existing tests vi.mock('../src/workflows/task-workflow') because 'cloudflare:workers' cannot load under Node, and a
// second module importing it would break every one of them. Class name must match [[workflows]] class_name = "BackupWorkflow".
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: Readonly<WorkflowEvent<BackupParams>>, step: WorkflowStep): Promise<unknown> {
    // as: WorkflowStep satisfies the BackupStep seam (do/sleep overloads); the seam omits the Rpc serialisability generics.
    const outcome = await runNightlyBackup(this.env, event.payload, step as unknown as BackupStep)
    // The alert and the backup_runs row are already written; throwing makes the instance show as errored in the dashboard.
    if (outcome.status === 'failed') throw new Error(`nightly backup failed: ${outcome.error ?? 'unknown'}`)
    return outcome
  }
}
