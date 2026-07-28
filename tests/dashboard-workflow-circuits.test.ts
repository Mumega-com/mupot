// tests/dashboard-workflow-circuits.test.ts — coverage for the /circuits
// dashboard view (mupot-circuit-state-view flight): the FIRST place a human
// can see live workflow-circuit state ("clear state of workflows") rather
// than only query it through MCP tools.
//
// Pattern: dashboard-routines.test.ts (dashboardApp.fetch against a real
// SQLite-backed D1 harness, requireAuth mocked) + workflow-circuits-service
// .test.ts (real defineCircuit/advanceNode/approveGateEdge drive the fixture,
// not raw SQL — the addon's own state machine builds the data under test, so
// this test cannot pass on a shape advanceNode's own gating would reject).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { installAddon, configureAddon, activateAddon } from '../src/addons/service'
import '../src/addons/workflow-circuits/manifest'
import {
  advanceNode,
  approveGateEdge,
  defineCircuit,
  getCircuitState,
  type WorkflowCircuitActor,
} from '../src/addons/workflow-circuits/service'
import { buildCircuitMermaidDefinition } from '../src/dashboard/workflow-circuits'
import type { CircuitState } from '../src/addons/workflow-circuits/service'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: {
    get: (key: 'auth') => AuthContext | undefined
    set: (key: 'auth', value: AuthContext) => void
    json: (body: unknown, status: 401) => Response
  }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const ADMIN: WorkflowCircuitActor = { id: 'owner-1', role: 'owner' }
const AGENT: WorkflowCircuitActor = { id: 'agent-1', role: 'member' }

function sessions() {
  const values = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = values.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { values.set(key, value) },
    async delete(key: string): Promise<void> { values.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: TENANT, BRAND: 'Mupot',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: TENANT, ...overrides }
}

async function enableWorkflowCircuitsAddon(env: Env) {
  const addonActor = { id: ADMIN.id, role: 'owner' as const }
  const installed = await installAddon(env, addonActor, 'workflow-circuits')
  const configured = await configureAddon(env, addonActor, 'workflow-circuits')
  const activated = await activateAddon(env, addonActor, 'workflow-circuits')
  if (!installed.ok || !configured.ok || !activated.ok) throw new Error('fixture addon activation failed')
}

/** Builds one real circuit exercising every edge type and a spread of
 * done_states, driven entirely through the addon's own service functions
 * (defineCircuit/advanceNode/approveGateEdge) — never a raw INSERT into the
 * addon's own tables, so the fixture can only reach states the addon's own
 * gating logic actually allows.
 *
 * Graph: intake --dependency--> review <--gate-- compliance_check
 *        review --trigger--> notify        review --fallback--> recover
 *        audit (standalone)
 *
 * End state: intake=done, compliance_check=blocked, review=degraded
 * (dependency AND gate both satisfied — gate approved explicitly, independent
 * of compliance_check's own blocked state, proving "gate not router"),
 * notify=pending (trigger never fired — review never reached 'done'),
 * recover=pending (fallback never fired — review never reached failed/
 * timeout), audit=failed (standalone). Five of the seven done_states appear
 * in one real, gate-consistent fixture. */
