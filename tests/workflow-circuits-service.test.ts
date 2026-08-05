// tests/workflow-circuits-service.test.ts — DB-integration coverage for the
// workflow-circuits addon (src/addons/workflow-circuits/service.ts), driven
// through the real D1-shaped sqlite harness and real migrations (same
// pattern as tests/project-link-addon.test.ts). Covers the flight brief's
// required minimum:
//   - AND-gate node cannot advance to active until ALL required deps are done
//   - OR-gate node CAN advance on any one satisfied input
//   - fallback edge fires (auto-activates its target) on a failed/timeout node
//   - a gate edge is satisfied only by explicit approval, not by the source
//     node's own state (approve_gate_edge)
//   - trigger edges auto-fire their target on source completion
// Each gating assertion is paired with the "same shape, condition removed"
// case so a reader can see it actually discriminates (not a test that can
// only ever pass).

import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { activateAddon, configureAddon, installAddon } from '../src/addons/service'
import '../src/addons/workflow-circuits/manifest'
import {
  advanceNode,
  approveGateEdge,
  defineCircuit,
  getCircuitState,
  type WorkflowCircuitActor,
} from '../src/addons/workflow-circuits/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'


const TENANT = 'tenant-a'
const ADMIN: WorkflowCircuitActor = { id: 'owner-1', role: 'owner' }
const AGENT: WorkflowCircuitActor = { id: 'agent-1', role: 'member' }

function makeEnv(harness: SqliteD1Harness): Env {
  applyAllMigrations(harness.sqlite)
  return { DB: harness.db, TENANT_SLUG: TENANT } as Env
}

async function enableWorkflowCircuitsAddon(env: Env) {
  const actor = { id: ADMIN.id, role: 'owner' as const }
  const installed = await installAddon(env, actor, 'workflow-circuits')
  const configured = await configureAddon(env, actor, 'workflow-circuits')
  const activated = await activateAddon(env, actor, 'workflow-circuits')
  if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
}

let harness: SqliteD1Harness
let env: Env

beforeEach(async () => {
  harness = createSqliteD1()
  env = makeEnv(harness)
  await enableWorkflowCircuitsAddon(env)
})

// ── AND gate ─────────────────────────────────────────────────────────────
describe('advanceNode — AND gate', () => {
  async function defineAndCircuit(key: string) {
    const result = await defineCircuit(env, ADMIN, {
      key,
      name: 'AND fan-in',
      nodes: [
        { id: 'dep_a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'dep_b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'join', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'dep_a', target: 'join' },
        { type: 'dependency', source: 'dep_b', target: 'join' },
      ],
    })
    if (!result.ok) throw new Error(`fixture define failed: ${result.reason}`)
    return result.circuit.id
  }

  it('cannot advance to active until ALL required deps are done', async () => {
    const circuitId = await defineAndCircuit('and-gate-blocked')

    // Only one of two deps is done — the AND gate must still refuse.
    const depA = await advanceNode(env, AGENT, circuitId, 'dep_a', 'active')
    expect(depA.ok).toBe(true)
    const depADone = await advanceNode(env, AGENT, circuitId, 'dep_a', 'done')
    expect(depADone.ok).toBe(true)

    const blocked = await advanceNode(env, AGENT, circuitId, 'join', 'active')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('gate_not_satisfied')

    const state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'join')?.done_state).toBe('pending')
  })

  it('advances once ALL required deps are done (proves the block above was the gate, not a bug)', async () => {
    const circuitId = await defineAndCircuit('and-gate-open')

    for (const dep of ['dep_a', 'dep_b']) {
      expect((await advanceNode(env, AGENT, circuitId, dep, 'active')).ok).toBe(true)
      expect((await advanceNode(env, AGENT, circuitId, dep, 'done')).ok).toBe(true)
    }

    const opened = await advanceNode(env, AGENT, circuitId, 'join', 'active')
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(opened.node.next_state).toBe('active')
  })
})

// ── OR gate ──────────────────────────────────────────────────────────────
describe('advanceNode — OR gate', () => {
  async function defineOrCircuit(key: string) {
    const result = await defineCircuit(env, ADMIN, {
      key,
      name: 'OR fan-in',
      nodes: [
        { id: 'dep_a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'dep_b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'join', type: 'step', gate_rule: 'OR', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'dep_a', target: 'join' },
        { type: 'dependency', source: 'dep_b', target: 'join' },
      ],
    })
    if (!result.ok) throw new Error(`fixture define failed: ${result.reason}`)
    return result.circuit.id
  }

  it('cannot advance while ZERO required inputs are satisfied', async () => {
    const circuitId = await defineOrCircuit('or-gate-blocked')
    const blocked = await advanceNode(env, AGENT, circuitId, 'join', 'active')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('gate_not_satisfied')
  })

  it('advances once ANY ONE required input is satisfied (dep_b still pending)', async () => {
    const circuitId = await defineOrCircuit('or-gate-open')
    expect((await advanceNode(env, AGENT, circuitId, 'dep_a', 'active')).ok).toBe(true)
    expect((await advanceNode(env, AGENT, circuitId, 'dep_a', 'done')).ok).toBe(true)

    const state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'dep_b')?.done_state).toBe('pending')

    const opened = await advanceNode(env, AGENT, circuitId, 'join', 'active')
    expect(opened.ok).toBe(true)
  })
})

