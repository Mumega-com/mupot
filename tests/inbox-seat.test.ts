// tests/inbox-seat.test.ts — unit coverage for resolveInboxSeatArg's normalization rule
// (mupot#1272 adversarial-gate P1 item 3, re-flagged unguarded in mupot#1325's gate as P3):
// an empty/whitespace `?seat=` must behave as "no seat requested" (unscoped-compat, returns
// the token's own bound seat), never as a seat_mismatch. No dedicated unit test existed for
// src/agents/inbox-seat.ts before this — only indirect coverage via the HTTP routes, none of
// which exercised the raw empty-string input.

import { describe, it, expect } from 'vitest'
import { resolveInboxSeatArg } from '../src/agents/inbox-seat'

describe('resolveInboxSeatArg', () => {
  it('omitted seat on a seat-bound token resolves to its own bound seat', () => {
    expect(resolveInboxSeatArg(undefined, 'hadi-codex-cli')).toEqual({ ok: true, seat: 'hadi-codex-cli' })
  })
  it('empty string seat on a seat-bound token normalizes to unscoped-compat, NOT seat_mismatch', () => {
    // mupot#1325 P3: mutating the `.trim().length === 0` guard to `false` makes '' fall
    // through to the mismatch branch (a bound seat is never ''), flipping this from
    // unscoped-compat to a spurious 403 seat_mismatch.
    expect(resolveInboxSeatArg('', 'hadi-codex-cli')).toEqual({ ok: true, seat: 'hadi-codex-cli' })
  })
  it('whitespace-only seat on a seat-bound token also normalizes to unscoped-compat', () => {
    expect(resolveInboxSeatArg('   ', 'hadi-codex-cli')).toEqual({ ok: true, seat: 'hadi-codex-cli' })
  })
  it('same-value echo on a seat-bound token is accepted', () => {
    expect(resolveInboxSeatArg('hadi-codex-cli', 'hadi-codex-cli')).toEqual({ ok: true, seat: 'hadi-codex-cli' })
  })
  it('mismatched seat on a seat-bound token is refused', () => {
    const r = resolveInboxSeatArg('hadi-codex-mac', 'hadi-codex-cli')
    expect(r).toMatchObject({ ok: false, status: 403, error: 'seat_mismatch' })
  })
  it('any requested seat on an unbound token is refused seat_not_bound', () => {
    const r = resolveInboxSeatArg('hadi-codex-cli', null)
    expect(r).toMatchObject({ ok: false, status: 403, error: 'seat_not_bound' })
  })
  it('empty string seat on an UNBOUND token stays unscoped (no seat requested at all)', () => {
    expect(resolveInboxSeatArg('', null)).toEqual({ ok: true, seat: undefined })
  })
})