async function buildFixtureCircuit(env: Env): Promise<string> {
  const defined = await defineCircuit(env, ADMIN, {
    key: 'onboarding-circuit',
    name: 'Onboarding Circuit',
    nodes: [
      { id: 'intake', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'compliance_check', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'review', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'notify', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'recover', type: 'step', gate_rule: 'AND', customer_facing: false },
      { id: 'audit', type: 'step', gate_rule: 'AND', customer_facing: false },
    ],
    edges: [
      { type: 'dependency', source: 'intake', target: 'review' },
      { type: 'gate', source: 'compliance_check', target: 'review' },
      { type: 'trigger', source: 'review', target: 'notify' },
      { type: 'fallback', source: 'review', target: 'recover' },
      // 'audit' has no other wire — a fully disconnected node is rejected as
      // an orphan by validateCircuitDefinition's reachability rule, so this
      // dependency edge just keeps it a legitimate entry node. It carries no
      // side effect on the fixture sequence below: dependency edges don't
      // auto-fire, and 'recover' is never advanced to 'active' in this
      // fixture, so this extra required wire on 'recover' is simply never
      // evaluated.
      { type: 'dependency', source: 'audit', target: 'recover' },
    ],
  })
  if (!defined.ok) throw new Error(`fixture defineCircuit failed: ${defined.reason}`)
  const circuitId = defined.circuit.id

  const step = async (nodeId: string, state: string) => {
    const result = await advanceNode(env, AGENT, circuitId, nodeId, state)
    if (!result.ok) throw new Error(`fixture advanceNode(${nodeId} -> ${state}) failed: ${result.reason}`)
  }

  await step('intake', 'active')
  await step('intake', 'done')
  await step('compliance_check', 'active')
  await step('compliance_check', 'blocked')

  const beforeApproval = await getCircuitState(env, circuitId)
  const gateEdge = beforeApproval?.edges.find((edge) => edge.type === 'gate' && edge.source === 'compliance_check')
  if (!gateEdge) throw new Error('fixture: gate edge not found')
  const approved = await approveGateEdge(env, ADMIN, circuitId, gateEdge.id)
  if (!approved.ok) throw new Error(`fixture approveGateEdge failed: ${approved.reason}`)

  await step('review', 'active')
  await step('review', 'degraded')
  await step('audit', 'active')
  await step('audit', 'failed')

  return circuitId
}

function jsonScript(body: string, id: string): unknown {
  const match = body.match(new RegExp(`<script type="application/json" id="${id}">([^<]*)</script>`))
  if (!match) throw new Error(`missing JSON script ${id}`)
  return JSON.parse(match[1])
}

describe('GET /circuits (list)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders known circuits with name, key, status, node count, and a link into the detail page', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await enableWorkflowCircuitsAddon(env)
    const circuitId = await buildFixtureCircuit(env)
    authState.current = actor()

    const response = await dashboardApp.fetch(new Request('https://pot.test/circuits'), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Onboarding Circuit')
    expect(body).toContain('onboarding-circuit')
    expect(body).toContain('Defined')
    // 6 nodes defined in the fixture graph.
    expect(body).toMatch(/circuit-cell">6</)
    expect(body).toContain(`href="/circuits/${circuitId}"`)
  })

  it('renders an honest empty state when no circuits are defined', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    authState.current = actor()

    const response = await dashboardApp.fetch(new Request('https://pot.test/circuits'), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('No circuits are defined yet.')
  })

  it('redirects unauthenticated requests to /auth/login instead of leaking a 401 JSON body', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    authState.current = null

    const response = await dashboardApp.fetch(new Request('https://pot.test/circuits'), env)
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(response.headers.get('location')).toBe('/auth/login')
  })
})

