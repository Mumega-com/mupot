// Member-scoped Hermes proxy — Open WebUI / browser talk as the bound member agent.
// Cookie session OR member bearer. Never exposes hermes_api connector secrets.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth } from '../auth'
import type { AuthContext, Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import {
  HermesSurfacesError,
  hermesSessionKeyForMember,
  resolveMemberHermesEndpoint,
} from '../hermes-surfaces/bindings'
import {
  chatTurn,
  createSession,
  listMessages,
  listSessions,
  KayhermesClientError,
  type KayhermesConfig,
} from '../kayhermes/client'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext; memberId: string } }

export const memberHermesApp = new Hono<AppEnv>()

async function resolveCallerMemberId(
  env: Env,
  authorization: string | undefined,
  loadSessionMember: () => Promise<{ memberId: string | null } | null>,
): Promise<string | null> {
  const token = bearerToken(authorization)
  if (token) {
    const id = await resolveMemberByToken(env, token)
    return id?.memberId ?? null
  }
  const session = await loadSessionMember()
  return session?.memberId ?? null
}

memberHermesApp.use('*', async (c, next) => {
  const memberId = await resolveCallerMemberId(
    c.env,
    c.req.header('authorization'),
    async () => {
      let proceeded = false
      await requireAuth(
        c as unknown as Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
        async () => {
          proceeded = true
        },
      )
      if (!proceeded) return null
      const auth = c.get('auth')
      if (!auth || auth.tenant !== c.env.TENANT_SLUG) return null
      if (auth.memberId) return { memberId: auth.memberId }
      if (auth.email) {
        const member = await c.env.DB.prepare(
          "SELECT id FROM members WHERE lower(email) = lower(?1) AND tenant = ?2 AND status = 'active' LIMIT 1",
        )
          .bind(auth.email, c.env.TENANT_SLUG)
          .first<{ id: string }>()
        return { memberId: member?.id ?? null }
      }
      return { memberId: null }
    },
  )
  if (!memberId) return c.json({ error: 'unauthorized' }, 401)
  c.set('memberId', memberId)
  await next()
})

function mapErr(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof HermesSurfacesError) {
    const status = err.code === 'not_bound' || err.code === 'hermes_api_unconfigured' ? 503 : 400
    return c.json({ error: err.code, detail: err.message }, status)
  }
  if (err instanceof KayhermesClientError) {
    const status = (err.status >= 400 && err.status <= 599 ? err.status : 502) as 400 | 502 | 503
    return c.json({ error: err.code, detail: err.message }, status)
  }
  return c.json({ error: 'internal' }, 500)
}

async function endpointFor(c: Context<AppEnv>): Promise<KayhermesConfig & { agentId: string }> {
  const memberId = c.get('memberId')
  const ep = await resolveMemberHermesEndpoint(c.env, memberId)
  return { baseUrl: ep.baseUrl, apiKey: ep.apiKey, agentId: ep.agentId }
}

memberHermesApp.get('/status', async (c) => {
  try {
    const ep = await endpointFor(c)
    return c.json({
      bound: true,
      agent_id: ep.agentId,
      session_key: hermesSessionKeyForMember(c.get('memberId')),
    })
  } catch (err) {
    if (err instanceof HermesSurfacesError && err.code === 'not_bound') {
      return c.json({ bound: false, agent_id: null }, 200)
    }
    return mapErr(c, err)
  }
})

memberHermesApp.get('/sessions', async (c) => {
  try {
    const config = await endpointFor(c)
    const sessions = await listSessions(config, { limit: 30, offset: 0 })
    return c.json({ sessions, agent_id: config.agentId })
  } catch (err) {
    return mapErr(c, err)
  }
})

memberHermesApp.post('/sessions', async (c) => {
  try {
    const config = await endpointFor(c)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null
    const session = await createSession(config, title && title.length > 0 ? title : null)
    return c.json({ session, agent_id: config.agentId })
  } catch (err) {
    return mapErr(c, err)
  }
})

memberHermesApp.get('/sessions/:id/messages', async (c) => {
  try {
    const config = await endpointFor(c)
    const messages = await listMessages(config, c.req.param('id'))
    return c.json({ messages })
  } catch (err) {
    return mapErr(c, err)
  }
})

memberHermesApp.post('/sessions/:id/chat', async (c) => {
  try {
    const config = await endpointFor(c)
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; text?: unknown }
    const input =
      typeof body.input === 'string' ? body.input : typeof body.text === 'string' ? body.text : ''
    const result = await chatTurn(config, c.req.param('id'), input)
    return c.json({ ...result, agent_id: config.agentId })
  } catch (err) {
    return mapErr(c, err)
  }
})

/** OpenAI-compatible chat completions — for Open WebUI pointing at this proxy. */
memberHermesApp.post('/v1/chat/completions', async (c) => {
  try {
    const config = await endpointFor(c)
    const memberId = c.get('memberId')
    const body = (await c.req.json()) as {
      messages?: Array<{ role?: string; content?: string }>
      stream?: boolean
    }
    if (body.stream) return c.json({ error: 'streaming_not_supported' }, 400)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')
    if (!lastUser?.content?.trim()) return c.json({ error: 'empty_input' }, 400)

    // One-shot session per turn for Open WebUI simplicity; session continuity via Hermes header key.
    const session = await createSession(config, `owui-${memberId.slice(0, 8)}`)
    const turn = await chatTurn(config, session.id, lastUser.content)
    return c.json({
      id: `chatcmpl-${session.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'hermes-agent',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: turn.reply },
          finish_reason: 'stop',
        },
      ],
    })
  } catch (err) {
    return mapErr(c, err)
  }
})

memberHermesApp.get('/v1/models', async (c) => {
  try {
    const ep = await endpointFor(c)
    return c.json({
      object: 'list',
      data: [{ id: 'hermes-agent', object: 'model', owned_by: ep.agentId }],
    })
  } catch (err) {
    return mapErr(c, err)
  }
})
