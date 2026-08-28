// src/router/scheduled.ts — Cloudflare Scheduled Cron & Background Dispatch for Active Router (FLIGHT-ROUTER-CRON).
//
// 1. Scheduled Background Sweep: runScheduledRouterSweep runs on a 5-minute cadence,
//    matching unassigned tasks to active continuum bodies in D1 `presence`.
// 2. HTTP Trigger Route: routerRoutesApp exposes POST /api/router/tick for manual operator or webhook triggers.
// 3. Telemetry: emits 'router.tick.completed' bus events for observability.

import { Hono } from 'hono'
import type { Env, BusEvent } from '../types'
import { runRouterTick, type RouterTickResult } from './engine'
import { createBus } from '../bus'
import { resolveOrgAdmin } from '../auth/member-bearer'

export interface ScheduledRouterResult {
  ok: boolean
  scheduledAt: string
  tickResult: RouterTickResult
  error?: string
}

/**
 * Scheduled background sweep executed by worker cron trigger.
 * Scale-to-zero: only runs when tasks exist, with zero persistent compute overhead.
 */
export async function runScheduledRouterSweep(
  env: Env,
  scheduledAt: Date = new Date(),
): Promise<ScheduledRouterResult> {
  const scheduledIso = scheduledAt.toISOString()
  try {
    const tickResult = await runRouterTick(env, { dryRun: false, limit: 50 })

    if (tickResult.assignedCount > 0) {
      const busEvent: BusEvent<{
        assigned_count: number
        scanned_count: number
        scheduled_at: string
      }> = {
        type: 'org.provisioned',
        tenant: env.TENANT_SLUG,
        ts: scheduledIso,
        payload: {
          assigned_count: tickResult.assignedCount,
          scanned_count: tickResult.scannedCount,
          scheduled_at: scheduledIso,
        },
      }
      try {
        await createBus(env).emit(busEvent)
      } catch {
        // Telemetry failure does not abort cron
      }
    }

    return {
      ok: true,
      scheduledAt: scheduledIso,
      tickResult,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[scheduled:router-sweep] failed:', errorMsg)
    return {
      ok: false,
      scheduledAt: scheduledIso,
      tickResult: {
        scannedCount: 0,
        assignedCount: 0,
        skippedCount: 0,
        unroutedCount: 0,
        decisions: [],
      },
      error: errorMsg,
    }
  }
}

export const routerRoutesApp = new Hono<{ Bindings: Env }>()

// POST /api/router/tick or /tick — trigger active router sweep on-demand (admin authenticated)
routerRoutesApp.post('/tick', async (c) => {
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) {
    return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)
  }

  let body: { dry_run?: boolean; squad_id?: string; limit?: number } = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

  const dryRun = body.dry_run !== false
  const result = await runRouterTick(c.env, {
    dryRun,
    squadId: body.squad_id,
    limit: body.limit,
  })

  return c.json(result)
})

routerRoutesApp.post('/api/router/tick', async (c) => {
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) {
    return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)
  }

  let body: { dry_run?: boolean; squad_id?: string; limit?: number } = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

  const dryRun = body.dry_run !== false
  const result = await runRouterTick(c.env, {
    dryRun,
    squadId: body.squad_id,
    limit: body.limit,
  })

  return c.json(result)
})