// ── fallback wiring ──────────────────────────────────────────────────────
describe('advanceNode — fallback edge fires on failed/timeout', () => {
  async function defineFallbackCircuit(key: string) {
    const result = await defineCircuit(env, ADMIN, {
      key,
      name: 'Fallback',
      nodes: [
        { id: 'charge', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
        { id: 'recover', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'charge', target: 'nps' },
        { type: 'fallback', source: 'charge', target: 'recover' },
        // Every resolution branch must reach a survey, including the
        // fallback branch this describe block exercises — without this
        // wire, `recover` is a dead end and the definition is (correctly)
        // rejected as customer_facing_missing_survey.
        { type: 'trigger', source: 'recover', target: 'nps' },
      ],
    })
    if (!result.ok) throw new Error(`fixture define failed: ${result.reason}`)
    return result.circuit.id
  }

  it('a fallback target stays pending while its source has not failed', async () => {
    const circuitId = await defineFallbackCircuit('fallback-not-yet')
    const state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'recover')?.done_state).toBe('pending')
  })

  it('auto-activates the fallback target when the source enters "failed"', async () => {
    const circuitId = await defineFallbackCircuit('fallback-failed')
    await advanceNode(env, AGENT, circuitId, 'charge', 'active')
    const result = await advanceNode(env, AGENT, circuitId, 'charge', 'failed')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cascaded).toEqual([
        { node_id: 'recover', previous_state: 'pending', next_state: 'active', via_edge_type: 'fallback', via_source_node_id: 'charge' },
      ])
    }
    const state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'recover')?.done_state).toBe('active')
  })

  it('auto-activates the fallback target when the source enters "timeout"', async () => {
    const circuitId = await defineFallbackCircuit('fallback-timeout')
    await advanceNode(env, AGENT, circuitId, 'charge', 'active')
    const result = await advanceNode(env, AGENT, circuitId, 'charge', 'timeout')
    expect(result.ok).toBe(true)
    const state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'recover')?.done_state).toBe('active')
  })
})

// ── trigger wiring ───────────────────────────────────────────────────────
describe('advanceNode — trigger edge fires on completion', () => {
  it('auto-activates the trigger target when the source reaches "done", but not before', async () => {
    const define = await defineCircuit(env, ADMIN, {
      key: 'trigger-chain',
      name: 'Trigger chain',
      nodes: [
        { id: 'ship', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
        { id: 'recover', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'ship', target: 'nps' },
        { type: 'fallback', source: 'ship', target: 'recover' },
        // Every resolution branch must reach a survey -- see the identical
        // note in the fallback-edge describe block above.
        { type: 'trigger', source: 'recover', target: 'nps' },
      ],
    })
    if (!define.ok) throw new Error('fixture define failed')
    const circuitId = define.circuit.id

    await advanceNode(env, AGENT, circuitId, 'ship', 'active')
    let state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'nps')?.done_state).toBe('pending')

    const result = await advanceNode(env, AGENT, circuitId, 'ship', 'done')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.cascaded).toEqual([
        { node_id: 'nps', previous_state: 'pending', next_state: 'active', via_edge_type: 'trigger', via_source_node_id: 'ship' },
      ])
    }
    state = await getCircuitState(env, circuitId)
    expect(state?.nodes.find((n) => n.id === 'nps')?.done_state).toBe('active')
  })
})

