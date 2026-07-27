import type { AuthContext } from '../types'
import { readAccess, readableProject } from './projects'
import { done, fail, str, type ToolSpec } from './index'
import {
  RUNTIME_ENDPOINT_ACK_SCHEMA,
  RUNTIME_ENDPOINT_SCHEMA,
  acceptRuntimeEndpointMessage,
  checkInRuntimeEndpoint,
  getRuntimeEndpoint,
  getRuntimeEndpointWithCapability,
  heartbeatRuntimeEndpoint,
  listRuntimeEndpoints,
  readRuntimeEndpointInbox,
  revokeRuntimeEndpoint,
  sendRuntimeEndpointMessage,
  type RuntimeEndpoint,
  type RuntimeKind,
  type WakeAdapter,
} from '../runtime-endpoints/service'

const STRING = { type: 'string' }
const NUMBER = { type: 'number' }
const STRING_ARRAY = { type: 'array', items: { type: 'string' } }
const RUNTIME_KINDS = ['codex', 'claude_code', 'cursor', 'hermes', 'other']
const WAKE_ADAPTERS = ['codex_cli', 'codex_app_server', 'claude_cli', 'hermes', 'generic']
const MESSAGE_KINDS = ['message', 'request']

function identity(auth: AuthContext): { agentId: string; memberId: string } | null {
  return auth.boundAgentId && auth.memberId
    ? { agentId: auth.boundAgentId, memberId: auth.memberId }
    : null
}

async function projectVisible(auth: AuthContext, env: Parameters<ToolSpec['run']>[1], projectId: string) {
  return await readableProject(env, projectId, readAccess(auth))
}

function serviceFailure(error: string) {
  if (error === 'endpoint_not_found' || error === 'message_not_found') return fail(404, error)
  if (error === 'sender_not_allowed') return fail(403, error)
  if (error === 'endpoint_unavailable' || error === 'endpoint_revoked' || error === 'endpoint_binding_conflict' ||
      error === 'message_already_accepted' ||
      error === 'request_id_conflict' || error === 'endpoint_inbox_full') return fail(409, error)
  if (error === 'db_error' || error === 'check_in_failed') return fail(500, error)
  return fail(400, error)
}

const checkInTool: ToolSpec = {
  name: 'runtime_endpoint_check_in',
  scope: 'self (register or renew one exact host-local runtime session)',
  min: 'authenticated',
  args: '{ runtime_kind, runtime_session_handle, node_id, local_source_id, project_id, purpose, workspace, wake_adapter, allowed_senders, lease_seconds? }',
  inputSchema: {
    type: 'object',
    properties: {
      runtime_kind: { type: 'string', enum: RUNTIME_KINDS },
      runtime_session_handle: STRING,
      node_id: STRING,
      local_source_id: STRING,
      project_id: STRING,
      purpose: STRING,
      workspace: STRING,
      wake_adapter: { type: 'string', enum: WAKE_ADAPTERS },
      allowed_senders: STRING_ARRAY,
      lease_seconds: NUMBER,
    },
    required: [
      'runtime_kind',
      'runtime_session_handle',
      'node_id',
      'local_source_id',
      'project_id',
      'purpose',
      'workspace',
      'wake_adapter',
      'allowed_senders',
    ],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const caller = identity(auth)
    if (!caller) return fail(403, 'not_agent_bound')
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_project_id')
    if (!(await projectVisible(auth, env, projectId))) return fail(404, 'project_not_found')

    const result = await checkInRuntimeEndpoint(env, {
      agentId: caller.agentId,
      memberId: caller.memberId,
      runtimeKind: args.runtime_kind as RuntimeKind,
      runtimeSessionHandle: str(args.runtime_session_handle) ?? '',
      nodeId: str(args.node_id) ?? '',
      localSourceId: str(args.local_source_id) ?? '',
      projectId,
      purpose: str(args.purpose) ?? '',
      workspace: str(args.workspace) ?? '',
      wakeAdapter: args.wake_adapter as WakeAdapter,
      allowedSenders: Array.isArray(args.allowed_senders)
        ? args.allowed_senders.filter((value): value is string => typeof value === 'string')
        : [],
      leaseSeconds: typeof args.lease_seconds === 'number' ? args.lease_seconds : undefined,
    })
    if (!result.ok) return serviceFailure(result.error)
    return done({
      schema: RUNTIME_ENDPOINT_SCHEMA,
      endpoint: result.value.endpoint,
      endpoint_capability: result.value.endpointCapability,
    })
  },
}

