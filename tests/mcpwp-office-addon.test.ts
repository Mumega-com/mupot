// mupot#1580 slice 1 — mcpwp-office addon: manifest, registration, runtime-contract,
// and the addon-door lifecycle (install/disable/archive) for an external_mcp addon.
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() — this file
// imports production code (src/addons/service.ts's installAddon/disableAddon/
// archiveAddon), so per scripts/check-test-schema-source.mjs it must build its schema
// from the committed migration chain (migrations/0175_addon_external_isolated.sql adds
// the isolation_class column that makes an 'external_isolated' row persistable at all —
// an ADD COLUMN, not a table rebuild; see that file's header for why).

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
  activateAddon,
  archiveAddon,
  configureAddon,
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
    `SELECT state, trust_class, isolation_class FROM addon_installations WHERE tenant = ? AND addon_key = ?`,
  ).get(TENANT, addonKey) as { state: string; trust_class: string; isolation_class: string } | undefined
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

/**
 * Seeds an 'installed' row (+ its matching install receipt) DIRECTLY via SQL for an
 * already-registered key — bypassing installAddon's own trustGateViolation entirely.
 * This is what lets the configureAddon/activateAddon tests below prove those two
 * functions independently re-check the SAME shared predicate, rather than merely
 * inheriting install's earlier refusal: for a violating manifest, installAddon would
 * refuse before ever creating this row, so the only way to exercise configureAddon's/
 * activateAddon's OWN gate is to hand-seed a row as if install had (incorrectly)
 * succeeded — mirroring exactly the two-statement shape installAddon's own batch writes.
 */
