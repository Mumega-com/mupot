// src/mcp/openapi-public-allowlist.ts — the single, committed source of truth for which
// tools appear in the UNAUTHENTICATED `GET /openapi.json` (mupot#1596).
//
// WHY THIS EXISTS
//
// `openApiSpec()` (src/mcp/index.ts) used to walk the entire `TOOLS` registry — all 144
// tools, no filter — and serve it at `GET /openapi.json` with no auth at all (it was built
// for the Custom GPT Actions facade, which needs unauthenticated discovery). Every tool
// still enforces its own server-side authz (spec.min, checked centrally in invokeTool before
// run() is ever entered — see mupot#1288's ELEVATION_FLOOR_BYPASS_TOOLS discovery), so this
// was disclosure, not an access break: but the disclosed set included the entire admin
// surface by name and input schema — mint_agent_token ("minimum capability: admin"),
// grant_agent_capability, revoke_agent_token, revoke_agent_session, archive_row,
// unarchive_row, addon_archive, and more. That is a map an attacker did not have to earn.
//
// THE DESIGN: EXPLICIT ALLOWLIST, NOT A DENYLIST
//
// A denylist ("hide these specific tools") means a newly added admin tool is public BY
// DEFAULT the moment it's registered in TOOLS — silent, and easy to miss in review since
// nothing about adding a tool to TOOLS looks like a disclosure decision. An allowlist means
// a new tool of ANY capability tier is private by default; making it public is a deliberate,
// reviewable, one-line addition here.
//
// HOW THIS LIST WAS DERIVED (2026-09-28, against origin/main 5f13fb57)
//
// docs/connect-mcp-client.md's own description of the Custom GPT / OpenAPI Actions facade
// ("the same tools are exposed as REST") does not name a narrower subset than "every tool a
// member-scoped bearer token can actually invoke" — there is no separate manifest recording
// which specific tools a Custom GPT config calls. So the allowlist below is every tool whose
// `min` is 'authenticated', 'observer', or 'member' (i.e. every tool a member-tier bearer
// token can actually reach past invokeTool's central AAGATE floor) — this is the largest set
// that changes nothing for an existing Custom GPT Actions consumer, while every 'lead'/
// 'admin'/'owner' tool (the entire disclosed admin surface named in mupot#1596) drops out.
// Adding a NEW tool at member-tier-or-below to this facade later is a conscious edit to this
// file, not an automatic inheritance from TOOLS.
//
// ENFORCEMENT (defense in depth, two independent layers)
//
//   1. Runtime (src/mcp/index.ts, publicToolSpecs()): TOOLS is filtered to
//      { name is in PUBLIC_TOOL_ALLOWLIST } AND { min is 'authenticated'|'observer'|'member' }.
//      Both conditions must hold — an allowlist typo that names an admin tool is STILL
//      excluded by the min check; a tool whose min was RAISED after being allowlisted is
//      STILL excluded by the same check, without needing this file edited on that PR.
//   2. CI ratchet (scripts/check-openapi-public-allowlist.mjs): fails the build if any name
//      in this file no longer resolves to a real ToolSpec, if any name in this file has a
//      `min` above 'member', or if the GET /openapi.json route handler stops calling
//      publicOpenApiSpec() (the only sanctioned way to reach the full TOOLS registry from an
//      unauthenticated route).
//
// Keep this list SORTED — a diff that isn't a clean one-line insertion is a signal to look
// twice at what else changed.
export const PUBLIC_TOOL_ALLOWLIST: readonly string[] = [
  'advance_node',
  'athena_review_pr',
  'boot_context',
  'bootstrap_self',
  'broadcast',
  'check_in',
  'connect',
  'cursor_dispatch',
  'cursor_run_status',
  'elevation_status',
  'end_agent_session',
  'execution_meter_status',
  'execution_receipt_get',
  'fleet_agent_get',
  'flight_cancel',
  'flight_dispatch',
  'flight_get',
  'flight_land',
  'flight_list',
  'flight_reap_stalled',
  'get_agent_profile',
  'get_circuit_state',
  'inbox',
  'inbox_ack',
  'inbox_consumer_status',
  'inbox_dead_letters',
  'inbox_lease',
  'inbox_lease_ack',
  'inbox_lease_reconcile',
  'kanban_board',
  'message_get',
  'needs_you_list',
  'objective_accept',
  'objective_get',
  'office.health',
  'office.list_pending_approvals',
  'office.publish_post',
  'office.review_approval',
  'orient',
  'peers',
  'presence_deregister',
  'presence_heartbeat',
  'presence_list',
  'presence_register',
  'project_access_reintake_authorize',
  'project_context',
  'project_get',
  'project_list',
  'project_memory_get',
  'project_recall',
  'project_remember',
  'project_squad_list',
  'project_wiki',
  'recall',
  'remember',
  'report_run_usage',
  'request_elevation',
  'resolve_agent',
  'reveal_credential_claim',
  'router_tick',
  'routine_get',
  'routine_list',
  'routine_proposal_submit',
  'routine_run_answer',
  'routine_run_get',
  'routine_run_list',
  'routine_run_now',
  'runner_list',
  'runner_record',
  'runtime_seat_register_pending',
  'secret_env_request',
  'secret_env_status',
  'send',
  'squad_member_list',
  'squad_message',
  'squad_recall',
  'squad_remember',
  'status',
  'supabase_connect',
  'supabase_mutate',
  'supabase_query',
  'supabase_schema',
  'task_board',
  'task_create',
  'task_dispatch',
  'task_dispatch_runtime_receipt',
  'task_get',
  'task_intake_audit',
  'task_list',
  'task_update',
  'task_verdict',
  'task_verdict_reverse',
  'token_binding_attest',
  'update_agent',
  'verify_agent_connection',
]
