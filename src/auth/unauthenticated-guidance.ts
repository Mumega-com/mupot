import { unauthenticatedApiBody } from './bearer-read'

/** Public, constant guidance: never derived from a credential, identity or tenant lookup. */
const MCP_GUIDANCE = {
  what_happened: 'This request could not be authenticated.',
  who_acts: 'owner',
  next_step: 'For your human: open the help URL, confirm the intended pot and existing agent with your workspace admin, then connect through the supported OAuth consent flow or an admin-provided agent-bound credential. Do not paste credentials into chat; retry only after the connection is configured.',
  help_url: 'https://mumega.com/docs/how-to-connect/',
} as const

const API_SIGN_IN_GUIDANCE = {
  what_happened: 'This request could not be authenticated.',
  who_acts: 'owner',
  next_step: 'For your human: sign in at this pot, then retry this API route. Do not paste credentials into chat.',
  help_url: 'https://mumega.com/docs/how-to-connect/',
} as const

const API_KEY_OR_SIGN_IN_GUIDANCE = {
  what_happened: 'This request could not be authenticated.',
  who_acts: 'owner',
  next_step: 'For your human: sign in at this pot, or use the admin-issued agent key accepted for this API route. Do not paste credentials into chat; retry only after the connection is configured.',
  help_url: 'https://mumega.com/docs/how-to-connect/',
} as const

const INBOX_AGENT_KEY_GUIDANCE = {
  what_happened: 'This request could not be authenticated.',
  who_acts: 'owner',
  next_step: 'For your human: use the admin-issued agent key bound to this inbox, then retry. Do not paste credentials into chat.',
  help_url: 'https://mumega.com/docs/how-to-connect/',
} as const

const REWRITABLE_REFUSAL_KEYS = new Set(['error', 'error_description', 'accepted'])

function isRewritableRefusal(body: Record<string, unknown>): boolean {
  return Object.keys(body).every((key) => REWRITABLE_REFUSAL_KEYS.has(key))
}

/** Inspect only small JSON refusals; a clone's cancellation must not wait for its unread sibling. */
async function refusalJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return null
  const reader = response.clone().body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) return null
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
  finally { void reader.cancel().catch(() => undefined) }
}

/** Presentation only, after routing/authentication. Existing statuses and challenges are never synthesized. */
export async function withUnauthenticatedGuidance(request: Request, response: Response): Promise<Response> {
  if (response.status !== 401) return response
  const path = new URL(request.url).pathname.replace(/^\/t\/[^/]+(?=\/)/, '')
  const mcp = path === '/mcp' || path.startsWith('/mcp/')
  const api = path.startsWith('/api/')
  const inbox = path === '/api/inbox' || path.startsWith('/api/inbox/')
  if (path === '/api/inbox/signed') return response
  if (!mcp && !api && !path.startsWith('/actions/') && path !== '/openapi.full.json') return response
  // Canonicalize only a small provider-style refusal. Rich RPC, signed-daemon and
  // route-specific diagnostics retain their existing response contract.
  const original = await refusalJson(response)
  if (!original || !isRewritableRefusal(original)) return response
  if (original.error !== 'unauthenticated' && original.error !== 'invalid_token'
    && !(inbox && original.error === 'unauthorized')) return response
  const accepted = api && !inbox ? unauthenticatedApiBody(request.method, path).accepted : null
  const guidance = !api
    ? MCP_GUIDANCE
    : inbox
      ? INBOX_AGENT_KEY_GUIDANCE
      : accepted?.includes('bearer')
        ? API_KEY_OR_SIGN_IN_GUIDANCE
        : API_SIGN_IN_GUIDANCE
  const body = {
    error: mcp ? 'invalid_token' : inbox ? 'unauthorized' : 'unauthenticated',
    error_description: 'Missing or invalid access token',
    ...guidance,
    accepted,
  }
  const headers = new Headers(response.headers)
  // These describe the old entity, whereas the OAuth challenge describes the unchanged refusal.
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('etag')
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers })
}
