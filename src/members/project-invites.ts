import type { AuthContext, Capability, CapabilityGrant, Env, OrgKind } from '../types'
import {
  actorRankOnScopeFor,
  capabilityRank,
  exceedsTargetRankCeiling,
  hasCapability,
  legacyRoleRank,
  loadSquadScope,
  planeCoversScope,
  resolveCapabilities,
  targetLegacyRoleRank,
  targetMaxRankAcrossScopes,
  type SquadScope,
} from '../auth/capability'
import { sha256Hex } from './service'
import { claimTimestamp } from '../lib/claim-timestamp'

const CAPABILITIES: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REQUEST_DIGEST_RE = /^[0-9a-fA-F]{64}$/

/**
 * The minimum rank createProjectInvite requires an actor to hold — on
 * whichever scope applies to the path they're taking (org-scope for a
 * member-bind invite, squad-scope for a net-new one; see the actorRank
 * computation below) — before an invite can be minted at all. kasra-review
 * AMBER P2 (2026-09-16): exported so callers that need to render UI
 * consistent with this floor (e.g. src/dashboard/account.ts's Connect
 * Telegram page) import the SAME constant rather than a second literal
 * `capabilityRank('admin')` that could silently drift from this one if this
 * floor is ever changed here without updating every reader.
 */
export const MEMBER_BIND_MINT_FLOOR: Capability = 'admin'

/**
 * mupot#1411 P2-E round 4 (kasra-review, 2026-09-15): the capabilities INSERT
 * below used to be a bare INSERT — any PRE-EXISTING grant on the invited
 * squad (even a lowly 'observer', the MOST common shape for a member-bind
 * invite: the whole point is adding Telegram to someone who already works on
 * that squad) hit `UNIQUE(member_id, scope_type, scope_id)` and threw,
 * rolling the whole claim back to a permanent, unrecoverable
 * 'redemption_failed' — the invite is not re-burned, but nothing about the
 * error tells the operator that "grant a capability the target already has"
 * is the unfixable case. `RANK_SQL_CASE` mirrors capability.ts's own RANK
 * ladder (owner=5 > admin=4 > lead=3 > member=2 > observer=1) so the ON
 * CONFLICT clause below can compare the pre-existing row's capability
 * against the invite's — in SQL, at conflict-evaluation time, since that is
 * the only place the pre-existing value is visible.
 */
const RANK_SQL_CASE = (column: string): string =>
  `(CASE ${column} WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3 WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END)`
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
  | 'invalid_invite_scope'
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
  | 'home_scope_not_invitable'
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
  | 'invite_minter_authority_lost'
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
  kind: OrgKind
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
  minted_by_member_id: string | null
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
  const scope: SquadScope = { id: squadId, department_id: departmentId, kind: await squadKindOf(env, squadId) }
  const grants: CapabilityGrant[] = auth.capabilities ?? await resolveCapabilities(env, auth.memberId)
  for (const capability of CAPABILITIES) {
    if (hasCapability(grants, 'squad', scope, capability)) {
      return capabilityRank(capability)
    }
  }
  // No grant resolves on this exact scope. The coarse role is a floor ONLY
  // when capabilities were never resolved for this principal at all — never
  // when they were resolved (even to an empty array), which is itself the
  // real "no standing here" answer and must not be overridden upward.
  //
  // G-FP1b point 2: that coarse-role floor must ALSO never cover a home
  // squad — otherwise a legacy owner/admin with unresolved capabilities gets
  // rank 5/4 on ANY member's home the moment the exact-grant loop above
  // finds nothing, which is precisely the master-key shape this predicate
  // exists to close.
  if (auth.capabilities !== undefined) return 0
  return planeCoversScope('role', scope) ? legacyRoleRank(auth.role) : 0
}

/** Small helper: a squad's kind alone, for callers that already resolved its
 *  department_id via a different query and don't need a second full
 *  SquadScope load. */
async function squadKindOf(env: Env, squadId: string): Promise<OrgKind> {
  const row = await env.DB.prepare('SELECT kind FROM squads WHERE id = ?1 LIMIT 1').bind(squadId).first<{ kind: OrgKind }>()
  return row?.kind ?? 'work'
}

