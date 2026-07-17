import { posthogCroSource } from '../../../cro/posthog'
import { useConnectorById } from '../../../connectors/service'
import type { Env } from '../../../types'
import type { MarketingMonitorSource, SourceSnapshot } from '../types'

interface PosthogConnectorMeta {
  readonly projectId: string
  readonly host?: string
}

function parsePosthogMeta(meta: string | null): PosthogConnectorMeta | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.projectId !== 'string' || !record.projectId.trim()) return null
    if (record.host !== undefined && (typeof record.host !== 'string' || !record.host.trim())) return null
    return {
      projectId: record.projectId.trim(),
      ...(typeof record.host === 'string' ? { host: record.host.trim() } : {}),
    }
  } catch {
    return null
  }
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

export function createPosthogMarketingSource(runId: string): MarketingMonitorSource {
  return {
    key: 'posthog',
    slot: 'web_analytics',
    async read(env, binding, window) {
      if (!binding.connectorId) return unavailable()
      const snapshot = await useConnectorById(env, binding.connectorId, 'posthog', async (connector) => {
        const meta = parsePosthogMeta(connector.meta)
        if (!meta) return unavailable()
        const posthogEnv = {
          POSTHOG_PERSONAL_API_KEY: connector.secret,
          POSTHOG_PROJECT_ID: meta.projectId,
          ...(meta.host ? { POSTHOG_HOST: meta.host } : {}),
        } as Env

        try {
          const metrics = await posthogCroSource.collect(posthogEnv)
          const users = metrics.find((metric) => metric.metric_key === 'cro.posthog.users_24h')
          return {
            status: 'available' as const,
            observations: users ? [{
              id: `${runId}:posthog:organic_sessions`,
              runId,
              metricKey: 'seo.organic_sessions' as const,
              value: users.value,
              unit: 'count',
              authority: 'posthog',
              observedAt: window.end,
            }] : [],
          }
        } catch {
          return failed()
        }
      })
      return snapshot ?? unavailable()
    },
  }
}
