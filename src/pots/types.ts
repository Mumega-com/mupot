// src/pots/types.ts — Types for Sovereign Multi-Tenant Pot Provisioning via WFP.

import type { CredentialClaimHandle } from '../auth/credential-claim'

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
  /** The interactive caller's own member id (org-admin dashboard/MCP callers only).
   *  When present, freshly-minted credentials are wrapped as a one-time
   *  `CredentialClaimHandle` (src/auth/credential-claim.ts) redeemable ONLY by this
   *  member — never returned raw. When absent (e.g. checkout.ts's Stripe-webhook
   *  path, which has no interactive member session to hand a claim to), credential
   *  claim fields stay null; see docs/workflows/tenant-provision.md for the gap this
   *  leaves in self-serve checkout, tracked separately from #1285. */
  minted_by_member_id?: string
  /** Explicit worker bundle for the tenant script (option C in
   *  docs/workflows/tenant-provision.md) — used when no R2-published bundle is
   *  configured for this build's RELEASE_SHA. See loadPotWorkerBundle in service.ts. */
  worker_js_code?: string
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
 *  job to clean up unless the caller is TOLD about them. `adopted` distinguishes a
 *  resource this call CREATED from one it found already existing under the expected
 *  name and reused (mupot#1285 comment 2026-09-22 — the Psychonom D1/KV) — an operator
 *  reading `orphaned_resources` needs to know whether a fresh call would create a
 *  DUPLICATE or safely retry against the same resource. */
export interface OrphanedResources {
  d1_database_id: string | null
  d1_database_name: string | null
  d1_adopted: boolean
  kv_namespace_id: string | null
  kv_namespace_title: string | null
  kv_adopted: boolean
}

/** One step's outcome, exactly as written to `pot_provision_receipts` (migration 0164). */
export interface ProvisionStepReceipt {
  step: ProvisionStep
  ok: boolean
  detail: string | null
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
  /** Groups this call's `pot_provision_receipts` rows (migration 0164). */
  run_id: string
  /** Every step's receipt, in the order it was attempted — mirrors what was written to
   *  `pot_provision_receipts`, so a caller doesn't have to query the ledger separately
   *  to know exactly what happened on THIS call. */
  receipts: ProvisionStepReceipt[]
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
  /** ALWAYS null. A credential minted in memory and never written to the pot's own
   *  database authenticates nothing, and even once it IS written, the raw value must
   *  never ride in a tool/HTTP response body a transcript can retain (mupot#987) — see
   *  `admin_credential_claim` for the one-time-redeemable replacement. Field kept (not
   *  removed) for response-shape compatibility with existing callers that check it is
   *  null before treating a pot as usable. */
  admin_token: null
  /** The tenant's own origin once provisioned, with no token embedded — never a
   *  "login" URL carrying a raw secret in its query string. */
  admin_login_url: string | null
  /** One-time redeemable handle for the admin token (src/auth/credential-claim.ts).
   *  Null when seeding did not run, OR when the caller supplied no
   *  `minted_by_member_id` (nobody to redeem it in-session — see that field's doc
   *  comment on `SovereignPotProvisionInput`). */
  admin_credential_claim: CredentialClaimHandle | null
  lead_agent_id: string
  lead_agent_name: string
  /** ALWAYS null — see `admin_token`. */
  lead_agent_token: null
  lead_agent_credential_claim: CredentialClaimHandle | null
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
