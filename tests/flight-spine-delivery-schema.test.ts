import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyAllMigrations, resetMigrationCache } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-3'
const T0 = '2026-08-24T12:00:00.000Z'
const T5 = '2026-08-24T12:00:05.000Z'
const T20 = '2026-08-24T12:00:20.000Z'
const T35 = '2026-08-24T12:00:35.000Z'
const T60 = '2026-08-24T12:01:00.000Z'
const T80 = '2026-08-24T12:01:20.000Z'
const T300 = '2026-08-24T12:05:00.000Z'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)
const FP_A = 'v1:' + 'a'.repeat(64)
const FP_B = 'v1:' + 'b'.repeat(64)
const FP_C = 'v1:' + 'c'.repeat(64)
const FP_D = 'v1:' + 'd'.repeat(64)
const FP_E = 'v1:' + 'e'.repeat(64)
const FP_F = 'v1:' + 'f'.repeat(64)
const FP_G = 'v1:' + '0'.repeat(64)

let harness: SqliteD1Harness

function seedBase(): void {
  harness.sqlite.exec([
    "INSERT INTO departments (id, slug, name) VALUES ('department-f3','f3','Flight 3');",
    "INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-f3','department-f3','f3','Flight 3');",
    "INSERT INTO agents (id,squad_id,slug,name,status) VALUES ('agent-source','squad-f3','source','Source','active'),('agent-runtime','squad-f3','runtime','Runtime','active'),('agent-broker','squad-f3','broker','Broker','active');",
    "INSERT INTO members (id,tenant,display_name,status) VALUES ('member-source','" + TENANT + "','Source','active'),('member-runtime','" + TENANT + "','Runtime','active'),('member-broker','" + TENANT + "','Broker','active');",
    "INSERT INTO agent_member_bindings (tenant,agent_id,member_id,created_at) VALUES ('" + TENANT + "','agent-source','member-source','" + T0 + "'),('" + TENANT + "','agent-runtime','member-runtime','" + T0 + "'),('" + TENANT + "','agent-broker','member-broker','" + T0 + "');",
    "INSERT INTO member_tokens (id,member_id,tenant,token_hash,agent_id,label,channel,created_at,expires_at) VALUES ('token-source','member-source','" + TENANT + "','hash-source','agent-source','source','workspace','" + T0 + "','" + T300 + "'),('token-broker','member-broker','" + TENANT + "','hash-broker','agent-broker','broker','workspace','" + T0 + "','" + T300 + "');",
    "INSERT INTO memberships (id,agent_id,squad_id,capability) VALUES ('membership-source','agent-source','squad-f3','member'),('membership-runtime','agent-runtime','squad-f3','member'),('membership-broker','agent-broker','squad-f3','member');",
    "INSERT INTO flights (id,tenant,agent,goal,status) VALUES ('flight-f3','" + TENANT + "','agent-source','Fenced delivery','running');",
    "INSERT INTO tasks (id,squad_id,title,status,assignee_agent_id,assignment_epoch) VALUES ('task-f3','squad-f3','Delivery lane','open','agent-runtime',1);",
    "INSERT INTO objectives (id,tenant,created_by_principal_kind,created_by_principal_id,created_by_member_id,squad_id,project_id,title,success_contract,authority_envelope,policy_json,budget_micro_usd,payload_json,payload_digest,accepted_at,created_at) VALUES ('objective-f3','" + TENANT + "','agent','agent-source','member-source','squad-f3',NULL,'Flight 3','Deliver exactly once','{}','{}',10000000,'{}','" + SHA_A + "','" + T0 + "','" + T0 + "');",
    "INSERT INTO runtime_seats (id,tenant,agent_id,seat_name,host_id,adapter_kind,state,current_generation,current_fencing_epoch,capabilities_json,created_at,updated_at) VALUES ('seat-runtime','" + TENANT + "','agent-runtime','runtime-seat','host-1','reference','active',1,0,'[]','" + T0 + "','" + T0 + "'),('seat-other','" + TENANT + "','agent-runtime','other-seat','host-1','reference','active',1,0,'[]','" + T0 + "','" + T0 + "');",
    "INSERT INTO runtime_seat_generations (id,tenant,runtime_seat_id,generation,host_id,process_id,process_uid,sandbox_id,executable_digest,public_key,broker_attestation_digest,started_at,created_at) VALUES ('generation-runtime','" + TENANT + "','seat-runtime',1,'host-1','pid-1','1004','sandbox-1','" + SHA_A + "','runtime-public','" + SHA_B + "','" + T0 + "','" + T0 + "'),('generation-other','" + TENANT + "','seat-other',1,'host-1','pid-2','1005','sandbox-2','" + SHA_A + "','other-public','" + SHA_B + "','" + T0 + "','" + T0 + "');",
  ].join('\n'))
}

function columns(table: string): string[] {
  return harness.sqlite.prepare('PRAGMA table_info(' + table + ')').all()
    .map((row) => String(row.name))
}

function insertChallenge(
  id: string,
  domain: string,
  kind: string,
  authorityId: string | null,
  resourceId: string,
  nonce: string,
): void {
  harness.sqlite.prepare(
    'INSERT INTO runtime_signing_challenges (id,tenant,requested_by_agent_id,domain,authority_kind,authority_id,resource_id,nonce,signable_payload_template,signable_payload_digest,issued_at,expires_at,consumed_at,consumed_request_digest,created_at) VALUES (?,?,' +
    "'agent-broker',?,?,?,?,?,'template',?,?,?,NULL,NULL,?)",
  ).run(id, TENANT, domain, kind, authorityId, resourceId, nonce.padEnd(16,'x'), SHA_A, T0, T60, T0)
}

