import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sanitizeSlug,
  validateSlug,
  createD1Database,
  createKVNamespace,
  uploadUserWorkerToDispatch,
  listSovereignPots,
  provisionSovereignPot,
  DISPATCH_NAMESPACE,
} from '../src/pots/service'
import { toolPotProvision, toolPotList } from '../src/mcp/pots'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

const orgAdmin: AuthContext = {
  memberId: 'admin-mem-id',
  role: 'admin',
  tenant: 'mumega',
  capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'admin' }],
}

describe('Sovereign Pot Provisioner (Flight 2)', () => {
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

    it('uploads User Worker script with explicit isolated bindings to dispatch namespace', async () => {
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
        publicOrigin: 'https://gaf.mupot.mumega.com',
      })

      expect(res.id).toBe('gaf')
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/acc-123/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/gaf`,
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ Authorization: 'Bearer cf-tok-abc' }),
        }),
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
      expect(pots[0].public_url).toBe('https://gaf.mupot.mumega.com')
      expect(pots[1].slug).toBe('viamar')
    })
  })

  describe('end-to-end sovereign pot orchestration', () => {
    // THE TEST THAT WAS MISSING. Every production caller — src/mcp/pots.ts:66,
    // src/pots/routes.ts:42, src/pots/checkout.ts:143 — invokes provisionSovereignPot with
    // TWO arguments. The suite only ever exercised the three-argument form, so it proved a
    // signature production never uses while the real path returned ok:true for an empty
    // database. A test covering a call shape nobody makes is worse than no test: it reports
    // coverage of the thing it is not covering.
    it('the two-argument form production actually calls reports incomplete and names the orphans', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/d1/database')) {
          return { status: 200, json: async () => ({ success: true, result: { uuid: 'd1-x', name: 'mupot-pot-x' } }) }
        }
        if (url.includes('/storage/kv/namespaces')) {
          return { status: 200, json: async () => ({ success: true, result: { id: 'kv-x', title: 'mupot-pot-x-kv' } }) }
        }
        return { status: 404, json: async () => ({ success: false }) }
      })

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
      } as unknown as Env

      const result = await provisionSovereignPot(env, {
        slug: 'neuraya', brand_name: 'Neuraya', admin_email: 'a@b.test',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      expect(result.not_completed).toContain('deploy_worker')

      // The resources are real and billable. If the caller is not told, nobody reclaims
      // them and they surface on an invoice instead of in a log.
      expect(result.orphaned_resources).not.toBeNull()
      expect(result.orphaned_resources?.d1_database_id).toBe('d1-x')
      expect(result.orphaned_resources?.kv_namespace_id).toBe('kv-x')
      expect(result.incomplete_reason).toBeTruthy()

      // PATH, not subdomain: `<slug>.mupot.mumega.com` cannot serve TLS at all —
      // Universal SSL does not cover a second-level wildcard.
      expect(result.public_origin).toBe('https://mupot.mumega.com/t/neuraya')
      expect(result.public_origin).not.toContain('neuraya.mupot')
    })

    it('provisions a full sovereign pot returning admin tokens and login URL', async () => {
      let callCount = 0
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        callCount++
        if (url.includes('/d1/database')) {
          return {
            status: 200,
            json: async () => ({ success: true, result: { uuid: 'd1-gaf-uuid', name: 'mupot-pot-gaf' } }),
          }
        }
        if (url.includes('/storage/kv/namespaces')) {
          return {
            status: 200,
            json: async () => ({ success: true, result: { id: 'kv-gaf-id', title: 'mupot-pot-gaf-kv' } }),
          }
        }
        if (url.includes('/workers/dispatch/namespaces')) {
          return {
            status: 200,
            json: async () => ({ success: true, result: { id: 'gaf' } }),
          }
        }
        return { status: 404, json: async () => ({ success: false }) }
      })

      const env = {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
      } as unknown as Env

      const result = await provisionSovereignPot(
        env,
        {
          slug: 'gaf',
          brand_name: 'GAF Materials',
          admin_email: 'admin@gaf.com',
          plan_tier: 'enterprise',
        },
        '// user worker bundle',
      )

      // WAS: expect(result.ok).toBe(true) plus admin_token/login_url assertions.
      // Those certified a defect (mupot#1285). Creating a D1 and a KV is not a pot: the
      // schema is never applied, no identities are seeded, and nothing is verified
      // reachable. `ok` now means "usable", so it is false here — correctly.
      expect(result.ok).toBe(false)
      expect(result.status).toBe('incomplete')
      expect(result.slug).toBe('gaf')
      expect(result.d1_database_id).toBe('d1-gaf-uuid')
      expect(result.kv_namespace_id).toBe('kv-gaf-id')
      // This call DOES pass workerJsCode, so the deploy step ran...
      expect(result.completed).toContain('deploy_worker')
      // ...but the steps that make a pot usable did not, and it says which.
      expect(result.not_completed).toEqual(
        expect.arrayContaining(['apply_schema', 'seed_identities', 'verify_reachable']),
      )
      // Credentials generated in memory and never written to the pot's database
      // authenticate nothing, so they are not handed back as if they worked.
      expect(result.admin_token).toBeNull()
      expect(result.admin_login_url).toBeNull()
      // WAS: expect(admin_login_url).toBe(`https://gaf.mupot.mumega.com/?token=...`).
      // That assertion pinned an address that cannot serve — Universal SSL does not cover
      // `*.mupot.mumega.com`, so the URL fails the TLS handshake before HTTP starts. A test
      // asserting an unreachable URL is how it survived: it checked the string, never the
      // reachability.
      expect(result.public_origin).toBe('https://mupot.mumega.com/t/gaf')
      expect(result.lead_agent_id).toBeTruthy()
      // Not persisted, so not handed back as usable.
      expect(result.lead_agent_token).toBeNull()
    })
  })

  describe('MCP tools', () => {
    it('executes pot_provision tool when caller holds org admin capability', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/d1/database')) {
          return {
            status: 200,
            json: async () => ({ success: true, result: { uuid: 'd1-111', name: 'mupot-pot-viamar' } }),
          }
        }
        if (url.includes('/storage/kv/namespaces')) {
          return {
            status: 200,
            json: async () => ({ success: true, result: { id: 'kv-222', title: 'mupot-pot-viamar-kv' } }),
          }
        }
        return { status: 404, json: async () => ({ success: false }) }
      })

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
      } as unknown as Env

      const outcome = await toolPotProvision.run(auth, env, {
        slug: 'viamar',
        brand_name: 'Viamar Logistics',
        admin_email: 'hadi@viamar.com',
        plan_tier: 'enterprise',
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error(outcome.error)
      const data = outcome.result as { pot: { slug: string; d1_database_id: string } }
      expect(data.pot.slug).toBe('viamar')
      expect(data.pot.d1_database_id).toBe('d1-111')
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
