import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MARKETING_MONITOR_PROGRAM_VERSION,
  getLatestMarketingMonitorRun,
  listMarketingMonitorRuns,
  runMarketingMonitor,
  type MarketingMonitorSourceFactory,
} from '../src/addons/marketing/service'
import { activateAddon, configureAddon, disableAddon, installAddon, type AddonInstallation } from '../src/addons/service'
import { archiveAddon } from '../src/addons/service'
import type { Env } from '../src/types'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0002_members.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0004_channels.sql',
  '../migrations/0005_channel_capability_grants.sql',
  '../migrations/0016_presence.sql',
  '../migrations/0019_agent_token_binding.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0028_metric_points.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0040_members_tenant.sql',
  '../migrations/0043_member_tokens_tenant.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
  '../migrations/0053_marketing_monitor_runs.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const owner = { id: 'owner-1', role: 'owner' as const }
const member = { id: 'member-1', role: 'member' as const }
const window = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T23:59:59.999Z',
}
const nextWindow = {
  start: '2026-07-02T00:00:00.000Z',
  end: '2026-07-02T23:59:59.999Z',
}

function envFor(harness: SqliteD1Harness, tenant = 'tenant-a'): Env {
  return { DB: harness.db, TENANT_SLUG: tenant } as Env
}

async function activateMarketing(env: Env): Promise<AddonInstallation> {
  const installed = await installAddon(env, owner, 'marketing-cro-monitor')
  expect(installed).toEqual(expect.objectContaining({ ok: true }))
  if (!installed.ok) throw new Error(`install failed: ${installed.reason}`)
  expect(await configureAddon(env, owner, 'marketing-cro-monitor', {
    bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
  })).toEqual(expect.objectContaining({ ok: true }))
  expect(await activateAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))
  return installed.installation
}

function insertPosthogConnector(harness: SqliteD1Harness): string {
  const id = crypto.randomUUID()
  harness.sqlite.prepare(`
    INSERT INTO connectors (
      id, tenant, type, label, encrypted_secret, meta, scope_type,
      scope_id, created_by, created_at, revoked_at
    ) VALUES (?, 'tenant-a', 'posthog', 'Monitor read scope', 'opaque-ciphertext',
      '{}', 'pot', NULL, 'owner-1', '2026-07-16T00:00:00.000Z', NULL)
  `).run(id)
  return id
}

function liveReadScope(harness: SqliteD1Harness): {
  installationId: string
  generationId: string
  bindingCount: number
} {
  const row = harness.sqlite.prepare(`
    SELECT installation.id AS installation_id, generation.id AS generation_id,
           generation.binding_count
      FROM addon_installations AS installation
      JOIN addon_binding_generations AS generation
        ON generation.installation_id = installation.id
       AND generation.tenant = installation.tenant
       AND generation.revoked_at IS NULL
     WHERE installation.tenant = 'tenant-a'
       AND installation.addon_key = 'marketing-cro-monitor'
       AND installation.state <> 'archived'
  `).get() as { installation_id: string; generation_id: string; binding_count: number } | undefined
  if (!row) throw new Error('live marketing read scope not found')
  return {
    installationId: row.installation_id,
    generationId: row.generation_id,
    bindingCount: row.binding_count,
  }
}

