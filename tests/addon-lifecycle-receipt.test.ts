import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADDON_KEY,
  EXPECTED_TRANSITIONS,
  FIXTURE_MANIFEST_SHA256,
  RECEIPT_TYPE,
  formatPlan,
  parseArgs,
  runLifecycleCheck,
  validateReceipt,
} from '../scripts/addon-lifecycle-receipt.mjs'

function validReceipt() {
  return {
    receipt_type: RECEIPT_TYPE,
    status: 'pass',
    addon_key: ADDON_KEY,
    transitions: [...EXPECTED_TRANSITIONS],
    install_side_effect_count: 0,
    manifest_sha256: FIXTURE_MANIFEST_SHA256,
    secrets_present: false,
  }
}

const FIXTURE_RECEIPT_IDS = Object.freeze([
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
])

const LIFECYCLE_TRANSITIONS = Object.freeze([
  ['install', 'installed', 201],
  ['configure', 'configured', 200],
  ['activate', 'active', 200],
  ['disable', 'disabled', 200],
  ['activate', 'active', 200],
  ['disable', 'disabled', 200],
  ['archive', 'archived', 200],
])

function createLifecycleFetch(options: {
  beforeDepartments?: Array<Record<string, unknown>>
  afterDepartments?: Array<Record<string, unknown>>
  ownershipClaimCount?: unknown
  receiptIds?: readonly string[]
  receiptExtra?: Record<string, unknown>
  finalReceipts?: Array<Record<string, unknown>>
  catalogState?: string
} = {}) {
  const receipts: Array<Record<string, unknown>> = []
  const calls: Array<{ path: string; method: string; authorization: string | null; cookie: string | null }> = []
  const beforeDepartments = options.beforeDepartments ?? [{ id: 'existing', slug: 'existing' }]
  const afterDepartments = options.afterDepartments ?? beforeDepartments
  let transitionIndex = 0
  let departmentReadCount = 0
  let receiptReadCount = 0

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    calls.push({
      path: url.pathname,
      method,
      authorization: headers.get('authorization'),
      cookie: headers.get('cookie'),
    })

    if (url.pathname === '/api/org/departments') {
      return Response.json({ departments: departmentReadCount++ === 0 ? beforeDepartments : afterDepartments })
    }
    if (url.pathname === '/api/addons') {
      return Response.json({ addons: [{ key: ADDON_KEY, state: options.catalogState ?? 'archived' }] })
    }
    if (url.pathname === '/api/addons/fixture-addon/receipts') {
      const listed = receiptReadCount++ === LIFECYCLE_TRANSITIONS.length
        ? options.finalReceipts ?? [...receipts].reverse()
        : [...receipts].reverse()
      return Response.json({ receipts: listed, ownershipClaimCount: options.ownershipClaimCount ?? 0 })
    }
    if (url.pathname.startsWith('/api/addons/fixture-addon/')) {
      const action = url.pathname.split('/').at(-1)
      if (transitionIndex === LIFECYCLE_TRANSITIONS.length && action === 'activate') {
        return Response.json({ error: 'invalid_state', state: null }, { status: 409 })
      }
      const expected = LIFECYCLE_TRANSITIONS[transitionIndex]
      if (!expected || action !== expected[0]) return Response.json({ error: 'unexpected_test_action' }, { status: 500 })
      transitionIndex += 1
      receipts.push({
        sequence: transitionIndex,
        id: options.receiptIds?.[transitionIndex - 1] ?? FIXTURE_RECEIPT_IDS[transitionIndex - 1],
        action,
        nextState: expected[1],
        addonKey: ADDON_KEY,
        outcome: 'pass',
        ...options.receiptExtra,
      })
      return Response.json({ ok: true, key: ADDON_KEY, state: expected[1] }, { status: expected[2] })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  return { fetch, calls }
}

describe('addon lifecycle receipt checker', () => {
  it('provides exact package plan and check commands', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['receipt:addon-lifecycle:plan']).toBe(
      'node scripts/addon-lifecycle-receipt.mjs --plan',
    )
    expect(pkg.scripts['receipt:addon-lifecycle:check']).toBe(
      'node scripts/addon-lifecycle-receipt.mjs --check',
    )
  })

  it('accepts the exact complete fixture lifecycle receipt', () => {
    expect(validateReceipt(validReceipt())).toEqual({ ok: true, errors: [] })
  })

  it('parses plan and check arguments without reading credentials', () => {
    expect(parseArgs(['--plan', '--base-url', 'https://pot.test/'])).toEqual({
      plan: true,
      check: false,
      help: false,
      baseUrl: 'https://pot.test',
      tokenEnv: '',
    })
    expect(parseArgs(['--check', '--token-env', 'MUPOT_OWNER_BEARER'])).toEqual({
      plan: false,
      check: true,
      help: false,
      baseUrl: '',
      tokenEnv: 'MUPOT_OWNER_BEARER',
    })
  })

  it('prints the exact no-write operator plan without credential values', () => {
    const plan = formatPlan({
      baseUrl: 'https://pot.test',
      tokenEnv: 'MUPOT_OWNER_BEARER',
    })

    expect(plan).toContain('Mupot native addon lifecycle evidence plan')
    expect(plan).toContain('GET /api/org/departments')
    expect(plan).toContain('POST /api/addons/fixture-addon/install')
    expect(plan).toContain('POST /api/addons/fixture-addon/archive')
    expect(plan).toContain('POST /api/addons/fixture-addon/activate -> 409 after archive')
    expect(plan).toContain('--token-env MUPOT_OWNER_BEARER')
    expect(plan).not.toContain('Bearer ')
  })

  it('redacts URL-embedded credentials from the no-write operator plan', () => {
    const username = 'plan-operator'
    const password = 'plan-password-value'
    const plan = formatPlan({
      baseUrl: `https://${username}:${password}@pot.test/`,
      tokenEnv: 'MUPOT_OWNER_BEARER',
    })

    expect(plan).toContain('--base-url https://pot.test')
    expect(plan).not.toContain(username)
    expect(plan).not.toContain(password)
  })

  it('rejects missing transitions', () => {
    const receipt = validReceipt()
    receipt.transitions = receipt.transitions.filter((state) => state !== 'configured')

    expect(validateReceipt(receipt)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining(['transitions_mismatch']),
    }))
  })

  it('rejects malformed manifest digests', () => {
    expect(validateReceipt({ ...validReceipt(), manifest_sha256: 'ABC123' })).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(['manifest_sha256_invalid']),
      }),
    )
  })

  it('rejects nonzero install side effects', () => {
    expect(validateReceipt({ ...validReceipt(), install_side_effect_count: 1 })).toEqual(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(['install_side_effect_count_nonzero']),
      }),
    )
  })

  it('rejects reactivation after archive', () => {
    expect(validateReceipt({
      ...validReceipt(),
      transitions: [...EXPECTED_TRANSITIONS, 'active'],
    })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining(['archived_reactivation']),
    }))
  })

  it('rejects raw authorization fields without copying their values', () => {
    const raw = `Bearer ${'sensitive-value-'.repeat(4)}`
    const result = validateReceipt({
      ...validReceipt(),
      http: [{ authorization: raw }],
    })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining(['sensitive_key_present']),
    }))
    expect(JSON.stringify(result)).not.toContain(raw)
  })

  it.each(['token', 'accessToken', 'client_secret', 'passwordHash'])(
    'rejects nested sensitive key %s',
    (key) => {
      const result = validateReceipt({
        ...validReceipt(),
        evidence: { nested: { [key]: 'redacted' } },
      })

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining(['sensitive_key_present']),
      }))
    },
  )

  it('fails when install mutates a complete department record or reports ownership claims', async () => {
    const { fetch } = createLifecycleFetch({
      beforeDepartments: [{ id: 'existing', slug: 'existing', active: true }],
      afterDepartments: [{ id: 'existing', slug: 'renamed', active: true }],
      ownershipClaimCount: 1,
    })
    const receipt = await runLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER' },
      { fetch, env: { MUPOT_OWNER_BEARER: 'owner-bearer-value' } },
    )

    expect(receipt).toEqual(expect.objectContaining({
      status: 'fail',
      install_side_effect_count: 2,
      failure_codes: expect.arrayContaining(['install_side_effect_count_nonzero']),
    }))
  })

  it.each([
    ['receipt id', (bearer: string) => ({ receiptIds: [bearer, ...FIXTURE_RECEIPT_IDS.slice(1)] })],
    ['innocuous receipt field', (bearer: string) => ({ receiptExtra: { observed: bearer } })],
  ])('fails closed without emitting a credential reflected through %s', async (_location, optionsForBearer) => {
    const bearer = 'owner-bearer-value-that-must-never-appear'
    const { fetch } = createLifecycleFetch(optionsForBearer(bearer))
    const receipt = await runLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER' },
      { fetch, env: { MUPOT_OWNER_BEARER: bearer } },
    )

    expect(receipt).toEqual(expect.objectContaining({
      status: 'fail',
      secrets_present: true,
    }))
    expect(JSON.stringify(receipt)).not.toContain(bearer)
  })

  it('fails when archived catalog state or final receipt evidence is incomplete', async () => {
    const { fetch } = createLifecycleFetch({
      catalogState: 'disabled',
      finalReceipts: [
        ...FIXTURE_RECEIPT_IDS.slice(0, 6).map((id, index) => ({
          sequence: index + 1,
          id,
          action: LIFECYCLE_TRANSITIONS[index][0],
          nextState: LIFECYCLE_TRANSITIONS[index][1],
          addonKey: ADDON_KEY,
          outcome: 'pass',
        })),
        {
          sequence: 8,
          id: FIXTURE_RECEIPT_IDS[0],
          action: 'install',
          nextState: 'installed',
          addonKey: ADDON_KEY,
          outcome: 'pass',
        },
      ],
    })
    const receipt = await runLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER' },
      { fetch, env: { MUPOT_OWNER_BEARER: 'owner-bearer-value' } },
    )

    expect(receipt).toEqual(expect.objectContaining({ status: 'fail' }))
    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'archived_catalog_state_invalid',
      'archived_receipts_invalid',
    ]))
  })

  it('performs the API lifecycle, records statuses and receipt IDs, and emits no bearer', async () => {
    const bearer = 'owner-bearer-value-that-must-never-appear'
    const { fetch, calls } = createLifecycleFetch()
    const receipt = await runLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER' },
      { fetch, env: { MUPOT_OWNER_BEARER: bearer } },
    )

    expect(receipt).toEqual(expect.objectContaining(validReceipt()))
    expect(receipt.receipt_ids).toEqual(FIXTURE_RECEIPT_IDS)
    expect(receipt.http_statuses).toEqual(expect.arrayContaining([
      { step: 'install', status: 201 },
      { step: 'archived_reactivation', status: 409 },
    ]))
    expect(calls.map(({ path, method }) => ({ path, method }))).toEqual(expect.arrayContaining([
      { path: '/api/org/departments', method: 'GET' },
      { path: '/api/addons/fixture-addon/install', method: 'POST' },
      { path: '/api/addons/fixture-addon/receipts', method: 'GET' },
      { path: '/api/addons', method: 'GET' },
    ]))
    expect(calls.every((call) => call.authorization === `Bearer ${bearer}`)).toBe(true)
    expect(calls.every((call) => call.cookie === `mupot_session=${encodeURIComponent(bearer)}`)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain(bearer)
    expect(validateReceipt(receipt)).toEqual({ ok: true, errors: [] })
  })
})
