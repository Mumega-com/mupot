// mupot — workflow-circuits domain service.
//
// Deterministic workflow-graph engine. A circuit is defined once
// (defineCircuit — validated by validation.ts, then persisted) and driven
// node-by-node through advanceNode, the ONLY function that changes a node's
// done_state. advanceNode enforces the node's declared gate_rule over its
// required input wires itself — a caller cannot mark a node active/done by
// skipping the gate, because there is no other write path to done_state.
//
// Same addon-active gating pattern as project-link
// (src/addons/project-link/service.ts#projectLinkAddonActive): domain writes
// check addon_installations.state = 'active' for this tenant before doing
// anything, same generic addon lifecycle table every addon shares
// (src/addons/service.ts).

import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import {
  validateCircuitDefinition,
  GATING_EDGE_TYPES,
  type CircuitDefinitionInput,
  type CircuitEdgeType,
  type CircuitValidationFailureReason,
} from './validation'

export interface WorkflowCircuitActor {
  id: string
  role: 'owner' | 'admin' | 'member'
}

export type CircuitDoneState = 'pending' | 'active' | 'done' | 'blocked' | 'failed' | 'timeout' | 'degraded'

const DONE_STATES: readonly CircuitDoneState[] = ['pending', 'active', 'done', 'blocked', 'failed', 'timeout', 'degraded']

export function isCircuitDoneState(value: unknown): value is CircuitDoneState {
  return typeof value === 'string' && (DONE_STATES as readonly string[]).includes(value)
}

// The abnormal-procedure states an aviation-tolerant circuit must be able to
// land a node in without hanging — see the flight brief: "a circuit must
// never just hang on an unhandled failure."
const TERMINAL_TOLERANCE_STATES: readonly CircuitDoneState[] = ['failed', 'timeout']

// Node state machine. `done` is terminal (a completed step is not reopened —
// re-running work is a new circuit run, not a state transition). `failed`/
// `timeout` can retry back to `active` (aviation-tolerance: a fallback path
// or a human/agent retry can bring a degraded step back into service).
const VALID_TRANSITIONS: Record<CircuitDoneState, readonly CircuitDoneState[]> = {
  pending: ['active', 'blocked', 'failed', 'timeout'],
  active: ['done', 'blocked', 'failed', 'timeout', 'degraded'],
  blocked: ['active', 'failed', 'timeout'],
  degraded: ['active', 'done', 'failed', 'timeout'],
  failed: ['active'],
  timeout: ['active'],
  done: [],
}

export interface CircuitNodeRecord {
  id: string
  type: string
  done_state: CircuitDoneState
  gate_rule: 'AND' | 'OR'
  customer_facing: boolean
}

export interface CircuitEdgeRecord {
  id: string
  type: CircuitEdgeType
  source: string
  target: string
  approved_by: string | null
  approved_at: string | null
}

export interface CircuitWireStatus {
  edge_id: string
  type: CircuitEdgeType
  source: string
  satisfied: boolean
}

export interface CircuitState {
  id: string
  tenant: string
  key: string
  name: string
  status: 'defined' | 'archived'
  nodes: Array<CircuitNodeRecord & { required_wires: CircuitWireStatus[] }>
  edges: CircuitEdgeRecord[]
}

export type WorkflowCircuitFailureReason =
  | 'not_authorized'
  | 'addon_inactive'
  | 'invalid_definition'
  | 'duplicate_circuit_key'
  | 'circuit_not_found'
  | 'circuit_archived'
  | 'node_not_found'
  | 'edge_not_found'
  | 'invalid_state'
  | 'invalid_transition'
  | 'gate_not_satisfied'
  | 'not_a_gate_edge'
  | 'write_failed'

export type DefineCircuitResult =
  | { ok: true; circuit: { id: string; key: string; name: string; status: 'defined' } }
  | { ok: false; reason: 'not_authorized' | 'addon_inactive' | 'duplicate_circuit_key' | CircuitValidationFailureReason; detail?: string }

