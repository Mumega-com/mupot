import { AgencyModule } from '../../departments/modules/agency'
import { GrowthModule } from '../../departments/modules/growth'
import { WebOpsModule } from '../../departments/modules/web-ops'
import {
  loadMarketingCroMonitorView,
  marketingCroMonitorBody,
} from '../../dashboard/marketing-cro-monitor'
import type { AddonManifestV1 } from '../contract'
import { registerAddonConsoleRenderer } from '../console-registry'
import { registerAddon } from '../registry'

const DASHBOARD_READER = { id: 'addon-console', role: 'admin' as const }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key))
    }
    Object.freeze(value)
  }
  return value
}

export const MarketingCroMonitorAddon = deepFreeze<AddonManifestV1>({
  schema: 'mupot.addon/v1',
  key: 'marketing-cro-monitor',
  name: 'Marketing & CRO Monitor',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.24.0',
  kind: 'native',
  description: 'Read-only marketing and conversion monitoring.',
  departments: [
    { moduleKey: GrowthModule.key, required: true },
    { moduleKey: AgencyModule.key, required: true },
    { moduleKey: WebOpsModule.key, required: true },
  ],
  agentTemplates: [],
  connectorRequirements: [
    { slot: 'web_analytics', accepts: ['first_party', 'posthog'], required: true, capability: 'read', bindingKind: 'either' },
    { slot: 'content_surface', accepts: ['inkwell', 'mcpwp'], required: false, capability: 'read', bindingKind: 'either' },
    { slot: 'search_performance', accepts: ['google_search_console'], required: false, capability: 'read', bindingKind: 'vault_connector' },
    { slot: 'crm', accepts: ['ghl', 'crm'], required: false, capability: 'read', bindingKind: 'vault_connector' },
    { slot: 'ai_visibility', accepts: ['ai_visibility'], required: false, capability: 'read', bindingKind: 'either' },
  ],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [],
  playbooks: [],
  loops: [{ templateKey: 'website-opportunity-review', defaultState: 'disabled', approvalRequired: true }],
  consoleSections: [{ rendererKey: 'marketing-cro-monitor', path: '/addons/marketing-cro-monitor', title: 'Marketing & CRO', navIcon: 'chart-no-axes-combined' }],
  eventSubscriptions: [],
  approvalPolicies: [{ action: 'promote_recommendation', requiredCapability: 'owner', selfApproval: false }],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
})

registerAddonConsoleRenderer({
  key: 'marketing-cro-monitor',
  path: '/addons/marketing-cro-monitor',
  title: 'Marketing & CRO',
  navIcon: 'chart-no-axes-combined',
  render: async (env, installation) => {
    if (!installation) throw new Error('addon_console_installation_required')
    const view = await loadMarketingCroMonitorView(env, installation, DASHBOARD_READER)
    return marketingCroMonitorBody(view)
  },
})

await registerAddon(MarketingCroMonitorAddon)
