export type DeliveryAuthorityKind =
  | 'broker'
  | 'ingress'
  | 'adapter'
  | 'runtime'
  | 'provider_verifier'

export type DeliveryEvidenceType =
  | 'host.persisted'
  | 'effect.intent'
  | 'provider.observed'
  | 'provider.reconciled'
  | 'runtime.injected'
  | 'runtime.consumed'
  | 'runtime.ack'

export type FencedDeliveryState =
  | 'accepted'
  | 'leased'
  | 'host_persisted'
  | 'effect_intent'
  | 'provider_observed'
  | 'runtime_injected'
  | 'runtime_consumed'
  | 'runtime_acked'
  | 'expired'
  | 'recovery_reserved'
  | 'source_acked'
  | 'blocked'

export type FencedDeliveryAttemptState =
  | 'leased'
  | 'expired'
  | 'blocked'
  | 'recovery_reserved'
  | 'completed'
  | 'stale'

export type RuntimeSigningDomain =
  | 'mupot-runtime-broker-register:v1'
  | 'mupot-delivery-authority-register:v1'
  | 'mupot-runtime-signer-register:v1'
  | 'mupot-runtime-generation-runtime-proof:v1'
  | 'mupot-runtime-generation-activate:v1'
  | 'mupot-fenced-delivery-lease:v1'
  | 'mupot-fenced-delivery-evidence:v1'

export interface CanonicalSignedRequest {
  issuedAt: string
  expiresAt: string
  nonce: string
  challengeId: string
  canonicalPayloadDigest: string
  signature: string
}

export interface RuntimeSigningChallenge {
  id: string
  domain: RuntimeSigningDomain
  authorityKind: DeliveryAuthorityKind
  authorityId: string | null
  resourceId: string
  requestedByMemberId: string
  requestedByCredentialId: string
  issuedAt: string
  expiresAt: string
  nonce: string
  signablePayloadTemplate: string
  signablePayloadDigest: string
  consumedAt: string | null
}

