// mupot — billing / entitlement layer (pot-wide plan tiers).
//
// Generalizes the github-capabilities.ts tier pattern to the WHOLE pot: a pot is
// on a PLAN TIER, and the tier gates (a) feature access and (b) numeric limits.
// This is the entitlement FOUNDATION — the subscription source (Stripe webhook,
// marketplace fulfillment, or an admin override) writes `org_settings.plan_tier`;
// this module reads it and answers "what is this pot allowed to do."
//
// Two axes, same as github-capabilities:
//   - PLAN TIER — the pot's plan (free → scale), ascending rank.
//   - FEATURE / LIMIT — each capability has a minimum tier; each limit has a
//     per-tier ceiling.
//
// Fail-closed: unknown/missing tier → 'free' (most restrictive). A swapped brain
// or bad overlay can never raise its own tier — tier is owner/subscription state.
//
// NOTE: the per-tier LIMITS and PRICES below are SCAFFOLDING DEFAULTS. Real pricing
// + limits are an owner/product decision (set via subscription config); the
// MECHANISM (rank, gate, fail-closed) is what this module guarantees.

// ── tiers ────────────────────────────────────────────────────────────────────
export type PotTier = 'free' | 'starter' | 'pro' | 'scale'

const TIER_RANK: Record<PotTier, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  scale: 3,
}

export function isPotTier(v: unknown): v is PotTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIER_RANK, v)
}

/** Fail-closed coerce: anything not a known tier → 'free'. */
export function coerceTier(v: unknown): PotTier {
  return isPotTier(v) ? v : 'free'
}

// ── features (what a tier unlocks) ─────────────────────────────────────────────
export type PotFeature =
  | 'byo_model' // swap the model port adapter (AI Gateway / BYOK) beyond the Workers-AI default
  | 'byo_brain' // swap the brain port adapter (sovereign C(t) / custom)
  | 'extra_channels' // comms beyond the default channel (WhatsApp / multi-channel)
  | 'github_paid' // the paid-tier GitHub features (gated again by github-capabilities)
  | 'priority_metabolism' // faster brain cron cadence
  | 'audit_export' // audit-log export
  | 'sso' // SSO enforcement

interface FeatureSpec {
  minTier: PotTier
  label: string
}

/** The tag registry: each feature → minimum tier. Single place to read tier gates. */
export const POT_FEATURES: Record<PotFeature, FeatureSpec> = {
  byo_model: { minTier: 'starter', label: 'Bring your own model / AI Gateway' },
  extra_channels: { minTier: 'starter', label: 'Extra comms channels (WhatsApp/multi)' },
  byo_brain: { minTier: 'pro', label: 'Swap the brain (sovereign / custom)' },
  github_paid: { minTier: 'pro', label: 'Paid GitHub features' },
  priority_metabolism: { minTier: 'pro', label: 'Priority brain cadence' },
  audit_export: { minTier: 'scale', label: 'Audit-log export' },
  sso: { minTier: 'scale', label: 'SSO enforcement' },
}

// ── limits (numeric ceilings per tier) ─────────────────────────────────────────
// SCAFFOLDING DEFAULTS — tune via product/pricing decision. -1 = unlimited.
export interface PotLimits {
  maxAgents: number
  maxSquads: number
  monthlyModelBudgetMicroUsd: number
}

export const PLAN_LIMITS: Record<PotTier, PotLimits> = {
  free: { maxAgents: 2, maxSquads: 1, monthlyModelBudgetMicroUsd: 2_000_000 }, // ~$2/mo Workers-AI
  starter: { maxAgents: 8, maxSquads: 3, monthlyModelBudgetMicroUsd: 50_000_000 }, // ~$50/mo
  pro: { maxAgents: 30, maxSquads: 10, monthlyModelBudgetMicroUsd: 300_000_000 }, // ~$300/mo
  scale: { maxAgents: -1, maxSquads: -1, monthlyModelBudgetMicroUsd: -1 }, // unlimited / metered
}

// ── pure gates (no I/O — fully testable) ───────────────────────────────────────

/** A feature is allowed iff the pot's tier meets the feature's minimum tier. */
export function entitled(tier: PotTier, feature: PotFeature): boolean {
  const spec = POT_FEATURES[feature]
  if (!spec) return false
  return TIER_RANK[tier] >= TIER_RANK[spec.minTier]
}

/** True if `value` is within the tier's ceiling for `limit` (-1 ceiling = unlimited). */
export function withinLimit(tier: PotTier, limit: keyof PotLimits, value: number): boolean {
  const ceiling = PLAN_LIMITS[tier][limit]
  if (ceiling < 0) return true // unlimited
  return value <= ceiling
}

/** The full entitlement snapshot for a tier — what the pot is allowed. */
export interface Entitlement {
  tier: PotTier
  limits: PotLimits
  features: ReadonlyArray<PotFeature>
}

export function entitlementFor(tier: PotTier): Entitlement {
  const features = (Object.keys(POT_FEATURES) as PotFeature[]).filter((f) => entitled(tier, f))
  return { tier, limits: PLAN_LIMITS[tier], features }
}
