// Shared Cursor Cloud → mupot control-plane write path.
//
// Creates the matching task + flight records after (or instead of) a Cursor
// Cloud agent launch. Used by the MCP tools and POST /api/studio/dispatch.

import type { Env } from '../types'
import { createTask } from '../tasks/service'
import type { Task } from '../types'
import { dispatchFlight } from '../flight/dispatch'
import type { DispatchResult } from '../flight/dispatch'
import type { FlightSignals } from '../flight/preflight'
import { FLIGHT_META_V1_SCHEMA } from '../flight/meta'

export const CURSOR_CLOUD_DONE_WHEN =
  'Cursor Cloud run finishes with a recorded result or pull request'

export const CURSOR_CLOUD_PREFLIGHT_SIGNALS: FlightSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 10_000,
  recentProgress: 0.8,
  progressPerStep: 0.6,
  wastePerStep: 0.1,
  stepSeconds: 60,
}

export interface CursorCloudRecord {
  agentId: string
  runId: string
  agentUrl: string
}

export {
  CURSOR_CLOUD_SEAT,
  CURSOR_CLOUD_HARNESS,
  CURSOR_CLOUD_MODEL,
  CURSOR_CLOUD_EFFORT,
  CURSOR_CLOUD_MACHINE,
  sevenAxisCheckInDeclaration,
  injectSevenAxisSeatDeclaration,
} from './seat-identity'

import { injectSevenAxisSeatDeclaration } from './seat-identity'

export interface RecordCursorCloudWorkInput {
  name: string
  repoUrl: string
  prompt: string
  squadId: string
  agentId: string
  actor?: { kind: 'member' | 'agent'; id: string }
  cursor?: CursorCloudRecord
  /** Reserved flight id so the injected check_in declaration matches the stored flight. */
  flightId?: string
}

export interface RecordCursorCloudWorkResult {
  task: Task
  flight: DispatchResult
}

export async function recordCursorCloudWork(
  env: Env,
  input: RecordCursorCloudWorkInput,
): Promise<RecordCursorCloudWorkResult> {
  const title = input.name.trim()
  const reservedFlightId = input.flightId?.trim() || crypto.randomUUID()
  const prompt = injectSevenAxisSeatDeclaration(input.prompt, reservedFlightId)
  const lines = [
    prompt,
    '',
    `repo: ${input.repoUrl.trim()}`,
  ]
  if (input.cursor) {
    lines.push(
      `cursor_agent: ${input.cursor.agentId}`,
      `cursor_run: ${input.cursor.runId}`,
      `cursor_url: ${input.cursor.agentUrl}`,
    )
  }

  const task = await createTask(
    env,
    {
      squad_id: input.squadId,
      title,
      body: lines.join('\n'),
      done_when: CURSOR_CLOUD_DONE_WHEN,
      assignee_agent_id: input.agentId,
      status: 'in_progress',
    },
    {
      actor: input.actor,
      skipMirror: true,
    },
  )

  const flight = await dispatchFlight(
    env,
    {
      agent: input.agentId,
      goal: title,
      trigger_source: 'api',
      meta: {
        schema: FLIGHT_META_V1_SCHEMA,
        goal_id: `cursor-cloud:${input.cursor?.agentId ?? task.id}`,
        objective_id: task.id,
        squad_ids: [input.squadId],
        task_ids: [task.id],
        done_when: [CURSOR_CLOUD_DONE_WHEN],
        artifact_refs: input.cursor ? [input.cursor.agentUrl] : [],
        receipt_refs: [],
        confidentiality: 'internal',
        publication_target: 'none',
        parent_flight_id: null,
      },
    },
    CURSOR_CLOUD_PREFLIGHT_SIGNALS,
    undefined,
    { id: reservedFlightId },
  )

  return { task, flight }
}
