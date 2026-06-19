// mupot — the service catalog: the priced "basket of services" a reseller sells.
//
// Each offering is a runnable skill/scenario delivered by an agency squad (SEO/AEO/Ads/
// Content) or a dev skill, at quality tiers, with a recurring (and/or setup) price. This is
// DECLARATIVE CONFIG — the reseller's storefront + the mupot console read it; the squads
// fulfill it. Prices live HERE so the operator edits a number, not code.
//
// ⚠️ PRICES ARE DRAFTS (2026-06-19) — benchmarked to findabl (~$299/mo AEO) and TechForge
// (~$10k+ dev). Hadi sets the real numbers; edit the `monthlyCents` / `setupCents` below.
// All prices are INTEGER CENTS (29900 = $299.00) so there is never a float-rounding bug.

export interface ServiceTier {
  /** Stable tier key within the offering ('starter' | 'pro' | 'premium' | …). */
  key: string
  name: string
  /** Recurring monthly price in cents (0 = no recurring component). */
  monthlyCents: number
  /** One-time setup/project price in cents (omitted = none). */
  setupCents?: number
  /** Short qualifier shown next to the price (e.g. "+ % of ad spend"). */
  note?: string
}

export interface ServiceOffering {
  /** Stable offering key ('aeo' | 'seo' | 'ads' | 'content' | 'fast-mvp'). */
  key: string
  name: string
  summary: string
  /** The agency squad slug (or skill) that fulfills it. */
  deliveredBy: string
  tiers: ServiceTier[]
}

// ── THE BASKET (draft prices — edit the numbers) ──────────────────────────────
export const SERVICE_CATALOG: readonly ServiceOffering[] = [
  {
    key: 'aeo',
    name: 'AEO — Answer-Engine Optimization',
    summary:
      'Get cited by AI answer engines (ChatGPT, Perplexity, Google AI). Audit → optimize the signals AI trusts → monthly visibility snapshot.',
    deliveredBy: 'aeo',
    tiers: [
      { key: 'starter', name: 'Starter', monthlyCents: 29900, note: 'core profile + monthly snapshot' },
      { key: 'pro', name: 'Pro', monthlyCents: 59900, note: 'multi-engine + competitor tracking' },
      { key: 'premium', name: 'Premium', monthlyCents: 99900, note: 'full coverage + content pipeline' },
    ],
  },
  {
    key: 'seo',
    name: 'SEO',
    summary: 'Technical, on-page, and content SEO to grow qualified organic search visibility.',
    deliveredBy: 'seo',
    tiers: [
      { key: 'starter', name: 'Starter', monthlyCents: 49900 },
      { key: 'pro', name: 'Pro', monthlyCents: 99900 },
      { key: 'premium', name: 'Premium', monthlyCents: 199900 },
    ],
  },
  {
    key: 'ads',
    name: 'Paid Ads Management',
    summary: 'Plan, run, and optimize Google/Meta campaigns to CPA/ROAS targets.',
    deliveredBy: 'ads',
    tiers: [
      { key: 'starter', name: 'Starter', monthlyCents: 49900, note: '+ % of ad spend' },
      { key: 'pro', name: 'Pro', monthlyCents: 99900, note: '+ % of ad spend' },
    ],
  },
  {
    key: 'content',
    name: 'Content',
    summary: 'Briefs, drafts, and optimization feeding the SEO and AEO squads.',
    deliveredBy: 'content',
    tiers: [
      { key: 'starter', name: 'Starter', monthlyCents: 39900 },
      { key: 'pro', name: 'Pro', monthlyCents: 79900 },
      { key: 'premium', name: 'Premium', monthlyCents: 149900 },
    ],
  },
  {
    key: 'fast-mvp',
    name: 'Fast MVP / Dev Environment',
    summary: 'Concept → production MVP in 4–8 weeks, then an ongoing managed dev environment.',
    deliveredBy: 'dev',
    tiers: [
      { key: 'mvp', name: 'MVP', monthlyCents: 0, setupCents: 750000, note: '4–8 week MVP' },
      { key: 'build', name: 'Build', monthlyCents: 0, setupCents: 2500000, note: 'full build' },
      { key: 'enterprise', name: 'Enterprise', monthlyCents: 200000, setupCents: 7500000, note: '+ retainer' },
    ],
  },
]

// ── helpers (pure) ────────────────────────────────────────────────────────────

/** "$299" from 29900 cents. Whole dollars when even, else 2dp. */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return '$0'
  const dollars = cents / 100
  const s = Number.isInteger(dollars) ? dollars.toLocaleString('en-US') : dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `$${s}`
}

/** Human price line for a tier, e.g. "$299/mo", "$7,500 setup", "$7,500 setup + $2,000/mo". */
export function formatTierPrice(tier: ServiceTier): string {
  const parts: string[] = []
  if (typeof tier.setupCents === 'number' && tier.setupCents > 0) parts.push(`${formatCents(tier.setupCents)} setup`)
  if (tier.monthlyCents > 0) parts.push(`${formatCents(tier.monthlyCents)}/mo`)
  if (parts.length === 0) return 'Custom'
  return parts.join(' + ')
}

/** Total number of offerings in the basket. */
export function catalogSize(): number {
  return SERVICE_CATALOG.length
}
