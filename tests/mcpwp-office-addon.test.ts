// mupot#1580 slice 1 — mcpwp-office addon: manifest, registration, runtime-contract,
// and the addon-door lifecycle (install/disable/archive) for an external_mcp addon.
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() — this file
// imports production code (src/addons/service.ts's installAddon/disableAddon/
// archiveAddon), so per scripts/check-test-schema-source.mjs it must build its schema
// from the committed migration chain (migrations/0175_addon_external_isolated.sql is
// what makes an 'external_isolated' trust_class row persistable at all).

import type { AddonManifestV1 } from '../src/addons/contract'
import { describe, expect, it } from 'vitest'
import { validateAddonManifest } from '../src/addons/contract'
import {
  assertAddonRuntimeContract,
  getRegisteredAddon,
  listRegisteredAddons,
  registerAddon,
} from '../src/addons/registry'
import { getRegistered as getRegisteredDepartment } from '../src/departments/registry'
import { McpwpOfficeAddon } from '../src/addons/office/manifest'
import {
  archiveAddon,
  disableAddon,
  externalIsolationViolation,
  installAddon,
  type AddonExternalInvariantViolation,
} from '../src/addons/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-office-a'

function realHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

function realEnv(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as Env
}

function installationRow(harness: SqliteD1Harness, addonKey: string) {
  return harness.sqlite.prepare(
    `SELECT state, trust_class FROM addon_installations WHERE tenant = ? AND addon_key = ?`,
  ).get(TENANT, addonKey) as { state: string; trust_class: string } | undefined
}

function receiptCount(harness: SqliteD1Harness, addonKey: string): number {
  const row = harness.sqlite.prepare(
    `SELECT COUNT(*) AS c FROM addon_receipts WHERE tenant = ? AND addon_key = ?`,
  ).get(TENANT, addonKey) as { c: number }
  return row.c
}

let violatingKeyCounter = 0

/**
 * Registers a copy of McpwpOfficeAddon with exactly one field mutated, under a fresh
 * key (production registry has no unregister — each probe needs its own identity), and
 * returns that key. `overrides` MUST leave the manifest passing validateAddonManifest +
 * assertAddonRuntimeContract (registerAddon runs both) — the mutation under test is
 * meant to be caught by installAddon's externalIsolationViolation, one layer further in,
 * not by registration itself.
 */
async function registerViolatingVariant(overrides: Partial<AddonManifestV1>): Promise<string> {
  violatingKeyCounter += 1
  const key = `mcpwp-office-invariant-probe-${violatingKeyCounter}`
  const variant: AddonManifestV1 = { ...McpwpOfficeAddon, ...overrides, key }
  await registerAddon(variant)
  return key
}

