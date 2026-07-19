import { FixtureModule } from '../../departments/modules/fixture'
import { html } from 'hono/html'
import { registerAddonConsoleRenderer } from '../console-registry'
import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

export const FixtureAddon: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-addon',
  name: 'Fixture Addon',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.24.0',
  kind: 'native',
  description: 'Lifecycle fixture with no authority.',
  departments: [{ moduleKey: FixtureModule.key, required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [{ descriptorKey: 'fixture.pings', ownerDepartment: 'fixture' }],
  playbooks: [],
  loops: [],
  consoleSections: [{ rendererKey: 'fixture', path: '/departments/fixture', title: 'Fixture', navIcon: 'beaker' }],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

registerAddonConsoleRenderer({
  key: 'fixture',
  path: '/departments/fixture',
  title: 'Fixture',
  navIcon: 'beaker',
  render: async () => html`<p>Fixture</p>`,
})

await registerAddon(FixtureAddon)