/**
 * mupot#1411 P2 round 5 (kasra-review adversarial addendum, 2026-09-15): the
 * invite MINTER's org-scope-local standing, re-derived FRESH from D1 at
 * REDEMPTION time — an org-scope capability grant, unioned with their
 * role-plane rank (targetLegacyRoleRank's members.email -> users.role
 * bridge).
 *
 * mupot#1411 F3 round 6 (Athena gate `efdb0b08`): this is NOT "the SAME
 * quantity" actorRankOnScopeFor(env, auth, 'org', null) computes for a live
 * session, as an earlier revision of this comment claimed. actorRankOnScopeFor
 * has a THIRD input this function has no way to re-derive: the SESSION's own
 * `auth.role`, read directly off the AuthContext at mint time, unconditionally
 * folded into the actor's rank regardless of whether that role is backed by
 * anything queryable in D1 for this memberId. This function only ever has two
 * planes to read — the `capabilities` table and the `members.email ->
 * users.role` bridge — because at redemption there is no live session for the
 * minter to re-read a `role` off; the caller redeeming is the INVITEE's
 * Telegram identity, never the minter's own request. The two ARE the same
 * quantity whenever the minting session's `auth.role` was itself sourced from
 * `users.role` under an email that matches this member's own `members.email`
 * (the ordinary case) — but a minter whose org-scope standing at mint time
 * came ONLY from `auth.role` with no backing capabilities row and no bridged
 * `users` row reachable from their OWN member email (a session-role-only
 * minter) mints successfully here and is refused at redemption
 * (`invite_minter_authority_lost`), even with no change in their real
 * standing between the two. Documented, known-at-v1 gap — not fixed this
 * round; see `docs/architecture/human-decision-channel-contract.md` clause
 * (g) and the operator runbook's pre-flight checklist, which now name it.
 * tests/telegram-project-onboarding.test.ts has a test exercising this exact
 * shape (mint succeeds, redemption refuses) so the gap is proven, not merely
 * asserted.
 */
async function currentMemberOrgRank(env: Env, memberId: string): Promise<number> {
  const grants = await resolveCapabilities(env, memberId)
  let max = 0
  for (const grant of grants) {
    if (grant.scope_type === 'org') max = Math.max(max, capabilityRank(grant.capability))
  }
  return Math.max(max, await targetLegacyRoleRank(env, memberId))
}

/**
 * mupot#1411 P2 round 6 (kasra-review adversarial addendum on Athena gate
 * `efdb0b08`): the NET-NEW invite path's mint-time authority is SQUAD-scoped
 * (`actorRankOnSquad`), not org-scoped — `currentMemberOrgRank` above is the
 * wrong quantity to re-check it against at redemption. Mirrors
 * `actorRankOnSquad`'s own grant-loop (department inheritance resolved from
 * D1, same as `hasCapability`'s squad branch always requires) without that
 * function's legacy-role floor: that floor exists only for a LIVE session
 * with no memberId at all, which can never be the case here — the minter
 * always has a real `members` row by construction (`minted_by_member_id`
 * REFERENCES `members(id)`).
 */
