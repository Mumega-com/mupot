// mupot — members component. Humans as first-class network nodes.
//
// A Member is one person. They reach this pot through several channels — their
// own workspace over MCP, IM (Telegram via Hermes), or the web dashboard — all
// resolving to the SAME member_id + capabilities. "Having effect" = acting
// through any channel, gated by capability (the real, fine-grained RBAC).
//
// membersApp — HTTP surface mounted (by the Integrate phase) under its prefix:
//   POST   /invites                      create an invite        (admin on org/dept)
//   POST   /invites/:id/accept           redeem → mint member + capability (mupot#1551:
//                                         no token — identity is proven at login)
//   GET    /members                      list members            (member+)
//   GET    /members/:id                  read one member         (member+)
//   PATCH  /members/:id                  suspend / reactivate    (admin)
//   POST   /members/:id/tokens           mint a scoped token     (admin) → raw ONCE
//   DELETE /members/:id/tokens/:tid      revoke a token          (admin)
//   DELETE /members/:id/telegram         unbind Telegram identity (admin)
//   POST   /members/:id/capabilities     grant / revoke a grant  (admin)
//
// SECURITY DISCIPLINE
//  - Identity is ALWAYS derived server-side (from the session / token / invite).
//    We NEVER trust a member id, email, or capability carried in message text.
//  - Tokens are stored HASHED (SHA-256 hex), never raw. The raw token is returned
//    EXACTLY ONCE at mint and never logged or re-derivable thereafter.
//  - Tenant isolation: the Worker's D1 IS the tenant's pot (one DB per tenant),
//    but we still HARD GUARD AuthContext.tenant === env.TENANT_SLUG so a token
//    minted for another pot can never touch this one.

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type {
  Env,
  AuthContext,
  Member,
  CapabilityGrant,
  Capability,
  CapabilityScopeType,
  ConnectionChannel,
  OrgKind,
} from '../types'

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
import { isMissingWebSessionsTableError } from '../auth/web-sessions'
import { csrf } from 'hono/csrf'
import { assertWritten } from '../lib/receipt'
// The FROZEN capability API — everyone codes against these exact signatures.
import {
  requireCapability,
  capabilityRank,
  actorMaxRankOnScope,
  exceedsTargetRankCeiling,
  currentMemberRankOnScope,
  isOrgAdmin,
} from '../auth/capability'
// Shared token lifecycle — the single mint/revoke path (also used by the dashboard).
// mupot#1551: acceptInvite() no longer mints (Athena's ruling — that is a
// function-boundary invariant now, not a per-caller option), so sha256Hex
// and mintRawToken are no longer imported here at all.
import {
  mintMemberToken,
  revokeMemberToken,
  isChannel as isChannelService,
  upsertCapabilityGrant,
  provisionHomeForMember,
} from './service'
import { createProjectInvite, type CreateProjectInviteError } from './project-invites'
// mupot#1551 slice 1: the SAME live-token predicate every bearer lookup in
// this codebase already shares (see that module's header) — reused here so
// "does this member hold a live token" can never drift into a second,
// differently-worded copy of what "live" means.
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
// mupot#1551 (case-insensitivity gate finding on #1557): the SAME normalizer
// /auth/callback's own email-match check (pendingInviteEmailsMatch) already
// uses — trim + lowercase, matching idx_members_email_lower (0146). Reused
// here rather than re-deriving a second copy that could drift.
import { normalizeInviteEmail } from '../auth/pending-invite-link'
import {
  isAgentAccessCapability,
  removeAgentSquadAccess,
  resolveBoundAgentForMember,
  setAgentSquadAccess,
  type AgentAccessCapability,
  type AgentSquadAccessError,
} from './agent-access'

// The validated invite payload, stashed by the parse middleware so the scope
// extractor (which runs inside requireCapability) can read the target department.
interface ParsedInvite {
  kind: 'legacy' | 'project' | 'squad'
  email: string
  /** Bind path only — an existing member to attach a Telegram identity to. */
  member_id: string | null
  department_id: string | null
  project_id: string | null
  squad_id: string | null
  capability: Capability
  expires_in_seconds: number | null
}

type AppEnv = {
  Bindings: Env
  Variables: {
    auth: AuthContext
    inviteBody?: ParsedInvite
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// RFC-5322-lite: good enough to reject obvious garbage; the real verification is
// the OAuth perimeter, not this regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function isEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v)
}

const CAPABILITIES: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']
function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v)
}

const SCOPE_TYPES: readonly CapabilityScopeType[] = ['org', 'department', 'squad']
function isScopeType(v: unknown): v is CapabilityScopeType {
  return typeof v === 'string' && (SCOPE_TYPES as readonly string[]).includes(v)
}

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". Map those to 409 rather than 500.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

// A raw bearer is returned exactly once on the two mint paths below. Keep that
// response out of browser/edge caches and prevent a subsequent navigation from
// forwarding its URL as a Referer.
//
// Exported (mupot#1436 round 2, WARN-A) so the public web invite-landing page
// (src/dashboard/invite.ts) can apply the SAME headers to every /invite/:id
// response instead of growing its own copy — that page never returns a raw
// token in the body, but it is the same sensitive-redemption threat model
// (an unauthenticated, unguessable-id-gated mint) and belongs behind the same
// no-store/no-referrer floor.
export function protectRawTokenResponse(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
}

function agentAccessErrorResponse(
  c: Context<AppEnv>,
  error: AgentSquadAccessError,
): Response {
  if (error === 'agent_not_found' || error === 'squad_not_found') {
    return c.json({ error }, 404)
  }
  if (error === 'receipt_failed') {
    return c.json({ error }, 500)
  }
  return c.json({ error }, 409)
}

interface InviteRow {
  id: string
  email: string
  department_id: string | null
  project_id: string | null
  squad_id: string | null
  pairing_hash: string | null
  pairing_expires_at: string | null
  capability: Capability
  invited_by: string | null
  // mupot#1551 slice 1: 0154's minter-identity column. Plain-invite producers
  // (POST /invites, team_bootstrap) never set this — only the Telegram/project
  // door (createProjectInvite) does — so it is NULL on every row this function
  // ever redeems today. Selected anyway so `invited_by`'s own documented
  // ambiguity (memberId OR a pure-login userId, src/members/project-invites.ts:661)
  // has a real fallback the moment a future producer starts setting it, instead
  // of silently reading undefined.
  minted_by_member_id: string | null
  accepted_at: string | null
  created_at: string
}

// mupot#1551 slice 1: the inviter re-check predicate — a plain boolean fact
// ("does a row for this member id exist, active, in this tenant") re-used
// VERBATIM in two places: the JS pre-check below (fails fast, before the
// invite is ever claimed) and the capabilities INSERT's own guard at write
// time (closes the race between that pre-check and the write landing — e.g.
// the inviter is suspended in the interval). Same discipline as
// MEMBER_BIND_ELIGIBLE_SQL / redeemTelegramProjectInvite
// (src/members/project-invites.ts) — one exported string, never a second
// hand-copy that can drift. NULL tenant is legacy-row-belongs-to-this-pot,
// the same convention every other tenant check in this file already uses.
export const INVITER_ACTIVE_MEMBER_SQL = "id = ? AND status = 'active' AND (tenant = ? OR tenant IS NULL)"

// ── app ──────────────────────────────────────────────────────────────────────

export const membersApp = new Hono<AppEnv>()

membersApp.get('/health', (c) =>
  c.json({ ok: true, component: 'members', tenant: c.env.TENANT_SLUG }),
)

// Hard tenant guard, applied to every authenticated route. The capability
// middleware enforces fine-grained RBAC; this floor stops a misrouted/stolen
// token from another pot before any capability is even resolved.
//
// NOTE: /invites/:id/accept is deliberately OUTSIDE this guard — it is redeemed
// by the unguessable invite id (the redemption secret), not by a session, so a
// brand-new member with no token yet can accept. It is registered before the
// guard middleware below.

// ── invites/accept (public redemption — no session, no tenant guard) ──────────
// Registered FIRST so the global requireAuth guard does not intercept it.

interface AcceptInviteBody {
  display_name?: unknown
  telegram_chat_id?: unknown
}