export interface AdvanceNodeCascadeEntry {
  node_id: string
  previous_state: CircuitDoneState
  next_state: CircuitDoneState
  via_edge_type: 'trigger' | 'fallback'
  via_source_node_id: string
}

export type AdvanceNodeResult =
  | {
      ok: true
      node: { id: string; previous_state: CircuitDoneState; next_state: CircuitDoneState }
      cascaded: AdvanceNodeCascadeEntry[]
    }
  | {
      ok: false
      reason: Extract<WorkflowCircuitFailureReason, 'addon_inactive' | 'circuit_not_found' | 'circuit_archived' | 'node_not_found' | 'invalid_state' | 'invalid_transition' | 'gate_not_satisfied' | 'write_failed'>
      detail?: unknown
    }

export type ApproveGateEdgeResult =
  | { ok: true; edge: CircuitEdgeRecord }
  | {
      ok: false
      reason: Extract<WorkflowCircuitFailureReason, 'not_authorized' | 'addon_inactive' | 'circuit_not_found' | 'edge_not_found' | 'not_a_gate_edge'>
    }

function admin(actor: WorkflowCircuitActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

async function workflowCircuitsAddonActive(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT state FROM addon_installations
      WHERE tenant = ?1 AND addon_key = 'workflow-circuits'
      ORDER BY installed_at DESC, id DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG).first<{ state: string }>()
  return row?.state === 'active'
}

async function canonicalSha256(value: unknown): Promise<string> {
  // Sorted-key JSON is sufficient here (unlike project-link's envelope,
  // nothing here is cryptographically signed) — this hash only needs to be
  // stable for change-detection / audit, not adversarially canonical.
  const sortValue = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortValue)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sortValue(child)]),
      )
    }
    return input
  }
  const bytes = new TextEncoder().encode(JSON.stringify(sortValue(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface CircuitRow {
  id: string
  tenant: string
  key: string
  name: string
  status: 'defined' | 'archived'
}

async function loadCircuitRow(env: Env, circuitId: string): Promise<CircuitRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, tenant, key, name, status FROM workflow_circuits WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(circuitId, env.TENANT_SLUG).first<CircuitRow>()
  return row ?? null
}

interface NodeRow {
  id: string
  type: string
  done_state: CircuitDoneState
  gate_rule: 'AND' | 'OR'
  customer_facing: number
}

async function loadNodeRows(env: Env, circuitId: string): Promise<CircuitNodeRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, type, done_state, gate_rule, customer_facing
       FROM workflow_circuit_nodes WHERE circuit_id = ?1 AND tenant = ?2`,
  ).bind(circuitId, env.TENANT_SLUG).all<NodeRow>()
  return (result.results ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    done_state: row.done_state,
    gate_rule: row.gate_rule,
    customer_facing: row.customer_facing === 1,
  }))
}

interface EdgeRow {
  id: string
  type: CircuitEdgeType
  source_node_id: string
  target_node_id: string
  approved_by: string | null
  approved_at: string | null
}

async function loadEdgeRows(env: Env, circuitId: string): Promise<CircuitEdgeRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, type, source_node_id, target_node_id, approved_by, approved_at
       FROM workflow_circuit_edges WHERE circuit_id = ?1 AND tenant = ?2`,
  ).bind(circuitId, env.TENANT_SLUG).all<EdgeRow>()
  return (result.results ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    source: row.source_node_id,
    target: row.target_node_id,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
  }))
}

/** Whether a single wire (dependency|gate edge) INTO a node currently counts
 * as satisfied. dependency: source node is done. gate: the edge itself has
 * been explicitly approved (see approveGateEdge) — deliberately independent
 * of the source node's own state; "gate not router": an approval is its own
 * explicit signal, not inferred from completion. */
