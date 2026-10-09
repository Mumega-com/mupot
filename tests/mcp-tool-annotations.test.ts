// tests/mcp-tool-annotations.test.ts — truthful MCP annotations on every tool (mupot#1709).
//
// Annotations are HINTS ONLY (authorization is unchanged) and MUST MATCH ACTUAL SIDE EFFECTS
// (Athena design-gate condition b85b87e4). This pins: completeness against the live registry,
// presence in the real tools/list body, a hand-picked list of tools whose handlers were read and
// are known to write / destroy / reach out (so a future edit cannot quietly relabel them), and
// consistency with the curated needs-you profile.
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { TOOLS } from '../src/mcp'
import { NEEDS_YOU_PROFILE } from '../src/mcp/profile-needs-you'
import { TOOL_ANNOTATION_ROWS, toolAnnotations } from '../src/mcp/tool-annotations'
import type { Env } from '../src/types'
import { mcpRequest } from './helpers/mcp-call'

const harnesses: SqliteD1Harness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close()
})

function makeEnv(): Env {
  const harness = createSqliteD1()
  harnesses.push(harness)
  applyAllMigrations(harness.sqlite)
  return { TENANT_SLUG: 'mumega', BRAND: 'Mumega', OAUTH_PROVIDER: 'google', DB: harness.db } as unknown as Env
}

describe('every registered tool carries annotations', () => {
  it('has a row with all three booleans and an evidence line for every TOOLS entry', () => {
    for (const t of TOOLS) {
      const r = TOOL_ANNOTATION_ROWS[t.name]
      expect(r, `${t.name} has no annotation row in src/mcp/tool-annotations.ts`).toBeDefined()
      expect(typeof r?.readOnlyHint, t.name).toBe('boolean')
      expect(typeof r?.destructiveHint, t.name).toBe('boolean')
      expect(typeof r?.openWorldHint, t.name).toBe('boolean')
      expect((r?.evidence ?? '').length, `${t.name} needs an evidence line`).toBeGreaterThan(10)
    }
  })

  it('has no row for a tool that is not registered (stale rows rot the table)', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const name of Object.keys(TOOL_ANNOTATION_ROWS)) expect(names.has(name), `row for unregistered tool ${name}`).toBe(true)
  })

  it('a readOnly tool is never destructive', () => {
    for (const [name, r] of Object.entries(TOOL_ANNOTATION_ROWS)) {
      if (r.readOnlyHint) expect(r.destructiveHint, name).toBe(false)
    }
  })

  it('prototype-member names resolve to nothing', () => {
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(toolAnnotations(n), n).toBeUndefined()
  })
})

describe('the full /mcp tools/list response includes them', () => {
  it('every listed tool has annotations equal to the table', async () => {
    const res = await mcpRequest(
      'https://pot.example/',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) },
      makeEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> } }
    // SEAT_AUTO_ENROLL is unset here: flag-gated seat_select (mupot#1794) is not advertised.
    expect(body.result.tools.length).toBe(TOOLS.filter((t) => t.name !== 'seat_select').length)
    for (const t of body.result.tools) {
      expect(t.annotations, t.name).toEqual(toolAnnotations(t.name))
      expect(Object.keys(t.annotations ?? {}).sort(), t.name).toEqual(['destructiveHint', 'openWorldHint', 'readOnlyHint'])
    }
  })
})

