// mupot — reseller provisioning PLANNER (the onboarding spine, slice 1).
//
// WHAT THIS IS (and is NOT):
//   mupot is SINGLE-TENANT-PER-DEPLOY — this Worker's D1 IS one tenant's pot; there is
//   NO `tenants` table to insert into (see src/org/index.ts). A reseller's pot is a
//   SEPARATE deploy (own Cloudflare account + own GitHub repo + own mupot worker). So
//   "provision a reseller" can NOT be a row-insert inside this pot. It is the act of
//   standing up a NEW deploy — which is operator/ops work (Cloudflare account, repo,
//   `wrangler deploy`, secrets) and is Hadi-go.
//
//   This module is the deterministic PLANNER for that stand-up: given a reseller's inputs
//   it computes the complete, validated, reproducible RECIPE — slug, plan tier, the agency
//   department + squads that will seed, the priced service basket, the GHL connector ref,
//   the Stripe-Connect platform-fee config, and the owner-walk link. It is the spine of the
//   "clean sales process": a salesperson runs ONE call and gets the exact stand-up plan,
//   identical every time, with zero side effects.
//
// PURITY (load-bearing): this function performs NO I/O — no DB, no fetch, no env read, no
//   Date.now()/crypto/randomness. It is a pure function of its input + the static in-code
//   catalogs (the agency module manifest, the tier table, the service catalog). Same input
//   → byte-identical output. That is what makes the recipe auditable and the dry-run safe.
//
// The EXECUTE leg (actually create the CF account/repo/deploy + set secrets + live customer
//   mint) is deliberately NOT here — it is Hadi-go ops, a later slice. This planner only
//   PLANS; nothing it returns has touched the world.

import { AgencyModule } from '../departments/modules/agency'
import { SERVICE_CATALOG, type ServiceOffering } from '../services/catalog'
import { coerceTier, withinLimit, type PotTier } from '../billing/plans'

// ── tunables (operator-editable; no behavioural magic numbers buried in logic) ──────────

/** Default platform-fee % mumega takes on each reseller's client subscription (Stripe Connect
 *  `application_fee_percent`). DRAFT — the real number is an owner/commercial decision. */
export const DEFAULT_PLATFORM_FEE_PCT = 15

/** Hard ceiling on the platform fee — a sanity bound so a typo can't propose a 900% fee. */
export const MAX_PLATFORM_FEE_PCT = 50

/** Default plan tier for a reseller pot. The agency template seeds 4 squads, so the tier
 *  must have maxSquads ≥ 4 (pro/scale). Pro is the floor that fits. */
export const DEFAULT_RESELLER_TIER: PotTier = 'pro'

/** The default-channel host suffix mupot pots get before a sovereign custom domain is wired.
 *  The owner-walk link uses `<slug>.<this>` until the reseller's own domain is assigned at deploy. */
export const DEFAULT_POT_HOST_SUFFIX = 'mupot.mumega.com'

/** The department template every reseller pot activates. */
const RESELLER_DEPARTMENT_KEY = AgencyModule.key // 'agency'

const MAX_DOMAIN_LEN = 253
const MAX_SLUG_LEN = 40
/** Non-public / loopback-ish TLDs we refuse as a reseller domain (a reseller sells on a real
 *  registrable domain, never an internal/loopback name). */
const BLOCKED_TLDS = new Set(['localhost', 'local', 'internal', 'invalid', 'lan', 'home', 'corp'])

// ── input / output types ────────────────────────────────────────────────────────────────

