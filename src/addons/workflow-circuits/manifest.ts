import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'

// workflow-circuits — a deterministic workflow-graph engine agents drive
// entirely through MCP tools (src/mcp/workflow-circuits.ts). "Circuit
// schematic," not a router: every node and wire is declared up front at
// define_circuit time (src/addons/workflow-circuits/service.ts), never
// decided at runtime by a model. Modeled on project-link's manifest
// (src/addons/project-link/manifest.ts) — empty department/agent/connector/
// authority declarations, no departments or capability grants requested,
// same registerAddon() wiring into the generic addon lifecycle
// (addon_installations/addon_receipts, src/addons/service.ts) that every
// addon shares. This addon's own domain tables are
// migrations/0072_workflow_circuits.sql.
export const WorkflowCircuitsAddon = Object.freeze<AddonManifestV1>({
  schema: 'mupot.addon/v1',
  key: 'workflow-circuits',
  name: 'Workflow Circuits',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.24.0',
  kind: 'native',
  description: 'Deterministic workflow-graph engine: gated node/edge circuits agents drive through MCP tools.',
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

await registerAddon(WorkflowCircuitsAddon)
