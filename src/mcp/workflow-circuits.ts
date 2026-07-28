// mupot — MCP tools for the workflow-circuits addon (deterministic workflow-graph
// engine; see src/addons/workflow-circuits/{validation,service}.ts).
//
// "Circuit schematic," not a router: define_circuit is the only way a circuit's
// nodes/wires come into existence, and it REJECTS an invalid definition (cycles,
// orphan nodes, a customer_facing node missing a downstream survey or an
// outgoing fallback wire — see validation.ts) rather than merely warning.
// advance_node is the only way a node's done_state changes, and it enforces the
// node's own declared gate_rule (AND/OR over dependency+gate wires) itself — a
// caller cannot skip the gate by calling advance_node directly, because the
// service function IS the gate.
//
// Tools (registered into TOOLS in src/mcp/index):
//   define_circuit      — org:admin — validates + persists a circuit definition
//   advance_node        — member    — the only done_state mutation path
//   get_circuit_state    — member    — full current node/edge state + wire diagnostics
//   approve_gate_edge   — member    — the explicit human/agent approval signal a
//                          'gate' edge requires before it counts as satisfied
//                          (without this, a gate edge could never be satisfied —
//                          see the flight report's judgment-call note)

import {
  advanceNode,
  approveGateEdge,
  defineCircuit,
  getCircuitState,
  isCircuitDoneState,
  type WorkflowCircuitActor,
} from '../addons/workflow-circuits/service'
import '../addons/workflow-circuits/manifest'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'

const STRING_SCHEMA = { type: 'string' }

function memberActor(auth: { memberId?: string }): WorkflowCircuitActor {
  // 'member' is the coarse role literal — advanceNode/approveGateEdge/
  // getCircuitState never branch on role, only on addon-active + the graph
  // itself, so this never claims a rank beyond what the caller proved
  // (an authenticated member identity).
  return { id: auth.memberId as string, role: 'member' }
}

function circuitFailureStatus(reason: string): 400 | 403 | 404 | 409 {
  switch (reason) {
    case 'not_authorized':
      return 403
    case 'circuit_not_found':
    case 'node_not_found':
    case 'edge_not_found':
      return 404
    case 'addon_inactive':
    case 'circuit_archived':
    case 'invalid_transition':
    case 'gate_not_satisfied':
    case 'not_a_gate_edge':
    case 'duplicate_circuit_key':
    case 'write_failed':
      return 409
    default:
      return 400
  }
}

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: STRING_SCHEMA,
    type: STRING_SCHEMA,
    gate_rule: { type: 'string', enum: ['AND', 'OR'] },
    customer_facing: { type: 'boolean' },
  },
  required: ['id', 'type', 'gate_rule', 'customer_facing'],
  additionalProperties: false,
}

const EDGE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['dependency', 'gate', 'trigger', 'fallback'] },
    source: STRING_SCHEMA,
    target: STRING_SCHEMA,
  },
  required: ['type', 'source', 'target'],
  additionalProperties: false,
}

const toolDefineCircuit: ToolSpec = {
  name: 'define_circuit',
  scope: 'org (org-admin defines a new workflow circuit)',
  min: 'admin',
  args: '{ definition: { key: string, name: string, nodes: Array<{id,type,gate_rule,customer_facing}>, edges: Array<{type,source,target}> } }',
  inputSchema: {
    type: 'object',
    properties: {
      definition: {
        type: 'object',
        properties: {
          key: STRING_SCHEMA,
          name: STRING_SCHEMA,
          nodes: { type: 'array', items: NODE_SCHEMA },
          edges: { type: 'array', items: EDGE_SCHEMA },
        },
        required: ['key', 'name', 'nodes', 'edges'],
        additionalProperties: false,
      },
    },
    required: ['definition'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member identity' })
    if (typeof args.definition !== 'object' || args.definition === null) {
      return fail(400, 'invalid_args', 'definition required')
    }

    const result = await defineCircuit(env, { id: auth.memberId, role: 'admin' }, args.definition)
    if (!result.ok) return fail(circuitFailureStatus(result.reason), result.reason, 'detail' in result ? result.detail : undefined)
    return done({ circuit: result.circuit })
  },
}

const toolAdvanceNode: ToolSpec = {
  name: 'advance_node',
  scope: 'org (any authenticated member/agent drives circuit execution)',
  min: 'member',
  args: '{ circuit_id: string, node_id: string, new_state: "pending"|"active"|"done"|"blocked"|"failed"|"timeout"|"degraded", reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      circuit_id: STRING_SCHEMA,
      node_id: STRING_SCHEMA,
      new_state: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'failed', 'timeout', 'degraded'] },
      reason: STRING_SCHEMA,
    },
    required: ['circuit_id', 'node_id', 'new_state'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member identity' })
    const circuitId = str(args.circuit_id)
    const nodeId = str(args.node_id)
    const newState = str(args.new_state)
    if (!circuitId) return fail(400, 'invalid_args', 'circuit_id required')
    if (!nodeId) return fail(400, 'invalid_args', 'node_id required')
    if (!newState || !isCircuitDoneState(newState)) return fail(400, 'invalid_args', 'new_state invalid')
    const reason = str(args.reason) ?? undefined

    const result = await advanceNode(env, memberActor(auth), circuitId, nodeId, newState, reason)
    if (!result.ok) return fail(circuitFailureStatus(result.reason), result.reason, 'detail' in result ? result.detail : undefined)
    return done({ node: result.node, cascaded: result.cascaded })
  },
}

const toolGetCircuitState: ToolSpec = {
  name: 'get_circuit_state',
  scope: 'org (any authenticated member/agent reads circuit state)',
  min: 'member',
  args: '{ circuit_id: string }',
  inputSchema: {
    type: 'object',
    properties: { circuit_id: STRING_SCHEMA },
    required: ['circuit_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member identity' })
    const circuitId = str(args.circuit_id)
    if (!circuitId) return fail(400, 'invalid_args', 'circuit_id required')

    const state = await getCircuitState(env, circuitId)
    if (!state) return fail(404, 'circuit_not_found')
    if (state.tenant !== env.TENANT_SLUG) return fail(404, 'circuit_not_found')
    return done({ circuit: state })
  },
}

const toolApproveGateEdge: ToolSpec = {
  name: 'approve_gate_edge',
  scope: 'org (any authenticated member/agent records the explicit approval a gate edge requires)',
  min: 'member',
  args: '{ circuit_id: string, edge_id: string }',
  inputSchema: {
    type: 'object',
    properties: { circuit_id: STRING_SCHEMA, edge_id: STRING_SCHEMA },
    required: ['circuit_id', 'edge_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member identity' })
    const circuitId = str(args.circuit_id)
    const edgeId = str(args.edge_id)
    if (!circuitId) return fail(400, 'invalid_args', 'circuit_id required')
    if (!edgeId) return fail(400, 'invalid_args', 'edge_id required')

    const result = await approveGateEdge(env, memberActor(auth), circuitId, edgeId)
    if (!result.ok) return fail(circuitFailureStatus(result.reason), result.reason)
    return done({ edge: result.edge })
  },
}

export const WORKFLOW_CIRCUIT_TOOLS: ToolSpec[] = [
  toolDefineCircuit,
  toolAdvanceNode,
  toolGetCircuitState,
  toolApproveGateEdge,
]
