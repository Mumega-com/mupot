// tests/boundary/sweep.test.ts — the registry sweep: EVERY MCP tool, called by a caller with no standing on
// customer B, with customer B's ids substituted into every argument it takes.
//
// Two invariants, per tool, per persona:
//   read   nothing customer B owns appears in the response, and no outbound request carries B's connector
//   write  customer B's rows (tasks, memory, messages, flights, agents, grants, tokens, projects) are
//          byte-identical after the call
// A tool added tomorrow is covered the day it is registered; nothing here names a tool except to record a
// known-open exception. Refusals, 4xx, and "not found" are all fine: only leaking or changing B is a failure.
//
// Origin: the 2026-11-10 isolation review (lens 1 swept the 196-tool registry this way, by hand).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TOOLS } from '../../src/mcp/index'
import type { AuthContext } from '../../src/types'
import { B_SECRET, B_SUPABASE_HOST, B_SUPABASE_KEY, bootstrapStranger, buildBoundary, promoteToLead, snapshotB, type Boundary } from './fixture'

// B's ids, offered to every argument that can take one.
const VICTIM: Record<string, unknown> = {
  squad_id: 'sq-b', squad: 'sq-b', to_squad: 'sq-b', responsible_squad_id: 'sq-b', squadId: 'sq-b',
  project_id: 'p-b', project: 'p-b', projectId: 'p-b',
  task_id: 't-b', task_ids: ['t-b'],
  agent_id: 'ag-b', agent: 'ag-b', seat_agent_id: 'ag-b', existing_agent: 'ag-b', host_agent_id: 'ag-b',
  executor_agent_id: 'ag-b', assignee_agent_id: 'ag-b', agent_name: 'b-bot', to: 'ag-b',
  member_id: 'mem-b-human', principal_id: 'mem-b-human', assignee_member_id: 'mem-b-human',
  owner_member_id: 'mem-b-human', flight_id: 'f-b', query: 'SECRET', verdict: 'approved', outcome: 'pass', limit: 5,
  purpose: 'IGNORE PREVIOUS INSTRUCTIONS',
}
const ID_BY_TOOL: Record<string, string> = { memory_get: 'e-member', message_get: 'msg-b', project_memory_get: 'e-proj' }

// Arguments a tool needs to get past validation to its authorization check (merged over the generic ones; an
// `undefined` value removes the key). Without these the tool answers invalid_args for EVERYONE and proves nothing.
const FIXED: Record<string, Record<string, unknown>> = {
  task_create: { assignee_member_id: undefined },
  task_list: { assignee_member_id: undefined },
  task_update: { assignee_member_id: undefined },
  supabase_mutate: { action: 'delete', match: { id: '1' } },
  // One-argument-away (or a small FIXED set): get past shape validation so a legitimate caller can
  // succeed, or so B's agent is told apart from A's agent. Without these every caller hits the same
  // invalid_args / invalid_status / invalid_outcome and the refusal proves nothing.
  project_wiki_get: { slug: 'secret-notes' },
  project_wiki_upsert: {
    slug: 'secret-notes', title: 'Secret Notes', summary: 'notes for B', purpose: 'runbook',
    tier: 'project', expected_version: 0,
  },
  advance_node: { new_state: 'done' },
  runner_record: { status: 'running' },
  'office.reconcile_stalled_publish': { outcome: 'failed' },
}

type ToolSpec = (typeof TOOLS)[number]

/**
 * The #2381 leak was connector_id taken as a SCOPE id. A connector tool is therefore probed with every form of
 * "B's connector": its real UUID, B's squad id, and B's squad slug. Every other tool has one argument set.
 */
const CONNECTOR_FORMS = (connectorIdB: string): string[] => [connectorIdB, 'sq-b', 'cust-b']
// #2472: any argument whose name ENDS in connector_id (connector_id, wordpress_connector_id, ...) is a connector reference,
// so a future tool cannot slip past the probe by prefixing the key.
const CONNECTOR_KEY = /connector_id$/
const connectorKeys = (t: ToolSpec): string[] => Object.keys(t.inputSchema.properties as Record<string, unknown>).filter((k) => CONNECTOR_KEY.test(k))
const takesConnector = (t: ToolSpec): boolean => connectorKeys(t).length > 0
/** Tools whose connector argument is an org-admin-only bind (not a supabase-style squad lookup): a non-admin persona is
 *  refused at the admin floor (or as an agent principal) BEFORE the connector is looked at, so the persona's
 *  supabase_connector_not_found is not the expected answer. The supabase tools keep the strict persona code. */
