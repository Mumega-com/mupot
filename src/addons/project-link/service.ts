import type { Env } from '../../types'
import {
  canonicalProjectLinkEnvelope,
  canonicalProjectLinkArtifact,
  importProjectLinkPublicKey,
  sha256Hex,
  validateProjectLinkEnvelope,
  verifySignedProjectEnvelope,
  type ProjectLinkEnvelopeV1,
  type ProjectLinkCapability,
  type SignedProjectLinkEnvelopeV1,
} from './envelope'

export interface ProjectLinkActor { id: string; role: 'owner' | 'admin' | 'member' }

export interface ProjectLink {
  id: string
  tenant: string
  local_project_id: string
  local_squad_id: string
  local_agent_id: string
  local_key_id: string
  remote_pot: string
  remote_project_id: string
  remote_link_id: string
  remote_agent_id: string
  remote_key_id: string
  remote_public_key: string
  remote_base_url: string
  capabilities: ProjectLinkCapability[]
  approved_evidence_origins: string[]
  state: 'active' | 'revoked'
  stale_after_seconds: number
  last_success_at: string | null
  last_failure_at: string | null
  last_error: string | null
  created_by: string
  created_at: string
  revoked_by: string | null
  revoked_at: string | null
}

export type CreateProjectLinkInput = Pick<ProjectLink,
  'id' | 'local_project_id' | 'local_squad_id' | 'local_agent_id' | 'local_key_id'
  | 'remote_pot' | 'remote_project_id' | 'remote_link_id' | 'remote_agent_id'
  | 'remote_key_id' | 'remote_public_key' | 'remote_base_url' | 'capabilities' | 'stale_after_seconds'
  | 'approved_evidence_origins'
>

export interface ProjectLinkReceipt {
  id: string
  tenant: string
  link_id: string
  local_project_id: string
  direction: 'inbound' | 'outbound'
  idempotency_key: string
  correlation_id: string
  envelope_sha256: string
  shared_receipt_sha256: string
  remote_pot: string
  remote_project_id: string
  source_agent_id: string
  action_type: 'task' | 'evidence'
  action_id: string
  evidence_sha256: string | null
  receipt_key_id: string
  receipt_signature: string
  status: 'accepted'
  created_at: string
}

type LinkFailure =
  | 'not_authorized' | 'addon_inactive' | 'invalid_link' | 'link_not_found' | 'link_revoked'
  | 'invalid_envelope' | 'invalid_signature' | 'mapping_mismatch' | 'expired'
  | 'idempotency_conflict' | 'remote_failure' | 'receipt_mismatch' | 'capability_denied'
  | 'receipt_signing_unconfigured' | 'delivery_review_required'

const MAX_REMOTE_RESPONSE_BYTES = 32 * 1024
const MAX_DELIVERY_ATTEMPTS = 100
const CAPABILITIES: readonly ProjectLinkCapability[] = ['project.task.write', 'project.evidence.write']

type ProjectLinkDb = Pick<Env['DB'], 'prepare' | 'batch'>

function primaryDb(env: Env): ProjectLinkDb {
  return typeof env.DB.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB
}

function admin(actor: ProjectLinkActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

async function projectLinkAddonActive(env: Env, db: ProjectLinkDb = env.DB): Promise<boolean> {
  const row = await db.prepare(
    `SELECT state FROM addon_installations
      WHERE tenant = ?1 AND addon_key = 'project-link'
      ORDER BY installed_at DESC, id DESC LIMIT 1`,
  ).bind(env.TENANT_SLUG).first<{ state: string }>()
  return row?.state === 'active'
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_])?$/.test(value)
    && !/(?:Bearer|mupot_|api[_-]?key|access[_-]?token|private[_-]?key|password|secret)/i.test(value)
}

function validHttpsBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

interface ProjectLinkRow extends Omit<ProjectLink, 'capabilities' | 'approved_evidence_origins'> {
  capabilities_json: string
  evidence_origins_json: string
}

function normalizeCapabilities(value: unknown): ProjectLinkCapability[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > CAPABILITIES.length) return null
  if (value.some((capability) => !CAPABILITIES.includes(capability as ProjectLinkCapability))) return null
  if (new Set(value).size !== value.length) return null
  return CAPABILITIES.filter((capability) => value.includes(capability))
}

async function loadLink(env: Env, id: string, db: ProjectLinkDb = env.DB): Promise<ProjectLink | null> {
  const row = await db.prepare(
    `SELECT id, tenant, local_project_id, local_squad_id, local_agent_id, local_key_id,
            remote_pot, remote_project_id, remote_link_id, remote_agent_id, remote_key_id,
            remote_public_key, remote_base_url, capabilities_json, evidence_origins_json, state, stale_after_seconds,
            last_success_at, last_failure_at, last_error, created_by, created_at,
            revoked_by, revoked_at
       FROM project_links WHERE tenant = ?1 AND id = ?2`,
  ).bind(env.TENANT_SLUG, id).first<ProjectLinkRow>()
  if (!row) return null
  let parsed: unknown
  let origins: unknown
  try {
    parsed = JSON.parse(row.capabilities_json)
    origins = JSON.parse(row.evidence_origins_json)
  } catch { return null }
  const capabilities = normalizeCapabilities(parsed)
  const approvedEvidenceOrigins = normalizeEvidenceOrigins(origins)
  if (!capabilities || !approvedEvidenceOrigins) return null
  const { capabilities_json: _capabilitiesJson, evidence_origins_json: _evidenceOriginsJson, ...link } = row
  return { ...link, capabilities, approved_evidence_origins: approvedEvidenceOrigins }
}

function normalizeEvidenceOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) return null
  const origins: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') return null
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' || url.username || url.password || url.origin !== candidate || url.pathname !== '/' || url.search || url.hash) return null
      origins.push(url.origin)
    } catch { return null }
  }
  return origins.sort()
}

async function destinationAuthorized(env: Env, link: ProjectLink, db: ProjectLinkDb = env.DB): Promise<boolean> {
  const row = await db.prepare(
    `SELECT p.status, a.access_level
       FROM projects p
       LEFT JOIN project_squad_access a
         ON a.project_id = p.id AND a.squad_id = ?2
      WHERE p.id = ?1`,
  ).bind(link.local_project_id, link.local_squad_id).first<{
    status: string; access_level: string | null
  }>()
  return Boolean(row && row.status !== 'archived' && (row.access_level === 'write' || row.access_level === 'admin'))
}

export async function createProjectLink(
  env: Env,
  input: CreateProjectLinkInput,
  actor: ProjectLinkActor,
  now = new Date().toISOString(),
): Promise<{ ok: true; link: ProjectLink } | { ok: false; reason: LinkFailure }> {
  if (!admin(actor)) return { ok: false, reason: 'not_authorized' }
  if (!(await projectLinkAddonActive(env))) return { ok: false, reason: 'addon_inactive' }
  const ids = [input.id, input.local_project_id, input.local_squad_id, input.local_agent_id, input.local_key_id,
    input.remote_pot, input.remote_project_id, input.remote_link_id, input.remote_agent_id, input.remote_key_id]
  if (ids.some((value) => !validIdentifier(value)) || input.remote_pot === env.TENANT_SLUG) {
    return { ok: false, reason: 'invalid_link' }
  }
  if (!validHttpsBaseUrl(input.remote_base_url) || !Number.isInteger(input.stale_after_seconds)
    || input.stale_after_seconds < 30 || input.stale_after_seconds > 86400) {
    return { ok: false, reason: 'invalid_link' }
  }
  const capabilities = normalizeCapabilities(input.capabilities)
  if (!capabilities) return { ok: false, reason: 'invalid_link' }
  const approvedEvidenceOrigins = normalizeEvidenceOrigins(input.approved_evidence_origins)
  if (!approvedEvidenceOrigins || (capabilities.includes('project.evidence.write') && approvedEvidenceOrigins.length === 0)) {
    return { ok: false, reason: 'invalid_link' }
  }
  try {
    await importProjectLinkPublicKey(input.remote_public_key)
  } catch {
    return { ok: false, reason: 'invalid_link' }
  }

  const candidate: ProjectLink = {
    ...input,
    remote_base_url: new URL(input.remote_base_url).toString(),
    capabilities,
    approved_evidence_origins: approvedEvidenceOrigins,
    tenant: env.TENANT_SLUG,
    state: 'active',
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    created_by: actor.id,
    created_at: now,
    revoked_by: null,
    revoked_at: null,
  }
  if (!(await destinationAuthorized(env, candidate))) return { ok: false, reason: 'not_authorized' }
  try {
    await env.DB.prepare(
      `INSERT INTO project_links (
        id, tenant, local_project_id, local_squad_id, local_agent_id, local_key_id,
        remote_pot, remote_project_id, remote_link_id, remote_agent_id, remote_key_id,
        remote_public_key, remote_base_url, capabilities_json, evidence_origins_json,
        state, stale_after_seconds, created_by, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'active', ?16, ?17, ?18)`,
    ).bind(
      candidate.id, candidate.tenant, candidate.local_project_id, candidate.local_squad_id,
      candidate.local_agent_id, candidate.local_key_id, candidate.remote_pot,
      candidate.remote_project_id, candidate.remote_link_id, candidate.remote_agent_id,
      candidate.remote_key_id, candidate.remote_public_key, candidate.remote_base_url,
      JSON.stringify(candidate.capabilities), JSON.stringify(candidate.approved_evidence_origins),
      candidate.stale_after_seconds, candidate.created_by, candidate.created_at,
    ).run()
  } catch {
    return { ok: false, reason: 'invalid_link' }
  }
  return { ok: true, link: candidate }
}

