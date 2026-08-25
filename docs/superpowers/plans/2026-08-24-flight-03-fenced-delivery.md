# Flight 3 Fenced Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and independently prove one exact-seat, fenced, crash-recoverable delivery chain from Mupot acceptance through runtime consumption, correlated runtime ACK, and exact-source ACK without a human pushing a pane.

**Architecture:** First create the governed Mupot implementation circuit and record the strongest currently available bootstrap evidence for every lane; no code starts before that Task 0 governance record. Missing exact delivery/consumption/correlated-ACK receipts are the Flight 3 objective, never an invented precondition. Then reuse `agent_messages` from migration `0120`, runtime seat/generation/lease primitives from `0122`, and the execution receipt ledger from `0123`. Add only a broker/key-attestation layer and a fenced-delivery state machine, then connect them to one Linux reference privileged launcher plus unprivileged broker/runtime/adapter whose append-only fsynced journal and idempotent provider make every crash window recoverable. Proof delivery is a separate exact-seat path: generic inbox APIs cannot see or acknowledge it, D1 stores only immutable digests and a bounded encrypted-envelope reference, the broker/adapter cannot read or mint the runtime signer/decryption key, and source ACK is server-gated on the complete signed chain.

**Tech Stack:** TypeScript 5.6, Cloudflare Workers, D1/SQLite, MCP JSON-RPC, Vitest, Node.js ESM, Ed25519 WebCrypto, Linux UID/process isolation, append-only files with `fsync`.

**Spec:** `docs/superpowers/specs/2026-08-23-autonomous-three-squad-flight-system-design.md`

## Global Constraints

- Frozen base and merged Flight 2 SHA: `890a0209c0846c9ce7b4f4561ab13523ddf9a21c`. Re-fetch `origin/main` before Task 1 and before Task 8; stop if this commit is no longer an ancestor.
- Current migration head is `0126_decision_requests.sql`. Reserve provisional `0127_runtime_brokers.sql` and `0128_fenced_deliveries.sql` only if both repository and remote D1 remain at `0126`; any collision requires a reviewed renumbering update to this plan before code.
- Reuse `agent_messages`, `runtime_seats`, `runtime_seat_generations`, `runtime_seat_leases`, and `execution_receipts`; do not create a second inbox, seat ledger, or receipt chain.
- A proof message MUST name one exact `runtime_seats.id` in `agent_messages.target_seat`. Proof broadcast (`target_seat IS NULL`) is invalid.
- Generic `inbox`, signed inbox, `inbox_lease`, `inbox_ack`, dead-letter, delete, and summary paths MUST exclude proof messages. Only the fenced-delivery service may advance or acknowledge them.
- Broker, adapter, runtime, and provider-verifier are distinct authorities with distinct registered public keys and domain-separated signatures. The broker may attest launch/persistence; it cannot emit runtime or provider evidence. The adapter may emit intent/injection; it cannot emit runtime consumption/ACK. The provider verifier may emit observed/reconciled effects only. The runtime signer may emit consumed/ACK only.
- A small privileged launcher/service manager creates the Linux UIDs, mount/user/PID namespaces, cgroup and seccomp policy, then execs the unprivileged broker, adapter, provider verifier, and runtime. Broker and adapter never run as root.
- The runtime generates its signing and envelope-decryption private keys only after the final runtime UID and private mount namespace are active. The launcher closes all namespace/root/key-directory descriptors before exec, drops all capabilities, sets `NoNewPrivs`, applies seccomp, and cannot reopen the runtime key namespace after exec. Proof uses namespace/capability/service-policy evidence; it never treats an `EACCES` probe made while still root as isolation.
- Broker, adapter, runtime, and provider-verifier each have a separate key custodian, UID, key path, registration/activation record, expiry/revocation lifecycle, and domain-separated signer implementation. The file provider's observation is signed by the provider-verifier key, not the adapter key.
- The adapter journals the accepted envelope before effect work, appends a hash-chained record for every transition, calls `fsync` before acknowledging each local transition, and replays from the last durable record after restart.
- Provider effects require a stable `effectKey`, an idempotent execute operation, and a lookup/reconcile operation. An unknown or unqueryable provider is excluded from autonomous execution.
- Exact-source ACK may set `agent_messages.read_at` only after the same delivery has valid `message.accepted -> seat.leased -> host.persisted -> effect.intent -> provider.observed|provider.reconciled -> runtime.injected -> runtime.consumed -> runtime.ack` evidence under the current seat generation, assignment epoch, and fencing epoch.
- Flight 3 implements no artifact bytes/storage, result reporting, gate semantics, task completion, cost finalization, landing, controller, portfolio, or harness-specific port. Those remain Flights 4–12.
- Flight 3 ports no Herdr, Prime-Agent, Hermes, OpenCode, Cursor, or gate harness. It supplies one reference adapter and a conformance contract for Flight 7.
- No credential values, private keys, bearer tokens, provider payload bodies, model prompts, or plaintext runtime inputs enter D1, logs, Git, receipts, test snapshots, or candidate manifests. D1 `agent_messages.body` contains only bounded `mupot-proof-ref:v1` JSON with delivery ID, immutable payload/runtime-input/envelope digests, and an opaque encrypted local-envelope reference.
- Budget ceiling: `10_000_000` micro-USD ($10). Overall implementation TTL: 8 hours. Writer TTL: 90 minutes with one progress-backed 45-minute renewal. Per-review TTL: 45 minutes. Final gate TTL: 45 minutes.
- Runtime policy: heartbeat age at dispatch at most 30 seconds; stale after 60 seconds; delivery lease 60 seconds; renew at least 20 seconds before expiry; runtime challenge within 60 seconds; recovery within 180 seconds; at most 3 automatic attempts with fixed 5/15/45-second backoff; lab proof at most 30 minutes; evidence retention at least 30 days.
- Every task uses one implementer and a fresh independent reviewer. A task may receive at most five implementation-review repair rounds; the fifth BLOCK stops the flight and creates a decision packet.
- The implementation circuit/flight is Task 0, executed immediately after this plan receives an independent PASS and before Task 1. It precreates all lanes/tasks/dependencies, applies the approved $10 cap/TTLs, records writer and gate ownership, and records task/assignment/dispatch acceptance, targeted message rows, transport ACK, and `runtime_read` only where each is actually available. Missing delivery/consumption/correlated-ACK receipts remain explicit Flight 3 done-when requirements.
- No push, PR, merge, migration, deploy, credential creation, live seat activation, fault injection, or cutover occurs merely by executing Tasks 1–8 locally.
- Hadi decisions remain separate and explicit for: (1) broker credential creation, (2) the $10 flight budget, (3) the exact lab seat, (4) live fault injection, and (5) later migration/deployment/cutover. One approval never implies another.

## Authoritative Entry Gate — Achieved, Delivery Still Unproven

Revalidated read-only on 2026-08-24:

| Fact | Authoritative evidence |
|---|---|
| Flight 2 merged | GitHub PR #1199 is MERGED; merge commit `890a0209c0846c9ce7b4f4561ab13523ddf9a21c`; `origin/main` equals it. |
| Production code | `https://mupot.mumega.com/health` returned version `0.30.0`, clean `true`, commit `890a0209c0846c9ce7b4f4561ab13523ddf9a21c`; deployed Worker version is `46fb74c3-7777-4cc2-a23b-473e3e5a86d2`. |
| D1 migrations | Remote `d1_migrations` contains `0120` through `0126` exactly once; `wrangler d1 migrations list mupot --remote` reports no pending migration. |
| Canonical identity attested | Agent `087a816b-ab9f-400f-8d53-f6f97b94a725` has token-binding attestation `a4e1100b-f516-43f2-b22c-24e7b2e1d7db`. |
| Pending command seat | Seat `64dfb077-68aa-4709-af0f-f6a52cd5c6ca`, name `codex-desktop-command`, host `hadi-mac`, adapter `codex-desktop`, is pending at generation/fencing `0/0`; seat attestation is `857b9125-f948-4b72-ac8b-d6e435310a61`. |
| Objective accepted | Zero-budget objective `objective-9565e9c3132c21db7416a0b1d64d4bda` was accepted by canonical `hadi-codex`; receipts are `ba024c50-5d3e-4817-ac6d-72fb6518a046` (`objective.authorized`) and `cfb70e2a-a9e3-47cd-9083-e71d5651bbb0` (`objective.accepted`). |
| Delivery not proved | That objective has only the two objective receipts; the pending seat has zero generations; the exact seat has zero targeted messages. No delivery, consumption, runtime ACK, source ACK, or recovery claim is permitted. |

The entry gate is therefore satisfied for Flight 3 planning and implementation. It is not a Flight 3 proof.

## Existing Interfaces That Must Remain Compatible

```ts
// src/agents/messages.ts
export interface SendInput {
  fromAgent: string
  fromMember: string
  toAgent: string
  body: string
  kind?: 'message' | 'request' | 'ack'
  requestId?: string
  inReplyTo?: string
  projectId?: string
  targetSeat?: string
}

export function readAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean; sinceSeq?: number; seat?: string },
): Promise<InboxResult | InboxFailure>

export function leaseAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; leaseSeconds?: number; seat?: string },
): Promise<LeaseResult | LeaseFailure>

export function ackAgentMessages(
  env: Env,
  input: { agent: string; ids: string[] },
): Promise<AckResult | AckFailure>

// src/flight-spine/seats.ts
export function registerPendingRuntimeSeat(
  env: Env,
  auth: AuthContext,
  input: { seatName: string; hostId: string; adapterKind: string; capabilities?: readonly string[] },
): Promise<RegisteredPendingRuntimeSeat>

export function acquireRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: {
    runtimeSeatId: string
    generation: number
    consumerId: string
    leaseTokenHash: string
    expiresAt: string
  },
): Promise<RuntimeSeatLease>

export function renewRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: RenewRuntimeSeatLeaseInput,
): Promise<RuntimeSeatLease>

export function releaseRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: ReleaseRuntimeSeatLeaseInput,
): Promise<RuntimeSeatLease>

// src/flight-spine/receipts.ts exports these existing functions:
// prepareFreshExecutionReceiptChain, prepareAuditedDomainMutation,
// executePreparedExecutionReceiptBatch, getExecutionReceipt,
// and verifyExecutionReceipt.
```

Existing generic behavior remains unchanged for non-proof messages. New SQL predicates only remove rows where `fenced_delivery_id IS NOT NULL`.

## Stable Flight 3 Interfaces

