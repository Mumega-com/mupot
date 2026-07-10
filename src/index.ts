// mupot — Worker entry. The root Hono app mounts each component's router under
// the prefixes in ROUTES (src/types.ts). Components are built independently and
// register here. The Durable Object classes are re-exported for the runtime.
//
// S-MUPOT-OAUTH: The root Hono app is wrapped with OAuthProvider. The provider:
//   - Serves /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource
//     automatically (ahead of the dashboardApp '/' catch-all).
//   - Handles /token and /register automatically.
//   - Intercepts POST /mcp with a valid OAuth token → McpOAuthApiHandler.
//   - Intercepts POST /mcp with a non-OAuth bearer → resolveExternalToken (member API key).
//   - Falls through everything else to the root Hono app (defaultHandler).
// /authorize is mounted EXPLICITLY before the dashboardApp catch-all (line ~75).
//
// Subagents: implement your component as a Hono sub-app exported from its folder,
// then mount it below. Do NOT change other components' mounts.

import { Hono } from 'hono'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { Env } from './types'
import { ROUTES } from './types'
import { publicHealth } from './health'

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
import { eventIngestApp } from './events/ingest'
import { prospectsApp } from './loops/prospects-routes'
import { loopsApp } from './loops/routes'
import { fleetCheckinApp } from './fleet/checkin-routes'
import { fleetControlApp } from './fleet/control-routes'
import { fleetAttachApp } from './fleet/attach-routes'
import { flightsApp } from './flight/routes'
import { orientApp } from './orient/routes'
import { handleOAuthAuthorize, resolveExternalToken as memberKeyResolver } from './mcp/oauth-authorize'
import { McpOAuthApiHandler } from './mcp/oauth-api-handler'
import { brainPhysicsIngestApp } from './dashboard/brain-ingest'
import { billingAdminApp } from './billing/admin'
import { ccSpendApp } from './economy/cc-spend'
import { resellerApp } from './reseller/routes'
import { inboxApp } from './agents/inbox-routes'
import { coordinationApp } from './coordination/routes'

// Durable Object classes — implemented in src/agents/.
export { AgentDO } from './agents/agent-do'
export { SquadCoordinatorDO } from './agents/squad-do'
// Workflow class — the CF Workflows runtime discovers it via this named export.
// The class_name in [[workflows]] must match: "TaskWorkflow".
export { TaskWorkflow } from './workflows/task-workflow'
// OAuth API handler WorkerEntrypoint — referenced by the OAuthProvider's apiHandler.
export { McpOAuthApiHandler }

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json(publicHealth(c.env.TENANT_SLUG)))

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
// Generic event → task ingestion (feedback-loop act wiring). HMAC-verified by EVENT_INGEST_SECRET.
// Mounted BEFORE the dashboard '/' catch-all.
app.route('/api/events', eventIngestApp)
// GitHub weave: inbound webhook (HMAC-verified by GITHUB_WEBHOOK_SECRET) → work units.
app.route('/api/integrations/github', githubInboundApp)
app.route('/api/prospects', prospectsApp)
app.route('/api/loops', loopsApp)
// Flock check-in (Flock #45): agents POST presence with their member-token (bearer).
// Inbound only — the pot needs no egress. Mounted before the dashboard '/' catch-all.
app.route('/api/fleet', fleetCheckinApp)
app.route('/api/fleet', fleetControlApp)
// Agent self-attach/detach (Step 2a): the agent runtime reports ITSELF as running/stopped.
// member_id is auth-derived; an agent can only manage its own row.
app.route('/api/fleet', fleetAttachApp)
// Coherence-loop connector (#70): the brain dispatches gated flights + pulls outcomes,
// inbound (the pot stays sealed). Org-admin via member-token. Before the '/' catch-all.
app.route('/api/flights', flightsApp)
// Orient seam (#digid-hybrid S1): an agent reads its basin-drop packet; the mind pushes
// per-agent field state inbound. Before the '/' catch-all. See docs/superpowers/specs.
app.route('/api/orient', orientApp)
// Brain physics ingest (#138): the sovereign daemon POSTs coherence scalars here after
// each measure_and_log() cycle. Bearer-auth (admin token); stores to SESSIONS KV.
// Mounted before the dashboard '/' catch-all so /api/brain/* is not shadowed.
app.route('/api/brain', brainPhysicsIngestApp)
// Billing plan-setter (#175 S2): the central billing source (mumega Stripe webhook)
// writes the pot's plan_tier here, HMAC-verified by BILLING_PLAN_SECRET. Inbound,
// machine-to-machine. Before the dashboard '/' catch-all.
app.route('/api/billing', billingAdminApp)

// Squad Anthropic spend ingest (#179): the server transcript rollup pushes the
// squad's REAL Claude Code spend here, HMAC-verified by CC_SPEND_SECRET. Inbound,
// machine-to-machine. Before the dashboard '/' catch-all.
app.route('/api/economy', ccSpendApp)

// Reseller provisioning planner (#213 reseller program, slice 1): admin-gated, WRITE-FREE.
// Returns the deterministic reseller-pot stand-up recipe (slug/tier/squads/basket/fee/owner-walk).
// The live stand-up (CF account/repo/deploy/secrets/mint) is Hadi-go ops — this plans only.
// Before the dashboard '/' catch-all.
app.route('/api/reseller', resellerApp)

// Agent inbox HTTP mirror (squad → mupot, S3 follow-on): the bash wake-hooks poll the pot for
// delegations over HTTP (they can't speak MCP JSON-RPC). Member-bearer auth, self-scoped to the
// token's welded agent. Same pure service as the MCP send/inbox tools. Before the '/' catch-all.
app.route('/api/inbox', inboxApp)

