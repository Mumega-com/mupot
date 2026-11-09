// Option B task 0: /device through the REAL worker entry (the deployed composition). Node-pool
// tests cannot import src/index.ts; this proves the actual mount answers the constant 410, also
// under the tenant path prefix, and that the HTTP 401 contract on neighbours is untouched.
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const paths = ['/device', '/device/', '/device/code', '/device/token', '/device/preview', '/device/decision', '/device/ABCD-2345', '/device/x/y']
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

function trap(calls: string[]) {
  return new Proxy({}, { get: (_t, prop) => { calls.push(String(prop)); throw new Error(`unexpected binding touch ${String(prop)}`) } })
}

describe('/device through the worker entry', () => {
  it.each(paths)('%s returns the constant 410 for every method without touching storage', async (path) => {
    const calls: string[] = []
    const env = { TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: trap(calls), DB: trap(calls) } as unknown as Env
    for (const method of methods) {
      for (const headers of [{}, { 'content-type': 'application/json' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
        const hasBody = method !== 'GET' && method !== 'HEAD'
        const res = await worker.fetch(new Request(`https://pot.test${path}`, {
          method, headers, body: hasBody ? '{"device_code":"dc","user_code":"ABCD-2345","action":"allow"}' : undefined,
        }), env, ctx)
        expect(res.status, `${method} ${path}`).toBe(410)
        if (method !== 'HEAD') {
          const body = await res.json() as Record<string, unknown>
          expect(body.error).toBe('device_flow_retired')
          expect(typeof body.what_happened).toBe('string')
          expect(typeof body.who_acts).toBe('string')
          expect(typeof body.next_step).toBe('string')
          expect(JSON.stringify(body)).not.toMatch(/access_token|RAW|ABCD-2345/)
        }
      }
    }
    expect(calls).toEqual([])
  })

  it('stays 410 when the flag-like env is off and no bindings exist', async () => {
    const res = await worker.fetch(new Request('https://pot.test/device/code', { method: 'POST', body: 'agent=a' }), { TENANT_SLUG: 'mumega' } as unknown as Env, ctx)
    expect(res.status).toBe(410)
  })

  it('an unauthenticated MCP request still answers 401 with its challenge (middleware untouched)', async () => {
    const res = await worker.fetch(new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test' } as unknown as Env, ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata/)
  })
})
