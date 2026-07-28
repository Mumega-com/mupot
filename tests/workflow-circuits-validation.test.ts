// tests/workflow-circuits-validation.test.ts — structural validation for
// define_circuit (src/addons/workflow-circuits/validation.ts). These are pure
// function tests (no DB): every MANDATORY rejection rule from the flight brief
// gets both a red case (the property the rule protects, broken) and a green
// case (the same shape, fixed) so a reader can see the assertion actually
// discriminates instead of always passing.

import { describe, expect, it } from 'vitest'
import { validateCircuitDefinition, type CircuitDefinitionInput } from '../src/addons/workflow-circuits/validation'

function baseDefinition(overrides: Partial<CircuitDefinitionInput> = {}): unknown {
  return {
    key: 'onboarding-v1',
    name: 'Onboarding',
    nodes: [
      { id: 'intake', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'review', type: 'step', gate_rule: 'AND', customer_facing: false },
    ],
    edges: [
      { type: 'dependency', source: 'intake', target: 'review' },
    ],
    ...overrides,
  }
}

describe('validateCircuitDefinition — shape', () => {
  it('accepts a minimal valid two-node chain', () => {
    const result = validateCircuitDefinition(baseDefinition())
    expect(result.ok).toBe(true)
  })

  it('rejects a non-object definition', () => {
    const result = validateCircuitDefinition('not an object')
    expect(result).toEqual({ ok: false, reason: 'invalid_definition' })
  })

  it('rejects an unknown top-level field (no silent drop)', () => {
    const result = validateCircuitDefinition({ ...baseDefinition() as object, extra: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_definition')
  })

  it('rejects a duplicate node id', () => {
    const result = validateCircuitDefinition(baseDefinition({
      nodes: [
        { id: 'intake', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'intake', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('duplicate_node_id')
  })

  it('rejects an edge referencing an unknown endpoint', () => {
    const result = validateCircuitDefinition(baseDefinition({
      edges: [{ type: 'dependency', source: 'intake', target: 'ghost' }],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown_edge_endpoint')
  })

  it('rejects a self-loop edge', () => {
    const result = validateCircuitDefinition(baseDefinition({
      edges: [{ type: 'dependency', source: 'intake', target: 'intake' }],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('self_loop_edge')
  })

  it('rejects a duplicate identical wire', () => {
    const result = validateCircuitDefinition(baseDefinition({
      edges: [
        { type: 'dependency', source: 'intake', target: 'review' },
        { type: 'dependency', source: 'intake', target: 'review' },
      ],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('duplicate_edge')
  })
})

// ── Mandatory rule: reject cycles ───────────────────────────────────────────
describe('validateCircuitDefinition — cycle rejection', () => {
  it('rejects a 2-node cycle', () => {
    const result = validateCircuitDefinition(baseDefinition({
      edges: [
        { type: 'dependency', source: 'intake', target: 'review' },
        { type: 'dependency', source: 'review', target: 'intake' },
      ],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cycle_detected')
  })

  it('rejects a longer cycle through a third node', () => {
    const result = validateCircuitDefinition({
      key: 'cycle-3',
      name: 'Cycle',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'c', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'a', target: 'b' },
        { type: 'dependency', source: 'b', target: 'c' },
        { type: 'trigger', source: 'c', target: 'a' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cycle_detected')
  })

  it('accepts the same graph with the back-edge removed (proves the check actually discriminates)', () => {
    const result = validateCircuitDefinition({
      key: 'no-cycle-3',
      name: 'No Cycle',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'c', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'a', target: 'b' },
        { type: 'dependency', source: 'b', target: 'c' },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

// ── Mandatory rule: reject orphan nodes (unreachable from any entry node) ──
describe('validateCircuitDefinition — orphan rejection', () => {
  it('rejects a node with no path from any entry node', () => {
    const result = validateCircuitDefinition({
      key: 'orphan',
      name: 'Orphan',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'island', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'a', target: 'b' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('orphan_node')
      expect(result.detail).toBe('island')
    }
  })

  it('accepts the same graph once the island is wired to an entry node (proves the check discriminates)', () => {
    const result = validateCircuitDefinition({
      key: 'no-orphan',
      name: 'No Orphan',
      nodes: [
        { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'island', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'a', target: 'b' },
        { type: 'trigger', source: 'a', target: 'island' },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it('a lone node with no edges at all is its own entry node — not an orphan', () => {
    const result = validateCircuitDefinition({
      key: 'lone',
      name: 'Lone',
      nodes: [{ id: 'solo', type: 'step', gate_rule: 'AND', customer_facing: false }],
      edges: [],
    })
    expect(result.ok).toBe(true)
  })
})

// ── Mandatory rule: customer_facing → downstream survey node reachable ─────
describe('validateCircuitDefinition — customer_facing requires a downstream survey', () => {
  it('rejects a customer_facing node with no reachable survey node', () => {
    const result = validateCircuitDefinition({
      key: 'no-survey',
      name: 'No Survey',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'ship', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'checkout', target: 'ship' },
        { type: 'fallback', source: 'checkout', target: 'ship' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('customer_facing_missing_survey')
  })

  it('accepts once a downstream survey node is wired in (proves the check discriminates)', () => {
    const result = validateCircuitDefinition({
      key: 'has-survey',
      name: 'Has Survey',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'ship', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'dependency', source: 'checkout', target: 'ship' },
        { type: 'trigger', source: 'ship', target: 'nps' },
        { type: 'fallback', source: 'checkout', target: 'ship' },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

// ── Mandatory rule: customer_facing → at least one outgoing fallback edge ──
describe('validateCircuitDefinition — customer_facing requires an outgoing fallback edge', () => {
  it('rejects a customer_facing node with a survey reachable but no fallback wire', () => {
    const result = validateCircuitDefinition({
      key: 'no-fallback',
      name: 'No Fallback',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'checkout', target: 'nps' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('customer_facing_missing_fallback')
  })

  it('accepts once an outgoing fallback edge is added (proves the check discriminates)', () => {
    const result = validateCircuitDefinition({
      key: 'has-fallback',
      name: 'Has Fallback',
      nodes: [
        { id: 'checkout', type: 'step', gate_rule: 'AND', customer_facing: true },
        { id: 'nps', type: 'survey', gate_rule: 'AND', customer_facing: false },
        { id: 'recover', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'checkout', target: 'nps' },
        { type: 'fallback', source: 'checkout', target: 'recover' },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

// ── Probe nodes observe; they never gate ────────────────────────────────────
describe('validateCircuitDefinition — probe nodes cannot gate downstream nodes', () => {
  it('rejects a dependency edge sourced from a probe node', () => {
    const result = validateCircuitDefinition({
      key: 'probe-gate',
      name: 'Probe Gate',
      nodes: [
        { id: 'work', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'latency_probe', type: 'probe', gate_rule: 'AND', customer_facing: false },
        { id: 'next', type: 'step', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'work', target: 'latency_probe' },
        { type: 'dependency', source: 'latency_probe', target: 'next' },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('probe_cannot_gate')
  })

  it('accepts the same shape once the probe->next wire is a trigger instead of a dependency (proves the check discriminates)', () => {
    const result = validateCircuitDefinition({
      key: 'probe-observe',
      name: 'Probe Observe',
      nodes: [
        { id: 'work', type: 'step', gate_rule: 'AND', customer_facing: false },
        { id: 'latency_probe', type: 'probe', gate_rule: 'AND', customer_facing: false },
      ],
      edges: [
        { type: 'trigger', source: 'work', target: 'latency_probe' },
      ],
    })
    expect(result.ok).toBe(true)
  })
})
