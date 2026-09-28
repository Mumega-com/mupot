// tests/check-openapi-public-allowlist.test.mjs — self-tests for the openapi-public-allowlist
// ratchet (mupot#1596). Same discipline as tests/check-mcp-tool-seam.test.mjs and the other
// ratchet self-tests: a gate with no tests of its own is the shape these guards exist to
// reject.
//
// Run: node --test tests/check-openapi-public-allowlist.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractToolSpecs,
  extractStringArrayExport,
  publicRouteUsesGuardedSpec,
  validatePublicAllowlist,
  UNRESOLVED_MIN,
} from '../scripts/check-openapi-public-allowlist.mjs'

// ── extractToolSpecs ─────────────────────────────────────────────────────────────────────

test('extractToolSpecs: reads name and min from a plain ToolSpec declaration', () => {
  const src = `
    const toolFoo: ToolSpec = {
      name: 'foo_bar',
      scope: 'test scope',
      min: 'member',
      args: '{}',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() { return done({}) },
    }
  `
  const specs = extractToolSpecs(src)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'foo_bar')
  assert.equal(specs[0].min, 'member')
})

test('extractToolSpecs: ignores const declarations not typed ToolSpec', () => {
  const src = `
    const notATool = { name: 'sneaky', min: 'admin' }
    const alsoNot: SomethingElse = { name: 'sneaky2', min: 'admin' }
  `
  assert.deepEqual(extractToolSpecs(src), [])
})

test('extractToolSpecs: only reads DEPTH-1 properties — a nested inputSchema.properties.name/min never counts', () => {
  const src = `
    const toolWeird: ToolSpec = {
      name: 'weird_tool',
      min: 'observer',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, min: { type: 'number' } },
        additionalProperties: false,
      },
    }
  `
  const specs = extractToolSpecs(src)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'weird_tool')
  assert.equal(specs[0].min, 'observer')
})

test('extractToolSpecs: a non-literal min is UNRESOLVED, not silently skipped or mis-typed', () => {
  const src = `
    const SOME_MIN = 'admin'
    const toolDynamic: ToolSpec = {
      name: 'dynamic_tool',
      min: SOME_MIN,
    }
  `
  const specs = extractToolSpecs(src)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].min, UNRESOLVED_MIN)
})

test('extractToolSpecs: a factory-returned object literal (shorthand name property) is invisible, not mis-extracted', () => {
  // Mirrors src/mcp/routines.ts's lifecycle() factory exactly — see the script's "KNOWN GAP"
  // header comment. The point of this test is to PIN the safe-failure-direction behavior:
  // this must never be silently treated as a real tool named "name".
  const src = `
    function lifecycle(name: 'a' | 'b', op: unknown): ToolSpec {
      return { name, scope: 's', min: 'admin', args: '', inputSchema: {}, run: op }
    }
  `
  assert.deepEqual(extractToolSpecs(src), [])
})

// ── extractStringArrayExport ─────────────────────────────────────────────────────────────

test('extractStringArrayExport: reads a sorted string array export', () => {
  const src = `export const PUBLIC_TOOL_ALLOWLIST: readonly string[] = [\n  'a',\n  'b',\n]\n`
  const result = extractStringArrayExport(src, 'PUBLIC_TOOL_ALLOWLIST')
  assert.deepEqual(result, { ok: true, values: ['a', 'b'] })
})

test('extractStringArrayExport: returns null when the export is not found', () => {
  const src = `export const SOMETHING_ELSE = ['a']`
  assert.equal(extractStringArrayExport(src, 'PUBLIC_TOOL_ALLOWLIST'), null)
})

test('extractStringArrayExport: {ok:false} when an element is not a plain string literal', () => {
  const src = `export const PUBLIC_TOOL_ALLOWLIST = ['a', SOME_VAR, 'c']`
  const result = extractStringArrayExport(src, 'PUBLIC_TOOL_ALLOWLIST')
  assert.equal(result.ok, false)
})

// ── publicRouteUsesGuardedSpec (the structural anti-bypass check) ───────────────────────

test('publicRouteUsesGuardedSpec: true when the route handler calls publicOpenApiSpec(...)', () => {
  const src = `
    mcpActionsApp.get('/openapi.json', (c) => {
      const url = new URL(c.req.url)
      return c.json(publicOpenApiSpec(url.origin))
    })
  `
  assert.deepEqual(publicRouteUsesGuardedSpec(src), { routeFound: true, callsGuarded: true })
})

