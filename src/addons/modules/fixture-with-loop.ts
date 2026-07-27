// mupot — lifecycle fixture with a declared loop (#471 test fixture).
//
// Mirrors fixture.ts (same FixtureModule department, no authority, no connectors) but
// adds a `loops` entry so addon-loop-instantiation tests can exercise ensureLoopClaim /
// releaseLoopClaim through the real activateAddon/disableAddon/archiveAddon paths
// without marketing-cro-monitor's connector-heavy activation preconditions. Reuses the
// REAL 'website-opportunity-review' template (registered by marketing-cro-monitor.ts),
// so this fixture also proves that production template works end to end.

import { FixtureModule } from '../../departments/modules/fixture'
import { html } from 'hono/html'
import { registerAddonConsoleRenderer } from '../console-registry'
import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

export const FixtureAddonWithLoop: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-addon-with-loop',
  name: 'Fixture Addon With Loop',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.24.0',
  kind: 'native',
  description: 'Lifecycle fixture with a declared loop, no authority.',
  departments: [{ moduleKey: FixtureModule.key, required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [{ descriptorKey: 'fixture.pings', ownerDepartment: 'fixture' }],
  playbooks: [],
  loops: [{ templateKey: 'website-opportunity-review', defaultState: 'disabled', approvalRequired: true }],
  consoleSections: [{ rendererKey: 'fixture-with-loop', path: '/departments/fixture-with-loop', title: 'Fixture With Loop', navIcon: 'beaker' }],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

registerAddonConsoleRenderer({
  key: 'fixture-with-loop',
  path: '/departments/fixture-with-loop',
  title: 'Fixture With Loop',
  navIcon: 'beaker',
  render: async () => html`<p>Fixture With Loop</p>`,
})

await registerAddon(FixtureAddonWithLoop)