describe('GET /circuits/:id (detail)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders the correct node done_states, edge types, and gate approval', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await enableWorkflowCircuitsAddon(env)
    const circuitId = await buildFixtureCircuit(env)
    authState.current = actor()

    const response = await dashboardApp.fetch(new Request(`https://pot.test/circuits/${circuitId}`), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Onboarding Circuit')
    // Every node's exact done_state label is present (pill text).
    for (const label of ['Done', 'Blocked', 'Degraded', 'Pending', 'Failed']) {
      expect(body).toContain(`>${label}<`)
    }
    // Every edge type appears in the edges table.
    for (const type of ['dependency', 'gate', 'trigger', 'fallback']) {
      expect(body).toMatch(new RegExp(`circuit-cell">${type}<`))
    }
    // Gate approval is rendered explicitly, with the approving actor id.
    expect(body).toContain('Approved')
    expect(body).toContain(ADMIN.id)
    // Non-graphical fallback: the node/edge tables always render server-side,
    // never gated behind JS (the diagram container is a progressive layer on top).
    expect(body).toContain('role="region" aria-label="Circuit nodes"')
    expect(body).toContain('role="region" aria-label="Circuit edges"')
    // Vendored (not CDN) Mermaid + explicit strict security level.
    expect(body).toContain('<script src="/vendor/mermaid.min.js"></script>')
    expect(body).toContain("securityLevel: 'strict'")
    expect(body).not.toContain('cdn.jsdelivr.net')
    expect(body).not.toContain('unpkg.com')

    // The embedded Mermaid definition matches the pure generator's own output
    // for this exact circuit state — pins the mechanism, not just presence.
    const state = await getCircuitState(env, circuitId)
    expect(state).not.toBeNull()
    const embeddedDefinition = jsonScript(body, 'circuit-mermaid-definition')
    expect(embeddedDefinition).toBe(buildCircuitMermaidDefinition(state as CircuitState))
    expect(embeddedDefinition).toContain('flowchart TD')
    expect(embeddedDefinition).toContain('gate: satisfied')
    expect(embeddedDefinition).toContain('|trigger|')
    expect(embeddedDefinition).toContain('|fallback|')
  })

  it('renders a circuit with zero nodes without crashing', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await enableWorkflowCircuitsAddon(env)
    // Zero-node circuits are unreachable through defineCircuit's own
    // validation (nodes must be non-empty) — insert directly to exercise the
    // route's defensive path a future direct-DB edit (or a bug elsewhere)
    // could otherwise crash on.
    harness.sqlite.exec(`
      INSERT INTO workflow_circuits (id, tenant, key, name, status, definition_sha256, created_by, created_at)
      VALUES ('circuit-empty', 'tenant-a', 'empty-circuit', 'Empty Circuit', 'defined', '${'a'.repeat(64)}', 'owner-1', '2026-07-28T00:00:00.000Z');
    `)
    authState.current = actor()

    const response = await dashboardApp.fetch(new Request('https://pot.test/circuits/circuit-empty'), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Empty Circuit')
    expect(body).toContain('This circuit has no nodes.')
    expect(body).toContain('This circuit has no edges.')
    const embeddedDefinition = jsonScript(body, 'circuit-mermaid-definition')
    expect(embeddedDefinition).toBe('flowchart TD')
  })

  it('returns 404 (not a crash) for an unknown circuit id', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await enableWorkflowCircuitsAddon(env)
    authState.current = actor()

    const response = await dashboardApp.fetch(new Request('https://pot.test/circuits/does-not-exist'), env)
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toContain('No circuit with id')
    expect(body).toContain('does-not-exist')
  })

  it('redirects unauthenticated requests to /auth/login', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await enableWorkflowCircuitsAddon(env)
    const circuitId = await buildFixtureCircuit(env)
    authState.current = null

    const response = await dashboardApp.fetch(new Request(`https://pot.test/circuits/${circuitId}`), env)
    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(response.headers.get('location')).toBe('/auth/login')
  })
})

