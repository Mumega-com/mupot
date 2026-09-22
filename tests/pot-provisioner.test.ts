import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sanitizeSlug,
  validateSlug,
  createD1Database,
  createKVNamespace,
  findD1DatabaseByName,
  getOrCreateD1Database,
  findKVNamespaceByTitle,
  getOrCreateKVNamespace,
  loadPotWorkerBundle,
  seedPotIdentities,
  verifyPotReachable,
  uploadUserWorkerToDispatch,
  listSovereignPots,
  provisionSovereignPot,
  DISPATCH_NAMESPACE,
} from '../src/pots/service'
import { toolPotProvision, toolPotList } from '../src/mcp/pots'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const orgAdmin: AuthContext = {
  memberId: 'admin-mem-id',
  role: 'admin',
  tenant: 'mumega',
  capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
}

/** Minimal in-memory KV double for the SESSIONS binding createCredentialClaim writes to. */
function fakeSessionsKv() {
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

/** A DISPATCHER double that answers `/health` with a configurable status, or throws a
 *  "not found"-shaped error to exercise dispatcher.ts's script-not-found branch. */
function fakeDispatcher(opts: { status?: number; body?: string; throwNotFound?: boolean } = {}) {
  return {
    get: vi.fn((_name: string) => ({
      fetch: vi.fn(async () => {
        if (opts.throwNotFound) throw new Error('No user worker found for the given name.')
        return new Response(opts.body ?? '{"status":"ok"}', {
          status: opts.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    })),
  }
}

/**
 * Fake Cloudflare REST backend. Covers every endpoint provisionSovereignPot's steps call:
 * D1 list-by-name / create / query, KV list / create, and the dispatch-namespace upload.
 * `queryOverride(sql, params, queryCallIndex)` lets a test intercept ANY /query POST (schema
 * chain statements, the pot_schema_applied bookkeeping read, or seedPotIdentities' own SQL)
 * and return `undefined` to fall through to the default (success, no rows).
 */
function createFakeCf(opts: {
  existingD1?: { uuid: string; name: string }
  existingKv?: { id: string; title: string }
  failDeploy?: boolean
  queryOverride?: (sql: string, params: unknown[], queryCallIndex: number) => { success: boolean; result?: unknown; errors?: Array<{ message: string }> } | undefined
} = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  let queryCallIndex = 0

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    calls.push({ url, method })

    // D1 — list by name (GET, reuse-or-create)
    if (method === 'GET' && url.includes('/d1/database?')) {
      const result = opts.existingD1 ? [opts.existingD1] : []
      return { status: 200, json: async () => ({ success: true, result }) }
    }
    // D1 — create (POST, no /query or /database/<id>/query suffix)
    if (method === 'POST' && /\/d1\/database$/.test(url)) {
      return {
        status: 200,
        json: async () => ({ success: true, result: { uuid: 'created-d1-uuid', name: 'mupot-pot-created' } }),
      }
    }
    // D1 — query (POST .../d1/database/<id>/query)
    if (method === 'POST' && /\/d1\/database\/[^/]+\/query$/.test(url)) {
      const body = init.body ? JSON.parse(init.body as string) : { sql: '', params: [] }
      const idx = queryCallIndex
      queryCallIndex += 1
      const override = opts.queryOverride?.(body.sql, body.params ?? [], idx)
      if (override) {
        return { status: override.success ? 200 : 200, json: async () => ({ ...override, result: override.result ?? [] }) }
      }
      // Default: the bookkeeping read fails "no such table" (fresh D1), everything else
      // (CREATE/INSERT/SELECT during seeding) succeeds with no rows.
      if (/^SELECT file, sha256, splitter_version, status FROM pot_schema_applied/.test(body.sql)) {
        return { status: 200, json: async () => ({ success: false, errors: [{ message: 'D1_ERROR: no such table: pot_schema_applied' }] }) }
      }
      return { status: 200, json: async () => ({ success: true, result: [{ results: [], success: true }] }) }
    }
    // KV — list (GET, reuse-or-create)
    if (method === 'GET' && url.includes('/storage/kv/namespaces?')) {
      const page = Number(new URL(url).searchParams.get('page') || '1')
      const result = page === 1 && opts.existingKv ? [opts.existingKv] : []
      return { status: 200, json: async () => ({ success: true, result }) }
    }
    // KV — create (POST)
    if (method === 'POST' && url.includes('/storage/kv/namespaces')) {
      return {
        status: 200,
        json: async () => ({ success: true, result: { id: 'created-kv-id', title: 'mupot-pot-created-kv' } }),
      }
    }
    // Dispatch namespace upload (PUT)
    if (method === 'PUT' && url.includes('/workers/dispatch/namespaces')) {
      if (opts.failDeploy) {
        return { status: 400, json: async () => ({ success: false, errors: [{ message: 'mocked deploy failure' }] }) }
      }
      return { status: 200, json: async () => ({ success: true, result: { id: 'deployed' } }) }
    }
    return { status: 404, json: async () => ({ success: false, errors: [{ message: 'unhandled mock route: ' + url }] }) }
  })

  return { fetchMock, calls, getQueryCallCount: () => queryCallIndex }
}

describe('Sovereign Pot Provisioner (Flight 2 + mupot#1285 completion)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('slug validation and sanitization', () => {
    it('sanitizes messy input strings into clean subdomain slugs', () => {
      expect(sanitizeSlug(' GAF Materials Inc. ')).toBe('gaf-materials-inc')
      expect(sanitizeSlug('Viamar__Data---')).toBe('viamar-data')
    })

    it('validates allowed subdomain slugs', () => {
      expect(validateSlug('gaf')).toEqual({ ok: true })
      expect(validateSlug('viamar-corp')).toEqual({ ok: true })
      expect(validateSlug('a')).toEqual({ ok: false, error: expect.stringContaining('at least 2') })
      expect(validateSlug('mumega')).toEqual({ ok: false, error: expect.stringContaining('reserved') })
      expect(validateSlug('mupot')).toEqual({ ok: false, error: expect.stringContaining('reserved') })
    })
  })

  describe('Cloudflare API operations', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    it('creates D1 database via Cloudflare REST API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          result: { uuid: 'd1-uuid-456', name: 'mupot-pot-gaf' },
          errors: [],
        }),
      })
      global.fetch = mockFetch

      const res = await createD1Database(cf, 'mupot-pot-gaf')
      expect(res.uuid).toBe('d1-uuid-456')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/acc-123/d1/database',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer cf-tok-abc' }),
          body: JSON.stringify({ name: 'mupot-pot-gaf' }),
        }),
      )
    })

    it('creates KV namespace via Cloudflare REST API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          result: { id: 'kv-id-789', title: 'mupot-pot-gaf-kv' },
          errors: [],
        }),
      })
      global.fetch = mockFetch

      const res = await createKVNamespace(cf, 'mupot-pot-gaf-kv')
      expect(res.id).toBe('kv-id-789')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/acc-123/storage/kv/namespaces',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'mupot-pot-gaf-kv' }),
        }),
      )
    })

    it('uploads User Worker script with explicit isolated bindings + RELEASE_SHA to dispatch namespace', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          result: { id: 'gaf' },
          errors: [],
        }),
      })
      global.fetch = mockFetch

      const res = await uploadUserWorkerToDispatch(cf, 'gaf', 'export default { fetch() {} }', {
        d1DatabaseId: 'd1-uuid-456',
        kvNamespaceId: 'kv-id-789',
        tenantSlug: 'gaf',
        brandName: 'GAF Materials',
        publicOrigin: 'https://mupot.mumega.com/t/gaf',
        releaseSha: 'abc1234',
      })

      expect(res.id).toBe('gaf')
      const [, requestInit] = mockFetch.mock.calls[0]
      const body = requestInit.body as FormData
      const metadataBlob = body.get('metadata') as Blob
      const metadata = JSON.parse(await metadataBlob.text())
      expect(metadata.bindings).toEqual(
        expect.arrayContaining([{ type: 'plain_text', name: 'RELEASE_SHA', text: 'abc1234' }]),
      )
    })

    it('lists all provisioned sovereign customer pots from dispatch namespace', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          result: [
            { id: 'gaf', created_on: '2026-08-26T18:00:00Z', modified_on: '2026-08-26T18:00:00Z' },
            { id: 'viamar', created_on: '2026-08-26T18:05:00Z', modified_on: '2026-08-26T18:05:00Z' },
          ],
        }),
      })
      global.fetch = mockFetch

      const pots = await listSovereignPots(cf)
      expect(pots).toHaveLength(2)
      expect(pots[0].slug).toBe('gaf')
      expect(pots[1].slug).toBe('viamar')
    })
  })

  describe('reuse-or-create (requirement 1: idempotent on slug, adopt orphans)', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    it('findD1DatabaseByName adopts an existing database by exact name match', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, result: [{ uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom' }] }),
      })
      const found = await findD1DatabaseByName(cf, 'mupot-pot-psychonom')
      expect(found).toEqual({ uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom' })
    })

    it('getOrCreateD1Database adopts an orphan instead of creating a duplicate', async () => {
      const { fetchMock, calls } = createFakeCf({ existingD1: { uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom' } })
      global.fetch = fetchMock as any
      const result = await getOrCreateD1Database(cf, 'mupot-pot-psychonom')
      expect(result).toEqual({ uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom', adopted: true })
      expect(calls.some((c) => c.method === 'POST' && /\/d1\/database$/.test(c.url))).toBe(false)
    })

    it('getOrCreateD1Database creates fresh when no name match exists', async () => {
      const { fetchMock, calls } = createFakeCf({})
      global.fetch = fetchMock as any
      const result = await getOrCreateD1Database(cf, 'mupot-pot-newslug')
      expect(result).toEqual({ uuid: 'created-d1-uuid', name: 'mupot-pot-created', adopted: false })
      expect(calls.some((c) => c.method === 'POST' && /\/d1\/database$/.test(c.url))).toBe(true)
    })

    it('findKVNamespaceByTitle paginates and matches by title', async () => {
      let page = 0
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        page += 1
        if (page === 1) {
          return { status: 200, json: async () => ({ success: true, result: Array.from({ length: 100 }, (_, i) => ({ id: `kv-${i}`, title: `other-${i}` })) }) }
        }
        return { status: 200, json: async () => ({ success: true, result: [{ id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv' }] }) }
      })
      const found = await findKVNamespaceByTitle({ accountId: 'a', apiToken: 't' }, 'mupot-pot-psychonom-kv')
      expect(found).toEqual({ id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv' })
    })

    it('getOrCreateKVNamespace adopts an orphan instead of creating a duplicate', async () => {
      const { fetchMock, calls } = createFakeCf({ existingKv: { id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv' } })
      global.fetch = fetchMock as any
      const result = await getOrCreateKVNamespace(cf, 'mupot-pot-psychonom-kv')
      expect(result).toEqual({ id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv', adopted: true })
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/storage/kv/namespaces'))).toBe(false)
    })
  })

  describe('loadPotWorkerBundle (requirement 3: bundle source trade-off)', () => {
    it('prefers the R2-published bundle for the current RELEASE_SHA when present', async () => {
      const bucket = { get: vi.fn().mockResolvedValue({ text: async () => '// r2 bundle' }) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const bundle = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(bundle).toEqual({ code: '// r2 bundle', source: 'r2' })
      expect(bucket.get).toHaveBeenCalledWith('sha123/worker.js')
    })

    it('falls back to the explicit bundle when R2 has no object for this RELEASE_SHA', async () => {
      const bucket = { get: vi.fn().mockResolvedValue(null) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const bundle = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(bundle).toEqual({ code: '// explicit bundle', source: 'explicit' })
    })

    it('falls back to the explicit bundle when no bucket binding is configured at all', async () => {
      const env = {} as unknown as Env
      const bundle = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(bundle).toEqual({ code: '// explicit bundle', source: 'explicit' })
    })

    it('returns null (hard, named failure) when neither source has a bundle', async () => {
      const env = {} as unknown as Env
      const bundle = await loadPotWorkerBundle(env, undefined)
      expect(bundle).toBeNull()
    })
  })

  describe('seedPotIdentities (requirement 4)', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    it('seeds department/squad/admin-member/lead-agent and mints hashed tokens', async () => {
      const inserted: string[] = []
      global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        if (/SELECT id FROM members WHERE email/.test(body.sql)) {
          return { status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) }
        }
        inserted.push(body.sql)
        return { status: 200, json: async () => ({ success: true, result: [{ results: [], success: true }] }) }
      })

      const result = await seedPotIdentities(cf, 'pot-db-id', {
        slug: 'gaf', brandName: 'GAF Materials', adminEmail: 'admin@gaf.com',
      })

      expect(result.ok).toBe(true)
      expect(result.alreadySeeded).toBe(false)
      expect(result.adminMemberId).toBeTruthy()
      expect(result.adminRawToken).toMatch(/^pot_adm_/)
      expect(result.leadAgentId).toBeTruthy()
      expect(result.leadAgentRawToken).toMatch(/^pot_agt_/)
      // Never the raw value in what got "written" (a hash, not the token, is inserted).
      expect(inserted.some((sql) => sql.includes('member_tokens'))).toBe(true)
    })

    it('is idempotent on admin email — a retry against an already-seeded pot mints no new tokens', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        if (/SELECT id FROM members WHERE email/.test(body.sql)) {
          return { status: 200, json: async () => ({ success: true, result: [{ results: [{ id: 'existing-admin-id' }] }] }) }
        }
        if (/SELECT id FROM agents WHERE slug/.test(body.sql)) {
          return { status: 200, json: async () => ({ success: true, result: [{ results: [{ id: 'existing-agent-id' }] }] }) }
        }
        throw new Error('unexpected write during an already-seeded retry: ' + body.sql)
      })

      const result = await seedPotIdentities(cf, 'pot-db-id', {
        slug: 'gaf', brandName: 'GAF Materials', adminEmail: 'admin@gaf.com',
      })

      expect(result.ok).toBe(true)
      expect(result.alreadySeeded).toBe(true)
      expect(result.adminMemberId).toBe('existing-admin-id')
      expect(result.leadAgentId).toBe('existing-agent-id')
      expect(result.adminRawToken).toBeNull()
      expect(result.leadAgentRawToken).toBeNull()
    })

    it('fails closed and names the failing statement when an insert fails', async () => {
      let call = 0
      global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        if (/SELECT id FROM members WHERE email/.test(body.sql)) {
          return { status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) }
        }
        call += 1
        if (call === 3) {
          // The 3rd write is the admin `members` INSERT.
          return { status: 200, json: async () => ({ success: false, errors: [{ message: 'UNIQUE constraint failed: members.email' }] }) }
        }
        return { status: 200, json: async () => ({ success: true, result: [{ results: [], success: true }] }) }
      })

      const result = await seedPotIdentities(cf, 'pot-db-id', {
        slug: 'gaf', brandName: 'GAF Materials', adminEmail: 'admin@gaf.com',
      })

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('seed statement 2')
      expect(result.detail).toContain('UNIQUE constraint failed')
    })
  })

  describe('verifyPotReachable (requirement 5)', () => {
    it('is ok when the dispatcher answers 200 through the internal binding', async () => {
      const env = { DISPATCHER: fakeDispatcher({ status: 200 }) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('is not ok when the dispatcher throws script-not-found', async () => {
      const env = { DISPATCHER: fakeDispatcher({ throwNotFound: true }) } as unknown as Env
      const result = await verifyPotReachable(env, 'ghost-slug', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
      expect(result.detail).toContain('ghost-slug')
    })

    it('is not ok on a non-200 response', async () => {
      const env = { DISPATCHER: fakeDispatcher({ status: 500, body: '{"error":"boom"}' }) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
    })

    it('fails closed with no DISPATCHER binding configured', async () => {
      const env = {} as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
      expect(result.detail).toContain('DISPATCHER binding not configured')
    })
  })

  describe('end-to-end sovereign pot orchestration', () => {
    function makeEnv(overrides: Partial<Env> & { harnessDb: unknown }) {
      const sessions = fakeSessionsKv()
      return {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: overrides.harnessDb,
        SESSIONS: sessions,
        ...overrides,
      } as unknown as Env
    }

    function receiptRows(sqlite: ReturnType<typeof createSqliteD1>['sqlite'], slug: string) {
      return sqlite
        .prepare('SELECT step, ok, detail FROM pot_provision_receipts WHERE slug = ? ORDER BY created_at ASC, rowid ASC')
        .all(slug) as Array<{ step: string; ok: number; detail: string | null }>
    }

    it('happy path: every step runs, ok:true, receipts row per step, credential claims (not raw tokens)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({})
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'gaf', brand_name: 'GAF Materials', admin_email: 'admin@gaf.com', minted_by_member_id: 'admin-mem-id' },
        '// worker bundle',
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe('provisioned')
      expect(result.not_completed).toEqual([])
      expect(result.orphaned_resources).toBeNull()
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.public_origin).toBe('https://mupot.mumega.com/t/gaf')

      // Never a raw token in the response.
      expect(result.admin_token).toBeNull()
      expect(result.lead_agent_token).toBeNull()
      expect(result.admin_login_url).toBe('https://mupot.mumega.com/t/gaf')
      // A redeemable claim instead (mupot#987 pattern).
      expect(result.admin_credential_claim?.claim_id).toBeTruthy()
      expect(result.admin_credential_claim?.reveal_tool).toBe('reveal_credential_claim')
      expect(result.lead_agent_credential_claim?.claim_id).toBeTruthy()

      const rows = receiptRows(harness.sqlite, 'gaf')
      expect(rows.map((r) => r.step)).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(rows.every((r) => r.ok === 1)).toBe(true)
      expect(result.receipts).toHaveLength(6)
    })

    it('adopt-orphans path: reuses the named D1/KV instead of creating duplicates (mupot#1285 comment 2026-09-22)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const existingD1 = { uuid: 'b0568c25-c1b6-4137-8fa0-690265d0b087', name: 'mupot-pot-psychonom' }
      const existingKv = { id: '061ebc1ed7c44a60b92c7e7966ed028c', title: 'mupot-pot-psychonom-kv' }
      const { fetchMock, calls } = createFakeCf({ existingD1, existingKv })
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'psychonom', brand_name: 'Psychonom', admin_email: 'admin@psychonom.test' },
        '// worker bundle',
      )

      expect(result.ok).toBe(true)
      expect(result.d1_database_id).toBe(existingD1.uuid)
      expect(result.kv_namespace_id).toBe(existingKv.id)
      expect(calls.some((c) => c.method === 'POST' && /\/d1\/database$/.test(c.url))).toBe(false)
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/storage/kv/namespaces'))).toBe(false)

      const rows = receiptRows(harness.sqlite, 'psychonom')
      const createD1Receipt = rows.find((r) => r.step === 'create_d1')
      expect(createD1Receipt?.detail).toContain('adopted existing database')
    })

    it('schema failure mid-chain: incomplete, names the file+statement, seeding never runs', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({
        queryOverride: (sql, _params, idx) => {
          // idx 0 = loadAlreadyAppliedSet's own bookkeeping read (falls through to the
          // default "no such table" response for a fresh D1); idx 1-2 = the two bootstrap
          // CREATE TABLE calls (pot_schema_applied, pot_schema_chain_meta); idx 3 = the
          // first real chain statement — fail exactly there.
          if (idx === 4) return { success: false, errors: [{ message: 'mocked mid-chain SQL failure' }] }
          return undefined
        },
      })
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'brokenschema', brand_name: 'Broken Schema Co', admin_email: 'admin@broken.test' },
        '// worker bundle',
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      expect(result.completed).toEqual(['create_d1', 'create_kv'])
      expect(result.not_completed).toEqual(['apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.orphaned_resources).not.toBeNull()
      expect(result.incomplete_reason).toContain('apply_schema failed')
      expect(result.incomplete_reason).toContain('statementIndex=0')
      expect(result.admin_member_id).toBe('')
      expect(result.admin_credential_claim).toBeNull()

      const rows = receiptRows(harness.sqlite, 'brokenschema')
      expect(rows.map((r) => r.step)).toEqual(['create_d1', 'create_kv', 'apply_schema'])
      const schemaReceipt = rows.find((r) => r.step === 'apply_schema')
      expect(schemaReceipt?.ok).toBe(0)
      expect(schemaReceipt?.detail).toContain('mocked mid-chain SQL failure')
    })

    it('dispatch upload failure: schema DID apply, but incomplete from deploy_worker onward', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({ failDeploy: true })
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'deployfail', brand_name: 'Deploy Fail Co', admin_email: 'admin@deployfail.test' },
        '// worker bundle',
      )

      expect(result.ok).toBe(false)
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema'])
      expect(result.not_completed).toEqual(['deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.incomplete_reason).toContain('deploy_worker failed')
    })

    it('deploy_worker fails closed with no bundle source at all (no R2 object, no worker_js_code)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({})
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      // No third positional argument, no input.worker_js_code, no POT_WORKER_BUNDLE_BUCKET.
      const result = await provisionSovereignPot(env, {
        slug: 'nobundle', brand_name: 'No Bundle Co', admin_email: 'admin@nobundle.test',
      })

      expect(result.ok).toBe(false)
      expect(result.not_completed).toContain('deploy_worker')
      expect(result.incomplete_reason).toContain('no worker bundle available')
    })

    it('health failure: seeding completed, but verify_reachable is the only incomplete step and no claims are minted', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({})
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 502, body: '{"error":"dispatcher_error"}' }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'unhealthy', brand_name: 'Unhealthy Co', admin_email: 'admin@unhealthy.test', minted_by_member_id: 'admin-mem-id' },
        '// worker bundle',
      )

      expect(result.ok).toBe(false)
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities'])
      expect(result.not_completed).toEqual(['verify_reachable'])
      expect(result.admin_credential_claim).toBeNull()
      expect(result.lead_agent_credential_claim).toBeNull()

      const rows = receiptRows(harness.sqlite, 'unhealthy')
      const reach = rows.find((r) => r.step === 'verify_reachable')
      expect(reach?.ok).toBe(0)
      expect(reach?.detail).toContain('502')
    })

    it('a retry after seeding already ran does not mint a second admin — idempotent seed_identities', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const seedState = { seeded: false, adminId: '', agentId: '', membersInsertCount: 0 }
      const { fetchMock } = createFakeCf({
        queryOverride: (sql, params) => {
          if (/SELECT id FROM members WHERE email/.test(sql)) {
            return seedState.seeded
              ? { success: true, result: [{ results: [{ id: seedState.adminId }] }] }
              : { success: true, result: [{ results: [] }] }
          }
          if (/SELECT id FROM agents WHERE slug/.test(sql)) {
            return { success: true, result: [{ results: seedState.seeded ? [{ id: seedState.agentId }] : [] }] }
          }
          // seedPotIdentities's OWN inserts use positional `?1` placeholders (real
          // parameterized queries); the schema chain's static seed data (e.g. the
          // "INSERT INTO memberships ..." backfills, the default "river-*" agents) is
          // baked-in literal SQL with no placeholders at all — `?1` is what tells them
          // apart. A bare `/INSERT INTO members/` regex would also match
          // "INSERT INTO memberships" (prefix collision) and every schema-seeded agent row.
          if (/^INSERT INTO members\b.*VALUES \(\?1/.test(sql) && !seedState.seeded) {
            seedState.membersInsertCount += 1
            if (seedState.membersInsertCount === 1) seedState.adminId = String(params[0])
          }
          if (/^INSERT INTO agents\b.*VALUES \(\?1/.test(sql) && !seedState.seeded) {
            seedState.agentId = String(params[0])
          }
          return undefined
        },
      })
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const first = await provisionSovereignPot(
        env, { slug: 'retryme', brand_name: 'Retry Co', admin_email: 'admin@retryme.test' }, '// worker bundle',
      )
      expect(first.ok).toBe(true)
      seedState.seeded = true

      const second = await provisionSovereignPot(
        env, { slug: 'retryme', brand_name: 'Retry Co', admin_email: 'admin@retryme.test' }, '// worker bundle',
      )
      expect(second.ok).toBe(true)
      expect(second.admin_member_id).toBe(first.admin_member_id)
      expect(second.admin_token).toBeNull()
      expect(second.admin_credential_claim).toBeNull() // nothing new to claim on an already-seeded retry
    })

    it('the two-argument form production actually calls reports incomplete and names the orphans', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db })

      const result = await provisionSovereignPot(env, {
        slug: 'neuraya', brand_name: 'Neuraya', admin_email: 'a@b.test',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      expect(result.not_completed).toContain('deploy_worker')
      expect(result.orphaned_resources).not.toBeNull()
      expect(result.orphaned_resources?.d1_database_id).toBe('created-d1-uuid')
      expect(result.orphaned_resources?.kv_namespace_id).toBe('created-kv-id')
      expect(result.incomplete_reason).toBeTruthy()
      expect(result.public_origin).toBe('https://mupot.mumega.com/t/neuraya')
      expect(result.public_origin).not.toContain('neuraya.mupot')
    })
  })

  describe('MCP tools', () => {
    it('executes pot_provision tool when caller holds org admin capability', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createFakeCf({})
      global.fetch = fetchMock as any

      const auth: AuthContext = {
        memberId: 'admin-mem-id',
        role: 'admin',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
      }

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: harness.db,
        SESSIONS: fakeSessionsKv(),
      } as unknown as Env

      const outcome = await toolPotProvision.run(auth, env, {
        slug: 'viamar',
        brand_name: 'Viamar Logistics',
        admin_email: 'hadi@viamar.com',
        plan_tier: 'enterprise',
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error(outcome.error)
      const data = outcome.result as { pot: { slug: string; d1_database_id: string; status: string } }
      expect(data.pot.slug).toBe('viamar')
      expect(data.pot.d1_database_id).toBe('created-d1-uuid')
      // No worker_js_code / RELEASE_SHA bundle wired through the MCP tool yet — the tool
      // still reports the exact incomplete step rather than a bare ok:false.
      expect(data.pot.status).toBe('incomplete')
    })

    it('pot_list through invokeTool returns 503 unconfigured with top-level error when CF token is missing', async () => {
      const env = { PUBLIC_ORIGIN: 'https://mupot.mumega.com' } as unknown as Env
      const outcome = await invokeTool(orgAdmin, env, 'pot_list', {})
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.status).toBe(503)
      expect(outcome.error).toBe('unconfigured')
      expect(String(outcome.detail)).toMatch(/Cloudflare API Token not configured/i)
    })

    it('pot_provision through invokeTool returns 503 unconfigured, not a detail-less 500, when CF token is missing', async () => {
      const env = { PUBLIC_ORIGIN: 'https://mupot.mumega.com' } as unknown as Env
      const outcome = await invokeTool(orgAdmin, env, 'pot_provision', {
        slug: 'gaf',
        brand_name: 'GAF',
        admin_email: 'admin@example.com',
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.status).toBe(503)
      expect(outcome.error).toBe('unconfigured')
      expect(String(outcome.detail)).toMatch(/Cloudflare API Token not configured/i)
    })
  })
})
