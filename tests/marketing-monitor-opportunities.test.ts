import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareMarketingRecommendation,
  runMarketingMonitor,
  type MarketingMonitorSourceFactory,
} from '../src/addons/marketing/service'
import { rankMarketingOpportunities } from '../src/addons/marketing/opportunities'
import {
  activateAddon,
  archiveAddon,
  configureAddon,
  disableAddon,
  installAddon,
  listAddonInstallations,
} from '../src/addons/service'
import type { MarketingMonitorRun } from '../src/addons/marketing/types'
import {
  loadMarketingCroMonitorView,
  marketingCroMonitorBody,
} from '../src/dashboard/marketing-cro-monitor'
import type { Env } from '../src/types'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0002_members.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0004_channels.sql',
  '../migrations/0005_channel_capability_grants.sql',
  '../migrations/0006_task_results.sql',
  '../migrations/0007_gates.sql',
  '../migrations/0008_gate_grants.sql',
  '../migrations/0009_work_unit.sql',
  '../migrations/0010_execution_meter.sql',
  '../migrations/0011_meter_cost.sql',
  '../migrations/0012_workflow_pipeline.sql',
  '../migrations/0013_outbound_acts.sql',
  '../migrations/0016_presence.sql',
  '../migrations/0017_flights.sql',
  '../migrations/0019_agent_token_binding.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0026_task_done_when.sql',
  '../migrations/0028_metric_points.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0040_members_tenant.sql',
  '../migrations/0042_task_status_gate_values.sql',
  '../migrations/0043_member_tokens_tenant.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
  '../migrations/0053_marketing_monitor_runs.sql',
  '../migrations/0054_marketing_recommendations.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const owner = { id: 'owner-1', role: 'owner' as const }
const window = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T23:59:59.999Z',
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'tenant-a',
    GITHUB_REPO: 'example/should-not-be-called',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function fixtureFactory(): MarketingMonitorSourceFactory {
  return ({ runId, window: requestedWindow }) => [createMarketingMonitorFixtureSource({
    runId,
    observedAt: '2026-07-01T12:00:00.000Z',
    window: requestedWindow,
  })]
}

async function createActiveRun(env: Env): Promise<MarketingMonitorRun> {
  expect(await installAddon(env, owner, 'marketing-cro-monitor'))
    .toEqual(expect.objectContaining({ ok: true }))
  expect(await configureAddon(env, owner, 'marketing-cro-monitor', {
    bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
  })).toEqual(expect.objectContaining({ ok: true }))
  expect(await activateAddon(env, owner, 'marketing-cro-monitor'))
    .toEqual(expect.objectContaining({ ok: true }))
  const result = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
  expect(result).toEqual(expect.objectContaining({ ok: true }))
  if (!result.ok) throw new Error(`monitor run failed: ${result.reason}`)
  return result.run
}

