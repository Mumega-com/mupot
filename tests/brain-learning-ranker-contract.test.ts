import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_BRAIN_PROPOSAL_KINDS,
  DISTILL_ALLOWED_SOURCES,
  DISTILL_FORBIDDEN_SOURCES,
  EXAMPLE_FABRICATION_INSTINCT_ID,
  FORBIDDEN_BRAIN_ACTION_VERBS,
  INSTINCT_CONFIDENCE_MAX,
  INSTINCT_CONFIDENCE_MIN,
  INSTINCT_DECAY_HALF_LIFE_DAYS,
  INSTINCT_INJECT_THRESHOLD,
  LEARNING_RANKER_PIPELINE,
  RANK_INSTINCT_DOMAINS,
  applyInstinctBiasToProposals,
  assertProposalKindAllowed,
  brainMayAct,
  clampInstinctConfidence,
  decayInstinctConfidence,
  defaultInstinctGateOpts,
  fabricationInstinctExample,
  gateInstinctsForRank,
  hermesIsLearningMechanism,
  hermesMayAuthorizeBrainAction,
  hotPathAllowsLlm,
  isForbiddenActionVerb,
  isLearningRankerRole,
  isRankInstinctDomain,
  mayApplyInstinctBias,
  mayDistillFromSource,
  mayRunHotPathDistill,
  shouldPromoteInstinct,
  textContainsForbiddenAction,
} from '../src/brain/learning-ranker-contract'

const contract = JSON.parse(
  readFileSync(new URL('../docs/brain-learning-ranker-v1.json', import.meta.url), 'utf8'),
) as {
  id: string
  status: string
  contrast: {
    learningRanker: { mayAct: boolean; hotPathLlm: boolean; learning: string }
    learningActor: { mayAct: boolean }
  }
  invariants: string[]
  rankPipeline: string[]
  allowedProposalKinds: string[]
  forbiddenActionVerbs: string[]
  instinct: {
    confidenceMin: number
    confidenceMax: number
    injectThreshold: number
    decayHalfLifeDays: number
    allowedDomains: string[]
    promoteMinProjects: number
    promoteMinConfidence: number
  }
  distill: {
    allowedSources: string[]
    forbiddenSources: string[]
    runsOnHotPath: boolean
  }
  runtime: {
    hermesIsLearningMechanism: boolean
  }
  exampleInstinctId: string
  nonGoals: string[]
  tiesTo: { dormantPort4Task: string; failureClass: string }
}