// ── shared accept logic (mupot#1436 A1) ────────────────────────────────────
//
// Extracted out of the POST /invites/:id/accept handler below so the public
// web invite-landing page (GET/POST /invite/:id, src/dashboard/invite.ts) can
// redeem a legacy invite through the EXACT SAME write path — no second copy
// of the claim/mint/rollback SQL. Only the display name is caller-supplied;
// the email always comes from the invite row (server-trusted).

export interface AcceptInviteSuccess {
  member_id: string
  email: string
  capability: { scope_type: CapabilityScopeType; scope_id: string | null; capability: Capability }
  // mupot#1551 (Athena's ruling, 2026-09-26): acceptInvite is a PUBLIC,
  // id-only redemption — it never has proof the caller controls
  // `invite.email`, so it must never be able to hand back a bearer for it.
  // That is now a FUNCTION-BOUNDARY invariant, not a per-caller option (the
  // former `mintToken` flag is gone — every caller on main already passed
  // `false` or relied on a default that had zero live true-callers). Always
  // `null`; identity is proven at login instead (resolveHumanMemberId links
  // this member by e-mail on first sign-in, same steal-protection the web
  // door's pending-invite marker gives its own flow). A future AUTHENTICATED
  // minter belongs on its own function (mintMemberToken, service.ts) — never
  // grafted back onto this one.
  token: null
}

export type AcceptInviteError =
  | 'invite_not_found'
  | 'project_invite_requires_telegram'
  | 'invite_already_accepted'
  | 'member_already_exists'
  // mupot#1436 round 2 WARN-B: server-side cap, enforced HERE so every caller
  // (JSON API, web invite-landing form) inherits the same limit rather than
  // each re-implementing (and potentially forgetting) its own.
  | 'invalid_display_name'
  // mupot#1551 slice 1: the INVITER's authority, re-checked fresh from D1 at
  // redemption — not the mint-time snapshot. Covers all three of: no known
  // inviter (invited_by AND minted_by_member_id both NULL — a D1-inserted
  // row with no server-derived actor at all), the inviter no longer an
  // active member of this tenant, the inviter no longer admin-or-better on
  // the invite's own scope, and an invite capability above what the inviter
  // could grant on that scope TODAY.
  | 'invite_inviter_no_longer_authorized'

export type AcceptInviteResult =
  | { ok: true; value: AcceptInviteSuccess }
  | { ok: false; error: AcceptInviteError }

/**
 * Redeem a web invite: mint the member, capability grant and (optionally)
 * workspace token atomically. A Telegram/project invite (pairing_hash or
 * pairing_expires_at set) is refused here — those redeem only through the
 * authenticated Hermes webhook (redeemTelegramProjectInvite, project-invites.ts).
 * A3: a plain squad invite (squad_id set, pairing columns NULL) grants the
 * human-plane squad capability through this same writer — not a hand-rolled
 * memberships insert. #1161 setSquadMembership is the agent-plane writer and
 * cannot bind a freshly minted human (no agent_id).
 */
/** Telegram/project door. Any one conjunct is enough — legal D1 rows cannot
 *  isolate them, so callers and WARN-D tests go through this helper. */
export function isTelegramDoorInvite(invite: {
  pairing_hash: string | null
  pairing_expires_at: string | null
  project_id: string | null
}): boolean {
  return (
    invite.pairing_hash !== null
    || invite.pairing_expires_at !== null
    || invite.project_id !== null
  )
}

