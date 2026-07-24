import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { canOnSquad, capabilityRank } from '../auth/capability'
import {
  claudeCodeSnippet,
  codexSnippet,
  cursorSnippet,
  mcpEndpoint,
  requiredCanonicalOrigin,
} from '../dashboard/connect'
import { rowsWritten } from '../lib/receipt'
import {
  isNonEmptyString,
  isValidSlug,
  prepareAgentCreate,
  type AgentInput,
  type PreparedAgentCreate,
} from '../org/service'
import { resolveAgentRef } from '../org/resolve'
import type { Agent, Capability, CapabilityGrant, Env } from '../types'
import {
  prepareAgentSquadAccess,
  type AgentAccessCapability,
} from './agent-access'
import {
  prepareAgentBoundTokenMint,
  resolveAgentMemberBinding,
  sha256Hex,
  type PreparedAgentTokenMint,
} from './service'

export const AGENT_CONNECTION_PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_RECEIPT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
export const AGENT_CONNECTION_VERIFY_TTL_MS = 15 * 60 * 1000

export interface AgentConnectionActor {
  kind: 'user' | 'member'
  id: string
  grants: CapabilityGrant[]
  legacyOrgRole?: 'owner' | 'admin'
}

export type AgentConnectionTarget =
  | { kind: 'existing'; agentRef: string }
  | { kind: 'new'; homeSquadId: string; agent: AgentInput }

export interface AgentConnectionInput {
  requestId: string
  target: AgentConnectionTarget
  additionalAccess: Array<{
    squadId: string
    capability: AgentAccessCapability
  }>
  credential: {
    action: 'issue_if_missing' | 'add' | 'replace'
    label: string
    homeCapability?: 'observer' | 'member'
    replaceTokenId?: string
  }
}

export interface AgentConnectionReceipt {
  id: string
  tenant: string
  actor_kind: 'user' | 'member'
  actor_id: string
  request_id: string
  request_fingerprint: string
  agent_id: string
  agent_slug: string
  agent_status_at_issue: string
  member_id: string
  token_id: string
  agent_disposition: 'created' | 'reused'
  credential_action: 'issue_if_missing' | 'add' | 'replace'
  home_squad_id: string
  home_capability: 'observer' | 'member'
  additional_access_json: string
  token_label: string
  endpoint: string
  transport: 'streamable_http'
  verification_status: 'pending' | 'pass' | 'fail' | 'expired'
  verification_challenge_hash: string | null
  verification_expires_at: string | null
  client_connected_at: string | null
  verification_message_id: string | null
  verification_request_id: string | null
  messaging_verified_at: string | null
  verification_error_code: string | null
  checks_json: string
  credential_issued_at: string
  created_at: string
  updated_at: string
}

export interface AgentConnectionIssued {
  status: 'credential_issued'
  credential: {
    raw: string
    tokenId: string
    shownOnce: true
  }
  verification: {
    receiptId: string
    challenge: string
    expiresAt: string
  }
  endpoint: string
  configuration: {
    claudeCode: string
    codex: string
    cursor: string
  }
  receipt: AgentConnectionReceipt
}

export type AgentConnectionOutcome =
  | AgentConnectionIssued
  | { status: 'in_progress' }
  | { status: 'credential_already_issued'; receipt: AgentConnectionReceipt }
  | {
      status: 'error'
      error: string
      details?: Record<string, string>
    }

interface AgentRow {
  id: string
  squad_id: string
  slug: string
  name: string
  role: string
  model: string
  status: string
}

interface RequestRow {
  request_fingerprint: string
  status: string
  receipt_id: string | null
  error_code: string | null
}

interface NormalizedConnection {
  requestId: string
  target:
    | { kind: 'existing'; agent: AgentRow }
    | { kind: 'new'; homeSquadId: string; agent: AgentInput }
  homeSquadId: string
  targetKey: string
  additionalAccess: AgentConnectionInput['additionalAccess']
  credential: {
    action: 'issue_if_missing' | 'add' | 'replace'
    label: string
    homeCapability: 'observer' | 'member'
    replaceTokenId?: string
  }
  fingerprint: string
}

const CAPS_DESC: Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']

function addMs(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString()
}

function randomChallenge(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    )
  }
  return value
}

async function fingerprint(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(stableValue(value)))
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function errorOutcome(error: string, details?: Record<string, string>): AgentConnectionOutcome {
  return details ? { status: 'error', error, details } : { status: 'error', error }
}