describe('buildCircuitMermaidDefinition (pure)', () => {
  function state(overrides: Partial<CircuitState> = {}): CircuitState {
    return {
      id: 'c1', tenant: 'tenant-a', key: 'k', name: 'N', status: 'defined',
      nodes: [], edges: [], ...overrides,
    }
  }

  it('produces a bare flowchart for a circuit with no nodes (never crashes)', () => {
    expect(buildCircuitMermaidDefinition(state())).toBe('flowchart TD')
  })

  it('emits solid arrows for dependency, dashed-with-label for gate (satisfied/unsatisfied), solid-labeled for trigger, dashed-labeled for fallback', () => {
    const circuit = state({
      nodes: [
        { id: 'a', type: 'step', done_state: 'done', gate_rule: 'AND', customer_facing: false, required_wires: [] },
        { id: 'b', type: 'step', done_state: 'pending', gate_rule: 'AND', customer_facing: false, required_wires: [] },
        { id: 'c', type: 'step', done_state: 'pending', gate_rule: 'AND', customer_facing: false, required_wires: [] },
        { id: 'd', type: 'step', done_state: 'pending', gate_rule: 'AND', customer_facing: false, required_wires: [] },
        { id: 'e', type: 'step', done_state: 'pending', gate_rule: 'AND', customer_facing: false, required_wires: [] },
      ],
      edges: [
        { id: 'e1', type: 'dependency', source: 'a', target: 'b', approved_by: null, approved_at: null },
        { id: 'e2', type: 'gate', source: 'a', target: 'c', approved_by: null, approved_at: null },
        { id: 'e3', type: 'gate', source: 'a', target: 'd', approved_by: 'owner-1', approved_at: '2026-07-28T00:00:00.000Z' },
        { id: 'e4', type: 'trigger', source: 'a', target: 'e', approved_by: null, approved_at: null },
        { id: 'e5', type: 'fallback', source: 'a', target: 'b', approved_by: null, approved_at: null },
      ],
    })
    const definition = buildCircuitMermaidDefinition(circuit)

    expect(definition).toMatch(/n0 --> n1\n/) // dependency: solid, unlabeled
    expect(definition).toContain('n0 -.->|gate: unsatisfied| n2') // gate, not approved
    expect(definition).toContain('n0 -.->|gate: satisfied| n3') // gate, approved
    expect(definition).toContain('n0 -->|trigger| n4') // trigger: solid, labeled
    expect(definition).toContain('n0 -.->|fallback| n1') // fallback: dashed, labeled
    // Distinct dash patterns for gate vs fallback (both use -.-> but must not
    // collapse to the same visual — brief requires dashed vs dotted).
    const linkStyleLines = definition.split('\n').filter((line) => line.trim().startsWith('linkStyle'))
    expect(linkStyleLines).toHaveLength(5)
    expect(linkStyleLines[1]).toContain('stroke-dasharray:6,4') // gate (unsatisfied)
    expect(linkStyleLines[2]).toContain('stroke-dasharray:6,4') // gate (satisfied)
    expect(linkStyleLines[4]).toContain('stroke-dasharray:1,4') // fallback
    expect(linkStyleLines[1]).not.toBe(linkStyleLines[4])
  })

  it('assigns a distinct classDef fill per done_state bucket, with failed and timeout sharing one bucket', () => {
    const circuit = state({
      nodes: (['pending', 'active', 'done', 'blocked', 'failed', 'timeout', 'degraded'] as const).map((doneState, index) => ({
        id: `n${index}`, type: 'step', done_state: doneState, gate_rule: 'AND', customer_facing: false, required_wires: [],
      })),
      edges: [],
    })
    const definition = buildCircuitMermaidDefinition(circuit)

    expect(definition).toContain('classDef st_done fill:#3fb950')
    expect(definition).toContain('classDef st_active fill:#d29922')
    expect(definition).toContain('classDef st_blocked fill:#6b7685')
    expect(definition).toContain('classDef st_failed fill:#f85149')
    expect(definition).toContain('classDef st_timeout fill:#f85149')
    expect(definition).toContain('classDef st_degraded fill:#db6d28')
    expect(definition).toContain('classDef st_pending fill:#2a3140')
    // failed and timeout are literally the SAME fill (one visual bucket).
    const failedFill = definition.match(/classDef st_failed fill:(#[0-9a-f]+)/)?.[1]
    const timeoutFill = definition.match(/classDef st_timeout fill:(#[0-9a-f]+)/)?.[1]
    expect(failedFill).toBe(timeoutFill)
    // degraded is visually distinct from active (both are otherwise "amber-ish" in the brief's fallback wording).
    const activeFill = definition.match(/classDef st_active fill:(#[0-9a-f]+)/)?.[1]
    const degradedFill = definition.match(/classDef st_degraded fill:(#[0-9a-f]+)/)?.[1]
    expect(activeFill).not.toBe(degradedFill)
  })

  it('skips an edge referencing an unknown node id rather than emitting a dangling reference', () => {
    const circuit = state({
      nodes: [{ id: 'a', type: 'step', done_state: 'pending', gate_rule: 'AND', customer_facing: false, required_wires: [] }],
      edges: [{ id: 'e1', type: 'dependency', source: 'a', target: 'ghost', approved_by: null, approved_at: null }],
    })
    expect(() => buildCircuitMermaidDefinition(circuit)).not.toThrow()
    const definition = buildCircuitMermaidDefinition(circuit)
    expect(definition).not.toContain('ghost')
    expect(definition.split('\n').some((line) => line.trim().startsWith('linkStyle'))).toBe(false)
  })

  it('escapes quotes, pipes, and newlines in a free-text node type before it reaches the Mermaid DSL', () => {
    const circuit = state({
      nodes: [{
        id: 'a', type: 'x"];classDef pwn fill:red\n|evil|', done_state: 'pending',
        gate_rule: 'AND', customer_facing: false, required_wires: [],
      }],
      edges: [],
    })
    const definition = buildCircuitMermaidDefinition(circuit)
    expect(definition).not.toContain('x"];classDef pwn')
    expect(definition).not.toContain('\n|evil|')
    expect(definition).toContain('&quot;')
  })
})
