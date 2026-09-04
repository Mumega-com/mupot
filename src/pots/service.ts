// src/pots/service.ts — Cloudflare Workers for Platforms (WFP) Sovereign Pot Provisioner.

import type { Env } from '../types'
import type { SovereignPotProvisionInput, SovereignPotProvisionResult, SovereignPotSummary } from './types'

export const DISPATCH_NAMESPACE = 'mupot-pots'
export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'

// Slugs that can never name a tenant worker. Mirrored by the apex path router
// (src/dispatcher.ts) so reserved names fail fast instead of dispatching.
export const RESERVED_TENANT_SLUGS = new Set([
  'mumega',
  'mupot',
  'api',
  'admin',
  'dashboard',
  'auth',
  'oauth',
  'app',
  'studio',
  'copilot',
])

export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function validateSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!slug || slug.length < 2) return { ok: false, error: 'Slug must be at least 2 characters.' }
  if (slug.length > 40) return { ok: false, error: 'Slug cannot exceed 40 characters.' }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return { ok: false, error: 'Slug must start and end with alphanumeric characters and contain only letters, numbers, and dashes.' }
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return { ok: false, error: `Slug '${slug}' is a reserved system domain.` }
  }
  return { ok: true }
}

export interface CloudflareApiConfig {
  accountId: string
  apiToken: string
}

export async function createD1Database(
  cf: CloudflareApiConfig,
  dbName: string,
): Promise<{ uuid: string; name: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/d1/database`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: dbName }),
  })
  const data = (await res.json()) as { success: boolean; result: { uuid: string; name: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to create D1 database '${dbName}': ${msg}`)
  }
  return data.result
}

export async function createKVNamespace(
  cf: CloudflareApiConfig,
  title: string,
): Promise<{ id: string; title: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })
  const data = (await res.json()) as { success: boolean; result: { id: string; title: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to create KV namespace '${title}': ${msg}`)
  }
  return data.result
}

export async function executeD1Query(
  cf: CloudflareApiConfig,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<unknown> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })
  const data = (await res.json()) as { success: boolean; result: unknown[]; errors: Array<{ message: string }> }
  if (!data.success) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`D1 query failed: ${msg}`)
  }
  return data.result
}

export async function uploadUserWorkerToDispatch(
  cf: CloudflareApiConfig,
  scriptName: string,
  workerJsCode: string,
  bindings: {
    d1DatabaseId: string
    kvNamespaceId: string
    tenantSlug: string
    brandName: string
    publicOrigin: string
  },
): Promise<{ id: string }> {
  const metadata = {
    main_module: 'worker.js',
    bindings: [
      { type: 'd1', name: 'DB', id: bindings.d1DatabaseId },
      { type: 'kv_namespace', name: 'SESSIONS', namespace_id: bindings.kvNamespaceId },
      { type: 'plain_text', name: 'TENANT_SLUG', text: bindings.tenantSlug },
      { type: 'plain_text', name: 'BRAND', text: bindings.brandName },
      { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: bindings.publicOrigin },
    ],
    compatibility_date: '2026-06-01',
    compatibility_flags: ['nodejs_compat'],
  }

  const formData = new FormData()
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json',
  )
  formData.append(
    'worker.js',
    new Blob([workerJsCode], { type: 'application/javascript+module' }),
    'worker.js',
  )

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${scriptName}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cf.apiToken}`,
      },
      body: formData,
    },
  )
  const data = (await res.json()) as { success: boolean; result: { id: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to upload User Worker to dispatch namespace: ${msg}`)
  }
  return data.result
}

export async function listSovereignPots(
  cf: CloudflareApiConfig,
  rootDomain = DEFAULT_ROOT_DOMAIN,
): Promise<SovereignPotSummary[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cf.apiToken}`,
      },
    },
  )
  const data = (await res.json()) as {
    success: boolean
    result: Array<{ id: string; created_on?: string; modified_on?: string }>
  }
  if (!data.success || !data.result) return []

  return data.result.map((item) => ({
    slug: item.id,
    script_name: item.id,
    created_on: item.created_on,
    modified_on: item.modified_on,
    public_url: `https://${item.id}.${rootDomain}`,
    status: 'active',
  }))
}

export async function provisionSovereignPot(
  env: Env,
  input: SovereignPotProvisionInput,
  workerJsCode?: string,
): Promise<SovereignPotProvisionResult> {
  const slug = sanitizeSlug(input.slug)
  const valid = validateSlug(slug)
  if (!valid.ok) {
    throw new Error(valid.error)
  }

  const accountId = input.account_id || env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
  const apiToken = input.cf_api_token || env.SECRET_ENV_CF_API_TOKEN
  if (!apiToken) {
    throw new Error('Cloudflare API Token not configured for pot provisioning.')
  }

  const cf: CloudflareApiConfig = { accountId, apiToken }
  const rootDomain = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).hostname : DEFAULT_ROOT_DOMAIN
  const publicOrigin = `https://${slug}.${rootDomain}`
  const tier = input.plan_tier || 'enterprise'

  // 1. Create Isolated D1 Database
  const dbName = `mupot-pot-${slug}`
  const d1 = await createD1Database(cf, dbName)

  // 2. Create Isolated KV Namespace
  const kvTitle = `mupot-pot-${slug}-kv`
  const kv = await createKVNamespace(cf, kvTitle)

  // 3. Generate initial IDs & Tokens
  const adminMemberId = crypto.randomUUID()
  const adminToken = `pot_adm_${crypto.randomUUID().replace(/-/g, '')}`
  const leadAgentId = crypto.randomUUID()
  const leadAgentToken = `pot_agt_${crypto.randomUUID().replace(/-/g, '')}`

  // 4. If workerJsCode provided, upload to Dispatch Namespace
  if (workerJsCode) {
    await uploadUserWorkerToDispatch(cf, slug, workerJsCode, {
      d1DatabaseId: d1.uuid,
      kvNamespaceId: kv.id,
      tenantSlug: slug,
      brandName: input.brand_name,
      publicOrigin,
    })
  }

  return {
    ok: true,
    slug,
    brand_name: input.brand_name,
    plan_tier: tier,
    d1_database_id: d1.uuid,
    d1_database_name: d1.name,
    kv_namespace_id: kv.id,
    kv_namespace_title: kv.title,
    dispatch_namespace: DISPATCH_NAMESPACE,
    worker_script_name: slug,
    public_origin: publicOrigin,
    admin_email: input.admin_email,
    admin_member_id: adminMemberId,
    admin_token: adminToken,
    admin_login_url: `${publicOrigin}/?token=${adminToken}`,
    lead_agent_id: leadAgentId,
    lead_agent_name: `${input.brand_name} Lead Agent`,
    lead_agent_token: leadAgentToken,
    provisioned_at: new Date().toISOString(),
  }
}
