// mupot — presence HTTP mirror (Module Kernel, Port 1). GET /api/presence?project=<id>
// for non-MCP callers (e.g. the Hermes daemon) that can't speak MCP JSON-RPC — the
// same shape as src/agents/inbox-routes.ts's HTTP mirror of the MCP inbox tools.
// GET /api/presence/live?project=<id> — gated WebSocket upgrade onto PresenceChannelDO
// (ADR #473); off until REALTIME_PRESENCE=1.
//
// Auth: the caller's pot member-token (bearer), resolved server-side via
// resolveMemberByToken (src/auth/member-bearer.ts) — the SAME primitive
// src/fleet/checkin-routes.ts and src/agents/inbox-routes.ts use. Generic 401 on any
// failure (no oracle between "missing" and "bad" token). Read-only for / ; /live is
// subscribe-only (mutations stay on MCP presence_* tools).
//
// AUTHZ mirrors the MCP presence_list tool's PROJECT-VISIBILITY decision (src/mcp/
// presence.ts): a caller may read a project's roster only if it can already read
// that project (readAccess + readableProject, src/mcp/projects.ts), and `project`
// omitted or explicitly empty requires org:admin (the unscoped/no-project view is a
// wider disclosure than any one project's roster). One difference from the MCP
// surface: presence_list also sits behind invokeTool's central `min:'observer'`
// capability floor (src/mcp/index.ts), so a grantless caller is rejected there
// (403 forbidden) before the project check ever runs. This HTTP route has no
// equivalent floor, so a grantless caller instead falls through to the
// readableProject check below and gets 404 project_not_found (readableProject
// fails closed for a caller with no grants — same safe outcome, different
// status/error shape). Not a security gap: both paths deny access; only the
// response shape differs between the two entry points.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { readAccess, readableProject } from '../mcp/projects'
import { listPresence } from './service'
import {
  isRealtimePresenceEnabled,
  presenceChannelName,
} from './realtime'

export const presenceApp = new Hono<{ Bindings: Env }>()

async function authorizePresenceRead(
  env: Env,
  authorizationHeader: string | undefined,
  projectQuery: string | undefined,
): Promise<
  | { ok: true; projectId: string | null | undefined }
  | { ok: false; status: 401 | 403 | 404; body: Record<string, unknown> }
> {
  const id = await resolveMemberByToken(env, bearerToken(authorizationHeader))
  if (!id) return { ok: false, status: 401, body: { error: 'unauthorized' } }

  const grants = await resolveCapabilities(env, id.memberId)
  const isAdmin = hasCapability(grants, 'org', null, 'admin')

  const pseudoAuth: AuthContext = {
    userId: id.memberId,
    email: id.email,
    role: 'member',
    tenant: env.TENANT_SLUG,
    memberId: id.memberId,
    channel: 'workspace',
    capabilities: grants,
    boundAgentId: id.boundAgentId,
  }

  if (projectQuery === undefined || projectQuery === '') {
    if (!isAdmin) return { ok: false, status: 403, body: { error: 'forbidden', need: 'org:admin' } }
    return { ok: true, projectId: undefined }
  }

  const access = readAccess(pseudoAuth)
  const project = await readableProject(env, projectQuery, access)
  if (!project) return { ok: false, status: 404, body: { error: 'project_not_found' } }
  return { ok: true, projectId: projectQuery }
}

presenceApp.get('/', async (c) => {
  const authz = await authorizePresenceRead(c.env, c.req.header('authorization'), c.req.query('project'))
  if (!authz.ok) return c.json(authz.body, authz.status)

  const modules =
    authz.projectId === undefined
      ? await listPresence(c.env, {})
      : await listPresence(c.env, { projectId: authz.projectId })
  return c.json({ modules })
})

// GET /api/presence/live?project=<id> — WebSocket upgrade onto PresenceChannelDO.
// Gated: absent REALTIME_PRESENCE=1 (or missing binding) → 404 realtime_disabled so
// pots without a live surface keep the query-time roster only (ADR #473 deferred path).
presenceApp.get('/live', async (c) => {
  if (!isRealtimePresenceEnabled(c.env) || !c.env.PRESENCE_CHANNEL) {
    return c.json({ error: 'realtime_disabled' }, 404)
  }
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected_websocket' }, 426)
  }

  const authz = await authorizePresenceRead(c.env, c.req.header('authorization'), c.req.query('project'))
  if (!authz.ok) return c.json(authz.body, authz.status)

  // Live channel is project-scoped (one DO per project). Tenant-wide (admin, no
  // project) is not a WebSocket channel — use GET /api/presence for that snapshot.
  if (authz.projectId === undefined) {
    return c.json({ error: 'project_required' }, 400)
  }

  const channelProjectId: string | null = authz.projectId
  const stub = c.env.PRESENCE_CHANNEL.get(
    c.env.PRESENCE_CHANNEL.idFromName(presenceChannelName(c.env.TENANT_SLUG, channelProjectId)),
  )
  const doUrl = new URL('https://presence-channel/subscribe')
  if (channelProjectId !== null) doUrl.searchParams.set('project', channelProjectId)
  return stub.fetch(new Request(doUrl.toString(), c.req.raw))
})