// Control Tower (coordination board): agents board cross-project flights; the colony reads the
// departures board. Member-bearer auth, agent welded from the token. The rendered board page is
// dashboard /coordination. Before the '/' catch-all.
app.route('/api/coordination', coordinationApp)

// ── OAuth 2.1 authorize leg (C3) ─────────────────────────────────────────────
// /authorize and /oauth/google-callback must be mounted BEFORE the dashboardApp
// '/' catch-all so they are not shadowed by the Coming-Soon page.
// /token, /register, /.well-known/* are auto-served by the OAuthProvider wrapper —
// they never reach this Hono app (the OAuthProvider intercepts them first).
app.all('/authorize', async (c) => handleOAuthAuthorize(c.req.raw, c.env))
app.all('/oauth/google-callback', async (c) => handleOAuthAuthorize(c.req.raw, c.env))

app.route(ROUTES.dashboard, dashboardApp)

// ── OAuthProvider wrapper (S-MUPOT-OAUTH) ────────────────────────────────────
// The provider wraps the root Hono app as the defaultHandler. Paths it auto-handles:
//   /.well-known/oauth-authorization-server  (auto-synthesized from config)
//   /.well-known/oauth-protected-resource    (auto-synthesized from config)
//   /token                                   (auto-handled: code exchange, refresh)
//   /register                                (auto-handled: DCR RFC 7591)
//
// apiRoute: ['/mcp'] — only the MCP endpoint is OAuth-protected. All other paths
// fall through to defaultHandler (the Hono app above). This ensures:
//   - /health, /api/fleet, /actions/:tool, /openapi.json all bypass OAuth.
//   - POST /mcp with a valid OAuth token → McpOAuthApiHandler.
//   - POST /mcp with a non-OAuth bearer → resolveExternalToken (member API key path).
//
// C8: OAUTH_KV binding declared in wrangler.toml [[kv_namespaces]] binding="OAUTH_KV"
const oauthProvider = new OAuthProvider<Env>({
  apiRoute: ['/mcp'],
  apiHandler: McpOAuthApiHandler,

  // All non-OAuth paths fall through to the root Hono app.
  defaultHandler: {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  },

  // PKCE: S256 only (LOCK-OAuth-A parity with mumega).
  allowPlainPKCE: false,
  allowImplicitFlow: false,

  // Path-only specs so origin auto-resolves from the request URL.
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',

  scopesSupported: ['mcp:read', 'mcp:write'],

  // Token TTLs (matching mumega).
  refreshTokenTTL: 2592000,  // 30 days
  accessTokenTTL: 3600,      // 1 hour

  // C1: resolveExternalToken — for a bearer the OAuthProvider doesn't own (member
  // API key), run the authenticateMember-equivalent lookup (sha256 → member_tokens
  // WHERE revoked_at IS NULL → active member check) and return {props} on success.
  // The OAuthProvider calls this only when its internal KV lookup returns nothing.
  resolveExternalToken: async ({ token, env }) => {
    return memberKeyResolver(env as Env, token)
  },
})

// Queue consumer — the bus component owns the handler.
import { handleQueue } from './bus/consumer'
// Metabolism — the pot heartbeat that pulses goal-bearing work-units (#27 loop, made autonomous).
import { runMetabolism } from './agents/metabolism'
import { runLoopsTick } from './loops/driver'
import { syncGitHubProject } from './integrations/github-projects'
// Growth cron step — active-guarded, fail-soft collection of growth metrics each tick.
import { runGrowthCollection } from './departments/collectors/growth-cron'
import { runCroCollection } from './cro/collect'

export default {
  // The OAuth provider is the outer entry point. It handles OAuth paths and
  // dispatches authenticated /mcp requests to McpOAuthApiHandler. Everything
  // else falls through to the root Hono app via defaultHandler.
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    oauthProvider.fetch(req, env, ctx),

  // Queue and scheduled handlers are preserved unchanged (spec §A.2).
  queue: handleQueue,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Five independent heartbeats on the same */15 cron:
    //  1. membership sync — reconcile channel membership → squad capabilities.
    //  2. metabolism — kick goal-bearing agents so their goal loops actually run
    //     ("design loops, not prompts"; without this the v0.3.0 loop never fires).
    //  3. loop driver — run one cycle of each active Loop manifest (the container
    //     heartbeat; without this runLoopCycle has no scheduled caller).
    //  4. GitHub Project sync (#23) — reconcile the configured board → pot tasks
    //     (no-op unless GITHUB_SYNC_PROJECT is set; idempotent/KV-deduped).
    //  5. Growth collector — emit prospect-funnel metric_points for the pot's tenant.
    //     Only runs when the 'growth' department is active. Fail-soft: a collector
    //     error is caught and logged so it never breaks the rest of the cron.
    //     Logic: src/departments/collectors/growth-cron.ts (also unit-tested there).
    //  6. CRO ingest — pull EXTERNAL connector signal (PostHog, then GSC/Ads/CRM) into
    //     metric_points. Runs whatever sources are connected (graceful degradation); a
    //     missing/broken source never blocks. Fail-soft. Logic: src/cro/collect.ts.
    ctx.waitUntil(reconcileMembership(env))
    ctx.waitUntil(runMetabolism(env))
    ctx.waitUntil(runLoopsTick(env))
    ctx.waitUntil(syncGitHubProject(env).then(() => undefined))
    ctx.waitUntil(runGrowthCollection(env))
    ctx.waitUntil(runCroCollection(env).then(() => undefined))
  },
}
