import type { MarketingMonitorSource } from '../types'
import { createDataForSeoMarketingSource } from './dataforseo'
import { createFirstPartyMarketingSource } from './first-party'
import { createInkwellMarketingSource } from './inkwell'
import { createMcpwpMarketingSource } from './mcpwp'
import { createPosthogMarketingSource } from './posthog'

export { createDataForSeoMarketingSource } from './dataforseo'
export { createFirstPartyMarketingSource } from './first-party'
export { createInkwellMarketingSource } from './inkwell'
export {
  createMcpwpMarketingSource,
  MCPWP_MARKETING_PER_PAGE,
  MCPWP_MARKETING_TIMEOUT_MS,
} from './mcpwp'
export { createPosthogMarketingSource } from './posthog'

export interface RegisteredMarketingMonitorAdapter {
  readonly adapter: 'dataforseo' | 'first_party' | 'posthog' | 'inkwell' | 'mcpwp'
  readonly create: (runId: string) => MarketingMonitorSource
}

export const MARKETING_MONITOR_ADAPTERS: readonly RegisteredMarketingMonitorAdapter[] = Object.freeze([
  Object.freeze({ adapter: 'first_party', create: createFirstPartyMarketingSource }),
  Object.freeze({ adapter: 'posthog', create: createPosthogMarketingSource }),
  Object.freeze({ adapter: 'dataforseo', create: createDataForSeoMarketingSource }),
  Object.freeze({ adapter: 'inkwell', create: createInkwellMarketingSource }),
  Object.freeze({ adapter: 'mcpwp', create: createMcpwpMarketingSource }),
])