```ts
// src/flight-spine/delivery-types.ts
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
  domain:
    | 'mupot-runtime-broker-register:v1'
    | 'mupot-delivery-authority-register:v1'
    | 'mupot-runtime-signer-register:v1'
    | 'mupot-runtime-generation-activate:v1'
    | 'mupot-fenced-delivery-lease:v1'
    | 'mupot-fenced-delivery-evidence:v1'
  authorityKind: DeliveryAuthorityKind
  authorityId: string | null
  resourceId: string
  issuedAt: string
  expiresAt: string
  nonce: string
  signablePayloadTemplate: string
  signablePayloadDigest: string
  consumedAt: string | null
}

export interface RegisteredRuntimeSigner {
  id: string
  runtimeSeatId: string
  generation: number
  publicKey: string
  encryptionPublicKey: string
  proofOfPossessionDigest: string
  challengeId: string
  issuedAt: string
  expiresAt: string
}

export interface EncryptedEnvelopeReference {
  schema: 'mupot-encrypted-envelope-ref:v1'
  envelopeReceiptId: string
  envelopeRef: string
  ciphertextDigest: string
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
  effectKey: string
  envelopeRef: string
  ciphertextDigest: string
  payloadDigest: string
  runtimeInputDigest: string
  state: FencedDeliveryState
  acceptedAt: string
  updatedAt: string
  sourceAckedAt: string | null
}

// src/flight-spine/runtime-brokers.ts
export function issueRuntimeSigningChallenge(
  env: Env,
  auth: AuthContext,
  input: {
    domain: RuntimeSigningChallenge['domain']
    authorityKind: DeliveryAuthorityKind
    authorityId?: string
    resourceId: string
  },
): Promise<RuntimeSigningChallenge>

export function getRuntimeSigningChallenge(
  env: Env,
  auth: AuthContext,
  challengeId: string,
): Promise<RuntimeSigningChallenge | null>

export function registerRuntimeBroker(
  env: Env,
  auth: AuthContext,
  input: CanonicalSignedRequest & {
    domain: 'mupot-runtime-broker-register:v1'
    tokenBindingAttestationId: string
    hostId: string
    publicKey: string
    keyFingerprint: string
  },
): Promise<RuntimeBroker>

export function registerDeliveryAuthority(
  env: Env,
  auth: AuthContext,
  input: CanonicalSignedRequest & {
    domain: 'mupot-delivery-authority-register:v1'
    brokerId: string
    runtimeSeatId: string
    generation: number
    authorityKind: 'ingress' | 'adapter' | 'provider_verifier'
    publicKey: string
    keyFingerprint: string
  },
): Promise<RuntimeDeliveryAuthority>

export function registerRuntimeSigner(
  env: Env,
  auth: AuthContext,
  input: CanonicalSignedRequest & {
    domain: 'mupot-runtime-signer-register:v1'
    runtimeSeatId: string
    generation: number
    publicKey: string
    encryptionPublicKey: string
  },
): Promise<RegisteredRuntimeSigner>

export function activateRuntimeSeatGeneration(
  env: Env,
  auth: AuthContext,
  input: CanonicalSignedRequest & {
    domain: 'mupot-runtime-generation-activate:v1'
    brokerId: string
    runtimeSeatId: string
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
    ingressAuthorityRegistrationDigest: string
    adapterAuthorityRegistrationId: string
    adapterAuthorityRegistrationDigest: string
    providerVerifierAuthorityRegistrationId: string
    providerVerifierAuthorityRegistrationDigest: string
    runtimeSignerRegistrationId: string
    runtimeSignerRegistrationDigest: string
    challengeNonceDigest: string
    challengeSignature: string
    launcherCapabilityDigest: string
    launcherSeccompDigest: string
    launcherServicePolicyDigest: string
    postExecNoNewPrivs: true
    postExecEffectiveCapabilities: '0000000000000000'
    postExecSeccompMode: 2
    brokerRuntimeNamespaceVisible: false
    adapterRuntimeNamespaceVisible: false
    launcherRuntimeNamespaceVisibleAfterExec: false
  },
): Promise<ActiveRuntimeSeatGeneration>

// src/flight-spine/deliveries.ts
export function authorizeEnvelopeIngress(
  env: Env,
  auth: AuthContext,
  input: {
    runtimeSeatId: string
    generation: number
    payloadDigest: string
    runtimeInputDigest: string
    byteLength: number
    idempotencyKey: string
  },
): Promise<EnvelopeIngressAuthorization>

export function recordHostEnvelopeIngressReceipt(
  env: Env,
  auth: AuthContext,
  input: HostEnvelopeIngressReceipt,
): Promise<HostEnvelopeIngressReceipt>

export function acceptFencedDelivery(
  env: Env,
  auth: AuthContext,
  input: AcceptFencedDeliveryInput,
): Promise<FencedDelivery>

export function leaseFencedDelivery(
  env: Env,
  auth: AuthContext,
  input: LeaseFencedDeliveryInput,
): Promise<FencedDelivery>

export function renewFencedDelivery(
  env: Env,
  auth: AuthContext,
  input: RenewFencedDeliveryInput,
): Promise<FencedDelivery>
export function submitFencedDeliveryEvidence(
  env: Env,
  auth: AuthContext,
  input: SignedDeliveryEvidence,
): Promise<FencedDelivery>
export function recoverFencedDelivery(
  env: Env,
  auth: AuthContext,
  input: ReserveFencedDeliveryRecoveryInput,
): Promise<FencedDeliveryRecoveryReservation>
export function leaseRecoveredFencedDelivery(
  env: Env,
  auth: AuthContext,
  input: LeaseRecoveredFencedDeliveryInput,
): Promise<FencedDelivery>
export function ackFencedDeliveryAtSource(
  env: Env,
  auth: AuthContext,
  input: { deliveryId: string; runtimeAckReceiptId: string; requestId: string },
): Promise<FencedDelivery>
export function getFencedDelivery(
  env: Env,
  auth: AuthContext,
  deliveryId: string,
): Promise<FencedDelivery | null>
```

Canonical payloads are strict newline-delimited UTF-8 in the field order shown by the interfaces, prefixed by the exact domain. The server challenge issue/read interface returns `challengeId`, `issuedAt`, `expiresAt`, nonce, domain, the complete externally signable payload template, and its lowercase SHA-256 digest. That signable payload contains only domain, challenge, authority kind/public authority ID, resource IDs, public facts, issued/expiry, and nonce; it excludes relay credential ID, member ID, squad, capability and bearer-token facts. The server separately derives/correlates the authenticated relay principal and current authority in mutation audit and DML guards, never by inserting hidden identity fields into bytes the external signer could not reproduce. Callers cannot provide or widen audit identity. `issuedAt <= server now < expiresAt`, expiry is at most 60 seconds, `challengeId` must be outstanding and unused, and `(authority/domain, nonce)` is insert-once. Migration `0127` stores challenges in `runtime_signing_challenges` and consumed digests in append-only `runtime_signed_request_replays`; exact digest replay returns the first result, while changed replay or reused challenge fails.

The local ESM contract is:

```js
// fleet-runtime/fenced-delivery/*.mjs
export function canonicalDeliveryEvidence(evidence) {}
export function openSignerCustody({ kind, keyPath, expectedUid, expiresAt }) {}
export function signBrokerRequest(custody, request) {}
export function signAdapterEvidence(custody, evidence) {}
export function signRuntimeEvidence(custody, evidence) {}
export function signProviderEvidence(custody, evidence) {}
export function rotateSigner(custody, nextPublicKey, activationTime) {}
export function revokeSigner(custody, reason, revokedAt) {}
export async function createLinuxIsolation(config, deps) {}
export async function generateRuntimeSignerAndDecryptor({ signingKeyPath, decryptionKeyPath, expectedUid }) {}
export async function launchRuntimeGeneration(config, deps) {}
export function openDeliveryJournal({ directory, deliveryId, expectedUid }) {}
export function storeEncryptedEnvelope({ directory, reference, ciphertext, expectedUid }) {}
export function readEncryptedEnvelope(reference, runtimeDecryptor) {}
export function appendJournalRecord(journal, record) {}
export function recoverJournal(journal) {}
export async function runDeliveryAttempt(config, deps) {}
export async function recoverDeliveryAttempt(config, deps) {}
export class FileEffectProvider {
  async execute({ effectKey, payloadDigest }) {}
  async lookup({ effectKey }) {}
}
export class FileProviderVerifier {
  async observe({ effectKey, payloadDigest, providerEffectId }) {}
  async reconcile({ effectKey, payloadDigest }) {}
}
```

## Authority and Signature Matrix

| Fact | Required signer | Key source | Forbidden substitute |
|---|---|---|---|
| Broker registration | bound broker workspace credential + broker key proof | `runtime_brokers.public_key` | Hadi Codex token, adapter key |
| Generation launch/persist | broker | `runtime_brokers.public_key` | adapter, runtime |
| Encrypted envelope stored/retrieved | ingress service | `runtime_delivery_authorities` kind `ingress` | broker/adapter assertion |
| Effect intent / runtime injection | adapter | `runtime_delivery_authorities` kind `adapter` | broker, runtime |
| Provider observed/reconciled | provider verifier | `runtime_delivery_authorities` kind `provider_verifier` | adapter prose |
| Runtime consumed / runtime ACK | runtime process | `runtime_seat_generations.public_key` | broker, adapter |
| Exact-source ACK | original source agent-bound workspace credential | `fenced_deliveries.source_* + member_tokens` | target runtime, coordinator alias |

## Seven Crash Points

| Point | Kill boundary | Durable fact required before restart | Recovery assertion |
|---|---|---|---|
| 1 | after `message.accepted`, before seat lease | D1 accepted delivery + message | new broker leases same delivery once |
| 2 | after `seat.leased`, before local persist | D1 attempt ID/number/generation/fencing epoch/nonce | attempt expires; recovery reserves exactly once, then leases attempt + 1 under a higher epoch; old attempt/signatures are terminal |
| 3 | after `host.persisted`, before effect intent | fsynced envelope and broker evidence | adapter resumes from exact envelope |
| 4 | after `effect.intent`, before provider call | fsynced effect key/intent | provider execute occurs once |
| 5 | after provider success, before provider-verifier evidence/local success record | provider has one effect; journal has intent only | SIGKILL witness records PID/UID/delivery/attempt/effect-key digests; restart uses provider lookup and an independently signed provider-verifier `provider.reconciled`, never execute again |
| 6 | after `runtime.injected`, before `runtime.consumed` | injected evidence + runtime input spool | runtime reopens exact input; one consumed/ACK pair |
| 7 | after `runtime.ack`, before `source.ack` | signed runtime ACK | source retries exact ACK idempotently; message becomes read once |