function seedBrokerAndSigners(authorityBrokerId = 'broker-1'): void {
  insertChallenge('challenge-broker','mupot-runtime-broker-register:v1','broker',null,'host-1','nonce-broker')
  harness.sqlite.prepare(
    "INSERT INTO runtime_brokers (id,tenant,agent_id,member_id,credential_id,host_id,public_key,key_fingerprint,state,registration_digest,challenge_id,registered_at,expires_at,revoked_at,created_at) VALUES ('broker-1',?,'agent-broker','member-broker','token-broker','host-1','broker-public',?,'active',?,'challenge-broker',?,?,NULL,?)",
  ).run(TENANT, FP_A, SHA_A, T0, T300, T0)

  if (authorityBrokerId === 'broker-2') {
    insertChallenge(
      'challenge-broker-2','mupot-runtime-broker-register:v1',
      'broker',null,'host-2','nonce-broker-2',
    )
    harness.sqlite.prepare(
      "INSERT INTO runtime_brokers (id,tenant,agent_id,member_id,credential_id,host_id,public_key,key_fingerprint,state,registration_digest,challenge_id,registered_at,expires_at,revoked_at,created_at) VALUES ('broker-2',?,'agent-broker','member-broker','token-broker','host-2','broker-public-2',?,'active',?,'challenge-broker-2',?,?,NULL,?)",
    ).run(TENANT,FP_G,'0'.repeat(64),T0,T300,T0)
  }

  const authorities = [
    ['ingress','authority-ingress',FP_B,SHA_B],
    ['adapter','authority-adapter',FP_C,SHA_C],
    ['provider_verifier','authority-provider',FP_D,SHA_D],
  ]
  for (const [kind,id,fingerprint,digest] of authorities) {
    const challenge = 'challenge-' + kind
    insertChallenge(challenge,'mupot-delivery-authority-register:v1',kind,id,'seat-runtime:1','nonce-' + kind)
    harness.sqlite.prepare(
      "INSERT INTO runtime_delivery_authorities (id,tenant,broker_id,runtime_seat_id,generation,authority_kind,public_key,key_fingerprint,proof_of_possession_digest,challenge_id,registration_digest,state,issued_at,expires_at,revoked_at,created_at) VALUES (?,?,?,'seat-runtime',1,?,?,?,?,?,?,'active',?,?,NULL,?)",
    ).run(
      id,TENANT,authorityBrokerId,kind,kind + '-public',fingerprint,digest,
      challenge,digest,T0,T300,T0,
    )
  }

  insertChallenge('challenge-runtime','mupot-runtime-signer-register:v1','runtime','runtime-signer-1','seat-runtime:1','nonce-runtime')
  harness.sqlite.prepare(
    "INSERT INTO runtime_signer_registrations (id,tenant,runtime_seat_id,generation,signing_public_key,encryption_public_key,signing_key_fingerprint,encryption_key_fingerprint,proof_of_possession_digest,challenge_id,registration_digest,state,issued_at,expires_at,revoked_at,created_at) VALUES ('runtime-signer-1',?,'seat-runtime',1,'runtime-signing-public','runtime-encryption-public',?,?,?,'challenge-runtime',?,'active',?,?,NULL,?)",
  ).run(TENANT,FP_E,FP_F,SHA_A,SHA_B,T0,T300,T0)
}

function seedIngress(): void {
  harness.sqlite.prepare(
    "INSERT INTO encrypted_envelope_ingress_authorizations (id,tenant,source_agent_id,runtime_seat_id,generation,recipient_encryption_key_id,payload_digest,runtime_input_digest,maximum_bytes,upload_nonce,idempotency_key,issued_at,expires_at,consumed_at,created_at) VALUES ('ingress-auth-1',?,'agent-source','seat-runtime',1,'runtime-signer-1',?,?,65536,'upload-nonce-0001','ingress-key-1',?,?,NULL,?)",
  ).run(TENANT,SHA_A,SHA_B,T0,T60,T0)
  harness.sqlite.prepare(
    "INSERT INTO host_envelope_ingress_receipts (id,tenant,authorization_id,runtime_seat_id,generation,recipient_encryption_key_id,envelope_ref,ciphertext_digest,envelope_digest,payload_digest,runtime_input_digest,byte_length,stored_at,expires_at,host_authority_id,canonical_payload_digest,signature,created_at) VALUES ('ingress-receipt-1',?,'ingress-auth-1','seat-runtime',1,'runtime-signer-1',?,?,?,?,?,128,?,?,'authority-ingress',?,'ingress-signature',?)",
  ).run(
    TENANT,'local-envelope:sha256:' + SHA_C,SHA_C,SHA_D,SHA_A,SHA_B,
    T0,T300,SHA_D,T0,
  )
}

function insertDelivery(id: string, messageId: string, seat = 'seat-runtime'): void {
  harness.sqlite.prepare(
    "INSERT INTO fenced_deliveries (id,tenant,message_id,source_agent_id,source_member_id,objective_id,flight_id,task_id,assignment_epoch,runtime_seat_id,generation,ingress_receipt_id,request_id,effect_key,envelope_ref,ciphertext_digest,envelope_digest,payload_digest,runtime_input_digest,state,active_attempt_id,active_attempt_number,current_fencing_epoch,accepted_at,updated_at,source_acked_at) VALUES (?, ?, ?, 'agent-source','member-source','objective-f3','flight-f3','task-f3',1,?,1,'ingress-receipt-1',?,?, ?, ?, ?, ?, ?,'accepted',NULL,0,0,?,?,NULL)",
  ).run(
    id,TENANT,messageId,seat,'request-' + messageId,'effect-' + id,
    'local-envelope:sha256:' + SHA_C,SHA_C,SHA_D,SHA_A,SHA_B,T0,T0,
  )
}