export async function revokeProjectLink(
  env: Env,
  id: string,
  actor: ProjectLinkActor,
  now = new Date().toISOString(),
): Promise<{ ok: true; link: ProjectLink } | { ok: false; reason: LinkFailure }> {
  if (!admin(actor)) return { ok: false, reason: 'not_authorized' }
  const link = await loadLink(env, id)
  if (!link) return { ok: false, reason: 'link_not_found' }
  if (link.state === 'active') {
    await env.DB.prepare(
      `UPDATE project_links SET state = 'revoked', revoked_by = ?3, revoked_at = ?4
        WHERE tenant = ?1 AND id = ?2 AND state = 'active'`,
    ).bind(env.TENANT_SLUG, id, actor.id, now).run()
  }
  const revoked = await loadLink(env, id)
  return revoked ? { ok: true, link: revoked } : { ok: false, reason: 'link_not_found' }
}

interface ProjectLinkReceiptPayloadV1 {
  schema: 'mupot.project-link-receipt/v1'
  status: 'accepted'
  receipt_key_id: string
  envelope_sha256: string
  idempotency_key: string
  correlation_id: string
  source: { pot: string; project_id: string; agent_id: string; key_id: string }
  destination: { pot: string; project_id: string }
  action: { type: 'task' | 'evidence'; id: string; evidence_sha256: string | null }
}

function canonicalReceipt(payload: ProjectLinkReceiptPayloadV1): string {
  return canonicalProjectLinkArtifact('mupot.project-link-receipt/v1/signature', payload)
}

function receiptPayload(input: {
  envelopeSha256: string
  envelope: ProjectLinkEnvelopeV1
  actionType: 'task' | 'evidence'
  actionId: string
  receiptKeyId: string
}): ProjectLinkReceiptPayloadV1 {
  return {
    schema: 'mupot.project-link-receipt/v1',
    status: 'accepted',
    receipt_key_id: input.receiptKeyId,
    envelope_sha256: input.envelopeSha256,
    idempotency_key: input.envelope.idempotency_key,
    correlation_id: input.envelope.correlation_id,
    source: { ...input.envelope.source },
    destination: { ...input.envelope.destination },
    action: {
      type: input.actionType,
      id: input.actionId,
      evidence_sha256: input.envelope.evidence?.sha256 ?? null,
    },
  }
}

function toB64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromB64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

async function signReceipt(env: Env, payload: ProjectLinkReceiptPayloadV1): Promise<string | null> {
  if (!env.PROJECT_LINK_SIGNING_KEY) return null
  try {
    const jwk = JSON.parse(env.PROJECT_LINK_SIGNING_KEY) as JsonWebKey
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
    return toB64url(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(canonicalReceipt(payload))))
  } catch {
    return null
  }
}

async function verifyReceiptSignature(
  payload: ProjectLinkReceiptPayloadV1,
  signature: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  const bytes = fromB64url(signature)
  return Boolean(bytes && await crypto.subtle.verify(
    { name: 'Ed25519' }, publicKey, bytes,
    new TextEncoder().encode(canonicalReceipt(payload)),
  ))
}

function expectedAction(envelope: ProjectLinkEnvelopeV1, envelopeSha256: string): {
  type: 'task' | 'evidence'; id: string
} {
  const type = envelope.requested_capability === 'project.task.write' ? 'task' : 'evidence'
  return { type, id: `${type === 'task' ? 'plt' : 'ple'}-${envelopeSha256.slice(0, 32)}` }
}

async function receiptFor(
  env: Env,
  linkId: string,
  direction: 'inbound' | 'outbound',
  idempotencyKey: string,
  db: ProjectLinkDb = env.DB,
) {
  return db.prepare(
    `SELECT id, tenant, link_id, local_project_id, direction, idempotency_key,
            correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
            remote_project_id, source_agent_id, action_type, action_id,
            evidence_sha256, receipt_key_id, receipt_signature, status, created_at
       FROM project_link_receipts
      WHERE tenant = ?1 AND link_id = ?2 AND direction = ?3 AND idempotency_key = ?4`,
  ).bind(env.TENANT_SLUG, linkId, direction, idempotencyKey).first<ProjectLinkReceipt>()
}

function mappingMatches(link: ProjectLink, envelope: ProjectLinkEnvelopeV1): boolean {
  return envelope.source.pot === link.remote_pot
    && envelope.source.project_id === link.remote_project_id
    && envelope.source.agent_id === link.remote_agent_id
    && envelope.source.key_id === link.remote_key_id
    && envelope.destination.pot === link.tenant
    && envelope.destination.project_id === link.local_project_id
}

function outboundMappingMatches(link: ProjectLink, envelope: ProjectLinkEnvelopeV1): boolean {
  return envelope.source.pot === link.tenant
    && envelope.source.project_id === link.local_project_id
    && envelope.source.agent_id === link.local_agent_id
    && envelope.source.key_id === link.local_key_id
    && envelope.destination.pot === link.remote_pot
    && envelope.destination.project_id === link.remote_project_id
}

function linkAllows(link: ProjectLink, capability: ProjectLinkCapability): boolean {
  return link.capabilities.includes(capability)
}