function envWithEvidenceInterleave(
  harness: SqliteD1Harness,
  beforeEvidenceQuery: () => Promise<void>,
): Env {
  let interleaved = false
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrap(target.bind(...values), sql)
      }
      if (property === 'first') {
        return async (columnName?: string) => {
          if (!interleaved && sql.includes('marketing_monitor_runs AS run')) {
            interleaved = true
            await beforeEvidenceQuery()
          }
          return target.first(columnName)
        }
      }
      if (property === 'all') {
        return async () => {
          if (!interleaved && sql.includes('marketing_monitor_runs AS run')) {
            interleaved = true
            await beforeEvidenceQuery()
          }
          return target.all()
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = {
    prepare(sql: string) {
      return wrap(harness.db.prepare(sql), sql)
    },
    batch: harness.db.batch.bind(harness.db),
  } as unknown as D1Database
  return { DB: db, TENANT_SLUG: 'tenant-a' } as Env
}

function fixtureFactory(
  calls: Array<{ runId: string; window: typeof window }> = [],
): MarketingMonitorSourceFactory {
  return ({ runId, window: requestedWindow }) => {
    calls.push({ runId, window: requestedWindow as typeof window })
    return [createMarketingMonitorFixtureSource({
      runId,
      observedAt: '2026-07-01T12:00:00.000Z',
      window: requestedWindow,
    })]
  }
}

const unavailableOutcomes = JSON.stringify({
  visibility: { status: 'unavailable', reason: 'authoritative_source_missing' },
  qualifiedTraffic: { status: 'unavailable', reason: 'authoritative_source_missing' },
  leads: { status: 'unavailable', reason: 'authoritative_source_missing' },
  conversion: { status: 'unavailable', reason: 'authoritative_source_missing' },
  revenue: { status: 'unavailable', reason: 'authoritative_source_missing' },
})

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

function runIntrinsicPoisoningFixture(): Promise<unknown> {
  const runner = fileURLToPath(new URL('./fixtures/marketing-monitor-intrinsic-poisoning-runner.mjs', import.meta.url))
  const root = fileURLToPath(new URL('..', import.meta.url))
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [runner], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = [error.message, stderr.trim()].filter(Boolean).join('\n')
        reject(new Error(`intrinsic poisoning fixture failed: ${detail}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (parseError) {
        reject(new Error(`intrinsic poisoning fixture returned invalid JSON: ${String(parseError)}`))
      }
    })
  })
}

function directRunValues(harness: SqliteD1Harness, overrides: Partial<Record<string, unknown>> = {}) {
  const installation = harness.sqlite.prepare(`
    SELECT id, tenant, addon_key, installed_version, publisher, trust_class,
           mupot_compatibility, manifest_sha256
      FROM addon_installations WHERE state = 'active'
  `).get() as Record<string, unknown>
  const generation = harness.sqlite.prepare(`
    SELECT id FROM addon_binding_generations WHERE revoked_at IS NULL
  `).get() as { id: string }
  return {
    id: crypto.randomUUID(),
    tenant: installation.tenant,
    installation_id: installation.id,
    binding_generation_id: generation.id,
    addon_key: installation.addon_key,
    installed_version: installation.installed_version,
    publisher: installation.publisher,
    trust_class: installation.trust_class,
    mupot_compatibility: installation.mupot_compatibility,
    manifest_sha256: installation.manifest_sha256,
    program_version: MARKETING_MONITOR_PROGRAM_VERSION,
    window_start: window.start,
    window_end: window.end,
    source_count: 0,
    observation_count: 0,
    raw_observation_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function insertDirectBuildingRun(harness: SqliteD1Harness, values: ReturnType<typeof directRunValues>) {
  harness.sqlite.prepare(`
    INSERT INTO marketing_monitor_runs (
      id, tenant, installation_id, binding_generation_id, addon_key,
      installed_version, publisher, trust_class, mupot_compatibility, manifest_sha256,
      program_version, window_start, window_end, status, source_count,
      observation_count, raw_observation_count, outcomes_json, evidence_digest,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(
    values.id,
    values.tenant,
    values.installation_id,
    values.binding_generation_id,
    values.addon_key,
    values.installed_version,
    values.publisher,
    values.trust_class,
    values.mupot_compatibility,
    values.manifest_sha256,
    values.program_version,
    values.window_start,
    values.window_end,
    values.source_count,
    values.observation_count,
    values.raw_observation_count,
    values.created_at,
  )
}

describe('marketing monitor service', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const migration of migrations) harness.sqlite.exec(migration)
    harness.sqlite.prepare(`
      INSERT INTO org_settings (key, value) VALUES ('billing_state', ?)
    `).run(JSON.stringify({ tier: 'scale', event_id: 'monitor-tests', effective_at: '2026-07-16T00:00:00.000Z' }))
    env = envFor(harness)
  })

  afterEach(() => harness.close())

  it('persists one immutable completed run for an active installation and exact window', async () => {
    await activateMarketing(env)
    const calls: Array<{ runId: string; window: typeof window }> = []
    const first = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory(calls) })
    const second = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory(calls) })

    expect(first).toEqual(expect.objectContaining({
      ok: true,
      idempotent: false,
      run: expect.objectContaining({
        programVersion: MARKETING_MONITOR_PROGRAM_VERSION,
        status: 'completed',
        window,
        sourceCount: 1,
        observationCount: 5,
        rawObservationCount: 5,
        evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }))
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      idempotent: true,
      run: expect.objectContaining({ id: first.ok ? first.run.id : '' }),
    }))
    expect(calls[0]).toEqual({ runId: first.ok ? first.run.id : '', window })
    expect(harness.sqlite.prepare('SELECT status, COUNT(*) AS count FROM marketing_monitor_runs').get())
      .toEqual({ status: 'completed', count: 1 })
  })

  it('uses live bindings to construct registered sources when no factory is injected', async () => {
    await activateMarketing(env)
    harness.sqlite.prepare(`
      INSERT INTO metric_points (
        id, tenant_id, metric_key, value, occurred_at, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'point-first-party-1',
      'tenant-a',
      'seo.organic_sessions',
      41,
      '2026-07-01T12:00:00.000Z',
      'first-party',
      '2026-07-01T12:00:00.000Z',
    )

    const result = await runMarketingMonitor(env, owner, { window })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      idempotent: false,
      run: expect.objectContaining({
        sourceCount: 1,
        observationCount: 1,
        sources: [{
          key: 'first_party',
          slot: 'web_analytics',
          status: 'available',
          observationCount: 1,
        }],
        observations: [expect.objectContaining({
          sourceKey: 'first_party',
          metricKey: 'seo.organic_sessions',
          value: 41,
          authority: 'first-party',
        })],
      }),
    }))
    expect(harness.sqlite.prepare(`
      SELECT source_key, metric_key, value, authority
        FROM marketing_monitor_observations
    `).get()).toEqual({
      source_key: 'first_party',
      metric_key: 'seo.organic_sessions',
      value: 41,
      authority: 'first-party',
    })
  })

  it.each(['missing', 'installed', 'configured', 'disabled', 'archived'] as const)(
    'refuses a %s installation before constructing sources',
    async (state) => {
    const sourceFactory: MarketingMonitorSourceFactory = () => {
      throw new Error('must not run')
    }

    if (state !== 'missing') await installAddon(env, owner, 'marketing-cro-monitor')
    if (state === 'configured' || state === 'disabled' || state === 'archived') {
      await configureAddon(env, owner, 'marketing-cro-monitor', {
        bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
      })
    }
    if (state === 'disabled' || state === 'archived') await disableAddon(env, owner, 'marketing-cro-monitor')
    if (state === 'archived') await archiveAddon(env, owner, 'marketing-cro-monitor')
    expect(await runMarketingMonitor(env, owner, { window }, { sourceFactory }))
      .toEqual({ ok: false, reason: 'addon_not_active' })
    },
  )

  it('requires owner or admin before reading state or constructing sources', async () => {
    expect(await runMarketingMonitor(env, member, { window }, { sourceFactory: fixtureFactory() }))
      .toEqual({ ok: false, reason: 'not_authorized' })
    expect(await getLatestMarketingMonitorRun(env, member)).toEqual({ ok: false, reason: 'not_authorized' })
    expect(await listMarketingMonitorRuns(env, member, { limit: 10 })).toEqual({ ok: false, reason: 'not_authorized' })
  })

  it('requires a canonical millisecond-Z evidence window', async () => {
    await activateMarketing(env)
    for (const invalid of [
      { start: '2026-07-01T00:00:00Z', end: window.end },
      { start: window.end, end: window.start },
      { start: window.start, end: '2026-08-15T00:00:00.000Z' },
    ]) {
      expect(await runMarketingMonitor(env, owner, { window: invalid }, { sourceFactory: fixtureFactory() }))
        .toEqual({ ok: false, reason: 'invalid_window' })
    }
  })

  it('rejects normalized evidence whose run ID does not match the minted run', async () => {
    await activateMarketing(env)
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: ({ window: requestedWindow }) => [createMarketingMonitorFixtureSource({
        runId: 'forged-run-id',
        observedAt: '2026-07-01T12:00:00.000Z',
        window: requestedWindow,
      })],
    })

    expect(result).toEqual({ ok: false, reason: 'collection_invalid' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get()).toEqual({ count: 0 })
  })

  it('rolls back when the addon is disabled during collection', async () => {
    await activateMarketing(env)
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: ({ runId, window: requestedWindow }) => [{
        ...createMarketingMonitorFixtureSource({
          runId,
          observedAt: '2026-07-01T12:00:00.000Z',
          window: requestedWindow,
        }),
        async read(sourceEnv, binding, sourceWindow) {
          await disableAddon(env, owner, 'marketing-cro-monitor')
          return createMarketingMonitorFixtureSource({
            runId,
            observedAt: '2026-07-01T12:00:00.000Z',
            window: requestedWindow,
          }).read(sourceEnv, binding, sourceWindow)
        },
      }],
    })

    expect(result).toEqual({ ok: false, reason: 'fence_lost' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get()).toEqual({ count: 0 })
  })

  it('returns only completed redacted runs from latest and bounded list reads', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)

    const latest = await getLatestMarketingMonitorRun(env, owner)
    const listed = await listMarketingMonitorRuns(env, owner, { limit: 1 })
    const scope = liveReadScope(harness)
    expect(latest).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ id: created.ok ? created.run.id : '' }),
    }))
    expect(listed).toEqual(expect.objectContaining({
      ok: true,
      runs: [expect.objectContaining({ id: created.ok ? created.run.id : '' })],
    }))
    const serialized = JSON.stringify({ latest, listed })
    for (const forbidden of [
      'connectorId',
      'connector_id',
      'configuredBy',
      'actorId',
      'rawPayload',
      'building',
      scope.generationId,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('reads only runs from the current live binding generation after reconfiguration', async () => {
    const installation = await activateMarketing(env)
    const oldRun = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(oldRun.ok).toBe(true)

    expect(await disableAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))
    const connectorId = insertPosthogConnector(harness)
    expect(await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{ slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId }],
    })).toEqual(expect.objectContaining({ ok: true }))

    const generations = harness.sqlite.prepare(`
      SELECT id, revoked_at FROM addon_binding_generations
       WHERE installation_id = ? ORDER BY configured_at, id
    `).all(installation.id) as Array<{ id: string; revoked_at: string | null }>
    expect(generations).toHaveLength(2)
    expect(generations[0].revoked_at).toEqual(expect.any(String))
    expect(generations[1].revoked_at).toBeNull()
    const newScope = liveReadScope(harness)
    expect(await getLatestMarketingMonitorRun(env, owner, newScope))
      .toEqual({ ok: true, run: null })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10, ...newScope }))
      .toEqual({ ok: true, runs: [] })

    expect(await activateAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))
    const newRun = await runMarketingMonitor(env, owner, { window: nextWindow }, { sourceFactory: fixtureFactory() })
    expect(newRun.ok).toBe(true)
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10, ...newScope }))
      .toEqual({
        ok: true,
        runs: [expect.objectContaining({ id: newRun.ok ? newRun.run.id : '' })],
      })
  })

  it('does not expose archived installation runs after reinstalling the addon', async () => {
    const oldInstallation = await activateMarketing(env)
    const oldRun = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(oldRun.ok).toBe(true)
    expect(await disableAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))
    expect(await archiveAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))

    const newInstallation = await activateMarketing(env)
    expect(newInstallation.id).not.toBe(oldInstallation.id)
    const newScope = liveReadScope(harness)
    expect(await getLatestMarketingMonitorRun(env, owner, newScope))
      .toEqual({ ok: true, run: null })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10, ...newScope }))
      .toEqual({ ok: true, runs: [] })

    const newRun = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(newRun.ok).toBe(true)
    expect(await getLatestMarketingMonitorRun(env, owner, newScope))
      .toEqual({
        ok: true,
        run: expect.objectContaining({ id: newRun.ok ? newRun.run.id : '' }),
      })
  })

  it('fences a scoped read when reconfiguration occurs immediately before evidence SQL executes', async () => {
    await activateMarketing(env)
    const oldRun = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(oldRun.ok).toBe(true)
    const oldScope = liveReadScope(harness)
    const racedEnv = envWithEvidenceInterleave(harness, async () => {
      expect(await disableAddon(env, owner, 'marketing-cro-monitor'))
        .toEqual(expect.objectContaining({ ok: true }))
      const connectorId = insertPosthogConnector(harness)
      expect(await configureAddon(env, owner, 'marketing-cro-monitor', {
        bindings: [{ slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId }],
      })).toEqual(expect.objectContaining({ ok: true }))
    })

    expect(await getLatestMarketingMonitorRun(racedEnv, owner, oldScope))
      .toEqual({ ok: false, reason: 'fence_lost' })
    expect(liveReadScope(harness).generationId).not.toBe(oldScope.generationId)
  })

  it('fences an unscoped read when reinstall occurs after context resolution but before evidence SQL', async () => {
    const oldInstallation = await activateMarketing(env)
    const oldRun = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(oldRun.ok).toBe(true)
    const oldScope = liveReadScope(harness)
    const racedEnv = envWithEvidenceInterleave(harness, async () => {
      expect(await disableAddon(env, owner, 'marketing-cro-monitor'))
        .toEqual(expect.objectContaining({ ok: true }))
      expect(await archiveAddon(env, owner, 'marketing-cro-monitor'))
        .toEqual(expect.objectContaining({ ok: true }))
      const replacement = await activateMarketing(env)
      expect(replacement.id).not.toBe(oldInstallation.id)
    })

    expect(await listMarketingMonitorRuns(racedEnv, owner, { limit: 10, ...oldScope }))
      .toEqual({ ok: false, reason: 'fence_lost' })
  })

  it.each(['latest', 'list'] as const)(
    'returns explicit fence loss for a both-empty %s read when its generation is replaced before evidence SQL',
    async (read) => {
      await activateMarketing(env)
      const oldScope = liveReadScope(harness)
      const racedEnv = envWithEvidenceInterleave(harness, async () => {
        expect(await disableAddon(env, owner, 'marketing-cro-monitor'))
          .toEqual(expect.objectContaining({ ok: true }))
        const connectorId = insertPosthogConnector(harness)
        expect(await configureAddon(env, owner, 'marketing-cro-monitor', {
          bindings: [{ slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId }],
        })).toEqual(expect.objectContaining({ ok: true }))
      })

      const result = read === 'latest'
        ? await getLatestMarketingMonitorRun(racedEnv, owner, oldScope)
        : await listMarketingMonitorRuns(racedEnv, owner, { limit: 10, ...oldScope })

      expect(result).toEqual({ ok: false, reason: 'fence_lost' })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get())
        .toEqual({ count: 0 })
    },
  )

  it.each(['latest', 'list'] as const)(
    'returns explicit fence loss for a both-empty %s read when its installation is archived and replaced',
    async (read) => {
      const oldInstallation = await activateMarketing(env)
      const oldScope = liveReadScope(harness)
      const racedEnv = envWithEvidenceInterleave(harness, async () => {
        expect(await disableAddon(env, owner, 'marketing-cro-monitor'))
          .toEqual(expect.objectContaining({ ok: true }))
        expect(await archiveAddon(env, owner, 'marketing-cro-monitor'))
          .toEqual(expect.objectContaining({ ok: true }))
        const replacement = await activateMarketing(env)
        expect(replacement.id).not.toBe(oldInstallation.id)
      })

      const result = read === 'latest'
        ? await getLatestMarketingMonitorRun(racedEnv, owner, oldScope)
        : await listMarketingMonitorRuns(racedEnv, owner, { limit: 10, ...oldScope })

      expect(result).toEqual({ ok: false, reason: 'fence_lost' })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get())
        .toEqual({ count: 0 })
    },
  )

  it('requires the scoped binding count to match the live generation at evidence query time', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    const scope = liveReadScope(harness)

    expect(await getLatestMarketingMonitorRun(env, owner, { ...scope, bindingCount: scope.bindingCount + 1 }))
      .toEqual({ ok: false, reason: 'fence_lost' })
  })

  it('requires an unscoped read to recount live bindings in the evidence statement', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    harness.sqlite.prepare(`
      UPDATE addon_connector_bindings
         SET revoked_at = '2999-01-01T00:00:00.000Z'
       WHERE generation_id = ?
    `).run(liveReadScope(harness).generationId)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'fence_lost' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'fence_lost' })
  })

  it('computes the canonical versioned evidence digest over ordered public evidence', async () => {
    await activateMarketing(env)
    const result = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const canonical = JSON.stringify({
      schema: 'mupot.marketing-monitor-evidence/v1',
      programVersion: MARKETING_MONITOR_PROGRAM_VERSION,
      window: result.run.window,
      sources: result.run.sources,
      observations: result.run.observations,
      outcomes: result.run.outcomes,
    })
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
    const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

    expect(result.run.evidenceDigest).toBe(digest)
  })

  it('uses captured numeric intrinsics after untrusted source execution', async () => {
    await activateMarketing(env)
    let result: Awaited<ReturnType<typeof runMarketingMonitor>> | undefined
    const originalNumberIsInteger = Number.isInteger
    try {
      result = await runMarketingMonitor(env, owner, { window }, {
        sourceFactory: ({ runId, window: requestedWindow }) => [{
          ...createMarketingMonitorFixtureSource({
            runId,
            observedAt: '2026-07-01T12:00:00.000Z',
            window: requestedWindow,
          }),
          async read(sourceEnv, binding, sourceWindow) {
            const snapshot = await createMarketingMonitorFixtureSource({
              runId,
              observedAt: '2026-07-01T12:00:00.000Z',
              window: requestedWindow,
            }).read(sourceEnv, binding, sourceWindow)
            Number.isInteger = (() => false) as typeof Number.isInteger
            return snapshot
          },
        }],
      })
    } finally {
      Number.isInteger = originalNumberIsInteger
    }
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ observationCount: 5 }),
    }))
  })

  it('keeps persistence and digest canonical after post-load intrinsic poisoning', async () => {
    const unrelatedCycle: unknown[] = []
    unrelatedCycle[0] = unrelatedCycle
    let proxyReads = 0
    const unrelatedProxy = new Proxy({}, {
      get() {
        proxyReads += 1
        throw new Error('unrelated proxy read')
      },
    })

    expect(unrelatedCycle.map(() => 'worker')).toEqual(['worker'])
    expect([unrelatedProxy].map(() => 'worker')).toEqual(['worker'])
    expect(proxyReads).toBe(0)
    expect(await runIntrinsicPoisoningFixture()).toEqual({
      ok: true,
      observationCount: 1,
      directPoisonChecks: {
        map: true,
        filter: true,
        some: true,
        textEncoder: true,
        outcomesJson: true,
      },
    })
  })

  it('pins a frozen collection environment before the injected source factory runs', async () => {
    await activateMarketing(env)
    const mutableEnv = env as unknown as { DB: Env['DB']; TENANT_SLUG: string }
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: ({ runId, window: requestedWindow }) => {
        mutableEnv.TENANT_SLUG = 'redirected-tenant'
        mutableEnv.DB = {
          prepare() { throw new Error('redirected database') },
          batch() { throw new Error('redirected database') },
        } as unknown as Env['DB']
        const fixture = createMarketingMonitorFixtureSource({
          runId,
          observedAt: '2026-07-01T12:00:00.000Z',
          window: requestedWindow,
        })
        return [{
          ...fixture,
          async read(sourceEnv, binding, sourceWindow) {
            if (sourceEnv.TENANT_SLUG !== 'tenant-a' || !Object.isFrozen(sourceEnv)) {
              return { status: 'failed', reason: 'source_unavailable', observations: [] }
            }
            return fixture.read(sourceEnv, binding, sourceWindow)
          },
        }]
      },
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ observationCount: 5 }),
    }))
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get())
      .toEqual({ count: 1 })
  })

  it('persists the exact collector-owned synthetic source configuration failure', async () => {
    await activateMarketing(env)
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: () => [{
        key: 'source_config_0',
        slot: 'web_analytics',
        async read() { return { status: 'available', observations: [] } },
      }],
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({
        sources: [{
          key: 'source_config_0',
          slot: 'unconfigured',
          status: 'failed',
          reason: 'invalid_source_configuration',
          observationCount: 0,
        }],
      }),
    }))
  })

  it('requires the exact registered identity and live binding generation before source construction', async () => {
    await activateMarketing(env)
    harness.sqlite.exec('DROP TRIGGER addon_installations_identity_is_immutable')
    harness.sqlite.prepare(`
      UPDATE addon_installations SET installed_version = '9.9.9'
    `).run()
    expect(await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: () => { throw new Error('must not run') },
    })).toEqual({ ok: false, reason: 'addon_identity_mismatch' })

    harness.sqlite.prepare(`UPDATE addon_installations SET installed_version = '1.0.0'`).run()
    harness.sqlite.prepare(`
      UPDATE addon_binding_generations SET revoked_at = '2999-01-01T00:00:00.000Z'
      WHERE revoked_at IS NULL
    `).run()
    expect(await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: () => { throw new Error('must not run') },
    })).toEqual({ ok: false, reason: 'binding_generation_not_live' })
  })

  it('mints the run ID before an empty source factory and persists a null collection run ID safely', async () => {
    await activateMarketing(env)
    const contexts: Array<{ runId: string; window: typeof window }> = []
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: (context) => {
        contexts.push(context as { runId: string; window: typeof window })
        return []
      },
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ sourceCount: 0, observationCount: 0, rawObservationCount: 0 }),
    }))
    expect(contexts).toEqual([{ runId: result.ok ? result.run.id : '', window }])
  })

  it('uses one five-statement D1 batch with JSON-to-row child inserts', async () => {
    await activateMarketing(env)
    const calls: Array<readonly { sql?: string }[]> = []
    const original = env.DB
    const trackedEnv = {
      ...env,
      DB: {
        prepare: original.prepare.bind(original),
        async batch<T>(statements: Parameters<typeof original.batch<T>>[0]) {
          calls.push(statements as unknown as readonly { sql?: string }[])
          return original.batch<T>(statements)
        },
      } as Env['DB'],
    }
    const result = await runMarketingMonitor(trackedEnv, owner, { window }, { sourceFactory: fixtureFactory() })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(5)
    expect(calls[0].filter((statement) => statement.sql?.includes('json_each(?1)'))).toHaveLength(2)
  })

  it('reconciles concurrent exact-window requests to one completed winner', async () => {
    await activateMarketing(env)
    let arrivals = 0
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const sourceFactory: MarketingMonitorSourceFactory = async ({ runId, window: requestedWindow }) => {
      arrivals += 1
      if (arrivals === 2) release()
      await released
      return [createMarketingMonitorFixtureSource({
        runId,
        observedAt: '2026-07-01T12:00:00.000Z',
        window: requestedWindow,
      })]
    }

    const results = await Promise.all([
      runMarketingMonitor(env, owner, { window }, { sourceFactory }),
      runMarketingMonitor(env, owner, { window }, { sourceFactory }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.filter((result) => result.ok && result.idempotent)).toHaveLength(1)
    expect(new Set(results.flatMap((result) => result.ok ? [result.run.id] : []))).toHaveLength(1)
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM marketing_monitor_runs WHERE status = 'completed'`).get())
      .toEqual({ count: 1 })
  })

  it('rolls back when the live binding generation drifts during collection', async () => {
    await activateMarketing(env)
    const result = await runMarketingMonitor(env, owner, { window }, {
      sourceFactory: ({ runId, window: requestedWindow }) => [{
        ...createMarketingMonitorFixtureSource({
          runId,
          observedAt: '2026-07-01T12:00:00.000Z',
          window: requestedWindow,
        }),
        async read(sourceEnv, binding, sourceWindow) {
          harness.sqlite.prepare(`
            UPDATE addon_binding_generations SET revoked_at = '2999-01-01T00:00:00.000Z'
            WHERE revoked_at IS NULL
          `).run()
          return createMarketingMonitorFixtureSource({
            runId,
            observedAt: '2026-07-01T12:00:00.000Z',
            window: requestedWindow,
          }).read(sourceEnv, binding, sourceWindow)
        },
      }],
    })

    expect(result).toEqual({ ok: false, reason: 'fence_lost' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM marketing_monitor_runs').get()).toEqual({ count: 0 })
  })

  it('enforces canonical windows, child attribution, child counts, finalization state, immutability, and no deletes in D1', async () => {
    await activateMarketing(env)
    expect(() => insertDirectBuildingRun(harness, directRunValues(harness, {
      window_start: '2026-07-01T00:00:00Z',
    }))).toThrow()

    const counted = directRunValues(harness, { source_count: 1, window_end: '2026-07-01T23:59:59.998Z' })
    insertDirectBuildingRun(harness, counted)
    expect(() => harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs
         SET status = 'completed', completed_at = ?, evidence_digest = ?, outcomes_json = ?
       WHERE id = ?
    `).run('2026-07-01T01:00:00.000Z', 'a'.repeat(64), unavailableOutcomes, counted.id)).toThrow()

    const attributed = directRunValues(harness, {
      source_count: 1,
      observation_count: 1,
      raw_observation_count: 1,
      window_end: '2026-07-01T23:59:59.997Z',
    })
    insertDirectBuildingRun(harness, attributed)
    harness.sqlite.prepare(`
      INSERT INTO marketing_monitor_sources (
        run_id, tenant, installation_id, binding_generation_id, position,
        source_key, source_slot, status, reason, observation_count
      ) VALUES (?, ?, ?, ?, 0, 'trusted', 'web_analytics', 'available', NULL, 1)
    `).run(attributed.id, attributed.tenant, attributed.installation_id, attributed.binding_generation_id)
    expect(() => harness.sqlite.prepare(`
      INSERT INTO marketing_monitor_observations (
        run_id, tenant, installation_id, binding_generation_id, position, id,
        source_key, source_slot, metric_key, value, unit, authority, observed_at
      ) VALUES (?, ?, ?, ?, 0, 'evidence', 'trusted', 'crm',
        'growth.leads', 1, 'count', 'first-party', '2026-07-01T00:30:00.000Z')
    `).run(attributed.id, attributed.tenant, attributed.installation_id, attributed.binding_generation_id)).toThrow()

    const complete = directRunValues(harness, { window_end: '2026-07-01T23:59:59.996Z' })
    insertDirectBuildingRun(harness, complete)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs
         SET status = 'completed', completed_at = ?, evidence_digest = ?, outcomes_json = ?
       WHERE id = ?
    `).run('2026-07-01T01:00:00.000Z', 'b'.repeat(64), unavailableOutcomes, complete.id)
    expect(() => harness.sqlite.prepare(`UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?`)
      .run('c'.repeat(64), complete.id)).toThrow()
    expect(() => harness.sqlite.prepare(`DELETE FROM marketing_monitor_runs WHERE id = ?`).run(complete.id)).toThrow()
  })

  it('enforces tenant identity and active exact generation at direct insert and finalize', async () => {
    await activateMarketing(env)
    expect(() => insertDirectBuildingRun(harness, directRunValues(harness, {
      tenant: 'tenant-b',
      window_end: '2026-07-01T23:59:59.993Z',
    }))).toThrow()

    const run = directRunValues(harness, { window_end: '2026-07-01T23:59:59.992Z' })
    insertDirectBuildingRun(harness, run)
    expect(await disableAddon(env, owner, 'marketing-cro-monitor')).toEqual(expect.objectContaining({ ok: true }))
    expect(() => harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs
         SET status = 'completed', completed_at = ?, evidence_digest = ?, outcomes_json = ?
       WHERE id = ?
    `).run('2026-07-01T01:00:00.000Z', 'e'.repeat(64), unavailableOutcomes, run.id)).toThrow()
    expect(harness.sqlite.prepare(`SELECT status FROM marketing_monitor_runs WHERE id = ?`).get(run.id))
      .toEqual({ status: 'building' })
  })

  it('rejects direct run inserts whose canonical window exceeds 31 days by one millisecond', async () => {
    await activateMarketing(env)
    expect(() => insertDirectBuildingRun(harness, directRunValues(harness, {
      window_end: '2026-08-01T00:00:00.000Z',
    }))).not.toThrow()
    expect(() => insertDirectBuildingRun(harness, directRunValues(harness, {
      window_end: '2026-08-01T00:00:00.001Z',
    }))).toThrow()
  })

  it.each([
    ['source_config_0', 'web_analytics', 'available', null, 0],
    ['normal_source', 'web_analytics', 'unavailable', 'binding_not_configured', 1],
    ['normal_source', 'web_analytics', 'unavailable', 'invalid_observation', 0],
    ['normal_source', 'web_analytics', 'failed', 'invalid_source_configuration', 0],
  ] as const)(
    'rejects direct source inserts outside the Task 3 status contract: %s/%s/%s/%s/%s',
    async (sourceKey, sourceSlot, status, reason, observationCount) => {
      await activateMarketing(env)
      const run = directRunValues(harness, { source_count: 1 })
      insertDirectBuildingRun(harness, run)
      expect(() => harness.sqlite.prepare(`
        INSERT INTO marketing_monitor_sources (
          run_id, tenant, installation_id, binding_generation_id, position,
          source_key, source_slot, status, reason, observation_count
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.tenant,
        run.installation_id,
        run.binding_generation_id,
        sourceKey,
        sourceSlot,
        status,
        reason,
        observationCount,
      )).toThrow()
    },
  )

  it('fails closed when a completed stored row contains malformed JSON', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    harness.sqlite.exec('DROP TRIGGER marketing_monitor_runs_finalize_only; PRAGMA ignore_check_constraints = ON;')
    harness.sqlite.prepare(`UPDATE marketing_monitor_runs SET outcomes_json = '{bad'`).run()

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed on semantically fabricated outcomes even with a matching evidence digest', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const outcomes = {
      ...created.run.outcomes,
      revenue: structuredClone(created.run.outcomes.visibility),
    }
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, outcomes })
    harness.sqlite.exec('DROP TRIGGER marketing_monitor_runs_finalize_only')
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs SET outcomes_json = ?, evidence_digest = ? WHERE id = ?
    `).run(JSON.stringify(outcomes), evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed on a fabricated evidence digest', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec('DROP TRIGGER marketing_monitor_runs_finalize_only')
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?
    `).run('f'.repeat(64), created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed on a stored canonical window over 31 days even with a matching digest', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const oversizedWindow = { ...created.run.window, end: '2026-08-01T00:00:00.001Z' }
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, window: oversizedWindow })
    harness.sqlite.exec('DROP TRIGGER marketing_monitor_runs_finalize_only')
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs SET window_end = ?, evidence_digest = ? WHERE id = ?
    `).run(oversizedWindow.end, evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed when stored evidence falls outside its run window with matching outcomes and digest', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const outsideWindow = '2026-07-02T00:00:00.000Z'
    const observations = created.run.observations.map((observation) => (
      observation.metricKey === 'seo.ai_citations' ? { ...observation, observedAt: outsideWindow } : observation
    ))
    const outcomes = {
      ...created.run.outcomes,
      visibility: created.run.outcomes.visibility.status === 'available'
        ? { ...created.run.outcomes.visibility, observedAt: outsideWindow }
        : created.run.outcomes.visibility,
    }
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, observations, outcomes })
    harness.sqlite.exec(`
      DROP TRIGGER marketing_monitor_observations_no_update;
      DROP TRIGGER marketing_monitor_runs_finalize_only;
    `)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_observations SET observed_at = ?
       WHERE run_id = ? AND metric_key = 'seo.ai_citations'
    `).run(outsideWindow, created.run.id)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs SET outcomes_json = ?, evidence_digest = ? WHERE id = ?
    `).run(JSON.stringify(outcomes), evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed on a stored observation ID beyond the persistence limit even with a matching digest', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const oversizedId = 'z'.repeat(257)
    const target = created.run.observations.at(-1)
    expect(target).toBeDefined()
    if (!target) return
    const observations = created.run.observations.map((observation) => (
      observation.id === target.id ? { ...observation, id: oversizedId } : observation
    ))
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, observations })
    harness.sqlite.exec(`
      DROP TRIGGER marketing_monitor_observations_no_update;
      DROP TRIGGER marketing_monitor_runs_finalize_only;
      PRAGMA ignore_check_constraints = ON;
    `)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_observations SET id = ? WHERE run_id = ? AND id = ?
    `).run(oversizedId, created.run.id, target.id)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?
    `).run(evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
    expect(await listMarketingMonitorRuns(env, owner, { limit: 10 })).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it.each([
    ['reserved key with nonsynthetic semantics', 'source_config_0'],
    ['noncanonical key', '_invalid'],
  ])('fails closed on a stored source with %s and a matching digest', async (_name, sourceKey) => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const originalSource = created.run.sources[0]
    const sources = [{ ...originalSource, key: sourceKey }]
    const observations = created.run.observations.map((observation) => ({ ...observation, sourceKey }))
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, sources, observations })
    harness.sqlite.exec(`
      DROP TRIGGER marketing_monitor_sources_no_update;
      DROP TRIGGER marketing_monitor_observations_no_update;
      DROP TRIGGER marketing_monitor_runs_finalize_only;
      PRAGMA foreign_keys = OFF;
      PRAGMA ignore_check_constraints = ON;
    `)
    harness.sqlite.prepare(`UPDATE marketing_monitor_sources SET source_key = ? WHERE run_id = ?`)
      .run(sourceKey, created.run.id)
    harness.sqlite.prepare(`UPDATE marketing_monitor_observations SET source_key = ? WHERE run_id = ?`)
      .run(sourceKey, created.run.id)
    harness.sqlite.prepare(`UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?`)
      .run(evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('fails closed when stored observations are attributed to an unavailable source', async () => {
    await activateMarketing(env)
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory: fixtureFactory() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sources = created.run.sources.map((source) => ({
      key: source.key,
      slot: source.slot,
      status: 'unavailable' as const,
      reason: 'binding_not_configured',
      observationCount: source.observationCount,
    }))
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, sources })
    harness.sqlite.exec(`
      DROP TRIGGER marketing_monitor_sources_no_update;
      DROP TRIGGER marketing_monitor_runs_finalize_only;
      PRAGMA ignore_check_constraints = ON;
    `)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_sources SET status = 'unavailable', reason = 'binding_not_configured'
       WHERE run_id = ?
    `).run(created.run.id)
    harness.sqlite.prepare(`UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?`)
      .run(evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it.each([
    ['unavailable', 'invalid_observation'],
    ['failed', 'invalid_source_configuration'],
  ] as const)('fails closed on a stored %s source reason Task 3 cannot emit for that identity', async (status, reason) => {
    await activateMarketing(env)
    const sourceFactory: MarketingMonitorSourceFactory = () => [{
      key: 'empty_fixture',
      slot: 'web_analytics',
      async read() { return { status: 'available', observations: [] } },
    }]
    const created = await runMarketingMonitor(env, owner, { window }, { sourceFactory })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sources = [{
      key: created.run.sources[0].key,
      slot: created.run.sources[0].slot,
      status,
      reason,
      observationCount: created.run.sources[0].observationCount,
    }]
    const evidenceDigest = await canonicalEvidenceDigest({ ...created.run, sources })
    harness.sqlite.exec(`
      DROP TRIGGER marketing_monitor_sources_no_update;
      DROP TRIGGER marketing_monitor_runs_finalize_only;
      PRAGMA ignore_check_constraints = ON;
    `)
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_sources SET status = ?, reason = ?
       WHERE run_id = ?
    `).run(status, reason, created.run.id)
    harness.sqlite.prepare(`UPDATE marketing_monitor_runs SET evidence_digest = ? WHERE id = ?`)
      .run(evidenceDigest, created.run.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })

  it('rejects arbitrary direct-write source reasons and fails closed on arbitrary outcome text', async () => {
    await activateMarketing(env)
    const sourceRun = directRunValues(harness, {
      source_count: 1,
      window_end: '2026-07-01T23:59:59.995Z',
    })
    insertDirectBuildingRun(harness, sourceRun)
    expect(() => harness.sqlite.prepare(`
      INSERT INTO marketing_monitor_sources (
        run_id, tenant, installation_id, binding_generation_id, position,
        source_key, source_slot, status, reason, observation_count
      ) VALUES (?, ?, ?, ?, 0, 'unsafe', 'web_analytics', 'failed',
        'Authorization_Bearer_sensitive', 0)
    `).run(sourceRun.id, sourceRun.tenant, sourceRun.installation_id, sourceRun.binding_generation_id)).toThrow()

    const outcomeRun = directRunValues(harness, { window_end: '2026-07-01T23:59:59.994Z' })
    insertDirectBuildingRun(harness, outcomeRun)
    const unsafeOutcomes = JSON.stringify({
      ...JSON.parse(unavailableOutcomes),
      revenue: { status: 'unavailable', reason: 'Authorization Bearer sensitive' },
    })
    harness.sqlite.prepare(`
      UPDATE marketing_monitor_runs
         SET status = 'completed', completed_at = ?, evidence_digest = ?, outcomes_json = ?
       WHERE id = ?
    `).run('2026-07-01T01:00:00.000Z', 'd'.repeat(64), unsafeOutcomes, outcomeRun.id)

    expect(await getLatestMarketingMonitorRun(env, owner)).toEqual({ ok: false, reason: 'stored_run_invalid' })
  })
})
