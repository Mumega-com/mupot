// tests/studio-supabase-data.test.ts — Unit tests for Studio Canvas Supabase Data Feed & Inspector (Flight 8).

import { describe, expect, it, vi } from 'vitest'
import { studioDataApp } from '../src/dashboard/studio-data-api'
import { studioPageHtml, type StudioViewData } from '../src/dashboard/studio'
import { encryptConnectorSecret } from '../src/connectors/crypto'

const TEST_MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'

describe('Studio Canvas Supabase Data Feed & Inspector (Flight 8)', () => {
  it('serves GET /tables with introspected schema', async () => {
    const mockOpenApi = {
      paths: {
        '/contractors': {
          get: {
            summary: 'List contractors',
            description: 'Contractors table',
            parameters: [
              { name: 'id', in: 'query', type: 'string' },
              { name: 'company_name', in: 'query', type: 'string' },
              { name: 'tier', in: 'query', type: 'string' },
            ],
          },
          post: {},
        },
        '/warranty_claims': {
          get: {
            summary: 'List warranty claims',
            parameters: [
              { name: 'id', in: 'query', type: 'string' },
              { name: 'claim_status', in: 'query', type: 'string' },
            ],
          },
        },
      },
      definitions: {
        contractors: {
          properties: {
            id: { type: 'string' },
            company_name: { type: 'string' },
            tier: { type: 'string' },
          },
        },
        warranty_claims: {
          properties: {
            id: { type: 'string' },
            claim_status: { type: 'string' },
          },
        },
      },
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockOpenApi,
    })
    globalThis.fetch = mockFetch as any

    const secretPayload = JSON.stringify({
      url: 'https://example-supabase-project.supabase.co',
      apiKey: 'example-supabase-key-placeholder',
    })

    const encSecret = await encryptConnectorSecret(TEST_MASTER_KEY, 'conn_1', 'supabase', secretPayload)

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      CONNECTOR_MASTER_KEY: TEST_MASTER_KEY,
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'conn_1',
              type: 'supabase',
              encrypted_secret: encSecret,
              revoked_at: null,
            }),
          }),
        }),
      },
    }

    const req = new Request('http://localhost/tables')
    const res = await studioDataApp.fetch(req, mockEnv as any)
    expect(res.status).toBe(200)

    const json = await res.json<{ ok: boolean; tables: Array<{ name: string; columns: any[] }> }>()
    expect(json.ok).toBe(true)
    expect(json.tables.length).toBe(2)
    expect(json.tables.map((t) => t.name)).toContain('contractors')
    expect(json.tables.map((t) => t.name)).toContain('warranty_claims')
  })

  it('serves GET /query and fetches rows via PostgREST', async () => {
    const mockRows = [
      { id: '1', company_name: 'Alpha Roofing', tier: 'master_elite' },
      { id: '2', company_name: 'Apex Shingles', tier: 'certified' },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-range': '0-1/2' }),
      json: async () => mockRows,
    })
    globalThis.fetch = mockFetch as any

    const secretPayload = JSON.stringify({
      url: 'https://example-supabase-project.supabase.co',
      apiKey: 'example-supabase-key-placeholder',
    })

    const encSecret = await encryptConnectorSecret(TEST_MASTER_KEY, 'conn_1', 'supabase', secretPayload)

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      CONNECTOR_MASTER_KEY: TEST_MASTER_KEY,
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'conn_1',
              type: 'supabase',
              encrypted_secret: encSecret,
              revoked_at: null,
            }),
          }),
        }),
      },
    }

    const req = new Request('http://localhost/query?table=contractors&limit=10')
    const res = await studioDataApp.fetch(req, mockEnv as any)
    expect(res.status).toBe(200)

    const json = await res.json<{ ok: boolean; table: string; count: number; data: any[] }>()
    expect(json.ok).toBe(true)
    expect(json.table).toBe('contractors')
    expect(json.data.length).toBe(2)
    expect(json.data[0].company_name).toBe('Alpha Roofing')
  })

  it('loads StudioViewData with Supabase table metadata and renders Data Tables tab', async () => {
    const viewData: StudioViewData = {
      brand: 'GAF Materials',
      tenant: 'gaf',
      tier: 'scale',
      operator: 'hadi@mumega.com',
      branch: 'main',
      flights: [],
      agents: [],
      hasSupabase: true,
      supabaseTables: [
        { name: 'contractors', columnCount: 5, description: 'Roofing contractors' },
        { name: 'warranty_claims', columnCount: 8, description: 'Warranty claims' },
      ],
    }

    const html = String(studioPageHtml(viewData))
    expect(html).toContain('Data Tables (2)')
    expect(html).toContain('studio-database-view')
    expect(html).toContain('contractors (5 cols)')
    expect(html).toContain('warranty_claims (8 cols)')
    expect(html).toContain('✨ Ask Agent About Table')
  })
})
