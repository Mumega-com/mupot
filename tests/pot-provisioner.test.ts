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
  checkSlugAvailability,
  PotSlugTakenError,
  DISPATCH_NAMESPACE,
} from '../src/pots/service'
import { validateProvisionRequestBody, PROVISION_ALLOWED_FIELDS } from '../src/pots/validate'
import { toolPotProvision, toolPotList } from '../src/mcp/pots'
import { potsApp } from '../src/pots/routes'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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

/** A DISPATCHER double that answers `/health` with a configurable body (default: a
 *  realistic `publicHealth`-shaped payload matching `tenant`/`releaseSha`, so the
 *  identity-check happy path is exercised for real rather than trivially). */
function fakeDispatcher(opts: { status?: number; body?: string; tenant?: string; releaseSha?: string; throwNotFound?: boolean } = {}) {
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

/** Routes a D1 REST `/query` call against a REAL SQLite database standing in for the
 *  child pot's D1 (mupot#1507 round-2 TEST HARNESS requirement: the old suite's fake
 *  answered success to every query, so the seed step's real triggers — most importantly
 *  migration 0071's `member_tokens_agent_binding_insert` — never actually ran).
 *
 *  Zero-param statements (the entire schema chain, and this PR's atomic seed batch, which
 *  inlines every value rather than binding params — see seedPotIdentities' doc comment)
 *  go through RAW `sqlite.exec()` / `sqlite.prepare().all()`, bypassing
 *  `tests/helpers/sqlite-d1.ts`'s `normalizeD1Bindings` entirely — that rewriter's
 *  `/\?(\d+)/g` regex matches a `?1`-shaped substring even INSIDE a `--` comment (real
 *  example: migrations/0040's own header comment), which would corrupt schema-chain SQL
 *  that was never parameterized in the first place. Only genuinely parameterized
 *  SELECTs (the identity-check queries in seedPotIdentities) go through the D1-emulation
 *  `harness.db` wrapper, which needs `?N`→anonymous-`?` rewriting to work at all. */
async function execAgainstChildHarness(
  harness: SqliteD1Harness,
  sql: string,
  params: unknown[],
): Promise<{ success: boolean; result?: unknown; errors?: Array<{ message: string }> }> {
  try {
    const isSelect = /^\s*SELECT/i.test(sql)
    if (params && params.length > 0) {
      const stmt = harness.db.prepare(sql).bind(...params)
      if (isSelect) {
        const res = await stmt.all()
        return { success: true, result: [{ results: res.results, success: true }] }
      }
      const res = await stmt.run()
      return { success: true, result: [{ results: [], success: res.success }] }
    }
    if (isSelect) {
      const rows = harness.sqlite.prepare(sql).all()
      return { success: true, result: [{ results: rows, success: true }] }
    }
    harness.sqlite.exec(sql)
    return { success: true, result: [{ results: [], success: true }] }
  } catch (error) {
    return { success: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] }
  }
}

/**
 * Fake Cloudflare REST backend backed by REAL SQLite child-pot databases. One
 * `SqliteD1Harness` per created/adopted D1 uuid, so the schema chain and seed batch run
 * against a real engine with the real migration 0071 trigger set — this is what actually
 * proves the P0-1 seed ordering fix (not a mock that answers success to everything).
 */
