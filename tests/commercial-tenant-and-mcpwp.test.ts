// tests/commercial-tenant-and-mcpwp.test.ts — Unit and real schema tests for commercialization engine.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { planClientTenant, deriveClientSlug } from '../src/reseller/client-tenant'
import { formatClientIntakeTask } from '../src/tasks/client-intake-template'
import { formatStripeMeteringReceipt } from '../src/billing/metering-receipt'
import { createTask } from '../src/tasks/service'
import type { Env } from '../src/types'

describe('Commercialization Engine & Real SQLite D1 Verification', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: 'mumega',
      DB: harness.db,
    } as unknown as Env
  })

  afterAll(() => {
    harness.close()
  })

  describe('Commercial Client Tenant Stand-Up Planner', () => {
  it('derives clean client slugs', () => {
    expect(deriveClientSlug('Viamar Logistics')).toBe('viamar-logistics')
    expect(deriveClientSlug('https://DentalNearYou.ca/')).toBe('dentalnearyou-ca')
    expect(deriveClientSlug('Tech-Parts & Hardware!')).toBe('tech-parts-hardware')
  })

  it('generates a deterministic client tenant stand-up plan', () => {
    const plan = planClientTenant({
      clientName: 'DentalNearYou',
      wordpressUrl: 'https://dentalnearyou.com',
      services: ['seo', 'content', 'aeo'],
      tier: 'pro',
      applicationFeePercent: 20,
      contactEmail: 'billing@dentalnearyou.com',
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.tenantSlug).toBe('dentalnearyou')
      expect(plan.tier).toBe('pro')
      expect(plan.billing.applicationFeePercent).toBe(20)
      expect(plan.billing.contactEmail).toBe('billing@dentalnearyou.com')
      expect(plan.squads).toHaveLength(2)
      expect(plan.squads[0].slug).toBe('dentalnearyou-core')
      expect(plan.squads[1].slug).toBe('dentalnearyou-mcpwp')
      expect(plan.connectorBindings).toHaveLength(2)
      expect(plan.services).toHaveLength(3)
      expect(plan.execute.stepsRequired.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('rejects invalid inputs cleanly', () => {
    const invalidName = planClientTenant({
      clientName: ' ',
      wordpressUrl: 'https://example.com',
    })
    expect(invalidName.ok).toBe(false)
    if (!invalidName.ok) expect(invalidName.reason).toBe('invalid_client_name')

    const invalidUrl = planClientTenant({
      clientName: 'Client Co',
      wordpressUrl: 'not-a-url',
    })
    expect(invalidUrl.ok).toBe(false)
    if (!invalidUrl.ok) expect(invalidUrl.reason).toBe('invalid_wordpress_url')

    const invalidService = planClientTenant({
      clientName: 'Client Co',
      wordpressUrl: 'https://example.com',
      services: ['non-existent-service-123'],
    })
    expect(invalidService.ok).toBe(false)
    if (!invalidService.ok) expect(invalidService.reason).toBe('unsupported_service')
  })
})

describe('Grok SEO & Client Task Intake Template', () => {
  it('formats an mcpwp-seo task with strict done_when predicates', () => {
    const task = formatClientIntakeTask({
      clientSlug: 'viamar',
      servicePackage: 'mcpwp-seo',
      title: 'Inject High-Intent Freight Meta Tags',
      description: 'Optimize the main freight forwarder page for Ontario commercial queries.',
      targetUrl: 'https://viamar.ca/freight-forwarding',
      targetKeywords: ['toronto freight', 'customs clearance ontario'],
      priority: 'P0',
    })

    expect(task.squadSlug).toBe('viamar-mcpwp')
    expect(task.priority).toBe('P0')
    expect(task.title).toBe('[MCPWP-SEO] Inject High-Intent Freight Meta Tags')
    expect(task.doneWhen).toContain('wp_get_posts/wp_get_pages')
    expect(task.doneWhen).toContain('HTTP and verify')
    expect(task.body).toContain('toronto freight')
    expect(task.suggestedGateOwner).toBe('gate:viamar-gate')
  })

  it('formats an mcpwp-store WooCommerce task', () => {
    const task = formatClientIntakeTask({
      clientSlug: 'techparts',
      servicePackage: 'mcpwp-store',
      title: 'Update Summer Sale Pricing',
      description: 'Apply 15% discount across GPU categories.',
      targetUrl: 'https://techparts.com/store',
    })

    expect(task.squadSlug).toBe('techparts-mcpwp')
    expect(task.doneWhen).toContain('wc_update_product')
  })
})

describe('Stripe Execution Metering & Receipts', () => {
  it('formats execution line items with appropriate margin and minimums', async () => {
    const receipt = await formatStripeMeteringReceipt({
      tenantSlug: 'viamar',
      clientName: 'Viamar Logistics',
      taskId: 'task-12345678-abcd',
      flightId: 'flight-999',
      servicePackage: 'mcpwp-seo',
      executorSeat: 'cursor-mupot-setup',
      costMicroUsd: 150000, // $0.15 compute cost
      modelTokens: { input: 25000, output: 1200 },
      completedAt: '2026-08-22T04:30:00.000Z',
    })

    expect(receipt.tenantSlug).toBe('viamar')
    expect(receipt.rawComputeCostUsd).toBe('$0.1500')
    // 0.15 * 2.5 = 0.375 -> rounded cents = 38 cents -> minimum 50 cents applied
    expect(receipt.billedAmountCents).toBe(50)
    expect(receipt.billedAmountFormatted).toBe('$0.50')
    expect(receipt.tokenUsageSummary).toContain('26,200 tokens')
    expect(receipt.lineItemDescription).toContain('[Mumega Autonomous Service] MCPWP-SEO')
    expect(receipt.payloadSha256).toBeDefined()
    expect(receipt.payloadSha256.length).toBe(64)
  })

  it('KILL-WITNESS: mutating any field in canonical payload changes the Web Crypto SHA-256 digest', async () => {
    const inputA = {
      tenantSlug: 'viamar',
      clientName: 'Viamar Logistics',
      taskId: 'task-12345678-abcd',
      flightId: 'flight-999',
      servicePackage: 'mcpwp-seo',
      executorSeat: 'cursor-mupot-setup',
      costMicroUsd: 150000,
      completedAt: '2026-08-22T04:30:00.000Z',
    }

    const receiptA = await formatStripeMeteringReceipt(inputA)

    // Mutate costMicroUsd slightly ($0.15 -> $0.16)
    const receiptB = await formatStripeMeteringReceipt({
      ...inputA,
      costMicroUsd: 160000,
    })

    // Mutate executorSeat
    const receiptC = await formatStripeMeteringReceipt({
      ...inputA,
      executorSeat: 'cursor-other-seat',
    })

    expect(receiptA.payloadSha256).not.toBe(receiptB.payloadSha256)
    expect(receiptA.payloadSha256).not.toBe(receiptC.payloadSha256)
    expect(receiptA.receiptId).not.toBe(receiptB.receiptId)
  })

  it('proves client intake task creates real D1 task record', async () => {
    // Seed department & squad
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-viamar', 'viamar-dept', 'Viamar Logistics Dept', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-viamar-mcpwp', 'dept-viamar', 'viamar-mcpwp', 'Viamar WordPress Squad', datetime('now'));
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES ('m-grok-seo', 'mumega', 'Grok SEO Lead', NULL, 'active', datetime('now'));
    `)

    const intake = formatClientIntakeTask({
      clientSlug: 'viamar',
      servicePackage: 'mcpwp-seo',
      title: 'Optimize Freight Landing Page Meta',
      description: 'Audit and update Yoast SEO titles and meta descriptions for Toronto commercial queries.',
      targetUrl: 'https://viamar.ca/freight',
      targetKeywords: ['toronto freight forwarder', 'ontario logistics'],
      priority: 'P0',
    })

    const task = await createTask(
      env,
      {
        squad_id: 'squad-viamar-mcpwp',
        title: intake.title,
        body: intake.body,
        done_when: intake.doneWhen,
        priority: intake.priority,
      },
      { actor: { kind: 'member', id: 'm-grok-seo' }, externalSource: intake.externalSource },
    )

    expect(task.id).toBeDefined()
    expect(task.status).toBe('open')
    expect(task.title).toContain('[MCPWP-SEO]')
    expect(task.done_when).toContain('wp_get_posts/wp_get_pages')

    // Read direct from SQLite to verify D1 persistence
    const saved = harness.sqlite.prepare(`SELECT title, status, external_source FROM tasks WHERE id = ?`).get(task.id) as { title: string; status: string; external_source: string }
    expect(saved.title).toBe(task.title)
    expect(saved.status).toBe('open')
    expect(saved.external_source).toBe('intake:mcpwp-seo:viamar')
  })
})
})
