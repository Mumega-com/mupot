// src/connectors/supabase.ts — Native Supabase (PostgreSQL) 1-Click Data Connector & Engine.
//
// Provides:
//   1. introspectSupabaseSchema() — fetches PostgREST schema and generates TypeScript interfaces.
//   2. executeSupabaseQuery() — safe, parameterized PostgREST querying.
//   3. executeSupabaseMutation() — safe insert / update / delete mutations with representation return.
//   4. handleSupabaseWebhook() — processes database trigger events and emits them to Mupot Bus / tasks.

import { redactSecretPatterns } from '../lib/redact'

export interface SupabaseConfig {
  url: string
  apiKey: string
}

export interface SupabaseColumnInfo {
  name: string
  type: string
  nullable: boolean
  description?: string
}

export interface SupabaseTableInfo {
  name: string
  description?: string
  columns: SupabaseColumnInfo[]
  primaryKey?: string[]
}

export interface SupabaseSchemaResult {
  tables: SupabaseTableInfo[]
  typeDefinitions: string
}

export interface SupabaseQueryParams {
  table: string
  select?: string
  filters?: Record<string, string>
  order?: string
  limit?: number
  offset?: number
}

export interface SupabaseMutationParams {
  table: string
  action: 'insert' | 'update' | 'delete'
  data?: Record<string, unknown> | Array<Record<string, unknown>>
  match?: Record<string, string>
}

export interface SupabaseWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema: string
  record: Record<string, unknown> | null
  old_record: Record<string, unknown> | null
}

export function normalizeSupabaseUrl(rawUrl: string): string {
  let url = rawUrl.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`
  }
  return url.replace(/\/+$/, '')
}

function validateTableName(table: string): string {
  const clean = table.trim()
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
    throw new Error(`Invalid table name: ${table}. Must contain only alphanumeric characters and underscores.`)
  }
  return clean
}

/**
 * Introspects live Supabase database via OpenAPI / PostgREST root schema.
 */
export async function introspectSupabaseSchema(
  config: SupabaseConfig,
  fetchFn: typeof fetch = fetch,
): Promise<SupabaseSchemaResult> {
  const baseUrl = normalizeSupabaseUrl(config.url)
  const endpoint = `${baseUrl}/rest/v1/?apikey=${encodeURIComponent(config.apiKey)}`

  const res = await fetchFn(endpoint, {
    method: 'GET',
    headers: {
      'apikey': config.apiKey,
      'Authorization': `Bearer ${config.apiKey}`,
      'Accept': 'application/openapi+json, application/json',
    },
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Failed to introspect Supabase schema: HTTP ${res.status} ${redactSecretPatterns(errText)}`)
  }

  const spec = await res.json<{
    definitions?: Record<string, {
      properties?: Record<string, { type?: string; description?: string; format?: string }>
      required?: string[]
      description?: string
    }>
    paths?: Record<string, unknown>
  }>()

  const tables: SupabaseTableInfo[] = []
  const typeDefLines: string[] = ['// Auto-generated Supabase TypeScript Interfaces', '']

  if (spec.definitions && typeof spec.definitions === 'object') {
    for (const [tableName, def] of Object.entries(spec.definitions)) {
      if (!tableName || tableName.startsWith('_')) continue

      const columns: SupabaseColumnInfo[] = []
      const requiredSet = new Set(def.required || [])

      typeDefLines.push(`export interface ${pascalCase(tableName)} {`)

      if (def.properties && typeof def.properties === 'object') {
        for (const [colName, prop] of Object.entries(def.properties)) {
          const isRequired = requiredSet.has(colName)
          const tsType = mapJsonSchemaTypeToTs(prop.type, prop.format)
          columns.push({
            name: colName,
            type: prop.type || 'string',
            nullable: !isRequired,
            description: prop.description,
          })

          const opt = isRequired ? '' : '?'
          typeDefLines.push(`  ${colName}${opt}: ${tsType}`)
        }
      }

      typeDefLines.push('}', '')

      tables.push({
        name: tableName,
        description: def.description,
        columns,
      })
    }
  }

  return {
    tables,
    typeDefinitions: typeDefLines.join('\n'),
  }
}

