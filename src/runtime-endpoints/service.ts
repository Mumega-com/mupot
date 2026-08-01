import type { Env } from '../types'

export const RUNTIME_ENDPOINT_SCHEMA = 'mupot.runtime-endpoint/v1'
export const RUNTIME_ENDPOINT_ACK_SCHEMA = 'mupot.runtime-endpoint-ack/v1'
export const RUNTIME_ENDPOINT_REJECTION_SCHEMA = 'mupot.runtime-endpoint-rejection/v1'
export const MIN_LEASE_SECONDS = 60
export const MAX_LEASE_SECONDS = 3600
export const DEFAULT_LEASE_SECONDS = 300
export const MAX_RUNTIME_ENDPOINT_UNREAD = 1000

export type RuntimeKind = 'codex' | 'claude_code' | 'cursor' | 'hermes' | 'other'
export type WakeAdapter = 'codex_cli' | 'codex_app_server' | 'claude_cli' | 'hermes' | 'generic'
export type EndpointStatus = 'active' | 'expired' | 'revoked'
export type EndpointMessageKind = 'message' | 'request'

const RUNTIME_KINDS = new Set<RuntimeKind>(['codex', 'claude_code', 'cursor', 'hermes', 'other'])
const WAKE_ADAPTERS = new Set<WakeAdapter>(['codex_cli', 'codex_app_server', 'claude_cli', 'hermes', 'generic'])
const MESSAGE_KINDS = new Set<EndpointMessageKind>(['message', 'request'])
const OPAQUE_HANDLE_RE = /^[A-Za-z0-9_-]{32,128}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

interface RuntimeEndpointRow {
  id: string
  tenant: string
  agent_id: string
  member_id: string
  runtime_kind: string
  session_fingerprint: string
  capability_hash: string
  node_id: string
  local_source_id: string
  project_id: string
  purpose: string
  workspace: string
  wake_adapter: string
  allowed_senders: string
  status: 'active' | 'revoked'
  lease_expires_at: string
  last_seen_at: string
  registered_at: string
  revoked_at: string | null
}

export interface RuntimeEndpoint {
  id: string
  agent_id: string
  member_id: string
  runtime_kind: RuntimeKind
  node_id: string
  local_source_id: string
  project_id: string
  purpose: string
  workspace: string
  wake_adapter: WakeAdapter
  allowed_senders: string[]
  status: EndpointStatus
  lease_expires_at: string
  last_seen_at: string
  registered_at: string
  revoked_at: string | null
}

export interface RuntimeEndpointMessage {
  seq: number
  id: string
  endpoint_id: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
  in_reply_to: string | null
  project_id: string
  created_at: string
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const ENDPOINT_COLUMNS = `id, tenant, agent_id, member_id, runtime_kind, session_fingerprint,
  capability_hash, node_id, local_source_id, project_id, purpose, workspace, wake_adapter,
  allowed_senders, status,
  lease_expires_at, last_seen_at, registered_at, revoked_at`

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === 'string' && RUNTIME_KINDS.has(value as RuntimeKind)
}

function isWakeAdapter(value: unknown): value is WakeAdapter {
  return typeof value === 'string' && WAKE_ADAPTERS.has(value as WakeAdapter)
}

function effectiveStatus(row: RuntimeEndpointRow, now: Date): EndpointStatus {
  if (row.status === 'revoked') return 'revoked'
  const leaseMs = Date.parse(row.lease_expires_at)
  return Number.isFinite(leaseMs) && leaseMs > now.getTime() ? 'active' : 'expired'
}

