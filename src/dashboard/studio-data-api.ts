// src/dashboard/studio-data-api.ts — Live Supabase Data API for Studio Canvas Inspector.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import {
  introspectSupabaseSchema,
  executeSupabaseQuery,
  executeSupabaseMutation,
  type SupabaseConfig,
} from '../connectors/supabase'
import { listConnectors, resolveConnector } from '../connectors/service'

export const studioDataApp = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()

async function resolveActiveSupabaseConfig(env: Env): Promise<SupabaseConfig | null> {
  const raw = await resolveConnector(env, 'pot', 'supabase')
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (parsed.url && parsed.apiKey) return parsed
  } catch {
    // Non-JSON format
  }
  return null
}

/**
 * GET /api/studio/database/tables — Returns introspected tables and column lists.
 */
studioDataApp.get('/tables', async (c) => {
  const creds = await resolveActiveSupabaseConfig(c.env)
  if (!creds) {
    return c.json({ ok: false, error: 'no_active_supabase_connector' }, 404)
  }

  try {
    const schema = await introspectSupabaseSchema(creds)
    return c.json({
      ok: true,
      tables: schema.tables,
      type_definitions: schema.typeDefinitions,
    })
  } catch (error) {
    return c.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 502)
  }
})

/**
 * GET /api/studio/database/query — Executes live query for a given table.
 */
studioDataApp.get('/query', async (c) => {
  const creds = await resolveActiveSupabaseConfig(c.env)
  if (!creds) {
    return c.json({ ok: false, error: 'no_active_supabase_connector' }, 404)
  }

  const table = c.req.query('table')?.trim()
  if (!table) {
    return c.json({ ok: false, error: 'table_required' }, 400)
  }

  const select = c.req.query('select')?.trim() || '*'
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 500)
  const order = c.req.query('order')?.trim() || undefined

  try {
    const result = await executeSupabaseQuery(creds, {
      table,
      select,
      limit,
      order,
    })

    return c.json({
      ok: true,
      table,
      count: result.count ?? result.data.length,
      data: result.data,
    })
  } catch (error) {
    return c.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 502)
  }
})

/**
 * POST /api/studio/database/mutate — Executes a mutation on a given table.
 */
studioDataApp.post('/mutate', async (c) => {
  const creds = await resolveActiveSupabaseConfig(c.env)
  if (!creds) {
    return c.json({ ok: false, error: 'no_active_supabase_connector' }, 404)
  }

  let body: { table?: string; action?: 'insert' | 'update' | 'delete'; data?: Record<string, unknown>; match?: Record<string, string> }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  if (!body.table || !body.action) {
    return c.json({ ok: false, error: 'table_and_action_required' }, 400)
  }

  const result = await executeSupabaseMutation(creds, {
    table: body.table,
    action: body.action,
    data: body.data,
    match: body.match,
  })

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 502)
  }

  return c.json({ ok: true, table: body.table, action: body.action, data: result.data })
})
