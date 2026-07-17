import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADDON_KEY,
  EXPECTED_PHASES,
  RECEIPT_TYPE,
  formatPlan,
  parseArgs,
  runMarketingMonitorLifecycleCheck,
  validateReceipt,
} from '../scripts/marketing-monitor-lifecycle-receipt.mjs'

const SHA = 'a'.repeat(64)
const RECEIPT_COUNT = 10

const WINDOW = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T23:59:59.999Z',
}

function validReceipt() {
  return {
    receipt_type: RECEIPT_TYPE,
    status: 'pass',
    addon_key: ADDON_KEY,
    phases: [...EXPECTED_PHASES],
    manifest_sha256: SHA,
    installed_version: '1.0.0',
    publisher: 'mumega',
    trust_class: 'native_reviewed',
    monitor_run_ids: ['run-1', 'run-2'],
    recommendation_visible: true,
    recommendation_links: { review_task: true, flight_record: true },
    archive_ownership_claim_count: 0,
    secrets_present: false,
    unavailable_not_zero: true,
    receipt_sequences: Array.from({ length: RECEIPT_COUNT }, (_, index) => index + 1),
    receipt_created_at: Array.from({ length: RECEIPT_COUNT }, (_, index) => `2026-07-01T00:00:${String(index + 1).padStart(2, '0')}.000Z`),
  }
}

function monitorRun(id: string, mutate: Record<string, unknown> = {}) {
  return {
    id,
    status: 'completed',
    window: WINDOW,
    sourceCount: 1,
    observationCount: 4,
    sources: [{ slot: 'web_analytics', status: 'available', observationCount: 4 }],
    outcomes: {
      visibility: { status: 'unavailable', reason: 'authoritative_source_missing' },
      qualifiedTraffic: { status: 'available', value: 44, unit: 'count', source: 'web_analytics' },
      leads: { status: 'available', value: 7, unit: 'count', source: 'web_analytics' },
      conversion: { status: 'available', value: 0.16, unit: 'ratio', source: 'web_analytics' },
      revenue: { status: 'unavailable', reason: 'authoritative_source_missing' },
    },
    evidenceDigest: 'b'.repeat(64),
    completedAt: '2026-07-01T00:10:00.000Z',
    ...mutate,
  }
}

