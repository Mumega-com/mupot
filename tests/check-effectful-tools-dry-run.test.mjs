// tests/check-effectful-tools-dry-run.test.mjs — self-tests for scripts/check-effectful-tools-dry-run.mjs.
// Run: node --test tests/check-effectful-tools-dry-run.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyzeToolSource, parseAnnotationKinds, validate } from '../scripts/check-effectful-tools-dry-run.mjs'

const tool = (name, runBody, schemaExtra = '') => `
const toolX: ToolSpec = {
  name: '${name}',
  min: 'member',
  inputSchema: { type: 'object', properties: { dry_run: { type: 'boolean'${schemaExtra} } } },
  async run(auth, env, args) { ${runBody} },
}`
const kinds = (name, kind) => new Map([[name, kind]])
const check = (src, name = 'fx_tool', kind = 'ADD', allow = new Map()) =>
  validate([{ file: 'a.ts', ...analyzeToolSource(src) }], kinds(name, kind), allow)

test('default-dry forms pass: !== false and === false', () => {
  assert.deepEqual(check(tool('fx_tool', 'const dry = args.dry_run !== false')), [])
  assert.deepEqual(check(tool('fx_tool', 'const apply = args.dry_run === false')), [])
})

test('validation-only reads (typeof, undefined) are ignored next to a real default', () => {
  const body = `if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return 1
    const dry = args.dry_run !== false`
  assert.deepEqual(check(tool('fx_tool', body)), [])
})

test('MUTATION: default-to-acting forms fail for an effectful tool', () => {
  for (const body of [
    'const dry = args.dry_run === true',
    'const dry = args.dry_run ?? false',
    'const dry = Boolean(args.dry_run)',
    'if (args.dry_run) return 1',
    'const dry = !!args.dry_run',
    'const dry = args.dry_run || false',
  ]) {
    assert.notDeepEqual(check(tool('fx_tool', body)), [], body)
  }
})

test('MUTATION: a tool that never reads dry_run back cannot prove its default', () => {
  const problems = check(tool('fx_tool', 'return 1'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cannot be proven/)
})

test('MUTATION: schema default:false fails even with a correct run body', () => {
  const problems = check(tool('fx_tool', 'const dry = args.dry_run !== false', ', default: false'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /default:false/)
})

test('a read-only tool is exempt; an unannotated tool fails closed', () => {
  assert.deepEqual(check(tool('fx_tool', 'const dry = args.dry_run === true'), 'fx_tool', 'RO'), [])
  const unannotated = validate([{ file: 'a.ts', ...analyzeToolSource(tool('fx_tool', 'return 1')) }], new Map(), new Map())
  assert.match(unannotated[0], /no annotation row/)
})

test('allow-list: justified exemption passes; stale and redundant entries fail', () => {
  const bad = tool('fx_tool', 'const dry = args.dry_run === true')
  assert.deepEqual(check(bad, 'fx_tool', 'ADD', new Map([['fx_tool', 'human-only apply']])), [])
  const redundant = check(tool('fx_tool', 'const dry = args.dry_run !== false'), 'fx_tool', 'ADD', new Map([['fx_tool', 'x']]))
  assert.match(redundant[0], /already compliant/)
  const stale = check(tool('fx_tool', 'const dry = args.dry_run !== false'), 'fx_tool', 'ADD', new Map([['gone', 'x']]))
  assert.match(stale[0], /matches no tool/)
})

test('a dry_run schema property outside any ToolSpec declaration is UNATTRIBUTED', () => {
  const src = `const schema = { type: 'object', properties: { dry_run: { type: 'boolean' } } }`
  const problems = validate([{ file: 'a.ts', ...analyzeToolSource(src) }], new Map(), new Map())
  assert.match(problems[0], /not attached to a recognised ToolSpec/)
})

test('comments and strings cannot satisfy or trip the check', () => {
  const body = `// args.dry_run !== false
    const s = 'args.dry_run !== false'
    const dry = args.dry_run === true`
  assert.notDeepEqual(check(tool('fx_tool', body)), [])
})

test('the committed registry passes (router_tick and seed_attach default to the dry run)', () => {
  const annotations = parseAnnotationKinds(readFileSync(new URL('../src/mcp/tool-annotations.ts', import.meta.url), 'utf8'))
  assert.ok(annotations.size > 100)
  for (const f of ['index.ts', 'seed.ts']) {
    const a = analyzeToolSource(readFileSync(new URL(`../src/mcp/${f}`, import.meta.url), 'utf8'), f)
    assert.deepEqual(validate([{ file: f, ...a }], annotations, new Map()).filter((p) => !p.includes('matches no tool')), [])
  }
})
