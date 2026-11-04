import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// mupot#982 — the first-owner bootstrap token is a secret compared against attacker input. Behaviour
// is identical for === and a constant-time compare, so only the source can pin which one is used.
describe('bootstrap owner token comparison', () => {
  const src = readFileSync('src/auth/index.ts', 'utf8')
  it('goes through the shared constant-time helper', () => {
    expect(src).toMatch(/timingSafeEqual\(\s*form\.token\s*,\s*c\.env\.BOOTSTRAP_OWNER_TOKEN/)
  })
  it('never compares the token with ===/!==', () => {
    expect(src).not.toMatch(/form\.token\s*[!=]==/)
    expect(src).not.toMatch(/[!=]==\s*(c\.)?env\.BOOTSTRAP_OWNER_TOKEN/)
  })
  it('has no local constantTimeEqual copy', () => {
    expect(src).not.toMatch(/function\s+constantTimeEqual/)
  })
})
