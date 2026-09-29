// tests/addon-authority-grants-native-pin.test.ts — P2-1 (kasra-review adversarial
// round 1, PR #1588): src/addons/service.ts's authorityGrantsAllowed narrows the
// "every addon's authorityRequests must be empty" rule so mcpwp-office (an
// external_mcp addon) may declare a namespaced surfaceGrants array. The narrowed
// rule still requires rankGrants to ALWAYS be empty, and requires ANY grant on a
// kind:'native' manifest to be refused exactly as it was refused before this
// narrowing existed — a compiled-in addon has no per-field isolation proof the way
// an external_mcp manifest does (externalIsolationViolation), so requesting ANY
// authority (rank or surface) must still be refused for it.
//
// The adversarial gate's own mutation run found that NOTHING in the existing suite
// pins this: replacing authorityGrantsAllowed with `return true` left every
// existing test (addon-contract, project-link, addon-loop-instantiation, mcpwp-
// office-addon, addon-service, mcp-addon-tools, marketing-cro-monitor*, workflow-
// circuit*) green, because none of them registers a NATIVE addon with a nonempty
// rankGrants or surfaceGrants array — every existing native fixture (fixture-addon,
// fixture-addon-with-loop, ...) declares authorityRequests: { rankGrants: [],
// surfaceGrants: [] }. These two fixtures are new, minimal native manifests that
// exist ONLY to give authorityGrantsAllowed's native branch something real to
// refuse. Reusing FixtureModule (already registered by src/addons/modules/fixture.ts,
// imported for its side effect below) keeps each fixture to the bare minimum
// (empty metrics/consoleSections/connectorRequirements/approvalPolicies) needed to
// pass assertAddonRuntimeContract, so this file adds no new registered department.

import { describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import '../src/addons/modules/fixture'
import { FixtureModule } from '../src/departments/modules/fixture'
import { registerAddon, getRegisteredAddon } from '../src/addons/registry'
import type { AddonManifestV1 } from '../src/addons/contract'
import { installAddon, configureAddon, activateAddon } from '../src/addons/service'

const TENANT = 'tenant-authority-grants-pin'

function env(): Env {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return { DB: harness.db, TENANT_SLUG: TENANT } as Env
}

const owner = { id: 'owner-1', role: 'owner' as const }

const NATIVE_WITH_RANK_GRANT: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-native-rank-grant-pin',
  name: 'Fixture Native Rank Grant Pin',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.30.0',
  kind: 'native',
  description: 'P2-1 pin fixture: a native addon requesting a rank grant.',
  departments: [{ moduleKey: FixtureModule.key, required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: {
    rankGrants: [{ subjectRef: 'anyone', capability: 'admin', scopeType: 'org', scopeRef: null, reason: 'P2-1 pin' }],
    surfaceGrants: [],
  },
  metrics: [],
  playbooks: [],
  loops: [],
  consoleSections: [],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

const NATIVE_WITH_SURFACE_GRANT: AddonManifestV1 = {
  ...NATIVE_WITH_RANK_GRANT,
  key: 'fixture-native-surface-grant-pin',
  name: 'Fixture Native Surface Grant Pin',
  description: 'P2-1 pin fixture: a native addon requesting a surface grant.',
  authorityRequests: {
    rankGrants: [],
    surfaceGrants: [{ subjectRef: 'anyone', capability: 'fixture.do_something', reason: 'P2-1 pin' }],
  },
}

describe('authorityGrantsAllowed pins a NATIVE addon with nonempty grants (P2-1)', () => {
  it('refuses configure AND activate for a native addon with a nonempty rankGrants array', async () => {
    await registerAddon(NATIVE_WITH_RANK_GRANT)
    expect(getRegisteredAddon('fixture-native-rank-grant-pin')).toBeDefined()

    const testEnv = env()
    const installed = await installAddon(testEnv, owner, 'fixture-native-rank-grant-pin')
    expect(installed.ok).toBe(true)

    const configured = await configureAddon(testEnv, owner, 'fixture-native-rank-grant-pin', {})
    expect(configured).toMatchObject({ ok: false, reason: 'invalid_state' })

    const activated = await activateAddon(testEnv, owner, 'fixture-native-rank-grant-pin')
    expect(activated).toMatchObject({ ok: false, reason: 'invalid_state' })
  })

  it('refuses configure AND activate for a native addon with a nonempty surfaceGrants array', async () => {
    await registerAddon(NATIVE_WITH_SURFACE_GRANT)
    expect(getRegisteredAddon('fixture-native-surface-grant-pin')).toBeDefined()

    const testEnv = env()
    const installed = await installAddon(testEnv, owner, 'fixture-native-surface-grant-pin')
    expect(installed.ok).toBe(true)

    const configured = await configureAddon(testEnv, owner, 'fixture-native-surface-grant-pin', {})
    expect(configured).toMatchObject({ ok: false, reason: 'invalid_state' })

    const activated = await activateAddon(testEnv, owner, 'fixture-native-surface-grant-pin')
    expect(activated).toMatchObject({ ok: false, reason: 'invalid_state' })
  })
})
