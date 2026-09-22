// tests/helpers/fake-cf-provisioner.ts — shared Cloudflare-provisioning test doubles used
// by both tests/pot-provisioner.test.ts and tests/pot-checkout-provisioning.test.ts.
//
// Pulled out of tests/pot-provisioner.test.ts (mupot#1507-v2) rather than imported directly
// from that test file: importing a `.test.ts` module re-executes its top-level `describe()`
// calls in the IMPORTING file's suite too (vitest runs a module's top-level code on import,
// `describe` included) — which silently duplicated every test in this file the first time
// this was tried. A plain helper module has no `describe`/`it` calls, so it is safe to
// import from multiple spec files.
import { vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './sqlite-d1'
import { execD1RestQuery } from './d1-rest-double'

/** Minimal in-memory KV double for the SESSIONS binding createCredentialClaim writes to. */
export function fakeSessionsKv() {
  const store = new Map<string, string>()
  return {
    store,
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

/** A DISPATCHER double that answers `/health` with a configurable body (default: a
 *  realistic `publicHealth`-shaped payload matching `tenant`/`releaseSha`, so the
 *  identity-check happy path is exercised for real rather than trivially). */
export function fakeDispatcher(opts: { status?: number; body?: string; tenant?: string; releaseSha?: string; throwNotFound?: boolean } = {}) {
  return {
    get: vi.fn((_name: string) => ({
      fetch: vi.fn(async () => {
        if (opts.throwNotFound) throw new Error('No user worker found for the given name.')
        const body = opts.body ?? JSON.stringify({
          ok: true, service: 'mupot', tenant: opts.tenant, commit: opts.releaseSha ?? null, clean: true,
        })
        return new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } })
      }),
    })),
  }
}

/**
 * Fake Cloudflare REST backend backed by REAL SQLite child-pot databases. One
 * `SqliteD1Harness` per created/adopted D1 uuid, so the schema chain and seed batch run
 * against a real engine with the real migration 0071 trigger set — this is what actually
 * proves the P0-1 seed ordering fix (not a mock that answers success to everything). Every
 * `/d1/database/{id}/query` call routes through `execD1RestQuery`
 * (tests/helpers/d1-rest-double.ts), which is what actually models D1's transaction-control
 * refusal and per-call atomicity (mupot#1507-v2 P0-A).
 */
export function createRealisticFakeCf(opts: {
  existingD1?: { uuid: string; name: string }
  existingKv?: { id: string; title: string }
  existingChildHarness?: SqliteD1Harness // pairs with existingD1, for adopt-orphan tests
  failDeploy?: boolean
  queryOverride?: (sql: string, params: unknown[], databaseId: string, queryCallIndex: number) => { success: boolean; result?: unknown; errors?: Array<{ message: string }> } | undefined
} = {}) {
  const calls: Array<{ url: string; method: string }> = []
  const d1ByName = new Map<string, { uuid: string; name: string }>()
  const kvByTitle = new Map<string, { id: string; title: string }>()
  const childHarnesses = new Map<string, SqliteD1Harness>()
  let d1CreateCalls = 0
  let kvCreateCalls = 0
  let queryCallIndex = 0

  if (opts.existingD1) {
    d1ByName.set(opts.existingD1.name, opts.existingD1)
    childHarnesses.set(opts.existingD1.uuid, opts.existingChildHarness ?? createSqliteD1())
  }
  if (opts.existingKv) kvByTitle.set(opts.existingKv.title, opts.existingKv)

  function harnessFor(uuid: string): SqliteD1Harness {
    let h = childHarnesses.get(uuid)
    if (!h) {
      h = createSqliteD1()
      childHarnesses.set(uuid, h)
    }
    return h
  }

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    calls.push({ url, method })

    if (method === 'GET' && url.includes('/d1/database?')) {
      const name = new URL(url).searchParams.get('name') || ''
      const found = d1ByName.get(name)
      return { status: 200, json: async () => ({ success: true, result: found ? [found] : [] }) }
    }
    if (method === 'POST' && /\/d1\/database$/.test(url)) {
      d1CreateCalls += 1
      const body = JSON.parse(init.body as string)
      const entry = { uuid: `d1-${body.name}`, name: body.name }
      d1ByName.set(body.name, entry)
      harnessFor(entry.uuid) // pre-create so the schema chain has somewhere to land
      return { status: 200, json: async () => ({ success: true, result: entry }) }
    }
    if (method === 'GET' && url.includes('/storage/kv/namespaces?')) {
      const page = Number(new URL(url).searchParams.get('page') || '1')
      return { status: 200, json: async () => ({ success: true, result: page === 1 ? Array.from(kvByTitle.values()) : [] }) }
    }
    if (method === 'POST' && url.includes('/storage/kv/namespaces')) {
      kvCreateCalls += 1
      const body = JSON.parse(init.body as string)
      const entry = { id: `kv-${body.title}`, title: body.title }
      kvByTitle.set(body.title, entry)
      return { status: 200, json: async () => ({ success: true, result: entry }) }
    }
    if (method === 'PUT' && url.includes('/workers/dispatch/namespaces')) {
      if (opts.failDeploy) {
        return { status: 400, json: async () => ({ success: false, errors: [{ message: 'mocked deploy failure' }] }) }
      }
      return { status: 200, json: async () => ({ success: true, result: { id: 'deployed' } }) }
    }
    const queryMatch = url.match(/\/d1\/database\/([^/]+)\/query$/)
    if (method === 'POST' && queryMatch) {
      const databaseId = queryMatch[1]
      const body = init.body ? JSON.parse(init.body as string) : { sql: '', params: [] }
      const idx = queryCallIndex
      queryCallIndex += 1
      const override = opts.queryOverride?.(body.sql, body.params ?? [], databaseId, idx)
      if (override) {
        return { status: 200, json: async () => override }
      }
      const result = await execD1RestQuery(harnessFor(databaseId), body.sql, body.params ?? [])
      return { status: 200, json: async () => result }
    }
    return { status: 404, json: async () => ({ success: false, errors: [{ message: 'unhandled mock route: ' + url }] }) }
  })

  return {
    fetchMock, calls, childHarnesses, harnessFor,
    getD1CreateCalls: () => d1CreateCalls,
    getKvCreateCalls: () => kvCreateCalls,
  }
}
