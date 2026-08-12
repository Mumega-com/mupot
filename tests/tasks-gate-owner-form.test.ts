// mupot — gate_owner write-time form guard (board 247858f1).
//
// callerHoldsGateCapability looks up gate_grants WHERE capability = <gate_owner
// RAW>, and only 'gate:<owner>' strings are insertable into gate_grants. A bare
// slug like 'athena' therefore can never match a grant — the task enters review
// and its verdict is structurally unreachable, and gate_owner is then LOCKED so
// it can't be corrected live. This guard rejects the bad form at write time.

import { describe, expect, it } from 'vitest'
import { isValidGateOwnerForm } from '../src/tasks/service'

describe('isValidGateOwnerForm', () => {
  it('accepts the gate:<owner> capability form', () => {
    expect(isValidGateOwnerForm('gate:athena')).toBe(true)
    expect(isValidGateOwnerForm('gate:kasra-core')).toBe(true)
    expect(isValidGateOwnerForm('gate:outreach:send')).toBe(true)
  })

  it('rejects a bare slug — the exact 247858f1 defect', () => {
    expect(isValidGateOwnerForm('athena')).toBe(false)
    expect(isValidGateOwnerForm('kasra')).toBe(false)
    expect(isValidGateOwnerForm('outreach')).toBe(false)
  })

  it('rejects a raw agent UUID — also unverdictable (no capability=<uuid> grant is insertable)', () => {
    // The lookup is `WHERE capability = <gate_owner>`; a UUID matches no grant.
    // This is the refinement over the first-pass "gate:<owner> OR agent id".
    expect(isValidGateOwnerForm('a9423609-e3bf-4797-8af8-4b9b7aecdf16')).toBe(false)
  })

  it('rejects near-miss forms that would not match a grant', () => {
    expect(isValidGateOwnerForm('gate:')).toBe(false) // empty owner
    expect(isValidGateOwnerForm('Gate:athena')).toBe(false) // wrong case prefix
    expect(isValidGateOwnerForm('gate athena')).toBe(false) // space
    expect(isValidGateOwnerForm('gate:athena!')).toBe(false) // illegal char
    expect(isValidGateOwnerForm('')).toBe(false)
    expect(isValidGateOwnerForm('  ')).toBe(false)
  })

})
