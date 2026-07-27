import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUIRED_WINS_PER_WIDEN,
  OWNER_EXPERIENCE_FACETS,
  OWNER_EXPERIENCE_LOOP,
  OWNER_EXPERIENCE_PRINCIPLES,
  OWNER_TRUST_LADDER,
  assertOwnerHomeFacets,
  assertTalkV1Runtime,
  autonomyForTrustLevel,
  brainRemainsRankNotAct,
  decideEarnedAutonomyWiden,
  decideProgressDisplay,
  isTalkV1Runtime,
  mayEnableInstinctAdapt,
  mayMubotRedefineGoal,
  mayMubotSelfVerdictGate,
  trustLevelForAutonomy,
  validateLessonDraft,
} from '../src/owner/owner-experience-contract'

const contract = JSON.parse(
  readFileSync(new URL('../docs/owner-experience-v1.json', import.meta.url), 'utf8'),
) as {
  id: string
  status: string
  facets: string[]
  loop: string[]
  principles: string[]
  invariants: string[]
  talk: { v1Runtime: string; tier2Status: string }
  trustLevels: Array<{ level: number; autonomy: string }>
  earnedAutonomy: {
    maxStepsPerWiden: number
    defaultRequiredWins: number
    winVerification: string
    mubotSelfWiden: boolean
  }
  progress: { allowedKinds: string[]; forbidFakeGreen: boolean }
  unmetDependencies: Array<{ id: string; status: string }>
  nonGoals: string[]
  buildSlices: string[]
}

describe('owner-experience/v1 contract doc', () => {
  it('is the design-status owner-experience contract', () => {
    expect(contract.id).toBe('owner-experience/v1')
    expect(contract.status).toBe('design')
    expect(contract.talk.v1Runtime).toBe('tier1_persistent_mubot')
    expect(contract.talk.tier2Status).toBe('dyad-gate-blocked')
    expect(contract.earnedAutonomy.mubotSelfWiden).toBe(false)
    expect(contract.earnedAutonomy.winVerification).toBe('resolved_by_id')
    expect(contract.progress.forbidFakeGreen).toBe(true)
    expect(contract.nonGoals).toContain('pretend-modelport-v2-exists')
    expect(contract.nonGoals).toContain('cite-dormant-surfaces-as-reuse')
    expect(contract.nonGoals).toContain('merge-port4-or-ranker-from-this-worktree')
  })

  it('matches the pure module facets, loop, and trust ladder', () => {
    expect(contract.facets).toEqual([...OWNER_EXPERIENCE_FACETS])
    expect(contract.loop).toEqual([...OWNER_EXPERIENCE_LOOP])
    expect(contract.principles).toEqual([...OWNER_EXPERIENCE_PRINCIPLES])
    expect(contract.earnedAutonomy.defaultRequiredWins).toBe(DEFAULT_REQUIRED_WINS_PER_WIDEN)
    expect(contract.earnedAutonomy.maxStepsPerWiden).toBe(1)
    expect(contract.trustLevels.map((row) => row.autonomy)).toEqual([...OWNER_TRUST_LADDER])
  })

  it('locks the load-bearing invariants and names unmet dependencies', () => {
    for (const inv of [
      'owner-owns-goal-mubot-cannot-redefine',
      'owner-owns-gate-mubot-cannot-self-verdict',
      'receipts-resolved-by-id-not-label',
      'progress-never-fake-green',
      'earned-autonomy-one-step-with-verified-wins',
      'lesson-requires-receipt-id',
      'talk-v1-tier1-mubot-only',
      'learn-adapt-instinct-requires-port4-prerequisite',
      'brain-remains-rank-not-act',
    ]) {
      expect(contract.invariants).toContain(inv)
    }
    const unmetIds = contract.unmetDependencies.map((row) => row.id)
    expect(unmetIds).toContain('port-4-instinct-memory')
    expect(unmetIds).toContain('tier2-user-chat')
    expect(unmetIds).toContain('model-port-v2-tool-calling')
    expect(contract.buildSlices[0]).toBe('outcome-model')
  })
})

describe('owner goal and gate ownership', () => {
  it('forbids mubot from redefining the outcome or self-verdicting', () => {
    expect(mayMubotRedefineGoal()).toBe(false)
    expect(mayMubotSelfVerdictGate()).toBe(false)
  })

  it('allows Talk v1 only for Tier-1 mubot runtime', () => {
    expect(isTalkV1Runtime('tier1_persistent_mubot')).toBe(true)
    expect(isTalkV1Runtime('tier2_stateless_user_chat')).toBe(false)
    expect(() => assertTalkV1Runtime('tier1_persistent_mubot')).not.toThrow()
    expect(() => assertTalkV1Runtime('tier2_stateless_user_chat')).toThrow(
      /owner_experience_talk_v1_tier1_only/,
    )
  })
})

