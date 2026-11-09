// mupot — /device is retired (Option B task 0, mupot#2374).
//
// The RFC 8628-style device grant let any org admin approve an agent key without a passkey,
// kept the raw key in KV, could double-issue, wrote no issuance audit row and revealed whether
// an agent existed. It is removed, not feature-flagged: every method and path under /device
// now answers one constant 410. This module touches no binding (no env, no KV, no D1), reads
// no request body and never echoes request data, so nothing about the request can mint,
// redeem, look up or transition anything. Mounted before the dashboard '/' catch-all.

import { Hono } from 'hono'
import type { Env } from '../types'

/** Public, constant guidance, never derived from the request, a credential or a tenant lookup. */
export const DEVICE_RETIRED_BODY = {
  error: 'device_flow_retired',
  what_happened: 'The /device agent-approval flow has been retired. No access was granted and nothing was issued.',
  who_acts: 'owner',
  next_step: 'For your human: ask a workspace admin to connect the agent through the supported, gated OAuth consent flow or an admin-provided agent-bound credential. Do not paste credentials into chat; retry only after the connection is configured.',
  help_url: 'https://mumega.com/docs/how-to-connect/',
} as const

const RETIRED_JSON = JSON.stringify(DEVICE_RETIRED_BODY)

function retiredResponse(): Response {
  return new Response(RETIRED_JSON, {
    status: 410,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export const deviceRetiredApp = new Hono<{ Bindings: Env }>()

// Both patterns so '/device' and '/device/' and every nested path are covered; all methods.
deviceRetiredApp.all('/', () => retiredResponse())
deviceRetiredApp.all('/*', () => retiredResponse())
