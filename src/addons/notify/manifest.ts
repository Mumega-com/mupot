import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

// The notify kernel's add-on seat (src/notify/). Subscribing is inert until a tenant installs and activates it:
// src/addons/event-dispatch.ts delivers only to ACTIVE installations. The design called this key `mupot.notify`;
// manifest keys must match /^[a-z0-9-]{3,64}$/ (src/addons/contract.ts KEY_PATTERN), so it is `mupot-notify`.
export const NotifyAddon = Object.freeze<AddonManifestV1>({
  schema: 'mupot.addon/v1',
  key: 'mupot-notify',
  name: 'Notify',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.30.0',
  addonApiCompatibility: '^1.0.0', // addon contract (src/addons/api-version.ts); mupotCompatibility above is a frozen digest-bound legacy pin; native-only claim, excluded from the digest — never bump mupotCompatibility on a product release
  kind: 'native',
  description: 'Notification kernel: one outbox, one carry table.',
  departments: [],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [],
  playbooks: [],
  loops: [],
  consoleSections: [],
  eventSubscriptions: ['task.review', 'task.blocked', 'backup.result'],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
})

await registerAddon(NotifyAddon)