test('publicRouteUsesGuardedSpec: DISCLOSURE REGRESSION — false when the handler calls openApiSpec(origin, TOOLS, ...) directly', () => {
  const src = `
    mcpActionsApp.get('/openapi.json', (c) => {
      const url = new URL(c.req.url)
      return c.json(openApiSpec(url.origin, TOOLS, 'oops, the whole registry'))
    })
  `
  assert.deepEqual(publicRouteUsesGuardedSpec(src), { routeFound: true, callsGuarded: false })
})

test('publicRouteUsesGuardedSpec: routeFound is false when the route does not exist at all', () => {
  const src = `mcpActionsApp.get('/something-else', (c) => c.json({}))`
  assert.deepEqual(publicRouteUsesGuardedSpec(src), { routeFound: false, callsGuarded: false })
})

// ── validatePublicAllowlist — the core invariant, mutation-proven ───────────────────────

function registryOf(entries) {
  return new Map(Object.entries(entries).map(([name, min]) => [name, { min, file: 'x.ts' }]))
}

test('validatePublicAllowlist: a clean allowlist of member-tier-or-below tools passes every check', () => {
  const registry = registryOf({ task_create: 'member', status: 'authenticated', inbox: 'observer' })
  const result = validatePublicAllowlist(registry, ['inbox', 'status', 'task_create'])
  assert.deepEqual(result, { unknown: [], tooHigh: [], unsorted: false, duplicates: [] })
})

test('MUTATION PROOF (the task-required case): adding an admin tool to the allowlist makes it fail', () => {
  const registry = registryOf({ task_create: 'member', mint_agent_token: 'admin' })
  // Before the mutation: allowlist has only the safe tool.
  const before = validatePublicAllowlist(registry, ['task_create'])
  assert.deepEqual(before.tooHigh, [])
  // The mutation: add the admin tool to the allowlist.
  const after = validatePublicAllowlist(registry, ['mint_agent_token', 'task_create'])
  assert.equal(after.tooHigh.length, 1)
  assert.equal(after.tooHigh[0].name, 'mint_agent_token')
  assert.equal(after.tooHigh[0].min, 'admin')
})

test('validatePublicAllowlist: a lead-tier tool also fails (not just admin) — "above member" means lead+admin+owner', () => {
  const registry = registryOf({ wake_agent: 'lead' })
  const result = validatePublicAllowlist(registry, ['wake_agent'])
  assert.equal(result.tooHigh.length, 1)
  assert.equal(result.tooHigh[0].name, 'wake_agent')
})

test('validatePublicAllowlist: an allowlisted name with no matching ToolSpec is "unknown", not silently dropped', () => {
  const registry = registryOf({ task_create: 'member' })
  const result = validatePublicAllowlist(registry, ['task_create', 'this_tool_does_not_exist'])
  assert.deepEqual(result.unknown, ['this_tool_does_not_exist'])
})

test('validatePublicAllowlist: an unknown name does not ALSO get flagged as tooHigh (it has no real min to compare)', () => {
  const registry = registryOf({ task_create: 'member' })
  const result = validatePublicAllowlist(registry, ['ghost_tool'])
  assert.deepEqual(result.unknown, ['ghost_tool'])
  assert.deepEqual(result.tooHigh, [])
})

test('validatePublicAllowlist: unsorted allowlist is flagged', () => {
  const registry = registryOf({ status: 'authenticated', task_create: 'member' })
  const result = validatePublicAllowlist(registry, ['task_create', 'status'])
  assert.equal(result.unsorted, true)
})

test('validatePublicAllowlist: duplicate entries are flagged by name', () => {
  const registry = registryOf({ status: 'authenticated' })
  const result = validatePublicAllowlist(registry, ['status', 'status'])
  assert.deepEqual(result.duplicates, ['status'])
})

test('validatePublicAllowlist: observer and authenticated tiers are member-tier-or-below, not tooHigh', () => {
  const registry = registryOf({ a: 'authenticated', b: 'observer', c: 'member' })
  const result = validatePublicAllowlist(registry, ['a', 'b', 'c'])
  assert.deepEqual(result.tooHigh, [])
})

test('validatePublicAllowlist: owner tier fails too (the ladder top, in case it is ever used as a min)', () => {
  const registry = registryOf({ super_tool: 'owner' })
  const result = validatePublicAllowlist(registry, ['super_tool'])
  assert.equal(result.tooHigh.length, 1)
})
