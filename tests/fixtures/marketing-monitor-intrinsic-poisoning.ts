import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Env } from '../../src/types'
import {
  runMarketingMonitor,
  type RunMarketingMonitorResult,
} from '../../src/addons/marketing/service'
import { activateAddon, configureAddon, installAddon } from '../../src/addons/service'
import { createSqliteD1 } from '../helpers/sqlite-d1'

const migrations = [
  'migrations/0001_init.sql',
  'migrations/0002_members.sql',
  'migrations/0003_settings.sql',
  'migrations/0004_channels.sql',
  'migrations/0005_channel_capability_grants.sql',
  'migrations/0014_loops.sql',
  'migrations/0016_presence.sql',
  'migrations/0019_agent_token_binding.sql',
  'migrations/0023_connectors.sql',
  'migrations/0028_metric_points.sql',
  'migrations/0029_department_microkernel.sql',
  'migrations/0040_members_tenant.sql',
  'migrations/0043_member_tokens_tenant.sql',
  'migrations/0050_addons.sql',
  'migrations/0052_addon_bindings.sql',
  'migrations/0053_marketing_monitor_runs.sql',
]

const owner = { id: 'owner-1', role: 'owner' as const }
const window = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T23:59:59.999Z',
}

function throwsMessage(action: () => unknown, message: string): boolean {
  try {
    action()
    return false
  } catch (error) {
    return error instanceof Error && error.message === message
  }
}

async function canonicalEvidenceDigest(evidence: {
  readonly programVersion: string
  readonly window: unknown
  readonly sources: unknown
  readonly observations: unknown
  readonly outcomes: unknown
}): Promise<string> {
  const canonical = JSON.stringify({
    schema: 'mupot.marketing-monitor-evidence/v1',
    programVersion: evidence.programVersion,
    window: evidence.window,
    sources: evidence.sources,
    observations: evidence.observations,
    outcomes: evidence.outcomes,
  })
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function runMarketingMonitorIntrinsicPoisoning(): Promise<{
  readonly ok: true
  readonly observationCount: 1
  readonly directPoisonChecks: {
    readonly map: true
    readonly filter: true
    readonly some: true
    readonly textEncoder: true
    readonly outcomesJson: true
  }
}> {
  const harness = createSqliteD1()
  try {
    for (const migration of migrations) harness.sqlite.exec(readFileSync(migration, 'utf8'))
    harness.sqlite.prepare(`
      INSERT INTO org_settings (key, value) VALUES ('billing_state', ?)
    `).run(JSON.stringify({ tier: 'scale', event_id: 'monitor-tests', effective_at: '2026-07-16T00:00:00.000Z' }))
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as Env

    const installed = await installAddon(env, owner, 'marketing-cro-monitor')
    assert.equal(installed.ok, true)
    assert.equal((await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
    })).ok, true)
    assert.equal((await activateAddon(env, owner, 'marketing-cro-monitor')).ok, true)

    const originalDb = env.DB
    const originals = {
      encode: TextEncoder.prototype.encode,
      map: Array.prototype.map,
      filter: Array.prototype.filter,
      some: Array.prototype.some,
      toJSON: Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'),
    }
    const safeBatchDb = {
      prepare: originalDb.prepare.bind(originalDb),
      async batch<T>(statements: Parameters<typeof originalDb.batch<T>>[0]) {
        const poisoned = {
          map: Array.prototype.map,
          filter: Array.prototype.filter,
          some: Array.prototype.some,
        }
        Array.prototype.map = originals.map
        Array.prototype.filter = originals.filter
        Array.prototype.some = originals.some
        try {
          return await originalDb.batch<T>(statements)
        } finally {
          Array.prototype.map = poisoned.map
          Array.prototype.filter = poisoned.filter
          Array.prototype.some = poisoned.some
        }
      },
    } as Env['DB']
    const isolatedEnv = { ...env, DB: safeBatchDb }
    let result: RunMarketingMonitorResult | undefined
    let directPoisonChecks: {
      map: boolean
      filter: boolean
      some: boolean
      textEncoder: boolean
      outcomesJson: boolean
    } | undefined

    try {
      result = await runMarketingMonitor(isolatedEnv, owner, { window }, {
        sourceFactory: ({ runId }) => {
          const rawObservations = [{
            id: `${runId}:visibility`,
            runId,
            metricKey: 'seo.ai_citations',
            value: 4,
            unit: 'count',
            authority: 'first-party',
            observedAt: '2026-07-01T12:00:00.000Z',
          }]
          const fixtureOutcome = { status: 'available', value: 4, unit: 'count' }
          TextEncoder.prototype.encode = () => { throw new Error('poisoned TextEncoder.encode') }
          Object.defineProperty(Object.prototype, 'toJSON', {
            configurable: true,
            value: () => ({ poisoned: true }),
          })
          Array.prototype.map = () => { throw new Error('poisoned map') }
          Array.prototype.filter = () => { throw new Error('poisoned filter') }
          Array.prototype.some = () => { throw new Error('poisoned some') }
          directPoisonChecks = {
            map: throwsMessage(() => rawObservations.map((value) => value), 'poisoned map'),
            filter: throwsMessage(() => rawObservations.filter(() => true), 'poisoned filter'),
            some: throwsMessage(() => rawObservations.some(() => true), 'poisoned some'),
            textEncoder: throwsMessage(
              () => new TextEncoder().encode('intrinsic fixture'),
              'poisoned TextEncoder.encode',
            ),
            outcomesJson: JSON.stringify(fixtureOutcome) === '{"poisoned":true}',
          }
          return [{
            key: 'intrinsic_fixture',
            slot: 'web_analytics',
            async read() {
              return { status: 'available', observations: rawObservations }
            },
          }]
        },
      })
    } finally {
      TextEncoder.prototype.encode = originals.encode
      Array.prototype.map = originals.map
      Array.prototype.filter = originals.filter
      Array.prototype.some = originals.some
      if (originals.toJSON) Object.defineProperty(Object.prototype, 'toJSON', originals.toJSON)
      else delete (Object.prototype as { toJSON?: unknown }).toJSON
    }

    assert.deepEqual(directPoisonChecks, {
      map: true,
      filter: true,
      some: true,
      textEncoder: true,
      outcomesJson: true,
    })
    assert.equal(result?.ok, true)
    if (!result?.ok) throw new Error(`monitor failed: ${result?.reason ?? 'missing_result'}`)
    assert.equal(result.run.observationCount, 1)
    assert.equal(result.run.evidenceDigest, await canonicalEvidenceDigest(result.run))
    return {
      ok: true,
      observationCount: 1,
      directPoisonChecks: {
        map: true,
        filter: true,
        some: true,
        textEncoder: true,
        outcomesJson: true,
      },
    }
  } finally {
    harness.close()
  }
}
