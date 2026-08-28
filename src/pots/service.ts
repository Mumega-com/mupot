// src/pots/service.ts — Cloudflare Workers for Platforms (WFP) Sovereign Pot Provisioner.

import type { Env } from '../types'
import type { SovereignPotProvisionInput, SovereignPotProvisionResult, SovereignPotSummary } from './types'

export const DISPATCH_NAMESPACE = 'mupot-pots'
export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'

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
  const reserved = new Set(['mumega', 'mupot', 'api', 'admin', 'dashboard', 'auth', 'oauth', 'app', 'studio', 'copilot'])
  if (reserved.has(slug)) {
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

export const DEFAULT_SOVEREIGN_WORKER_SCRIPT = `
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const tenant = env.TENANT_SLUG || 'sovereign';
    const brand = env.BRAND || tenant.toUpperCase();
    const publicOrigin = env.PUBLIC_ORIGIN || url.origin;

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      let dbOk = false;
      try {
        if (env.DB) {
          const res = await env.DB.prepare("SELECT 1 as alive").first();
          dbOk = !!res?.alive;
        }
      } catch (e) {
        dbOk = false;
      }

      return new Response(JSON.stringify({
        ok: true,
        status: 'healthy',
        tenant,
        brand,
        isolated: true,
        storage: { d1: dbOk, kv: !!env.SESSIONS },
        public_origin: publicOrigin,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-mupot-tenant': tenant }
      });
    }

    // Studio / Dashboard view
    if (url.pathname === '/' || url.pathname.startsWith('/studio') || url.pathname.startsWith('/copilot') || url.pathname.startsWith('/tasks')) {
      const html = \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>\${brand} · Sovereign Pot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #09090b; color: #f4f4f5; margin: 0; padding: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
    .container { max-width: 600px; width: 100%; background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 36px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: #064e3b; color: #34d399; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 20px; }
    .dot { width: 8px; height: 8px; background: #34d399; border-radius: 50%; }
    h1 { font-size: 28px; font-weight: 700; margin: 0 0 12px 0; color: #ffffff; }
    p { font-size: 15px; line-height: 1.6; color: #a1a1aa; margin: 0 0 24px 0; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .meta-card { background: #121214; border: 1px solid #27272a; border-radius: 8px; padding: 12px 16px; }
    .meta-label { font-size: 12px; color: #71717a; text-transform: uppercase; margin-bottom: 4px; }
    .meta-value { font-size: 14px; font-weight: 600; color: #38bdf8; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge"><div class="dot"></div>Sovereign Cloudflare Isolate</div>
    <h1>\${brand}</h1>
    <p>Dedicated autonomous agent control plane operating with isolated V8 runtime and private D1 storage.</p>
    <div class="meta-grid">
      <div class="meta-card"><div class="meta-label">Tenant Slug</div><div class="meta-value">\${tenant}</div></div>
      <div class="meta-card"><div class="meta-label">Namespace</div><div class="meta-value">mupot-pots</div></div>
      <div class="meta-card"><div class="meta-label">D1 Database</div><div class="meta-value">Dedicated</div></div>
      <div class="meta-card"><div class="meta-label">KV Cache</div><div class="meta-value">Dedicated</div></div>
    </div>
  </div>
</body>
</html>\`;
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-mupot-tenant': tenant }
      });
    }

    // Default API / JSON response
    return new Response(JSON.stringify({
      ok: true,
      tenant,
      brand,
      path: url.pathname,
      message: 'Sovereign Pot User Worker Active',
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-mupot-tenant': tenant }
    });
  }
};
`

export async function applyMigrationsToD1Database(
  cf: CloudflareApiConfig,
  databaseId: string,
  migrationSqlList: string[],
): Promise<{ applied: number; success: boolean }> {
  let applied = 0
  for (const sql of migrationSqlList) {
    if (!sql || !sql.trim()) continue
    await executeD1Query(cf, databaseId, sql)
    applied++
  }
  return { applied, success: true }
}

export interface SovereignSeedOptions {
  tenantSlug: string
  brandName: string
  adminEmail: string
  adminMemberId: string
  adminToken: string
  leadAgentId: string
  leadAgentName: string
  leadAgentToken: string
}

export async function seedSovereignPotD1(
  cf: CloudflareApiConfig,
  databaseId: string,
  opts: SovereignSeedOptions,
): Promise<{ seeded: boolean }> {
  const deptId = `dept-${opts.tenantSlug}-core`
  const squadId = `squad-${opts.tenantSlug}-core`
  const projId = `proj-${opts.tenantSlug}-main`
  const adminTokenId = crypto.randomUUID()
  const agentTokenId = crypto.randomUUID()

  // Compute sha256 of admin & lead agent tokens for member_tokens / agent_keys table
  const adminHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.adminToken))
  const adminHash = Array.from(new Uint8Array(adminHashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  const agentHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.leadAgentToken))
  const agentHash = Array.from(new Uint8Array(agentHashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')

  const statements = [
    // 1. Root department
    `INSERT INTO departments (id, tenant, slug, name, description, created_at)
     VALUES ('${deptId}', '${opts.tenantSlug}', 'core', '${opts.brandName} Operations', 'Core Sovereign Operations Department', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 2. Root core squad
    `INSERT INTO squads (id, tenant, department_id, slug, name, description, created_at)
     VALUES ('${squadId}', '${opts.tenantSlug}', '${deptId}', 'core', 'Core Squad', 'Primary Autonomous Agent Squad', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 3. Lead agent
    `INSERT INTO agents (id, tenant, squad_id, slug, name, role, model, status, created_at)
     VALUES ('${opts.leadAgentId}', '${opts.tenantSlug}', '${squadId}', '${opts.tenantSlug}-lead', '${opts.leadAgentName}', 'lead', 'claude-3-7-sonnet', 'active', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 4. Admin member
    `INSERT INTO members (id, tenant, email, display_name, role, created_at)
     VALUES ('${opts.adminMemberId}', '${opts.tenantSlug}', '${opts.adminEmail}', '${opts.brandName} Administrator', 'owner', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 5. Admin member token
    `INSERT INTO member_tokens (id, tenant, member_id, token_hash, token_prefix, label, created_at)
     VALUES ('${adminTokenId}', '${opts.tenantSlug}', '${opts.adminMemberId}', '${adminHash}', '${opts.adminToken.slice(0, 12)}', 'Primary Admin Token', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 6. Lead Agent key/token
    `INSERT INTO agent_keys (id, tenant, agent_id, key_hash, label, created_at)
     VALUES ('${agentTokenId}', '${opts.tenantSlug}', '${opts.leadAgentId}', '${agentHash}', 'Lead Agent Key', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,

    // 7. Default project
    `INSERT INTO projects (id, tenant, slug, name, description, created_at)
     VALUES ('${projId}', '${opts.tenantSlug}', 'main', '${opts.brandName} Main', 'Primary Sovereign Pot Project', CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING;`,
  ]

  try {
    for (const stmt of statements) {
      await executeD1Query(cf, databaseId, stmt)
    }
    return { seeded: true }
  } catch {
    // Fail-open for partial tables if schema is not yet migrated
    return { seeded: false }
  }
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

  // 3. Apply migrations to isolated D1 database if provided
  let migrationsApplied = 0
  if (input.migrations && input.migrations.length > 0) {
    const migRes = await applyMigrationsToD1Database(cf, d1.uuid, input.migrations)
    migrationsApplied = migRes.applied
  }

  // 4. Generate initial IDs & Tokens
  const adminMemberId = crypto.randomUUID()
  const adminToken = `pot_adm_${crypto.randomUUID().replace(/-/g, '')}`
  const leadAgentId = crypto.randomUUID()
  const leadAgentToken = `pot_agt_${crypto.randomUUID().replace(/-/g, '')}`
  const leadAgentName = `${input.brand_name} Lead Agent`

  // 5. Seed initial root entities into D1 database
  const seedOutcome = await seedSovereignPotD1(cf, d1.uuid, {
    tenantSlug: slug,
    brandName: input.brand_name,
    adminEmail: input.admin_email,
    adminMemberId,
    adminToken,
    leadAgentId,
    leadAgentName,
    leadAgentToken,
  })

  // 6. Upload User Worker script to Dispatch Namespace
  const scriptCode = workerJsCode || DEFAULT_SOVEREIGN_WORKER_SCRIPT
  await uploadUserWorkerToDispatch(cf, slug, scriptCode, {
    d1DatabaseId: d1.uuid,
    kvNamespaceId: kv.id,
    tenantSlug: slug,
    brandName: input.brand_name,
    publicOrigin,
  })

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
    lead_agent_name: leadAgentName,
    lead_agent_token: leadAgentToken,
    migrations_applied: migrationsApplied,
    seeded: seedOutcome.seeded,
    provisioned_at: new Date().toISOString(),
  }
}
