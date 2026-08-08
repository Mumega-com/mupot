import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AuthContext, Env } from '../types'
import { bearerToken, resolveMemberByToken, type AgentIdentity } from '../auth/member-bearer'
import { resolveCapabilities } from '../auth/capability'
import { invokeHostTool, type ToolOutcome } from '../mcp'

const MAX_BODY_BYTES = 16_384

export const runtimeEndpointsApp = new Hono<{ Bindings: Env }>()
runtimeEndpointsApp.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
})

type ParsedBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string }

async function readJsonObject(c: Context<{ Bindings: Env }>): Promise<ParsedBody> {
  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'invalid_body' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
}

async function bearerAuth(c: Context<{ Bindings: Env }>): Promise<AuthContext | null> {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return null
  return authContext(c.env, id)
}

async function authContext(env: Env, id: AgentIdentity): Promise<AuthContext> {
  return {
    userId: id.memberId,
    memberId: id.memberId,
    email: id.email ?? '',
    role: 'member',
    tenant: env.TENANT_SLUG,
    channel: 'workspace',
    boundAgentId: id.boundAgentId,
    capabilities: await resolveCapabilities(env, id.memberId),
  }
}

function response(c: Context<{ Bindings: Env }>, outcome: ToolOutcome) {
  if (outcome.ok) return c.json(outcome.result)
  return c.json(
    {
      error: outcome.error,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    },
    outcome.status as 400 | 401 | 403 | 404 | 409 | 413 | 500,
  )
}

async function runBodyTool(
  c: Context<{ Bindings: Env }>,
  tool: string,
) {
  const auth = await bearerAuth(c)
  if (!auth) return c.json({ error: 'unauthorized' }, 401)
  const parsed = await readJsonObject(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  return response(c, await invokeHostTool(auth, c.env, tool, parsed.value, new URL(c.req.url).origin))
}

runtimeEndpointsApp.post('/check-in', (c) => runBodyTool(c, 'runtime_endpoint_check_in'))
runtimeEndpointsApp.post('/heartbeat', (c) => runBodyTool(c, 'runtime_endpoint_heartbeat'))
runtimeEndpointsApp.post('/revoke', (c) => runBodyTool(c, 'runtime_endpoint_revoke'))
runtimeEndpointsApp.post('/send', (c) => runBodyTool(c, 'runtime_endpoint_send'))
runtimeEndpointsApp.post('/inbox', (c) => runBodyTool(c, 'runtime_endpoint_inbox'))
runtimeEndpointsApp.post('/accept', (c) => runBodyTool(c, 'runtime_endpoint_accept'))
runtimeEndpointsApp.post('/reject', (c) => runBodyTool(c, 'runtime_endpoint_reject'))

runtimeEndpointsApp.get('/', async (c) => {
  const auth = await bearerAuth(c)
  if (!auth) return c.json({ error: 'unauthorized' }, 401)
  const projectId = c.req.query('project_id')
  return response(c, await invokeHostTool(
    auth,
    c.env,
    'runtime_endpoint_list',
    projectId ? { project_id: projectId } : {},
    new URL(c.req.url).origin,
  ))
})