describe('guard: tools that write are never readOnly; tools that destroy are destructive', () => {
  // Each name was classified by reading its handler (evidence strings in the table).
  const KNOWN_WRITERS = [
    'boot_context', 'orient', 'connect', 'inbox', 'inbox_ack', 'inbox_lease', 'inbox_lease_ack', 'inbox_lease_reconcile',
    'send', 'broadcast', 'squad_message', 'wake_agent', 'task_create', 'task_list', 'task_update', 'task_verdict',
    'task_verdict_reverse', 'task_dispatch', 'task_submit_result', 'remember', 'squad_remember', 'project_remember',
    'presence_register', 'presence_heartbeat', 'presence_deregister', 'check_in', 'mint_agent_token', 'revoke_agent_token',
    'archive_row', 'unarchive_row', 'flight_dispatch', 'flight_land', 'office.health', 'office.publish_post',
    'secret_env_request', 'supabase_mutate', 'create_agent', 'deactivate_agent', 'routine_create', 'routine_run_now',
    'request_elevation', 'grant_gate_capability', 'cursor_dispatch', 'pot_provision',
  ]
  it.each(KNOWN_WRITERS)('%s is not readOnly', (name) => {
    expect(TOOL_ANNOTATION_ROWS[name]?.readOnlyHint, name).toBe(false)
  })

  const KNOWN_DESTRUCTIVE = [
    'revoke_agent_token', 'revoke_agent_session', 'archive_row', 'deactivate_agent', 'routine_archive', 'task_verdict',
    'task_verdict_reverse', 'pot_release', 'revoke_gate_capability', 'task_update', 'update_agent', 'move_agent_squad',
    'squad_member_remove', 'project_squad_remove', 'end_agent_session', 'reveal_credential_claim', 'secret_env_request',
    'addon_disable', 'addon_archive', 'supabase_mutate', 'office.publish_post', 'task_dispatch_lease_reset',
    'set_agent_inbox_consumer', 'team_bootstrap_release', 'loop_set_status', 'routine_run_cancel', 'register_agent_key',
  ]
  it.each(KNOWN_DESTRUCTIVE)('%s is destructive', (name) => {
    expect(TOOL_ANNOTATION_ROWS[name]?.destructiveHint, name).toBe(true)
  })

  const KNOWN_EXTERNAL = [
    'task_create', 'task_update', 'task_submit_result', 'project_wiki', 'office.publish_post', 'office.health', 'cursor_dispatch',
    'cursor_run_status', 'pot_provision', 'pot_list', 'supabase_connect', 'supabase_schema', 'supabase_query', 'supabase_mutate',
    'agent_lifecycle', 'addon_setup', 'wake_agent',
  ]
  it.each(KNOWN_EXTERNAL)('%s is openWorld', (name) => {
    expect(TOOL_ANNOTATION_ROWS[name]?.openWorldHint, name).toBe(true)
  })

  // The converse pin: tools verified pure-read stay readOnly AND closed-world, so the hints stay useful
  // (a table where everything is false is "truthful" and worthless).
  const KNOWN_PURE_READS = [
    'recall', 'squad_recall', 'project_recall', 'task_get', 'task_board', 'kanban_board', 'task_intake_audit', 'flight_get',
    'message_get', 'peers', 'status', 'fleet_agent_get', 'needs_you_list', 'project_list', 'project_get', 'project_context',
    'list_agent_tokens', 'list_agent_sessions', 'get_agent_profile', 'presence_list', 'routine_list', 'routine_get',
    'routine_run_list', 'routine_run_get', 'get_circuit_state', 'athena_review_pr', 'archive_plan_expand', 'elevation_status',
  ]
  it.each(KNOWN_PURE_READS)('%s is readOnly and closed-world', (name) => {
    expect(TOOL_ANNOTATION_ROWS[name]?.readOnlyHint, name).toBe(true)
    expect(TOOL_ANNOTATION_ROWS[name]?.openWorldHint, name).toBe(false)
  })
})