describe('brain-learning-ranker/v1 contract doc', () => {
  it('is the design-status learning-ranker contract', () => {
    expect(contract.id).toBe('brain-learning-ranker/v1')
    expect(contract.status).toBe('design')
    expect(contract.contrast.learningRanker.mayAct).toBe(false)
    expect(contract.contrast.learningRanker.hotPathLlm).toBe(false)
    expect(contract.contrast.learningRanker.learning).toBe('port4-instinct-loop')
    expect(contract.contrast.learningActor.mayAct).toBe(true)
    expect(contract.runtime.hermesIsLearningMechanism).toBe(false)
    expect(contract.distill.runsOnHotPath).toBe(false)
    expect(contract.tiesTo.dormantPort4Task).toBe('b143e73d')
    expect(contract.tiesTo.failureClass).toBe('#490-act-on-fabrication')
    expect(contract.nonGoals).toContain('replace-brainport-with-hermes-gateway')
    expect(contract.nonGoals).toContain('make-brain-an-actor')
  })

  it('matches the pure module pipeline and lists', () => {
    expect(contract.rankPipeline).toEqual([...LEARNING_RANKER_PIPELINE])
    expect(contract.allowedProposalKinds).toEqual([...ALLOWED_BRAIN_PROPOSAL_KINDS])
    expect(contract.forbiddenActionVerbs).toEqual([...FORBIDDEN_BRAIN_ACTION_VERBS])
    expect(contract.instinct.allowedDomains).toEqual([...RANK_INSTINCT_DOMAINS])
    expect(contract.distill.allowedSources).toEqual([...DISTILL_ALLOWED_SOURCES])
    expect(contract.distill.forbiddenSources).toEqual([...DISTILL_FORBIDDEN_SOURCES])
    expect(contract.exampleInstinctId).toBe(EXAMPLE_FABRICATION_INSTINCT_ID)
    expect(contract.instinct.confidenceMin).toBe(INSTINCT_CONFIDENCE_MIN)
    expect(contract.instinct.confidenceMax).toBe(INSTINCT_CONFIDENCE_MAX)
    expect(contract.instinct.injectThreshold).toBe(INSTINCT_INJECT_THRESHOLD)
    expect(contract.instinct.decayHalfLifeDays).toBe(INSTINCT_DECAY_HALF_LIFE_DAYS)
  })

  it('locks the load-bearing invariants', () => {
    for (const inv of [
      'brain-rank-not-act',
      'learning-is-instinct-loop-not-hermes-gateway',
      'hot-path-zero-llm',
      'recall-at-rank-core-injected',
      'distill-from-receipts-only',
      'instincts-confidence-decay-domain-gated',
      'instincts-never-bypass-core-gates',
      'no-new-brain-proposal-verbs',
      'hermes-optional-runtime-only',
    ]) {
      expect(contract.invariants).toContain(inv)
    }
  })
})

describe('brain role — rank not act', () => {
  it('learning_ranker may not act; learning_actor is the anti-pattern', () => {
    expect(isLearningRankerRole('learning_ranker')).toBe(true)
    expect(brainMayAct('learning_ranker')).toBe(false)
    expect(brainMayAct('learning_actor')).toBe(true)
  })

  it('Hermes is optional runtime only — not learning, not action authority', () => {
    expect(hermesIsLearningMechanism()).toBe(false)
    expect(hermesMayAuthorizeBrainAction()).toBe(false)
  })

  it('hot path forbids LLM distill', () => {
    expect(hotPathAllowsLlm()).toBe(false)
    expect(mayRunHotPathDistill()).toBe(false)
  })

  it('allows only BrainPort proposal kinds and forbids restart/heal verbs', () => {
    expect(() => assertProposalKindAllowed('spawn_task')).not.toThrow()
    expect(() => assertProposalKindAllowed('restart')).toThrow(/forbidden_proposal_kind/)
    expect(isForbiddenActionVerb('restart')).toBe(true)
    expect(isForbiddenActionVerb('heal')).toBe(true)
    expect(textContainsForbiddenAction('please restart the squad service')).toBe(true)
    expect(textContainsForbiddenAction('rank open tasks by age')).toBe(false)
  })
})

describe('distill source fence (anti self-poisoning)', () => {
  it('allows receipted sources only', () => {
    expect(mayDistillFromSource('gate_fail_receipt')).toEqual({ ok: true })
    expect(mayDistillFromSource('fabrication_receipt')).toEqual({ ok: true })
    expect(mayDistillFromSource('human_correction_receipt')).toEqual({ ok: true })
  })

  it('refuses self-report and speculation', () => {
    expect(mayDistillFromSource('raw_agent_self_report')).toEqual({
      ok: false,
      reason: 'forbidden_source',
    })
    expect(mayDistillFromSource('model_speculation')).toEqual({
      ok: false,
      reason: 'forbidden_source',
    })
    expect(mayDistillFromSource('vibes')).toEqual({ ok: false, reason: 'unknown_source' })
  })
})