export interface ResellerProvisionInput {
  /** The reseller's public domain, e.g. "digitalmarketingexperts.ca". Required. */
  resellerDomain: string
  /** Plan tier for the reseller pot. Default DEFAULT_RESELLER_TIER. Must fit the agency squads. */
  tier?: PotTier
  /** Service-catalog offering keys to include in the basket. Default = the whole catalog. */
  services?: string[]
  /** Opaque ref/id of the reseller's GHL location/connector (NOT a secret — the secret lives
   *  in the connector vault, set Hadi-go). Optional. */
  ghlConnectorRef?: string
  /** Stripe-Connect platform fee %. Default DEFAULT_PLATFORM_FEE_PCT. Range (0, MAX_PLATFORM_FEE_PCT]. */
  applicationFeePercent?: number
  /** Override the auto-derived pot slug. Sanitized the same way; must be non-empty after. */
  slug?: string
}

export interface PlannedSquad {
  slug: string
  name: string
}

export interface PlannedOffering {
  key: string
  name: string
  deliveredBy: string
  tiers: ServiceOffering['tiers']
}

export interface ResellerProvisionPlan {
  ok: true
  planVersion: '1'
  /** Always 'dry-run' from this module — nothing has been executed. */
  mode: 'dry-run'
  slug: string
  domain: string
  tier: PotTier
  department: { key: string; squads: PlannedSquad[] }
  catalog: PlannedOffering[]
  ghl: { provider: 'ghl'; connectorRef: string | null }
  billing: { model: 'stripe_connect'; applicationFeePercent: number }
  ownerWalk: { potHost: string; path: '/setup'; url: string }
  /** The operator/ops steps that the EXECUTE leg (Hadi-go) must perform to make this plan live.
   *  Listed explicitly so the recipe is honest about what it does NOT do. */
  execute: { opsRequired: string[] }
  warnings: string[]
  summary: string[]
}

export type ResellerProvisionResult =
  | ResellerProvisionPlan
  | {
      ok: false
      reason:
        | 'invalid_input'
        | 'invalid_domain'
        | 'slug_underivable'
        | 'invalid_slug'
        | 'tier_too_low'
        | 'unknown_service'
        | 'invalid_fee'
        | 'invalid_ghl_ref'
      detail: string
    }

// ── pure helpers ────────────────────────────────────────────────────────────────────────

/** Normalize a domain string: strip scheme, path, port, leading www., trailing dot; lowercase.
 *  Uses split (linear) — NO backtracking regex — so a hostile input can't trigger ReDoS. */
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase()
  // strip scheme (everything up to and including "://")
  const scheme = d.indexOf('://')
  if (scheme !== -1) d = d.slice(scheme + 3)
  // strip userinfo (anything before an '@')
  const at = d.indexOf('@')
  if (at !== -1) d = d.slice(at + 1)
  // strip path / query / fragment
  d = d.split('/')[0].split('?')[0].split('#')[0]
  // strip port
  d = d.split(':')[0]
  // strip a single leading www.
  if (d.startsWith('www.')) d = d.slice(4)
  // strip trailing dot (FQDN root)
  if (d.endsWith('.')) d = d.slice(0, -1)
  return d
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ // linear, bounded — no ReDoS
const TLD_RE = /^[a-z]{2,63}$/ // alphabetic TLD (rejects IPv4 octets)

/** True iff `d` is a syntactically valid PUBLIC domain (≥2 labels, alpha TLD, not a blocked TLD,
 *  not an IP literal). Per-label validation (a loop, not one mega-regex) keeps it linear. */
function isValidPublicDomain(d: string): boolean {
  if (d.length === 0 || d.length > MAX_DOMAIN_LEN) return false
  const labels = d.split('.')
  if (labels.length < 2) return false // need at least name.tld
  const tld = labels[labels.length - 1]
  if (!TLD_RE.test(tld)) return false // alphabetic TLD → rejects IPv4 + numeric tails
  if (BLOCKED_TLDS.has(tld)) return false
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return false
  }
  return true
}

/** Sanitize an arbitrary string into a pot slug: lowercase, non-alnum → '-', collapse, trim, cap. */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '') // re-trim in case the cap left a trailing '-'
}

