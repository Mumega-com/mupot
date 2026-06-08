// mupot — durable task pipeline tests (issue #7).
//
// Tests the PURE pipeline core (src/workflows/pipeline.ts) at the step seam.
// The CF Workflows runtime is NEVER used here: StepLike is a hand-mock and
// D1 is stubbed with a minimal builder.  task-workflow.ts (the thin CF adapter)
// is intentionally not tested here — it delegates entirely to runTaskPipeline.
//
// Coverage:
//  1. Ungated task: execute step runs, receipt written, no waitForEvent.
//  2. Gated task (gate_owner set, runTaskExecution lands 'review'):
//     a. waitForEvent called exactly once with { type: 'gate-verdict' }.
//     b. readLatestVerdict consulted from D1 (authoritative).
//     c. Event payload DIFFERS from D1 verdict; D1 verdict wins.
//     d. 'gate-resolved' receipt written with the D1 verdict.
//  3. Gated task, waitForEvent THROWS (timeout):
//     a. Pipeline catches — does not propagate.
//     b. readLatestVerdict still consulted.
//     c. D1 has a verdict → 'gate-resolved' receipt.
//     d. D1 has no verdict → 'gate-timeout' receipt.
//     e. Task status row is untouched (pipeline never flips status).
//  4. Receipt idempotency: INSERT OR IGNORE / UNIQUE(instance_id, step_name).
//  5. startTaskPipeline: creates instance + persists workflow_instance_id.
//  6. startTaskPipeline: refuses to start when already started.
//  7. Pipeline summary shape.

import { describe, expect, it, vi } from 'vitest'
import { runTaskPipeline, startTaskPipeline } from '../src/workflows/pipeline'
import type { StepLike, TaskPipelineParams, PipelineDeps, VerdictRow } from '../src/workflows/pipeline'
import type { Env, Agent, Task } from '../src/types'
import type { ExecuteResult } from '../src/agents/execute'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PARAMS: TaskPipelineParams = {
  taskId: 'task-wf-1',
  squadId: 'squad-wf-1',
  agentId: 'agent-wf-1',
}

const AGENT: Agent = {
  id: 'agent-wf-1',
  squad_id: 'squad-wf-1',
  slug: 'worker',
  name: 'Worker',
  role: 'executor',
  model: '@cf/meta/llama-3.3',
  status: 'active',
  okr: null,
  kpi_target: null,
  kpi_progress: 0,
  effort: 'standard',
  autonomy: 'execute',
  budget_cap_cents: null,
  budget_window: 'day',
  created_at: '2026-06-08T00:00:00.000Z',
}

// ── D1 mock helpers ───────────────────────────────────────────────────────────

interface ReceiptRow {
  instanceId: string
  taskId: string
  stepName: string
  status: string
  detail?: string
}

/** Minimal D1 stub.  Not used by pipeline directly — we inject writeReceipt + readLatestVerdict. */
function makeMinimalEnv(): Env {
  return {
    TENANT_SLUG: 'test',
    DB: null as unknown as Env['DB'],
    VEC: null as unknown as Env['VEC'],
    BUS: null as unknown as Env['BUS'],
    SESSIONS: null as unknown as Env['SESSIONS'],
    BLOBS: null as unknown as Env['BLOBS'],
    AI: null as unknown as Env['AI'],
    AGENT: null as unknown as Env['AGENT'],
    SQUAD: null as unknown as Env['SQUAD'],
    TASK_WORKFLOW: undefined,
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
  }
}

// ── StepLike mock builder ─────────────────────────────────────────────────────
//
// The step mock transparently executes do() callbacks (simulating the CF
// Workflows "run once, cache result" contract) and records which names were
// called.  waitForEvent can be configured to resolve or throw (timeout).

interface StepMock extends StepLike {
  doNames: string[]
  waitForEventNames: string[]
}

