import { useConnectorById } from '../../../connectors/service'
import type { Env } from '../../../types'
import type { MarketingMonitorSource, SourceSnapshot } from '../types'

const DATAFORSEO_TIMEOUT_MS = 30000
const DATAFORSEO_API_HOST = 'https://api.dataforseo.com'

interface DataForSeoConnectorMeta {
  readonly maxCreditsPerRun: number
  readonly accountEmail?: string
}

function parseDataForSeoMeta(meta: string | null): DataForSeoConnectorMeta | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.maxCreditsPerRun !== 'number' || record.maxCreditsPerRun <= 0) return null
    if (record.accountEmail !== undefined && typeof record.accountEmail !== 'string') return null
    return {
      maxCreditsPerRun: record.maxCreditsPerRun,
      ...(typeof record.accountEmail === 'string' ? { accountEmail: record.accountEmail } : {}),
    }
  } catch {
    return null
  }
}

function isRedirect(response: Response): boolean {
  return (response.type as string) === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)
}

function isChallengeOrErrorPage(response: Response): boolean {
  return response.status === 403 || response.status === 429 || response.status >= 500
}

const unavailable = (): SourceSnapshot => ({
  status: 'unavailable',
  reason: 'source_unavailable',
  observations: [],
})

const failed = (): SourceSnapshot => ({
  status: 'failed',
  reason: 'source_unavailable',
  observations: [],
})

/**
 * Record a cost receipt for a DataForSEO API call.
 * Emits to provider_cost_receipts table for audit and spend tracking.
 * Fails silently — cost tracking must not block the main operation.
 */
async function recordCostReceipt(
  env: Env,
  taskId: string,
  reportedCost: number,
  callTimestamp: string,
  now: string,
): Promise<void> {
  try {
    if (!env.DB) return
    await env.DB.prepare(
      `INSERT INTO provider_cost_receipts
         (id, tenant, provider, task_id, reported_cost, currency, call_timestamp, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        `receipt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        env.TENANT_SLUG,
        'dataforseo',
        taskId,
        reportedCost,
        'credits',
        callTimestamp,
        now,
      )
      .run()
  } catch {
    // Silent fail: cost receipt is audit-trail only, not critical path
  }
}

/**
 * Check spend budget for this tenant.
 * Returns { available: true } if under budget, or { available: false, reason }
 * if at or over the per-run limit.
 */
async function checkSpendBudget(
  env: Env,
  maxCreditsPerRun: number,
): Promise<{ available: boolean; reason?: string }> {
  try {
    if (!env.DB) return { available: false, reason: 'database_unavailable' }

    const today = new Date().toISOString().split('T')[0]
    const result = await env.DB.prepare(
      `SELECT COALESCE(SUM(reported_cost), 0) as total_spent
         FROM provider_cost_receipts
        WHERE tenant = ?1
          AND provider = 'dataforseo'
          AND call_timestamp >= ?2`,
    )
      .bind(env.TENANT_SLUG, today)
      .first<{ total_spent: number }>()

    const totalSpent = result?.total_spent ?? 0
    const remaining = maxCreditsPerRun - totalSpent
    if (remaining <= 0) {
      return { available: false, reason: `spend_limit_reached: ${totalSpent}/${maxCreditsPerRun} credits used today` }
    }
    return { available: true }
  } catch {
    return { available: false, reason: 'budget_check_failed' }
  }
}

export function createDataForSeoMarketingSource(runId: string): MarketingMonitorSource {
  return {
    key: 'dataforseo',
    slot: 'search_performance',
    async read(env, binding, _window) {
      if (!binding.connectorId) return unavailable()

      const now = new Date().toISOString()
      const snapshot = await useConnectorById(env, binding.connectorId, 'dataforseo', async (connector) => {
        const meta = parseDataForSeoMeta(connector.meta)
        if (!meta) return unavailable()

        // Check spend budget BEFORE making the call
        const budgetCheck = await checkSpendBudget(env, meta.maxCreditsPerRun)
        if (!budgetCheck.available) {
          return {
            status: 'unavailable' as const,
            reason: 'source_unavailable',
            observations: [],
          }
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DATAFORSEO_TIMEOUT_MS)
        try {
          // Example: GET /v3/dataforseo_labs/google_serp_api/live (health check)
          // In production, this would be the actual metric-collection endpoint
          const endpoint = `${DATAFORSEO_API_HOST}/v3/dataforseo_labs/google_serp_api/live`
          const response = await connector.authenticatedFetch(endpoint, {
            method: 'GET',
            headers: { 'content-type': 'application/json' },
            redirect: 'manual',
            signal: controller.signal,
          })

          // Reject challenge/error pages before processing
          if (isChallengeOrErrorPage(response)) return failed()
          if (isRedirect(response) || !response.ok) return failed()

          const data = (await response.json()) as { tasks?: unknown }

          // Extract task ID and cost info from response if present
          const tasks = data.tasks
          if (Array.isArray(tasks) && tasks.length > 0) {
            const firstTask = tasks[0] as Record<string, unknown>
            const taskId = typeof firstTask.id === 'string' ? firstTask.id : `${runId}:dataforseo:${Date.now()}`
            const cost = typeof firstTask.cost === 'number' ? firstTask.cost : 0.1

            // Record cost receipt asynchronously (does not block the snapshot)
            recordCostReceipt(env, taskId, cost, now, now).catch(() => {
              // Silent fail: cost receipt failure should not break the adapter
            })
          }

          // Connectivity check passed — no fresh metric data yet (S3 phase)
          return { status: 'available' as const, observations: [] }
        } catch {
          return failed()
        } finally {
          clearTimeout(timer)
        }
      })
      return snapshot ?? unavailable()
    },
  }
}