const ADMIN_FLOOR_CONNECTOR_CODES: Record<string, string[]> = {
  'office.bind_project_site': ['forbidden', 'operator_principal_required'],
}

function argsFor(t: ToolSpec, connectorIdB: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = t.inputSchema.properties as Record<string, { type?: unknown }>
  const req = new Set(t.inputSchema.required ?? [])
  for (const [k, p] of Object.entries(props)) {
    if (k === 'seat') continue
    if (k === 'id') { out.id = ID_BY_TOOL[t.name] ?? 'x'; continue }
    if (CONNECTOR_KEY.test(k)) { out[k] = connectorIdB; continue }
    if (k in VICTIM) { out[k] = VICTIM[k]; continue }
    if (!req.has(k)) continue
    const ty = Array.isArray(p.type) ? p.type[0] : p.type
    out[k] = ty === 'number' || ty === 'integer' ? 1 : ty === 'boolean' ? false : ty === 'array' ? ['x'] : ty === 'object' ? {} : 'PROBE'
  }
  for (const [k, v] of Object.entries(FIXED[t.name] ?? {})) { if (v === undefined) delete out[k]; else out[k] = v }
  return out
}

const personas: Array<{ name: string; make: (b: Boundary) => Promise<AuthContext>; connectorCode: string }> = [
  { name: "customer A's agent (squad member)", make: (b) => b.attacker(), connectorCode: 'supabase_connector_not_found' },
  { name: "customer A's lead (squad lead)", make: async (b) => { promoteToLead(b, 'a'); return b.agent('ag-a', 'mem-a-agent') }, connectorCode: 'supabase_connector_not_found' },
  { name: "customer A's human (squad member, no agent)", make: (b) => b.human('mem-a-human'), connectorCode: 'supabase_connector_not_found' },
  { name: 'a member holding no grants at all', make: (b) => b.human('mem-zero'), connectorCode: 'forbidden' },
  { name: 'a stranger after bootstrap_self (the unbound session)', make: async (b) => (await bootstrapStranger(b)).member, connectorCode: 'supabase_connector_not_found' },
  { name: 'the agent a stranger minted through bootstrap_self', make: async (b) => (await bootstrapStranger(b)).agent, connectorCode: 'supabase_connector_not_found' },
]

let outbound: Array<{ url: string; headers: string }> = []
const realFetch = globalThis.fetch
/** While true the stubbed network answers 200, so a legitimate connector call can succeed. Otherwise it answers 503. */
let controlPhase = false

beforeAll(() => {
  vi.stubGlobal('fetch', async (u: unknown, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u)
    const headers = JSON.stringify([...new Headers(init?.headers ?? (u instanceof Request ? u.headers : undefined)).entries()])
    outbound.push({ url, headers })
    return controlPhase ? new Response('[]', { status: 200 }) : new Response('{}', { status: 503 })
  })
})
afterAll(() => { globalThis.fetch = realFetch })