## File Ownership and Collision-Free Order

| Task | Sole writer owns | Must not edit |
|---|---|---|
| 0 | Mupot circuit/flight/tasks/dependencies/dispatch receipts only; no repository files | repository, runtime, credentials, deployment |
| 1 | `0127`, `0128`, `delivery-types.ts`, schema tests | all runtime and MCP files |
| 2 | `runtime-brokers.ts`, broker tests | migrations, local runtime, MCP |
| 3 | `deliveries.ts`, `receipts.ts`, delivery service tests | messages/MCP, local runtime |
| 4 | `agents/messages.ts`, `mcp/flight-delivery.ts`, `mcp/index.ts`, MCP/inbox tests | migrations, broker/runtime files |
| 5 | local canonical/key/runtime/broker modules and tests | Worker/D1/MCP |
| 6 | local journal/provider/adapter modules and tests | Worker/D1/MCP |
| 7 | integration/fault tests, proof script, CI workflow, package scripts | product modules unless a prior owner receives a bounded repair round |
| 8 package writer | candidate manifest, governed packet, package test, existing-flight completion packet | product code and gate verdict |
| 8 independent gate | separately fetchable gate-verdict file/commit from frozen candidate | candidate/product/package files |

After this plan receives an independent PASS, Task 0 creates and verifies the governed flight. Task 1 cannot start until Task 0 records exact current runtime-readiness evidence and caveats for every lane owner; it does not require receipts that Flight 3 exists to build. Task 1 then lands first. After its PASS, the server lane (Tasks 2 → 3 → 4) and Linux-reference lane (Tasks 5 → 6) may run concurrently in separate worktrees. Task 7 integrates the exact reviewed tips. Task 8 freezes the package, hands the immutable candidate to an independent gate, and lands the existing implementation flight only after PASS.

---

### Task 0: Create and Record the Governed Mupot Implementation Flight

**External state only:**
- Create: circuit key `flight-spine-delivery-03-20260824`
- Create: flight key `FLIGHT-SPINE-DELIVERY-03`
- Create: eight Mupot tasks matching Tasks 1–8
- Create: lane/task dependency edges matching the order below
- Record: exact task creation, assignment, dispatch, delivery, consumption, and correlated-ACK receipts

**Interfaces:**
- Consumes: independently PASSed plan commit, canonical `hadi-codex` identity, Hadi's separate $10 budget approval, current registered worker/gate identities.
- Produces: one running governed flight with immutable cap/TTLs/owners/dependencies and proof that every named runtime can receive and ACK its exact lane before implementation begins.

- [ ] **Step 1: Independently gate this plan before mutating Mupot**

The plan reviewer fetches the exact plan commit, checks all twelve review findings are resolved, and writes a separately fetchable PASS/BLOCK verdict naming plan SHA/tree. A PASS is required before the first circuit call.

- [ ] **Step 2: Obtain the separate $10 budget decision**

Hadi approves exactly `10_000_000` micro-USD for `FLIGHT-SPINE-DELIVERY-03`. This approval authorizes only circuit/flight execution; it does not authorize broker credential creation, lab-seat activation, fault injection, migration, deploy, or cutover.

- [ ] **Step 3: Create the circuit, tasks, and dependencies**

Create the immutable flight definition:

```yaml
circuit_key: flight-spine-delivery-03-20260824
flight_key: FLIGHT-SPINE-DELIVERY-03
executor:
  agent_id: 087a816b-ab9f-400f-8d53-f6f97b94a725
  slug: hadi-codex
budget_micro_usd: 10000000
overall_ttl_seconds: 28800
writer_ttl_seconds: 5400
writer_renewal_seconds: 2700
gate_ttl_seconds: 2700
tasks:
  - task_1_schema
  - task_2_broker
  - task_3_delivery
  - task_4_mcp
  - task_5_launcher_runtime
  - task_6_adapter_provider
  - task_7_integration
  - task_8_package
dependencies:
  task_2_broker: [task_1_schema]
  task_3_delivery: [task_2_broker]
  task_4_mcp: [task_3_delivery]
  task_5_launcher_runtime: [task_1_schema]
  task_6_adapter_provider: [task_5_launcher_runtime]
  task_7_integration: [task_4_mcp, task_6_adapter_provider]
  task_8_package: [task_7_integration]
gate_owner: hadi-grok
```

Assign one sole writer per task and record exact writer agent ID, gate agent ID, worktree/branch, file ownership, done-when contract, and renewal boundary. Record runtime seat ID when currently registered; otherwise record `runtime_seat_missing` as the lane-readiness caveat Flight 3 must close. Reject generic stubs, duplicate writers, self-gates, or an unenforced cap; do not invent a seat merely to make Task 0 look green.

- [ ] **Step 4: Dispatch one canonical bootstrap request to every lane owner**

Each request carries the plan SHA, exact task ID, task key, file boundary, done-when, dependency IDs, budget/TTL, and a unique `request_id`. When an exact canonical runtime seat is currently registered, target it. Otherwise dispatch to the canonical agent record, retain the accepted/targeted row evidence Mupot actually provides, and mark exact-seat delivery as missing Flight 3 done-when.

- [ ] **Step 5: Record honest current runtime-readiness evidence**

For all eight task owners plus Hadi Grok, record whichever facts currently exist, without promoting one fact into another:

```text
task created -> task assigned -> dispatch accepted -> targeted message row
-> transport ACK (when present) -> runtime_read marker (when present)
```

For every absent stage, record `missing_not_yet_supported` plus the exact expected Flight 3 receipt. An accepted dispatch, visible pane, registration, transport ACK, or coordinator claim is not delivery/consumption. A `runtime_read` marker proves only that runtime read when it is cryptographically/correlatively bound to the targeted row. Do not use pane injection, SOS, or a human keypress as substitute evidence.

- [ ] **Step 6: Freeze Task 0 receipts and open Task 1**

Record circuit ID, flight ID, all task IDs, dependency IDs, dispatch IDs, targeted message IDs, available transport/runtime-read evidence, missing-receipt caveats, runtime seat IDs, cap, TTLs, owners, gate, and server timestamps in the flight's evidence field. The Flight 3 done-when explicitly requires replacing each missing caveat with exact delivery, consumption, correlated ACK, and recovery receipts. Only then set `task_1_schema` runnable.

---

### Task 1: Add the Broker and Fenced-Delivery Schema

**Files:**
- Create: `migrations/0127_runtime_brokers.sql`
- Create: `migrations/0128_fenced_deliveries.sql`
- Create: `src/flight-spine/delivery-types.ts`
- Create: `tests/flight-spine-delivery-schema.test.ts`
- Modify: `tests/migration-numbering.test.mjs`

**Interfaces:**
- Consumes: migrations `0120`, `0122`, `0123`; existing `agents`, `members`, `member_tokens`, `memberships`, `tasks`, and `flight_task_assignments`.
- Produces: the stable types above and tables `runtime_brokers`, `runtime_delivery_authorities`, `runtime_broker_attestations`, `runtime_signing_challenges`, `runtime_signed_request_replays`, `fenced_deliveries`, `fenced_delivery_attempts`, `fenced_delivery_recovery_reservations`, `encrypted_envelope_ingress_authorizations`, `host_envelope_ingress_receipts`, and `fenced_delivery_evidence`; adds nullable `agent_messages.fenced_delivery_id`.

- [ ] **Step 1: Revalidate the migration reservation**

Run:

```bash
git fetch origin main --prune
test "$(git rev-parse origin/main)" = "890a0209c0846c9ce7b4f4561ab13523ddf9a21c"
test "$(find migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort | tail -1)" = "migrations/0126_decision_requests.sql"
npx wrangler d1 migrations list mupot --remote --config /Users/hadi/dev/mumega/mupot/wrangler.toml
```

Expected: exact SHA match, repository head `0126`, and “No migrations to apply.” If any check differs, stop before creating `0127`.

- [ ] **Step 2: Write RED schema tests**

Assert exact tables/columns/indexes, append-only evidence, one active broker per host, unique authority key per seat generation/kind, one live challenge, one consumed nonce/domain tuple, one active delivery attempt, one recovery reservation for a prior attempt, one single-use ingress authorization, immutable host-ingress receipt replay, max three attempts, allowed state transitions, immutable payload/envelope/runtime-input digests, and these database failures:

```ts
expect(() => insertProofMessage({ targetSeat: null })).toThrow()
expect(() => insertProofMessage({ targetSeat: 'seat-name-not-id' })).toThrow()
expect(() => insertProofMessage({ targetSeat: otherSeatId })).toThrow()
expect(() => updateEvidenceRow()).toThrow()
expect(() => deleteEvidenceRow()).toThrow()
expect(() => advanceSourceAckBeforeRuntimeAck()).toThrow()
expect(() => reuseChallengeWithChangedDigest()).toThrow()
expect(() => leaseAttemptFour()).toThrow()
expect(() => attachEvidenceToPriorAttempt()).toThrow()
```

Run:

```bash
npx vitest run tests/flight-spine-delivery-schema.test.ts
node --test tests/migration-numbering.test.mjs
```

Expected: FAIL because migrations `0127`/`0128` and delivery tables do not exist.

- [ ] **Step 3: Implement the two additive migrations**

`0127` stores only public broker/authority keys, credential IDs/fingerprints, immutable generation attestations, privileged-launcher namespace/capability/seccomp/service-policy digests, one-time signing challenges, consumed canonical request digests/nonces, signature bytes, expiry, and revocation state. `0128` stores immutable delivery identity plus payload/ciphertext/runtime-input digests and opaque envelope reference, create-only ingress authorizations, append-only server-verified host ingress receipts, attempts/recovery reservations/evidence, and the proof-message link.

Required database guards:

