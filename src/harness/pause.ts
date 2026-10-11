// src/harness/pause.ts — execution-pause fence for harness dispatch (loop brake #2, mupot#1780/#1811).
//
// A harness dispatch is a mupot-mediated START of work, so it must honour an active execution pause on the agent
// (or its current squad) BEFORE any side effect: before the reservation INSERT, and again after the attach lease
// is claimed (a pause may land between reserve and attach) and before any vendor call.

import type { Env } from '../types'
import { EXECUTION_PAUSED_ERROR, isExecutionPaused } from '../agents/execution-brake-sql'

export class ExecutionPausedError extends Error {
  constructor() {
    super(EXECUTION_PAUSED_ERROR)
    this.name = 'ExecutionPausedError'
  }
}

export async function assertExecutionNotPaused(env: Env, agentId: string): Promise<void> {
  if (await isExecutionPaused(env, agentId)) throw new ExecutionPausedError()
}
