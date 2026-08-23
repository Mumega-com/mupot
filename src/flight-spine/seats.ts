import type { AuthContext, Env } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import type { MemberTokenFingerprintEnv } from '../members/service'
import {
  issueTokenBindingAttestation,
  type TokenBindingAttestation,
} from './attestations'
import {
  executePreparedExecutionReceiptBatch,
  prepareAuditedDomainMutation,
  prepareFreshExecutionReceiptChain,
} from './receipts'

export interface RegisterPendingRuntimeSeatInput {
  seatName: string
  hostId: string
  adapterKind: string
  capabilities?: readonly string[]
}

export interface PendingRuntimeSeat {
  id: string
  tenant: string
  agentId: string
  seatName: string
  hostId: string
  adapterKind: string
  state: 'pending'
  currentGeneration: 0
  currentFencingEpoch: 0
  processPublicKey: null
  credentialFingerprint: string
  capabilities: string[]
  lastHeartbeatAt: null
  revokedAt: null
  createdAt: string
  updatedAt: string
}

export interface PendingSeatAttestation {
  id: string
  tenant: string
  runtimeSeatId: string
  tokenBindingAttestationId: string
  memberId: string
  agentId: string
  seatState: 'pending'
  seatClaimDigest: string
  issuedAt: string
  expiresAt: string | null
  createdAt: string
}

export interface RegisteredPendingRuntimeSeat {
  seat: PendingRuntimeSeat
  attestation: PendingSeatAttestation
  tokenBindingAttestation: TokenBindingAttestation
}

export interface AcquireRuntimeSeatLeaseInput {
  runtimeSeatId: string
  generation: number
  consumerId: string
  leaseTokenHash: string
  expiresAt: string
}

export interface RenewRuntimeSeatLeaseInput {
  runtimeSeatId: string
  generation: number
  fencingEpoch: number
  leaseTokenHash: string
  expiresAt: string
}

export interface ReleaseRuntimeSeatLeaseInput {
  runtimeSeatId: string
  generation: number
  fencingEpoch: number
  leaseTokenHash: string
}

export interface RuntimeSeatLease {
  id: string
  tenant: string
  runtimeSeatId: string
  generation: number
  fencingEpoch: number
  consumerId: string
  state: 'active' | 'released' | 'expired' | 'revoked'
  leasedAt: string
  expiresAt: string
  renewedAt: string | null
  releasedAt: string | null
  receiptId: string
}

export type RuntimeSeatErrorCode =
  | 'invalid_seat'
  | 'duplicate_seat'
  | 'seat_registration_conflict'
  | 'workspace_token_required'
  | 'lease_forbidden'
  | 'seat_not_found'
  | 'seat_not_active'
  | 'seat_revoked'
  | 'stale_generation'
  | 'active_lease_exists'
  | 'stale_lease'
  | 'lease_persistence_conflict'

export class RuntimeSeatError extends Error {
  readonly name = 'RuntimeSeatError'

  constructor(readonly code: RuntimeSeatErrorCode) {
    super(code)
  }
}

interface RuntimeSeatRow {
  id: string
  tenant: string
  agent_id: string
  seat_name: string
  host_id: string
  adapter_kind: string
  state: 'pending' | 'active' | 'revoked'
  current_generation: number
  current_fencing_epoch: number
  process_public_key: string | null
  credential_fingerprint: string | null
  capabilities_json: string
  last_heartbeat_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
  squad_id?: string
  department_id?: string
  membership_capability?: string | null
  maximum_fencing_epoch?: number
  active_lease_count?: number
}

interface SeatAttestationRow {
  id: string
  tenant: string
  runtime_seat_id: string
  token_binding_attestation_id: string
  member_id: string
  agent_id: string
  seat_state: 'pending'
  seat_claim_digest: string
  issued_at: string
  expires_at: string | null
  created_at: string
}

interface RuntimeSeatLeaseRow {
  id: string
  tenant: string
  runtime_seat_id: string
  generation: number
  fencing_epoch: number
  consumer_id: string
  state: RuntimeSeatLease['state']
  leased_at: string
  expires_at: string
  renewed_at: string | null
  released_at: string | null
  receipt_id: string | null
}

interface LeaseActor {
  memberId: string
  agentId: string
  tokenId: string
  tokenHash: string
}

