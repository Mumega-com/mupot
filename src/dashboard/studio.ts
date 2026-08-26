// Studio dispatch — launch governed work from the console, optionally through
// Cursor Cloud when CURSOR_API_TOKEN (or CURSOR_API_KEY) is bound.
//
// POST /api/studio/dispatch
//   { name, repo_url, prompt, model?, squad_id?, agent_id? }

import { Hono } from 'hono'
import { resolveCapabilities, holdsCapabilityFloor, isOrgAdmin } from '../auth/capability'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { createCursorAgent, resolveCursorApiToken } from '../cursor/client'
import { recordCursorCloudWork } from '../cursor/dispatch'
import { getAgent } from '../mcp/index'
import type { AuthContext, Env } from '../types'

type AppEnv = { Bindings: Env; Variables: { auth?: AuthContext } }

export const studioApp = new Hono<AppEnv>()

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sessionAuth(c: { get: (key: 'auth') => AuthContext | undefined }): AuthContext | null {
  try {
    return c.get('auth') ?? null
  } catch {
    return null
  }
}

async function resolveStudioAuth(c: {
  env: Env
  req: { header: (name: string) => string | undefined }
  get: (key: 'auth') => AuthContext | undefined
}): Promise<{ ok: true; auth: AuthContext } | { ok: false; status: 401 | 403; error: string }> {
  const existing = sessionAuth(c)
  if (existing) {
    if (isOrgAdmin(existing) || holdsCapabilityFloor(existing, 'member')) {
      return { ok: true, auth: existing }
    }
    return { ok: false, status: 403, error: 'forbidden' }
  }

  const identity = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!identity) return { ok: false, status: 401, error: 'unauthorized' }
  const capabilities = await resolveCapabilities(c.env, identity.memberId)
  const auth: AuthContext = {
    userId: identity.memberId,
    email: identity.email,
    role: 'member',
    tenant: c.env.TENANT_SLUG,
    memberId: identity.memberId,
    channel: 'workspace',
    capabilities,
    boundAgentId: identity.boundAgentId,
    tokenId: identity.tokenId,
  }
  if (!isOrgAdmin(auth) && !holdsCapabilityFloor(auth, 'member')) {
    return { ok: false, status: 403, error: 'forbidden' }
  }
  return { ok: true, auth }
}

studioApp.post('/dispatch', async (c) => {
  const resolved = await resolveStudioAuth(c)
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status)

  let body: Record<string, unknown>
  try {
    body = await c.req.json() as Record<string, unknown>
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const name = asTrimmed(body.name)
  const repoUrl = asTrimmed(body.repo_url)
  const prompt = asTrimmed(body.prompt)
  const model = asTrimmed(body.model) || undefined
  if (!name || !repoUrl || !prompt) {
    return c.json({ ok: false, error: 'invalid_args', detail: 'name, repo_url, and prompt are required' }, 400)
  }

  const requestedAgentId = asTrimmed(body.agent_id) || resolved.auth.boundAgentId || ''
  if (!requestedAgentId) {
    return c.json({ ok: false, error: 'agent_binding_required' }, 409)
  }
  const loaded = await getAgent(c.env, requestedAgentId)
  if (!loaded.ok) return c.json({ ok: false, error: loaded.error }, loaded.status)
  if (loaded.agent.status !== 'active') {
    return c.json({ ok: false, error: 'agent_inactive' }, 409)
  }

  const squadId = asTrimmed(body.squad_id) || loaded.agent.squad_id
  const token = resolveCursorApiToken(c.env)

  let cursor: { agent_id: string; run_id: string; agent_url: string } | null = null
  if (token) {
    try {
      const launched = await createCursorAgent(token, { name, repoUrl, prompt, model })
      cursor = {
        agent_id: launched.agent.id,
        run_id: launched.run.id,
        agent_url: launched.agent.url,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'cursor_api_error'
      return c.json({ ok: false, error: 'cursor_api_error', detail: message }, 502)
    }
  }

  const actor = resolved.auth.memberId
    ? { kind: 'member' as const, id: resolved.auth.memberId }
    : { kind: 'agent' as const, id: loaded.agent.id }

  try {
    const recorded = await recordCursorCloudWork(c.env, {
      name,
      repoUrl,
      prompt,
      squadId,
      agentId: loaded.agent.id,
      actor,
      cursor: cursor
        ? { agentId: cursor.agent_id, runId: cursor.run_id, agentUrl: cursor.agent_url }
        : undefined,
    })
    return c.json({
      ok: true,
      task_id: recorded.task.id,
      flight_id: recorded.flight.id,
      agent_id: cursor?.agent_id ?? null,
      run_id: cursor?.run_id ?? null,
      agent_url: cursor?.agent_url ?? null,
      cursor_launched: cursor !== null,
    })
  } catch {
    return c.json({ ok: false, error: 'cursor_record_failed' }, 500)
  }
})
