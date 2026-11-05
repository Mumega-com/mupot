// Root app error handler (mupot#2343). Everything keeps Hono's default behaviour (HTTPException response, else a plain 500)
// except the agent-bearer liveness failure, which is a retryable 503 with a stable code.
import type { Context } from 'hono'
import { BoundAgentCheckUnavailableError, BOUND_AGENT_CHECK_UNAVAILABLE } from './auth/bound-agent-live'
import { safeConsole } from './lib/log'

export function appErrorHandler(err: Error, c: Context): Response {
  if (err instanceof BoundAgentCheckUnavailableError) {
    return c.json({ error: BOUND_AGENT_CHECK_UNAVAILABLE }, 503, { 'Retry-After': '2', 'Cache-Control': 'no-store' })
  }
  // Hono's own duck-check (hono-base.js): any error carrying getResponse (HTTPException from this or another copy of
  // hono) is answered the way Hono answers it, through c.newResponse so headers set on the context (c.header(), e.g.
  // the csrf/secure-headers/no-store middleware) survive on the error response instead of being dropped (mupot#2345).
  if ('getResponse' in err && typeof err.getResponse === 'function') {
    const res: unknown = err.getResponse()
    if (res instanceof Response) return c.newResponse(res.body, res)
  }
  // Stack goes to the log (redacted by safeConsole); the response body never carries err.message.
  safeConsole.error('[app] unhandled error', err.stack ?? err.message)
  return c.text('Internal Server Error', 500)
}