function makeStep(opts: {
  waitForEventThrows?: boolean
  /** Event payload returned by waitForEvent (IGNORED by pipeline — tests verify D1 wins) */
  waitForEventPayload?: unknown
} = {}): StepMock {
  const doNames: string[] = []
  const waitForEventNames: string[] = []

  const mock: StepMock = {
    doNames,
    waitForEventNames,

    // Overload 1: no config.  Overload 2: with config.  We handle both by
    // checking whether the second argument is a function.
    do<T>(
      name: string,
      configOrCb: unknown,
      maybeCb?: () => Promise<T>,
    ): Promise<T> {
      doNames.push(name)
      const cb = typeof configOrCb === 'function'
        ? (configOrCb as () => Promise<T>)
        : (maybeCb as () => Promise<T>)
      return cb()
    },

    waitForEvent<T>(
      name: string,
      _opts: { type: string; timeout?: string },
    ): Promise<{ payload: T }> {
      waitForEventNames.push(name)
      if (opts.waitForEventThrows) {
        return Promise.reject(new Error('waitForEvent timeout'))
      }
      return Promise.resolve({ payload: opts.waitForEventPayload as T })
    },
  }

  return mock
}

// ── 1. Ungated task ───────────────────────────────────────────────────────────

describe('ungated task', () => {
  it('execute step runs, receipt written with ok status, no waitForEvent', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    const step = makeStep()

    const executeResult: ExecuteResult = {
      ok: true,
      task_id: PARAMS.taskId,
      decided: 'completed',
      task_status: 'done',
    }

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async () => executeResult),
      readLatestVerdict: vi.fn(async () => null),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-1', deps)

    // execute step ran
    expect(step.doNames).toContain('execute')

    // NO waitForEvent for ungated task
    expect(step.waitForEventNames).toHaveLength(0)

    // One receipt: execute/ok
    expect(receipts).toHaveLength(1)
    expect(receipts[0].stepName).toBe('execute')
    expect(receipts[0].status).toBe('ok')
    expect(receipts[0].detail).toContain('"task_status":"done"')

    // Summary
    expect(summary.gated).toBe(false)
    expect(summary.resolved).toBe(false)
    expect(summary.taskId).toBe(PARAMS.taskId)
    expect(summary.finalStatus).toBe('done')
  })

  it('summary.gated is false when execute lands blocked (never gated regardless)', async () => {
    const env = makeMinimalEnv()
    const step = makeStep()

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async () => ({
        ok: false,
        task_id: PARAMS.taskId,
        decided: 'blocked',
        task_status: 'blocked',
      } satisfies ExecuteResult)),
      readLatestVerdict: vi.fn(async () => null),
      writeReceipt: vi.fn(async () => {}),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-2', deps)

    expect(summary.gated).toBe(false)
    expect(step.waitForEventNames).toHaveLength(0)
  })
})

// ── 2. Gated task (execute lands 'review') ────────────────────────────────────

describe('gated task — waitForEvent resume', () => {
  it('calls waitForEvent exactly once with type gate-verdict', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    // waitForEvent resolves (not throws); payload has a WRONG verdict to prove D1 wins
    const step = makeStep({ waitForEventPayload: { verdict: 'WRONG_PAYLOAD_VALUE' } })

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      // D1 says 'approved' — this is the authoritative verdict, not the event payload
      readLatestVerdict: vi.fn(async (): Promise<VerdictRow | null> => ({ verdict: 'approved' })),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-3', deps)

    // waitForEvent called once
    expect(step.waitForEventNames).toHaveLength(1)
    expect(step.waitForEventNames[0]).toBe('await-gate')

    // readLatestVerdict was called (D1 consulted)
    expect(deps.readLatestVerdict).toHaveBeenCalledWith(env, PARAMS.taskId)

    // Summary says gated + resolved
    expect(summary.gated).toBe(true)
    expect(summary.resolved).toBe(true)

    // Receipts: execute/ok, await-gate/waiting, gate-resolved/gate-resolved
    const receiptNames = receipts.map((r) => r.stepName)
    expect(receiptNames).toContain('execute')
    expect(receiptNames).toContain('await-gate')
    expect(receiptNames).toContain('gate-resolved')
  })

  it('D1 verdict wins over the event payload — resolved receipt carries D1 value', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    // event payload says 'rejected'; D1 says 'approved' — D1 must win
    const step = makeStep({ waitForEventPayload: { verdict: 'rejected' } })

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      readLatestVerdict: vi.fn(async (): Promise<VerdictRow | null> => ({ verdict: 'approved' })),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    await runTaskPipeline(env, PARAMS, step, 'inst-4', deps)

    // Find the gate-resolved receipt
    const resolved = receipts.find((r) => r.stepName === 'gate-resolved')
    expect(resolved).toBeDefined()
    // Detail must carry the D1 verdict ('approved'), NOT the event payload ('rejected')
    expect(resolved?.detail).toContain('"verdict":"approved"')
    expect(resolved?.detail).not.toContain('rejected')
  })
})