describe('mcpwp-office addon manifest', () => {
  it('declares an external_mcp / external_isolated addon with a write connector and no rank grants', () => {
    expect(McpwpOfficeAddon).toMatchObject({
      schema: 'mupot.addon/v1',
      key: 'mcpwp-office',
      kind: 'external_mcp',
      trustClass: 'external_isolated',
      publisher: 'mumega',
    })
    expect(McpwpOfficeAddon.authorityRequests.rankGrants).toEqual([])
  })

  it('declares the office department as required', () => {
    expect(McpwpOfficeAddon.departments).toEqual([{ moduleKey: 'office', required: true }])
  })

  it('declares the site-operator agent template inactive by default', () => {
    expect(McpwpOfficeAddon.agentTemplates).toEqual([
      expect.objectContaining({
        key: 'site-operator',
        departmentModuleKey: 'office',
        squadSlug: 'site-operator',
        defaultStatus: 'inactive',
      }),
    ])
  })

  it('declares exactly one required write connector slot accepting mcpwp', () => {
    expect(McpwpOfficeAddon.connectorRequirements).toEqual([
      {
        slot: 'wordpress_site',
        accepts: ['mcpwp'],
        required: true,
        capability: 'write',
        bindingKind: 'vault_connector',
      },
    ])
  })

  it('names office tools as surface grants without implementing them yet', () => {
    const capabilities = McpwpOfficeAddon.authorityRequests.surfaceGrants.map((grant) => grant.capability)
    expect(capabilities).toEqual([
      'office.publish_post',
      'office.list_pending_approvals',
      'office.review_approval',
    ])
    expect(McpwpOfficeAddon.authorityRequests.surfaceGrants.every((grant) => grant.subjectRef === 'site-operator')).toBe(true)
  })

  it('declares both manifest metrics owned by the office department', () => {
    expect(McpwpOfficeAddon.metrics).toEqual([
      { descriptorKey: 'content.posts_published', ownerDepartment: 'office' },
      { descriptorKey: 'office.pending_approvals', ownerDepartment: 'office' },
    ])
  })

  it('gates publish with review and satisfies the write-connector approval-policy invariant', () => {
    expect(McpwpOfficeAddon.approvalPolicies).toEqual(expect.arrayContaining([
      { action: 'wordpress_site', requiredCapability: 'lead', selfApproval: false },
      { action: 'publish', requiredCapability: 'lead', selfApproval: false },
    ]))
  })

  it('declares append-only-safe retention and the task.completed event subscription', () => {
    expect(McpwpOfficeAddon.retention).toEqual({ disablePreservesData: true, purgeRequiresOwner: true })
    expect(McpwpOfficeAddon.eventSubscriptions).toEqual(['task.completed'])
  })

  it('declares two health checks matching src/addons/office/health.ts', () => {
    expect(McpwpOfficeAddon.healthChecks).toEqual([
      'wordpress_site_endpoint_reachable',
      'wordpress_site_key_valid',
    ])
  })

  it('passes validateAddonManifest', () => {
    const result = validateAddonManifest(McpwpOfficeAddon)
    expect(result.ok).toBe(true)
  })

  it('fails validateAddonManifest with missing_approval_policy if the write-connector policy is dropped', () => {
    const withoutBindingPolicy = {
      ...McpwpOfficeAddon,
      approvalPolicies: McpwpOfficeAddon.approvalPolicies.filter((policy) => policy.action !== 'wordpress_site'),
    }
    const result = validateAddonManifest(withoutBindingPolicy)
    expect(result).toEqual({ ok: false, reason: 'missing_approval_policy', path: 'connectorRequirements[0].slot' })
  })

  it('rejects an unregistered ownerDepartment metric — mutation proof of the runtime contract guard', () => {
    // Same manifest, but claim a metric owned by a department that isn't registered.
    // This proves assertAddonRuntimeContract's addon_metric_owner_not_registered guard
    // is live for THIS manifest shape, not just for the framework's own fixtures.
    expect(() => assertAddonRuntimeContract({
      ...McpwpOfficeAddon,
      key: 'mcpwp-office-mutation-probe',
      metrics: [{ descriptorKey: 'content.posts_published', ownerDepartment: 'not-a-real-department' }],
    })).toThrow('addon_metric_owner_not_registered')
  })

  it('the real office department is registered and owns both declared descriptor keys', () => {
    const office = getRegisteredDepartment('office')
    expect(office).toBeDefined()
    const keys = office?.metricsEmitted.map((descriptor) => descriptor.key) ?? []
    expect(keys).toEqual(expect.arrayContaining(['content.posts_published', 'office.pending_approvals']))
  })

  it('passes assertAddonRuntimeContract for the real, unmodified manifest', () => {
    expect(() => assertAddonRuntimeContract(McpwpOfficeAddon)).not.toThrow()
  })

  it('is registered in the production addon catalog and listed alongside the native addons', () => {
    const entry = getRegisteredAddon('mcpwp-office')
    expect(entry).toBeDefined()
    expect(entry?.manifest.key).toBe('mcpwp-office')
    expect(entry?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(listRegisteredAddons().map((catalogEntry) => catalogEntry.manifest.key)).toContain('mcpwp-office')
  })

  // ── The addon door, proven open (mupot#1580 coordinator decision) ───────────
  //
  // src/addons/service.ts installAddon now accepts kind:'external_mcp' once the
  // manifest passes externalIsolationViolation, and
  // migrations/0175_addon_external_isolated.sql widened addon_installations/
  // addon_receipts' trust_class CHECK to admit 'external_isolated'. This section
  // proves the REAL manifest installs, that install is followed all the way
  // through disable (data preserved) and archive (refused for a non-owner actor),
  // and that each of installAddon's four isolation invariants independently
  // refuses a manifest that violates it.

  it('installs the real mcpwp-office manifest and persists trust_class external_isolated', async () => {
    const harness = realHarness()
    const result = await installAddon(realEnv(harness), { id: 'owner-1', role: 'owner' }, 'mcpwp-office')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.created).toBe(true)
    expect(result.state).toBe('installed')
    expect(result.installation.trustClass).toBe('external_isolated')
    expect(result.installation.addonKey).toBe('mcpwp-office')

    // Not just the TS-typed return value — the widened SQL CHECK actually accepted
    // the row. A pre-0175 CHECK (trust_class = 'native_reviewed') would abort this
    // INSERT and installAddon would surface it as write_failed instead.
    expect(installationRow(harness, 'mcpwp-office')).toEqual({
      state: 'installed',
      trust_class: 'external_isolated',
    })
    harness.close()
  })

  it('is idempotent on a second install call', async () => {
    const harness = realHarness()
    const actor = { id: 'owner-1', role: 'owner' as const }
    const first = await installAddon(realEnv(harness), actor, 'mcpwp-office')
    const second = await installAddon(realEnv(harness), actor, 'mcpwp-office')

    expect(first.ok).toBe(true)
    expect(second).toEqual(first.ok
      ? { ok: true, state: first.state, installation: first.installation, idempotent: true }
      : first)
    harness.close()
  })

  it('disable preserves prior installation data', async () => {
    const harness = realHarness()
    const actor = { id: 'owner-1', role: 'owner' as const }
    const installed = await installAddon(realEnv(harness), actor, 'mcpwp-office')
    expect(installed.ok).toBe(true)
    const receiptsAfterInstall = receiptCount(harness, 'mcpwp-office')
    expect(receiptsAfterInstall).toBeGreaterThan(0)

    const disabled = await disableAddon(realEnv(harness), actor, 'mcpwp-office')

    expect(disabled.ok).toBe(true)
    if (!disabled.ok) throw new Error('unreachable')
    expect(disabled.state).toBe('disabled')
    expect(installationRow(harness, 'mcpwp-office')).toEqual({
      state: 'disabled',
      trust_class: 'external_isolated',
    })
    // "Disable preserves data" — the addon_receipts append-only ledger keeps every
    // prior receipt (install's) and only ADDS the disable receipt; nothing is deleted.
    expect(receiptCount(harness, 'mcpwp-office')).toBe(receiptsAfterInstall + 1)
    harness.close()
  })

  // "purgeRequiresOwner" (retention field) has no distinct 'purge' action anywhere in
  // this codebase — addon_receipts.action's CHECK (migrations/0050_addons.sql) does not
  // even list 'purge' as a valid value, and no service function or MCP/HTTP route by
  // that name exists for ANY addon, native or external. archiveAddon is the closest real
  // analogue (the one teardown action that permanently ends an installation's lifecycle
  // and releases its resource ownership), so this test exercises retention's intent —
  // "a non-owner cannot tear the addon down" — through archiveAddon rather than a
  // fabricated 'purge' call. Reported to the coordinator as a residual naming gap: this
  // does not distinguish 'owner' from 'admin' (authorized() treats both as authorized,
  // same as install/configure/activate/disable), so it proves "refused for member",
  // not "refused for anyone-but-literally-owner" — a stricter reading of
  // purgeRequiresOwner would need a new, narrower authorization predicate, which is new
  // scope beyond this PR's install-door fix.
  it('archive (the nearest real analogue to "purge") is refused for a non-owner actor, and the addon stays disabled', async () => {
    const harness = realHarness()
    const owner = { id: 'owner-1', role: 'owner' as const }
    const installed = await installAddon(realEnv(harness), owner, 'mcpwp-office')
    expect(installed.ok).toBe(true)
    const disabled = await disableAddon(realEnv(harness), owner, 'mcpwp-office')
    expect(disabled.ok).toBe(true)

    const refused = await archiveAddon(realEnv(harness), { id: 'member-1', role: 'member' }, 'mcpwp-office')

    expect(refused).toEqual({ ok: false, reason: 'not_authorized' })
    expect(installationRow(harness, 'mcpwp-office')).toEqual({
      state: 'disabled',
      trust_class: 'external_isolated',
    })
    harness.close()
  })

  it('archive succeeds for the owner once the addon is disabled', async () => {
    const harness = realHarness()
    const owner = { id: 'owner-1', role: 'owner' as const }
    await installAddon(realEnv(harness), owner, 'mcpwp-office')
    await disableAddon(realEnv(harness), owner, 'mcpwp-office')

    const archived = await archiveAddon(realEnv(harness), owner, 'mcpwp-office')

    expect(archived.ok).toBe(true)
    if (!archived.ok) throw new Error('unreachable')
    expect(archived.state).toBe('archived')
    harness.close()
  })

  describe('externalIsolationViolation — one mutation per invariant, mutation-proved', () => {
    const cases: Array<{
      name: string
      overrides: Partial<AddonManifestV1>
      expected: AddonExternalInvariantViolation
    }> = [
      {
        name: 'rank_grants',
        overrides: {
          authorityRequests: {
            rankGrants: [{
              subjectRef: 'site-operator',
              capability: 'member',
              scopeType: 'org',
              scopeRef: null,
              reason: 'invariant probe — must be refused',
            }],
            surfaceGrants: McpwpOfficeAddon.authorityRequests.surfaceGrants,
          },
        },
        expected: 'rank_grants',
      },
      {
        name: 'surface_grant_namespace',
        overrides: {
          authorityRequests: {
            rankGrants: [],
            surfaceGrants: [
              { subjectRef: 'site-operator', capability: 'core.everything', reason: 'invariant probe' },
            ],
          },
        },
        expected: 'surface_grant_namespace',
      },
      {
        name: 'connector_binding_kind',
        overrides: {
          connectorRequirements: [{
            slot: 'wordpress_site',
            accepts: ['mcpwp'],
            required: true,
            capability: 'write',
            bindingKind: 'internal_adapter',
          }],
        },
        expected: 'connector_binding_kind',
      },
      {
        name: 'loops_not_allowed',
        overrides: {
          loops: [{ templateKey: 'invariant-probe-template', defaultState: 'disabled', approvalRequired: true }],
        },
        expected: 'loops_not_allowed',
      },
      {
        name: 'event_subscription_allowlist',
        overrides: { eventSubscriptions: ['agent.wake'] },
        expected: 'event_subscription_allowlist',
      },
    ]

    for (const testCase of cases) {
      it(`refuses ${testCase.name}`, async () => {
        // Unit-level: the pure function called directly, independent of the DB.
        expect(externalIsolationViolation({ ...McpwpOfficeAddon, ...testCase.overrides })).toBe(testCase.expected)

        // Integration-level: the SAME violation, through the real installAddon call,
        // against real SQLite — proves the check actually gates the lifecycle door,
        // not just the standalone function.
        const harness = realHarness()
        const key = await registerViolatingVariant(testCase.overrides)
        const result = await installAddon(realEnv(harness), { id: 'owner-1', role: 'owner' }, key)
        expect(result).toEqual({ ok: false, reason: `addon_external_invariant:${testCase.expected}` })
        expect(installationRow(harness, key)).toBeUndefined()
        harness.close()
      })
    }

    it('passes with zero violations for the real, unmodified manifest', () => {
      expect(externalIsolationViolation(McpwpOfficeAddon)).toBeNull()
    })
  })
})