function wireSatisfied(edge: CircuitEdgeRecord, nodesById: ReadonlyMap<string, CircuitNodeRecord>): boolean {
  if (edge.type === 'dependency') return nodesById.get(edge.source)?.done_state === 'done'
  if (edge.type === 'gate') return edge.approved_at !== null
  return false
}

function requiredWires(nodeId: string, edges: readonly CircuitEdgeRecord[]): CircuitEdgeRecord[] {
  return edges.filter((edge) => edge.target === nodeId && GATING_EDGE_TYPES.includes(edge.type))
}

/** gate_rule evaluation over a node's required input wires. Zero wires
 * (an entry node) is vacuously satisfied under both AND and OR — there is
 * nothing to gate on, so the node is free to start. */
function gateSatisfied(
  node: CircuitNodeRecord,
  edges: readonly CircuitEdgeRecord[],
  nodesById: ReadonlyMap<string, CircuitNodeRecord>,
): boolean {
  const wires = requiredWires(node.id, edges)
  if (wires.length === 0) return true
  const states = wires.map((edge) => wireSatisfied(edge, nodesById))
  return node.gate_rule === 'AND' ? states.every(Boolean) : states.some(Boolean)
}

export async function defineCircuit(
  env: Env,
  actor: WorkflowCircuitActor,
  rawDefinition: unknown,
): Promise<DefineCircuitResult> {
  if (!admin(actor)) return { ok: false, reason: 'not_authorized' }
  if (!(await workflowCircuitsAddonActive(env))) return { ok: false, reason: 'addon_inactive' }

  const validation = validateCircuitDefinition(rawDefinition)
  if (!validation.ok) return { ok: false, reason: validation.reason, detail: validation.detail }
  const definition: CircuitDefinitionInput = validation.definition

  const existing = await env.DB.prepare(
    `SELECT 1 FROM workflow_circuits WHERE tenant = ?1 AND key = ?2 AND status <> 'archived' LIMIT 1`,
  ).bind(env.TENANT_SLUG, definition.key).first()
  if (existing) return { ok: false, reason: 'duplicate_circuit_key' }

  const now = new Date().toISOString()
  const circuitId = crypto.randomUUID()
  const definitionSha256 = await canonicalSha256(definition)

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO workflow_circuits (id, tenant, key, name, status, definition_sha256, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, 'defined', ?5, ?6, ?7)`,
    ).bind(circuitId, env.TENANT_SLUG, definition.key, definition.name, definitionSha256, actor.id, now),
  ]

  for (const node of definition.nodes) {
    statements.push(env.DB.prepare(
      `INSERT INTO workflow_circuit_nodes (circuit_id, id, tenant, type, done_state, gate_rule, customer_facing, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?7)`,
    ).bind(circuitId, node.id, env.TENANT_SLUG, node.type, node.gate_rule, node.customer_facing ? 1 : 0, now))
  }

  for (const edge of definition.edges) {
    statements.push(env.DB.prepare(
      `INSERT INTO workflow_circuit_edges (id, circuit_id, tenant, type, source_node_id, target_node_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(crypto.randomUUID(), circuitId, env.TENANT_SLUG, edge.type, edge.source, edge.target, now))
  }

  const results = await env.DB.batch(statements) as D1Result<unknown>[]
  if (results.some((result) => !result.success)) return { ok: false, reason: 'invalid_definition', detail: 'write_failed' }

  return { ok: true, circuit: { id: circuitId, key: definition.key, name: definition.name, status: 'defined' } }
}