// mupot#1718 Athena P1-2: pin the WHOLE table, not hand-picked samples. Any relabel of any tool, in
// any direction, must change this list in the same diff (a reviewer then sees it). Lists generated
// from the classified table and reviewed row by row against the evidence strings.
describe('full-table pin: every readOnly / destructive / openWorld label is explicit', () => {
  const ALL_READ_ONLY = [
    'archive_plan_expand', 'athena_review_pr', 'cursor_run_status', 'elevation_status',
    'execution_meter_status', 'execution_receipt_get', 'fleet_agent_get', 'flight_get', 'flight_list',
    'get_agent_profile', 'get_circuit_state', 'grant_list_gate_capabilities', 'harness_capacity_list', 'inbox_consumer_status',
    'inbox_dead_letters', 'kanban_board', 'list_agent_sessions', 'list_agent_tokens', 'loop_list',
    'message_get', 'needs_you_list', 'objective_get', 'office.list_pending_approvals', 'peers', 'pot_list',
    'presence_list', 'project_context', 'project_get', 'project_list', 'project_memory_get', 'project_recall', 'project_squad_list',
    'project_wiki', 'recall', 'resolve_agent', 'routine_get', 'routine_list', 'routine_run_get',
    'routine_run_list', 'runner_list', 'secret_env_status', 'squad_member_list', 'squad_recall', 'status',
    'supabase_query', 'supabase_schema', 'task_board', 'task_get', 'task_intake_audit',
  ]
  const ALL_DESTRUCTIVE = [
    'addon_archive', 'addon_configure', 'addon_disable', 'addon_setup', 'advance_node', 'agent_lifecycle',
    'approve_gate_edge', 'archive_row', 'deactivate_agent', 'end_agent_session', 'flight_cancel', 'flight_land',
    'flight_reap_stalled', 'grant_agent_capability', 'harness_capacity_report', 'loop_control', 'loop_set_status', 'mint_agent_token',
    'move_agent_squad', 'office.publish_post', 'office.reconcile_stalled_publish', 'office.review_approval',
    'pot_release', 'presence_deregister', 'project_recommit', 'project_squad_remove', 'project_squad_set',
    'project_update', 'register_agent_key', 'reveal_credential_claim', 'revoke_agent_session',
    'revoke_agent_token', 'revoke_gate_capability', 'router_tick', 'routine_archive', 'routine_run_cancel',
    'routine_update', 'runner_record', 'secret_env_request', 'set_agent_inbox_consumer',
    'squad_member_remove', 'supabase_mutate', 'task_dispatch_lease_reset', 'task_dispatch_runtime_receipt',
    'task_submit_result', 'task_update', 'task_verdict', 'task_verdict_reverse', 'team_bootstrap_release',
    'update_agent', 'update_squad',
  ]
  const ALL_OPEN_WORLD = [
    'addon_setup', 'agent_lifecycle', 'cursor_dispatch', 'cursor_run_status', 'office.health',
    'office.publish_post', 'office.reconcile_stalled_publish', 'pot_list', 'pot_provision', 'project_wiki',
    'supabase_connect', 'supabase_mutate', 'supabase_query', 'supabase_schema', 'task_create',
    'task_submit_result', 'task_update', 'wake_agent',
  ]
  const names = Object.keys(TOOL_ANNOTATION_ROWS)
  const pick = (k: 'readOnlyHint' | 'destructiveHint' | 'openWorldHint') =>
    names.filter((n) => TOOL_ANNOTATION_ROWS[n][k]).sort()

  it('the readOnly set is exactly the pinned list', () => expect(pick('readOnlyHint')).toEqual([...ALL_READ_ONLY].sort()))
  it('the destructive set is exactly the pinned list', () => expect(pick('destructiveHint')).toEqual([...ALL_DESTRUCTIVE].sort()))
  it('the openWorld set is exactly the pinned list', () => expect(pick('openWorldHint')).toEqual([...ALL_OPEN_WORLD].sort()))
  it('readOnly and destructive never overlap', () => {
    for (const n of ALL_READ_ONLY) expect(ALL_DESTRUCTIVE, n).not.toContain(n)
  })
})

describe('needs-you profile stays consistent with the full table', () => {
  // The profile runs with ToolCtx.sideEffectFree (index.ts: profile === 'needs-you'), under which these
  // three skip their own writes (task_list: touchPollFleetPresence index.ts:1236; boot_context: presence
  // touch + selfReport index.ts:5815,5850; orient: recordInduction index.ts:6045), and
  // tests/mcp-profile-needs-you-no-side-effects.test.ts snapshots every table to prove it. On the FULL
  // surface the same tools write, so the full table says readOnly:false. That is the ONLY readOnly gap.
  const SIDE_EFFECT_FREE_ONLY = new Set(['boot_context', 'orient', 'task_list'])
  // project_wiki GETs the Inkwell wiki service, so the full table says openWorld:true. The profile's
  // CI gate (scripts/check-mcp-profile-needs-you.mjs) pins openWorldHint:false for every profile tool;
  // tracked as a follow-up rather than silently loosening that gate here.
  const KNOWN_PROFILE_OPENWORLD_GAP = new Set(['project_wiki'])

  it('every profile tool is in the full table, and differs only in the documented ways', () => {
    for (const e of NEEDS_YOU_PROFILE) {
      const full = toolAnnotations(e.name)
      expect(full, e.name).toBeDefined()
      expect(e.annotations.destructiveHint, e.name).toBe(full?.destructiveHint)
      if (SIDE_EFFECT_FREE_ONLY.has(e.name)) {
        expect(full?.readOnlyHint, `${e.name} full surface writes`).toBe(false)
      } else {
        expect(e.annotations.readOnlyHint, e.name).toBe(full?.readOnlyHint)
      }
      if (KNOWN_PROFILE_OPENWORLD_GAP.has(e.name)) {
        expect(full?.openWorldHint, e.name).toBe(true)
        expect(e.annotations.openWorldHint, e.name).toBe(false)
      } else {
        expect(e.annotations.openWorldHint, e.name).toBe(full?.openWorldHint)
      }
    }
  })

  it('the documented-difference sets name only tools that are actually in the profile', () => {
    const inProfile = new Set(NEEDS_YOU_PROFILE.map((e) => e.name))
    for (const n of [...SIDE_EFFECT_FREE_ONLY, ...KNOWN_PROFILE_OPENWORLD_GAP]) expect(inProfile.has(n), n).toBe(true)
  })
})
