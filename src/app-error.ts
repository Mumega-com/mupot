// Root app error handler (mupot#2343). Everything keeps Hono's default behaviour (HTTPException response, else a plain 500)
// except the agent-bearer liveness failure, which is a retryable 503 with a stable code.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { BoundAgentCheckUnavailableError, BOUND_AGENT_CHECK_UNAVAILABLE } from './auth/bound-agent-live'
import { safeConsole } from './lib/log'

export function appErrorHandler(err: Error, c: Context): Response {
  if (err instanceof BoundAgentCheckUnavailableError) {
    return c.json({ error: BOUND_AGENT_CHECK_UNAVAILABLE }, 503, { 'Retry-After': '2', 'Cache-Control': 'no-store' })
  }
  if (err instanceof HTTPException) return err.getResponse()
  safeConsole.error('[app] unhandled error', err.message)
  return c.text('Internal Server Error', 500)
}
