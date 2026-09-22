// tests/pot-checkout-provisioning.test.ts — Unit tests for Self-Serve Pot Checkout & Provisioning (Flight 12).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkSlugAvailability,
  createPotCheckoutSession,
  handlePotCreationCompleted,
} from '../src/pots/checkout'
import { pricingPageHtml } from '../src/dashboard/pricing'
import { publicPotsApp } from '../src/pots/routes'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { createRealisticFakeCf, fakeDispatcher } from './helpers/fake-cf-provisioner'

describe('Public Pricing & Self-Serve Sovereign Pot Provisioning Portal (Flight 12)', () => {
  let harness: ReturnType<typeof createSqliteD1>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  it('validates subdomain slug availability and reserved word protection', async () => {
    const env = { DB: harness.db } as unknown as Env

    // Valid slug
    const resValid = await checkSlugAvailability(env, 'acme-corp')
    expect(resValid.available).toBe(true)
    expect(resValid.slug).toBe('acme-corp')

    // Reserved slug
    const resReserved = await checkSlugAvailability(env, 'admin')
    expect(resReserved.available).toBe(false)
    expect(resReserved.reason).toContain('reserved')

    // Invalid format
    const resInvalid = await checkSlugAvailability(env, '-bad_slug!')
    expect(resInvalid.available).toBe(false)
  })

  // mupot#1303. The old implementation swallowed a failed lookup and returned
  // `available: true`, with a comment calling that "fail-safe". These tests pin the
  // opposite, and every one of them PASSES under the old code except by design:
  // the seeded-pot and throwing-DB cases are the two that could not have passed.
  describe('availability fails closed (#1303)', () => {
    it('reports a slug with a live pot as TAKEN', async () => {
      // The row is seeded HERE, not by the migration. Migration 0145 creates the table
      // only: tests/helpers/migrations.ts caches the finished chain as DDL, which is sound
      // only while no migration seeds data, and its guard goes red if one ever does. `gaf`
      // is the real content of the mupot-pots dispatch namespace read from the Cloudflare
      // API on 2026-09-04; on production before this fix it reported available while
      // serving traffic.
      harness.sqlite.exec(`
        INSERT INTO pots (id, slug, worker_script, status, source)
        VALUES ('pot-gaf', 'gaf', 'gaf', 'active', 'namespace-audit');
      `)
      const env = { DB: harness.db } as unknown as Env
      const res = await checkSlugAvailability(env, 'gaf')
      expect(res.available).toBe(false)
      expect(res.reason).toContain('already taken')
    })

    it('reports a slug taken by a PROJECT worker as taken — same dispatch namespace', async () => {
      harness.sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S1');
        INSERT INTO projects (id, slug, name, description, goal, status, assigned_squad_id, worker_name)
        VALUES ('p1', 'someproject', 'P', '', '', 'active', 's1', 'claimed-worker');
      `)
      const env = { DB: harness.db } as unknown as Env
      expect((await checkSlugAvailability(env, 'claimed-worker')).available).toBe(false)
      expect((await checkSlugAvailability(env, 'someproject')).available).toBe(false)
    })

    it('an unanswerable check is NOT available', async () => {
      // The exact shape of the original defect: the lookup throws. Old code returned
      // available:true. "I could not determine whether this is taken" must never be
      // answered as "this is not taken".
      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: async () => { throw new Error('D1_ERROR: no such table: pots') },
            }),
          }),
        },
      } as unknown as Env
      const res = await checkSlugAvailability(env, 'anything-at-all')
      expect(res.available).toBe(false)
      expect(res.reason).toContain('could not be verified')
    })

    it('still accepts a genuinely free slug — the check is not simply refusing everything', async () => {
      // Paired positive control. Without it, `return { available: false }` unconditionally
      // would satisfy every assertion above.
      const env = { DB: harness.db } as unknown as Env
      const res = await checkSlugAvailability(env, 'genuinely-unused-slug')
      expect(res.available).toBe(true)
      expect(res.reason).toBeUndefined()
    })
  })

  it('creates Stripe checkout session with embedded pot metadata', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        id: 'cs_placeholder_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_placeholder_test_123',
      }),
    })

    const env = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key',
      DB: harness.db,
    } as unknown as Env

    const result = await createPotCheckoutSession(
      env,
      {
        slug: 'novacorp',
        brand: 'Nova Corporation',
        tier: 'pro',
        ownerEmail: 'ceo@novacorp.com',
        origin: 'https://mupot.mumega.com',
      },
      mockFetch as any,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sessionId).toBe('cs_placeholder_test_123')
      expect(result.url).toContain('stripe.com')
    }

    const calledBody = mockFetch.mock.calls[0][1].body
    expect(calledBody).toContain('metadata%5Bslug%5D=novacorp')
    expect(calledBody).toContain('metadata%5Btier%5D=pro')
    expect(calledBody).toContain('unit_amount%5D=9900') // $99 for Pro
  })

  it('provisions pot and emits BusEvent when checkout session completes', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true, result: { id: 'd1_id_123' } }),
    })

    // Mock global fetch for provisionPot sub-calls
    vi.stubGlobal('fetch', mockFetch)

    const env = {
      TENANT_SLUG: 'mumega',
      SECRET_ENV_CF_API_TOKEN: 'cf_token_placeholder',
      BUS: { send: mockBusSend },
      DB: harness.db,
    } as unknown as Env

    const sessionPayload = {
      customer: 'cus_123',
      customer_email: 'admin@acme.com',
      metadata: {
        action: 'create_pot',
        slug: 'acmecorp',
        brand: 'ACME Corporation',
        tier: 'starter',
        owner_email: 'admin@acme.com',
      },
    }

    const outcome = await handlePotCreationCompleted(env, sessionPayload)

    // WAS: expect(outcome.ok).toBe(true). This is the MONEY PATH — it runs after a customer
    // completes Stripe checkout. Asserting ok:true certified that a paying customer is told
    // their pot is live when provisioning created an empty D1, an empty KV, no schema, no
    // worker and no credentials (mupot#1285). The test made the defect look verified.
    expect(outcome.ok).toBe(false)
    expect(outcome.slug).toBe('acmecorp')
    expect(outcome.error).toBeTruthy()

    // The event still fires — silence would be worse — but under a type that says what
    // actually happened, so no subscriber treats a half-run as a delivered product.
    expect(mockBusSend).toHaveBeenCalledTimes(1)
    const emitted = mockBusSend.mock.calls[0][0] as { type: string; payload: Record<string, unknown> }
    expect(emitted.type).toBe('pot.self_serve_provisioning_incomplete')
    expect(emitted.payload.not_completed).toBeTruthy()
    expect(emitted.payload.orphaned_resources).toBeTruthy()

    vi.unstubAllGlobals()
  })

  it('renders public pricing page HTML', () => {
    const pageHtml = pricingPageHtml('https://mupot.mumega.com').toString()
    expect(pageHtml).toContain('Your Sovereign Agent Workforce')
    expect(pageHtml).toContain('Starter')
    expect(pageHtml).toContain('$49')
    expect(pageHtml).toContain('Pro')
    expect(pageHtml).toContain('$99')
    expect(pageHtml).toContain('Scale')
    expect(pageHtml).toContain('$249')
  })

  it('serves public REST API endpoints: GET /slug-available and POST /checkout', async () => {
    const env = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key',
      DB: harness.db,
    } as unknown as Env

    const req = new Request('http://localhost/slug-available?slug=my-fleet-pot')
    const res = await publicPotsApp.fetch(req, env)
    expect(res.status).toBe(200)
    const json = await res.json<{ ok: boolean; result: { available: boolean } }>()
    expect(json.ok).toBe(true)
    expect(json.result.available).toBe(true)
  })

  describe('per-checkout-session claim (mupot#1507-v2 P0-C)', () => {
    async function sha256(text: string): Promise<string> {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }

    function fullProvisionEnv(overrides: Partial<Env> = {}): Env {
      const bundleCode = '// self-serve worker bundle'
      return {
        PUBLIC_ORIGIN: 'https://mupot.mumega.com',
        SECRET_ENV_CF_ACCOUNT_ID: 'acc-123',
        SECRET_ENV_CF_API_TOKEN: 'cf-tok-abc',
        TENANT_SLUG: 'mumega',
        DB: harness.db,
        BUS: { send: vi.fn(async () => undefined) },
        DISPATCHER: fakeDispatcher({ tenant: 'raceslug', releaseSha: null as any }) as any,
        // checkout.ts's Stripe path calls provisionSovereignPot with no `workerJsCode`
        // positional argument (a KNOWN, DOCUMENTED gap — docs/workflows/tenant-provision.md
        // "Bundle source trade-off") — so the ONLY way `deploy_worker` (and therefore this
        // whole run) can reach `ok:true` in these tests is via the R2 bundle path.
        POT_WORKER_BUNDLE_BUCKET: {
          get: vi.fn(async () => ({ text: async () => bundleCode, customMetadata: { sha256: await sha256(bundleCode) } })),
        },
        ...overrides,
      } as unknown as Env
    }

    it('a replayed webhook for the SAME session is idempotent — adopts, does not duplicate, same admin identity', async () => {
      const { fetchMock } = createRealisticFakeCf({})
      global.fetch = fetchMock as any
      const env = fullProvisionEnv()
      const session = {
        id: 'cs_replay_1',
        customer: 'cus_1',
        customer_email: 'owner@raceslug.test',
        metadata: { action: 'create_pot', slug: 'raceslug', brand: 'Race Slug Co', tier: 'starter', owner_email: 'owner@raceslug.test' },
      }

      const first = await handlePotCreationCompleted(env, session)
      expect(first.ok).toBe(true)

      const second = await handlePotCreationCompleted(env, session)
      expect(second.ok).toBe(true)

      const rows = harness.sqlite.prepare("SELECT COUNT(*) as c FROM pots WHERE slug = 'raceslug'").get() as { c: number }
      expect(rows.c).toBe(1) // never duplicated

      const memberRows = harness.sqlite.prepare(
        "SELECT COUNT(*) as c FROM pot_provision_receipts WHERE slug = 'raceslug' AND step = 'seed_identities' AND ok = 1",
      ).get() as { c: number }
      // Two full runs, but the second is `alreadySeeded` — seedPotIdentities mints nothing
      // new — still two receipt rows (one per run_id), which is correct: each CALL is its
      // own receipted attempt, only the underlying resources are not duplicated.
      expect(memberRows.c).toBe(2)
    })

    it('a SECOND, genuinely different session for the SAME slug is refused — zero Cloudflare calls, zero pots-row mutation', async () => {
      const env = fullProvisionEnv()
      // First session claims the slug (simulating an in-flight/still-processing first
      // webhook) directly at the DB level — equivalent to handlePotCreationCompleted's own
      // registry-gate INSERT having already landed for `cs_first`.
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, checkout_session_id, provisioner_tenant) ` +
          `VALUES ('p-race', 'raceslug', 'raceslug', 'provisioning', 'provision', 'cs_first', 'mumega')`,
      )

      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as any

      const attackerSession = {
        id: 'cs_second_different',
        customer: 'cus_evil',
        customer_email: 'attacker@evil.test',
        metadata: { action: 'create_pot', slug: 'raceslug', brand: 'Evil Co', tier: 'starter', owner_email: 'attacker@evil.test' },
      }
      const outcome = await handlePotCreationCompleted(env, attackerSession)

      expect(outcome.ok).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled() // zero Cloudflare calls

      const row = harness.sqlite.prepare(
        "SELECT checkout_session_id, provisioner_member_id FROM pots WHERE slug = 'raceslug'",
      ).get() as { checkout_session_id: string; provisioner_member_id: string | null }
      // The original claim is untouched — never adopted, never overwritten.
      expect(row.checkout_session_id).toBe('cs_first')
      expect(row.provisioner_member_id).toBeNull()
    })

    it('P0-C REGRESSION PROOF: two DIFFERENT self-serve sessions on the same slug do NOT match via null===null even with TENANT_SLUG unset', async () => {
      // Reproduces the exact reported defect: checkout.ts never sets
      // `minted_by_member_id`, and before this fix, `actorTenant` alone (which is
      // IDENTICAL for every self-serve buyer, including when TENANT_SLUG is unset and it
      // is simply `null` on both sides) was the entire ownership predicate for a
      // self-serve claim.
      const env = fullProvisionEnv({ TENANT_SLUG: undefined } as Partial<Env>)
      harness.sqlite.exec(
        `INSERT INTO pots (id, slug, worker_script, status, source, checkout_session_id, provisioner_member_id, provisioner_tenant) ` +
          `VALUES ('p-race2', 'raceslug2', 'raceslug2', 'provisioning', 'provision', 'cs_victim', NULL, NULL)`,
      )
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as any

      const outcome = await handlePotCreationCompleted(env, {
        id: 'cs_attacker_different',
        customer: 'cus_evil',
        customer_email: 'attacker@evil.test',
        metadata: { action: 'create_pot', slug: 'raceslug2', brand: 'Evil Co', tier: 'starter', owner_email: 'attacker@evil.test' },
      })

      expect(outcome.ok).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
