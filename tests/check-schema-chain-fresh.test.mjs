// tests/check-schema-chain-fresh.test.mjs — self-tests for
// scripts/check-schema-chain-fresh.mjs (mupot#1285 Tier C slice 1).
//
// Guard self-tests FIRST, same discipline as the sibling guards (test-schema-source,
// mcp-tool-seam, migration-numbering): a gate with no tests of its own is the shape these
// guards exist to reject.
//
// Run: node --test tests/check-schema-chain-fresh.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSchemaChainFresh } from '../scripts/check-schema-chain-fresh.mjs'
import { generateSchemaChainModule } from '../scripts/gen-schema-chain.mjs'

test('checkSchemaChainFresh: ok when current content matches generate() output exactly', () => {
  const generate = () => 'export const SCHEMA_CHAIN = []\n'
  const result = checkSchemaChainFresh(generate, 'export const SCHEMA_CHAIN = []\n')
  assert.equal(result.ok, true)
})

test('checkSchemaChainFresh: NOT ok when current content differs from generate() output', () => {
  const generate = () => 'export const SCHEMA_CHAIN = [1]\n'
  const result = checkSchemaChainFresh(generate, 'export const SCHEMA_CHAIN = [1, 2]\n')
  assert.equal(result.ok, false)
  assert.equal(typeof result.firstDiffLine, 'number')
})

test('checkSchemaChainFresh: reports the first differing line number, not just "different"', () => {
  const generate = () => 'line1\nline2\nline3\n'
  const result = checkSchemaChainFresh(generate, 'line1\nDIFFERENT\nline3\n')
  assert.equal(result.ok, false)
  assert.equal(result.firstDiffLine, 2)
})

test('checkSchemaChainFresh: length-only difference (extra trailing line) is still caught', () => {
  const generate = () => 'line1\nline2\n'
  const result = checkSchemaChainFresh(generate, 'line1\nline2\nline3\n')
  assert.equal(result.ok, false)
})

// ── repo invariant: the REAL generated module, as committed, is fresh right now ────────
//
// This is the guard's own dogfood check — if this fails, either the committed
// schema-chain.generated.ts is stale (someone edited migrations/ without regenerating) or
// the generator itself is non-deterministic. Either way it belongs in the guard's own
// self-tests, not just as a separate CI step, so a broken generator is caught here too.

test('checkSchemaChainFresh: the REAL committed schema-chain.generated.ts is fresh', async () => {
  const { readFileSync } = await import('node:fs')
  const { DEFAULT_OUTPUT_FILE } = await import('../scripts/gen-schema-chain.mjs')
  const current = readFileSync(DEFAULT_OUTPUT_FILE, 'utf8')
  const result = checkSchemaChainFresh(generateSchemaChainModule, current)
  assert.equal(
    result.ok,
    true,
    `schema-chain.generated.ts is stale — run \`npm run gen:schema-chain\` (first diff at line ${result.firstDiffLine})`,
  )
})