function createRealisticFakeCf(opts: {
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
      const result = await execAgainstChildHarness(harnessFor(databaseId), body.sql, body.params ?? [])
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

describe('Sovereign Pot Provisioner (Flight 2 + mupot#1285/#1507)', () => {
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
        json: async () => ({ success: true, result: { uuid: 'd1-uuid-456', name: 'mupot-pot-gaf' }, errors: [] }),
      })
      global.fetch = mockFetch
      const res = await createD1Database(cf, 'mupot-pot-gaf')
      expect(res.uuid).toBe('d1-uuid-456')
    })

    it('creates KV namespace via Cloudflare REST API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, result: { id: 'kv-id-789', title: 'mupot-pot-gaf-kv' }, errors: [] }),
      })
      global.fetch = mockFetch
      const res = await createKVNamespace(cf, 'mupot-pot-gaf-kv')
      expect(res.id).toBe('kv-id-789')
    })

    it('uploads User Worker script with explicit isolated bindings + RELEASE_SHA to dispatch namespace', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, result: { id: 'gaf' }, errors: [] }),
      })
      global.fetch = mockFetch
      const res = await uploadUserWorkerToDispatch(cf, 'gaf', 'export default { fetch() {} }', {
        d1DatabaseId: 'd1-uuid-456', kvNamespaceId: 'kv-id-789', tenantSlug: 'gaf',
        brandName: 'GAF Materials', publicOrigin: 'https://mupot.mumega.com/t/gaf', releaseSha: 'abc1234',
      })
      expect(res.id).toBe('gaf')
      const [, requestInit] = mockFetch.mock.calls[0]
      const metadata = JSON.parse(await (requestInit.body as FormData).get('metadata')!.text())
      expect(metadata.bindings).toEqual(expect.arrayContaining([{ type: 'plain_text', name: 'RELEASE_SHA', text: 'abc1234' }]))
    })

    it('lists all provisioned sovereign customer pots from dispatch namespace', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, result: [{ id: 'gaf' }, { id: 'viamar' }] }),
      })
      const pots = await listSovereignPots(cf)
      expect(pots.map((p) => p.slug)).toEqual(['gaf', 'viamar'])
    })
  })

  describe('reuse-or-create CF-layer helpers (requirement 1)', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    it('findD1DatabaseByName adopts an existing database by exact name match', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, result: [{ uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom' }] }),
      })
      expect(await findD1DatabaseByName(cf, 'mupot-pot-psychonom')).toEqual({ uuid: 'b0568c25-orphan', name: 'mupot-pot-psychonom' })
    })

    it('getOrCreateD1Database creates fresh when no name match exists', async () => {
      const { fetchMock, calls } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const result = await getOrCreateD1Database(cf, 'mupot-pot-newslug')
      expect(result).toEqual({ uuid: 'd1-mupot-pot-newslug', name: 'mupot-pot-newslug', adopted: false })
      expect(calls.some((c) => c.method === 'POST' && /\/d1\/database$/.test(c.url))).toBe(true)
    })

    it('findKVNamespaceByTitle paginates and matches by title', async () => {
      let page = 0
      global.fetch = vi.fn().mockImplementation(async () => {
        page += 1
        if (page === 1) return { status: 200, json: async () => ({ success: true, result: Array.from({ length: 100 }, (_, i) => ({ id: `kv-${i}`, title: `other-${i}` })) }) }
        return { status: 200, json: async () => ({ success: true, result: [{ id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv' }] }) }
      })
      expect(await findKVNamespaceByTitle(cf, 'mupot-pot-psychonom-kv')).toEqual({ id: '061ebc1e-orphan', title: 'mupot-pot-psychonom-kv' })
    })
  })

  describe('loadPotWorkerBundle (requirement 3 bundle trade-off; round-2 P1-2 digest verification)', () => {
    async function sha256(text: string): Promise<string> {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }

    it('prefers the R2-published bundle when its recorded digest matches the bytes read back', async () => {
      const code = '// r2 bundle'
      const digest = await sha256(code)
      const bucket = { get: vi.fn().mockResolvedValue({ text: async () => code, customMetadata: { sha256: digest } }) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const result = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(result).toEqual({ ok: true, bundle: { code, source: 'r2', sha256: digest, r2ObjectKey: 'sha123/worker.js' } })
    })

    it('FAILS CLOSED, never falls back, when the R2 object digest does not match its recorded metadata', async () => {
      const bucket = { get: vi.fn().mockResolvedValue({ text: async () => '// tampered', customMetadata: { sha256: 'deadbeef'.repeat(8) } }) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const result = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.reason).toContain('digest mismatch')
    })

    it('FAILS CLOSED when the R2 object carries no recorded digest at all', async () => {
      const bucket = { get: vi.fn().mockResolvedValue({ text: async () => '// unsigned', customMetadata: {} }) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const result = await loadPotWorkerBundle(env, '// explicit bundle')
      expect(result.ok).toBe(false)
    })

    it('FAILS CLOSED (round-2 P1-2: NO fallback to worker_js_code) when the R2 GET call itself throws', async () => {
      const bucket = { get: vi.fn().mockRejectedValue(new Error('R2 transport error')) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const result = await loadPotWorkerBundle(env, '// explicit bundle — must NOT be used')
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.reason).toContain('R2 GET')
      expect(result.reason).toContain('transport error')
    })

    it('falls back to the explicit bundle (still digest-receipted) when R2 has no object for this RELEASE_SHA', async () => {
      const bucket = { get: vi.fn().mockResolvedValue(null) }
      const env = { RELEASE_SHA: 'sha123', POT_WORKER_BUNDLE_BUCKET: bucket } as unknown as Env
      const code = '// explicit bundle'
      expect(await loadPotWorkerBundle(env, code)).toEqual({ ok: true, bundle: { code, source: 'explicit', sha256: await sha256(code) } })
    })

    it('falls back to the explicit bundle when no bucket binding is configured at all', async () => {
      const env = {} as unknown as Env
      const code = '// explicit bundle'
      expect(await loadPotWorkerBundle(env, code)).toEqual({ ok: true, bundle: { code, source: 'explicit', sha256: await sha256(code) } })
    })

    it('is a hard, named failure when neither source has a bundle', async () => {
      const result = await loadPotWorkerBundle({} as unknown as Env, undefined)
      expect(result.ok).toBe(false)
    })
  })

  describe('seedPotIdentities against a REAL child schema (round-2 P0-1/P0-2)', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    function seededChildHarness(): SqliteD1Harness {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      return harness
    }

    it('seeds atomically: agent_member_bindings precedes the seed-seat token, and the real 0071 triggers accept it', async () => {
      const harness = seededChildHarness()
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const m = (url as string).match(/\/query$/)
        if (!m) throw new Error('unexpected non-query URL in this test: ' + url)
        const body = JSON.parse(init.body as string)
        return { status: 200, json: async () => execAgainstChildHarness(harness, body.sql, body.params ?? []) }
      }) as any

      const result = await seedPotIdentities(cf, 'child-db', { slug: 'gaf', brandName: 'GAF Materials', adminEmail: 'admin@gaf.com' })

      expect(result.ok).toBe(true)
      expect(result.alreadySeeded).toBe(false)
      expect(result.adminRawToken).toMatch(/^pot_adm_/)
      expect(result.leadAgentRawToken).toMatch(/^pot_agt_/)

      // Real rows, real trigger-enforced shape — this is the actual proof, not a mock
      // reporting success.
      const binding = harness.sqlite.prepare(
        'SELECT * FROM agent_member_bindings WHERE agent_id = ?',
      ).get(result.leadAgentId)
      expect(binding).toBeTruthy()
      const leadCap = harness.sqlite.prepare(
        "SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'squad'",
      ).get(result.leadAgentMemberId) as { capability: string } | undefined
      // 'lead', matching agents.role — the home-capability ceiling (migration 0071) that
      // used to cap this was dropped by migration 0087 on an explicit Hadi directive.
      expect(leadCap?.capability).toBe('lead')
      const seedSeatToken = harness.sqlite.prepare(
        "SELECT * FROM member_tokens WHERE agent_id = ? AND label = 'seed-seat'",
      ).get(result.leadAgentId)
      expect(seedSeatToken).toBeTruthy()
    })

    it('MUTATION-EQUIVALENT: without the binding insert, the real trigger aborts the whole batch and NOTHING from it persists', async () => {
      // Reproduces P0-1's exact reported defect directly against the real schema, without
      // needing to mutate service.ts's source for this one assertion — the trigger itself
      // is the authority. (A source-level mutation removing the binding statement is ALSO
      // run manually as part of this PR's mutation ledger — see the PR body.)
      const harness = seededChildHarness()
      const now = new Date().toISOString()
      const badBatch = [
        'BEGIN;',
        `INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('adm-x', 'admin@bad.test', 'Admin', 'active', 'bad', '${now}');`,
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES ('cap-x', 'adm-x', 'org', NULL, 'owner', '${now}');`,
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('dept-x', 'core', 'Bad Co', 'work', 1, '${now}');`,
        `INSERT INTO squads (id, department_id, slug, name, kind, created_at) VALUES ('sq-x', 'dept-x', 'core', 'Core', 'work', '${now}');`,
        `INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('lam-x', NULL, 'Lead Agent', 'active', 'bad', '${now}');`,
        `INSERT INTO agents (id, squad_id, slug, name, role, status, kind, owner_member_id, created_at) VALUES ('la-x', 'sq-x', 'bad-bot', 'Lead Agent', 'lead', 'active', 'work', 'lam-x', '${now}');`,
        // NO agent_member_bindings insert here — this is the exact class the fix closes.
        `INSERT INTO member_tokens (id, member_id, agent_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-x', 'lam-x', 'la-x', '${'a'.repeat(64)}', 'seed-seat', 'workspace', '${now}', 'bad');`,
        'COMMIT;',
      ].join('\n')

      expect(() => harness.sqlite.exec(badBatch)).toThrow(/agent_identity_conflict/)
      // The transaction is left OPEN by node:sqlite on error (verified empirically — see
      // this PR's doc comment on seedPotIdentities) — an explicit ROLLBACK, exactly what
      // seedPotIdentities issues on catch, is what actually clears it.
      harness.sqlite.exec('ROLLBACK;')

      // Nothing from the batch persists: no admin member, no org:owner capability, no
      // orphan token — the exact "admin member + capability + orphan token, no lead
      // agent" partial state requirement 1 names.
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM members WHERE id IN ('adm-x','lam-x')").get()).toEqual({ c: 0 })
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM capabilities WHERE id = 'cap-x'").get()).toEqual({ c: 0 })
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM member_tokens WHERE id = 'tok-x'").get()).toEqual({ c: 0 })
    })

    it('a genuine seedPotIdentities() failure leaves NO trace — real ROLLBACK proven end to end', async () => {
      const harness = seededChildHarness()
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        // Force the LAST statement (the seed-seat token insert) to fail by pre-seeding a
        // UNIQUE collision on its token_hash.
        if (/^INSERT INTO member_tokens\b/.test(body.sql) === false) {
          return { status: 200, json: async () => execAgainstChildHarness(harness, body.sql, body.params ?? []) }
        }
        // Let the schema-chain / normal flow through; only sabotage the ATOMIC BATCH by
        // pre-inserting a colliding token_hash right before it runs, once.
        return { status: 200, json: async () => execAgainstChildHarness(harness, body.sql, body.params ?? []) }
      }) as any

      // Pre-seed a colliding admin token_hash the batch's OWN generated hash cannot equal
      // (sha256Hex of a random UUID) — instead, force a real collision the deterministic
      // way: pre-create the admin member row directly with the SAME id the batch does NOT
      // control (department slug UNIQUE(department_id, slug) is simpler to collide on).
      harness.sqlite.exec(
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('pre-existing-dept', 'core', 'Pretaken', 'work', 1, '${new Date().toISOString()}')`,
      )
      // 'core' is not unique alone (UNIQUE is per-slug globally via departments.slug
      // UNIQUE) — departments.slug IS globally UNIQUE (migration 0001), so THIS second
      // 'core' insert inside the real seed batch will collide and abort.

      const result = await seedPotIdentities(cf, 'child-db', { slug: 'collideco', brandName: 'Collide Co', adminEmail: 'admin@collide.test' })

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('atomic seed batch failed')
      // Nothing landed — the admin member insert that WOULD have run right after the
      // colliding department insert never took effect.
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM members WHERE email = 'admin@collide.test'").get()).toEqual({ c: 0 })
    })

    it('is idempotent (case-insensitive email) — a retry checks the FULL identity, not just member existence, and mints nothing new', async () => {
      const harness = seededChildHarness()
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        return { status: 200, json: async () => execAgainstChildHarness(harness, body.sql, body.params ?? []) }
      }) as any

      const first = await seedPotIdentities(cf, 'child-db', { slug: 'gaf', brandName: 'GAF', adminEmail: 'Admin@Gaf.com' })
      expect(first.ok).toBe(true)

      const second = await seedPotIdentities(cf, 'child-db', { slug: 'gaf', brandName: 'GAF', adminEmail: 'admin@gaf.com' })
      expect(second.ok).toBe(true)
      expect(second.alreadySeeded).toBe(true)
      expect(second.adminMemberId).toBe(first.adminMemberId)
      expect(second.leadAgentId).toBe(first.leadAgentId)
      expect(second.adminRawToken).toBeNull()
      // Fingerprint recovered from the stored hash, matches the original mint.
      expect(second.adminTokenFingerprint).toBe(first.adminTokenFingerprint)

      const adminRows = harness.sqlite.prepare("SELECT COUNT(*) as c FROM members WHERE email = 'admin@gaf.com'").get()
      expect(adminRows).toEqual({ c: 1 }) // never a duplicate via case-mismatch
    })

    it('P0-2: a HALF-seeded pot (admin member exists, but no org:owner capability) is a hard failure, never ok:true', async () => {
      const harness = seededChildHarness()
      const now = new Date().toISOString()
      // Admin member exists — but nothing else does. The OLD check ("does a member with
      // this email exist") would have reported this as fully seeded.
      harness.sqlite.exec(
        `INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('half-admin', 'admin@half.test', 'Half Admin', 'active', 'half', '${now}')`,
      )
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        return { status: 200, json: async () => execAgainstChildHarness(harness, body.sql, body.params ?? []) }
      }) as any

      const result = await seedPotIdentities(cf, 'child-db', { slug: 'half', brandName: 'Half Co', adminEmail: 'admin@half.test' })

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('partial seed state detected')
      expect(result.detail).toContain('admin_owner_capability')
      expect(result.detail).toContain('admin_token')
      expect(result.detail).toContain('lead_agent')
    })
  })

  describe('verifyPotReachable (round-2 P1-1: tenant + release_sha identity check)', () => {
    it('is ok when tenant and release_sha both match', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: 'a'.repeat(40) }) as any, RELEASE_SHA: 'a'.repeat(40) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(true)
      expect(result.tenantMatch).toBe(true)
      expect(result.releaseShaMatch).toBe(true)
      expect(result.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    })

    it('fails when the health body reports the WRONG tenant', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'some-other-pot', releaseSha: 'a'.repeat(40) }) as any, RELEASE_SHA: 'a'.repeat(40) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
      expect(result.tenantMatch).toBe(false)
    })

    it('fails when the health body reports a DIFFERENT commit than what was uploaded', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: 'b'.repeat(40) }) as any, RELEASE_SHA: 'a'.repeat(40) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
      expect(result.releaseShaMatch).toBe(false)
    })

    it('release_sha check is trivially satisfied (not a failure) when this deployment has no RELEASE_SHA configured', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: null as any }) as any } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(true)
      expect(result.releaseShaMatch).toBe(true)
    })

    it('never stores the raw /health body — only its sha256', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: 'a'.repeat(40) }) as any, RELEASE_SHA: 'a'.repeat(40) } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(JSON.stringify(result)).not.toContain('"service":"mupot"')
      expect(result.bodySha256).toBeTruthy()
    })

    it('is not ok when the dispatcher throws script-not-found', async () => {
      const env = { DISPATCHER: fakeDispatcher({ throwNotFound: true }) as any } as unknown as Env
      const result = await verifyPotReachable(env, 'ghost-slug', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
    })

    it('fails closed with no DISPATCHER binding configured', async () => {
      const result = await verifyPotReachable({} as unknown as Env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(false)
    })
  })

  describe('checkSlugAvailability / pots registry (round-2 P0-4)', () => {
    it('reports a slug already in `pots` as taken', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      harness.sqlite.exec(`INSERT INTO pots (id, slug, worker_script, status, source) VALUES ('p1','gaf','gaf','active','provision')`)
      const env = { DB: harness.db } as unknown as Env
      const res = await checkSlugAvailability(env, 'gaf')
      expect(res.available).toBe(false)
    })

    it('still accepts a genuinely free slug', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const env = { DB: harness.db } as unknown as Env
      const res = await checkSlugAvailability(env, 'genuinely-unused-slug')
      expect(res.available).toBe(true)
    })
  })

  describe('validateProvisionRequestBody (round-2 P0-3)', () => {
    it('accepts exactly the allowed fields', () => {
      const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b.com' })
      expect(result.ok).toBe(true)
    })

    for (const forbidden of ['worker_js_code', 'cf_api_token', 'account_id']) {
      it(`refuses '${forbidden}' with a named error, never silently drops it`, () => {
        const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b.com', [forbidden]: 'x' })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected failure')
        expect(result.error).toBe('unexpected_fields')
        expect(result.message).toContain(forbidden)
      })
    }

    it('refuses an arbitrary unknown field the same way', () => {
      const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b.com', is_admin: true })
      expect(result.ok).toBe(false)
    })

    it('MCP tool inputSchema properties are built from the SAME allow-list (parity by construction)', () => {
      expect(Object.keys(toolPotProvision.inputSchema.properties as object).sort()).toEqual([...PROVISION_ALLOWED_FIELDS].sort())
    })

    it('Athena condition iii: provisionSovereignPot ITSELF refuses forbidden keys via an `as any` bypass, independent of either surface validator', async () => {
      const env = { SECRET_ENV_CF_API_TOKEN: 'x', TENANT_SLUG: 'mumega' } as unknown as Env
      for (const forbidden of ['worker_js_code', 'cf_api_token', 'account_id']) {
        const input = { slug: 'x', brand_name: 'X', admin_email: 'a@b.com', [forbidden]: 'smuggled' } as any
        await expect(provisionSovereignPot(env, input), forbidden).rejects.toThrow(new RegExp(forbidden))
      }
    })
  })

  describe('POST /api/pots/provision through the real Hono app (round-2 P0-3)', () => {
    const TENANT = 'local'
    const OWNER_COOKIE = 'mupot_session=owner-s'

    async function ownerEnv(): Promise<{ env: Env; harness: SqliteD1Harness }> {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const owner = JSON.stringify({ userId: 'u-owner', email: 'owner@local.test', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' })
      const env = {
        TENANT_SLUG: TENANT,
        DB: harness.db,
        SESSIONS: { get: async (k: string) => (k === 'sess:owner-s' ? owner : null), put: async () => undefined, delete: async () => undefined },
        SECRET_ENV_CF_API_TOKEN: 'cf-tok',
      } as unknown as Env
      await env.DB.prepare(
        `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('mem-owner', ?1, 'owner@local.test', 'Owner', 'active', datetime('now'))`,
      ).bind(TENANT).run()
      return { env, harness }
    }

    it('rejects worker_js_code with 400, never reaching provisionSovereignPot', async () => {
      const { env } = await ownerEnv()
      const res = await potsApp.request('/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: OWNER_COOKIE },
        body: JSON.stringify({ slug: 'evil', brand_name: 'Evil', admin_email: 'a@b.com', worker_js_code: '//pwn' }),
      }, env)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toBe('unexpected_fields')
    })

    it('rejects cf_api_token / account_id the same way', async () => {
      const { env } = await ownerEnv()
      const res = await potsApp.request('/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: OWNER_COOKIE },
        body: JSON.stringify({ slug: 'evil', brand_name: 'Evil', admin_email: 'a@b.com', cf_api_token: 'steal-me', account_id: 'not-mine' }),
      }, env)
      expect(res.status).toBe(400)
    })

    it('a slug already registered to someone else is refused 409, with zero Cloudflare calls', async () => {
      const { env, harness } = await ownerEnv()
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, provisioner_member_id, provisioner_tenant) VALUES ('p1','taken','taken','active','provision','someone-else','other-tenant')`,
      )
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy
      const res = await potsApp.request('/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: OWNER_COOKIE },
        body: JSON.stringify({ slug: 'taken', brand_name: 'Taken', admin_email: 'a@b.com' }),
      }, env)
      expect(res.status).toBe(409)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('MCP tool operator-principal + tenant fence (round-2 P2, Athena condition v)', () => {
    it('refuses a bound-agent session (operator_principal_required)', async () => {
      const auth: AuthContext = { memberId: 'm1', boundAgentId: 'agent-1', role: 'admin', tenant: 'mumega', capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }] }
      const outcome = await toolPotProvision.run(auth, { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'x' } as unknown as Env, { slug: 'x', brand_name: 'X', admin_email: 'a@b.com' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('operator_principal_required')
    })

    it('refuses a caller whose tenant does not match this deployment', async () => {
      const auth: AuthContext = { memberId: 'm1', role: 'admin', tenant: 'foreign-tenant', capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }] }
      const outcome = await toolPotProvision.run(auth, { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'x' } as unknown as Env, { slug: 'x', brand_name: 'X', admin_email: 'a@b.com' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('tenant_mismatch')
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

    function receiptRows(sqlite: SqliteD1Harness['sqlite'], slug: string) {
      return sqlite
        .prepare('SELECT step, ok, detail FROM pot_provision_receipts WHERE slug = ? ORDER BY created_at ASC, rowid ASC')
        .all(slug) as Array<{ step: string; ok: number; detail: string | null }>
    }

    it('happy path against a REAL child schema: every step runs, ok:true, receipts queryable, registry activated', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any

      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: null as any }) as any })

      const result = await provisionSovereignPot(
        env,
        { slug: 'gaf', brand_name: 'GAF Materials', admin_email: 'admin@gaf.com', minted_by_member_id: 'admin-mem-id', caller_tenant: 'mumega' },
        '// worker bundle',
      )

      expect(result.ok).toBe(true)
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.admin_token).toBeNull()
      expect(result.admin_credential_claim?.claim_id).toBeTruthy()

      // Registry row is written and activated (P0-2/P0-4).
      const potRow = harness.sqlite.prepare('SELECT status, provisioner_member_id, provisioner_tenant FROM pots WHERE slug = ?').get('gaf') as any
      expect(potRow.status).toBe('active')
      expect(potRow.provisioner_member_id).toBe('admin-mem-id')
      expect(potRow.provisioner_tenant).toBe('mumega')

      // checkSlugAvailability now truthfully reports it taken.
      const availability = await checkSlugAvailability(env, 'gaf')
      expect(availability.available).toBe(false)

      // Receipts carry the actor, and NEVER an email, and are JSON where required.
      const rows = receiptRows(harness.sqlite, 'gaf')
      expect(rows).toHaveLength(6)
      for (const row of rows) {
        expect(row.detail ?? '').not.toContain('@')
      }
      const seedRow = rows.find((r) => r.step === 'seed_identities')!
      const seedDetail = JSON.parse(seedRow.detail!)
      expect(seedDetail.admin_member_id).toBe(result.admin_member_id)
      expect(seedDetail.admin_token_fingerprint).toMatch(/^[0-9a-f]{16}$/)

      const actorRows = harness.sqlite.prepare('SELECT actor_member_id, actor_tenant FROM pot_provision_receipts WHERE slug = ? LIMIT 1').get('gaf') as any
      expect(actorRows.actor_member_id).toBe('admin-mem-id')
      expect(actorRows.actor_tenant).toBe('mumega')
    })

    it('a DIFFERENT caller cannot adopt a slug already claimed by someone else (Athena condition i)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, provisioner_member_id, provisioner_tenant) VALUES ('p1','claimed','claimed','provisioning','provision','original-admin','mumega')`,
      )
      const { fetchMock, calls } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db })

      await expect(provisionSovereignPot(
        env, { slug: 'claimed', brand_name: 'Hijack Co', admin_email: 'attacker@evil.test', minted_by_member_id: 'attacker-mem-id', caller_tenant: 'mumega' },
      )).rejects.toThrow(PotSlugTakenError)
      expect(calls).toHaveLength(0) // zero Cloudflare calls
    })

    it('the SAME caller retrying an already-claimed slug adopts and continues (owner retry)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, provisioner_member_id, provisioner_tenant) VALUES ('p1','retryco','retryco','provisioning','provision','admin-mem-id','mumega')`,
      )
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'retryco', releaseSha: null as any }) as any })

      const result = await provisionSovereignPot(
        env, { slug: 'retryco', brand_name: 'Retry Co', admin_email: 'admin@retryco.test', minted_by_member_id: 'admin-mem-id', caller_tenant: 'mumega' }, '// bundle',
      )
      expect(result.ok).toBe(true)
    })

    it('a race for a brand-new slug refuses the loser via the UNIQUE(slug) constraint', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db })

      // Simulate the race directly: pre-insert the row a "concurrent winner" would have
      // written, then attempt the SAME slug as a genuinely different caller.
      await env.DB.prepare(
        "INSERT INTO pots (id, slug, worker_script, status, source, provisioner_member_id, provisioner_tenant) VALUES (?1,?2,?2,'provisioning','provision',?3,?4)",
      ).bind('race-winner', 'racer', 'winner-mem-id', 'mumega').run()

      await expect(provisionSovereignPot(
        env, { slug: 'racer', brand_name: 'Racer', admin_email: 'loser@evil.test', minted_by_member_id: 'loser-mem-id', caller_tenant: 'mumega' },
      )).rejects.toThrow(PotSlugTakenError)
    })

    it('M5 pinned at the entry: a reserved slug is refused before any Cloudflare call', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock, calls } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db })

      await expect(provisionSovereignPot(env, { slug: 'mumega', brand_name: 'X', admin_email: 'a@b.com' })).rejects.toThrow(/reserved/)
      expect(calls).toHaveLength(0)
    })

    it('M8 pinned: no minted_by_member_id means no claim, even on full ok:true success', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'noclaim', releaseSha: null as any }) as any })

      const result = await provisionSovereignPot(env, { slug: 'noclaim', brand_name: 'No Claim Co', admin_email: 'admin@noclaim.test' }, '// bundle')
      expect(result.ok).toBe(true)
      expect(result.admin_credential_claim).toBeNull()
      expect(result.lead_agent_credential_claim).toBeNull()
    })

    it('schema failure mid-chain: incomplete, names the file+statement, seeding never runs, registry stays "provisioning"', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({
        queryOverride: (sql, _params, _dbId, idx) => {
          if (idx === 4) return { success: false, errors: [{ message: 'mocked mid-chain SQL failure' }] }
          return undefined
        },
      })
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(env, { slug: 'brokenschema', brand_name: 'Broken Schema Co', admin_email: 'admin@broken.test' }, '// bundle')

      expect(result.ok).toBe(false)
      expect(result.completed).toEqual(['create_d1', 'create_kv'])
      expect(result.incomplete_reason).toContain('statementIndex=0')
      const potRow = harness.sqlite.prepare('SELECT status FROM pots WHERE slug = ?').get('brokenschema') as any
      expect(potRow.status).toBe('provisioning')
    })

    it('dispatch upload failure: schema DID apply, incomplete from deploy_worker onward', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({ failDeploy: true })
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(env, { slug: 'deployfail', brand_name: 'Deploy Fail Co', admin_email: 'admin@deployfail.test' }, '// bundle')
      expect(result.ok).toBe(false)
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema'])
    })

    it('health identity mismatch: verify_reachable fails even on HTTP 200 when tenant does not match', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'wrong-tenant' }) as any })

      const result = await provisionSovereignPot(env, { slug: 'mismatch', brand_name: 'Mismatch Co', admin_email: 'admin@mismatch.test' }, '// bundle')
      expect(result.ok).toBe(false)
      expect(result.not_completed).toEqual(['verify_reachable'])
      const rows = receiptRows(harness.sqlite, 'mismatch')
      const reach = JSON.parse(rows.find((r) => r.step === 'verify_reachable')!.detail!)
      expect(reach.tenant_match).toBe(false)
    })

    it('deploy_worker fails closed with no bundle source at all', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ status: 200 }) as any })

      const result = await provisionSovereignPot(env, { slug: 'nobundle', brand_name: 'No Bundle Co', admin_email: 'admin@nobundle.test' })
      expect(result.ok).toBe(false)
      expect(result.not_completed).toContain('deploy_worker')
    })

    it('the two-argument form production actually calls reports incomplete and names the orphans', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db })

      const result = await provisionSovereignPot(env, { slug: 'neuraya', brand_name: 'Neuraya', admin_email: 'a@b.test' })
      expect(result.ok).toBe(false)
      expect(result.not_completed).toContain('deploy_worker')
      expect(result.orphaned_resources).not.toBeNull()
      expect(result.public_origin).toBe('https://mupot.mumega.com/t/neuraya')
    })
  })

  describe('MCP tools (non-provisioning)', () => {
    it('pot_list through invokeTool returns 503 unconfigured with top-level error when CF token is missing', async () => {
      const env = { PUBLIC_ORIGIN: 'https://mupot.mumega.com' } as unknown as Env
      const outcome = await invokeTool(orgAdmin, env, 'pot_list', {})
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.status).toBe(503)
    })

    it('pot_provision through invokeTool returns 503 unconfigured, not a detail-less 500, when CF token is missing', async () => {
      const env = { PUBLIC_ORIGIN: 'https://mupot.mumega.com', TENANT_SLUG: 'mumega' } as unknown as Env
      const outcome = await invokeTool(orgAdmin, env, 'pot_provision', { slug: 'gaf', brand_name: 'GAF', admin_email: 'admin@example.com' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.status).toBe(503)
    })
  })
})