interface LeaseAuthority {
  actor: LeaseActor
  squadId: string
  departmentId: string
  legacyAdmin: boolean
}

const PENDING_SEAT_KEYS = new Set([
  'seatName',
  'hostId',
  'adapterKind',
  'capabilities',
])

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new RuntimeSeatError('invalid_seat')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new RuntimeSeatError('invalid_seat')
  }
  return normalized
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RuntimeSeatError('invalid_seat')
  }
  return Number(value)
}

function leaseTokenHash(value: unknown): string {
  const normalized = boundedText(value, 64)
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new RuntimeSeatError('invalid_seat')
  return normalized
}

function futureTimestamp(value: unknown): string {
  const normalized = boundedText(value, 80)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) {
    throw new RuntimeSeatError('invalid_seat')
  }
  const parsed = new Date(normalized)
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.toISOString() !== normalized
    || parsed.getTime() <= Date.now()
  ) {
    throw new RuntimeSeatError('invalid_seat')
  }
  return normalized
}

function normalizePendingInput(input: RegisterPendingRuntimeSeatInput): {
  seatName: string
  hostId: string
  adapterKind: string
  capabilities: string[]
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RuntimeSeatError('invalid_seat')
  }
  if (Object.keys(input).some((key) => !PENDING_SEAT_KEYS.has(key))) {
    throw new RuntimeSeatError('invalid_seat')
  }
  const rawCapabilities = input.capabilities ?? []
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length > 64) {
    throw new RuntimeSeatError('invalid_seat')
  }
  const capabilities = rawCapabilities.map((item) => boundedText(item, 120))
  if (new Set(capabilities).size !== capabilities.length) {
    throw new RuntimeSeatError('invalid_seat')
  }
  return {
    seatName: boundedText(input.seatName, 160),
    hostId: boundedText(input.hostId, 255),
    adapterKind: boundedText(input.adapterKind, 120),
    capabilities,
  }
}

