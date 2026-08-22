// scripts/provision-wfp-tenant.mjs — Automated provisioning script for WFP tenant pots.
//
// Generates the Cloudflare REST API commands to stand up a new isolated pot
// in the `mupot-pots` dispatch namespace with dedicated D1 and collapsed KV.

import { planClientTenant } from '../src/reseller/client-tenant.js'

export function generateWfpProvisioningCommands(input) {
  const plan = planClientTenant(input)
  if (!plan.ok) {
    throw new Error(`Tenant planning failed: ${plan.reason} - ${plan.detail || ''}`)
  }

  const { tenantSlug, tier } = plan

  return {
    tenantSlug,
    tier,
    resources: {
      d1Database: `mupot-${tenantSlug}-db`,
      kvNamespace: `mupot-${tenantSlug}-kv`,
      r2Bucket: `mupot-${tenantSlug}-blobs`,
      queue: `mupot-${tenantSlug}-events`,
      dispatchNamespace: 'mupot-pots',
      userWorkerScript: `pot-${tenantSlug}`,
    },
    commands: [
      `# 1. Create isolated D1 database`,
      `npx wrangler d1 create mupot-${tenantSlug}-db`,
      ``,
      `# 2. Create collapsed single KV namespace (prefixed sess: and oauth:)`,
      `npx wrangler kv:namespace create SESSIONS --binding SESSIONS`,
      ``,
      `# 3. Apply schema migration chain to new D1 database`,
      `npx wrangler d1 migrations apply mupot-${tenantSlug}-db --remote`,
      ``,
      `# 4. Upload user Worker script to WFP dispatch namespace`,
      `npx wrangler deploy --dispatch-namespace mupot-pots --name pot-${tenantSlug} --var TENANT_SLUG:${tenantSlug} --var BRAND:"${plan.clientName}"`,
    ],
    plan,
  }
}
