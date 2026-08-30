// mupot — dashboard (server-rendered HTML console, no build step).
//
// This is the SUBSTRATE UI: it shows org STRUCTURE (departments → squads →
// agents), a squad board, and a per-agent console with a 'wake' button. It is
// NOT the tenant's business content — the pot, not the plant.
//
// dashboardApp — mounted at ROUTES.dashboard ('/'):
//   GET /                  org overview (dept → squad → agent tree)
//   GET /squads/:id        squad board (charter + agents + tasks)
//   GET /agents/:id        agent console (status + a 'wake' button)
//   GET /copilot, /chat    dedicated Co-Pilot page (drawer also lives in shell())
//   POST /api/studio/chat  SSE token stream for Co-Pilot
//
// Auth: gated by requireAuth. Because these are HTML pages (not an API),
// unauthenticated requests are REDIRECTED to /auth/login rather than handed a
// 401 JSON body. We run the auth component's requireAuth and, if it produced an
// unauthenticated (4xx) response, swap it for a redirect.
//
// Data: rendered directly from this tenant's D1 (env.DB). One pot = one DB, so
// the org tables carry no tenant column; we still HARD GUARD that the caller's
// AuthContext.tenant matches env.TENANT_SLUG so a misrouted token can never read
// another pot. The wake action is performed by the browser POSTing to the
// RBAC-gated /api/agents/:id/wake endpoint owned by the agents component.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { TASK_SELECT_COLUMNS, actionableStatusOrderSql, priorityOrderSql } from '../tasks/ranking'
import { MUPOT_FAVICON_32_PNG_B64, MUPOT_MARK_64_PNG_B64 } from './brand-assets'
import type {
  Env,
  AuthContext,
  Department,
  Squad,
  Agent,
  Task,
  Project,
  Member,
  CapabilityGrant,
  Capability,
  CapabilityScopeType,
  ConnectionChannel,
} from '../types'

import { requireAuth } from '../auth'
// Fine-grained RBAC — the dashboard's mutating handlers reuse the SAME gates the
// JSON API uses (admin on org for tokens / departments; admin on the department for
// a squad; lead on the squad for an agent). Identity is always server-derived.
import {
  resolveCapabilities,
  hasCapability,
  actorMaxRankOnScope,
  hasSurfaceCap,
  isOrgAdmin,
  holdsCapabilityFloor,
} from '../auth/capability'
// Legible refusals (#530 follow-on): a 403 that names the signed-in principal and
// their actual standing, not just the requirement they failed. See src/auth/refusal.ts.
import { orgAdminRefusalLines, orgAdminForbiddenPayload, ORG_ADMIN_REFUSAL_LINKS } from '../auth/refusal'
// FLIGHT-001 #797 — the shared "which squads can this caller read" primitive
// (extracted from dashboard/agents-admin.ts's accessibleSquadIds, #796), reused
// to scope /fleet's roster + presence and /brain's loop feed.
import { resolveAccessibleSquadIds } from '../projects/readable-squads'

// Shared creation paths — the dashboard handlers call the SAME service functions
// the /api routes call, never re-implementing the write/validation logic.
import { createDepartment, createSquad, createAgent, setAgentStatus, deleteAgent, updateUnitConfig } from '../org/service'
import type { UnitConfigPatch } from '../org/service'
import { createProject, getProject, updateProject } from '../projects/service'
import { defaultStartGateDeps, startProject } from '../projects/start-gate'
import { SQUAD_PACKS, seedSquadPack } from '../org/squad-packs'
import { mintMemberToken, revokeMemberToken, loadLiveTokens, isChannel } from '../members/service'
import type { MintedToken, PublicMemberToken } from '../members/service'

// Scoped-key mint UI (#deliverable-2).
import { loadKeysView, mintScopedKey, keysPageBody, keysMintedBody } from './keys'
import { findPreset, isValidPresetId } from '../auth/role-presets'

// Agent-bound token mint UI.
import { loadAgentTokenView, agentTokenPageBody, agentTokenMintedBody } from './agent-token'
import { loadControlCenterView, controlCenterPageBody } from './control-center'
import { loadJoinPreview, confirmJoin, joinPreviewPageBody, joinConfirmedBody } from './join-agent'
import { mintAgentBoundToken, isAgentTokenCapability } from '../members/service'
import { resolveAgentRef } from '../org/resolve'

// Connect-config builders (pure) for the Connect card.
import {
  mcpEndpoint,
  claudeCodeSnippet,
  codexSnippet,
  cursorSnippet,
  requiredCanonicalOrigin,
} from './connect'
import { loadApprovals, loadPublishable, resultPreview } from './approvals'
import { CONTENT_DEPARTMENT_KEY } from '../agents/execute'
// Secret-env approvals (Task 5): the paste-capable admin section on /approvals —
// this is deliberately NOT the task_verdict queue above, since paste fields
// cannot go through the generic verdict endpoint. Service functions are the
// SAME ones the MCP surface calls; the dashboard never reimplements custody.
import {
  secretEnvApprovalsSection,
  secretEnvBoundBody,
  secretEnvRejectedBody,
  secretEnvErrorBody,
} from './secret-env'
import { listPendingSecretEnvRequests, bindSecretEnv, rejectSecretEnv } from '../secret-env/service'
import type { PublicSecretEnvRequest } from '../secret-env/types'
import { loadLoopsView, loopsBody } from './loops'
import { loadEconomy, economyBody, loadTodaySpendScalar } from './economy'
import { loadDeployment, deploymentBody } from './deployment'
import { loadVerifications, verificationsBody, athenaGateReceiptsBody } from './verifications'
import { listAthenaGateReceipts } from '../athena/webhook'
import { loadAudit, auditBody } from './audit'
import { loadBilling, billingBody } from './billing'
import { servicesBody } from './services'
import {
  addonsBody,
  createAddonConsoleResolver,
  installedAddonIdentityMatches,
  latestInstallationByKey,
} from './addons'
import { listRegisteredAddons } from '../addons/registry'
import { listAddonInstallations } from '../addons/service'
import { runMarketingMonitor } from '../addons/marketing/service'
import {
  pageHeader,
  notConnected,
  statCard,
  kpiRow,
  sectionPanel,
  dataTable,
  emptyState,
  avatarBadge,
  statusDot as uiStatusDot,
} from './ui'
import type { Html } from './ui'
import type { ApprovalItem } from './approvals'
import { loadObservatory, agentGradient } from './observatory'
import { kanbanApp, loadKanbanData, kanbanBoardBody } from './kanban-routes'
// Flight-008 Slice 3 (#1062): the /send dispatch-now picker's reachability signal.
// Reuses getFleetAgentRuntimeStates VERBATIM — the SAME dual-surface (fleet_agents ∪
// module_registry) presence primitive src/routines/dispatch.ts#selectAgent already
// uses for automated dispatch (mupot#732's either-surface fix). Do not invent a
// second liveness notion here.
import { getFleetAgentRuntimeStates, MAX_RUNTIME_STATE_BATCH } from '../fleet/registry'
import type { FleetAgentIdentity, FleetAgentRuntimeState } from '../fleet/registry'

import type { ObservatoryData, SwimlaneBar, AgentRuntimeState, AgentStat } from './observatory'
import { loadOpsHealth } from './health'
import type { OpsHealthData, HealthTone } from './health'
import { computeOperatorCounts, loadTaskStatusCounts } from './operator-counts'
import type { OperatorCounts } from './operator-counts'
import { loadAllAgents, loadSquadOptions } from './agents-admin'
import type { AgentAdminRow, SquadOption } from './agents-admin'
import { formatBurn, formatUsd } from '../agents/cost'
import {
  canManageProject,
  canManageProjects,
  loadProjectDetail,
  projectManageAccessContext,
  loadProjectFlights,
  loadProjectParentOptions,
  loadProjectWorkContext,
  loadProjectsPage,
  parseProjectListFilters,
  projectCreateBody,
  projectDetailBody,
  projectFormValues,
  projectLifecycleTransition,
  projectMutationInput,
  projectMutationStatus,
  projectNotFoundBody,
  projectSettingsBody,
  projectsPageBody,
  submittedProjectFormValues,
} from './projects'
import { stripExternalLifecycleFields } from '../projects/lifecycle-input'
import {
  consumeRoutineRunNonce,
  loadRoutineWorkspace,
  parseDashboardCursor,
  routineDashboardErrorStatus,
  routineInput,
  routineWorkspaceBody,
  submittedRoutineFormValues,
} from './routines'
import { loadNeedsYouDashboard, needsYouBody } from './needs-you'
import { routinePrincipal } from '../routines/access'
import {
  archiveRoutine,
  createManualRoutineRun,
  createRoutine,
  enableRoutine,
  getRoutine,
  getRoutineRun,
  pauseRoutine,
  updateRoutine,
} from '../routines/service'
import { answerRoutineRun, cancelRoutineRun } from '../routines/actions'
import { loadAgentConnectionStatus } from '../members/agent-connection-status'

import { wakeFleetAgent, requestFleetControl, fleetScoped } from './fleet'
import { emitControlRequest, emitSquadControlRequest } from '../fleet/control'
import { listFlights } from '../flight/service'
import { buildBoard } from '../flight/board'
import { flightsBody } from './flights-deck'
import { wizardApp } from './wizard'
import { studioApp } from './studio'
import { isOnboardingComplete } from './settings'
import { loadBrainView, brainBody, regimeBadgeClass, loadBrainPhysics } from './brain'
import type { PhysicsSnapshot } from './brain'
import { loadGrowthView, growthBody } from './growth'
import { setLoopControl, isLoopControlAction } from '../loops/decisions'
import { getLoop } from '../loops/service'
import {
  addConnector,
  rotateConnector,
  revokeConnector,
  listConnectors,
  resolveConnector,
  resolveConnectorWithMeta,
} from '../connectors/service'
import { isConnectorType, isConnectorScopeType } from '../connectors/crypto'
import { parseWpConnectorConfig } from '../departments/executors/mcpwp'
import { kernelMintCtx, getRegistered } from '../departments/registry'
import { githubCapabilitySnapshot } from '../integrations/github-capabilities'
import { writeAgentDef, assignIssueToCopilot } from '../integrations/github-repo-write'
import { installUrl, parseInstallCallback, storeInstallation, getInstallationId } from '../integrations/github-install'
import { syncFleetToGitHub } from '../integrations/github-fleet-sync'
import { executeTaskAsPR } from '../integrations/github-execute'
import { importProjectItems } from '../integrations/github-projects'
import { githubStatusBody } from '../integrations/github-dashboard'
import { connectorsPageBody, connectorAddedBody, connectorRotatedBody } from '../connectors/dashboard'
import type { KernelHandle } from '../departments/ctx'
import '../departments/modules/growth' // side-effect: register GrowthModule so getRegistered('growth') resolves
import '../departments/modules/agency' // side-effect: register AgencyModule (reusable agency/AEO template)
import '../departments/modules/web-ops' // side-effect: register WebOpsModule (AI website-operations team — the wedge)
import { makeMissionControlApp } from './mission-control-routes'
export { controlTowerBody, potFleetBody } from './mission-control-views'
import { getAuthContext, loadStudioData, studioPageHtml, dispatchStudioFlight, isSafeRepoUrl } from './studio'
import { deployProject } from '../projects/deploy'
import { studioDispatchPath } from '../projects/urls'
import {
  copilotDrawerCss,
  copilotPageBody,
  copilotShellEmbed,
  normalizeCopilotRecipient,
  readStudioChatPayload,
  streamStudioChat,
} from './copilot'
import { keepAliveCacheSession } from '../ai/cache-context'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const dashboardApp = new Hono<AppEnv>()

// ── browser-surface hardening ─────────────────────────────────────────────────
// CSRF: every mutating dashboard route is a cookie-authenticated HTML-form POST.
// SameSite=Lax already blocks cross-site POSTs; hono/csrf adds an Origin check so
// Lax is never the single line of defense on token minting (adversarial WARN-1).
dashboardApp.use('*', csrf())

// Authenticated UI: never cache (the show-once token page especially must not
// survive in any shared/proxy/back-button cache), never leak Referer off-origin.
dashboardApp.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
})

// ── auth gate (redirect HTML callers to login instead of 401 JSON) ───────────

dashboardApp.use('*', async (c, next) => {
  // Run the shared requireAuth. It either sets c.get('auth') and calls next(),
  // or short-circuits with a 401 JSON response (no auth populated).
  let proceeded = false
  await requireAuth(c, async () => {
    proceeded = true
  })
  if (!proceeded || !c.get('auth')) {
    // Unauthenticated → send the browser to the login flow.
    return c.redirect('/auth/login')
  }
  // Hard tenant guard: the DB is per-tenant, but a stolen/misrouted token must
  // never render another pot's structure.
  const auth = c.get('auth')
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.html(shell(c.env, 'Forbidden', errorBody('This session is not scoped to this org.')), 403)
  }
  await next()
})

// ── capability floor (FLIGHT-001 F2 — READ was never gated, only WRITE) ────────
// requireAuth above only proves PRESENCE (a valid session cookie), never
// authorization. Before this gate, a random Google-connect signup resolved
// role='member' with ZERO rows in `capabilities` / `channel_capability_grants`,
// sailed past requireAuth (presence, not capability), and saw every menu, the
// full agent roster, and every project/task. The dashboard's write handlers were
// already gated (isOrgAdmin / canOnOrg / requireCapability-equivalent inline
// checks) — reads never were. That asymmetry was the whole bug.
//
// The floor is deliberately the LOWEST rank on the ladder:
// `holdsCapabilityFloor(auth, 'observer')` asks only "does this principal hold
// ANY capability row, at ANY rank, on ANY scope" — an org grant, a department
// grant, or a single squad 'observer' row all satisfy it, since observer is the
// bottom of RANK and every real grant meets-or-exceeds it. That is intentionally
// NOT the same question as "can this member see THIS resource" — individual
// read paths (loadAllAgents, loadProjectsPage, etc.) still do their own per-scope
// filtering; this is the coarse "you belong somewhere in this org" chokepoint
// that a zero-capability drive-by signup can never pass, applied once instead of
// re-implemented per route (see [[feedback_two_tools_two_copies_of_one_predicate]]
// on why a single chokepoint beats N copies of the same predicate).
//
// A legacy org owner/admin (web login, no fine-grained `capabilities` array) is
// never locked out — holdsCapabilityFloor falls back to the SAME legacy-role
// escape requireCapability/requireOrgCapability already use.
//
// Scoped to GET/HEAD only, deliberately. Every mutating (POST/PUT/DELETE)
// handler on this app ALREADY inline-gates on isOrgAdmin / canOnOrg /
// hasSurfaceCap before it writes anything (that was true before this fix —
// "READ was never gated, only WRITE" is the bug this closes, not evidence
// WRITE needs the same floor). Applying the floor to writes too would also
// wrongly reject a legitimate principal who holds ONLY a surface-scoped grant
// (gate_grants — e.g. a scoped API key minted with content:write but no
// capabilities-table row; see hasSurfaceCap's own comment on why that ladder
// is intentionally separate) — such a principal has zero rows this floor can
// see, yet is fully authorized for the specific write its token names. Reads
// have no equivalent per-route gate to defer to, which is exactly the gap.
dashboardApp.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    await next()
    return
  }
  // NOTE (#847 adversarial gate, P2-2): this route used to be exempted from the
  // floor here, reasoning that "the common caller is the human who just issued
  // the connection and may hold ZERO standing capabilities otherwise." That
  // premise does not hold against the live code: the only production issuance
  // path, provision_agent_connection (src/mcp/provision.ts, min: 'admin'),
  // always constructs its actor as `{ kind: 'member', ... }` (never sets
  // `legacyOrgRole`), and agent-connection.ts#authorize() requires that actor
  // to hold a REAL admin-rank capability grant on the receipt's home squad
  // before a receipt is ever written (agent-connection.ts:357-365). So by
  // construction, the human who issued a connection already holds a capability
  // row that satisfies holdsCapabilityFloor('observer') on its own — the
  // exemption was never load-bearing for that caller. (The `actor_kind: 'user'`
  // + zero-grants issuer that motivated this exemption is only ever constructed
  // directly in tests/agent-connection-status.test.ts; no production code path
  // writes it — src/mcp/provision.ts:806 hardcodes `kind: 'member'`.)
  //
  // callerMayPoll (src/members/agent-connection-status.ts) still does its own
  // full, receipt-scoped authorization after this floor — org-admin, the
  // issuing member, or current admin on the receipt's home squad — so removing
  // this exemption narrows who reaches that check without narrowing who
  // callerMayPoll itself would have allowed.
  const auth = c.get('auth')
  // isOrgAdmin is checked explicitly (not left to holdsCapabilityFloor's own
  // legacy-role escape) because that escape only fires when auth.capabilities
  // is `undefined` — true for every REAL owner/admin session (requireAuth's
  // member-email bridge only ever runs for role==='member', see auth/index.ts).
  // A coarse "does this principal belong in this pot at all" gate should never
  // depend on whether some fine-grained capabilities array happens to be
  // attached; that array governs PER-RESOURCE scoping (loadAllAgents,
  // loadProjectsPage, …) downstream, not baseline dashboard access.
  if (isOrgAdmin(auth) || holdsCapabilityFloor(auth, 'observer')) {
    await next()
    return
  }
  // Same content-negotiation precedent as GET /radar below: ?format=json or an
  // Accept header that wants JSON without HTML gets a JSON 403; everyone else
  // (the normal browser navigation case) gets the rendered deny page.
  const accept = c.req.header('accept') ?? ''
  const wantsJson =
    c.req.query('format') === 'json' ||
    (accept.includes('application/json') && !accept.includes('text/html'))
  if (wantsJson) return c.json({ error: 'forbidden', need: 'capability' }, 403)
  return c.html(shell(c.env, 'No access', noDashboardAccessBody()), 403)
})

// Addon discoverability is part of the server-rendered shell, not a client-side
// privilege hint. Keep the shell template role-agnostic and reveal this one
// operator-only entry after the authenticated route response has been rendered.
dashboardApp.use('*', async (c, next) => {
  await next()
  if (!isOrgAdmin(c.get('auth')) || !c.res.headers.get('content-type')?.includes('text/html')) return

  const body = await c.res.text()
  c.res = new Response(body.replace('id="nav-addons" hidden', 'id="nav-addons"'), c.res)
})

// ── setup wizard ─────────────────────────────────────────────────────────────
// Mounted on the authenticated, tenant-guarded dashboard app. The wizard enforces
// its own owner-only gate (org role 'owner' OR org-capability 'owner') internally.
dashboardApp.route('/setup', wizardApp)
dashboardApp.route('/api/studio', studioApp)

// ── routes ───────────────────────────────────────────────────────────────────

// Refresh-safe polling for the guided agent-connection flow. Authorization is
// recalculated on every request and every denial is deliberately a 404.
dashboardApp.get('/api/agent-connections/:receiptId/status', async (c) => {
  const result = await loadAgentConnectionStatus(
    c.env,
    c.get('auth'),
    c.req.param('receiptId'),
  )
  return result.ok
    ? c.json(result.value)
    : c.json({ error: 'not_found' }, 404)
})

// GET / — Observatory home (#13): swimlane of agents over time, operator queue,
// recent tasks. First-run onboarding redirect is retained at the top.
dashboardApp.get('/', async (c) => {
  const auth = c.get('auth')
  // First-run nudge: an owner landing on an un-onboarded pot goes straight to the
  // wizard. Non-owners (and completed pots) see the normal overview. The wizard
  // itself re-checks owner + completion, so this is a convenience redirect only.
  if ((auth.role === 'owner' || hasOrgOwnerCapability(auth)) && !(await isOnboardingComplete(c.env))) {
    return c.redirect('/setup')
  }
  // Load observatory data (agents, stats, bars, ticks, recentTasks), the
  // operator queue (existing loadApprovals, same RBAC as the /approvals page),
  // and the two LIGHT header-chip reads, in parallel — independent KV/D1 reads,
  // one round-trip cluster. Overview is the highest-traffic page (the owner's
  // landing page), so this deliberately uses the light single-read helpers, NOT
  // loadBrainView (loops + up to 100 decisions) or loadEconomy (5 aggregation
  // queries: by-model/by-agent/14-day/totals/latest) those other pages need:
  //   - loadBrainPhysics: the SAME bare KV .get() brain.ts's coherence panel
  //     reads (no D1 at all).
  //   - loadTodaySpendScalar: ONE D1 round trip (today's sum + an EXISTS check),
  //     vs loadEconomy's 5 parallel queries — see economy.ts for why "configured"
  //     is defined identically so the two never disagree.
  const [obsData, approvals, physics, spend, taskStatusCounts] = await Promise.all([
    loadObservatory(c.env),
    loadApprovals(c.env, auth),
    loadBrainPhysics(c.env),
    loadTodaySpendScalar(c.env),
    loadTaskStatusCounts(c.env),
  ])
  // Flight-008 Slice 1 (mupot#1060): the hero KPI strip (Configured agents, Live
  // runtimes, In flight, Needs decision) is derived through the SAME pure helper
  // Health's loadOpsHealth uses (operator-counts.ts) — fed with the SAME loaded
  // maps this route already needed for the swimlane/directory render below, so
  // this is not an extra D1 round trip. See operator-counts.ts's header for why.
  const counts = computeOperatorCounts({
    nowMs: Date.now(),
    agents: obsData.agents,
    stats: obsData.stats,
    runtimeStates: obsData.runtimeStates,
    approvals,
    taskStatusCounts,
  })
  return c.html(
    shell(c.env, 'Overview', observatoryBody(c.env.BRAND, obsData, approvals, auth, counts), {
      physics,
      costToday: { configured: spend.configured, todayUsdMicro: spend.today_usd_micro },
    }),
  )
})

dashboardApp.get('/projects', async (c) => {
  const filters = parseProjectListFilters(c.req.query('search'), c.req.query('status'))
  if (!filters) {
    return c.html(shell(c.env, 'Projects', errorBody('Choose a valid project status filter.')), 400)
  }
  const view = await loadProjectsPage(c.env, c.get('auth'), filters)
  return c.html(shell(c.env, 'Projects', projectsPageBody(view)))
})

dashboardApp.get('/projects/new', async (c) => {
  if (!await canManageProjects(c.env, c.get('auth'))) {
    return c.html(shell(c.env, 'Projects', errorBody('Creating a project requires workspace admin.')), 403)
  }
  const view = { values: projectFormValues(), parentOptions: await loadProjectParentOptions(c.env) }
  return c.html(shell(c.env, 'Create project', projectCreateBody(view)))
})

dashboardApp.post('/projects', async (c) => {
  if (!await canManageProjects(c.env, c.get('auth'))) {
    return c.html(shell(c.env, 'Projects', errorBody('Creating a project requires workspace admin.')), 403)
  }
  const values = submittedProjectFormValues(await c.req.parseBody())
  const result = await createProject(c.env, { ...projectMutationInput(values), status: 'planned' })
  if (!result.ok) {
    const view = { values, parentOptions: await loadProjectParentOptions(c.env), error: result.error }
    return c.html(shell(c.env, 'Create project', projectCreateBody(view)), projectMutationStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(result.value.id)}?status=created`, 303)
})

dashboardApp.get('/projects/:id/settings', async (c) => {
  const detail = await loadProjectDetail(c.env, c.get('auth'), c.req.param('id'))
  if (!detail) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  if (!detail.canManage) {
    return c.html(shell(c.env, 'Project settings', errorBody('Project settings require workspace admin.')), 403)
  }
  const body = projectSettingsBody({
    project: detail.project,
    values: projectFormValues(detail.project),
    parentOptions: await loadProjectParentOptions(c.env, detail.project.id),
  })
  return c.html(shell(c.env, 'Project settings', body))
})

dashboardApp.post('/projects/:id/settings', async (c) => {
  if (!await canManageProjects(c.env, c.get('auth'))) {
    return c.html(shell(c.env, 'Project settings', errorBody('Project settings require workspace admin.')), 403)
  }
  const projectId = c.req.param('id')
  const values = submittedProjectFormValues(await c.req.parseBody())
  const result = await updateProject(
    c.env,
    projectId,
    stripExternalLifecycleFields(projectMutationInput(values) as Record<string, unknown>) as ReturnType<typeof projectMutationInput>,
  )
  if (!result.ok) {
    const project = await getProject(c.env, projectId)
    if (!project) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    const body = projectSettingsBody({
      project,
      values,
      parentOptions: await loadProjectParentOptions(c.env, project.id),
      error: result.error,
    })
    return c.html(shell(c.env, 'Project settings', body), projectMutationStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(result.value.id)}?status=updated`, 303)
})

dashboardApp.post('/projects/:id/status', async (c) => {
  if (!await canManageProjects(c.env, c.get('auth'))) {
    return c.html(shell(c.env, 'Project settings', errorBody('Project lifecycle requires workspace admin.')), 403)
  }
  const projectId = c.req.param('id')
  const currentProject = await getProject(c.env, projectId)
  if (!currentProject) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const form = await c.req.parseBody()
  const command = typeof form.command === 'string' ? form.command : ''
  const transition = projectLifecycleTransition(command)

  // Slice 3: planned→active must authorize + provision via start-gate.
  if (transition?.status === 'active' && currentProject.status === 'planned') {
    const started = await startProject(c.env, projectId, defaultStartGateDeps())
    if (!started.ok) {
      const body = projectSettingsBody({
        project: currentProject,
        values: projectFormValues(currentProject),
        parentOptions: await loadProjectParentOptions(c.env, currentProject.id),
        error: started.error === 'project_not_found' ? 'project_not_found' : 'start_gate_required',
        lifecycleCommand: command,
      })
      return c.html(
        shell(c.env, 'Project settings', body),
        started.error === 'project_not_found' ? 404 : 409,
      )
    }
    return c.redirect(
      `/projects/${encodeURIComponent(started.project.id)}?status=${encodeURIComponent(transition.result)}`,
      303,
    )
  }

  const result = transition
    ? await updateProject(c.env, projectId, { status: transition.status })
    : { ok: false as const, error: 'invalid_status' as const }
  if (!result.ok) {
    if (result.error === 'project_not_found') {
      return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    }
    const body = projectSettingsBody({
      project: currentProject,
      values: projectFormValues(currentProject),
      parentOptions: await loadProjectParentOptions(c.env, currentProject.id),
      error: result.error,
      lifecycleCommand: command,
    })
    return c.html(shell(c.env, 'Project settings', body), projectMutationStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(result.value.id)}?status=${transition!.result}`, 303)
})

// ── Project Routines ───────────────────────────────────────────────────────
// These HTML handlers only translate form submissions. Policy, authorization,
// scheduling, idempotency, and cancellation remain owned by shared routine services.
function dashboardHistoryCursor(value: string | undefined) {
  return parseDashboardCursor(value)
}

function validDashboardHistoryQuery(c: { req: { query: (key: string) => string | undefined } }): boolean {
  for (const key of ['run_limit', 'event_limit', 'routine_limit']) {
    const value = c.req.query(key)
    if (value !== undefined && (!/^[1-9]\d?$/.test(value) || Number(value) > 50)) return false
  }
  return dashboardHistoryCursor(c.req.query('run_cursor')) !== null
    && dashboardHistoryCursor(c.req.query('event_cursor')) !== null
    && dashboardHistoryCursor(c.req.query('routine_cursor')) !== null
}

dashboardApp.get('/projects/:id/routines', async (c) => {
  if (!validDashboardHistoryQuery(c)) {
    return c.html(shell(c.env, 'Project routines', errorBody('Choose a valid routine history page.')), 400)
  }
  const runAfter = dashboardHistoryCursor(c.req.query('run_cursor'))
  const eventAfter = dashboardHistoryCursor(c.req.query('event_cursor'))
  const routineAfter = dashboardHistoryCursor(c.req.query('routine_cursor'))
  const runLimit = c.req.query('run_limit')
  const eventLimit = c.req.query('event_limit')
  const routineLimit = c.req.query('routine_limit')
  const view = await loadRoutineWorkspace(c.env, c.get('auth'), c.req.param('id'), {
    ...(runAfter ? { runAfter } : {}), ...(eventAfter ? { eventAfter } : {}),
    ...(routineAfter ? { routineAfter } : {}),
    ...(runLimit ? { runLimit: Number(runLimit) } : {}), ...(eventLimit ? { eventLimit: Number(eventLimit) } : {}),
    ...(routineLimit ? { routineLimit: Number(routineLimit) } : {}),
    ...(c.req.query('edit') ? { editId: c.req.query('edit') } : {}),
    ...(c.req.query('run_id') ? { runId: c.req.query('run_id') } : {}),
    ...(c.req.query('routine_id') ? { routineId: c.req.query('routine_id') } : {}),
  })
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  return c.html(shell(c.env, 'Project routines', routineWorkspaceBody(view, { status: c.req.query('status') })))
})

dashboardApp.post('/projects/:id/routines', async (c) => {
  const projectId = c.req.param('id')
  const auth = c.get('auth')
  const view = await loadRoutineWorkspace(c.env, auth, projectId)
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  if (!view.canManage) return c.html(shell(c.env, 'Project routines', errorBody('Routine administration requires workspace admin.')), 403)
  const values = submittedRoutineFormValues(await c.req.parseBody())
  const result = await createRoutine(c.env, routinePrincipal(auth), { ...routineInput(values), project_id: projectId })
  if (!result.ok) {
    return c.html(shell(c.env, 'Project routines', routineWorkspaceBody(view, { error: result.error, values })), routineDashboardErrorStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?status=created`, 303)
})

dashboardApp.post('/projects/:id/routines/:routineId', async (c) => {
  const projectId = c.req.param('id')
  const routineId = c.req.param('routineId')
  const auth = c.get('auth')
  const view = await loadRoutineWorkspace(c.env, auth, projectId, { editId: routineId })
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  if (!view.canManage) return c.html(shell(c.env, 'Project routines', errorBody('Routine administration requires workspace admin.')), 403)
  const routine = await getRoutine(c.env, routinePrincipal(auth), routineId)
  if (!routine || routine.project_id !== projectId) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const values = submittedRoutineFormValues(await c.req.parseBody())
  const result = await updateRoutine(c.env, routinePrincipal(auth), routineId, routineInput(values))
  if (!result.ok) {
    return c.html(shell(c.env, 'Project routines', routineWorkspaceBody(view, { error: result.error, values })), routineDashboardErrorStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?status=updated`, 303)
})

for (const [command, action, message] of [
  ['enable', enableRoutine, 'enabled'], ['pause', pauseRoutine, 'paused'], ['archive', archiveRoutine, 'archived'],
] as const) {
  dashboardApp.post(`/projects/:id/routines/:routineId/${command}`, async (c) => {
    const projectId = c.req.param('id')
    const routineId = c.req.param('routineId')
    const auth = c.get('auth')
    const view = await loadRoutineWorkspace(c.env, auth, projectId)
    if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    if (!view.canManage) return c.html(shell(c.env, 'Project routines', errorBody('Routine administration requires workspace admin.')), 403)
    const routine = await getRoutine(c.env, routinePrincipal(auth), routineId)
    if (!routine || routine.project_id !== projectId) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    const result = await action(c.env, routinePrincipal(auth), routineId)
    if (!result.ok) return c.html(shell(c.env, 'Project routines', routineWorkspaceBody(view, { error: result.error })), routineDashboardErrorStatus(result.error))
    return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?status=${message}`, 303)
  })
}

