// tests/mcp-workflow-circuit-tools.test.ts — proves the workflow-circuits
// domain functions (tested directly in tests/workflow-circuits-service.test.ts)
// are actually reachable over the real MCP dispatch chokepoint (invokeTool,
// src/mcp/index.ts), with the same capability-floor + identity-attribution
// guarantees every other tool gets — not just callable as bare functions.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { activateAddon, configureAddon, installAddon } from '../src/addons/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
  '../migrations/0075_workflow_circuits.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

async function makeEnv(): Promise<Env> {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
  const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  const actor = { id: 'owner-1', role: 'owner' as const }
  const installed = await installAddon(env, actor, 'workflow-circuits')
  const configured = await configureAddon(env, actor, 'workflow-circuits')
  const activated = await activateAddon(env, actor, 'workflow-circuits')
  if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
  return env
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

const orgAdmin = auth('admin-member', [grant('admin', 'org', null)])
const plainMember = auth('agent-member', [grant('member', 'org', null)])
const grantlessMember = auth('grantless-member', [])

describe('workflow-circuits MCP tools — registry', () => {
  it('all four tools are registered with the documented min', () => {
    const expected: Record<string, string> = {
      define_circuit: 'admin',
      advance_node: 'member',
      get_circuit_state: 'member',
      approve_gate_edge: 'member',
    }
    for (const [name, min] of Object.entries(expected)) {
      const spec = TOOLS.find((t) => t.name === name)
      expect(spec, `${name} should be registered`).toBeDefined()
      expect(spec?.min).toBe(min)
    }
  })
})

describe('workflow-circuits MCP tools — end-to-end over invokeTool', () => {
  it('define_circuit → advance_node → get_circuit_state round-trips through the real dispatch chokepoint', async () => {
    const env = await makeEnv()

    const defineOutcome = await invokeTool(orgAdmin, env, 'define_circuit', {
      definition: {
        key: 'mcp-roundtrip',
        name: 'MCP Roundtrip',
        nodes: [
          { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
          { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        ],
        edges: [{ type: 'dependency', source: 'a', target: 'b' }],
      },
    }, ORIGIN)
    expect(defineOutcome.ok).toBe(true)
    const circuitId = (defineOutcome as { result: { circuit: { id: string } } }).result.circuit.id

    // 'b' cannot go active until 'a' is done — enforced through the MCP tool, not bypassed.
    const early = await invokeTool(plainMember, env, 'advance_node', { circuit_id: circuitId, node_id: 'b', new_state: 'active' }, ORIGIN)
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.error).toBe('gate_not_satisfied')

    expect((await invokeTool(plainMember, env, 'advance_node', { circuit_id: circuitId, node_id: 'a', new_state: 'active' }, ORIGIN)).ok).toBe(true)
    expect((await invokeTool(plainMember, env, 'advance_node', { circuit_id: circuitId, node_id: 'a', new_state: 'done' }, ORIGIN)).ok).toBe(true)
    expect((await invokeTool(plainMember, env, 'advance_node', { circuit_id: circuitId, node_id: 'b', new_state: 'active' }, ORIGIN)).ok).toBe(true)

    const stateOutcome = await invokeTool(plainMember, env, 'get_circuit_state', { circuit_id: circuitId }, ORIGIN)
    expect(stateOutcome.ok).toBe(true)
    const state = (stateOutcome as { result: { circuit: { nodes: Array<{ id: string; done_state: string }> } } }).result.circuit
    expect(state.nodes.find((n) => n.id === 'a')?.done_state).toBe('done')
    expect(state.nodes.find((n) => n.id === 'b')?.done_state).toBe('active')
  })

  it('define_circuit rejects a grantless caller at the capability floor before the handler runs', async () => {
    const env = await makeEnv()
    const outcome = await invokeTool(grantlessMember, env, 'define_circuit', {
      definition: { key: 'x', name: 'X', nodes: [{ id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false }], edges: [] },
    }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.status).toBe(403)
  })

  it('define_circuit rejects an invalid definition (cycle) through the MCP tool with the structural reason surfaced', async () => {
    const env = await makeEnv()
    const outcome = await invokeTool(orgAdmin, env, 'define_circuit', {
      definition: {
        key: 'mcp-cycle',
        name: 'MCP Cycle',
        nodes: [
          { id: 'a', type: 'step', gate_rule: 'AND', customer_facing: false },
          { id: 'b', type: 'step', gate_rule: 'AND', customer_facing: false },
        ],
        edges: [
          { type: 'dependency', source: 'a', target: 'b' },
          { type: 'dependency', source: 'b', target: 'a' },
        ],
      },
    }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('cycle_detected')
  })

  it('advance_node rejects an attacker-supplied identity-shaped field before the handler runs', async () => {
    const env = await makeEnv()
    const outcome = await invokeTool(plainMember, env, 'advance_node', {
      circuit_id: 'whatever', node_id: 'whatever', new_state: 'active', actor_id: 'someone-else',
    }, ORIGIN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(400)
      expect(outcome.error).toBe('invalid_args')
    }
  })
})
