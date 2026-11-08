import { describe, expect, it } from 'vitest'
import { withUnauthenticatedGuidance } from '../src/auth/unauthenticated-guidance'
const request = (path = '/actions/status') => new Request('https://pot.test' + path)
const refusal = (body: unknown = { error: 'unauthenticated' }, status = 401, headers: Record<string,string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('constant public authentication guidance', () => {
  it.each([200,400,403,404,429,500])('leaves status %s and its response untouched', async status => {
    const response = refusal({ error: 'unauthenticated' }, status)
    expect(await withUnauthenticatedGuidance(request('/mcp'), response)).toBe(response)
  })
  it.each(['/authorize','/token','/auth/login','/api-other','/actions-other','/mcp-other','/webhook'])('leaves unrelated path %s untouched', async path => {
    const response = refusal()
    expect(await withUnauthenticatedGuidance(request(path), response)).toBe(response)
  })
  it('preserves the complete challenge and other headers while rewriting a safe provider refusal', async () => {
    const challenge = 'Bearer realm="Test", resource_metadata="https://pot.test/meta?q=one", error="invalid_token"'
    const response = refusal({ error: 'invalid_token' },401,
      { 'www-authenticate': challenge, 'retry-after': '5', 'x-preserved': 'yes', 'content-length': '99', etag: '"old"', 'content-encoding': 'gzip' })
    const result = await withUnauthenticatedGuidance(request('/mcp'), response)
    expect(result.status).toBe(401)
    expect(result.headers.get('www-authenticate')).toBe(challenge)
    expect(result.headers.get('retry-after')).toBe('5')
    expect(result.headers.get('x-preserved')).toBe('yes')
    for (const header of ['etag','content-length','content-encoding']) expect(result.headers.has(header)).toBe(false)
    const body = await result.json() as { error: string }
    expect(body.error).toBe('invalid_token')
    expect(body).toMatchObject({ who_acts: 'owner' })
  })
  it('leaves an MCP refusal with an RPC envelope untouched', async () => {
    const response = refusal({ jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'unauthenticated' } })
    expect(await withUnauthenticatedGuidance(request('/mcp'), response)).toBe(response)
  })
  it('leaves an MCP authentication refusal with another entity format untouched', async () => {
    const response = new Response('old authentication text',{status:401,headers:{'content-type':'text/plain'}})
    const result = await withUnauthenticatedGuidance(request('/mcp'),response)
    expect(result).toBe(response)
    expect(await result.text()).toBe('old authentication text')
  })
  it('canonicalizes only a safe-key provider MCP 401', async () => {
    const a = await withUnauthenticatedGuidance(request('/mcp'), refusal({ error: 'invalid_token' }))
    expect(await a.json()).toMatchObject({ error: 'invalid_token', who_acts: 'owner' })
  })
  it('leaves extra-key refusals byte-for-byte unchanged instead of reflecting them', async () => {
    for (const [requestValue, body] of [
      [request(), { error:'unauthenticated', agent:'existing-agent', tenant:'secret-tenant', exists:true }],
      [new Request('https://other.test/actions/status?agent=missing'), { error:'invalid_token', exists:false }],
    ] as const) {
      const original = refusal(body)
      const text = await original.clone().text()
      expect(await withUnauthenticatedGuidance(requestValue, original)).toBe(original)
      expect(await original.text()).toBe(text)
    }
  })
  it('does not reflect request data or the safe original error code into rewritten guidance', async () => {
    const a = await withUnauthenticatedGuidance(request('/actions/status'), refusal({ error:'unauthenticated' }))
    const b = await withUnauthenticatedGuidance(new Request('https://other.test/actions/status?agent=missing'), refusal({ error:'invalid_token' }))
    const text = await a.text()
    expect(text).toBe(await b.text())
    for (const value of ['other.test','missing']) expect(text).not.toContain(value)
    expect(JSON.parse(text)).toMatchObject({ error:'unauthenticated', what_happened:'This request could not be authenticated.', who_acts:'owner', help_url:'https://mumega.com/docs/how-to-connect/' })
  })
  it.each([
    ['clock skew', { error: 'unauthorized', detail: 'signature timestamp out of window' }],
    ['bad signature', { error: 'unauthorized', detail: 'signature verification failed' }],
  ])('leaves the signed inbox %s refusal byte-for-byte unchanged', async (_name, body) => {
    const original = refusal(body)
    const expected = await original.clone().text()
    const actual = await withUnauthenticatedGuidance(request('/api/inbox/signed'), original)
    expect(actual).toBe(original)
    expect(await actual.text()).toBe(expected)
  })
  it('leaves a bare signed inbox unauthorized refusal untouched', async () => {
    const original = refusal({ error: 'unauthorized' })
    expect(await withUnauthenticatedGuidance(request('/api/inbox/signed'), original)).toBe(original)
  })
  it('never rewrites an in-scope refusal with extra keys', async () => {
    const original = refusal({ error: 'unauthenticated', detail: 'keep this diagnostic' })
    expect(await withUnauthenticatedGuidance(request('/api/tasks'), original)).toBe(original)
  })
  it('uses API-specific next steps without offering OAuth consent', async () => {
    const result = await withUnauthenticatedGuidance(request('/api/tasks'), refusal({ error: 'unauthenticated' }))
    const body = await result.json() as { next_step: string }
    expect(body.next_step).toContain('sign in at this pot')
    expect(body.next_step).toContain('admin-issued agent key')
    expect(body.next_step).not.toContain('OAuth consent flow')
  })
  it('keeps cookie-only and signed-agent API next steps accurate', async () => {
    const cookieOnly = await withUnauthenticatedGuidance(request('/api/agents'), refusal({ error: 'unauthenticated' }))
    const cookieBody = await cookieOnly.json() as { next_step: string }
    expect(cookieBody.next_step).toContain('sign in at this pot')
    expect(cookieBody.next_step).not.toContain('agent key')

    const inbox = await withUnauthenticatedGuidance(request('/api/inbox'), refusal({ error: 'unauthorized' }))
    const inboxBody = await inbox.json() as { next_step: string }
    expect(inboxBody.next_step).toContain('admin-issued agent key')
    expect(inboxBody.next_step).not.toContain('sign in at this pot')
  })
  it('retains the inbox unauthorized code and leaves other shared-secret refusals alone', async () => {
    const inbox = await withUnauthenticatedGuidance(request('/api/inbox'),refusal({error:'unauthorized'}))
    const body = await inbox.json() as { accepted?: unknown }
    expect(body).toMatchObject({error:'unauthorized',who_acts:'owner'})
    expect(body.accepted).toBeNull()
    for (const path of ['/api/hooks','/api/inbox-other']) {
      const webhook = refusal({error:'unauthorized'})
      expect(await withUnauthenticatedGuidance(request(path),webhook)).toBe(webhook)
    }
  })
  it('retains static API accepted-credential hints, independent of old body values', async () => {
    const a = await withUnauthenticatedGuidance(request('/api/tasks'), refusal({ error:'unauthenticated', accepted:['attacker'] }))
    expect(await a.json()).toMatchObject({ accepted:['bearer','cookie'] })
    const b = await withUnauthenticatedGuidance(new Request('https://pot.test/api/tasks',{method:'POST'}), refusal())
    expect(await b.json()).toMatchObject({ accepted:['cookie'] })
  })
  it.each(['{"error":"bad_signature"}','invalid','null','[]','"text"'])('leaves a distinct or malformed REST refusal untouched: %s', async text => {
    const response = new Response(text,{status:401,headers:{'content-type':'application/json'}})
    expect(await withUnauthenticatedGuidance(request(), response).catch(error => error)).toBe(response)
    expect(await response.text()).toBe(text)
  })
  it('preserves a JSON-labelled REST refusal with no body stream', async () => {
    const response = new Response(null,{status:401,headers:{'content-type':'application/json'}})
    expect(await withUnauthenticatedGuidance(request(),response).catch(error => error)).toBe(response)
  })
  it('does not consume non-JSON REST challenges', async () => {
    const response = new Response('{"error":"unauthenticated"}',{status:401})
    expect(await withUnauthenticatedGuidance(request(), response).catch(error => error)).toBe(response)
  })
  it('bounds REST inspection at 4096 bytes without waiting for an unread tee', async () => {
    const text = JSON.stringify({error:'unauthenticated'})
    const within = new Response(text.padEnd(4096),{status:401,headers:{'content-type':'application/json'}})
    expect(await withUnauthenticatedGuidance(request(),within)).not.toBe(within)
    const oversized = new Response(text.padEnd(4097),{status:401,headers:{'content-type':'application/json'}})
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([withUnauthenticatedGuidance(request(),oversized), new Promise(resolve => { timer=setTimeout(() => resolve('blocked cancellation'),500) })])
    clearTimeout(timer)
    expect((await oversized.text()).length).toBe(4097) // drain the other tee even under the blocking-cancel mutant
    expect(result).toBe(oversized)
  })
  it('handles broken REST response streams without changing the refusal', async () => {
    const response = new Response(new ReadableStream({start(c){c.error(new Error('fixture stream error'))}}),{status:401,headers:{'content-type':'application/json'}})
    expect(await withUnauthenticatedGuidance(request(),response).catch(error => error)).toBe(response)
  })
  it('covers home-alias tenant prefixes without reflecting the prefix', async () => {
    const a = await withUnauthenticatedGuidance(request('/t/mumega/mcp'),refusal())
    const b = await withUnauthenticatedGuidance(request('/mcp'),refusal())
    expect(await a.text()).toBe(await b.text())
  })
})