function seedInstalledRow(harness: SqliteD1Harness, key: string, actorId = 'owner-1'): void {
  const entry = getRegisteredAddon(key)
  if (!entry) throw new Error(`fixture error: ${key} is not registered`)
  const installationId = `seed-install-${key}`
  const receiptId = `seed-receipt-${key}`
  const now = '2026-01-01T00:00:00.000Z'
  // addon_installations' FK to addon_receipts is DEFERRABLE INITIALLY DEFERRED — but
  // that only defers to the END OF THE ENCLOSING TRANSACTION. Two separate .run() calls
  // in autocommit mode are each their own implicit transaction, so the deferred check
  // still fires immediately after the FIRST insert (before the receipt exists) and
  // throws FOREIGN KEY constraint failed. An explicit BEGIN/COMMIT around both — exactly
  // how installAddon's own env.DB.batch() commits both statements atomically — defers
  // the check to COMMIT, by which point both rows exist.
  harness.sqlite.exec('BEGIN')
  try {
    harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES (?, ?, ?, ?, ?, 'native_reviewed', ?, ?, 'installed', NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      installationId, TENANT, entry.manifest.key, entry.manifest.version, entry.manifest.publisher,
      entry.manifestSha256, entry.manifest.mupotCompatibility, actorId, actorId, receiptId, now, now,
      entry.manifest.trustClass,
    )
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES (?, ?, ?, 'install', NULL, 'installed', ?, ?, ?, 'native_reviewed', ?, ?, ?, 'pass', '[]', '{}', ?, ?)
    `).run(
      receiptId, TENANT, installationId, entry.manifest.key, entry.manifest.version, entry.manifest.publisher,
      entry.manifest.mupotCompatibility, entry.manifestSha256, actorId, now, entry.manifest.trustClass,
    )
    harness.sqlite.exec('COMMIT')
  } catch (error) {
    harness.sqlite.exec('ROLLBACK')
    throw error
  }
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
      { action: 'office.publish', requiredCapability: 'lead', selfApproval: false },
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
  // src/addons/service.ts installAddon/configureAddon/activateAddon now accept
  // kind:'external_mcp' once the manifest passes externalIsolationViolation, and
  // migrations/0175_addon_external_isolated.sql added the isolation_class column
  // (NOT a trust_class rebuild — see that file's header for why: D1 applies a
  // migration in one transaction, and 7 live tables hold ON DELETE RESTRICT FKs
  // to addon_installations, so a drop/recreate would fail on any populated tenant).
  // This section proves the REAL manifest installs, that install is followed all
  // the way through disable (data preserved) and archive (refused for a
  // non-owner actor), and that each isolation invariant independently refuses a
  // manifest that violates it.

  it('installs the real mcpwp-office manifest and persists isolation_class external_isolated', async () => {
    const harness = realHarness()
    const result = await installAddon(realEnv(harness), { id: 'owner-1', role: 'owner' }, 'mcpwp-office')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.created).toBe(true)
    expect(result.state).toBe('installed')
    expect(result.installation.trustClass).toBe('external_isolated')
    expect(result.installation.addonKey).toBe('mcpwp-office')

    // Not just the TS-typed return value — the widened schema actually accepted the
    // row. A pre-0175 schema (no isolation_class column at all) would abort this
    // INSERT and installAddon would surface it as write_failed instead. trust_class
    // (legacy, migrations/0175) stays frozen at 'native_reviewed' forever — never a
    // lie, because it's retired, not repurposed; isolation_class is the real value.
    expect(installationRow(harness, 'mcpwp-office')).toEqual({
      state: 'installed',
      trust_class: 'native_reviewed',
      isolation_class: 'external_isolated',
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
      trust_class: 'native_reviewed',
      isolation_class: 'external_isolated',
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
      trust_class: 'native_reviewed',
      isolation_class: 'external_isolated',
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
        name: 'agent_template_namespace',
        overrides: {
          agentTemplates: [{ ...McpwpOfficeAddon.agentTemplates[0], departmentModuleKey: 'fixture' }],
        },
        expected: 'agent_template_namespace',
      },
      {
        // 'fixture' must ALSO be declared (assertAddonRuntimeContract requires a
        // metric's ownerDepartment to be one of the manifest's OWN declared
        // departments) — this is deliberately the ONE case that also has 2
        // departments, and still reports metric_namespace, not multiple_departments,
        // because externalIsolationViolation checks metrics against departments[0]
        // ('office') BEFORE its final "exactly one department" check.
        name: 'metric_namespace',
        overrides: {
          departments: [{ moduleKey: 'office', required: true }, { moduleKey: 'fixture', required: true }],
          // 'fixture.pings' is a REAL descriptor FixtureModule emits (departments/
          // modules/fixture.ts) — assertAddonRuntimeContract requires the descriptor
          // to actually exist under the claimed owner, not just the owner to be declared.
          metrics: [{ descriptorKey: 'fixture.pings', ownerDepartment: 'fixture' }],
        },
        expected: 'metric_namespace',
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
        // P3 fix, round 1 SURVIVOR: isNamespacedUnder requires the literal '.' boundary
        // ('office.') — a bare `startsWith(moduleKey)` would let 'officeX.exploit' pass
        // as if it were namespaced under 'office', since the strings share a prefix
        // without sharing a namespace. Same-string-prefix lookalike, not a real dotted
        // child of departments[0].
        name: 'surface_grant_namespace_prefix_lookalike',
        overrides: {
          authorityRequests: {
            rankGrants: [],
            surfaceGrants: [
              {
                subjectRef: 'site-operator',
                capability: 'officeX.exploit',
                reason: 'invariant probe — prefix lookalike must not pass as namespaced',
              },
            ],
          },
        },
        expected: 'surface_grant_namespace',
      },
      {
        name: 'approval_policy_namespace',
        overrides: {
          approvalPolicies: [
            { action: 'wordpress_site', requiredCapability: 'lead', selfApproval: false },
            { action: 'automate', requiredCapability: 'lead', selfApproval: false },
          ],
        },
        expected: 'approval_policy_namespace',
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
      {
        // Every other field still points at departments[0] ('office') alone — the
        // shape that would slip past every per-field namespace check above and is
        // only caught by the final "exactly one department" structural gate.
        name: 'multiple_departments',
        overrides: {
          departments: [{ moduleKey: 'office', required: true }, { moduleKey: 'fixture', required: true }],
        },
        expected: 'multiple_departments',
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

  // P2 fix: the trust gate (kind/trustClass pairing + externalIsolationViolation) is a
  // SHARED predicate, called from installAddon, configureAddon, AND activateAddon — not
  // install alone. These two tests seed an 'installed' row directly (see
  // seedInstalledRow's doc comment) for a manifest registered with a rank_grants
  // violation, so installAddon is never involved — proving configureAddon/activateAddon
  // check the SAME predicate independently, not merely inheriting install's refusal.
  describe('the shared trust gate is also enforced at configure and activate', () => {
    const violatingOverrides: Partial<AddonManifestV1> = {
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
    }

    it('configureAddon refuses', async () => {
      const harness = realHarness()
      const key = await registerViolatingVariant(violatingOverrides)
      seedInstalledRow(harness, key)

      const result = await configureAddon(realEnv(harness), { id: 'owner-1', role: 'owner' }, key)

      expect(result).toEqual({ ok: false, reason: 'addon_external_invariant:rank_grants' })
      harness.close()
    })

    it('activateAddon refuses', async () => {
      const harness = realHarness()
      const key = await registerViolatingVariant(violatingOverrides)
      seedInstalledRow(harness, key)

      const result = await activateAddon(realEnv(harness), { id: 'owner-1', role: 'owner' }, key)

      expect(result).toEqual({ ok: false, reason: 'addon_external_invariant:rank_grants', state: 'installed' })
      harness.close()
    })
  })
})
