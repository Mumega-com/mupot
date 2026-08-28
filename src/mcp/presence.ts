// mupot — MCP presence tools (Module Kernel, Port 1: agents connect → select a
// project → heartbeat → project-scoped online roster). Design:
// docs/architecture/mupot-module-kernel.md. Twin of GET /api/presence
// (src/registry/presence-routes.ts) for non-MCP callers (e.g. the Hermes daemon).
// Shared storage: src/registry/service.ts.
//
// AUTHZ:
//   - presence_register / presence_heartbeat / presence_deregister act on the
//     CALLER'S OWN identity ONLY. Identity is ALWAYS derived server-side from auth
//     (auth.boundAgentId when the token is welded to an agent, else auth.memberId) —
//     NEVER from an args field. There is no "identity" arg on any of these tools, so
//     an attacker cannot even ATTEMPT to name another principal (schema-level, not
//     just a runtime check — additionalProperties:false rejects an extra field
//     before the handler runs).
//   - presence_register / presence_heartbeat ALSO bind that identity into a
//     project's roster when project_id is non-null — that is a WRITE into project-
//     scoped state, so it is gated through the SAME project-visibility primitive
//     presence_list's read path uses (readAccess + readableProject,
//     src/mcp/projects.ts): if the caller cannot read the target project, the write
//     is refused with the identical project_not_found shape presence_list returns
//     (no oracle — a caller can't distinguish "wrong project id" from "no access").
//     project_id: null (the no-project self bucket) is always open; it names no
//     project, so there is nothing to authorize against. presence_deregister is
//     exempt: its write can only ever transition an EXISTING (identity, project_id)
//     row it already owns to 'offline' — it can't create or rebind a registration
//     into a project, and it returns the same not_registered 404 whether the
//     project is inaccessible or the row never existed, so there's no new
//     disclosure to gate.
//   - presence_list is an org-scoped READ: any member may see the roster of a
//     project they can already read. Reuses the SAME project-visibility primitive
//     project_get uses (readAccess + readableProject, src/mcp/projects.ts) rather
//     than inventing a second authz path. Omitting project_id requires org:admin —
//     the unscoped "every registration in the tenant" view is a wider disclosure
//     than "this project's roster," so it fails closed to the org floor instead of
//     silently granting it to every observer.

// Flock 7-axis seat declaration (check_in / touchPresence) lives in
// src/fleet/presence.ts and the MCP check_in tool in src/mcp/index.ts.
// This file is the project-scoped MODULE roster (presence_register / heartbeat).
// Re-export the seat-axis contract so MCP clients and tests have one import.

export {
  SEVEN_AXIS_HARNESSES,
  SEVEN_AXIS_EFFORTS,
  normalizeHarness,
  normalizeEffort,
  normalizeSevenAxis,
  type SevenAxisHarness,
  type SevenAxisEffort,
  type SevenAxisDeclaration,
} from '../fleet/presence'

import type { AuthContext } from '../types'
import {
  registerModule,
  heartbeatModule,
  deregisterModule,
  listPresence,
  getModule,
  isModuleKind,
  isActivityState,
  ACTIVITY_STATES,
  type ModuleKind,
  type ActivityReport,
} from '../registry/service'
import { publishRosterPush } from '../registry/realtime'
import { readAccess, readableProject } from './projects'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const MODULE_KIND_ENUM = ['agent_system', 'workflow', 'surface']

// The caller's own identity, server-derived — never taken from args (see file
// docstring). A welded agent-scoped token IS that agent; a plain member/operator
// token registers as itself. Mirrors memberActor()/resolveTaskAssignee's own-identity
// convention (src/mcp/index.ts) applied to the registry.
function callerIdentity(auth: AuthContext): string | null {
  return auth.boundAgentId ?? auth.memberId ?? null
}

function readProjectId(args: Record<string, unknown>): string | null | undefined {
  if (args.project_id === undefined) return undefined
  if (args.project_id === null) return null
  return str(args.project_id) ?? undefined
}

