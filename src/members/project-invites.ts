import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import {
  capabilityRank,
  hasCapability,
  legacyRoleRank,
  resolveCapabilities,
} from '../auth/capability'
import { sha256Hex } from './service'

const CAPABILITIES: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REQUEST_DIGEST_RE = /^[0-9a-fA-F]{64}$/
const MAX_INVITE_LIFETIME_SECONDS = 7 * 24 * 60 * 60

export interface CreateProjectInviteInput {
  /** Required unless `member_id` is set — then the member's own email is used. */
  email?: string
  /**
   * Bind this EXISTING, active, same-tenant member instead of minting a
   * net-new one at redemption. Mutually exclusive with a caller-supplied
   * `email` (the member's own email is read server-side so the UNIQUE fence
   * and the receipt shape stay identical to the net-new path).
   */
  member_id?: string
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
  | 'invalid_member_id'
  | 'invalid_project_id'
  | 'invalid_squad_id'
  | 'invalid_capability'
  | 'invalid_expiry'
  | 'project_not_found'
  | 'archived_project'
  | 'project_not_active'
  | 'project_squad_not_linked'
  | 'member_not_found'
  | 'member_not_active'
  | 'member_missing_email'
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
  member_id: string | null
}

interface BindableMemberRow {
  id: string
  status: string
  telegram_chat_id: string | null
}

interface TelegramReceiptRow {
  telegram_user_id: string
  request_digest: string
  state: string
  response_text: string | null
}

function isNonEmptyString(value: unknown, maxLength = 255): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

/**
 * The actor's effective capability rank on a squad scope — carrying exactly
 * requireCapability's restrictions (src/auth/capability.ts:295-338), NOT a
 * looser re-derivation of them.
 *
 * P1-1 fix: the prior version computed the coarse legacy role's rank
 * unconditionally and then `Math.max`ed it against any real grant, so a
 * coarse org owner/admin role always floored (and could WIDEN past) an
 * explicit narrower squad grant. requireCapability never does that for a
 * non-org scope: its legacy-role escape (capabilities === undefined) exists
 * ONLY for org-scope checks, and once a member's grants are resolved (even to
 * []) the coarse role plays no further part. So here: an explicit grant on
 * this scope (via hasCapability — the same predicate requireCapability calls,
 * reused rather than re-implemented) always wins outright; the coarse role
 * (via legacyRoleRank — the SAME rank function requireCapability's own
 * legacy-role escape is built on, not a second copy of it) is consulted ONLY
 * as a bootstrap-owner floor when this principal's capabilities were NEVER
 * resolved at all (auth.capabilities === undefined) and no grant covers this
 * squad — never as an addition on top of a real, narrower grant.
 *
 * P1-1 parity fix: requireCapability's legacy-role escape is gated on
 * `target.type === 'org'` (src/auth/capability.ts:302-310) — for a non-org
 * scope with no memberId it returns 403 unconditionally, regardless of role
 * or whether capabilities were ever resolved (src/auth/capability.ts:315-322).
 * This function is squad-scope only, so that escape never applies here at
 * all; the prior `!auth.memberId` branch granting a legacy-role floor was a
 * second, looser copy of the same escape leaking into a scope it was never
 * meant to reach. Removed rather than reimplemented — no memberId on a squad
 * scope is simply zero standing, matching the canonical predicate exactly.
 */