```sql
-- Proof rows are exact-seat only and target the seat's agent.
SELECT RAISE(ABORT, 'proof delivery requires exact runtime seat')
WHERE NEW.fenced_delivery_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM fenced_deliveries delivery
      JOIN runtime_seats seat ON seat.id = delivery.runtime_seat_id
     WHERE delivery.id = NEW.fenced_delivery_id
       AND delivery.tenant = NEW.tenant
       AND delivery.message_id = NEW.id
       AND NEW.target_seat = seat.id
       AND NEW.to_agent = seat.agent_id
  );

-- Generic/direct read_at mutation cannot consume proof mail.
SELECT RAISE(ABORT, 'proof delivery requires exact source ack')
WHERE OLD.fenced_delivery_id IS NOT NULL
  AND NEW.read_at IS NOT OLD.read_at
  AND NOT EXISTS (
    SELECT 1 FROM fenced_deliveries
     WHERE id = OLD.fenced_delivery_id
       AND state = 'source_acked'
       AND source_acked_at = NEW.read_at
  );
```

Add immutable identity/no-delete triggers, nonce/challenge replay triggers, attempt cardinality/backoff guards, and explicit transitions permitting only:

```text
accepted -> leased -> host_persisted -> effect_intent
effect_intent -> provider_observed
effect_intent -> provider_observed via reconciled evidence
provider_observed -> runtime_injected -> runtime_consumed -> runtime_acked -> source_acked
leased -> expired
host_persisted|effect_intent|provider_observed|runtime_injected|runtime_consumed -> blocked
expired|blocked -> recovery_reserved -> leased (new attempt, same generation, higher fence)
```

`fenced_delivery_attempts` stores `attempt_number` 1–3, unique `attempt_nonce`, generation, prior fencing epoch, current fencing epoch, lease ID, lease expiry, state, and retry-not-before timestamp. A partial unique index allows one `leased|recovery_reserved` attempt per delivery. Attempt 2 cannot reserve before accepted-at + 5 seconds; attempt 3 cannot reserve before attempt-2 expiry/block + 15 seconds; no attempt exists after attempt 3. The 45-second backoff is the final wait before transitioning the delivery to terminal `blocked` and escalating rather than creating attempt 4.

- [ ] **Step 4: Define the stable TypeScript types**

Implement exactly the interfaces in “Stable Flight 3 Interfaces.” Validate finite positive generation/assignment/fencing integers, bounded IDs, UTC timestamps, lowercase 64-hex digests, base64url Ed25519 public keys/signatures, and `additionalProperties: false` in later MCP schemas.

- [ ] **Step 5: Run GREEN schema checks**

```bash
node scripts/check-migration-numbering.mjs
node --test tests/migration-numbering.test.mjs
npx vitest run tests/helpers-migrations.test.ts tests/flight-spine-schema.test.ts tests/flight-spine-delivery-schema.test.ts tests/migration-d1-compat.test.ts
npm run typecheck
git diff --check
```

Expected: all pass; migration set is exactly `0127`, `0128` above `0126`.

- [ ] **Step 6: Independent review and commit**

Reviewer checks no private material, no second ledger, no circular immediate FK, exact-seat trigger, generic read-at trigger, and D1 compatibility. At most five repair rounds.

```bash
git add migrations/0127_runtime_brokers.sql migrations/0128_fenced_deliveries.sql \
  src/flight-spine/delivery-types.ts tests/flight-spine-delivery-schema.test.ts \
  tests/migration-numbering.test.mjs
git commit -m "feat: add Flight 3 delivery schema"
```

---

### Task 2: Register Brokers and Activate Attested Runtime Generations

**Files:**
- Create: `src/flight-spine/runtime-brokers.ts`
- Create: `tests/flight-spine-runtime-brokers.test.ts`

**Interfaces:**
- Consumes: Task 1 schema/types, `issueTokenBindingAttestation()`, pending seats, `runtime_seat_generations`, audited domain mutations.
- Produces: `issueRuntimeSigningChallenge()`, `getRuntimeSigningChallenge()`, `registerRuntimeBroker()`, `registerDeliveryAuthority()`, `registerRuntimeSigner()`, `activateRuntimeSeatGeneration()`.

- [ ] **Step 1: Write RED broker tests**

Cover challenge issue/read visibility and expiry; exact replay/conflict; inactive broker credential; missing member+ membership; revoked agent/token; host mismatch; pending-seat requirement; issued/expiry bounds; one-time challenge/nonce use; canonical digest/domain mismatch; broker/adapter/provider/runtime key substitution; activation with raw keys; wrong/missing/stale adapter, provider-verifier, or runtime signer registration ID/digest; non-distinct UIDs; privileged launcher still retaining capabilities/namespaces after exec; concurrent activation; rotation/revocation; and no partial challenge/registration/generation/seat/audit/replay write.

```ts
const sameUid = activationFixture()
sameUid.brokerUid = '1001'
sameUid.adapterUid = '1001'
await expect(activateRuntimeSeatGeneration(env, brokerAuth, sameUid))
  .rejects.toMatchObject({ code: 'uid_isolation_failed' })

const privilegedAfterExec = activationFixture()
privilegedAfterExec.postExecEffectiveCapabilities = '0000000000000001'
await expect(activateRuntimeSeatGeneration(env, brokerAuth, privilegedAfterExec))
  .rejects.toMatchObject({ code: 'launcher_isolation_failed' })

const replay = brokerRegistrationFixture()
await registerRuntimeBroker(env, brokerAuth, replay)
replay.hostId = 'other-host'
await expect(registerRuntimeBroker(env, brokerAuth, replay))
  .rejects.toMatchObject({ code: 'signed_request_replay_conflict' })
```

Run:

```bash
npx vitest run tests/flight-spine-runtime-brokers.test.ts
```

Expected: FAIL because the broker service does not exist.

- [ ] **Step 2: Implement bounded server challenge issue/read**

`issueRuntimeSigningChallenge()` derives relay audit identity and current scope, creates a 60-second single-use challenge, and returns only domain, public authority/resource identifiers, issued/expiry, nonce, signable payload template and digest. `getRuntimeSigningChallenge()` returns the same bounded public challenge only to the original authenticated relay or a visible registered authority. Neither route returns credential/member/squad/capability facts or a signing key. Challenge creation/read has exact MCP schemas and mutation/read audits.

- [ ] **Step 3: Implement broker, adapter/provider-verifier, and runtime signer registration**

Require an active agent-bound workspace token and current member+ membership/capability in both preflight and the final D1 statement. Derive tenant, broker agent, member, credential ID/fingerprint and squad from `AuthContext`; never accept or widen them from input. Require a live `tokenBindingAttestationId`, one server-issued unused `challengeId`, `issuedAt`, `expiresAt` no more than 60 seconds later, nonce, canonical digest, and signature. Verify proof-of-possession over:

```text
mupot-runtime-broker-register:v1
tenant
broker-id
host-id
public-key
issued-at
expires-at
challenge-id
nonce
```

Store the exact canonical digest/nonce/challenge/result ID in `runtime_signed_request_replays` in the same D1 batch as registration. Exact same-digest replay returns the first row; a changed digest, consumed challenge, expired request, or reused domain/nonce fails. Register adapter/provider authorities under domain `mupot-delivery-authority-register:v1` only under the same active broker, exact seat/generation, host, expiry and separate self-signed proof-of-possession. Register the runtime signing/encryption public keys under domain `mupot-runtime-signer-register:v1` only after the runtime signs its server challenge from inside its final namespace. Each registration has immutable ID/digest; no broker-supplied raw key is an activation input.

- [ ] **Step 4: Implement atomic generation activation**

Verify domain `mupot-runtime-generation-activate:v1`, broker attestation, issued/expiry, nonce/challenge replay, and canonical digest using WebCrypto Ed25519. Require exact prior ingress authority registration ID/digest, adapter authority registration ID/digest, provider-verifier registration ID/digest, and runtime signer registration ID/digest for the same tenant/seat/generation/host; reverify each self-signed proof-of-possession and active/unexpired/unrevoked state inside the final D1 mutation. Reject raw key fields and any broker attempt to substitute registrations. Require four distinct numeric Linux UIDs, executable digest, exact pending seat/host, current member+ broker authority, no existing generation, distinct mount/user namespaces, launcher `NoNewPrivs=1`, `CapEff=0`, seccomp mode 2, and false post-exec visibility of the runtime namespace from launcher/broker/adapter. In one audited batch:

1. insert immutable broker attestation;
2. insert generation `1` (or current + 1 after a reviewed replacement);
3. consume/correlate the four prior immutable signer registrations without copying caller-supplied keys;
4. update the seat `pending -> active`, generation `0 -> 1`, public key/fingerprint, heartbeat;
5. emit the existing host observation correlation without claiming delivery.

- [ ] **Step 5: Run GREEN broker checks**

```bash
npx vitest run tests/flight-spine-runtime-brokers.test.ts \
  tests/flight-spine-seats.test.ts tests/flight-spine-attestations.test.ts \
  tests/flight-spine-host-control.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 6: Independent review and commit**

Reviewer verifies credential/member/seat/host/UID/key/challenge/nonce/expiry checks are repeated inside D1 writes, caller identity is never input-derived, launcher isolation is based on post-exec namespace/capability/seccomp/service facts, and broker cannot create adapter/runtime/provider evidence.

```bash
git add src/flight-spine/runtime-brokers.ts tests/flight-spine-runtime-brokers.test.ts
git commit -m "feat: attest Flight 3 runtime brokers"
```

---

### Task 3: Implement the Server-Side Fenced Delivery State Machine

**Files:**
- Create: `src/flight-spine/deliveries.ts`
- Modify: `src/flight-spine/receipts.ts`
- Create: `tests/flight-spine-deliveries.test.ts`
- Create: `tests/flight-spine-delivery-races.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2, current assignments, runtime generations/leases, receipt ledger, mutation audit.
- Produces: the delivery functions in “Stable Flight 3 Interfaces” and a signed-external receipt append path limited to adapter/runtime/provider-verifier evidence.

- [ ] **Step 1: Write RED acceptance/lease tests**

Prove authenticated create-only ingress authorization, exact target-generation encryption key, bounded ciphertext size, host-ingress signature, same-reference replay, changed-reference conflict, TTL/retrieval/recovery, and refusal of missing/wrong/expired ingress receipts. Then prove exact current task assignment, same agent/seat/squad/objective/flight, exact assignment epoch, active generation, unique request/effect keys, no broadcast, immutable envelope/payload/runtime-input digest propagation, bounded opaque `mupot-proof-ref:v1` body, atomic `agent_messages + fenced_deliveries + message.accepted`, 60-second lease, renew-before-20-second boundary, lease expiry, recovery reservation, higher-epoch attempt takeover, max-three-attempt/backoff enforcement, terminal stale attempts, and two-consumer fencing.

