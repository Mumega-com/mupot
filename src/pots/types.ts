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
  /** Cloudflare API token override (falls back to env.SECRET_ENV_CF_API_TOKEN) */
  cf_api_token?: string
  /** Cloudflare Account ID override (falls back to env.SECRET_ENV_CF_ACCOUNT_ID) */
  account_id?: string
}

/** The steps a pot needs before it exists. Named so a partial run can say which ones
 *  actually happened instead of implying all of them. */
export type ProvisionStep =
  | 'create_d1'
  | 'create_kv'
  | 'apply_schema'
  | 'deploy_worker'
  | 'seed_identities'
  | 'verify_reachable'

/** Resources that were created before provisioning stopped. Real, billable, and nobody's
 *  job to clean up unless the caller is TOLD about them. */
export interface OrphanedResources {
  d1_database_id: string | null
  d1_database_name: string | null
  kv_namespace_id: string | null
  kv_namespace_title: string | null
}

export interface SovereignPotProvisionResult {
  /** TRUE only when every step completed and the pot was verified reachable.
   *  It previously meant "the function returned", which is not the same thing. */
  ok: boolean
  status: 'provisioned' | 'incomplete'
  completed: ProvisionStep[]
  /** What did NOT happen. Empty only when status is 'provisioned'. */
  not_completed: ProvisionStep[]
  /** Populated whenever status is 'incomplete' — these exist and cost money. */
  orphaned_resources: OrphanedResources | null
  /** Why it stopped, in words an operator can act on. */
  incomplete_reason: string | null
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
  /** NULL until seeding exists. A credential that was generated in memory and never
   *  written to the pot's database authenticates nothing; returning it as if it worked is
   *  how an operator ends up debugging a login that was never possible. */
  admin_token: string | null
  admin_login_url: string | null
  lead_agent_id: string
  lead_agent_name: string
  lead_agent_token: string | null
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
