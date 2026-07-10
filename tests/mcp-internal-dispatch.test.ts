import { describe, expect, it } from 'vitest'
import type { AuthContext } from '../src/types'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'

const auth: AuthContext = {
  userId: 'member-1',
  email: 'operator@example.test',
  role: 'member',
  tenant: 'test-pot',
  memberId: 'member-1',
  channel: 'workspace',
  capabilities: [],
  boundAgentId: null,
}

describe('mcpInternalRequest', () => {
  it('re-roots an OAuthProvider /mcp request for the unmounted mcp sub-app', async () => {
    const request = new Request('https://pot.example/mcp?trace=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer consumed-by-provider' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    const forwarded = mcpInternalRequest(request, auth)
    const url = new URL(forwarded.url)
    expect(url.pathname).toBe('/')
    expect(url.search).toBe('?trace=1')
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('authorization')).toBe('Bearer consumed-by-provider')
    expect(forwarded.headers.get(AUTH_CONTEXT_HEADER)).toBe(JSON.stringify(auth))
    expect(await forwarded.json()).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })
})
