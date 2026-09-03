// src/pots/checkout.ts — 1-Click Self-Serve Sovereign Pot Creation & Stripe Checkout Engine.

import type { Env } from '../types'
import { isPotTier, type PotTier } from '../billing/plans'
import { TIER_PRICING } from '../billing/stripe'
import { provisionSovereignPot } from './service'
import { createBus } from '../bus'

const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'billing', 'blog', 'dashboard', 'dev',
  'docs', 'help', 'mail', 'mupot', 'mumega', 'root', 'sos', 'static',
  'status', 'studio', 'support', 'test', 'www',
])

export interface SlugCheckResult {
  available: boolean
  slug: string
  reason?: string
}

export interface CreatePotCheckoutParams {
  slug: string
  brand: string
  tier: PotTier
  ownerEmail: string
  origin: string
}

/**
 * Validates whether a requested subdomain slug is available and valid.
 */
export async function checkSlugAvailability(env: Env, rawSlug: string): Promise<SlugCheckResult> {
  const slug = (rawSlug || '').toLowerCase().trim()

  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
    return {
      available: false,
      slug,
      reason: 'Slug must be 3-32 lowercase alphanumeric characters and cannot start or end with a hyphen.',
    }
  }

  if (RESERVED_SLUGS.has(slug)) {
    return { available: false, slug, reason: 'This pot subdomain is reserved.' }
  }

  // Check if pot already exists in pots table
  try {
    const existing = await env.DB.prepare('SELECT id FROM pots WHERE slug = ?1 LIMIT 1')
      .bind(slug)
      .first<{ id: string }>()

    if (existing) {
      return { available: false, slug, reason: 'This pot subdomain is already taken.' }
    }
  } catch {
    // If pots table not queryable, proceed fail-safe
  }

  return { available: true, slug }
}

/**
 * Creates a Stripe Checkout Session for instant new pot provisioning upon payment.
 */
export async function createPotCheckoutSession(
  env: Env,
  params: CreatePotCheckoutParams,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; url: string; sessionId: string } | { ok: false; error: string }> {
  const slugCheck = await checkSlugAvailability(env, params.slug)
  if (!slugCheck.available) {
    return { ok: false, error: slugCheck.reason || 'slug_unavailable' }
  }

  const tier = isPotTier(params.tier) && params.tier !== 'free' ? params.tier : 'starter'
  const pricing = TIER_PRICING[tier as keyof typeof TIER_PRICING]

  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return { ok: false, error: 'STRIPE_SECRET_KEY not configured' }
  }

  const searchParams = new URLSearchParams()
  searchParams.set('mode', 'subscription')
  searchParams.set('success_url', `${params.origin}/pots/success?slug=${encodeURIComponent(params.slug)}&session_id={CHECKOUT_SESSION_ID}`)
  searchParams.set('cancel_url', `${params.origin}/pricing?canceled=true`)
  searchParams.set('customer_email', params.ownerEmail)
  searchParams.set('client_reference_id', params.slug)

  searchParams.set('metadata[action]', 'create_pot')
  searchParams.set('metadata[slug]', params.slug)
  searchParams.set('metadata[brand]', params.brand || params.slug.toUpperCase())
  searchParams.set('metadata[tier]', tier)
  searchParams.set('metadata[owner_email]', params.ownerEmail)

  searchParams.set('line_items[0][price_data][currency]', 'usd')
  searchParams.set('line_items[0][price_data][product_data][name]', `Sovereign Agent Pot: ${params.brand || params.slug} (${tier.toUpperCase()})`)
  searchParams.set('line_items[0][price_data][unit_amount]', String(pricing.monthlyCents))
  searchParams.set('line_items[0][price_data][recurring][interval]', 'month')
  searchParams.set('line_items[0][quantity]', '1')

  try {
    const res = await fetchFn('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: searchParams.toString(),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { ok: false, error: `Stripe error: HTTP ${res.status} ${errText}` }
    }

    const session = (await res.json()) as { id: string; url: string }
    return { ok: true, url: session.url, sessionId: session.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Handles Stripe webhook completion for self-serve pot creation.
 */
export async function handlePotCreationCompleted(
  env: Env,
  session: Record<string, any>,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  const metadata = session.metadata || {}
  if (metadata.action !== 'create_pot' || !metadata.slug) {
    return { ok: false, error: 'not_a_pot_creation_session' }
  }

  const slug = metadata.slug.toLowerCase().trim()
  const brand = metadata.brand || slug.toUpperCase()
  const tier = isPotTier(metadata.tier) ? (metadata.tier as PotTier) : 'starter'
  const ownerEmail = metadata.owner_email || session.customer_email

  try {
    const result = await provisionSovereignPot(env, {
      slug,
      brand_name: brand,
      admin_email: ownerEmail,
    })

    // MONEY PATH. This runs after Stripe checkout completes. Emitting
    // `pot.self_serve_provisioned` for an empty D1 with no worker told a PAYING CUSTOMER
    // their pot was live, at a URL that could not even complete a TLS handshake. The event
    // type now follows what actually happened, so nothing downstream treats a half-run as
    // a delivered product.
    const bus = createBus(env)
    await bus.emit({
      type: result.ok ? 'pot.self_serve_provisioned' : 'pot.self_serve_provisioning_incomplete',
      actor: { kind: 'stripe', id: session.customer || 'checkout' },
      tenant: env.TENANT_SLUG,
      ts: new Date().toISOString(),
      payload: {
        slug,
        brand,
        tier,
        owner_email: ownerEmail,
        public_url: result.public_origin,
        status: result.status,
        not_completed: result.not_completed,
        orphaned_resources: result.orphaned_resources,
        incomplete_reason: result.incomplete_reason,
      },
    })

    return result.ok
      ? { ok: true, slug }
      : { ok: false, slug, error: result.incomplete_reason ?? 'provisioning incomplete' }
  } catch (error) {
    return { ok: false, slug, error: error instanceof Error ? error.message : String(error) }
  }
}