const toolPresenceRegister: ToolSpec = {
  name: 'presence_register',
  scope: 'self (register/re-register this module in the project-scoped roster)',
  min: 'authenticated',
  args: '{ adapter: string, project_id?: string|null, kind?: "agent_system"|"workflow"|"surface", capabilities?: string[], model?: string|null, session_epoch?: number, lease_ttl_sec?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      adapter: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      kind: { type: 'string', enum: MODULE_KIND_ENUM },
      capabilities: OPTIONAL_STRING_ARRAY_SCHEMA,
      model: NULLABLE_STRING_SCHEMA,
      session_epoch: { type: 'number', description: 'Monotonic per-session registration epoch (Issue #1031).' },
      lease_ttl_sec: { type: 'number', description: 'Lease TTL window in seconds (Issue #1031).' },
    },
    required: ['adapter'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'presence_register requires a member-token principal')

    const adapter = str(args.adapter)
    if (!adapter) return fail(400, 'invalid_args', 'adapter required')

    const kindRaw = args.kind === undefined ? 'agent_system' : args.kind
    if (!isModuleKind(kindRaw)) return fail(400, 'invalid_kind', { accepted: MODULE_KIND_ENUM })
    const kind: ModuleKind = kindRaw

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }

    // P1 fix: a non-null project_id binds this registration (and attacker-chosen
    // capabilities) into that project's roster — gate it through the SAME
    // primitive presence_list's read path uses. Fail closed with the identical
    // project_not_found shape (no existence oracle). project_id: null names no
    // project, so it stays open (see file docstring).
    if (typeof projectId === 'string') {
      const access = readAccess(auth)
      const project = await readableProject(env, projectId, access)
      if (!project) return fail(404, 'project_not_found')
    }

    let capabilities: string[] | undefined
    if (args.capabilities !== undefined) {
      if (!Array.isArray(args.capabilities) || !args.capabilities.every((v) => typeof v === 'string')) {
        return fail(400, 'invalid_args', 'capabilities must be a string[]')
      }
      capabilities = args.capabilities
    }

    const model = typeof args.model === 'string' ? args.model : null
    const sessionEpoch = typeof args.session_epoch === 'number' && Number.isInteger(args.session_epoch) && args.session_epoch > 0 ? args.session_epoch : null
    const leaseTtlSec = typeof args.lease_ttl_sec === 'number' && Number.isInteger(args.lease_ttl_sec) && args.lease_ttl_sec > 0 ? args.lease_ttl_sec : null

    const result = await registerModule(env, {
      identity,
      kind,
      adapter,
      projectId: projectId ?? null,
      capabilities,
      model,
      sessionEpoch,
      leaseTtlSec,
    })
    if (!result.ok) return fail(400, result.error)
    await publishRosterPush(env, projectId ?? null, new Date())
    return done({ module: result.value })
  },
}