```ts
const wrongSeat = deliveryFixture()
wrongSeat.runtimeSeatId = seatName
await expect(acceptFencedDelivery(env, sourceAuth, wrongSeat))
  .rejects.toMatchObject({ code: 'runtime_seat_not_found' })

const [a, b] = await Promise.allSettled([
  leaseFencedDelivery(env, brokerAuth, leaseInputA),
  leaseFencedDelivery(env, brokerAuth, leaseInputB),
])
expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
```

- [ ] **Step 2: Write RED evidence/ACK tests**

For every evidence type, mutate signer, authority kind, seat, generation, attempt ID/number/nonce, epoch, assignment, message, effect key, payload digest, envelope digest, runtime-input digest, provider effect, issued/expiry, challenge, canonical digest, nonce, and signature. Prove replay is exact-idempotent, changed replay conflicts, expired evidence fails, stale-attempt evidence is terminal, evidence cannot cross attempts, and source ACK before the full chain writes nothing.

Run:

```bash
npx vitest run tests/flight-spine-deliveries.test.ts tests/flight-spine-delivery-races.test.ts
```

Expected: FAIL because delivery services do not exist.

- [ ] **Step 3: Implement atomic acceptance and leasing**

`authorizeEnvelopeIngress()` derives the source principal and exact active target runtime generation/encryption key, creates a 60-second single-use upload authorization capped at 64 KiB ciphertext, and returns no credential/private/plaintext facts. The source encrypts locally, uploads ciphertext to the authenticated lab-host ingress using that authorization, and receives a host-signed immutable receipt. `recordHostEnvelopeIngressReceipt()` verifies the registered host-ingress authority, authorization/source/seat/generation/recipient-key, ciphertext/payload/runtime-input digests, size, reference, TTL and signature; same receipt/reference replay returns the original row and any changed bytes/digest/reference conflicts.

`acceptFencedDelivery()` derives the source principal, rechecks current authority and the exact `flight_task_assignments` row, requires the exact unexpired server-verified host ingress receipt and validates all receipt fields plus all three immutable digests, inserts the delivery before its linked message in one D1 batch, and appends `message.accepted`. The message stores `target_seat = runtime_seats.id`, `fenced_delivery_id = delivery.id`, and only this bounded metadata:

```json
{
  "schema": "mupot-proof-ref:v1",
  "delivery_id": "delivery UUID",
  "envelope_ref": "local-envelope:sha256:<64 lowercase hex>",
  "ciphertext_digest": "<64 lowercase hex>",
  "payload_digest": "<64 lowercase hex>",
  "runtime_input_digest": "<64 lowercase hex>"
}
```

No plaintext payload/model prompt/provider body is accepted by this API.

`leaseFencedDelivery()` verifies the exact broker canonical signed request and active broker/seat/generation, creates attempt 1, a `runtime_seat_leases` row, and a `fenced_delivery_attempts` row under one new fencing epoch, emits `seat.leased`, and advances only `accepted -> leased`. Renewal is signed for the same attempt/epoch, is accepted only while at least 20 seconds remain, and cannot resurrect an expired epoch.

- [ ] **Step 4: Implement cryptographic evidence progression**

Add an internal signed-receipt append function in `receipts.ts` that:

1. loads the registered public key by authority kind;
2. canonicalizes every signed field;
3. verifies Ed25519;
4. rechecks delivery/message/seat/generation/assignment/attempt/attempt-number/fencing/current lease and all three immutable digests;
5. maps adapter/runtime/provider evidence to the existing corresponding external `issuer_kind`;
6. appends receipt + evidence + state transition atomically under the current receipt-head CAS.

Broker `host.persisted` remains a verified broker evidence row correlated to a Mupot-issued `host.persisted` receipt; it is never mislabeled as adapter/runtime/provider. Adapter `effect.intent` and `runtime.injected`, provider-verifier `provider.observed|provider.reconciled`, and runtime `runtime.consumed|runtime.ack` each carry the immutable payload/envelope/runtime-input digests and the exact attempt tuple.

- [ ] **Step 5: Implement recovery and exact-source ACK**

`recoverFencedDelivery()` reserves recovery only from `expired|blocked -> recovery_reserved` for the exact prior attempt after its 5/15-second backoff, with a one-time broker signed request, unique idempotency key, and next attempt number no greater than 3. `leaseRecoveredFencedDelivery()` consumes that reservation once, creates a new attempt under the same generation and higher fencing epoch, and advances `recovery_reserved -> leased`; all prior-attempt signatures remain terminal. After attempt 3, wait 45 seconds and leave terminal `blocked` for decision instead of creating attempt 4.

`ackFencedDeliveryAtSource()` derives the original source from the current agent-bound workspace credential, verifies the complete same-attempt chain and exact runtime ACK receipt with matching payload/envelope/runtime-input digests, atomically advances to `source_acked`, sets `source_acked_at`, sets the linked message `read_at` to the same server timestamp, and emits `source.ack`.

- [ ] **Step 6: Run GREEN delivery checks**

```bash
npx vitest run tests/flight-spine-deliveries.test.ts tests/flight-spine-delivery-races.test.ts \
  tests/flight-spine-receipts.test.ts tests/flight-spine-assignments.test.ts \
  tests/flight-spine-audit.test.ts tests/flight-spine-seats.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 7: Independent review and commit**

Reviewer targets head races, cross-squad/cross-seat reads, source impersonation, signature substitution, stale epochs, partial writes, and replay conflicts.

```bash
git add src/flight-spine/deliveries.ts src/flight-spine/receipts.ts \
  tests/flight-spine-deliveries.test.ts tests/flight-spine-delivery-races.test.ts
git commit -m "feat: add fenced exact-seat delivery"
```

---

### Task 4: Expose Bounded MCP Tools and Isolate Generic Inbox Paths

**Files:**
- Modify: `src/agents/messages.ts`
- Modify: `src/projects/projections.ts`
- Modify: `src/bus/fleet-bridge.ts`
- Modify: `src/routines/actions.ts`
- Create: `src/mcp/flight-delivery.ts`
- Modify: `src/mcp/index.ts`
- Create: `tests/mcp-flight-delivery.test.ts`
- Create: `tests/proof-inbox-isolation.test.ts`
- Modify: `tests/agent-inbox-lease-sqlite.test.ts`
- Modify: `tests/targeted-seat-dispatch.test.ts`
- Modify: `tests/project-projections.test.ts`
- Modify: `tests/fleet-bridge.test.ts`
- Modify: `tests/routine-actions.test.ts`
- Modify: `tests/mcp-broadcast.test.ts`
- Modify: `tests/inbox-stream-delivery.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 services.
- Produces: exactly fourteen MCP tools: `runtime_signing_challenge_issue`, `runtime_signing_challenge_get`, `runtime_broker_register`, `delivery_authority_register`, `runtime_signer_register`, `runtime_seat_activate`, `envelope_ingress_authorize`, `envelope_ingress_receipt_submit`, `delivery_accept`, `delivery_lease`, `delivery_renew`, `delivery_evidence_submit`, `delivery_source_ack`, `delivery_get`.

- [ ] **Step 1: Write RED proof-inbox isolation tests**

Seed one generic seat-targeted message and one proof message for the same agent/seat. Verify every generic reader/consumer, unread-cap calculation, request replay lookup, project count/body projection, fleet-bridge/routine duplicate lookup, broadcast, signed read, HTTP stream, dead-letter list/summary, and connection-message delete returns/counts/mutates only the generic row and cannot expose proof reference metadata or alter proof lease/read/dead-letter fields.

```ts
expect((await readAgentInbox(env, { agent, seat })).messages.map((m) => m.id))
  .toEqual([genericMessageId])
expect((await leaseAgentInbox(env, { agent, seat })).messages.map((m) => m.id))
  .toEqual([genericMessageId])
expect(await ackAgentMessages(env, { agent, ids: [proofMessageId] }))
  .toMatchObject({ ok: true, refused: [proofMessageId] })
```

- [ ] **Step 2: Write RED MCP contract tests**

Require exact schemas with `additionalProperties: false`, challenge issue/read expiry and visibility, signable template/digest reproducibility with relay member/credential/squad facts absent, prior signer-registration ID/digest activation, authenticated ingress authorization/host receipt, bound-agent tools for broker/source calls, signed evidence for relayed runtime/provider facts, no caller-supplied actor/member/token/tenant/server timestamp, project/squad visibility on read, and stable error mapping.

Run:

```bash
npx vitest run tests/proof-inbox-isolation.test.ts tests/mcp-flight-delivery.test.ts
```

Expected: FAIL because generic paths still expose proof rows and tools do not exist.

- [ ] **Step 3: Exclude proof rows from every generic path**

Add `fenced_delivery_id IS NULL` inside the mutation/selection SQL—not as a preflight—to every current direct SQL surface:

```text
src/agents/messages.ts
  sendAgentMessage unread-cap subqueries (current lines 252 and 268)
  findBySenderRequestId replay SELECT (current line 387)
  readAgentInboxForReader signed/bearer SELECTs (451, 466)
  readAgentInboxForReader consuming UPDATE/subqueries (485–506)
  readAgentInboxForReader remaining counts (540, 554)
  leaseAgentInbox dead-letter UPDATE (746)
  leaseAgentInbox lease UPDATE/subquery (760–764)
  leaseAgentInbox remaining/dead counts (796)
  ackAgentMessages UPDATE and already-read lookup (849, 871)
  listDeadLetteredMessages SELECT (921)
  summarizeDeadLetters COUNT (939)
  dead-letter/detail SELECT (970)
  deleteAgentConnectionMessage DELETE (1010)
  readVerifiedSignedAgentInbox through the same filtered reader
src/projects/projections.ts
  project message count/body projections (current lines 339 and 565)
src/bus/fleet-bridge.ts
  generic request-id existence lookup (current line 136)
src/routines/actions.ts
  generic dispatch existence lookup (current line 1562)
```

Also prove `src/channels/index.ts` direct channel insert and MCP `broadcast` can create only rows with `fenced_delivery_id IS NULL`; neither may set or retrieve a proof reference. `src/agents/inbox-routes.ts` HTTP/stream output inherits the filtered service and has an explicit regression test. Preserve existing behavior byte-for-byte for rows with `fenced_delivery_id IS NULL`.

- [ ] **Step 4: Implement and register the fourteen MCP tools**