const heartbeatTool: ToolSpec = {
  name: 'runtime_endpoint_heartbeat',
  scope: 'self (renew one unexpired runtime endpoint lease)',
  min: 'authenticated',
  args: '{ endpoint_id: string, endpoint_capability: string, lease_seconds?: number }',
  inputSchema: {
    type: 'object',
    properties: { endpoint_id: STRING, endpoint_capability: STRING, lease_seconds: NUMBER },
    required: ['endpoint_id', 'endpoint_capability'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const caller = identity(auth)
    if (!caller) return fail(403, 'not_agent_bound')
    const endpointId = str(args.endpoint_id)
    const endpointCapability = str(args.endpoint_capability)
    if (!endpointId || !endpointCapability) return fail(400, 'invalid_args')
    const owned = await ownedActiveEndpoint(auth, env, endpointId, endpointCapability)
    if (!owned.ok) return owned.error
    const result = await heartbeatRuntimeEndpoint(
      env,
      endpointId,
      caller.agentId,
      endpointCapability,
      typeof args.lease_seconds === 'number' ? args.lease_seconds : undefined,
    )
    if (!result.ok) return serviceFailure(result.error)
    return done({ schema: RUNTIME_ENDPOINT_SCHEMA, endpoint: result.value })
  },
}

const revokeTool: ToolSpec = {
  name: 'runtime_endpoint_revoke',
  scope: 'self (permanently revoke one runtime endpoint handle)',
  min: 'authenticated',
  args: '{ endpoint_id: string, endpoint_capability: string }',
  inputSchema: {
    type: 'object',
    properties: { endpoint_id: STRING, endpoint_capability: STRING },
    required: ['endpoint_id', 'endpoint_capability'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const caller = identity(auth)
    if (!caller) return fail(403, 'not_agent_bound')
    const endpointId = str(args.endpoint_id)
    const endpointCapability = str(args.endpoint_capability)
    if (!endpointId || !endpointCapability) return fail(400, 'invalid_args')
    const result = await revokeRuntimeEndpoint(env, endpointId, caller.agentId, endpointCapability)
    if (!result.ok) return serviceFailure(result.error)
    return done({ schema: RUNTIME_ENDPOINT_SCHEMA, endpoint: result.value })
  },
}

const listTool: ToolSpec = {
  name: 'runtime_endpoint_list',
  scope: 'self endpoints, or the endpoint roster for one readable project',
  min: 'observer',
  args: '{ project_id?: string }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const caller = identity(auth)
    if (!caller) return fail(403, 'not_agent_bound')
    const projectId = str(args.project_id)
    if (args.project_id !== undefined && !projectId) return fail(400, 'invalid_project_id')
    if (projectId && !(await projectVisible(auth, env, projectId))) return fail(404, 'project_not_found')
    const candidates = await listRuntimeEndpoints(
      env,
      projectId ? { projectId } : { agentId: caller.agentId },
    )
    const endpoints = projectId
      ? candidates
      : (await Promise.all(candidates.map(async (endpoint) =>
          (await projectVisible(auth, env, endpoint.project_id)) ? endpoint : null)))
        .filter((endpoint): endpoint is RuntimeEndpoint => endpoint !== null)
    return done({ schema: RUNTIME_ENDPOINT_SCHEMA, endpoints })
  },
}

const sendTool: ToolSpec = {
  name: 'runtime_endpoint_send',
  scope: 'explicit leased endpoint in a readable project',
  min: 'authenticated',
  args: '{ endpoint_id, project_id, body, kind?, request_id?, in_reply_to? }',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint_id: STRING,
      project_id: STRING,
      body: STRING,
      kind: { type: 'string', enum: MESSAGE_KINDS },
      request_id: STRING,
      in_reply_to: STRING,
    },
    required: ['endpoint_id', 'project_id', 'body'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const caller = identity(auth)
    if (!caller) return fail(403, 'not_agent_bound')
    const endpointId = str(args.endpoint_id)
    const projectId = str(args.project_id)
    const body = str(args.body)
    if (!endpointId || !projectId || !body) return fail(400, 'invalid_args')
    if (!(await projectVisible(auth, env, projectId))) return fail(404, 'project_not_found')
    const endpoint = await getRuntimeEndpoint(env, endpointId)
    if (!endpoint || endpoint.project_id !== projectId) return fail(404, 'endpoint_not_found')
    const result = await sendRuntimeEndpointMessage(env, {
      endpoint,
      fromAgent: caller.agentId,
      fromMember: caller.memberId,
      projectId,
      body,
      kind: args.kind as 'message' | 'request' | undefined,
      requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
      inReplyTo: typeof args.in_reply_to === 'string' ? args.in_reply_to : undefined,
    })
    if (!result.ok) return serviceFailure(result.error)
    return done({ ...result.value, project_id: projectId })
  },
}