export async function getCircuitState(env: Env, circuitId: string): Promise<CircuitState | null> {
  const circuit = await loadCircuitRow(env, circuitId)
  if (!circuit) return null
  const nodes = await loadNodeRows(env, circuitId)
  const edges = await loadEdgeRows(env, circuitId)
  const nodesById = new Map(nodes.map((node) => [node.id, node]))

  return {
    id: circuit.id,
    tenant: circuit.tenant,
    key: circuit.key,
    name: circuit.name,
    status: circuit.status,
    edges,
    nodes: nodes.map((node) => ({
      ...node,
      required_wires: requiredWires(node.id, edges).map((edge) => ({
        edge_id: edge.id,
        type: edge.type,
        source: edge.source,
        satisfied: wireSatisfied(edge, nodesById),
      })),
    })),
  }
}

export interface CircuitSummary {
  id: string
  key: string
  name: string
  status: 'defined' | 'archived'
  node_count: number
  created_at: string
}

/** Tenant-wide circuit list for the dashboard's circuit-state view (#circuit-view
 * flight). Deliberately as thin as getCircuitState: a plain read, no addon-active
 * gate — an inactive/uninstalled addon simply has no rows to return, which is
 * already an honest empty state (see src/dashboard/workflow-circuits.ts). Circuits
 * are NOT project-scoped (workflow_circuits carries no project_id column), so this
 * is tenant-wide by design, same scope defineCircuit writes into. */
export async function listCircuits(env: Env): Promise<CircuitSummary[]> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.key, c.name, c.status, c.created_at,
            (SELECT COUNT(*) FROM workflow_circuit_nodes n
              WHERE n.circuit_id = c.id AND n.tenant = c.tenant) AS node_count
       FROM workflow_circuits c
      WHERE c.tenant = ?1
      ORDER BY c.created_at DESC, c.id DESC`,
  ).bind(env.TENANT_SLUG).all<{
    id: string; key: string; name: string; status: 'defined' | 'archived'; created_at: string; node_count: number
  }>()
  return (result.results ?? []).map((row) => ({ ...row }))
}

export async function approveGateEdge(
  env: Env,
  actor: WorkflowCircuitActor,
  circuitId: string,
  edgeId: string,
): Promise<ApproveGateEdgeResult> {
  if (!(await workflowCircuitsAddonActive(env))) return { ok: false, reason: 'addon_inactive' }
  const circuit = await loadCircuitRow(env, circuitId)
  if (!circuit) return { ok: false, reason: 'circuit_not_found' }

  const edges = await loadEdgeRows(env, circuitId)
  const edge = edges.find((candidate) => candidate.id === edgeId)
  if (!edge) return { ok: false, reason: 'edge_not_found' }
  if (edge.type !== 'gate') return { ok: false, reason: 'not_a_gate_edge' }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE workflow_circuit_edges SET approved_by = ?1, approved_at = ?2
      WHERE id = ?3 AND circuit_id = ?4 AND tenant = ?5`,
  ).bind(actor.id, now, edgeId, circuitId, env.TENANT_SLUG).run()

  return { ok: true, edge: { ...edge, approved_by: actor.id, approved_at: now } }
}