function taskBody(envelope: ProjectLinkEnvelopeV1): string {
  const task = envelope.task!
  return JSON.stringify({
    schema: 'mupot.project-link-task/v1',
    source_pot: envelope.source.pot,
    source_project_id: envelope.source.project_id,
    source_task_id: task.source_task_id,
    remote_state: task.state,
    priority: task.priority,
    progress_summary: task.progress_summary,
    blocker_summary: task.blocker_summary,
    correlation_id: envelope.correlation_id,
  })
}

export async function receiveProjectLinkEnvelope(
  env: Env,
  linkId: string,
  signed: unknown,
  now = new Date().toISOString(),
): Promise<{ ok: true; receipt: ProjectLinkReceipt; idempotent?: true } | { ok: false; reason: LinkFailure | string; path?: string }> {
  const db = primaryDb(env)
  if (!(await projectLinkAddonActive(env, db))) return { ok: false, reason: 'addon_inactive' }
  const link = await loadLink(env, linkId, db)
  if (!link) return { ok: false, reason: 'link_not_found' }
  if (link.state !== 'active') return { ok: false, reason: 'link_revoked' }

  let publicKey: CryptoKey
  try {
    publicKey = await importProjectLinkPublicKey(link.remote_public_key)
  } catch {
    return { ok: false, reason: 'invalid_link' }
  }
  const verified = await verifySignedProjectEnvelope(signed, publicKey)
  if (!verified.ok) return verified.reason === 'invalid_signature'
    ? { ok: false, reason: 'invalid_signature' }
    : { ok: false, reason: 'invalid_envelope', path: verified.path }
  const scopedValidation = validateProjectLinkEnvelope(verified.envelope, {
    approvedEvidenceOrigins: link.approved_evidence_origins,
  })
  if (!scopedValidation.ok) return { ok: false, reason: 'invalid_envelope', path: scopedValidation.path }
  const envelope = scopedValidation.envelope
  if (!mappingMatches(link, envelope)) return { ok: false, reason: 'mapping_mismatch' }
  if (!linkAllows(link, envelope.requested_capability)) return { ok: false, reason: 'capability_denied' }
  const nowMs = Date.parse(now)
  const expiresMs = Date.parse(envelope.expires_at)
  if (!Number.isFinite(nowMs) || expiresMs <= nowMs || expiresMs - nowMs > 15 * 60_000) {
    return { ok: false, reason: 'expired' }
  }
  const envelopeSha256 = await sha256Hex(canonicalProjectLinkEnvelope(envelope))
  if (!(await destinationAuthorized(env, link, db))) return { ok: false, reason: 'not_authorized' }
  const existing = await receiptFor(env, link.id, 'inbound', envelope.idempotency_key, db)
  if (existing) {
    return existing.envelope_sha256 === envelopeSha256
      ? { ok: true, receipt: existing, idempotent: true }
      : { ok: false, reason: 'idempotency_conflict' }
  }
  const action = expectedAction(envelope, envelopeSha256)
  const payload = receiptPayload({
    envelopeSha256,
    envelope,
    actionType: action.type,
    actionId: action.id,
    receiptKeyId: link.local_key_id,
  })
  const signature = await signReceipt(env, payload)
  if (!signature) return { ok: false, reason: 'receipt_signing_unconfigured' }
  const sharedHash = await sha256Hex(canonicalReceipt(payload))
  const receipt: ProjectLinkReceipt = {
    id: `plr-${sharedHash.slice(0, 32)}`,
    tenant: env.TENANT_SLUG,
    link_id: link.id,
    local_project_id: link.local_project_id,
    direction: 'inbound',
    idempotency_key: envelope.idempotency_key,
    correlation_id: envelope.correlation_id,
    envelope_sha256: envelopeSha256,
    shared_receipt_sha256: sharedHash,
    remote_pot: link.remote_pot,
    remote_project_id: link.remote_project_id,
    source_agent_id: envelope.source.agent_id,
    action_type: action.type,
    action_id: action.id,
    evidence_sha256: envelope.evidence?.sha256 ?? null,
    receipt_key_id: link.local_key_id,
    receipt_signature: signature,
    status: 'accepted',
    created_at: now,
  }
  const statements = []
  if (action.type === 'task') {
    statements.push(db.prepare(
      `INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        github_issue_url, result, completed_at, gate_owner, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', NULL, NULL, NULL, NULL, NULL, ?7, ?7)`,
    ).bind(
      action.id, link.local_squad_id, link.local_project_id,
      `[${envelope.source.pot}] ${envelope.task!.title}`,
      taskBody(envelope), envelope.task!.success_predicate, now,
    ))
  }
  statements.push(db.prepare(
    `INSERT INTO project_link_deliveries (
      id, tenant, link_id, direction, idempotency_key, envelope_sha256,
      status, attempts, created_at, updated_at
    ) VALUES (?1, ?2, ?3, 'inbound', ?4, ?5, 'delivered', 1, ?6, ?6)`,
  ).bind(`pld-in-${envelopeSha256.slice(0, 28)}`, env.TENANT_SLUG, link.id, envelope.idempotency_key, envelopeSha256, now))
  statements.push(db.prepare(
    `INSERT INTO project_link_receipts (
      id, tenant, link_id, local_project_id, direction, idempotency_key,
      correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
      remote_project_id, source_agent_id, action_type, action_id,
      evidence_sha256, receipt_key_id, receipt_signature, status, created_at
    ) VALUES (?1, ?2, ?3, ?4, 'inbound', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'accepted', ?17)`,
  ).bind(
    receipt.id, receipt.tenant, receipt.link_id, receipt.local_project_id,
    receipt.idempotency_key, receipt.correlation_id, receipt.envelope_sha256,
    receipt.shared_receipt_sha256, receipt.remote_pot, receipt.remote_project_id,
    receipt.source_agent_id, receipt.action_type, receipt.action_id,
    receipt.evidence_sha256, receipt.receipt_key_id, receipt.receipt_signature, receipt.created_at,
  ))
  statements.push(db.prepare(
    `UPDATE project_links SET last_success_at = ?3, last_error = NULL
      WHERE tenant = ?1 AND id = ?2 AND state = 'active'`,
  ).bind(env.TENANT_SLUG, link.id, now))

  try {
    await db.batch(statements)
  } catch {
    const raced = await receiptFor(env, link.id, 'inbound', envelope.idempotency_key, db)
    if (raced && raced.envelope_sha256 === envelopeSha256) return { ok: true, receipt: raced, idempotent: true }
    if (!(await projectLinkAddonActive(env, db))) return { ok: false, reason: 'addon_inactive' }
    const current = await loadLink(env, link.id, db)
    if (!current || current.state !== 'active') return { ok: false, reason: 'link_revoked' }
    if (!linkAllows(current, envelope.requested_capability)) return { ok: false, reason: 'capability_denied' }
    if (!(await destinationAuthorized(env, current, db))) return { ok: false, reason: 'not_authorized' }
    return { ok: false, reason: 'idempotency_conflict' }
  }
  return { ok: true, receipt }
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function readBoundedRemoteJson(response: Response, timeoutMs: number): Promise<
  | { ok: true; value: unknown }
  | { ok: false; error: 'remote_response_too_large' | 'invalid_remote_response' }
> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_REMOTE_RESPONSE_BYTES) {
    return { ok: false, error: 'remote_response_too_large' }
  }
  if (!response.body) return { ok: false, error: 'invalid_remote_response' }
  const reader = response.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const body = (async () => {
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_REMOTE_RESPONSE_BYTES) {
          await reader.cancel()
          return { ok: false as const, error: 'remote_response_too_large' as const }
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      return { ok: true, value: JSON.parse(text) } as const
    } catch {
      return { ok: false as const, error: 'invalid_remote_response' as const }
    }
  })()
  const timeout = new Promise<{ ok: false; error: 'invalid_remote_response' }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ ok: false, error: 'invalid_remote_response' })
    }, timeoutMs)
  })
  const result = await Promise.race([body, timeout])
  if (timer) clearTimeout(timer)
  if (timedOut) void reader.cancel().catch(() => undefined)
  return result
}

