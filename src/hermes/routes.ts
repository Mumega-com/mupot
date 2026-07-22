// mupot — Hermes constant-agent HTTP surface (Port 3).
//
// POST /chat — member-bearer chat with Hermes-Sol (Luna triage → Sol reasoning →
// Opus wake). Used by the Hermes daemon and any non-cookie client.
// The dashboard panel at GET /hermes (cookie auth) posts through a twin route
// under the dashboard app so CSRF + session cookies stay consistent.
//
// Auth: member bearer, same pattern as /api/presence and /api/inbox. Identity is
// ALWAYS derived from the token — never from the body.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { handleHermesTurn } from './constant'

type AppEnv = { Bindings: Env }

export const HERMES_CHAT_MAX_CHARS = 4000

export const hermesApp = new Hono<AppEnv>()

hermesApp.get('/', (c) =>
  c.json({
    ok: true,
    service: 'hermes-constant',
    tiers: ['luna', 'sol', 'opus'],
    chat: 'POST /api/hermes/chat',
  }),
)

hermesApp.post('/chat', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ ok: false, error: 'unauthorized' }, 401)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ ok: false, error: 'invalid_body' }, 400)
  }
  const record = body as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (!message) return c.json({ ok: false, error: 'message_required' }, 400)
  if (message.length > HERMES_CHAT_MAX_CHARS) {
    return c.json({ ok: false, error: 'message_too_long', max: HERMES_CHAT_MAX_CHARS }, 400)
  }
  const projectId =
    typeof record.project_id === 'string' && record.project_id.trim()
      ? record.project_id.trim()
      : null
  const squadId =
    typeof record.squad_id === 'string' && record.squad_id.trim()
      ? record.squad_id.trim()
      : null

  try {
    const result = await handleHermesTurn(c.env, {
      message,
      memberId: id.memberId,
      projectId,
      squadId,
    })
    return c.json({
      ok: true,
      reply: result.reply,
      route: result.route,
      task_id: result.taskId,
      woke_opus_agent_id: result.wokeOpusAgentId,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'hermes_turn_failed'
    console.error('hermes.chat failed', { reason })
    return c.json({ ok: false, error: 'hermes_turn_failed' }, 500)
  }
})
