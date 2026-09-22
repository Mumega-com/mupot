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
  InvalidSlugError,
  releaseStalePot,
  receiptOk,
  receiptError,
  writeProvisionReceipt,
  DISPATCH_NAMESPACE,
} from '../src/pots/service'
import type { ProvisionStep } from '../src/pots/types'
import { validateProvisionRequestBody, PROVISION_ALLOWED_FIELDS } from '../src/pots/validate'
import { toolPotProvision, toolPotList, toolPotRelease } from '../src/mcp/pots'
import { potsApp } from '../src/pots/routes'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  execD1RestQuery,
  D1_TRANSACTION_CONTROL_ERROR,
  D1_MULTI_STATEMENT_PARAMS_ERROR,
  D1_TOO_MANY_PARAMS_ERROR,
  D1_STATEMENT_TOO_LARGE_ERROR,
  D1_ATTACH_REFUSED_ERROR,
  D1_TEMP_TABLE_REFUSED_ERROR,
  D1_MAX_BOUND_PARAMS,
  D1_MAX_STATEMENT_BYTES,
} from './helpers/d1-rest-double'
import { fakeSessionsKv, fakeDispatcher, createRealisticFakeCf } from './helpers/fake-cf-provisioner'

const orgAdmin: AuthContext = {
  memberId: 'admin-mem-id',
  role: 'admin',
  tenant: 'mumega',
  capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
}

/** Routes a D1 REST `/query` call against a REAL SQLite database standing in for the
 *  child pot's D1 — thin local alias for `tests/helpers/d1-rest-double.ts`'s
 *  `execD1RestQuery` (mupot#1507-v2 P0-A: that shared helper is what actually models D1's
 *  real transaction-control refusal and implicit per-call atomicity; every fake-CF backend
 *  in this repo should route `/query` through it rather than re-answering `success:true`
 *  to raw SQL text, which is exactly how mupot#1507 round-1's seed-ordering defect and
 *  round-2's app-level-BEGIN defect both shipped past a passing suite). */
