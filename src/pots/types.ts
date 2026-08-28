// src/pots/types.ts — Types for Sovereign Multi-Tenant Pot Provisioning via WFP.

export type SovereignPotTier = 'pro' | 'enterprise' | 'custom'

export interface SovereignPotProvisionInput {
  /** Unique subdomain slug, e.g. "gaf", "viamar" */
  slug: string
  /** Display name of the business / org */
  brand_name: string
  /** Admin contact email for initial invitation */
  admin_email: string
  /** Optional admin full name */
  admin_name?: string
  /** Selected commercial tier */
  plan_tier?: SovereignPotTier
  /** Optional custom domain (CNAME) */
  custom_domain?: string
  /** Optional migration SQL statements to apply */
  migrations?: string[]
  /** Cloudflare API token override (falls back to env.SECRET_ENV_CF_API_TOKEN) */
  cf_api_token?: string
  /** Cloudflare Account ID override (falls back to env.SECRET_ENV_CF_ACCOUNT_ID) */
  account_id?: string
}

export interface SovereignPotProvisionResult {
  ok: boolean
  slug: string
  brand_name: string
  plan_tier: SovereignPotTier
  d1_database_id: string
  d1_database_name: string
  kv_namespace_id: string
  kv_namespace_title: string
  dispatch_namespace: string
  worker_script_name: string
  public_origin: string
  admin_email: string
  admin_member_id: string
  admin_token: string
  admin_login_url: string
  lead_agent_id: string
  lead_agent_name: string
  lead_agent_token: string
  migrations_applied?: number
  seeded?: boolean
  provisioned_at: string
}

export interface SovereignPotSummary {
  slug: string
  script_name: string
  created_on?: string
  modified_on?: string
  public_url: string
  status: 'active' | 'provisioning' | 'failed'
}
