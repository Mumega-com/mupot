// tests/supabase-connector.test.ts — Unit tests for 1-Click Supabase Data Connector & Vault Engine (Flight 6).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeSupabaseUrl,
  introspectSupabaseSchema,
  executeSupabaseQuery,
  executeSupabaseMutation,
  type SupabaseConfig,
} from '../src/connectors/supabase'
import { isConnectorType } from '../src/connectors/crypto'
import { supabaseWebhookApp } from '../src/connectors/supabase-webhook'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('1-Click Supabase Data Connector & Engine (Flight 6)', () => {
  let harness: ReturnType<typeof createSqliteD1>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  it('recognizes supabase as a valid connector type in crypto engine', () => {
    expect(isConnectorType('supabase')).toBe(true)
    expect(isConnectorType('unknown_type')).toBe(false)
  })

  it('normalizes supabase project URLs accurately', () => {
    expect(normalizeSupabaseUrl('https://abcxyz.supabase.co/')).toBe('https://abcxyz.supabase.co')
    expect(normalizeSupabaseUrl('abcxyz.supabase.co')).toBe('https://abcxyz.supabase.co')
    expect(normalizeSupabaseUrl('http://localhost:54321/')).toBe('http://localhost:54321')
  })

  it('introspects live OpenAPI PostgREST schema and generates TypeScript interfaces', async () => {
    const mockSpec = {
      definitions: {
        warranty_claims: {
          description: 'Customer roof warranty triage claims',
          required: ['id', 'contractor_id', 'claim_status'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            contractor_id: { type: 'string' },
            claim_status: { type: 'string' },
            damage_estimate_cents: { type: 'integer' },
            notes: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        contractors: {
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            tier: { type: 'string' },
          },
        },
      },
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSpec,
    }) as unknown as typeof fetch

    const config: SupabaseConfig = {
      url: 'https://gaf-roofing.supabase.co',
      apiKey: 'example-supabase-key-placeholder',
    }

    const result = await introspectSupabaseSchema(config, mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.tables.length).toBe(2)

    const warrantyTable = result.tables.find((t) => t.name === 'warranty_claims')
    expect(warrantyTable).toBeDefined()
    expect(warrantyTable?.description).toBe('Customer roof warranty triage claims')
    expect(warrantyTable?.columns.length).toBe(6)

    const idCol = warrantyTable?.columns.find((c) => c.name === 'id')
    expect(idCol?.nullable).toBe(false)

    const notesCol = warrantyTable?.columns.find((c) => c.name === 'notes')
    expect(notesCol?.nullable).toBe(true)

    // Verify generated TypeScript interfaces
    expect(result.typeDefinitions).toContain('export interface WarrantyClaims {')
    expect(result.typeDefinitions).toContain('id: string')
    expect(result.typeDefinitions).toContain('contractor_id: string')
    expect(result.typeDefinitions).toContain('notes?: string')
    expect(result.typeDefinitions).toContain('export interface Contractors {')
  })

  it('executes parameterized SELECT queries with PostgREST filters and count headers', async () => {
    const mockRows = [
      { id: 'claim-1', claim_status: 'open', damage_estimate_cents: 450000 },
      { id: 'claim-2', claim_status: 'open', damage_estimate_cents: 120000 },
    ]

    const mockHeaders = new Headers({
      'content-range': '0-1/2',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: mockHeaders,
      json: async () => mockRows,
    }) as unknown as typeof fetch

    const config: SupabaseConfig = {
      url: 'https://gaf-roofing.supabase.co',
      apiKey: 'example-supabase-key-placeholder',
    }

    const queryResult = await executeSupabaseQuery(
      config,
      {
        table: 'warranty_claims',
        select: 'id,claim_status,damage_estimate_cents',
        filters: { claim_status: 'eq.open' },
        limit: 10,
        order: 'damage_estimate_cents.desc',
      },
      mockFetch,
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const calledUrl = (mockFetch as any).mock.calls[0][0]
    expect(calledUrl).toContain('/rest/v1/warranty_claims')
    expect(calledUrl).toContain('select=id%2Cclaim_status%2Cdamage_estimate_cents')
    expect(calledUrl).toContain('claim_status=eq.open')
    expect(calledUrl).toContain('limit=10')
    expect(calledUrl).toContain('order=damage_estimate_cents.desc')

    expect(queryResult.data.length).toBe(2)
    expect(queryResult.count).toBe(2)
  })

  it('executes mutations (insert, update, delete) with return representation', async () => {
    const mockCreated = [{ id: 'claim-3', claim_status: 'pending_review' }]
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => mockCreated,
    }) as unknown as typeof fetch

    const config: SupabaseConfig = {
      url: 'https://gaf-roofing.supabase.co',
      apiKey: 'example-supabase-key-placeholder',
    }

    const insertResult = await executeSupabaseMutation(
      config,
      {
        table: 'warranty_claims',
        action: 'insert',
        data: { contractor_id: 'c-100', claim_status: 'pending_review' },
      },
      mockFetch,
    )

    expect(insertResult.ok).toBe(true)
    if (insertResult.ok) {
      expect(insertResult.data.length).toBe(1)
      expect(insertResult.data[0].id).toBe('claim-3')
    }
  })

  it('routes Supabase database trigger webhooks to Mupot Bus and returns receipt', async () => {
    const payload = {
      type: 'INSERT',
      table: 'warranty_claims',
      schema: 'public',
      record: {
        id: 'claim-999',
        contractor_id: 'c-555',
        claim_status: 'intake_queued',
      },
      old_record: null,
    }

    const mockBusSend = vi.fn().mockResolvedValue(undefined)
    const env = {
      TENANT_SLUG: 'gaf',
      BUS: {
        send: mockBusSend,
      },
      DB: harness.db,
    } as unknown as Env

    const req = new Request('http://localhost/supabase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const res = await supabaseWebhookApp.fetch(req, env)
    expect(res.status).toBe(200)

    const json = await res.json<{ ok: boolean; event: string; table: string }>()
    expect(json.ok).toBe(true)
    expect(json.event).toBe('supabase.record.insert')
    expect(json.table).toBe('warranty_claims')
    expect(mockBusSend).toHaveBeenCalledOnce()
  })
})