describe('instinct gate — confidence + decay + domain', () => {
  const now = '2026-07-27T12:00:00.000Z'

  it('clamps and decays confidence', () => {
    expect(clampInstinctConfidence(0.1)).toBe(INSTINCT_CONFIDENCE_MIN)
    expect(clampInstinctConfidence(0.99)).toBe(INSTINCT_CONFIDENCE_MAX)
    const half = decayInstinctConfidence(0.8, '2026-06-27T12:00:00.000Z', now, 30)
    expect(half).toBeLessThan(0.8)
    expect(half).toBeGreaterThanOrEqual(INSTINCT_CONFIDENCE_MIN)
  })

  it('injects only allowlisted domains above threshold after decay', () => {
    const instincts = [
      {
        id: 'ok',
        trigger: 'when fabrication appears',
        confidence: 0.85,
        domain: 'rank-discipline',
        action: 'prefer noop',
        updatedAt: now,
        projectId: 'p1',
      },
      {
        id: 'wrong-domain',
        trigger: 'when anything',
        confidence: 0.9,
        domain: 'code-style',
        action: 'prefer noop',
        updatedAt: now,
        projectId: 'p1',
      },
      {
        id: 'too-weak',
        trigger: 'when fabrication appears',
        confidence: 0.4,
        domain: 'rank-discipline',
        action: 'prefer noop',
        updatedAt: now,
        projectId: 'p1',
      },
    ]
    const gated = gateInstinctsForRank(instincts, defaultInstinctGateOpts(now))
    expect(gated.ok).toBe(true)
    if (gated.ok) {
      expect(gated.instincts.map((i) => i.id)).toEqual(['ok'])
    }
    expect(isRankInstinctDomain('rank-discipline')).toBe(true)
    expect(isRankInstinctDomain('code-style')).toBe(false)
  })

  it('promotion requires ≥2 projects and high average confidence', () => {
    expect(shouldPromoteInstinct([0.9])).toBe(false)
    expect(shouldPromoteInstinct([0.9, 0.85])).toBe(true)
    expect(shouldPromoteInstinct([0.5, 0.5])).toBe(false)
  })
})

describe('RECALL-at-rank bias — #490 fabrication class', () => {
  const now = '2026-07-27T12:00:00.000Z'

  it('turns a fabrication restart proposal into noop via gated instinct', () => {
    const instinct = fabricationInstinctExample(now)
    const gated = gateInstinctsForRank([instinct], defaultInstinctGateOpts(now))
    expect(gated.ok).toBe(true)
    if (!gated.ok) return

    // Forbidden verb in the summary must fail closed before bias.
    expect(() =>
      applyInstinctBiasToProposals(
        [
          {
            kind: 'spawn_task',
            summary: 'Please restart the squad service now',
            priority: 10,
            doneWhen: null,
          },
        ],
        gated.instincts,
      ),
    ).toThrow(/forbidden_action_in_summary/)

    // Same intent without the forbidden verb token — trigger match → noop.
    const safe = applyInstinctBiasToProposals(
      [
        {
          kind: 'spawn_task',
          summary: 'Clear fabricated empty backlog outage with invented work',
          priority: 10,
          doneWhen: 'backlog healthy',
        },
        {
          kind: 'spawn_task',
          summary: 'Rank open docs RBAC tasks by age',
          priority: 5,
          doneWhen: 'list ordered',
        },
      ],
      gated.instincts,
    )
    const blocked = safe.find((p) => p.summary.includes(EXAMPLE_FABRICATION_INSTINCT_ID))
    expect(blocked?.kind).toBe('noop')
    expect(safe.some((p) => p.kind === 'spawn_task' && p.summary.includes('docs RBAC'))).toBe(
      true,
    )
  })

  it('requires gateInstincts + decide before applyInstinctBias', () => {
    expect(mayApplyInstinctBias([])).toBe(false)
    expect(mayApplyInstinctBias(['loadBoardContext', 'recallInstincts'])).toBe(false)
    expect(mayApplyInstinctBias(['gateInstincts', 'decide'])).toBe(true)
    expect(
      mayApplyInstinctBias(['gateInstincts', 'decide', 'applyInstinctBias']),
    ).toBe(false)
  })
})