const execAgainstChildHarness = execD1RestQuery

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
      expect(validateSlug('a')).toEqual({ ok: false, error: expect.stringContaining('at least 3') })
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

  describe('D1 REST double + seedPotIdentities atomicity WITHOUT app-level BEGIN/COMMIT (mupot#1507-v2 P0-A)', () => {
    const cf = { accountId: 'acc-123', apiToken: 'cf-tok-abc' }

    function seededChildHarness(): SqliteD1Harness {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      return harness
    }

    it('the double refuses BEGIN/COMMIT/ROLLBACK with D1\'s real error text — a real D1 engine is not a raw SQLite connection this Worker can wrap', async () => {
      const harness = seededChildHarness()
      for (const stmt of ['BEGIN;', 'BEGIN TRANSACTION;', 'begin immediate;', 'COMMIT;', 'ROLLBACK;']) {
        const res = await execD1RestQuery(harness, stmt, [])
        expect(res.success, stmt).toBe(false)
        expect(res.errors?.[0]?.message, stmt).toBe(D1_TRANSACTION_CONTROL_ERROR)
      }
    })

    it('the double refuses combining bound params with a multi-statement body', async () => {
      const harness = seededChildHarness()
      const res = await execD1RestQuery(harness, "SELECT 1; SELECT 2;", [1])
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_MULTI_STATEMENT_PARAMS_ERROR)
    })

    it('P2-1: the double catches transaction control that is NOT the first statement in the batch (per-statement, not per-batch)', async () => {
      const harness = seededChildHarness()
      const batch = [
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('d-x', 'core', 'X', 'work', 1, '2026-01-01T00:00:00.000Z');`,
        'COMMIT;', // hidden mid-batch — NOT the first line, which a batch-level ^-anchored check would miss
      ].join('\n')
      const res = await execD1RestQuery(harness, batch, [])
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_TRANSACTION_CONTROL_ERROR)
      // Refused before anything in the batch landed — including the statement BEFORE the
      // hidden COMMIT (the whole call is refused, same as a real D1 authorizer rejection).
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM departments WHERE id = 'd-x'").get()).toEqual({ c: 0 })
    })

    it('P2-1: a CREATE TRIGGER statement (a legitimate bare BEGIN inside its own body) is NEVER mistaken for transaction control', async () => {
      const harness = seededChildHarness()
      const triggerSql = [
        'CREATE TRIGGER IF NOT EXISTS d1_double_trigger_probe',
        '  AFTER INSERT ON departments',
        'BEGIN',
        "  SELECT 1;",
        'END;',
      ].join('\n')
      const res = await execD1RestQuery(harness, triggerSql, [])
      expect(res.success, JSON.stringify(res)).toBe(true)
      const row = harness.sqlite.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='trigger' AND name='d1_double_trigger_probe'").get()
      expect(row).toEqual({ c: 1 })
    })

    it('P2-1: refuses more than 100 bound parameters', async () => {
      const harness = seededChildHarness()
      const params = Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => i)
      const res = await execD1RestQuery(harness, 'SELECT 1 WHERE 1 = ?1', params)
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_TOO_MANY_PARAMS_ERROR)
    })

    it('P2-1: refuses a single statement over the ~100KB cap', async () => {
      const harness = seededChildHarness()
      const oversized = `SELECT '${'a'.repeat(D1_MAX_STATEMENT_BYTES)}';`
      const res = await execD1RestQuery(harness, oversized, [])
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_STATEMENT_TOO_LARGE_ERROR)
    })

    it("P2-1: refuses ATTACH (Cloudflare D1's documented restriction)", async () => {
      const harness = seededChildHarness()
      const res = await execD1RestQuery(harness, "ATTACH DATABASE 'other.db' AS other;", [])
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_ATTACH_REFUSED_ERROR)
    })

    it("P2-1: refuses CREATE TEMP TABLE (empirically verified per migrations/0049's own header)", async () => {
      const harness = seededChildHarness()
      const res = await execD1RestQuery(harness, 'CREATE TEMP TABLE d1_double_temp_probe (id TEXT);', [])
      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_TEMP_TABLE_REFUSED_ERROR)
    })

    it('P2-1: returns ONE result element PER STATEMENT in a multi-statement zero-param batch', async () => {
      const harness = seededChildHarness()
      const batch = [
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('d-y', 'dept-y', 'Y', 'work', 1, '2026-01-01T00:00:00.000Z');`,
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('d-z', 'dept-z', 'Z', 'work', 1, '2026-01-01T00:00:00.000Z');`,
      ].join('\n')
      const res = await execD1RestQuery(harness, batch, [])
      expect(res.success).toBe(true)
      expect(res.result).toHaveLength(2)
    })

    it('seedPotIdentities sends NO transaction-control statement — the batch it builds passes the double clean', async () => {
      const harness = seededChildHarness()
      const seenSql: string[] = []
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        seenSql.push(body.sql as string)
        return { status: 200, json: async () => execD1RestQuery(harness, body.sql, body.params ?? []) }
      }) as any

      const result = await seedPotIdentities(cf, 'child-db', { slug: 'cleanbatch', brandName: 'Clean Batch Co', adminEmail: 'admin@cleanbatch.test' })

      expect(result.ok).toBe(true)
      const seedBatch = seenSql.find((sql) => /INSERT INTO departments/.test(sql))!
      expect(seedBatch).toBeTruthy()
      expect(seedBatch).not.toMatch(/^\s*BEGIN\b/im)
      expect(seedBatch).not.toMatch(/;\s*COMMIT\s*;?\s*$/im)
    })

    it('MUTATION-PROVING: reintroducing an app-level BEGIN/COMMIT wrapper makes the REAL D1-shaped double refuse the whole batch — the exact defect P0-A closes', async () => {
      // This is what the round-2 version of seedPotIdentities actually sent — reproduced
      // here directly (not by editing src/pots/service.ts) to prove the double catches it,
      // independent of whether the source regresses. The companion source-level mutation
      // (re-adding 'BEGIN;'/'COMMIT;' to service.ts's `batchSql` array) was ALSO run by
      // hand against this same suite as part of this PR's mutation ledger: with the double
      // now used instead of the old always-succeeds fake, that mutation turns EVERY
      // `seedPotIdentities` happy-path test in this file red (`result.ok` becomes `false`),
      // where round-1/round-2's fake CF could not see it at all.
      const harness = seededChildHarness()
      const now = new Date().toISOString()
      const wrappedBatch = [
        'BEGIN;',
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('d-x', 'core', 'X', 'work', 1, '${now}');`,
        'COMMIT;',
      ].join('\n')

      const res = await execD1RestQuery(harness, wrappedBatch, [])

      expect(res.success).toBe(false)
      expect(res.errors?.[0]?.message).toBe(D1_TRANSACTION_CONTROL_ERROR)
      // Nothing persisted — refused before it ever touched the engine.
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM departments WHERE id = 'd-x'").get()).toEqual({ c: 0 })
    })

    it('a mid-batch failure through the double leaves ZERO identity rows — D1 REST\'s own one-call-one-batch atomicity, no app-level transaction needed', async () => {
      const harness = seededChildHarness()
      // Collide on departments.slug UNIQUE (global) so the seed batch's OWN department
      // insert (statement 1 of the batch) fails.
      harness.sqlite.exec(
        `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES ('pre-existing-dept', 'core', 'Pretaken', 'work', 1, '${new Date().toISOString()}')`,
      )
      global.fetch = vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        return { status: 200, json: async () => execD1RestQuery(harness, body.sql, body.params ?? []) }
      }) as any

      const result = await seedPotIdentities(cf, 'child-db', { slug: 'atomicfail', brandName: 'Atomic Fail Co', adminEmail: 'admin@atomicfail.test' })

      expect(result.ok).toBe(false)
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM members WHERE email = 'admin@atomicfail.test'").get()).toEqual({ c: 0 })
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM agents WHERE slug = 'atomicfail-bot'").get()).toEqual({ c: 0 })
    })

    // HARNESS PIN (not a source mutation — see the double's own doc comment): if
    // `tests/helpers/d1-rest-double.ts` were changed to ACCEPT transaction control instead
    // of refusing it, this whole describe block's first test goes red immediately — that IS
    // the intended signal. There is no separate automated check for "the double itself
    // regressed to modeling D1 incorrectly" beyond that direct assertion; a reviewer
    // changing the double's refusal behavior should treat that as changing what this test
    // means, not as a test to work around.
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

    it('release_sha check is trivially satisfied (not a failure, not asserted true) when this deployment has no RELEASE_SHA configured', async () => {
      const env = { DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: null as any }) as any } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.ok).toBe(true)
      // null, never true — "nothing configured" is "not verified," not "verified and matched".
      expect(result.releaseShaMatch).toBeNull()
    })

    it('M-RELEASESHA (mupot#1507-v2 P1 pin): a non-40-hex RELEASE_SHA (configured but malformed) records release_sha_match: null, never true — and still does not block ok:true', async () => {
      const env = {
        DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: undefined }) as any,
        RELEASE_SHA: 'unknown', // exactly what uploadUserWorkerToDispatch stamps when it has no real sha
      } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.releaseShaMatch).toBeNull()
      expect(result.ok).toBe(true)
    })

    it('MUTATION-EQUIVALENT: a REAL release_sha mismatch (both configured, both 40-hex) is still `false` (blocking), never swallowed by the null-is-non-blocking rule', async () => {
      // Distinct from the existing "fails when the health body reports a DIFFERENT commit"
      // test above (a fresh named assertion so a mutation collapsing `false` into `null` in
      // the caller's ok-gate — `releaseShaMatch === false` back to `!releaseShaMatch` — is
      // pinned at BOTH the field value and the resulting `ok`).
      const env = {
        DISPATCHER: fakeDispatcher({ tenant: 'gaf', releaseSha: 'b'.repeat(40) }) as any,
        RELEASE_SHA: 'a'.repeat(40),
      } as unknown as Env
      const result = await verifyPotReachable(env, 'gaf', 'mupot.mumega.com')
      expect(result.releaseShaMatch).toBe(false)
      expect(result.ok).toBe(false)
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

    it('M-CLAIM: refuses a slug already claimed by a `projects` worker BEFORE any pots row exists', async () => {
      // Pins that checkSlugAvailability's cross-table check runs at the registry gate for
      // a genuinely NEW slug (provisionSovereignPot's `!existingPotRow` branch) — without
      // it, the INSERT into `pots` would succeed (pots.slug UNIQUE says nothing about
      // `projects`), silently colliding with a project's own worker in the shared
      // `mupot-pots` dispatch namespace.
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      harness.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S1');
        INSERT INTO projects (id, slug, name, description, goal, status, assigned_squad_id, worker_name)
        VALUES ('p1', 'someproject', 'P', '', '', 'active', 's1', 'takenproj');
      `)
      const env = { DB: harness.db, SECRET_ENV_CF_API_TOKEN: 'x', TENANT_SLUG: 'mumega' } as unknown as Env
      await expect(provisionSovereignPot(env, { slug: 'takenproj', brand_name: 'X', admin_email: 'a@b.com' }))
        .rejects.toThrow(PotSlugTakenError)
      expect(harness.sqlite.prepare("SELECT COUNT(*) as c FROM pots WHERE slug = 'takenproj'").get()).toEqual({ c: 0 })
    })

    describe('staleness (mupot#1507-v2 P1-A)', () => {
      function insertPot(harness: SqliteD1Harness, overrides: Partial<{ status: string; created_at: string }> = {}) {
        harness.sqlite.exec(
          `INSERT INTO pots (id, slug, worker_script, status, source, created_at) VALUES ` +
            `('p-stale', 'staleslug', 'staleslug', '${overrides.status ?? 'provisioning'}', 'checkout', ` +
            `'${overrides.created_at ?? new Date().toISOString()}')`,
        )
      }

      it('a FRESH provisioning row still reads as taken', async () => {
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        insertPot(harness)
        const env = { DB: harness.db } as unknown as Env
        expect((await checkSlugAvailability(env, 'staleslug')).available).toBe(false)
      })

      it('a STALE provisioning row (past STALE_PROVISIONING_MS) reads as available again', async () => {
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        insertPot(harness, { created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
        const env = { DB: harness.db } as unknown as Env
        expect((await checkSlugAvailability(env, 'staleslug')).available).toBe(true)
      })

      it('an ACTIVE row is taken regardless of age — staleness never applies to a live pot', async () => {
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        insertPot(harness, { status: 'active', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
        const env = { DB: harness.db } as unknown as Env
        expect((await checkSlugAvailability(env, 'staleslug')).available).toBe(false)
      })
    })
  })

  describe('validateSlug / checkSlugAvailability length alignment + 400 vs 409 (mupot#1507-v2 P2)', () => {
    it('validateSlug and checkSlugAvailability agree on the 3-32 length window', () => {
      expect(validateSlug('ab')).toEqual({ ok: false, error: expect.stringContaining('at least 3') })
      expect(validateSlug('a'.repeat(33))).toEqual({ ok: false, error: expect.stringContaining('cannot exceed 32') })
      expect(validateSlug('a'.repeat(32))).toEqual({ ok: true })
    })

    it('a malformed (too-long) slug is refused 400 invalid_slug, never 409 pot_slug_taken', async () => {
      const env = { SECRET_ENV_CF_API_TOKEN: 'x', TENANT_SLUG: 'mumega' } as unknown as Env
      await expect(provisionSovereignPot(env, { slug: 'a'.repeat(40), brand_name: 'X', admin_email: 'a@b.com' }))
        .rejects.toThrow(InvalidSlugError)
    })

    it('POST /api/pots/provision surfaces a format refusal as 400, not 409 or 500', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const owner = JSON.stringify({ userId: 'u-owner', email: 'owner@local.test', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' })
      const env = {
        TENANT_SLUG: 'local',
        DB: harness.db,
        SESSIONS: { get: async (k: string) => (k === 'sess:owner-s' ? owner : null), put: async () => undefined, delete: async () => undefined },
        SECRET_ENV_CF_API_TOKEN: 'cf-tok',
      } as unknown as Env
      await env.DB.prepare(
        `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('mem-owner', 'local', 'owner@local.test', 'Owner', 'active', datetime('now'))`,
      ).run()
      const res = await potsApp.request('/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: 'mupot_session=owner-s' },
        body: JSON.stringify({ slug: 'x'.repeat(40), brand_name: 'X', admin_email: 'a@b.com' }),
      }, env)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toBe('invalid_slug')
    })
  })

  describe('pot_release (mupot#1507-v2 P1-A)', () => {
    const orgAdminAuth: AuthContext = {
      memberId: 'admin-mem-id', role: 'admin', tenant: 'mumega',
      capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
    }

    function insertPot(harness: SqliteD1Harness, opts: { status: string; createdAt: string }) {
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, created_at) VALUES ` +
          `('p-rel', 'relslug', 'relslug', '${opts.status}', 'checkout', '${opts.createdAt}')`,
      )
    }

    it('refuses to release a row that does not exist', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const outcome = await toolPotRelease.run(orgAdminAuth, env, { slug: 'ghost' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('not_found')
    })

    it('NEVER releases an active pot, regardless of age', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'active', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const outcome = await toolPotRelease.run(orgAdminAuth, env, { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('cannot_release_active_pot')
      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('active')
    })

    it('refuses to release a provisioning row that is not yet stale', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date().toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const outcome = await toolPotRelease.run(orgAdminAuth, env, { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('not_stale')
    })

    it('releases a stale provisioning row, receipted, and it becomes claimable by a NEW provisioner', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env

      const outcome = await toolPotRelease.run(orgAdminAuth, env, { slug: 'relslug' })
      expect(outcome.ok).toBe(true)

      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('released')
      const receipt = harness.sqlite.prepare(
        "SELECT step, ok, detail, actor_member_id FROM pot_provision_receipts WHERE slug = 'relslug'",
      ).get() as any
      expect(receipt.step).toBe('release')
      expect(receipt.ok).toBe(1)
      expect(JSON.parse(receipt.detail).ok).toBe(true)
      expect(receipt.actor_member_id).toBe('admin-mem-id')

      // Claimable by a genuinely different, brand-new provisioner now.
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const provisionEnv = {
        ...env,
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        DISPATCHER: fakeDispatcher({ tenant: 'relslug', releaseSha: null as any }) as any,
        SESSIONS: fakeSessionsKv(),
      } as unknown as Env
      const result = await provisionSovereignPot(provisionEnv, {
        slug: 'relslug', brand_name: 'New Owner Co', admin_email: 'newowner@relslug.test',
        minted_by_member_id: 'new-admin-mem-id', caller_tenant: 'mumega',
      }, '// bundle')
      expect(result.ok).toBe(true)
      const finalRow = harness.sqlite.prepare("SELECT status, provisioner_member_id FROM pots WHERE slug = 'relslug'").get() as any
      expect(finalRow.status).toBe('active')
      expect(finalRow.provisioner_member_id).toBe('new-admin-mem-id')
    })

    it('a race for the same just-released slug refuses the loser via the status=released WHERE guard', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'released', createdAt: new Date().toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc' } as unknown as Env

      // Simulate the winner already having claimed it.
      harness.sqlite.exec("UPDATE pots SET status = 'provisioning', provisioner_member_id = 'winner' WHERE slug = 'relslug'")

      await expect(provisionSovereignPot(env, {
        slug: 'relslug', brand_name: 'Loser Co', admin_email: 'loser@relslug.test', minted_by_member_id: 'loser', caller_tenant: 'mumega',
      })).rejects.toThrow(PotSlugTakenError)
    })

    it('P1-2: a LOST RACE (the row is reclaimed between this call\'s own SELECT and its UPDATE) refuses release_lost_race, writes NO receipt, and never touches the winner\'s row', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env

      // Intercept the FIRST SELECT (the pre-check read) and, immediately after it resolves
      // but BEFORE releaseStalePot's own UPDATE runs, simulate a concurrent winner
      // reclaiming the row — exactly the race the meta.changes check exists to catch.
      const realPrepare = harness.db.prepare.bind(harness.db)
      let selectSeen = false
      const racyDb = {
        ...harness.db,
        prepare(sql: string) {
          if (!selectSeen && sql.includes('SELECT status, created_at FROM pots')) {
            selectSeen = true
            const stmt = realPrepare(sql)
            return {
              bind: (...args: unknown[]) => {
                const bound = stmt.bind(...args)
                return {
                  first: async (...fa: unknown[]) => {
                    const result = await bound.first(...fa)
                    // The race, exactly as named in the finding: the original provisioner's
                    // OWN retry completes and flips the row to 'active' THIS INSTANT, after
                    // our read (which saw 'provisioning') but before our own UPDATE.
                    harness.sqlite.exec("UPDATE pots SET status = 'active' WHERE slug = 'relslug'")
                    return result
                  },
                }
              },
            }
          }
          return realPrepare(sql)
        },
      } as unknown as Env['DB']
      const racyEnv = { ...env, DB: racyDb } as unknown as Env

      const outcome = await toolPotRelease.run(orgAdminAuth, racyEnv, { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('release_lost_race')

      // The now-active row is untouched — never flipped to 'released' out from under the
      // provisioning run that just legitimately completed it.
      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('active')
      const receiptCount = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pot_provision_receipts WHERE slug = 'relslug'").get() as { c: number }
      expect(receiptCount.c).toBe(0)
    })

    it('P1-1: a receipt-write failure during release is FAIL CLOSED — the state flip is reverted, never ok:true with zero receipts', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env

      const realPrepare = harness.db.prepare.bind(harness.db)
      const sabotagedDb = {
        ...harness.db,
        prepare(sql: string) {
          if (sql.includes('INSERT INTO pot_provision_receipts')) {
            return { bind: () => ({ run: async () => { throw new Error('receipts table is locked') } }) }
          }
          return realPrepare(sql)
        },
      } as unknown as Env['DB']
      const sabotagedEnv = { ...env, DB: sabotagedDb } as unknown as Env

      const outcome = await toolPotRelease.run(orgAdminAuth, sabotagedEnv, { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('receipt_write_failed')

      // REVERTED — the status flip did not survive the failed receipt write. Round-2's own
      // version discarded the write's boolean here, so this exact scenario left the row
      // durably 'released' with ok:true and ZERO receipts.
      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('provisioning')
      const receiptCount = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pot_provision_receipts WHERE slug = 'relslug'").get() as { c: number }
      expect(receiptCount.c).toBe(0)
    })

    it('P1-3: pot_release refuses a caller whose tenant does not match this deployment (through invokeTool)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const foreignAuth: AuthContext = {
        memberId: 'foreign-admin', role: 'admin', tenant: 'foreign-tenant',
        capabilities: [{ scope_type: 'org', scope_id: 'foreign-tenant', capability: 'admin' }],
      }

      const outcome = await invokeTool(foreignAuth, env, 'pot_release', { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('tenant_mismatch')

      // Never released, never receipted under a foreign actor_tenant.
      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('provisioning')
      const receiptCount = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pot_provision_receipts WHERE slug = 'relslug'").get() as { c: number }
      expect(receiptCount.c).toBe(0)
    })

    it('P1-4: pot_release refuses a bound-agent session (through invokeTool)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      insertPot(harness, { status: 'provisioning', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const agentAuth: AuthContext = {
        memberId: 'agent-member', boundAgentId: 'agent-1', role: 'admin', tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
      }

      const outcome = await invokeTool(agentAuth, env, 'pot_release', { slug: 'relslug' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.error).toBe('operator_principal_required')

      const row = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'relslug'").get() as any
      expect(row.status).toBe('provisioning')
    })
  })

  describe('P3: provisionSovereignPot\'s final registry activation is guarded by ownership, not just the slug (mupot#1516 round-2)', () => {
    it('a slug reassigned to a DIFFERENT provisioner while this run\'s six steps were in flight is refused at activation, not marked active on this run\'s say-so', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any

      // Intercept the FINAL activation UPDATE and, right before it runs, simulate the slug
      // having been reassigned to a different provisioner in the meantime (e.g. released by
      // an admin and reclaimed by someone else while this run's six steps were in flight).
      const realPrepare = harness.db.prepare.bind(harness.db)
      const racyDb = {
        ...harness.db,
        prepare(sql: string) {
          if (sql.includes("UPDATE pots SET status = 'active'")) {
            harness.sqlite.exec(
              "UPDATE pots SET provisioner_member_id = 'reassigned-owner' WHERE slug = 'ownershiprace'",
            )
          }
          return realPrepare(sql)
        },
      } as unknown as Env['DB']

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: racyDb,
        SESSIONS: fakeSessionsKv(),
        DISPATCHER: fakeDispatcher({ tenant: 'ownershiprace', releaseSha: null as any }) as any,
      } as unknown as Env

      const result = await provisionSovereignPot(
        env, { slug: 'ownershiprace', brand_name: 'Ownership Race Co', admin_email: 'admin@ownershiprace.test', minted_by_member_id: 'original-owner', caller_tenant: 'mumega' }, '// bundle',
      )

      expect(result.ok).toBe(false)
      expect(result.incomplete_reason).toContain('registry activation refused')
      const row = harness.sqlite.prepare("SELECT status, provisioner_member_id FROM pots WHERE slug = 'ownershiprace'").get() as any
      // Reassigned owner, status never flipped to active by the original run.
      expect(row.provisioner_member_id).toBe('reassigned-owner')
      expect(row.status).toBe('provisioning')
    })
  })

  describe('ENABLEMENT GATE: bundle source is resolved BEFORE any Cloudflare call (mupot#1516 round-2)', () => {
    it('no POT_WORKER_BUNDLE_BUCKET and no workerJsCode refuses no_bundle_source with ZERO Cloudflare calls — the #1285 orphan class this closes', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as any

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: harness.db,
      } as unknown as Env

      const result = await provisionSovereignPot(env, { slug: 'preflightfail', brand_name: 'Preflight Fail Co', admin_email: 'admin@preflightfail.test' })

      expect(result.ok).toBe(false)
      expect(result.not_completed).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.completed).toEqual([])
      // The defining proof: no D1, no KV, nothing — zero Cloudflare calls of any kind.
      expect(fetchSpy).not.toHaveBeenCalled()

      const receipt = harness.sqlite.prepare(
        "SELECT step, ok, detail FROM pot_provision_receipts WHERE slug = 'preflightfail'",
      ).get() as { step: string; ok: number; detail: string }
      expect(receipt.step).toBe('deploy_worker')
      expect(receipt.ok).toBe(0)
      expect(JSON.parse(receipt.detail).error.class).toBe('no_bundle_source')

      // The registry row was still claimed (the preflight runs AFTER the registry gate,
      // never before it) — but never got past 'provisioning'.
      const potRow = harness.sqlite.prepare("SELECT status FROM pots WHERE slug = 'preflightfail'").get() as any
      expect(potRow.status).toBe('provisioning')
    })

    it('a configured bundle source still lets the run proceed normally (positive control)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: harness.db,
        DISPATCHER: fakeDispatcher({ tenant: 'preflightok', releaseSha: null as any }) as any,
      } as unknown as Env

      const result = await provisionSovereignPot(env, { slug: 'preflightok', brand_name: 'Preflight OK Co', admin_email: 'admin@preflightok.test' }, '// bundle')
      expect(result.ok).toBe(true)
    })
  })

  describe('receipt detail is JSON on every step × outcome, and a failed write is a failed step (mupot#1507-v2 P0-B, Athena binding addition 1)', () => {
    const ALL_STEPS: ProvisionStep[] = [
      'create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable', 'release',
    ]

    for (const step of ALL_STEPS) {
      for (const ok of [true, false]) {
        it(`step=${step} ok=${ok}: the built detail is accepted by the REAL 0169 CHECK constraint`, async () => {
          const harness = createSqliteD1()
          applyAllMigrations(harness.sqlite)
          const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env

          // A message that is neither trivially empty JSON nor accidentally safe: it
          // contains an '@' that is NOT an email (a Workers AI binding name) AND a real
          // email address, exercising both halves of `redactAndBound` at once.
          const detail = ok
            ? receiptOk({ note: 'fine @cf/meta/llama-3.3 mention' })
            : receiptError('test_error', 'boom @cf/meta/llama-3.3 failed, contact admin@example.com for help')

          const written = await writeProvisionReceipt(env, 'run-1', 'detailtest', step, ok, detail, 'mem-1', 'mumega')
          expect(written, `step=${step} ok=${ok}`).toBe(true)

          const row = harness.sqlite.prepare(
            'SELECT ok, detail FROM pot_provision_receipts WHERE slug = ? AND step = ?',
          ).get('detailtest', step) as { ok: number; detail: string }
          expect(row).toBeTruthy()
          expect(row.ok).toBe(ok ? 1 : 0)
          expect(() => JSON.parse(row.detail)).not.toThrow()
          if (!ok) {
            // The real email is gone from what actually landed in the ledger; the
            // non-email '@' mention survives untouched.
            expect(row.detail).not.toContain('admin@example.com')
            expect(row.detail).toContain('@cf/meta/llama-3.3')
            expect(row.detail).toContain('[redacted-email]')
          }
        })
      }
    }

    it('MUTATION-EQUIVALENT: a non-JSON detail is REJECTED by the real CHECK (proves the constraint still guards structure)', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
      const written = await writeProvisionReceipt(env, 'run-1', 'rawtest', 'apply_schema', false, 'plain prose, not JSON', null, null)
      expect(written).toBe(false)
      const row = harness.sqlite.prepare(
        "SELECT COUNT(*) as c FROM pot_provision_receipts WHERE slug = 'rawtest'",
      ).get() as { c: number }
      expect(row.c).toBe(0)
    })

    it("P2-4: a Workers AI binding name like '@cf/meta/llama-3.3' survives redaction untouched — it is NOT email-shaped", () => {
      const detail = receiptError('sql_error', "schema statement referenced binding=@cf/meta/llama-3.3 which does not exist")
      expect(detail).toContain('@cf/meta/llama-3.3')
      expect(detail).not.toContain('[redacted-email]')
    })

    it('P2-4 positive control: a real email address in the SAME message IS redacted', () => {
      const detail = receiptError('sql_error', 'boom @cf/meta/llama-3.3 failed, contact admin@example.com for help')
      expect(detail).toContain('@cf/meta/llama-3.3') // non-email survives
      expect(detail).not.toContain('admin@example.com') // real email redacted
      expect(detail).toContain('[redacted-email]')
    })

    it('P2-3: redaction covers extraFields/fields too, not just the top-level message', () => {
      const errorDetail = receiptError('sql_error', 'boom', { hint: 'contact admin@example.com', file: 'x.sql' })
      const parsedError = JSON.parse(errorDetail)
      expect(parsedError.hint).toBe('contact [redacted-email]')
      expect(parsedError.file).toBe('x.sql') // untouched, no email in it

      const okDetail = receiptOk({ note: 'operator is admin@example.com', count: 3 })
      const parsedOk = JSON.parse(okDetail)
      expect(parsedOk.note).toBe('operator is [redacted-email]')
      expect(parsedOk.count).toBe(3) // non-string values pass through unchanged
    })

    describe('mupot#1520 P1-A/P2-B: unicode-aware redaction, key redaction, Date serialization, and a whole-document bound', () => {
      it('P1-A: a unicode email survives to the receipt with the OLD (\\w-only) regex and is redacted with the fix — in the message, a nested field, AND a key', () => {
        const unicodeEmail = 'hédi.sérvat@exämple.com'
        // Sanity check pinning the defect this fix closes: `\w` is ASCII-only, so the OLD
        // regex never matches a unicode local-part/domain at all.
        expect(unicodeEmail.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')).toBe(unicodeEmail)

        const detail = receiptError('sql_error', `contact ${unicodeEmail} for help`, {
          nested: { hint: `owner is ${unicodeEmail}` },
          [unicodeEmail]: 'value-under-an-email-shaped-key',
        })
        const parsed = JSON.parse(detail)
        expect(parsed.error.message).toBe('contact [redacted-email] for help')
        expect(parsed.nested.hint).toBe('owner is [redacted-email]')
        expect(parsed).not.toHaveProperty(unicodeEmail)
        expect(Object.keys(parsed)).toContain('[redacted-email]')
        expect(parsed['[redacted-email]']).toBe('value-under-an-email-shaped-key')
      })

      it('P1-A: a soft-hyphen-obfuscated domain (renders identically to a plain domain, invisible character mid-word) is still redacted', () => {
        const SOFT_HYPHEN = '­'
        const obfuscated = `hedi@exa${SOFT_HYPHEN}mple.com` // renders as "hedi@example.com"
        const detail = receiptError('sql_error', `contact ${obfuscated} for help`)
        const parsed = JSON.parse(detail)
        expect(parsed.error.message).toBe('contact [redacted-email] for help')
        expect(parsed.error.message).not.toContain(SOFT_HYPHEN)
      })

      it('P1-A regression guard: `binding=@cf/meta/llama-3.3` and `model:@cf/meta/llama-3.3` both still survive the unicode-aware regex untouched', () => {
        const detail = receiptError(
          'sql_error',
          'schema statement referenced binding=@cf/meta/llama-3.3 and model:@cf/meta/llama-3.3, neither is an email',
        )
        const parsed = JSON.parse(detail)
        expect(parsed.error.message).toContain('binding=@cf/meta/llama-3.3')
        expect(parsed.error.message).toContain('model:@cf/meta/llama-3.3')
        expect(parsed.error.message).not.toContain('[redacted-email]')
      })

      it('P2-B: a Date value serializes to its ISO string instead of collapsing to {}', () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        const detail = receiptOk({ at })
        const parsed = JSON.parse(detail)
        expect(parsed.at).toBe('2026-01-01T00:00:00.000Z')
      })

      it('P2-B / mupot#1523 item 4: a 200-field SUCCESS detail (each field ~499 chars, individually under the per-leaf 500-char cap) is bounded as a WHOLE document, and the fallback preserves ok:true (a successful step is not misreported as failed)', () => {
        const fields: Record<string, string> = {}
        for (let i = 0; i < 200; i++) {
          fields[`field_${i}`] = 'x'.repeat(499)
        }
        const naiveSerializedLength = JSON.stringify({ ok: true, ...fields }).length
        expect(naiveSerializedLength).toBeGreaterThan(64 * 1024) // proves the scenario actually stresses the bound

        const detail = receiptOk(fields)
        expect(detail.length).toBeLessThanOrEqual(64 * 1024)
        expect(() => JSON.parse(detail)).not.toThrow() // the CHECK constraint's json_valid(detail) must still pass
        const parsed = JSON.parse(detail)
        expect(parsed.ok).toBe(true) // NOT hardcoded false — this step actually succeeded
        expect(parsed.truncated).toBe(true)
        expect(parsed.error).toBeUndefined() // ok:true shape never carries an `error` object
      })

      it('mupot#1523 item 4: a 200-field FAILURE detail bounds the same way and keeps ok:false + a named error class', () => {
        const extraFields: Record<string, string> = {}
        for (let i = 0; i < 200; i++) {
          extraFields[`field_${i}`] = 'x'.repeat(499)
        }
        const detail = receiptError('sql_error', 'boom', extraFields)
        expect(detail.length).toBeLessThanOrEqual(64 * 1024)
        const parsed = JSON.parse(detail)
        expect(parsed.ok).toBe(false)
        expect(parsed.truncated).toBe(true)
        expect(parsed.error.class).toBe('detail_too_large')
      })

      it("mupot#1523 item 2: errorClass itself is redacted and bounded the same way as message — an email-shaped errorClass doesn't reach the ledger", () => {
        const detail = receiptError('contact-admin@example.com', 'boom')
        const parsed = JSON.parse(detail)
        expect(parsed.error.class).toBe('[redacted-email]')
        expect(parsed.error.class).not.toContain('admin@example.com')
      })

      it('mupot#1523 item 1: an NFD-decomposed unicode email (combining marks, not precomposed letters) is still redacted', () => {
        // 'é' as NFD is 'e' + COMBINING ACUTE ACCENT (U+0301); as NFC it is the single
        // precomposed codepoint U+00E9. Confirm the fixture is actually decomposed before
        // relying on it to exercise the NFKC-normalization fix.
        const nfdEmail = 'hédi.sérvat@exämple.com' // é / é via combining marks
        expect(nfdEmail.normalize('NFC')).toBe('hédi.sérvat@exämple.com')
        expect(nfdEmail).not.toBe(nfdEmail.normalize('NFC')) // sanity: the fixture really is decomposed

        const detail = receiptError('sql_error', `contact ${nfdEmail} for help`)
        const parsed = JSON.parse(detail)
        expect(parsed.error.message).toBe('contact [redacted-email] for help')
      })

      it('mupot#1523 item 1: a braille-blank (U+2800) obfuscated domain is still redacted, and binding=/model: still survive', () => {
        const BRAILLE_BLANK = '⠀'
        const obfuscated = `hedi@exa${BRAILLE_BLANK}mple.com`
        const detail = receiptError(
          'sql_error',
          `contact ${obfuscated} for help — binding=@cf/meta/llama-3.3 and model:@cf/meta/llama-3.3 are not emails`,
        )
        const parsed = JSON.parse(detail)
        expect(parsed.error.message).toContain('contact [redacted-email] for help')
        expect(parsed.error.message).toContain('binding=@cf/meta/llama-3.3')
        expect(parsed.error.message).toContain('model:@cf/meta/llama-3.3')
        // exactly one redaction happened — the binding/model mentions were not touched
        expect((parsed.error.message.match(/\[redacted-email\]/g) ?? []).length).toBe(1)
      })

      it('mupot#1523 re-run P1: a NON-composable combining mark (CGJ U+034F, variation selector U+FE0F, Thai U+0E31) inside an email is still redacted after NFKC', () => {
        for (const mark of ['\u034F', '\uFE0F', '\u0E31', '\u20E0']) {
          const obfuscated = `victim@exa${mark}mple.com`
          expect(obfuscated.normalize('NFKC')).toBe(obfuscated) // sanity: NFKC does NOT fold this one away
          const detail = receiptError('sql_error', `near "${obfuscated}": syntax error`)
          const parsed = JSON.parse(detail)
          expect(parsed.error.message).toBe('near "[redacted-email]": syntax error')
        }
      })

      it('mupot#1523 item 3: two keys that redact to the SAME string are both preserved, suffixed, never silently dropped', () => {
        const detail = receiptOk({ 'victim1@example.com': 'a', 'victim2@example.com': 'b', 'victim3@example.com': 'c' })
        const parsed = JSON.parse(detail)
        expect(parsed['[redacted-email]']).toBe('a')
        expect(parsed['[redacted-email]#2']).toBe('b')
        expect(parsed['[redacted-email]#3']).toBe('c')
        expect(Object.keys(parsed).filter((k) => k.startsWith('[redacted-email]'))).toHaveLength(3)
      })

      describe('mupot#1523 item 5: receiptOk/receiptError are TOTAL — never throw', () => {
        it('an Invalid Date serializes as the string "invalid-date"', () => {
          const detail = receiptOk({ at: new Date('this is not a valid date') })
          const parsed = JSON.parse(detail)
          expect(parsed.at).toBe('invalid-date')
        })

        it('a BigInt serializes as a string (JSON.stringify cannot serialize a raw BigInt)', () => {
          const detail = receiptOk({ count: 9007199254740993n })
          const parsed = JSON.parse(detail)
          expect(parsed.count).toBe('9007199254740993')
        })

        it('a circular reference is replaced with "[circular]" instead of throwing/looping forever', () => {
          const cyclic: Record<string, unknown> = { name: 'cyclic' }
          cyclic.self = cyclic
          expect(() => receiptOk({ nested: cyclic })).not.toThrow()
          const parsed = JSON.parse(receiptOk({ nested: cyclic }))
          expect(parsed.nested.name).toBe('cyclic')
          expect(parsed.nested.self).toBe('[circular]')
        })

        it('a throwing getter is replaced with "[unreadable]" instead of propagating the throw', () => {
          const landmine: Record<string, unknown> = {}
          Object.defineProperty(landmine, 'boom', { enumerable: true, get() { throw new Error('nope') } })
          expect(() => receiptOk({ landmine })).not.toThrow()
          const parsed = JSON.parse(receiptOk({ landmine }))
          expect(parsed.landmine.boom).toBe('[unreadable]')
        })

        it('a non-circular DAG (same object reachable via two different fields) is NOT misreported as circular', () => {
          const shared = { note: 'shared@example.com' }
          const detail = receiptOk({ a: shared, b: shared })
          const parsed = JSON.parse(detail)
          expect(parsed.a.note).toBe('[redacted-email]')
          expect(parsed.b.note).toBe('[redacted-email]')
        })
      })
    })

    it('FAIL CLOSED: a receipt write failure is treated as a FAILED STEP even when the underlying operation succeeded', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any

      // Sabotage ONLY the receipts INSERT — every other DB call on this same `harness.db`
      // (the registry gate's SELECT/INSERT into `pots`) must keep working normally.
      const realPrepare = harness.db.prepare.bind(harness.db)
      const sabotagedDb = {
        ...harness.db,
        prepare(sql: string) {
          if (sql.includes('INSERT INTO pot_provision_receipts')) {
            return { bind: () => ({ run: async () => { throw new Error('receipts table is locked') } }) }
          }
          return realPrepare(sql)
        },
      } as unknown as Env['DB']

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: sabotagedDb,
        DISPATCHER: fakeDispatcher({ tenant: 'receiptfail', releaseSha: null as any }) as any,
      } as unknown as Env

      const result = await provisionSovereignPot(env, { slug: 'receiptfail', brand_name: 'Receipt Fail Co', admin_email: 'admin@receiptfail.test' }, '// bundle')

      // create_d1 itself SUCCEEDED (the CF call landed, a real database uuid came back) —
      // only its receipt write failed. Round-2's swallowed write failure would have let
      // this step (and the whole run) proceed toward `ok:true`. It must not: a step whose
      // receipt cannot be written is itself a failed step.
      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      expect(result.incomplete_reason).toContain('receipt failed to write')
    })
  })

  describe('validateProvisionRequestBody (round-2 P0-3)', () => {
    it('accepts exactly the allowed fields', () => {
      const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b.com' })
      expect(result.ok).toBe(true)
    })

    describe('P2-5: caller-suppliable string bounds', () => {
      it('accepts brand_name/admin_name at exactly 200 chars and admin_email at exactly 254', () => {
        const email254 = `${'a'.repeat(254 - '@b.com'.length)}@b.com`
        expect(email254).toHaveLength(254)
        const result = validateProvisionRequestBody({
          slug: 'gaf', brand_name: 'B'.repeat(200), admin_name: 'N'.repeat(200), admin_email: email254,
        })
        expect(result.ok).toBe(true)
      })

      it('refuses brand_name over 200 chars with a named field_too_long error', () => {
        const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'B'.repeat(201), admin_email: 'a@b.com' })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected failure')
        expect(result.error).toBe('field_too_long')
        expect(result.message).toContain('brand_name')
      })

      it('refuses admin_name over 200 chars', () => {
        const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b.com', admin_name: 'N'.repeat(201) })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected failure')
        expect(result.error).toBe('field_too_long')
        expect(result.message).toContain('admin_name')
      })

      it('refuses admin_email over 254 chars', () => {
        const longEmail = `${'a'.repeat(250)}@b.com` // well over 254 total
        const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: longEmail })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected failure')
        expect(result.error).toBe('field_too_long')
        expect(result.message).toContain('admin_email')
      })

      describe('mupot#1520 P1-A: admin_email shape validation', () => {
        it("refuses 'notanemail' with a named invalid_email error", () => {
          const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'notanemail' })
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('expected failure')
          expect(result.error).toBe('invalid_email')
          expect(result.message).toContain('admin_email')
        })

        it('refuses an email with no domain dot, and one with two @ signs', () => {
          for (const bad of ['admin@localhost', 'a@b@c.com', 'admin@.com', '@b.com', 'admin@']) {
            const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: bad })
            expect(result.ok, bad).toBe(false)
            if (result.ok) throw new Error('expected failure')
            expect(result.error, bad).toBe('invalid_email')
          }
        })

        it('accepts a plausible unicode email', () => {
          const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'hédi.sérvat@exämple.com' })
          expect(result.ok).toBe(true)
        })

        it("mupot#1523 item 6: refuses an internal empty domain segment ('a@b..c') — the round-1 check only looked at the FIRST/LAST segment", () => {
          const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'a@b..c' })
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('expected failure')
          expect(result.error).toBe('invalid_email')
        })

        it("mupot#1523 item 6: refuses whitespace INSIDE admin_email (leading/trailing whitespace is already trimmed upstream by validateProvisionRequestBody's own str(), so these are all internal)", () => {
          for (const bad of ['admin @example.com', 'admin@exa mple.com', 'admin@ex\tample.com', 'admin@example\t.com']) {
            const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: bad })
            expect(result.ok, JSON.stringify(bad)).toBe(false)
            if (result.ok) throw new Error('expected failure')
            expect(result.error, JSON.stringify(bad)).toBe('invalid_email')
          }
        })

        it('mupot#1523 re-run P1: refuses format characters and non-composable combining marks inside admin_email, still accepts NFD accents', () => {
          for (const mark of ['\u00AD', '\u200B', '\u034F', '\uFE0F', '\u0E31']) {
            const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: `admin@exa${mark}mple.com` })
            expect(result.ok).toBe(false)
            if (result.ok) throw new Error('expected failure')
            expect(result.error).toBe('invalid_email')
          }
          const nfd = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: 'admin@exa\u0308mple.com' })
          expect(nfd.ok).toBe(true)
        })

        it('mupot#1523 item 6: refuses a Unicode CONTROL character (category Cc, e.g. NUL) inside admin_email even though it is not `\\s`', () => {
          const bad = 'admin@ex' + String.fromCharCode(0) + 'ample.com'
          const result = validateProvisionRequestBody({ slug: 'gaf', brand_name: 'GAF', admin_email: bad })
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('expected failure')
          expect(result.error).toBe('invalid_email')
        })
      })

      it('the HTTP route surfaces field_too_long as 400, not a 500 from downstream string interpolation', async () => {
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        const owner = JSON.stringify({ userId: 'u-owner', email: 'owner@local.test', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' })
        const env = {
          TENANT_SLUG: 'local', DB: harness.db,
          SESSIONS: { get: async (k: string) => (k === 'sess:owner-s' ? owner : null), put: async () => undefined, delete: async () => undefined },
          SECRET_ENV_CF_API_TOKEN: 'cf-tok',
        } as unknown as Env
        await env.DB.prepare(
          `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('mem-owner', 'local', 'owner@local.test', 'Owner', 'active', datetime('now'))`,
        ).run()
        const res = await potsApp.request('/provision', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: 'mupot_session=owner-s' },
          body: JSON.stringify({ slug: 'toolongbrand', brand_name: 'X'.repeat(300), admin_email: 'a@b.com' }),
        }, env)
        expect(res.status).toBe(400)
        const json = await res.json() as { error: string }
        expect(json.error).toBe('field_too_long')
      })

      it("P2-5/P2-1: a MAXIMAL-length seed (200-char brand_name/admin_name, 254-char admin_email) stays comfortably under the D1 double's 100KB per-statement cap — the bounds don't fight each other", async () => {
        const email254 = `${'a'.repeat(254 - '@maximal-length-test-domain.example.com'.length)}@maximal-length-test-domain.example.com`
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        global.fetch = vi.fn(async (url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string)
          return { status: 200, json: async () => execD1RestQuery(harness, body.sql, body.params ?? []) }
        }) as any

        const result = await seedPotIdentities(
          { accountId: 'acc-123', apiToken: 'cf-tok-abc' },
          'child-db',
          { slug: 'maximal', brandName: 'B'.repeat(200), adminEmail: email254, adminName: 'N'.repeat(200) },
        )
        // If any inlined statement in the batch had exceeded the double's 100KB cap, this
        // would come back ok:false with a D1_STATEMENT_TOO_LARGE_ERROR-shaped detail —
        // ok:true here IS the proof the two bounds coexist correctly.
        expect(result.ok).toBe(true)
      })
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

    it("mupot#1520 P1-A: rejects admin_email='notanemail' with 400 invalid_email, never reaching provisionSovereignPot", async () => {
      const { env } = await ownerEnv()
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy
      const res = await potsApp.request('/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: OWNER_COOKIE },
        body: JSON.stringify({ slug: 'bademail', brand_name: 'Bad Email Co', admin_email: 'notanemail' }),
      }, env)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toBe('invalid_email')
      expect(fetchSpy).not.toHaveBeenCalled()
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

    it("mupot#1520 P1-A: rejects admin_email='notanemail' with 400 invalid_email through the MCP tool too — same validator, same shape", async () => {
      const auth: AuthContext = { memberId: 'm1', role: 'admin', tenant: 'mumega', capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }] }
      const outcome = await toolPotProvision.run(auth, { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'x' } as unknown as Env, { slug: 'x', brand_name: 'X', admin_email: 'notanemail' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected failure')
      expect(outcome.status).toBe(400)
      expect(outcome.error).toBe('invalid_email')
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

    it("M-LOWER: a mixed-case slug normalizes to the SAME registry row a lowercase retry sees — a different actor cannot squat the differently-cased name", async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'mixedcase', releaseSha: null as any }) as any })

      const first = await provisionSovereignPot(
        env, { slug: 'MixedCase', brand_name: 'Mixed Case Co', admin_email: 'admin@mixedcase.test', minted_by_member_id: 'owner-1', caller_tenant: 'mumega' }, '// bundle',
      )
      expect(first.ok).toBe(true)
      expect(first.slug).toBe('mixedcase') // normalized

      // Exactly ONE row — the mixed-case input landed on the same normalized slug.
      const rowCount = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pots WHERE slug = 'mixedcase'").get() as { c: number }
      expect(rowCount.c).toBe(1)

      // A DIFFERENT actor supplying the already-lowercase form is refused — it is the SAME
      // slug, not a fresh one a case mismatch would let them squat.
      await expect(provisionSovereignPot(
        env, { slug: 'mixedcase', brand_name: 'Squatter Co', admin_email: 'squatter@evil.test', minted_by_member_id: 'attacker', caller_tenant: 'mumega' },
      )).rejects.toThrow(PotSlugTakenError)
    })

    it('M-BODYHASH: the verify_reachable RECEIPT (not just the return value) never contains the raw /health body', async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'bodyhash', releaseSha: null as any }) as any })

      const result = await provisionSovereignPot(env, { slug: 'bodyhash', brand_name: 'Body Hash Co', admin_email: 'admin@bodyhash.test' }, '// bundle')
      expect(result.ok).toBe(true)

      const rows = receiptRows(harness.sqlite, 'bodyhash')
      const verifyRow = rows.find((r) => r.step === 'verify_reachable')!
      expect(verifyRow.detail).not.toContain('"service"')
      expect(verifyRow.detail).not.toContain('"clean"')
      const parsed = JSON.parse(verifyRow.detail!)
      expect(parsed.body_sha256).toMatch(/^[0-9a-f]{64}$/)
    })

    it("M-REGACTIVATE: a registry-activation write failure after all six steps still succeeded is ok:false, not a silent ok:true", async () => {
      const harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any

      const realPrepare = harness.db.prepare.bind(harness.db)
      const sabotagedDb = {
        ...harness.db,
        prepare(sql: string) {
          if (sql.includes("UPDATE pots SET status = 'active'")) {
            return { bind: () => ({ run: async () => { throw new Error('pots table is locked') } }) }
          }
          return realPrepare(sql)
        },
      } as unknown as Env['DB']

      const env = makeEnv({
        harnessDb: sabotagedDb,
        DISPATCHER: fakeDispatcher({ tenant: 'regactivate', releaseSha: null as any }) as any,
      })

      const result = await provisionSovereignPot(env, { slug: 'regactivate', brand_name: 'Reg Activate Co', admin_email: 'admin@regactivate.test' }, '// bundle')

      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      // All six steps DID complete — this is the one documented edge where not_completed
      // reads [] under status:'incomplete' (see the code comment on this exact branch).
      expect(result.completed).toEqual(['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable'])
      expect(result.not_completed).toEqual([])
      expect(result.incomplete_reason).toContain('registry activation failed')
    })

    describe('P1-C: a GENUINE concurrent race for a brand-new slug (no pre-inserted winner)', () => {
      it('two truly concurrent calls for the SAME brand-new slug: exactly one wins, the loser is refused BEFORE any CF call it would otherwise make, and only ONE D1 is created', async () => {
        const harness = createSqliteD1()
        applyAllMigrations(harness.sqlite)
        const { fetchMock, calls } = createRealisticFakeCf({})
        global.fetch = fetchMock as any
        const env = makeEnv({ harnessDb: harness.db, DISPATCHER: fakeDispatcher({ tenant: 'racer2', releaseSha: null as any }) as any })

        // NEITHER call pre-inserts anything — both start from a genuinely empty `pots`
        // table for this slug and race through the SAME registry gate. Node's single
        // event loop interleaves the two async call chains at their own await points
        // (the SELECT, then checkSlugAvailability's own await, THEN the INSERT) — this
        // is what actually reaches the INSERT's try/catch under real contention, unlike
        // a test that pre-seeds the "winner" row and only ever exercises the
        // already-existing-row branch.
        const [a, b] = await Promise.allSettled([
          provisionSovereignPot(env, { slug: 'racer2', brand_name: 'Racer A', admin_email: 'a@racer2.test', minted_by_member_id: 'caller-a', caller_tenant: 'mumega' }, '// bundle'),
          provisionSovereignPot(env, { slug: 'racer2', brand_name: 'Racer B', admin_email: 'b@racer2.test', minted_by_member_id: 'caller-b', caller_tenant: 'mumega' }, '// bundle'),
        ])

        const outcomes = [a, b]
        const fulfilledOk = outcomes.filter((r) => r.status === 'fulfilled' && (r.value as any).ok === true)
        const rejectedAsTaken = outcomes.filter((r) => r.status === 'rejected' && (r.reason instanceof PotSlugTakenError))

        // Exactly one winner, exactly one loser — never both succeeding, never both
        // failing, and the loser fails with the NAMED refusal, not a generic error.
        expect(fulfilledOk.length, JSON.stringify(outcomes.map((o) => o.status))).toBe(1)
        expect(rejectedAsTaken.length).toBe(1)

        // The defining proof: only ONE D1 database was ever created for this slug — the
        // loser never reached create_d1 at all. A "swallow the INSERT failure and
        // continue" mutation would let BOTH callers through to create_d1, and this count
        // would be 2.
        const d1CreateCalls = calls.filter((c) => c.method === 'POST' && /\/d1\/database$/.test(c.url))
        expect(d1CreateCalls).toHaveLength(1)

        const rowCount = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pots WHERE slug = 'racer2'").get() as { c: number }
        expect(rowCount.c).toBe(1)
      })
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