// THE RULE (#2411): a tool counts as PROVEN only when a legitimate caller of B succeeds — B's own
// agent or B's member acting in B's scope. An org admin/owner success alone is not proof: those
// principals sit above every squad, so their OK says nothing about cross-customer isolation. A
// refusal that is identical for B's agent and A's agent (compared like-for-like: both raised to
// lead, because B's control is promoted) is VACUOUS even when an admin succeeds. Every tool that
// is not live must be named in UNPROVEN with the reason, or given arguments that work.
const controls: Array<(b: Boundary) => Promise<AuthContext>> = [
  async (b) => { promoteToLead(b, 'b'); return b.agent('ag-b', 'mem-b-agent') },
  async (b) => { promoteToLead(b, 'b'); return b.human('mem-b-human') },
]
// Like-for-like baseline: B's agent is a lead, so A's agent must be a lead too (#2411 / #2396).
const aLeadBaseline = async (b: Boundary): Promise<AuthContext> => {
  promoteToLead(b, 'a')
  return b.agent('ag-a', 'mem-a-agent')
}
interface Liveness { live: Set<string>; vacuous: Set<string> }
let liveMemo: Promise<Liveness> | undefined
const verdictOf = (o: { ok?: boolean; error?: string; status?: number }): string => (o.ok ? 'OK' : `${o.status} ${o.error}`)
function liveTools(): Promise<Liveness> {
  liveMemo ??= (async () => {
    const live = new Set<string>()
    // Only B's agent answers count toward "same refusal" — human/admin credential floors must not
    // make a tool look proven when A's lead and B's lead still hear the same words (#2396/#2411).
    const bAgentAnswer = new Map<string, string>()
    const aLeadAnswer = new Map<string, string>()
    controlPhase = true
    try {
      for (const make of [...controls, aLeadBaseline]) {
        const b = await buildBoundary()
        try {
          const auth = await make(b)
          const asALead = auth.boundAgentId === 'ag-a'
          const asBAgent = auth.boundAgentId === 'ag-b'
          const asBMember = !auth.boundAgentId && auth.memberId === 'mem-b-human'
          for (const spec of TOOLS) {
            let v: string
            try {
              const out = await b.call(auth, spec.name, argsFor(spec, b.connectorIdB))
              // Admin/owner are deliberately absent: only B's agent or B's member success proves.
              if (out.ok && (asBAgent || asBMember)) live.add(spec.name)
              v = verdictOf(out)
            } catch (e) { v = `threw ${String(e).slice(0, 40)}` }
            if (asALead) aLeadAnswer.set(spec.name, v)
            else if (asBAgent) bAgentAnswer.set(spec.name, v)
          }
        } finally { b.close() }
      }
    } finally { controlPhase = false }
    const vacuous = new Set<string>()
    for (const spec of TOOLS) {
      if (live.has(spec.name)) continue
      if (bAgentAnswer.get(spec.name) === aLeadAnswer.get(spec.name)) vacuous.add(spec.name)
    }
    return { live, vacuous }
  })()
  return liveMemo
}

/**
 * Tools no legitimate caller of this fixture can drive to success, each with the reason. The sweep still checks
 * that these show and change nothing of B's, but their refusal for the intruder is NOT evidence of isolation.
 * (A test below fails when an entry here turns out to be live, so the list cannot go stale.)
 */
