import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

export const ProjectLinkAddon = Object.freeze<AddonManifestV1>({
  schema: 'mupot.addon/v1',
  key: 'project-link',
  name: 'Project Link',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.23.0',
  kind: 'native',
  description: 'Signed, bounded collaboration between sovereign Mupot projects.',
  departments: [],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [],
  playbooks: [],
  loops: [],
  consoleSections: [],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
})

await registerAddon(ProjectLinkAddon)