async function actorRankOnSquad(
  env: Env,
  auth: AuthContext,
  squadId: string,
  departmentId: string,
): Promise<number> {
  if (!auth.memberId) {
    // Fine-grained RBAC is a member concept on a squad scope, and
    // requireCapability's legacy-role escape does not reach non-org scopes —
    // no floor here for any role, resolved or not.
    return 0
  }
  const grants: CapabilityGrant[] = auth.capabilities ?? await resolveCapabilities(env, auth.memberId)
  for (const capability of CAPABILITIES) {
    if (hasCapability(grants, 'squad', squadId, capability, departmentId)) {
      return capabilityRank(capability)
    }
  }
  // No grant resolves on this exact scope. The coarse role is a floor ONLY
  // when capabilities were never resolved for this principal at all — never
  // when they were resolved (even to an empty array), which is itself the
  // real "no standing here" answer and must not be overridden upward.
  return auth.capabilities === undefined ? legacyRoleRank(auth.role) : 0
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

/**
 * The atomic single-use claim fence, extracted to a named constant so a test
 * can drive this EXACT statement directly (P1-2). tests/helpers/sqlite-d1.ts
 * is synchronous `node:sqlite`, so no test that goes through
 * redeemTelegramProjectInvite's own JS pre-check (line ~368, which answers
 * first in every sequential run) can ever exercise this WHERE clause failing
 * on its own — the pre-check always agrees with a same-process, non-racing
 * caller. Pinning the statement itself, independent of that pre-check, is the
 * only way to prove single-use (`accepted_at IS NULL`), expiry
 * (`pairing_expires_at > ?8`), and the receipt-processing binding (the final
 * EXISTS) each still hold under a real concurrent claim.
 *
 * Member-bind extension: the final `member_id IS NULL OR EXISTS(...)`
 * conjunct ties the claim ITSELF to the target member still being active —
 * not merely the downstream bind statement. This is load-bearing, not
 * decorative: a bind statement that failed silently (0 rows, no exception —
 * a suspended member is not a SQL error) while this claim had already
 * committed would irreversibly burn a single-use invite for a transient
 * state with nothing to show for it (no member bound, no capability granted,
 * receipt left `processing`), and would do so on the ordinary sequential
 * "member got suspended before the participant typed /start" path, not only
 * under a race. Net-new invites (`member_id IS NULL`) are unaffected — the
 * `OR` short-circuits before ever touching the `members` table for them.
 */
export const CLAIM_INVITE_SQL = `
  UPDATE invites
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
          AND receipt.telegram_user_id = ?12
          AND receipt.state = 'processing'
     )
     AND (
       invites.member_id IS NULL
       OR EXISTS (
         SELECT 1 FROM members bind_target
          WHERE bind_target.id = invites.member_id
            AND bind_target.status = 'active'
       )
     )
`

function claimTimestamp(): string {
  const iso = new Date().toISOString()
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const suffix = String(random[0] % 1_000_000).padStart(6, '0')
  return iso.replace('Z', `${suffix}Z`)
}

function parseStoredRedemption(text: string | null): RedeemedProjectInvite | null {
  if (!text || text.length > 1000) return null
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const keys = Object.keys(parsed).sort()
    if (keys.join(',') !== 'capability,member_id,project_id,squad_id') return null
    if (!isNonEmptyString(parsed.member_id)) return null
    if (!isNonEmptyString(parsed.project_id)) return null
    if (!isNonEmptyString(parsed.squad_id)) return null
    if (!isCapability(parsed.capability)) return null
    return {
      member_id: parsed.member_id.trim(),
      project_id: parsed.project_id.trim(),
      squad_id: parsed.squad_id.trim(),
      capability: parsed.capability,
    }
  } catch {
    return null
  }
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

  // member_id and a caller-supplied email are mutually exclusive: the bind
  // path derives email from the member row so the UNIQUE fence and the
  // receipt shape stay identical to the net-new path — the caller never gets
  // to choose an email that diverges from the member it is binding to.
  const hasMemberId = input.member_id !== undefined && input.member_id !== null
  let memberId: string | null = null
  let email = ''
  if (hasMemberId) {
    if (!isNonEmptyString(input.member_id)) return { ok: false, error: 'invalid_member_id' }
    memberId = input.member_id.trim()
  } else {
    email = typeof input.email === 'string' ? input.email.trim() : ''
    if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' }
  }
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

  if (hasMemberId) {
    // Same tenant-collapse shape as GET /members/:id (src/members/index.ts) —
    // a member in another tenant reads as not-found, not forbidden, so this
    // never becomes a cross-tenant existence oracle.
    const member = await env.DB.prepare(
      'SELECT id, email, status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
    ).bind(memberId, env.TENANT_SLUG).first<{ id: string; email: string | null; status: string }>()
    if (!member) return { ok: false, error: 'member_not_found' }
    if (member.status !== 'active') return { ok: false, error: 'member_not_active' }
    if (!isNonEmptyString(member.email)) return { ok: false, error: 'member_missing_email' }
    email = member.email.trim()
  }

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
       project_id, squad_id, pairing_hash, pairing_expires_at, member_id
     ) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
    memberId,
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
    `SELECT telegram_user_id, request_digest, state, response_text
       FROM telegram_webhook_receipts
      WHERE tenant = ?1 AND update_id = ?2
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.update_id.trim()).first<TelegramReceiptRow>()
  if (!receipt || receipt.request_digest.toLowerCase() !== input.request_digest.toLowerCase()) {
    return { ok: false, error: 'update_receipt_invalid' }
  }
  if (receipt.telegram_user_id !== input.telegram_user_id.trim()) {
    return { ok: false, error: 'update_receipt_invalid' }
  }
  if (receipt.state === 'completed') {
    const stored = parseStoredRedemption(receipt.response_text)
    return stored
      ? { ok: true, value: stored }
      : { ok: false, error: 'update_receipt_invalid' }
  }
  if (receipt.state !== 'processing') return { ok: false, error: 'update_receipt_invalid' }

  const matches = await env.DB.prepare(
    `SELECT id, email, project_id, squad_id, capability, accepted_at, pairing_expires_at, member_id
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

  // Bind-existing-member path (invite.member_id set at creation): pre-empt the
  // "already bound to a DIFFERENT Telegram identity" conflict with its own
  // named error. Every OTHER member-eligibility fact (not found, wrong
  // tenant, no longer active at claim time) is deliberately left to the
  // atomic bindMemberStatement guard below — it re-checks the identical
  // status/tenant facts inside the same claim, so a redundant JS copy here
  // would only ever agree with it (same generic invalid_or_expired_pairing_code
  // fallback), never diverge. Only the conflict case changes the returned
  // error code, which is why it alone needs a pre-check; the reverse conflict
  // ("this Telegram id already belongs to a different member") is left to the
  // existing UNIQUE(members.telegram_chat_id) catch below — the SAME
  // mechanism the net-new path already relies on, not a second copy.
  if (invite.member_id !== null) {
    const member = await env.DB.prepare(
      'SELECT id, status, telegram_chat_id FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
    ).bind(invite.member_id, env.TENANT_SLUG).first<BindableMemberRow>()
    if (
      member
      && member.status === 'active'
      && member.telegram_chat_id !== null
      && member.telegram_chat_id !== input.telegram_user_id.trim()
    ) {
      return { ok: false, error: 'telegram_identity_conflict' }
    }
  }

  const memberId = invite.member_id ?? crypto.randomUUID()
  const grantId = crypto.randomUUID()
  const claimedAt = claimTimestamp()
  const value: RedeemedProjectInvite = {
    member_id: memberId,
    project_id: invite.project_id,
    squad_id: invite.squad_id,
    capability: invite.capability,
  }
  const responseText = JSON.stringify(value)

  // status='active' is deliberately NOT re-checked here: CLAIM_INVITE_SQL
  // (statement 1, same D1 batch = one transaction, no external write can
  // interleave) already fences it as part of the claim itself, so re-testing
  // it here could only ever agree — a guaranteed-vacuous copy, not a second
  // layer. What CAN still fail independently is the Telegram identity match,
  // which is exactly this statement's own reason to exist.
  const bindMemberStatement = invite.member_id !== null
    ? env.DB.prepare(
      `UPDATE members
          SET telegram_chat_id = ?1
        WHERE id = ?2
          AND (tenant = ?3 OR tenant IS NULL)
          AND (telegram_chat_id IS NULL OR telegram_chat_id = ?1)
          AND EXISTS (
            SELECT 1 FROM invites WHERE id = ?4 AND accepted_at = ?5
          )`,
    ).bind(
      input.telegram_user_id.trim(),
      memberId,
      env.TENANT_SLUG,
      invite.id,
      claimedAt,
    )
    : env.DB.prepare(
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
    )

  // Bind path only: tie the capability grant and receipt completion to
  // bindMemberStatement's OWN effect having actually landed, not merely to
  // CLAIM_INVITE_SQL's. CLAIM_INVITE_SQL guarantees the member was active AT
  // THE CLAIM, but bindMemberStatement can still independently affect 0 rows
  // in the same batch (the residual Telegram-identity-conflict race — the
  // pre-check above answers it in every sequential run, same TOCTOU-only
  // shape as CLAIM_INVITE_SQL's own receipt sub-conjuncts). Without this,
  // that race would grant the squad capability and mark the receipt
  // completed for a member whose Telegram identity was never actually bound
  // — capability without a proven bind. Net-new invites are unaffected: the
  // member-INSERT's own UNIQUE constraints already make ITS failure throw
  // (batch-wide rollback), so no analogous silent-0-rows gap exists there.
  const memberBindLandedGuard = invite.member_id !== null
    ? `
       AND EXISTS (
         SELECT 1 FROM members WHERE id = ? AND telegram_chat_id = ?
       )`
    : ''
  const memberBindLandedParams = invite.member_id !== null
    ? [memberId, input.telegram_user_id.trim()]
    : []

  try {
    const results = await env.DB.batch([
      env.DB.prepare(CLAIM_INVITE_SQL).bind(
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
        input.telegram_user_id.trim(),
      ),
      bindMemberStatement,
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         SELECT ?, ?, 'squad', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE id = ? AND accepted_at = ?
          )${memberBindLandedGuard}`,
      ).bind(
        grantId, memberId, invite.squad_id, invite.capability, invite.id, claimedAt,
        ...memberBindLandedParams,
      ),
      env.DB.prepare(
        `UPDATE telegram_webhook_receipts
            SET state = 'completed', response_text = ?, completed_at = ?
          WHERE tenant = ?
            AND update_id = ?
            AND lower(request_digest) = lower(?)
            AND telegram_user_id = ?
            AND state = 'processing'
            AND EXISTS (
              SELECT 1 FROM invites WHERE id = ? AND accepted_at = ?
            )${memberBindLandedGuard}`,
      ).bind(
        responseText,
        now,
        env.TENANT_SLUG,
        input.update_id.trim(),
        input.request_digest,
        input.telegram_user_id.trim(),
        invite.id,
        claimedAt,
        ...memberBindLandedParams,
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
