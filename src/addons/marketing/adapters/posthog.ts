import { POSTHOG_TIMEOUT_MS, posthogHost } from '../../../cro/posthog'
import { useConnectorById } from '../../../connectors/service'
import type { Env } from '../../../types'
import type { MarketingMonitorSource, SourceSnapshot } from '../types'

const HOGQL_24H_ROLLUP = `
  SELECT count() AS events_24h, count(DISTINCT person_id) AS users_24h
  FROM events
  WHERE timestamp >= now() - INTERVAL 1 DAY
  LIMIT 1
`.trim()

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

export function createPosthogMarketingSource(_runId: string): MarketingMonitorSource {
  return {
    key: 'posthog',
    slot: 'web_analytics',
    async read(env, binding, _window) {
      if (!binding.connectorId) return unavailable()
      const snapshot = await useConnectorById(env, binding.connectorId, 'posthog', async (connector) => {
        const meta = parsePosthogMeta(connector.meta)
        if (!meta) return unavailable()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), POSTHOG_TIMEOUT_MS)
        try {
          const host = posthogHost({
            ...(meta.host ? { POSTHOG_HOST: meta.host } : {}),
          } as Env)
          const endpoint = `${host}/api/projects/${encodeURIComponent(meta.projectId)}/query/`
          const response = await connector.authenticatedFetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: { kind: 'HogQLQuery', query: HOGQL_24H_ROLLUP } }),
            signal: controller.signal,
          })
          if (!response.ok) return failed()
          await response.json()
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