Tools call only Task 2/3 services. Challenge issue/get returns the bounded public signable template/digest and excludes relay member, credential, squad and capability facts. Envelope ingress authorization is source-agent bound; receipt submission requires the registered host-ingress signature and cannot carry plaintext. Broker/source calls require current agent-bound workspace identity. `delivery_evidence_submit` accepts a relayed signed envelope but trusts no relay claim; the service derives authority from the signature/key registry. Read responses omit bodies, signatures, public keys, lease hashes, host/process IDs, and credential IDs.

- [ ] **Step 5: Run GREEN MCP/compatibility checks**

```bash
npx vitest run tests/proof-inbox-isolation.test.ts tests/mcp-flight-delivery.test.ts \
  tests/agent-messages.test.ts tests/agent-inbox-lease-sqlite.test.ts \
  tests/inbox-fence-sqlite.test.ts tests/inbox-routes.test.ts \
  tests/inbox-stream-delivery.test.ts tests/targeted-seat-dispatch.test.ts \
  tests/project-projections.test.ts tests/fleet-bridge.test.ts \
  tests/routine-actions.test.ts tests/mcp-broadcast.test.ts \
  tests/mcp-flight-spine.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 6: Independent review and commit**

```bash
git add src/agents/messages.ts src/projects/projections.ts src/bus/fleet-bridge.ts \
  src/routines/actions.ts src/mcp/flight-delivery.ts src/mcp/index.ts \
  tests/mcp-flight-delivery.test.ts tests/proof-inbox-isolation.test.ts \
  tests/agent-inbox-lease-sqlite.test.ts tests/targeted-seat-dispatch.test.ts \
  tests/project-projections.test.ts tests/fleet-bridge.test.ts \
  tests/routine-actions.test.ts tests/mcp-broadcast.test.ts \
  tests/inbox-stream-delivery.test.ts
git commit -m "feat: expose fenced delivery tools"
```

---

### Task 5: Build the Privileged Linux Launcher and Broker/Runtime Signer Boundaries

**Files:**
- Create: `fleet-runtime/fenced-delivery/canonical.mjs`
- Create: `fleet-runtime/fenced-delivery/signer-custody.mjs`
- Create: `fleet-runtime/fenced-delivery/privileged-launcher.mjs`
- Create: `fleet-runtime/fenced-delivery/runtime-process.mjs`
- Create: `fleet-runtime/fenced-delivery/broker.mjs`
- Create: `fleet-runtime/fenced-delivery/canonical.test.mjs`
- Create: `fleet-runtime/fenced-delivery/signer-custody.test.mjs`
- Create: `fleet-runtime/fenced-delivery/privileged-launcher.test.mjs`
- Create: `fleet-runtime/fenced-delivery/runtime-process.test.mjs`
- Create: `fleet-runtime/fenced-delivery/broker.test.mjs`

**Interfaces:**
- Consumes: Task 1 canonical evidence contract; Node WebCrypto/process/fs APIs.
- Produces: canonical broker/authority/activation/evidence payloads, broker signer custody/lifecycle, privileged launcher policy, `generateRuntimeSignerAndDecryptor()`, `launchRuntimeGeneration()`, and runtime consumed/ACK signer custody/lifecycle.

- [ ] **Step 1: Write RED canonical/key tests**

Use fixed vectors to prove byte-identical canonical messages and signature verification. Reject reordered/extra/missing fields, non-base64url material, reused nonce, wrong domain, and wrong authority.

- [ ] **Step 2: Write RED UID/process tests**

With injectable stat/spawn/UID/namespace/capability operations, prove launcher, broker, adapter, provider-verifier, and runtime identities are distinct; broker/runtime signer files are regular, correct-UID, mode `0600`; parent receives only public keys + challenge signatures; broker/adapter/launcher post-exec cannot resolve the runtime private mount namespace; launcher has `CapEff=0`, `NoNewPrivs=1`, seccomp mode 2, no saved namespace/root/key-directory fd, and no ability to reopen the runtime namespace; stdout/stderr never contains private JWK fields. Add expiry, rotation, revocation, wrong-key, wrong-domain, and stale-key tests for broker and runtime custodians.

Run:

```bash
node --test fleet-runtime/fenced-delivery/canonical.test.mjs \
  fleet-runtime/fenced-delivery/signer-custody.test.mjs \
  fleet-runtime/fenced-delivery/privileged-launcher.test.mjs \
  fleet-runtime/fenced-delivery/runtime-process.test.mjs \
  fleet-runtime/fenced-delivery/broker.test.mjs
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement canonical signers and runtime-owned key generation**

`signer-custody.mjs` supplies separate broker and runtime custodians. Each validates key owner/mode/kind/domain, issued/expiry, active key generation, nonce/challenge, rotation activation time, and revocation. The runtime process, after final UID and namespace activation, creates private directory `0700`, writes Ed25519 signing and runtime-envelope decryption private JWKs `0600`, fsyncs files and parent directory, and returns only public keys plus signature over a broker challenge. Parsing errors return fixed messages that cannot echo key bytes.

- [ ] **Step 4: Implement the privileged launcher/service policy**

The launcher is the only initially privileged component. It creates four service UIDs, mount/user/PID namespaces and cgroup; mounts the runtime key directory only inside the runtime namespace; applies a deny-by-default seccomp profile and service-manager capability bounding set; closes all privileged/root/namespace/key-directory descriptors; drops capabilities; sets `NoNewPrivs`; then execs the unprivileged services. It returns only public process/namespace/policy digests. Linux is the proof platform; non-Linux execution returns `linux_required` rather than simulating success.

- [ ] **Step 5: Implement the unprivileged broker/runtime launch**

The broker validates executable digest, sandbox/cgroup IDs, four UIDs, exact seat, one-time challenge and response, and the launcher's post-exec isolation facts. It never runs as root, creates a broker-signed activation request, and cannot resolve/open the runtime private namespace. The runtime signs only `runtime.consumed` and `runtime.ack` with the exact attempt and immutable input digests.

- [ ] **Step 6: Run GREEN local-runtime checks**

```bash
node --test fleet-runtime/fenced-delivery/canonical.test.mjs \
  fleet-runtime/fenced-delivery/signer-custody.test.mjs \
  fleet-runtime/fenced-delivery/privileged-launcher.test.mjs \
  fleet-runtime/fenced-delivery/runtime-process.test.mjs \
  fleet-runtime/fenced-delivery/broker.test.mjs
node scripts/no-secrets.mjs --root fleet-runtime/fenced-delivery
git diff --check
```

- [ ] **Step 7: Independent review and commit**

```bash
git add fleet-runtime/fenced-delivery/canonical.mjs \
  fleet-runtime/fenced-delivery/signer-custody.mjs \
  fleet-runtime/fenced-delivery/privileged-launcher.mjs \
  fleet-runtime/fenced-delivery/runtime-process.mjs \
  fleet-runtime/fenced-delivery/broker.mjs \
  fleet-runtime/fenced-delivery/*.test.mjs
git commit -m "feat: isolate Flight 3 runtime signer"
```

---

### Task 6: Add the Fsynced Journal, Idempotent Provider, and Recovery Adapter

**Files:**
- Create: `fleet-runtime/fenced-delivery/journal.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-store.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-ingress.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-client.mjs`
- Create: `fleet-runtime/fenced-delivery/adapter-signer.mjs`
- Create: `fleet-runtime/fenced-delivery/provider.mjs`
- Create: `fleet-runtime/fenced-delivery/provider-verifier.mjs`
- Create: `fleet-runtime/fenced-delivery/adapter.mjs`
- Create: `fleet-runtime/fenced-delivery/journal.test.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-store.test.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-ingress.test.mjs`
- Create: `fleet-runtime/fenced-delivery/envelope-client.test.mjs`
- Create: `fleet-runtime/fenced-delivery/adapter-signer.test.mjs`
- Create: `fleet-runtime/fenced-delivery/provider.test.mjs`
- Create: `fleet-runtime/fenced-delivery/provider-verifier.test.mjs`
- Create: `fleet-runtime/fenced-delivery/adapter.test.mjs`

**Interfaces:**
- Consumes: Task 5 canonical/runtime modules and the server contract.
- Produces: authenticated create-only encrypted-envelope client/ingress/store, host-ingress receipt signer, adapter signer custody/lifecycle, `openDeliveryJournal()`, `appendJournalRecord()`, `recoverJournal()`, `FileEffectProvider`, independent `FileProviderVerifier` signer custody/lifecycle, `runDeliveryAttempt()`, `recoverDeliveryAttempt()`.

- [ ] **Step 1: Write RED journal tests**

Prove source-side encryption to the exact runtime-generation encryption public key, authenticated single-use upload authorization, 64 KiB ciphertext ceiling, create-only same-ref replay/change conflict, host receipt signature, receipt TTL, crash-safe retrieval/recovery and owner UID. Prove directory `0700`, journal/envelope `0600`, owner UID, create-only AES-256-GCM encrypted envelope bytes, RSA-OAEP-wrapped content key for the runtime encryption public key, opaque reference/digest generation, canonical JSONL records, predecessor hash chain, `fsync` after each append, directory fsync on creation, torn final-record detection, changed-history rejection, and restart state reconstruction. The adapter may read ciphertext/reference only; only the runtime decryptor returns plaintext and recomputes `runtimeInputDigest`.

- [ ] **Step 2: Write RED provider/recovery tests**

Prove one effect per `effectKey`, same-payload replay returns the original effect, changed-payload replay conflicts, lookup finds completed effects, and recovery after point 5 calls lookup but never execute. Prove adapter and provider-verifier have different UIDs/keys/domains; provider observed/reconciled evidence verifies only under the provider-verifier key; key expiry/revocation/rotation is enforced; the adapter cannot call the provider signer.

```js
await provider.execute({ effectKey, payloadDigest })
await assert.rejects(
  provider.execute({ effectKey, payloadDigest: otherDigest }),
  /effect_key_conflict/,
)
assert.equal(provider.executeCalls, 1)
assert.equal(provider.lookupCalls, 1)
```

- [ ] **Step 3: Run RED journal/provider/adapter tests**

```bash
node --test fleet-runtime/fenced-delivery/journal.test.mjs \
  fleet-runtime/fenced-delivery/envelope-store.test.mjs \
  fleet-runtime/fenced-delivery/envelope-ingress.test.mjs \
  fleet-runtime/fenced-delivery/envelope-client.test.mjs \
  fleet-runtime/fenced-delivery/adapter-signer.test.mjs \
  fleet-runtime/fenced-delivery/provider.test.mjs \
  fleet-runtime/fenced-delivery/provider-verifier.test.mjs \
  fleet-runtime/fenced-delivery/adapter.test.mjs
```

