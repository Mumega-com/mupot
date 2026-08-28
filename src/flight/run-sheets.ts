// src/flight/run-sheets.ts — Declarative Run Sheets & Multi-Seat Flight Execution Graph.
//
// Defines structured execution run sheets for coordinating heterogeneous agent flights
// (river-cursor, loom-hetzner, kasra, dara) across stages, dependencies, gate checks,
// and artifact verification with cryptographic receipt assurance.

export const RUN_SHEET_SCHEMA_V1 = 'mupot.flight.run_sheet/v1' as const

export type RunSheetStageType = 'dispatch' | 'execute' | 'gate_review' | 'verify' | 'land'
export type RunSheetStageStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped'

export interface RunSheetArtifactExpectation {
  path: string
  sha256?: string
  description?: string
  required: boolean
}

export interface RunSheetGateRequirement {
  gateOwner: string // e.g. "gate:athena", "gate:hadi-grok", "gate:kasra"
  independentOnly: boolean // Author != Gate required
  minVerdictsRequired?: number
}

export interface RunSheetTelemetryCriteria {
  maxContextPercent?: number // default 70%
  minTokenRemaining?: number
  maxStepSeconds?: number
}

export interface RunSheetStage {
  id: string
  name: string
  type: RunSheetStageType
  assigneeAgentId?: string | null
  targetSeat?: string | null // e.g. "river-cursor", "loom-hetzner"
  squadId: string
  dependsOn: string[] // IDs of stages that must complete before this stage starts
  status: RunSheetStageStatus
  instructions?: string
  artifacts?: RunSheetArtifactExpectation[]
  gate?: RunSheetGateRequirement
  telemetry?: RunSheetTelemetryCriteria
  completedAt?: string | null
  resultArtifactPath?: string | null
  resultSha256?: string | null
}