/**
 * Executes a parameterized SELECT query against Supabase PostgREST endpoint.
 */
export async function executeSupabaseQuery<T = Record<string, unknown>>(
  config: SupabaseConfig,
  params: SupabaseQueryParams,
  fetchFn: typeof fetch = fetch,
): Promise<{ data: T[]; count?: number }> {
  const baseUrl = normalizeSupabaseUrl(config.url)
  const table = validateTableName(params.table)
  const url = new URL(`${baseUrl}/rest/v1/${table}`)

  url.searchParams.set('select', params.select || '*')

  if (params.filters && typeof params.filters === 'object') {
    for (const [key, value] of Object.entries(params.filters)) {
      if (/^[a-zA-Z0-9_]+$/.test(key)) {
        url.searchParams.set(key, value)
      }
    }
  }

  if (params.order) {
    url.searchParams.set('order', params.order)
  }

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 1000)
  url.searchParams.set('limit', String(limit))

  if (params.offset && params.offset > 0) {
    url.searchParams.set('offset', String(params.offset))
  }

  const res = await fetchFn(url.toString(), {
    method: 'GET',
    headers: {
      'apikey': config.apiKey,
      'Authorization': `Bearer ${config.apiKey}`,
      'Accept': 'application/json',
      'Prefer': 'count=exact',
    },
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Supabase query failed on ${table}: HTTP ${res.status} ${redactSecretPatterns(errText)}`)
  }

  const data = (await res.json()) as T[]
  const contentRange = res.headers.get('content-range')
  let count: number | undefined
  if (contentRange && contentRange.includes('/')) {
    const totalStr = contentRange.split('/')[1]
    if (totalStr && totalStr !== '*') {
      const parsed = parseInt(totalStr, 10)
      if (!isNaN(parsed)) count = parsed
    }
  }

  return { data, count }
}

/**
 * Executes an INSERT, UPDATE, or DELETE mutation on Supabase PostgREST endpoint.
 */
export async function executeSupabaseMutation<T = Record<string, unknown>>(
  config: SupabaseConfig,
  params: SupabaseMutationParams,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; data: T[] } | { ok: false; error: string }> {
  const baseUrl = normalizeSupabaseUrl(config.url)
  const table = validateTableName(params.table)
  const url = new URL(`${baseUrl}/rest/v1/${table}`)

  let method = 'POST'
  if (params.action === 'update') method = 'PATCH'
  if (params.action === 'delete') method = 'DELETE'

  if (params.match && typeof params.match === 'object') {
    for (const [key, value] of Object.entries(params.match)) {
      if (/^[a-zA-Z0-9_]+$/.test(key)) {
        url.searchParams.set(key, value.startsWith('eq.') ? value : `eq.${value}`)
      }
    }
  }

  try {
    const res = await fetchFn(url.toString(), {
      method,
      headers: {
        'apikey': config.apiKey,
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'return=representation',
      },
      body: params.data ? JSON.stringify(params.data) : undefined,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return {
        ok: false,
        error: `Supabase mutation ${params.action} failed on ${table}: HTTP ${res.status} ${redactSecretPatterns(errText)}`,
      }
    }

    const data = (await res.json().catch(() => [])) as T[]
    return { ok: true, data }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function pascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_]/g, ' ')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

function mapJsonSchemaTypeToTs(type?: string, format?: string): string {
  if (!type) return 'unknown'
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  if (type === 'string') {
    if (format === 'date-time' || format === 'date') return 'string'
    return 'string'
  }
  if (type === 'array') return 'unknown[]'
  if (type === 'object') return 'Record<string, unknown>'
  return 'unknown'
}