Expected: FAIL because the journal, encrypted store, adapter signer, provider verifier, and adapter modules do not exist.

- [ ] **Step 4: Implement the append-only fsynced journal and encrypted envelope store**

Each record contains `sequence`, `deliveryId`, `attemptId`, `attemptNumber`, `fencingEpoch`, `state`, all three immutable digests, `predecessorHash`, `recordHash`, and `recordedAt`. Append one newline-terminated canonical record, call `fsyncSync(fd)`, and only then return success. Recovery rejects gaps, hash mismatch, duplicate sequence with changed bytes, records from another delivery/attempt, or digest drift.

The envelope store writes create-only ciphertext locally, fsyncs file/directory, and returns `local-envelope:sha256:<digest>` plus byte length/digests. D1 never owns or retrieves these bytes. This encrypted runtime-input transport object is not a Flight 4 result artifact; it is retained for the proof window/30-day evidence period and deleted only by a separately audited retention job after Flight 3.

`envelope-client.mjs` obtains a Mupot ingress authorization, verifies its target seat/generation/key/TTL, encrypts locally, and uploads ciphertext plus authorization ID/nonce over authenticated TLS to `envelope-ingress.mjs`. The ingress binds to the dedicated lab-host service identity, permits create/read-by-runtime only, validates the single-use authorization against Mupot, stores bytes under the ciphertext digest, fsyncs, and signs `HostEnvelopeIngressReceipt`. It can retrieve the same immutable ciphertext for the exact runtime generation during recovery until expiry; it never decrypts. Exact same authorization/reference/ciphertext replay returns the first receipt; changed digest/size/reference is a conflict.

- [ ] **Step 5: Implement separate adapter and provider-verifier signer custody**

Adapter custody signs only `effect.intent` and `runtime.injected`. Provider-verifier custody signs only `provider.observed` and `provider.reconciled` after independently reading/recomputing the provider effect record. Both enforce UID/mode, active key generation, expiry, nonce/challenge, rotation and revocation. No shared key file, key object or signing callback crosses the process boundary.

- [ ] **Step 6: Implement the file-backed reference provider**

Provider storage is a separate `0700` directory with one create-only `0600` record per hashed effect key. Create uses exclusive `wx`, fsyncs the file and directory, and lookup recomputes the digest. It stores only effect key, payload digest, runtime-input digest, effect ID, and timestamp. The provider process cannot sign evidence; the separate provider-verifier process reads the public effect record and signs its observation.

- [ ] **Step 7: Implement adapter execution and recovery**

Order is fixed:

```text
persist accepted envelope -> host.persisted
persist effect intent -> submit effect.intent
provider execute OR lookup -> provider.observed/reconciled
inject exact runtime input -> runtime.injected
runtime verifies and signs consumed -> runtime.consumed
runtime completes and signs correlated ACK -> runtime.ack
return runtime ACK receipt ID to exact source
```

Every network submission is replay-safe and binds delivery/attempt/generation/assignment/fence plus all immutable digests. Recovery reads the journal and server state, refuses a lower fencing epoch or stale attempt, requests/resumes only an authorized recovery reservation, reconciles provider state when intent exists without observation, and never locally marks source ACK.

- [ ] **Step 8: Run GREEN adapter checks**

```bash
node --test fleet-runtime/fenced-delivery/journal.test.mjs \
  fleet-runtime/fenced-delivery/envelope-store.test.mjs \
  fleet-runtime/fenced-delivery/envelope-ingress.test.mjs \
  fleet-runtime/fenced-delivery/envelope-client.test.mjs \
  fleet-runtime/fenced-delivery/adapter-signer.test.mjs \
  fleet-runtime/fenced-delivery/provider.test.mjs \
  fleet-runtime/fenced-delivery/provider-verifier.test.mjs \
  fleet-runtime/fenced-delivery/adapter.test.mjs
node scripts/no-secrets.mjs --root fleet-runtime/fenced-delivery
git diff --check
```

- [ ] **Step 9: Independent review and commit**

```bash
git add fleet-runtime/fenced-delivery/journal.mjs \
  fleet-runtime/fenced-delivery/envelope-store.mjs \
  fleet-runtime/fenced-delivery/envelope-ingress.mjs \
  fleet-runtime/fenced-delivery/envelope-client.mjs \
  fleet-runtime/fenced-delivery/adapter-signer.mjs \
  fleet-runtime/fenced-delivery/provider.mjs \
  fleet-runtime/fenced-delivery/provider-verifier.mjs \
  fleet-runtime/fenced-delivery/adapter.mjs \
  fleet-runtime/fenced-delivery/journal.test.mjs \
  fleet-runtime/fenced-delivery/envelope-store.test.mjs \
  fleet-runtime/fenced-delivery/envelope-ingress.test.mjs \
  fleet-runtime/fenced-delivery/envelope-client.test.mjs \
  fleet-runtime/fenced-delivery/adapter-signer.test.mjs \
  fleet-runtime/fenced-delivery/provider.test.mjs \
  fleet-runtime/fenced-delivery/provider-verifier.test.mjs \
  fleet-runtime/fenced-delivery/adapter.test.mjs
git commit -m "feat: recover Flight 3 delivery effects"
```

---

### Task 7: Prove Fencing, Seven Crash Windows, and Point-5 SIGKILL

**Files:**
- Create: `tests/flight-spine-fenced-delivery.integration.test.ts`
- Create: `fleet-runtime/fenced-delivery/end-to-end.test.mjs`
- Create: `scripts/flight03-fault-witness.mjs`
- Create: `tests/flight03-fault-witness.test.mjs`
- Create: `.github/workflows/flight03-fenced-delivery.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: exact reviewed tips of Tasks 1–6.
- Produces: local D1 integration proof, Linux UID/key proof, seven crash/restart proofs, point-5 SIGKILL witness, and one exact receipt-chain verifier.

- [ ] **Step 1: Write the RED end-to-end proof**

The test accepts one new exact-seat request, runs two competing consumers, and requires:

```ts
expect(chain.map((receipt) => receipt.type)).toEqual([
  'message.accepted',
  'seat.leased',
  'host.persisted',
  'effect.intent',
  'provider.observed',
  'runtime.injected',
  'runtime.consumed',
  'runtime.ack',
  'source.ack',
])
expect(providerEffects).toHaveLength(1)
expect(genericInbox.messages).toHaveLength(0)
expect(proofMessage.read_at).toBe(sourceAck.serverTimestamp)
```

- [ ] **Step 2: Add all seven crash cases**

Parameterize the seven exact points above. Each restart must finish under 180 seconds, preserve one provider effect, enforce the explicit `expired|blocked -> recovery_reserved -> leased` attempt transition and 5/15/45-second policy, reject the stale attempt/consumer/signatures, preserve all immutable digests, produce one runtime ACK and one source ACK, and verify the entire execution receipt hash chain.

- [ ] **Step 3: Run the RED integration/crash tests**

```bash
npx vitest run tests/flight-spine-fenced-delivery.integration.test.ts
node --test fleet-runtime/fenced-delivery/end-to-end.test.mjs tests/flight03-fault-witness.test.mjs
```

Expected: FAIL specifically because the point-5 witness/launcher and seven restart orchestration paths do not yet exist; a schema, import, or fixture failure must be fixed before treating this as the intended RED.

- [ ] **Step 4: Add the real point-5 kill witness**

`flight03-fault-witness.mjs` uses the privileged launcher to start the unprivileged adapter under its service UID, waits until the provider effect file exists while the journal still ends at `effect_intent`, records PID/UID/delivery/attempt/effect-key digests and timestamps, sends `SIGKILL`, restarts the adapter, and proves:

```text
first process exit signal = SIGKILL
provider effect count = 1
provider execute count after restart = 0
provider lookup count after restart = 1
recovery evidence type = provider.reconciled
recovery evidence signer = independent provider-verifier key
prior attempt evidence after recovery = rejected_stale_attempt
final source ACK count = 1
```

The witness contains no body, credential, private key, or raw signature.

- [ ] **Step 5: Add the Linux CI gate**

The workflow runs on GitHub Linux, creates launcher/broker/ingress/adapter/provider-verifier/runtime service identities, executes unit/integration/fault suites, and proves: unprivileged broker/adapter/verifier/runtime UIDs; distinct mount/user/PID namespaces; runtime key mount absent from launcher/broker/adapter namespace views; launcher post-exec `CapEff=0`, `NoNewPrivs=1`, seccomp mode 2 and no saved privileged descriptor; independent signer keys/domains; and real SIGKILL/reconciliation. It runs typecheck/no-secrets/migration checks and uploads only redacted logs/witnesses. A skipped namespace, capability, signer, UID, or SIGKILL check is a failure, not a pass.

- [ ] **Step 6: Run GREEN integration checks**

```bash
npx vitest run tests/flight-spine-fenced-delivery.integration.test.ts \
  tests/flight-spine-deliveries.test.ts tests/proof-inbox-isolation.test.ts \
  tests/mcp-flight-delivery.test.ts