/** Derive a slug from a (already validated) domain: drop the TLD label, join the rest, sanitize. */
function deriveSlugFromDomain(domain: string): string {
  const labels = domain.split('.')
  const withoutTld = labels.slice(0, -1) // drop the last (TLD) label
  return sanitizeSlug(withoutTld.join('-'))
}

const GHL_REF_RE = /^[a-zA-Z0-9_-]{1,128}$/

// ── the planner ─────────────────────────────────────────────────────────────────────────

/**
 * Compute the complete, deterministic reseller-pot stand-up recipe. Pure: no I/O, no clock,
 * no randomness. Returns {ok:false, reason, detail} on any invalid input (fail-closed) so the
 * caller never has to guess; returns the full plan on success. NOTHING is executed.
 */
export function planResellerTenant(input: ResellerProvisionInput): ResellerProvisionResult {
  if (input === null || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input', detail: 'input must be an object' }
  }

  // ── domain ──────────────────────────────────────────────────────────────────────────
  if (typeof input.resellerDomain !== 'string' || input.resellerDomain.trim().length === 0) {
    return { ok: false, reason: 'invalid_domain', detail: 'resellerDomain is required (string)' }
  }
  const domain = normalizeDomain(input.resellerDomain)
  if (!isValidPublicDomain(domain)) {
    return {
      ok: false,
      reason: 'invalid_domain',
      detail: `'${input.resellerDomain}' is not a valid public domain (need name.tld; no IPs/localhost/internal)`,
    }
  }

  // ── slug (explicit override OR derived) ───────────────────────────────────────────────
  let slug: string
  if (input.slug !== undefined) {
    if (typeof input.slug !== 'string') {
      return { ok: false, reason: 'invalid_slug', detail: 'slug must be a string when provided' }
    }
    slug = sanitizeSlug(input.slug)
    if (slug.length === 0) {
      return { ok: false, reason: 'invalid_slug', detail: `slug '${input.slug}' sanitizes to empty` }
    }
  } else {
    slug = deriveSlugFromDomain(domain)
    if (slug.length === 0) {
      return { ok: false, reason: 'slug_underivable', detail: `cannot derive a slug from '${domain}'` }
    }
  }

  // ── tier (must fit the agency template's squad count) ─────────────────────────────────
  const tier: PotTier = input.tier === undefined ? DEFAULT_RESELLER_TIER : coerceTier(input.tier)
  const squadCount = AgencyModule.defaultSquads.length
  if (!withinLimit(tier, 'maxSquads', squadCount)) {
    return {
      ok: false,
      reason: 'tier_too_low',
      detail: `tier '${tier}' cannot seed the agency template's ${squadCount} squads — needs a tier with maxSquads ≥ ${squadCount} (pro/scale)`,
    }
  }

  // ── service basket ────────────────────────────────────────────────────────────────────
  const catalogByKey = new Map(SERVICE_CATALOG.map((o) => [o.key, o]))
  let chosen: ServiceOffering[]
  if (input.services === undefined) {
    chosen = [...SERVICE_CATALOG]
  } else {
    if (!Array.isArray(input.services)) {
      return { ok: false, reason: 'invalid_input', detail: 'services must be an array of offering keys' }
    }
    chosen = []
    for (const key of input.services) {
      if (typeof key !== 'string' || !catalogByKey.has(key)) {
        return {
          ok: false,
          reason: 'unknown_service',
          detail: `unknown service '${String(key)}'. Valid: ${[...catalogByKey.keys()].join(', ')}`,
        }
      }
      chosen.push(catalogByKey.get(key)!)
    }
  }

  // ── platform fee ──────────────────────────────────────────────────────────────────────
  const fee = input.applicationFeePercent === undefined ? DEFAULT_PLATFORM_FEE_PCT : input.applicationFeePercent
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee <= 0 || fee > MAX_PLATFORM_FEE_PCT) {
    return {
      ok: false,
      reason: 'invalid_fee',
      detail: `applicationFeePercent must be a number in (0, ${MAX_PLATFORM_FEE_PCT}] — got ${String(fee)}`,
    }
  }

  // ── GHL connector ref (optional; an id/ref, never a secret) ──────────────────────────
  let ghlRef: string | null = null
  if (input.ghlConnectorRef !== undefined) {
    if (typeof input.ghlConnectorRef !== 'string' || !GHL_REF_RE.test(input.ghlConnectorRef)) {
      return {
        ok: false,
        reason: 'invalid_ghl_ref',
        detail: 'ghlConnectorRef must match [A-Za-z0-9_-]{1,128} (a ref/id, not a secret)',
      }
    }
    ghlRef = input.ghlConnectorRef
  }

  // ── assemble the plan (deterministic) ─────────────────────────────────────────────────
  const potHost = `${slug}.${DEFAULT_POT_HOST_SUFFIX}`
  const squads: PlannedSquad[] = AgencyModule.defaultSquads.map((s) => ({ slug: s.slug, name: s.name }))
  // DEEP-COPY into the plan — the returned plan must OWN its data. `o.tiers` is a reference
  // into the shared SERVICE_CATALOG singleton (a top-level-readonly array, NOT deep-frozen);
  // aliasing it would let a caller mutate plan.catalog[i].tiers[...] and silently corrupt the
  // global + every later call, breaking the purity/determinism contract. A fresh array of
  // shallow-cloned (flat) tier objects severs that link. squads above are already fresh literals.
  const catalog: PlannedOffering[] = chosen.map((o) => ({
    key: o.key,
    name: o.name,
    deliveredBy: o.deliveredBy,
    tiers: o.tiers.map((t) => ({ ...t })),
  }))

  const warnings: string[] = []
  if (ghlRef === null) {
    warnings.push('no GHL connector ref — wire the reseller GHL location at onboarding (secret is Hadi-go)')
  }
  warnings.push(
    `ownerWalk host '${potHost}' is the default-channel placeholder — the sovereign custom domain is assigned at deploy (ops)`,
  )

  const opsRequired = [
    'create the reseller Cloudflare account / project (Hadi-go)',
    'create the reseller GitHub repo (fork of mupot) (Hadi-go)',
    `deploy mupot to the new account with TENANT_SLUG='${slug}' (Hadi-go: wrangler deploy)`,
    `set the pot plan tier to '${tier}' via the billing plan-setter (HMAC, central billing source)`,
    `activate('${RESELLER_DEPARTMENT_KEY}') on the new pot (seeds ${squadCount} squads)`,
    'set per-tenant secrets (GHL, Stripe Connect account) — never on this plan; Hadi-go',
    `send the owner the walk link: https://${potHost}/setup`,
  ]

  const summary = [
    `Reseller pot for ${domain} → slug '${slug}', tier '${tier}'.`,
    `Department '${RESELLER_DEPARTMENT_KEY}' seeds ${squadCount} squads: ${squads.map((s) => s.slug).join(', ')}.`,
    `Basket: ${catalog.length} offering(s) — ${catalog.map((o) => o.key).join(', ')}.`,
    `Billing: Stripe Connect, ${fee}% platform fee.`,
    `Owner walk: https://${potHost}/setup`,
    'This is a DRY-RUN recipe — nothing was created. Execute leg is Hadi-go ops.',
  ]

  return {
    ok: true,
    planVersion: '1',
    mode: 'dry-run',
    slug,
    domain,
    tier,
    department: { key: RESELLER_DEPARTMENT_KEY, squads },
    catalog,
    ghl: { provider: 'ghl', connectorRef: ghlRef },
    billing: { model: 'stripe_connect', applicationFeePercent: fee },
    ownerWalk: { potHost, path: '/setup', url: `https://${potHost}/setup` },
    execute: { opsRequired },
    warnings,
    summary,
  }
}