const UNPROVEN: Record<string, string> = {
  ...group('feature flag off in the fixture: every caller gets the *_disabled / unavailable answer', [
    'connect_intent', 'credential_request', 'host_key_register', 'secure_drop_ack', 'secure_drop_pull', 'secure_drop_revoke',
    'owner_call', 'worktree_list', 'worktree_open', 'seed_attach_request', 'squad_join_request', 'moment_miniapp_link',
  ]),
  ...group('needs a session shape the fixture personas do not have (an unbound directory session or an attached seat)', [
    'bootstrap_self', 'seat_select', 'seat_attach', 'connection_check', 'inbox_mark_handled',
  ]),
  ...group('the fixture seeds no such object of B (routine, run, objective, receipt, circuit, claim): every caller gets not_found', [
    'routine_get', 'routine_run_now', 'routine_run_get', 'routine_run_answer', 'routine_proposal_observe', 'routine_proposal_submit',
    'report_run_usage', 'objective_get', 'execution_receipt_get', 'get_circuit_state', 'reveal_credential_claim',
  ]),
  ...group('arguments are shape-validated beyond what the generic builder produces, or need state the fixture lacks', [
    'cursor_run_status', 'secret_env_request', 'seed_attach', 'seed_draft', 'join_squad',
    'flight_reap_stalled', 'office.publish_post', 'office.review_approval', 'task_verdict_reverse',
    'task_dispatch_runtime_receipt', 'project_access_reintake_authorize',
  ]),
  ...group('FIXED args clear shape validation, but the circuits addon is inactive in the fixture: every caller gets addon_inactive', [
    'advance_node',
  ]),
  ...group('FIXED args clear shape validation, but B\'s task has no stalled office publish claim: every caller gets wrong_gate', [
    'office.reconcile_stalled_publish',
  ]),
  ...group('needs a live gate holder plus a current submission on B\'s task; proven by the paired probes in write.test.ts instead', [
    'task_verdict', 'task_review_lens',
  ]),
  // #2396: under the old rule these looked proven because a human or admin control got a different
  // credential/floor refusal than an agent. A's lead and B's lead still hear the same words — not
  // isolation proof. The twelve named in the issue come first; the rest are the same false-positive
  // class the stricter B-lead-vs-A-lead comparison exposes.
  ...group('B\'s lead and A\'s lead get the same refusal; agent-vs-human/admin answer differences are not proof (#2396)', [
    'cursor_dispatch', 'elevation_status', 'flight_land', 'harness_capacity_report', 'inbox_lease_ack',
    'inbox_lease_reconcile', 'message_get', 'operator_revoke', 'request_elevation', 'runtime_seat_register_pending',
    'token_binding_attest', 'verify_agent_connection',
    'addon_activate', 'addon_archive', 'addon_configure', 'addon_disable', 'addon_install', 'addon_setup',
    'agent_lifecycle', 'approval_resubmit_cap_reset', 'approve_gate_edge', 'archive_plan_expand', 'archive_row',
    'create_department', 'create_squad', 'define_circuit', 'execution_pause', 'execution_resume',
    'grant_agent_capability', 'grant_gate_capability', 'loop_set_status', 'move_agent_squad', 'office.health',
    'operator_delegate', 'pot_list', 'pot_provision', 'pot_release', 'project_create', 'project_deploy',
    'project_recommit', 'project_squad_set', 'provision_agent_connection', 'register_agent_key',
    'revoke_agent_token', 'revoke_gate_capability', 'routine_archive', 'routine_create', 'routine_enable',
    'routine_pause', 'routine_run_cancel', 'routine_update', 'set_agent_inbox_consumer',
    'task_dispatch_lease_reset', 'task_incident_revert', 'team_bootstrap', 'team_bootstrap_release',
    'unarchive_row', 'update_department', 'update_squad',
  ]),
  // #2411: admin/owner success alone used to count as PROVEN. B's lead and A's lead hear the same
  // refusal; the admin OK is above every squad and is not isolation proof.
  ...group('admin-floor only: B\'s lead and A\'s lead get the same refusal; org admin/owner success is not proof (#2411)', [
    'project_update', 'project_squad_remove', 'mint_agent_token', 'list_agent_tokens', 'list_agent_sessions',
    'revoke_agent_session', 'deactivate_agent', 'operator_list', 'approval_expiry_sweep', 'execution_release',
    'grant_list_gate_capabilities', 'loop_list',
    'office.bind_project_site', 'office.unbind_project_site',
  ]),
  // #2411: B was promoted to lead while A's baseline was a plain member — rank asymmetry made these
  // look non-vacuous. Compared lead-to-lead both hear the same words.
  ...group('rank-asymmetric false proof: B-lead vs A-member differed; B-lead vs A-lead match (#2411)', [
    'loop_control', 'seat_event_grant', 'squad_member_add', 'squad_member_remove',
  ]),
  // #2411: nobody on B succeeds; B's lead and A's lead get different refusals (so not vacuous), but
  // the sweep still cannot claim isolation proof. Honest UNPROVEN until FIXED/fixture can drive them.
  ...group('B\'s lead cannot succeed yet; refusal differs from A\'s lead so not vacuous — still not proof (#2411)', [
    'flight_dispatch', 'task_dispatch', 'task_submit_result', 'create_agent', 'update_agent',
    'set_agent_webhook_doorbell', 'project_wiki', 'project_wiki_get', 'project_wiki_upsert',
  ]),
}
function group(reason: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, reason]))
}

// One fixture per persona (a fresh fixture per tool made this the slowest file in the repo). Each tool is
// judged against the snapshot taken immediately before its own call, so one tool's writes cannot be blamed
// on the next.
describe.each(personas)('registry sweep as $name', (persona) => {
  let b: Boundary
  let auth: AuthContext
  let live: Liveness
  beforeAll(async () => {
    live = await liveTools()
    b = await buildBoundary()
    auth = await persona.make(b)
  }, 300_000)
  afterAll(() => b.close())

  it.each(TOOLS.map((t) => t.name))('%s neither shows nor changes customer B', async (toolName) => {
    const spec = TOOLS.find((t) => t.name === toolName)
    if (!spec) throw new Error(`tool ${toolName} vanished`)
    expect(live.live.has(spec.name) || spec.name in UNPROVEN,
      `${spec.name}: not PROVEN (no B agent/member success) and not listed in UNPROVEN. Every tool must be exactly one. Fix FIXED, or add it to UNPROVEN with the reason`).toBe(true)
    expect(!live.vacuous.has(spec.name) || spec.name in UNPROVEN,
      `${spec.name}: B's lead gets the same answer as customer A's lead (and no B agent/member succeeds), so this refusal proves nothing. Fix the arguments in FIXED, or list the tool in UNPROVEN with the reason`).toBe(true)
    const forms = takesConnector(spec) ? CONNECTOR_FORMS(b.connectorIdB) : [undefined]
    for (const form of forms) {
      outbound = []
      b.bus.length = 0
      const before = snapshotB(b)
      const args = argsFor(spec, b.connectorIdB)
      if (form !== undefined) for (const k of connectorKeys(spec)) args[k] = form
      let out: Awaited<ReturnType<Boundary['call']>> | { threw: string }
      try {
        out = await b.call(auth, spec.name, args)
      } catch (e) {
        out = { threw: String(e) }
      }
      const label = `${spec.name}${form === undefined ? '' : ` (connector_id=${form})`}`
      const shown = JSON.stringify(out) + JSON.stringify(b.bus)
      expect(shown, `${label} response`).not.toContain(B_SECRET)
      expect(JSON.stringify(outbound), `${label} outbound`).not.toContain(B_SUPABASE_HOST)
      expect(JSON.stringify(outbound), `${label} outbound`).not.toContain(B_SUPABASE_KEY)
      expect(snapshotB(b), `${label} changed customer B's rows`).toBe(before)
      // The connector tools are the #2381 surface: whatever form of "B's connector" is named, the answer is the same exact code
      // (a persona with no squad standing at all is refused one step earlier, by the member floor).
      if (form !== undefined) {
        const adminFloor = ADMIN_FLOOR_CONNECTOR_CODES[spec.name]
        const code = (out as { error?: string }).error
        if (adminFloor) expect(adminFloor, `${label}: ${JSON.stringify(out)}`).toContain(code)
        else expect(code, `${label}: ${JSON.stringify(out)}`).toBe(persona.connectorCode)
        expect(outbound, `${label}: nothing may be sent`).toEqual([])
      }
    }
  })
})