function mapPendingSeat(row: RuntimeSeatRow): PendingRuntimeSeat {
  return {
    id: row.id,
    tenant: row.tenant,
    agentId: row.agent_id,
    seatName: row.seat_name,
    hostId: row.host_id,
    adapterKind: row.adapter_kind,
    state: 'pending',
    currentGeneration: 0,
    currentFencingEpoch: 0,
    processPublicKey: null,
    credentialFingerprint: row.credential_fingerprint as string,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    lastHeartbeatAt: null,
    revokedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSeatAttestation(row: SeatAttestationRow): PendingSeatAttestation {
  return {
    id: row.id,
    tenant: row.tenant,
    runtimeSeatId: row.runtime_seat_id,
    tokenBindingAttestationId: row.token_binding_attestation_id,
    memberId: row.member_id,
    agentId: row.agent_id,
    seatState: row.seat_state,
    seatClaimDigest: row.seat_claim_digest,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function mapLease(row: RuntimeSeatLeaseRow): RuntimeSeatLease {
  if (row.receipt_id === null) throw new RuntimeSeatError('lease_persistence_conflict')
  return {
    id: row.id,
    tenant: row.tenant,
    runtimeSeatId: row.runtime_seat_id,
    generation: Number(row.generation),
    fencingEpoch: Number(row.fencing_epoch),
    consumerId: row.consumer_id,
    state: row.state,
    leasedAt: row.leased_at,
    expiresAt: row.expires_at,
    renewedAt: row.renewed_at,
    releasedAt: row.released_at,
    receiptId: row.receipt_id,
  }
}

/** Create only a pending command-seat identity and its immutable public claim. */
export async function registerPendingRuntimeSeat(
  env: MemberTokenFingerprintEnv,
  auth: AuthContext,
  input: RegisterPendingRuntimeSeatInput,
): Promise<RegisteredPendingRuntimeSeat> {
  const normalized = normalizePendingInput(input)
  const tokenAttestation = await issueTokenBindingAttestation(env, auth)
  const seatId = crypto.randomUUID()
  const seatAttestationId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const capabilitiesJson = canonicalJson(normalized.capabilities)
  const claimDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    runtimeSeatId: seatId,
    tokenBindingAttestationId: tokenAttestation.id,
    memberId: tokenAttestation.memberId,
    agentId: tokenAttestation.agentId,
    seatName: normalized.seatName,
    hostId: normalized.hostId,
    adapterKind: normalized.adapterKind,
    state: 'pending',
    credentialFingerprint: tokenAttestation.credentialFingerprint,
    capabilities: normalized.capabilities,
  }))

  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO runtime_seats (
          id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
          current_generation, current_fencing_epoch, process_public_key,
          credential_fingerprint, capabilities_json, last_heartbeat_at,
          revoked_at, created_at, updated_at
        )
        SELECT ?1, token.tenant, token.agent_id, ?2, ?3, ?4, 'pending',
               0, 0, NULL, attestation.credential_fingerprint, ?5,
               NULL, NULL, ?6, ?6
          FROM token_binding_attestations attestation
          JOIN member_tokens token
            ON token.id = attestation.token_id
           AND token.tenant = attestation.tenant
           AND token.member_id = attestation.member_id
           AND token.agent_id = attestation.agent_id
           AND token.channel = attestation.channel
          JOIN members member
            ON member.id = token.member_id AND member.tenant = token.tenant
          JOIN agents agent ON agent.id = token.agent_id
          JOIN agent_member_bindings binding
            ON binding.tenant = token.tenant
           AND binding.agent_id = token.agent_id
           AND binding.member_id = token.member_id
         WHERE attestation.id = ?7
           AND attestation.tenant = ?8
           AND attestation.member_id = ?9
           AND attestation.agent_id = ?10
           AND attestation.channel = 'workspace'
           AND attestation.credential_fingerprint = ?11
           AND (attestation.expires_at IS NULL
                OR julianday(attestation.expires_at) > julianday(?12))
           AND member.status = 'active'
           AND agent.status = 'active'
           AND ${TOKEN_LIVE_PREDICATE('?12').replaceAll('t.', 'token.')}
           AND NOT EXISTS (
             SELECT 1 FROM runtime_seats existing
              WHERE existing.tenant = token.tenant
                AND existing.agent_id = token.agent_id
                AND existing.seat_name = ?2
           )
      `).bind(
        seatId,
        normalized.seatName,
        normalized.hostId,
        normalized.adapterKind,
        capabilitiesJson,
        createdAt,
        tokenAttestation.id,
        env.TENANT_SLUG,
        tokenAttestation.memberId,
        tokenAttestation.agentId,
        tokenAttestation.credentialFingerprint,
        nowSqlUtc(),
      ),
      env.DB.prepare(`
        INSERT INTO seat_attestations (
          id, tenant, runtime_seat_id, token_binding_attestation_id,
          member_id, agent_id, seat_state, seat_claim_digest,
          issued_at, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?8)
      `).bind(
        seatAttestationId,
        env.TENANT_SLUG,
        seatId,
        tokenAttestation.id,
        tokenAttestation.memberId,
        tokenAttestation.agentId,
        claimDigest,
        createdAt,
        tokenAttestation.expiresAt,
      ),
    ])
    if (results.length !== 2 || results.some((result) => Number(result.meta?.changes) !== 1)) {
      throw new RuntimeSeatError('seat_registration_conflict')
    }
  } catch (error) {
    const duplicate = await env.DB.prepare(`
      SELECT id FROM runtime_seats
       WHERE tenant = ?1 AND agent_id = ?2 AND seat_name = ?3
       LIMIT 1
    `).bind(
      env.TENANT_SLUG,
      tokenAttestation.agentId,
      normalized.seatName,
    ).first<{ id: string }>()
    if (duplicate) throw new RuntimeSeatError('duplicate_seat')
    if (error instanceof RuntimeSeatError) throw error
    throw new RuntimeSeatError('seat_registration_conflict')
  }

  const seat = await env.DB.prepare(`
    SELECT id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
           current_generation, current_fencing_epoch, process_public_key,
           credential_fingerprint, capabilities_json, last_heartbeat_at,
           revoked_at, created_at, updated_at
      FROM runtime_seats WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, seatId).first<RuntimeSeatRow>()
  const attestation = await env.DB.prepare(`
    SELECT id, tenant, runtime_seat_id, token_binding_attestation_id,
           member_id, agent_id, seat_state, seat_claim_digest,
           issued_at, expires_at, created_at
      FROM seat_attestations WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, seatAttestationId).first<SeatAttestationRow>()
  if (!seat || seat.state !== 'pending' || !attestation) {
    throw new RuntimeSeatError('seat_registration_conflict')
  }
  return {
    seat: mapPendingSeat(seat),
    attestation: mapSeatAttestation(attestation),
    tokenBindingAttestation: tokenAttestation,
  }
}

async function requireLeaseActor(env: Env, auth: AuthContext): Promise<LeaseActor> {
  const memberId = (auth.memberId ?? auth.userId).trim()
  const agentId = auth.boundAgentId?.trim() ?? ''
  const tokenId = auth.tokenId?.trim() ?? ''
  if (
    auth.tenant !== env.TENANT_SLUG
    || memberId === ''
    || agentId === ''
    || tokenId === ''
  ) {
    throw new RuntimeSeatError('workspace_token_required')
  }
  const row = await env.DB.prepare(`
    SELECT token.id, token.token_hash
      FROM member_tokens token
      JOIN members member
        ON member.id = token.member_id AND member.tenant = token.tenant
      JOIN agents agent ON agent.id = token.agent_id
      JOIN agent_member_bindings binding
        ON binding.tenant = token.tenant
       AND binding.agent_id = token.agent_id
       AND binding.member_id = token.member_id
     WHERE token.id = ?1 AND token.tenant = ?2 AND token.member_id = ?3
       AND token.agent_id = ?4 AND token.channel = 'workspace'
       AND member.status = 'active' AND agent.status = 'active'
       AND ${TOKEN_LIVE_PREDICATE('?5').replaceAll('t.', 'token.')}
     LIMIT 1
  `).bind(tokenId, env.TENANT_SLUG, memberId, agentId, nowSqlUtc())
    .first<{ id: string; token_hash: string }>()
  if (!row) throw new RuntimeSeatError('workspace_token_required')
  return { memberId, agentId, tokenId, tokenHash: row.token_hash }
}

async function readSeatForActor(
  env: Env,
  runtimeSeatId: string,
  actor: LeaseActor,
): Promise<RuntimeSeatRow> {
  const row = await env.DB.prepare(`
    SELECT seat.id, seat.tenant, seat.agent_id, seat.seat_name, seat.host_id,
           seat.adapter_kind, seat.state, seat.current_generation,
           seat.current_fencing_epoch, seat.process_public_key,
           seat.credential_fingerprint, seat.capabilities_json,
           seat.last_heartbeat_at, seat.revoked_at, seat.created_at,
           seat.updated_at, agent.squad_id, squad.department_id,
           membership.capability AS membership_capability,
           COALESCE((
             SELECT MAX(lease.fencing_epoch) FROM runtime_seat_leases lease
              WHERE lease.tenant = seat.tenant AND lease.runtime_seat_id = seat.id
           ), 0) AS maximum_fencing_epoch,
           (
             SELECT COUNT(*) FROM runtime_seat_leases lease
              WHERE lease.tenant = seat.tenant AND lease.runtime_seat_id = seat.id
                AND lease.state = 'active'
           ) AS active_lease_count
      FROM runtime_seats seat
      JOIN agents agent ON agent.id = seat.agent_id
      JOIN squads squad ON squad.id = agent.squad_id
      LEFT JOIN memberships membership
        ON membership.agent_id = agent.id AND membership.squad_id = squad.id
     WHERE seat.id = ?1 AND seat.tenant = ?2 AND seat.agent_id = ?3
     LIMIT 1
  `).bind(runtimeSeatId, env.TENANT_SLUG, actor.agentId).first<RuntimeSeatRow>()
  if (!row) throw new RuntimeSeatError('seat_not_found')
  if (row.state === 'revoked') throw new RuntimeSeatError('seat_revoked')
  return row
}

async function requireLeaseAuthority(
  env: Env,
  auth: AuthContext,
  actor: LeaseActor,
  seat: RuntimeSeatRow,
): Promise<LeaseAuthority> {
  const squadId = seat.squad_id ?? ''
  const departmentId = seat.department_id ?? ''
  const membershipCapability = seat.membership_capability ?? ''
  if (
    squadId === ''
    || departmentId === ''
    || !['member', 'lead', 'admin', 'owner'].includes(membershipCapability)
  ) {
    throw new RuntimeSeatError('lease_forbidden')
  }
  const legacyAdmin = auth.capabilities === undefined
    && (auth.role === 'owner' || auth.role === 'admin')
  const effectiveGrants = auth.capabilities ?? (await resolveCapabilities(env, actor.memberId))
  if (!legacyAdmin && !hasCapability(
    effectiveGrants,
    'squad',
    squadId,
    'member',
    departmentId,
  )) {
    throw new RuntimeSeatError('lease_forbidden')
  }
  const liveGrants = await resolveCapabilities(env, actor.memberId)
  if (!legacyAdmin && !hasCapability(
    liveGrants,
    'squad',
    squadId,
    'member',
    departmentId,
  )) {
    throw new RuntimeSeatError('lease_forbidden')
  }
  return { actor, squadId, departmentId, legacyAdmin }
}

async function leaseById(env: Env, leaseId: string): Promise<RuntimeSeatLease> {
  const row = await env.DB.prepare(`
    SELECT lease.id, lease.tenant, lease.runtime_seat_id, lease.generation,
           lease.fencing_epoch, lease.consumer_id, lease.state,
           lease.leased_at, lease.expires_at, lease.renewed_at,
           lease.released_at, receipt.id AS receipt_id
      FROM runtime_seat_leases lease
      JOIN execution_receipts receipt
        ON receipt.id = lease.id
       AND receipt.tenant = lease.tenant
       AND receipt.type = 'seat.leased'
       AND receipt.seat_id = lease.runtime_seat_id
       AND receipt.seat_generation = lease.generation
       AND receipt.fencing_epoch = lease.fencing_epoch
       AND receipt.lease_token_hash = lease.lease_token_hash
     WHERE lease.tenant = ?1 AND lease.id = ?2
     LIMIT 1
  `).bind(env.TENANT_SLUG, leaseId).first<RuntimeSeatLeaseRow>()
  if (!row) throw new RuntimeSeatError('lease_persistence_conflict')
  return mapLease(row)
}

function assertActiveGeneration(seat: RuntimeSeatRow, generation: number): void {
  if (seat.state !== 'active') throw new RuntimeSeatError('seat_not_active')
  if (Number(seat.current_generation) !== generation) {
    throw new RuntimeSeatError('stale_generation')
  }
}

/** Acquire a fenced active-generation lease and its atomic `seat.leased` receipt. */
export async function acquireRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: AcquireRuntimeSeatLeaseInput,
): Promise<RuntimeSeatLease> {
  const runtimeSeatId = boundedText(input?.runtimeSeatId, 255)
  const generation = positiveInteger(input?.generation)
  const consumerId = boundedText(input?.consumerId, 255)
  const tokenHash = leaseTokenHash(input?.leaseTokenHash)
  const expiresAt = futureTimestamp(input?.expiresAt)
  const actor = await requireLeaseActor(env, auth)
  const seat = await readSeatForActor(env, runtimeSeatId, actor)
  const authority = await requireLeaseAuthority(env, auth, actor, seat)
  assertActiveGeneration(seat, generation)
  if (Number(seat.active_lease_count) !== 0) {
    throw new RuntimeSeatError('active_lease_exists')
  }
  const fencingEpoch = Math.max(
    Number(seat.current_fencing_epoch),
    Number(seat.maximum_fencing_epoch),
  ) + 1
  const idempotencyDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    runtimeSeatId,
    generation,
    fencingEpoch,
  }))
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'seat.leased',
    idempotencyKey: `runtime-seat-lease:${idempotencyDigest}`,
    seatId: runtimeSeatId,
    seatGeneration: generation,
    fencingEpoch,
    leaseTokenHash: tokenHash,
    claims: { consumerId, expiresAt },
  }])
  const receipt = prepared.expectedReceipts[0]
  // Migration 0122 has no separate receipt-id column and migrations are frozen for
  // this task. Use the immutable lease PK as the exact receipt FK-by-identity.
  const leaseId = receipt.id
  const leasedAt = new Date().toISOString()
  const domain = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO runtime_seat_leases (
      id, tenant, runtime_seat_id, generation, fencing_epoch, consumer_id,
      lease_token_hash, state, leased_at, expires_at, renewed_at, released_at
    )
    SELECT ?1, seat.tenant, seat.id, ?2, ?3, ?4, ?5, 'active', ?6, ?7, NULL, NULL
      FROM runtime_seats seat
      JOIN runtime_seat_generations generation
        ON generation.tenant = seat.tenant
       AND generation.runtime_seat_id = seat.id
       AND generation.generation = ?2
      JOIN agents agent ON agent.id = seat.agent_id
      JOIN squads squad ON squad.id = agent.squad_id
      JOIN memberships membership
        ON membership.agent_id = agent.id AND membership.squad_id = squad.id
      JOIN agent_member_bindings binding
        ON binding.tenant = seat.tenant
       AND binding.agent_id = seat.agent_id
       AND binding.member_id = ?8
      JOIN members member
        ON member.id = binding.member_id AND member.tenant = binding.tenant
      JOIN member_tokens token
        ON token.id = ?9 AND token.tenant = binding.tenant
       AND token.member_id = binding.member_id AND token.agent_id = seat.agent_id
     WHERE seat.id = ?10 AND seat.tenant = ?11 AND seat.agent_id = ?12
       AND seat.state = 'active' AND seat.current_generation = ?2
       AND seat.current_fencing_epoch < ?3
       AND agent.status = 'active' AND member.status = 'active'
       AND token.channel = 'workspace'
       AND ${TOKEN_LIVE_PREDICATE('?13').replaceAll('t.', 'token.')}
       AND token.token_hash = ?14
       AND squad.id = ?15 AND squad.department_id = ?16
       AND CASE membership.capability
         WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
         WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
       AND (
         ?17 = 1
         OR EXISTS (
           SELECT 1 FROM capabilities capability
            WHERE capability.member_id = member.id
              AND (
                capability.scope_type = 'org'
                OR (capability.scope_type = 'department'
                  AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad'
                  AND capability.scope_id = squad.id)
              )
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
            WHERE capability.member_id = member.id
              AND capability.squad_id = squad.id
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )
       AND julianday(?7) IS NOT NULL
       AND julianday(?7) > julianday(?6)
       AND NOT EXISTS (
         SELECT 1 FROM runtime_seat_leases active
          WHERE active.tenant = seat.tenant AND active.runtime_seat_id = seat.id
            AND active.state = 'active'
       )
       AND NOT EXISTS (
         SELECT 1 FROM runtime_seat_leases prior
          WHERE prior.tenant = seat.tenant AND prior.runtime_seat_id = seat.id
            AND prior.fencing_epoch >= ?3
       )`,
    bindings: [
      leaseId,
      generation,
      fencingEpoch,
      consumerId,
      tokenHash,
      leasedAt,
      expiresAt,
      actor.memberId,
      actor.tokenId,
      runtimeSeatId,
      env.TENANT_SLUG,
      actor.agentId,
      leasedAt,
      actor.tokenHash,
      authority.squadId,
      authority.departmentId,
      authority.legacyAdmin ? 1 : 0,
    ],
    audit: {
      expectedAuditId: `audit:${leaseId}:acquire`,
      principalKind: 'agent',
      principalId: actor.agentId,
      memberId: actor.memberId,
      agentId: actor.agentId,
      credentialId: actor.tokenId,
      runtimeSeatId,
      runtimeGeneration: generation,
      origin: 'worker_callback',
      handler: 'flight_spine.acquire_runtime_seat_lease',
      operation: 'acquire',
      targetKind: 'runtime_seat_lease',
      targetId: leaseId,
      afterDigest: receipt.payloadDigest,
      requestId: `runtime-seat:${runtimeSeatId}:lease:${fencingEpoch}`,
      idempotencyKey: receipt.idempotencyKey,
      evidence: { fencingEpoch, receiptId: receipt.id },
    },
  })

  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [domain])
  } catch {
    const current = await readSeatForActor(env, runtimeSeatId, actor)
    assertActiveGeneration(current, generation)
    if (Number(current.active_lease_count) !== 0) {
      throw new RuntimeSeatError('active_lease_exists')
    }
    throw new RuntimeSeatError('lease_persistence_conflict')
  }
  return leaseById(env, leaseId)
}

