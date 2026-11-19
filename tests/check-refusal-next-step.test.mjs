// tests/check-refusal-next-step.test.mjs — self-tests for the refusal-next-step ratchet
// (scripts/check-refusal-next-step.mjs, mupot 4213349b).
//
// A gate with no tests of its own is the shape these guards exist to reject. This suite
// drives the exported scanners/validators with synthetic fixtures — including a fake new
// refusal that must fail with a clear message, and an allowlist-growth case.
//
// Run: node --test tests/check-refusal-next-step.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanRefusalCodes,
  extractRealNextStepCodes,
  validateRefusalNextStep,
  loadAllowlist,
} from '../scripts/check-refusal-next-step.mjs'

const MIN_TABLE = `
export const GUIDANCE_TABLE: readonly GuidanceEntry[] = [
  { error: 'known_refusal', who_acts: 'self', next_tool: 'boot_context', next_step: 'call boot_context' },
  { error: 'prose_only', who_acts: 'owner', next_step: 'ask a human' },
]
`

function allowlistJson(codes, dated = '2026-11-14') {
  return JSON.stringify({ dated, codes }, null, 2)
}

test('scanRefusalCodes: catches fail(4xx, \'code\') literals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-scan-'))
  try {
    mkdirSync(join(dir, 'mcp'), { recursive: true })
    writeFileSync(join(dir, 'mcp', 'x.ts'), "return fail(403, 'brand_new_refusal_xyz')\n")
    writeFileSync(join(dir, 'mcp', 'y.ts'), "return fail(400, someVar)\n") // variable — invisible
    const found = scanRefusalCodes(dir)
    assert.equal(found.has('brand_new_refusal_xyz'), true)
    assert.equal(found.size, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanRefusalCodes: catches REST { error: \'code\' }, 4xx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-rest-'))
  try {
    writeFileSync(join(dir, 'routes.ts'), "return c.json({ error: 'rest_code_abc', detail: 1 }, 409)\n")
    const found = scanRefusalCodes(dir)
    assert.equal(found.has('rest_code_abc'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractRealNextStepCodes: requires who_acts AND next_tool', () => {
  const { real, all } = extractRealNextStepCodes(MIN_TABLE)
  assert.equal(real.has('known_refusal'), true)
  assert.equal(real.has('prose_only'), false)
  assert.equal(all.has('prose_only'), true)
})

test('validate: a fake new refusal without a row or allowlist entry fails clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-new-'))
  try {
    mkdirSync(join(dir, 'mcp'), { recursive: true })
    writeFileSync(join(dir, 'mcp', 'x.ts'), "return fail(403, 'brand_new_refusal_xyz')\n")
    writeFileSync(join(dir, 'mcp', 'known.ts'), "return fail(400, 'known_refusal')\n")
    const result = validateRefusalNextStep({
      srcDir: dir,
      guidanceSource: MIN_TABLE,
      allowlistRaw: allowlistJson([]),
      target: { state: 'bootstrap', codes: null },
    })
    assert.equal(result.ok, false)
    const text = result.messages.join('\n')
    assert.match(text, /NEW REFUSAL WITHOUT A NEXT STEP/)
    assert.match(text, /brand_new_refusal_xyz/)
    assert.equal(result.missing.some((m) => m.startsWith('brand_new_refusal_xyz')), true)
    // known_refusal has a real row — not missing
    assert.equal(result.missing.some((m) => m.startsWith('known_refusal')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validate: growing the allowlist fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-grow-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "return fail(400, 'legacy_one')\nreturn fail(400, 'legacy_two')\n")
    const result = validateRefusalNextStep({
      srcDir: dir,
      guidanceSource: MIN_TABLE,
      allowlistRaw: allowlistJson(['legacy_one', 'legacy_two']),
      target: { state: 'compared', codes: new Set(['legacy_one']) },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /ALLOWLIST GREW/)
    assert.match(result.messages.join('\n'), /\+ legacy_two/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validate: allowlisted legacy code with no row passes (bootstrap / shrink-ok)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-ok-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "return fail(400, 'legacy_one')\nreturn fail(403, 'known_refusal')\n")
    const result = validateRefusalNextStep({
      srcDir: dir,
      guidanceSource: MIN_TABLE,
      allowlistRaw: allowlistJson(['legacy_one']),
      target: { state: 'compared', codes: new Set(['legacy_one']) },
    })
    assert.equal(result.ok, true, result.messages.join('\n'))
    assert.deepEqual(result.covered, ['known_refusal'])
    assert.deepEqual(result.allowlisted, ['legacy_one'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validate: stale allowlist entry (code now has a real row) fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-stale-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "return fail(400, 'known_refusal')\n")
    const result = validateRefusalNextStep({
      srcDir: dir,
      guidanceSource: MIN_TABLE,
      allowlistRaw: allowlistJson(['known_refusal']),
      target: { state: 'compared', codes: new Set(['known_refusal']) },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /STALE ALLOWLIST/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadAllowlist: rejects unsorted / bad shapes via validate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-sort-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "return fail(400, 'b_code')\nreturn fail(400, 'a_code')\n")
    const result = validateRefusalNextStep({
      srcDir: dir,
      guidanceSource: MIN_TABLE,
      allowlistRaw: allowlistJson(['b_code', 'a_code']),
      target: { state: 'bootstrap', codes: null },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /SORTED AND UNIQUE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadAllowlist: reads dated codes', () => {
  const parsed = loadAllowlist(allowlistJson(['a', 'b'], '2026-11-14'))
  assert.equal(parsed.dated, '2026-11-14')
  assert.deepEqual(parsed.codes, ['a', 'b'])
})