export async function acceptInvite(
  env: Env,
  inviteId: string,
  displayName: string,
): Promise<AcceptInviteResult> {
  const invite = await env.DB.prepare(
    `SELECT id, email, department_id, project_id, squad_id, pairing_hash,
            pairing_expires_at, capability, invited_by, minted_by_member_id,
            accepted_at, created_at
       FROM invites WHERE id = ? LIMIT 1`,
  )
    .bind(inviteId)
    .first<InviteRow>()

  if (!invite) return { ok: false, error: 'invite_not_found' }
  // A3-1: pairing_hash or pairing_expires_at is the Telegram door. A3-2:
  // project_id without a web project-bind path stays 409 (filed separately).
  // squad_id alone is a web accept after 0156.
  if (isTelegramDoorInvite(invite)) {
    return { ok: false, error: 'project_invite_requires_telegram' }
  }
  if (invite.accepted_at) return { ok: false, error: 'invite_already_accepted' }

  // WARN-B: cap + validate BEFORE any mutation — a name that fails this check
  // must not flip accepted_at or spend the invite. 120 matches the web form's
  // (advisory, client-side-only) maxlength; this is the enforcement.
  const trimmedDisplayName = displayName.trim()
  if (!trimmedDisplayName || trimmedDisplayName.length > 120) {
    return { ok: false, error: 'invalid_display_name' }
  }

  // A3-2: squad-first. The grant is the same capabilities INSERT this
  // function already owns for org/department — not a memberships-table
  // write (that table is the #1161 agent plane). Computed here (not just
  // before the mint below) because the inviter re-check right after needs
  // the invite's own scope to ask "admin-or-better on THIS scope", not some
  // other one.
  const scopeType: CapabilityScopeType = invite.squad_id
    ? 'squad'
    : invite.department_id
      ? 'department'
      : 'org'
  const scopeId: string | null = invite.squad_id ?? invite.department_id

  // mupot#1551 slice 1 — re-check the INVITER at redemption, mirroring
  // redeemTelegramProjectInvite's own minter re-check (project-invites.ts
  // ~L862-905): an invite's authority to grant a capability is only as good
  // as the inviter's CURRENT standing, re-derived fresh from D1 the moment
  // the invite is actually spent — up to 7 days stale otherwise (suspended
  // since, demoted since, or a row a script inserted with no real actor
  // behind it at all). Runs BEFORE any mutation (same WARN-B discipline as
  // the display-name check above) so the common case never even claims the
  // invite; the capabilities INSERT below re-asserts the identical
  // INVITER_ACTIVE_MEMBER_SQL fact as defense-in-depth against the narrow
  // race between this check and that write landing (same shape as PR #1550
  // round 2's verified-identity re-check — a dropped pre-check there still
  // got caught at write time, just as a 500 instead of a clean 409; that is
  // the accepted trade-off for the sliver of cases this JS check cannot
  // itself close).
  //
  // invited_by is documented as ambiguous — auth.memberId ?? auth.userId at
  // mint time (POST /invites) — so a pure legacy web login with no member
  // row leaves invited_by holding a `users.id`, not a `members.id`; that
  // case is indistinguishable here from "no member row" and is refused the
  // same way (fail closed, never treated as elevation). minted_by_member_id
  // is the unambiguous fallback 0154 added for exactly this gap; plain
  // invites never set it today (see InviteRow's comment above), so this is
  // forward-looking, not dead code — the moment a producer starts setting
  // it, this re-check picks it up with no further change.
  const inviterId = invite.invited_by ?? invite.minted_by_member_id
  if (inviterId === null) {
    return { ok: false, error: 'invite_inviter_no_longer_authorized' }
  }
  const inviter = await env.DB.prepare(`SELECT id FROM members WHERE ${INVITER_ACTIVE_MEMBER_SQL} LIMIT 1`)
    .bind(inviterId, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (!inviter) {
    return { ok: false, error: 'invite_inviter_no_longer_authorized' }
  }
  const inviterRank = await currentMemberRankOnScope(env, inviterId, scopeType, scopeId)
  if (inviterRank < capabilityRank('admin') || capabilityRank(invite.capability) > inviterRank) {
    return { ok: false, error: 'invite_inviter_no_longer_authorized' }
  }

  // Mint the member. The email comes from the INVITE (server-trusted), never a
  // caller-supplied value — callers only ever supply the display name.
  const member: Member = {
    id: crypto.randomUUID(),
    email: invite.email,
    display_name: trimmedDisplayName,
    telegram_chat_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
  }

  // mupot#1551 (#1557, option A): NO raw token, NO hash, NO token id is ever
  // computed on this path — not merely "computed then discarded". A public,
  // id-only redemption must not even hold a raw bearer in memory for an
  // email it has no proof the caller controls. scopeType/scopeId are
  // computed earlier now (see the inviter re-check above), not re-declared
  // here.
  const grantId = crypto.randomUUID()
  const acceptedAt = new Date().toISOString()

  // Atomic redemption: flip accepted_at ONLY if still unaccepted (single-use),
  // then create member + capability + token in the same batch. If the conditional
  // UPDATE changed zero rows, a concurrent accept won the race → 409.
  const claim = await env.DB.prepare(
    'UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL',
  )
    .bind(acceptedAt, inviteId)
    .run()

  // D1 exposes the affected-row count under meta.changes.
  if (!claim.meta || claim.meta.changes === 0) {
    return { ok: false, error: 'invite_already_accepted' }
  }

  try {
    const writes = [
      // mupot#1551 (case-insensitivity gate finding on #1557): members.email's
      // UNIQUE index (0002) is CASE-SENSITIVE, while every member lookup in
      // this codebase matches by lower(email) (idx_members_email_lower,
      // 0146; INVITER_ACTIVE_MEMBER_SQL and RESERVED_INVITE_EMAIL_SQL above;
      // normalizeInviteEmail's own callers). A concurrent write landing an
      // email that differs only by case would sail past the UNIQUE
      // constraint and mint a SECOND row lower(email)-ambiguous with the
      // first. Guarded the same way as the other two writes in this batch —
      // check-then-write in one statement, not a separate SELECT first — so
      // this is closed atomically rather than merely reduced to "usually
      // caught by the case-sensitive UNIQUE, sometimes not".
      env.DB.prepare(
        `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM members WHERE lower(email) = lower(?))`,
      ).bind(
        member.id,
        member.email,
        member.display_name,
        member.telegram_chat_id,
        member.status,
        member.created_at,
        env.TENANT_SLUG,
        member.email,
      ),
      // mupot#1551 slice 1: re-asserts INVITER_ACTIVE_MEMBER_SQL at write time
      // — the SAME fragment (and the SAME inviterId/env.TENANT_SLUG values,
      // captured once in JS above) the pre-check just ran. A 0-row result
      // here (inviter went inactive/left the tenant in the race window
      // between that check and this write) makes the assertWritten calls
      // below throw, landing in the catch and rolling the claim back — see
      // the comment on the re-check above for why this is JS-checked first
      // and SQL-reasserted here rather than the other way around.
      //
      // mupot#1551 (case-insensitivity follow-up): ALSO requires the member
      // row above to actually exist (`id = ?`) — capabilities.member_id is a
      // real FK (0002) into members(id). Without this, a member INSERT the
      // lower(email) guard just above blocked (0 rows) still lets THIS
      // statement attempt to insert a capabilities row pointing at a
      // member.id that was never created, which fails the batch with a raw
      // FOREIGN KEY constraint error instead of the clean, nameable
      // member_already_exists this function exists to return.
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM members WHERE id = ?)
            AND EXISTS (SELECT 1 FROM members WHERE ${INVITER_ACTIVE_MEMBER_SQL})`,
      ).bind(grantId, member.id, scopeType, scopeId, invite.capability, member.id, inviterId, env.TENANT_SLUG),
    ]
    // mupot#1551 (#1557, option A): acceptInvite never inserts into
    // member_tokens — there is no conditional branch left to gate; this
    // route mints a member and a capability grant, nothing else. (The
    // case-insensitivity fix's own FK-safety guard for a member_tokens
    // write no longer applies — there is no such write to guard.)
    // A2: D1 is the callback's authority for which member this accept minted.
    // 0156 allows this stamp on a legacy/plain-squad row; the KV marker's
    // member_id is only a pointer and must not be trusted blind.
    writes.push(
      env.DB.prepare(
        // mupot#1551: same FK-safety guard — invites.member_id is also a
        // real FK (0154) into members(id).
        'UPDATE invites SET member_id = ? WHERE id = ? AND accepted_at IS NOT NULL AND EXISTS (SELECT 1 FROM members WHERE id = ?)',
      ).bind(member.id, inviteId, member.id),
    )
    const acceptWrites = await env.DB.batch(writes)
    // Receipt (#186): every mint row (member + capability, plus the token row
    // when minted) must land before we return `raw`. A 0-row INSERT does not
    // throw on its own; a partial mint would hand out a show-once token bound
    // to a broken identity. Failure → the catch rolls the invite back so the
    // person can retry.
    //
    // mupot#1551: labelled PER-STATEMENT (not one assertBatchWritten call
    // over the whole array) so the catch below can tell "the member row's
    // own lower(email) guard fired" (a real, nameable outcome —
    // member_already_exists) apart from every other write's failure (which
    // stays an unnamed 500, unchanged prior behavior).
    assertWritten(acceptWrites[0], 'invite_accept_mint.member', 1)
    for (let i = 1; i < acceptWrites.length; i += 1) {
      assertWritten(acceptWrites[i], `invite_accept_mint[${i}]`, 1)
    }
  } catch (err) {
    // Roll the invite back so the person can retry (e.g. duplicate email collision
    // on members.email UNIQUE). The conditional claim above already serialized us.
    await env.DB.prepare('UPDATE invites SET accepted_at = NULL, member_id = NULL WHERE id = ?')
      .bind(inviteId)
      .run()
    if (isUniqueViolation(err)) return { ok: false, error: 'member_already_exists' }
    // mupot#1551: the member INSERT's own lower(email) guard produced a
    // 0-row receipt failure (a concurrent case-different email landed
    // between the JS pre-check upstream and this write) — same outcome the
    // pre-existing UNIQUE-violation branch above names, just reached through
    // the guard instead of a case-exact constraint violation.
    if (err instanceof Error && err.message.includes('invite_accept_mint.member')) {
      return { ok: false, error: 'member_already_exists' }
    }
    throw err
  }

  return {
    ok: true,
    value: {
      member_id: member.id,
      // invite.email (InviteRow) is non-null (invites.email NOT NULL); member.email
      // is typed string | null on the shared Member shape (IM-only members carry
      // none), so read it from the invite, not the just-built member row.
      email: invite.email,
      capability: { scope_type: scopeType, scope_id: scopeId, capability: invite.capability },
      token: null,
    },
  }
}

function acceptInviteErrorStatus(error: AcceptInviteError): 400 | 404 | 409 {
  if (error === 'invite_not_found') return 404
  if (error === 'invalid_display_name') return 400
  return 409
}

membersApp.post('/invites/:id/accept', async (c) => {
  const inviteId = c.req.param('id')

  let body: AcceptInviteBody
  try {
    body = (await c.req.json()) as AcceptInviteBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400)

  // Telegram identity is accepted only from the authenticated webhook envelope.
  // The public/browser redemption body is never an identity authority, even when
  // it carries a syntactically valid numeric chat id.
  if (Object.prototype.hasOwnProperty.call(body, 'telegram_chat_id')) {
    return c.json({ error: 'telegram_identity_requires_authenticated_webhook' }, 400)
  }

  if (!isNonEmptyString(body.display_name)) return c.json({ error: 'invalid_display_name' }, 400)
  const displayName = body.display_name.trim()

  // mupot#1551 Option A (defect class: public invite accept minting a bearer
  // for an admin-typed, unverified email — a squatting enabler). This route
  // is redeemed by the invite id alone, with NO proof the caller controls
  // `invite.email` — that proof only exists at IdP login. Handing back a raw
  // workspace bearer here was therefore a credential for an address nobody
  // had verified. Athena's ruling (2026-09-26): this is now a FUNCTION
  // boundary, not a per-caller flag — acceptInvite() itself can never mint a
  // token (the former `mintToken` option is gone entirely; grepped clean on
  // main, no caller ever passed `true`). This route and the dashboard's own
  // /invite/:id door (src/dashboard/invite.ts, the only other caller) both
  // simply get `token: null` back unconditionally.
  //
  // No KV pending-invite marker/cookie is planted here (contrast the web
  // door, which plants one for its own follow-on browser redirect into
  // /auth/login). Two reasons: (1) a JSON/API caller has no browser session
  // for a cookie to attach to, and /auth/login's only intake for that marker
  // is `getCookie(c, PENDING_INVITE_COOKIE)` (src/auth/index.ts) — there is
  // no body/query-param intake an API client could drive today, so handing
  // one back would be a dead value with nothing to consume it; wiring that
  // up is a real feature (its own gate), not part of narrowing this mint.
  // (2) it is not needed for the security property this fix protects: the
  // member row this mints has no `human_login_identities` row yet, so the
  // ORDINARY (non-invite) Google login already binds it by e-mail on first
  // sign-in — resolveHumanMemberId's `NOT EXISTS(human_login_identities)`
  // check (src/members/resolve-human-member.ts) is exactly the same
  // steal-protection the pending-invite marker enforces for the web door,
  // reached here via the plain login path instead of a special-cased one.
  const result = await acceptInvite(c.env, inviteId, displayName)
  if (!result.ok) {
    return c.json({ error: result.error }, acceptInviteErrorStatus(result.error))
  }

  // mupot#1504 (gate round 2, coordinator addendum): this JSON API accept
  // route is a THIRD caller of provisionHomeForMember — a member minted
  // here (no browser, no Telegram — e.g. a CLI or non-browser integration)
  // was otherwise a member with no home until they happened to touch one of
  // the other two channels. Same function, same 'web' channel value as the
  // dashboard's own /invite/:id door (this route mints over the web/API
  // plane, not IM), same receipt table, same idempotent/best-effort
  // contract — never blocks or is reflected in this response either way.
  //
  // Adversarial round 1, P2-a: this call sat before the (now-removed) raw
  // token response so an uncaught rejection could not burn a show-once
  // token. mupot#1551: the route no longer hands one back at all, but the
  // `.catch` stays as defense in depth on top of provisionHomeForMember's own
  // internal never-throws guarantee (src/members/service.ts) — this call
  // must never be allowed to turn a successful accept into a 500.
  await provisionHomeForMember(c.env, result.value.member_id, 'web').catch((err: unknown) => {
    console.error('members/index: provisionHomeForMember rejected unexpectedly (non-fatal)', {
      member_id: result.value.member_id, channel: 'web',
      error_class: err instanceof Error ? err.constructor.name : typeof err, err,
    })
  })

  // mupot#1551: no raw bearer is ever minted on this public, unverified-email
  // path — `token` is always null and `next` tells the caller identity is
  // proven by signing in (Google), not by a value this response carries.
  // protectRawTokenResponse's no-store/no-referrer headers stay: `member_id`
  // and `capability` are still sensitive enough (org structure, who was just
  // invited) to keep off caches and out of a Referer header.
  protectRawTokenResponse(c)
  return c.json(
    {
      member_id: result.value.member_id,
      capability: result.value.capability,
      token: null,
      next: 'sign_in' as const,
    },
    201,
  )
})

// ── global guards for the remaining (session-backed) routes ───────────────────

// CSRF (2026-09-02, adversarial class finding): cookie-authenticated mutations on a
// top-level mount do not inherit dashboardApp's csrf(); SameSite=Lax is site-scoped
// (mumega.com) and does not stop a sibling *.mupot.mumega.com origin, and text/plain
// skips CORS preflight. hono/csrf guards the three CORS-simple content types only —
// its coverage depends on this Worker having NO cors() anywhere. Same convention as tasksApp.
// Registered AFTER /invites/:id/accept on purpose: that route is public token
// redemption (no session), so CSRF is not its threat model and CLI redeems keep working.
membersApp.use('*', csrf())
membersApp.use('*', requireAuth)
membersApp.use('*', async (c, next) => {
  const auth = c.get('auth')
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

// Scope extractors for requireCapability. The frozen middleware resolves the
// caller's grants and checks them against (scopeType, scopeId, min).

/** org-wide scope (typed as base Context to match the frozen requireCapability). */
const orgScope = (_c: Context): { type: CapabilityScopeType; id: string | null } => ({
  type: 'org',
  id: null,
})

// ── invites (create) ──────────────────────────────────────────────────────────

interface CreateInviteBody {
  email?: unknown
  member_id?: unknown
  department_id?: unknown
  project_id?: unknown
  squad_id?: unknown
  capability?: unknown
  expires_in_seconds?: unknown
}

// Creating an invite requires admin. When the invite targets a department, admin
// ON THAT DEPARTMENT suffices; otherwise org-level admin is required. We resolve
// the scope from the parsed body, then delegate the check to requireCapability.
const inviteScope = (c: Context): { type: CapabilityScopeType; id: string | null } => {
  // The frozen requireCapability types its scope arg as (c: Context) => …, so we
  // read our stashed variable through the typed view of the same context.
  const parsed = (c as Context<AppEnv>).get('inviteBody')
  if ((parsed?.kind === 'project' || parsed?.kind === 'squad') && parsed.squad_id) {
    return { type: 'squad', id: parsed.squad_id }
  }
  const dept = parsed?.department_id ?? null
  return dept ? { type: 'department', id: dept } : { type: 'org', id: null }
}

// A pre-middleware that parses + validates the body and stashes it so the scope
// extractor (which runs inside requireCapability, AFTER this) can read the target
// department, and the handler can reuse the parsed body without re-reading it.
const parseInvite: MiddlewareHandler<AppEnv> = async (c, next) => {
  let body: CreateInviteBody
  try {
    body = (await c.req.json()) as CreateInviteBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400)

  // member_id (bind-existing-member path) and a caller-supplied email are
  // mutually exclusive — the target member's own email is derived server-side
  // by createProjectInvite, so a body carrying both is an ambiguous request,
  // not a hint about which one wins.
  const hasMemberId = body.member_id !== undefined && body.member_id !== null
  if (hasMemberId) {
    if (!isNonEmptyString(body.member_id)) return c.json({ error: 'invalid_member_id' }, 400)
    if (body.email !== undefined && body.email !== null) {
      return c.json({ error: 'invalid_invite_scope' }, 400)
    }
  } else {
    if (!isEmail(body.email)) return c.json({ error: 'invalid_email' }, 400)
  }

  // squad_id alone is the plain-squad producer (P1-C / A3). project_id,
  // expires_in_seconds, or member_id still mark the Telegram/project shape.
  const hasProjectFields =
    hasMemberId
    || body.project_id !== undefined
    || body.expires_in_seconds !== undefined

  const capability: Capability =
    body.capability === undefined ? 'member' : (body.capability as Capability)
  if (!isCapability(capability)) return c.json({ error: 'invalid_capability' }, 400)

  if (hasProjectFields) {
    if (body.department_id !== undefined && body.department_id !== null) {
      return c.json({ error: 'invalid_invite_scope' }, 400)
    }
    if (!isNonEmptyString(body.project_id)) return c.json({ error: 'invalid_project_id' }, 400)
    if (!isNonEmptyString(body.squad_id)) return c.json({ error: 'invalid_squad_id' }, 400)
    if (
      typeof body.expires_in_seconds !== 'number'
      || !Number.isInteger(body.expires_in_seconds)
    ) {
      return c.json({ error: 'invalid_expiry' }, 400)
    }
    c.set('inviteBody', {
      kind: 'project',
      // Both casts are guarded above (isEmail / isNonEmptyString) in the
      // branch that reaches them; the ternary's other arm never touches the
      // unchecked value, so this mirrors the existing `capability as
      // Capability` cast just above, guarded by isCapability.
      email: hasMemberId ? '' : (body.email as string),
      member_id: hasMemberId ? (body.member_id as string).trim() : null,
      department_id: null,
      project_id: body.project_id.trim(),
      squad_id: body.squad_id.trim(),
      capability,
      expires_in_seconds: body.expires_in_seconds,
    })
    await next()
    return
  }

  if (body.squad_id !== undefined && body.squad_id !== null) {
    if (body.department_id !== undefined && body.department_id !== null) {
      return c.json({ error: 'invalid_invite_scope' }, 400)
    }
    if (!isNonEmptyString(body.squad_id)) return c.json({ error: 'invalid_squad_id' }, 400)
    const squadId = body.squad_id.trim()
    const squad = await c.env.DB.prepare('SELECT id FROM squads WHERE id = ? LIMIT 1')
      .bind(squadId)
      .first<{ id: string }>()
    if (!squad) return c.json({ error: 'squad_not_found' }, 404)
    c.set('inviteBody', {
      kind: 'squad',
      email: body.email as string,
      member_id: null,
      department_id: null,
      project_id: null,
      squad_id: squadId,
      capability,
      expires_in_seconds: null,
    })
    await next()
    return
  }

  let departmentId: string | null = null
  if (body.department_id !== undefined && body.department_id !== null) {
    if (!isNonEmptyString(body.department_id)) {
      return c.json({ error: 'invalid_department_id' }, 400)
    }
    departmentId = body.department_id.trim()
    const dept = await c.env.DB.prepare('SELECT id FROM departments WHERE id = ? LIMIT 1')
      .bind(departmentId)
      .first<{ id: string }>()
    if (!dept) return c.json({ error: 'department_not_found' }, 404)
  }

  c.set('inviteBody', {
    kind: 'legacy',
    // Reaching this branch means hasMemberId was false above, so the isEmail
    // guard in that branch already ran and returned on failure — narrowing
    // just doesn't survive the intervening if/else for TS's flow analysis.
    email: body.email as string,
    member_id: null,
    department_id: departmentId,
    project_id: null,
    squad_id: null,
    capability,
    expires_in_seconds: null,
  })
  await next()
}