// ── gate edges: satisfied only by explicit approval ─────────────────────
describe('advanceNode — gate edge requires explicit approval, not source completion', () => {
  async function defineGateCircuit(key: string) {
    const result = await defineCircuit(env, ADMIN, {
      key,
      name: 'Gate approval',
      nodes: [
        { id: 'draft', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'publish', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'gate', source: 'draft', target: 'publish' },
      ],
    })
    if (!result.ok) throw new Error(`fixture define failed: ${result.reason}`)
    return result.circuit.id
  }

  it('publish stays blocked even after draft is done, until the gate edge is approved', async () => {
    const circuitId = await defineGateCircuit('gate-unapproved')
    await advanceNode(env, AGENT, circuitId, 'draft', 'active')
    await advanceNode(env, AGENT, circuitId, 'draft', 'done')

    const blocked = await advanceNode(env, AGENT, circuitId, 'publish', 'active')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('gate_not_satisfied')
  })

  it('publish advances once the gate edge is explicitly approved (proves the block above was the gate)', async () => {
    const circuitId = await defineGateCircuit('gate-approved')
    await advanceNode(env, AGENT, circuitId, 'draft', 'active')
    await advanceNode(env, AGENT, circuitId, 'draft', 'done')

    const state = await getCircuitState(env, circuitId)
    const edge = state?.edges.find((e) => e.type === 'gate')
    expect(edge).toBeDefined()

    const approved = await approveGateEdge(env, { id: 'approver-1', role: 'member' }, circuitId, edge!.id)
    expect(approved.ok).toBe(true)

    const opened = await advanceNode(env, AGENT, circuitId, 'publish', 'active')
    expect(opened.ok).toBe(true)
  })
})

// ── define_circuit persistence + structural rejection wiring ────────────
describe('defineCircuit — persistence and rejection', () => {
  it('persists nodes/edges retrievable via getCircuitState', async () => {
    const result = await defineCircuit(env, ADMIN, {
      key: 'persist-check',
      name: 'Persist Check',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = await getCircuitState(env, result.circuit.id)
    expect(state?.nodes).toHaveLength(1)
    expect(state?.nodes[0].done_state).toBe('pending')
  })

  it('rejects a duplicate circuit key for the same tenant', async () => {
    const input = {
      key: 'dupe-key',
      name: 'Dupe',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND' as const, customer_facing: false }],
      edges: [],
    }
    expect((await defineCircuit(env, ADMIN, input)).ok).toBe(true)
    const second = await defineCircuit(env, ADMIN, input)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('duplicate_circuit_key')
  })

  it('rejects a customer_facing node missing a downstream survey node', async () => {
    const result = await defineCircuit(env, ADMIN, {
      key: 'reject-no-survey',
      name: 'Reject',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'recover', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [{ type: 'fallback', source: 'checkout', target: 'recover' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('customer_facing_missing_survey')
  })

  it('rejects a customer_facing node missing an outgoing fallback edge', async () => {
    const result = await defineCircuit(env, ADMIN, {
      key: 'reject-no-fallback',
      name: 'Reject',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [{ type: 'trigger', source: 'checkout', target: 'nps' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('customer_facing_missing_fallback')
  })

  it('rejects orphan nodes at define time (not caught mid-execution)', async () => {
    const result = await defineCircuit(env, ADMIN, {
      key: 'reject-orphan',
      name: 'Reject',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'island', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [{ type: 'dependency', source: 'a', target: 'b' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('orphan_node')
  })

  it('rejects cycles at define time (not caught mid-execution)', async () => {
    const result = await defineCircuit(env, ADMIN, {
      key: 'reject-cycle',
      name: 'Reject',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'a', target: 'b' },
        { type: 'dependency', source: 'b', target: 'a' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cycle_detected')
  })

  it('rejects when the addon is not active for the tenant', async () => {
    const bareHarness = createSqliteD1()
    const bareEnv = makeEnv(bareHarness)
    // No installAddon/configureAddon/activateAddon — addon_installations has no row.
    const result = await defineCircuit(bareEnv, ADMIN, {
      key: 'inactive',
      name: 'Inactive',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('addon_inactive')
  })

  it('rejects a non-admin actor', async () => {
    const result = await defineCircuit(env, { id: 'member-1', role: 'member' }, {
      key: 'not-admin',
      name: 'Not Admin',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_authorized')
  })
})

// ── invalid state transitions ────────────────────────────────────────────
describe('advanceNode — invalid transitions and unknown targets', () => {
  it('rejects advancing a done node back to pending', async () => {
    const define = await defineCircuit(env, ADMIN, {
      key: 'terminal-done',
      name: 'Terminal',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    if (!define.ok) throw new Error('fixture define failed')
    const circuitId = define.circuit.id
    await advanceNode(env, AGENT, circuitId, 'solo', 'active')
    await advanceNode(env, AGENT, circuitId, 'solo', 'done')
    const result = await advanceNode(env, AGENT, circuitId, 'solo', 'pending')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_transition')
  })

  it('rejects advancing an unknown node', async () => {
    const define = await defineCircuit(env, ADMIN, {
      key: 'unknown-node',
      name: 'Unknown',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    if (!define.ok) throw new Error('fixture define failed')
    const result = await advanceNode(env, AGENT, define.circuit.id, 'ghost', 'active')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('node_not_found')
  })

  it('rejects advancing a node in an unknown circuit', async () => {
    const result = await advanceNode(env, AGENT, 'no-such-circuit', 'solo', 'active')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('circuit_not_found')
  })
})
