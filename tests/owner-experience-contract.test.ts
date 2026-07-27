import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUIRED_WINS_PER_WIDEN,
  OWNER_EXPERIENCE_FACETS,
  OWNER_EXPERIENCE_LOOP,
  OWNER_EXPERIENCE_PRINCIPLES,
  OWNER_TRUST_LADDER,
  WIN_CONSUMPTION_POLICY,
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
  verifiedWinRefFromResolver,
  type WinReceiptResolver,
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
  talk: { v1Runtime: string; tier2Status: string; homePolicy?: string }
  trustLevels: Array<{ level: number; autonomy: string }>
  earnedAutonomy: {
    maxStepsPerWiden: number
    defaultRequiredWins: number
    winVerification: string
    mubotSelfWiden: boolean
    winConsumptionPolicy: string
  }
  progress: { allowedKinds: string[]; forbidFakeGreen: boolean }
  unmetDependencies: Array<{ id: string; status: string }>
  nonGoals: string[]
  buildSlices: string[]
}

function mintWins(
  resolver: WinReceiptResolver,
  ids: readonly string[],
  scope: { projectId: string; agentId: string },
) {
  return ids.map((id) => {
    const ref = verifiedWinRefFromResolver(resolver, id, scope)
    if (!('_brand' in ref)) throw new Error(`mint failed: ${JSON.stringify(ref)}`)
    return ref
  })
}

const scope = { projectId: 'proj-a', agentId: 'agent-a' }

const store: WinReceiptResolver = (id) => {
  const known: Record<string, { polarity: 'win' | 'miss'; projectId: string; agentId: string }> = {
    'wr-1': { polarity: 'win', projectId: 'proj-a', agentId: 'agent-a' },
    'wr-2': { polarity: 'win', projectId: 'proj-a', agentId: 'agent-a' },
    'wr-3': { polarity: 'win', projectId: 'proj-a', agentId: 'agent-a' },
    'wr-miss': { polarity: 'miss', projectId: 'proj-a', agentId: 'agent-a' },
    'wr-other-proj': { polarity: 'win', projectId: 'sandbox', agentId: 'agent-a' },
    'wr-other-agent': { polarity: 'win', projectId: 'proj-a', agentId: 'agent-b' },
  }
  const row = known[id]
  if (!row) return null
  return {
    receiptId: id,
    projectId: row.projectId,
    agentId: row.agentId,
    polarity: row.polarity,
    resolvedAt: '2026-07-27T12:00:00.000Z',
  }
}

describe('owner-experience/v1 contract doc', () => {
  it('is the design-status owner-experience contract', () => {
    expect(contract.id).toBe('owner-experience/v1')
    expect(contract.status).toBe('design')
    expect(contract.talk.v1Runtime).toBe('tier1_persistent_mubot')
    expect(contract.talk.tier2Status).toBe('dyad-gate-blocked')
    expect(contract.earnedAutonomy.mubotSelfWiden).toBe(false)
    expect(contract.earnedAutonomy.winVerification).toBe(
      'branded-VerifiedWinRef-from-WinReceiptResolver',
    )
    expect(contract.earnedAutonomy.winConsumptionPolicy).toBe(WIN_CONSUMPTION_POLICY)
    expect(contract.progress.forbidFakeGreen).toBe(true)
    expect(contract.talk.homePolicy).toBe('optional-facet-until-tier1-revived')
    expect(contract.nonGoals).toContain('pretend-modelport-v2-exists')
    expect(contract.nonGoals).toContain('cite-dormant-surfaces-as-reuse')
    expect(contract.nonGoals).toContain('merge-port4-or-ranker-from-this-worktree')
    expect(contract.nonGoals).toContain('cite-BrainPort-as-reuse')
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
      'earned-autonomy-wins-consumed-after-widen',
      'earned-autonomy-scope-bound-to-project-and-agent',
      'lesson-requires-receipt-id',
      'talk-v1-tier1-mubot-only-when-present',
      'learn-adapt-instinct-requires-port4-prerequisite',
      'brain-remains-rank-not-act',
      'mechanism-lock-ne-trust-lock',
    ]) {
      expect(contract.invariants).toContain(inv)
    }
    const unmetIds = contract.unmetDependencies.map((row) => row.id)
    expect(unmetIds).toContain('tier1-persistent-mubot-505')
    expect(unmetIds).toContain('port-4-instinct-memory')
    expect(unmetIds).toContain('tier2-user-chat')
    expect(unmetIds).toContain('model-port-v2-tool-calling')
    expect(unmetIds).toContain('brainport-default-adapter')
    expect(contract.buildSlices[0]).toBe('outcome-model')
  })
})