dashboardApp.post('/projects/:id/routines/:routineId/run', async (c) => {
  const projectId = c.req.param('id')
  const routineId = c.req.param('routineId')
  const auth = c.get('auth')
  const principal = routinePrincipal(auth)
  const routine = await getRoutine(c.env, principal, routineId)
  if (!routine || routine.project_id !== projectId) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const form = await c.req.parseBody()
  if (!await consumeRoutineRunNonce(c.env, auth, routineId, form.nonce)) {
    const view = await loadRoutineWorkspace(c.env, auth, projectId)
    return c.html(shell(c.env, 'Project routines', view ? routineWorkspaceBody(view, { error: 'invalid_nonce' }) : projectNotFoundBody()), 400)
  }
  const result = await createManualRoutineRun(c.env, principal, routineId, form.nonce as string)
  if (!result.ok) {
    const view = await loadRoutineWorkspace(c.env, auth, projectId)
    return c.html(shell(c.env, 'Project routines', view ? routineWorkspaceBody(view, { error: result.error }) : projectNotFoundBody()), routineDashboardErrorStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?status=run_queued`, 303)
})

dashboardApp.post('/projects/:id/routines/:runId/cancel', async (c) => {
  const projectId = c.req.param('id')
  const runId = c.req.param('runId')
  const auth = c.get('auth')
  const principal = routinePrincipal(auth)
  const run = await getRoutineRun(c.env, principal, runId)
  if (!run || run.project_id !== projectId) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const result = await cancelRoutineRun(c.env, principal, runId)
  if (!result.ok) {
    const view = await loadRoutineWorkspace(c.env, auth, projectId)
    return c.html(shell(c.env, 'Project routines', view ? routineWorkspaceBody(view, { error: result.error }) : projectNotFoundBody()), routineDashboardErrorStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?status=run_cancelled`, 303)
})

dashboardApp.post('/projects/:id/routines/:runId/answer', async (c) => {
  const projectId = c.req.param('id')
  const runId = c.req.param('runId')
  const auth = c.get('auth')
  const principal = routinePrincipal(auth)
  const run = await getRoutineRun(c.env, principal, runId)
  if (!run || run.project_id !== projectId) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const form = await c.req.parseBody()
  const result = await answerRoutineRun(c.env, principal, runId, form.answer)
  if (!result.ok) {
    const view = await loadRoutineWorkspace(c.env, auth, projectId, { runId })
    return c.html(shell(c.env, 'Project routines', view ? routineWorkspaceBody(view, { error: result.error }) : projectNotFoundBody()), routineDashboardErrorStatus(result.error))
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}/routines?run_id=${encodeURIComponent(runId)}&status=answer_recorded`, 303)
})

dashboardApp.get('/projects/:id', async (c) => {
  const view = await loadProjectDetail(c.env, c.get('auth'), c.req.param('id'))
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  return c.html(shell(c.env, view.project.name, projectDetailBody(view, c.req.query('status'))))
})

// POST /projects/:id/boards — link an external board. Gated on per-project
// `manage` access (issue #402): a squad with write/admin access_level on THIS
// project may bind its board; org-admin/owner still pass (superset, see
// canManageProject in ./projects). Coarser pot-wide isOrgAdmin no longer gates
// this — that let any pot-admin bind ANY project's board and blocked a
// project-scoped squad manager from binding its own.
dashboardApp.post('/projects/:id/boards', async (c) => {
  const auth = c.get('auth')
  const projectId = c.req.param('id')
  // Compute the manage-access context ONCE — the same authority check backs
  // both the route gate and the connector-scope bound below (#453): the
  // connector a caller may reference must never be broader than the specific
  // authority (workspace-admin, or the exact squads) that got them past this
  // gate in the first place.
  const access = await projectManageAccessContext(c.env, auth, projectId)
  if (!access.authorized) {
    return c.html(shell(c.env, 'Projects', projectNotFoundBody()), 403)
  }
  const view = await loadProjectDetail(c.env, auth, projectId)
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const form = await c.req.parseBody()
  const { upsertProjectBinding } = await import('../projects/providers/bindings')
  const result = await upsertProjectBinding(c.env, projectId, {
    provider: form.provider,
    external_id: form.external_id,
    connector_id: form.connector_id,
  }, { workspaceAdmin: access.workspaceAdmin, actorSquadIds: access.actorSquadIds })
  if (!result.ok) {
    return c.html(
      shell(c.env, view.project.name, projectDetailBody(view)),
      result.error === 'archived_project' || result.error === 'project_not_found' ? 400 : 400,
    )
  }
  return c.redirect(`/projects/${encodeURIComponent(projectId)}#board`)
})

// POST /projects/:id/boards/sync — import from the linked board into attributed
// tasks. Same per-project `manage` gate as the bind route above (issue #402).
dashboardApp.post('/projects/:id/boards/sync', async (c) => {
  const auth = c.get('auth')
  const projectId = c.req.param('id')
  if (!await canManageProject(c.env, auth, projectId)) {
    return c.html(shell(c.env, 'Projects', projectNotFoundBody()), 403)
  }
  const view = await loadProjectDetail(c.env, auth, projectId)
  if (!view) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  const form = await c.req.parseBody()
  const { isProjectBoardProvider } = await import('../projects/providers/port')
  const { getProjectBinding } = await import('../projects/providers/bindings')
  const { getTaskBoardPort } = await import('../projects/providers/registry')
  const providerRaw = typeof form.provider === 'string' ? form.provider : ''
  if (!isProjectBoardProvider(providerRaw)) {
    return c.redirect(`/projects/${encodeURIComponent(projectId)}#board`)
  }
  const binding = await getProjectBinding(c.env, projectId, providerRaw)
  if (!binding) return c.redirect(`/projects/${encodeURIComponent(projectId)}#board`)
  await getTaskBoardPort(c.env, providerRaw).syncIntoProject(binding, {
    project_id: projectId,
    dryRun: false,
  })
  return c.redirect(`/projects/${encodeURIComponent(projectId)}#board`)
})

// GET /send — the "Send a task" page. The last mile: a person writes a task,
// picks one of their agents, submits, and watches it get done. The form POSTs to
// the RBAC-gated /api/tasks (dispatch:true) and polls GET /api/tasks/:id. All auth
// + CSRF + no-store/Referrer-Policy come from the dashboard middleware above.
dashboardApp.get('/send', async (c) => {
  const projectId = c.req.query('project_id')
  if (projectId !== undefined) {
    const context = await loadProjectWorkContext(c.env, c.get('auth'), projectId)
    if (!context) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    const [agents, dispatchable] = await Promise.all([
      loadActiveAgentsWithSquad(c.env, context.taskableSquadIds),
      loadDispatchableAgents(c.env, context.taskableSquadIds),
    ])
    return c.html(shell(c.env, 'Send a task', sendPageBody(
      agents,
      dispatchable,
      pickDispatchDefault(dispatchable),
      context.project,
      context.taskableSquadIdsTruncated,
    )))
  }
  const [agents, dispatchable] = await Promise.all([
    loadActiveAgentsWithSquad(c.env),
    loadDispatchableAgents(c.env),
  ])
  return c.html(shell(c.env, 'Send a task', sendPageBody(agents, dispatchable, pickDispatchDefault(dispatchable))))
})

// GET /approvals — the gate queue (#6). Tasks in 'review' the caller may
// verdict (owner/admin: all; others: gate_grants visibility == authority).
// Buttons POST to the existing RBAC'd /api/tasks/:id/verdict — this page adds
// no new write path.
//
// Also renders a "Ready to publish" section (flight-1 gap fix): tasks that
// already cleared the gate (status='approved', gate_owner='gate:content') sat
// invisible with no operator control to fire the real write. loadPublishable
// is admin/owner-gated server-side, so the section — and its Publish button —
// simply doesn't render for non-admins; the button POSTs to the existing
// admin-gated POST /admin/departments/:dept/execute/:gateId, no new write path.
dashboardApp.get('/approvals', async (c) => {
  const auth = c.get('auth')
  // Secret-env pending requests: admin-only, like loadPublishable above — a
  // non-admin caller never even queries the table, not just doesn't see a button.
  const [items, publishable, secretEnvRequests] = await Promise.all([
    loadApprovals(c.env, auth),
    loadPublishable(c.env, auth),
    isOrgAdmin(auth) ? listPendingSecretEnvRequests(c.env) : Promise.resolve([]),
  ])
  return c.html(shell(c.env, 'Approvals', approvalsBody(items, publishable, secretEnvRequests)))
})

// POST /admin/secret-env/:requestId/bind — admin pastes values for a pending
// secret-env request. Values are collected here ONLY to build bindSecretEnv's
// payload and are never referenced again after that call — the response and
// any error page render binding NAMES only (see ./secret-env.ts).
dashboardApp.post('/admin/secret-env/:requestId/bind', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Binding a secret-env request', auth), 403)

  const requestId = c.req.param('requestId')
  const form = await c.req.parseBody()
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(form)) {
    if (key.startsWith('secret__') && typeof value === 'string') {
      values[key.slice('secret__'.length)] = value
    }
  }

  const result = await bindSecretEnv(c.env, {
    requestId,
    values,
    actorId: auth.memberId ?? auth.userId,
  })

  if (!result.ok) {
    return c.html(shell(c.env, 'Approvals', secretEnvErrorBody(result.error)), 400)
  }
  return c.html(shell(c.env, 'Secret env bound', secretEnvBoundBody(requestId, result.bound)))
})

// POST /admin/secret-env/:requestId/reject — admin declines; no CF calls, no values.
dashboardApp.post('/admin/secret-env/:requestId/reject', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Rejecting a secret-env request', auth), 403)

  const requestId = c.req.param('requestId')
  const result = await rejectSecretEnv(c.env, { requestId, actorId: auth.memberId ?? auth.userId })

  if (!result.ok) {
    return c.html(shell(c.env, 'Approvals', secretEnvErrorBody(result.error)), 400)
  }
  return c.html(shell(c.env, 'Secret env rejected', secretEnvRejectedBody(requestId)))
})

dashboardApp.get('/needs-you', async (c) => {
  const rawLimit = c.req.query('limit')
  const cursor = c.req.query('cursor')
  if ((rawLimit !== undefined && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100))
    || (cursor !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor))) {
    return c.html(shell(c.env, 'Needs You', errorBody('Choose a valid Needs You page.')), 400)
  }
  try {
    const view = await loadNeedsYouDashboard(c.env, c.get('auth'), {
      ...(rawLimit ? { limit: Number(rawLimit) } : {}), ...(cursor ? { after: cursor } : {}),
    })
    return c.html(shell(c.env, 'Needs You', needsYouBody(view)))
  } catch {
    return c.html(shell(c.env, 'Needs You', errorBody('Choose a valid Needs You page.')), 400)
  }
})

// GET /ops — owner/admin health and observability console.
// Read-only. Aggregates existing runtime/task/integration/audit evidence so an
// operator can answer "is this pot healthy?" without querying SQL.
dashboardApp.get('/ops', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Operations', orgAdminForbiddenBody('The Operations page', auth)), 403)
  }
  const data = await loadOpsHealth(c.env, auth)
  return c.html(shell(c.env, 'Operations', opsHealthBody(data)))
})

// ── deployment (SOVEREIGNTY: the pot's actual live deployment identity) ──────
// GET /deployment — replaces the old mislabeled "Deployment" nav item that used
// to point at /setup (the first-run onboarding wizard). Read-only: version,
// RELEASE_SHA/commit, tenant, and liveness straight from the same publicHealth()
// GET /health uses, plus honest (non-clickable) redeploy guidance. Owner/admin
// only, like the other SOVEREIGNTY pages (/admin/keys, /ops).
dashboardApp.get('/deployment', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Deployment', orgAdminForbiddenBody('The Deployment page', auth)), 403)
  }
  const data = await loadDeployment(c.env)
  return c.html(shell(c.env, 'Deployment', deploymentBody(data)))
})

// ── loops (watch goal-seeking work-units + the outreach funnel) ──────────────
dashboardApp.get('/loops', async (c) => {
  const view = await loadLoopsView(c.env)
  return c.html(shell(c.env, 'Loops', loopsBody(view)))
})

// ── services (the priced "basket of services" the reseller sells) ────────────
// GET /services — read-only render of SERVICE_CATALOG (config). requireAuth via the
// outer middleware. Draft prices live in src/services/catalog.ts.
dashboardApp.get('/services', async (c) => {
  return c.html(shell(c.env, 'Services', servicesBody()))
})

// ── addons — owner/admin lifecycle console ──────────────────────────────────
// The catalog is registered at process startup; installation state stays tenant
// scoped in D1. Lifecycle writes remain owned by /api/addons and are re-gated
// there, so this route only renders the existing API contract.
dashboardApp.get('/addons', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Addons', orgAdminForbiddenBody('The Addons console', auth)), 403)
  }
  try {
    const [installations, connectors] = await Promise.all([
      listAddonInstallations(c.env),
      listConnectors(c.env),
    ])
    return c.html(shell(c.env, 'Addons', addonsBody(
      listRegisteredAddons(),
      installations,
      dashboardBuiltInGetRoutes,
      connectors,
    )))
  } catch {
    return c.html(shell(c.env, 'Addons', errorBody('Addon catalog is unavailable.')), 500)
  }
})

function currentUtcMarketingWindow(now = new Date()) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const day = now.getUTCDate()
  return {
    start: new Date(Date.UTC(year, month, day, 0, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(year, month, day, 23, 59, 59, 999)).toISOString(),
  }
}

dashboardApp.post('/addons/marketing-cro-monitor/run', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Marketing & CRO', orgAdminForbiddenBody('Running the monitor', auth)), 403)
  }
  const result = await runMarketingMonitor(
    c.env,
    { id: auth.userId, role: auth.role },
    { window: currentUtcMarketingWindow() },
  )
  if (!result.ok) {
    return c.html(shell(c.env, 'Marketing & CRO', errorBody(`Monitor run failed: ${result.reason}.`)), 409)
  }
  return c.redirect('/addons/marketing-cro-monitor')
})

// ── economy (squad Anthropic spend — #179) ───────────────────────────────────
// GET /economy — real Claude Code spend pushed in from the server transcript
// rollup (actual tokens × Anthropic list rates). Read-only; requireAuth via the
// outer middleware. Separate from the pot's internal burn gauge.
dashboardApp.get('/economy', async (c) => {
  const data = await loadEconomy(c.env)
  // Header spend chip reuses this SAME loadEconomy() call — no extra D1 round
  // trip, and the chip is guaranteed to agree with the "Today" card below it.
  return c.html(
    shell(c.env, 'Economy', economyBody(data), {
      costToday: { configured: data.configured, todayUsdMicro: data.today_usd_micro },
    }),
  )
})

// ── economy/billing — current plan + tier from org_settings (no secrets) ─────
dashboardApp.get('/economy/billing', async (c) => {
  const model = await loadBilling(c.env, c.get('auth'))
  return c.html(shell(c.env, 'Billing', billingBody(model)))
})

// ── economy/wallet + marketplace — honest-empty (greenfield, no backing model) ─
// Per the reskin plan §5 + Codex condition 6: render the real chrome with a
// visible "not connected" state. NEVER fabricate a balance or a listing.
dashboardApp.get('/economy/wallet', (c) =>
  c.html(
    shell(
      c.env,
      'Wallet',
      html`${pageHeader({ crumbs: 'Overview / Economy / Wallet', title: 'Wallet' })}
      ${notConnected(
        'Wallet',
        'A per-pot credit wallet — balance, top-ups, and per-execution debits — has no backing model yet. Real Claude Code spend is visible under Economy.',
      )}`,
    ),
  ),
)
dashboardApp.get('/economy/marketplace', (c) =>
  c.html(
    shell(
      c.env,
      'Marketplace',
      html`${pageHeader({ crumbs: 'Overview / Economy / Marketplace', title: 'Marketplace' })}
      ${notConnected(
        'Marketplace',
        'Listing this pot’s agents/capabilities for rent or sale (and the earnings ledger) is not connected yet.',
      )}`,
    ),
  ),
)

// ── verifications — latest verdict per task (reuses the S4-hardened verdict store) ─
// Read-only. Visibility mirrors /approvals (owner/admin all; others gate-scoped).
dashboardApp.get('/verifications', async (c) => {
  const items = await loadVerifications(c.env, c.get('auth'))
  const athenaReceipts = await listAthenaGateReceipts(c.env)
  return c.html(
    shell(
      c.env,
      'Verifications',
      html`${verificationsBody(items)}${athenaGateReceiptsBody(athenaReceipts)}`,
    ),
  )
})

// ── audit — immutable trail (connector actions + gate decisions). Owner/admin. ─
dashboardApp.get('/audit', async (c) => {
  const result = await loadAudit(c.env, c.get('auth'))
  // WARN-1 (Codex): a non-admin gets a real 403, not a 200-with-empty. The body
  // still renders the restricted state; the status makes the denial monitorable.
  const status = result.forbidden ? 403 : 200
  return c.html(shell(c.env, 'Audit log', auditBody(result)), status)
})

// ── brain (per-pot brain panel — decision feed + governor) ───────────────────
// GET /brain — decision feed + governor controls (S-BRAIN-CTRL-MUPOT-1 AC#4).
// Reads are the dashboard's global capability floor (FLIGHT-001 F2, #796) plus
// per-squad loop-feed scoping (FLIGHT-001 #797 — see loadBrainView's own doc
// comment for the judged physics/directive-stay-org-level decision). Governor
// writes are isAdmin-gated (AC#7) in the POST handler below.
dashboardApp.get('/brain', async (c) => {
  const auth = c.get('auth')
  const view = await loadBrainView(c.env, auth)
  // Header regime chip reuses this SAME loadBrainView() call (it already fetched
  // the KV physics snapshot for the coherence panel below) — no extra KV read.
  return c.html(
    shell(c.env, 'Brain', brainBody(view, isOrgAdmin(auth)), { physics: view.physics }),
  )
})

// ── departments/growth (Marketing & Sales console view) ─────────────────────
// GET /departments/growth — read-only view: funnel + KPIs + trend chart + squads.
// Data: prospects table (countByStatus), metric_points (growth.leads series),
//       departments + squads tables. No mutations. requireAuth via outer gate.
dashboardApp.get('/departments/growth', async (c) => {
  const auth = c.get('auth')
  const view = await loadGrowthView(c.env, auth)
  return c.html(shell(c.env, 'Marketing & Sales', growthBody(view)))
})

// POST /admin/departments/:dept/execute/:gateId — owner/admin-triggered execution
// of an ALREADY-APPROVED department proposal (S4 live-wire; WordPress adapter #370).
// Human-in-the-loop: the owner approves via /approvals (writes the task_verdicts row),
// then fires this to perform the real content write. The kernel re-checks the approval
// + tenant/dept binding; this route only resolves the per-pot connector credential(s)
// and mints the ctx.
//
// #370: this route does NOT know which adapter the approved record targets — that is
// content-bound, resolved inside kernel.ts from the stored payload's `executor` hint
// (see ctx.ts CONTENT-BOUND EXECUTION). So the route resolves EVERY adapter it knows
// about, additively and non-fatally: whichever connector(s) are configured for this
// pot populate handle.executorEnv; the kernel dispatches to whichever one the stored
// record names. Fail-closed: if NEITHER 'inkwell' nor 'mcpwp' resolves to a usable
// config → 503 executor_not_configured (inert; nothing wired for this pot at all).
dashboardApp.post('/admin/departments/:dept/execute/:gateId', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Executing a department gate', auth), 403)
  const dept = c.req.param('dept')
  const gateId = c.req.param('gateId')
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(dept) || !gateId) {
    return c.json({ error: 'invalid_params' }, 400)
  }
  const moduleDef = getRegistered(dept)
  if (!moduleDef) return c.json({ error: 'department_not_found' }, 404)

  const executorEnv: NonNullable<KernelHandle['executorEnv']> = {}

  // Inkwell: pot-scoped 'inkwell' connector. resolveConnector fails closed (null)
  // when no CONNECTOR_MASTER_KEY or no row. Additive + non-fatal here — a pot with
  // no INKWELL_API_URL / no inkwell connector simply doesn't get inkwell wired,
  // it is not an error unless NO adapter resolves at all (checked below).
  if (c.env.INKWELL_API_URL) {
    const token = await resolveConnector(c.env, dept, 'inkwell')
    if (token) {
      executorEnv.inkwell = {
        apiUrl: c.env.INKWELL_API_URL,
        token,
        tenantSlug: c.env.TENANT_SLUG,
        // Same-zone Inkwell → route through the service binding to dodge the CF 522
        // Worker→Worker edge loopback. Absent (cross-zone tenant) → public fetch.
        fetcher: c.env.INKWELL_SVC,
      }
    }
  }

  // WordPress (#370): pot-scoped 'mcpwp' connector. secret = the WordPress
  // application password (the actual credential); meta = non-secret JSON
  // { siteUrl, username } — same secret+meta split as the Telegram connector's
  // allowed_chats (src/connectors/service.ts). Additive + non-fatal.
  const wp = await resolveConnectorWithMeta(c.env, dept, 'mcpwp')
  if (wp) {
    const wpCfg = parseWpConnectorConfig(wp.secret, wp.meta)
    if (wpCfg) executorEnv.mcpwp = wpCfg
  }

  if (!executorEnv.inkwell && !executorEnv.mcpwp) {
    return c.json(
      { error: 'executor_not_configured', reason: 'no inkwell or mcpwp adapter is configured for this pot' },
      503,
    )
  }

  const handle: KernelHandle = { db: c.env.DB, executorEnv }
  const ctx = kernelMintCtx(handle, {
    tenantId: c.env.TENANT_SLUG,
    departmentKey: dept,
    module: moduleDef,
    capabilities: [auth.role === 'owner' ? 'owner' : 'admin'],
  })
  try {
    const outcome = await ctx.executor.execute(gateId)
    if (outcome.executed) {
      // Close the loop (flight-1): a content-publish proposal minted through
      // runTaskExecution (src/agents/execute.ts finishContentProposal) uses
      // idGen: () => task.id, so gateId === the originating task's own id.
      // This route previously returned the outcome and never touched `tasks`,
      // stranding that row at 'approved' forever — invisible as a receipt.
      // Flip it to 'done' now that a real write has happened. approved → done
      // is a legal transition (src/tasks/service.ts TRANSITIONS). Self-scoping
      // / harmless no-op for every OTHER gate.propose() work-type this kernel
      // serves (seo-audit-proposal, seo-meta-fix, …): their gateId is a random
      // UUID with no matching task row, or the row isn't 'approved' — either
      // way this UPDATE only ever touches a row that is genuinely this pot's
      // own approved content-publish task.
      const now = new Date().toISOString()
      // CRO apply-bridge (S5b): when the adapter performed a fetch-then-merge write
      // (outcome.diff present — see executors/inkwell.ts ContentMergeDiff /
      // ctx.ts ExecuteDiff), fold the change-type + before/after into this SAME
      // receipt string rather than adding a second persistence path. Today this
      // UPDATE is a harmless no-op for cro-apply's random-UUID gateId (same as it
      // already is for seo-meta-fix — see the comment above); this stays ready for
      // a future flow that mints gateId === task.id for a cro-apply proposal too.
      const receiptResult = outcome.diff
        ? `Applied ${outcome.diff.changeType} via ${outcome.adapter ?? 'unknown'}${outcome.artifactUrl ? `: ${outcome.artifactUrl}` : ''} — ${outcome.diff.field}: ${JSON.stringify(outcome.diff.before)} -> ${JSON.stringify(outcome.diff.after)}`
        : `Published via ${outcome.adapter ?? 'unknown'}${outcome.artifactUrl ? `: ${outcome.artifactUrl}` : ''}`
      await c.env.DB.prepare(
        `UPDATE tasks SET status = 'done', result = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'approved'`,
      )
        .bind(receiptResult, now, now, gateId)
        .run()
    }
    return c.json(outcome, outcome.executed ? 200 : 422)
  } catch (e) {
    // execute() throws CtxError on not_approved / capability / cross-tenant.
    const reason = e instanceof Error ? e.message : 'execute_failed'
    return c.json({ executed: false, error: 'not_executable', reason }, 409)
  }
})

// POST /brain/loops/:id/control — governor control signal.
// Surface-cap gated (#106): non-admin callers need content:write for any action,
// plus budget:write for budget_override. Admin/owner bypass via hasSurfaceCap.
// Writes a loop_controls row; the driver picks it up on the next heartbeat cycle.
// Accepted actions: pause | kill | budget_override
// For budget_override: body must include value (micro-USD integer as string).
// For pause/kill: value is ignored.
dashboardApp.post('/brain/loops/:id/control', async (c) => {
  const auth = c.get('auth')

  // Surface-cap gate (#106): any loop control action requires content:write.
  // Admin/owner tokens pass via hasSurfaceCap bypass (rank is sufficient).
  // Non-admin members must hold an explicit content:write grant in gate_grants.
  if (!isOrgAdmin(auth)) {
    const hasContentWrite = await hasSurfaceCap(c.env, auth, 'content:write')
    if (!hasContentWrite) return c.json({ error: 'forbidden', need: 'content:write' }, 403)
  }

  const loopId = c.req.param('id')
  if (!loopId || loopId.length > 64) return c.json({ error: 'invalid_loop_id' }, 400)

  // Verify the loop belongs to this pot (tenant guard).
  const loop = await getLoop(c.env, loopId)
  if (!loop) return c.json({ error: 'not_found' }, 404)

  let body: { action?: unknown; value?: unknown }
  try {
    body = (await c.req.json()) as { action?: unknown; value?: unknown }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isLoopControlAction(body.action)) {
    return c.json({ error: 'invalid_action', accepted: ['pause', 'kill', 'budget_override'] }, 400)
  }

  // budget_override requires budget:write in addition to content:write.
  // Admin/owner bypass again via hasSurfaceCap.
  if (body.action === 'budget_override') {
    if (!isOrgAdmin(auth)) {
      const hasBudgetWrite = await hasSurfaceCap(c.env, auth, 'budget:write')
      if (!hasBudgetWrite) return c.json({ error: 'forbidden', need: 'budget:write' }, 403)
    }
    // budget_override validation (fix: value<=0 inverts to UNLIMITED in the meter,
    // because meter.ts only applies the cap when budgetCapMicroUsd > 0). Reject
    // non-numeric, NaN, and any value <= 0 — the caller intends a cap, not a removal.
    // Use pause/kill to stop a loop; budget_override is strictly a positive cap clamp.
    if (typeof body.value !== 'string') {
      return c.json({ error: 'budget_override requires value (micro-USD integer string)' }, 400)
    }
    const parsed = parseInt(body.value, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({
        error: 'budget_override value must be a positive integer (micro-USD). Use pause or kill to stop a loop.',
      }, 400)
    }
  }

  const value =
    body.action === 'budget_override' && typeof body.value === 'string'
      ? body.value
      : null

  await setLoopControl(c.env, loopId, body.action, auth.email ?? auth.userId, value)
  return c.json({ ok: true, action: body.action, loop_id: loopId })
})

// ── flights (the flight board — what is flying/sleeping + each flight's cost) ─
// GET /flights — read the flights table (#61). Read-only; control stays on Fleet.
dashboardApp.get('/flights', async (c) => {
  const projectId = c.req.query('project_id')
  const context = projectId === undefined
    ? null
    : await loadProjectWorkContext(c.env, c.get('auth'), projectId)
  if (projectId !== undefined && !context) {
    return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  }
  const result = context
    ? await loadProjectFlights(c.env, context)
    : { rows: await listFlights(c.env), scanLimited: false }
  const nowMs = Date.now()
  const cards = buildBoard(result.rows, nowMs)
  return c.html(shell(c.env, 'Flights', flightsBody(cards, context?.project, result.scanLimited, nowMs)))
})

// GET /studio — Lovable/Claude Design split-pane canvas (session auth).
dashboardApp.get('/studio', async (c) => {
  const auth = getAuthContext(c)
  const data = await loadStudioData(c.env, auth)
  const repo = c.req.query('repo')?.trim()
  if (repo && isSafeRepoUrl(repo)) data.repoUrl = repo
  return c.html(studioPageHtml(data))
})

dashboardApp.post('/projects/:id/deploy', async (c) => {
  if (!await canManageProjects(c.env, c.get('auth'))) {
    return c.html(shell(c.env, 'Projects', errorBody('Deploying a project worker requires workspace admin.')), 403)
  }
  const projectId = c.req.param('id')
  const result = await deployProject(c.env, projectId, c.get('auth'))
  if (!result.ok) {
    if (result.error === 'project_not_found') {
      return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
    }
    return c.html(shell(c.env, 'Projects', errorBody(`Deploy failed: ${result.error}`)), 400)
  }
  return c.redirect(result.studio_url, 303)
})

dashboardApp.post('/projects/:id/dispatch-flight', async (c) => {
  const detail = await loadProjectDetail(c.env, c.get('auth'), c.req.param('id'))
  if (!detail) return c.html(shell(c.env, 'Project not found', projectNotFoundBody()), 404)
  if (detail.canManage) {
    const result = await deployProject(c.env, detail.project.id, c.get('auth'), {
      prompt: `Dispatch a feature flight for ${detail.project.name}`,
    })
    if (result.ok) return c.redirect(result.studio_url, 303)
  }
  if (detail.project.repo_url) return c.redirect(studioDispatchPath(detail.project.repo_url), 303)
  return c.redirect(`/projects/${encodeURIComponent(detail.project.id)}`, 303)
})

// POST /api/studio/dispatch — create a flight + task from a Studio prompt.
dashboardApp.post('/api/studio/dispatch', async (c) => {
  const auth = getAuthContext(c)
  let body: { prompt?: unknown; repoUrl?: unknown; model?: unknown }
  try {
    body = (await c.req.json()) as { prompt?: unknown; repoUrl?: unknown; model?: unknown }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const result = await dispatchStudioFlight(c.env, auth, {
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    repoUrl: typeof body.repoUrl === 'string' ? body.repoUrl : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.result)
})

// GET /copilot and GET /chat — full-height Deep Chat card (session auth).
dashboardApp.get('/copilot', async (c) => c.html(shell(c.env, 'Co-Pilot', copilotPageBody(getAuthContext(c)))))
dashboardApp.get('/chat', async (c) => c.html(shell(c.env, 'Co-Pilot', copilotPageBody(getAuthContext(c)))))

// POST /api/studio/chat — Deep Chat SSE stream. Accepts { messages, recipient }
// and the shorter { message, recipient } body. Authority is derived from the
// signed-in session (admin vs member), never from the request body.
dashboardApp.post('/api/studio/chat', async (c) => {
  const auth = getAuthContext(c)
  const parsed = await readStudioChatPayload(c.req.raw)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  return streamStudioChat(c.env, auth, parsed.value)
})

dashboardApp.post('/api/studio/chat/keepalive', async (c) => {
  const auth = getAuthContext(c)
  const recipient = normalizeCopilotRecipient(c.req.header('X-Mupot-Recipient'))
  return c.json(keepAliveCacheSession(`copilot:${recipient}:${auth.tenant || c.env.TENANT_SLUG}`))
})

// ── radar (visual fleet + squad awareness — #21 slice 1, VIEW LAYER ONLY) ────
// GET /radar — agent character-sheet cards + a compact fleet-map "brain image"
// rendered from the SAME FleetRadar the brain's ATC tower already reads at the
// bearer-gated GET /api/radar JSON feed (dashboard/radar-routes.ts, #23) — zero
// new data, zero migration, reuses loadFleetRadar/buildFleetRadar as-is.
//
// Auth: this route lives on dashboardApp (session-cookie, requireAuth via the
// outer middleware) and is admin-gated with the SAME isOrgAdmin() check every
// other org-admin dashboard page uses (/ops, /deployment, /audit) — matching
// the org-admin authorization LEVEL that GET /api/radar's bearer-token
// resolveOrgAdmin check requires, via the mechanism this cookie-authed
// dashboard already uses everywhere else. GET /api/radar's own bearer check
// Mount Mission Control Sub-app (unified /radar + 301 redirects)
dashboardApp.route('/', makeMissionControlApp(shell))

// Mount Kanban Sub-app
dashboardApp.route('/', kanbanApp)

// GET /dashboard/kanban — Multi-Perspective Squad & Project Kanban Board
dashboardApp.get('/dashboard/kanban', async (c) => {
  const auth = c.get('auth')
  const squad = c.req.query('squad') || c.req.query('squad_id')
  const project = c.req.query('project') || c.req.query('project_id')
  const view = c.req.query('view')

  const accessibleSquadIds = await resolveAccessibleSquadIds(c.env, auth)
  const isAllAccessible = isOrgAdmin(auth) || accessibleSquadIds === null

  const [data, allSquads, allProjects] = await Promise.all([
    loadKanbanData(c.env, auth, { squadIdOrSlug: squad, projectIdOrSlug: project, view }),
    loadSquads(c.env),
    c.env.DB.prepare('SELECT id, slug, name, goal, status FROM projects WHERE status <> "archived" ORDER BY name ASC').all<Project>().then(r => r.results ?? []),
  ])

  const visibleSquads = isAllAccessible
    ? allSquads
    : allSquads.filter(s => accessibleSquadIds?.includes(s.id))

  const visibleProjects = allProjects // Projects without accessible squad tasks will render empty/scoped per-squad lanes

  const title = data.mode === 'project' && data.project
    ? `Project Board · ${data.project.name}`
    : `Squad Board · ${data.squad?.name || 'Kanban'}`

  return c.html(
    shell(c.env, title, kanbanBoardBody(data, visibleSquads, visibleProjects)),
  )
})



// POST /fleet/host-control — start|stop|restart a HOST agent OR squad via the SIGNED control
// plane (mupot inbox → host daemon verifies the Ed25519 signature → engine.control/control_squad).
// OWNER only (highest-stakes action; host process control). The principal comes from the
// session, never the form. Form POST + redirect. Exactly one of agent_id/squad_id is present —
// the two panel forms (controlCell / squadControlCell) each set only their own hidden field.
dashboardApp.post('/fleet/host-control', async (c) => {
  const auth = c.get('auth')
  if (auth.role !== 'owner') return c.json({ error: 'forbidden', need: 'owner' }, 403)
  const form = await c.req.parseBody()
  const agent_id = typeof form.agent_id === 'string' ? form.agent_id : ''
  const squad_id = typeof form.squad_id === 'string' ? form.squad_id : ''
  const verb = typeof form.verb === 'string' ? form.verb : ''
  // Exactly one of agent_id/squad_id — mirrors POST /api/fleet/control's mutual-exclusion 400
  // (src/fleet/control-routes.ts). This route previously fell through to "squad wins" when both
  // were present instead of refusing outright; the two panel forms never legitimately submit
  // both, so a request carrying both is malformed, not an ambiguity to silently resolve.
  if (Boolean(agent_id) === Boolean(squad_id)) {
    return c.json({ error: 'bad_request', detail: 'exactly one of agent_id/squad_id required' }, 400)
  }
  const principal = { memberId: auth.memberId ?? auth.userId, boundAgentId: auth.boundAgentId ?? null }
  const res = squad_id
    ? await emitSquadControlRequest(c.env, { squad_id, verb }, principal)
    : await emitControlRequest(c.env, { agent_id, verb }, principal)
  return c.redirect(`/fleet?hc=${encodeURIComponent(res.ok ? 'ok' : res.reason)}`)
})

// POST /fleet/wake — durable inbox ping + agent.wake Queue event. Owner/admin only
// (adversarial P2 2026-06-07). Fail closed when the pot has no tenant/sender scope.
dashboardApp.post('/fleet/wake', async (c) => {
  if (!fleetScoped(c.env)) return c.json({ error: 'fleet_not_scoped' }, 503)
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenJson('Waking a fleet agent', auth), 403)
  }
  const memberId = auth.memberId ?? auth.userId
  if (!memberId) return c.json({ error: 'no_member' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown }
  const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
  if (!agent || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
    return c.json({ error: 'invalid_agent' }, 400)
  }
  const ok = await wakeFleetAgent(c.env, agent, {
    memberId,
    boundAgentId: auth.boundAgentId ?? null,
    label: auth.email ?? 'admin',
  })
  return c.json(ok ? { ok: true } : { error: 'send_failed' }, ok ? 200 : 502)
})

// POST /fleet/control — pause/resume/deactivate/delete REQUEST (owner/admin
// only). Never a direct host action: durable agent_messages ask to FLEET_OPS_AGENT.
// Host process start/stop uses POST /fleet/host-control (signed control plane).
dashboardApp.post('/fleet/control', async (c) => {
  if (!fleetScoped(c.env)) return c.json({ error: 'fleet_not_scoped' }, 503)
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenJson('Fleet control', auth), 403)
  }
  const memberId = auth.memberId ?? auth.userId
  if (!memberId) return c.json({ error: 'no_member' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; action?: unknown }
  const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
  const action = typeof body.action === 'string' ? body.action : ''
  if (!agent || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
    return c.json({ error: 'invalid_agent' }, 400)
  }
  const r = await requestFleetControl(c.env, agent, action, {
    memberId,
    boundAgentId: auth.boundAgentId ?? null,
    label: auth.email ?? 'admin',
  })
  return c.json(r, r.ok ? 200 : 400)
})

// ── /agents — unified agent management ───────────────────────────────────────
//
// Owner/admin gated on every mutating path (create, status, delete).
// Read (GET /agents) is open to any authenticated pot member who holds at
// least one capability grant (the dashboard's global capability floor) — and
// loadAllAgents itself further scopes the roster to the squads that grant
// covers (org grant → every squad; squad/department grant → its own squads
// only). FLIGHT-001 F2.

// GET /agents — the management table: agents in the caller's squads, plus an Add form.
dashboardApp.get('/agents', async (c) => {
  const auth = c.get('auth')
  // Trivially-cheap header wiring (same light reads as Overview — bare KV get +
  // one-row D1 scalar, not the full loadBrainView/loadEconomy).
  const [agents, squadOptions, physics, spend] = await Promise.all([
    loadAllAgents(c.env, auth),
    loadSquadOptions(c.env),
    loadBrainPhysics(c.env),
    loadTodaySpendScalar(c.env),
  ])
  const canManage = isOrgAdmin(auth)
  return c.html(
    shell(c.env, 'Agents', agentsBody(agents, squadOptions, canManage), {
      physics,
      costToday: { configured: spend.configured, todayUsdMicro: spend.today_usd_micro },
    }),
  )
})