async function validatedOutboundReceipt(
  env: Env,
  link: ProjectLink,
  envelope: ProjectLinkEnvelopeV1,
  envelopeSha256: string,
  value: unknown,
  now: string,
): Promise<ProjectLinkReceipt | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const remoteReceipt = value as Partial<ProjectLinkReceipt>
  const action = expectedAction(envelope, envelopeSha256)
  const payload = receiptPayload({
    envelopeSha256,
    envelope,
    actionType: action.type,
    actionId: action.id,
    receiptKeyId: link.remote_key_id,
  })
  const expected = await sha256Hex(canonicalReceipt(payload))
  if (remoteReceipt.shared_receipt_sha256 !== expected
    || remoteReceipt.envelope_sha256 !== envelopeSha256
    || remoteReceipt.idempotency_key !== envelope.idempotency_key
    || remoteReceipt.correlation_id !== envelope.correlation_id
    || remoteReceipt.tenant !== link.remote_pot
    || remoteReceipt.local_project_id !== link.remote_project_id
    || remoteReceipt.direction !== 'inbound'
    || remoteReceipt.remote_pot !== link.tenant
    || remoteReceipt.remote_project_id !== link.local_project_id
    || remoteReceipt.source_agent_id !== envelope.source.agent_id
    || remoteReceipt.action_type !== action.type
    || remoteReceipt.action_id !== action.id
    || remoteReceipt.evidence_sha256 !== (envelope.evidence?.sha256 ?? null)
    || remoteReceipt.receipt_key_id !== link.remote_key_id
    || typeof remoteReceipt.receipt_signature !== 'string'
    || remoteReceipt.status !== 'accepted') return null
  let publicKey: CryptoKey
  try { publicKey = await importProjectLinkPublicKey(link.remote_public_key) } catch { return null }
  if (!(await verifyReceiptSignature(payload, remoteReceipt.receipt_signature, publicKey))) return null
  const receipt: ProjectLinkReceipt = {
    ...(remoteReceipt as ProjectLinkReceipt),
    id: `plr-out-${expected.slice(0, 28)}`,
    tenant: env.TENANT_SLUG,
    link_id: link.id,
    local_project_id: link.local_project_id,
    direction: 'outbound',
    remote_pot: link.remote_pot,
    remote_project_id: link.remote_project_id,
    source_agent_id: envelope.source.agent_id,
    created_at: now,
  }
  return receipt
}