async function resolveExistingAgent(
  env: Env,
  ref: string,
): Promise<{ ok: true; agent: AgentRow } | { ok: false; error: 'agent_not_found' | 'ambiguous_slug' }> {
  const trimmed = ref.trim()
  if (!trimmed) return { ok: false, error: 'agent_not_found' }
  const resolved = await resolveAgentRef(env, trimmed)
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.reason === 'ambiguous' ? 'ambiguous_slug' : 'agent_not_found',
    }
  }
  const agent = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status
       FROM agents
      WHERE id = ?
      LIMIT 1`,
  ).bind(resolved.value.id).first<AgentRow>()
  return agent
    ? { ok: true, agent }
    : { ok: false, error: 'agent_not_found' }
}

async function normalizeInput(
  env: Env,
  input: AgentConnectionInput,
): Promise<NormalizedConnection | AgentConnectionOutcome> {
  const requestId = input.requestId.trim()
  if (requestId.length < 1 || requestId.length > 128) {
    return errorOutcome('invalid_request_id')
  }
  if (!['issue_if_missing', 'add', 'replace'].includes(input.credential.action)) {
    return errorOutcome('invalid_credential_action')
  }
  if (
    input.credential.action === 'replace'
    && !input.credential.replaceTokenId?.trim()
  ) {
    return errorOutcome('replace_token_required')
  }
  if (
    input.credential.action !== 'replace'
    && input.credential.replaceTokenId !== undefined
  ) {
    return errorOutcome('replace_token_not_allowed')
  }
  const homeCapability = input.credential.homeCapability ?? 'member'
  if (homeCapability !== 'observer' && homeCapability !== 'member') {
    return errorOutcome('invalid_home_capability')
  }
  const label = input.credential.label.trim().slice(0, 64)

  let target: NormalizedConnection['target']
  let homeSquadId: string
  let targetKey: string
  if (input.target.kind === 'existing') {
    const resolved = await resolveExistingAgent(env, input.target.agentRef)
    if (!resolved.ok) return errorOutcome(resolved.error)
    const agent = resolved.agent
    if (agent.status !== 'active') return errorOutcome('agent_inactive')
    target = { kind: 'existing', agent }
    homeSquadId = agent.squad_id
    targetKey = `agent:${agent.id}`
  } else {
    const slugValue = typeof input.target.agent.slug === 'string'
      ? input.target.agent.slug.trim().normalize('NFC').toLowerCase()
      : input.target.agent.slug
    const normalizedAgent: AgentInput = {
      ...input.target.agent,
      slug: slugValue,
      name: typeof input.target.agent.name === 'string'
        ? input.target.agent.name.trim()
        : input.target.agent.name,
    }
    homeSquadId = input.target.homeSquadId.trim()
    if (!homeSquadId) return errorOutcome('squad_not_found')
    if (!isValidSlug(normalizedAgent.slug)) return errorOutcome('invalid_slug')
    if (!isNonEmptyString(normalizedAgent.name)) return errorOutcome('invalid_name')
    target = { kind: 'new', homeSquadId, agent: normalizedAgent }
    targetKey = `new:${homeSquadId}:${String(slugValue ?? '')}`
  }

  const additionalAccess = [...input.additionalAccess]
    .map((entry) => ({
      squadId: entry.squadId.trim(),
      capability: entry.capability,
    }))
    .sort((a, b) => a.squadId.localeCompare(b.squadId))
  const seen = new Set<string>()
  for (const entry of additionalAccess) {
    if (!entry.squadId) return errorOutcome('squad_not_found')
    if (entry.squadId === homeSquadId) return errorOutcome('home_squad_duplicate')
    if (seen.has(entry.squadId)) return errorOutcome('duplicate_squad_access')
    seen.add(entry.squadId)
  }

  for (const squadId of [homeSquadId, ...additionalAccess.map((entry) => entry.squadId)]) {
    const squad = await env.DB.prepare(
      'SELECT id FROM squads WHERE id = ? LIMIT 1',
    ).bind(squadId).first<{ id: string }>()
    if (!squad) return errorOutcome('squad_not_found')
  }

  const credential = {
    ...input.credential,
    label,
    homeCapability,
    replaceTokenId: input.credential.replaceTokenId?.trim(),
  }
  const requestFingerprint = await fingerprint({
    target: target.kind === 'existing'
      ? { kind: 'existing', agentId: target.agent.id }
      : target,
    additionalAccess,
    credential,
  })
  return {
    requestId,
    target,
    homeSquadId,
    targetKey,
    additionalAccess,
    credential,
    fingerprint: requestFingerprint,
  }
}

function legacyRank(actor: AgentConnectionActor): number {
  if (actor.legacyOrgRole === 'owner') return capabilityRank('owner')
  if (actor.legacyOrgRole === 'admin') return capabilityRank('admin')
  return 0
}

async function actorRankOnSquad(
  env: Env,
  actor: AgentConnectionActor,
  squadId: string,
): Promise<number> {
  let rank = legacyRank(actor)
  for (const capability of CAPS_DESC) {
    if (await canOnSquad(env, actor.grants, squadId, capability)) {
      rank = Math.max(rank, capabilityRank(capability))
      break
    }
  }
  return rank
}

async function authorize(
  env: Env,
  actor: AgentConnectionActor,
  normalized: NormalizedConnection,
): Promise<AgentConnectionOutcome | null> {
  const homeRank = await actorRankOnSquad(env, actor, normalized.homeSquadId)
  const homeNeed = normalized.target.kind === 'new' ? 'lead' : 'admin'
  if (homeRank < capabilityRank(homeNeed)) {
    return errorOutcome('forbidden', { need: homeNeed, squad_id: normalized.homeSquadId })
  }
  // Credential issuance is always an admin act, including creation flows.
  if (homeRank < capabilityRank('admin')) {
    return errorOutcome('forbidden', { need: 'admin', squad_id: normalized.homeSquadId })
  }
  for (const access of normalized.additionalAccess) {
    const rank = await actorRankOnSquad(env, actor, access.squadId)
    if (rank < capabilityRank('admin')) {
      return errorOutcome('forbidden', { need: 'admin', squad_id: access.squadId })
    }
    if (rank < capabilityRank(access.capability)) {
      return errorOutcome('capability_ceiling', { squad_id: access.squadId })
    }
  }
  return null
}

async function readReceipt(env: Env, id: string): Promise<AgentConnectionReceipt | null> {
  return env.DB.prepare(
    'SELECT * FROM agent_connection_receipts WHERE tenant = ? AND id = ? LIMIT 1',
  ).bind(env.TENANT_SLUG, id).first<AgentConnectionReceipt>()
}

async function replayOutcome(
  env: Env,
  request: RequestRow,
  expectedFingerprint: string,
): Promise<AgentConnectionOutcome> {
  if (request.request_fingerprint !== expectedFingerprint) {
    return errorOutcome('request_id_conflict')
  }
  if (request.status === 'pending') return { status: 'in_progress' }
  if (
    ['credential_issued', 'client_connected', 'messaging_verified'].includes(request.status)
    && request.receipt_id
  ) {
    const receipt = await readReceipt(env, request.receipt_id)
    if (!receipt) return errorOutcome('receipt_not_found')
    return { status: 'credential_already_issued', receipt }
  }
  return errorOutcome(request.error_code ?? `request_${request.status}`)
}

async function reserve(
  env: Env,
  actor: AgentConnectionActor,
  normalized: NormalizedConnection,
  now: Date,
): Promise<AgentConnectionOutcome | null> {
  const existing = await env.DB.prepare(
    `SELECT request_fingerprint, status, receipt_id, error_code
       FROM agent_connection_requests
      WHERE tenant = ?
        AND actor_kind = ?
        AND actor_id = ?
        AND request_id = ?
      LIMIT 1`,
  ).bind(
    env.TENANT_SLUG,
    actor.kind,
    actor.id,
    normalized.requestId,
  ).first<RequestRow>()
  if (existing) return replayOutcome(env, existing, normalized.fingerprint)

  const nowIso = now.toISOString()
  await env.DB.prepare(
    `UPDATE agent_connection_requests
        SET status = 'expired',
            error_code = 'reservation_expired',
            updated_at = ?,
            finalized_at = ?
      WHERE tenant = ?
        AND target_key = ?
        AND status = 'pending'
        AND expires_at <= ?`,
  ).bind(
    nowIso,
    nowIso,
    env.TENANT_SLUG,
    normalized.targetKey,
    nowIso,
  ).run()

  try {
    await env.DB.prepare(
      `INSERT INTO agent_connection_requests
        (tenant, actor_kind, actor_id, request_id, request_fingerprint,
         target_key, agent_mode, credential_action, replace_token_id, status,
         created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(
      env.TENANT_SLUG,
      actor.kind,
      actor.id,
      normalized.requestId,
      normalized.fingerprint,
      normalized.targetKey,
      normalized.target.kind,
      normalized.credential.action,
      normalized.credential.action === 'replace'
        ? normalized.credential.replaceTokenId
        : null,
      nowIso,
      nowIso,
      addMs(now, AGENT_CONNECTION_PENDING_TTL_MS),
    ).run()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await env.DB.prepare(
      `SELECT request_fingerprint, status, receipt_id, error_code
         FROM agent_connection_requests
        WHERE tenant = ?
          AND actor_kind = ?
          AND actor_id = ?
          AND request_id = ?
        LIMIT 1`,
    ).bind(
      env.TENANT_SLUG,
      actor.kind,
      actor.id,
      normalized.requestId,
    ).first<RequestRow>()
    if (raced) return replayOutcome(env, raced, normalized.fingerprint)
    return errorOutcome('agent_setup_in_progress')
  }
  return null
}

