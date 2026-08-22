// mupot — client tenant stand-up & onboarding recipe (commercialization slice 1).
//
// WHAT THIS IS:
//   Pure deterministic planner for standing up client project containers in Mupot
//   with associated squads, mcpwp connector configurations, Stripe Connect billing
//   attribution, and initial service dispatch packages.

import { coerceTier, type PotTier } from '../billing/plans'
import { SERVICE_CATALOG, type ServiceOffering } from '../services/catalog'

export interface ClientTenantInput {
  /** The client's business name or domain (e.g. "Viamar Logistics", "DentalNearYou", "TechParts"). Required. */
  clientName: string
  /** The client's main WordPress website URL (e.g. "https://dentalnearyou.com"). Required for mcpwp. */
  wordpressUrl: string
  /** Selected service keys from SERVICE_CATALOG (e.g. ['seo', 'content', 'aeo', 'mcpwp-store']). */
  services?: string[]
  /** Custom tenant slug override. */
  slug?: string
  /** Tier assignment (default 'pro'). */
  tier?: PotTier
  /** Stripe Connect application fee % (default 15). */
  applicationFeePercent?: number
  /** Primary contact / billing email. */
  contactEmail?: string
}

export interface PlannedClientSquad {
  slug: string
  name: string
  role: string
  purpose: string
}

export interface ClientTenantPlan {
  ok: true
  planVersion: '1'
  mode: 'dry-run'
  tenantSlug: string
  clientName: string
  wordpressUrl: string
  tier: PotTier
  billing: {
    model: 'stripe_connect'
    applicationFeePercent: number
    contactEmail: string | null
  }
  project: {
    name: string
    slug: string
    goal: string
    parentProjectId: null
  }
  squads: PlannedClientSquad[]
  connectorBindings: Array<{
    connector: 'mcpwp' | 'stripe' | 'google_workspace'
    target: string
    status: 'vault_unbound' | 'pending_auth'
  }>
  services: ServiceOffering[]
  execute: {
    stepsRequired: string[]
  }
}

export type ClientTenantResult =
  | ClientTenantPlan
  | { ok: false; reason: 'invalid_client_name' | 'invalid_wordpress_url' | 'invalid_slug' | 'unsupported_service'; detail?: string }

const SLUG_CLEAN_RE = /[^a-z0-9-]/g
const MULTI_DASH_RE = /--+/g

export function deriveClientSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(MULTI_DASH_RE, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

function isValidHttpUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function planClientTenant(input: ClientTenantInput): ClientTenantResult {
  const name = typeof input.clientName === 'string' ? input.clientName.trim() : ''
  if (!name || name.length < 2) {
    return { ok: false, reason: 'invalid_client_name', detail: 'clientName must be at least 2 characters' }
  }

  const wpUrl = typeof input.wordpressUrl === 'string' ? input.wordpressUrl.trim() : ''
  if (!wpUrl || !isValidHttpUrl(wpUrl)) {
    return { ok: false, reason: 'invalid_wordpress_url', detail: 'wordpressUrl must be a valid http(s) URL' }
  }

  const slug = input.slug ? input.slug.trim().toLowerCase().replace(SLUG_CLEAN_RE, '-').replace(MULTI_DASH_RE, '-').replace(/^-|-$/g, '') : deriveClientSlug(name)
  if (!slug || slug.length < 2) {
    return { ok: false, reason: 'invalid_slug', detail: 'slug must be valid and at least 2 characters' }
  }

  const requestedServiceKeys = input.services ?? ['seo', 'content']
  const matchedServices: ServiceOffering[] = []
  for (const key of requestedServiceKeys) {
    const found = SERVICE_CATALOG.find((s) => s.key === key)
    if (!found) {
      return { ok: false, reason: 'unsupported_service', detail: `Service '${key}' not in catalog` }
    }
    matchedServices.push(found)
  }

  const tier = coerceTier(input.tier ?? 'pro')
  const feePct = typeof input.applicationFeePercent === 'number' && input.applicationFeePercent > 0 && input.applicationFeePercent <= 50
    ? input.applicationFeePercent
    : 15

  const squads: PlannedClientSquad[] = [
    {
      slug: `${slug}-core`,
      name: `${name} Core Squad`,
      role: 'Operations & Gating Lead',
      purpose: 'Coordinates client deliverables, audits diffs, and manages task review gates.',
    },
    {
      slug: `${slug}-mcpwp`,
      name: `${name} WordPress Automation`,
      role: 'WordPress Technical Execution',
      purpose: 'Executes direct page updates, SEO meta injection, and WooCommerce catalog modifications via mcpwp.',
    },
  ]

  return {
    ok: true,
    planVersion: '1',
    mode: 'dry-run',
    tenantSlug: slug,
    clientName: name,
    wordpressUrl: wpUrl,
    tier,
    billing: {
      model: 'stripe_connect',
      applicationFeePercent: feePct,
      contactEmail: input.contactEmail?.trim() ?? null,
    },
    project: {
      name: `${name} Managed Growth`,
      slug: `project-${slug}`,
      goal: `Continuous SEO, CRO, and WooCommerce optimization for ${name} (${wpUrl}) via mcpwp.`,
      parentProjectId: null,
    },
    squads,
    connectorBindings: [
      {
        connector: 'mcpwp',
        target: wpUrl,
        status: 'vault_unbound',
      },
      {
        connector: 'stripe',
        target: input.contactEmail ? `customer:${input.contactEmail}` : 'pending_subscription',
        status: 'vault_unbound',
      },
    ],
    services: matchedServices,
    execute: {
      stepsRequired: [
        `1. Insert project 'project-${slug}' into D1 projects table with active status.`,
        `2. Create client squads '${squads.map((s) => s.slug).join(', ')}' and grant project_squad_access.`,
        `3. Bind mcpwp application password in connector vault for ${wpUrl}.`,
        `4. Set billing plan tier '${tier}' and Stripe Connect fee ${feePct}%.`,
      ],
    },
  }
}