describe('the control list is honest', () => {
  it('every tool is exactly one of PROVEN or UNPROVEN; UNPROVEN entries stay undrivable', async () => {
    const { live, vacuous } = await liveTools()
    const known = TOOLS.map((t) => t.name)
    const unproven = new Set(Object.keys(UNPROVEN))
    // Stale = listed UNPROVEN but a B agent/member now succeeds → delete from UNPROVEN.
    const stale = [...unproven].filter((n) => live.has(n))
    expect(stale, 'these tools are now PROVEN (B agent/member succeeds): remove them from UNPROVEN').toEqual([])
    expect([...unproven].filter((n) => !known.includes(n)), 'UNPROVEN names a tool that no longer exists').toEqual([])
    // Full accounting: 197 tools, each in exactly one bucket (#2411). Vacuous tools that differ
    // from A only by rank/admin floor must still land in UNPROVEN; so must the "neither" set
    // (B and A refuse differently, but nobody on B succeeds).
    const neither = known.filter((n) => !live.has(n) && !unproven.has(n))
    expect(neither, 'these tools are in neither PROVEN nor UNPROVEN — add them to UNPROVEN with a reason').toEqual([])
    const both = known.filter((n) => live.has(n) && unproven.has(n))
    expect(both, 'these tools are in both PROVEN and UNPROVEN').toEqual([])
    expect(live.size + unproven.size, 'PROVEN + UNPROVEN must equal the registry').toBe(known.length)
    // Vacuous (same refusal as A's lead) is a subset of UNPROVEN — the honesty signal for #2396.
    const vacuousMissing = [...vacuous].filter((n) => !unproven.has(n))
    expect(vacuousMissing, 'vacuous tools (B-lead == A-lead refusal) must be listed in UNPROVEN').toEqual([])
    // Like-for-like guard (#2411): these looked non-vacuous only when B-lead was compared to A-member.
    // If the baseline regresses to A-member, they leave `vacuous` and this fails.
    for (const n of ['loop_control', 'seat_event_grant', 'squad_member_add', 'squad_member_remove']) {
      expect(vacuous.has(n), `${n}: B-lead vs A-lead must match (rank-asymmetric false proof)`).toBe(true)
    }
    // Admin-floor guard (#2411): these must not be live, and B-lead vs A-lead must match.
    for (const n of [
      'project_update', 'project_squad_remove', 'mint_agent_token', 'list_agent_tokens', 'list_agent_sessions',
      'revoke_agent_session', 'deactivate_agent', 'operator_list', 'approval_expiry_sweep', 'execution_release',
      'grant_list_gate_capabilities', 'loop_list',
      'office.bind_project_site', 'office.unbind_project_site',
    ]) {
      expect(live.has(n), `${n}: admin-floor success must not count as PROVEN`).toBe(false)
      expect(vacuous.has(n), `${n}: B-lead vs A-lead must match for admin-floor tools`).toBe(true)
    }
  }, 300_000)
})
