// mupot — workflow-port inbound ingress (Port 5).
//
// POST /api/integrations/workflow/inbound
//
// Signed source-only: an external manager (n8n) may POST events INTO the pot,
// but NEVER holds approval authority. Verification = HMAC-SHA256 of the raw
// body against WORKFLOW_INBOUND_SECRET (header: x-mupot-workflow-signature).
// On valid inbound: create an open (ungated) observability task — operators
// decide next steps. Fail-closed when the secret is absent.

import { Hono } from 'hono'
import type { Env } from '../types'
import { createTask } from '../tasks/service'

interface WorkflowInboundEnv {
  WORKFLOW_INBOUND_SECRET?: string
  WORKFLOW_INBOUND_SQUAD_ID?: string
}

function inboundEnv(env: Env): WorkflowInboundEnv {
  return env as unknown as WorkflowInboundEnv
}

export const WORKFLOW_INBOUND_MAX_BODY_BYTES = 256 * 1024

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

async function computeHmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const workflowInboundApp = new Hono<{ Bindings: Env }>()

workflowInboundApp.post('/inbound', async (c) => {
  const secrets = inboundEnv(c.env)
  const secret = secrets.WORKFLOW_INBOUND_SECRET
  if (typeof secret !== 'string' || secret.length === 0) {
    return c.json({ ok: false, error: 'not_configured' }, 503)
  }

  const raw = await c.req.text()
  if (raw.length > WORKFLOW_INBOUND_MAX_BODY_BYTES) {
    return c.json({ ok: false, error: 'body_too_large' }, 413)
  }

  const header = c.req.header('x-mupot-workflow-signature') ?? ''
  const expected = await computeHmacHex(secret, raw)
  if (!timingSafeEqual(header.toLowerCase(), expected.toLowerCase())) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return c.json({ ok: false, error: 'invalid_body' }, 400)
  }
  const rec = parsed as Record<string, unknown>
  const summary =
    typeof rec.summary === 'string' && rec.summary.trim()
      ? rec.summary.trim().slice(0, 200)
      : 'workflow inbound event'
  const adapter =
    typeof rec.adapter === 'string' && rec.adapter.trim()
      ? rec.adapter.trim().slice(0, 32)
      : 'external'

  let squadId = secrets.WORKFLOW_INBOUND_SQUAD_ID
  if (typeof squadId !== 'string' || !squadId.trim()) {
    const row = await c.env.DB.prepare(`SELECT id FROM squads ORDER BY created_at ASC LIMIT 1`)
      .first<{ id: string }>()
    squadId = row?.id
  }
  if (!squadId) {
    return c.json({ ok: false, error: 'no_squad' }, 503)
  }

  // Source-only: create an open observability task. No auto-approval, no act fire.
  const task = await createTask(
    c.env,
    {
      squad_id: squadId,
      title: summary,
      body: JSON.stringify({ source: 'workflow_inbound', adapter, payload: rec }),
      done_when: 'Operator reviewed the inbound workflow event',
      status: 'open',
    },
    { skipMirror: true },
  )

  return c.json({ ok: true, task_id: task.id }, 201)
})