// POST /agents — create an agent (owner/admin only).
dashboardApp.post('/agents', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'Agents', orgAdminForbiddenBody('Creating an agent', auth)), 403)
  }
  const form = await c.req.parseBody()
  const squadId = typeof form.squad_id === 'string' ? form.squad_id.trim() : ''
  if (!squadId) {
    return c.html(shell(c.env, 'Agents', errorBody('Pick a squad for the agent.')), 400)
  }
  // Validate the squad exists in this pot before writing.
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env, 'Agents', errorBody('Squad not found.')), 404)
  }
  const result = await createAgent(c.env, squadId, {
    slug: form.slug,
    name: form.name,
    role: form.role,
    model: form.model,
  })
  if (!result.ok) {
    const [agents, squadOptions] = await Promise.all([loadAllAgents(c.env, auth), loadSquadOptions(c.env)])
    return c.html(
      shell(c.env, 'Agents', agentsBody(agents, squadOptions, true, `Could not add agent: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/agents')
})

// POST /agents/:id/status — pause or resume an agent (owner/admin only).
dashboardApp.post('/agents/:id/status', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Changing agent status', auth), 403)
  const agentId = c.req.param('id')
  // Validate agentId is a non-empty string (UUID format); we don't need to parse
  // the body format strictly since we validate the status value via isAgentStatus.
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  const status = body.status
  if (status !== 'active' && status !== 'paused') {
    return c.json({ error: 'invalid_status', allowed: ['active', 'paused'] }, 400)
  }
  const result = await setAgentStatus(c.env, agentId, status)
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true })
})

// DELETE /agents/:id — delete an agent row (owner/admin only).
// Note: HTML forms cannot DELETE; the client sends via fetch() with method:DELETE.
dashboardApp.delete('/agents/:id', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Deleting an agent', auth), 403)
  const agentId = c.req.param('id')
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)
  const result = await deleteAgent(c.env, agentId)
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true })
})

// POST /agents/:id/config — patch work-unit knobs on an agent (owner/admin only).
// Calls the shared updateUnitConfig from org/service — no new write logic here.
dashboardApp.post('/agents/:id/config', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Changing agent config', auth), 403)
  const agentId = c.req.param('id')
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)

  const form = await c.req.parseBody()
  const patch = parseUnitConfigPatch(form)
  const result = await updateUnitConfig(c.env, 'agent', agentId, patch)
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 400
    return c.json({ error: result.error }, status)
  }
  return c.redirect('/agents')
})

// POST /squads/:id/config — patch work-unit knobs on a squad (owner/admin only).
dashboardApp.post('/squads/:id/config', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Changing squad config', auth), 403)
  const squadId = c.req.param('id')
  if (!squadId || squadId.length > 64) return c.json({ error: 'invalid_squad_id' }, 400)

  const form = await c.req.parseBody()
  const patch = parseUnitConfigPatch(form)
  const result = await updateUnitConfig(c.env, 'squad', squadId, patch)
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 400
    return c.json({ error: result.error }, status)
  }
  return c.redirect(`/squads/${squadId}`)
})

// GET /squads/:id — squad board: charter, agents, tasks by lane.
//
// FLIGHT-001-adjacent (found auditing F2): this rendered ANY squad's full agent
// + task list to ANY authenticated caller who knew or guessed the squad id — the
// dashboard's capability floor only proves the caller belongs SOMEWHERE in the
// org, not that they belong on THIS squad. A squad-A-only member could browse
// straight to /squads/squad-b. Gated the same way GET /projects/:id already is
// (loadProjectDetail → projectAccess): org-scope capability (or legacy owner/
// admin) reads every squad; a squad/department grant reads only its own.
dashboardApp.get('/squads/:id', async (c) => {
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env, 'Squad', errorBody('Squad not found.')), 404)
  }
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    const grants = auth.memberId ? auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId)) : []
    const orgRead = hasCapability(grants, 'org', null, 'observer')
    const squadRead = orgRead || (await canOnSquadRead(c.env, grants, squadId))
    if (!squadRead) {
      return c.html(shell(c.env, 'Squad', errorBody('You do not have access to this squad.')), 403)
    }
  }
  const [agents, tasks] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE squad_id = ? ORDER BY created_at ASC, slug ASC',
    )
      .bind(squadId)
      .all<Agent>(),
    c.env.DB.prepare(
      // Ranked, not merely recent (#713). This ordered by updated_at DESC — so the human
      // board showed "most recently touched", never "most important", while the MCP path
      // ranked correctly. The board is the surface an operator opens to answer "what is
      // next"; answering it with recency is a silent wrong answer.
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks WHERE squad_id = ?
        ORDER BY ${actionableStatusOrderSql()}, ${priorityOrderSql()}, updated_at DESC`,
    )
      .bind(squadId)
      .all<Task>(),
  ])
  const canAddAgent = await canOnSquad(c.env, auth, squadId)
  const canManage = isOrgAdmin(auth)
  return c.html(
    shell(
      c.env,
      `Squad · ${squad.name}`,
      squadBoardBody(squad, agents.results ?? [], tasks.results ?? [], canAddAgent, canManage),
    ),
  )
})

// GET /agents/:id — agent console: identity, status, wake button.
// `:id` accepts id OR unique slug (resolveAgentRef) so /agents/kayhermes works.
//
// FLIGHT-001 #797 (the follow-up gap flagged auditing #796's GET /agents roster
// scope): the dashboard's global capability floor (F2) only proves the caller
// belongs SOMEWHERE in the org — any floor-passing caller who knew or guessed an
// agent id/slug could open ANY agent's console regardless of squad membership,
// the same shape as the GET /squads/:id gap #796 already closed. Gated the same
// way: org-scope capability (or legacy owner/admin) reads every agent; a
// squad/department grant reads only agents in its own squads.
dashboardApp.get('/agents/:id', async (c) => {
  const ref = c.req.param('id')
  const resolved = await resolveAgentRef(c.env, ref)
  if (!resolved.ok) {
    const msg =
      resolved.reason === 'ambiguous'
        ? 'Agent slug is ambiguous — open by UUID instead.'
        : 'Agent not found.'
    return c.html(shell(c.env, 'Agent', errorBody(msg)), 404)
  }
  const agent = await getById<Agent>(c.env, 'agents', resolved.value.id)
  if (!agent) {
    return c.html(shell(c.env, 'Agent', errorBody('Agent not found.')), 404)
  }
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    const grants = auth.memberId ? auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId)) : []
    const orgRead = hasCapability(grants, 'org', null, 'observer')
    const squadRead = orgRead || (await canOnSquadRead(c.env, grants, agent.squad_id))
    if (!squadRead) {
      return c.html(shell(c.env, 'Agent', errorBody('You do not have access to this agent.')), 403)
    }
  }
  const squad = await getById<Squad>(c.env, 'squads', agent.squad_id)
  // Mirror the wake API's real gate (lead+ on the agent's squad) so squad leads
  // see a working button — the API re-checks server-side either way.
  const canWake = await canOnSquad(c.env, auth, agent.squad_id)
  return c.html(
    shell(c.env, `Agent · ${agent.name}`, agentConsoleBody(agent, squad, canWake)),
  )
})

// ── members + divisions admin (humans as first-class network nodes) ───────────
//
// These two views are ADMIN-only (org role owner|admin). The mutating actions are
// NOT performed here — every button POSTs to the RBAC-gated member-admin API
// (/api/members/*), which re-checks fine-grained capability server-side. The
// dashboard only renders structure (read directly from this pot's D1) and the
// forms; it never trusts client-supplied identity or duplicates the API's writes.

// GET /admin/members — roster: each member, their capability grants, their live
// connection channels, suspend/reactivate, grant-capability + invite forms.
dashboardApp.get('/admin/members', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'People & Access', orgAdminForbiddenBody('The People & Access page', auth)),
      403,
    )
  }
  const [members, grants, channels, depts] = await Promise.all([
    loadMembers(c.env),
    loadGrants(c.env),
    loadChannels(c.env),
    loadDepartments(c.env),
  ])
  const scopeNames = await loadScopeNames(c.env)
  return c.html(
    shell(
      c.env,
      'People & Access',
      membersAdminBody(members, grants, channels, depts, scopeNames, auth),
    ),
  )
})

// GET /admin/divisions — departments → squads, each with its head(s): the
// member(s) holding lead+ capability on that scope.
dashboardApp.get('/admin/divisions', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Organization', orgAdminForbiddenBody('The Organization page', auth)),
      403,
    )
  }
  const [depts, squads, grants, members] = await Promise.all([
    loadDepartments(c.env),
    loadSquads(c.env),
    loadGrants(c.env),
    loadMembers(c.env),
  ])
  return c.html(
    shell(c.env, 'Organization', divisionsAdminBody(depts, squads, grants, members, auth)),
  )
})

// ── /admin/keys — scoped-key mint UI (deliverable 2) ─────────────────────────
//
// GET /admin/keys — landing page: preset picker + guide panel + active scoped keys.
// POST /admin/keys/mint — isAdmin-gated; mints a capability grant + member_token
//   using the named preset; shows the raw key EXACTLY ONCE (no redirect).
//
// Security:
//   - Both routes check isAdmin before any DB access.
//   - The CSRF middleware covers the POST (applied to all dashboard routes above).
//   - The raw token is rendered once and never persisted or logged.
//   - mintScopedKey validates that the scope_id belongs to THIS pot's D1 —
//     a caller cannot claim another tenant's squad/department uuid.

// GET /admin/keys
dashboardApp.get('/admin/keys', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Scoped Keys', orgAdminForbiddenBody('Scoped key management', auth)),
      403,
    )
  }
  const view = await loadKeysView(c.env)
  return c.html(shell(c.env, 'Scoped API Keys', keysPageBody(view)))
})

// POST /admin/keys/mint — mint + show-once
dashboardApp.post('/admin/keys/mint', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Scoped Keys', orgAdminForbiddenBody('Minting a scoped key', auth)),
      403,
    )
  }

  const form = await c.req.parseBody()
  const presetIdRaw = typeof form.preset_id === 'string' ? form.preset_id.trim() : ''
  const memberIdRaw = typeof form.member_id === 'string' ? form.member_id.trim() : ''
  const scopeIdRaw  = typeof form.scope_id  === 'string' ? form.scope_id.trim()  : null

  // Basic input validation before hitting the DB.
  if (!isValidPresetId(presetIdRaw)) {
    const view = await loadKeysView(c.env)
    return c.html(
      shell(c.env, 'Scoped API Keys', keysPageBody(view, undefined, undefined, 'Unknown preset.')),
      400,
    )
  }
  if (!memberIdRaw) {
    const view = await loadKeysView(c.env)
    return c.html(
      shell(c.env, 'Scoped API Keys', keysPageBody(view, presetIdRaw, scopeIdRaw ?? undefined, 'Pick a member.')),
      400,
    )
  }

  // Resolve the minter's effective rank on the org scope.
  // actorMaxRankOnScope combines the coarse org role (owner=5, admin=4) with any
  // fine-grained capability grants the minter holds.  This is the authoritative
  // ceiling passed to mintScopedKey for the rank-ceiling check.
  const minterRank = await actorMaxRankOnScope(c, 'org', null)

  const result = await mintScopedKey(c.env, {
    memberId: memberIdRaw,
    presetId: presetIdRaw,
    scopeId: scopeIdRaw || null,
    minterRank,
  })

  if (!result.ok) {
    const view = await loadKeysView(c.env)
    const msg = result.error === 'rank_ceiling'
      ? 'You cannot mint a key at or above your own capability rank. An admin cannot mint another admin; only an owner can.'
      : result.error === 'member_not_found'
      ? 'Member not found or inactive.'
      : result.error === 'squad_not_found'
      ? 'Squad not found.'
      : result.error === 'department_not_found'
      ? 'Department not found.'
      : result.error === 'scope_id_required_for_squad_preset'
      ? 'This preset requires a squad. Pick one from the scope picker.'
      : result.error === 'scope_id_required_for_department_preset'
      ? 'This preset requires a department. Pick one from the scope picker.'
      : result.error === 'member_lacks_capability'
      ? 'This member does not hold the capability this preset attests. Minting a key never elevates a member — grant the capability to the member first, then mint an attesting key.'
      : `Mint failed: ${result.error}`
    const statusCode =
      result.error === 'rank_ceiling' || result.error === 'member_lacks_capability' ? 403 : 400
    return c.html(
      shell(c.env, 'Scoped API Keys', keysPageBody(view, presetIdRaw, scopeIdRaw ?? undefined, msg)),
      statusCode,
    )
  }

  // Find preset label for the show-once page.
  const preset = findPreset(presetIdRaw)! // validated above
  const member = await c.env.DB.prepare(
    'SELECT display_name FROM members WHERE id = ?1 LIMIT 1',
  )
    .bind(memberIdRaw)
    .first<{ display_name: string }>()
  const memberName = member?.display_name ?? memberIdRaw

  // Render the raw key ONCE — do NOT redirect (prevents back-button retrieval).
  // Cache-Control: no-store and Referrer-Policy: no-referrer are set by the
  // dashboard-wide middleware above.
  return c.html(
    shell(
      c.env,
      'Key provisioned',
      keysMintedBody(memberName, result.label, preset.label, result.raw),
    ),
  )
})

// ── Owner Control Center (read-only, mupot#1067) ─────────────────────────────
//
// GET /admin/control-center — one owner-facing roster: hierarchy, canonical ids,
// home/additional memberships, effective capability + source, credential STATE
// (never hashes/raw), duplicate warnings. Org-admin only. Pure read — no writes.

dashboardApp.get('/admin/control-center', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Control Center', errorBody('The Control Center requires owner or admin.')),
      403,
    )
  }
  const view = await loadControlCenterView(c.env)
  return c.html(shell(c.env, 'Control Center', controlCenterPageBody(view)))
})

// ── agent-bound token mint ───────────────────────────────────────────────────
//
// Distinct from the operator token mint at POST /members/:id/tokens (which mints a
// NULL-bound token for a HUMAN member). This path mints a token whose
// member_tokens.agent_id is set to the chosen agent — required by /attach.
//
// GET /admin/agent-token — agent picker form (org-admin only).
// POST /admin/agent-token/mint — mints via the shared mintAgentBoundToken helper,
//   shows the raw token EXACTLY ONCE (no redirect, Cache-Control: no-store).
//
// Security:
//   - Both routes check isAdmin before any DB access.
//   - CSRF middleware covers the POST (applied dashboard-wide above).
//   - agent is validated against the pot's own agents table — not a free-form string.
//   - mintAgentBoundToken enforces the escalation guard and batch atomicity.
//   - Raw token rendered once; never persisted or logged anywhere.

// GET /admin/agent-token
dashboardApp.get('/admin/agent-token', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Mint agent token', orgAdminForbiddenBody('Minting an agent token', auth)),
      403,
    )
  }
  const view = await loadAgentTokenView(c.env)
  return c.html(shell(c.env, 'Mint agent token', agentTokenPageBody(view)))
})

// POST /admin/agent-token/mint
dashboardApp.post('/admin/agent-token/mint', async (c) => {
  const auth = c.get('auth')
  if (auth.boundAgentId) {
    return c.html(
      shell(c.env, 'Mint agent token', errorBody('An operator principal is required.')),
      403,
    )
  }
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Mint agent token', orgAdminForbiddenBody('Minting an agent token', auth)),
      403,
    )
  }
  const canonical = requiredCanonicalOrigin(c.env)
  if (!canonical.ok) {
    return c.html(
      shell(
        c.env,
        'Mint agent token',
        errorBody('A secure public origin must be configured before provisioning a token.'),
      ),
      503,
    )
  }

  const form = await c.req.parseBody()
  const agentIdRaw = typeof form.agent_id === 'string' ? form.agent_id.trim() : ''
  const labelRaw   = typeof form.label    === 'string' ? form.label.trim()    : ''
  const capabilityRaw = typeof form.capability === 'string' && form.capability.trim()
    ? form.capability.trim()
    : 'member'

  if (!agentIdRaw) {
    const view = await loadAgentTokenView(c.env)
    return c.html(
      shell(c.env, 'Mint agent token', agentTokenPageBody(view, 'Pick an agent.')),
      400,
    )
  }
  if (labelRaw.length > 64) {
    const view = await loadAgentTokenView(c.env)
    return c.html(
      shell(c.env, 'Mint agent token', agentTokenPageBody(view, 'Label too long (max 64 chars).')),
      400,
    )
  }
  if (!isAgentTokenCapability(capabilityRaw)) {
    const view = await loadAgentTokenView(c.env)
    return c.html(
      shell(c.env, 'Mint agent token', agentTokenPageBody(view, 'Grant must be observer or member.')),
      400,
    )
  }

  // Validate agent against the pot's own agents table (resolveAgentRef: id-first,
  // slug-with-ambiguity-refusal). A free-form string from the form is NOT trusted.
  const agentResult = await resolveAgentRef(c.env, agentIdRaw)
  if (!agentResult.ok) {
    const view = await loadAgentTokenView(c.env)
    const msg = agentResult.reason === 'ambiguous'
      ? 'Agent slug is ambiguous — use the agent id instead.'
      : 'Agent not found in this pot.'
    const status = agentResult.reason === 'ambiguous' ? 409 : 404
    return c.html(
      shell(c.env, 'Mint agent token', agentTokenPageBody(view, msg)),
      status,
    )
  }
  const agent = agentResult.value

  const expiresInDays = typeof form.expires_in_days === 'string' ? Number(form.expires_in_days) : undefined
  const { resolveAgentTokenExpiry } = await import('../auth/token-lifecycle')
  const expiry = resolveAgentTokenExpiry({
    expiresInDays,
    allowNonExpiring: auth.role === 'owner' || hasCapability(auth.capabilities ?? [], 'org', null, 'owner'),
  })
  if (!expiry.ok) {
    const view = await loadAgentTokenView(c.env)
    return c.html(
      shell(c.env, 'Mint agent token', agentTokenPageBody(view, 'Expiry must be a whole number from 1 to 365 days.')),
      400,
    )
  }
  const expiresAt = expiry.expiresAt

  // Delegate to the shared atomic-mint helper. A first mint creates the member,
  // binding, home capability, and welded token; later mints add only the token.
  // This is the same path the MCP mint_agent_token tool uses.
  const minted = await mintAgentBoundToken(c.env, agent, labelRaw, {
    grantCapability: capabilityRaw,
    expiresAt,
  })

  // Look up the squad name for the show-once page.
  const squadRow = await c.env.DB.prepare('SELECT name FROM squads WHERE id = ?1 LIMIT 1')
    .bind(agent.squad_id)
    .first<{ name: string }>()

  // Render ONCE — do NOT redirect (raw must not survive past this response).
  // Cache-Control: no-store and Referrer-Policy: no-referrer are set by the
  // dashboard-wide middleware above.
  return c.html(
    shell(
      c.env,
      'Agent token minted',
      agentTokenMintedBody(
        agent.name,
        agent.slug,
        squadRow?.name ?? null,
        minted.raw,
        minted.tokenId,
        minted.grantCapability,
      ),
    ),
  )
})

// ── connector credential vault ───────────────────────────────────────────────
//
// Admin-only routes for managing encrypted third-party tool credentials.
//
// Security:
//   - All routes require isAdmin (owner or admin org role).
//   - encrypted_secret is NEVER read in these routes — listConnectors() SQL
//     explicitly excludes it. Only resolveConnector() (service layer) may decrypt.
//   - CSRF middleware covers all POSTs (applied dashboard-wide above).
//   - Tenant-scope: the tenant = env.TENANT_SLUG is injected by the service layer;
//     the admin of pot A cannot see or write pot B's connectors.
//   - Add/rotate: the raw secret is discarded after encryption; a hint (last-4)
//     is returned once in the show-once confirmation page and not persisted.

// GET /admin/connectors — list active connectors (masked)
dashboardApp.get('/admin/connectors', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Connectors', orgAdminForbiddenBody('Connector management', auth)),
      403,
    )
  }
  const rows = await listConnectors(c.env)
  return c.html(shell(c.env, 'Connector Credentials', connectorsPageBody(rows)))
})

// POST /admin/connectors — add a new connector (encrypt + store)
dashboardApp.post('/admin/connectors', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(
      shell(c.env, 'Connectors', orgAdminForbiddenBody('Adding a connector', auth)),
      403,
    )
  }

  const form = await c.req.parseBody()
  const type      = typeof form.type       === 'string' ? form.type.trim()       : ''
  const label     = typeof form.label      === 'string' ? form.label.trim()      : ''
  const secret    = typeof form.secret     === 'string' ? form.secret            : ''
  const scopeType = typeof form.scope_type === 'string' ? form.scope_type.trim() : 'pot'
  const scopeId   = typeof form.scope_id   === 'string' && form.scope_id.trim()
    ? form.scope_id.trim()
    : null
  const meta      = typeof form.meta       === 'string' && form.meta.trim()
    ? form.meta.trim()
    : null

  if (!isConnectorType(type)) {
    const rows = await listConnectors(c.env)
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, 'Unknown connector type.')),
      400,
    )
  }
  if (!isConnectorScopeType(scopeType)) {
    const rows = await listConnectors(c.env)
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, 'Invalid scope type.')),
      400,
    )
  }

  const result = await addConnector(c.env, {
    type,
    label,
    secret,
    meta,
    scope_type: scopeType,
    scope_id: scopeId,
    created_by: auth.memberId ?? auth.userId,
  })

  if (!result.ok) {
    const rows = await listConnectors(c.env)
    const msg =
      result.error === 'secret_required'   ? 'Secret cannot be empty.' :
      result.error === 'label_required'    ? 'Label cannot be empty.' :
      result.error === 'scope_id_required' ? 'Scope ID is required for squad/agent scope.' :
      result.error === 'squad_not_found'   ? 'Squad not found in this pot.' :
      result.error === 'agent_not_found'   ? 'Agent not found in this pot.' :
      `Add failed: ${result.error}`
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, msg)),
      400,
    )
  }

  // Show-once confirmation. Raw secret is NOT echoed — only the hint (last-4).
  // Cache-Control: no-store is set by the dashboard-wide middleware.
  return c.html(
    shell(
      c.env,
      'Connector added',
      connectorAddedBody(result.connector.type, result.connector.label, result.connector.hint, result.connector.id),
    ),
  )
})

// POST /admin/connectors/:id/rotate — re-encrypt with a new secret
dashboardApp.post('/admin/connectors/:id/rotate', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenJson('Rotating a connector', auth), 403)
  }

  const connectorId = c.req.param('id')
  const form = await c.req.parseBody()
  const newSecret = typeof form.new_secret === 'string' ? form.new_secret : ''

  if (!newSecret.trim()) {
    const rows = await listConnectors(c.env)
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, 'New secret cannot be empty.')),
      400,
    )
  }

  const result = await rotateConnector(c.env, connectorId, newSecret, auth.memberId ?? auth.userId)
  if (!result.ok) {
    const rows = await listConnectors(c.env)
    const msg =
      result.error === 'not_found'       ? 'Connector not found.' :
      result.error === 'already_revoked' ? 'Cannot rotate a revoked connector.' :
      `Rotate failed: ${result.error}`
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, msg)),
      result.error === 'not_found' ? 404 : 400,
    )
  }

  return c.html(
    shell(
      c.env,
      'Secret rotated',
      connectorRotatedBody(result.connector.type, result.connector.label, result.connector.hint, result.connector.id),
    ),
  )
})

// POST /admin/connectors/:id/revoke — permanently disable a connector
dashboardApp.post('/admin/connectors/:id/revoke', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenJson('Revoking a connector', auth), 403)
  }

  const connectorId = c.req.param('id')
  const revoked = await revokeConnector(c.env, connectorId, auth.memberId ?? auth.userId)
  if (!revoked) {
    const rows = await listConnectors(c.env)
    return c.html(
      shell(c.env, 'Connector Credentials', connectorsPageBody(rows, 'Connector not found or already revoked.')),
      404,
    )
  }

  return c.redirect('/admin/connectors')
})

// ── GitHub admin (JSON API) ───────────────────────────────────────────────────
//
// The pot's GitHub hands, exposed for the operator + agents. All isAdmin-gated and
// tenant-scoped (the App token is this pot's). JSON (not HTML) so agents call them too.
//   GET  /admin/github/status         — capability snapshot (tier, kill switch, per-feature)
//   POST /admin/github/agent-def      — write .github/agents/<name>.agent.md  { repo, agentName, content, message? }
//   POST /admin/github/assign-copilot — assign an issue to Copilot            { repo, issueNumber }

dashboardApp.get('/admin/github/status', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Reading GitHub status', auth), 403)
  const snapshot = await githubCapabilitySnapshot(c.env)
  return c.json(snapshot)
})

// GET /admin/github — the HTML status + connect + sync card (A4).
dashboardApp.get('/admin/github', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.html(shell(c.env, 'GitHub', orgAdminForbiddenBody('GitHub management', auth)), 403)
  }
  const snapshot = await githubCapabilitySnapshot(c.env)
  const installationId = await getInstallationId(c.env)
  return c.html(
    shell(
      c.env,
      'GitHub',
      githubStatusBody({ ...snapshot, connected: installationId !== null, installationId }),
    ),
  )
})

dashboardApp.post('/admin/github/agent-def', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Writing an agent definition to GitHub', auth), 403)

  let body: { repo?: unknown; agentName?: unknown; content?: unknown; message?: unknown }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : ''
  const content = typeof body.content === 'string' ? body.content : ''
  const message = typeof body.message === 'string' ? body.message : undefined

  const result = await writeAgentDef(c.env, { repo, agentName, content, message })
  return c.json(result, result.ok ? 200 : 400)
})

dashboardApp.post('/admin/github/assign-copilot', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Assigning Copilot', auth), 403)

  let body: { repo?: unknown; issueNumber?: unknown }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  const issueNumber = typeof body.issueNumber === 'number' ? body.issueNumber : NaN

  const result = await assignIssueToCopilot(c.env, { repo, issueNumber })
  return c.json(result, result.ok ? 200 : 400)
})

// POST /admin/github/sync-fleet — write a .agent.md for every active pot agent into `repo`,
// each wired to THIS pot's MCP endpoint. { repo, dryRun? }. dryRun previews without writing.
dashboardApp.post('/admin/github/sync-fleet', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Syncing the fleet to GitHub', auth), 403)

  let body: { repo?: unknown; dryRun?: unknown }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
  const dryRun = body.dryRun === true
  if (!repo) return c.json({ ok: false, error: 'repo_required' }, 400)

  const mcpUrl = mcpEndpoint(new URL(c.req.url).origin)
  const result = await syncFleetToGitHub(c.env, { repo, mcpUrl, dryRun })
  return c.json({ ok: true, ...result })
})

// POST /admin/github/execute-task — own-fleet executor: ship a task's work as a PR.
// { taskId, repo, branchName, files:[{path,content}], title, body?, baseBranch? }
dashboardApp.post('/admin/github/execute-task', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Executing a task on GitHub', auth), 403)

  let body: {
    taskId?: unknown; repo?: unknown; branchName?: unknown
    files?: unknown; title?: unknown; bodyText?: unknown; baseBranch?: unknown
  }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json', stage: 'validate' }, 400)
  }
  const files = Array.isArray(body.files)
    ? (body.files as Array<{ path?: unknown; content?: unknown }>).map((f) => ({
        path: typeof f?.path === 'string' ? f.path : '',
        content: typeof f?.content === 'string' ? f.content : '',
      }))
    : []
  const result = await executeTaskAsPR(c.env, {
    taskId: typeof body.taskId === 'string' ? body.taskId : '',
    repo: typeof body.repo === 'string' ? body.repo.trim() : '',
    branchName: typeof body.branchName === 'string' ? body.branchName.trim() : '',
    baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch.trim() : undefined,
    files,
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.bodyText === 'string' ? body.bodyText : undefined,
  })
  return c.json(result, result.ok ? 200 : 400)
})

// POST /admin/github/import-project — Projects v2 ↔ pot bridge: import board items assigned to
// a named agent (via the "Agent" field) as routed tasks. { owner, projectNumber, agentField?, dryRun? }
dashboardApp.post('/admin/github/import-project', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Importing a GitHub project', auth), 403)

  let body: { owner?: unknown; projectNumber?: unknown; agentField?: unknown; dryRun?: unknown }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  const result = await importProjectItems(c.env, {
    owner: typeof body.owner === 'string' ? body.owner.trim() : '',
    projectNumber: typeof body.projectNumber === 'number' ? body.projectNumber : NaN,
    agentField: typeof body.agentField === 'string' ? body.agentField : undefined,
    dryRun: body.dryRun === true,
  })
  return c.json(result, result.ok ? 200 : 400)
})

// ── GitHub one-click connect (install flow) ───────────────────────────────────
//
// GET /admin/github/connect    — isAdmin; mint a CSRF state, redirect to the App install
// GET /connect/github/callback — GitHub redirects here post-install with installation_id;
//                                verify state (single-use, KV-stored, tenant-bound), capture id.
//
// The shared "mupot" App's key is a platform secret; this captures THIS tenant's installation_id.

dashboardApp.get('/admin/github/connect', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Connecting GitHub', auth), 403)
  const state = crypto.randomUUID()
  // Single-use, tenant-bound, 10-min TTL. Verified + deleted on callback.
  await c.env.SESSIONS.put(`ghstate:${state}`, c.env.TENANT_SLUG, { expirationTtl: 600 })
  return c.redirect(installUrl(state))
})

dashboardApp.get('/connect/github/callback', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json(orgAdminForbiddenJson('Completing the GitHub connection', auth), 403)

  const url = new URL(c.req.url)
  const state = url.searchParams.get('state') ?? ''
  // CSRF: state must match a stored, tenant-bound token. Single-use (deleted after read).
  const boundTenant = state ? await c.env.SESSIONS.get(`ghstate:${state}`) : null
  if (!boundTenant || boundTenant !== c.env.TENANT_SLUG) {
    return c.html(shell(c.env, 'Connect GitHub', errorBody('Invalid or expired connect request.')), 400)
  }
  await c.env.SESSIONS.delete(`ghstate:${state}`)

  const parsed = parseInstallCallback(url)
  if (!parsed) {
    return c.html(shell(c.env, 'Connect GitHub', errorBody('GitHub did not return a valid installation.')), 400)
  }
  await storeInstallation(c.env, parsed.installationId, url.searchParams.get('account_login'))
  return c.redirect('/admin/github/status')
})

// ── members page (GET) + token mint/revoke (POST-redirect-GET) ────────────────
//
// A focused roster: each member, their live channels, their live tokens, and
// (admin+) a mint form + per-token revoke. The Connect card on the overview shows
// the config snippet with a <MEMBER_TOKEN> placeholder; here a raw token is shown
// EXACTLY ONCE on the mint result page and never persisted/redirected. Mint + revoke
// reuse the shared members service AND the SAME org-admin gate the JSON API uses.

// GET /members — roster with mint + revoke (forms hidden for non-admins).
// FLIGHT-001-adjacent: found auditing F2. loadMembers/loadLiveTokens return the
// WHOLE org's member list (email, display_name, telegram_chat_id) and every live
// token's label/channel with no scoping — same "read was never gated" shape as
// the agent roster, but worse (PII, not just org structure), and reachable by
// ANY capability-holding member, not only zero-capability ones (the dashboard
// floor above stops the zero-capability case; it can't narrow this one since
// the page has no per-squad meaning to scope by — org membership is inherently
// org-wide). Require org-admin, same threshold /admin/members already uses.
dashboardApp.get('/members', async (c) => {
  const auth = c.get('auth')
  const canManage = await canOnOrg(c.env, auth, 'admin')
  if (!canManage) {
    return c.html(shell(c.env, 'Access Tokens', orgAdminForbiddenBody('The Access Tokens page', auth)), 403)
  }
  const [members, channels, tokens] = await Promise.all([
    loadMembers(c.env),
    loadChannels(c.env),
    loadLiveTokens(c.env),
  ])
  return c.html(
    shell(c.env, 'Access Tokens', membersPageBody(members, channels, tokens, canManage, auth)),
  )
})

// POST /members/:id/tokens — mint a scoped token, then render the SHOW-ONCE page.
// We do NOT redirect (the raw token must not survive past this one response).
dashboardApp.post('/members/:id/tokens', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env, 'Access Tokens', errorBody('Provisioning a token requires admin.')), 403)
  }
  const memberId = c.req.param('id')
  const member = await c.env.DB.prepare('SELECT id, display_name FROM members WHERE id = ? LIMIT 1')
    .bind(memberId)
    .first<{ id: string; display_name: string }>()
  if (!member) {
    return c.html(shell(c.env, 'Access Tokens', errorBody('Person not found.')), 404)
  }

  const form = await c.req.parseBody()
  const labelRaw = typeof form.label === 'string' ? form.label : ''
  if (labelRaw.length > 64) {
    return c.html(shell(c.env, 'Access Tokens', errorBody('Label too long (max 64 chars).')), 400)
  }
  const channelRaw = typeof form.channel === 'string' ? form.channel : 'workspace'
  if (!isChannel(channelRaw)) {
    return c.html(shell(c.env, 'Access Tokens', errorBody('Invalid channel.')), 400)
  }

  const canonical = requiredCanonicalOrigin(c.env)
  if (!canonical.ok) {
    return c.html(
      shell(
        c.env,
        'Access Tokens',
        errorBody('A secure public origin must be configured before provisioning a token.'),
      ),
      503,
    )
  }

  // Shared mint path — raw returned once, only the hash persisted.
  const minted = await mintMemberToken(c.env, memberId, labelRaw, channelRaw)
  return c.html(
    shell(
      c.env,
      'Token provisioned',
      tokenShowOnceBody(c.env.TENANT_SLUG, canonical.origin, member.display_name, minted),
    ),
  )
})

// POST /members/:id/tokens/:tid/revoke — revoke a token (HTML forms can't DELETE).
dashboardApp.post('/members/:id/tokens/:tid/revoke', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env, 'Access Tokens', errorBody('Revoking a token requires admin.')), 403)
  }
  await revokeMemberToken(c.env, c.req.param('id'), c.req.param('tid'))
  // Idempotent — whether or not a live token matched, land back on the roster.
  return c.redirect('/members')
})

// ── org management (POST-redirect-GET) — create department / squad / agent ────
// Each handler runs the SAME fine-grained gate the JSON API uses, then calls the
// SAME shared service. On error we re-render the relevant page with a message.

