// src/mcp/tool-annotations.ts — MCP `annotations` for EVERY tool in the full /mcp registry
// (mupot#1709, first wave). OpenAI/ChatGPT plugin review requires readOnlyHint /
// destructiveHint / openWorldHint on every tool, and ChatGPT uses them to decide when to ask
// the user to confirm a call.
//
// THESE ARE HINTS ONLY. They never replace server-side authorization (invokeTool's spec.min
// floor and each handler's own checks are unchanged), and they MUST MATCH ACTUAL SIDE EFFECTS
// (Athena design-gate condition b85b87e4): a tool that writes ANY state is never readOnly.
// Every row below was classified by reading the handler and the service function it calls, not
// by its name; the `evidence` string names the write / external call that drove the verdict.
//
// RULES USED
//  readOnlyHint   true ONLY if the handler performs no write of any kind: no D1 INSERT/UPDATE/
//                 DELETE, KV/R2 put or delete, queue/bus emit, outbound message, presence or
//                 fleet last-seen touch, lease/claim, audit row, or cache write. Where a tool
//                 has an OPTIONAL arg that writes (inbox peek:false), the worst case governs.
//                 ONE deliberate carve-out: the framework-level post-call presence bump in
//                 invokeTool (index.ts, "Zero-Touch Living Presence") runs after EVERY
//                 successful /mcp call of every tool, so it cannot distinguish tools and is not
//                 counted; a tool is judged on what its OWN handler writes. (The needs-you
//                 profile runs with ToolCtx.sideEffectFree and suppresses even that bump.)
//                 SECOND carve-out (Athena #1718 P1-1, one rule for every reader): an
//                 ephemeral, caller-bound PAGINATION CURSOR stored with a TTL (KV
//                 SESSIONS.put of the next-page position, readable only by the same caller)
//                 is not counted. It changes no state any other caller can observe; it is
//                 the server-side half of returning a page. Applies identically to
//                 flight_list and needs_you_list.
//  destructiveHint true if the tool can delete, revoke, archive, deactivate, reset, kill, or
//                 overwrite existing state (updates to an existing row's content/config/
//                 verdict, status moves that end something, secret/credential replacement).
//                 Additive INSERTs and the caller's own liveness/identity self-reports are not.
//                 An upsert that can overwrite an existing row's user-visible content (ON
//                 CONFLICT DO UPDATE of status/evidence/config) IS destructive; a recomputed
//                 accounting rollup (cost totals derived from reported usage) is not.
//  openWorldHint  true if the handler reaches a system outside this pot's own D1/KV/R2/DO/
//                 Vectorize/Workers-AI bindings: Cloudflare API, GitHub, Inkwell/WordPress,
//                 Supabase, Cursor, Jev, or a model provider via the AI Gateway — including
//                 a SYNCHRONOUS call made by a Durable Object the handler awaits (wake_agent).
//                 Asynchronous bus delivery to other agents is NOT counted as open-world (the
//                 handler itself makes no external call and does not wait on one).
//
// A test (tests/mcp-tool-annotations.test.ts) fails if a registered tool has no row here, if a
// row names no registered tool, or if a known-writing tool is marked readOnly.

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  openWorldHint: boolean
}

interface AnnotationRow extends ToolAnnotations {
  /** The write / external call that drove the classification (file:line on main 79c1151f). */
  evidence: string
}

const row = (readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean, evidence: string): AnnotationRow =>
  ({ readOnlyHint, destructiveHint, openWorldHint, evidence })
/** Reads only, pot-internal. */
const RO = (evidence: string): AnnotationRow => row(true, false, false, evidence)
/** Reads only, but reaches an external system. */
const ROX = (evidence: string): AnnotationRow => row(true, false, true, evidence)
/** Additive write (INSERT / append / self-liveness), pot-internal. */
const ADD = (evidence: string): AnnotationRow => row(false, false, false, evidence)
/** Additive write that also reaches an external system. */
const ADDX = (evidence: string): AnnotationRow => row(false, false, true, evidence)
/** Destructive write (delete/revoke/archive/overwrite/kill), pot-internal. */
const MUT = (evidence: string): AnnotationRow => row(false, true, false, evidence)
/** Destructive write that also reaches an external system. */
const MUTX = (evidence: string): AnnotationRow => row(false, true, true, evidence)