function proofBody(deliveryId: string): string {
  void deliveryId
  return JSON.stringify({
    schema: 'mupot-proof-ref:v1',
    ref: 'local-envelope:sha256:' + SHA_C,
    payload_digest: SHA_A,
    envelope_digest: SHA_D,
    ciphertext_digest: SHA_C,
    runtime_input_digest: SHA_B,
    size: 128,
    recipient_generation: 1,
  })
}

function strictProofBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...JSON.parse(proofBody('strict')),
    ...extra,
  })
}

interface ProofMessageOverrides {
  toAgent?: string
  fromAgent?: string
  fromMember?: string
  kind?: string
  requestId?: string
  body?: string
}

function insertProofMessage(
  deliveryId: string,
  messageId: string,
  targetSeat: string | null,
  overrides: ProofMessageOverrides = {},
): void {
  harness.sqlite.prepare(
    'INSERT INTO agent_messages (id,tenant,to_agent,from_agent,from_member,kind,body,request_id,created_at,target_seat,fenced_delivery_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    messageId,
    TENANT,
    overrides.toAgent ?? 'agent-runtime',
    overrides.fromAgent ?? 'agent-source',
    overrides.fromMember ?? 'member-source',
    overrides.kind ?? 'request',
    overrides.body ?? proofBody(deliveryId),
    overrides.requestId ?? 'request-' + messageId,
    T0,
    targetSeat,
    deliveryId,
  )
}

function insertLease(id: string, fencingEpoch: number): void {
  harness.sqlite.prepare(
    "INSERT INTO runtime_seat_leases (id,tenant,runtime_seat_id,generation,fencing_epoch,consumer_id,lease_token_hash,state,leased_at,expires_at) VALUES (?,?,'seat-runtime',1,?,?,?,'active',?,?)",
  ).run(id,TENANT,fencingEpoch,'consumer-' + id,SHA_A,T0,T60)
}

function insertAttempt(
  id: string,
  deliveryId: string,
  number: number,
  leaseId: string,
  priorFence: number,
  fence: number,
  state = 'leased',
  endedAt: string | null = null,
  retryNotBefore = number === 1 ? T0 : number === 2 ? T5 : T35,
  leasedAt = retryNotBefore,
): void {
  harness.sqlite.prepare(
    "INSERT INTO fenced_delivery_attempts (id,tenant,delivery_id,attempt_number,attempt_nonce,generation,prior_fencing_epoch,fencing_epoch,runtime_seat_lease_id,state,leased_at,expires_at,retry_not_before,ended_at,created_at) VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,TENANT,deliveryId,number,'nonce-' + id,priorFence,fence,leaseId,state,
    leasedAt,T60,retryNotBefore,endedAt,T0,
  )
}

interface ReceiptOverrides {
  objectiveId?: string
  flightId?: string
  taskId?: string
  messageId?: string
}

function insertReceipt(
  id: string,
  type: string,
  issuerKind: string,
  issuerId: string,
  overrides: ReceiptOverrides = {},
): void {
  harness.sqlite.prepare(
    "INSERT INTO execution_receipts (id,tenant,type,issuer_kind,issuer_id,actor_kind,actor_id,seat_id,seat_generation,objective_id,flight_id,task_id,message_id,assignment_epoch,fencing_epoch,lease_token_hash,idempotency_key,claims_json,canonical_payload,payload_digest,predecessor_receipt_id,predecessor_hash,receipt_hash,server_timestamp) VALUES (?,?,?, ?,?,'agent','agent-runtime','seat-runtime',1,?,?,?,?,1,1,NULL,?,'{}','{}',?,NULL,NULL,?,?)",
  ).run(
    id,TENANT,type,issuerKind,issuerId,
    overrides.objectiveId ?? 'objective-f3',
    overrides.flightId ?? 'flight-f3',
    overrides.taskId ?? 'task-f3',
    overrides.messageId ?? 'message-chain',
    'key-' + id,SHA_A,SHA_B,T0,
  )
}

function insertEvidence(
  id: string,
  deliveryId: string,
  attemptId: string,
  evidenceType: string,
  authorityKind: string,
  authorityId: string,
  issuerKind: string,
  receiptIssuerId = authorityId,
  receiptOverrides: ReceiptOverrides = {},
): void {
  const challenge = 'challenge-' + id
  insertChallenge(
    challenge,
    'mupot-fenced-delivery-evidence:v1',
    authorityKind,
    authorityId,
    deliveryId + ':' + evidenceType,
    'nonce-' + id,
  )
  const receiptId = 'receipt-' + id
  insertReceipt(receiptId,evidenceType,issuerKind,receiptIssuerId,receiptOverrides)
  harness.sqlite.prepare(
    "INSERT INTO fenced_delivery_evidence (id,tenant,delivery_id,attempt_id,attempt_number,authority_kind,authority_id,evidence_type,message_id,runtime_seat_id,generation,assignment_epoch,fencing_epoch,effect_key,payload_digest,ciphertext_digest,envelope_digest,runtime_input_digest,provider_effect_id,occurred_at,issued_at,expires_at,nonce,challenge_id,canonical_payload_digest,signature,execution_receipt_id,created_at) VALUES (?,?,?, ?,1,?,?,?,'message-chain','seat-runtime',1,1,1,?,?,?,?,?,NULL,?,?,?,?,?,?,'signature',?,?)",
  ).run(
    id,TENANT,deliveryId,attemptId,authorityKind,authorityId,evidenceType,
    'effect-' + deliveryId,SHA_A,SHA_C,SHA_D,SHA_B,T0,T0,T60,'nonce-evidence-' + id,
    challenge,SHA_D,receiptId,T0,
  )
}

