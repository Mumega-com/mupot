// mupot — Growth cron step: run the growth collector inside the scheduled handler.
//
// Extracted from src/index.ts so it can be unit-tested without pulling in the
// full Worker entry (Hono + OAuthProvider + cloudflare: ESM imports that vitest
// cannot resolve). The scheduled handler in src/index.ts calls runGrowthCollection
// via a simple import from here.
//
// Three invariants:
//   1. Single-tenant-per-pot: the tenant is always env.TENANT_SLUG.
//   2. Active guard: no-op (no error, no emit) when 'growth' is not active.
//   3. Fail-soft: any collector error is caught and logged — never breaks the cron.
//
// `now` is read from the real clock HERE (I/O boundary), then passed as a string into
// collectGrowthMetrics so that function remains deterministic and testable.

import type { Env } from '../../types'
import { collectGrowthMetrics } from './growth-collector'
import { getActive } from '../registry'

// ── runGrowthCollection ───────────────────────────────────────────────────────
//
// Called from the scheduled() handler in src/index.ts via ctx.waitUntil().
// Also exported for direct unit testing.

export async function runGrowthCollection(env: Env): Promise<void> {
  const tenantId = env.TENANT_SLUG
  const now = new Date().toISOString()

  // Active check: query the departments table to see if 'growth' is active.
  // getActive() returns all active, template_key-bearing departments for this D1 instance.
  // Each deployed pot has its own D1 — this is always scoped to the pot's single tenant.
  let growthActive = false
  try {
    const activeDepts = await getActive(env.DB)
    growthActive = activeDepts.some((d) => d.template_key === 'growth')
  } catch (err) {
    // If we cannot read the departments table, skip collection silently.
    console.error('[growth_cron] active-check failed — skipping collection', err)
    return
  }

  if (!growthActive) {
    // Growth department not active for this tenant — skip, no error.
    return
  }

  try {
    await collectGrowthMetrics({ db: env.DB }, tenantId, now)
  } catch (err) {
    // Fail-soft: log and move on. A collector error must never crash the cron
    // or prevent the other heartbeats from completing.
    console.error('[growth_cron] collectGrowthMetrics failed', { tenantId, now, err })
  }
}