function createFetch(options: {
  mutateReceipt?: (receipt: Record<string, unknown>, index: number) => Record<string, unknown>
  mutateRun?: (run: Record<string, unknown>, ordinal: number) => Record<string, unknown>
  consoleHtml?: string
  archiveOwnershipClaimCount?: number
  manifestSha256?: string
  latestManifestSha256?: string
} = {}) {
  const calls: Array<{ path: string; method: string; authorization: string | null; cookie: string | null; body: string }> = []
  let transitionIndex = 0
  let runIndex = 0
  let latestRun: Record<string, unknown> | null = null
  let latestState: string | null = null
  const receipts: Array<Record<string, unknown>> = []
  const states = ['installed', 'configured', 'active', 'disabled', 'archived', 'installed', 'configured', 'active', 'disabled', 'archived']
  const actions = ['install', 'configure', 'activate', 'disable', 'archive', 'install', 'configure', 'activate', 'disable', 'archive']

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ path: url.pathname + url.search, method, authorization: headers.get('authorization'), cookie: headers.get('cookie'), body })

    if (url.pathname === `/api/addons/${ADDON_KEY}/evidence`) {
      return Response.json({
        businessStateSha256: 'c'.repeat(64),
        manifestSha256: transitionIndex === 0
          ? options.manifestSha256 ?? SHA
          : options.latestManifestSha256 ?? options.manifestSha256 ?? SHA,
        installedVersion: '1.0.0',
        mupotCompatibility: '^0.23.0',
        publisher: 'mumega',
        trustClass: 'native_reviewed',
      })
    }
    if (url.pathname === `/api/addons/${ADDON_KEY}/receipts`) {
      return Response.json({
        receipts: [...receipts].reverse(),
        ownershipClaimCount: latestState === 'archived' ? options.archiveOwnershipClaimCount ?? 0 : 0,
        departmentStateSha256: 'd'.repeat(64),
      })
    }
    if (url.pathname === '/api/addons') {
      return Response.json({ addons: [{ key: ADDON_KEY, state: latestState }] })
    }
    if (url.pathname === `/api/addons/${ADDON_KEY}/monitor` && method === 'POST') {
      runIndex += 1
      latestRun = options.mutateRun?.(monitorRun(`run-${runIndex}`), runIndex) ?? monitorRun(`run-${runIndex}`)
      return Response.json({ ok: true, idempotent: false, run: latestRun }, { status: 201 })
    }
    if (url.pathname === `/api/addons/${ADDON_KEY}/recommendation` && method === 'POST') {
      return Response.json({
        ok: true,
        idempotent: false,
        recommendation: {
          kind: 'conversion_review',
          target: 'resource:web-ops/conversion-funnel',
          problem: 'Conversion needs review.',
          hypothesis: 'A reviewed experiment can improve conversion.',
          primaryKpi: 'conversion',
          kpiBaseline: { status: 'available', value: 0.16, unit: 'ratio', source: 'web_analytics' },
          limitingEvidence: [{ outcome: 'revenue', status: 'unavailable', reason: 'authoritative_source_missing' }],
          evidenceDigest: 'b'.repeat(64),
          approval: { required: true, action: 'promote_recommendation', requiredCapability: 'owner', selfApproval: false },
          terminalAction: 'recommendation_ready',
          receiptDigest: 'f'.repeat(64),
          createdAt: '2026-07-01T00:11:00.000Z',
          preparedAt: '2026-07-01T00:12:00.000Z',
          links: { reviewTask: '/approvals', flightRecord: '/flights' },
        },
      }, { status: 201 })
    }
    if (url.pathname === `/api/addons/${ADDON_KEY}/monitor/latest`) {
      return Response.json({ run: latestRun })
    }
    if (url.pathname === `/api/addons/${ADDON_KEY}/monitor`) {
      return Response.json({ runs: latestRun ? [latestRun] : [] })
    }
    if (url.pathname === '/addons/marketing-cro-monitor') {
      return new Response(options.consoleHtml ?? '<strong>Unavailable</strong><a href="/approvals">Review task</a><a href="/flights">Flight record</a>', {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (url.pathname.startsWith(`/api/addons/${ADDON_KEY}/`)) {
      const action = url.pathname.split('/').at(-1)
      if (action !== actions[transitionIndex]) return Response.json({ error: 'unexpected_test_action' }, { status: 500 })
      const state = states[transitionIndex]
      const receipt = {
        sequence: transitionIndex + 1,
        action,
        previousState: transitionIndex === 0 || transitionIndex === 5 ? null : states[transitionIndex - 1],
        nextState: state,
        addonKey: ADDON_KEY,
        installedVersion: '1.0.0',
        manifestSha256: options.manifestSha256 ?? SHA,
        mupotCompatibility: '^0.23.0',
        publisher: 'mumega',
        trustClass: 'native_reviewed',
        outcome: 'pass',
        errorCode: null,
        createdAt: `2026-07-01T00:00:${String(transitionIndex + 1).padStart(2, '0')}.000Z`,
      }
      receipts.push(options.mutateReceipt?.(receipt, transitionIndex) ?? receipt)
      transitionIndex += 1
      latestState = state
      return Response.json({ ok: true, key: ADDON_KEY, state }, { status: action === 'install' ? 201 : 200 })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  return { fetch, calls }
}

describe('marketing monitor lifecycle receipt checker', () => {
  it('adds package plan and check commands', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['receipt:marketing-monitor:plan']).toBe(
      'node scripts/marketing-monitor-lifecycle-receipt.mjs --plan',
    )
    expect(pkg.scripts['receipt:marketing-monitor:check']).toBe(
      'node scripts/marketing-monitor-lifecycle-receipt.mjs --check',
    )
  })

  it('parses arguments and prints a no-write plan without credential values', () => {
    expect(parseArgs(['--check', '--base-url', 'https://pot.test/', '--token-env', 'MUPOT_BEARER'])).toMatchObject({
      check: true,
      baseUrl: 'https://pot.test',
      tokenEnv: 'MUPOT_BEARER',
    })
    const plan = formatPlan({ baseUrl: 'https://user:pass@pot.test', tokenEnv: 'MUPOT_BEARER' })
    expect(plan).toContain('Marketing/CRO monitor lifecycle evidence plan')
    expect(plan).toContain('/api/addons/marketing-cro-monitor/monitor')
    expect(plan).toContain('--token-env MUPOT_BEARER')
    expect(plan).not.toContain('user')
    expect(plan).not.toContain('pass')
    expect(plan).not.toContain('Bearer ')
  })

  it('accepts the exact complete receipt', () => {
    expect(validateReceipt(validReceipt())).toEqual({ ok: true, errors: [] })
  })

  it.each([
    ['missing phase', { phases: EXPECTED_PHASES.filter((phase) => phase !== 'recommendation_visible') }, 'phases_mismatch'],
    ['duplicate run id', { monitor_run_ids: ['run-1', 'run-1'] }, 'monitor_run_ids_invalid'],
    ['active archive claim', { archive_ownership_claim_count: 1 }, 'archive_ownership_claim_count_nonzero'],
    ['missing recommendation', { recommendation_visible: false }, 'recommendation_not_visible'],
    ['zero unavailable proof', { unavailable_not_zero: false }, 'unavailable_rendered_as_zero'],
  ])('rejects receipt with %s', (_label, patch, error) => {
    expect(validateReceipt({ ...validReceipt(), ...patch })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([error]),
    }))
  })

  it('performs install through reinstall and emits no bearer or raw task/flight ids', async () => {
    const bearer = 'owner-bearer-value-that-must-never-appear'
    const cookie = 'mupot_session=session-value-that-must-never-appear'
    const { fetch, calls } = createFetch()
    const receipt = await runMarketingMonitorLifecycleCheck(
      {
        baseUrl: 'https://pot.test',
        tokenEnv: 'MUPOT_OWNER_BEARER',
        sessionCookieEnv: 'MUPOT_SESSION_COOKIE',
        window: WINDOW,
      },
      { fetch, env: { MUPOT_OWNER_BEARER: bearer, MUPOT_SESSION_COOKIE: cookie } },
    )

    expect(receipt).toEqual(expect.objectContaining(validReceipt()))
    expect(receipt.monitor_run_ids).toEqual(['run-1', 'run-2'])
    expect(receipt.http_statuses).toEqual(expect.arrayContaining([
      { step: 'first_install', status: 201 },
      { step: 'first_monitor', status: 201 },
      { step: 'second_archive', status: 200 },
    ]))
    expect(calls.map(({ path, method }) => ({ path, method }))).toEqual(expect.arrayContaining([
      { path: `/api/addons/${ADDON_KEY}/install`, method: 'POST' },
      { path: `/api/addons/${ADDON_KEY}/configure`, method: 'POST' },
      { path: `/api/addons/${ADDON_KEY}/monitor`, method: 'POST' },
      { path: `/api/addons/${ADDON_KEY}/recommendation`, method: 'POST' },
      { path: '/addons/marketing-cro-monitor', method: 'GET' },
    ]))
    const consoleCall = calls.find((call) => call.path === '/addons/marketing-cro-monitor')
    expect(consoleCall).toMatchObject({
      authorization: null,
      cookie,
    })
    const configureBodies = calls.filter((call) => call.path.endsWith('/configure')).map((call) => JSON.parse(call.body))
    expect(configureBodies).toEqual([
      { bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }] },
      { bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }] },
    ])
    expect(JSON.stringify(receipt)).not.toContain(bearer)
    expect(JSON.stringify(receipt)).not.toContain(cookie)
    expect(JSON.stringify(receipt)).not.toContain('task-')
    expect(JSON.stringify(receipt)).not.toContain('flight-')
    expect(validateReceipt(receipt)).toEqual({ ok: true, errors: [] })
  })

  it('fails on duplicated source slots and unavailable values rendered as zero', async () => {
    const { fetch } = createFetch({
      mutateRun: (run) => ({
        ...run,
        sources: [
          { slot: 'web_analytics', status: 'available', observationCount: 4 },
          { slot: 'web_analytics', status: 'available', observationCount: 4 },
        ],
        outcomes: {
          ...(run.outcomes as Record<string, unknown>),
          revenue: { status: 'unavailable', value: 0, reason: 'authoritative_source_missing' },
        },
      }),
    })
    const receipt = await runMarketingMonitorLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER', sessionCookieEnv: 'MUPOT_SESSION_COOKIE', window: WINDOW },
      { fetch, env: { MUPOT_OWNER_BEARER: 'bearer', MUPOT_SESSION_COOKIE: 'mupot_session=test' } },
    )

    expect(receipt.status).toBe('fail')
    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'monitor_sources_duplicated',
      'unavailable_rendered_as_zero',
    ]))
  })

  it('fails on manifest digest drift, missing recommendation links, and archive claims', async () => {
    const { fetch } = createFetch({
      latestManifestSha256: 'e'.repeat(64),
      consoleHtml: '<main>No recommendation</main>',
      archiveOwnershipClaimCount: 1,
    })
    const receipt = await runMarketingMonitorLifecycleCheck(
      { baseUrl: 'https://pot.test', tokenEnv: 'MUPOT_OWNER_BEARER', sessionCookieEnv: 'MUPOT_SESSION_COOKIE', window: WINDOW },
      { fetch, env: { MUPOT_OWNER_BEARER: 'bearer', MUPOT_SESSION_COOKIE: 'mupot_session=test' } },
    )

    expect(receipt.status).toBe('fail')
    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'manifest_digest_drift',
      'recommendation_not_visible',
      'archive_ownership_claim_count_nonzero',
    ]))
  })
})