async function failReservation(
  env: Env,
  actor: AgentConnectionActor,
  normalized: NormalizedConnection,
  errorCode: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString()
  await env.DB.prepare(
    `UPDATE agent_connection_requests
        SET status = 'failed',
            error_code = ?,
            updated_at = ?,
            finalized_at = ?
      WHERE tenant = ?
        AND actor_kind = ?
        AND actor_id = ?
        AND request_id = ?
        AND request_fingerprint = ?
        AND status = 'pending'`,
  ).bind(
    errorCode,
    nowIso,
    nowIso,
    env.TENANT_SLUG,
    actor.kind,
    actor.id,
    normalized.requestId,
    normalized.fingerprint,
  ).run()
}

function publicAgent(prepared: PreparedAgentCreate): AgentRow {
  return prepared.agent as Agent
}

function insertReceiptStatement(env: Env, receipt: AgentConnectionReceipt): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO agent_connection_receipts
      (id, tenant, actor_kind, actor_id, request_id, request_fingerprint,
       agent_id, agent_slug, agent_status_at_issue, member_id, token_id,
       agent_disposition, credential_action, home_squad_id, home_capability,
       additional_access_json, token_label, endpoint, transport,
       verification_status, verification_challenge_hash, verification_expires_at,
       client_connected_at, verification_message_id, verification_request_id,
       messaging_verified_at, verification_error_code, checks_json,
       credential_issued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    receipt.id,
    receipt.tenant,
    receipt.actor_kind,
    receipt.actor_id,
    receipt.request_id,
    receipt.request_fingerprint,
    receipt.agent_id,
    receipt.agent_slug,
    receipt.agent_status_at_issue,
    receipt.member_id,
    receipt.token_id,
    receipt.agent_disposition,
    receipt.credential_action,
    receipt.home_squad_id,
    receipt.home_capability,
    receipt.additional_access_json,
    receipt.token_label,
    receipt.endpoint,
    receipt.transport,
    receipt.verification_status,
    receipt.verification_challenge_hash,
    receipt.verification_expires_at,
    receipt.client_connected_at,
    receipt.verification_message_id,
    receipt.verification_request_id,
    receipt.messaging_verified_at,
    receipt.verification_error_code,
    receipt.checks_json,
    receipt.credential_issued_at,
    receipt.created_at,
    receipt.updated_at,
  )
}