node --test fleet-runtime/fenced-delivery/*.test.mjs tests/flight03-fault-witness.test.mjs
npm run typecheck
node scripts/check-migration-numbering.mjs
node scripts/no-secrets.mjs --root .
git diff --check
```

Expected locally on Linux: all pass. On non-Linux, pure unit suites pass but the candidate cannot be gated until the required Linux workflow proves the non-skipped namespace/capability/UID/key-custody/SIGKILL checks.

- [ ] **Step 7: Independent integration review and commit**

```bash
git add tests/flight-spine-fenced-delivery.integration.test.ts \
  fleet-runtime/fenced-delivery/end-to-end.test.mjs \
  scripts/flight03-fault-witness.mjs tests/flight03-fault-witness.test.mjs \
  .github/workflows/flight03-fenced-delivery.yml package.json
git commit -m "test: prove Flight 3 crash recovery"
```

---

### Task 8: Freeze the Package, Obtain an Independent Gate, and Land the Implementation Flight

**Files:**
- Create: `docs/receipts/flight-03-fenced-delivery-candidate.json`
- Create: `docs/receipts/flight-03-fenced-delivery-manifest.json`
- Create: `docs/superpowers/handoffs/2026-08-24-flight-03-governed-packet.md`
- Create: `tests/flight-03-package.test.mjs`
- Independent gate worktree only: `docs/receipts/flight-03-fenced-delivery-gate-verdict.json`

**Interfaces:**
- Consumes: reviewed Task 1–7 commits, Linux CI evidence, and the Task 0 circuit/flight/tasks/receipts.
- Produces: immutable candidate SHA/tree/file digests, separately authored PASS/BLOCK verdict tied to exact bytes, completed Task 0 implementation-flight receipts, and the remaining deployment/proof decision packet. It creates no new flight and performs no migration/deploy/credential/seat/fault mutation.

- [ ] **Step 1: Write and run the RED package contract**

`tests/flight-03-package.test.mjs` requires candidate/manifest schema, exact Task 0 circuit/flight/task IDs plus available dispatch/targeted-message/transport-ACK/runtime-read evidence and explicit missing-receipt caveats, Task 1–7 commit map, file/log digests, Linux witness, migration reservation, scope exclusions, five decision receipts/statuses, and absence of secrets/private payloads. It rejects an inline or package-writer-authored gate verdict.

```bash
node --test tests/flight-03-package.test.mjs
```

Expected: FAIL with missing candidate/manifest/governed-packet files. A syntax/import failure is not the intended RED.

- [ ] **Step 2: Re-fetch Git and the live migration ledger; fail on collision**

```bash
git fetch origin main --prune
git merge-base --is-ancestor 890a0209c0846c9ce7b4f4561ab13523ddf9a21c origin/main
git merge-base --is-ancestor 890a0209c0846c9ce7b4f4561ab13523ddf9a21c HEAD
git merge-base --is-ancestor origin/main HEAD
git ls-tree -r --name-only origin/main migrations | sort | tail -10
npx wrangler d1 execute mupot --remote --config /Users/hadi/dev/mumega/mupot/wrangler.toml --command "SELECT id,name,applied_at FROM d1_migrations ORDER BY id DESC LIMIT 3;"
npx wrangler d1 migrations list mupot --remote --config /Users/hadi/dev/mumega/mupot/wrangler.toml
```

Expected: `origin/main` is an ancestor of the candidate; the listed `origin/main` migration tail ends at exactly `0126_decision_requests.sql` and contains no `0127`/`0128`; live ledger head is exactly `0126_decision_requests.sql`; neither `0127` nor `0128` is applied; the remote pending set from the candidate worktree is exactly `0127_runtime_brokers.sql` and `0128_fenced_deliveries.sql`; no different migration owns either number. Any changed live head, missing/extra pending migration, or repository numbering conflict stops packaging and returns to Task 1 for a reviewed renumber/rebase.

- [ ] **Step 3: Freeze and verify the exact candidate**

```bash
test "$(git status --porcelain)" = ""
node scripts/check-migration-numbering.mjs
node --test tests/migration-numbering.test.mjs
npx vitest run tests/flight-spine-*.test.ts tests/mcp-flight-*.test.ts tests/proof-inbox-isolation.test.ts
node --test fleet-runtime/fenced-delivery/*.test.mjs tests/flight03-fault-witness.test.mjs
npm test
npm run typecheck
node scripts/no-secrets.mjs --root .
git diff --check 890a0209c0846c9ce7b4f4561ab13523ddf9a21c..HEAD
```

Record exact commands, exit codes, counts, log digests, source SHA, tree SHA, migration hashes, file hashes, role identities, budget/TTLs, crash witnesses, and scope exclusions. Do not embed untracked logs that a reviewer cannot fetch.

- [ ] **Step 4: Package the existing governed flight**

The packet records rather than creates:

```yaml
flight_key: FLIGHT-SPINE-DELIVERY-03
task_0_circuit_id_source: task0.circuit_create_receipt.circuit_id
task_0_flight_id_source: task0.flight_create_receipt.flight_id
executor: canonical hadi-codex (087a816b-ab9f-400f-8d53-f6f97b94a725)
budget_micro_usd: 10000000
overall_ttl_seconds: 28800
writer_ttl_seconds: 5400
writer_renewal_seconds: 2700
gate_ttl_seconds: 2700
waves:
  - task_1_schema
  - parallel:
      - server_lane: [task_2_broker, task_3_delivery, task_4_mcp]
      - linux_lane: [task_5_runtime, task_6_adapter]
  - task_7_integration
  - task_8_package_gate
gate:
  owner: hadi-grok
  independence: no author/coordinator/integrator credential, key, worktree, or mutable artifact
stop_on:
  - identity_or_migration_collision
  - cross_lane_edit
  - budget_or_ttl_breach
  - missing_linux_uid_or_sigkill_witness
  - test_or_secret_scan_failure
  - gate_block
```

Resolve both Task 0 receipt sources to exact UUID values before commit; the package test rejects unresolved source expressions. Include every Task 0 task/dependency/dispatch/targeted-message record and each honestly available transport-ACK/runtime-read fact, with missing delivery/consumption/correlated-ACK receipts recorded as Flight 3 done-when caveats. The budget decision is already consumed by Task 0 and has an exact receipt. Broker credential, exact lab seat, live fault injection, and migration/deploy/cutover remain separately unchecked.

- [ ] **Step 5: Make the package test GREEN and commit package-writer files**

```bash
node --test tests/flight-03-package.test.mjs
git diff --check
git add docs/receipts/flight-03-fenced-delivery-candidate.json docs/receipts/flight-03-fenced-delivery-manifest.json docs/superpowers/handoffs/2026-08-24-flight-03-governed-packet.md tests/flight-03-package.test.mjs
git commit -m "docs: package Flight 3 fenced delivery"
```

Expected: package test and diff pass; the commit contains no gate verdict.

- [ ] **Step 6: Run the independent gate in a separate worktree**

Hadi Grok fetches the exact package commit in a separate review worktree and independently checks migration/live-ledger collision, exact-seat/no-broadcast invariants, all enumerated generic inbox surfaces, encrypted-reference/no-body rule, authority/key custody/lifecycle, signature/replay negatives, journal/fsync semantics, provider-verifier independence, attempt recovery/backoff, two-consumer fencing, seven crash windows, Linux launcher/namespace/capability isolation, point-5 kill witness, exact-source ACK gate, and scope exclusions.

The gate owner—not the package writer—creates `docs/receipts/flight-03-fenced-delivery-gate-verdict.json` on a separate gate branch/commit. The verdict names exact source candidate SHA/tree and package SHA/tree, exact review commands/evidence digests, reviewer canonical identity/seat, PASS or reproducible BLOCK, timestamp, and no mutable/unfetchable evidence. The gate commit must be pushed/fetchable before Mupot records the verdict. A repair returns to the owning task and counts toward its five-round ceiling.

- [ ] **Step 7: Record the verdict and land the existing implementation flight**

After a fetchable PASS, Hadi Grok submits the exact verdict to the predeclared Task 0 gate. Verify only the honest receipts the current legacy Mupot circuit/task/gate/flight APIs can produce: gate verdict attribution, task status mutation receipt/event where available, flight status transition, recorded cost field, and legacy landing/close receipt only if the current service actually emits one. Flight Spine `task.completed`, `cost.finalized`, and `flight.landed` receipts are explicitly deferred to Flight 5 and are not Task 8 requirements. If the current legacy implementation flight cannot honestly close, leave it blocked with the exact missing legacy transition/evidence—never synthesize or relabel a Flight Spine receipt.

- [ ] **Step 8: Stop for the remaining four Hadi decisions**

No migration, deploy, credential, active seat, or fault is executed here. The $10 budget decision was used only by Task 0. After separate approvals for broker credential, exact lab seat, live fault injection, and migration/deploy/cutover:

1. back up D1 and apply the separately gated migrations;
2. deploy the exact candidate;
3. create/use the approved broker credential without exposing it;
4. activate only the approved Linux lab seat;
5. accept one fresh $10-capped proof objective;
6. run the exact-seat canary and approved point-5 fault;
7. verify delivery, consumption, correlated runtime ACK, exact-source ACK, one provider effect, recovery under 180 seconds, and full receipt chain;
8. record the production proof and either cut over the single lab seat or roll back the Worker under the approved boundary.

Flight 3 closes only after that live proof. A green PR or local/CI proof alone does not close it.

## How Flights 4–11 Reach the Three-Squad Objective

This plan does not claim any later flight:

| Flight | Adds after Flight 3 | Why it is required |
|---|---|---|
| 4 — Result/Artifact | create-only artifact bytes, retrieval, result reporting | workers must produce inspectable outputs |
| 5 — Gate/Land | independent verdict, guarded completion/cost/landing | a delivery chain is not a completed governed flight |
| 6 — Controller | objective composition, fenced controller, retry/budget, recovery | removes Hadi from pane-by-pane scheduling |
| 7 — Adapter Conformance | ports the proven reference contract to selected real harnesses | converts one lab adapter into usable fleet runtimes |
| 8 — Hadi-Mac Autonomy | fresh parallel Hadi-Mac lanes, integration, Hadi-Grok gate, fault, landing | first full autonomous squad proof |
| 9 — Mumega HQ Autonomy | fresh HQ parallel lanes, integration, Athena gate, fault, landing | second full autonomous squad proof |
| 10 — Mupot OS Autonomy | exact VM identities, parallel outputs, Athena gate, restart, landing | third full autonomous squad proof |
| 11 — Cross-Squad Autonomy | parent creates all three overlapping child flights, integrates current PASS outputs, controller takeover | proves cross-squad operation without manually attached evidence |

Flight 12 then exposes the proven portfolio projection in Codex Desktop and demonstrates that only genuine authority/business decisions escalate. Until Flights 4–12 pass, the overall three-squad objective remains incomplete.

## Plan Self-Review

- Spec coverage: Task 0 establishes governance using honest current evidence/caveats; Flight 3 challenge/PoP registration, encrypted ingress, broker, exact-seat delivery, signed authority separation, journal/provider recovery, seven crash windows, two-consumer fencing, Linux isolation, and exact-source ACK map to Tasks 1–7; packaging, independent gate, honest legacy close/block, and remaining decision boundaries map to Task 8.
- Scope exclusions: artifact/result product surfaces, Flight Spine gate/task-completion/cost/landing semantics, controller, portfolio and harness ports are explicitly deferred. Task 8 uses only existing legacy governance state and never claims Flight 5 receipts.
- Type consistency: all later tasks consume the stable names in “Stable Flight 3 Interfaces.”
- Collision check: Task 0 owns external governance only; Tasks 2–4 and Tasks 5–6 own disjoint files; Task 7 owns only integration/proof surfaces; Task 8 package writer and independent gate own separate commits/files.
- Placeholder scan: no implementation step depends on an unspecified type, file, test command, decision owner, or acceptance condition.