describe('marketing monitor opportunities', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const migration of migrations) harness.sqlite.exec(migration)
    harness.sqlite.prepare(`
      INSERT INTO org_settings (key, value) VALUES ('billing_state', ?)
    `).run(JSON.stringify({
      tier: 'scale',
      event_id: 'recommendation-tests',
      effective_at: '2026-07-16T00:00:00.000Z',
    }))
    env = envFor(harness)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    harness.close()
  })

  it('ranks the same bounded candidates deterministically', async () => {
    const run = await createActiveRun(env)

    const first = rankMarketingOpportunities(run)
    const second = rankMarketingOpportunities(run)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(5)
    expect(first[0]).toMatchObject({
      kind: 'conversion_review',
      target: 'resource:web-ops/conversion-funnel',
      primaryKpi: 'conversion',
      kpiBaseline: { status: 'available', value: 0.05, unit: 'ratio' },
    })
  })

  it('creates at most one recommendation, task, and flight for the same evidence window', async () => {
    const run = await createActiveRun(env)

    const first = await prepareMarketingRecommendation(env, owner, run.id)
    const second = await prepareMarketingRecommendation(env, owner, run.id)

    expect(first).toEqual(expect.objectContaining({ ok: true, idempotent: false }))
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      idempotent: true,
      recommendation: expect.objectContaining({
        id: first.ok ? first.recommendation.id : '',
      }),
    }))
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_recommendations').get())
      .toEqual({ count: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get())
      .toEqual({ count: 1 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM flights').get())
      .toEqual({ count: 1 })
  })

  it('never calls an external executor or task mirror', async () => {
    const executorCalls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (...args: unknown[]) => {
      executorCalls.push(args)
      return new Response(null, { status: 204 })
    }))
    const run = await createActiveRun(env)

    await prepareMarketingRecommendation(env, owner, run.id)

    expect(executorCalls).toEqual([])
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM outbound_acts').get())
      .toEqual({ count: 0 })
  })

  it.each(['disabled', 'archived'] as const)(
    '%s installations cannot create recommendations',
    async (state) => {
      const run = await createActiveRun(env)
      expect(await disableAddon(env, owner, 'marketing-cro-monitor'))
        .toEqual(expect.objectContaining({ ok: true }))
      if (state === 'archived') {
        expect(await archiveAddon(env, owner, 'marketing-cro-monitor'))
          .toEqual(expect.objectContaining({ ok: true }))
      }

      expect(await prepareMarketingRecommendation(env, owner, run.id))
        .toEqual({ ok: false, reason: 'addon_not_active' })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_recommendations').get())
        .toEqual({ count: 0 })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get())
        .toEqual({ count: 0 })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM flights').get())
        .toEqual({ count: 0 })
    },
  )

  it('carries unavailable evidence honestly instead of converting it to zero', async () => {
    const run = await createActiveRun(env)
    await prepareMarketingRecommendation(env, owner, run.id)

    const row = harness.sqlite.prepare(`
      SELECT kpi_baseline_json, limiting_evidence_json
        FROM marketing_recommendations
    `).get() as { kpi_baseline_json: string; limiting_evidence_json: string }
    expect(JSON.parse(row.kpi_baseline_json)).toEqual({
      status: 'available',
      value: 0.05,
      unit: 'ratio',
      source: 'first-party',
      observedAt: '2026-07-01T12:00:00.000Z',
    })
    expect(JSON.parse(row.limiting_evidence_json)).toEqual([
      { outcome: 'revenue', status: 'unavailable', reason: 'authoritative_source_missing' },
    ])
    expect(row.limiting_evidence_json).not.toContain('"value":0')
  })

  it('persists approval gate metadata, review terminals, safe linkage, and a receipt digest', async () => {
    const run = await createActiveRun(env)
    const result = await prepareMarketingRecommendation(env, owner, run.id)
    expect(result).toEqual(expect.objectContaining({ ok: true }))

    const recommendation = harness.sqlite.prepare(`
      SELECT approval_required, approval_action, required_capability, self_approval,
             terminal_action, task_id, flight_id, receipt_digest, status
        FROM marketing_recommendations
    `).get() as Record<string, unknown>
    expect(recommendation).toMatchObject({
      approval_required: 1,
      approval_action: 'promote_recommendation',
      required_capability: 'owner',
      self_approval: 0,
      terminal_action: 'recommendation_ready',
      status: 'ready',
    })
    expect(recommendation.receipt_digest).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/))

    const task = harness.sqlite.prepare('SELECT id, status, gate_owner FROM tasks').get()
    expect(task).toEqual({
      id: recommendation.task_id,
      status: 'review',
      gate_owner: 'gate:addons:marketing-cro-monitor:promote_recommendation',
    })
    const flight = harness.sqlite.prepare('SELECT id, status, meta FROM flights').get() as {
      id: string
      status: string
      meta: string
    }
    expect(flight.id).toBe(recommendation.flight_id)
    expect(flight.status).toBe('preflight')
    expect(JSON.parse(flight.meta)).toMatchObject({
      terminal_action: 'recommendation_ready',
      executor: null,
      task_ids: [recommendation.task_id],
    })
  })

  it('surfaces governed work through safe task and flight references without rendering raw IDs', async () => {
    const run = await createActiveRun(env)
    const prepared = await prepareMarketingRecommendation(env, owner, run.id)
    expect(prepared).toEqual(expect.objectContaining({ ok: true }))
    if (!prepared.ok) return
    const installation = (await listAddonInstallations(env))[0]
    const view = await loadMarketingCroMonitorView(env, installation, owner)
    const rendered = String(marketingCroMonitorBody(view))

    expect(rendered).toContain('Owner approval required')
    expect(rendered).toContain('href="/approvals"')
    expect(rendered).toContain('href="/flights"')
    expect(rendered).not.toContain(prepared.recommendation.taskId)
    expect(rendered).not.toContain(prepared.recommendation.flightId)
  })
})