function insertBrokerAttestation(
  id: string,
  adapterRegistrationDigest: string,
  launcherCapabilityDigest: string,
): void {
  insertChallenge(
    'challenge-' + id,
    'mupot-runtime-generation-activate:v1',
    'broker',
    'broker-1',
    'seat-runtime:1',
    'nonce-' + id,
  )
  harness.sqlite.prepare(
    "INSERT INTO runtime_broker_attestations (id,tenant,broker_id,runtime_seat_id,generation,host_id,process_id,launcher_process_id,broker_uid,adapter_uid,provider_verifier_uid,runtime_uid,sandbox_id,mount_namespace_id,user_namespace_id,cgroup_id,executable_digest,ingress_authority_registration_id,ingress_authority_registration_digest,adapter_authority_registration_id,adapter_authority_registration_digest,provider_verifier_authority_registration_id,provider_verifier_authority_registration_digest,runtime_signer_registration_id,runtime_signer_registration_digest,challenge_id,challenge_nonce_digest,challenge_signature,launcher_capability_digest,launcher_seccomp_digest,launcher_service_policy_digest,post_exec_no_new_privs,post_exec_effective_capabilities,post_exec_seccomp_mode,broker_runtime_namespace_visible,adapter_runtime_namespace_visible,launcher_runtime_namespace_visible_after_exec,canonical_payload_digest,signature,signed_at,created_at) VALUES (?,?, 'broker-1','seat-runtime',1,'host-1','pid-runtime','pid-launcher','1001','1002','1003','1004','sandbox-1','mnt-1','userns-1','cgroup-1',?,'authority-ingress',?,'authority-adapter',?,'authority-provider',?,'runtime-signer-1',?, ?,?,'challenge-signature',?,?,?,1,'0000000000000000',2,0,0,0,?,'broker-signature',?,?)",
  ).run(
    id,TENANT,SHA_A,SHA_B,adapterRegistrationDigest,SHA_D,SHA_B,
    'challenge-' + id,SHA_A,launcherCapabilityDigest,SHA_B,SHA_C,SHA_D,T0,T0,
  )
}

function seedLeasedEvidenceDelivery(): void {
  seedBrokerAndSigners()
  seedIngress()
  insertDelivery('delivery-evidence','message-chain')
  insertProofMessage('delivery-evidence','message-chain','seat-runtime')
  insertLease('lease-evidence',1)
  insertAttempt('attempt-evidence','delivery-evidence',1,'lease-evidence',0,1)
  harness.sqlite.exec(
    "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-evidence',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-evidence'",
  )
}

function insertRecoveryReservation(
  id: string,
  deliveryId: string,
  priorAttemptId: string,
  priorAttemptNumber: number,
  priorFence: number,
  nextAttemptNumber: number,
  reservedAt: string,
): void {
  harness.sqlite.prepare(
    "INSERT INTO fenced_delivery_recovery_reservations (id,tenant,delivery_id,prior_attempt_id,prior_attempt_number,prior_fencing_epoch,next_attempt_number,broker_id,consumer_id,idempotency_key,reservation_nonce,state,reserved_at,retry_not_before,expires_at,consumed_at,created_at) VALUES (?,?,?,?,?,?,?,'broker-1',?,?,?,'reserved',?,?,?,NULL,?)",
  ).run(
    id,TENANT,deliveryId,priorAttemptId,priorAttemptNumber,priorFence,
    nextAttemptNumber,'consumer-' + id,'key-' + id,'nonce-' + id,
    reservedAt,reservedAt,T300,reservedAt,
  )
}

function reserveAndConsumeRecovery(
  reservationId: string,
  deliveryId: string,
  priorAttemptId: string,
  priorAttemptNumber: number,
  priorFence: number,
  nextAttemptNumber: number,
  reservedAt: string,
): void {
  insertRecoveryReservation(
    reservationId,deliveryId,priorAttemptId,priorAttemptNumber,priorFence,
    nextAttemptNumber,reservedAt,
  )
  harness.sqlite.prepare(
    'UPDATE fenced_delivery_attempts SET state=?,ended_at=? WHERE id=?',
  ).run('recovery_reserved',reservedAt,priorAttemptId)
  harness.sqlite.prepare(
    'UPDATE fenced_deliveries SET state=?,updated_at=? WHERE id=?',
  ).run('recovery_reserved',reservedAt,deliveryId)
  harness.sqlite.prepare(
    'UPDATE fenced_delivery_recovery_reservations SET state=?,consumed_at=? WHERE id=?',
  ).run('consumed',reservedAt,reservationId)
  harness.sqlite.prepare(
    'UPDATE fenced_delivery_attempts SET state=?,ended_at=? WHERE id=?',
  ).run('stale',reservedAt,priorAttemptId)
}

beforeEach(() => {
  resetMigrationCache()
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedBase()
})

afterEach(() => harness.close())