describe('owner goal and gate ownership', () => {
  it('forbids mubot from redefining the outcome or self-verdicting (parametrized)', () => {
    expect(mayMubotRedefineGoal('mubot_or_agent')).toBe(false)
    expect(mayMubotRedefineGoal('owner_or_admin_human')).toBe(false)
    expect(mayMubotSelfVerdictGate('mubot_or_agent')).toBe(false)
    expect(mayMubotSelfVerdictGate('owner_or_admin_human')).toBe(false)
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

describe('earned autonomy trust-locks', () => {
  it('maps trust levels onto the existing Autonomy ladder', () => {
    expect(trustLevelForAutonomy('suggest')).toBe(0)
    expect(trustLevelForAutonomy('execute')).toBe(3)
    expect(autonomyForTrustLevel(2)).toBe('execute_with_approval')
  })

  it('refuses caller-written resolved_by_id labels (original failing scenario)', () => {
    expect(
      decideEarnedAutonomyWiden({
        projectId: 'proj-a',
        agentId: 'agent-a',
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: [
          { receiptId: 'wr-1', verification: 'resolved_by_id' },
          { receiptId: 'wr-2', verification: 'resolved_by_id' },
          { receiptId: 'wr-3', verification: 'resolved_by_id' },
        ],
        requiredWins: 3,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'unverified_win_label' })
  })

  it('widens one step only from resolver-minted wins matching scope', () => {
    const wins = mintWins(store, ['wr-1', 'wr-2', 'wr-3'], scope)
    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'owner_or_admin_human',
        wins,
        requiredWins: 3,
        consumedReceiptIds: [],
      }),
    ).toEqual({
      ok: true,
      from: 'suggest',
      to: 'draft',
      verifiedWinCount: 3,
      consumeReceiptIds: ['wr-1', 'wr-2', 'wr-3'],
    })
  })

  it('fails closed on self-widen, skip, miss polarity, scope laundering, and consumption', () => {
    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'mubot_or_agent',
        wins: mintWins(store, ['wr-1'], scope),
        requiredWins: 1,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'mubot_cannot_self_widen' })

    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'suggest',
        proposed: 'execute',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: mintWins(store, ['wr-1', 'wr-2', 'wr-3'], scope),
        requiredWins: 3,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'skip_not_allowed' })

    expect(verifiedWinRefFromResolver(store, 'wr-miss', scope)).toEqual({
      ok: false,
      reason: 'not_a_win',
    })
    expect(verifiedWinRefFromResolver(store, 'wr-other-proj', scope)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    })
    expect(verifiedWinRefFromResolver(store, 'wr-other-agent', scope)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    })

    // Win laundering: mint against sandbox, attempt widen on customer project.
    const sandboxWins = mintWins(
      store,
      ['wr-other-proj'],
      { projectId: 'sandbox', agentId: 'agent-a' },
    )
    expect(
      decideEarnedAutonomyWiden({
        projectId: 'proj-a',
        agentId: 'agent-a',
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: sandboxWins,
        requiredWins: 3,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'scope_mismatch' })

    const wins = mintWins(store, ['wr-1', 'wr-2', 'wr-3'], scope)
    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'draft',
        proposed: 'execute_with_approval',
        actingPrincipalKind: 'owner_or_admin_human',
        wins,
        requiredWins: 3,
        consumedReceiptIds: ['wr-1', 'wr-2', 'wr-3'],
      }),
    ).toEqual({ ok: false, reason: 'win_already_consumed' })

    // Dedup: same receipt thrice does not count as three wins.
    const one = mintWins(store, ['wr-1'], scope)[0]
    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'suggest',
        proposed: 'draft',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: [one, one, one],
        requiredWins: 3,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'insufficient_verified_wins' })

    // Floor: requiredWins < 3 rejected.
    expect(
      decideEarnedAutonomyWiden({
        projectId: scope.projectId,
        agentId: scope.agentId,
        current: 'execute_with_approval',
        proposed: 'execute',
        actingPrincipalKind: 'owner_or_admin_human',
        wins: mintWins(store, ['wr-1'], scope),
        requiredWins: 1,
        consumedReceiptIds: [],
      }),
    ).toEqual({ ok: false, reason: 'required_wins_invalid' })
  })
})

describe('honest progress and visible learning', () => {
  it('v1 ships unmeasured — agent KPI sources cannot measure a project', () => {
    expect(
      decideProgressDisplay({
        outcome: {
          statement: 'Booked calls',
          metric: { sourceId: 'task_counter', target: 20 },
          measurementMode: 'unmeasured_until_project_kpi',
        },
        signal: { ok: true, value: 20, sourceId: 'task_counter' },
      }),
    ).toEqual({ kind: 'unmeasured' })
  })

  it('measured path requires allowlisted KpiSourceId and matching signal — no sourceWired boolean', () => {
    expect(
      decideProgressDisplay({
        outcome: {
          statement: 'PRs',
          metric: { sourceId: 'github_prs', target: 10 },
          measurementMode: 'measured',
        },
        signal: { ok: true, value: 5, sourceId: 'github_prs' },
      }),
    ).toEqual({ kind: 'measured', value: 5, target: 10, ratio: 0.5 })
    expect(
      decideProgressDisplay({
        outcome: {
          statement: 'PRs',
          metric: { sourceId: 'github_prs', target: 10 },
          measurementMode: 'measured',
        },
        signal: { ok: true, value: 5, sourceId: 'task_counter' },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'source_id_mismatch' })
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

  it('requires Know+Watch; Talk optional while #505 is closed-unmerged', () => {
    expect(() => assertOwnerHomeFacets(['know', 'watch'])).not.toThrow()
    expect(() => assertOwnerHomeFacets(['talk', 'know', 'watch'])).not.toThrow()
    expect(() => assertOwnerHomeFacets(['talk', 'watch'])).toThrow(/owner_experience_facet_missing/)
    expect(brainRemainsRankNotAct()).toBe(true)
  })
})
