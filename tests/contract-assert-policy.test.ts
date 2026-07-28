import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkJsonTsMirrors,
  checkLifecycleDeclarations,
  checkLifecycleValues,
  checkTestSourceLifecycle,
  checkTestSourceMirrors,
  getJsonValue,
  policyFindingsInclude,
  runContractAssertPolicy,
  type ContractAssertPolicySpec,
  type PolicyFindingCode,
} from '../src/contracts/contract-assert-policy'

const ownerFixtureJson = JSON.parse(
  readFileSync(new URL('./fixtures/contract-assert-policy/owner-experience-v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

const OWNER_EXPERIENCE_FACETS = ['talk', 'know', 'watch'] as const
const OWNER_EXPERIENCE_LOOP = [
  'goal',
  'sense',
  'rank',
  'act',
  'receipt',
  'learn',
  'adapt',
  'gate',
] as const
const OWNER_EXPERIENCE_PRINCIPLES = [
  'one-face',
  'goals-not-tasks',
  'honest-by-construction',
  'earned-autonomy',
  'visible-learning',
  'owner-owns-goals-and-gates',
] as const
const OWNER_TRUST_LADDER = ['suggest', 'draft', 'execute_with_approval', 'execute'] as const
const DEFAULT_REQUIRED_WINS_PER_WIDEN = 3
const WIN_CONSUMPTION_POLICY = 'mark_consumed_after_successful_widen' as const

const ownerSpec: ContractAssertPolicySpec = {
  lifecycleFields: [
    {
      field: 'status',
      allowedValues: ['design', 'dyad-gate', 'live'],
      whoMayFlip: ['loom', 'kasra', 'athena-gate'],
    },
  ],
  jsonTsMirrors: [
    { jsonPath: ['facets'], tsExportName: 'OWNER_EXPERIENCE_FACETS' },
    { jsonPath: ['loop'], tsExportName: 'OWNER_EXPERIENCE_LOOP' },
    { jsonPath: ['principles'], tsExportName: 'OWNER_EXPERIENCE_PRINCIPLES' },
    {
      jsonPath: ['earnedAutonomy', 'defaultRequiredWins'],
      tsExportName: 'DEFAULT_REQUIRED_WINS_PER_WIDEN',
    },
    {
      jsonPath: ['earnedAutonomy', 'winConsumptionPolicy'],
      tsExportName: 'WIN_CONSUMPTION_POLICY',
    },
  ],
}

const ownerTsExports: Record<string, unknown> = {
  OWNER_EXPERIENCE_FACETS,
  OWNER_EXPERIENCE_LOOP,
  OWNER_EXPERIENCE_PRINCIPLES,
  DEFAULT_REQUIRED_WINS_PER_WIDEN,
  WIN_CONSUMPTION_POLICY,
}

const compliantOwnerTestSource = `
describe('owner-experience/v1 contract doc', () => {
  it('matches the pure module facets, loop, and trust ladder', () => {
    const allowedStatuses = ['design', 'dyad-gate', 'live']
    expect(allowedStatuses).toContain(contract.status)
    expect(contract.facets).toEqual([...OWNER_EXPERIENCE_FACETS])
    expect(contract.loop).toEqual([...OWNER_EXPERIENCE_LOOP])
    expect(contract.principles).toEqual([...OWNER_EXPERIENCE_PRINCIPLES])
    expect(contract.earnedAutonomy.defaultRequiredWins).toBe(DEFAULT_REQUIRED_WINS_PER_WIDEN)
    expect(contract.earnedAutonomy.winConsumptionPolicy).toBe(WIN_CONSUMPTION_POLICY)
    expect(contract.trustLevels.map((row) => row.autonomy)).toEqual([...OWNER_TRUST_LADDER])
  })
})
`

function expectFinding(
  findings: readonly { code: PolicyFindingCode }[],
  code: PolicyFindingCode,
): void {
  expect(policyFindingsInclude(findings, code)).toBe(true)
}

describe('contract-assert-policy helpers', () => {
  it('reads nested JSON paths', () => {
    expect(getJsonValue(ownerFixtureJson, ['earnedAutonomy', 'winConsumptionPolicy'])).toBe(
      WIN_CONSUMPTION_POLICY,
    )
  })

  it('passes on compliant owner-experience fixture + test source', () => {
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: ownerFixtureJson,
      tsExports: ownerTsExports,
      testSource: compliantOwnerTestSource,
    })
    expect(findings).toEqual([])
  })
})

describe('rule 1 — lifecycle membership, not literal equality', () => {
  it('flags missing allowedValues or whoMayFlip in spec', () => {
    expectFinding(
      checkLifecycleDeclarations({
        lifecycleFields: [
          {
            field: 'status',
            allowedValues: [],
            whoMayFlip: ['loom'],
          },
        ],
        jsonTsMirrors: [],
      }),
      'lifecycle_missing_allowed_values',
    )
    expectFinding(
      checkLifecycleDeclarations({
        lifecycleFields: [
          {
            field: 'phase',
            allowedValues: ['design'],
            whoMayFlip: [],
          },
        ],
        jsonTsMirrors: [],
      }),
      'lifecycle_missing_who_may_flip',
    )
  })

  it('flags contract lifecycle values outside declared allowed set', () => {
    const findings = checkLifecycleValues(
      {
        lifecycleFields: [
          {
            field: 'status',
            allowedValues: ['design', 'live'],
            whoMayFlip: ['loom'],
          },
        ],
        jsonTsMirrors: [],
      },
      { ...ownerFixtureJson, status: 'shipped-without-gate' },
    )
    expectFinding(findings, 'lifecycle_value_not_in_allowed_set')
  })

  it('flags single-literal lifecycle assertions in test source', () => {
    const badTest = `
      it('bad', () => {
        expect(contract.status).toBe('design')
      })
    `
    const findings = checkTestSourceLifecycle(badTest, ownerSpec.lifecycleFields)
    expectFinding(findings, 'lifecycle_test_literal_equality')
  })
})

describe('rule 2 — JSON↔TS mirrors via TS exports', () => {
  it('flags missing TS export for a declared mirror', () => {
    const findings = checkJsonTsMirrors(
      {
        lifecycleFields: [],
        jsonTsMirrors: [{ jsonPath: ['facets'], tsExportName: 'MISSING_FACETS' }],
      },
      ownerFixtureJson,
      ownerTsExports,
    )
    expectFinding(findings, 'json_ts_mirror_missing_ts_constant')
  })

  it('flags JSON value drift from TS export', () => {
    const findings = checkJsonTsMirrors(ownerSpec, ownerFixtureJson, {
      ...ownerTsExports,
      WIN_CONSUMPTION_POLICY: 'never_consume_wins',
    })
    expectFinding(findings, 'json_ts_mirror_value_mismatch')
  })

  it('flags retyped literals and missing TS assertion in tests', () => {
    const literalTest = `
      expect(contract.facets).toEqual(['talk', 'know', 'watch'])
    `
    const findings = checkTestSourceMirrors(literalTest, ownerSpec.jsonTsMirrors)
    expectFinding(findings, 'json_ts_mirror_literal_in_test')
    expectFinding(findings, 'json_ts_mirror_assertion_token_absent')

    const missingMirrorTest = `
      expect(contract.loop).toEqual(['goal', 'sense'])
    `
    const missingFindings = checkTestSourceMirrors(missingMirrorTest, [
      { jsonPath: ['loop'], tsExportName: 'OWNER_EXPERIENCE_LOOP' },
    ])
    expectFinding(missingFindings, 'json_ts_mirror_literal_in_test')
  })
})

describe('mutation — deliberate fixture breaks must fire the checker', () => {
  it('mutation A: lifecycle literal equality in test', () => {
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: ownerFixtureJson,
      tsExports: ownerTsExports,
      testSource: `expect(contract.status).toBe('design')`,
    })
    expectFinding(findings, 'lifecycle_test_literal_equality')
  })

  it('mutation B: lifecycle value outside allowed set', () => {
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: { ...ownerFixtureJson, status: 'production' },
      tsExports: ownerTsExports,
      testSource: compliantOwnerTestSource,
    })
    expectFinding(findings, 'lifecycle_value_not_in_allowed_set')
  })

  it('mutation C: missing whoMayFlip declaration', () => {
    const findings = runContractAssertPolicy({
      spec: {
        ...ownerSpec,
        lifecycleFields: [
          {
            field: 'status',
            allowedValues: ['design'],
            whoMayFlip: [],
          },
        ],
      },
      contractJson: ownerFixtureJson,
      tsExports: ownerTsExports,
      testSource: compliantOwnerTestSource,
    })
    expectFinding(findings, 'lifecycle_missing_who_may_flip')
  })

  it('mutation D: missing TS constant for mirror', () => {
    const { OWNER_EXPERIENCE_FACETS: _drop, ...partialExports } = ownerTsExports
    void _drop
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: ownerFixtureJson,
      tsExports: partialExports,
      testSource: compliantOwnerTestSource,
    })
    expectFinding(findings, 'json_ts_mirror_missing_ts_constant')
  })

  it('mutation E: retyped literal mirror assertion in test', () => {
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: ownerFixtureJson,
      tsExports: ownerTsExports,
      testSource: `
        expect(['design']).toContain(contract.status)
        expect(contract.facets).toEqual(['talk', 'know', 'watch'])
      `,
    })
    expectFinding(findings, 'json_ts_mirror_literal_in_test')
  })

  it('mutation F: JSON/TS drift on mirrored constant', () => {
    const findings = runContractAssertPolicy({
      spec: ownerSpec,
      contractJson: ownerFixtureJson,
      tsExports: {
        ...ownerTsExports,
        DEFAULT_REQUIRED_WINS_PER_WIDEN: 1,
      },
      testSource: compliantOwnerTestSource,
    })
    expectFinding(findings, 'json_ts_mirror_value_mismatch')
  })
})