export interface RunSheetV1 {
  schema: typeof RUN_SHEET_SCHEMA_V1
  flightId?: string
  goalId: string
  title: string
  objectiveId: string
  squadIds: string[]
  stages: RunSheetStage[]
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface RunSheetValidationError {
  field: string
  message: string
}

export type RunSheetValidationResult =
  | { ok: true; runSheet: RunSheetV1 }
  | { ok: false; errors: RunSheetValidationError[] }

/**
 * Validates a declarative run sheet object against schema invariants and graph acyclicity.
 */
export function validateRunSheet(input: unknown): RunSheetValidationResult {
  const errors: RunSheetValidationError[] = []

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'root', message: 'Run sheet must be a non-null object' }] }
  }

  const raw = input as Record<string, unknown>

  if (raw.schema !== RUN_SHEET_SCHEMA_V1) {
    errors.push({ field: 'schema', message: `Schema must be '${RUN_SHEET_SCHEMA_V1}'` })
  }

  if (typeof raw.goalId !== 'string' || !raw.goalId.trim()) {
    errors.push({ field: 'goalId', message: 'goalId is required' })
  }

  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    errors.push({ field: 'title', message: 'title is required' })
  }

  if (typeof raw.objectiveId !== 'string' || !raw.objectiveId.trim()) {
    errors.push({ field: 'objectiveId', message: 'objectiveId is required' })
  }

  if (!Array.isArray(raw.squadIds) || raw.squadIds.length === 0 || !raw.squadIds.every((s) => typeof s === 'string' && s.trim())) {
    errors.push({ field: 'squadIds', message: 'squadIds must be a non-empty array of squad IDs' })
  }

  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    errors.push({ field: 'stages', message: 'stages must be a non-empty array of stage definitions' })
    return { ok: false, errors }
  }

  const stageIds = new Set<string>()
  const stageMap = new Map<string, RunSheetStage>()

  for (let i = 0; i < raw.stages.length; i++) {
    const s = raw.stages[i]
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push({ field: `stages[${i}]`, message: 'Stage definition must be an object' })
      continue
    }

    const stage = s as Partial<RunSheetStage>
    if (!stage.id || typeof stage.id !== 'string' || !stage.id.trim()) {
      errors.push({ field: `stages[${i}].id`, message: 'Stage id is required' })
      continue
    }

    if (stageIds.has(stage.id)) {
      errors.push({ field: `stages[${i}].id`, message: `Duplicate stage id '${stage.id}'` })
    }
    stageIds.add(stage.id)

    if (!stage.name || typeof stage.name !== 'string') {
      errors.push({ field: `stages[${i}].name`, message: 'Stage name is required' })
    }

    const validTypes: RunSheetStageType[] = ['dispatch', 'execute', 'gate_review', 'verify', 'land']
    if (!stage.type || !validTypes.includes(stage.type)) {
      errors.push({ field: `stages[${i}].type`, message: `Stage type must be one of ${validTypes.join(', ')}` })
    }

    if (!stage.squadId || typeof stage.squadId !== 'string') {
      errors.push({ field: `stages[${i}].squadId`, message: 'squadId is required on stage' })
    }

    if (stage.dependsOn && (!Array.isArray(stage.dependsOn) || !stage.dependsOn.every((d) => typeof d === 'string'))) {
      errors.push({ field: `stages[${i}].dependsOn`, message: 'dependsOn must be an array of stage IDs' })
    }

    stageMap.set(stage.id, {
      id: stage.id,
      name: stage.name || '',
      type: stage.type || 'execute',
      assigneeAgentId: stage.assigneeAgentId ?? null,
      targetSeat: stage.targetSeat ?? null,
      squadId: stage.squadId || '',
      dependsOn: Array.isArray(stage.dependsOn) ? stage.dependsOn : [],
      status: (stage.status as RunSheetStageStatus) || 'pending',
      instructions: stage.instructions,
      artifacts: stage.artifacts,
      gate: stage.gate,
      telemetry: stage.telemetry,
      completedAt: stage.completedAt ?? null,
      resultArtifactPath: stage.resultArtifactPath ?? null,
      resultSha256: stage.resultSha256 ?? null,
    })
  }

  // Check graph dependencies & cycles
  for (const [id, stage] of stageMap.entries()) {
    for (const depId of stage.dependsOn) {
      if (!stageMap.has(depId)) {
        errors.push({ field: `stages[${id}].dependsOn`, message: `Unknown dependency stage '${depId}'` })
      }
    }
  }

  // Cycle detection via DFS
  const visited = new Set<string>()
  const recStack = new Set<string>()

  function hasCycle(currId: string): boolean {
    visited.add(currId)
    recStack.add(currId)

    const stage = stageMap.get(currId)
    if (stage) {
      for (const depId of stage.dependsOn) {
        if (!visited.has(depId)) {
          if (hasCycle(depId)) return true
        } else if (recStack.has(depId)) {
          return true
        }
      }
    }

    recStack.delete(currId)
    return false
  }

  for (const id of stageMap.keys()) {
    if (!visited.has(id)) {
      if (hasCycle(id)) {
        errors.push({ field: 'stages', message: 'Cycle detected in run sheet stage dependencies' })
        break
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    runSheet: {
      schema: RUN_SHEET_SCHEMA_V1,
      flightId: typeof raw.flightId === 'string' ? raw.flightId : undefined,
      goalId: String(raw.goalId).trim(),
      title: String(raw.title).trim(),
      objectiveId: String(raw.objectiveId).trim(),
      squadIds: (raw.squadIds as string[]).map((s) => s.trim()),
      stages: Array.from(stageMap.values()),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      metadata: typeof raw.metadata === 'object' && raw.metadata !== null && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : undefined,
    },
  }
}

/**
 * Evaluates the next runnable stages in a run sheet given current stage statuses.
 */
export function getExecutableStages(runSheet: RunSheetV1): RunSheetStage[] {
  const completedStages = new Set(
    runSheet.stages.filter((s) => s.status === 'completed').map((s) => s.id),
  )

  return runSheet.stages.filter((s) => {
    if (s.status !== 'pending') return false
    return s.dependsOn.every((depId) => completedStages.has(depId))
  })
}

/**
 * Computes deterministic SHA-256 hash of an artifact string or Uint8Array.
 */
export async function computeArtifactSha256(content: string | Uint8Array): Promise<string> {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
