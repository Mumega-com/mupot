// mupot — presence HTTP mirror (Module Kernel, Port 1). GET /api/presence?project=<id>
// for non-MCP callers (e.g. the Hermes daemon) that can't speak MCP JSON-RPC — the
// same shape as src/agents/inbox-routes.ts's HTTP mirror of the MCP inbox tools.
//
// Auth: the caller's pot member-token (bearer), resolved server-side via
// resolveMemberByToken (src/auth/member-bearer.ts) — the SAME primitive
// src/fleet/checkin-routes.ts and src/agents/inbox-routes.ts use. Generic 401 on any
// failure (no oracle between "missing" and "bad" token). Read-only: this route never
// registers/heartbeats/deregisters anything — see src/mcp/presence.ts for the mutating
// twin (MCP tools presence_register/heartbeat/deregister).
//
// AUTHZ mirrors the MCP presence_list tool exactly (src/mcp/presence.ts): a caller may
// read a project's roster only if it can already read that project (readAccess +
// readableProject, src/mcp/projects.ts). `project` omitted or explicitly empty
// requires org:admin (the unscoped/no-project view is a wider disclosure than any one
// project's roster).

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { readAccess, readableProject } from '../mcp/projects'
import { listPresence } from './service'

export const presenceApp = new Hono<{ Bindings: Env }>()

presenceApp.get('/', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401) // no auth oracle

  const grants = await resolveCapabilities(c.env, id.memberId)
  const isAdmin = hasCapability(grants, 'org', null, 'admin')

  // Build the minimal AuthContext shape readAccess/readableProject need — same
  // fields authenticateMember produces for an MCP caller, so the two entry points
  // resolve the identical visibility decision for the identical grants.
  const pseudoAuth: AuthContext = {
    userId: id.memberId,
    email: id.email,
    role: 'member',
    tenant: c.env.TENANT_SLUG,
    memberId: id.memberId,
    channel: 'workspace',
    capabilities: grants,
    boundAgentId: id.boundAgentId,
  }

  const projectQuery = c.req.query('project')
  if (projectQuery === undefined || projectQuery === '') {
    if (!isAdmin) return c.json({ error: 'forbidden', need: 'org:admin' }, 403)
    const modules = await listPresence(c.env, {})
    return c.json({ modules })
  }

  const access = readAccess(pseudoAuth)
  const project = await readableProject(c.env, projectQuery, access)
  if (!project) return c.json({ error: 'project_not_found' }, 404)

  const modules = await listPresence(c.env, { projectId: projectQuery })
  return c.json({ modules })
})