// POST /departments — create a department (org admin+).
dashboardApp.post('/departments', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env, 'Overview', errorBody('Creating a department requires admin.')), 403)
  }
  const form = await c.req.parseBody()
  const result = await createDepartment(c.env, { slug: form.slug, name: form.name })
  if (!result.ok) {
    return c.html(
      shell(c.env, 'Overview', errorBody(`Could not create department: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/admin/divisions')
})

// POST /squads — create a squad in a department (admin on THAT department).
dashboardApp.post('/squads', async (c) => {
  const auth = c.get('auth')
  const form = await c.req.parseBody()
  const departmentId = typeof form.department_id === 'string' ? form.department_id : ''
  if (!departmentId) {
    return c.html(shell(c.env, 'Overview', errorBody('Pick a department for the squad.')), 400)
  }
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) {
    return c.html(shell(c.env, 'Overview', errorBody('Department not found.')), 404)
  }
  if (!(await canOnDepartment(c.env, auth, departmentId))) {
    return c.html(
      shell(c.env, 'Overview', errorBody('Creating a squad requires admin on that department.')),
      403,
    )
  }
  const result = await createSquad(c.env, departmentId, {
    slug: form.slug,
    name: form.name,
    charter: form.charter,
  })
  if (!result.ok) {
    return c.html(
      shell(c.env, 'Overview', errorBody(`Could not create squad: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/admin/divisions')
})

// POST /squads/packs/:key — seed a starter squad pack (#11): one squad + its
// work-units in a single owner action. Admin on the target department, mirroring
// POST /squads. Uses the shared seedSquadPack → createSquad/createAgent (no D1
// bypass; full validation). The department is the form's department_id, or the
// first department when omitted (single-department pots are the common case).
dashboardApp.post('/squads/packs/:key', async (c) => {
  const auth = c.get('auth')
  const key = c.req.param('key')
  if (!SQUAD_PACKS.some((p) => p.key === key)) {
    return c.html(shell(c.env, 'Overview', errorBody('Unknown squad pack.')), 404)
  }

  const form = await c.req.parseBody()
  let departmentId = typeof form.department_id === 'string' ? form.department_id : ''
  if (!departmentId) {
    // Fall back to the first department so a single-department pot needs no picker.
    const first = await c.env.DB.prepare(
      'SELECT id FROM departments ORDER BY created_at ASC LIMIT 1',
    ).first<{ id: string }>()
    departmentId = first?.id ?? ''
  }
  if (!departmentId) {
    return c.html(shell(c.env, 'Overview', errorBody('Create a department first.')), 400)
  }
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) {
    return c.html(shell(c.env, 'Overview', errorBody('Department not found.')), 404)
  }
  if (!(await canOnDepartment(c.env, auth, departmentId))) {
    return c.html(
      shell(c.env, 'Overview', errorBody('Seeding a squad pack requires admin on that department.')),
      403,
    )
  }

  const result = await seedSquadPack(c.env, departmentId, key)
  if (!result.ok) {
    return c.html(
      shell(c.env, 'Overview', errorBody(`Could not seed pack: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  // Land on the new squad's board.
  return c.redirect(result.squad ? `/squads/${result.squad.id}` : '/')
})

// POST /squads/:id/agents — add an agent to a squad (lead+ on THAT squad).
dashboardApp.post('/squads/:id/agents', async (c) => {
  const auth = c.get('auth')
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env, 'Squad', errorBody('Squad not found.')), 404)
  }
  if (!(await canOnSquad(c.env, auth, squadId))) {
    return c.html(
      shell(c.env, `Squad · ${squad.name}`, errorBody('Adding an agent requires lead on this squad.')),
      403,
    )
  }
  const form = await c.req.parseBody()
  const result = await createAgent(c.env, squadId, {
    slug: form.slug,
    name: form.name,
    role: form.role,
    model: form.model,
  })
  if (!result.ok) {
    return c.html(
      shell(
        c.env,
        `Squad · ${squad.name}`,
        errorBody(`Could not add agent: ${result.error}.`),
      ),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect(`/squads/${squadId}`)
})

// ── join existing agent (mupot#1067) ──────────────────────────────────────────
//
// REUSE path — never creates a duplicate, never mints. Gate mirrors
// POST /agents/:id/memberships (admin on TARGET squad, dept inherits).
//
// GET  /squads/:id/agents/join?ref=… — resolve + preview (fail-closed on ambiguity)
// POST /squads/:id/agents/join       — confirm via setAgentSquadAccess (idempotent)

dashboardApp.get('/squads/:id/agents/join', async (c) => {
  const auth = c.get('auth')
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) return c.html(shell(c.env, 'Squad', errorBody('Squad not found.')), 404)
  if (!(await canOnSquad(c.env, auth, squadId))) {
    return c.html(
      shell(c.env, `Squad · ${squad.name}`, errorBody('Adding an agent requires lead on this squad.')),
      403,
    )
  }
  const ref = typeof c.req.query('ref') === 'string' ? c.req.query('ref') ?? '' : ''
  const result = ref ? await loadJoinPreview(c.env, squad, ref) : { ok: false, error: 'invalid_ref' as const }
  return c.html(shell(c.env, `Add existing agent · ${squad.name}`, joinPreviewPageBody(squad, ref, result)))
})

dashboardApp.post('/squads/:id/agents/join', async (c) => {
  const auth = c.get('auth')
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) return c.html(shell(c.env, 'Squad', errorBody('Squad not found.')), 404)
  // Join writes a membership — requires admin on the TARGET squad (same gate as
  // POST /agents/:id/memberships in src/org/index.ts; dept grants inherit).
  if (isOrgAdmin(auth)) {
    // org-admin ok
  } else {
    const grants = auth.memberId ? auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId)) : []
    const deptId = await squadDepartment(c.env, squadId)
    if (!hasCapability(grants, 'squad', squadId, 'admin', deptId)) {
      return c.html(
        shell(c.env, `Squad · ${squad.name}`, errorBody('Joining an existing agent requires admin on this squad.')),
        403,
      )
    }
  }

  const form = await c.req.parseBody()
  const agentId = typeof form.agent_id === 'string' ? form.agent_id.trim() : ''
  const capability = typeof form.capability === 'string' ? form.capability.trim() : 'member'
  if (!agentId) {
    return c.html(shell(c.env, `Squad · ${squad.name}`, errorBody('Agent id is required.')), 400)
  }

  // Re-resolve the EXACT agent row by id (never slug at write time — the preview
  // already de-ambiguated; the write pins the id).
  const agent = await getById<Agent>(c.env, 'agents', agentId)
  if (!agent) return c.html(shell(c.env, `Squad · ${squad.name}`, errorBody('Agent not found.')), 404)

  const outcome = await confirmJoin(c.env, squad, agentId, capability)
  if (!outcome.ok) {
    const msg =
      outcome.error === 'agent_identity_unminted'
        ? 'This agent has no welded identity. Mint an agent-bound token first — joining never mints.'
        : `Could not join agent: ${outcome.error}.`
    return c.html(shell(c.env, `Squad · ${squad.name}`, errorBody(msg)), 409)
  }
  return c.html(
    shell(c.env, 'Membership confirmed', joinConfirmedBody(squad, agent.name, outcome.result, capability)),
  )
})

// Capture the real Hono GET table before registering the addon wildcard. Catalog
// links and fallback dispatch compile this same set of exact and parameterized
// routes, so every advertised addon path is reachable by the fallback.
export const dashboardBuiltInGetRoutes = Object.freeze(dashboardApp.routes
  .filter((route) => route.method === 'GET')
  .map((route) => Object.freeze({ method: route.method, path: route.path })))

dashboardApp.get('*', async (c) => {
  if (!isOrgAdmin(c.get('auth'))) {
    return c.html(shell(c.env, 'Addon console', orgAdminForbiddenBody('The addon console', c.get('auth'))), 403)
  }
  const resolved = createAddonConsoleResolver(
    listRegisteredAddons(),
    dashboardBuiltInGetRoutes,
  ).resolve(c.req.path)
  if (!resolved) {
    return c.html(shell(c.env, 'Addon console', errorBody('Addon console not found.')), 404)
  }
  try {
    const installation = latestInstallationByKey(await listAddonInstallations(c.env))
      .get(resolved.entry.manifest.key)
    if (!installedAddonIdentityMatches(resolved.entry, installation)) {
      return c.html(shell(c.env, resolved.section.title, errorBody('Addon console not found.')), 404)
    }
    const body = await resolved.renderer.render(c.env, installation)
    return c.html(shell(c.env, resolved.section.title, body))
  } catch {
    return c.html(shell(c.env, resolved.section.title, errorBody('Addon console is unavailable.')), 500)
  }
})

// ── config patch helper ───────────────────────────────────────────────────────
//
// Parse a multipart form body into a UnitConfigPatch. Only fields present in the
// form are included in the patch — absent fields are not sent to updateUnitConfig,
// so they remain untouched in D1. Budget cap arrives as a dollar amount from the
// form (input type=number, step=0.01) and is converted to integer cents here.

function parseUnitConfigPatch(form: Record<string, string | File>): UnitConfigPatch {
  const patch: UnitConfigPatch = {}
  if ('okr' in form)           patch.okr = typeof form.okr === 'string' ? form.okr.trim() || null : null
  if ('kpi_target' in form)    patch.kpi_target = typeof form.kpi_target === 'string' ? form.kpi_target.trim() || null : null
  if ('effort' in form)        patch.effort = form.effort
  if ('autonomy' in form)      patch.autonomy = form.autonomy
  if ('budget_window' in form) patch.budget_window = form.budget_window
  if ('budget_cap_dollars' in form) {
    const raw = typeof form.budget_cap_dollars === 'string' ? form.budget_cap_dollars.trim() : ''
    if (raw === '' || raw === '0') {
      patch.budget_cap_cents = null
    } else {
      const dollars = parseFloat(raw)
      // Clamp to integer cents; reject NaN/negative
      patch.budget_cap_cents = Number.isFinite(dollars) && dollars >= 0
        ? Math.round(dollars * 100)
        : null
    }
  }
  return patch
}

// ── data (squad board page helpers) ─────────────────────────────────────────

type DashTable = 'departments' | 'squads' | 'agents'
async function getById<T>(env: Env, table: DashTable, id: string): Promise<T | null> {
  // table is an internal allow-listed literal — never caller-supplied.
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<T>()
  return row ?? null
}

// ── members / divisions data ──────────────────────────────────────────────────
//
// All reads are direct against this pot's D1 (one DB per tenant). The dashboard
// renders STRUCTURE only — the member-admin API owns every write.

/** Synchronous owner check for the first-run nudge ONLY — reads the org 'owner'
 *  grant already resolved onto the AuthContext (no DB hit). The wizard does the
 *  authoritative async check (resolveCapabilities); this is a convenience so a
 *  member-authn owner is nudged too without an extra query on every overview load. */
function hasOrgOwnerCapability(auth: AuthContext): boolean {
  return (auth.capabilities ?? []).some(
    (g) => g.scope_type === 'org' && g.scope_id === null && g.capability === 'owner',
  )
}

// ── write-gates (mirror src/org exactly so the dashboard never WIDENS the API) ──
// These are the authoritative, async, fine-grained checks the dashboard's POST
// handlers run before any mutation. They replicate the org API's gate logic 1:1:
// org-admin → departments + tokens; admin-on-department → squads; lead-on-squad →
// agents (with department→squad inheritance). isOrgAdmin() doubles as the legacy
// owner/admin escape, identical to requireCapability's.

/** Resolve a squad's department for department→squad capability inheritance. */
async function squadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

/** org-scope capability gate (e.g. minting a token / creating a department → admin). */
async function canOnOrg(env: Env, auth: AuthContext, min: 'admin' | 'owner'): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  return hasCapability(grants, 'org', null, min)
}

/** department-scope gate (creating a squad → admin on THAT department). */
async function canOnDepartment(
  env: Env,
  auth: AuthContext,
  departmentId: string,
): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  return hasCapability(grants, 'department', departmentId, 'admin')
}

/** squad-scope gate (creating an agent → lead on THAT squad, dept grants inherit). */
async function canOnSquad(env: Env, auth: AuthContext, squadId: string): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  const deptId = await squadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, 'lead', deptId)
}

/**
 * squad-scope READ gate (GET /squads/:id, FLIGHT-001-adjacent) — the read
 * threshold is 'observer', deliberately lower than canOnSquad's 'lead' write
 * threshold above: any real member of the squad (down to observer) can view
 * its board, matching the read floor everywhere else in this file (agent
 * roster, projects). Takes already-resolved `grants` (caller already resolved
 * them for the org-read check this is OR'd with) rather than re-querying.
 */
async function canOnSquadRead(env: Env, grants: CapabilityGrant[], squadId: string): Promise<boolean> {
  const deptId = await squadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, 'observer', deptId)
}

async function loadMembers(env: Env): Promise<Member[]> {
  const rows = await env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members ORDER BY created_at ASC, display_name ASC',
  ).all<Member>()
  return rows.results ?? []
}

async function loadGrants(env: Env): Promise<CapabilityGrant[]> {
  const rows = await env.DB.prepare(
    `SELECT member_id, scope_type, scope_id, capability
       FROM capabilities
     UNION ALL
     SELECT member_id, 'squad' AS scope_type, squad_id AS scope_id, capability
       FROM channel_capability_grants`,
  ).all<CapabilityGrant>()
  return rows.results ?? []
}

interface MemberChannel {
  member_id: string
  channel: ConnectionChannel
}

/** Live (non-revoked) connection channels per member, derived from member_tokens. */
async function loadChannels(env: Env): Promise<MemberChannel[]> {
  const rows = await env.DB.prepare(
    'SELECT DISTINCT member_id, channel FROM member_tokens WHERE tenant = ? AND revoked_at IS NULL',
  ).bind(env.TENANT_SLUG).all<MemberChannel>()
  return rows.results ?? []
}

async function loadDepartments(env: Env): Promise<Department[]> {
  const rows = await env.DB.prepare(
    'SELECT id, slug, name, created_at FROM departments ORDER BY created_at ASC, name ASC',
  ).all<Department>()
  return rows.results ?? []
}

async function loadSquads(env: Env): Promise<Squad[]> {
  const rows = await env.DB.prepare(
    'SELECT id, department_id, slug, name, charter, created_at FROM squads ORDER BY created_at ASC, name ASC',
  ).all<Squad>()
  return rows.results ?? []
}

/** Active agents joined to their squad name — the /send agent picker. One pot is
 *  small, so a single join is fine. Returns a flat list with a squad label. */
interface PickerAgent {
  id: string
  name: string
  role: string
  squad_id: string
  squad_name: string
}
async function loadActiveAgentsWithSquad(env: Env, squadIds?: string[]): Promise<PickerAgent[]> {
  if (squadIds?.length === 0) return []
  const filter = squadIds === undefined
    ? ''
    : ' AND a.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))'
  const statement = env.DB.prepare(
    `SELECT a.id AS id, a.name AS name, a.role AS role, a.squad_id AS squad_id, s.name AS squad_name
       FROM agents a JOIN squads s ON s.id = a.squad_id
      WHERE a.status = 'active'${filter}
      ORDER BY s.name ASC, a.name ASC`,
  )
  const rows = squadIds === undefined
    ? await statement.all<PickerAgent>()
    : await statement.bind(JSON.stringify([...new Set(squadIds)])).all<PickerAgent>()
  return rows.results ?? []
}

// ── Flight-008 Slice 3 (mupot#1062) — disambiguated dispatch-now picker ────────
//
// loadActiveAgentsWithSquad above answers "which agents COULD this squad ever
// task" (catalog membership: agents.status='active') and still backs the backlog
// form's squad list + optional assignee — a backlog task is allowed to name an
// agent that isn't live right now, since nothing wakes until later. The
// "Dispatch now" panel is different: it WAKES the agent immediately, so offering
// a not-runtime / unattached / stale-seat identity there is a silent misdispatch
// (the owner picks a name, nothing is actually listening). loadDispatchableAgents
// answers the narrower, execution-safe question: "which of this squad's active
// agents has a REACHABLE runtime right now" — reachability is the SAME
// dual-surface presence getFleetAgentRuntimeStates already computes for the
// routine scheduler (mupot#732), not a reinvented notion.

type SeatStatus = FleetAgentRuntimeState['presence'] // 'live' | 'stale' | 'offline'

export interface DispatchableAgent {
  id: string
  slug: string
  name: string
  role: string
  model: string
  squad_id: string
  squad_name: string
  seat_status: SeatStatus
  last_seen: string
}

export interface DispatchDefault {
  agent_id: string | null
  reason: string
}

interface DispatchAgentCandidate {
  id: string
  slug: string
  name: string
  role: string
  model: string
  squad_id: string
  squad_name: string
}

/**
 * isLiveRuntimeState — the ONE predicate that decides "reachable enough to wake
 * right now." Factored out as its own named function (rather than inlined in the
 * filter loop below) so a mutation that deletes/inverts this check is directly
 * observable: strip the call in loadDispatchableAgents and every seeded
 * stale/unattached/offline seat starts getting offered again (see
 * tests/dashboard-send-picker.test.ts, "reachability filter is load-bearing").
 */
export function isLiveRuntimeState(state: FleetAgentRuntimeState | undefined): boolean {
  return state !== undefined && state.presence === 'live'
}

/**
 * loadDispatchableAgents — active agents in scope, narrowed to ones with a LIVE
 * runtime right now. Excludes, by construction (never a post-fetch client-side
 * hide — every exclusion happens in this server function before the row ever
 * reaches HTML):
 *   - not-runtime / unattached: agent has NEVER reported to either presence
 *     surface (fleet_agents or module_registry) — getFleetAgentRuntimeStates
 *     returns no entry for it at all, so isLiveRuntimeState(undefined) is false.
 *   - stale-seat: a presence row exists but its heartbeat has aged past the TTL
 *     (presence: 'stale') or was explicitly detached (presence: 'offline').
 *   - ambiguous-duplicate: when a runtime attached under a bare SLUG that more
 *     than one agent (across squads) shares, getFleetAgentRuntimeStates REFUSES
 *     to attribute that row to any of them (readFleetAgentRow's cardinality
 *     check, src/fleet/registry.ts) — such an agent also reads as "no entry"
 *     here. This is distinct from two agents that each carry their OWN
 *     exact-id-keyed presence row and simply happen to share a slug across
 *     squads: those are NOT ambiguous (id lookup always wins unconditionally)
 *     and both surface as separate, live, distinctly-badged rows — see the
 *     "same slug, different squads, never collapsed" test.
 * Never groups/dedupes by name or slug — one row per agents.id, always.
 */
export async function loadDispatchableAgents(env: Env, squadIds?: string[], nowMs = Date.now()): Promise<DispatchableAgent[]> {
  if (squadIds?.length === 0) return []
  const filter = squadIds === undefined
    ? ''
    : ' AND a.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))'
  const statement = env.DB.prepare(
    `SELECT a.id AS id, a.slug AS slug, a.name AS name, a.role AS role, a.model AS model,
            a.squad_id AS squad_id, s.name AS squad_name
       FROM agents a JOIN squads s ON s.id = a.squad_id
      WHERE a.status = 'active'${filter}
      ORDER BY s.name ASC, a.name ASC`,
  )
  const rows = squadIds === undefined
    ? await statement.all<DispatchAgentCandidate>()
    : await statement.bind(JSON.stringify([...new Set(squadIds)])).all<DispatchAgentCandidate>()
  const candidates = rows.results ?? []
  if (candidates.length === 0) return []

  // getFleetAgentRuntimeStates throws past MAX_RUNTIME_STATE_BATCH — a pot is
  // documented as small (loadActiveAgentsWithSquad's own docstring above), but
  // fail safe rather than 500 the whole /send page: cap the batch rather than
  // let an unusually large roster take the page down. A truncated candidate set
  // can only OMIT potential live agents, never wrongly ADMIT an unreachable one.
  const identities: FleetAgentIdentity[] = candidates
    .slice(0, MAX_RUNTIME_STATE_BATCH)
    .map((a) => ({ agent_id: a.id, slug: a.slug }))
  const states = await getFleetAgentRuntimeStates(env, identities, nowMs)

  const live: DispatchableAgent[] = []
  for (const a of candidates) {
    const state = states.get(a.id)
    if (!isLiveRuntimeState(state)) continue
    live.push({
      id: a.id,
      slug: a.slug,
      name: a.name,
      role: a.role,
      model: a.model,
      squad_id: a.squad_id,
      squad_name: a.squad_name,
      seat_status: (state as FleetAgentRuntimeState).presence,
      last_seen: (state as FleetAgentRuntimeState).last_seen,
    })
  }
  return live
}

/**
 * pickDispatchDefault — the deterministic default for the "Dispatch now" picker.
 * Never a first-row/array-order pick (that was the arbitrary-default bug,
 * mupot#1062): the ONLY case that pre-selects anything is exactly one live
 * runtime, and the reason string is always returned alongside the id so the UI
 * can show WHY that one (or no one) is selected — never a silent default.
 */
export function pickDispatchDefault(agents: DispatchableAgent[]): DispatchDefault {
  if (agents.length === 0) {
    return { agent_id: null, reason: 'No reachable agents are live right now — nothing can be auto-selected.' }
  }
  if (agents.length === 1) {
    const only = agents[0]
    return {
      agent_id: only.id,
      reason: `Only live runtime — ${only.name} (${only.squad_name}) auto-selected.`,
    }
  }
  return {
    agent_id: null,
    reason: `${agents.length} live runtimes available — choose one.`,
  }
}

/** id → display name for department & squad scopes, so grants read as names not uuids. */
async function loadScopeNames(env: Env): Promise<Map<string, string>> {
  const [depts, squads] = await Promise.all([loadDepartments(env), loadSquads(env)])
  const m = new Map<string, string>()
  for (const d of depts) m.set(d.id, d.name)
  for (const s of squads) m.set(s.id, s.name)
  return m
}

// ── views ────────────────────────────────────────────────────────────────────

const TASK_LANES: ReadonlyArray<{ key: Task['status']; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
]

// ── topbar header chips (regime + spend) ────────────────────────────────────
//
// Both chips were static placeholders (regime: display:none; spend: never
// rendered at all). Wired live, but ONLY on the routes that already load the
// backing data for their own page — so wiring costs ZERO extra reads and is
// GUARANTEED to agree with what that page shows elsewhere:
//   - regime chip: /brain already calls loadBrainView, which fetches the KV
//     physics snapshot for its own coherence panel (loadBrainPhysics). We pass
//     that SAME already-loaded `view.physics` into shell()'s header param —
//     no second KV read.
//   - spend chip: /economy already calls loadEconomy for its own stat cards.
//     We pass that SAME already-loaded `data.{configured,today_usd_micro}` —
//     no second D1 round-trip, and the header figure is BY CONSTRUCTION the
//     same number as the Economy page's "Today" card (same source, same call).
// Every other route omits the 4th shell() argument, so `header` defaults to
// `{}` and both chips render in their pre-existing honest-empty state (regime:
// hidden; spend: "no data") — NOT a regression, just not wired there yet.
// Extending live wiring to more routes only means passing more `header` data
// from a handler that already has it — never re-deriving regime or spend logic.

/** Header-chip data a route MAY pass into shell(). Everything optional; when a
 *  field is omitted the corresponding chip shows its honest-empty state. */
interface HeaderChips {
  /** Latest coherence physics snapshot (from loadBrainView), or null when KV is
   *  genuinely empty. Omit entirely on routes that don't load physics. */
  physics?: PhysicsSnapshot | null
  /** Today's spend, straight from loadEconomy's own fields. `configured: false`
   *  means cc_spend_daily has never been pushed to (never fabricate a number in
   *  that case); `configured: true` with `todayUsdMicro: 0` is an honest $0.00 —
   *  spend WAS tracked today, it was just zero. */
  costToday?: { configured: boolean; todayUsdMicro: number } | null
}

/** Regime label shown in the compact header chip — just Title-Cases the raw
 *  `physics.regime` string (already computed by the sovereign daemon; this is
 *  formatting, not regime derivation). The longer descriptive label + color
 *  class live in brain.ts (regimeLabel / regimeBadgeClass) for the full panel. */
function shortRegimeLabel(regime: string): string {
  return regime.length > 0 ? regime.charAt(0).toUpperCase() + regime.slice(1) : regime
}

/** Render the topbar regime chip. Reuses brain.ts's regimeBadgeClass() for the
 *  color mapping (flow/chaos/coercion/stall → ok/warn2/accent/danger) instead of
 *  re-deriving it. `physics` undefined/null → honest hidden "no data" state,
 *  identical to the pre-wire placeholder — never fabricates a regime. */
export function regimeChipHtml(physics: PhysicsSnapshot | null | undefined) {
  if (!physics) {
    return html`<div class="regime-chip" id="regime-chip" style="display:none" title="Coherence regime — no physics snapshot yet.">
      <span class="regime-dot" id="regime-dot"></span>
      <span class="regime-label" id="regime-label">—</span>
      <span class="regime-ct" id="regime-ct">C(t) —</span>
    </div>`
  }
  const cls = regimeBadgeClass(physics.regime)
  return html`<div class="regime-chip ${raw(cls)}" id="regime-chip" title="Coherence regime — brain physics from KV (sovereign daemon).">
    <span class="regime-dot" id="regime-dot"></span>
    <span class="regime-label" id="regime-label">${shortRegimeLabel(physics.regime)}</span>
    <span class="regime-ct" id="regime-ct">C(t) ${physics.C.toFixed(3)}</span>
  </div>`
}

/** Render the topbar spend chip. `cost` undefined/null → this route hasn't
 *  wired spend data (hidden, same shape as before). `configured: false` → an
 *  honest "no spend yet" (cc_spend_daily has never been pushed to — never show
 *  $0.00 as if spend were tracked and happened to be zero). Otherwise renders
 *  formatUsd(todayUsdMicro) — the SAME formatter + SAME field the Economy page
 *  uses for its "Today" stat card. */
export function spendChipHtml(cost: { configured: boolean; todayUsdMicro: number } | null | undefined) {
  if (!cost) {
    return html`<div class="spend-chip" id="spend-chip" style="display:none" title="Today's spend — not loaded on this page.">
      <span class="spend-chip-dot">◆</span><span id="spend-chip-value">—</span>
    </div>`
  }
  if (!cost.configured) {
    return html`<div class="spend-chip" id="spend-chip" title="No Claude Code spend has been pushed to this pot yet.">
      <span class="spend-chip-dot">◆</span><span id="spend-chip-value">no spend yet</span>
    </div>`
  }
  return html`<div class="spend-chip" id="spend-chip" title="Today's Claude Code spend (Anthropic list price) — same figure as the Economy page's Today card.">
    <span class="spend-chip-dot">◆</span><span id="spend-chip-value">${raw(formatUsd(cost.todayUsdMicro))} today</span>
  </div>`
}

/** Where the sidebar's "Switch pot →" link sends a checked-in user (the
 *  cross-tenant pot picker). Hardcoded to mumega's own console for every
 *  forked pot until #de-mumega-ify: a customer's users would land on OUR
 *  site. `env.CONSOLE_SWITCH_POT_URL` overrides it; unset ⇒ this default,
 *  so mumega's own deploy is byte-identical. */
export const DEFAULT_CONSOLE_SWITCH_POT_URL = 'https://mumega.com/dashboard/pots'

export function resolveSwitchPotUrl(env: Env): string {
  return env.CONSOLE_SWITCH_POT_URL || DEFAULT_CONSOLE_SWITCH_POT_URL
}

/** Outer HTML document with inline CSS (no framework, no build step).
 *
 * Theme: light by default, dark toggled via [data-theme="dark"] on <html>.
 * Persisted in localStorage under the key "mupot-theme".
 * Fonts: Instrument Serif (headings/metrics) · Hanken Grotesk (body) · JetBrains Mono (IDs/badges).
 * Sidebar: Stripe-style with collapsible sections that remember open/closed state.
 */
export function shell(
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  header: HeaderChips = {},
) {
  const brand = env.BRAND
  const switchPotUrl = resolveSwitchPotUrl(env)
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · ${brand}</title>
    <link rel="icon" type="image/png" href="${raw(`data:image/png;base64,${MUPOT_FAVICON_32_PNG_B64}`)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>
      /* ── Light palette (default) ─────────────────────────────────────────── */
      :root {
        --bg: #f6f7f6;
        --surface: #fff;
        --sidebar: #fff;
        --text: #171b19;
        --text2: #454c48;
        --dim: #7a827d;
        --primary: #96780A;
        --primary-soft: #f7f1dd;
        --border: #e7e9e7;
        --border-soft: #eef0ee;
        --hover: #f4f6f4;
        --bars: #dfe6e1;
        /* semantic aliases kept for view bodies */
        --surface2: #f4f6f4;
        --muted: #7a827d;
        --accent: #96780A;
        --accent2: #06b6d4;
        --ok: #16a34a;
        --warn: #ca8a04;
        --radius: 10px;
        --font-display: 'Instrument Serif', Georgia, serif;
        --font-body: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
        --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      /* ── Dark palette ─────────────────────────────────────────────────────── */
      [data-theme="dark"] {
        --bg: #0e1116;
        --surface: #161b22;
        --sidebar: #161b22;
        --text: #e6edf3;
        --text2: #9aa7b5;
        --dim: #6b7685;
        --primary: #d4a017;
        --primary-soft: #2e2812;
        --border: #2a3140;
        --border-soft: #222b38;
        --hover: #1c2230;
        --bars: #2a3140;
        --surface2: #1c2230;
        --muted: #9aa7b5;
        --accent: #d4a017;
        --accent2: #06b6d4;
        --ok: #3fb950;
        --warn: #d29922;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        background: var(--bg); color: var(--text);
        font-family: var(--font-body);
        font-size: 15px; line-height: 1.55;
        -webkit-font-smoothing: antialiased;
      }
      a { color: var(--primary); text-decoration: none; }
      a:hover { text-decoration: underline; }
      ::selection { background: rgba(14,122,85,.18); }
      :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
      ::-webkit-scrollbar { width: 11px; height: 11px; }
      ::-webkit-scrollbar-thumb {
        background: var(--border); border-radius: 8px;
        border: 3px solid transparent; background-clip: content-box;
      }

      /* ── App layout ──────────────────────────────────────────────────────── */
      .layout { display: flex; min-height: 100vh; }

      /* ── Sidebar ─────────────────────────────────────────────────────────── */
      .sidebar {
        width: 252px; flex-shrink: 0; background: var(--sidebar);
        border-right: 1px solid var(--border);
        position: sticky; top: 0; height: 100vh; overflow-y: auto;
        display: flex; flex-direction: column;
      }
      /* pot switcher */
      .switcher { border-bottom: 1px solid var(--border); padding: 12px 12px 8px; }
      .switcher > summary {
        list-style: none; cursor: pointer; user-select: none;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 9px; border: 1px solid var(--border); border-radius: 10px;
        font-weight: 700; color: var(--text); background: transparent;
      }
      .switcher > summary::-webkit-details-marker { display: none; }
      .switcher > summary .pot-icon {
        width: 30px; height: 30px; flex: none; border-radius: 8px;
        overflow: hidden; background: #f7f3ef;
        display: flex; align-items: center; justify-content: center;
      }
      .switcher > summary .pot-icon img {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      .switcher > summary .pot-name {
        flex: 1; min-width: 0; font-size: 13.5px; font-weight: 700;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .switcher > summary .caret { color: var(--dim); flex: none; }
      .switcher-menu {
        background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
        box-shadow: 0 8px 30px rgba(16,24,20,.14); padding: 6px; margin-top: 6px;
      }
      .switcher-menu-label {
        font-family: var(--font-mono); font-size: 10px; letter-spacing: .6px;
        color: var(--dim); padding: 7px 9px 5px;
      }
      .switcher-menu a {
        display: flex; align-items: center; padding: 8px 10px; border-radius: 8px;
        color: var(--text2); font-size: 13px;
      }
      .switcher-menu a:hover { background: var(--hover); text-decoration: none; }
      .switcher-checkout { color: var(--warn) !important; }
      .switcher-whoami {
        padding: 6px 10px 8px; font-size: 12px; color: var(--dim);
        border-bottom: 1px solid var(--border-soft); margin-bottom: 4px;
      }
      .switcher-whoami b { color: var(--text2); font-weight: 600; }
      /* search bar */
      .sidebar-search { padding: 4px 12px 10px; }
      .sidebar-search-inner {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        border: 1px solid var(--border); border-radius: 9px; background: var(--bg);
      }
      .sidebar-search-inner input {
        border: none; outline: none; background: transparent;
        font-family: var(--font-body); font-size: 13px; color: var(--text); width: 100%;
      }
      .sidebar-search-inner .kbd {
        font-family: var(--font-mono); font-size: 10px; color: var(--dim);
        border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; flex: none;
      }
      /* nav sections */
      .nav-scroll { flex: 1; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; }
      .nav-link {
        display: flex; align-items: center; gap: 9px;
        padding: 7px 9px; border-radius: 8px;
        color: var(--text2); font-size: 13.5px;
        cursor: pointer; text-decoration: none;
        border: none; background: transparent; width: 100%; text-align: left;
        font-family: var(--font-body);
      }
      .nav-link:hover { background: var(--hover); text-decoration: none; color: var(--text); }
      .nav-link.active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
      .nav-link svg { flex: none; color: inherit; }
      .nav-link .nav-label { flex: 1; }
      /* collapsible section header (parent link with chevron) */
      .nav-section { display: flex; flex-direction: column; }
      .nav-section-toggle {
        display: flex; align-items: center; gap: 9px;
        padding: 7px 9px; border-radius: 8px;
        color: var(--text2); font-size: 13.5px;
        cursor: pointer; background: transparent; border: none;
        width: 100%; text-align: left; font-family: var(--font-body);
      }
      .nav-section-toggle:hover { background: var(--hover); color: var(--text); }
      .nav-section-toggle .nav-label { flex: 1; }
      .nav-chevron { flex: none; transition: transform .18s; color: var(--dim); }
      .nav-chevron.open { transform: rotate(90deg); }
      .nav-children {
        display: flex; flex-direction: column; gap: 1px; margin: 1px 0 2px;
        /* hidden by default; JS toggles display */
      }
      .nav-children[hidden] { display: none; }
      .nav-child {
        display: flex; align-items: center;
        padding: 6px 9px 6px 36px; border-radius: 8px;
        color: var(--text2); font-size: 13px;
        cursor: pointer; text-decoration: none;
        border: none; background: transparent; width: 100%; text-align: left;
        font-family: var(--font-body);
      }
      .nav-child:hover { background: var(--hover); text-decoration: none; color: var(--text); }
      .nav-child.active { color: var(--primary); font-weight: 600; }
      /* SOVEREIGNTY label */
      .nav-sovereignty-label {
        font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px;
        color: var(--dim); padding: 16px 10px 6px; text-transform: uppercase;
      }
      /* count badge */
      .nav-badge {
        font-family: var(--font-mono); font-size: 10px; font-weight: 700;
        min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
        background: var(--primary); color: #fff;
        display: flex; align-items: center; justify-content: center; flex: none;
      }
      /* sidebar bottom: account row + theme toggle */
      .sidebar-footer {
        border-top: 1px solid var(--border); padding: 10px 12px;
        display: flex; align-items: center; gap: 10px; flex: none;
      }
      .sidebar-footer-account {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
        background: transparent; border: none; cursor: pointer; padding: 0; text-align: left;
      }
      .sidebar-footer-avatar {
        width: 30px; height: 30px; flex: none; border-radius: 50%;
        background: linear-gradient(135deg,var(--bars),var(--border));
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 700; color: var(--text2);
      }
      .sidebar-footer-name { font-size: 13px; font-weight: 600; color: var(--text); }
      .sidebar-footer-role { font-size: 11px; color: var(--dim); }
      .sidebar-theme-btn {
        width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 8px;
        background: transparent; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: var(--dim); font-size: 14px; flex: none;
      }
      .sidebar-theme-btn:hover { background: var(--hover); color: var(--text); }

      /* ── Top bar ─────────────────────────────────────────────────────────── */
      .topbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; gap: 14px;
        padding: 0 28px; height: 60px;
        background: rgba(246,247,246,.88);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid var(--border);
      }
      [data-theme="dark"] .topbar { background: rgba(14,17,22,.88); }
      .topbar-crumb { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .topbar-crumb-pot { color: var(--dim); }
      .topbar-crumb-sep { color: var(--border); }
      .topbar-crumb-view { color: var(--text); font-weight: 600; }
      .regime-chip {
        display: flex; align-items: center; gap: 7px;
        padding: 5px 11px; border-radius: 8px;
        background: var(--primary-soft);
        font-size: 12.5px;
      }
      .regime-chip .regime-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--primary); flex: none; }
      .regime-chip .regime-label { font-weight: 700; color: var(--primary); }
      .regime-chip .regime-ct { font-family: var(--font-mono); font-size: 11px; color: var(--dim); }
      /* regime-dot color per regime — SAME regime→color mapping as brain.ts's
       * .regime-badge classes (regimeBadgeClass, reused not reinvented): flow=ok,
       * chaos=warn2, coercion=accent, stall=danger. --danger/--warn2 are defined
       * further down (Observatory section) but CSS custom properties resolve by
       * cascade, not declaration order, so this is safe. */
      .regime-chip.regime-flow     .regime-dot { background: var(--ok, #16a34a); }
      .regime-chip.regime-chaos    .regime-dot { background: var(--warn2, #d29922); }
      .regime-chip.regime-coercion .regime-dot { background: var(--accent); }
      .regime-chip.regime-stall    .regime-dot { background: var(--danger, #c0392b); }
      .topbar-spacer { flex: 1; }
      .cloud-pill, .spend-chip {
        display: flex; align-items: center; gap: 7px;
        padding: 6px 11px; border: 1px solid var(--border); border-radius: 8px;
        background: var(--surface);
        font-family: var(--font-mono); font-size: 11px; color: var(--text2);
      }
      .cloud-pill-dot, .spend-chip-dot { color: var(--primary); }
      .topbar-invite {
        padding: 7px 14px; border: none; border-radius: 8px;
        background: var(--primary); color: #fff; cursor: pointer;
        font-size: 13px; font-weight: 600; font-family: var(--font-body);
        box-shadow: 0 1px 2px rgba(14,122,85,.3);
      }
      .topbar-invite:hover { filter: brightness(1.06); }
      .topbar-menu-btn {
        display: none; align-items: center; justify-content: center;
        width: 34px; height: 34px; flex: none;
        border: 1px solid var(--border); border-radius: 8px;
        background: var(--surface); cursor: pointer; color: var(--text2);
      }

      /* ── Main content area ───────────────────────────────────────────────── */
      .content-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      main { flex: 1; max-width: 1080px; margin: 0 auto; padding: 28px 24px 64px; width: 100%; }

      /* ── Mobile: sidebar slides in ───────────────────────────────────────── */
      @media (max-width: 860px) {
        .topbar-menu-btn { display: flex; }
        .sidebar {
          position: fixed; top: 0; bottom: 0; left: 0; z-index: 80;
          transform: translateX(-100%); transition: transform .26s cubic-bezier(.2,.8,.2,1);
          box-shadow: 0 0 50px rgba(16,24,20,.22);
        }
        .sidebar.open { transform: translateX(0); }
        .nav-scrim {
          display: block; position: fixed; inset: 0; z-index: 75;
          background: rgba(16,24,20,.34);
        }
      }
      @media (min-width: 861px) {
        .nav-scrim { display: none; }
      }

      /* ── Typography ──────────────────────────────────────────────────────── */
      h1 {
        font-family: var(--font-display); font-weight: 400;
        font-size: 32px; line-height: 1.08; margin: 0 0 4px;
      }
      h2 { font-size: 16px; margin: 28px 0 12px; color: var(--text); }
      .crumbs { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
      .crumbs a { color: var(--muted); }

      /* ── Component tokens (views inherit these) ──────────────────────────── */
      .card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 16px 18px; margin: 12px 0;
      }
      .dept > .dept-name { font-size: 15px; font-weight: 600; color: var(--primary); margin-bottom: 8px; }
      .squad-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
        background: var(--surface2); margin: 8px 0;
      }
      .squad-row .meta { color: var(--muted); font-size: 13px; }
      .agents { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .chip {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--bg); font-size: 13px; color: var(--text);
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .dot.active { background: var(--ok); }
      .dot.paused { background: var(--dim); }
      .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .lane { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; min-height: 80px; }
      .lane h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
      .task { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; font-size: 13px; }
      .task .t-title { font-weight: 600; }
      .task .t-meta { color: var(--dim); font-size: 12px; margin-top: 3px; }
      .kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 14px; font-size: 14px; }
      .kv dt { color: var(--muted); }
      .kv dd { margin: 0; }
      .charter { white-space: pre-wrap; color: var(--muted); font-size: 14px; }
      .btn {
        appearance: none; cursor: pointer; font-family: var(--font-body); font-weight: 600;
        padding: 9px 18px; border-radius: 8px; border: 1px solid var(--primary);
        background: var(--primary); color: #fff;
      }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn.secondary { background: transparent; color: var(--primary); }
      .status-line { margin-top: 12px; font-size: 13px; color: var(--muted); min-height: 18px; }
      .empty { color: var(--dim); font-size: 14px; padding: 8px 0; }
      .tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
      .tag.cap { color: var(--primary); border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); }
      .tag.chan { color: var(--accent2); border-color: color-mix(in srgb, var(--accent2) 40%, var(--border)); }
      table.grid { width: 100%; border-collapse: collapse; font-size: 14px; }
      table.grid th, table.grid td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
      table.grid th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; }
      table.grid tr:last-child td { border-bottom: none; }
      table.grid td.actions { white-space: nowrap; }
      .adminform { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: end; }
      .adminform label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
      .adminform input, .adminform select {
        font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text); min-width: 180px;
      }
      .btn.sm { padding: 5px 11px; font-size: 12px; margin-right: 6px; }
      .modal {
        position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex;
        align-items: center; justify-content: center; z-index: 110; padding: 20px;
      }
      .modal[hidden] { display: none; }
      .modal-card {
        background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
        padding: 20px 22px; max-width: 460px; width: 100%;
        max-height: calc(100vh - 40px); overflow-y: auto;
      }
      .modal-actions { display: flex; gap: 10px; margin-top: 4px; width: 100%; }
      pre.snippet {
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.5;
        color: var(--text); margin: 6px 0 0;
        font-family: var(--font-mono);
      }
      code.inline {
        background: var(--surface2); border: 1px solid var(--border);
        border-radius: 6px; padding: 1px 6px; font-size: 13px; color: var(--text);
        font-family: var(--font-mono);
      }
      code.token {
        display: block; word-break: break-all; background: var(--bg);
        border: 1px solid color-mix(in srgb, var(--primary) 45%, var(--border));
        border-radius: 8px; padding: 12px 14px; font-size: 13px; color: var(--primary);
        font-family: var(--font-mono);
      }
      .warn-box {
        border: 1px solid color-mix(in srgb, #ef4444 50%, var(--border));
        background: color-mix(in srgb, #ef4444 8%, var(--surface));
        color: #b91c1c; border-radius: 8px; padding: 12px 14px; font-size: 13px; margin: 12px 0;
      }
      [data-theme="dark"] .warn-box { color: #ffb4ab; }
      .warn-box strong { color: #dc2626; }
      [data-theme="dark"] .warn-box strong { color: #ff7b72; }
      .tokenline { display: flex; align-items: center; gap: 8px; margin: 4px 0; flex-wrap: wrap; }
      .tokenline .lbl { font-size: 13px; }
      @media (max-width: 720px) { .board { grid-template-columns: 1fr 1fr; } }

      /* ── Observatory (#13) ─────────────────────────────────────────────────── */
      /* Danger token not in original shell; define inline for bars */
      :root { --danger: #f85149; --warn2: #d29922; }

      .obs { display: flex; flex-direction: column; gap: 14px; }
      .panel {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden;
      }
      .panel-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border);
      }
      .panel-head h2 {
        font-size: 15px; font-weight: 700; margin: 0; color: var(--text);
        display: flex; align-items: center; gap: 8px;
      }
      .ph-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .legend { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
      .sw { width: 10px; height: 10px; border-radius: 2px; }
      .sw--done { background: var(--ok); }
      .sw--in-progress { background: var(--accent2); }
      .sw--blocked { background: var(--warn2); }
      .sw--review { background: var(--accent); }
      .count-badge {
        font-size: 11px; font-weight: 700; color: #1b1402;
        background: var(--accent); padding: 1px 6px; border-radius: 999px;
      }
      .jump-now-btn {
        font-size: 11px; color: var(--accent); background: transparent;
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
        border-radius: 999px; padding: 3px 9px; cursor: pointer;
      }
      .jump-now-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }

      /* swimlane layout */
      .swimlane { display: flex; overflow-x: auto; }
      .lane-col {
        position: sticky; left: 0; z-index: 4;
        flex: 0 0 280px; min-width: 0;
        background: var(--surface); border-right: 1px solid var(--border);
      }
      .lane-col-head, .grid-head {
        height: 28px; display: flex; align-items: center;
        border-bottom: 1px solid var(--border); padding: 0 12px;
      }
      .axis-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }

      .tile {
        height: 68px; display: flex; align-items: center; gap: 10px;
        padding: 0 12px; border-bottom: 1px solid var(--border);
      }
      .tile:last-child { border-bottom: none; }
      .tile-av {
        width: 32px; height: 32px; border-radius: 9px; font-size: 13px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.35); flex-shrink: 0;
      }
      .tile-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .tile-top { display: flex; align-items: center; gap: 6px; }
      .tile-name { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tile-role { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; margin-left: auto; white-space: nowrap; }
      .tile-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .tile-dot--active { background: var(--ok); }
      .tile-dot--paused { background: var(--dim); }
      .press { height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--text) 10%, var(--surface)); overflow: hidden; }
      .press-fill { height: 100%; border-radius: 2px; transition: width .3s; }
      .press-fill--green { background: var(--ok); }
      .press-fill--amber { background: var(--warn2); }
      .press-fill--red { background: var(--danger); }
      .tile-stats { font-size: 10px; color: var(--muted); display: flex; gap: 5px; flex-wrap: wrap; }
      .tile-stats .sep { color: var(--border); }

      /* time grid */
      .time-grid { position: relative; flex: 1; min-width: 520px; }
      .grid-head { position: relative; padding: 0; }
      .tick {
        position: absolute; top: 50%; transform: translate(-50%, -50%);
        font-size: 10px; color: var(--dim); white-space: nowrap;
      }
      .tick:last-child { color: var(--accent); transform: translate(-100%, -50%); }
      .grid-body { position: relative; }
      .grid-row { position: relative; height: 68px; border-bottom: 1px solid var(--border); }
      .grid-row:last-child { border-bottom: none; }
      .gridline { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--border) 60%, transparent); }
      .now-line { position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: var(--accent); z-index: 3; }
      .now-tag {
        position: absolute; top: -1px; right: 0;
        font-size: 9px; font-weight: 700; color: #1b1402;
        background: var(--accent); padding: 1px 4px; border-radius: 0 0 0 3px;
      }

      /* bars */
      .bar {
        position: absolute; top: 20px; height: 28px;
        border-radius: 5px; cursor: default;
        border: 1px solid transparent;
        transition: transform 100ms ease, filter 100ms ease;
      }
      .bar:hover { transform: translateY(-1px); filter: brightness(1.12); z-index: 6; }
      .bar--done     { background: color-mix(in srgb, var(--ok) 70%, var(--surface)); border-color: var(--ok); }
      .bar--in_progress { background: color-mix(in srgb, var(--accent2) 70%, var(--surface)); border-color: var(--accent2); }
      .bar--open     { background: color-mix(in srgb, var(--dim) 50%, var(--surface)); border-color: var(--dim); }
      .bar--blocked  { background: color-mix(in srgb, var(--warn2) 65%, var(--surface)); border-color: var(--warn2); }
      .bar--review   { background: color-mix(in srgb, var(--accent) 70%, var(--surface)); border-color: var(--accent); }
      .bar--approved { background: color-mix(in srgb, var(--ok) 70%, var(--surface)); border-color: var(--ok); }
      .bar--rejected { background: color-mix(in srgb, var(--danger) 65%, var(--surface)); border-color: var(--danger); }
      .bar--growing::after {
        content: ''; position: absolute; right: -1px; top: -1px; bottom: -1px; width: 4px;
        border-radius: 0 5px 5px 0; background: currentColor; opacity: .5;
        animation: obs-pulse 1.4s ease-in-out infinite;
      }
      @keyframes obs-pulse {
        0%, 100% { opacity: .5; }
        50% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .bar--growing::after { animation: none; }
        .tile-dot--active { animation: none; }
      }

      /* bar tooltip */
      .bar-tip {
        display: none; position: absolute; bottom: calc(100% + 8px); left: 50%;
        transform: translateX(-50%); min-width: 170px; max-width: 230px;
        background: var(--bg); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 8px 10px;
        flex-direction: column; gap: 4px;
        box-shadow: 0 8px 24px rgba(0,0,0,.15); z-index: 10; pointer-events: none;
      }
      .bar:hover .bar-tip { display: flex; }
      .bar-tip strong { font-size: 12px; font-weight: 600; color: var(--text); line-height: 1.35; }
      .bar-tip-meta { font-size: 10px; color: var(--muted); }
      .bar-tip-st { font-weight: 700; }
      .bar-tip-st--done, .bar-tip-st--approved { color: var(--ok); }
      .bar-tip-st--in_progress { color: var(--accent2); }
      .bar-tip-st--blocked { color: var(--warn2); }
      .bar-tip-st--review { color: var(--accent); }
      .bar-tip-st--rejected { color: var(--danger); }
      .bar-tip-st--open { color: var(--dim); }

      /* operator queue (reuses .appr-* classes already defined for /approvals) */
      .queue-section .appr-head { display: flex; justify-content: space-between; gap: 12px; }
      .queue-section .appr-title { font-weight: 600; }
      .queue-section .appr-meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .queue-section .appr-when { color: var(--dim); font-size: 12px; white-space: nowrap; }
      .gate-chip {
        border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
        font-size: 12px; color: var(--accent);
      }
      .appr-body { margin-top: 10px; font-size: 14px; white-space: pre-wrap; }
      .appr-result {
        margin-top: 10px; background: var(--surface2); border: 1px solid var(--border);
        border-radius: 8px; padding: 10px 12px; font-size: 13px; white-space: pre-wrap;
      }
      .appr-result .lbl { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
      .appr-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
      .appr-note {
        flex: 1; min-width: 180px; font: inherit; font-size: 13px; padding: 7px 10px;
        border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
      }
      .btn-reject { background: transparent; color: var(--warn2); border: 1px solid var(--warn2); }
      .appr-status { font-size: 13px; color: var(--dim); }
      .approval.decided { opacity: .55; }
      .publish.decided { opacity: .55; }

      /* recent tasks table */
      .recent-tasks { width: 100%; border-collapse: collapse; font-size: 13px; }
      .recent-tasks th, .recent-tasks td {
        text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle;
      }
      .recent-tasks th { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
      .recent-tasks tr:last-child td { border-bottom: none; }
      .recent-tasks .task-title { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .agent-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 12px; background: var(--bg); border: 1px solid var(--border);
        padding: 2px 8px 2px 4px; border-radius: 999px; white-space: nowrap;
      }
      .agent-chip-av {
        width: 14px; height: 14px; border-radius: 3px;
        display: inline-block; flex-shrink: 0;
      }
      .st-badge {
        font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
      }
      .st-badge--done { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, var(--surface)); }
      .st-badge--in_progress { color: var(--accent2); background: color-mix(in srgb, var(--accent2) 14%, var(--surface)); }
      .st-badge--open { color: var(--dim); background: color-mix(in srgb, var(--dim) 14%, var(--surface)); }
      .st-badge--blocked { color: var(--warn2); background: color-mix(in srgb, var(--warn2) 14%, var(--surface)); }
      .st-badge--review { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
      .st-badge--approved { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, var(--surface)); }
      .st-badge--rejected { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, var(--surface)); }

      /* cost chip — placeholder until #15 */
      .cost-chip { font-size: 11px; color: var(--dim); }

      @media (max-width: 900px) {
        .lane-col { flex: 0 0 220px; }
        .recent-tasks .cost-chip { display: none; }
      }
      @media (max-width: 720px) {
        .lane-col { flex: 0 0 180px; }
        .tile-stats { display: none; }
        .recent-tasks th:nth-child(n+4), .recent-tasks td:nth-child(n+4) { display: none; }
      }

      /* ── Unit cards (#26) — employee-performance panel style ─────────────────── */
      /* The card grid wraps at 1280px: each card is min 300px, max 380px.
         No horizontal overflow: the knobs form uses a max-width constraint and
         budget/window inputs never overflow at 1280px. */
      .unit-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
        margin: 16px 0;
      }
      .unit-card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden;
        display: flex; flex-direction: column;
      }
      .unit-card-head {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--border);
      }
      .unit-av {
        width: 36px; height: 36px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 700; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,.3); flex-shrink: 0;
      }
      .unit-head-body { flex: 1; min-width: 0; }
      .unit-name {
        font-weight: 700; font-size: 14px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .unit-role { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
      .unit-status-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        margin-left: auto;
      }
      .unit-status-dot--active { background: var(--ok); }
      .unit-status-dot--paused { background: var(--dim); }

      .unit-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }

      .unit-field { display: flex; flex-direction: column; gap: 3px; }
      .unit-field-label {
        font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600;
      }
      .unit-field-value { font-size: 13px; color: var(--text); line-height: 1.4; }
      .unit-field-value.muted { color: var(--muted); }
      .unit-field-value.dim { color: var(--dim); font-style: italic; }

      /* KPI progress bar */
      .kpi-bar-wrap {
        height: 4px; background: color-mix(in srgb, var(--text) 10%, var(--surface));
        border-radius: 2px; overflow: hidden; margin-top: 4px;
      }
      .kpi-bar-fill { height: 100%; border-radius: 2px; transition: width .3s; background: var(--ok); }

      /* Effort dial — rendered as a badge with accent colour per level */
      .effort-badge {
        display: inline-block; font-size: 11px; font-weight: 700;
        padding: 2px 8px; border-radius: 999px; border: 1px solid;
      }
      .effort-low      { color: var(--ok);     border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
      .effort-standard { color: var(--accent2); border-color: color-mix(in srgb, var(--accent2) 40%, var(--border)); }
      .effort-high     { color: var(--accent);  border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .effort-sprint   { color: var(--danger);  border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

      /* Autonomy badge */
      .autonomy-badge {
        display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
        border: 1px solid var(--border); color: var(--muted);
      }
      .autonomy-execute_with_approval { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .autonomy-execute { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }

      /* Budget row */
      .unit-budget { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
      .unit-budget .cap { font-weight: 600; color: var(--text); }
      .unit-budget .window { color: var(--dim); font-size: 11px; }

      /* Task title chips */
      .unit-task-chip {
        font-size: 12px; padding: 3px 8px;
        background: var(--surface2); border: 1px solid var(--border);
        border-radius: 6px; color: var(--text);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 100%;
        display: block;
      }

      /* Knobs form — collapsible via <details> */
      .unit-knobs { border-top: 1px solid var(--border); }
      .unit-knobs summary {
        padding: 8px 16px; font-size: 12px; color: var(--muted); cursor: pointer;
        user-select: none; list-style: none; display: flex; align-items: center; gap: 6px;
      }
      .unit-knobs summary::-webkit-details-marker { display: none; }
      .unit-knobs summary::before { content: '▸'; font-size: 10px; }
      .unit-knobs[open] summary::before { content: '▾'; }
      .unit-knobs-body {
        padding: 12px 16px 14px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .knob-row { display: flex; flex-direction: column; gap: 4px; }
      .knob-label { font-size: 11px; color: var(--muted); }
      .knob-input, .knob-select {
        font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 7px;
        border: 1px solid var(--border); background: var(--bg); color: var(--text);
        width: 100%;
      }
      .knob-row-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .knob-submit { margin-top: 4px; }

      /* Squad rollup header on /squads/:id */
      .squad-unit-header {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 16px 18px; margin-bottom: 18px;
      }
      .squad-unit-header h2 { margin: 0 0 12px; }
      .squad-unit-meta { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 13px; }
      .squad-unit-meta .suf-item { display: flex; flex-direction: column; gap: 2px; }
      .squad-unit-meta .suf-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }

      /* ══ console-reskin primitives (src/dashboard/ui.ts) ══════════════════ */
      .ui-pagehead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
      .ui-pagehead-right { margin-left: auto; }
      .ui-h1 { font-family: var(--font-display); font-weight: 400; font-size: 36px; line-height: 1.1; margin: 0; letter-spacing: -.01em; }
      .ui-sub { color: var(--dim); font-size: 13.5px; margin: 6px 0 18px; max-width: 680px; line-height: 1.5; }
      .ui-pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; letter-spacing: .04em; padding: 3px 8px; border-radius: 999px;
        color: var(--pill,var(--primary)); background: color-mix(in srgb, var(--pill,var(--primary)) 12%, transparent); border: 1px solid color-mix(in srgb, var(--pill,var(--primary)) 28%, transparent); }
      .ui-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text2); }
      .ui-status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }

      .ui-kpis { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; margin: 18px 0; }
      @media (max-width:1180px){ .ui-kpis { grid-template-columns: repeat(2,1fr); } }
      @media (max-width:680px){ .ui-kpis { grid-template-columns: 1fr; } }
      .ui-stat { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 15px 16px; box-shadow: var(--shadow,none); }
      .ui-stat-label { font-size: 12.5px; color: var(--dim); margin-bottom: 8px; }
      .ui-stat-value { font-family: var(--font-display); font-weight: 400; font-size: 38px; line-height: 1; color: var(--text); }
      .ui-stat-bar { height: 6px; border-radius: 5px; background: var(--bars); margin: 12px 0 8px; overflow: hidden; }
      .ui-stat-bar > span { display: block; height: 100%; border-radius: 5px; }
      .ui-stat-sub { font-size: 11.5px; }

      .ui-panel { border: 1px solid var(--border); border-radius: 16px; background: var(--surface); padding: 0; margin: 18px 0; box-shadow: var(--shadow,none); overflow: hidden; }
      .ui-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--border-soft); }
      .ui-panel-title { font-family: var(--font-body); font-weight: 700; font-size: 14px; margin: 0; }
      .ui-panel-right { display: flex; align-items: center; gap: 8px; }
      .ui-panel-body { padding: 16px 18px; }

      .ui-table { width: 100%; }
      .ui-tr { display: grid; align-items: center; gap: 12px; padding: 10px 14px; }
      .ui-thead { border-bottom: 1px solid var(--border-soft); }
      .ui-th { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; color: var(--dim); }
      .ui-row { border-bottom: 1px solid var(--border-soft); }
      .ui-row:last-child { border-bottom: none; }
      .ui-row:hover { background: var(--hover); }
      .ui-td { font-size: 13px; color: var(--text); min-width: 0; }
      .ui-table-empty { padding: 22px 14px; color: var(--dim); font-size: 13px; }

      .ui-empty { border: 1px dashed var(--border); border-radius: 16px; background: var(--surface); padding: 40px 24px; text-align: center; margin: 18px 0; }
      .ui-empty-mark { font-size: 30px; color: var(--dim); line-height: 1; margin-bottom: 12px; }
      .ui-empty-title { font-weight: 700; font-size: 15px; color: var(--text); margin-bottom: 6px; }
      .ui-empty-detail { font-size: 13px; color: var(--text2); max-width: 460px; margin: 0 auto; line-height: 1.5; }
      .ui-empty-hint { font-size: 11.5px; color: var(--dim); margin-top: 10px; }

      /* gradient initial tile (agent directory, recent rows, queue) */
      .ui-av {
        width: 30px; height: 30px; flex: none; border-radius: 9px;
        display: inline-flex; align-items: center; justify-content: center;
        font-family: var(--font-display); font-size: 14px; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,.35);
      }
      .ui-av.sm { width: 22px; height: 22px; font-size: 11px; border-radius: 7px; }

      /* observatory: agent-directory cells + name link */
      .ui-agent-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .ui-agent-meta { min-width: 0; }
      .ui-agent-name { display: block; font-size: 13.5px; font-weight: 600; color: var(--text); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      a.ui-agent-name:hover { color: var(--primary); }
      .ui-agent-role { display: block; font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ui-mono-dim { font-family: var(--font-mono); font-size: 12px; color: var(--text2); }
      .ui-panel-sub { font-size: 12px; color: var(--dim); margin-top: 1px; }
      .ui-link { font-size: 12.5px; color: var(--primary); text-decoration: none; font-weight: 600; }
      .ui-link:hover { text-decoration: underline; }
      .routine-form label { display: grid; gap: 5px; min-width: 0; }
      .routine-form input, .routine-form select, .routine-form textarea {
        width: 100%; min-width: 0; max-width: 100%;
      }
      .routine-table .routine-cell {
        display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere;
      }
      .routine-mobile-label { display: none; }
      .routine-stack {
        display: grid; gap: 3px; min-width: 0;
      }
      .obs-queue-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
      @media (max-width: 720px) {
        .ui-tr.ui-hide-sm-3 > .ui-td:nth-child(n+4), .ui-tr.ui-hide-sm-3 > .ui-th:nth-child(n+4) { display: none; }
        .routine-table { min-width: 0 !important; }
        .routine-table .ui-thead {
          position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
          overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
        }
        .routine-table .ui-row {
          grid-template-columns: minmax(0, 1fr) !important;
          align-items: start; gap: 10px; padding: 14px;
        }
        .routine-table .ui-td {
          display: grid; grid-template-columns: minmax(7rem, 35%) minmax(0, 1fr);
          gap: 12px; align-items: start;
        }
        .routine-table .routine-mobile-label {
          display: block;
          font-family: var(--font-mono); font-size: 10px; font-weight: 600;
          letter-spacing: .6px; text-transform: uppercase; color: var(--dim);
        }
      }

      /* ── /approvals page styles (kept here to avoid duplication) ── */
      ${raw(copilotDrawerCss())}
    </style>
  </head>
  <body>
    <!-- nav scrim for mobile -->
    <div class="nav-scrim" id="nav-scrim" onclick="document.getElementById('app-sidebar').classList.remove('open');this.style.display='none';" style="display:none;"></div>

    <div class="layout">
      <!-- ══ SIDEBAR ══════════════════════════════════════════════════════════ -->
      <aside class="sidebar" id="app-sidebar">

        <!-- pot switcher -->
        <div class="switcher">
          <details id="pot-details">
            <summary>
              <span class="pot-icon" id="pot-icon"><img src="${raw(`data:image/png;base64,${MUPOT_MARK_64_PNG_B64}`)}" alt="" width="30" height="30" /></span>
              <span class="pot-name" id="pot-name">${brand}</span>
              <span class="caret">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M5 6.5 8 9.5l3-3"/></svg>
              </span>
            </summary>
            <div class="switcher-menu">
              <div class="switcher-menu-label">YOUR POTS</div>
              <div class="switcher-whoami" id="switcher-whoami">Checked in</div>
              <a href="${switchPotUrl}">Switch pot →</a>
              <a href="/auth/logout" class="switcher-checkout">Check out ↩</a>
            </div>
          </details>
        </div>

        <!-- search -->
        <div class="sidebar-search">
          <div class="sidebar-search-inner">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="14" height="14" style="color:var(--dim);flex:none;"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
            <input type="text" placeholder="Search agents, tasks, PRs…" />
            <span class="kbd">/</span>
          </div>
        </div>

        <!-- nav -->
        <nav class="nav-scroll" id="app-nav">

          <!-- Home -->
          <a class="nav-link" href="/">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M3.5 9 10 3.5 16.5 9"/><path d="M5 8.2V16h10V8.2"/></svg>
            <span class="nav-label">Home</span>
          </a>

          <!-- Projects -->
          <a class="nav-link" href="/projects">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13z"/><path d="M3.5 5.5V4h5l1.5 1.5"/></svg>
            <span class="nav-label">Projects</span>
          </a>

          <!-- Work -->
          <a class="nav-link" href="/send">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="5.5" cy="5.5" r="2"/><circle cx="5.5" cy="14.5" r="2"/><circle cx="14.5" cy="10" r="2"/><path d="M5.5 7.5v5M7.4 5.9 12.7 9.2M7.3 13.9 12.7 10.7"/></svg>
            <span class="nav-label">Work</span>
          </a>

          <a class="nav-link" href="/needs-you">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M10 3.2a6.8 6.8 0 1 0 6.8 6.8"/><path d="M10 6.3v4.2l2.8 1.7"/><path d="M15.2 3.6v3.1h-3.1"/></svg>
            <span class="nav-label">Needs You</span>
          </a>

          <!-- Approvals (with live badge) -->
          <a class="nav-link" href="/approvals" id="nav-approvals">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M10 3 4.5 5.2v4.3c0 3.4 2.3 5.8 5.5 7 3.2-1.2 5.5-3.6 5.5-7V5.2z"/><path d="M7.6 10l1.7 1.7 3.1-3.4"/></svg>
            <span class="nav-label">Approvals</span>
            <span class="nav-badge" id="approvals-badge" style="display:none;">0</span>
          </a>

          <a class="nav-link" href="/studio">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><rect x="3.4" y="4.2" width="5.4" height="11.6" rx="1.2"/><rect x="11.2" y="4.2" width="5.4" height="11.6" rx="1.2"/></svg>
            <span class="nav-label">Studio</span>
          </a>

          <a class="nav-link" href="/copilot">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M4.2 13.6V6.4A2.2 2.2 0 0 1 6.4 4.2h7.2A2.2 2.2 0 0 1 15.8 6.4v4.2a2.2 2.2 0 0 1-2.2 2.2H8.1L4.2 15.8z"/><path d="M7 8.4h6M7 10.8h3.4"/></svg>
            <span class="nav-label">Co-Pilot</span>
          </a>

          <!-- Organization (collapsible) -->
          <div class="nav-section">
            <button class="nav-section-toggle" data-section="org" onclick="navToggle('org')">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" width="17" height="17"><rect x="3.5" y="3.5" width="5.2" height="5.2" rx="1"/><rect x="11.3" y="3.5" width="5.2" height="5.2" rx="1"/><rect x="3.5" y="11.3" width="5.2" height="5.2" rx="1"/><rect x="11.3" y="11.3" width="5.2" height="5.2" rx="1"/></svg>
              <span class="nav-label">Organization</span>
              <span class="nav-chevron" id="chev-org"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M6 4l4 4-4 4"/></svg></span>
            </button>
            <div class="nav-children" id="children-org">
              <a class="nav-child" href="/admin/divisions">Departments</a>
              <a class="nav-child" href="/agents">Agents</a>
            </div>
          </div>

          <!-- Work views (collapsible) -->
          <div class="nav-section">
            <button class="nav-section-toggle" data-section="work" onclick="navToggle('work')">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="5.5" cy="5.5" r="2"/><circle cx="5.5" cy="14.5" r="2"/><circle cx="14.5" cy="10" r="2"/><path d="M5.5 7.5v5M7.4 5.9 12.7 9.2M7.3 13.9 12.7 10.7"/></svg>
              <span class="nav-label">Work views</span>
              <span class="nav-chevron" id="chev-work"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M6 4l4 4-4 4"/></svg></span>
            </button>
            <div class="nav-children" id="children-work">
              <a class="nav-child" href="/dashboard/kanban">Kanban board</a>
              <a class="nav-child" href="/send">Tasks</a>
              <a class="nav-child" href="/studio">Studio</a>
              <a class="nav-child" href="/copilot">Co-Pilot</a>
              <a class="nav-child" href="/flights">Flights</a>
              <a class="nav-child" href="/verifications">Verifications</a>
            </div>
          </div>

          <!-- Mission Control (unified Radar, Fleet, Motherboard, and Departures — Flight-003B) -->
          <a class="nav-link" href="/radar">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2"/></svg>
            <span class="nav-label">Mission Control</span>
          </a>

          <!-- Health (operator console) -->
          <a class="nav-link" href="/ops">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M10 2v4"/><path d="M10 14v4"/><path d="M4.3 4.3l2.8 2.8"/><path d="m12.9 12.9 2.8 2.8"/><path d="M2 10h4"/><path d="M14 10h4"/><path d="m4.3 15.7 2.8-2.8"/><path d="m12.9 7.1 2.8-2.8"/><circle cx="10" cy="10" r="3"/></svg>
            <span class="nav-label">Health</span>
          </a>

          <a class="nav-link" href="/addons" id="nav-addons" hidden>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M7.2 3.5v3.1a2.1 2.1 0 1 0 2.1 2.1h3.2v-2a1.9 1.9 0 1 1 3.8 0v2H17v6.1H9.3a2.1 2.1 0 1 0-2.1 2.1v-2.1H3.5V9h2.1a2.1 2.1 0 1 0 1.6-3.4V3.5z"/></svg>
            <span class="nav-label">Addons</span>
          </a>

          <!-- Economy (collapsible) -->
          <div class="nav-section">
            <button class="nav-section-toggle" data-section="econ" onclick="navToggle('econ')">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="10" cy="10" r="6.5"/><path d="M10 6v8M8.2 8h2.6a1.5 1.5 0 0 1 0 3H8.4"/></svg>
              <span class="nav-label">Economy</span>
              <span class="nav-chevron" id="chev-econ"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M6 4l4 4-4 4"/></svg></span>
            </button>
            <div class="nav-children" id="children-econ">
              <a class="nav-child" href="/economy">Spend</a>
              <a class="nav-child" href="/economy/wallet">Wallet</a>
              <a class="nav-child" href="/economy/marketplace">Marketplace</a>
              <a class="nav-child" href="/economy/billing">Billing</a>
            </div>
          </div>

          <!-- Members & access (tokens) -->
          <a class="nav-link" href="/members">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="7.3" cy="7.5" r="2.5"/><circle cx="13.6" cy="8.5" r="2"/><path d="M3.4 16c0-2.3 1.8-3.8 3.9-3.8s3.9 1.5 3.9 3.8M12.4 12.5c2 0 3.9 1.1 3.9 3.5"/></svg>
            <span class="nav-label">Access tokens</span>
          </a>

          <!-- People & roles (grants roster) -->
          <a class="nav-link" href="/admin/members">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="10" cy="6.5" r="2.6"/><path d="M4.5 16c0-2.6 2.5-4.3 5.5-4.3s5.5 1.7 5.5 4.3"/></svg>
            <span class="nav-label">People &amp; roles</span>
          </a>

          <!-- Audit log -->
          <a class="nav-link" href="/audit">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M5.5 3.5h6l3.5 3.5V16.5h-9.5z"/><path d="M11.3 3.5V7h3.4M7.5 10.5h5M7.5 13h5"/></svg>
            <span class="nav-label">Audit log</span>
          </a>

          <!-- SOVEREIGNTY section label -->
          <div class="nav-sovereignty-label">SOVEREIGNTY</div>

          <!-- Deployment (live deployment identity — NOT the setup wizard; see /deployment) -->
          <a class="nav-link" href="/deployment">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" width="17" height="17"><rect x="3.5" y="4" width="13" height="5" rx="1.3"/><rect x="3.5" y="11" width="13" height="5" rx="1.3"/><circle cx="6.6" cy="6.5" r=".8" fill="currentColor" stroke="none"/><circle cx="6.6" cy="13.5" r=".8" fill="currentColor" stroke="none"/></svg>
            <span class="nav-label">Deployment</span>
          </a>

          <!-- Directory sync -->
          <a class="nav-link" href="/admin/github">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M4.5 8.5a5.5 5.5 0 0 1 9.3-3M15.5 11.5a5.5 5.5 0 0 1-9.3 3"/><path d="M14 3.5V6h-2.5M6 16.5V14h2.5"/></svg>
            <span class="nav-label">Directory sync</span>
          </a>

          <!-- Keys & secrets -->
          <a class="nav-link" href="/admin/keys">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="7.5" cy="8.5" r="3.2"/><path d="M9.8 10.8 16.5 17.5M13.5 14.5l1.7-1.7"/></svg>
            <span class="nav-label">Keys &amp; secrets</span>
          </a>

        </nav>

        <!-- account row + theme toggle -->
        <div class="sidebar-footer">
          <button class="sidebar-footer-account" id="footer-account" aria-label="Account menu">
            <span class="sidebar-footer-avatar" id="footer-avatar">?</span>
            <span>
              <span class="sidebar-footer-name" id="footer-name">—</span>
              <span class="sidebar-footer-role" id="footer-role">member</span>
            </span>
          </button>
          <button class="sidebar-theme-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle light/dark theme">
            <span id="theme-icon">☀</span>
          </button>
        </div>

      </aside>

      <!-- ══ CONTENT AREA ══════════════════════════════════════════════════════ -->
      <div class="content-wrap">

        <!-- top bar -->
        <header class="topbar" id="app-topbar">
          <button class="topbar-menu-btn" id="topbar-menu-btn" aria-label="Open navigation" onclick="document.getElementById('app-sidebar').classList.add('open');document.getElementById('nav-scrim').style.display='block';">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" width="18" height="18"><path d="M3.5 6h13M3.5 10h13M3.5 14h13"/></svg>
          </button>
          <div class="topbar-crumb" id="topbar-crumb">
            <span class="topbar-crumb-pot" id="crumb-pot">${brand}</span>
            <span class="topbar-crumb-sep">/</span>
            <span class="topbar-crumb-view" id="crumb-view">Overview</span>
          </div>
          ${regimeChipHtml(header.physics)}
          <div class="topbar-spacer"></div>
          ${spendChipHtml(header.costToday)}
          <div class="cloud-pill">
            <span class="cloud-pill-dot">◆</span> YOUR CLOUD · CF
          </div>
          <button class="topbar-invite">Invite member</button>
        </header>

        <main>${body}</main>

      </div><!-- /.content-wrap -->
    </div><!-- /.layout -->


    <script>
      (function () {
        // ── Theme ─────────────────────────────────────────────────────────────
        var THEME_KEY = 'mupot-theme';
        var htmlEl = document.documentElement;
        var themeIcon = document.getElementById('theme-icon');
        function applyTheme(t) {
          if (t === 'dark') {
            htmlEl.setAttribute('data-theme', 'dark');
            if (themeIcon) themeIcon.textContent = '☾';
          } else {
            htmlEl.removeAttribute('data-theme');
            if (themeIcon) themeIcon.textContent = '☀';
          }
        }
        applyTheme(localStorage.getItem(THEME_KEY) || 'light');
        var themeBtn = document.getElementById('theme-toggle');
        if (themeBtn) {
          themeBtn.addEventListener('click', function () {
            var next = htmlEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            localStorage.setItem(THEME_KEY, next);
            applyTheme(next);
          });
        }

        // ── Active nav link (longest-prefix match) ─────────────────────────────
        var p = location.pathname;
        var best = null, bestLen = -1;
        document.querySelectorAll('#app-nav a.nav-link, #app-nav a.nav-child').forEach(function (a) {
          var href = a.getAttribute('href');
          if (!href) return;
          var match = href === '/' ? p === '/' : p.indexOf(href) === 0;
          if (match && href.length > bestLen) { best = a; bestLen = href.length; }
        });
        if (best) best.classList.add('active');

        // Update topbar crumb from active link label
        var crumbView = document.getElementById('crumb-view');
        if (crumbView && best) crumbView.textContent = (best.querySelector('.nav-label') || best).textContent.trim() || crumbView.textContent;

        // Open section if a child is active
        ['org','work','econ'].forEach(function (sec) {
          var kids = document.getElementById('children-' + sec);
          if (!kids) return;
          if (kids.querySelector('.active')) {
            kids.removeAttribute('hidden');
            var chev = document.getElementById('chev-' + sec);
            if (chev) chev.classList.add('open');
          } else {
            kids.setAttribute('hidden', '');
          }
        });

        // ── Section toggle (collapsible nav groups) ─────────────────────────
        window.navToggle = function (sec) {
          var kids = document.getElementById('children-' + sec);
          var chev = document.getElementById('chev-' + sec);
          var STORAGE_KEY = 'mupot-nav-' + sec;
          if (!kids) return;
          var open = kids.hasAttribute('hidden') ? false : true;
          if (open) {
            kids.setAttribute('hidden', '');
            if (chev) chev.classList.remove('open');
            localStorage.setItem(STORAGE_KEY, '0');
          } else {
            kids.removeAttribute('hidden');
            if (chev) chev.classList.add('open');
            localStorage.setItem(STORAGE_KEY, '1');
          }
        };
        // Restore section states from localStorage (unless a child is already active)
        ['org','work','econ'].forEach(function (sec) {
          var kids = document.getElementById('children-' + sec);
          var chev = document.getElementById('chev-' + sec);
          if (!kids || kids.querySelector('.active')) return; // active overrides
          var stored = localStorage.getItem('mupot-nav-' + sec);
          if (stored === '1') {
            kids.removeAttribute('hidden');
            if (chev) chev.classList.add('open');
          }
        });

        // ── Auth/me — fill "Checked in as" + account row ───────────────────
        fetch('/auth/me', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (a) {
            if (!a) return;
            var who = a.email || a.userId || '';
            // switcher label
            var el = document.getElementById('switcher-whoami');
            if (el && who) {
              el.textContent = '';
              el.appendChild(document.createTextNode('Checked in as '));
              var b = document.createElement('b');
              b.textContent = who; // textContent = no XSS
              el.appendChild(b);
            }
            // footer account row
            var name = document.getElementById('footer-name');
            var role = document.getElementById('footer-role');
            var av   = document.getElementById('footer-avatar');
            if (name) name.textContent = a.name || who;
            // /auth/me returns the authenticated org role. Older response shapes
            // may expose capability, but must never leave an owner as "member".
            if (role && (a.role || a.capability)) role.textContent = a.role || a.capability;
            if (av) {
              var initials = (a.name || who || '?').replace(/\s+/g, ' ').split(' ').map(function(w){ return w[0]; }).join('').substring(0, 2).toUpperCase();
              av.textContent = initials;
            }
          })
          .catch(function () {});

        // ── Approvals badge — cheap HEAD check on /approvals data ─────────
        fetch('/approvals', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            // The /approvals page returns HTML; skip if not JSON-parseable
            var badge = document.getElementById('approvals-badge');
            if (badge && d && typeof d.pending === 'number' && d.pending > 0) {
              badge.textContent = String(d.pending);
              badge.style.display = '';
            }
          })
          .catch(function () {});

      })();
    </script>
    ${copilotShellEmbed()}
  </body>
</html>`
}

export function errorBody(message: string) {
  return html`<h1>Hmm.</h1><p class="empty">${message}</p><p><a href="/">← Back to overview</a></p>`
}

// ── the org-admin refusal surface ────────────────────────────────────────────
// The links live in src/auth/refusal.ts (ORG_ADMIN_REFUSAL_LINKS) so the HTML
// page and its JSON twin can never drift, and every href there is asserted
// reachable-by-a-refused-member in tests/org-admin-capability-gate.test.ts.

/**
 * orgAdminForbiddenBody — the HTML 403 for an isOrgAdmin refusal.
 *
 * Names the signed-in principal and the standing they hold, states what the page
 * requires, says what would grant it, and offers a route they can actually reach.
 * The gate and the status code are unchanged — this is legibility, not outcome.
 */
export function orgAdminForbiddenBody(action: string, auth: AuthContext | null | undefined) {
  const lines = orgAdminRefusalLines(action, auth)
  return html`<h1>Not allowed</h1>
    <p class="empty">${lines.identity}</p>
    <p class="empty">${lines.requirement}</p>
    <p class="empty">${lines.nextStep}</p>
    <p>
      ${ORG_ADMIN_REFUSAL_LINKS.map(
        (l) => html`<a href="${l.href}" style="margin-right:16px">${l.label}</a>`,
      )}
    </p>`
}

/** JSON twin of orgAdminForbiddenBody, carrying the same verified links. */
export function orgAdminForbiddenJson(action: string, auth: AuthContext | null | undefined) {
  return orgAdminForbiddenPayload(action, auth, ORG_ADMIN_REFUSAL_LINKS)
}

// FLIGHT-001 F2 — the capability-floor deny page. Deliberately does NOT link
// back to "/" — a zero-capability member would just bounce off the same gate.
// Points to logout instead so the visitor can sign in with the right account.
function noDashboardAccessBody() {
  return html`<h1>No access</h1><p class="empty">Your account is signed in, but it doesn't hold any
    capability grant on this workspace yet. Ask an admin to add you to a squad.</p>
    <p><a href="/auth/logout">← Sign out</a></p>`
}

function statusDot(status: Agent['status']) {
  return html`<span class="dot ${status === 'active' ? 'active' : 'paused'}"></span>`
}

function agentChip(a: Agent) {
  return html`<a class="chip" href="/agents/${a.id}">${statusDot(a.status)}${a.name}<span class="tag">${a.role}</span></a>`
}


// ── Observatory (#13) — the new GET / home ────────────────────────────────────
//
// Three sections:
//   1. Swimlane — all agents × 24h time grid with task bars.
//   2. Operator queue — tasks in 'review' the caller may verdict (reuses
//      loadApprovals + the shared verdict POST wiring from /approvals).
//   3. Recent tasks — last 10 tasks, most recent first.
//
// Read-only except the operator-queue verdict buttons (existing endpoint).
// Cost column renders '—' until #15 (metered spend) lands.

function observatoryBody(
  brand: string,
  data: ObservatoryData,
  approvals: ApprovalItem[],
  auth: AuthContext,
  counts: OperatorCounts,
) {
  const { agents, stats, runtimeStates, bars, ticks, recentTasks } = data

  // Filter active or council agents for the primary swimlane view (#824)
  const COUNCIL_SLUGS = new Set(['asha', 'kasra', 'athena', 'river', 'loom'])
  const activeAgents = agents.filter((a) => {
    const s = stats.get(a.id)
    const runtime = runtimeStates.get(a.id)
    const slug = (a.id || '').toLowerCase()
    const name = (a.name || '').toLowerCase()
    const isCouncil = COUNCIL_SLUGS.has(slug) || COUNCIL_SLUGS.has(name)
    const hasActivity = s && (s.task_count > 0 || s.in_flight > 0 || s.spend_micro_usd > 0)
    const isLive = runtime === 'live'
    return isCouncil || hasActivity || isLive
  })
  const displayAgents = activeAgents.length > 0 ? activeAgents : agents

  function runtimeLabel(state: AgentRuntimeState): string {
    if (state === 'live') return 'live runtime'
    if (state === 'stale') return 'stale runtime'
    if (state === 'offline') return 'runtime offline'
    return 'runtime unattached'
  }

  function runtimeTone(state: AgentRuntimeState): 'ok' | 'warn' | 'dim' {
    if (state === 'live') return 'ok'
    if (state === 'stale') return 'warn'
    return 'dim'
  }

  // ── swimlane ──────────────────────────────────────────────────────────────
  // Bars grouped by agent_id for O(1) row render.
  const barsByAgent = new Map<string, SwimlaneBar[]>()
  for (const b of bars) {
    const list = barsByAgent.get(b.agent_id) ?? []
    list.push(b)
    barsByAgent.set(b.agent_id, list)
  }

  // Tick <span>s — 7 items. Last is 'now', positioned right-aligned.
  const tickSpans = ticks
    .map((t, i) => {
      const pct = (i / (ticks.length - 1)) * 100
      return `<span class="tick" style="left:${pct.toFixed(2)}%">${escHtml(t)}</span>`
    })
    .join('')

  // Gridline <span>s — same positions as ticks (except last = right edge = now-line).
  const gridlines = ticks
    .slice(0, -1)
    .map((_, i) => {
      const pct = (i / (ticks.length - 1)) * 100
      return `<span class="gridline" style="left:${pct.toFixed(2)}%"></span>`
    })
    .join('')

  // Agent tiles (left sticky column)
  const agentTiles = displayAgents.length === 0
    ? '<div class="tile"><span class="empty">No agents yet.</span></div>'
    : displayAgents.map((a) => {
        const stat: AgentStat = stats.get(a.id) ?? {
          agent_id: a.id,
          task_count: 0,
          done_count: 0,
          success_pct: 0,
          in_flight: 0,
          spend_micro_usd: 0,
        }
        const pressure = stat.in_flight > 0 ? Math.min(stat.in_flight * 25, 100) : 0
        const pressClass = pressure > 85 ? 'red' : pressure > 65 ? 'amber' : 'green'
        const grad = agentGradient(a.name)
        const initial = escHtml(a.name.slice(0, 1).toUpperCase())
        const runtime = runtimeStates.get(a.id) ?? 'unattached'
        const dotClass = runtime === 'live' ? 'active' : 'paused'
        return (
          `<div class="tile">` +
          `<span class="tile-av" style="background:${grad}">${initial}</span>` +
          `<div class="tile-body">` +
          `<div class="tile-top">` +
          `<a href="/agents/${escAttr(a.id)}" class="tile-name">${escHtml(a.name)}</a>` +
          `<span class="tile-dot tile-dot--${dotClass}" title="${escAttr(runtimeLabel(runtime))}"></span>` +
          `<span class="tile-role">${escHtml(a.role)}</span>` +
          `</div>` +
          `<div class="press"><div class="press-fill press-fill--${pressClass}" style="width:${pressure}%"></div></div>` +
          `<div class="tile-stats">` +
          `<span>${escHtml(String(stat.task_count))} tasks</span><span class="sep">·</span>` +
          `<span>${escHtml(String(stat.success_pct))}%</span><span class="sep">·</span>` +
          // Cost (#15): summed task spend over the 24h window (estimated).
          `<span class="cost-chip" title="Estimated spend, last 24h">${escHtml(formatUsd(stat.spend_micro_usd))}</span>` +
          `</div>` +
          `</div>` +
          `</div>`
        )
      }).join('')

  // Grid rows (one per agent)
  const gridRows = displayAgents.length === 0
    ? '<div class="grid-row"></div>'
    : displayAgents.map((a) => {
        const agentBars = barsByAgent.get(a.id) ?? []
        const barHtml = agentBars
          .map((b) => {
            const growingClass = b.growing ? ' bar--growing' : ''
            const statusClass = `bar--${b.status}`
            const tipStatus = `<span class="bar-tip-st bar-tip-st--${b.status}">${escHtml(b.status.replace('_', ' '))}</span>`
            const when = b.completed_at
              ? escHtml(b.completed_at.slice(0, 16).replace('T', ' '))
              : 'in progress'
            return (
              `<div class="bar ${statusClass}${growingClass}"` +
              ` style="left:${b.left_pct.toFixed(2)}%;width:${b.width_pct.toFixed(2)}%"` +
              ` title="${escAttr(b.title)}">` +
              `<div class="bar-tip">` +
              `<strong>${escHtml(b.title)}</strong>` +
              `<span class="bar-tip-meta">${tipStatus} · ${when}</span>` +
              `</div>` +
              `</div>`
            )
          })
          .join('')
        return `<div class="grid-row">${barHtml}</div>`
      }).join('')

  const swimlaneSection = `
  <section class="panel swimlane-panel">
    <div class="panel-head">
      <h2>Fleet activity · last 24h</h2>
      <div class="ph-right">
        <span class="legend"><i class="sw sw--done"></i>done</span>
        <span class="legend"><i class="sw sw--in-progress"></i>in progress</span>
        <span class="legend"><i class="sw sw--blocked"></i>blocked</span>
        <span class="legend"><i class="sw sw--review"></i>review</span>
        <button class="jump-now-btn" id="jumpNow">Jump to now →</button>
      </div>
    </div>
    <div class="swimlane" id="swimlane">
      <div class="lane-col">
        <div class="lane-col-head"><span class="axis-label">Agents</span></div>
        ${agentTiles}
      </div>
      <div class="time-grid">
        <div class="grid-head">${tickSpans}</div>
        <div class="grid-body">
          ${gridlines}
          <span class="now-line"><span class="now-tag">NOW</span></span>
          ${gridRows}
        </div>
      </div>
    </div>
  </section>`

  // ── operator queue ────────────────────────────────────────────────────────
  const queueCount = counts.needsDecisionCount
  const queueCards = approvals.map((t) => approvalCardHtml(t)).join('')

  // ── fleet-level KPI strip (ui.ts) — every number here comes from the SAME
  // computeOperatorCounts helper Health's loadOpsHealth reads (operator-counts.ts).
  // Do not re-derive any of these inline — that is exactly how Home and Health
  // drifted apart before Flight-008 Slice 1 (mupot#1060).
  const kpiStrip = kpiRow([
    statCard({ label: 'Configured agents', value: String(counts.agentsTotal) }),
    statCard({ label: 'Live runtimes', value: String(counts.liveRuntimeCount), subTone: counts.liveRuntimeCount > 0 ? 'primary' : 'warn' }),
    statCard({ label: 'In flight', value: String(counts.inFlightTotal), subTone: counts.inFlightTotal > 0 ? 'primary' : 'dim' }),
    statCard({ label: 'Needs decision', value: String(counts.needsDecisionCount), subTone: counts.needsDecisionCount > 0 ? 'warn' : 'dim' }),
    statCard({ label: 'Spend · 24h', value: formatUsd(counts.spendMicroUsdTotal) }),
  ])

  // ── operator queue — "The Gate" surface, rendered inside the new section panel.
  // Cards are existing escaped HTML strings (approvalCardHtml); the verdict buttons
  // still POST to the RBAC-gated /api/tasks/:id/verdict — no new write path.
  const operatorPanel = sectionPanel({
    title: 'Needs your decision',
    right: html`<a class="ui-link" href="/approvals">All approvals →</a>`,
    body:
      queueCount > 0
        ? html`<div id="obs-queue" class="obs-queue-grid">${raw(queueCards)}</div>`
        : emptyState({
            title: 'Gate clear',
            detail:
              'Nothing waiting at your gates. Agents propose; gated work lands here for you to authorize.',
          }),
  })

  // ── agent directory (design's signature full-width table) — real data only.
  // Columns are what THIS function already loads: identity, role, live status,
  // 24h task count, success %, 24h spend. No fabricated capabilities/Workday.
  const directoryRows: Html[][] = agents.map((a) => {
    const stat = stats.get(a.id)
    const taskCount = stat?.task_count ?? 0
    const successPct = stat?.success_pct ?? 0
    const spend = stat?.spend_micro_usd ?? 0
    const initial = a.name.slice(0, 1).toUpperCase()
    const runtime = runtimeStates.get(a.id) ?? 'unattached'
    return [
      html`<div class="ui-agent-cell">
        ${avatarBadge({ initial, fill: agentGradient(a.name), title: a.name })}
        <span class="ui-agent-meta">
          <a class="ui-agent-name" href="/agents/${a.id}">${a.name}</a>
          <span class="ui-agent-role">${a.role}</span>
        </span>
      </div>`,
      uiStatusDot(runtimeTone(runtime), `${runtimeLabel(runtime)} · ${a.status}`),
      html`<span class="ui-mono-dim">${String(taskCount)}</span>`,
      html`<span class="ui-mono-dim">${taskCount > 0 ? `${successPct}%` : '—'}</span>`,
      html`<span class="ui-mono-dim">${spend > 0 ? formatUsd(spend) : '—'}</span>`,
    ]
  })

  const directoryPanel = sectionPanel({
    title: 'Agent directory',
    right: html`<a class="ui-link" href="/agents">View all →</a>`,
    body: dataTable({
      cols: [
        { label: 'Agent', width: '2fr' },
        { label: 'Runtime', width: '1fr' },
        { label: 'Tasks · 24h', width: '1fr' },
        { label: 'Success', width: '1fr' },
        { label: 'Spend · 24h', width: '1fr' },
      ],
      rows: directoryRows,
      empty: 'No agents yet. Add departments and squads from the org tree, then add agents.',
    }),
  })

  // ── recent tasks ──────────────────────────────────────────────────────────
  const recentRows: Html[][] = recentTasks.map((t) => {
    const agentName = t.agent_name ?? t.agent_id ?? '—'
    const grad = t.agent_name ? agentGradient(t.agent_name) : 'var(--bars)'
    const initial = agentName.slice(0, 1).toUpperCase()
    const when = (t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' ')
    return [
      html`<span class="task-title">${t.title}</span>`,
      html`<span class="agent-chip">${avatarBadge({
        initial,
        fill: grad,
        title: agentName,
      })}${agentName}</span>`,
      html`<span class="st-badge st-badge--${raw(escAttr(t.status))}">${t.status.replace('_', ' ')}</span>`,
      // Cost (#15): per-task spend stamped at execution (estimated; '—' if never run).
      html`<span class="ui-mono-dim">${t.cost_micro_usd > 0 ? formatUsd(t.cost_micro_usd) : '—'}</span>`,
      html`<span style="color:var(--dim);font-size:12px">${when}</span>`,
    ]
  })

  const recentPanel = sectionPanel({
    title: 'Recent tasks',
    body: dataTable({
      cols: [
        { label: 'Task', width: '2fr' },
        { label: 'Agent', width: '1.2fr' },
        { label: 'Status', width: '1fr' },
        { label: 'Cost', width: '0.8fr' },
        { label: 'When', width: '1fr' },
      ],
      rows: recentRows,
      empty: 'No tasks yet. Send a task to see it land here.',
    }),
  })

  return html`
    ${pageHeader({
      title: brand,
      crumbs: `Signed in as ${auth.email ?? auth.userId} · ${auth.role}`,
      sub: 'A living company of agent-employees you hire, grow, and watch — running where you control it.',
    })}
    <p style="margin:4px 0 18px"><a class="btn" href="/send" style="display:inline-block;text-decoration:none">Send a task →</a></p>
    ${kpiStrip}
    <div class="obs">
      ${raw(swimlaneSection)}
      ${operatorPanel}
      ${directoryPanel}
      ${recentPanel}
    </div>
    ${queueCount > 0 ? raw(obsQueueScript()) : html``}`
}

function uiToneFromHealth(tone: HealthTone): 'ok' | 'warn' | 'danger' | 'dim' {
  if (tone === 'ok') return 'ok'
  if (tone === 'warn') return 'warn'
  if (tone === 'danger') return 'danger'
  return 'dim'
}

function opsHealthBody(data: OpsHealthData) {
  const checkRows: Html[][] = data.checks.map((c) => [
    html`<a class="ui-link" href="${c.href}">${c.label}</a>`,
    uiStatusDot(uiToneFromHealth(c.tone), c.state),
    html`<span>${c.detail}</span>`,
    html`<span>${c.nextAction}</span>`,
  ])

  const runtimeRows: Html[][] = data.runtimeSignals.map((r) => [
    html`<a class="ui-link" href="${r.href}">${r.label}</a>`,
    html`<span class="ui-mono-dim">${r.kind === 'fleet_agent' ? 'fleet' : 'presence'}</span>`,
    html`<span>${r.runtime}</span>`,
    uiStatusDot(uiToneFromHealth(r.tone), r.state),
    html`<span class="ui-mono-dim">${r.lastSeen}</span>`,
    html`<span>${r.detail}</span>`,
  ])

  const failureRows: Html[][] = data.recentFailures.map((f) => [
    html`<a class="ui-link" href="${f.href}">${f.title}</a>`,
    uiStatusDot(f.status === 'blocked' || f.status === 'rejected' ? 'danger' : 'warn', f.status.replace('_', ' ')),
    html`<span>${f.detail}</span>`,
    html`<span class="ui-mono-dim">${f.updatedAt.slice(0, 16).replace('T', ' ')}</span>`,
  ])

  const auditRows: Html[][] = data.auditSignals.map((a) => [
    html`<a class="ui-link" href="${a.href}">${a.label}</a>`,
    html`<span>${a.detail}</span>`,
    html`<span class="ui-mono-dim">${a.at.slice(0, 16).replace('T', ' ')}</span>`,
  ])

  return html`
    ${pageHeader({
      crumbs: 'Overview / Operations',
      title: 'Operations health',
      sub:
        'A read-only console for runtime liveness, queues, integration readiness, schema state, and audit-linked events.',
      badge: data.overallTone === 'ok' ? 'Healthy' : data.overallTone === 'danger' ? 'Action needed' : 'Needs review',
      badgeTone: uiToneFromHealth(data.overallTone),
    })}
    ${kpiRow([
      statCard({ label: 'Active agents', value: String(data.kpis.activeAgents), subTone: data.kpis.activeAgents > 0 ? 'ok' : 'warn' }),
      statCard({ label: 'Runtime online', value: String(data.kpis.runtimeOnline), subTone: data.kpis.runtimeOnline > 0 ? 'ok' : 'warn' }),
      statCard({ label: 'Needs decision', value: String(data.kpis.needsDecision), subTone: data.kpis.needsDecision > 0 ? 'warn' : 'dim' }),
      statCard({ label: 'Failures', value: String(data.kpis.blockedOrRejected), subTone: data.kpis.blockedOrRejected > 0 ? 'danger' : 'dim' }),
    ])}
    ${sectionPanel({
      title: 'Health checks',
      right: html`<span class="ui-mono-dim">${data.generatedAt.slice(0, 16).replace('T', ' ')}</span>`,
      body: dataTable({
        cols: [
          { label: 'Surface', width: '1.1fr' },
          { label: 'State', width: '1fr' },
          { label: 'Reason', width: '2fr' },
          { label: 'Next action', width: '2fr' },
        ],
        rows: checkRows,
        empty: 'No health checks returned.',
      }),
    })}
    ${sectionPanel({
      title: 'Runtime signals',
      right: html`<a class="ui-link" href="/fleet">Open Fleet -></a>`,
      body: dataTable({
        cols: [
          { label: 'Runtime', width: '1.3fr' },
          { label: 'Kind', width: '0.8fr' },
          { label: 'Adapter', width: '1fr' },
          { label: 'State', width: '1fr' },
          { label: 'Last seen', width: '0.9fr' },
          { label: 'Detail', width: '2fr' },
        ],
        rows: runtimeRows,
        empty: 'No runtime or presence signals yet. Attach a worker or run a local fleet check-in.',
      }),
    })}
    ${sectionPanel({
      title: 'Recent failures',
      right: html`<a class="ui-link" href="/send">Open work queue -></a>`,
      body: dataTable({
        cols: [
          { label: 'Work', width: '1.5fr' },
          { label: 'Status', width: '1fr' },
          { label: 'Detail', width: '2.2fr' },
          { label: 'Updated', width: '1fr' },
        ],
        rows: failureRows,
        empty: 'No blocked tasks, rejected tasks, or failed workflow receipts in the recent window.',
      }),
    })}
    ${sectionPanel({
      title: 'Audit-linked events',
      right: html`<a class="ui-link" href="/audit">Open Audit log -></a>`,
      body: dataTable({
        cols: [
          { label: 'Event', width: '1.2fr' },
          { label: 'Detail', width: '2fr' },
          { label: 'When', width: '1fr' },
        ],
        rows: auditRows,
        empty: 'No connector, fleet, verdict, or workflow receipts found yet.',
      }),
    })}`
}

/**
 * Render one approval item as an HTML card string.
 * Shared between observatoryBody (operator queue) and approvalsBody (/approvals page).
 * The verdict buttons call the existing RBAC-gated POST /api/tasks/:id/verdict endpoint.
 * NO new write path is introduced here (adversarial review point from #12).
 */
function approvalCardHtml(t: ApprovalItem): string {
  const preview = resultPreview(t)
  const agentLabel = escHtml(t.agent_name ?? t.assignee_agent_id ?? 'unassigned')
  const squadLabel = escHtml(t.squad_name ?? t.squad_id)
  const gateChip = t.gate_owner
    ? `· <span class="gate-chip">${escHtml(t.gate_owner)}</span>`
    : ''
  const when = escHtml((t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' '))
  const previewHtml = preview
    ? `<div class="appr-result"><div class="lbl">Result</div>${escHtml(preview)}</div>`
    : ''
  return `
    <div class="card approval" data-task="${escAttr(t.id)}" style="border-left:3px solid var(--accent)">
      <div class="appr-head">
        <div>
          <div class="appr-title">${escHtml(t.title)}</div>
          <div class="appr-meta">${agentLabel} · ${squadLabel} ${gateChip}</div>
        </div>
        <div class="appr-when">${when}</div>
      </div>
      <div class="appr-body">${escHtml(t.body)}</div>
      ${previewHtml}
      <div class="appr-actions">
        <input type="text" class="appr-note" placeholder="note (optional; required to reject)" />
        <button class="btn appr-approve">Approve</button>
        <button class="btn btn-reject appr-reject">Reject</button>
        <span class="appr-status"></span>
      </div>
    </div>`
}

/** Vanilla JS that wires the verdict buttons in the observatory operator queue.
 *  Identical logic to approvalsScript() — same endpoint, same pattern. */
function obsQueueScript(): string {
  // Escape JSON.stringify output is safe for raw() injection.
  return `
    <script>
      (function () {
        document.querySelectorAll('#obs-queue .approval').forEach(function (card) {
          var id = card.getAttribute('data-task');
          var note = card.querySelector('.appr-note');
          var status = card.querySelector('.appr-status');
          function decide(verdict) {
            if (verdict === 'rejected' && !note.value.trim()) {
              status.textContent = 'a note is required to reject';
              note.focus();
              return;
            }
            card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
            status.textContent = '…';
            fetch('/api/tasks/' + encodeURIComponent(id) + '/verdict', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ verdict: verdict, note: note.value.trim() || undefined })
            }).then(function (res) {
              return res.json().then(function (data) { return { ok: res.ok, data: data }; });
            }).then(function (r) {
              if (r.ok) {
                status.textContent = verdict === 'approved' ? 'approved' : 'rejected';
                card.classList.add('decided');
              } else {
                status.textContent = (r.data && r.data.error) || 'failed';
                card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
              }
            }).catch(function () {
              status.textContent = 'network error — try again';
              card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
            });
          }
          card.querySelector('.appr-approve').addEventListener('click', function () { decide('approved'); });
          card.querySelector('.appr-reject').addEventListener('click', function () { decide('rejected'); });
        });

        // Jump-to-now: scroll the swimlane grid all the way right.
        var jumpBtn = document.getElementById('jumpNow');
        if (jumpBtn) {
          jumpBtn.addEventListener('click', function () {
            var sl = document.getElementById('swimlane');
            if (sl) sl.scrollTo({ left: sl.scrollWidth, behavior: 'smooth' });
          });
        }
      })();
    </script>`
}


function squadBoardBody(squad: Squad, agents: Agent[], tasks: Task[], canAddAgent: boolean, canManage = false) {
  const byLane = new Map<Task['status'], Task[]>()
  for (const t of tasks) {
    const list = byLane.get(t.status) ?? []
    list.push(t)
    byLane.set(t.status, list)
  }
  // Add-agent form (lead+ on this squad). Plain HTML POST → /squads/:id/agents
  // (POST-redirect-GET); the model defaults to the Workers-AI llama as the API does.
  const addAgentForm = canAddAgent
    ? html`
        <form class="adminform" method="post" action="/squads/${squad.id}/agents" autocomplete="off"
          style="margin-top:14px">
          <label>Slug
            <input name="slug" required placeholder="dispatcher" />
          </label>
          <label>Name
            <input name="name" required placeholder="Dispatcher" />
          </label>
          <label>Role
            <input name="role" placeholder="member" />
          </label>
          <label>Model
            <input name="model" value="@cf/meta/llama-3.3-70b-instruct-fp8-fast" />
          </label>
          <button type="submit" class="btn">Add agent</button>
        </form>
        <div style="margin-top:8px;font-size:13px;color:var(--muted)">
          Or <a href="/squads/${squad.id}/agents/join">add an <strong>existing</strong> agent</a>
          (reuse, never duplicates — join is separate from create).
        </div>`
    : html``

  // Squad rollup header — shows the squad's own OKR/KPI/effort/autonomy if set,
  // plus a compact Configure form for admins (fractal: same knob shape as agents).
  const squadKnobs = canManage
    ? raw(unitKnobsForm(squad.id, 'squad', {
        okr: squad.okr,
        kpi_target: squad.kpi_target,
        effort: squad.effort,
        autonomy: squad.autonomy,
        budget_cap_cents: squad.budget_cap_cents,
        budget_window: squad.budget_window,
      }))
    : html``

  const kpiPct = Math.min(Math.max(squad.kpi_progress ?? 0, 0), 100)
  const squadHeader = html`
    <div class="squad-unit-header">
      <h2 style="margin-top:0;margin-bottom:10px">${squad.name} · work unit</h2>
      <div class="squad-unit-meta">
        <div class="suf-item">
          <span class="suf-label">Objective</span>
          <span style="font-size:13px">${squad.okr ? squad.okr : raw('<em style="color:var(--dim)">not set</em>')}</span>
        </div>
        <div class="suf-item">
          <span class="suf-label">KPI</span>
          <span style="font-size:13px">${squad.kpi_target ? squad.kpi_target : raw('<em style="color:var(--dim)">not set</em>')} · ${kpiPct}%</span>
        </div>
        <div class="suf-item">
          <span class="suf-label">Effort</span>
          ${raw(effortBadge(squad.effort))}
        </div>
        <div class="suf-item">
          <span class="suf-label">Autonomy</span>
          ${raw(autonomyBadge(squad.autonomy))}
        </div>
        <div class="suf-item">
          <span class="suf-label">Budget</span>
          ${raw(budgetLine(squad.budget_cap_cents, squad.budget_window))}
        </div>
      </div>
      ${squadKnobs}
    </div>`

  return html`
    ${pageHeader({ crumbs: `Overview / ${squad.name}`, title: squad.name })}
    ${squadHeader}
    ${
      squad.charter
        ? html`<div class="card"><h2 style="margin-top:0">Charter</h2><div class="charter">${squad.charter}</div></div>`
        : html``
    }
    <h2>Agents</h2>
    <div class="card">
      ${
        agents.length === 0
          ? html`<p class="empty">No agents in this squad yet.</p>`
          : html`<div class="agents">${raw(agents.map((a) => agentChip(a).toString()).join(''))}</div>`
      }
      ${addAgentForm}
    </div>
    <h2>Backlog</h2>
    <div class="card">
      ${
        canAddAgent
          ? html`<form id="backlog-form" class="adminform" autocomplete="off" style="margin:0">
              <input type="hidden" id="backlog-squad" value="${squad.id}" />
              <label>Title
                <input id="backlog-title" required placeholder="What needs doing?" />
              </label>
              <label>Done when
                <input id="backlog-donewhen" required placeholder="Verifiable success predicate — e.g. tests pass and PR merged" style="width:100%" />
              </label>
              <button type="submit" class="btn">Create task (backlog only)</button>
              <span style="margin-left:10px;color:var(--muted);font-size:13px">Creation is separate from dispatch — no agent is woken by this action.</span>
              <span id="backlog-status" style="margin-left:10px;color:var(--muted);font-size:13px"></span>
            </form>
            <script>
              (function () {
                var form = document.getElementById('backlog-form');
                var status = document.getElementById('backlog-status');
                if (!form) return;
                form.addEventListener('submit', async function (ev) {
                  ev.preventDefault();
                  var title = document.getElementById('backlog-title').value.trim();
                  var doneWhen = document.getElementById('backlog-donewhen').value.trim();
                  var squadId = document.getElementById('backlog-squad').value;
                  if (!title || !doneWhen) return;
                  status.textContent = 'Creating…';
                  try {
                    var res = await fetch('/api/tasks', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ squad_id: squadId, title: title, done_when: doneWhen })
                    });
                    var data = await res.json().catch(function () { return {}; });
                    if (res.ok) {
                      status.textContent = 'Created (backlog). Dispatch is a separate action.';
                      form.reset();
                    } else {
                      status.textContent = 'Failed: ' + ((data && data.error) || res.status);
                    }
                  } catch (e) {
                    status.textContent = 'Network error — try again.';
                  }
                });
              })();
            </script>`
          : html`<p class="empty">You need member+ to create tasks.</p>`
      }
    </div>
    <h2>Board</h2>
    <div class="board">
      ${raw(
        TASK_LANES.map((lane) => {
          const items = byLane.get(lane.key) ?? []
          const cards =
            items.length === 0
              ? '<p class="empty">—</p>'
              : items.map((t) => taskCard(t).toString()).join('')
          return html`<div class="lane"><h3>${lane.label} · ${items.length}</h3>${raw(cards)}</div>`.toString()
        }).join(''),
      )}
    </div>`
}

function taskCard(t: Task) {
  return html`<div class="task">
    <div class="t-title">${t.title}</div>
    <div class="t-meta">${t.assignee_agent_id ? html`assigned` : html`unassigned`}${
    t.github_issue_url ? html` · <a href="${t.github_issue_url}">GH</a>` : html``
  }</div>
  </div>`
}

function agentConsoleBody(agent: Agent, squad: Squad | null, canWake: boolean) {
  // The wake button calls the RBAC-gated agents endpoint. The fetch is same-origin
  // and credentialed (HttpOnly session cookie rides along automatically).
  const wakeScript = raw(`
    <script>
      (function () {
        var btn = document.getElementById('wake-btn');
        var out = document.getElementById('wake-status');
        if (!btn) return;
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          out.textContent = 'Waking…';
          try {
            var res = await fetch(${JSON.stringify(`/api/agents/${agent.id}/wake`)}, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ reason: 'dashboard manual wake' })
            });
            if (res.ok) {
              out.textContent = 'Woken. The cortex cycle is running.';
            } else if (res.status === 403) {
              out.textContent = 'Forbidden — you need admin or owner to wake an agent.';
            } else {
              out.textContent = 'Wake failed (' + res.status + ').';
            }
          } catch (e) {
            out.textContent = 'Wake request errored.';
          } finally {
            setTimeout(function () { btn.disabled = false; }, 1500);
          }
        });
      })();
    </script>`)
  return html`
    <p class="crumbs"><a href="/">Overview</a> /
      ${squad ? html`<a href="/squads/${squad.id}">${squad.name}</a>` : html`squad`} / ${agent.name}</p>
    ${pageHeader({
      title: agent.name,
      badge: agent.status,
      badgeTone: agent.status === 'active' ? 'ok' : 'dim',
    })}
    <div class="card">
      <dl class="kv">
        <dt>Slug</dt><dd>${agent.slug}</dd>
        <dt>Role</dt><dd>${agent.role}</dd>
        <dt>Model</dt><dd><code>${agent.model}</code></dd>
        <dt>Status</dt><dd>${agent.status}</dd>
        <dt>Squad</dt><dd>${squad ? html`<a href="/squads/${squad.id}">${squad.name}</a>` : html`—`}</dd>
        <dt>Agent id</dt><dd><code>${agent.id}</code></dd>
        <dt>Created</dt><dd>${agent.created_at}</dd>
      </dl>
    </div>
    <h2>Console</h2>
    <div class="card">
      <button id="wake-btn" class="btn" ${canWake ? raw('') : raw('disabled title="Requires admin or owner"')}>
        Wake agent
      </button>
      <span style="margin-left:12px;color:var(--dim);font-size:13px;">drives one cortex cycle</span>
      <div id="wake-status" class="status-line"></div>
      ${canWake ? html`` : html`<p class="empty">You can view this agent but only admin/owner may wake it.</p>`}
    </div>
    ${wakeScript}`
}

// ── /send — write a task, pick an agent, watch it get done ─────────────────────
//
// The picker is a flat <select> of active agents, each option labelled with its
// squad. The option VALUE carries "agentId|squadId" so the client can post both
// without a second lookup. The client posts to /api/tasks (dispatch:true) and then
// polls /api/tasks/:id every 2s (cap 120s), rendering sent → working → done.
export function sendPageBody(
  agents: PickerAgent[],
  dispatchable: DispatchableAgent[] = [],
  dispatchDefault: DispatchDefault = pickDispatchDefault(dispatchable),
  project?: Project,
  projectSquadsTruncated = false,
) {
  const hasDispatchable = dispatchable.length > 0
  const agentOptions = agents
    .map(
      (a) =>
        `<option value="${escAttr(`${a.id}|${a.squad_id}`)}">${escHtml(a.name)} — ${escHtml(a.role)} · ${escHtml(a.squad_name)}</option>`,
    )
    .join('')

  // Unique squad list for the backlog squad picker (post requires a squad). This
  // stays sourced from the FULL catalog (agents), not the reachability-filtered
  // dispatchable list — a squad remains plannable for backlog work even when
  // none of its agents currently have a live runtime; only "Dispatch now" (which
  // wakes something immediately) requires reachability.
  const squadMap = new Map<string, string>()
  for (const a of agents) squadMap.set(a.squad_id, a.squad_name)
  const squadOptions = Array.from(squadMap.entries())
    .map(([id, name]) => `<option value="${escAttr(id)}">${escHtml(name)}</option>`)
    .join('')

  // ── Disambiguated agent picker (Flight-008 Slice 3, mupot#1062) ──────────────
  // Radio cards, not a native <select>: every offered row carries its own
  // MODEL / SQUAD / SEAT STATUS badges (server-derived, from loadDispatchableAgents
  // — never guessed or cached client-side), and — critically — the browser can no
  // longer supply an implicit "first option" default the way a bare <select>
  // does. Only the id pickDispatchDefault names gets the `checked` attribute; a
  // multi-candidate page renders with NOTHING checked, forcing an explicit choice.
  const agentCards = dispatchable
    .map((a) => {
      const value = `${a.id}|${a.squad_id}`
      const checked = a.id === dispatchDefault.agent_id
      return `<label class="agent-option${checked ? ' is-default' : ''}">
        <input type="radio" name="send-agent" value="${escAttr(value)}"${checked ? ' checked' : ''}>
        <span class="agent-option-name">${escHtml(a.name)}</span>
        <span class="agent-option-role dim">${escHtml(a.role)}</span>
        <span class="badge badge-model" title="model">${escHtml(a.model)}</span>
        <span class="badge badge-squad" title="squad">${escHtml(a.squad_name)}</span>
        <span class="badge badge-seat badge-seat-${escAttr(a.seat_status)}" title="seat status">${escHtml(a.seat_status)}</span>
      </label>`
    })
    .join('')

  // ── New backlog task (planning only: dispatch:false, unassigned by default) ──
  const backlogForm = html`
    <div class="card">
      <h2 style="margin:0 0 4px">New backlog task</h2>
      <p class="dim" style="margin:0 0 14px;font-size:13px">Captures planning work without waking anyone — dispatch:false, nothing executes.</p>
      <label class="block">
        <span class="lbl">Title</span>
        <input id="bk-title" placeholder="Short, specific title">
      </label>
      <label class="block" style="margin-top:10px">
        <span class="lbl">What needs doing?</span>
        <textarea id="bk-body" rows="4" placeholder="Describe the work…"></textarea>
      </label>
      <label class="block" style="margin-top:10px">
        <span class="lbl">Done when (verifiable)</span>
        <input id="bk-done" placeholder="e.g. the report exists and names any follow-up">
      </label>
      <div style="display:flex;gap:12px;margin-top:12px;flex-wrap:wrap">
        <label class="block" style="flex:1;min-width:140px">
          <span class="lbl">Priority</span>
          <select id="bk-priority">
            <option value="">Untriaged</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option>
          </select>
        </label>
        <label class="block" style="flex:1;min-width:140px">
          <span class="lbl">Squad</span>
          <select id="bk-squad">${squadOptions ? raw(squadOptions) : html`<option value="">No squads available</option>`}</select>
        </label>
        <label class="block" style="flex:1;min-width:140px">
          <span class="lbl">Assignee (optional)</span>
          <select id="bk-assignee"><option value="">Unassigned</option>${raw(agentOptions)}</select>
        </label>
      </div>
      <div style="margin-top:14px">
        <button id="bk-btn" class="btn">Add to backlog</button>
        <span style="margin-left:12px;color:var(--dim);font-size:13px;">dispatch:false — nothing wakes, nothing runs</span>
      </div>
      <div id="bk-status" class="status-line"></div>
      <div id="bk-result" class="result-box" hidden></div>
    </div>`

  // ── Dispatch now (existing /send flow, relabeled) ──
  const dispatchForm = hasDispatchable
    ? html`
        <div class="card" style="margin-top:18px">
          <h2 style="margin:0 0 4px">Dispatch now</h2>
          <p class="dim" style="margin:0 0 14px;font-size:13px">Assigns a reachable agent and wakes it immediately to do the work. Only agents with a live runtime right now are offered.</p>
          <div class="block">
            <span class="lbl">Your agents</span>
            <div class="agent-picker" role="radiogroup" aria-label="Choose an agent">${raw(agentCards)}</div>
            <p class="dim" id="send-agent-reason" style="margin:2px 0 0;font-size:12px">${dispatchDefault.reason}</p>
          </div>
          <label class="block" style="margin-top:14px">
            <span class="lbl">What do you need done?</span>
            <textarea id="send-body" rows="6" placeholder="Describe the task in your own words…"></textarea>
          </label>
          <label class="block" style="margin-top:14px">
            <span class="lbl">Done when (verifiable)</span>
            <input id="send-done" placeholder="e.g. Artifact: path and SHA256: digest are reported">
          </label>
          <label class="block" style="margin-top:14px">
            <span class="lbl">Independent gate owner</span>
            <input id="send-gate" placeholder="e.g. gate:reviewer">
          </label>
          <div style="margin-top:14px">
            <button id="send-btn" class="btn">Dispatch now</button>
            <span id="send-hint" style="margin-left:12px;color:var(--dim);font-size:13px;">wakes your agent now and the result lands here</span>
          </div>
          <div id="send-status" class="status-line"></div>
          <div id="send-result" class="result-box" hidden></div>
        </div>`
    : html`<div class="card" style="margin-top:18px"><p class="empty">No reachable agents right now — either add one from a
        <a href="/">squad board</a>, or wait for an existing agent's runtime to come online (seat status derives from its
        live presence heartbeat, not just being enabled in the catalog).</p></div>`

  return html`
    <p class="crumbs"><a href="/">Overview</a> / ${project ? html`<a href="/projects/${encodeURIComponent(project.id)}">${project.name}</a> / ` : ''}Create a task</p>
    <h1>Create a task</h1>
    ${project ? html`<p class="empty" style="margin-top:0;max-width:640px">
      Project context: <strong>${project.name}</strong>. Only writable project squads and their active agents are available.
    </p>` : ''}
    ${projectSquadsTruncated ? html`<p class="empty" style="margin-top:0;max-width:640px">
      Only the first 100 project squad edges were evaluated; additional eligible agents may be omitted.
    </p>` : ''}
    <p class="empty" style="margin-top:0;max-width:640px">
      Add a planning-only backlog task (nothing runs), or dispatch work to an active agent now.</p>
    <style>
      .block { display: flex; flex-direction: column; gap: 6px; }
      .block .lbl { font-size: 13px; color: var(--muted); }
      #send-body, #send-done, #send-gate, #bk-title, #bk-body, #bk-done, #bk-priority, #bk-squad, #bk-assignee {
        font: inherit; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text); width: 100%; resize: vertical;
      }
      .result-box {
        margin-top: 16px; background: var(--surface2); border: 1px solid var(--border);
        border-radius: 8px; padding: 14px 16px; font-size: 14px; white-space: pre-wrap;
        line-height: 1.55;
      }
      .result-box .done-meta { color: var(--dim); font-size: 12px; margin-bottom: 10px; }
      .agent-picker { display: flex; flex-direction: column; gap: 6px; }
      .agent-option {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); cursor: pointer;
      }
      .agent-option:has(input:checked) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--bg)); }
      .agent-option input[type="radio"] { flex: none; }
      .agent-option-name { font-weight: 600; }
      .agent-option-role { font-size: 12px; }
      .badge {
        font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border);
        color: var(--muted); background: var(--surface2);
      }
      .badge-seat-live { color: var(--ok); border-color: var(--ok); }
      .badge-seat-stale { color: var(--warn); border-color: var(--warn); }
      .badge-seat-offline { color: var(--danger, #f85149); border-color: var(--danger, #f85149); }
    </style>
    ${backlogForm}
    ${dispatchForm}
    ${backlogScript(project?.id)}
    ${hasDispatchable ? sendScript(project?.id) : html``}`
}

function backlogScript(projectId?: string) {
  // Backlog-only create: POST /api/tasks with dispatch:false (server hard-excludes
  // the task.created → dispatchSquad loop). No polling — nothing will execute.
  return raw(`
    <script>
      (function () {
        var projectId = ${JSON.stringify(projectId ?? null).replace(/</g, '\\u003c')};
        var btn = document.getElementById('bk-btn');
        if (!btn) return;
        var status = document.getElementById('bk-status');
        var resultBox = document.getElementById('bk-result');
        function esc(s) {
          return String(s).replace(/[&<>"']/g, function (c) {
            return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
          });
        }
        btn.addEventListener('click', async function () {
          var title = (document.getElementById('bk-title').value || '').trim();
          var body = (document.getElementById('bk-body').value || '').trim();
          var doneWhen = (document.getElementById('bk-done').value || '').trim();
          var priority = document.getElementById('bk-priority').value;
          var squadId = document.getElementById('bk-squad').value;
          var assigneeVal = document.getElementById('bk-assignee').value || '';
          var agentId = assigneeVal.split('|')[0] || undefined;
          if (!title) { status.textContent = 'Title is required.'; return; }
          if (!doneWhen) { status.textContent = 'A verifiable done-when is required.'; return; }
          if (!squadId) { status.textContent = 'Pick a squad.'; return; }
          btn.disabled = true; resultBox.hidden = true; resultBox.innerHTML = '';
          status.textContent = 'Saving…';
          try {
            var payload = { squad_id: squadId, title: title, done_when: doneWhen, body: body, dispatch: false };
            if (priority) payload.priority = priority;
            if (agentId) payload.assignee_agent_id = agentId;
            if (projectId) payload.project_id = projectId;
            var res = await fetch('/api/tasks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify(payload)
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) { status.textContent = 'Could not add (' + res.status + ')' + (data.error ? ': ' + data.error : '') + '.'; return; }
            var t = data.task;
            resultBox.hidden = false;
            resultBox.innerHTML = '<div class="done-meta">Task ' + esc(t.id) + ' · ' + esc(t.status) + ' · squad ' + esc(t.squad_id) + ' · assignee ' + (t.assignee_agent_id ? esc(t.assignee_agent_id) : 'unassigned') + ' · priority ' + (t.priority ? esc(t.priority) : 'untriaged') + ' · dispatch:false</div>' + esc(t.title);
            status.textContent = 'Added to backlog — nothing dispatched.';
          } catch (e) {
            status.textContent = 'Add failed — try again.';
          } finally {
            btn.disabled = false;
          }
        });
      })();
    </script>`)
}

function sendScript(projectId?: string) {
  // Vanilla, same-origin, credentialed. Title = first ~60 chars of the body. Polls
  // GET /api/tasks/:id every 2s up to 120s. CSRF + no-store handled by middleware.
  return raw(`
    <script>
      (function () {
        var projectId = ${JSON.stringify(projectId ?? null).replace(/</g, '\\u003c')};
        var btn = document.getElementById('send-btn');
        var bodyEl = document.getElementById('send-body');
        var doneEl = document.getElementById('send-done');
        var gateEl = document.getElementById('send-gate');
        var status = document.getElementById('send-status');
        var resultBox = document.getElementById('send-result');
        if (!btn) return;

        // The picker is a radio-card group (name="send-agent"), not a <select> —
        // no implicit "first option" default exists to accidentally read. Only
        // the id the server named in pickDispatchDefault is pre-selected.
        function selectedAgentValue() {
          var selected = document.querySelector('input[name="send-agent"]:checked');
          return selected ? selected.value : '';
        }

        var POLL_MS = 2000;
        var MAX_MS = 120000;

        function esc(s) {
          return String(s).replace(/[&<>"']/g, function (c) {
            return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
          });
        }
        function fmtSecs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }
        function shouldDispatch() {
          return window.__MUPOT_SMOKE_DISABLE_DISPATCH === true ? false : true;
        }

        async function poll(taskId, startedAt) {
          var deadline = startedAt + MAX_MS;
          while (Date.now() < deadline) {
            await new Promise(function (r) { setTimeout(r, POLL_MS); });
            var res;
            try {
              res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
                method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }
              });
            } catch (e) { continue; }
            if (!res.ok) { continue; }
             var data = await res.json();
             var t = data.task;
             if (!t) { continue; }
             t.dispatch_timeline = data.dispatch_timeline || { transport: [], runtime: [], gate: [] };
            if (t.status === 'in_progress') { status.textContent = 'Working… (' + fmtSecs(Date.now() - startedAt) + ')'; continue; }
            if (t.status === 'done' || t.status === 'approved' || t.status === 'review' || t.status === 'blocked' || t.status === 'rejected') {
              return render(t, startedAt);
            }
            // still 'open' (dispatch in flight) — keep waiting.
            status.textContent = 'Sent. Waiting for your agent to pick it up…';
          }
          status.textContent = 'Still working after ' + fmtSecs(MAX_MS) + '. It will keep running — refresh later to see the result.';
        }

         function render(t, startedAt) {
          var took = fmtSecs(Date.now() - startedAt);
          if (t.status === 'done') {
            status.textContent = 'Done in ' + took + '.';
          } else if (t.status === 'approved') {
            status.textContent = 'Approved in ' + took + '.';
          } else if (t.status === 'review') {
            status.textContent = 'Awaiting independent gate — work is complete but not approved.';
          } else if (t.status === 'rejected') {
            status.textContent = 'Gate rejected the work — see the note below.';
          } else {
            status.textContent = 'Blocked — see the note below.';
          }
          var when = t.completed_at || '';
          var who = t.assignee_agent_id || 'your agent';
          var label = t.status === 'done' ? 'Completed by '
            : t.status === 'approved' ? 'Approved · '
            : t.status === 'review' ? 'Review pending · '
            : t.status === 'rejected' ? 'Rejected · '
            : 'Blocked · ';
           var meta = label + esc(who) + (when ? ' at ' + esc(when) : '');
           var timeline = t.dispatch_timeline || { transport: [], runtime: [], gate: [] };
           var stages = [];
           if ((timeline.transport || []).some(function (row) { return !!row.transport_delivered_at; })) {
             stages.push('Transport delivered');
           }
           if ((timeline.runtime || []).some(function (row) { return row.stage === 'runtime_consumed'; })) {
             stages.push('Runtime consumed');
           }
           if ((timeline.runtime || []).some(function (row) { return row.stage === 'completed'; })) {
             stages.push('Runtime completed');
           }
           if ((timeline.runtime || []).some(function (row) { return row.stage === 'failed'; })) {
             stages.push('Runtime failed');
           }
           var gateReceipts = timeline.gate || [];
           if (gateReceipts.length > 0) {
             stages.push('Gate verdict: ' + gateReceipts[gateReceipts.length - 1].verdict);
           }
           var receiptStages = stages.length
             ? '<div class="done-meta">' + stages.map(esc).join(' · ') + '</div>'
             : '';
           resultBox.hidden = false;
           resultBox.innerHTML = '<div class="done-meta">' + meta + '</div>' + receiptStages + esc(t.result || '(no output)');
        }

        btn.addEventListener('click', async function () {
          var text = (bodyEl.value || '').trim();
           var doneWhen = (doneEl.value || '').trim();
           var gateOwner = (gateEl.value || '').trim();
           if (!text) { status.textContent = 'Write what you need first.'; return; }
           if (!doneWhen) { status.textContent = 'A verifiable done-when is required.'; return; }
           if (!gateOwner) { status.textContent = 'An independent gate owner is required.'; return; }
           if (!/^gate:[A-Za-z0-9][A-Za-z0-9:_-]{0,120}$/.test(gateOwner)) {
             status.textContent = 'Gate owner must use the gate:<owner> form.'; return;
           }
          var val = selectedAgentValue();
          var parts = val.split('|');
          var agentId = parts[0];
          var squadId = parts[1];
          if (!agentId || !squadId) { status.textContent = 'Pick an agent first.'; return; }

          btn.disabled = true;
          resultBox.hidden = true;
          resultBox.innerHTML = '';
          status.textContent = 'Sending…';
          var title = text.slice(0, 60);
          try {
            var payload = {
              squad_id: squadId,
              title: title,
               done_when: doneWhen,
               gate_owner: gateOwner,
              body: text,
              assignee_agent_id: agentId,
              dispatch: shouldDispatch()
            };
            if (projectId) payload.project_id = projectId;
            var res = await fetch('/api/tasks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify(payload)
            });
            if (res.status === 403) { status.textContent = 'You do not have permission to task that agent.'; return; }
            if (!res.ok) {
              var err = await res.json().catch(function () { return {}; });
              status.textContent = 'Could not send (' + res.status + ')' + (err.error ? ': ' + err.error : '') + '.';
              return;
            }
            var created = await res.json();
            var taskId = created.task && created.task.id;
            if (!taskId) { status.textContent = 'Sent, but no task id came back.'; return; }
            status.textContent = 'Sent. Waiting for your agent to pick it up…';
            await poll(taskId, Date.now());
          } catch (e) {
            status.textContent = 'Send failed — try again.';
          } finally {
            btn.disabled = false;
          }
        });
      })();
    </script>`)
}

// ── approvals page (/approvals) ───────────────────────────────────────────────
//
// Card HTML is now factored into approvalCardHtml() which is shared with the
// observatory operator queue. The verdict script is also shared via approvalsScript().
// The inline <style> block for .appr-* classes was moved into shell() to avoid
// duplication across pages.

function approvalsBody(
  items: ApprovalItem[],
  publishable: ApprovalItem[] = [],
  secretEnvRequests: PublicSecretEnvRequest[] = [],
) {
  // Re-use the shared card renderer. Wrap in a named container so the script can
  // scope its querySelectorAll without touching #obs-queue on the home page.
  const cards = items.map((t) => approvalCardHtml(t)).join('')
  const n = items.length

  // "Ready to publish" (flight-1 gap fix): tasks already past the gate
  // (status='approved', gate:content) with no operator control to fire the real
  // write. loadPublishable is admin/owner-gated server-side — publishable is
  // always [] for a non-admin caller, so this whole section (and its button)
  // is simply absent from their HTML, not just disabled.
  const pubCards = publishable.map((t) => publishCardHtml(t)).join('')
  const pn = publishable.length
  const publishSection = pn
    ? html`
        ${pageHeader({
          crumbs: '',
          title: 'Ready to publish',
          sub: 'Approved content, waiting on the separate Publish action. Approving a proposal and publishing it are two distinct human steps — this button is the second one.',
          badge: `${String(pn)} approved`,
          badgeTone: 'ok',
        })}
        ${raw(`<div id="publish-list">${pubCards}</div>`)}
        ${publishScript()}`
    : html``

  return html`
    ${pageHeader({
      crumbs: 'Overview / The Gate',
      title: 'The Gate',
      sub: 'Agents propose work; you authorize it. This is the only place human authority enters the loop — untrusted input can wake an agent, never steer it.',
      badge: n ? `${String(n)} awaiting your gate` : 'Gate clear',
      badgeTone: n ? 'warn' : 'ok',
    })}
    ${n ? raw(`<div id="approvals-list">${cards}</div>`) : html`<div class="card"><p class="empty">Nothing waiting at your gates. Gated work lands here when an agent finishes it.</p></div>`}
    ${n ? approvalsScript() : html``}
    ${publishSection}
    ${secretEnvApprovalsSection(secretEnvRequests)}`
}

/**
 * Render one approved content-publish task as a Publish card. Only ever
 * populated by loadPublishable (admin/owner + status='approved' + gate:content),
 * so no client-side role check is needed here — the data itself is the gate.
 */
function publishCardHtml(t: ApprovalItem): string {
  const agentLabel = escHtml(t.agent_name ?? t.assignee_agent_id ?? 'unassigned')
  const squadLabel = escHtml(t.squad_name ?? t.squad_id)
  const when = escHtml((t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' '))
  return `
    <div class="card publish" data-task="${escAttr(t.id)}" style="border-left:3px solid var(--ok)">
      <div class="appr-head">
        <div>
          <div class="appr-title">${escHtml(t.title)}</div>
          <div class="appr-meta">${agentLabel} · ${squadLabel} · approved ${when}</div>
        </div>
      </div>
      <div class="appr-body">${escHtml(t.body)}</div>
      <div class="appr-actions">
        <button class="btn appr-publish">Publish</button>
        <span class="appr-status"></span>
      </div>
    </div>`
}

/**
 * Vanilla JS wiring the Publish button. Targets the EXISTING admin-gated
 * POST /admin/departments/:dept/execute/:gateId (src/dashboard/index.ts) —
 * dept is hardcoded to CONTENT_DEPARTMENT_KEY ('growth', the same key
 * finishContentProposal used to mint the gate — src/agents/execute.ts), gateId
 * is the task id (THE SEAM: gateId === task.id for content-publish proposals).
 * No new write path. Server re-checks isAdmin + the approved verdict; this is
 * purely the UI trigger the loop was missing.
 */
function publishScript() {
  return raw(`
    <script>
      (function () {
        var list = document.getElementById('publish-list');
        if (!list) return;
        list.querySelectorAll('.publish').forEach(function (card) {
          var id = card.getAttribute('data-task');
          var status = card.querySelector('.appr-status');
          var btn = card.querySelector('.appr-publish');
          btn.addEventListener('click', function () {
            btn.disabled = true;
            status.textContent = 'publishing…';
            fetch('/admin/departments/${CONTENT_DEPARTMENT_KEY}/execute/' + encodeURIComponent(id), {
              method: 'POST', credentials: 'same-origin'
            }).then(function (res) {
              return res.json().then(function (data) { return { ok: res.ok, data: data }; });
            }).then(function (r) {
              if (r.ok && r.data && r.data.executed) {
                status.textContent = r.data.artifactUrl ? ('published ✓ ' + r.data.artifactUrl) : 'published ✓';
                card.classList.add('decided');
              } else {
                status.textContent = (r.data && (r.data.reason || r.data.error)) || 'publish failed';
                btn.disabled = false;
              }
            }).catch(function () {
              status.textContent = 'network error — try again';
              btn.disabled = false;
            });
          });
        });
      })();
    </script>`)
}

function approvalsScript() {
  // Same-origin, credentialed. POSTs to the existing RBAC'd verdict endpoint;
  // CSRF Origin check + no-store come from the dashboard middleware.
  return raw(`
    <script>
      (function () {
        var list = document.getElementById('approvals-list');
        if (!list) return;
        list.querySelectorAll('.approval').forEach(function (card) {
          var id = card.getAttribute('data-task');
          var note = card.querySelector('.appr-note');
          var status = card.querySelector('.appr-status');
          function decide(verdict) {
            if (verdict === 'rejected' && !note.value.trim()) {
              status.textContent = 'a note is required to reject';
              note.focus();
              return;
            }
            card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
            status.textContent = '…';
            fetch('/api/tasks/' + encodeURIComponent(id) + '/verdict', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ verdict: verdict, note: note.value.trim() || undefined })
            }).then(function (res) {
              return res.json().then(function (data) { return { ok: res.ok, data: data }; });
            }).then(function (r) {
              if (r.ok) {
                status.textContent = verdict === 'approved' ? 'approved ✓' : 'rejected ✗';
                card.classList.add('decided');
              } else {
                status.textContent = (r.data && r.data.error) || 'failed';
                card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
              }
            }).catch(function () {
              status.textContent = 'network error — try again';
              card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
            });
          }
          card.querySelector('.appr-approve').addEventListener('click', function () { decide('approved'); });
          card.querySelector('.appr-reject').addEventListener('click', function () { decide('rejected'); });
        });
      })();
    </script>`)
}

// ── members + divisions views ─────────────────────────────────────────────────

// Ladder high→low — used to order capability chips and populate <select>s.
const CAPABILITY_ORDER: ReadonlyArray<Capability> = [
  'owner',
  'admin',
  'lead',
  'member',
  'observer',
]

const SCOPE_TYPES: ReadonlyArray<CapabilityScopeType> = ['org', 'department', 'squad']

const CHANNEL_LABEL: Record<ConnectionChannel, string> = {
  workspace: 'workspace',
  im: 'IM',
  dashboard: 'dashboard',
  directory: 'directory (OAuth)',
}

// ── members PAGE (GET /members) — roster + mint/revoke + show-once token ────────
// Distinct from membersAdminBody (the /admin/members grant/invite console). This is
// the connect-oriented surface: each member's live channels + live tokens, with a
// mint form and per-token revoke for admins. Forms are hidden for non-admins.

function membersPageBody(
  members: Member[],
  channels: { member_id: string; channel: ConnectionChannel }[],
  tokens: PublicMemberToken[],
  canManage: boolean,
  auth: AuthContext,
) {
  const channelsByMember = new Map<string, Set<ConnectionChannel>>()
  for (const ch of channels) {
    const set = channelsByMember.get(ch.member_id) ?? new Set<ConnectionChannel>()
    set.add(ch.channel)
    channelsByMember.set(ch.member_id, set)
  }
  const tokensByMember = new Map<string, PublicMemberToken[]>()
  for (const t of tokens) {
    const list = tokensByMember.get(t.member_id) ?? []
    list.push(t)
    tokensByMember.set(t.member_id, list)
  }

  const rows =
    members.length === 0
      ? '<p class="empty">No people yet. Onboard someone from the People &amp; Access console — first sign-in provisions their identity + token.</p>'
      : members
          .map((m) =>
            memberConnectRow(
              m,
              channelsByMember.get(m.id),
              tokensByMember.get(m.id) ?? [],
              canManage,
            ),
          )
          .map((x) => x.toString())
          .join('')

  return html`
    ${pageHeader({
      crumbs: `Signed in as ${auth.email ?? auth.userId} · ${auth.role} · ${members.length} ${members.length === 1 ? 'person' : 'people'}`,
      title: 'Access Tokens',
      sub:
        'A token is what a person pastes into their workspace config (see the Connect card). Provision one below — it is shown exactly once.',
    })}
    <div class="card" style="padding:12px 18px;margin-bottom:16px;background:var(--surface2)">
      <p style="margin:0;font-size:13px;color:var(--muted)">
        <strong>Operator tokens (this page)</strong> — NULL-bound; for humans and operator
        harnesses. Not accepted by the <code class="inline">/attach</code> endpoint.<br/>
        <strong>Agent tokens</strong> — bound to a specific agent runtime; required for
        <code class="inline">/attach</code>.
        ${canManage ? raw('<a href="/admin/agent-token" class="btn secondary sm" style="margin-left:10px;vertical-align:middle">Mint agent token</a>') : raw('')}
      </p>
    </div>
    <div class="card" style="padding:0">
      <table class="grid">
        <thead>
          <tr><th>Person</th><th>Channels</th><th>Tokens</th>${
            canManage ? raw('<th>Provision operator token</th>') : raw('')
          }</tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
      </table>
    </div>`
}

function memberConnectRow(
  m: Member,
  channels: Set<ConnectionChannel> | undefined,
  tokens: PublicMemberToken[],
  canManage: boolean,
) {
  const chSet = new Set<ConnectionChannel>(channels ?? [])
  if (m.telegram_chat_id) chSet.add('im')
  const chChips =
    chSet.size === 0
      ? html`<span class="empty">—</span>`
      : raw(
          [...chSet]
            .map((ch) => `<span class="tag chan">${escHtml(CHANNEL_LABEL[ch])}</span>`)
            .join(' '),
        )

  const tokenList =
    tokens.length === 0
      ? html`<span class="empty">no live tokens</span>`
      : raw(
          tokens
            .map((t) => {
              const label = t.label.length > 0 ? t.label : '(unlabeled)'
              const revokeBtn = canManage
                ? `<form method="post" action="/members/${escAttr(t.member_id)}/tokens/${escAttr(
                    t.id,
                  )}/revoke" style="display:inline">` +
                  `<button type="submit" class="btn secondary sm">Revoke</button></form>`
                : ''
              return (
                `<div class="tokenline"><span class="tag chan">${escHtml(
                  CHANNEL_LABEL[t.channel],
                )}</span>` +
                `<span class="lbl">${escHtml(label)}</span>${revokeBtn}</div>`
              )
            })
            .join(''),
        )

  // Per-row mint form (admin+). A plain HTML POST → the show-once page.
  const mintCell = canManage
    ? html`<td>
        <form method="post" action="/members/${m.id}/tokens" class="adminform" autocomplete="off">
          <label>Label
            <input name="label" placeholder="laptop" style="min-width:120px" />
          </label>
          <label>Channel
            <select name="channel">
              <option value="workspace">workspace</option>
              <option value="im">IM</option>
              <option value="dashboard">dashboard</option>
            </select>
          </label>
          <button type="submit" class="btn sm">Provision token</button>
        </form>
      </td>`
    : html``

  return html`
    <tr data-member="${m.id}">
      <td>
        <strong>${m.display_name}</strong>
        <div class="t-meta">${m.email ?? html`<span class="empty">no email</span>`}</div>
      </td>
      <td>${chChips}</td>
      <td>${tokenList}</td>
      ${mintCell}
    </tr>`
}

// The SHOW-ONCE page. The raw token is rendered here and NOWHERE else — never
// persisted, never logged, never reachable by a redirect. Reloading this page will
// not show the token again (it does not exist server-side in raw form).
function tokenShowOnceBody(slug: string, origin: string, memberName: string, minted: MintedToken) {
  return html`
    <p class="crumbs"><a href="/">Overview</a> / <a href="/members">Access Tokens</a> / Token provisioned</p>
    <h1>Token provisioned for ${memberName}</h1>
    <div class="warn-box">
      <strong>Copy this token now — it is shown exactly once.</strong> We store only a hash, so it
      can never be displayed again. If it is lost, revoke it and mint a new one.
    </div>
    <div class="card">
      <p class="empty" style="margin-top:0">Label
        <strong>${minted.label.length > 0 ? minted.label : '(unlabeled)'}</strong> ·
        channel <span class="tag chan">${CHANNEL_LABEL[minted.channel]}</span></p>
      <code class="token">${minted.raw}</code>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Paste it into your workspace</h2>
      <p class="empty" style="margin-top:0">Replace <code class="inline">&lt;MEMBER_TOKEN&gt;</code>
        in the snippet with the token above. Endpoint:
        <code class="inline">${mcpEndpoint(origin)}</code>.</p>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Claude Code · <code class="inline">.mcp.json</code></h3>
      <pre class="snippet">${claudeCodeSnippet(slug, origin)}</pre>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Codex · <code class="inline">~/.codex/config.toml</code></h3>
      <pre class="snippet">${codexSnippet(slug, origin)}</pre>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Cursor · <code class="inline">MCP JSON</code></h3>
      <pre class="snippet">${cursorSnippet(slug, origin)}</pre>
    </div>
    <p><a href="/members">← Back to access tokens</a></p>`
}

/** Render one entitlement grant as a human label: "admin · Engineering" / "owner · organization". */
function grantLabel(g: CapabilityGrant, scopeNames: Map<string, string>): string {
  if (g.scope_type === 'org') return `${g.capability} · organization`
  // Enterprise rendering: the 'squad' scope type is surfaced as "team".
  const scopeWord = g.scope_type === 'squad' ? 'team' : g.scope_type
  const name = g.scope_id ? (scopeNames.get(g.scope_id) ?? g.scope_id) : g.scope_id
  return `${g.capability} · ${scopeWord} ${name ?? ''}`.trim()
}

function capabilityRank(cap: Capability): number {
  const i = CAPABILITY_ORDER.indexOf(cap)
  return i === -1 ? CAPABILITY_ORDER.length : i
}

function membersAdminBody(
  members: Member[],
  grants: CapabilityGrant[],
  channels: { member_id: string; channel: ConnectionChannel }[],
  depts: Department[],
  scopeNames: Map<string, string>,
  auth: AuthContext,
) {
  const grantsByMember = new Map<string, CapabilityGrant[]>()
  for (const g of grants) {
    const list = grantsByMember.get(g.member_id) ?? []
    list.push(g)
    grantsByMember.set(g.member_id, list)
  }
  const channelsByMember = new Map<string, Set<ConnectionChannel>>()
  for (const ch of channels) {
    const set = channelsByMember.get(ch.member_id) ?? new Set<ConnectionChannel>()
    set.add(ch.channel)
    channelsByMember.set(ch.member_id, set)
  }

  const deptOptions = depts
    .map((d) => `<option value="${escAttr(d.id)}">${escHtml(d.name)}</option>`)
    .join('')
  const capOptions = CAPABILITY_ORDER.map(
    (cap) => `<option value="${cap}">${cap}</option>`,
  ).join('')

  const rows =
    members.length === 0
      ? '<p class="empty">No people yet. Onboard someone below — first sign-in provisions their identity + token.</p>'
      : members
          .map((m) => memberRow(m, grantsByMember.get(m.id) ?? [], channelsByMember.get(m.id), scopeNames))
          .map((x) => x.toString())
          .join('')

  return html`
    ${pageHeader({
      crumbs: `Signed in as ${auth.email ?? auth.userId} · ${auth.role} · ${members.length} ${members.length === 1 ? 'person' : 'people'}`,
      title: 'People & Access',
      sub:
        'Each person is a sponsor or owner accountable for the AI agents they register (one person, many channels).',
    })}

    <h2>Onboard a person</h2>
    <div class="card">
      <p class="empty" style="margin-top:0">An invite is redeemed once: first sign-in provisions the
        person, their entitlement and a workspace token. The entitlement applies organization-wide unless you scope it
        to a department.</p>
      <form id="invite-form" class="adminform" autocomplete="off">
        <label>Email
          <input name="email" type="email" required placeholder="person@example.com" />
        </label>
        <label>Department
          <select name="department_id">
            <option value="">— organization-wide —</option>
            ${raw(deptOptions)}
          </select>
        </label>
        <label>Entitlement
          <select name="capability">${raw(capOptions)}</select>
        </label>
        <button type="submit" class="btn">Send invite</button>
      </form>
      <div id="invite-status" class="status-line"></div>
    </div>

    <h2>Directory</h2>
    <div class="card" style="padding:0">
      <table class="grid">
        <thead>
          <tr><th>Person</th><th>Channels</th><th>Entitlements</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
      </table>
    </div>

    ${membersAdminScript(scopeNamesToOptions(scopeNames, depts))}`
}

function memberRow(
  m: Member,
  grants: CapabilityGrant[],
  channels: Set<ConnectionChannel> | undefined,
  scopeNames: Map<string, string>,
) {
  const sorted = [...grants].sort((a, b) => capabilityRank(a.capability) - capabilityRank(b.capability))
  const capChips =
    sorted.length === 0
      ? html`<span class="empty">none</span>`
      : raw(
          sorted
            .map((g) => `<span class="tag cap">${escHtml(grantLabel(g, scopeNames))}</span>`)
            .join(' '),
        )

  // Channels: tokens give workspace/im/dashboard reachability; a telegram_chat_id
  // also makes the member IM-reachable even before a Hermes token is minted.
  const chSet = new Set<ConnectionChannel>(channels ?? [])
  if (m.telegram_chat_id) chSet.add('im')
  const chChips =
    chSet.size === 0
      ? html`<span class="empty">—</span>`
      : raw(
          [...chSet]
            .map((ch) => `<span class="tag chan">${escHtml(CHANNEL_LABEL[ch])}</span>`)
            .join(' '),
        )

  const suspended = m.status === 'suspended'
  return html`
    <tr data-member="${m.id}">
      <td>
        <strong>${m.display_name}</strong>
        <div class="t-meta">${m.email ?? html`<span class="empty">no email</span>`}</div>
        <div class="t-meta"><code>${m.id}</code></div>
      </td>
      <td>${chChips}</td>
      <td>${capChips}</td>
      <td>
        <span class="dot ${suspended ? 'paused' : 'active'}"></span>
        ${m.status}
      </td>
      <td class="actions">
        <button class="btn secondary sm js-suspend" data-member="${m.id}"
          data-next="${suspended ? 'active' : 'suspended'}">
          ${suspended ? 'Reactivate' : 'Suspend'}
        </button>
        <button class="btn secondary sm js-grant" data-member="${m.id}"
          data-name="${escAttr(m.display_name)}">Grant entitlement</button>
      </td>
    </tr>`
}

// Persistent org-creation forms (the gap: dept/squad creation was wizard-only). Plain
// same-origin POST forms — the csrf() middleware validates the Origin, no token field needed.
// They target the existing (RBAC-gated) POST /departments + POST /squads handlers.
function addDepartmentFormHtml(): string {
  return `<div class="card" style="margin-top:12px"><h3 style="margin:0 0 10px">Add a department</h3>
    <form class="adminform" method="post" action="/departments" autocomplete="off">
      <input name="name" required placeholder="Engineering" />
      <input name="slug" required placeholder="engineering" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, dashes" />
      <button type="submit" class="btn">Add department</button>
    </form></div>`
}
function addSquadFormHtml(deptId: string): string {
  return `<form class="adminform" method="post" action="/squads" autocomplete="off" style="margin-top:10px;border-top:1px solid var(--border,#e7e9e7);padding-top:10px">
      <input type="hidden" name="department_id" value="${escAttr(deptId)}" />
      <input name="name" required placeholder="New team" />
      <input name="slug" required placeholder="team-slug" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, dashes" />
      <input name="charter" placeholder="What this team does (optional)" />
      <button type="submit" class="btn secondary sm">Add team</button>
    </form>`
}

function divisionsAdminBody(
  depts: Department[],
  squads: Squad[],
  grants: CapabilityGrant[],
  members: Member[],
  auth: AuthContext,
) {
  const memberName = new Map<string, string>()
  for (const m of members) memberName.set(m.id, m.display_name)

  // Heads of a scope = members holding lead+ capability on that exact scope.
  // (org > admin > lead > member > observer; 'head' = lead or stronger.)
  const headRank = capabilityRank('lead')
  const headsByScope = new Map<string, { name: string; cap: Capability }[]>()
  for (const g of grants) {
    if (g.scope_type === 'org' || g.scope_id === null) continue
    if (capabilityRank(g.capability) > headRank) continue // weaker than lead → not a head
    const list = headsByScope.get(g.scope_id) ?? []
    list.push({ name: memberName.get(g.member_id) ?? g.member_id, cap: g.capability })
    headsByScope.set(g.scope_id, list)
  }

  const squadsByDept = new Map<string, Squad[]>()
  for (const s of squads) {
    const list = squadsByDept.get(s.department_id) ?? []
    list.push(s)
    squadsByDept.set(s.department_id, list)
  }

  const heads = (scopeId: string) => {
    const list = headsByScope.get(scopeId) ?? []
    if (list.length === 0) return html`<span class="empty">no head assigned</span>`
    return raw(
      list
        .sort((a, b) => capabilityRank(a.cap) - capabilityRank(b.cap))
        .map((h) => `<span class="tag cap">${escHtml(h.cap)} · ${escHtml(h.name)}</span>`)
        .join(' '),
    )
  }

  if (depts.length === 0) {
    return html`
      ${pageHeader({ crumbs: 'Overview / Organization', title: 'Organization' })}
      <div class="card"><p class="empty">No departments yet — add your first one to start the org tree.</p></div>
      ${raw(addDepartmentFormHtml())}`
  }

  const cards = depts
    .map((d) => {
      const ds = squadsByDept.get(d.id) ?? []
      const squadRows =
        ds.length === 0
          ? '<p class="empty">No squads.</p>'
          : ds
              .map(
                (s) => html`
                  <div class="squad-row">
                    <div>
                      <a href="/squads/${s.id}"><strong>${s.name}</strong></a>
                      <span class="meta"> · team</span>
                    </div>
                    <div class="meta">${heads(s.id)}</div>
                  </div>`.toString(),
              )
              .join('')
      return html`
        <div class="card dept">
          <div class="dept-name">${d.name}</div>
          <div class="t-meta" style="margin-bottom:8px">Department head: ${heads(d.id)}</div>
          ${raw(squadRows)}
          ${raw(addSquadFormHtml(d.id))}
        </div>`.toString()
    })
    .join('')

  return html`
    ${pageHeader({
      crumbs: `Signed in as ${auth.email ?? auth.userId} · ${auth.role}`,
      title: 'Organization',
      sub: 'An owner is any person holding the lead entitlement or stronger on that scope.',
    })}
    ${kpiRow([
      statCard({ label: 'Departments', value: String(depts.length) }),
      statCard({ label: 'Teams', value: String(squads.length) }),
    ])}
    ${raw(cards)}
    ${raw(addDepartmentFormHtml())}
    <p class="empty">Assign an owner from the <a href="/admin/members">People &amp; Access</a> page — grant a person
      the <code>lead</code> entitlement (or higher) on the department or team scope.</p>`
}

// ── client scripts (POST to the RBAC-gated /api/members/* — never write here) ──

/** Department/squad <option>s for the grant dialog's scope selector. */
function scopeNamesToOptions(scopeNames: Map<string, string>, depts: Department[]): string {
  const deptIds = new Set(depts.map((d) => d.id))
  const opts: string[] = []
  for (const [id, name] of scopeNames) {
    const kind = deptIds.has(id) ? 'department' : 'squad'
    // data-kind keeps the API scope-type ('squad'); the visible word is the
    // enterprise rendering ('team').
    const kindLabel = kind === 'squad' ? 'team' : kind
    opts.push(`<option value="${escAttr(id)}" data-kind="${kind}">${escHtml(name)} (${kindLabel})</option>`)
  }
  return opts.join('')
}

function membersAdminScript(scopeOptions: string) {
  const capOptions = CAPABILITY_ORDER.map((c) => `<option value="${c}">${c}</option>`).join('')
  // Enterprise rendering: keep the API value ('org'|'department'|'squad') but
  // surface 'org'→'organization' and 'squad'→'team' to the reader.
  const scopeTypeLabel = (s: string) => (s === 'squad' ? 'team' : s === 'org' ? 'organization' : s)
  const scopeTypeOptions = SCOPE_TYPES.map((s) => `<option value="${s}">${scopeTypeLabel(s)}</option>`).join('')
  // The member-admin API base. The Integrate phase mounts membersApp under this
  // prefix; buttons call it (we never duplicate the API's writes here).
  const api = '/api/members'
  return raw(`
    <div id="grant-modal" class="modal" hidden>
      <div class="modal-card">
        <h3 style="margin-top:0">Grant entitlement — <span id="grant-who"></span></h3>
        <form id="grant-form" class="adminform">
          <label>Scope type
            <select name="scope_type" id="grant-scope-type">${scopeTypeOptions}</select>
          </label>
          <label id="grant-scope-wrap">Scope
            <select name="scope_id" id="grant-scope-id">${scopeOptions}</select>
          </label>
          <label>Entitlement
            <select name="capability">${capOptions}</select>
          </label>
          <div class="modal-actions">
            <button type="button" class="btn secondary" id="grant-cancel">Cancel</button>
            <button type="submit" class="btn">Grant</button>
          </div>
        </form>
        <div id="grant-status" class="status-line"></div>
      </div>
    </div>
    <script>
      (function () {
        var API = ${JSON.stringify(api)};
        async function postJSON(url, method, body) {
          return fetch(url, {
            method: method,
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: body == null ? undefined : JSON.stringify(body)
          });
        }
        function reloadSoon() { setTimeout(function () { location.reload(); }, 900); }

        // ── invite ──
        var inviteForm = document.getElementById('invite-form');
        var inviteStatus = document.getElementById('invite-status');
        if (inviteForm) {
          inviteForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var fd = new FormData(inviteForm);
            var payload = {
              email: String(fd.get('email') || ''),
              capability: String(fd.get('capability') || 'member')
            };
            var dep = String(fd.get('department_id') || '');
            if (dep) payload.department_id = dep;
            inviteStatus.textContent = 'Creating invite…';
            try {
              var res = await postJSON(API + '/invites', 'POST', payload);
              var data = await res.json().catch(function () { return {}; });
              if (res.ok) {
                inviteStatus.textContent =
                  'Invite created. Redemption id: ' + (data.invite && data.invite.id) +
                  ' — share the accept link; first connect mints the member + token (shown once).';
                inviteForm.reset();
              } else if (res.status === 403) {
                inviteStatus.textContent = 'Forbidden — you need admin on this scope to invite.';
              } else {
                inviteStatus.textContent = 'Invite failed: ' + (data.error || res.status);
              }
            } catch (err) { inviteStatus.textContent = 'Invite request errored.'; }
          });
        }

        // ── suspend / reactivate ──
        document.querySelectorAll('.js-suspend').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var id = btn.getAttribute('data-member');
            var next = btn.getAttribute('data-next');
            btn.disabled = true;
            try {
              var res = await postJSON(API + '/members/' + encodeURIComponent(id), 'PATCH', { status: next });
              if (res.ok) { reloadSoon(); }
              else if (res.status === 403) { btn.disabled = false; alert('Forbidden — admin required.'); }
              else { btn.disabled = false; alert('Update failed (' + res.status + ').'); }
            } catch (e) { btn.disabled = false; alert('Request errored.'); }
          });
        });

        // ── grant capability (modal) ──
        var modal = document.getElementById('grant-modal');
        var grantForm = document.getElementById('grant-form');
        var grantWho = document.getElementById('grant-who');
        var grantStatus = document.getElementById('grant-status');
        var scopeType = document.getElementById('grant-scope-type');
        var scopeWrap = document.getElementById('grant-scope-wrap');
        var scopeId = document.getElementById('grant-scope-id');
        var currentMember = null;

        function syncScopeVisibility() {
          var t = scopeType.value;
          if (t === 'org') { scopeWrap.setAttribute('hidden', ''); }
          else {
            scopeWrap.removeAttribute('hidden');
            // filter scope options to the chosen kind
            Array.prototype.forEach.call(scopeId.options, function (opt) {
              if (!opt.getAttribute('data-kind')) return;
              opt.hidden = opt.getAttribute('data-kind') !== t;
            });
            var firstVisible = Array.prototype.find.call(scopeId.options, function (o) { return !o.hidden; });
            if (firstVisible) scopeId.value = firstVisible.value;
          }
        }
        if (scopeType) scopeType.addEventListener('change', syncScopeVisibility);

        document.querySelectorAll('.js-grant').forEach(function (btn) {
          btn.addEventListener('click', function () {
            currentMember = btn.getAttribute('data-member');
            grantWho.textContent = btn.getAttribute('data-name') || currentMember;
            grantStatus.textContent = '';
            modal.removeAttribute('hidden');
            syncScopeVisibility();
          });
        });
        var cancel = document.getElementById('grant-cancel');
        if (cancel) cancel.addEventListener('click', function () { modal.setAttribute('hidden', ''); });

        if (grantForm) {
          grantForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!currentMember) return;
            var fd = new FormData(grantForm);
            var st = String(fd.get('scope_type') || 'org');
            var payload = { action: 'grant', scope_type: st, capability: String(fd.get('capability') || 'member') };
            if (st !== 'org') payload.scope_id = String(fd.get('scope_id') || '');
            grantStatus.textContent = 'Granting…';
            try {
              var res = await postJSON(API + '/members/' + encodeURIComponent(currentMember) + '/capabilities', 'POST', payload);
              var data = await res.json().catch(function () { return {}; });
              if (res.ok) { grantStatus.textContent = 'Granted.'; reloadSoon(); }
              else if (res.status === 403) { grantStatus.textContent = 'Forbidden — admin required on this scope.'; }
              else { grantStatus.textContent = 'Grant failed: ' + (data.error || res.status); }
            } catch (err) { grantStatus.textContent = 'Grant request errored.'; }
          });
        }
      })();
    </script>`)
}

// ── Unit card renderer (#26) ───────────────────────────────────────────────────
//
// unitCard(u, canManage) — the employee-performance panel. One card per agent.
// Layout: avatar + name/role header, then body sections: Objective (OKR), KPI +
// progress bar, Effort dial, Autonomy badge, Burn gauge ($X/hr, #15), Budget cap
// + window, Current Work (most-recent in_progress/open task), Next Approval (task
// in 'review'). Followed by a collapsed Knobs form for admins.
//
// All strings are manually escaped (escHtml/escAttr) because the card is built
// as a raw string for injection into a grid container via raw().
//
// Burn ($X/hr) is derived from today's metered spend (#15): the agent's current-day
// execution_meter window, priced via src/agents/cost.ts. The budget cap + window
// fields give the configured ceiling alongside the live rate.

function agentGradientLocal(name: string): string {
  // Same deterministic gradient as observatory — kept local to avoid a cross-module
  // import of agentGradient from observatory.ts (that module pulls in loadObservatory).
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  const h2 = (h + 48) % 360
  return `linear-gradient(135deg,hsl(${h} 58% 46%),hsl(${h2} 62% 38%))`
}

function effortBadge(effort: string): string {
  const label = effort.charAt(0).toUpperCase() + effort.slice(1)
  return `<span class="effort-badge effort-${escAttr(effort)}">${escHtml(label)}</span>`
}

function autonomyBadge(autonomy: string): string {
  const label = autonomy.replace(/_/g, ' ')
  return `<span class="autonomy-badge autonomy-${escAttr(autonomy)}">${escHtml(label)}</span>`
}

function budgetLine(capCents: number | null, window: string): string {
  if (capCents === null) return `<span class="unit-field-value dim">no cap set</span>`
  const dollars = (capCents / 100).toFixed(2)
  return (
    `<div class="unit-budget">` +
    `<span class="cap">$${escHtml(dollars)}</span>` +
    `<span class="window">/ ${escHtml(window)}</span>` +
    `</div>`
  )
}

function unitKnobsForm(id: string, kind: 'agent' | 'squad', u: {
  okr: string | null
  kpi_target: string | null
  effort: string
  autonomy: string
  budget_cap_cents: number | null
  budget_window: string
}): string {
  const action = kind === 'agent' ? `/agents/${escAttr(id)}/config` : `/squads/${escAttr(id)}/config`
  const budgetDollars = u.budget_cap_cents !== null ? (u.budget_cap_cents / 100).toFixed(2) : ''
  const effortOptions = ['low', 'standard', 'high', 'sprint']
    .map((e) => `<option value="${e}"${u.effort === e ? ' selected' : ''}>${e}</option>`)
    .join('')
  const autonomyOptions = ['suggest', 'draft', 'execute', 'execute_with_approval']
    .map((a) => `<option value="${a}"${u.autonomy === a ? ' selected' : ''}>${a.replace(/_/g, ' ')}</option>`)
    .join('')
  const windowOptions = ['day', 'week']
    .map((w) => `<option value="${w}"${u.budget_window === w ? ' selected' : ''}>${w}</option>`)
    .join('')

  return (
    `<details class="unit-knobs">` +
    `<summary>Configure</summary>` +
    `<form class="unit-knobs-body" method="post" action="${action}" autocomplete="off">` +
    `<div class="knob-row"><label class="knob-label">Objective (OKR)` +
    `<input class="knob-input" name="okr" value="${escAttr(u.okr ?? '')}" placeholder="Drive Q3 pipeline to 50 leads" /></label></div>` +
    `<div class="knob-row"><label class="knob-label">KPI target` +
    `<input class="knob-input" name="kpi_target" value="${escAttr(u.kpi_target ?? '')}" placeholder="50 leads" /></label></div>` +
    `<div class="knob-row-2col">` +
    `<div class="knob-row"><label class="knob-label">Effort` +
    `<select class="knob-select" name="effort">${effortOptions}</select></label></div>` +
    `<div class="knob-row"><label class="knob-label">Autonomy` +
    `<select class="knob-select" name="autonomy">${autonomyOptions}</select></label></div>` +
    `</div>` +
    `<div class="knob-row-2col">` +
    `<div class="knob-row"><label class="knob-label">Budget cap ($)` +
    `<input class="knob-input" name="budget_cap_dollars" type="number" min="0" step="0.01" ` +
    `value="${escAttr(budgetDollars)}" placeholder="50.00" /></label></div>` +
    `<div class="knob-row"><label class="knob-label">Window` +
    `<select class="knob-select" name="budget_window">${windowOptions}</select></label></div>` +
    `</div>` +
    `<button type="submit" class="btn sm knob-submit">Save</button>` +
    `</form>` +
    `</details>`
  )
}

/** Render one agent as an employee-performance unit card. */
function unitCard(u: AgentAdminRow, canManage: boolean): string {
  const grad = agentGradientLocal(u.name)
  const initial = escHtml(u.name.slice(0, 1).toUpperCase())
  const dotClass = u.status === 'active' ? 'active' : 'paused'

  // OKR / Objective
  const okrLine = u.okr
    ? `<span class="unit-field-value">${escHtml(u.okr)}</span>`
    : `<span class="unit-field-value dim">not set</span>`

  // KPI + progress bar
  const kpiLabel = u.kpi_target ? escHtml(u.kpi_target) : '<em style="color:var(--dim)">not set</em>'
  const kpiPct = Math.min(Math.max(u.kpi_progress ?? 0, 0), 100)
  const kpiSection =
    `<div class="unit-field">` +
    `<span class="unit-field-label">KPI</span>` +
    `<span class="unit-field-value">${kpiLabel}</span>` +
    `<div class="kpi-bar-wrap"><div class="kpi-bar-fill" style="width:${kpiPct}%"></div></div>` +
    `<span style="font-size:11px;color:var(--dim)">${kpiPct}%</span>` +
    `</div>`

  // Burn ($/hr) — derived from today's spend (#15). Shows the rate plus today's
  // running total in the tooltip. $0.00/hr when the unit has not spent today.
  const burn = formatBurn(u.spend_today_micro_usd, Date.now())
  const spentToday = formatUsd(u.spend_today_micro_usd)
  const burnLine =
    `<span class="unit-field-value" title="${escAttr(`${spentToday} spent today (UTC) · estimated from token usage`)}">` +
    `${escHtml(burn)}` +
    (u.spend_today_micro_usd > 0 ? ` <span class="dim" style="font-size:11px">· ${escHtml(spentToday)} today</span>` : '') +
    `</span>`

  // Budget cap + window (the concrete configured number)
  const budgetSection =
    `<div class="unit-field">` +
    `<span class="unit-field-label">Budget</span>` +
    budgetLine(u.budget_cap_cents, u.budget_window) +
    `</div>`

  // Current work
  const currentWork = u.current_task_title
    ? `<span class="unit-task-chip" title="${escAttr(u.current_task_title)}">${escHtml(u.current_task_title)}</span>`
    : `<span class="unit-field-value dim">idle</span>`

  // Next approval
  const nextApproval = u.review_task_title
    ? `<span class="unit-task-chip" title="${escAttr(u.review_task_title)}">${escHtml(u.review_task_title)}</span>`
    : `<span class="unit-field-value dim">—</span>`

  // Admin action buttons (pause/resume + delete) keep the existing pattern
  const actions = canManage
    ? `<div style="display:flex;gap:6px;padding:10px 16px;border-top:1px solid var(--border)">` +
      `<button class="btn sm ag-status-btn" data-agent="${escAttr(u.id)}" data-status="${escAttr(u.status)}" ` +
      `data-name="${escAttr(u.name)}">${u.status === 'active' ? 'Pause' : 'Resume'}</button>` +
      `<button class="btn sm ag-delete-btn" style="background:transparent;color:#e5534b;border-color:#e5534b" ` +
      `data-agent="${escAttr(u.id)}" data-name="${escAttr(u.name)}">Delete</button>` +
      `<span class="ag-row-status" data-agent-row="${escAttr(u.id)}" style="font-size:12px;color:var(--dim);margin-left:4px"></span>` +
      `</div>`
    : ''

  const knobsForm = canManage ? unitKnobsForm(u.id, 'agent', u) : ''

  return (
    `<div class="unit-card" data-agent-row="${escAttr(u.id)}">` +
    // Header
    `<div class="unit-card-head">` +
    `<div class="unit-av" style="background:${grad}">${initial}</div>` +
    `<div class="unit-head-body">` +
    `<a href="/agents/${escAttr(u.id)}" class="unit-name">${escHtml(u.name)}</a>` +
    `<div class="unit-role">${escHtml(u.role)}</div>` +
    `</div>` +
    `<span class="unit-status-dot unit-status-dot--${dotClass}" title="${escAttr(u.status)}"></span>` +
    `</div>` +
    // Body
    `<div class="unit-body">` +
    `<div class="unit-field"><span class="unit-field-label">Objective</span>${okrLine}</div>` +
    kpiSection +
    `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">` +
    `<div class="unit-field"><span class="unit-field-label">Effort</span><div>${effortBadge(u.effort)}</div></div>` +
    `<div class="unit-field"><span class="unit-field-label">Autonomy</span><div>${autonomyBadge(u.autonomy)}</div></div>` +
    `</div>` +
    `<div class="unit-field"><span class="unit-field-label">Burn</span>${burnLine}</div>` +
    budgetSection +
    `<div class="unit-field"><span class="unit-field-label">Current Work</span>${currentWork}</div>` +
    `<div class="unit-field"><span class="unit-field-label">Next Approval</span>${nextApproval}</div>` +
    `</div>` +
    // Knobs + admin actions
    knobsForm +
    actions +
    `</div>`
  )
}

// ── /agents view ─────────────────────────────────────────────────────────────
//
// agentsBody — renders the full agent management page:
//   - Grid of unit cards (employee-performance panel, one per agent)
//   - Per-card Pause/Resume + Delete buttons (owner/admin only, JS fetch)
//   - Per-card Knobs form (admin only): set OKR/KPI/effort/autonomy/budget
//   - Add-agent form (name, slug, role, model, squad picker)
//
// All user-supplied strings are escaped via escHtml/escAttr.
// Status mutations call POST /agents/:id/status (JSON body {status}).
// Delete calls DELETE /agents/:id (fetch with method:DELETE + confirm()).

function agentsBody(
  agents: AgentAdminRow[],
  squadOptions: SquadOption[],
  canManage: boolean,
  errorMsg: string | null = null,
) {
  const errorBanner = errorMsg
    ? `<div class="warn-box" style="margin-bottom:14px"><strong>Error:</strong> ${escHtml(errorMsg)}</div>`
    : ''

  // Squad <option>s for the add-agent form.
  const squadOptHtml = squadOptions.length === 0
    ? '<option disabled value="">No squads — create a squad first</option>'
    : squadOptions
        .map((s) => {
          const label = s.dept_name
            ? `${s.dept_name} / ${s.name}`
            : s.name
          return `<option value="${escAttr(s.id)}">${escHtml(label)}</option>`
        })
        .join('')

  // Unit card grid — employee performance panels, one per agent.
  const cardsHtml = agents.length === 0
    ? `<div class="card"><p class="empty">No agents yet. Add one below.</p></div>`
    : `<div class="unit-grid">${agents.map((a) => unitCard(a, canManage)).join('')}</div>`

  const addForm = canManage && squadOptions.length > 0
    ? `<div class="card" style="margin-top:20px">
        <h2 style="margin-top:0">Add agent</h2>
        <form class="adminform" method="post" action="/agents" autocomplete="off">
          <label>Name
            <input name="name" required placeholder="Dispatcher" />
          </label>
          <label>Slug
            <input name="slug" required placeholder="dispatcher" />
          </label>
          <label>Role
            <input name="role" placeholder="member" />
          </label>
          <label>Model
            <input name="model" value="@cf/meta/llama-3.3-70b-instruct-fp8-fast" />
          </label>
          <label>Squad
            <select name="squad_id" required>${squadOptHtml}</select>
          </label>
          <button type="submit" class="btn">Add agent</button>
        </form>
      </div>`
    : canManage
      ? `<div class="card" style="margin-top:20px"><p class="empty">Create a squad first, then add agents.</p></div>`
      : ''

  // Starter packs (#11): one-click seed of a branded squad + its work-units.
  // Admin-only; each button POSTs to the RBAC'd /squads/packs/:key seeder.
  const packsCard = canManage && SQUAD_PACKS.length > 0
    ? `<div class="card" style="margin-top:20px">
        <h2 style="margin-top:0">Starter packs</h2>
        <p class="empty" style="margin-top:0">Seed a ready-made squad and its work-units in one click. You can dial each unit's knobs afterwards.</p>
        ${SQUAD_PACKS.map((p) => (
          `<form method="post" action="/squads/packs/${escAttr(p.key)}" style="display:flex;align-items:center;gap:12px;margin-top:10px">` +
          `<div style="flex:1"><strong>${escHtml(p.name)}</strong> · <span style="color:var(--dim);font-size:13px">${escHtml(p.description)}</span> ` +
          `<span style="color:var(--dim);font-size:12px">(${p.agents.length} units)</span></div>` +
          `<button type="submit" class="btn secondary sm">Seed ${escHtml(p.name)}</button>` +
          `</form>`
        )).join('')}
      </div>`
    : ''

  const activeCount = agents.filter((a) => a.status === 'active').length
  const pausedCount = agents.length - activeCount

  return html`
    ${pageHeader({
      crumbs: 'Overview / Agents',
      title: 'Agents',
      sub:
        'All agents across this pot. Each card shows the unit’s objective, KPI, effort level, autonomy, and current work.' +
        (canManage ? ' Use the Configure panel on each card to set OKR, effort, autonomy, and budget.' : ''),
    })}
    ${kpiRow([
      statCard({ label: 'Agents', value: String(agents.length) }),
      statCard({ label: 'Active', value: String(activeCount), subTone: 'ok' }),
      statCard({ label: 'Paused', value: String(pausedCount), subTone: pausedCount > 0 ? 'dim' : 'dim' }),
    ])}
    ${raw(errorBanner)}
    ${raw(cardsHtml)}
    ${raw(addForm)}
    ${raw(packsCard)}
    ${canManage && agents.length > 0 ? agentsScript() : html``}`
}

function agentsScript(): HtmlEscapedString {
  return raw(`
    <script>
      (function () {
        // Pause / Resume — POST /agents/:id/status {status:'active'|'paused'}
        document.querySelectorAll('.ag-status-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var agentId = btn.getAttribute('data-agent');
            var current = btn.getAttribute('data-status');
            var next = current === 'active' ? 'paused' : 'active';
            var row = document.querySelector('[data-agent-row="' + agentId + '"]');
            var rowStatus = row && row.querySelector('.ag-row-status');
            btn.disabled = true;
            if (rowStatus) rowStatus.textContent = '…';
            fetch('/agents/' + encodeURIComponent(agentId) + '/status', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ status: next })
            }).then(function (r) {
              return r.json().then(function (d) { return { ok: r.ok, d: d }; });
            }).then(function (r) {
              if (r.ok) {
                if (rowStatus) rowStatus.textContent = next === 'paused' ? 'paused' : 'resumed';
                btn.textContent = next === 'active' ? 'Pause' : 'Resume';
                btn.setAttribute('data-status', next);
              } else {
                if (rowStatus) rowStatus.textContent = (r.d && r.d.error) || 'failed';
              }
              btn.disabled = false;
            }).catch(function () {
              if (rowStatus) rowStatus.textContent = 'network error';
              btn.disabled = false;
            });
          });
        });

        // Delete — DELETE /agents/:id (confirm first)
        document.querySelectorAll('.ag-delete-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var agentId = btn.getAttribute('data-agent');
            var name = btn.getAttribute('data-name');
            if (!confirm('Delete agent "' + name + '"? This cannot be undone.')) return;
            var row = document.querySelector('[data-agent-row="' + agentId + '"]');
            var rowStatus = row && row.querySelector('.ag-row-status');
            btn.disabled = true;
            if (rowStatus) rowStatus.textContent = '…';
            fetch('/agents/' + encodeURIComponent(agentId), {
              method: 'DELETE', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }
            }).then(function (r) {
              return r.json().then(function (d) { return { ok: r.ok, d: d }; });
            }).then(function (r) {
              if (r.ok) {
                if (row) {
                  row.style.opacity = '0.4';
                  row.style.transition = 'opacity .3s';
                  setTimeout(function () { row.remove(); }, 320);
                }
              } else {
                if (rowStatus) rowStatus.textContent = (r.d && r.d.error) || 'failed';
                btn.disabled = false;
              }
            }).catch(function () {
              if (rowStatus) rowStatus.textContent = 'network error';
              btn.disabled = false;
            });
          });
        });
      })();
    </script>`)
}

// ── small HTML escapers (for raw-interpolated attribute/text values) ──────────
// hono's html`` template auto-escapes interpolations, but raw() strings we build
// by hand (table rows, <option>s, modal markup) must be escaped explicitly.
function escHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function escAttr(v: string): string {
  return escHtml(v)
}