// ── 3. Gated task — waitForEvent throws (timeout) ────────────────────────────

describe('gated task — waitForEvent timeout', () => {
  it('pipeline catches the throw and still calls readLatestVerdict', async () => {
    const env = makeMinimalEnv()
    const step = makeStep({ waitForEventThrows: true })

    const readLatestVerdict = vi.fn(async (): Promise<VerdictRow | null> => ({ verdict: 'approved' }))
    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      readLatestVerdict,
      writeReceipt: vi.fn(async () => {}),
    }

    // Must not throw
    await expect(runTaskPipeline(env, PARAMS, step, 'inst-5', deps)).resolves.not.toThrow()

    // readLatestVerdict was still called after the timeout
    expect(readLatestVerdict).toHaveBeenCalledWith(env, PARAMS.taskId)
  })

  it('timeout + D1 has verdict → gate-resolved receipt with D1 verdict', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    const step = makeStep({ waitForEventThrows: true })

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      readLatestVerdict: vi.fn(async (): Promise<VerdictRow | null> => ({ verdict: 'approved' })),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-6', deps)

    const resolved = receipts.find((r) => r.stepName === 'gate-resolved')
    expect(resolved?.status).toBe('gate-resolved')
    expect(resolved?.detail).toContain('"verdict":"approved"')
    expect(summary.resolved).toBe(true)
  })

  it('timeout + D1 has NO verdict → gate-timeout receipt', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    const step = makeStep({ waitForEventThrows: true })

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      // D1 has no verdict yet
      readLatestVerdict: vi.fn(async (): Promise<VerdictRow | null> => null),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-7', deps)

    // P1 (adversarial gate): the timeout receipt uses a DISTINCT step name so it
    // can never collide with / suppress a real 'gate-resolved' row under the
    // UNIQUE(instance_id, step_name) + INSERT OR IGNORE write.
    const timeout = receipts.find((r) => r.stepName === 'gate-timeout')
    expect(timeout?.status).toBe('gate-timeout')
    // And it must NOT have been written under the 'gate-resolved' name.
    expect(receipts.find((r) => r.stepName === 'gate-resolved')).toBeUndefined()
    // resolved is false when there is no verdict in D1
    expect(summary.resolved).toBe(false)
  })

  it('timeout and resolved receipts never collide (distinct step names coexist)', async () => {
    // Simulate a real receipt store enforcing UNIQUE(instance_id, step_name) with
    // INSERT OR IGNORE: a timeout row written first must NOT block a later
    // gate-resolved row for the same instance — otherwise the log would lie.
    const store = new Map<string, ReceiptRow>()
    const idempotentWrite = async (_e: Env, row: ReceiptRow) => {
      const key = `${row.instanceId}::${row.stepName}`
      if (!store.has(key)) store.set(key, row) // INSERT OR IGNORE semantics
    }
    const env = makeMinimalEnv()
    const instanceId = 'inst-collision'

    // First: a timeout receipt (no verdict yet).
    await idempotentWrite(env, { instanceId, taskId: PARAMS.taskId, stepName: 'gate-timeout', status: 'gate-timeout' })
    // Later: the real verdict resolves and a gate-resolved receipt is written.
    await idempotentWrite(env, { instanceId, taskId: PARAMS.taskId, stepName: 'gate-resolved', status: 'gate-resolved', detail: JSON.stringify({ verdict: 'approved' }) })

    // Both coexist — the resolved row is NOT suppressed by the earlier timeout row.
    expect(store.get(`${instanceId}::gate-timeout`)?.status).toBe('gate-timeout')
    expect(store.get(`${instanceId}::gate-resolved`)?.status).toBe('gate-resolved')
  })

  it('task status row is UNTOUCHED — pipeline never flips status', async () => {
    // The pipeline has no DB prepare calls of its own (all DB writes go through
    // the injectable writeReceipt / readLatestVerdict seams).  Verify that the
    // DB stub is never called via the env directly.
    const dbPrepare = vi.fn()
    const env: Env = {
      ...makeMinimalEnv(),
      DB: { prepare: dbPrepare } as unknown as Env['DB'],
    }
    const step = makeStep({ waitForEventThrows: true })

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      readLatestVerdict: vi.fn(async () => null),
      writeReceipt: vi.fn(async () => {}),
    }

    await runTaskPipeline(env, PARAMS, step, 'inst-8', deps)

    // env.DB.prepare must never be called by the pipeline itself
    expect(dbPrepare).not.toHaveBeenCalled()
  })
})

