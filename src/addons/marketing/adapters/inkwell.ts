import { useConnectorById } from '../../../connectors/service'
import { assertPublicHttpsUrl } from '../../../lib/ssrf'
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

function isRedirect(response: Response): boolean {
  return response.type as string === 'opaqueredirect'
    || (response.status >= 300 && response.status < 400)
}

export function createInkwellMarketingSource(_runId: string): MarketingMonitorSource {
  return {
    key: 'inkwell',
    slot: 'content_surface',
    async read(env, binding) {
      if (!binding.connectorId || !env.INKWELL_API_URL) return unavailable()
      const snapshot = await useConnectorById(env, binding.connectorId, 'inkwell', async (connector) => {
        const slug = parseSlug(connector.meta)
        if (!slug) return unavailable()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), INKWELL_TIMEOUT_MS)
        try {
          const origin = assertPublicHttpsUrl(env.INKWELL_API_URL as string).origin
          const endpoint = new URL(`/api/internal/content/${encodeURIComponent(slug)}`, origin)
          endpoint.searchParams.set('tenant_slug', env.TENANT_SLUG)
          const response = await connector.authenticatedFetch(endpoint, {
            method: 'GET',
            headers: { 'user-agent': 'mupot-executor/1.0' },
            redirect: 'manual',
            signal: controller.signal,
          })
          if (isRedirect(response) || (!response.ok && response.status !== 404)) return failed()
          if (response.status === 404) return unavailable()
          const body = await response.json().catch(() => null) as Record<string, unknown> | null
          return body?.ok === true && typeof body.content === 'string'
            ? { status: 'available' as const, observations: [] }
            : failed()
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