const authorizeInvite: MiddlewareHandler<AppEnv> = async (c, next) => {
  const body = c.get('inviteBody')
  // Project invite authorization is enforced by createProjectInvite against both
  // the legacy role plane and the caller's live/resolved squad grants. Keeping it
  // in the service prevents a non-HTTP caller from bypassing the same ceiling.
  if (body?.kind === 'project') {
    await next()
    return
  }
  return requireCapability(inviteScope, 'admin')(c, next)
}

// mupot#1551 slice 2 — the "squatted row" shape: a member row that (a) no
// real human has ever proven ownership of (zero LIVE human_login_identities)
// and (b) someone already holds a live bearer for (>=1 live member_tokens).
// This is the SHAPE mupot#1457/#1550's adversarial gate traced a takeover
// to: mint a member for an arbitrary invited email, hold a token for it,
// then wait for a HIGHER-capability invite to land on the SAME email. #1557
// (merged onto this branch, mupot#1551 option A) closed the SPECIFIC
// mechanism this comment originally described — the public JSON accept
// itself no longer mints ANY token — but the shape it produced (an
// identity-less row someone already holds a live bearer for) can still
// arise other ways (an admin-minted token via POST /members/:id/tokens, a
// Telegram/project bind, a future producer), so refusing a NEW invite onto
// that exact shape (unless the creator is already org-admin — an org-admin
// re-inviting a known operator is not the attack this closes) remains a
// live, useful defense-in-depth rather than dead code for a closed door.
//
// One exported string, reused VERBATIM as both the pre-check's SELECT and
// the creating INSERT's own WHERE guard below — never a second hand-copy.
// `datetime('now')` is inlined (not a bound param) the same way
// src/flight-spine/attestations.ts's simple liveness checks do — no caller
// here needs a frozen/pinned clock.
export const RESERVED_INVITE_EMAIL_SQL = (emailParam: string, tenantParam: string): string => `EXISTS (
    SELECT 1 FROM members m
     WHERE lower(m.email) = lower(${emailParam})
       AND (m.tenant = ${tenantParam} OR m.tenant IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM human_login_identities h
          WHERE h.member_id = m.id AND h.revoked_at IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM member_tokens t
          WHERE t.member_id = m.id AND ${TOKEN_LIVE_PREDICATE("datetime('now')")}
       )
  )`

