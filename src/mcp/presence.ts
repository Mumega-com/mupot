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
//   - presence_list is an org-scoped READ: any member may see the roster of a
//     project they can already read. Reuses the SAME project-visibility primitive
//     project_get uses (readAccess + readableProject, src/mcp/projects.ts) rather
//     than inventing a second authz path. Omitting project_id requires org:admin —
//     the unscoped "every registration in the tenant" view is a wider disclosure
//     than "this project's roster," so it fails closed to the org floor instead of
//     silently granting it to every observer.

import type { AuthContext } from '../types'
import {
  registerModule,
  heartbeatModule,
  deregisterModule,
  listPresence,
  isModuleKind,
  type ModuleKind,
} from '../registry/service'
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
  args: '{ adapter: string, project_id?: string|null, kind?: "agent_system"|"workflow"|"surface", capabilities?: string[] }',
  inputSchema: {
    type: 'object',
    properties: {
      adapter: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      kind: { type: 'string', enum: MODULE_KIND_ENUM },
      capabilities: OPTIONAL_STRING_ARRAY_SCHEMA,
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

    let capabilities: string[] | undefined
    if (args.capabilities !== undefined) {
      if (!Array.isArray(args.capabilities) || !args.capabilities.every((v) => typeof v === 'string')) {
        return fail(400, 'invalid_args', 'capabilities must be a string[]')
      }
      capabilities = args.capabilities
    }

    const result = await registerModule(env, {
      identity,
      kind,
      adapter,
      projectId: projectId ?? null,
      capabilities,
    })
    if (!result.ok) return fail(400, result.error)
    return done({ module: result.value })
  },
}

const toolPresenceHeartbeat: ToolSpec = {
  name: 'presence_heartbeat',
  scope: 'self (keep this module\'s registration online)',
  min: 'authenticated',
  args: '{ project_id?: string|null }',
  inputSchema: {
    type: 'object',
    properties: { project_id: NULLABLE_STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = callerIdentity(auth)
    if (!identity) return fail(403, 'not_member_bound', 'presence_heartbeat requires a member-token principal')

    const projectId = readProjectId(args)
    if (args.project_id !== undefined && args.project_id !== null && projectId === undefined) {
      return fail(400, 'invalid_project_id')
    }

    const ok = await heartbeatModule(env, identity, projectId ?? null)
    if (!ok) return fail(404, 'not_registered', 'call presence_register first')
    return done({ ok: true })
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