describe('earned autonomy', () => {
  it('maps trust levels onto the existing Autonomy ladder', () => {
    expect(trustLevelForAutonomy('suggest')).toBe(0)
    expect(trustLevelForAutonomy('execute')).toBe(3)
    expect(autonomyForTrustLevel(2)).toBe('execute_with_approval')
  })

  it('widens one step only when wins are resolved_by_id and decider is owner', () => {
    const wins = [
      { receiptId: 'wr-1', verification: 'resolved_by_id' as const },
      { receiptId: 'wr-2', verification: 'resolved_by_id' as const },
      { receiptId: 'wr-3', verification: 'resolved_by_id' as const },
    ]
    expect(
      decideEarnedAutonomyWiden({
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'owner_or_admin_human',
        wins,
        requiredWins: 3,
      }),
    ).toEqual({ ok: true, from: 'suggest', to: 'draft', verifiedWinCount: 3 })
  })

  it('fails closed on self-widen, skip, labels, and insufficient wins', () => {
    expect(
      decideEarnedAutonomyWiden({
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'mubot_or_agent',
        wins: [{ receiptId: 'wr-1', verification: 'resolved_by_id' }],
        requiredWins: 1,
      }),
    ).toEqual({ ok: false, reason: 'mubot_cannot_self_widen' })

    expect(
      decideEarnedAutonomyWiden({
        current: 'suggest',
        proposed: 'execute',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: [
          { receiptId: 'a', verification: 'resolved_by_id' },
          { receiptId: 'b', verification: 'resolved_by_id' },
          { receiptId: 'c', verification: 'resolved_by_id' },
        ],
        requiredWins: 3,
      }),
    ).toEqual({ ok: false, reason: 'skip_not_allowed' })

    expect(
      decideEarnedAutonomyWiden({
        current: 'draft',
        proposed: 'execute_with_approval',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: [{ receiptId: 'wr-1', verification: 'unverified_label' }],
        requiredWins: 1,
      }),
    ).toEqual({ ok: false, reason: 'unverified_win_label' })

    expect(
      decideEarnedAutonomyWiden({
        current: 'draft',
        proposed: 'execute_with_approval',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: [{ receiptId: 'wr-1', verification: 'resolved_by_id' }],
        requiredWins: 3,
      }),
    ).toEqual({ ok: false, reason: 'insufficient_verified_wins' })
  })
})

describe('honest progress and visible learning', () => {
  it('never fake-greens when metric is missing or source unwired', () => {
    expect(
      decideProgressDisplay({ metric: null, sourceWired: true, signal: { ok: true, value: 20 } }),
    ).toEqual({ kind: 'unmeasured' })
    expect(
      decideProgressDisplay({
        metric: { sourceId: 'ghl_booked_calls', target: 20 },
        sourceWired: false,
        signal: { ok: true, value: 20 },
      }),
    ).toEqual({ kind: 'unmeasured' })
  })

  it('returns measured only from a wired signal and unavailable on failure', () => {
    expect(
      decideProgressDisplay({
        metric: { sourceId: 'github_prs', target: 10 },
        sourceWired: true,
        signal: { ok: true, value: 5 },
      }),
    ).toEqual({ kind: 'measured', value: 5, target: 10, ratio: 0.5 })
    expect(
      decideProgressDisplay({
        metric: { sourceId: 'github_prs', target: 10 },
        sourceWired: true,
        signal: { ok: false, reason: 'source_error' },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'source_error' })
  })

  it('requires receipt id on lessons', () => {
    expect(
      validateLessonDraft({
        receiptId: '',
        polarity: 'miss',
        summary: 'Long form killed sign-ups',
        sourceSchema: 'mupot.lessons_capture/v1',
      }),
    ).toEqual({ ok: false, reason: 'receipt_id_required' })

    const good = validateLessonDraft({
      receiptId: 'rcpt-9',
      polarity: 'miss',
      summary: 'Long form killed sign-ups',
      sourceSchema: 'mupot.lessons_capture/v1',
    })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.lesson.receiptId).toBe('rcpt-9')
  })
})

describe('prerequisites and home composition', () => {
  it('blocks instinct Adapt until Port-4 is live and ranker has passed', () => {
    expect(
      mayEnableInstinctAdapt({ port4LiveOnMain: false, learningRankerDyadPassed: false }),
    ).toEqual({ ok: false, reason: 'port4_not_live' })
    expect(
      mayEnableInstinctAdapt({ port4LiveOnMain: true, learningRankerDyadPassed: false }),
    ).toEqual({ ok: false, reason: 'learning_ranker_not_passed' })
    expect(
      mayEnableInstinctAdapt({ port4LiveOnMain: true, learningRankerDyadPassed: true }),
    ).toEqual({ ok: true })
  })

  it('requires all three facets on the owner home', () => {
    expect(() => assertOwnerHomeFacets(['talk', 'know', 'watch'])).not.toThrow()
    expect(() => assertOwnerHomeFacets(['talk', 'watch'])).toThrow(/owner_experience_facet_missing/)
    expect(brainRemainsRankNotAct()).toBe(true)
  })
})