export async function provisionAgentConnection(
  env: Env,
  actor: AgentConnectionActor,
  input: AgentConnectionInput,
  now = new Date(),
): Promise<AgentConnectionOutcome> {
  const canonical = requiredCanonicalOrigin(env)
  if (!canonical.ok) return errorOutcome(canonical.error)

  const normalizedResult = await normalizeInput(env, input)
  if ('status' in normalizedResult) return normalizedResult
  const normalized = normalizedResult

  const denied = await authorize(env, actor, normalized)
  if (denied) return denied

  const reservation = await reserve(env, actor, normalized, now)
  if (reservation) return reservation

  let preparedAgent: PreparedAgentCreate | null = null
  let agent: AgentRow
  let agentDisposition: 'created' | 'reused'
  try {
    if (normalized.target.kind === 'new') {
      const prepared = await prepareAgentCreate(
        env,
        normalized.target.homeSquadId,
        normalized.target.agent,
      )
      if (!prepared.ok) {
        await failReservation(env, actor, normalized, prepared.error, now)
        return errorOutcome(prepared.error)
      }
      preparedAgent = prepared.value
      agent = publicAgent(prepared.value)
      agentDisposition = 'created'
    } else {
      agent = normalized.target.agent
      agentDisposition = 'reused'
    }

    const existingBinding = await resolveAgentMemberBinding(env, agent.id)
    if (
      normalized.credential.action === 'issue_if_missing'
      && existingBinding.kind === 'bound'
    ) {
      await failReservation(env, actor, normalized, 'agent_already_connected', now)
      return errorOutcome('agent_already_connected')
    }
    if (
      normalized.credential.action !== 'issue_if_missing'
      && existingBinding.kind === 'unminted'
    ) {
      await failReservation(env, actor, normalized, 'agent_identity_unminted', now)
      return errorOutcome('agent_identity_unminted')
    }

    const token: PreparedAgentTokenMint = await prepareAgentBoundTokenMint(
      env,
      agent,
      normalized.credential.label || agent.slug,
      normalized.credential.homeCapability,
    )

    let replaceStatement: D1PreparedStatement | null = null
    if (normalized.credential.action === 'replace') {
      const replaceTokenId = normalized.credential.replaceTokenId as string
      const replaceTarget = await env.DB.prepare(
        `SELECT id
           FROM member_tokens
          WHERE id = ?
            AND tenant = ?
            AND member_id = ?
            AND agent_id = ?
            AND revoked_at IS NULL
          LIMIT 1`,
      ).bind(
        replaceTokenId,
        env.TENANT_SLUG,
        token.memberId,
        agent.id,
      ).first<{ id: string }>()
      if (!replaceTarget) {
        await failReservation(env, actor, normalized, 'replace_token_not_found', now)
        return errorOutcome('replace_token_not_found')
      }
      replaceStatement = env.DB.prepare(
        `UPDATE member_tokens
            SET revoked_at = ?
          WHERE id = ?
            AND tenant = ?
            AND member_id = ?
            AND agent_id = ?
            AND revoked_at IS NULL`,
      ).bind(
        now.toISOString(),
        replaceTokenId,
        env.TENANT_SLUG,
        token.memberId,
        agent.id,
      )
    }

    const accessStatements: D1PreparedStatement[] = []
    for (const access of [
      {
        squadId: normalized.homeSquadId,
        capability: token.grantCapability,
      },
      ...normalized.additionalAccess,
    ]) {
      const prepared = await prepareAgentSquadAccess(env, {
        agentId: agent.id,
        memberId: token.memberId,
        squadId: access.squadId,
        capability: access.capability,
      }, token.bindingProof)
      if (!prepared.ok) {
        await failReservation(env, actor, normalized, prepared.error, now)
        return errorOutcome(prepared.error)
      }
      accessStatements.push(...prepared.value.statements)
    }

    const challenge = randomChallenge()
    const challengeHash = await sha256Hex(challenge)
    const issuedAt = now.toISOString()
    const receiptId = crypto.randomUUID()
    const verificationExpiresAt = addMs(now, AGENT_CONNECTION_VERIFY_TTL_MS)
    const endpoint = mcpEndpoint(canonical.origin)
    const receipt: AgentConnectionReceipt = {
      id: receiptId,
      tenant: env.TENANT_SLUG,
      actor_kind: actor.kind,
      actor_id: actor.id,
      request_id: normalized.requestId,
      request_fingerprint: normalized.fingerprint,
      agent_id: agent.id,
      agent_slug: agent.slug,
      agent_status_at_issue: agent.status,
      member_id: token.memberId,
      token_id: token.tokenId,
      agent_disposition: agentDisposition,
      credential_action: normalized.credential.action,
      home_squad_id: normalized.homeSquadId,
      home_capability: token.grantCapability,
      additional_access_json: JSON.stringify(normalized.additionalAccess),
      token_label: normalized.credential.label || agent.slug,
      endpoint,
      transport: 'streamable_http',
      verification_status: 'pending',
      verification_challenge_hash: challengeHash,
      verification_expires_at: verificationExpiresAt,
      client_connected_at: null,
      verification_message_id: null,
      verification_request_id: null,
      messaging_verified_at: null,
      verification_error_code: null,
      checks_json: '{}',
      credential_issued_at: issuedAt,
      created_at: issuedAt,
      updated_at: issuedAt,
    }

    const statements: D1PreparedStatement[] = [
      ...(preparedAgent?.statements ?? []),
      ...token.statements,
      ...accessStatements,
    ]
    if (replaceStatement) statements.push(replaceStatement)
    statements.push(
      insertReceiptStatement(env, receipt),
      env.DB.prepare(
        `UPDATE agent_connection_requests
            SET status = 'credential_issued',
                agent_id = ?,
                member_id = ?,
                token_id = ?,
                receipt_id = ?,
                updated_at = ?,
                finalized_at = ?
          WHERE tenant = ?
            AND actor_kind = ?
            AND actor_id = ?
            AND request_id = ?
            AND request_fingerprint = ?
            AND status = 'pending'`,
      ).bind(
        agent.id,
        token.memberId,
        token.tokenId,
        receiptId,
        issuedAt,
        issuedAt,
        env.TENANT_SLUG,
        actor.kind,
        actor.id,
        normalized.requestId,
        normalized.fingerprint,
      ),
    )

    const writes = await env.DB.batch(statements)
    if (writes.some((write) => rowsWritten(write) < 1)) {
      throw new Error('receipt_failed')
    }

    return {
      status: 'credential_issued',
      credential: {
        raw: token.raw,
        tokenId: token.tokenId,
        shownOnce: true,
      },
      verification: {
        receiptId,
        challenge,
        expiresAt: verificationExpiresAt,
      },
      endpoint,
      configuration: {
        claudeCode: claudeCodeSnippet(env.TENANT_SLUG, canonical.origin),
        codex: codexSnippet(env.TENANT_SLUG, canonical.origin),
        cursor: cursorSnippet(env.TENANT_SLUG, canonical.origin),
      },
      receipt,
    }
  } catch (error) {
    const code = error instanceof Error && error.message.includes('slug')
      ? 'slug_taken'
      : error instanceof Error && error.message.includes('agent_identity_conflict')
        ? 'agent_identity_conflict'
        : 'provisioning_failed'
    await failReservation(env, actor, normalized, code, now)
    return errorOutcome(code)
  }
}