export async function advanceNode(
  env: Env,
  actor: WorkflowCircuitActor,
  circuitId: string,
  nodeId: string,
  newState: string,
  reason?: string,
): Promise<AdvanceNodeResult> {
  if (!isCircuitDoneState(newState)) return { ok: false, reason: 'invalid_state' }
  if (!(await workflowCircuitsAddonActive(env))) return { ok: false, reason: 'addon_inactive' }

  const circuit = await loadCircuitRow(env, circuitId)
  if (!circuit) return { ok: false, reason: 'circuit_not_found' }
  if (circuit.status === 'archived') return { ok: false, reason: 'circuit_archived' }

  const nodes = await loadNodeRows(env, circuitId)
  const edges = await loadEdgeRows(env, circuitId)
  const nodesById = new Map(nodes.map((node) => [node.id, node]))

  const target = nodesById.get(nodeId)
  if (!target) return { ok: false, reason: 'node_not_found' }

  if (!VALID_TRANSITIONS[target.done_state].includes(newState)) {
    return { ok: false, reason: 'invalid_transition', detail: { from: target.done_state, to: newState } }
  }
  if (newState === 'active' && !gateSatisfied(target, edges, nodesById)) {
    return {
      ok: false,
      reason: 'gate_not_satisfied',
      detail: {
        gate_rule: target.gate_rule,
        required_wires: requiredWires(nodeId, edges).map((edge) => ({
          edge_id: edge.id,
          type: edge.type,
          source: edge.source,
          satisfied: wireSatisfied(edge, nodesById),
        })),
      },
    }
  }

  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  const cascaded: AdvanceNodeCascadeEntry[] = []

  const stampTransition = (
    id: string,
    from: CircuitDoneState,
    to: CircuitDoneState,
    cascadeSourceNodeId: string | null,
    cascadeEdgeType: 'trigger' | 'fallback' | null,
  ) => {
    statements.push(env.DB.prepare(
      `UPDATE workflow_circuit_nodes SET done_state = ?1, updated_at = ?2
        WHERE circuit_id = ?3 AND id = ?4 AND tenant = ?5 AND done_state = ?6`,
    ).bind(to, now, circuitId, id, env.TENANT_SLUG, from))
    statements.push(env.DB.prepare(
      `INSERT INTO workflow_circuit_node_events
         (id, tenant, circuit_id, node_id, previous_state, next_state, actor_id, cascade_source_node_id, cascade_edge_type, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      crypto.randomUUID(), env.TENANT_SLUG, circuitId, id, from, to, actor.id,
      cascadeSourceNodeId, cascadeEdgeType, reason ?? null, now,
    ))
    // Reflect the change into the in-memory snapshot so cascade logic below
    // (and gate evaluation for any later cascade step) sees the new state.
    const previousRecord = nodesById.get(id)
    if (previousRecord) nodesById.set(id, { ...previousRecord, done_state: to })
  }

  stampTransition(nodeId, target.done_state, newState, null, null)

  // Trigger wires: fire automatically on source completion. One hop only —
  // a cascaded activation does not itself cascade further until a later,
  // explicit advance_node call moves that node to 'done'.
  if (newState === 'done') {
    for (const edge of edges.filter((candidate) => candidate.type === 'trigger' && candidate.source === nodeId)) {
      const downstream = nodesById.get(edge.target)
      if (!downstream) continue
      if (!VALID_TRANSITIONS[downstream.done_state].includes('active')) continue
      if (!gateSatisfied(downstream, edges, nodesById)) continue
      const previousState = downstream.done_state
      stampTransition(edge.target, previousState, 'active', nodeId, 'trigger')
      cascaded.push({ node_id: edge.target, previous_state: previousState, next_state: 'active', via_edge_type: 'trigger', via_source_node_id: nodeId })
    }
  }

  // Fallback wires: the pre-wired abnormal procedure. Fires unconditionally
  // (bypasses gate_rule) on failed/timeout — an unhandled failure must never
  // just hang (aviation-tolerance requirement from the flight brief).
  if (TERMINAL_TOLERANCE_STATES.includes(newState)) {
    for (const edge of edges.filter((candidate) => candidate.type === 'fallback' && candidate.source === nodeId)) {
      const downstream = nodesById.get(edge.target)
      if (!downstream) continue
      if (!VALID_TRANSITIONS[downstream.done_state].includes('active')) continue
      const previousState = downstream.done_state
      stampTransition(edge.target, previousState, 'active', nodeId, 'fallback')
      cascaded.push({ node_id: edge.target, previous_state: previousState, next_state: 'active', via_edge_type: 'fallback', via_source_node_id: nodeId })
    }
  }

  const results = await env.DB.batch(statements) as D1Result<unknown>[]
  if (results.some((result) => !result.success)) return { ok: false, reason: 'write_failed' }

  return {
    ok: true,
    node: { id: nodeId, previous_state: target.done_state, next_state: newState },
    cascaded,
  }
}
