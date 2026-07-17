import { useConnectorById } from '../../../connectors/service'
import { fetchInkwellContent } from '../../../departments/executors/inkwell'
import type { MarketingMonitorSource, SourceSnapshot } from '../types'

const INKWELL_TIMEOUT_MS = 8_000

function parseSlug(meta: string | null): string | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const slug = (value as Record<string, unknown>).slug
    return typeof slug === 'string' && slug.trim() ? slug.trim() : null
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

export function createInkwellMarketingSource(_runId: string): MarketingMonitorSource {
  return {
    key: 'inkwell',
    slot: 'content_surface',
    async read(env, binding) {
      if (!binding.connectorId || !env.INKWELL_API_URL) return unavailable()
      const snapshot = await useConnectorById(env, binding.connectorId, 'inkwell', async (connector) => {
        const slug = parseSlug(connector.meta)
        if (!slug) return unavailable()
        return connector.call(async (secret) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), INKWELL_TIMEOUT_MS)
          const baseFetch = env.INKWELL_SVC
            ? env.INKWELL_SVC.fetch.bind(env.INKWELL_SVC) as typeof fetch
            : fetch
          const boundedFetch = ((input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, {
            ...init,
            signal: controller.signal,
          })) as typeof fetch

          try {
            const content = await fetchInkwellContent({
              apiUrl: env.INKWELL_API_URL as string,
              token: secret,
              tenantSlug: env.TENANT_SLUG,
            }, slug, boundedFetch)
            return content ? { status: 'available' as const, observations: [] } : unavailable()
          } catch {
            return failed()
          } finally {
            clearTimeout(timer)
          }
        })
      })
      return snapshot ?? unavailable()
    },
  }
}