export async function sweepAgentConnectionRetention(
  env: Env,
  now = new Date(),
): Promise<{
  requestsExpired: number
  challengesExpired: number
  requestsPurged: number
  receiptsPurged: number
}> {
  const zero = {
    requestsExpired: 0,
    challengesExpired: 0,
    requestsPurged: 0,
    receiptsPurged: 0,
  }
  try {
    const nowIso = now.toISOString()
    const requestCutoff = new Date(
      now.getTime() - AGENT_CONNECTION_REQUEST_RETENTION_MS,
    ).toISOString()
    const receiptCutoff = new Date(
      now.getTime() - AGENT_CONNECTION_RECEIPT_RETENTION_MS,
    ).toISOString()
    const writes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_connection_requests
            SET status = 'expired',
                error_code = COALESCE(error_code, 'reservation_expired'),
                updated_at = ?,
                finalized_at = ?
          WHERE tenant = ?
            AND status = 'pending'
            AND expires_at <= ?`,
      ).bind(nowIso, nowIso, env.TENANT_SLUG, nowIso),
      env.DB.prepare(
        `UPDATE agent_connection_receipts
            SET verification_status = 'expired',
                verification_challenge_hash = NULL,
                updated_at = ?
          WHERE tenant = ?
            AND verification_status = 'pending'
            AND verification_expires_at <= ?`,
      ).bind(nowIso, env.TENANT_SLUG, nowIso),
      env.DB.prepare(
        `DELETE FROM agent_connection_requests
          WHERE tenant = ?
            AND status <> 'pending'
            AND finalized_at <= ?`,
      ).bind(env.TENANT_SLUG, requestCutoff),
      env.DB.prepare(
        `DELETE FROM agent_connection_receipts
          WHERE tenant = ?
            AND created_at <= ?`,
      ).bind(env.TENANT_SLUG, receiptCutoff),
    ])
    return {
      requestsExpired: rowsWritten(writes[0]),
      challengesExpired: rowsWritten(writes[1]),
      requestsPurged: rowsWritten(writes[2]),
      receiptsPurged: rowsWritten(writes[3]),
    }
  } catch (error) {
    console.error('agent connection retention sweep failed', error)
    return zero
  }
}