interface ProjectLinkDelivery {
  id: string
  envelope_sha256: string
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'review'
  attempts: number
  claim_token: string | null
  claim_expires_at: string | null
}

async function deliveryFor(
  env: Env,
  db: ProjectLinkDb,
  linkId: string,
  idempotencyKey: string,
): Promise<ProjectLinkDelivery | null> {
  return db.prepare(
    `SELECT id, envelope_sha256, status, attempts, claim_token, claim_expires_at
       FROM project_link_deliveries
      WHERE tenant = ?1 AND link_id = ?2 AND direction = 'outbound' AND idempotency_key = ?3`,
  ).bind(env.TENANT_SLUG, linkId, idempotencyKey).first<ProjectLinkDelivery>()
}

export async function deliverProjectLinkEnvelope(
  env: Env,
  linkId: string,
  signed: SignedProjectLinkEnvelopeV1,
  options: { fetcher?: typeof fetch; now?: string; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<{ ok: true; receipt: ProjectLinkReceipt } | { ok: false; reason: LinkFailure }> {
  const db = primaryDb(env)
  if (!(await projectLinkAddonActive(env, db))) return { ok: false, reason: 'addon_inactive' }
  const link = await loadLink(env, linkId, db)
  if (!link) return { ok: false, reason: 'link_not_found' }
  if (link.state !== 'active') return { ok: false, reason: 'link_revoked' }
  const validation = validateProjectLinkEnvelope(signed.envelope, {
    approvedEvidenceOrigins: link.approved_evidence_origins,
  })
  if (!validation.ok) return { ok: false, reason: 'invalid_envelope' }
  const envelope = validation.envelope
  if (!outboundMappingMatches(link, envelope)) return { ok: false, reason: 'mapping_mismatch' }
  if (!linkAllows(link, envelope.requested_capability)) return { ok: false, reason: 'capability_denied' }
  if (!(await destinationAuthorized(env, link, db))) return { ok: false, reason: 'not_authorized' }
  const envelopeSha256 = await sha256Hex(canonicalProjectLinkEnvelope(envelope))
  const prior = await receiptFor(env, link.id, 'outbound', envelope.idempotency_key, db)
  if (prior) return prior.envelope_sha256 === envelopeSha256
    ? { ok: true, receipt: prior }
    : { ok: false, reason: 'idempotency_conflict' }

  const now = options.now ?? new Date().toISOString()
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts ?? 3)))
  const timeoutMs = Math.max(1000, Math.min(30_000, Math.floor(options.timeoutMs ?? 10_000)))
  const fetcher = options.fetcher ?? fetch
  let delivery = await deliveryFor(env, db, link.id, envelope.idempotency_key)
  const proposedDeliveryId = `pld-out-${envelopeSha256.slice(0, 27)}`
  if (!delivery) {
    try {
      await db.prepare(
      `INSERT INTO project_link_deliveries (
        id, tenant, link_id, direction, idempotency_key, envelope_sha256,
        status, attempts, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'outbound', ?4, ?5, 'pending', 0, ?6, ?6)`,
      ).bind(proposedDeliveryId, env.TENANT_SLUG, link.id, envelope.idempotency_key, envelopeSha256, now).run()
      delivery = {
        id: proposedDeliveryId, envelope_sha256: envelopeSha256, status: 'pending', attempts: 0,
        claim_token: null, claim_expires_at: null,
      }
    } catch {
      delivery = await deliveryFor(env, db, link.id, envelope.idempotency_key)
      if (!delivery) return { ok: false, reason: 'idempotency_conflict' }
    }
  }
  if (delivery.envelope_sha256 !== envelopeSha256 || delivery.status === 'delivered') {
    return { ok: false, reason: 'idempotency_conflict' }
  }
  if (delivery.status === 'review') return { ok: false, reason: 'delivery_review_required' }
  const deliveryId = delivery.id
  const attemptsBefore = delivery.attempts
  if (attemptsBefore >= MAX_DELIVERY_ATTEMPTS) {
    await db.prepare(
      `UPDATE project_link_deliveries
          SET status = 'review', last_error = 'retry_limit_exhausted', next_retry_at = NULL, updated_at = ?3
        WHERE tenant = ?1 AND id = ?2 AND status IN ('pending','failed')`,
    ).bind(env.TENANT_SLUG, deliveryId, now).run()
    return { ok: false, reason: 'delivery_review_required' }
  }
  const claimToken = `plc-${crypto.randomUUID()}`
  const claimExpiresAt = new Date(Date.parse(now) + maxAttempts * timeoutMs * 2 + 30_000).toISOString()
  const claim = await db.prepare(
    `UPDATE project_link_deliveries
        SET status = 'sending', claim_token = ?3, claim_expires_at = ?4,
            next_retry_at = NULL, updated_at = ?5
      WHERE tenant = ?1 AND id = ?2 AND envelope_sha256 = ?6
        AND (status IN ('pending','failed') OR (status = 'sending' AND claim_expires_at <= ?5))
        AND EXISTS (
          SELECT 1
            FROM project_links l
            JOIN projects p ON p.id = l.local_project_id
            JOIN project_squad_access a
              ON a.project_id = l.local_project_id AND a.squad_id = l.local_squad_id
           WHERE l.tenant = ?1 AND l.id = project_link_deliveries.link_id
             AND l.state = 'active' AND p.status <> 'archived'
             AND a.access_level IN ('write','admin')
             AND EXISTS (SELECT 1 FROM json_each(l.capabilities_json) WHERE value = ?7)
             AND (
               SELECT state FROM addon_installations
                WHERE tenant = ?1 AND addon_key = 'project-link'
                ORDER BY installed_at DESC, id DESC LIMIT 1
             ) = 'active'
        )`,
  ).bind(
    env.TENANT_SLUG, deliveryId, claimToken, claimExpiresAt, now, envelopeSha256,
    envelope.requested_capability,
  ).run()
  if (Number(claim.meta?.changes ?? 0) !== 1) {
    const raced = await receiptFor(env, link.id, 'outbound', envelope.idempotency_key, db)
    if (raced?.envelope_sha256 === envelopeSha256) return { ok: true, receipt: raced }
    const currentDelivery = await deliveryFor(env, db, link.id, envelope.idempotency_key)
    if (currentDelivery?.status === 'review') return { ok: false, reason: 'delivery_review_required' }
    const currentLink = await loadLink(env, link.id, db)
    if (!currentLink || currentLink.state !== 'active') return { ok: false, reason: 'link_revoked' }
    if (!(await projectLinkAddonActive(env, db))) return { ok: false, reason: 'addon_inactive' }
    if (!(await destinationAuthorized(env, currentLink, db))) return { ok: false, reason: 'not_authorized' }
    return { ok: false, reason: 'idempotency_conflict' }
  }

  let lastError = 'remote_unavailable'
  let attemptsMade = 0
  let terminalReason: LinkFailure = 'remote_failure'
  const attemptBudget = Math.min(maxAttempts, MAX_DELIVERY_ATTEMPTS - attemptsBefore)
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    attemptsMade = attemptsBefore + attempt
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetcher(`${link.remote_base_url}api/project-links/${encodeURIComponent(link.remote_link_id)}/deliver`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signed),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (response.ok) {
        const parsed = await readBoundedRemoteJson(response, timeoutMs)
        if (!parsed.ok) {
          lastError = parsed.error
          break
        }
        const body = parsed.value
        if (body && typeof body === 'object' && !Array.isArray(body)
          && (body as { ok?: unknown }).ok === true && (body as { receipt?: unknown }).receipt) {
          const receipt = await validatedOutboundReceipt(
            env, link, envelope, envelopeSha256, (body as { receipt: unknown }).receipt, now,
          )
          if (!receipt) {
            lastError = 'receipt_mismatch'
            terminalReason = 'receipt_mismatch'
            break
          }
          try {
            const outcomes = await db.batch([
              db.prepare(
                `UPDATE project_link_deliveries
                    SET status = 'delivered', attempts = ?4, last_error = NULL,
                        next_retry_at = NULL, updated_at = ?5
                  WHERE tenant = ?1 AND id = ?2 AND status = 'sending' AND claim_token = ?3`,
              ).bind(env.TENANT_SLUG, deliveryId, claimToken, attemptsMade, now),
              db.prepare(
                `UPDATE project_links SET last_success_at = ?3, last_error = NULL
                  WHERE tenant = ?1 AND id = ?2 AND state = 'active'`,
              ).bind(env.TENANT_SLUG, link.id, now),
              db.prepare(
                `INSERT INTO project_link_receipts (
                  id, tenant, link_id, local_project_id, direction, idempotency_key,
                  correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
                  remote_project_id, source_agent_id, action_type, action_id,
                  evidence_sha256, receipt_key_id, receipt_signature, delivery_claim_token, status, created_at
                ) VALUES (?1, ?2, ?3, ?4, 'outbound', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 'accepted', ?18)`,
              ).bind(
                receipt.id, receipt.tenant, receipt.link_id, receipt.local_project_id,
                receipt.idempotency_key, receipt.correlation_id, receipt.envelope_sha256,
                receipt.shared_receipt_sha256, receipt.remote_pot, receipt.remote_project_id,
                receipt.source_agent_id, receipt.action_type, receipt.action_id,
                receipt.evidence_sha256, receipt.receipt_key_id, receipt.receipt_signature,
                claimToken, receipt.created_at,
              ),
            ])
            if (Number(outcomes[0]?.meta?.changes ?? 0) !== 1) throw new Error('delivery_claim_lost')
          } catch {
            const raced = await receiptFor(env, link.id, 'outbound', envelope.idempotency_key, db)
            if (raced?.envelope_sha256 === envelopeSha256) return { ok: true, receipt: raced }
            const current = await loadLink(env, link.id, db)
            if (!current || current.state !== 'active') return { ok: false, reason: 'link_revoked' }
            if (!(await destinationAuthorized(env, current, db))) return { ok: false, reason: 'not_authorized' }
            return { ok: false, reason: 'idempotency_conflict' }
          }
          return { ok: true, receipt }
        }
        lastError = 'invalid_remote_receipt'
      } else {
        lastError = `remote_http_${response.status}`
        if (!retryable(response.status)) break
      }
    } catch {
      lastError = 'remote_network_error'
    }
    const nextRetryAt = new Date(Date.parse(now) + attempt * 1000).toISOString()
    const attemptUpdate = await db.prepare(
      `UPDATE project_link_deliveries
          SET attempts = ?3, last_error = ?4, next_retry_at = ?5, updated_at = ?6
        WHERE tenant = ?1 AND id = ?2 AND status = 'sending' AND claim_token = ?7`,
    ).bind(env.TENANT_SLUG, deliveryId, attemptsMade, lastError, nextRetryAt, now, claimToken).run()
    if (Number(attemptUpdate.meta?.changes ?? 0) !== 1) {
      const raced = await receiptFor(env, link.id, 'outbound', envelope.idempotency_key, db)
      if (raced?.envelope_sha256 === envelopeSha256) return { ok: true, receipt: raced }
      return { ok: false, reason: 'idempotency_conflict' }
    }
  }
  const exhausted = terminalReason === 'remote_failure' && attemptsMade >= MAX_DELIVERY_ATTEMPTS
  const finalStatus = exhausted ? 'review' : 'failed'
  const finalError = exhausted ? 'retry_limit_exhausted' : lastError
  const outcomes = await db.batch([
    db.prepare(
      `UPDATE project_link_deliveries SET status = ?3, attempts = ?4, last_error = ?5, next_retry_at = NULL, updated_at = ?6
        WHERE tenant = ?1 AND id = ?2 AND status = 'sending' AND claim_token = ?7`,
    ).bind(env.TENANT_SLUG, deliveryId, finalStatus, attemptsMade, finalError, now, claimToken),
    db.prepare(
      `UPDATE project_links SET last_failure_at = ?3, last_error = ?4
        WHERE tenant = ?1 AND id = ?2 AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM project_link_deliveries
             WHERE tenant = ?1 AND id = ?5 AND status = ?6 AND claim_token = ?7
          )`,
    ).bind(env.TENANT_SLUG, link.id, now, finalError, deliveryId, finalStatus, claimToken),
  ])
  if (Number(outcomes[0]?.meta?.changes ?? 0) !== 1) {
    const raced = await receiptFor(env, link.id, 'outbound', envelope.idempotency_key, db)
    if (raced?.envelope_sha256 === envelopeSha256) return { ok: true, receipt: raced }
    return { ok: false, reason: 'idempotency_conflict' }
  }
  return { ok: false, reason: exhausted ? 'delivery_review_required' : terminalReason }
}