/** Renew only the exact live generation/epoch/hash tuple; stale callers write nothing. */
export async function renewRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: RenewRuntimeSeatLeaseInput,
): Promise<RuntimeSeatLease> {
  const runtimeSeatId = boundedText(input?.runtimeSeatId, 255)
  const generation = positiveInteger(input?.generation)
  const fencingEpoch = positiveInteger(input?.fencingEpoch)
  const tokenHash = leaseTokenHash(input?.leaseTokenHash)
  const expiresAt = futureTimestamp(input?.expiresAt)
  const actor = await requireLeaseActor(env, auth)
  const seat = await readSeatForActor(env, runtimeSeatId, actor)
  const authority = await requireLeaseAuthority(env, auth, actor, seat)
  assertActiveGeneration(seat, generation)
  const renewedAt = new Date().toISOString()
  const result = await env.DB.prepare(`
    UPDATE runtime_seat_leases AS lease
       SET expires_at = ?1, renewed_at = ?2
     WHERE lease.tenant = ?3 AND lease.runtime_seat_id = ?4
       AND lease.generation = ?5 AND lease.fencing_epoch = ?6
       AND lease.lease_token_hash = ?7 AND lease.state = 'active'
       AND julianday(lease.expires_at) IS NOT NULL
       AND julianday(lease.expires_at) > julianday(?2)
       AND julianday(?1) IS NOT NULL
       AND julianday(?1) > julianday(?2)
       AND julianday(?1) > julianday(lease.expires_at)
       AND EXISTS (
         SELECT 1
           FROM runtime_seats seat
           JOIN agents agent ON agent.id = seat.agent_id
           JOIN squads squad ON squad.id = agent.squad_id
           JOIN memberships membership
             ON membership.agent_id = agent.id AND membership.squad_id = squad.id
           JOIN agent_member_bindings binding
             ON binding.tenant = seat.tenant
            AND binding.agent_id = seat.agent_id
            AND binding.member_id = ?9
           JOIN members member
             ON member.id = binding.member_id AND member.tenant = binding.tenant
           JOIN member_tokens token
             ON token.id = ?10 AND token.tenant = binding.tenant
            AND token.member_id = binding.member_id AND token.agent_id = seat.agent_id
          WHERE seat.tenant = lease.tenant AND seat.id = lease.runtime_seat_id
            AND seat.agent_id = ?8 AND seat.state = 'active'
            AND seat.current_generation = lease.generation
            AND seat.current_fencing_epoch < lease.fencing_epoch
            AND agent.status = 'active' AND member.status = 'active'
            AND token.channel = 'workspace' AND token.token_hash = ?11
            AND ${TOKEN_LIVE_PREDICATE('?2').replaceAll('t.', 'token.')}
            AND squad.id = ?12 AND squad.department_id = ?13
            AND CASE membership.capability
              WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
              WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
            AND (
              ?14 = 1
              OR EXISTS (
                SELECT 1 FROM capabilities capability
                 WHERE capability.member_id = member.id
                   AND (
                     capability.scope_type = 'org'
                     OR (capability.scope_type = 'department'
                       AND capability.scope_id = squad.department_id)
                     OR (capability.scope_type = 'squad'
                       AND capability.scope_id = squad.id)
                   )
                   AND CASE capability.capability
                     WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                     WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
              )
              OR EXISTS (
                SELECT 1 FROM channel_capability_grants capability
                 WHERE capability.member_id = member.id
                   AND capability.squad_id = squad.id
                   AND CASE capability.capability
                     WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                     WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
              )
            )
       )
    RETURNING id
  `).bind(
    expiresAt,
    renewedAt,
    env.TENANT_SLUG,
    runtimeSeatId,
    generation,
    fencingEpoch,
    tokenHash,
    actor.agentId,
    actor.memberId,
    actor.tokenId,
    actor.tokenHash,
    authority.squadId,
    authority.departmentId,
    authority.legacyAdmin ? 1 : 0,
  ).all<{ id: string }>()
  const rows = result.results ?? []
  if (rows.length !== 1) throw new RuntimeSeatError('stale_lease')
  return leaseById(env, rows[0].id)
}

