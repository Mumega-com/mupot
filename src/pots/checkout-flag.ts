// src/pots/checkout-flag.ts — mupot#1518 hotfix kill switch for anonymous self-serve pot checkout.
//
// Dependency-free on purpose: the /pricing renderer (src/dashboard/pricing.ts via src/index.ts)
// and the checkout route (src/pots/routes.ts) must read ONE predicate, and neither should have
// to pull in the provisioning service to do it.

import type { Env } from '../types'

/** Error code every disabled checkout path returns. */
export const CHECKOUT_UNAVAILABLE = 'checkout_unavailable'

/**
 * Enabled ONLY when POT_SELF_SERVE_CHECKOUT_ENABLED is exactly the string "true".
 * "TRUE", "1", "yes", "", unset: all disabled. Today a completed create_pot session is billed
 * monthly but the webhook never provisions the pot, so the default must be off.
 */
export function isPotSelfServeCheckoutEnabled(env: Pick<Env, 'POT_SELF_SERVE_CHECKOUT_ENABLED'>): boolean {
  return env.POT_SELF_SERVE_CHECKOUT_ENABLED === 'true'
}
