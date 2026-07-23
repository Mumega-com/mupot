// Live-verified Cursor / Anthropic API version pins for topology C.
//
// Verified 2026-07-23 against live endpoints (invalid key → 401, not 404):
//   POST https://api.cursor.com/v1/agents  → 401
//   POST https://api.cursor.com/v0/agents  → 401  (legacy still up)
//   GET  https://api.cursor.com/v1/me      → 401
//   POST https://api.anthropic.com/v1/agents|environments|sessions → 401
//
// Official Cursor docs (cloud-agent/api/endpoints): Cloud Agents API **v1** is
// the public beta launch surface. Webhooks are "coming soon" on v1; the
// documented HMAC statusChange payload remains the webhook contract, and the
// legacy v0 launch body still accepts `webhook: { url, secret }`.
//
// Adapter policy: launch on **v1**. Prefer webhook completion when a secret is
// configured (listener is HMAC-ready). Always keep poll/SSE available — required
// for Claude Managed Agents (no webhook) and as Cursor v1 fallback.

export const CURSOR_API_BASE = 'https://api.cursor.com'
export const CURSOR_AGENTS_API_VERSION = 'v1' as const
export const CURSOR_AGENTS_PATH = `/v1/agents`
export const CURSOR_LEGACY_AGENTS_PATH = `/v0/agents`

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION_HEADER = '2023-06-01'
export const ANTHROPIC_MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01'

export const CONTRACT_ID = 'runtime-adapter/v1' as const
export const SIGNED_ATTACH_DOMAIN = 'fleet-attach:v1' as const
export const LAND_AT_STATUS = 'review' as const

export interface ApiVersionProbeResult {
  cursorV1Agents: number
  cursorV0Agents: number
  preferredLaunchVersion: 'v1'
  webhookOnV1: 'coming_soon_per_docs'
  webhookListenerReady: true
}

/**
 * Probe Cursor agent routes without credentials.
 * A live route returns 401 for a bad key; a missing route returns 404.
 */
export async function probeCursorApiVersions(
  fetchImpl: typeof fetch,
): Promise<ApiVersionProbeResult> {
  const v1 = await fetchImpl(`${CURSOR_API_BASE}${CURSOR_AGENTS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer invalid',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const v0 = await fetchImpl(`${CURSOR_API_BASE}${CURSOR_LEGACY_AGENTS_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer invalid',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  if (v1.status === 404) {
    throw new Error('cursor_api_v1_agents_missing: POST /v1/agents returned 404')
  }
  return {
    cursorV1Agents: v1.status,
    cursorV0Agents: v0.status,
    preferredLaunchVersion: 'v1',
    webhookOnV1: 'coming_soon_per_docs',
    webhookListenerReady: true,
  }
}
