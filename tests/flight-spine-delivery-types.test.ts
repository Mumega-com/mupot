import { describe, expect, it } from 'vitest'

import type {
  RegisteredRuntimeSigner,
  RuntimeDeliveryAuthority,
  RuntimeSigningChallenge,
  RuntimeSigningDomain,
} from '../src/flight-spine/delivery-types'

const RUNTIME_PROOF_DOMAIN: RuntimeSigningDomain =
  'mupot-runtime-generation-runtime-proof:v1'

const CHALLENGE: RuntimeSigningChallenge = {
  id: 'challenge-1',
  domain: RUNTIME_PROOF_DOMAIN,
  authorityKind: 'runtime',
  authorityId: 'runtime-signer-1',
  resourceId: 'seat-runtime:1',
  requestedByMemberId: 'member-broker',
  requestedByCredentialId: 'token-broker',
  issuedAt: '2026-08-24T12:00:00.000Z',
  expiresAt: '2026-08-24T12:01:00.000Z',
  nonce: 'nonce-runtime-proof',
  signablePayloadTemplate: 'runtime-proof-template',
  signablePayloadDigest: 'a'.repeat(64),
  consumedAt: null,
}

const AUTHORITY: RuntimeDeliveryAuthority = {
  id: 'authority-adapter',
  tenant: 'tenant-flight-3',
  brokerId: 'broker-1',
  runtimeSeatId: 'seat-runtime',
  generation: 1,
  authorityKind: 'adapter',
  publicKey: 'adapter-public',
  keyFingerprint: `v1:${'b'.repeat(64)}`,
  proofOfPossessionDigest: 'b'.repeat(64),
  proofOfPossessionSignature: 'adapter-proof-signature',
  canonicalPayload: 'adapter-canonical-payload',
  challengeId: 'challenge-adapter',
  registrationDigest: 'c'.repeat(64),
  state: 'active',
  issuedAt: '2026-08-24T12:00:00.000Z',
  expiresAt: '2026-08-24T12:05:00.000Z',
  revokedAt: null,
}

const SIGNER: RegisteredRuntimeSigner = {
  id: 'runtime-signer-1',
  brokerId: 'broker-1',
  runtimeSeatId: 'seat-runtime',
  generation: 1,
  publicKey: 'runtime-public',
  encryptionPublicKey: 'runtime-encryption-public',
  proofOfPossessionDigest: 'd'.repeat(64),
  proofOfPossessionSignature: 'runtime-proof-signature',
  canonicalPayload: 'runtime-canonical-payload',
  challengeId: 'challenge-runtime',
  registrationDigest: 'e'.repeat(64),
  state: 'active',
  issuedAt: '2026-08-24T12:00:00.000Z',
  expiresAt: '2026-08-24T12:05:00.000Z',
  revokedAt: null,
}

describe('Flight 3 delivery type contract', () => {
  it('keeps runtime generation proof separate from broker activation', () => {
    expect(RUNTIME_PROOF_DOMAIN).toBe(
      'mupot-runtime-generation-runtime-proof:v1',
    )
    expect(RUNTIME_PROOF_DOMAIN).not.toBe(
      'mupot-runtime-generation-activate:v1',
    )
  })

  it('exposes immutable challenge and signer registration provenance', () => {
    expect(CHALLENGE.requestedByMemberId).toBe('member-broker')
    expect(CHALLENGE.requestedByCredentialId).toBe('token-broker')
    expect(AUTHORITY.proofOfPossessionSignature).toBe('adapter-proof-signature')
    expect(AUTHORITY.canonicalPayload).toBe('adapter-canonical-payload')
    expect(SIGNER.brokerId).toBe('broker-1')
    expect(SIGNER.proofOfPossessionSignature).toBe('runtime-proof-signature')
    expect(SIGNER.canonicalPayload).toBe('runtime-canonical-payload')
  })
})
