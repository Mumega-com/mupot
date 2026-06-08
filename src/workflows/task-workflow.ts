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