function publicEndpoint(row: RuntimeEndpointRow, now: Date): RuntimeEndpoint | null {
  if (!isRuntimeKind(row.runtime_kind) || !isWakeAdapter(row.wake_adapter)) return null
  return {
    id: row.id,
    agent_id: row.agent_id,
    member_id: row.member_id,
    runtime_kind: row.runtime_kind,
    node_id: row.node_id,
    local_source_id: row.local_source_id,
    project_id: row.project_id,
    purpose: row.purpose,
    workspace: row.workspace,
    wake_adapter: row.wake_adapter,
    allowed_senders: parseAllowedSenders(row.allowed_senders),
    status: effectiveStatus(row, now),
    lease_expires_at: row.lease_expires_at,
    last_seen_at: row.last_seen_at,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
  }
}

function parseAllowedSenders(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && REF_RE.test(item)).slice(0, 64)
      : []
  } catch {
    return []
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function validAllowedSenders(value: string[]): boolean {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 64 &&
    value.every((sender) => typeof sender === 'string' && REF_RE.test(sender)) &&
    new Set(value).size === value.length
}

function clampLease(value: number | undefined): number | null {
  const lease = value ?? DEFAULT_LEASE_SECONDS
  if (!Number.isInteger(lease) || lease < MIN_LEASE_SECONDS || lease > MAX_LEASE_SECONDS) return null
  return lease
}

export interface CheckInRuntimeEndpointInput {
  agentId: string
  memberId: string
  runtimeKind: RuntimeKind
  runtimeSessionHandle: string
  nodeId: string
  localSourceId: string
  projectId: string
  purpose: string
  workspace: string
  wakeAdapter: WakeAdapter
  allowedSenders: string[]
  leaseSeconds?: number
}

export async function checkInRuntimeEndpoint(
  env: Env,
  input: CheckInRuntimeEndpointInput,
  now: Date = new Date(),
): Promise<Result<{ endpoint: RuntimeEndpoint; endpointCapability: string }>> {
  if (!env.TENANT_SLUG) return { ok: false, error: 'no_tenant' }
  if (!REF_RE.test(input.agentId) || !REF_RE.test(input.memberId)) return { ok: false, error: 'invalid_identity' }
  if (!isRuntimeKind(input.runtimeKind)) return { ok: false, error: 'invalid_runtime_kind' }
  if (UUID_RE.test(input.runtimeSessionHandle)) return { ok: false, error: 'raw_runtime_session_forbidden' }
  if (!OPAQUE_HANDLE_RE.test(input.runtimeSessionHandle)) return { ok: false, error: 'invalid_runtime_session_handle' }
  if (!REF_RE.test(input.nodeId)) return { ok: false, error: 'invalid_node_id' }
  if (!REF_RE.test(input.localSourceId)) return { ok: false, error: 'invalid_local_source_id' }
  if (!REF_RE.test(input.projectId)) return { ok: false, error: 'invalid_project_id' }
  if (!input.purpose.trim() || input.purpose.length > 120) return { ok: false, error: 'invalid_purpose' }
  if (!input.workspace.trim() || input.workspace.length > 240) return { ok: false, error: 'invalid_workspace' }
  if (!isWakeAdapter(input.wakeAdapter)) return { ok: false, error: 'invalid_wake_adapter' }
  if (!validAllowedSenders(input.allowedSenders)) return { ok: false, error: 'invalid_allowed_senders' }
  const leaseSeconds = clampLease(input.leaseSeconds)
  if (leaseSeconds === null) return { ok: false, error: 'invalid_lease_seconds' }

  const fingerprint = await sha256Hex(input.runtimeSessionHandle)
  const endpointCapability = randomCapability()
  const capabilityHash = await sha256Hex(endpointCapability)
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
  const id = crypto.randomUUID()

  const row = await env.DB.prepare(
    `INSERT INTO runtime_endpoints
       (id, tenant, agent_id, member_id, runtime_kind, session_fingerprint, capability_hash,
        node_id, local_source_id, project_id, purpose, workspace, wake_adapter, allowed_senders,
        status, lease_expires_at, last_seen_at, registered_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'active', ?15, ?16, ?16, NULL)
     ON CONFLICT(tenant, agent_id, session_fingerprint) DO UPDATE SET
       member_id = excluded.member_id,
       runtime_kind = excluded.runtime_kind,
       capability_hash = excluded.capability_hash,
       purpose = excluded.purpose,
       workspace = excluded.workspace,
       wake_adapter = excluded.wake_adapter,
       allowed_senders = excluded.allowed_senders,
       lease_expires_at = excluded.lease_expires_at,
       last_seen_at = excluded.last_seen_at
     WHERE runtime_endpoints.status = 'active'
       AND runtime_endpoints.node_id = excluded.node_id
       AND runtime_endpoints.local_source_id = excluded.local_source_id
       AND runtime_endpoints.project_id = excluded.project_id
     RETURNING ${ENDPOINT_COLUMNS}`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      input.agentId,
      input.memberId,
      input.runtimeKind,
      fingerprint,
      capabilityHash,
      input.nodeId,
      input.localSourceId,
      input.projectId,
      input.purpose.trim(),
      input.workspace.trim(),
      input.wakeAdapter,
      JSON.stringify(input.allowedSenders),
      leaseExpiresAt,
      nowIso,
    )
    .first<RuntimeEndpointRow>()

  if (!row) {
    const existing = await env.DB.prepare(
      `SELECT status, node_id, local_source_id, project_id FROM runtime_endpoints
        WHERE tenant = ?1 AND agent_id = ?2 AND session_fingerprint = ?3 LIMIT 1`,
    )
      .bind(env.TENANT_SLUG, input.agentId, fingerprint)
      .first<{ status: string; node_id: string; local_source_id: string; project_id: string }>()
    if (existing?.status === 'revoked') return { ok: false, error: 'endpoint_revoked' }
    if (
      existing &&
      (existing.node_id !== input.nodeId ||
        existing.local_source_id !== input.localSourceId ||
        existing.project_id !== input.projectId)
    ) {
      return { ok: false, error: 'endpoint_binding_conflict' }
    }
    return { ok: false, error: 'check_in_failed' }
  }
  const endpoint = publicEndpoint(row, now)
  return endpoint
    ? { ok: true, value: { endpoint, endpointCapability } }
    : { ok: false, error: 'check_in_failed' }
}

export async function getRuntimeEndpoint(
  env: Env,
  endpointId: string,
  now: Date = new Date(),
): Promise<RuntimeEndpoint | null> {
  if (!env.TENANT_SLUG || !REF_RE.test(endpointId)) return null
  const row = await env.DB.prepare(
    `SELECT ${ENDPOINT_COLUMNS} FROM runtime_endpoints WHERE tenant = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, endpointId)
    .first<RuntimeEndpointRow>()
  return row ? publicEndpoint(row, now) : null
}

export async function getRuntimeEndpointWithCapability(
  env: Env,
  endpointId: string,
  endpointCapability: string,
  now: Date = new Date(),
): Promise<RuntimeEndpoint | null> {
  if (!env.TENANT_SLUG || !REF_RE.test(endpointId) || !/^[A-Za-z0-9_-]{40,128}$/.test(endpointCapability)) {
    return null
  }
  const capabilityHash = await sha256Hex(endpointCapability)
  const row = await env.DB.prepare(
    `SELECT ${ENDPOINT_COLUMNS} FROM runtime_endpoints
      WHERE tenant = ?1 AND id = ?2 AND capability_hash = ?3 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, endpointId, capabilityHash)
    .first<RuntimeEndpointRow>()
  return row ? publicEndpoint(row, now) : null
}

export async function heartbeatRuntimeEndpoint(
  env: Env,
  endpointId: string,
  agentId: string,
  endpointCapability: string,
  leaseSecondsValue?: number,
  now: Date = new Date(),
): Promise<Result<RuntimeEndpoint>> {
  const endpoint = await getRuntimeEndpointWithCapability(env, endpointId, endpointCapability, now)
  if (!endpoint || endpoint.agent_id !== agentId) return { ok: false, error: 'endpoint_not_found' }
  if (endpoint.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  const leaseSeconds = clampLease(leaseSecondsValue)
  if (leaseSeconds === null) return { ok: false, error: 'invalid_lease_seconds' }
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
  const capabilityHash = await sha256Hex(endpointCapability)
  const updated = await env.DB.prepare(
    `UPDATE runtime_endpoints SET last_seen_at = ?1, lease_expires_at = ?2
      WHERE tenant = ?3 AND id = ?4 AND agent_id = ?5 AND capability_hash = ?6
        AND status = 'active' AND lease_expires_at > ?1`,
  )
    .bind(nowIso, leaseExpiresAt, env.TENANT_SLUG, endpointId, agentId, capabilityHash)
    .run()
  if ((updated.meta?.changes ?? 0) === 0) return { ok: false, error: 'endpoint_unavailable' }
  return {
    ok: true,
    value: { ...endpoint, last_seen_at: nowIso, lease_expires_at: leaseExpiresAt },
  }
}

export async function revokeRuntimeEndpoint(
  env: Env,
  endpointId: string,
  agentId: string,
  endpointCapability: string,
  now: Date = new Date(),
): Promise<Result<RuntimeEndpoint>> {
  if (!env.TENANT_SLUG || !REF_RE.test(endpointId) || !REF_RE.test(agentId) ||
      !/^[A-Za-z0-9_-]{40,128}$/.test(endpointCapability)) {
    return { ok: false, error: 'endpoint_not_found' }
  }
  const authorized = await getRuntimeEndpointWithCapability(
    env,
    endpointId,
    endpointCapability,
    now,
  )
  if (!authorized || authorized.agent_id !== agentId) {
    return { ok: false, error: 'endpoint_not_found' }
  }
  if (authorized.status === 'revoked') return { ok: true, value: authorized }
  const revokedAt = now.toISOString()
  const capabilityHash = await sha256Hex(endpointCapability)
  const row = await env.DB.prepare(
    `UPDATE runtime_endpoints SET status = 'revoked', revoked_at = ?1
      WHERE tenant = ?2 AND id = ?3 AND agent_id = ?4 AND capability_hash = ?5
        AND status = 'active'
      RETURNING ${ENDPOINT_COLUMNS}`,
  )
    .bind(revokedAt, env.TENANT_SLUG, endpointId, agentId, capabilityHash)
    .first<RuntimeEndpointRow>()
  if (row) {
    const endpoint = publicEndpoint(row, now)
    return endpoint
      ? { ok: true, value: endpoint }
      : { ok: false, error: 'endpoint_unavailable' }
  }
  const current = await getRuntimeEndpointWithCapability(
    env,
    endpointId,
    endpointCapability,
    now,
  )
  if (current?.agent_id === agentId && current.status === 'revoked') {
    return { ok: true, value: current }
  }
  return { ok: false, error: 'endpoint_unavailable' }
}

export async function listRuntimeEndpoints(
  env: Env,
  filter: { agentId?: string; projectId?: string },
  now: Date = new Date(),
): Promise<RuntimeEndpoint[]> {
  let sql = `SELECT ${ENDPOINT_COLUMNS} FROM runtime_endpoints WHERE tenant = ?1`
  const binds: unknown[] = [env.TENANT_SLUG]
  if (filter.agentId) {
    binds.push(filter.agentId)
    sql += ` AND agent_id = ?${binds.length}`
  }
  if (filter.projectId) {
    binds.push(filter.projectId)
    sql += ` AND project_id = ?${binds.length}`
  }
  sql += ' ORDER BY last_seen_at DESC, id ASC'
  const rows = await env.DB.prepare(sql).bind(...binds).all<RuntimeEndpointRow>()
  return (rows.results ?? []).map((row) => publicEndpoint(row, now)).filter((row): row is RuntimeEndpoint => row !== null)
}

interface SendEndpointMessageInput {
  endpoint: RuntimeEndpoint
  fromAgent: string
  fromMember: string
  projectId: string
  body: string
  kind?: EndpointMessageKind
  requestId?: string
  inReplyTo?: string
}

interface ExistingMessage {
  id: string
  seq: number
  endpoint_id: string
  project_id: string
  kind: string
  body: string
  in_reply_to: string | null
}

function sameMessage(existing: ExistingMessage, input: SendEndpointMessageInput, kind: EndpointMessageKind): boolean {
  return existing.endpoint_id === input.endpoint.id &&
    existing.project_id === input.projectId &&
    existing.kind === kind &&
    existing.body === input.body &&
    (existing.in_reply_to ?? null) === (input.inReplyTo ?? null)
}

async function existingRequest(
  env: Env,
  projectId: string,
  fromAgent: string,
  requestId: string,
): Promise<ExistingMessage | null> {
  return await env.DB.prepare(
    `SELECT id, seq, endpoint_id, project_id, kind, body, in_reply_to
       FROM runtime_endpoint_messages
      WHERE tenant = ?1 AND project_id = ?2 AND from_agent = ?3 AND request_id = ?4 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, projectId, fromAgent, requestId)
    .first<ExistingMessage>()
}

export async function sendRuntimeEndpointMessage(
  env: Env,
  input: SendEndpointMessageInput,
  now: Date = new Date(),
): Promise<Result<{ id: string; seq: number; endpoint_id: string; duplicate: boolean }>> {
  if (input.endpoint.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  if (input.endpoint.project_id !== input.projectId) return { ok: false, error: 'endpoint_project_mismatch' }
  if (!input.endpoint.allowed_senders.includes(input.fromAgent)) return { ok: false, error: 'sender_not_allowed' }
  if (!REF_RE.test(input.fromAgent) || !REF_RE.test(input.fromMember)) return { ok: false, error: 'invalid_identity' }
  if (!input.body || input.body.length > 8000) return { ok: false, error: 'invalid_body' }
  const kind = input.kind ?? 'message'
  if (!MESSAGE_KINDS.has(kind)) return { ok: false, error: 'invalid_kind' }
  if (input.requestId !== undefined && !REF_RE.test(input.requestId)) return { ok: false, error: 'invalid_request_id' }
  if (input.inReplyTo !== undefined && !REF_RE.test(input.inReplyTo)) return { ok: false, error: 'invalid_in_reply_to' }

  if (input.requestId) {
    const existing = await existingRequest(env, input.projectId, input.fromAgent, input.requestId)
    if (existing) {
      return sameMessage(existing, input, kind)
        ? { ok: true, value: { id: existing.id, seq: Number(existing.seq), endpoint_id: input.endpoint.id, duplicate: true } }
        : { ok: false, error: 'request_id_conflict' }
    }
  }

  const id = crypto.randomUUID()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO runtime_endpoint_messages
        (id, tenant, endpoint_id, to_agent, from_agent, from_member, project_id,
         kind, body, request_id, in_reply_to, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        WHERE EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?2 AND e.id = ?3 AND e.agent_id = ?4
             AND e.project_id = ?7 AND e.status = 'active'
             AND e.lease_expires_at > ?12
             AND EXISTS (
               SELECT 1 FROM json_each(e.allowed_senders)
                WHERE value = ?5
             )
        )
          AND (SELECT COUNT(*) FROM runtime_endpoint_messages
                WHERE tenant = ?2 AND endpoint_id = ?3
                  AND accepted_at IS NULL AND rejected_at IS NULL) < ?13`,
    )
      .bind(
        id,
        env.TENANT_SLUG,
        input.endpoint.id,
        input.endpoint.agent_id,
        input.fromAgent,
        input.fromMember,
        input.projectId,
        kind,
        input.body,
        input.requestId ?? null,
        input.inReplyTo ?? null,
        now.toISOString(),
        MAX_RUNTIME_ENDPOINT_UNREAD,
      )
      .run()
    if ((result.meta?.changes ?? 0) === 0) {
      const current = await getRuntimeEndpoint(env, input.endpoint.id, now)
      if (!current || current.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
      if (!current.allowed_senders.includes(input.fromAgent)) return { ok: false, error: 'sender_not_allowed' }
      return { ok: false, error: 'endpoint_inbox_full' }
    }
    return {
      ok: true,
      value: {
        id,
        seq: Number(result.meta?.last_row_id ?? 0),
        endpoint_id: input.endpoint.id,
        duplicate: false,
      },
    }
  } catch {
    if (input.requestId) {
      const existing = await existingRequest(env, input.projectId, input.fromAgent, input.requestId)
      if (existing) {
        return sameMessage(existing, input, kind)
          ? { ok: true, value: { id: existing.id, seq: Number(existing.seq), endpoint_id: input.endpoint.id, duplicate: true } }
          : { ok: false, error: 'request_id_conflict' }
      }
    }
    return { ok: false, error: 'db_error' }
  }
}

export async function readRuntimeEndpointInbox(
  env: Env,
  endpoint: RuntimeEndpoint,
  endpointCapability: string,
  limitValue?: number,
  now: Date = new Date(),
): Promise<Result<{ messages: RuntimeEndpointMessage[]; remaining: number }>> {
  if (endpoint.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  const capabilityHash = await sha256Hex(endpointCapability)
  const nowIso = now.toISOString()
  const limit = limitValue === undefined ? 20 : Math.min(100, Math.max(1, Math.floor(limitValue)))
  if (!Number.isFinite(limit)) return { ok: false, error: 'invalid_limit' }
  const rows = await env.DB.prepare(
    `SELECT seq, id, endpoint_id, from_agent, from_member, kind, body,
            request_id, in_reply_to, project_id, created_at
       FROM runtime_endpoint_messages
      WHERE tenant = ?1 AND endpoint_id = ?2
        AND accepted_at IS NULL AND rejected_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?1 AND e.id = ?2 AND e.capability_hash = ?3
             AND e.status = 'active' AND e.lease_expires_at > ?4
        )
      ORDER BY seq ASC LIMIT ?5`,
  )
    .bind(env.TENANT_SLUG, endpoint.id, capabilityHash, nowIso, limit)
    .all<RuntimeEndpointMessage>()
  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM runtime_endpoint_messages
      WHERE tenant = ?1 AND endpoint_id = ?2
        AND accepted_at IS NULL AND rejected_at IS NULL`,
  )
    .bind(env.TENANT_SLUG, endpoint.id)
    .first<{ n: number }>()
  const current = await getRuntimeEndpointWithCapability(env, endpoint.id, endpointCapability, now)
  if (!current || current.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  const messages = (rows.results ?? []).map((message) => ({ ...message, seq: Number(message.seq) }))
  return { ok: true, value: { messages, remaining: Number(remainingRow?.n ?? 0) } }
}

export async function acceptRuntimeEndpointMessage(
  env: Env,
  endpoint: RuntimeEndpoint,
  endpointCapability: string,
  messageId: string,
  runtimeTurnId: string,
  now: Date = new Date(),
): Promise<Result<{
  endpoint_id: string
  message_id: string
  request_id: string | null
  runtime_turn_id: string
  accepted_at: string
  duplicate: boolean
}>> {
  if (endpoint.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  if (!REF_RE.test(messageId)) return { ok: false, error: 'invalid_message_id' }
  if (!REF_RE.test(runtimeTurnId)) return { ok: false, error: 'invalid_runtime_turn_id' }
  const capabilityHash = await sha256Hex(endpointCapability)
  const row = await env.DB.prepare(
    `SELECT id, request_id, accepted_at, runtime_turn_id, rejected_at
       FROM runtime_endpoint_messages
      WHERE tenant = ?1 AND endpoint_id = ?2 AND id = ?3
        AND EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?1 AND e.id = ?2 AND e.capability_hash = ?4
        )
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, endpoint.id, messageId, capabilityHash)
    .first<{
      id: string
      request_id: string | null
      accepted_at: string | null
      runtime_turn_id: string | null
      rejected_at: string | null
    }>()
  if (!row) return { ok: false, error: 'message_not_found' }
  if (row.rejected_at) return { ok: false, error: 'message_already_rejected' }
  if (row.accepted_at) {
    if (row.runtime_turn_id !== runtimeTurnId) return { ok: false, error: 'message_already_accepted' }
    return {
      ok: true,
      value: {
        endpoint_id: endpoint.id,
        message_id: row.id,
        request_id: row.request_id,
        runtime_turn_id: runtimeTurnId,
        accepted_at: row.accepted_at,
        duplicate: true,
      },
    }
  }
  const acceptedAt = now.toISOString()
  const update = await env.DB.prepare(
    `UPDATE runtime_endpoint_messages SET accepted_at = ?1, runtime_turn_id = ?2
      WHERE tenant = ?3 AND endpoint_id = ?4 AND id = ?5
        AND accepted_at IS NULL AND rejected_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?3 AND e.id = ?4 AND e.status = 'active'
             AND e.capability_hash = ?6 AND e.lease_expires_at > ?1
        )`,
  )
    .bind(acceptedAt, runtimeTurnId, env.TENANT_SLUG, endpoint.id, messageId, capabilityHash)
    .run()
  if ((update.meta?.changes ?? 0) === 0) {
    const current = await getRuntimeEndpointWithCapability(env, endpoint.id, endpointCapability, now)
    if (!current || current.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
    const raced = await env.DB.prepare(
      `SELECT request_id, accepted_at, runtime_turn_id, rejected_at
         FROM runtime_endpoint_messages
        WHERE tenant = ?1 AND endpoint_id = ?2 AND id = ?3 LIMIT 1`,
    )
      .bind(env.TENANT_SLUG, endpoint.id, messageId)
      .first<{
        request_id: string | null
        accepted_at: string | null
        runtime_turn_id: string | null
        rejected_at: string | null
      }>()
    if (raced?.rejected_at) return { ok: false, error: 'message_already_rejected' }
    if (!raced?.accepted_at) return { ok: false, error: 'db_error' }
    if (raced.runtime_turn_id !== runtimeTurnId) return { ok: false, error: 'message_already_accepted' }
    return {
      ok: true,
      value: {
        endpoint_id: endpoint.id,
        message_id: messageId,
        request_id: raced.request_id,
        runtime_turn_id: runtimeTurnId,
        accepted_at: raced.accepted_at,
        duplicate: true,
      },
    }
  }
  return {
    ok: true,
    value: {
      endpoint_id: endpoint.id,
      message_id: row.id,
      request_id: row.request_id,
      runtime_turn_id: runtimeTurnId,
      accepted_at: acceptedAt,
      duplicate: false,
    },
  }
}

export async function rejectRuntimeEndpointMessage(
  env: Env,
  endpoint: RuntimeEndpoint,
  endpointCapability: string,
  messageId: string,
  reason: string,
  rejectedByAgent: string,
  now: Date = new Date(),
): Promise<Result<{
  endpoint_id: string
  message_id: string
  request_id: string | null
  reason: string
  rejected_by_agent: string
  rejected_at: string
  duplicate: boolean
}>> {
  if (endpoint.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
  if (!REF_RE.test(messageId)) return { ok: false, error: 'invalid_message_id' }
  if (reason !== 'sender_policy_changed') return { ok: false, error: 'invalid_rejection_reason' }
  const capabilityHash = await sha256Hex(endpointCapability)
  const row = await env.DB.prepare(
    `SELECT id, request_id, from_agent, accepted_at, rejected_at,
            rejection_reason, rejected_by_agent
       FROM runtime_endpoint_messages
      WHERE tenant = ?1 AND endpoint_id = ?2 AND id = ?3
        AND EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?1 AND e.id = ?2 AND e.capability_hash = ?4
        )
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, endpoint.id, messageId, capabilityHash)
    .first<{
      id: string
      request_id: string | null
      from_agent: string
      accepted_at: string | null
      rejected_at: string | null
      rejection_reason: string | null
      rejected_by_agent: string | null
    }>()
  if (!row) return { ok: false, error: 'message_not_found' }
  if (row.accepted_at) return { ok: false, error: 'message_already_accepted' }
  if (row.rejected_at) {
    if (row.rejection_reason !== reason || row.rejected_by_agent !== rejectedByAgent) {
      return { ok: false, error: 'message_already_rejected' }
    }
    return {
      ok: true,
      value: {
        endpoint_id: endpoint.id,
        message_id: row.id,
        request_id: row.request_id,
        reason,
        rejected_by_agent: rejectedByAgent,
        rejected_at: row.rejected_at,
        duplicate: true,
      },
    }
  }
  if (endpoint.allowed_senders.includes(row.from_agent)) {
    return { ok: false, error: 'message_still_authorized' }
  }
  const rejectedAt = now.toISOString()
  const update = await env.DB.prepare(
    `UPDATE runtime_endpoint_messages
        SET rejected_at = ?1, rejection_reason = ?2, rejected_by_agent = ?3
      WHERE tenant = ?4 AND endpoint_id = ?5 AND id = ?6
        AND accepted_at IS NULL AND rejected_at IS NULL
        AND EXISTS (
          SELECT 1 FROM runtime_endpoints e
           WHERE e.tenant = ?4 AND e.id = ?5 AND e.status = 'active'
             AND e.capability_hash = ?7 AND e.lease_expires_at > ?1
             AND NOT EXISTS (
               SELECT 1 FROM json_each(e.allowed_senders)
                WHERE json_each.value = runtime_endpoint_messages.from_agent
             )
        )`,
  )
    .bind(
      rejectedAt,
      reason,
      rejectedByAgent,
      env.TENANT_SLUG,
      endpoint.id,
      messageId,
      capabilityHash,
    )
    .run()
  if ((update.meta?.changes ?? 0) === 0) {
    const current = await getRuntimeEndpointWithCapability(env, endpoint.id, endpointCapability, now)
    if (!current || current.status !== 'active') return { ok: false, error: 'endpoint_unavailable' }
    const raced = await env.DB.prepare(
      `SELECT from_agent, request_id, accepted_at, rejected_at,
              rejection_reason, rejected_by_agent
         FROM runtime_endpoint_messages
        WHERE tenant = ?1 AND endpoint_id = ?2 AND id = ?3 LIMIT 1`,
    )
      .bind(env.TENANT_SLUG, endpoint.id, messageId)
      .first<{
        from_agent: string
        request_id: string | null
        accepted_at: string | null
        rejected_at: string | null
        rejection_reason: string | null
        rejected_by_agent: string | null
      }>()
    if (raced?.accepted_at) return { ok: false, error: 'message_already_accepted' }
    if (!raced?.rejected_at) {
      if (raced && current.allowed_senders.includes(raced.from_agent)) {
        return { ok: false, error: 'message_still_authorized' }
      }
      return { ok: false, error: 'db_error' }
    }
    if (raced.rejection_reason !== reason || raced.rejected_by_agent !== rejectedByAgent) {
      return { ok: false, error: 'message_already_rejected' }
    }
    return {
      ok: true,
      value: {
        endpoint_id: endpoint.id,
        message_id: messageId,
        request_id: raced.request_id,
        reason,
        rejected_by_agent: rejectedByAgent,
        rejected_at: raced.rejected_at,
        duplicate: true,
      },
    }
  }
  return {
    ok: true,
    value: {
      endpoint_id: endpoint.id,
      message_id: row.id,
      request_id: row.request_id,
      reason,
      rejected_by_agent: rejectedByAgent,
      rejected_at: rejectedAt,
      duplicate: false,
    },
  }
}