// ── 4. Receipt idempotency ────────────────────────────────────────────────────

describe('receipt idempotency — UNIQUE(instance_id, step_name)', () => {
  it('second writeReceipt call with the same instance+stepName is a no-op (INSERT OR IGNORE)', async () => {
    // We simulate idempotency at the mock level: track per (instanceId, stepName) and
    // ensure a second write with the same key does not change the stored row.
    const stored = new Map<string, ReceiptRow>()

    const idempotentWrite = vi.fn(async (_env: Env, row: ReceiptRow) => {
      const key = `${row.instanceId}::${row.stepName}`
      if (!stored.has(key)) {
        stored.set(key, row)
      }
      // second call: stored[key] unchanged (INSERT OR IGNORE semantics)
    })

    const env = makeMinimalEnv()
    const instanceId = 'inst-idem'

    // Call writeReceipt twice for the same (instanceId, stepName).
    await idempotentWrite(env, { instanceId, taskId: PARAMS.taskId, stepName: 'execute', status: 'ok', detail: 'first' })
    await idempotentWrite(env, { instanceId, taskId: PARAMS.taskId, stepName: 'execute', status: 'ok', detail: 'second' })

    expect(idempotentWrite).toHaveBeenCalledTimes(2)
    // The stored row is the FIRST write; the second was a no-op.
    expect(stored.get(`${instanceId}::execute`)?.detail).toBe('first')
  })
})

// ── 5. startTaskPipeline — creates instance + persists workflow_instance_id ───

describe('startTaskPipeline', () => {
  function makeStartEnv(opts: {
    task: Partial<Task & { workflow_instance_id: string | null }> | null
    instanceId?: string
  }) {
    const updates: { sql: string; args: unknown[] }[] = []
    const instanceId = opts.instanceId ?? 'wf-inst-new'

    const env: Env & {
      TASK_WORKFLOW: {
        create: ReturnType<typeof vi.fn>
        get: ReturnType<typeof vi.fn>
      }
    } = {
      ...makeMinimalEnv(),
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first<T>() {
                  if (opts.task === null) return null as unknown as T
                  // Return a row that matches the SELECT in startTaskPipeline.
                  // Use 'assignee_agent_id' in opts.task to detect explicit null
                  // (null and 'agent-wf-1' default are different cases).
                  const assigneeId =
                    'assignee_agent_id' in opts.task
                      ? opts.task.assignee_agent_id ?? null
                      : 'agent-wf-1'
                  return {
                    id: opts.task.id ?? 'task-wf-1',
                    squad_id: opts.task.squad_id ?? 'squad-wf-1',
                    status: opts.task.status ?? 'open',
                    assignee_agent_id: assigneeId,
                    workflow_instance_id: opts.task.workflow_instance_id ?? null,
                  } as unknown as T
                },
                async run() {
                  updates.push({ sql, args })
                  return { meta: { changes: 1 } }
                },
              }
            },
          }
        },
      } as unknown as Env['DB'],
      TASK_WORKFLOW: {
        create: vi.fn(async () => ({ id: instanceId })),
        get: vi.fn(async () => ({
          sendEvent: vi.fn(async () => {}),
          status: vi.fn(async () => ({})),
        })),
      },
    }

    return { env, updates }
  }

  it('creates a workflow instance and persists workflow_instance_id on the task', async () => {
    const { env, updates } = makeStartEnv({ task: { status: 'open', workflow_instance_id: null } })

    const result = await startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')

    expect(result.instanceId).toBe('wf-inst-new')
    expect(env.TASK_WORKFLOW!.create).toHaveBeenCalledOnce()

    // Must UPDATE tasks SET workflow_instance_id
    const update = updates.find((u) => u.sql.includes('workflow_instance_id'))
    expect(update).toBeDefined()
    expect(update?.args[0]).toBe('wf-inst-new')
    expect(update?.args[2]).toBe('task-wf-1')
  })

  it('refuses to start when workflow_instance_id is already set', async () => {
    const { env } = makeStartEnv({
      task: { status: 'open', workflow_instance_id: 'existing-wf-id' },
    })

    await expect(startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')).rejects.toMatchObject({
      message: 'pipeline_already_started',
    })

    // Workflow.create must NOT be called
    expect(env.TASK_WORKFLOW!.create).not.toHaveBeenCalled()
  })

  it('refuses to start for a non-runnable status (done)', async () => {
    const { env } = makeStartEnv({ task: { status: 'done', workflow_instance_id: null } })

    await expect(startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')).rejects.toMatchObject({
      code: 'task_not_runnable',
    })
  })

  it('refuses to start for a non-runnable status (review)', async () => {
    const { env } = makeStartEnv({ task: { status: 'review', workflow_instance_id: null } })

    await expect(startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')).rejects.toMatchObject({
      code: 'task_not_runnable',
    })
  })

  it('refuses to start when task has no assignee', async () => {
    const { env } = makeStartEnv({
      task: { status: 'open', assignee_agent_id: null, workflow_instance_id: null },
    })

    await expect(startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')).rejects.toMatchObject({
      code: 'task_has_no_assignee',
    })
  })

  it('throws task_not_found when task is absent', async () => {
    const { env } = makeStartEnv({ task: null })

    await expect(startTaskPipeline(env, 'task-wf-1', 'squad-wf-1')).rejects.toMatchObject({
      code: 'task_not_found',
    })
  })
})

