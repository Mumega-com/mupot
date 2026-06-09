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
import { tasksApp, gatesApp } from './tasks'
import { busApp } from './bus'
import { membersApp } from './members'
import { mcpActionsApp, mcpApp } from './mcp'
import { imApp } from './im'
import { dashboardApp } from './dashboard'
import { channelsApp, reconcileMembership } from './channels'
import { channelsAdminApp } from './channels/admin'
import { ghlInboundApp } from './integrations/ghl-routes'
import { githubInboundApp } from './integrations/github-routes'
import { prospectsApp } from './loops/prospects-routes'
import { loopsApp } from './loops/routes'
import { fleetCheckinApp } from './fleet/checkin-routes'
import { flightsApp } from './flight/routes'
import { orientApp } from './orient/routes'

// Durable Object classes — implemented in src/agents/.
export { AgentDO } from './agents/agent-do'
export { SquadCoordinatorDO } from './agents/squad-do'
// Workflow class — the CF Workflows runtime discovers it via this named export.
// The class_name in [[workflows]] must match: "TaskWorkflow".
export { TaskWorkflow } from './workflows/task-workflow'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ ok: true, service: 'mupot', tenant: c.env.TENANT_SLUG }))

app.route(ROUTES.auth, authApp)
app.route(ROUTES.org, orgApp)
app.route(ROUTES.agents, agentsApp)
app.route(ROUTES.tasks, tasksApp)
// K3: gate grant management (owner/admin only)
app.route('/api/gates', gatesApp)
app.route(ROUTES.bus, busApp)
app.route(ROUTES.members, membersApp)
app.route(ROUTES.mcp, mcpApp)
app.route('/', mcpActionsApp)
app.route(ROUTES.im, imApp)
// channel adapters: the scoped webhook (/channels/:platform/webhook) + binding admin.
// Mounted BEFORE the dashboard '/' catch-all so the specific prefixes win.
app.route('/channels', channelsApp)
app.route('/api/channels', channelsAdminApp)
// GHL act-channel: inbound webhook (unauthenticated by session; verified by HMAC secret).
// Mounted BEFORE the dashboard '/' catch-all so /api/integrations/ghl/* wins.
app.route('/api/integrations/ghl', ghlInboundApp)
// GitHub weave: inbound webhook (HMAC-verified by GITHUB_WEBHOOK_SECRET) → work units.
app.route('/api/integrations/github', githubInboundApp)
app.route('/api/prospects', prospectsApp)
app.route('/api/loops', loopsApp)
// Flock check-in (Flock #45): agents POST presence with their member-token (bearer).
// Inbound only — the pot needs no egress. Mounted before the dashboard '/' catch-all.
app.route('/api/fleet', fleetCheckinApp)
// Coherence-loop connector (#70): the brain dispatches gated flights + pulls outcomes,
// inbound (the pot stays sealed). Org-admin via member-token. Before the '/' catch-all.
app.route('/api/flights', flightsApp)
// Orient seam (#digid-hybrid S1): an agent reads its basin-drop packet; the mind pushes
// per-agent field state inbound. Before the '/' catch-all. See docs/superpowers/specs.
app.route('/api/orient', orientApp)
app.route(ROUTES.dashboard, dashboardApp)

// Queue consumer — the bus component owns the handler.
import { handleQueue } from './bus/consumer'
// Metabolism — the pot heartbeat that pulses goal-bearing work-units (#27 loop, made autonomous).
import { runMetabolism } from './agents/metabolism'
import { runLoopsTick } from './loops/driver'

export default {
  fetch: app.fetch,
  queue: handleQueue,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Three independent heartbeats on the same cron:
    //  1. membership sync — reconcile channel membership → squad capabilities.
    //  2. metabolism — kick goal-bearing agents so their goal loops actually run
    //     ("design loops, not prompts"; without this the v0.3.0 loop never fires).
    //  3. loop driver — run one cycle of each active Loop manifest (the container
    //     heartbeat; without this runLoopCycle has no scheduled caller).
    ctx.waitUntil(reconcileMembership(env))
    ctx.waitUntil(runMetabolism(env))
    ctx.waitUntil(runLoopsTick(env))
  },
}
