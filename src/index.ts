// mupot — Worker entry. The root Hono app mounts each component's router under
// the prefixes in ROUTES (src/types.ts). Components are built independently and
// register here. The Durable Object classes are re-exported for the runtime.
//
// Subagents: implement your component as a Hono sub-app exported from its folder,
// then mount it below. Do NOT change other components' mounts.

import { Hono } from 'hono'
import type { Env } from './types'
import { ROUTES } from './types'

// Component routers (each subagent fills these in their folder).
// Stubs are provided so the app type-checks before all components land.
import { authApp } from './auth'
import { orgApp } from './org'
import { agentsApp } from './agents'
import { tasksApp } from './tasks'
import { busApp } from './bus'
import { membersApp } from './members'
import { mcpApp } from './mcp'
import { imApp } from './im'
import { dashboardApp } from './dashboard'
import { channelsApp, reconcileMembership } from './channels'
import { channelsAdminApp } from './channels/admin'

// Durable Object classes — implemented in src/agents/.
export { AgentDO } from './agents/agent-do'
export { SquadCoordinatorDO } from './agents/squad-do'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ ok: true, service: 'mupot', tenant: c.env.TENANT_SLUG }))

app.route(ROUTES.auth, authApp)
app.route(ROUTES.org, orgApp)
app.route(ROUTES.agents, agentsApp)
app.route(ROUTES.tasks, tasksApp)
app.route(ROUTES.bus, busApp)
app.route(ROUTES.members, membersApp)
app.route(ROUTES.mcp, mcpApp)
app.route(ROUTES.im, imApp)
// channel adapters: the scoped webhook (/channels/:platform/webhook) + binding admin.
// Mounted BEFORE the dashboard '/' catch-all so the specific prefixes win.
app.route('/channels', channelsApp)
app.route('/api/channels', channelsAdminApp)
app.route(ROUTES.dashboard, dashboardApp)

// Queue consumer — the bus component owns the handler.
import { handleQueue } from './bus/consumer'

export default {
  fetch: app.fetch,
  queue: handleQueue,
  // membership sync: reconcile channel membership → squad capabilities on a schedule.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileMembership(env))
  },
}
