// src/mcp/supabase-tools.ts — MCP tools for 1-Click Supabase Data Connector.

import type { ToolSpec } from './index'
import { fail, done, str, hasWorkspaceAdmin, memberCanOnSquad } from './index'
import type { Env, AuthContext } from '../types'
import {
  introspectSupabaseSchema,
  executeSupabaseQuery,
  executeSupabaseMutation,
  normalizeSupabaseUrl,
  type SupabaseConfig,
} from '../connectors/supabase'
import {
  addConnector,
  resolveConnector,
  listConnectors,
  type ConnectorScopeType,
} from '../connectors/service'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_STRING_SCHEMA = { type: 'string' }
const OBJECT_SCHEMA = { type: 'object' }

async function resolveSupabaseCredentials(
  env: Env,
  _auth: AuthContext,
  connectorId?: string,
): Promise<SupabaseConfig | null> {
  if (connectorId) {
    const raw = await resolveConnector(env, connectorId, 'supabase')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed.url && parsed.apiKey) return parsed
    } catch {
      // If raw is just the api key and url is in meta
    }
  }

  // Look for any active supabase connector available in pot/squad scope
  const connectors = await listConnectors(env)
  const active = connectors.find((c) => c.type === 'supabase' && !c.revoked_at)
  if (!active) return null

  const raw = await resolveConnector(env, active.id, 'supabase')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const toolSupabaseConnect: ToolSpec = {
  name: 'supabase_connect',
  scope: 'org admin or squad lead',
  min: 'member',
  args: '{ url: string, service_key: string, label?: string, squad_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      url: STRING_SCHEMA,
      service_key: STRING_SCHEMA,
      label: OPTIONAL_STRING_SCHEMA,
      squad_id: OPTIONAL_STRING_SCHEMA,
    },
    required: ['url', 'service_key'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const url = str(args.url)
    const serviceKey = str(args.service_key)
    const label = str(args.label) || 'Primary Supabase Connector'
    const squadId = str(args.squad_id)

    if (!url || !serviceKey) {
      return fail(400, 'invalid_args', 'url and service_key are required')
    }

    const scopeType: ConnectorScopeType = squadId ? 'squad' : 'pot'
    if (scopeType === 'squad' && squadId) {
      const can = await memberCanOnSquad(env, auth.capabilities ?? [], squadId, 'lead')
      if (!can && !hasWorkspaceAdmin(auth)) {
        return fail(403, 'forbidden', { need: 'squad:lead or org:admin' })
      }
    } else if (!hasWorkspaceAdmin(auth)) {
      return fail(403, 'forbidden', { need: 'org:admin' })
    }

    const normalizedUrl = normalizeSupabaseUrl(url)
    const payload = JSON.stringify({ url: normalizedUrl, apiKey: serviceKey })

    const result = await addConnector(env, {
      type: 'supabase',
      label,
      secret: payload,
      scope_type: scopeType,
      scope_id: squadId || null,
      created_by: auth.memberId || auth.userId,
    })

    if (!result.ok) {
      return fail(500, 'connector_save_failed', { error: result.error })
    }

    // Try schema test
    let schemaTest: { table_count: number } | null = null
    try {
      const schema = await introspectSupabaseSchema({ url: normalizedUrl, apiKey: serviceKey })
      schemaTest = { table_count: schema.tables.length }
    } catch {
      schemaTest = null
    }

    return done({
      ok: true,
      connector: result.connector,
      schema_test: schemaTest,
    })
  },
}

export const toolSupabaseSchema: ToolSpec = {
  name: 'supabase_schema',
  scope: 'member',
  min: 'member',
  args: '{ connector_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      connector_id: OPTIONAL_STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const connectorId = str(args.connector_id) ?? undefined
    const creds = await resolveSupabaseCredentials(env, auth, connectorId)
    if (!creds) {
      return fail(404, 'supabase_connector_not_found', 'No active Supabase connector configured for this squad/pot.')
    }

    try {
      const schema = await introspectSupabaseSchema(creds)
      return done({
        ok: true,
        tables: schema.tables,
        type_definitions: schema.typeDefinitions,
      })
    } catch (error) {
      return fail(500, 'supabase_introspection_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
}

export const toolSupabaseQuery: ToolSpec = {
  name: 'supabase_query',
  scope: 'member',
  min: 'member',
  args: '{ table: string, select?: string, filters?: Record<string, string>, order?: string, limit?: number, offset?: number, connector_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      table: STRING_SCHEMA,
      select: OPTIONAL_STRING_SCHEMA,
      filters: OBJECT_SCHEMA,
      order: OPTIONAL_STRING_SCHEMA,
      limit: { type: 'number' },
      offset: { type: 'number' },
      connector_id: OPTIONAL_STRING_SCHEMA,
    },
    required: ['table'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const table = str(args.table)
    if (!table) return fail(400, 'invalid_args', 'table is required')

    const connectorId = str(args.connector_id) ?? undefined
    const creds = await resolveSupabaseCredentials(env, auth, connectorId)
    if (!creds) {
      return fail(404, 'supabase_connector_not_found', 'No active Supabase connector found.')
    }

    try {
      const result = await executeSupabaseQuery(creds, {
        table,
        select: str(args.select) || '*',
        filters: typeof args.filters === 'object' ? (args.filters as Record<string, string>) : undefined,
        order: str(args.order) || undefined,
        limit: typeof args.limit === 'number' ? args.limit : 50,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
      })

      return done({
        ok: true,
        table,
        count: result.count ?? result.data.length,
        data: result.data,
      })
    } catch (error) {
      return fail(500, 'supabase_query_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
}

export const toolSupabaseMutate: ToolSpec = {
  name: 'supabase_mutate',
  scope: 'member',
  min: 'member',
  args: '{ table: string, action: "insert"|"update"|"delete", data?: Record<string, any>, match?: Record<string, string>, connector_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      table: STRING_SCHEMA,
      action: { type: 'string', enum: ['insert', 'update', 'delete'] },
      data: OBJECT_SCHEMA,
      match: OBJECT_SCHEMA,
      connector_id: OPTIONAL_STRING_SCHEMA,
    },
    required: ['table', 'action'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const table = str(args.table)
    const action = str(args.action) as 'insert' | 'update' | 'delete'
    if (!table || !['insert', 'update', 'delete'].includes(action)) {
      return fail(400, 'invalid_args', 'table and action (insert|update|delete) are required')
    }

    const connectorId = str(args.connector_id) ?? undefined
    const creds = await resolveSupabaseCredentials(env, auth, connectorId)
    if (!creds) {
      return fail(404, 'supabase_connector_not_found', 'No active Supabase connector found.')
    }

    const result = await executeSupabaseMutation(creds, {
      table,
      action,
      data: typeof args.data === 'object' ? (args.data as Record<string, unknown>) : undefined,
      match: typeof args.match === 'object' ? (args.match as Record<string, string>) : undefined,
    })

    if (!result.ok) {
      return fail(500, 'supabase_mutation_failed', { error: result.error })
    }

    return done({
      ok: true,
      table,
      action,
      data: result.data,
    })
  },
}
