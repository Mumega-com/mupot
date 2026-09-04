// tests/composition/tenant-header-cannot-select-a-worker.test.ts — mupot#1299.
//
// Entering through src/index.ts's exported fetch, because that is where the defect was:
// the WFP dispatch branch is the FIRST thing the Worker does, ahead of the OAuth provider
// and every auth middleware. A test that imports the dispatcher and hand-builds an env
// cannot see this — the sub-app is reached only after the branch has already decided.
//
// Measured on production at 8ff9b8e2, unauthenticated, no session:
//   GET https://mupot.mumega.com/health  with  x-mupot-tenant-slug: <a script name>
//   -> 200, answered by that script, not by the colony.
//
// The control (same request, no header) returned the colony's own /health. So the header
// alone moved an anonymous request from the colony to a named tenant's isolate.

import { describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  }
}

/** An env WITH a DISPATCHER bound — the dispatch branch is skipped entirely without one. */
function envWithDispatcher() {
  const dispatched: string[] = []
  const env = {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
    DISPATCHER: {
      get: (name: string) => {
        dispatched.push(name)
        return {
          fetch: async () =>
            new Response(JSON.stringify({ served_by: 'tenant-worker', tenant: name }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        }
      },
    },
  }
  return { env: env as never, dispatched }
}

describe('a client-supplied tenant header cannot choose the serving Worker (#1299)', () => {
  it.each([
    ['x-mupot-tenant-slug'],
    ['x-pot-tenant'],
  ])('apex request carrying %s is served by the colony, not the named tenant', async (header) => {
    const { env, dispatched } = envWithDispatcher()

    const res = await worker.fetch(
      new Request('https://mupot.mumega.com/health', { headers: { [header]: 'gaf' } }),
      env,
      ctx,
    )

    // The dispatcher must never have been consulted at all.
    expect(dispatched, `apex request was routed to ${dispatched.join(',')}`).toEqual([])
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.served_by).toBeUndefined()
    expect(body.service).toBe('mupot')
  })

  it('the control still works: a real tenant HOSTNAME does dispatch', async () => {
    // The paired positive control. Without it, a fix that broke dispatch outright would
    // pass every assertion above — "nothing was dispatched" is exactly what a dead branch
    // looks like, and the test would be green for the wrong reason.
    const { env, dispatched } = envWithDispatcher()

    const res = await worker.fetch(
      new Request('https://gaf.mupot.mumega.com/health'),
      env,
      ctx,
    )

    expect(dispatched).toEqual(['gaf'])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ served_by: 'tenant-worker', tenant: 'gaf' })
  })

  it('the header cannot redirect a tenant hostname to a DIFFERENT tenant either', async () => {
    const { env, dispatched } = envWithDispatcher()

    await worker.fetch(
      new Request('https://gaf.mupot.mumega.com/health', {
        headers: { 'x-mupot-tenant-slug': 'victim' },
      }),
      env,
      ctx,
    )

    expect(dispatched).toEqual(['gaf'])
  })
})

// ── mupot#1307 (gate F4) ───────────────────────────────────────────────────────────────
//
// The /preview gate proven through the DEPLOYED composition, not the sub-app. Every other
// test for it calls platformApp.fetch, which cannot see whether the middleware survives the
// mount at `app.route('/', platformApp)` in src/index.ts, or the OAuthProvider wrapper
// around it. That is the same blind spot this file was created for.
//
// There is NO DB binding on this env, deliberately. If the refusal is ordered correctly the
// database is never reached, so a missing binding is harmless — and if the gate is removed,
// the handler dereferences `env.DB` and cannot produce a clean 401. That proves refusal
// precedes any database work without hand-writing a D1 stand-in, which
// scripts/check-test-schema-source.mjs correctly rejects: an invented query builder is a
// SQL engine that string-matches instead of executing, so it can never contradict a query
// naming a column that does not exist. It caught my first attempt at this test — and then
// caught the COMMENT explaining the fix, because that guard scans raw text and its pattern
// matches the method name in prose as readily as in code. Named in prose deliberately.
describe('/preview refuses anonymous callers through the real worker (#1307)', () => {
  function envWithoutDb() {
    const dispatched: string[] = []
    const env = {
      TENANT_SLUG: 'mumega',
      BRAND: 'mupot',
      IDP_PROVIDER: 'google',
      OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      OAUTH_CLIENT_SECRET: 'test-secret',
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
      SESSIONS: kv(),
      OAUTH_KV: kv(),
      DISPATCHER: {
        get: (name: string) => {
          dispatched.push(name)
          return { fetch: async () => new Response('tenant') }
        },
      },
    }
    return { env: env as never, dispatched }
  }

  it.each([
    ['/preview/proj-1'],
    ['/preview/proj-1/'],
    ['/preview/proj-1/deep/path?q=1'],
  ])('%s is refused 401 without touching the database or the namespace', async (path) => {
    const { env, dispatched } = envWithoutDb()
    const res = await worker.fetch(new Request(`https://mupot.mumega.com${path}`), env, ctx)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(dispatched).toEqual([])
  })
})