async function currentMemberSquadRank(env: Env, memberId: string, squadId: string): Promise<number> {
  const grants = await resolveCapabilities(env, memberId)
  const scope = await loadSquadScope(env, squadId)
  if (!scope) return 0
  for (const capability of CAPABILITIES) {
    if (hasCapability(grants, 'squad', scope, capability)) {
      return capabilityRank(capability)
    }
  }
  return 0
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
 * The ONE member-eligibility predicate for a Telegram bind-existing-member
 * invite, expressed exactly once and interpolated verbatim into BOTH
 * CLAIM_INVITE_SQL's `bind_target` EXISTS check and bindMemberStatement's own
 * WHERE clause below, so the two statements structurally cannot drift into
 * checking different facts (mupot#1411 Athena F2, round 2: CLAIM_INVITE_SQL's
 * `bind_target` EXISTS checked `status` only; bindMemberStatement's WHERE
 * checked `tenant` — two independent, hand-duplicated predicates).
 *
 * `tenant = ?` is an EXACT, non-NULL match, not the `(tenant = ? OR tenant IS
 * NULL)` collapse shape used elsewhere for existence-oracle avoidance —
 * deliberately, because `memberForChat` (src/im/index.ts:95-97) requires an
 * exact tenant match with no NULL fallback, so a NULL-tenant member can never
 * be resolved by `/approve` etc. through Telegram even if bound. Binding one
 * would silently grant a capability an operator can never reach that way.
 *
 * tests/telegram-project-onboarding.test.ts has a seam test asserting BOTH
 * compiled statement strings contain this exact constant, so any future edit
 * that touches one copy without the other fails immediately.
 */
export const MEMBER_BIND_ELIGIBLE_SQL = "id = ? AND tenant = ? AND status = 'active' AND (telegram_chat_id IS NULL OR telegram_chat_id = ?)"

/**
 * The bind-landed PROOF used to gate the capability grant and receipt
 * completion on the bind path — exported so a test can pin the exact text
 * used in production (P1-2 pattern), directly against `members.telegram_bound_at`
 * (see bindMemberStatement below), not against `telegram_chat_id`. A
 * pre-existing telegram_chat_id that merely happens to already equal the
 * redeeming identity must NOT satisfy this on its own; only THIS claim's own
 * write of `telegram_bound_at = claimedAt` does.
 */
export const MEMBER_BIND_LANDED_GUARD_SQL = 'EXISTS (SELECT 1 FROM members WHERE id = ? AND telegram_bound_at = ?)'

/**
 * The atomic single-use claim fence, extracted to a named constant so a test
 * can drive this EXACT statement directly (P1-2). tests/helpers/sqlite-d1.ts
 * is synchronous `node:sqlite`, so no test that goes through
 * redeemTelegramProjectInvite's own JS pre-check (line ~368, which answers
 * first in every sequential run) can ever exercise this WHERE clause failing
 * on its own — the pre-check always agrees with a same-process, non-racing
 * caller. Pinning the statement itself, independent of that pre-check, is the
 * only way to prove single-use (`accepted_at IS NULL`), expiry
 * (`pairing_expires_at > ?`), and the receipt-processing binding (the final
 * EXISTS) each still hold under a real concurrent claim.
 *
 * Member-bind extension: the final `member_id IS NULL OR EXISTS(...)`
 * conjunct ties the claim ITSELF to the target member still being eligible —
 * not merely the downstream bind statement, and via the SAME
 * MEMBER_BIND_ELIGIBLE_SQL predicate the bind statement itself uses. This is
 * load-bearing, not decorative: a bind statement that failed silently (0
 * rows, no exception — a suspended member, a reassigned tenant, or a NULL
 * tenant is not a SQL error) while this claim had already committed would
 * irreversibly burn a single-use invite for a transient state with nothing
 * to show for it (no member bound, no capability granted, receipt left
 * `processing`), and would do so on the ordinary sequential "member's
 * eligibility changed before the participant typed /start" path, not only
 * under a race. Net-new invites (`member_id IS NULL`) are unaffected — the
 * `OR` short-circuits before ever touching the `members` table for them; the
 * eligibility fragment is bound against the invite's OWN `member_id` (read
 * once, in JS, before the batch — never a correlated subquery column), the
 * same value bindMemberStatement itself binds, so the two can never see
 * different targets within the one atomic batch.
 */
export const CLAIM_INVITE_SQL = `
  UPDATE invites
     SET accepted_at = ?
   WHERE id = ?
     AND pairing_hash = ?
     AND project_id = ?
     AND squad_id = ?
     AND capability = ?
     AND email = ?
     AND accepted_at IS NULL
     AND pairing_expires_at > ?
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
        WHERE receipt.tenant = ?
          AND receipt.update_id = ?
          AND lower(receipt.request_digest) = lower(?)
          AND receipt.telegram_user_id = ?
          AND receipt.state = 'processing'
     )
     AND (
       invites.member_id IS NULL
       OR EXISTS (
         SELECT 1 FROM members WHERE ${MEMBER_BIND_ELIGIBLE_SQL}
       )
     )
`

/**
 * The Telegram-bind UPDATE for an EXISTING member (the second statement of
 * the same atomic batch as CLAIM_INVITE_SQL), extracted to a named constant
 * for the same reason CLAIM_INVITE_SQL is: so a test can assert, byte for
 * byte, that it interpolates the SAME MEMBER_BIND_ELIGIBLE_SQL fragment
 * CLAIM_INVITE_SQL's own bind_target EXISTS does (the seam test) — the two
 * can never independently drift back into checking different member facts.
 * `telegram_bound_at = ?` is this claim's own bind-landed stamp; see
 * MEMBER_BIND_LANDED_GUARD_SQL for how it is later proven, not merely stated.
 */
export const MEMBER_BIND_UPDATE_SQL = `
  UPDATE members
     SET telegram_chat_id = ?, telegram_bound_at = ?
   WHERE ${MEMBER_BIND_ELIGIBLE_SQL}
     AND EXISTS (
       SELECT 1 FROM invites WHERE id = ? AND accepted_at = ?
     )
`

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
  // mupot#1411 P2-2 (kasra-review, 2026-09-15): the HTTP route's parseInvite
  // already refuses a body carrying both, but createProjectInvite is called
  // directly by non-HTTP callers too (the same reason its own rank ceiling
  // below cannot rely on route middleware) — a caller-supplied `email`
  // silently winning member_id's derived email must be refused HERE, not
  // only at the one HTTP entry point.
  if (hasMemberId && input.email !== undefined && input.email !== null) {
    return { ok: false, error: 'invalid_invite_scope' }
  }
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
    `SELECT access.squad_id, squad.department_id, squad.kind
       FROM project_squad_access access
       JOIN squads squad ON squad.id = access.squad_id
      WHERE access.project_id = ?1 AND access.squad_id = ?2
      LIMIT 1`,
  ).bind(projectId, squadId).first<ProjectSquadRow>()
  if (!edge) return { ok: false, error: 'project_squad_not_linked' }
  // G-FP1b point 4: a project↔squad edge legitimately exists for a home
  // squad (that is how Slice 2's grant lands — project_squad_set on the
  // home squad, deliberately untouched by this PR). But an INVITE minted
  // against that edge is a DIFFERENT thing: it lets an ARBITRARY invitee
  // redeem a standing capabilities row on the squad itself (see the
  // 'squad' scope_type INSERT at redemption, below) — i.e. it grants entry
  // INTO the squad, not merely project access FOR it. For a home squad that
  // is exactly the standing-grant-into-home path point 4 forbids, so the
  // invite is refused here regardless of the caller's own rank.
  if (edge.kind === 'home') return { ok: false, error: 'home_scope_not_invitable' }

  // mupot#1411 P0-1 (kasra-review, 2026-09-15): a member-bind invite mints a
  // Telegram credential that authenticates AS the target member — exactly the
  // token-mint concept requireCapability(orgScope,'admin') + targetRankCeiling
  // already guard in src/members/index.ts (POST /members/:id/tokens). A
  // squad-admin ceiling is not enough: it never looks at what the TARGET
  // already holds, so a squad-admin could member-bind an org OWNER (or any
  // higher-ranked principal) onto their own squad at a low capability, then
  // redeem it from THEIR OWN Telegram id and resolve through memberForChat AS
  // that member — an identity takeover with no unbind route. So the member-id
  // path requires ORG-scope admin (not squad-admin) AND the SAME
  // target-rank-ceiling primitive the token-mint route uses, checked against
  // the target's REAL standing across every scope (targetMaxRankAcrossScopes),
  // not merely the invited squad. The net-new path (no member_id — nothing to
  // take over, a fresh member is minted) keeps the existing squad-admin
  // ceiling unchanged.
  //
  // mupot#1411 P2-D round 4 (kasra-review, 2026-09-15): this coarse
  // "does the actor even hold admin standing at all" check used to run AFTER
  // the member lookup below — so a zero-standing caller (never admin on
  // anything) got a DIFFERENT error per target (member_not_found /
  // member_not_active / member_missing_email / eventually 'forbidden'),
  // making member existence, status, and email-presence an enumeration
  // oracle available to literally anyone who could reach this function.
  // Neither `edge` (squad/department) nor this rank computation depends on
  // the target member row, so this can run first: a zero-standing caller now
  // gets the exact same 'forbidden' refusal regardless of what the target
  // member id resolves to.
  const actorRank = hasMemberId
    ? await actorRankOnScopeFor(env, auth, 'org', null)
    : await actorRankOnSquad(env, auth, squadId, edge.department_id)
  if (actorRank < capabilityRank(MEMBER_BIND_MINT_FLOOR)) return { ok: false, error: 'forbidden' }

  if (hasMemberId) {
    // mupot#1411 N4 round 4 (Athena, 2026-09-15): deliberately EXACT tenant
    // match here, NOT the GET /members/:id collapse shape (tenant = ? OR
    // tenant IS NULL) this used to reuse. That collapse is right for a READ
    // (existence-oracle safety) but wrong for a WRITE that creates a
    // dependency on a LATER exact-tenant check: MEMBER_BIND_ELIGIBLE_SQL,
    // the fence redemption actually enforces, requires `tenant = ?` exactly
    // — NULL never equals a tenant slug in SQL — so a NULL-tenant member
    // passed creation's old collapse-shaped check, minted a real invite, and
    // could NEVER redeem it (permanently invalid_or_expired_pairing_code,
    // no way to distinguish that from any other expired code). Refusing here
    // with the SAME exact-match predicate as the eligibility fence trades a
    // silent, permanent dead invite for an immediate, honest
    // member_not_found at creation time — still not a cross-tenant oracle,
    // since a NULL-tenant row and a genuinely nonexistent one both resolve
    // to the identical refusal. Reached only once the caller is already
    // proven to hold org-admin standing (above), so this is no longer
    // reachable by a zero-standing caller at all.
    const member = await env.DB.prepare(
      'SELECT id, email, status FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1',
    ).bind(memberId, env.TENANT_SLUG).first<{ id: string; email: string | null; status: string }>()
    if (!member) return { ok: false, error: 'member_not_found' }
    if (member.status !== 'active') return { ok: false, error: 'member_not_active' }
    if (!isNonEmptyString(member.email)) return { ok: false, error: 'member_missing_email' }
    email = member.email.trim()
  }

  if (capabilityRank(input.capability) > actorRank) {
    return { ok: false, error: 'cannot_grant_above_own_rank' }
  }
  if (hasMemberId && memberId !== null && await exceedsTargetRankCeiling(env, auth, memberId)) {
    return { ok: false, error: 'forbidden' }
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
  // mupot#1411 P2 round 5 (kasra-review adversarial addendum, 2026-09-15):
  // `invited_by` is ambiguous (memberId OR userId) and cannot be re-resolved
  // to a member's CURRENT standing later. This records the minter's MEMBER
  // id specifically — NULL for a pure legacy web login with no member row —
  // so redemption can re-check it (see redeemTelegramProjectInvite).
  const mintedByMemberId = auth.memberId ?? null

  await env.DB.prepare(
    `INSERT INTO invites (
       id, email, department_id, capability, invited_by, accepted_at, created_at,
       project_id, squad_id, pairing_hash, pairing_expires_at, member_id, minted_by_member_id
     ) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
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
    mintedByMemberId,
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
    `SELECT id, email, project_id, squad_id, capability, accepted_at, pairing_expires_at, member_id, minted_by_member_id
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
  // named error. Every OTHER member-eligibility fact (not found, wrong or
  // NULL tenant, no longer active at claim time) is deliberately left to the
  // atomic MEMBER_BIND_ELIGIBLE_SQL fence below — it re-checks the identical
  // status/tenant/identity facts inside the same claim (exact non-NULL
  // tenant, unlike this pre-check's own collapse shape used purely to avoid
  // a cross-tenant existence oracle), so a mismatch here just means the pre-
  // check found nothing to warn about and the atomic claim refuses instead
  // (generic invalid_or_expired_pairing_code, invite stays unburned). Only
  // the conflict case changes the returned error code, which is why it alone
  // needs a pre-check; the reverse conflict ("this Telegram id already
  // belongs to a different member") is left to the existing
  // UNIQUE(members.telegram_chat_id) catch below — the SAME mechanism the
  // net-new path already relies on, not a second copy.
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

  // mupot#1411 P2 round 5, reshaped round 6 (kasra-review adversarial
  // addendum on Athena gate `efdb0b08`): an invite's capability must not
  // outlive the MINTER's own authority to have minted it — and, for the
  // member-bind path specifically, the TARGET's standing must not have
  // grown past the minter's either. An owner mints an 'admin' bind invite,
  // is then demoted (or suspended) — up to 7 days later
  // (MAX_INVITE_LIFETIME_SECONDS) redemption used to still grant 'admin'
  // with no re-check of who authorized it. The MINTER-side re-check below
  // only runs when minted_by_member_id is non-NULL: a pure legacy
  // web-login minter (no member row) has an IMMUTABLE role-plane rank in
  // this schema (no route ever changes users.role), so there is nothing to
  // re-check for them — and no regression, since that was already true
  // before this column existed.
  //
  // mupot#1411 P1-B round 6: the round-5 check alone
  // (`minterRank < capabilityRank(invite.capability)`) missed the BASELINE
  // authority `createProjectInvite` requires to reach EITHER invite shape at
  // all (`actorRank >= admin`, both `hasMemberId` and squad-only branches
  // above) — a minter demoted all the way to 'observer' minting an
  // 'observer'-capability invite passed the old check (1 < 1 is false)
  // despite 'observer' never being enough standing to have minted anything
  // through this function in the first place. Re-checking `minterRank >=
  // admin` unconditionally closes it for both invite shapes.
  //
  // mupot#1411 P1-A round 6, split round 7 (kasra-review adversarial gate
  // on `dd9a7d52`): the round-5 check never re-derived the TARGET's
  // standing for the member-bind path — a member-bind invite minted for a
  // nobody, where the target is promoted to org owner any time within the
  // invite's (up to 7-day) lifetime, still bound on redemption even though
  // `exceedsTargetRankCeiling` would refuse the identical action taken as
  // a fresh request. Round 6 gated the fix on `minted_by_member_id !==
  // null` alongside the minter-side re-check — but the TARGET's standing
  // is D1-derivable regardless of whether the minter is known, and a
  // legacy web-login actor with no member row (`auth.memberId` undefined,
  // `src/auth/index.ts:1367-1385` documents this as production-reachable)
  // mints with `minted_by_member_id` NULL, leaving that exact takeover
  // path open (the net-new path is separately refused at mint for such a
  // principal — `actorRankOnSquad` floors at 0 with no memberId — so
  // member-bind was the one reachable shape). `targetOutgrewMinter` now
  // runs for EVERY member-bind redemption, independent of whether the
  // minter is known: compared against the minter's CURRENT org-local rank
  // when `minted_by_member_id` is non-NULL, or against
  // `capabilityRank('admin')` — the mint-time floor `createProjectInvite`
  // enforces on every minter, known or not — when it is NULL (there is no
  // minter row to have gone above that floor, so the floor itself is the
  // correct comparison). Self-exempt when the minter targets themselves,
  // matching `exceedsTargetRankCeiling`'s own self-exemption (only
  // meaningful when the minter is known — a NULL minter can never equal
  // the target).
  //
  // mupot#1411 P2 round 6: the net-new (`email`) path had NO minter
  // re-check AT ALL — a squad-admin's invite, redeemed after they were
  // suspended or demoted below squad-admin, still minted a fresh member at
  // the invited capability. Applies the SAME active + baseline-rank +
  // capability-ceiling conditions here too, re-derived on the invite's
  // SQUAD (`currentMemberSquadRank` — the authority a net-new mint actually
  // requires, mirroring `actorRankOnSquad`) rather than the org scope —
  // there is no existing identity to take over on this path, so no
  // target-ceiling re-check applies.
  //
  // Known, disclosed residual NOT fixed this round (see PR body "Honest
  // survivors" and the operator runbook): a net-new invite minted at
  // capability 'owner' by a squad owner mints a member whose GLOBAL rank is
  // now 5 — every org admin's `exceedsTargetRankCeiling` on that member
  // (suspend, token mint, capability grant/revoke, Telegram unbind) then
  // refuses, a real behavior change from `main` for that one path. Filed as
  // a follow-up issue rather than fixed here; the fix (only the granting
  // squad owner, or an org owner, can act back) is a broader ceiling-design
  // question than this round's scope.
  let minterRank = 0
  if (invite.minted_by_member_id !== null) {
    const minter = await env.DB.prepare(
      'SELECT status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
    ).bind(invite.minted_by_member_id, env.TENANT_SLUG).first<{ status: string }>()
    const minterActive = minter?.status === 'active'
    minterRank = minterActive
      ? invite.member_id !== null
        ? await currentMemberOrgRank(env, invite.minted_by_member_id)
        : await currentMemberSquadRank(env, invite.minted_by_member_id, invite.squad_id)
      : 0
    const baselineAuthorityLost =
      minterRank < capabilityRank('admin') || capabilityRank(invite.capability) > minterRank
    if (baselineAuthorityLost) {
      return { ok: false, error: 'invite_minter_authority_lost' }
    }
  }
  const targetOutgrewMinter =
    invite.member_id !== null
    && invite.minted_by_member_id !== invite.member_id
    && (await targetMaxRankAcrossScopes(env, invite.member_id))
      > (invite.minted_by_member_id !== null ? minterRank : capabilityRank('admin'))
  if (targetOutgrewMinter) {
    return { ok: false, error: 'invite_minter_authority_lost' }
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

  // MEMBER_BIND_ELIGIBLE_SQL (status, exact non-NULL tenant, Telegram
  // compatibility) is deliberately NOT hand-duplicated here: it is the SAME
  // constant CLAIM_INVITE_SQL's own bind_target EXISTS interpolates, bound
  // with the SAME (memberId, env.TENANT_SLUG, telegram target) values — so
  // this WHERE and that EXISTS can never drift into checking different
  // facts (mupot#1411 Athena F2, round 2). Also stamps `telegram_bound_at =
  // claimedAt` — a value unique to THIS claim (claimTimestamp() mixes in a
  // random suffix) — so downstream statements can require PROOF this exact
  // UPDATE landed, not merely that some past write left a matching state.
  const bindMemberStatement = invite.member_id !== null
    ? env.DB.prepare(MEMBER_BIND_UPDATE_SQL).bind(
      input.telegram_user_id.trim(),
      claimedAt,
      memberId,
      env.TENANT_SLUG,
      input.telegram_user_id.trim(),
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
  // CLAIM_INVITE_SQL's. This is a STAMP check, not a state check (mupot#1411
  // Athena F2, round 2): `telegram_chat_id = ?` would have been satisfied by
  // ANY history that happened to leave that value set — including a member
  // who already carried the redeeming identity from something else entirely
  // — independent of whether bindMemberStatement itself ran, and did so
  // successfully, for THIS claim. `telegram_bound_at = claimedAt` can only be
  // true if bindMemberStatement's own UPDATE (same batch, same transaction)
  // matched MEMBER_BIND_ELIGIBLE_SQL and wrote THIS unique-per-claim value —
  // it is proof of this claim's write, not a fact that could have been true
  // already. Net-new invites are unaffected: the member-INSERT's own UNIQUE
  // constraints already make ITS failure throw (batch-wide rollback), so no
  // analogous silent-0-rows gap exists there.
  const memberBindLandedGuard = invite.member_id !== null
    ? `
       AND ${MEMBER_BIND_LANDED_GUARD_SQL}`
    : ''
  const memberBindLandedParams = invite.member_id !== null
    ? [memberId, claimedAt]
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
        // MEMBER_BIND_ELIGIBLE_SQL's 3 params — the SAME values
        // bindMemberStatement below binds for its own copy of this fragment,
        // captured once in JS so the two can never see different targets.
        invite.member_id,
        env.TENANT_SLUG,
        input.telegram_user_id.trim(),
      ),
      bindMemberStatement,
      // mupot#1411 P2-E round 4: ON CONFLICT DO UPDATE instead of a bare
      // INSERT — a pre-existing grant on the invited squad no longer throws
      // (batch-wide rollback, permanent redemption_failed); it is upgraded
      // to the HIGHER of the two ranks via RANK_SQL_CASE, NEVER downgraded
      // (an existing 'admin' redeeming an 'observer' invite keeps 'admin')
      // and never exceeding the invite's own capability (which was already
      // capped at mint time to <= the minter's own rank in
      // createProjectInvite above — 'cannot_grant_above_own_rank' — so this
      // can never smuggle a grant past the minter's ceiling). When the
      // SELECT's WHERE (the claim fence + bind-landed guard) is false, zero
      // source rows means the INSERT never fires and ON CONFLICT never
      // triggers either — a failed claim touches no pre-existing row.
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         SELECT ?, ?, 'squad', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE id = ? AND accepted_at = ?
          )${memberBindLandedGuard}
         ON CONFLICT (member_id, scope_type, scope_id) DO UPDATE SET capability =
           CASE WHEN ? > ${RANK_SQL_CASE('capabilities.capability')}
                THEN excluded.capability
                ELSE capabilities.capability
           END`,
      ).bind(
        grantId, memberId, invite.squad_id, invite.capability, invite.id, claimedAt,
        ...memberBindLandedParams,
        capabilityRank(invite.capability),
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