export async function listProjectLinkReceipts(env: Env, projectId: string): Promise<ProjectLinkReceipt[]> {
  const result = await env.DB.prepare(
    `SELECT id, tenant, link_id, local_project_id, direction, idempotency_key,
            correlation_id, envelope_sha256, shared_receipt_sha256, remote_pot,
            remote_project_id, source_agent_id, action_type, action_id,
            evidence_sha256, receipt_key_id, receipt_signature, status, created_at
       FROM project_link_receipts
      WHERE tenant = ?1 AND local_project_id = ?2
      ORDER BY created_at DESC, id DESC`,
  ).bind(env.TENANT_SLUG, projectId).all<ProjectLinkReceipt>()
  return result.results ?? []
}

export async function getProjectLinkStatus(
  env: Env,
  linkId: string,
  now = new Date().toISOString(),
): Promise<{
  state: 'unknown' | 'healthy' | 'failed' | 'stale' | 'revoked'
  source_pot?: string
  last_success_at?: string | null
  last_failure_at?: string | null
}> {
  const link = await loadLink(env, linkId)
  if (!link) return { state: 'unknown' }
  if (link.state === 'revoked') return { state: 'revoked', source_pot: link.remote_pot, last_success_at: link.last_success_at, last_failure_at: link.last_failure_at }
  if (!link.last_success_at && !link.last_failure_at) return { state: 'unknown', source_pot: link.remote_pot, last_success_at: null, last_failure_at: null }
  if (link.last_failure_at && (!link.last_success_at || Date.parse(link.last_failure_at) > Date.parse(link.last_success_at))) {
    return { state: 'failed', source_pot: link.remote_pot, last_success_at: link.last_success_at, last_failure_at: link.last_failure_at }
  }
  const stale = Date.parse(now) - Date.parse(link.last_success_at!) > link.stale_after_seconds * 1000
  return { state: stale ? 'stale' : 'healthy', source_pot: link.remote_pot, last_success_at: link.last_success_at, last_failure_at: link.last_failure_at }
}
