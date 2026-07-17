import { useConnectorById } from '../../../connectors/service'
import { parseWpConnectorConfig } from '../../../departments/executors/mcpwp'
import { assertPublicHttpsUrl } from '../../../lib/ssrf'
import type { MarketingMonitorSource, SourceSnapshot } from '../types'

export const MCPWP_MARKETING_TIMEOUT_MS = 8_000
export const MCPWP_MARKETING_PER_PAGE = 50
const WORDPRESS_POST_FIELDS = 'id,slug,link,date,modified,title'

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

export function createMcpwpMarketingSource(_runId: string): MarketingMonitorSource {
  return {
    key: 'mcpwp',
    slot: 'content_surface',
    async read(env, binding, window) {
      if (!binding.connectorId) return unavailable()
      const snapshot = await useConnectorById(env, binding.connectorId, 'mcpwp', async (connector) => {
        const config = parseWpConnectorConfig(connector.secret, connector.meta)
        if (!config) return unavailable()

        let origin: string
        try {
          origin = assertPublicHttpsUrl(config.siteUrl).origin
        } catch {
          return failed()
        }

        const endpoint = new URL('/wp-json/wp/v2/posts', origin)
        endpoint.searchParams.set('status', 'publish')
        endpoint.searchParams.set('_fields', WORDPRESS_POST_FIELDS)
        endpoint.searchParams.set('per_page', String(MCPWP_MARKETING_PER_PAGE))
        endpoint.searchParams.set('after', window.start)
        endpoint.searchParams.set('before', window.end)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), MCPWP_MARKETING_TIMEOUT_MS)
        try {
          const response = await fetch(endpoint.toString(), {
            method: 'GET',
            headers: {
              authorization: `Basic ${btoa(`${config.username}:${config.appPassword}`)}`,
              'user-agent': 'mupot-marketing-monitor/1.0',
            },
            redirect: 'manual',
            signal: controller.signal,
          })
          if (isRedirect(response) || !response.ok) return failed()
          const body = await response.json().catch(() => null)
          return Array.isArray(body)
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
