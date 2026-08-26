// tests/agent-routines-scheduler.test.ts — Unit tests for Autonomous Agent Cron Routine Scheduler (Flight 9).

import { describe, expect, it, vi } from 'vitest'
import { evaluateAndDispatchDueRoutines } from '../src/routines/cron-scheduler'

describe('Autonomous Agent Cron Routine Scheduler (Flight 9)', () => {
  it('evaluates due routines and dispatches autonomous tasks and runs', async () => {
    const mockRoutine = {
      id: 'routine_claim_audit',
      tenant: 'gaf',
      project_id: 'proj_gaf',
      name: 'Daily Warranty Claim Audit',
      objective: 'Audit all pending warranty claims in Supabase and flag anomalies.',
      status: 'enabled',
      trigger_kind: 'cron',
      cron_expression: '0 8 * * *',
      timezone: 'UTC',
      overlap_policy: 'skip',
      execution_mode: 'autonomous',
      responsible_squad_id: 'squad_claims',
      preferred_agent_id: 'agent_auditor',
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      occurrence_count: 5,
      max_occurrences: null,
      stop_at: null,
    }

    const mockBusSend = vi.fn().mockResolvedValue(undefined)

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: {
        send: mockBusSend,
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: any[]) => ({
            all: vi.fn().mockResolvedValue({ results: [mockRoutine] }),
            first: vi.fn().mockResolvedValue(null), // No existing run
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          })),
        })),
      },
    }

    const summary = await evaluateAndDispatchDueRoutines(mockEnv as any, Date.now())

    expect(summary.checked).toBe(1)
    expect(summary.dispatched).toBe(1)
    expect(summary.skipped).toBe(0)
    expect(summary.errors.length).toBe(0)
    expect(mockBusSend).toHaveBeenCalledTimes(1)
  })

  it('skips duplicate runs if occurrence key already exists', async () => {
    const mockRoutine = {
      id: 'routine_claim_audit',
      tenant: 'gaf',
      project_id: 'proj_gaf',
      name: 'Daily Warranty Claim Audit',
      objective: 'Audit claims',
      status: 'enabled',
      trigger_kind: 'cron',
      cron_expression: '0 8 * * *',
      timezone: 'UTC',
      overlap_policy: 'skip',
      execution_mode: 'autonomous',
      responsible_squad_id: 'squad_claims',
      preferred_agent_id: 'agent_auditor',
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      occurrence_count: 5,
      max_occurrences: null,
      stop_at: null,
    }

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: {
        send: vi.fn().mockResolvedValue(undefined),
      },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: any[]) => ({
            all: vi.fn().mockResolvedValue({ results: [mockRoutine] }),
            first: vi.fn().mockResolvedValue({ id: 'existing_run_123' }), // Existing run found
            run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
          })),
        })),
      },
    }

    const summary = await evaluateAndDispatchDueRoutines(mockEnv as any, Date.now())

    expect(summary.checked).toBe(1)
    expect(summary.dispatched).toBe(0)
    expect(summary.skipped).toBe(1)
  })
})
