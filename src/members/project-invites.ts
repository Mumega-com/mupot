import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import {
  capabilityRank,
  hasCapability,
  resolveCapabilities,
} from '../auth/capability'
import { sha256Hex } from './service'

const CAPABILITIES: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REQUEST_DIGEST_RE = /^[0-9a-fA-F]{64}$/
const MAX_INVITE_LIFETIME_SECONDS = 7 * 24 * 60 * 60

export interface CreateProjectInviteInput {
  email: string
  project_id: string
  squad_id: string
  capability: Capability
  expires_in_seconds: number
}

export interface ProjectInviteMetadata {
  id: string
  email: string
  project_id: string
  squad_id: string
  capability: Capability
  invited_by: string
  accepted_at: null
  created_at: string
  pairing_expires_at: string
}

export interface CreatedProjectInvite {
  invite: ProjectInviteMetadata
  pairing_code: string
  access_scope: {
    scope_type: 'squad'
    scope_id: string
    includes_all_projects_linked_to_squad: true
  }
  access_notice: string
}

export type CreateProjectInviteError =
  | 'tenant_scope'
  | 'invalid_email'
  | 'invalid_project_id'
  | 'invalid_squad_id'
  | 'invalid_capability'
  | 'invalid_expiry'
  | 'project_not_found'
  | 'archived_project'
  | 'project_not_active'
  | 'project_squad_not_linked'
  | 'forbidden'
  | 'cannot_grant_above_own_rank'
  | 'pairing_code_collision'

export type CreateProjectInviteResult =
  | { ok: true; value: CreatedProjectInvite }
  | { ok: false; error: CreateProjectInviteError }

export interface RedeemTelegramProjectInviteInput {
  pairing_code: string
  telegram_user_id: string
  display_name: string
  update_id: string
  request_digest: string
}

export interface RedeemedProjectInvite {
  member_id: string
  project_id: string
  squad_id: string
  capability: Capability
}

export type RedeemTelegramProjectInviteError =
  | 'invalid_pairing_code'
  | 'invalid_telegram_user_id'
  | 'invalid_display_name'
  | 'invalid_update_id'
  | 'invalid_request_digest'
  | 'update_receipt_invalid'
  | 'update_already_completed'
  | 'invalid_or_expired_pairing_code'
  | 'ambiguous_pairing_code'
  | 'telegram_identity_conflict'
  | 'member_already_exists'
  | 'redemption_failed'

export type RedeemTelegramProjectInviteResult =
  | { ok: true; value: RedeemedProjectInvite }
  | { ok: false; error: RedeemTelegramProjectInviteError }

interface ProjectRow {
  id: string
  status: string
}

interface ProjectSquadRow {
  squad_id: string
  department_id: string
}

interface RedeemableInviteRow {
  id: string
  email: string
  project_id: string
  squad_id: string
  capability: Capability
  accepted_at: string | null
  pairing_expires_at: string
}

function isNonEmptyString(value: unknown, maxLength = 255): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

function actorRoleRank(auth: AuthContext): number {
  if (auth.role === 'owner') return capabilityRank('owner')
  if (auth.role === 'admin') return capabilityRank('admin')
  return 0
}