/** Release the exact lease and advance the durable completed fencing epoch once. */
export async function releaseRuntimeSeatLease(
  env: Env,
  auth: AuthContext,
  input: ReleaseRuntimeSeatLeaseInput,
): Promise<RuntimeSeatLease> {
  const runtimeSeatId = boundedText(input?.runtimeSeatId, 255)
  const generation = positiveInteger(input?.generation)
  const fencingEpoch = positiveInteger(input?.fencingEpoch)
  const tokenHash = leaseTokenHash(input?.leaseTokenHash)
  const actor = await requireLeaseActor(env, auth)
  const seat = await readSeatForActor(env, runtimeSeatId, actor)
  const authority = await requireLeaseAuthority(env, auth, actor, seat)
  assertActiveGeneration(seat, generation)
  const releasedAt = new Date().toISOString()
  const results = await env.DB.batch<{ id: string }>([
    env.DB.prepare(`
      UPDATE runtime_seat_leases AS lease
         SET state = 'released', released_at = ?1
       WHERE lease.tenant = ?2 AND lease.runtime_seat_id = ?3
         AND lease.generation = ?4 AND lease.fencing_epoch = ?5
         AND lease.lease_token_hash = ?6 AND lease.state = 'active'
         AND julianday(lease.expires_at) IS NOT NULL
         AND julianday(lease.expires_at) > julianday(?1)
         AND EXISTS (
           SELECT 1
             FROM runtime_seats seat
             JOIN agents agent ON agent.id = seat.agent_id
             JOIN squads squad ON squad.id = agent.squad_id
             JOIN memberships membership
               ON membership.agent_id = agent.id AND membership.squad_id = squad.id
             JOIN agent_member_bindings binding
               ON binding.tenant = seat.tenant
              AND binding.agent_id = seat.agent_id
              AND binding.member_id = ?8
             JOIN members member
               ON member.id = binding.member_id AND member.tenant = binding.tenant
             JOIN member_tokens token
               ON token.id = ?9 AND token.tenant = binding.tenant
              AND token.member_id = binding.member_id AND token.agent_id = seat.agent_id
            WHERE seat.tenant = lease.tenant AND seat.id = lease.runtime_seat_id
              AND seat.agent_id = ?7 AND seat.state = 'active'
              AND seat.current_generation = lease.generation
              AND seat.current_fencing_epoch < lease.fencing_epoch
              AND agent.status = 'active' AND member.status = 'active'
              AND token.channel = 'workspace' AND token.token_hash = ?10
              AND ${TOKEN_LIVE_PREDICATE('?1').replaceAll('t.', 'token.')}
              AND squad.id = ?11 AND squad.department_id = ?12
              AND CASE membership.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
              AND (
                ?13 = 1
                OR EXISTS (
                  SELECT 1 FROM capabilities capability
                   WHERE capability.member_id = member.id
                     AND (
                       capability.scope_type = 'org'
                       OR (capability.scope_type = 'department'
                         AND capability.scope_id = squad.department_id)
                       OR (capability.scope_type = 'squad'
                         AND capability.scope_id = squad.id)
                     )
                     AND CASE capability.capability
                       WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                       WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
                )
                OR EXISTS (
                  SELECT 1 FROM channel_capability_grants capability
                   WHERE capability.member_id = member.id
                     AND capability.squad_id = squad.id
                     AND CASE capability.capability
                       WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                       WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
                )
              )
         )
      RETURNING id
    `).bind(
      releasedAt,
      env.TENANT_SLUG,
      runtimeSeatId,
      generation,
      fencingEpoch,
      tokenHash,
      actor.agentId,
      actor.memberId,
      actor.tokenId,
      actor.tokenHash,
      authority.squadId,
      authority.departmentId,
      authority.legacyAdmin ? 1 : 0,
    ),
    env.DB.prepare(`
      UPDATE runtime_seats AS seat
         SET current_fencing_epoch = ?1, updated_at = ?2
       WHERE seat.tenant = ?3 AND seat.id = ?4 AND seat.agent_id = ?5
         AND seat.state = 'active' AND seat.current_generation = ?6
         AND seat.current_fencing_epoch < ?1
         AND NOT EXISTS (
           SELECT 1 FROM runtime_seat_leases active
            WHERE active.tenant = seat.tenant AND active.runtime_seat_id = seat.id
              AND active.state = 'active'
         )
         AND EXISTS (
           SELECT 1 FROM runtime_seat_leases released
            WHERE released.tenant = seat.tenant AND released.runtime_seat_id = seat.id
              AND released.generation = ?6 AND released.fencing_epoch = ?1
              AND released.lease_token_hash = ?7 AND released.state = 'released'
              AND released.released_at = ?2
         )
      RETURNING id
    `).bind(
      fencingEpoch,
      releasedAt,
      env.TENANT_SLUG,
      runtimeSeatId,
      actor.agentId,
      generation,
      tokenHash,
    ),
  ])
  const leaseRows = results[0]?.results ?? []
  const seatRows = results[1]?.results ?? []
  if (leaseRows.length !== 1 || seatRows.length !== 1) {
    throw new RuntimeSeatError('stale_lease')
  }
  return leaseById(env, leaseRows[0].id)
}
