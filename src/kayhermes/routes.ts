// Owner-gated KayHermes chat proxy — /api/kayhermes/*
//
// Browser never sees KAYHERMES_API_KEY. Session cookie auth + owner role required.
// Upstream = Hermes Sessions API (Open WebUI-style integration).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth } from '../auth'
import type { AuthContext, Env } from '../types'
import {
  KayhermesClientError,
  chatTurn,
  createSession,
  kayhermesConfigured,
  listMessages,
  listSessions,
  probeHealth,
  resolveKayhermesConfig,
} from './client'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const kayhermesApp = new Hono<AppEnv>()

kayhermesApp.use('*', requireAuth)

function requireOwner(c: Context<AppEnv>): Response | null {
  const auth = c.get('auth')
  if (!auth || auth.role !== 'owner') {
    return c.json({ error: 'forbidden', need: 'owner' }, 403)
  }
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', need: 'tenant' }, 403)
  }
  return null
}

function mapClientError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof KayhermesClientError) {
    const status = (err.status >= 400 && err.status <= 599 ? err.status : 502) as
      | 400
      | 401
      | 403
      | 404
      | 413
      | 502
      | 503
    return c.json({ error: err.code, detail: err.message }, status)
  }
  return c.json({ error: 'internal' }, 500)
}

async function readJsonCapped(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'bad_json' }> {
  const len = c.req.header('content-length')
  if (len && Number(len) > maxBytes) return { ok: false, reason: 'too_large' }
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' }
  if (buf.byteLength === 0) return { ok: true, value: {} }
  let text: string
  try {
    text = new TextDecoder('utf-8').decode(buf)
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
}

kayhermesApp.get('/status', async (c) => {
  const denied = requireOwner(c)
  if (denied) return denied
  if (!kayhermesConfigured(c.env)) {
    return c.json({ configured: false, healthy: false })
  }
  try {
    const config = resolveKayhermesConfig(c.env)
    const health = await probeHealth(config)
    return c.json({ configured: true, healthy: health.ok, detail: health.detail })
  } catch (err) {
    return mapClientError(c, err)
  }
})

kayhermesApp.get('/sessions', async (c) => {
  const denied = requireOwner(c)
  if (denied) return denied
  try {
    const config = resolveKayhermesConfig(c.env)
    const limitRaw = Number(c.req.query('limit') ?? '30')
    const offsetRaw = Number(c.req.query('offset') ?? '0')
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 30
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0
    const sessions = await listSessions(config, { limit, offset })
    return c.json({ sessions })
  } catch (err) {
    return mapClientError(c, err)
  }
})

kayhermesApp.post('/sessions', async (c) => {
  const denied = requireOwner(c)
  if (denied) return denied
  const parsed = await readJsonCapped(c, 4096)
  if (!parsed.ok) return c.json({ error: parsed.reason }, parsed.reason === 'too_large' ? 413 : 400)
  const body = parsed.value as { title?: unknown }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null
  try {
    const config = resolveKayhermesConfig(c.env)
    const session = await createSession(config, title && title.length > 0 ? title : null)
    return c.json({ session })
  } catch (err) {
    return mapClientError(c, err)
  }
})

kayhermesApp.get('/sessions/:id/messages', async (c) => {
  const denied = requireOwner(c)
  if (denied) return denied
  try {
    const config = resolveKayhermesConfig(c.env)
    const messages = await listMessages(config, c.req.param('id'))
    return c.json({ messages })
  } catch (err) {
    return mapClientError(c, err)
  }
})

kayhermesApp.post('/sessions/:id/chat', async (c) => {
  const denied = requireOwner(c)
  if (denied) return denied
  const parsed = await readJsonCapped(c, 16_384)
  if (!parsed.ok) return c.json({ error: parsed.reason }, parsed.reason === 'too_large' ? 413 : 400)
  const body = parsed.value as { input?: unknown; text?: unknown }
  const input =
    typeof body.input === 'string' ? body.input : typeof body.text === 'string' ? body.text : ''
  try {
    const config = resolveKayhermesConfig(c.env)
    const result = await chatTurn(config, c.req.param('id'), input)
    return c.json(result)
  } catch (err) {
    return mapClientError(c, err)
  }
})
