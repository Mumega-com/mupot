import { Hono } from 'hono'
import type { Env } from '../types'

// Legacy addon writes are retired. Content and wiki operations use connector
// bearers through their dedicated adapters; this addon exposes health only.
export const inkwellApp = new Hono<{ Bindings: Env }>()

inkwellApp.get('/health', (c) => {
  return c.json({
    ok: true,
    addon: 'inkwell',
    status: 'active',
    targetUrlConfigured: Boolean(c.env.INKWELL_API_URL || c.env.INKWELL_SVC),
  })
})