async function actorRankOnSquad(
  env: Env,
  auth: AuthContext,
  squadId: string,
  departmentId: string,
): Promise<number> {
  let max = actorRoleRank(auth)
  if (!auth.memberId) return max
  const grants: CapabilityGrant[] = auth.capabilities ?? await resolveCapabilities(env, auth.memberId)
  for (const capability of CAPABILITIES) {
    if (hasCapability(grants, 'squad', squadId, capability, departmentId)) {
      max = Math.max(max, capabilityRank(capability))
      break
    }
  }
  return max
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function mintPairingCode(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

function rowsChanged(result: { meta?: { changes?: number } } | undefined): number {
  return Number(result?.meta?.changes ?? 0)
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function uniqueConstraintColumn(error: unknown, column: string): boolean {
  return error instanceof Error && new RegExp(`UNIQUE constraint failed: .*${column}`, 'i').test(error.message)
}

function claimTimestamp(): string {
  const iso = new Date().toISOString()
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const suffix = String(random[0] % 1_000_000).padStart(6, '0')
  return iso.replace('Z', `${suffix}Z`)
}

/**
 * Create a single-use Telegram invite for one active project and one exact
 * project-linked squad. The raw pairing code is returned once and only its
 * SHA-256 digest is stored.
 */
export async function createProjectInvite(
  env: Env,
  auth: AuthContext,
  input: CreateProjectInviteInput,
): Promise<CreateProjectInviteResult> {
  if (auth.tenant !== env.TENANT_SLUG) return { ok: false, error: 'tenant_scope' }

  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' }
  if (!isNonEmptyString(input.project_id)) return { ok: false, error: 'invalid_project_id' }
  if (!isNonEmptyString(input.squad_id)) return { ok: false, error: 'invalid_squad_id' }
  if (!isCapability(input.capability)) return { ok: false, error: 'invalid_capability' }
  if (
    !Number.isInteger(input.expires_in_seconds)
    || input.expires_in_seconds <= 0
    || input.expires_in_seconds > MAX_INVITE_LIFETIME_SECONDS
  ) {
    return { ok: false, error: 'invalid_expiry' }
  }

  const projectId = input.project_id.trim()
  const squadId = input.squad_id.trim()
  const project = await env.DB.prepare(
    'SELECT id, status FROM projects WHERE id = ?1 LIMIT 1',
  ).bind(projectId).first<ProjectRow>()
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'archived') return { ok: false, error: 'archived_project' }
  if (project.status !== 'active') return { ok: false, error: 'project_not_active' }

  const edge = await env.DB.prepare(
    `SELECT access.squad_id, squad.department_id
       FROM project_squad_access access
       JOIN squads squad ON squad.id = access.squad_id
      WHERE access.project_id = ?1 AND access.squad_id = ?2
      LIMIT 1`,
  ).bind(projectId, squadId).first<ProjectSquadRow>()
  if (!edge) return { ok: false, error: 'project_squad_not_linked' }

  const actorRank = await actorRankOnSquad(env, auth, squadId, edge.department_id)
  if (actorRank < capabilityRank('admin')) return { ok: false, error: 'forbidden' }
  if (capabilityRank(input.capability) > actorRank) {
    return { ok: false, error: 'cannot_grant_above_own_rank' }
  }

  let pairingCode = ''
  let pairingHash = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    pairingCode = mintPairingCode()
    pairingHash = await sha256Hex(pairingCode)
    const existing = await env.DB.prepare(
      'SELECT id FROM invites WHERE pairing_hash = ?1 LIMIT 1',
    ).bind(pairingHash).first<{ id: string }>()
    if (!existing) break
    pairingCode = ''
    pairingHash = ''
  }
  if (!pairingCode || !pairingHash) return { ok: false, error: 'pairing_code_collision' }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + input.expires_in_seconds * 1000).toISOString()
  const invitedBy = auth.memberId ?? auth.userId

  await env.DB.prepare(
    `INSERT INTO invites (
       id, email, department_id, capability, invited_by, accepted_at, created_at,
       project_id, squad_id, pairing_hash, pairing_expires_at
     ) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    id,
    email,
    input.capability,
    invitedBy,
    createdAt,
    projectId,
    squadId,
    pairingHash,
    expiresAt,
  ).run()

  return {
    ok: true,
    value: {
      invite: {
        id,
        email,
        project_id: projectId,
        squad_id: squadId,
        capability: input.capability,
        invited_by: invitedBy,
        accepted_at: null,
        created_at: createdAt,
        pairing_expires_at: expiresAt,
      },
      pairing_code: pairingCode,
      access_scope: {
        scope_type: 'squad',
        scope_id: squadId,
        includes_all_projects_linked_to_squad: true,
      },
      access_notice: 'This squad capability applies to every project linked to the selected squad.',
    },
  }
}

/**
 * Redeem a project invite only from an already-reserved authenticated Telegram
 * update. Claim, tokenless member creation, squad grant, and receipt completion
 * are one D1 transaction. Any constraint failure rolls the invite claim back.
 */
export async function redeemTelegramProjectInvite(
  env: Env,
  input: RedeemTelegramProjectInviteInput,
): Promise<RedeemTelegramProjectInviteResult> {
  if (!isNonEmptyString(input.pairing_code, 512)) return { ok: false, error: 'invalid_pairing_code' }
  if (!isNonEmptyString(input.telegram_user_id)) return { ok: false, error: 'invalid_telegram_user_id' }
  if (!isNonEmptyString(input.display_name, 200)) return { ok: false, error: 'invalid_display_name' }
  if (!isNonEmptyString(input.update_id)) return { ok: false, error: 'invalid_update_id' }
  if (!REQUEST_DIGEST_RE.test(input.request_digest)) return { ok: false, error: 'invalid_request_digest' }

  const pairingHash = await sha256Hex(input.pairing_code.trim())
  const receipt = await env.DB.prepare(
    `SELECT request_digest, state
       FROM telegram_webhook_receipts
      WHERE tenant = ?1 AND update_id = ?2
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.update_id.trim()).first<{
    request_digest: string
    state: string
  }>()
  if (!receipt || receipt.request_digest.toLowerCase() !== input.request_digest.toLowerCase()) {
    return { ok: false, error: 'update_receipt_invalid' }
  }
  if (receipt.state === 'completed') return { ok: false, error: 'update_already_completed' }
  if (receipt.state !== 'processing') return { ok: false, error: 'update_receipt_invalid' }

  const matches = await env.DB.prepare(
    `SELECT id, email, project_id, squad_id, capability, accepted_at, pairing_expires_at
       FROM invites
      WHERE pairing_hash = ?1
      LIMIT 2`,
  ).bind(pairingHash).all<RedeemableInviteRow>()
  const invitations = matches.results ?? []
  if (invitations.length > 1) return { ok: false, error: 'ambiguous_pairing_code' }
  if (invitations.length === 0) return { ok: false, error: 'invalid_or_expired_pairing_code' }

  const invite = invitations[0]
  const now = new Date().toISOString()
  if (invite.accepted_at !== null || invite.pairing_expires_at <= now) {
    return { ok: false, error: 'invalid_or_expired_pairing_code' }
  }

  const memberId = crypto.randomUUID()
  const grantId = crypto.randomUUID()
  const claimedAt = claimTimestamp()
  const value: RedeemedProjectInvite = {
    member_id: memberId,
    project_id: invite.project_id,
    squad_id: invite.squad_id,
    capability: invite.capability,
  }
  const responseText = JSON.stringify(value)

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE invites
            SET accepted_at = ?1
          WHERE id = ?2
            AND pairing_hash = ?3
            AND project_id = ?4
            AND squad_id = ?5
            AND capability = ?6
            AND email = ?7
            AND accepted_at IS NULL
            AND pairing_expires_at > ?8
            AND EXISTS (
              SELECT 1 FROM projects project
               WHERE project.id = invites.project_id AND project.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM project_squad_access access
               WHERE access.project_id = invites.project_id
                 AND access.squad_id = invites.squad_id
            )
            AND EXISTS (
              SELECT 1 FROM telegram_webhook_receipts receipt
               WHERE receipt.tenant = ?9
                 AND receipt.update_id = ?10
                 AND lower(receipt.request_digest) = lower(?11)
                 AND receipt.state = 'processing'
            )`,
      ).bind(
        claimedAt,
        invite.id,
        pairingHash,
        invite.project_id,
        invite.squad_id,
        invite.capability,
        invite.email,
        now,
        env.TENANT_SLUG,
        input.update_id.trim(),
        input.request_digest,
      ),
      env.DB.prepare(
        `INSERT INTO members (
           id, email, display_name, telegram_chat_id, status, created_at, tenant
         )
         SELECT ?1, ?2, ?3, ?4, 'active', ?5, ?6
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE id = ?7 AND accepted_at = ?8
          )`,
      ).bind(
        memberId,
        invite.email,
        input.display_name.trim(),
        input.telegram_user_id.trim(),
        now,
        env.TENANT_SLUG,
        invite.id,
        claimedAt,
      ),
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         SELECT ?1, ?2, 'squad', ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE id = ?5 AND accepted_at = ?6
          )`,
      ).bind(grantId, memberId, invite.squad_id, invite.capability, invite.id, claimedAt),
      env.DB.prepare(
        `UPDATE telegram_webhook_receipts
            SET state = 'completed', response_text = ?1, completed_at = ?2
          WHERE tenant = ?3
            AND update_id = ?4
            AND lower(request_digest) = lower(?5)
            AND state = 'processing'
            AND EXISTS (
              SELECT 1 FROM invites WHERE id = ?6 AND accepted_at = ?7
            )`,
      ).bind(
        responseText,
        now,
        env.TENANT_SLUG,
        input.update_id.trim(),
        input.request_digest,
        invite.id,
        claimedAt,
      ),
    ])

    if (results.length !== 4 || results.some((result) => rowsChanged(result) !== 1)) {
      return { ok: false, error: 'invalid_or_expired_pairing_code' }
    }
  } catch (error) {
    if (uniqueConstraintColumn(error, 'telegram_chat_id')) {
      return { ok: false, error: 'telegram_identity_conflict' }
    }
    if (uniqueConstraintColumn(error, 'members.email')) {
      return { ok: false, error: 'member_already_exists' }
    }
    if (isUniqueViolation(error)) return { ok: false, error: 'redemption_failed' }
    throw error
  }

  return { ok: true, value }
}
