// mupot — entitlement resolver. Reads the pot's plan tier from org_settings and
// answers what it's allowed. The subscription source (Stripe webhook / marketplace
// fulfillment / admin override) is the ONLY writer of `org_settings.plan_tier`;
// this module never writes it. Fail-closed to 'free'.

import type { Env } from '../types'
import { getSetting } from '../dashboard/settings'
import {
  coerceTier,
  entitled,
  entitlementFor,
  type Entitlement,
  type PotFeature,
  type PotTier,
} from './plans'

/** org_settings key holding the pot's plan tier. Written ONLY by the billing source
 *  (Stripe webhook / marketplace fulfillment / admin override) — never self-service.
 *  Owned by the billing module (intentionally not in dashboard SETTINGS_KEYS, which
 *  is substrate/wizard config; billing is its own concern). */
export const PLAN_TIER_KEY = 'plan_tier'

/** Resolve the pot's plan tier from org_settings (fail-closed to 'free'). */
export async function resolveTier(env: Env): Promise<PotTier> {
  return coerceTier(await getSetting(env, PLAN_TIER_KEY))
}

/** Resolve the pot's full entitlement snapshot (tier + limits + features). */
export async function resolveEntitlement(env: Env): Promise<Entitlement> {
  return entitlementFor(await resolveTier(env))
}

/** Convenience gate: is `feature` available for this pot right now? */
export async function potEntitled(env: Env, feature: PotFeature): Promise<boolean> {
  return entitled(await resolveTier(env), feature)
}