type OwnedEndpoint =
  | { ok: true; endpoint: RuntimeEndpoint }
  | { ok: false; error: ReturnType<typeof fail> }

async function ownedActiveEndpoint(
  auth: AuthContext,
  env: Parameters<ToolSpec['run']>[1],
  endpointId: string,
  endpointCapability: string,
): Promise<OwnedEndpoint> {
  const caller = identity(auth)
  if (!caller) return { ok: false, error: fail(403, 'not_agent_bound') }
  const endpoint = await getRuntimeEndpointWithCapability(env, endpointId, endpointCapability)
  if (!endpoint || endpoint.agent_id !== caller.agentId) return { ok: false, error: fail(404, 'endpoint_not_found') }
  if (!(await projectVisible(auth, env, endpoint.project_id))) return { ok: false, error: fail(404, 'endpoint_not_found') }
  if (endpoint.status !== 'active') return { ok: false, error: fail(409, 'endpoint_unavailable') }
  return { ok: true, endpoint }
}

const inboxTool: ToolSpec = {
  name: 'runtime_endpoint_inbox',
  scope: 'self (peek one exact endpoint inbox; acceptance is separate)',
  min: 'authenticated',
  args: '{ endpoint_id: string, endpoint_capability: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { endpoint_id: STRING, endpoint_capability: STRING, limit: NUMBER },
    required: ['endpoint_id', 'endpoint_capability'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const endpointId = str(args.endpoint_id)
    const endpointCapability = str(args.endpoint_capability)
    if (!endpointId || !endpointCapability) return fail(400, 'invalid_args')
    const owned = await ownedActiveEndpoint(auth, env, endpointId, endpointCapability)
    if (!owned.ok) return owned.error
    const result = await readRuntimeEndpointInbox(
      env,
      owned.endpoint,
      endpointCapability,
      typeof args.limit === 'number' ? args.limit : undefined,
    )
    if (!result.ok) return serviceFailure(result.error)
    return done({ ...result.value, consumed: false })
  },
}

const acceptTool: ToolSpec = {
  name: 'runtime_endpoint_accept',
  scope: 'self (mark one durably persisted message accepted by this exact runtime)',
  min: 'authenticated',
  args: '{ endpoint_id: string, endpoint_capability: string, message_id: string, runtime_turn_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint_id: STRING,
      endpoint_capability: STRING,
      message_id: STRING,
      runtime_turn_id: STRING,
    },
    required: ['endpoint_id', 'endpoint_capability', 'message_id', 'runtime_turn_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const endpointId = str(args.endpoint_id)
    const endpointCapability = str(args.endpoint_capability)
    const messageId = str(args.message_id)
    const runtimeTurnId = str(args.runtime_turn_id)
    if (!endpointId || !endpointCapability || !messageId || !runtimeTurnId) return fail(400, 'invalid_args')
    const owned = await ownedActiveEndpoint(auth, env, endpointId, endpointCapability)
    if (!owned.ok) return owned.error
    const result = await acceptRuntimeEndpointMessage(
      env,
      owned.endpoint,
      endpointCapability,
      messageId,
      runtimeTurnId,
    )
    if (!result.ok) return serviceFailure(result.error)
    return done({ schema: RUNTIME_ENDPOINT_ACK_SCHEMA, receipt: result.value })
  },
}

export const RUNTIME_ENDPOINT_HOST_TOOLS: ToolSpec[] = [
  checkInTool,
  heartbeatTool,
  revokeTool,
  listTool,
  sendTool,
  inboxTool,
  acceptTool,
]

// Capabilities and host session handles are runtime-adapter secrets. Only safe
// discovery and governed send are model-visible MCP tools.
export const RUNTIME_ENDPOINT_MCP_TOOLS: ToolSpec[] = [
  listTool,
  sendTool,
]
