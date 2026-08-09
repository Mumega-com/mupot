import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TIER2_ALLOWED_TOOLS,
  TIER2_FORBIDDEN_TOOLS,
  TIER2_TURN_PIPELINE,
  allowsPersistentProcessPerUser,
  assertTier2ToolAllowed,
  decideTier2Budget,
  idleModelCostMicroUsd,
  isTier2AllowedTool,
  isTier2ForbiddenTool,
  isTier2Runtime,
  mayRunModelTurn,
  mayWakeIdleTier2Chat,
  parseTier2ChatMarker,
  tier2ChatMarker,
  tier2ResultFanInKey,
  validateTier2TaskCreate,
} from '../src/chat/tier2-contract'

const contract = JSON.parse(
  readFileSync(new URL('../docs/tier2-user-chat-v1.json', import.meta.url), 'utf8'),
) as {
  id: string
  status: string
  contrast: {
    tier1: { persistentProcessPerUser?: boolean; idleCost: string }
    tier2: { persistentProcessPerUser: boolean; idleCost: string }
  }
  invariants: string[]
  provenanceMarkerPrefix: string
  turnPipeline: string[]
  allowedTools: string[]
  forbiddenTools: string[]
  budget: { preCallGate: boolean; denyWithoutModelCall: boolean }
  resultFanIn: { idempotencyKey: string[]; messageRole: string }
  nonGoals: string[]
}

describe('tier2-user-chat/v1 contract doc', () => {
  it('is the design-status Tier-2 chat contract', () => {
    expect(contract.id).toBe('tier2-user-chat/v1')
    expect(contract.status).toBe('design')
    expect(contract.contrast.tier2.persistentProcessPerUser).toBe(false)
    expect(contract.contrast.tier2.idleCost).toBe('zero')
    expect(contract.contrast.tier1.idleCost).toBe('non-zero')
    expect(contract.budget.preCallGate).toBe(true)
    expect(contract.budget.denyWithoutModelCall).toBe(true)
    expect(contract.nonGoals).toContain('replace-tier1-kayhermes')
    expect(contract.nonGoals).toContain('cron-wake-for-idle-chats')
  })

  it('matches the pure module pipeline and tool lists', () => {
    expect(contract.turnPipeline).toEqual([...TIER2_TURN_PIPELINE])
    expect(contract.allowedTools).toEqual([...TIER2_ALLOWED_TOOLS])
    expect(contract.forbiddenTools).toEqual([...TIER2_FORBIDDEN_TOOLS])
    expect(contract.provenanceMarkerPrefix).toBe('[tier2-chat:')
    expect(contract.resultFanIn.messageRole).toBe('result')
    expect(contract.resultFanIn.idempotencyKey).toEqual([
      'session_id',
      'task_id',
      'terminal_status',
    ])
  })

  it('locks the load-bearing invariants', () => {
    for (const inv of [
      'no-persistent-agent-process-per-user',
      'dormant-when-idle-zero-model-cost',
      'budget-gate-before-model-call',
      'board-dispatch-only-no-self-execute',
      'session-history-in-d1',
      'results-return-via-gated-task-terminal',
    ]) {
      expect(contract.invariants).toContain(inv)
    }
  })
})

describe('tier2 runtime contrast', () => {
  it('Tier-2 is the every-member path; Tier-1 keeps persistent process', () => {
    expect(isTier2Runtime('tier2_stateless_user_chat')).toBe(true)
    expect(isTier2Runtime('tier1_persistent_mubot')).toBe(false)
    expect(allowsPersistentProcessPerUser('tier2_stateless_user_chat')).toBe(false)
    expect(allowsPersistentProcessPerUser('tier1_persistent_mubot')).toBe(true)
  })

  it('idle Tier-2 costs zero model spend; idle Tier-1 is not free', () => {
    expect(idleModelCostMicroUsd('tier2_stateless_user_chat', false)).toBe(0)
    expect(idleModelCostMicroUsd('tier1_persistent_mubot', false)).toBeGreaterThan(0)
  })

  it('refuses cron/idle wake without a user message', () => {
    expect(mayWakeIdleTier2Chat(false)).toBe(false)
    expect(mayWakeIdleTier2Chat(true)).toBe(true)
  })
})

describe('tier2 budget gate', () => {
  it('allows spend within remaining budget and when unlimited', () => {
    expect(decideTier2Budget({ remainingMicroUsd: 1_000, estimateMicroUsd: 1_000 })).toEqual({
      ok: true,
    })
    expect(decideTier2Budget({ remainingMicroUsd: -1, estimateMicroUsd: 9_999_999 })).toEqual({
      ok: true,
    })
  })

  it('blocks before model when estimate would exceed remaining', () => {
    expect(decideTier2Budget({ remainingMicroUsd: 100, estimateMicroUsd: 101 })).toEqual({
      ok: false,
      reason: 'budget_exhausted',
    })
  })

  it('requires budgetGate before modelTurn in the pipeline', () => {
    expect(mayRunModelTurn([])).toBe(false)
    expect(mayRunModelTurn(['authorize', 'loadContext'])).toBe(false)
    expect(mayRunModelTurn(['authorize', 'loadContext', 'budgetGate'])).toBe(true)
    expect(mayRunModelTurn(['authorize', 'loadContext', 'budgetGate', 'modelTurn'])).toBe(false)
  })
})

describe('tier2 tools and board dispatch', () => {
  it('allows board/read tools and forbids Hermes/gate/deploy', () => {
    expect(isTier2AllowedTool('task_create')).toBe(true)
    expect(isTier2ForbiddenTool('hermes_sessions')).toBe(true)
    expect(isTier2ForbiddenTool('deploy')).toBe(true)
    expect(() => assertTier2ToolAllowed('task_create')).not.toThrow()
    expect(() => assertTier2ToolAllowed('hermes_sessions')).toThrow(/tier2_tool_forbidden/)
    expect(() => assertTier2ToolAllowed('unknown_tool')).toThrow(/tier2_tool_forbidden/)
  })

  it('requires done_when and embeds provenance marker on task create', () => {
    const bad = validateTier2TaskCreate({
      title: 'Ship landing CTA',
      body: 'Do the work',
      doneWhen: '',
      sessionId: 'sess-1',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('done_when_required')

    const good = validateTier2TaskCreate({
      title: 'Ship landing CTA',
      body: 'Test the pricing CTA.',
      doneWhen: 'PR opened with CTA A/B test and gate PASS',
      sessionId: 'sess-1',
    })
    expect(good.ok).toBe(true)
    if (good.ok) {
      expect(good.body).toContain(tier2ChatMarker('sess-1'))
      expect(parseTier2ChatMarker(good.body)).toBe('sess-1')
    }
  })

  it('builds a stable result fan-in idempotency key', () => {
    expect(
      tier2ResultFanInKey({
        sessionId: 'sess-1',
        taskId: 'task-9',
        terminalStatus: 'done',
      }),
    ).toBe('sess-1:task-9:done')
    expect(() =>
      tier2ResultFanInKey({ sessionId: '', taskId: 't', terminalStatus: 'done' }),
    ).toThrow(/tier2_result_fan_in_key_incomplete/)
  })
})
