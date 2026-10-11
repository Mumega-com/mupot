// tests/seed-v1-patterns.test.ts — the seed validator's secret patterns and scripts/no-secrets.mjs
// must stay in step. no-secrets.mjs is a node CLI (not importable), so its `rules` literal is read
// and evaluated here. A pattern added to EITHER side fails until it is classified below.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SECRET_VALUE_PATTERNS, validateSeed } from '../src/seeds/validate'

const src = readFileSync(join(__dirname, '..', 'scripts', 'no-secrets.mjs'), 'utf8')
const literal = src.slice(src.indexOf('const rules = [') + 'const rules = '.length, src.indexOf('\nfunction parseRoot'))
// eslint-disable-next-line no-new-func -- test-only: evaluates the repo's own rules literal
const rules = new Function(`return ${literal}`)() as Array<{ label: string; pattern: RegExp }>

const J = (...p: string[]) => p.join('')
// Samples every shared pattern must flag in BOTH places. Built from parts so this file is not itself a hit.
const SHARED: Array<[string, string]> = [
  ['OpenAI', J('sk', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2')],
  ['GitHub ghp', J('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3')],
  ['GitHub other', J('gho', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3')],
  ['JWT', [J('eyJ', 'hbGciOiJIUzI1NiJ9'), J('eyJ', 'zdWIiOiIxMjM0NTY3'), 'abcdefghij1234567'].join('.')],
  ['private key', J('-----BEGIN ', 'RSA PRIVATE', ' KEY-----')],
]
// Validator-only patterns (deliberately not repo-wide: they would flag ordinary repo text).
const VALIDATOR_ONLY = ['AWS access key id', 'Slack token', 'bearer credential', 'Google API key', 'Stripe-style key', 'GitLab token', 'credential in query or assignment', 'URL with embedded credentials']
const VALIDATOR_SHARED = ['OpenAI-style key', 'GitHub token', 'JWT', 'private key block']

describe('validator and no-secrets patterns stay in step', () => {
  it('`rules` is defined once and never mutated after the literal', () => {
    expect(src.match(/\brules\b\s*=/g)?.length).toBe(1)
    expect(src).not.toMatch(/\brules\s*\.\s*(push|unshift|splice|pop|shift|length)|\brules\s*\[[^\]]*\]\s*=/)
    expect(src.match(/const rules = \[/g)?.length).toBe(1)
  })
  it('parsed the no-secrets rules', () => expect(rules.length).toBeGreaterThanOrEqual(5))
  it('every validator pattern is classified (new pattern => fail until classified)', () => {
    expect(SECRET_VALUE_PATTERNS.map((p) => p.label).sort()).toEqual([...VALIDATOR_SHARED, ...VALIDATOR_ONLY].sort())
  })
  it('every no-secrets rule is covered by a shared sample', () => {
    for (const r of rules) expect(SHARED.some(([, s]) => r.pattern.test(s)), r.label).toBe(true)
  })
  it.each(SHARED)('shared sample %s is flagged by both no-secrets and the validator', async (_l, sample) => {
    expect(rules.some((r) => r.pattern.test(sample))).toBe(true)
    expect(SECRET_VALUE_PATTERNS.some((p) => p.re.test(sample))).toBe(true)
    const r = await validateSeed(`schema: mupot.seed/v1\nslug: s\nname: n\nkind: repo\ngoal: g\nowner: o\nrepo: "${sample}"\n`)
    expect(r.ok).toBe(false)
  })
})
