// CI guard: a NEW refusal code in src/ must have a Security Bar registry entry (src/policy/registry.ts).
// Today's codes are grandfathered through src/policy/refusal-codes.allowlist.json. Adding to that file is
// the escape hatch of last resort and shows up in review; the intended fix is a registry rule (FLOOR, BAR or,
// for pure input validation, a floor entry that names the code).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registeredRefusalCodes, POLICY_RULES } from '../src/policy/registry'
import { scanRefusalCodes } from './helpers/refusal-codes'

const SRC = join(__dirname, '..', 'src')
const allowlist: string[] = JSON.parse(readFileSync(join(SRC, 'policy', 'refusal-codes.allowlist.json'), 'utf8')).codes

describe('refusal codes are registered', () => {
  const found = scanRefusalCodes(SRC)
  const registered = registeredRefusalCodes()
  const grandfathered = new Set(allowlist)

  it('every refusal code in src/ is in the registry or the grandfather allowlist', () => {
    const unregistered = [...found.entries()]
      .filter(([code]) => !registered.has(code) && !grandfathered.has(code))
      .map(([code, files]) => `${code}  (${[...files].join(', ')})`)
    expect(
      unregistered,
      'New refusal code(s) without a Security Bar registry entry. Add a rule to src/policy/registry.ts (floor: true if the bar must never relax it) naming the code in refusalCodes.',
    ).toEqual([])
  })

  it('the allowlist is sorted, unique and only shrinks over time (no code that is already registered)', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort())
    const dup = allowlist.filter((c) => registered.has(c))
    expect(dup, 'remove codes from the allowlist once the registry names them').toEqual([])
  })

  it('every registry refusalCode still exists in src/ (no typos or dead entries)', () => {
    const srcText = [...new Set([...found.values()].flatMap((s) => [...s]))].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n')
    const allSrc = srcText + '\n' + readFileSync(join(SRC, 'tasks', 'service.ts'), 'utf8') + readFileSync(join(SRC, 'tasks', 'assignee.ts'), 'utf8')
    for (const rule of POLICY_RULES) {
      for (const code of rule.refusalCodes ?? []) expect(allSrc.includes(`'${code}'`), `${rule.id}: ${code}`).toBe(true)
    }
  })

  it('the scanner sees the codes this PR wires (self-test that it is not silently empty)', () => {
    expect(found.has('gate_owner_creator_is_assignee')).toBe(true)
    expect(found.has('artifact_verification_failed')).toBe(true)
    expect(found.size).toBeGreaterThan(100)
  })
})
