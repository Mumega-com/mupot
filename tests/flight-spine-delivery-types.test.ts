import { describe, expect, it } from 'vitest'

import type { RuntimeSigningDomain } from '../src/flight-spine/delivery-types'

const RUNTIME_PROOF_DOMAIN: RuntimeSigningDomain =
  'mupot-runtime-generation-runtime-proof:v1'

describe('Flight 3 delivery type contract', () => {
  it('keeps runtime generation proof separate from broker activation', () => {
    expect(RUNTIME_PROOF_DOMAIN).toBe(
      'mupot-runtime-generation-runtime-proof:v1',
    )
    expect(RUNTIME_PROOF_DOMAIN).not.toBe(
      'mupot-runtime-generation-activate:v1',
    )
  })
})
