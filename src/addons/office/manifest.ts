// mupot — mcpwp-office addon manifest (mupot#1580 slice 1).
//
// "WordPress as each pot's office": an external_mcp / external_isolated addon
// (the mcpwp WordPress plugin's own MCP endpoint is the trust boundary — this pot
// never runs WordPress code, it only calls out to it) that declares the `office`
// department, a `site-operator` agent template, one write-capable connector slot,
// and the office_* tool names the surface will expose. Registered the same way
// project-link and workflow-circuits register themselves
// (src/addons/project-link/manifest.ts, src/addons/workflow-circuits/manifest.ts):
// one manifest object + one `await registerAddon(...)` call, then imported once
// from src/addons/modules/index.ts (the module list every addon consumer imports
// as a side effect — src/dashboard/addons.ts, src/mcp/addons.ts, src/addons/service.ts
// all do `import '../addons/modules'` / `import './modules'`).
//
// SLICE 2 (mupot#1580 T2) implements the office_* tools named below in
// authorityRequests.surfaceGrants and wires the connectorRequirements binding
// through configureAddon. This slice declares the manifest, registers it, proves
// it validates + passes the runtime contract, ships the health-check function
// (src/addons/office/health.ts) that slice 2's tools will call before any
// WordPress write, and (coordinator decision, same PR) closes the addon-door
// gap this manifest first exposed: `addon_install`/`addon_configure`/
// `addon_activate` now accept a kind:'external_mcp' manifest once it passes
// externalIsolationViolation (src/addons/service.ts, checked at every one of
// those three writes, not install alone) — rankGrants empty, every
// surfaceGrants/metrics/agentTemplates entry namespaced under this manifest's
// OWN single department (never any other registered department), every
// connectorRequirement bindingKind exactly 'vault_connector', no loops, and
// eventSubscriptions restricted to an allowlist. addon_installations/
// addon_receipts gained a NEW `isolation_class` column (migrations/
// 0175_addon_external_isolated.sql — an ADD COLUMN, not a rebuild; see that
// file for why the legacy `trust_class` column is untouched) that is the real
// source of truth for an installation's trust class going forward. This
// manifest satisfies every invariant (verified in
// tests/mcpwp-office-addon.test.ts) and installs for real.

import type { AddonManifestV1 } from '../contract'
import { registerAddon } from '../registry'
import '../../departments/modules/office'

export const McpwpOfficeAddon: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'mcpwp-office',
  name: 'Office (WordPress)',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'external_isolated',
  // Pinned as a literal, like the native addons' mupotCompatibility — NOT
  // derived from MUPOT_PUBLIC_API_VERSION. An external_isolated addon gets
  // no one-minor grace band (supportsAdditiveNativePreviousMinor is native-
  // only by design: "external addons remain on strict semver compatibility"),
  // so a derived value meant every version bump, patches included, would
  // drift every live installation's identity and need its own backfill
  // migration (found in mupot#1604's adversarial gate). Bump this by hand
  // alongside the native manifests' compat strings at each release.
  mupotCompatibility: '^0.31.0',
  kind: 'external_mcp',
  description: 'WordPress as each pot’s office — publish and review content through the mcpwp MCP endpoint under gate.',
  departments: [{ moduleKey: 'office', required: true }],
  agentTemplates: [
    {
      key: 'site-operator',
      name: 'Site Operator',
      role: 'Runs the office (the pot’s WordPress site) under gate',
      departmentModuleKey: 'office',
      squadSlug: 'site-operator',
      defaultStatus: 'inactive',
    },
  ],
  connectorRequirements: [
    {
      slot: 'wordpress_site',
      accepts: ['mcpwp'],
      required: true,
      capability: 'write',
      bindingKind: 'vault_connector',
    },
  ],
  authorityRequests: {
    rankGrants: [],
    // Tool names only — implemented in slice 2 (mupot#1580 T2). Naming them now
    // in the manifest lets Athena's gate review the intended surface before any
    // tool exists to call.
    surfaceGrants: [
      {
        subjectRef: 'site-operator',
        capability: 'office.publish_post',
        reason: 'Publish or update WordPress content through the gated office department (slice 2, mupot#1580 T2).',
      },
      {
        subjectRef: 'site-operator',
        capability: 'office.list_pending_approvals',
        reason: 'List content awaiting review before publish (slice 2).',
      },
      {
        subjectRef: 'site-operator',
        capability: 'office.review_approval',
        reason: 'Approve or reject a pending publish request under the with-review policy (slice 2).',
      },
    ],
  },
  metrics: [
    { descriptorKey: 'content.posts_published', ownerDepartment: 'office' },
    { descriptorKey: 'office.pending_approvals', ownerDepartment: 'office' },
  ],
  playbooks: [],
  loops: [],
  consoleSections: [],
  eventSubscriptions: ['task.completed'],
  approvalPolicies: [
    // Satisfies src/addons/contract.ts's write-connector invariant (validateAddonManifest:
    // "a required, capability:'write' connectorRequirements entry must have an
    // approvalPolicy whose action equals its slot" — connectorRequirements[0].slot is
    // 'wordpress_site', so an action of that exact name is required independent of the
    // domain-level 'office.publish' policy below). This is also the one approvalPolicies
    // action externalIsolationViolation exempts from its own-department-namespace
    // requirement (src/addons/service.ts) — it is named after a connector slot this
    // manifest itself declares, not a bare/unnamespaced action.
    { action: 'wordpress_site', requiredCapability: 'lead', selfApproval: false },
    // The domain-level "publish = with review" policy named in the brief. Namespaced
    // under this addon's own 'office' department (externalIsolationViolation's
    // approval_policy_namespace invariant — an external addon may not declare an
    // unnamespaced action like bare 'publish', which could read as a core-surface gate).
    // Distinct from the binding-gate policy above: this one gates the
    // office.publish_post tool itself (slice 2), the way WordpressChannel's own
    // content-publish work-type requires 'lead' (src/departments/channels/wordpress-channel.ts).
    { action: 'office.publish', requiredCapability: 'lead', selfApproval: false },
  ],
  healthChecks: ['wordpress_site_endpoint_reachable', 'wordpress_site_key_valid'],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

await registerAddon(McpwpOfficeAddon)
