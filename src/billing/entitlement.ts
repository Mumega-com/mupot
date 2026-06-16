// mupot — entitlement resolver + the atomic plan-event writer.
//
// The pot's billing state (tier + the last applied billing event) is ONE record
// in org_settings: `billing_state` = { tier, event_id, effective_at }. Keeping
// tier and the idempotency/ordering watermark together lets the write be a single
// conditional upsert (CAS) — no read/check/write race, no partial persistence.
//
// resolveTier reads it (fail-closed to 'free'). applyPlanEvent is the ONLY writer,
// called by the HMAC-authed plan-setter route after the central billing source
// signs the event. Never owner-session, never self-service.

import type { Env } from '../types'
import { getJSON } from '../dashboard/settings'
import {
  coerceTier,
  entitled,
  entitlementFor,
  type Entitlement,
  type PotFeature,
  type PotTier,
} from './plans'

/** org_settings key holding the pot's billing state (tier + last-applied event). */
export const BILLING_STATE_KEY = 'billing_state'

/** Resolve the pot's plan tier from billing_state (fail-closed to 'free'). */
export async function resolveTier(env: Env): Promise<PotTier> {
  const state = await getJSON<{ tier?: unknown }>(env, BILLING_STATE_KEY)
  return coerceTier(state?.tier)
}

/** Resolve the pot's full entitlement snapshot (tier + limits + features). */
export async function resolveEntitlement(env: Env): Promise<Entitlement> {
  return entitlementFor(await resolveTier(env))
}

/** Convenience gate: is `feature` available for this pot right now? */
export async function potEntitled(env: Env, feature: PotFeature): Promise<boolean> {
  return entitled(await resolveTier(env), feature)
}

/**
 * Atomically apply a billing event → set the pot's tier, conditioned on freshness,
 * in a SINGLE conditional upsert (CAS). The freshness test and the write happen in
 * one SQL statement, so concurrent / stale / duplicate / partially-persisted events
 * cannot race or roll back:
 *   - no existing row            → INSERT (apply).
 *   - newer effective_at + new event_id → UPDATE (apply).
 *   - duplicate event_id OR older/equal effective_at → no-op (row unchanged).
 *
 * Returns whether it applied. Idempotent: a duplicate or stale event is a safe no-op.
 */
export async function applyPlanEvent(
  env: Env,
  ev: { tier: PotTier; eventId: string; effectiveAt: number },
): Promise<{ applied: boolean }> {
  const value = JSON.stringify({ tier: ev.tier, event_id: ev.eventId, effective_at: ev.effectiveAt })
  const res = await env.DB.prepare(
    `INSERT INTO org_settings (key, value, updated_at)
       VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE json_extract(excluded.value, '$.event_id') != json_extract(org_settings.value, '$.event_id')
         AND CAST(json_extract(excluded.value, '$.effective_at') AS INTEGER)
             > CAST(json_extract(org_settings.value, '$.effective_at') AS INTEGER)`,
  )
    .bind(BILLING_STATE_KEY, value)
    .run()
  return { applied: (res.meta?.changes ?? 0) > 0 }
}
