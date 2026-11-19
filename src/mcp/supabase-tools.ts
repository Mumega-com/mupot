// src/mcp/supabase-tools.ts — MCP tools for 1-Click Supabase Data Connector.

import type { ToolSpec } from './index'
import { fail, done, str, hasWorkspaceAdmin, memberCanOnSquad, memberCanOnSquadAuth } from './index'
import type { AuthContext, Env } from '../types'
import {
  introspectSupabaseSchema,
  executeSupabaseQuery,
  executeSupabaseMutation,
  normalizeSupabaseUrl,
  type SupabaseConfig,
} from '../connectors/supabase'
import {
  addConnector,
  resolveConnectorById,
  listConnectors,
  type ConnectorScopeType,
} from '../connectors/service'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_STRING_SCHEMA = { type: 'string' }
const OBJECT_SCHEMA = { type: 'object' }

/**
 * May this caller use a connector with this scope? Decided from the connector's REAL scope,
 * before any secret is decrypted.
 *   agent → only the bound agent; squad → member rank on THAT squad; pot → org admin only.
 */
async function callerMayUseConnector(
  env: Env,
  auth: AuthContext,
  scopeType: string,
  scopeId: string | null,
): Promise<boolean> {
  if (scopeType === 'agent') return !!scopeId && !!auth.boundAgentId && auth.boundAgentId === scopeId
  if (scopeType === 'squad') return !!scopeId && memberCanOnSquadAuth(env, auth, scopeId, 'member')
  if (scopeType === 'pot') return hasWorkspaceAdmin(auth)
  return false
}

async function decryptSupabaseConfig(env: Env, connectorId: string): Promise<SupabaseConfig | null> {
  const raw = await resolveConnectorById(env, connectorId, 'supabase')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.url === 'string' && typeof parsed.apiKey === 'string') return parsed
  } catch {
    // unparseable secret: treat as unavailable
  }
  return null
}

// Every refusal here (unknown id, other scope, revoked, wrong type) returns null, which the
// tools turn into one identical not-found result: no existence oracle across scopes.
async function resolveSupabaseCredentials(
  env: Env,
  auth: AuthContext,
  connectorId?: string,
): Promise<SupabaseConfig | null> {
  const connectors = (await listConnectors(env)).filter((c) => c.type === 'supabase' && !c.revoked_at)

  if (connectorId) {
    // connector_id is a connector's OWN id; strict, no fallback to another connector.
    const target = connectors.find((c) => c.id === connectorId)
    if (!target) return null
    if (!(await callerMayUseConnector(env, auth, target.scope_type, target.scope_id))) return null
    return decryptSupabaseConfig(env, target.id)
  }

  // No id: only connectors the caller is authorised for, agent first, then the caller's own
  // squad, then (org admins only) pot-wide.
  if (auth.boundAgentId) {
    const own = connectors.find((c) => c.scope_type === 'agent' && c.scope_id === auth.boundAgentId)
    if (own) return decryptSupabaseConfig(env, own.id)

    const agent = await env.DB.prepare(`SELECT squad_id FROM agents WHERE id = ?1 LIMIT 1`)
      .bind(auth.boundAgentId)
      .first<{ squad_id: string }>()
    const squadId = agent?.squad_id
    if (squadId && (await memberCanOnSquadAuth(env, auth, squadId, 'member'))) {
      const sq = connectors.find((c) => c.scope_type === 'squad' && c.scope_id === squadId)
      if (sq) return decryptSupabaseConfig(env, sq.id)
    }
  }
  if (hasWorkspaceAdmin(auth)) {
    const pot = connectors.find((c) => c.scope_type === 'pot')
    if (pot) return decryptSupabaseConfig(env, pot.id)
  }
  return null
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
      return fail(502, 'supabase_introspection_failed', {
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
      return fail(502, 'supabase_query_failed', {
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
      return fail(502, 'supabase_mutation_failed', { error: result.error })
    }

    return done({
      ok: true,
      table,
      action,
      data: result.data,
    })
  },
}