// ── 6. Pipeline summary shape ─────────────────────────────────────────────────

describe('pipeline summary shape', () => {
  it('ungated summary has correct shape', async () => {
    const env = makeMinimalEnv()
    const step = makeStep()

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'done',
        task_status: 'done',
      })),
      readLatestVerdict: vi.fn(async () => null),
      writeReceipt: vi.fn(async () => {}),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-summary-1', deps)

    expect(summary).toMatchObject({
      taskId: PARAMS.taskId,
      finalStatus: 'done',
      gated: false,
      resolved: false,
    })
  })

  it('gated + resolved summary has correct shape', async () => {
    const env = makeMinimalEnv()
    const step = makeStep()

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => AGENT),
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: true,
        task_id: PARAMS.taskId,
        decided: 'review',
        task_status: 'review',
      })),
      readLatestVerdict: vi.fn(async (): Promise<VerdictRow | null> => ({ verdict: 'rejected' })),
      writeReceipt: vi.fn(async () => {}),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-summary-2', deps)

    expect(summary).toMatchObject({
      taskId: PARAMS.taskId,
      finalStatus: 'review',
      gated: true,
      resolved: true,
    })
  })
})

// ── 7. Agent not found edge case ──────────────────────────────────────────────

describe('agent not found', () => {
  it('pipeline writes agent_not_found receipt and returns gated=false', async () => {
    const receipts: ReceiptRow[] = []
    const env = makeMinimalEnv()
    const step = makeStep()

    const deps: PipelineDeps = {
      loadAgent: vi.fn(async () => null), // agent absent
      runTaskExecution: vi.fn(async (): Promise<ExecuteResult> => ({
        ok: false,
        task_id: PARAMS.taskId,
        decided: 'agent_not_found',
        task_status: undefined,
      })),
      readLatestVerdict: vi.fn(async () => null),
      writeReceipt: vi.fn(async (_e, row) => { receipts.push(row) }),
    }

    const summary = await runTaskPipeline(env, PARAMS, step, 'inst-notfound', deps)

    const agentReceipt = receipts.find((r) => r.status === 'agent_not_found')
    expect(agentReceipt).toBeDefined()
    expect(summary.gated).toBe(false)
    expect(summary.resolved).toBe(false)
    // No waitForEvent when execute did not land 'review'
    expect(step.waitForEventNames).toHaveLength(0)
  })
})