export const TOOL_ANNOTATION_ROWS: Readonly<Record<string, AnnotationRow>> = {
  // ── flights ────────────────────────────────────────────────────────────────────────────────
  flight_dispatch: ADD('dispatchFlight INSERTs flights + sendAgentMessage INSERT agent_messages (messages.ts:426)'),
  flight_get: RO('getFlight SELECT only (index.ts:3509)'),
  flight_list: RO('SELECTs; the only write is the TTL\'d caller-bound pagination cursor (issueFlightCursor, index.ts:3110), covered by the cursor carve-out'),
  flight_land: MUT('landGovernedFlight UPDATE flights status=landed + INSERT flight_event_outbox (flight/service.ts:418,543)'),
  flight_reap_stalled: MUT('reapStalledFlight UPDATE flights / routine_runs + INSERT reap receipt (flight/watchdog.ts:403,413,476)'),
  flight_cancel: MUT('cancelFlight UPDATE flights status=failed + UPDATE routine_runs (cancelled or failed/cancellation_unconfirmed) + UPDATE routine_run_actions (unconfirmed branch only) + INSERT routine_run_events (cancellation_unconfirmed) + INSERT flight_cancel_receipts with routine_outcome (flight/watchdog.ts cancelFlight)'),

  // ── tasks ──────────────────────────────────────────────────────────────────────────────────
  task_create: ADDX('createTask INSERT tasks (tasks/service.ts:1414) + mirrorTaskCreate GitHub issue POST (service.ts:1470,853)'),
  task_list: ADD('touchPollFleetPresence UPDATE fleet_agents.last_reported_at (index.ts:1236, fleet/registry.ts:321); needs-you profile suppresses it via sideEffectFree'),
  task_get: RO('SELECT receipts/verdicts only (index.ts:1312)'),
  task_board: RO('SELECT only (index.ts:1245)'),
  kanban_board: RO('loadKanbanData SELECT only (dashboard/kanban-routes.ts:59)'),
  task_update: MUTX('persistTaskUpdate UPDATE tasks (tasks/service.ts:540) + gate reassignment INSERT (index.ts:1941) + mirrorTaskUpdate GitHub PATCH (index.ts:1898)'),
  task_verdict: MUT('writeVerdict batch INSERT task_verdicts + task status (tasks/service.ts:1896)'),
  task_verdict_reverse: MUT('reverseTaskVerdict UPDATE task_verdicts.reversed_at + INSERT verdict_reversals (tasks/service.ts:694,758)'),
  task_dispatch: ADD('INSERT task_dispatch_receipts + bus emit (index.ts:2542,2570)'),
  task_dispatch_runtime_receipt: MUT('UPDATE tasks status/result + INSERT mutation_audit_entries + runtime receipt (tasks/runtime-receipts.ts:1038-1123)'),
  task_submit_result: MUTX('UPDATE tasks status=review,result + INSERT task_result_submissions (index.ts:2878,2895) + mirrorTaskUpdate GitHub (index.ts:2908)'),
  task_intake_audit: RO('SELECT + pure evaluateTaskIntakeContract (index.ts:2937-3045)'),

  // ── memory ─────────────────────────────────────────────────────────────────────────────────
  remember: ADD('INSERT engrams + Vectorize upsert (memory/index.ts:39,47)'),
  recall: RO('Vectorize query + SELECT engrams (memory/index.ts:60-90); embeddings via Workers AI binding, pot-internal'),
  squad_remember: ADD('createMemory.remember INSERT engrams + Vectorize upsert (memory/index.ts:39,47)'),
  squad_recall: RO('createMemory.recall read path (memory/index.ts:60)'),
  project_remember: ADD('createMemory.remember INSERT engrams + Vectorize upsert (memory/index.ts:39,47)'),
  project_recall: RO('createMemory.recall read path (memory/index.ts:60)'),
  project_memory_get: RO('SELECT engrams WHERE id AND agent_id=project:<id> behind readableProject (index.ts toolProjectMemoryGet); pure SHA-256 over stored text'),

  // ── wake / routing / messaging ─────────────────────────────────────────────────────────────
  wake_agent: ADDX('routeAgentWake POSTs AgentDO /wake (agents/wake-routing.ts:123); the DO runs one cortex cycle synchronously via createModel (agents/agent-do.ts:16,136) which calls the model provider through the AI Gateway, and advances the DO cycle/alarm'),
  router_tick: MUT('runRouterTick UPDATE tasks (claims/assigns) + bus emit ONLY when dry_run:false is explicit; dry_run defaults to true (toolRouterTick) and the dry path writes nothing (router/engine.ts dryRun branch)'),
  execution_meter_status: RO('getAuthorizedMeterStatus SELECT only (agents/meter.ts:287)'),
  squad_message: ADD('createBus().emit queue send (index.ts:4148)'),
  send: ADD('sendToRef -> sendAgentMessage INSERT agent_messages + bus emit (agents/messages.ts:426,511)'),
  broadcast: ADD('sendAgentMessage per recipient INSERT agent_messages (agents/messages.ts:426)'),
  // inbox peek:false CONSUMES (UPDATE agent_messages.read_at) and every call touches fleet_agents
  // last-seen; classified by worst case. Marks read, deletes nothing, so not destructive.
  inbox: ADD('peek:false UPDATE agent_messages SET read_at (agents/messages.ts:760,786) + touchPollFleetPresence (index.ts:4432)'),
  message_get: RO('getSenderMessage SELECT only (agents/messages.ts:624)'),
  inbox_lease: ADD('leaseAgentInbox UPDATE agent_messages lease + touchPollFleetPresence (agents/messages.ts:1671; index.ts:4579)'),
  inbox_lease_reconcile: ADD('INSERT/UPDATE agent_inbox_lease_attempts (agents/messages.ts:1412,1419,1430)'),
  inbox_lease_ack: ADD('ackAgentInboxLeaseAttempt UPDATE agent_messages / attempts (agents/messages.ts:1494-1563)'),
  inbox_ack: ADD('ackAgentMessages UPDATE agent_messages (agents/messages.ts:1779)'),
  inbox_dead_letters: RO('listDeadLetteredMessages SELECT only (agents/messages.ts:1826)'),
  inbox_consumer_status: RO('loadActiveAgentKey SELECT only (index.ts:4807)'),
  set_agent_inbox_consumer: MUT('INSERT agent_inbox_fences ON CONFLICT DO UPDATE mode/generation (index.ts:4894-4897)'),
  task_dispatch_lease_reset: MUT('adminResetDispatchLease overrides/terminates a live lease + INSERT mutation_audit_entries (tasks/runtime-receipts.ts:1467,1503)'),

  // ── presence / sessions / identity (own session) ───────────────────────────────────────────
  peers: RO('SELECT presence/fleet only (index.ts:5027)'),
  check_in: ADD('recordCheckin INSERT presence ON CONFLICT UPDATE + SESSIONS.put + fleet upsert (fleet/presence.ts:213; index.ts:5194,5268)'),
  end_agent_session: MUT('revokeAgentSessionByCredential revokes the caller session (index.ts:5313)'),
  request_elevation: ADD('createElevationRequest INSERT elevation_requests (auth/elevation.ts:202)'),
  elevation_status: RO('SELECT elevation requests/grants only (index.ts:5421)'),
  status: RO('SELECTs + AgentDO /status read of storage only (index.ts:5588; agents/agent-do.ts:417); opening the DO runs an idempotent CREATE TABLE IF NOT EXISTS schema init (agent-do.ts:95), not state'),
  fleet_agent_get: RO('readFleetAgentRow SELECT only (index.ts:5612; fleet/registry.ts:625)'),
  // boot_context on the FULL /mcp writes: touchPresence (index.ts:5820) and, with runtime/model
  // args, reportSelfAtBoot UPDATE fleet_agents (index.ts:5850). On the needs-you profile it runs
  // sideEffectFree (neither runs), which is why that profile may still say readOnly.
  boot_context: ADD('touchPresence (index.ts:5820) + reportSelfAtBoot UPDATE fleet_agents runtime/model/status (index.ts:5850)'),
  orient: ADD('buildOrient INSERT agent_orientation ON CONFLICT UPDATE orient_count (orient/service.ts:327); profile passes recordInduction:false'),
  connect: ADD('UPDATE member_tokens SET agent_id WHERE agent_id IS NULL (index.ts:6238); first bind only, never overwrites'),
  verify_agent_connection: ADD('verifyAgentConnection sends a challenge message + records receipts (members/agent-connection-verification.ts:436-582)'),

  // ── projects ───────────────────────────────────────────────────────────────────────────────
  project_create: ADD('createProject INSERT projects + project_squad_access (projects/service.ts:311,335) + bus emit (mcp/projects.ts:81)'),
  project_list: RO('SELECT only (mcp/projects.ts:275)'),
  project_get: RO('loadProjectSituation SELECT only (projects/situation.ts:460)'),
  project_context: RO('loadProjectSituation + listPresence + listProjectBindings SELECT only (mcp/projects.ts:432)'),
  project_wiki: ROX('getProjectWikiGraph GET to Inkwell wiki service (projects/wiki-client.ts:299)'),
  project_update: MUT('updateProject UPDATE projects (projects/service.ts:511) + start-gate receipts'),
  project_recommit: MUT('proposeProjectRecommit recordRecommitOrKill can kill the project (projects/circuit-breaker.ts:317)'),
  project_squad_list: RO('SELECT only (mcp/projects.ts:567)'),
  project_squad_set: MUT('upsertProjectSquadAccess overwrites access_level (mcp/projects.ts:626)'),
  project_squad_remove: MUT('removeProjectSquadAccess DELETE (mcp/projects.ts:654)'),
  project_deploy: ADD('deployProject: UPDATE projects.deploy_status (projects/deploy.ts:95), createTask (:120), createFlight (:141), recordProjectDeployment INSERT receipt (:196); no external call in deploy.ts'),

  // ── org / agents / tokens ──────────────────────────────────────────────────────────────────
  create_department: ADD('INSERT departments (org/service.ts:141)'),
  create_squad: ADD('INSERT squads (org/service.ts:270)'),
  create_agent: ADD('createAgent batch INSERT (org/service.ts:959)'),
  resolve_agent: RO('findAgentsByName SELECT only (org/service.ts:1064)'),
  get_agent_profile: RO('getAgentProfile SELECT only (org/service.ts:1053)'),
  // mint with a replacement handoff revokes the prior live token (prepare/activateAgentTokenReplacement).
  mint_agent_token: MUT('mintAgentBoundToken INSERT member_tokens + credential claim KV put; replacement path revokes the prior token (mcp/provision.ts:626+; auth/credential-claim.ts:92)'),
  list_agent_tokens: RO('listAgentTokensQuery SELECT only (mcp/token-queries.ts:24)'),
  revoke_agent_token: MUT('revokeMemberToken UPDATE member_tokens.revoked_at (members/service.ts:161)'),
  list_agent_sessions: RO('listAgentSessions SELECT only (auth/agent-sessions.ts:366)'),
  revoke_agent_session: MUT('revokeAgentSessionById UPDATE agent_sessions.revoked_at (auth/agent-sessions.ts:411)'),
  provision_agent_connection: ADD('provisionAgentConnection reserves + mints a connection for an UNMINTED agent (members/agent-connection.ts:741)'),
  grant_agent_capability: MUT('setAgentSquadAccess commit path replaces/deletes prior memberships+capabilities (members/agent-access.ts:381,424)'),
  squad_member_add: ADD('addSquadMember INSERT memberships (members/squad-membership.ts:133)'),
  squad_member_remove: MUT('removeSquadMember DELETE memberships (members/squad-membership.ts:213)'),
  squad_member_list: RO('listSquadMembers SELECT only (members/squad-membership.ts:285)'),
  register_agent_key: MUT('registerAgentPublicKey UPDATE retires prior agent_keys + INSERT new (fleet/agent-keys.ts:117,130)'),
  deactivate_agent: MUT('UPDATE agents status=inactive + DELETE agent_keys/fleet_agents + revoke tokens (mcp/provision.ts:2555+)'),
  update_agent: MUT('updateAgentProfile UPDATE agents + agent_audit (org/service.ts:1676)'),
  move_agent_squad: MUT('UPDATE agents.squad_id + DELETE memberships/capabilities (org/service.ts:1866-1872)'),
  update_squad: MUT('updateUnitConfig UPDATE squads (org/service.ts:1265)'),
  team_bootstrap: ADD('INSERT project/squads/access/invites + credential claim + remember (org/team-bootstrap.ts:882,938)'),
  team_bootstrap_release: MUT('releaseTeamBootstrapSlugBase DELETE FROM projects (org/team-bootstrap.ts:1089)'),
  archive_row: MUT('archiveRow archives members/agents/squads/projects, and tasks only when TASK_ARCHIVE_ENABLED=1 (taskArchiveEnabled)'),
  // unarchive restores a previously archived row (the inverse of archive_row): changes state, destroys nothing.
  unarchive_row: ADD('unarchiveRow restores archived members/agents/squads/projects, and tasks only when TASK_ARCHIVE_ENABLED=1 (taskArchiveEnabled)'),
  task_incident_revert: MUT('task_incident_revert INSERT task_incident_revert_receipts + guarded UPDATE tasks status/assignee/updated_at (tasks/incident-revert.ts); org-admin operator only'),
  // Loop brakes (migration 0203): additive state rows, no data destroyed; resume is the exact inverse.
  execution_pause: ADD('toolExecutionPause INSERT execution_pauses ON CONFLICT DO NOTHING + INSERT mutation_audit_entries (mcp/execution-pause.ts); stops nothing already written, no task/agent row changes'),
  execution_release: ADD('toolExecutionRelease UPDATE execution_holds released_at + DELETE task_execution_attempts + INSERT mutation_audit_entries (agents/execution-brakes.ts releaseExecutionHold); lifts a hold, destroys only the refusal counter'),
  execution_resume: ADD('toolExecutionResume UPDATE execution_pauses resumed_at + INSERT mutation_audit_entries (mcp/execution-pause.ts); inverse of execution_pause'),
  archive_plan_expand: RO('read-only SELECT expansion of a task archive plan (toolArchivePlanExpand); refuses 409 not_supported after the admin gate unless TASK_ARCHIVE_ENABLED=1, and never writes'),
  agent_lifecycle: MUTX('delegates to deactivate/move/grant/mint, and free-text intent calls Jev at api.typesafe.ai (mcp/agent-lifecycle.ts:156,258)'),
  bootstrap_self: ADD('bootstrapSelf INSERT department/squad/agent/capabilities + agent_audit + credential claim (members/bootstrap-self.ts:809-852)'),
  seat_select: ADD('seatSelect INSERT agent/member/binding/capability/token/audit/seat (members/seat-select.ts); flag-gated SEAT_AUTO_ENROLL'),
  // One-shot reveal: the KV entry is deleted by the read, so the secret is gone afterwards.
  reveal_credential_claim: MUT('revealCredentialClaim SESSIONS.delete consumes the one-time secret (auth/credential-claim.ts:149)'),

  // ── add-ons ────────────────────────────────────────────────────────────────────────────────
  addon_install: ADD('installAddon INSERT addon_installations + receipts (addons/service.ts:2880,2902)'),
  addon_configure: MUT('configureAddon UPDATE addon_installations config + receipts (addons/service.ts:3001)'),
  addon_activate: ADD('activateAddon UPDATE addon_installations status (addons/service.ts:3313); forward transition, config untouched'),
  addon_disable: MUT('disableAddon UPDATE addon_installations (addons/service.ts:3540)'),
  addon_archive: MUT('archiveAddon UPDATE bindings + installations (addons/service.ts:3867-3891)'),
  addon_setup: MUTX('composite install+configure+activate (configure overwrites) + probeOfficeHealth external fetch (mcp/addons.ts:301)'),

  // ── gates / loops / secrets ────────────────────────────────────────────────────────────────
  grant_gate_capability: ADD('grantGateCapability INSERT OR IGNORE gate_grants (gates/grants.ts:67)'),
  grant_list_gate_capabilities: RO('listGateCapabilities SELECT only (gates/grants.ts:96)'),
  revoke_gate_capability: MUT('revokeGateCapability DELETE FROM gate_grants (gates/grants.ts:134)'),
  loop_list: RO('listLoops SELECT only (loops/service.ts:154)'),
  loop_set_status: MUT('setLoopStatus UPDATE loops.status, can kill (loops/service.ts:235)'),
  loop_control: MUT('setLoopControl INSERT loop_controls ON CONFLICT DO UPDATE (loops/decisions.ts:140)'),
  secret_env_request: MUT('requestSecretEnv INSERT request + UPDATE secret_env_bindings supersedes prior (secret-env/service.ts:253,271,281)'),
  secret_env_status: RO('getSecretEnvStatus SELECT only (secret-env/service.ts:403)'),

  // ── presence registry ──────────────────────────────────────────────────────────────────────
  presence_register: ADD('registerModule INSERT module_registry ON CONFLICT UPDATE + roster push to presence DO (registry/service.ts:323; realtime.ts:164)'),
  presence_heartbeat: ADD('heartbeatModule UPDATE module_registry (registry/service.ts:387,419) + roster push'),
  presence_deregister: MUT('deregisterModule UPDATE module_registry deactivates the module (registry/service.ts:449)'),
  presence_list: RO('listPresence/listOwnModules SELECT only (registry/service.ts:466,493)'),

  // ── workflow circuits ──────────────────────────────────────────────────────────────────────
  define_circuit: ADD('defineCircuit batch INSERT circuits/nodes/edges (addons/workflow-circuits/service.ts:284-303)'),
  advance_node: MUT('advanceNode UPDATE workflow_circuit_nodes.done_state + INSERT events (workflow-circuits/service.ts:443,447)'),
  get_circuit_state: RO('getCircuitState SELECT only (workflow-circuits/service.ts:309)'),
  approve_gate_edge: MUT('approveGateEdge UPDATE edges approved_by/at, an approval decision (workflow-circuits/service.ts:383)'),

  // ── office add-on ──────────────────────────────────────────────────────────────────────────
  'office.publish_post': MUTX('publishOfficePost claims freeze row + wordpressPublish POST to the customer WordPress site (addons/office/service.ts:1210,1230)'),
  'office.list_pending_approvals': RO('listOfficePendingApprovals SELECT only (addons/office/service.ts:264)'),
  'office.health': ADDX('getOfficeHealth caches the probe in org_settings (service.ts:213-233) after a vault-mediated external fetch (health.ts)'),
  'office.review_approval': MUT('reviewOfficeApproval records an approve/reject verdict via the task verdict path (addons/office/service.ts:347)'),
  'office.reconcile_stalled_publish': MUTX('reconcileStalledOfficePublish looks up WordPress, UPDATE office_publish_freezes outcome (addons/office/service.ts:1435,1470)'),

  // ── routines ───────────────────────────────────────────────────────────────────────────────
  routine_list: RO('listRoutines SELECT only (routines/service.ts:389)'),
  routine_get: RO('getRoutine SELECT only (routines/service.ts:375)'),
  routine_create: ADD('createRoutine INSERT routines (routines/service.ts:358)'),
  routine_update: MUT('updateRoutine UPDATE routines (routines/service.ts:454)'),
  routine_enable: ADD('lifecycle enableRoutine flips status enabled (mcp/routines.ts:283); reversible'),
  routine_pause: ADD('lifecycle pauseRoutine flips status paused (mcp/routines.ts:283); reversible'),
  routine_archive: MUT('lifecycle archiveRoutine archives the routine (mcp/routines.ts:283)'),
  routine_run_now: ADD('createManualRoutineRun INSERT routine_runs + events (routines/service.ts:566-577)'),
  routine_run_list: RO('listRoutineRuns SELECT only (routines/service.ts:652)'),
  routine_run_get: RO('getRoutineRun SELECT only (routines/service.ts:605)'),
  routine_run_answer: ADD('answerRoutineRun UPDATE routine_run_actions/runs + INSERT event (routines/actions.ts:1880-1906); records an answer'),
  routine_run_cancel: MUT('cancelRoutineRun terminates the run (routines/actions.ts:2070-2084)'),
  routine_proposal_submit: ADD('submitRoutineProposal records a proposal (routines/actions.ts:2127)'),
  report_run_usage: ADD('UPDATE flights.cost_micro_usd + routine_runs cost + outbox payload (mcp/routines.ts:414,498): a recomputed accounting rollup from reported usage, not an overwrite of user content, so additive by rule'),
  needs_you_list: RO('listNeedsYou SELECTs (attention/service.ts:855); the only write is the TTL\'d caller-bound pagination cursor (issueCursor, attention/service.ts:772) when more pages exist, covered by the cursor carve-out'),
  project_access_reintake_authorize: ADD('INSERT project_access_grant_receipts (mcp/routines.ts:582)'),

  // ── runners / flight spine ─────────────────────────────────────────────────────────────────
  runner_record: MUT('recordRunner INSERT runner_receipts ON CONFLICT(id) DO UPDATE SET status, ended_at, evidence_summary, verdict_line, log_url: overwrites an existing receipt row (runners/service.ts:103-109)'),
  harness_capacity_report: MUT('upsertCapacity INSERT ... ON CONFLICT DO UPDATE harness_capacity_snapshots (harness/capacity.ts): overwrites the caller\'s own latest snapshot row'),
  harness_capacity_list: RO('listCapacity SELECT only (harness/capacity.ts)'),
  runner_list: RO('listRunners SELECT only (runners/service.ts:145)'),
  objective_accept: ADD('acceptObjective INSERT objectives + acceptance keys + audit (flight-spine/objectives.ts:469,605)'),
  objective_get: RO('visibleObjective SELECT only (mcp/flight-spine.ts:210)'),
  execution_receipt_get: RO('getExecutionReceipt + verify SELECT only (flight-spine/receipts.ts:1355,1363)'),
  token_binding_attest: ADD('issueTokenBindingAttestation INSERT token_binding_attestations (flight-spine/attestations.ts:300)'),
  runtime_seat_register_pending: ADD('registerPendingRuntimeSeat INSERT runtime_seats + seat_attestations (flight-spine/seats.ts:439,530)'),

  // ── external services ──────────────────────────────────────────────────────────────────────
  cursor_dispatch: ADDX('createCursorAgent POST to the Cursor API + recordCursorCloudWork INSERT (cursor/client.ts:257; cursor/dispatch.ts:63)'),
  cursor_run_status: ROX('getCursorRun GET to the Cursor API (cursor/client.ts:307)'),
  athena_review_pr: RO('pure reviewPullRequest over the supplied diff; no D1, KV or network (athena/reviewer.ts:288)'),
  pot_provision: ADDX('provisionSovereignPot creates D1/KV/Worker via the Cloudflare API + INSERT pots (pots/service.ts:104-463,1516)'),
  pot_list: ROX('listSovereignPots GET Cloudflare dispatch-namespace scripts (pots/service.ts:1367)'),
  pot_release: MUT('releaseStalePot UPDATE pots status=released (pots/service.ts:1916)'),
  supabase_connect: ADDX('addConnector INSERT connectors after an introspection call to the Supabase URL (connectors/service.ts:177; supabase-tools.ts:55)'),
  supabase_schema: ROX('introspectSupabaseSchema GET to the customer Supabase project (connectors/supabase.ts:78)'),
  supabase_query: ROX('executeSupabaseQuery SELECT via PostgREST (connectors/supabase.ts:155)'),
  supabase_mutate: MUTX('executeSupabaseMutation writes rows in the customer Supabase project (connectors/supabase.ts:217)'),
}

/** The three MCP hint booleans for a registered tool name, or undefined when unknown. */
export function toolAnnotations(name: string): ToolAnnotations | undefined {
  // Object.hasOwn: a tool named `constructor` / `__proto__` must never resolve to a prototype member.
  if (!Object.hasOwn(TOOL_ANNOTATION_ROWS, name)) return undefined
  const r = TOOL_ANNOTATION_ROWS[name]
  if (!r) return undefined
  return { readOnlyHint: r.readOnlyHint, destructiveHint: r.destructiveHint, openWorldHint: r.openWorldHint }
}
