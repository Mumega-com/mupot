// mupot#1580 slice 1 — mcpwp-office addon: manifest, registration, runtime-contract,
// and the current install-lifecycle gap (see src/addons/office/manifest.ts's header
// comment and the PR description for the full gap report).
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() — this file
// imports production code (src/addons/service.ts's installAddon), so per
// scripts/check-test-schema-source.mjs it must build its schema from the committed
// migration chain. The "no DB access" proof below wraps the REAL db in a proxy that
// throws on any prepare()/batch() call, rather than faking D1 with a hand-written
// double — a real (unused) schema underneath, not an invented one.

import type { D1Database } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { validateAddonManifest } from '../src/addons/contract'
import { assertAddonRuntimeContract, getRegisteredAddon, listRegisteredAddons } from '../src/addons/registry'
import { getRegistered as getRegisteredDepartment } from '../src/departments/registry'
import { McpwpOfficeAddon } from '../src/addons/office/manifest'
import { installAddon } from '../src/addons/service'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

function tripwireEnv(): Env {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const db = new Proxy(harness.db, {
    get(target, prop, receiver) {
      if (prop === 'prepare' || prop === 'batch') {
        throw new Error(`tripwire: unexpected DB access via ${String(prop)}()`)
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as D1Database
  return { DB: db, TENANT_SLUG: 'tenant-office-a' } as Env
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

  // ── KNOWN FRAMEWORK GAP (pinned, not routed around) ─────────────────────────
  //
  // src/addons/service.ts installAddon (around line 2611) refuses any manifest
  // whose (kind, trustClass) isn't exactly ('native', 'native_reviewed') — and
  // addon_installations/addon_receipts carry a SQL CHECK (trust_class =
  // 'native_reviewed') at the schema level (migrations/0050_addons.sql). This test
  // pins that CURRENT, documented behavior for this external_mcp manifest: the
  // in-memory refusal happens before any DB access (proved with a tripwire DB),
  // so a caller never gets a half-written row. Extending the lifecycle to accept
  // external_isolated addons is a schema-migration decision, out of scope here —
  // see the PR description.
  it('installAddon refuses this external_mcp manifest before touching the database (documented gap)', async () => {
    const result = await installAddon(tripwireEnv(), { id: 'owner-1', role: 'owner' }, 'mcpwp-office')
    expect(result).toEqual({ ok: false, reason: 'invalid_state' })
  })

  // Both blocked on the SAME gap as the test above: disableAddon/archiveAddon (and the
  // "disable preserves data" / "purge refused for non-owner" behaviors this task asked
  // for) all require an installed row first, and installAddon cannot produce one for an
  // external_mcp manifest today (in-code gate + the addon_installations.trust_class SQL
  // CHECK). Left as explicit, visible gaps rather than faked passes or silently dropped —
  // see the PR description / follow-up issue for the schema-migration work that unblocks
  // both.
  it.todo('disable preserves prior installation data once addon_install supports external_mcp (mupot#1580 follow-up)')
  it.todo('purge is refused for a non-owner actor once addon_install supports external_mcp (mupot#1580 follow-up)')
})