export interface RuntimeBroker {
  id: string
  tenant: string
  agentId: string
  memberId: string
  credentialId: string
  hostId: string
  publicKey: string
  keyFingerprint: string
  state: 'active' | 'revoked'
  registrationDigest: string
  challengeId: string
  registeredAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface RuntimeDeliveryAuthority {
  id: string
  tenant: string
  brokerId: string
  runtimeSeatId: string
  generation: number
  authorityKind: 'ingress' | 'adapter' | 'provider_verifier'
  publicKey: string
  keyFingerprint: string
  proofOfPossessionDigest: string
  proofOfPossessionSignature: string
  canonicalPayload: string
  challengeId: string
  registrationDigest: string
  state: 'pending' | 'active' | 'revoked'
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface RegisteredRuntimeSigner {
  id: string
  brokerId: string
  runtimeSeatId: string
  generation: number
  publicKey: string
  encryptionPublicKey: string
  proofOfPossessionDigest: string
  proofOfPossessionSignature: string
  canonicalPayload: string
  challengeId: string
  registrationDigest: string
  state: 'pending' | 'active' | 'revoked'
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface ActiveRuntimeSeatGeneration {
  attestationId: string
  brokerId: string
  runtimeSeatId: string
  generation: number
  hostId: string
  processId: string
  launcherProcessId: string
  brokerUid: string
  adapterUid: string
  providerVerifierUid: string
  runtimeUid: string
  sandboxId: string
  mountNamespaceId: string
  userNamespaceId: string
  cgroupId: string
  executableDigest: string
  ingressAuthorityRegistrationId: string
  adapterAuthorityRegistrationId: string
  providerVerifierAuthorityRegistrationId: string
  runtimeSignerRegistrationId: string
  canonicalPayloadDigest: string
  signedAt: string
}

export interface EncryptedEnvelopeReference {
  schema: 'mupot-encrypted-envelope-ref:v1'
  envelopeReceiptId: string
  envelopeRef: string
  ciphertextDigest: string
  envelopeDigest: string
  payloadDigest: string
  runtimeInputDigest: string
  encryptionKeyId: string
  recipientRuntimeSeatId: string
  recipientGeneration: number
  byteLength: number
  expiresAt: string
}

export interface EnvelopeIngressAuthorization {
  id: string
  sourceAgentId: string
  runtimeSeatId: string
  generation: number
  recipientEncryptionKeyId: string
  payloadDigest: string
  runtimeInputDigest: string
  maximumBytes: number
  issuedAt: string
  expiresAt: string
  uploadNonce: string
  idempotencyKey: string
}

export interface HostEnvelopeIngressReceipt {
  id: string
  authorizationId: string
  runtimeSeatId: string
  generation: number
  recipientEncryptionKeyId: string
  envelopeRef: string
  ciphertextDigest: string
  envelopeDigest: string
  payloadDigest: string
  runtimeInputDigest: string
  byteLength: number
  storedAt: string
  expiresAt: string
  hostAuthorityId: string
  canonicalPayloadDigest: string
  signature: string
}

export interface SignedDeliveryEvidence {
  domain: 'mupot-fenced-delivery-evidence:v1'
  authorityKind: DeliveryAuthorityKind
  authorityId: string
  evidenceType: DeliveryEvidenceType
  deliveryId: string
  attemptId: string
  attemptNumber: number
  messageId: string
  runtimeSeatId: string
  generation: number
  assignmentEpoch: number
  fencingEpoch: number
  effectKey: string
  payloadDigest: string
  ciphertextDigest: string
  envelopeDigest: string
  runtimeInputDigest: string
  providerEffectId: string | null
  occurredAt: string
  issuedAt: string
  expiresAt: string
  nonce: string
  challengeId: string
  canonicalPayloadDigest: string
  signature: string
}

export interface AcceptFencedDeliveryInput {
  objectiveId: string
  flightId: string
  taskId: string
  assignmentEpoch: number
  runtimeSeatId: string
  kind: 'request'
  requestId: string
  effectKey: string
  envelope: EncryptedEnvelopeReference
}

export interface LeaseFencedDeliveryInput extends CanonicalSignedRequest {
  deliveryId: string
  runtimeSeatId: string
  generation: number
  brokerId: string
  consumerId: string
  leaseTokenHash: string
}

export interface RenewFencedDeliveryInput extends CanonicalSignedRequest {
  deliveryId: string
  attemptId: string
  attemptNumber: number
  runtimeSeatId: string
  generation: number
  fencingEpoch: number
  leaseTokenHash: string
}

export interface ReserveFencedDeliveryRecoveryInput extends CanonicalSignedRequest {
  deliveryId: string
  priorAttemptId: string
  priorAttemptNumber: number
  priorFencingEpoch: number
  brokerId: string
  consumerId: string
  idempotencyKey: string
}

export interface LeaseRecoveredFencedDeliveryInput extends CanonicalSignedRequest {
  deliveryId: string
  recoveryReservationId: string
  priorAttemptId: string
  priorFencingEpoch: number
  nextAttemptNumber: number
  runtimeSeatId: string
  generation: number
  consumerId: string
  leaseTokenHash: string
}

export interface FencedDeliveryRecoveryReservation {
  id: string
  deliveryId: string
  priorAttemptId: string
  priorAttemptNumber: number
  priorFencingEpoch: number
  nextAttemptNumber: number
  brokerId: string
  consumerId: string
  idempotencyKey: string
  reservationNonce: string
  state: 'reserved' | 'consumed' | 'expired'
  reservedAt: string
  retryNotBefore: string
  expiresAt: string
  consumedAt: string | null
}

export interface FencedDelivery {
  id: string
  tenant: string
  messageId: string
  sourceAgentId: string
  sourceMemberId: string
  objectiveId: string
  flightId: string
  taskId: string
  assignmentEpoch: number
  runtimeSeatId: string
  generation: number
  fencingEpoch: number
  activeAttemptId: string | null
  activeAttemptNumber: number
  requestId: string
  effectKey: string
  envelopeReceiptId: string
  envelopeRef: string
  ciphertextDigest: string
  envelopeDigest: string
  payloadDigest: string
  runtimeInputDigest: string
  state: FencedDeliveryState
  acceptedAt: string
  updatedAt: string
  sourceAckedAt: string | null
}
