import { describe, expect, it } from 'vitest'
import type { AddonBinding } from '../src/addons/bindings'
import type { MarketingMonitorRun } from '../src/addons/marketing/types'
import type { AddonInstallation } from '../src/addons/service'
import {
  loadMarketingCroMonitorView,
  marketingCroMonitorBody,
} from '../src/dashboard/marketing-cro-monitor'
import type { Env } from '../src/types'

const installation: AddonInstallation = {
  id: 'installation-1',
  tenant: 'tenant-a',
  addonKey: 'marketing-cro-monitor',
  installedVersion: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  manifestSha256: 'a'.repeat(64),
  mupotCompatibility: '^0.23.0',
  state: 'active',
  latestPreviousState: 'configured',
  installedBy: 'owner-1',
  latestActorId: 'owner-1',
  latestReceiptId: 'receipt-secret',
  installedAt: '2026-07-01T00:00:00.000Z',
  configuredAt: '2026-07-01T00:01:00.000Z',
  activatedAt: '2026-07-01T00:02:00.000Z',
  disabledAt: null,
  archivedAt: null,
  updatedAt: '2026-07-01T00:02:00.000Z',
  lastError: null,
}

const binding: AddonBinding = {
  id: 'binding-secret',
  tenant: 'tenant-a',
  installationId: installation.id,
  generationId: 'generation-secret',
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
  capability: 'read',
  connectorId: 'connector-secret',
  manifestSha256: 'b'.repeat(64),
  configuredBy: 'operator-secret',
  configuredAt: '2026-07-01T00:01:00.000Z',
  revokedAt: null,
}

const run: MarketingMonitorRun = {
  id: 'run-1',
  programVersion: 'marketing-cro-monitor-v1',
  status: 'completed',
  window: {
    start: '2026-07-01T00:00:00.000Z',
    end: '2026-07-01T23:59:59.999Z',
  },
  sourceCount: 1,
  observationCount: 5,
  rawObservationCount: 5,
  sources: [{
    key: 'source-key-secret',
    slot: 'web_analytics',
    status: 'available',
    observationCount: 5,
  }],
  observations: [{
    id: 'observation-secret',
    runId: 'run-1',
    metricKey: 'seo.organic_sessions',
    value: 240,
    unit: 'count',
    authority: 'first-party',
    observedAt: '2026-07-01T12:00:00.000Z',
    sourceKey: 'source-key-secret',
    sourceSlot: 'web_analytics',
  }],
  outcomes: {
    visibility: { status: 'available', value: 8, unit: 'count', source: 'first-party', observedAt: '2026-07-01T12:00:00.000Z' },
    qualifiedTraffic: { status: 'available', value: 240, unit: 'count', source: 'first-party', observedAt: '2026-07-01T12:00:00.000Z' },
    leads: { status: 'available', value: 12, unit: 'count', source: 'first-party', observedAt: '2026-07-01T12:00:00.000Z' },
    conversion: { status: 'available', value: 0.05, unit: 'ratio', source: 'first-party', observedAt: '2026-07-01T12:00:00.000Z' },
    revenue: { status: 'unavailable', reason: 'authoritative_source_missing' },
  },
  evidenceDigest: 'c'.repeat(64),
  createdAt: '2026-07-01T12:00:00.000Z',
  completedAt: '2026-07-01T12:00:01.000Z',
}

const env = { TENANT_SLUG: 'tenant-a' } as Env
const actor = { id: 'owner-1', role: 'owner' as const }

async function loadedView() {
  return loadMarketingCroMonitorView(env, installation, actor, {
    listBindings: async () => [binding],
    getLatestRun: async () => ({ ok: true, run }),
    listRuns: async () => ({ ok: true, runs: [run] }),
  })
}

describe('marketing CRO monitor dashboard', () => {
  it('consumes bindings and run reads without exposing connector or observation metadata', async () => {
    const view = await loadedView()
    const serialized = JSON.stringify(view)

    expect(view.sourceHealth[0]).toEqual({
      slot: 'web_analytics',
      label: 'Web analytics',
      adapter: 'first_party',
      status: 'available',
      detail: '5 observations',
    })
    for (const forbidden of [
      'binding-secret',
      'connector-secret',
      'generation-secret',
      'operator-secret',
      'source-key-secret',
      'observation-secret',
      'receipt-secret',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('renders outcomes, source health, runs, and unavailable revenue honestly', async () => {
    const html = String(marketingCroMonitorBody(await loadedView()))

    expect(html).toContain('AI visibility')
    expect(html).toContain('Qualified traffic')
    expect(html).toContain('Source health')
    expect(html).toContain('Recent runs')
    expect(html).toContain('Revenue')
    expect(html).toContain('Unavailable')
    expect(html).not.toMatch(/Revenue[\s\S]{0,100}>0</)
    expect(html).toContain('c'.repeat(12))
    expect(html).toContain('href="/api/addons/marketing-cro-monitor/monitor/latest"')
    expect(html).toContain('href="/api/addons/marketing-cro-monitor/receipts"')
  })

  it('keeps the monitor surface within a 390px viewport without client data loading', async () => {
    const html = String(marketingCroMonitorBody(await loadedView()))

    expect(html).toContain('@media (max-width: 680px)')
    expect(html).toContain('minmax(0, 1fr)')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('fetch(')
  })

  it('preserves unavailable reads instead of converting them to empty or zero values', async () => {
    const view = await loadMarketingCroMonitorView(env, installation, actor, {
      listBindings: async () => { throw new Error('bindings offline') },
      getLatestRun: async () => ({ ok: false, reason: 'write_failed' }),
      listRuns: async () => ({ ok: false, reason: 'write_failed' }),
    })
    const html = String(marketingCroMonitorBody(view))

    expect(view.sourceHealth).toBeNull()
    expect(view.outcomes).toBeNull()
    expect(view.recentRuns).toBeNull()
    expect(html).toContain('Monitor data unavailable')
    expect(html).not.toMatch(/(?:AI visibility|Qualified traffic|Leads|Conversion|Revenue)[\s\S]{0,80}>0</)
  })
})