const toolPresenceHeartbeat: ToolSpec = {
  name: 'presence_heartbeat',
  scope: 'self (keep this module\'s registration online, and optionally report what it is doing)',
  min: 'authenticated',
  args: '{ project_id?: string|null, state?: "working"|"idle"|"blocked"|"done", message?: string|null, seq?: number, session_epoch?: number, lease_ttl_sec?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: NULLABLE_STRING_SCHEMA,
      // mupot#1117 — the activity report rides the HEARTBEAT rather than getting its
      // own tool. One call, one round trip, and it becomes structurally impossible to
      // report activity for a seat that is not simultaneously announcing reachability.
      // Both facts describe the same seat at the same instant; a separate tool would
      // let them drift apart, which is the exact failure this surface exists to stop.
      state: { type: 'string', enum: [...ACTIVITY_STATES] },
      message: NULLABLE_STRING_SCHEMA,
      seq: { type: 'number' },
      session_epoch: { type: 'number', description: 'Monotonic per-session registration epoch (Issue #1031).' },
      lease_ttl_sec: { type: 'number', description: 'Lease TTL window in seconds (Issue #1031).' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'presence_heartbeat requires a member-token principal')

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }

    // P1 fix (defense-in-depth): a heartbeat re-announcing into a non-null
    // project_id must not be able to re-bind into a project the caller can't
    // read — same gate as presence_register, same fail-closed shape.
    if (typeof projectId === 'string') {
      const access = readAccess(auth)
      const project = await readableProject(env, projectId, access)
      if (!project) return fail(404, 'project_not_found')
    }

    // An activity report is all-or-nothing: `state` REQUIRES `seq`, because without a
    // monotonic sequence two racing reports resolve by arrival order, and a late
    // 'working' would pin a finished seat as busy forever. Rejecting a report we cannot
    // order is better than accepting one — defaulting the seq would manufacture an
    // ordering that does not exist, which is worse than a 400.
    let report: ActivityReport | undefined
    if (args.state !== undefined) {
      if (!isActivityState(args.state)) return fail(400, 'invalid_state', { accepted: ACTIVITY_STATES })
      // seq MUST BE >= 1, and the off-by-one here was a real accepted-but-inert bug.
      //
      // Found by Athena (GPT-5.6 Luna) on the #1118 gate, who proved it with a throwaway
      // test rather than by reading: this accepted any NON-NEGATIVE integer including 0,
      // while migration 0108 initializes activity_seq to 0 and heartbeatModule guards with
      // `?7 > activity_seq`. So `0 > 0` is false and a seat's first report at seq 0 was
      // accepted by validation, returned ok, and SILENTLY DROPPED — activity stayed
      // 'unknown' forever while the caller had every reason to think it had reported.
      //
      // 0 is the NEVER-REPORTED SENTINEL, not a usable sequence value. Rejecting it here
      // is better than moving the sentinel to -1: the boundary is then visible to callers
      // as a 400 instead of silently doing nothing, and "seq starts at 1" is easier to get
      // right in a reporter than "seq must exceed a sentinel you cannot see".
      const seq = args.seq
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
        return fail(400, 'invalid_seq', 'state requires an integer seq >= 1 (monotonic per seat; 0 is the never-reported sentinel)')
      }
      let message: string | null = null
      if (args.message !== undefined && args.message !== null) {
        message = str(args.message) ?? null
        if (message === null) return fail(400, 'invalid_args', 'message must be a string')
      }
      report = { state: args.state, message, seq }
    } else if (args.seq !== undefined || args.message !== undefined) {
      return fail(400, 'invalid_args', 'seq/message are only meaningful alongside state')
    }

    const sessionEpoch = typeof args.session_epoch === 'number' && Number.isInteger(args.session_epoch) && args.session_epoch > 0 ? args.session_epoch : null
    const leaseTtlSec = typeof args.lease_ttl_sec === 'number' && Number.isInteger(args.lease_ttl_sec) && args.lease_ttl_sec > 0 ? args.lease_ttl_sec : null

    const ok = await heartbeatModule(env, identity, projectId ?? null, new Date(), report, { sessionEpoch, leaseTtlSec })
    if (!ok) return fail(404, 'not_registered', 'call presence_register first')
    await publishRosterPush(env, projectId ?? null, new Date())
    if (!report) return done({ ok: true })

    // Hand back the RESULTING row, not an acknowledgement. A stale-seq report is
    // dropped silently by design (see heartbeatModule), so a bare `{ok:true}` would
    // tell the caller its report landed when it did not — a receipt for something
    // that never happened. Returning what is actually stored lets the caller see for
    // itself whether its seq won.
    const module = await getModule(env, identity, projectId ?? null)
    return done({ ok: true, module })
  },
}

const toolPresenceDeregister: ToolSpec = {
  name: 'presence_deregister',
  scope: 'self (mark this module\'s registration offline)',
  min: 'authenticated',
  args: '{ project_id?: string|null }',
  inputSchema: {
    type: 'object',
    properties: { project_id: NULLABLE_STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'presence_deregister requires a member-token principal')

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }

    const ok = await deregisterModule(env, identity, projectId ?? null)
    if (!ok) return fail(404, 'not_registered')
    await publishRosterPush(env, projectId ?? null, new Date())
    return done({ ok: true })
  },
}

const toolPresenceList: ToolSpec = {
  name: 'presence_list',
  scope: 'project roster (any member who can read the project) — omit project_id for the org-admin tenant-wide view',
  min: 'observer',
  args: '{ project_id?: string|null }',
  inputSchema: {
    type: 'object',
    properties: { project_id: NULLABLE_STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (args.project_id === undefined) {
      // Unscoped roster — every registration this tenant has, across every project.
      // Wider disclosure than a single project's roster, so it requires the org
      // floor rather than being open to any observer.
      if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
      const modules = await listPresence(env, {})
      return done({ modules })
    }

    const projectId = args.project_id === null ? null : str(args.project_id)
    if (args.project_id !== null && !projectId) return fail(400, 'invalid_project_id')

    if (projectId !== null) {
      const access = readAccess(auth)
      const project = await readableProject(env, projectId, access)
      if (!project) return fail(404, 'project_not_found')
    } else if (!hasWorkspaceAdmin(auth)) {
      // project_id explicitly null = "modules with no project selected." Same
      // wider-disclosure reasoning as the fully-omitted case: this is not scoped
      // to any project a squad has access to, so it requires org:admin too.
      return fail(403, 'forbidden', { need: 'org:admin' })
    }

    const modules = await listPresence(env, { projectId })
    return done({ modules })
  },
}

export const PRESENCE_TOOLS: ToolSpec[] = [
  toolPresenceRegister,
  toolPresenceHeartbeat,
  toolPresenceDeregister,
  toolPresenceList,
]
