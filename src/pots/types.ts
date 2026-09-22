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
  // NO `cf_api_token`, `account_id`, or `worker_js_code` field here, deliberately (mupot#1507
  // round-2 P0-3). Cloudflare credentials come ONLY from env (SECRET_ENV_CF_API_TOKEN /
  // SECRET_ENV_CF_ACCOUNT_ID); the worker bundle comes ONLY from the R2 artifact or the
  // separate positional `workerJsCode` argument to `provisionSovereignPot` — a function
  // parameter, not a property of this object, so it cannot be smuggled in by spreading an
  // HTTP request body or MCP tool-call args into this type. Removed rather than gated: a
  // type that cannot EXPRESS the unsafe field cannot be called unsafely by accident. See
  // src/pots/validate.ts for the shared allow-list both the HTTP route and the MCP tool
  // enforce on the wire, and `assertNoForbiddenProvisionInputKeys` in service.ts for the
  // runtime defense-in-depth check (Athena round-2 condition iii) against a caller that
  // bypasses the type via `as any`.
  /** The interactive caller's own member id (org-admin dashboard/MCP callers only).
   *  When present, freshly-minted credentials are wrapped as a one-time
   *  `CredentialClaimHandle` (src/auth/credential-claim.ts) redeemable ONLY by this
   *  member — never returned raw. When absent (e.g. checkout.ts's Stripe-webhook
   *  path, which has no interactive member session to hand a claim to), credential
   *  claim fields stay null; see docs/workflows/tenant-provision.md for the gap this
   *  leaves in self-serve checkout, tracked separately from #1285. */
  minted_by_member_id?: string
  /** The interactive caller's own tenant (`auth.tenant`) — recorded on every
   *  `pot_provision_receipts` row this call writes (`actor_tenant`, migration 0164) and
   *  used to derive/verify `provisioner_tenant` on the `pots` registry row (migration
   *  0167). Independent of `minted_by_member_id`: even a caller with no interactive member
   *  identity still has a tenant. */
  caller_tenant?: string
  /** Set ONLY by `src/pots/checkout.ts`'s Stripe self-serve path — the completed Checkout
   *  Session's own id (`session.id`), never caller-suppliable via the HTTP route or MCP
   *  tool (both validate against `src/pots/validate.ts`'s `PROVISION_ALLOWED_FIELDS`, which
   *  does not include it — same structural protection `minted_by_member_id`/
   *  `caller_tenant` already get). This is the per-checkout-session claim mupot#1507-v2
   *  P0-C introduces: self-serve callers have no interactive member (`minted_by_member_id`
   *  is always null there), so before this field existed, "ownership" of a self-serve
   *  `pots` row degraded to matching `actorTenant` alone — the SAME value for every
   *  self-serve buyer on this deployment — meaning a SECOND checkout session for the same
   *  slug (a retry, a different customer, an attacker) could adopt whatever the first
   *  session claimed, purely because `null === null` and `tenant === tenant`. Scoping the
   *  claim to the exact session id makes a Stripe webhook replay idempotent (same session
   *  => same claim => adopt) while refusing a genuinely different session on the same slug
   *  outright, before any Cloudflare call. See `provisionSovereignPot`'s registry gate. */
  checkout_session_id?: string
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
  /** Not one of the six provisioning steps above (never appears in `ALL_PROVISION_STEPS`,
   *  never part of a `provisionSovereignPot` run's own `completed`/`not_completed`) — a
   *  distinct, administrative action recorded on the SAME append-only ledger:
   *  `releaseStalePot` (mupot#1507-v2 P1-A) freeing a stale `provisioning` row so a
   *  different provisioner can claim the slug. Sharing the ledger keeps one queryable
   *  history per slug instead of a second table for one action. */
  | 'release'

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