/** JS-side pre-check (fails fast with a clean 409, before ever attempting the
 *  INSERT) built from the exact same fragment the guarded INSERT re-asserts. */
async function isInviteEmailReserved(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${RESERVED_INVITE_EMAIL_SQL('?1', '?2')} AS reserved`)
    .bind(email, env.TENANT_SLUG)
    .first<{ reserved: number }>()
  return row?.reserved === 1
}

function projectInviteErrorStatus(error: CreateProjectInviteError): 400 | 403 | 404 | 409 {
  if (
    error === 'project_not_found'
    || error === 'project_squad_not_linked'
    || error === 'member_not_found'
  ) return 404
  if (
    error === 'tenant_scope'
    || error === 'forbidden'
    || error === 'cannot_grant_above_own_rank'
    || error === 'member_not_active'
    || error === 'home_scope_not_invitable'
  ) return 403
  if (error === 'pairing_code_collision') return 409
  return 400
}

membersApp.post(
  '/invites',
  parseInvite,
  authorizeInvite,
  async (c) => {
    // Validated + scoped by parseInvite; reuse the stashed body.
    const body = c.get('inviteBody')
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const auth = c.get('auth')

    if (body.kind === 'project') {
      if (!body.project_id || !body.squad_id || body.expires_in_seconds === null) {
        return c.json({ error: 'invalid_invite_scope' }, 400)
      }
      const result = await createProjectInvite(c.env, auth, {
        email: body.member_id ? undefined : body.email,
        member_id: body.member_id ?? undefined,
        project_id: body.project_id,
        squad_id: body.squad_id,
        capability: body.capability,
        expires_in_seconds: body.expires_in_seconds,
      })
      if (!result.ok) return c.json({ error: result.error }, projectInviteErrorStatus(result.error))
      protectRawTokenResponse(c)
      return c.json(result.value, 201)
    }

    // CEILING: cannot invite at a capability above your own rank on this scope
    // (a dept-admin must not mint an 'owner' on their department). P0 fix.
    {
      const { type: scopeType, id: scopeId } = inviteScope(c)
      if (capabilityRank(body.capability) > (await actorMaxRankOnScope(c, scopeType, scopeId))) {
        return c.json({ error: 'forbidden', reason: 'cannot_grant_above_own_rank' }, 403)
      }
    }

    // mupot#1551 slice 2: refuse a new invite onto a squatted row (see
    // RESERVED_INVITE_EMAIL_SQL above for the exact shape and why) unless the
    // creator is already org-admin. Checked here — the non-project branch of
    // THIS handler, the one producer this PR scopes to — not inside
    // parseInvite, which has no `auth` to read the bypass from.
    //
    // team_bootstrap.ts's own per-human invite INSERT (src/org/team-bootstrap.ts
    // ~L917-925) and createProjectInvite's Telegram/project door are separate
    // producers with their own INSERT statements and do NOT run through this
    // handler — this issue's scope documents that gap (PR body) rather than
    // forking a second hand-copy of this check onto either of them.

    // mupot#1551 (case-insensitivity gate finding on #1557): store the SAME
    // normalized form the auth callback will later compare against
    // (normalizeInviteEmail), and refuse outright when a member ALREADY
    // exists whose email matches only by case — never the exact same string.
    // An EXACT-case match is deliberately left to the checks that already
    // own it (RESERVED_INVITE_EMAIL_SQL's org-admin-bypassable refusal right
    // below, or — if neither refuses — the pre-existing case-sensitive
    // members.email UNIQUE at accept time, unchanged). Only a CASE-DIFFERENT
    // match is the actual bug this closes: `members.email`'s UNIQUE index
    // (0002) is case-sensitive, so `ALICE@x.com` sailing past it while
    // `alice@x.com` already exists would mint a SECOND row — both then
    // ambiguous to every lower(email)-keyed lookup in this codebase
    // (idx_members_email_lower/0146, INVITER_ACTIVE_MEMBER_SQL,
    // RESERVED_INVITE_EMAIL_SQL above) — with no bypass, unlike the
    // squatted-row check: letting even an org-admin create this would only
    // fail later, differently, at accept.
    const normalizedEmail = normalizeInviteEmail(body.email)
    const trimmedRawEmail = body.email.trim()
    const caseDifferentMember = await c.env.DB.prepare(
      'SELECT id FROM members WHERE lower(email) = ? AND email != ? LIMIT 1',
    )
      .bind(normalizedEmail, trimmedRawEmail)
      .first<{ id: string }>()
    if (caseDifferentMember) {
      return c.json({ error: 'member_already_exists' }, 409)
    }

    const creatorIsOrgAdmin = isOrgAdmin(auth)
    if (!creatorIsOrgAdmin && (await isInviteEmailReserved(c.env, normalizedEmail))) {
      return c.json({ error: 'invite_email_reserved' }, 409)
    }

    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    // invited_by = the acting principal (member if present, else the web user id).
    const invitedBy = auth.memberId ?? auth.userId

    try {
      // Guarded write — re-asserts the SAME RESERVED_INVITE_EMAIL_SQL fact
      // the pre-check above just read, closing the race between that read
      // and this INSERT landing (someone else's invite squats the row in
      // between). ?8 is the org-admin bypass flag, captured once in JS so
      // this statement and the pre-check can never see different answers to
      // "is the creator org-admin". Stores normalizedEmail, not body.email.
      const result = await c.env.DB.prepare(
        `INSERT INTO invites (id, email, department_id, squad_id, capability, invited_by, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ?8 = 1 OR NOT ${RESERVED_INVITE_EMAIL_SQL('?9', '?10')}`,
      )
        .bind(
          id,
          normalizedEmail,
          body.department_id,
          body.squad_id,
          body.capability,
          invitedBy,
          createdAt,
          creatorIsOrgAdmin ? 1 : 0,
          normalizedEmail,
          c.env.TENANT_SLUG,
        )
        .run()
      if (!result.meta || result.meta.changes === 0) {
        return c.json({ error: 'invite_email_reserved' }, 409)
      }
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'invite_exists' }, 409)
      throw err
    }

    return c.json(
      {
        invite: {
          id,
          email: normalizedEmail,
          department_id: body.department_id,
          squad_id: body.squad_id,
          capability: body.capability,
          invited_by: invitedBy,
          accepted_at: null,
          created_at: createdAt,
        },
      },
      201,
    )
  },
)

// ── members (list / read) ─────────────────────────────────────────────────────

membersApp.get('/members', requireCapability(orgScope, 'member'), async (c) => {
  // #1330 F-B: tenant-scoped — this listed every tenant's members alongside the
  // by-id GET beside it (already scoped by F2). Match legacy NULL-tenant rows
  // too so they still show up, consistent with the F-A adoption-on-write fix.
  const rows = await c.env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE tenant = ?1 OR tenant IS NULL ORDER BY created_at ASC, display_name ASC',
  )
    .bind(c.env.TENANT_SLUG)
    .all<Member>()
  return c.json({ members: rows.results ?? [] })
})

membersApp.get('/members/:id', requireCapability(orgScope, 'member'), async (c) => {
  const id = c.req.param('id')
  // #1330 F2: tenant-scoped — was `WHERE id = ?` alone, letting an admin of
  // tenant A read a tenant-B member's row by id.
  // #1330 gate-followup: match legacy `tenant IS NULL` rows too, matching
  // GET /members just above — a legacy row was listed there but 404'd here,
  // which was incoherent (fail-closed is fine, but the two surfaces must agree).
  const member = await c.env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
  )
    .bind(id, c.env.TENANT_SLUG)
    .first<Member>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)
  return c.json({ member })
})

// ── members (suspend / reactivate) ────────────────────────────────────────────

interface PatchMemberBody {
  status?: unknown
}


// ── TARGET-rank ceiling (#1337), shared by every route that mutates a member ──
//
// The ceilings already in this file guard the capability being GRANTED or
// INVITED AT. None of them looked at what the TARGET already holds, which is the
// #1164/#1169 class: "a rank ceiling guards the grant, not the target."
//
// Three reachable paths, all of which act on a higher-ranked principal:
//   1. POST /members/:id/capabilities action='revoke' — DELETEs by
//      (member_id, scope_type, scope_id) and does NOT filter on capability, so
//      revoking org scope removes an OWNER row wholesale.
//   2. POST /members/:id/capabilities action='grant' with a LOWER capability —
//      upsertCapabilityGrant (src/members/service.ts) is DELETE-then-INSERT on
//      the same key, so granting 'member' to an owner deletes the owner row. The
//      grant ceiling cannot catch this: rank('member') is BELOW the actor's own,
//      so it passes. Demotion slips through the check meant to stop escalation.
//   3. PATCH /members/:id — an org admin could suspend the org OWNER. Since
//      #1330 revokes web sessions on suspend, that lockout is immediate.
//
// ONE helper rather than three copies: a rule that exists in more than one place
// is a rule whose copies eventually disagree, which is the defect class this
// codebase keeps paying for (seat resolution had an HTTP copy and an MCP copy;
// gate eligibility had three).
//
// Rank comparison rather than hasCapability(grants, ...) — deliberately.
// actorMaxRankOnScope combines the fine-grained grants with the coarse auth.role
// plane; a grants-only check would miss an actor whose standing comes from the
// legacy role column.
//
// STRICTLY ABOVE, not at-or-above: an admin removing another admin is ordinary
// administration, and refusing it would break a live path to close a hole that
// is about rank INVERSION, not peers.
//
// mupot#1411 P0-1 (kasra-review, 2026-09-15): this used to compare the target's
// row on the ONE (scopeType, scopeId) an action happened to touch — a target
// who outranked the actor via a DIFFERENT scope (an org owner with nothing on
// THIS squad, say) sailed through. Now uses targetMaxRankAcrossScopes (the
// target's real standing, everywhere) uniformly at all four call sites below
// AND the member-bind invite path (src/members/project-invites.ts), so none of
// them can independently regress back to the narrow, bypassable check.
//
// mupot#1411 N2 round 4 (Athena, 2026-09-15): no longer takes a scope — round
// 4 made the ACTOR side of exceedsTargetRankCeiling global too
// (actorMaxRankAcrossScopes), reasoning that a scope-local actor rank
// compared against a global target rank was two different quantities, and
// added an explicit self-exemption so a principal can never outrank
// themselves regardless.
//
// mupot#1411 A1 round 5 (Athena final-gate, 2026-09-15): round 4's
// globalisation of the ACTOR side was itself the escalation — `actor =
// actorMaxRankAcrossScopes` let an org admin who ALSO held 'owner' on one
// unrelated squad act on every ORG-scope-gated route below (all four call
// sites require `requireCapability(orgScope, 'admin')` first) as though
// their real standing were global rank 5, not the org-scope rank 4 those
// routes actually proved. exceedsTargetRankCeiling's actor side is now
// `actorRankOnScopeFor(env, auth, 'org', null)` — org-scope-local, matching
// what every call site here (and the member-bind invite path) already
// requires before it ever reaches this ceiling. The self-exemption alone is
// what closes N2 (a principal acting on themselves never reaches the
// comparison at all); it survives this fix unchanged. The scope a caller is
// ACTING on still needs its own, separate, scope-local floor (e.g. the grant
// route's `capabilityRank(capability) > actorMaxRankOnScope(c, scopeType,
// scopeId)` "cannot_grant_above_own_rank" check, a few lines below its own
// targetRankCeiling call) — that question is orthogonal to this one and is
// untouched.
async function targetRankCeiling(
  c: Context<AppEnv>,
  targetMemberId: string,
): Promise<Response | null> {
  if (await exceedsTargetRankCeiling(c.env, c.get('auth'), targetMemberId)) {
    return c.json({ error: 'forbidden', reason: 'cannot_affect_higher_rank' }, 403)
  }
  return null
}

membersApp.patch('/members/:id', requireCapability(orgScope, 'admin'), async (c) => {
  const id = c.req.param('id')

  let body: PatchMemberBody
  try {
    body = (await c.req.json()) as PatchMemberBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const status = body.status
  if (status !== 'active' && status !== 'suspended') {
    return c.json({ error: 'invalid_status', allowed: ['active', 'suspended'] }, 400)
  }

  // #1337: an org admin must not suspend (or reactivate) a higher-ranked
  // principal. Since #1330 revokes web sessions on suspend, an unguarded
  // suspend of the org OWNER is an immediate, total lockout of the one
  // principal who could undo it.
  const ceiling = await targetRankCeiling(c, id)
  if (ceiling) return ceiling

  let sessionsRevoked = 0
  const res = status === 'suspended'
    ? await (async () => {
        const nowIso = new Date().toISOString()
        try {
          const [memberUpdate, sessionRevoke] = await c.env.DB.batch([
            // #1330 F2: tenant-scoped, matching the web_sessions UPDATE
            // one line below — was `WHERE id = ?` alone, letting an admin
            // of tenant A suspend/reactivate a tenant-B member by id.
            // #1330 F-A: legacy rows may have tenant IS NULL (0040 adds the
            // column with no backfill). Match NULL rows too and adopt them
            // into this tenant in the same statement — the same lazy
            // backfill reportFleetAgents/getAgentView already perform —
            // so a legacy row is repaired on first touch instead of being
            // invisible to every tenant-scoped write forever.
            c.env.DB.prepare(
              'UPDATE members SET status = ?1, tenant = ?3 WHERE id = ?2 AND (tenant = ?3 OR tenant IS NULL)',
            ).bind(status, id, c.env.TENANT_SLUG),
            c.env.DB.prepare(
              `UPDATE web_sessions SET revoked_at = ?1, revoke_reason = ?2
                WHERE tenant = ?3 AND member_id = ?4 AND revoked_at IS NULL`,
            ).bind(nowIso, 'member_suspended', c.env.TENANT_SLUG, id),
          ])
          sessionsRevoked = Number(sessionRevoke.meta?.changes ?? 0)
          return memberUpdate
        } catch (err) {
          if (!isMissingWebSessionsTableError(err)) throw err
          // #1330 F-A / F-C: same NULL-tenant adoption as the batch path
          // above, pinned for the degraded-schema (missing web_sessions)
          // fallback rung.
          return c.env.DB.prepare(
            'UPDATE members SET status = ?1, tenant = ?3 WHERE id = ?2 AND (tenant = ?3 OR tenant IS NULL)',
          )
            .bind(status, id, c.env.TENANT_SLUG)
            .run()
        }
      })()
    : // #1330 F-A: reactivate path — same NULL-tenant adoption.
      await c.env.DB.prepare(
        'UPDATE members SET status = ?1, tenant = ?3 WHERE id = ?2 AND (tenant = ?3 OR tenant IS NULL)',
      )
        .bind(status, id, c.env.TENANT_SLUG)
        .run()
  if (!res.meta || res.meta.changes === 0) return c.json({ error: 'member_not_found' }, 404)

  return c.json({ member_id: id, status, sessions_revoked: sessionsRevoked })
})

// ── tokens (mint / revoke) ────────────────────────────────────────────────────

interface MintTokenBody {
  label?: unknown
  channel?: unknown
}

membersApp.post('/members/:id/tokens', requireCapability(orgScope, 'admin'), async (c) => {
  const memberId = c.req.param('id')

  // mupot#1411 N1 round 4 (Athena, 2026-09-15): pre-existing, same #1330 F2
  // class as the unbind fence a few lines below — this SELECT was `WHERE id
  // = ?` alone, so a tenant-A admin could mint a token (a credential that
  // authenticates AS the member) for a tenant-B member. Same tenant-collapse
  // predicate as the other reads in this file (exact match OR legacy
  // NULL-tenant row); no write here to adopt the tenant on, unlike suspend/
  // unbind, since this handler never updates the members row itself.
  const member = await c.env.DB.prepare(
    'SELECT id, status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
  )
    .bind(memberId, c.env.TENANT_SLUG)
    .first<{ id: string; status: Member['status'] }>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)

  // #1337: the most severe of the three. Minting a token FOR a member yields a
  // credential that authenticates AS that member, so an unguarded mint lets an
  // org admin (rank 4) obtain owner rank (5). That is vertical privilege
  // escalation, not merely acting on a higher-ranked target.
  const mintCeiling = await targetRankCeiling(c, memberId)
  if (mintCeiling) return mintCeiling

  let body: MintTokenBody
  try {
    body = (await c.req.json()) as MintTokenBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const label = body.label === undefined ? '' : body.label
  if (typeof label !== 'string' || label.length > 64) return c.json({ error: 'invalid_label' }, 400)

  const channel: ConnectionChannel = body.channel === undefined ? 'workspace' : (body.channel as ConnectionChannel)
  if (!isChannelService(channel)) return c.json({ error: 'invalid_channel' }, 400)

  // Shared mint path — raw token returned EXACTLY ONCE; only the hash is persisted.
  const token = await mintMemberToken(c.env, memberId, label, channel)
  protectRawTokenResponse(c)
  return c.json({ token }, 201)
})

membersApp.delete(
  '/members/:id/tokens/:tid',
  requireCapability(orgScope, 'admin'),
  async (c) => {
    const memberId = c.req.param('id')
    const tokenId = c.req.param('tid')

    // Revoke only if the token belongs to this member AND is not already revoked.
    const revoked = await revokeMemberToken(c.env, memberId, tokenId)
    if (!revoked) {
      // Either no such token under this member, or already revoked.
      return c.json({ error: 'token_not_found_or_already_revoked' }, 404)
    }

    return c.json({ token_id: tokenId, revoked: true })
  },
)

// ── Telegram bind (admin unbind) ───────────────────────────────────────────────

// mupot#1411 P0-1(d): a Telegram bind is a credential mint — it lets a chat
// authenticate AS this member (memberForChat, src/im/index.ts) exactly the
// way a member token does. Minting one is already gated behind org admin +
// targetRankCeiling (POST /members/:id/tokens). Prior to this route, NOTHING
// could clear `members.telegram_chat_id` once a member-bind invite set it —
// an irreversible grant, unlike every other credential in this file (tokens
// revoke, capabilities revoke). Same authority as the mint, checked the same
// way: an admin cannot unbind a principal who outranks them either — that
// would itself be an act ON a higher-ranked target.
//
// mupot#1411 P2 round 5 (kasra-review adversarial addendum, 2026-09-15): a
// member-bind invite (project-invites.ts) attaches a Telegram identity to an
// EXISTING member — the person it lands on had no say in it, and until now
// had NO way to detach their OWN identity without going through an org
// admin. Honest framing: unbind is BOTH a remedy for that victim AND, in an
// admin's hands, a takeover-enabler already inside the admin envelope this
// same round's A1/A2 harden — nothing here widens what an ADMIN can do.
// requireAdminOrSelfForTelegramUnbind lets the target unbind THEMSELVES with
// no capability check at all (never a route an org admin needed to gate —
// self-action, same class as N2's self-exemption in exceedsTargetRankCeiling
// below), and falls back to the existing admin + targetRankCeiling path for
// everyone else.
const requireAdminOrSelfForTelegramUnbind: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth')
  if (auth?.memberId && auth.memberId === c.req.param('id')) {
    await next()
    return
  }
  return requireCapability(orgScope, 'admin')(c, next)
}

membersApp.delete(
  '/members/:id/telegram',
  requireAdminOrSelfForTelegramUnbind,
  async (c) => {
    const memberId = c.req.param('id')

    // mupot#1411 P1-A round 4 (kasra-review, 2026-09-15): both statements
    // below were `WHERE id = ?` alone — the exact #1330 F2 class the suspend
    // path above already closed 40 lines up. Reusing that SAME predicate
    // (tenant match OR legacy NULL-tenant row, adopted into this tenant on
    // write) rather than a second hand-written copy: a tenant-A admin could
    // read AND clear a tenant-B member's Telegram binding, and the 404 for
    // "wrong tenant" was indistinguishable from "not bound" / "not found" —
    // an existence oracle across tenants.
    const member = await c.env.DB.prepare(
      'SELECT id, telegram_chat_id FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
    ).bind(memberId, c.env.TENANT_SLUG).first<{ id: string; telegram_chat_id: string | null }>()
    if (!member) return c.json({ error: 'member_not_found' }, 404)
    if (member.telegram_chat_id === null) return c.json({ error: 'telegram_not_bound' }, 404)

    const ceiling = await targetRankCeiling(c, memberId)
    if (ceiling) return ceiling

    const priorTelegramChatId = member.telegram_chat_id
    const actorId = c.get('auth').memberId ?? c.get('auth').userId
    const receiptId = crypto.randomUUID()
    const unboundAt = new Date().toISOString()

    // mupot#1411 A8 round 5 (Athena final-gate, 2026-09-15): the clearing
    // UPDATE and the receipt INSERT used to be two SEPARATE .run() calls — a
    // failure on the receipt side (or a crash between the two calls) would
    // leave the binding cleared with NO durable trace of who did it, exactly
    // the phantom-success class assertWritten exists to catch elsewhere in
    // this file (invite-accept's own mint batch, a few hundred lines up).
    // Batched atomically now (same `DB.batch()` shape the
    // suspend route above already uses for its UPDATE+UPDATE pair) so either
    // both writes land or neither does.
    //
    // The receipt INSERT is `... SELECT ... WHERE changes() = 1` rather than
    // an unconditional VALUES row — the same cross-statement idiom this
    // codebase already uses (migrations 0071/0134/0135's triggers,
    // src/flight-spine/receipts.ts's own atomic-audit guard) to make one
    // statement's write conditional on the row count the PREVIOUS statement
    // in the same transaction actually changed. `changes() = 1` here reads
    // the UPDATE immediately above: a 0-row UPDATE (the TOCTOU race the
    // `telegram_chat_id = ?3` conjunct guards — someone else changed the
    // binding between the SELECT above and now) must not write a receipt
    // that claims a clearing which never happened.
    const [update, insert] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE members SET telegram_chat_id = NULL, telegram_bound_at = NULL, tenant = ?2
          WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) AND telegram_chat_id = ?3`,
      ).bind(memberId, c.env.TENANT_SLUG, priorTelegramChatId),
      c.env.DB.prepare(
        `INSERT INTO telegram_unbind_receipts
           (id, tenant, member_id, actor_id, prior_telegram_chat_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE changes() = 1`,
      ).bind(receiptId, c.env.TENANT_SLUG, memberId, actorId, priorTelegramChatId, unboundAt),
    ])
    if (!update.meta || update.meta.changes === 0) return c.json({ error: 'member_not_found' }, 404)
    // The UPDATE landed (changes === 1), so the conditional INSERT above was
    // guaranteed to fire — assertWritten catches a phantom success (e.g. a
    // future constraint silently no-opping the row) rather than reporting
    // telegram_unbound: true over an unrecorded revocation.
    assertWritten(insert, 'telegram_unbind_receipts.insert')

    return c.json({ member_id: memberId, telegram_unbound: true })
  },
)

// ── capabilities (grant / revoke) ─────────────────────────────────────────────

interface CapabilityBody {
  action?: unknown // 'grant' | 'revoke'
  scope_type?: unknown
  scope_id?: unknown
  capability?: unknown
}

membersApp.post('/members/:id/capabilities', requireCapability(orgScope, 'admin'), async (c) => {
  const memberId = c.req.param('id')

  // mupot#1411 P1 round 5 (kasra-review adversarial addendum, 2026-09-15):
  // pre-existing, same #1330 F2 class the suspend/mint/unbind routes in this
  // file already closed — this SELECT was `WHERE id = ?` alone, letting a
  // tenant-A admin grant or revoke a capability on a tenant-B member. Same
  // tenant-collapse predicate as the other reads here (exact match OR legacy
  // NULL-tenant row); no write here to adopt the tenant on, since a grant/
  // revoke never updates the members row itself.
  const member = await c.env.DB.prepare(
    'SELECT id FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1',
  )
    .bind(memberId, c.env.TENANT_SLUG)
    .first<{ id: string }>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)

  let body: CapabilityBody
  try {
    body = (await c.req.json()) as CapabilityBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const action = body.action === undefined ? 'grant' : body.action
  if (action !== 'grant' && action !== 'revoke') {
    return c.json({ error: 'invalid_action', allowed: ['grant', 'revoke'] }, 400)
  }

  if (!isScopeType(body.scope_type)) return c.json({ error: 'invalid_scope_type' }, 400)
  const scopeType: CapabilityScopeType = body.scope_type

  // scope_id MUST be null for org scope, and a non-empty id for department/squad.
  let scopeId: string | null
  if (scopeType === 'org') {
    if (body.scope_id !== undefined && body.scope_id !== null) {
      return c.json({ error: 'org_scope_takes_no_id' }, 400)
    }
    scopeId = null
  } else {
    if (!isNonEmptyString(body.scope_id)) return c.json({ error: 'invalid_scope_id' }, 400)
    scopeId = body.scope_id.trim()
    // Verify the referenced scope exists in this pot.
    const table = scopeType === 'department' ? 'departments' : 'squads'
    const exists = await c.env.DB.prepare(
      `SELECT id, kind FROM ${table} WHERE id = ? LIMIT 1`,
    )
      .bind(scopeId)
      .first<{ id: string; kind: OrgKind }>()
    if (!exists) return c.json({ error: `${scopeType}_not_found` }, 404)
    // G-FP1b point 4: NO standing grant path into a kind='home' squad OR
    // department except createHomeForMember (the only writer of a home
    // capability row). This is the general grant/revoke API — refuse a home
    // target outright, for BOTH actions, regardless of the caller's own
    // rank. A home department can exist too (resolveHomeDepartmentId in
    // org/service.ts creates one), so the same refusal covers it.
    if (exists.kind === 'home') {
      return c.json({ error: 'home_scope_not_grantable' }, 403)
    }
  }

  const ceiling = await targetRankCeiling(c, memberId)
  if (ceiling) return ceiling

  const boundAgent = await resolveBoundAgentForMember(c.env, memberId)
  if (boundAgent && scopeType !== 'squad') {
    return c.json({ error: 'agent_capability_scope_unsupported' }, 409)
  }

  if (action === 'revoke') {
    if (boundAgent) {
      const outcome = await removeAgentSquadAccess(c.env, {
        agentId: boundAgent.agentId,
        memberId,
        squadId: scopeId as string,
      })
      if (!outcome.ok) return agentAccessErrorResponse(c, outcome.error)
      return c.json({
        member_id: memberId,
        action: 'revoke',
        result: outcome.result,
      })
    }

    // scope_id comparison must treat null correctly (IS NULL vs = ?).
    const res = scopeId === null
      ? await c.env.DB.prepare(
          'DELETE FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id IS NULL',
        )
          .bind(memberId, scopeType)
          .run()
      : await c.env.DB.prepare(
          'DELETE FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id = ?',
        )
          .bind(memberId, scopeType, scopeId)
          .run()
    const removed = res.meta ? res.meta.changes : 0
    return c.json({ member_id: memberId, action: 'revoke', removed })
  }

  // grant
  if (!isCapability(body.capability)) return c.json({ error: 'invalid_capability' }, 400)
  const capability: Capability = body.capability
  let agentCapability: AgentAccessCapability | null = null
  if (boundAgent) {
    if (!isAgentAccessCapability(capability)) {
      return c.json({
        error: 'invalid_agent_capability',
        allowed: ['observer', 'member', 'lead', 'admin'],
      }, 400)
    }
    agentCapability = capability
  }

  // CEILING: cannot grant above your own rank on the target scope (an org-admin
  // must not grant org 'owner'). P1 fix.
  if (capabilityRank(capability) > (await actorMaxRankOnScope(c, scopeType, scopeId))) {
    return c.json({ error: 'forbidden', reason: 'cannot_grant_above_own_rank' }, 403)
  }

  if (boundAgent && agentCapability) {
    const outcome = await setAgentSquadAccess(c.env, {
      agentId: boundAgent.agentId,
      memberId,
      squadId: scopeId as string,
      capability: agentCapability,
    })
    if (!outcome.ok) return agentAccessErrorResponse(c, outcome.error)
    return c.json({
      grant: outcome.grant,
      action: 'grant',
      result: outcome.result,
    }, outcome.result === 'created' ? 201 : 200)
  }

  const grant: CapabilityGrant = {
    member_id: memberId,
    scope_type: scopeType,
    scope_id: scopeId,
    capability,
  }

  const outcome = await upsertCapabilityGrant(c.env, grant)
  return c.json({ grant: outcome.grant, action: 'grant', result: outcome.result }, 201)
})
