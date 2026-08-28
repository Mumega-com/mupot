// tests/flight-run-sheets.test.ts — Unit tests for Declarative Run Sheets & Preflight Gates (FLIGHT-10 / Issue #1234).

import { describe, expect, it } from 'vitest'
import {
  validateRunSheet,
  getExecutableStages,
  computeArtifactSha256,
  RUN_SHEET_SCHEMA_V1,
  type RunSheetV1,
} from '../src/flight/run-sheets'
import { preflightCheck, readinessScore, type FlightSignals } from '../src/flight/preflight'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-run-sheets'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    harness,
  }
}

function auth(
  memberId: string,
  boundAgentId: string | null = null,
): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }],
    boundAgentId,
  }
}

describe('Declarative Run Sheets (src/flight/run-sheets.ts)', () => {
  it('validates a well-formed multi-stage run sheet graph', () => {
    const validSheet: RunSheetV1 = {
      schema: RUN_SHEET_SCHEMA_V1,
      goalId: 'flight-10-run-sheets',
      title: 'FLIGHT-10 Multi-Seat Run Sheet Engine',
      objectiveId: 'obj-run-sheets-1234',
      squadIds: ['squad-core', '813ca010-87db-43ff-8422-bada52f255f9'],
      stages: [
        {
          id: 'stage-1-dispatch',
          name: 'Stage 1: Dispatch & Clearance',
          type: 'dispatch',
          assigneeAgentId: 'loom',
          targetSeat: 'loom-hetzner',
          squadId: '813ca010-87db-43ff-8422-bada52f255f9',
          dependsOn: [],
          status: 'completed',
        },
        {
          id: 'stage-2-execute',
          name: 'Stage 2: Implementation & Tests',
          type: 'execute',
          assigneeAgentId: 'river',
          targetSeat: 'river-cursor',
          squadId: 'squad-core',
          dependsOn: ['stage-1-dispatch'],
          status: 'pending',
          artifacts: [
            {
              path: 'src/flight/run-sheets.ts',
              required: true,
            },
          ],
        },
        {
          id: 'stage-3-gate',
          name: 'Stage 3: Athena Adversarial Gate Pass',
          type: 'gate_review',
          assigneeAgentId: 'athena',
          squadId: 'squad-core',
          dependsOn: ['stage-2-execute'],
          status: 'pending',
          gate: {
            gateOwner: 'gate:athena',
            independentOnly: true,
          },
        },
        {
          id: 'stage-4-land',
          name: 'Stage 4: Flight Landing & Receipt Hashing',
          type: 'land',
          assigneeAgentId: 'kasra',
          squadId: 'squad-core',
          dependsOn: ['stage-3-gate'],
          status: 'pending',
        },
      ],
      createdAt: new Date().toISOString(),
    }

    const validation = validateRunSheet(validSheet)
    expect(validation.ok).toBe(true)
    if (validation.ok) {
      expect(validation.runSheet.stages).toHaveLength(4)
      const executable = getExecutableStages(validation.runSheet)
      expect(executable).toHaveLength(1)
      expect(executable[0].id).toBe('stage-2-execute')
    }
  })

  it('rejects circular dependency cycles in stage definitions', () => {
    const cyclicSheet = {
      schema: RUN_SHEET_SCHEMA_V1,
      goalId: 'cyclic-test',
      title: 'Cyclic Run Sheet',
      objectiveId: 'obj-cyclic',
      squadIds: ['squad-core'],
      stages: [
        {
          id: 'stage-a',
          name: 'Stage A',
          type: 'execute',
          squadId: 'squad-core',
          dependsOn: ['stage-b'],
          status: 'pending',
        },
        {
          id: 'stage-b',
          name: 'Stage B',
          type: 'execute',
          squadId: 'squad-core',
          dependsOn: ['stage-a'],
          status: 'pending',
        },
      ],
    }

    const validation = validateRunSheet(cyclicSheet)
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.errors.some((e) => e.message.includes('Cycle detected'))).toBe(true)
    }
  })

  it('computes deterministic SHA-256 for artifacts', async () => {
    const artifactText = 'MUPOT FLIGHT 10 RECEIPT CONTENT'
    const sha256 = await computeArtifactSha256(artifactText)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256).toBe(await computeArtifactSha256(artifactText))
  })
})

describe('Preflight Context Headroom & Token Margins (FLIGHT-10 / Issue #880)', () => {
  const baseSignals: FlightSignals = {
    contextComplete: true,
    toolsReachable: true,
    budgetRemainingMicroUsd: 1_000_000,
    budgetEstimateMicroUsd: 10_000,
    recentProgress: 0.9,
    progressPerStep: 0.8,
    wastePerStep: 0.1,
    stepSeconds: 30,
    contextPercent: 45, // Healthy <70%
    tokenRemaining: 500_000,
    tokenEstimate: 50_000,
  }

  it('passes preflight check when context is < 70% and tokens are sufficient', () => {
    const res = preflightCheck(baseSignals)
    expect(res.go).toBe(true)
    expect(res.checks.contextHeadroom).toBe(true)
    expect(res.checks.tokenMarginSufficient).toBe(true)
    expect(res.reasons).toEqual([])
  })

  it('fails preflight check with context_exceeds_headroom_limit when context is > 70%', () => {
    const bloatedSignals: FlightSignals = {
      ...baseSignals,
      contextPercent: 82, // Exceeds 70% ceiling
    }

    const res = preflightCheck(bloatedSignals)
    expect(res.go).toBe(false)
    expect(res.checks.contextHeadroom).toBe(false)
    expect(res.reasons).toContain('context_exceeds_headroom_limit')
  })

  it('fails preflight check when token remaining is less than estimated need', () => {
    const lowTokenSignals: FlightSignals = {
      ...baseSignals,
      tokenRemaining: 5_000,
      tokenEstimate: 50_000,
    }

    const res = preflightCheck(lowTokenSignals)
    expect(res.go).toBe(false)
    expect(res.checks.tokenMarginSufficient).toBe(false)
    expect(res.reasons).toContain('insufficient_token_margin')
  })
})

describe('Flight Spine MCP Tools (run_sheet_validate & run_sheet_artifact_hash)', () => {
  it('validates run sheet via MCP tool run_sheet_validate', async () => {
    const { env } = makeDb()
    const caller = auth('mem-operator')

    const out = await invokeTool(
      caller,
      env,
      'run_sheet_validate',
      {
        run_sheet: {
          schema: RUN_SHEET_SCHEMA_V1,
          goalId: 'mcp-run-sheet-goal',
          title: 'MCP Run Sheet Validation',
          objectiveId: 'obj-mcp',
          squadIds: ['squad-core'],
          stages: [
            {
              id: 'stg-1',
              name: 'First Stage',
              type: 'dispatch',
              squadId: 'squad-core',
              dependsOn: [],
              status: 'pending',
            },
          ],
        },
      },
      ORIGIN,
    )

    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result).toMatchObject({
        valid: true,
        goalId: 'mcp-run-sheet-goal',
        stagesCount: 1,
        nextExecutableStages: [{ id: 'stg-1', name: 'First Stage', type: 'dispatch' }],
      })
    }
  })

  it('computes artifact hash via MCP tool run_sheet_artifact_hash', async () => {
    const { env } = makeDb()
    const caller = auth('mem-operator')

    const out = await invokeTool(
      caller,
      env,
      'run_sheet_artifact_hash',
      {
        content: 'CANARY RECEIPT DATA LINE',
      },
      ORIGIN,
    )

    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.result as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
      expect((out.result as { byteLength: number }).byteLength).toBe(24)
    }
  })
})
