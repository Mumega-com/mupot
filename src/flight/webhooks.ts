// flight/webhooks — external webhook handlers for flight creation (Linear, PostHog, etc.).
//
// SECURITY MODEL: External webhooks can create flights in 'proposed' gate_state only.
// Proposed flights are NOT dispatchable until explicit mupot-side approval gate moves them
// to 'approved'. This enforces the LINE: Linear MAY WRITE, NEVER DISPATCH.
//
// Signature Verification: Each provider signs its webhook with an HMAC. Unsigned or
// replayed payloads are rejected with 401. Verification is mandatory; no exceptions.
//
// Untrusted Content: Webhook payloads are treated as attacker-influenceable (anyone
// who can edit a Linear issue can inject text). Payloads must never be interpolated
// into agent prompts or privilege-bearing decisions. See brief: "observer-tier
// prompt-injection found on mupot#484" — same concern applies here.

import type { Env } from '../types'
import { createFlight } from './service'
import type { NewFlight } from './service'

export interface LinearWebhookPayload {
  id: string
  type: 'issue.created' | 'issue.updated' | 'comment.created' | string
  createdAt?: string
  data: {
    id: string
    identifier: string
    title: string
    description?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

// Verify Linear HMAC-SHA256 signature on the webhook payload.
// Linear includes a 'Linear-Signature' header: base64(hmac-sha256(body, secret)).
// Returns true if signature is valid, false otherwise.
export async function verifyLinearSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature) return false
  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const computed = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const computedB64 = btoa(String.fromCharCode(...new Uint8Array(computed)))
    // Constant-time comparison to prevent timing attacks.
    if (computedB64.length !== signature.length) return false
    let match = 0
    for (let i = 0; i < computedB64.length; i++) {
      match |= computedB64.charCodeAt(i) ^ signature.charCodeAt(i)
    }
    return match === 0
  } catch {
    return false
  }
}

// Create a proposed flight from a Linear webhook payload.
// The flight lands in gate_state='proposed' (not dispatchable until approval).
export async function createProposedFlightFromLinear(
  env: Env,
  payload: LinearWebhookPayload,
): Promise<string> {
  const issue = payload.data
  const agent = 'linear-webhook' // Metadata: source agent
  const goal = `Linear issue ${issue.identifier}: ${issue.title}`.slice(0, 2000)
  // External origin marker: webhooks always create proposed flights.
  const flight: NewFlight = {
    agent,
    goal,
    trigger_source: 'event',
    gate_state: 'proposed',
  }
  return createFlight(env, flight)
}
