// src/connectors/supabase-webhook.ts — Inbound Webhook Router for Supabase Database Triggers.

import { Hono } from 'hono'
import type { Env } from '../types'
import { createBus } from '../bus'
import { createTask } from '../tasks/service'
import type { SupabaseWebhookPayload } from './supabase'

export const supabaseWebhookApp = new Hono<{ Bindings: Env }>()

supabaseWebhookApp.post('/supabase', async (c) => {
  const secretHeader = c.req.header('x-supabase-webhook-secret') || c.req.query('secret')
  const expectedSecret = c.env.SUPABASE_WEBHOOK_SECRET

  if (expectedSecret && secretHeader !== expectedSecret) {
    return c.json({ ok: false, error: 'invalid_webhook_secret' }, 401)
  }

  let body: SupabaseWebhookPayload
  try {
    body = await c.req.json<SupabaseWebhookPayload>()
  } catch {
    return c.json({ ok: false, error: 'invalid_json_payload' }, 400)
  }

  if (!body.type || !body.table) {
    return c.json({ ok: false, error: 'missing_required_fields' }, 400)
  }

  const bus = createBus(c.env)
  const eventName = `supabase.record.${body.type.toLowerCase()}`

  await bus.emit({
    type: eventName,
    actor: { kind: 'external', id: `supabase:${body.table}` },
    tenant: c.env.TENANT_SLUG,
    ts: new Date().toISOString(),
    payload: {
      type: body.type,
      table: body.table,
      schema: body.schema || 'public',
      record: body.record,
      old_record: body.old_record,
      received_at: new Date().toISOString(),
    },
  })

  // Auto-intake: If there is an agent or squad mapped to this table (e.g. warranty_claims -> triage agent),
  // optionally instantiate an autonomous task.
  let taskId: string | null = null
  if (body.type === 'INSERT' && body.record) {
    try {
      const mappingRow = await c.env.DB.prepare(
        `SELECT squad_id, assignee_agent_id FROM task_intake_rules WHERE source = 'supabase' AND event_name = ?1 LIMIT 1`
      ).bind(body.table).first<{ squad_id: string; assignee_agent_id: string | null }>()

      if (mappingRow?.squad_id) {
        const task = await createTask(
          c.env,
          {
            squad_id: mappingRow.squad_id,
            title: `Supabase ${body.table} event (${body.type})`,
            body: JSON.stringify(body.record, null, 2),
            done_when: `Process and resolve Supabase ${body.table} trigger.`,
            assignee_agent_id: mappingRow.assignee_agent_id || null,
          },
          { skipMirror: true, actor: { kind: 'member', id: `supabase:${body.table}` } },
        )
        taskId = task.id
      }
    } catch {
      // Non-fatal if task_intake_rules table is empty or unpopulated
    }
  }

  return c.json({
    ok: true,
    event: eventName,
    table: body.table,
    type: body.type,
    task_id: taskId,
  })
})
