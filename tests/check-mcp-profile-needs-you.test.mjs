// tests/check-mcp-profile-needs-you.test.mjs — self-tests for scripts/check-mcp-profile-needs-you.mjs.
// Run: node --test tests/check-mcp-profile-needs-you.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extractProfileEntries,
  validateProfile,
  checkProfileWiring,
} from '../scripts/check-mcp-profile-needs-you.mjs'

const good = (name) =>
  `{ name: '${name}', annotations: { title: 'T', readOnlyHint: true, destructiveHint: false, openWorldHint: false } }`
const src = (...items) => `export const NEEDS_YOU_PROFILE: readonly ProfileToolEntry[] = [ ${items.join(',')} ]`
const registry = new Map([
  ['orient', { min: 'authenticated', file: 'a.ts' }],
  ['task_list', { min: 'member', file: 'a.ts' }],
  ['send', { min: 'member', file: 'a.ts' }],
  ['grant_agent_capability', { min: 'admin', file: 'a.ts' }],
  ['lookup_thing', { min: 'lead', file: 'a.ts' }],
])
const check = (source) => validateProfile(registry, extractProfileEntries(source))

test('a clean profile passes every check', () => {
  const v = check(src(good('orient'), good('task_list')))
  assert.deepEqual(
    [v.unresolved, v.unknown, v.tooHigh, v.writeNamed, v.badAnnotations, v.duplicates],
    [[], [], [], [], [], []],
  )
  assert.equal(v.unsorted, false)
})

test('adding a write tool (send) fails: write-named', () => {
  assert.deepEqual(check(src(good('orient'), good('send'))).writeNamed, ['send'])
})

test('adding an admin tool fails: too-high and write-named', () => {
  const v = check(src(good('grant_agent_capability'), good('orient')))
  assert.equal(v.tooHigh[0].name, 'grant_agent_capability')
  assert.deepEqual(v.writeNamed, ['grant_agent_capability'])
})

test('a lead-tier read-shaped tool fails on the min ceiling alone', () => {
  assert.equal(check(src(good('lookup_thing'))).tooHigh[0].name, 'lookup_thing')
})

test('unknown tool fails', () => {
  assert.deepEqual(check(src(good('nope_tool'))).unknown, ['nope_tool'])
})

test('missing, false-readOnly, destructive, openWorld, or title-less annotations fail', () => {
  const bad = [
    `{ name: 'orient' }`,
    `{ name: 'orient', annotations: { title: 'T', readOnlyHint: false, destructiveHint: false, openWorldHint: false } }`,
    `{ name: 'orient', annotations: { title: 'T', readOnlyHint: true, destructiveHint: true, openWorldHint: false } }`,
    `{ name: 'orient', annotations: { title: 'T', readOnlyHint: true, destructiveHint: false, openWorldHint: true } }`,
    `{ name: 'orient', annotations: { title: '', readOnlyHint: true, destructiveHint: false, openWorldHint: false } }`,
    `{ name: 'orient', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }`,
  ]
  for (const b of bad) assert.deepEqual(check(src(b)).badAnnotations, ['orient'], b)
})

test('non-literal entries are unresolved (fail closed), not skipped', () => {
  const v = check(`const X = 'orient'; export const NEEDS_YOU_PROFILE = [ { name: X, annotations: {} } ]`)
  assert.equal(v.unresolved.length, 1)
})

test('unsorted and duplicate entries fail', () => {
  assert.equal(check(src(good('task_list'), good('orient'))).unsorted, true)
  assert.deepEqual(check(src(good('orient'), good('orient'))).duplicates, ['orient'])
})

test('missing array returns null', () => {
  assert.equal(extractProfileEntries('export const OTHER = []'), null)
})

test('wiring: real src/mcp/index.ts passes', () => {
  const w = checkProfileWiring(readFileSync(new URL('../src/mcp/index.ts', import.meta.url), 'utf8'))
  assert.deepEqual(w, { handlerFound: true, callsProfileEntry: true, callsProfileToolList: true, routeFound: true, routePassesMode: true })
})

test('wiring: removing the allowlist refusal or the route mode is detected', () => {
  const real = readFileSync(new URL('../src/mcp/index.ts', import.meta.url), 'utf8')
  const noEntry = real.replace('!profileEntry(params.name)', 'false')
  assert.equal(checkProfileWiring(noEntry).callsProfileEntry, false)
  const noMode = real.replace("handleJsonRpc(c, body, 'needs-you')", 'handleJsonRpc(c, body)')
  assert.equal(checkProfileWiring(noMode).routePassesMode, false)
})