describe('Flight 3 real migration schema', () => {
  it('creates every broker and fenced-delivery table on the full production migration chain', () => {
    const tables = harness.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runtime_brokers','runtime_delivery_authorities','runtime_signer_registrations','runtime_broker_attestations','runtime_signing_challenges','runtime_signed_request_replays','encrypted_envelope_ingress_authorizations','host_envelope_ingress_receipts','fenced_deliveries','fenced_delivery_attempts','fenced_delivery_recovery_reservations','fenced_delivery_evidence') ORDER BY name",
    ).all().map((row) => String(row.name))
    expect(tables).toHaveLength(12)
    expect(columns('agent_messages')).toContain('fenced_delivery_id')
    expect(columns('fenced_deliveries')).toEqual(expect.arrayContaining([
      'payload_digest','ciphertext_digest','envelope_digest',
      'runtime_input_digest','ingress_receipt_id',
    ]))
  })

  it('rejects null, label, and wrong-seat proof targets but accepts the exact runtime seat id', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-target','message-target')
    expect(() => insertProofMessage('delivery-target','message-target',null)).toThrow(/exact runtime seat/)
    expect(() => insertProofMessage('delivery-target','message-target','runtime-seat')).toThrow(/exact runtime seat/)
    expect(() => insertProofMessage('delivery-target','message-target','seat-other')).toThrow(/exact runtime seat/)
    expect(() => insertProofMessage('delivery-target','message-target','seat-runtime')).not.toThrow()
  })

  it('rejects direct proof read_at before terminal source ACK', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-read','message-read')
    insertProofMessage('delivery-read','message-read','seat-runtime')
    expect(() => harness.sqlite.exec(
      "UPDATE agent_messages SET read_at='" + T60 + "' WHERE id='message-read'",
    )).toThrow(/exact source ack/)
  })

  it('rejects source_acked_at before the runtime_acked to source_acked transition', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-early-ack','message-early-ack')
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET source_acked_at='" + T60 + "' WHERE id='delivery-early-ack'",
    )).toThrow(/source ack timestamp/)
  })

  it('refuses deletion of a proof message so the source record cannot be orphaned', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-delete','message-delete')
    insertProofMessage('delivery-delete','message-delete','seat-runtime')
    expect(() => harness.sqlite.exec(
      "DELETE FROM agent_messages WHERE id='message-delete'",
    )).toThrow(/proof message/)
  })

  it.each([
    ['source agent', { fromAgent: 'agent-broker' }],
    ['source member', { fromMember: 'member-broker' }],
    ['request kind', { kind: 'message' }],
    ['request identity', { requestId: 'wrong-request-id' }],
  ])('binds proof message %s to immutable delivery source facts', (_label, overrides) => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-source','message-source')
    expect(() => insertProofMessage(
      'delivery-source','message-source','seat-runtime',overrides,
    )).toThrow(/proof delivery source/)
  })

  it('accepts only the exact bounded opaque proof metadata body', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-body','message-body')
    expect(() => insertProofMessage(
      'delivery-body','message-body','seat-runtime',{ body: strictProofBody() },
    )).not.toThrow()
  })

  it.each(['plaintext','prompt'])('rejects an extra %s field in proof metadata', (field) => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-extra','message-extra')
    const body = JSON.stringify({
      ...JSON.parse(proofBody('delivery-extra')),
      [field]: 'sensitive runtime input',
    })
    expect(() => insertProofMessage(
      'delivery-extra','message-extra','seat-runtime',{ body },
    )).toThrow(/proof message metadata/)
  })

  it('rejects a string size in proof metadata', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-size-type','message-size-type')
    expect(() => insertProofMessage(
      'delivery-size-type','message-size-type','seat-runtime',
      { body: strictProofBody({ size: '128' }) },
    )).toThrow(/proof message metadata/)
  })

  it('rejects a non-integer recipient generation in proof metadata', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-generation-type','message-generation-type')
    expect(() => insertProofMessage(
      'delivery-generation-type','message-generation-type','seat-runtime',
      { body: strictProofBody({ recipient_generation: 1.5 }) },
    )).toThrow(/proof message metadata/)
  })

  it('makes challenges, signed nonces, authority keys, ingress receipts, and evidence append-only or unique', () => {
    seedBrokerAndSigners()
    seedIngress()
    expect(() => insertChallenge(
      'challenge-broker-2','mupot-runtime-broker-register:v1','broker',null,'host-1','nonce-broker',
    )).toThrow()
    harness.sqlite.prepare(
      "INSERT INTO runtime_signed_request_replays (id,tenant,domain,authority_kind,authority_id,nonce,challenge_id,canonical_payload_digest,result_kind,result_id,issued_at,expires_at,created_at) VALUES ('replay-1',?,'mupot-runtime-broker-register:v1','broker','broker-1','signed-nonce-0001','challenge-broker',?,'runtime_broker','broker-1',?,?,?)",
    ).run(TENANT,SHA_A,T0,T60,T0)
    expect(() => harness.sqlite.prepare(
      "INSERT INTO runtime_signed_request_replays (id,tenant,domain,authority_kind,authority_id,nonce,challenge_id,canonical_payload_digest,result_kind,result_id,issued_at,expires_at,created_at) VALUES ('replay-2',?,'mupot-runtime-broker-register:v1','broker','broker-1','signed-nonce-0001','challenge-broker',?,'runtime_broker','broker-1',?,?,?)",
    ).run(TENANT,SHA_B,T0,T60,T0)).toThrow()
    expect(() => harness.sqlite.exec(
      "UPDATE host_envelope_ingress_receipts SET envelope_ref='changed' WHERE id='ingress-receipt-1'",
    )).toThrow(/immutable/)
    expect(() => harness.sqlite.exec(
      "DELETE FROM host_envelope_ingress_receipts WHERE id='ingress-receipt-1'",
    )).toThrow(/immutable/)
    insertChallenge(
      'challenge-key-reuse','mupot-delivery-authority-register:v1',
      'adapter','authority-key-reuse','seat-other:1','nonce-key-reuse',
    )
    expect(() => harness.sqlite.prepare(
      "INSERT INTO runtime_delivery_authorities (id,tenant,broker_id,runtime_seat_id,generation,authority_kind,public_key,key_fingerprint,proof_of_possession_digest,challenge_id,registration_digest,state,issued_at,expires_at,revoked_at,created_at) VALUES ('authority-key-reuse',?,'broker-1','seat-other',1,'adapter','reused-public',?,?, 'challenge-key-reuse',?,'active',?,?,NULL,?)",
    ).run(TENANT,FP_C,SHA_A,SHA_B,T0,T300,T0)).toThrow()
    insertChallenge(
      'challenge-broker-key-reuse','mupot-runtime-broker-register:v1',
      'broker',null,'host-2','nonce-broker-key-reuse',
    )
    expect(() => harness.sqlite.prepare(
      "INSERT INTO runtime_brokers (id,tenant,agent_id,member_id,credential_id,host_id,public_key,key_fingerprint,state,registration_digest,challenge_id,registered_at,expires_at,revoked_at,created_at) VALUES ('broker-key-reuse',?,'agent-broker','member-broker','token-broker','host-2','broker-reused',?,'active',?,'challenge-broker-key-reuse',?,?,NULL,?)",
    ).run(TENANT,FP_C,SHA_D,T0,T300,T0)).toThrow(/distinct/)
    expect(() => harness.sqlite.prepare(
      "INSERT INTO host_envelope_ingress_receipts (id,tenant,authorization_id,runtime_seat_id,generation,recipient_encryption_key_id,envelope_ref,ciphertext_digest,envelope_digest,payload_digest,runtime_input_digest,byte_length,stored_at,expires_at,host_authority_id,canonical_payload_digest,signature,created_at) VALUES ('ingress-receipt-changed',?,'ingress-auth-1','seat-runtime',1,'runtime-signer-1',?,?,?,?,?,128,?,?,'authority-ingress',?,'changed-signature',?)",
    ).run(
      TENANT,'local-envelope:sha256:' + SHA_D,SHA_D,SHA_D,SHA_A,SHA_B,
      T0,T300,SHA_D,T0,
    )).toThrow()
  })

  it('rejects malformed public broker-attestation digests', () => {
    seedBrokerAndSigners()
    expect(() => insertBrokerAttestation('attestation-bad-digest',SHA_C,'not-a-digest'))
      .toThrow()
  })

  it('rejects broker attestations that substitute a signer registration digest', () => {
    seedBrokerAndSigners()
    expect(() => insertBrokerAttestation('attestation-substitute',SHA_A,SHA_A))
      .toThrow(/registration mismatch/)
  })

  it('accepts one exact broker attestation and keeps it immutable', () => {
    seedBrokerAndSigners()
    expect(() => insertBrokerAttestation('attestation-valid',SHA_C,SHA_A)).not.toThrow()
    expect(() => harness.sqlite.exec(
      "UPDATE runtime_broker_attestations SET signature='changed' WHERE id='attestation-valid'",
    )).toThrow(/immutable/)
    expect(() => harness.sqlite.exec(
      "DELETE FROM runtime_broker_attestations WHERE id='attestation-valid'",
    )).toThrow(/immutable/)
  })

  it('rejects broker attestations that borrow authority registrations from another broker', () => {
    seedBrokerAndSigners('broker-2')
    expect(() => insertBrokerAttestation('attestation-cross-broker',SHA_C,SHA_A))
      .toThrow(/registration mismatch/)
  })

  it.each([
    ['broker','host.persisted','broker','broker-1','adapter','authority-adapter'],
    ['adapter','effect.intent','adapter','authority-adapter','runtime','runtime-signer-1'],
    ['provider','provider.observed','provider_verifier','authority-provider','adapter','authority-adapter'],
    ['runtime','runtime.consumed','runtime','runtime-signer-1','adapter','authority-adapter'],
  ])(
    'rejects a substituted %s execution-receipt issuer',
    (_label,type,authorityKind,authorityId,receiptIssuerKind,receiptIssuerId) => {
      seedLeasedEvidenceDelivery()
      expect(() => insertEvidence(
        'evidence-wrong-issuer','delivery-evidence','attempt-evidence',
        type,authorityKind,authorityId,receiptIssuerKind,receiptIssuerId,
      )).toThrow(/evidence mismatch/)
    },
  )

  it.each([
    ['objective', { objectiveId: 'objective-other' }],
    ['flight', { flightId: 'flight-other' }],
    ['task', { taskId: 'task-other' }],
  ])('rejects an execution receipt from another %s', (_label,receiptOverrides) => {
    seedLeasedEvidenceDelivery()
    expect(() => insertEvidence(
      'evidence-cross-correlation','delivery-evidence','attempt-evidence',
      'effect.intent','adapter','authority-adapter','adapter',
      'authority-adapter',receiptOverrides,
    )).toThrow(/evidence mismatch/)
  })

  it('enforces one active attempt, one recovery reservation, max three attempts, and retry backoff', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-retry','message-retry')
    insertProofMessage('delivery-retry','message-retry','seat-runtime')
    insertLease('lease-retry-1',1)
    insertAttempt('attempt-retry-1','delivery-retry',1,'lease-retry-1',0,1)
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-retry-1',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-retry'",
    )

    expect(() => insertAttempt(
      'attempt-retry-duplicate','delivery-retry',2,'lease-retry-1',1,2,
    )).toThrow()

    harness.sqlite.exec([
      "UPDATE runtime_seat_leases SET state='expired' WHERE id='lease-retry-1';",
      "UPDATE fenced_delivery_attempts SET state='expired',ended_at='" + T0 + "' WHERE id='attempt-retry-1';",
      "UPDATE fenced_deliveries SET state='expired',updated_at='" + T0 + "' WHERE id='delivery-retry';",
    ].join('\n'))

    expect(() => harness.sqlite.exec(
      "INSERT INTO fenced_delivery_recovery_reservations (id,tenant,delivery_id,prior_attempt_id,prior_attempt_number,prior_fencing_epoch,next_attempt_number,broker_id,consumer_id,idempotency_key,reservation_nonce,state,reserved_at,retry_not_before,expires_at,consumed_at,created_at) VALUES ('reservation-early','" + TENANT + "','delivery-retry','attempt-retry-1',1,1,2,'broker-1','consumer-2','recovery-early','reserve-early','reserved','" + T0 + "','" + T5 + "','" + T60 + "',NULL,'" + T0 + "')",
    )).toThrow(/backoff/)

    harness.sqlite.exec(
      "INSERT INTO fenced_delivery_recovery_reservations (id,tenant,delivery_id,prior_attempt_id,prior_attempt_number,prior_fencing_epoch,next_attempt_number,broker_id,consumer_id,idempotency_key,reservation_nonce,state,reserved_at,retry_not_before,expires_at,consumed_at,created_at) VALUES ('reservation-ok','" + TENANT + "','delivery-retry','attempt-retry-1',1,1,2,'broker-1','consumer-2','recovery-ok','reserve-ok','reserved','" + T5 + "','" + T5 + "','" + T60 + "',NULL,'" + T5 + "')",
    )
    expect(() => harness.sqlite.exec(
      "INSERT INTO fenced_delivery_recovery_reservations (id,tenant,delivery_id,prior_attempt_id,prior_attempt_number,prior_fencing_epoch,next_attempt_number,broker_id,consumer_id,idempotency_key,reservation_nonce,state,reserved_at,retry_not_before,expires_at,consumed_at,created_at) VALUES ('reservation-two','" + TENANT + "','delivery-retry','attempt-retry-1',1,1,2,'broker-1','consumer-3','recovery-two','reserve-two','reserved','" + T5 + "','" + T5 + "','" + T60 + "',NULL,'" + T5 + "')",
    )).toThrow()

    expect(() => harness.sqlite.exec(
      "INSERT INTO fenced_delivery_attempts (id,tenant,delivery_id,attempt_number,attempt_nonce,generation,prior_fencing_epoch,fencing_epoch,runtime_seat_lease_id,state,leased_at,expires_at,retry_not_before,created_at) VALUES ('attempt-four','" + TENANT + "','delivery-retry',4,'nonce-four',1,3,4,'lease-retry-1','blocked','" + T0 + "','" + T60 + "','" + T0 + "','" + T0 + "')",
    )).toThrow()
  })

  it('rejects a recovered attempt leased before its reservation retry boundary', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-early-lease','message-early-lease')
    insertProofMessage('delivery-early-lease','message-early-lease','seat-runtime')
    insertLease('lease-early-1',1)
    insertAttempt('attempt-early-1','delivery-early-lease',1,'lease-early-1',0,1)
    harness.sqlite.exec([
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-early-1',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-early-lease';",
      "UPDATE runtime_seat_leases SET state='expired' WHERE id='lease-early-1';",
      "UPDATE fenced_delivery_attempts SET state='expired',ended_at='" + T0 + "' WHERE id='attempt-early-1';",
      "UPDATE fenced_deliveries SET state='expired',updated_at='" + T0 + "' WHERE id='delivery-early-lease';",
    ].join('\n'))
    reserveAndConsumeRecovery(
      'reservation-early-lease','delivery-early-lease','attempt-early-1',1,1,2,T5,
    )
    insertLease('lease-early-2',2)
    expect(() => insertAttempt(
      'attempt-early-2','delivery-early-lease',2,'lease-early-2',1,2,
      'leased',null,T5,T0,
    )).toThrow(/retry boundary/)
    expect(() => insertAttempt(
      'attempt-boundary-2','delivery-early-lease',2,'lease-early-2',1,2,
      'leased',null,T5,T5,
    )).not.toThrow()
  })

  it('waits 45 seconds after attempt three ends before terminal blocked escalation', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-final-wait','message-final-wait')
    insertProofMessage('delivery-final-wait','message-final-wait','seat-runtime')

    insertLease('lease-final-1',1)
    insertAttempt('attempt-final-1','delivery-final-wait',1,'lease-final-1',0,1)
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-final-1',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-final-wait'",
    )
    harness.sqlite.exec([
      "UPDATE runtime_seat_leases SET state='expired' WHERE id='lease-final-1';",
      "UPDATE fenced_delivery_attempts SET state='expired',ended_at='" + T0 + "' WHERE id='attempt-final-1';",
      "UPDATE fenced_deliveries SET state='expired',updated_at='" + T0 + "' WHERE id='delivery-final-wait';",
    ].join('\n'))
    reserveAndConsumeRecovery(
      'reservation-final-1','delivery-final-wait','attempt-final-1',1,1,2,T5,
    )

    insertLease('lease-final-2',2)
    insertAttempt('attempt-final-2','delivery-final-wait',2,'lease-final-2',1,2)
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-final-2',active_attempt_number=2,current_fencing_epoch=2,updated_at='" + T5 + "' WHERE id='delivery-final-wait'",
    )
    harness.sqlite.exec([
      "UPDATE runtime_seat_leases SET state='expired' WHERE id='lease-final-2';",
      "UPDATE fenced_delivery_attempts SET state='expired',ended_at='" + T20 + "' WHERE id='attempt-final-2';",
      "UPDATE fenced_deliveries SET state='expired',updated_at='" + T20 + "' WHERE id='delivery-final-wait';",
    ].join('\n'))
    reserveAndConsumeRecovery(
      'reservation-final-2','delivery-final-wait','attempt-final-2',2,2,3,T35,
    )

    insertLease('lease-final-3',3)
    insertAttempt('attempt-final-3','delivery-final-wait',3,'lease-final-3',2,3)
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-final-3',active_attempt_number=3,current_fencing_epoch=3,updated_at='" + T35 + "' WHERE id='delivery-final-wait'",
    )
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='blocked',updated_at='" + T80 + "' WHERE id='delivery-final-wait'",
    )).toThrow(/final retry wait/)
    harness.sqlite.exec([
      "UPDATE runtime_seat_leases SET state='expired' WHERE id='lease-final-3';",
      "UPDATE fenced_delivery_attempts SET state='blocked',ended_at='" + T35 + "' WHERE id='attempt-final-3';",
    ].join('\n'))

    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='blocked',updated_at='" + T35 + "' WHERE id='delivery-final-wait'",
    )).toThrow(/final retry wait/)
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='blocked',updated_at='" + T80 + "' WHERE id='delivery-final-wait'",
    )).not.toThrow()
  })

  it('rejects terminal blocking when active attempt three does not exist', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-missing-third','message-missing-third')
    insertProofMessage('delivery-missing-third','message-missing-third','seat-runtime')
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='missing-attempt-3',active_attempt_number=3,current_fencing_epoch=3,updated_at='" + T35 + "' WHERE id='delivery-missing-third'",
    )
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='blocked',updated_at='" + T80 + "' WHERE id='delivery-missing-third'",
    )).toThrow(/final retry wait/)
  })

  it('keeps delivery digests immutable and rejects evidence for a stale attempt', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-stale','message-chain')
    insertProofMessage('delivery-stale','message-chain','seat-runtime')
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET payload_digest='" + SHA_D + "' WHERE id='delivery-stale'",
    )).toThrow(/immutable/)

    insertLease('lease-stale',1)
    insertAttempt('attempt-stale','delivery-stale',1,'lease-stale',0,1)
    harness.sqlite.exec(
      "UPDATE fenced_delivery_attempts SET state='stale',ended_at='" + T0 + "' WHERE id='attempt-stale'",
    )
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='blocked',active_attempt_id='attempt-stale',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-stale'",
    )
    expect(() => insertEvidence(
      'stale-evidence','delivery-stale','attempt-stale','host.persisted',
      'broker','broker-1','mupot',
    )).toThrow(/stale attempt/)
  })

  it('permits terminal read_at only after the complete same-attempt signed evidence chain', () => {
    seedBrokerAndSigners()
    seedIngress()
    insertDelivery('delivery-chain','message-chain')
    insertProofMessage('delivery-chain','message-chain','seat-runtime')
    insertLease('lease-chain',1)
    insertAttempt('attempt-chain','delivery-chain',1,'lease-chain',0,1)
    harness.sqlite.exec(
      "UPDATE fenced_deliveries SET state='leased',active_attempt_id='attempt-chain',active_attempt_number=1,current_fencing_epoch=1 WHERE id='delivery-chain'",
    )

    const chain = [
      ['host.persisted','broker','broker-1','mupot','mupot:' + TENANT,'host_persisted'],
      ['effect.intent','adapter','authority-adapter','adapter','authority-adapter','effect_intent'],
      ['provider.observed','provider_verifier','authority-provider','provider_verifier','authority-provider','provider_observed'],
      ['runtime.injected','adapter','authority-adapter','adapter','authority-adapter','runtime_injected'],
      ['runtime.consumed','runtime','runtime-signer-1','runtime','runtime-signer-1','runtime_consumed'],
      ['runtime.ack','runtime','runtime-signer-1','runtime','runtime-signer-1','runtime_acked'],
    ]
    for (const [type,kind,authority,issuer,receiptIssuerId,state] of chain) {
      insertEvidence(
        'evidence-' + state,'delivery-chain','attempt-chain',type,kind,
        authority,issuer,receiptIssuerId,
      )
      harness.sqlite.prepare(
        "UPDATE fenced_deliveries SET state=?,updated_at=? WHERE id='delivery-chain'",
      ).run(state,T0)
    }
    harness.sqlite.exec([
      "UPDATE fenced_deliveries SET state='source_acked',source_acked_at='" + T60 + "',updated_at='" + T60 + "' WHERE id='delivery-chain';",
      "UPDATE agent_messages SET read_at='" + T60 + "' WHERE id='message-chain';",
    ].join('\n'))
    expect(harness.sqlite.prepare(
      "SELECT read_at FROM agent_messages WHERE id='message-chain'",
    ).get()?.read_at).toBe(T60)
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_delivery_evidence SET signature='changed' WHERE id='evidence-runtime_acked'",
    )).toThrow(/immutable/)
    expect(() => harness.sqlite.exec(
      "DELETE FROM fenced_delivery_evidence WHERE id='evidence-runtime_acked'",
    )).toThrow(/immutable/)
    expect(() => harness.sqlite.exec(
      "UPDATE fenced_deliveries SET source_acked_at='" + T300 + "' WHERE id='delivery-chain'",
    )).toThrow(/source ack timestamp/)
    expect(() => harness.sqlite.exec(
      "UPDATE agent_messages SET read_at='" + T300 + "' WHERE id='message-chain'",
    )).toThrow(/exact source ack/)
  })
})
