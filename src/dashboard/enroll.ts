// mupot — seat enrollment page (GET /enroll, POST /enroll/mint).
//
// The pot already supports many keys per person and per seat (`member_tokens`
// has no unique constraint on (member_id, agent_id); `label` is the seat name
// since migrations/0002_members.sql). What was missing is a single page that
// lets a signed-in human CHOOSE an agent they may act as and COIN a
// workspace-channel key labelled with this seat — plus any MCP refusal that
// cannot resolve identity pointing HERE instead of dying as prose.
//
// This module is the seat-aware sibling of src/dashboard/agent-token.ts:
//   loadEnrollView(...)     → signed-in human + seat + consentable agents + live keys
//   enrollPageBody(...)     → HTML (GET /enroll)
//   enrollMintedBody(...)   → HTML (show-once after POST /enroll/mint)
//   enrollUrl(...)          → the one absolute URL every MCP dead-end links to
//
// The route handlers live in src/dashboard/index.ts. Minting goes through the
// SAME mintAgentBoundToken helper that POST /admin/agent-token/mint and
// mint_agent_token use — never a second write path, never hand-rolled SQL
// against member_tokens. Authorization is the SAME bar mint_agent_token
// enforces: operator principal + admin on the target agent's squad.
//
// Eligibility for the picker is the OAuth consent rule (listConsentableAgents):
// active agent, agent_member_bindings row, human holds admin on its squad.
// Do not invent a looser list.

import { html, raw as honoRaw } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { canOnSquad, isOrgAdmin } from '../auth/capability'
import { describeOrgStanding } from '../auth/refusal'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { resolveHumanMemberId } from '../members/resolve-human-member'
import {
  listConsentableAgents,
  resolveHumanStandingGrants,
  type ConsentableAgent,
} from '../mcp/oauth-authorize'
import { mcpEndpoint, mcpServerKey } from './connect'

export const DEFAULT_ENROLL_SEAT = 'unnamed-seat'

export interface EnrollLiveKey {
  label: string
  channel: string
  created_at: string
}

export interface EnrollAgent extends ConsentableAgent {
  liveKeys: EnrollLiveKey[]
}

export interface EnrollView {
  principal: string
  memberId: string | null
  seat: string
  preselectedAgent: string | null
  agents: EnrollAgent[]
}

export async function resolveEnrollMemberId(env: Env, auth: AuthContext): Promise<string | null> {
  if (auth.boundAgentId) return null
  return auth.memberId ??
    auth.webSessionMemberId ??
    (auth.email
      ? await resolveHumanMemberId(env, { tenant: env.TENANT_SLUG, email: auth.email })
      : null)
}

/** Absolute enrollment URL, built in exactly one place. Optional seat is
 *  query-encoded; omit or blank → `/enroll` with no guess. */
export function enrollUrl(origin: string, seat?: string | null): string {
  const base = origin.replace(/\/+$/, '')
  const trimmed = (seat ?? '').trim()
  if (!trimmed) return `${base}/enroll`
  return `${base}/enroll?seat=${encodeURIComponent(trimmed)}`
}

/** Seat label for the form: honour `?seat=` when present, otherwise an honest
 *  default — never a guessed harness name. Capped at 64 (member_tokens.label). */
export function normalizeEnrollSeat(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().slice(0, 64)
  return trimmed.length > 0 ? trimmed : DEFAULT_ENROLL_SEAT
}

/** Paste-ready Cursor/Claude MCP JSON. Reuses connect.ts endpoint + server-key
 *  helpers. Always a `<MEMBER_TOKEN>` placeholder — the raw is shown once
 *  beside this snippet, never woven into it. The seat header is the point. */
export function enrollClientSnippet(slug: string, origin: string, seat: string): string {
  const key = mcpServerKey(slug)
  return JSON.stringify(
    {
      mcpServers: {
        [key]: {
          type: 'http',
          url: mcpEndpoint(origin),
          headers: {
            Authorization: 'Bearer <MEMBER_TOKEN>',
            'x-mupot-seat': seat,
          },
        },
      },
    },
    null,
    2,
  )
}

/**
 * Same authorization mint_agent_token enforces (src/mcp/provision.ts):
 *   - an agent-bound caller is refused (operator_principal_required)
 *   - the caller must hold admin on the target agent's squad (org/dept inherit)
 *
 * This page is a convenience surface. It must never mint what mint_agent_token
 * would refuse.
 *
 * ── THE SQUAD-ADMIN vs ORG-ADMIN DELTA, AS A DECISION (not an oversight) ──────
 *
 * Three doors mint the same artifact and they do NOT agree on the bar:
 *
 *   mint_agent_token (MCP)        squad admin on the target agent's squad
 *   POST /enroll/mint (here)      squad admin on the target agent's squad
 *   POST /admin/agent-token/mint  isOrgAdmin
 *
 * This route deliberately matches the MCP primitive, not its dashboard sibling.
 * The reasoning, recorded so nobody has to re-derive it from a diff:
 *
 *   1. The looser-looking bar is the ALREADY-REACHABLE one. A squad admin who
 *      can mint via mint_agent_token today gains no new power from this page —
 *      it is the same capability behind a form instead of a tool call. Gating
 *      the page at org admin would not close a hole; it would only push the
 *      same person back to the MCP tool to do the identical thing, which is how
 *      you teach people to route around the surface you can see.
 *   2. The org-admin bar on /admin/agent-token is an over-restriction of ONE
 *      surface, not the pot's intended policy. Treating it as the policy would
 *      mean the MCP tool has been over-permissive since it shipped — a much
 *      larger claim, and one no gate has made.
 *   3. Squad admin is not a weak scope here: the grant the minted token records
 *      is hard-clamped to squad scope and capability <= 'member'
 *      (prepareAgentBoundTokenMintForBinding, "THE ESCALATION GUARD"). A squad
 *      admin minting on their own squad cannot manufacture authority they do
 *      not already hold.
 *
 * If the intended policy is in fact org admin everywhere, the fix is to raise
 * mint_agent_token — the primitive — and let both dashboard routes inherit it.
 * Do not raise this route alone: that re-creates the divergence in the other
 * direction and leaves the tool as the soft path.
 *
 * Reviewed by Athena, 2026-09-01 (adversarial pass on PR #1254): "NO widening
 * beyond mint_agent_token's bar ... that bar is an over-restriction of one
 * surface; enroll matches the MCP primitive."
 */
/** The standing of the principal whose AUTHORITY is being honoured.
 *
 *  The fourth gate's one-line diagnosis of the previous version: it moved the gate's join
 *  key to email without moving the authority's join key with it. `auth.capabilities` is
 *  loaded by `resolveCapabilities(memberId)` where memberId is
 *  `webSessionMemberId ?? resolveHumanMemberId(email)` (src/auth/index.ts:1072-1084), and
 *  `webSessionMemberId` comes from `human_login_identities` — deliberately NOT the display
 *  email. When those resolve different rows, an email-keyed status check reads a member who
 *  never granted anything, and the suspended one who did walks through.
 *
 *  So ask on whichever plane the authority actually arrived:
 *    - grants (auth.memberId present) -> that member's status, keyed on id;
 *    - users.role alone (no member id) -> email is the only join to members, so use it,
 *      including the owner-alias indirection that exists precisely to map an operator's
 *      login address onto the org owner.
 *
 *  Distinguishing 'none' from 'revoked' remains the point: every rung of
 *  resolveHumanMemberId filters on active status, so it collapses them, and treating that
 *  collapsed null as the bootstrap-owner shape is what made SUSPENSION the way in. */
export type HumanStanding = 'none' | 'active' | 'revoked'

function standingOf(row: { status: string } | null): HumanStanding {
  if (!row) return 'none'
  return row.status === 'active' ? 'active' : 'revoked'
}

export async function humanStandingForSession(env: Env, auth: AuthContext): Promise<HumanStanding> {
  // Plane 1: authority came from this member's grant rows. Key on the same id.
  // No tenant predicate: `members.tenant` ships NULLABLE with a deliberate no-backfill
  // design (migrations/0040), so scoping by tenant here silently misses legacy rows and
  // returns 'none' for a suspended principal — the mupot#1330 shape.
  // Same precedence as resolveEnrollMemberId (enroll.ts:60) — `memberId ?? webSessionMemberId`.
  // They are equal today only because loadAuthFromCookie sets memberId FROM
  // webSessionMemberId when present; one line of drift in either producer and a gate reading
  // the opposite order judges a different member than the one whose grants are used.
  const authorityMemberId = auth.memberId ?? auth.webSessionMemberId
  if (authorityMemberId) {
    const row = await env.DB.prepare(
      `SELECT status FROM members WHERE id = ?1 LIMIT 1`,
    ).bind(authorityMemberId).first<{ status: string }>()
    return standingOf(row)
  }

  // Plane 2: authority is `users.role`, a table with no status column and no member id.
  // Email is the only join. An absent email means no member identity exists to revoke —
  // and refusing there locks out the bootstrap owner this branch exists to serve, on the
  // one shape where they have no other door (a provider that returns no email at all;
  // src/auth/index.ts mints such sessions with email: null).
  const email = auth.email?.trim().toLowerCase()
  if (!email) return 'none'

  // trim() on BOTH sides: lowering only the column while trimming only the input let a
  // stored 'ws@pot.test ' miss and read as 'none'.
  const direct = await env.DB.prepare(
    `SELECT status FROM members WHERE lower(trim(email)) = ?1 LIMIT 1`,
  ).bind(email).first<{ status: string }>()
  if (direct) return standingOf(direct)

  // The owner alias (org_settings.owner_login_emails) maps an operator's login address to
  // the unique org owner and has no members row of its own, so a direct lookup answers
  // 'none' for a suspended owner arriving that way.
  const aliasOwner = await ownerAliasStanding(env, email)
  return aliasOwner ?? 'none'
}

/** Resolve the owner-alias indirection to the org owner's standing, or null when the
 *  address is not an alias. Mirrors ownerAliasMemberId in src/members/resolve-human-member.ts,
 *  which cannot be reused directly because it resolves an id through status-filtered rungs. */
async function ownerAliasStanding(env: Env, email: string): Promise<HumanStanding | null> {
  try {
    const setting = await env.DB.prepare(
      `SELECT value FROM org_settings WHERE key = 'owner_login_emails' LIMIT 1`,
    ).first<{ value: string }>()
    if (!setting?.value) return null
    const parsed: unknown = JSON.parse(setting.value)
    if (!Array.isArray(parsed)) return null
    const aliases = parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
    if (!aliases.includes(email)) return null
    // Mirror uniqueOrgOwnerId (src/members/resolve-human-member.ts:25-39), minus TWO
    // predicates, each for its own reason.
    //
    // status: this function must SEE a suspended owner rather than resolve past them.
    //
    // tenant: 0040 ships members.tenant NULLABLE with no backfill, and the predicate's
    // POLARITY INVERTS on the way from a resolver into a gate. In uniqueOrgOwnerId a
    // missed row means "resolve nobody", which is safe. Here a missed row drops the count
    // from 1 to 0, and a gate that denies on the count then REFUSES the live owner. Same
    // reasoning as the member-id plane above, which is why that one carries no tenant
    // predicate either.
    //
    // The previous version dropped three others as well: tenant, `scope_id IS NULL`, and
    // the uniqueness check. That left the authority resolver answering "the unique active
    // org-scoped owner OF THIS TENANT" while this gate answered "an arbitrary row from a
    // superset", decided by rowid. Same fixture, opposite verdict depending on insertion
    // order — and in the shared-DB shape 0040 defends, a suspended owner of this pot was
    // admitted because an active owner of another tenant sorted first.
    //
    // LIMIT 2 + reject non-unique is deliberate and matches the original: an alias that
    // cannot be resolved to exactly one owner must not grant. Ambiguity fails CLOSED here
    // rather than falling through to the caller's 'none', which admits.
    const owners = await env.DB.prepare(
      `SELECT m.status AS status FROM members m
         JOIN capabilities c ON c.member_id = m.id
        WHERE c.scope_type = 'org'
          AND c.scope_id IS NULL
          AND c.capability = 'owner'
        LIMIT 2`,
    ).all<{ status: string }>()
    const found = owners.results ?? []
    // TWO different decisions, and the previous version collapsed them into one refusal:
    //
    //   2+ owners -> ambiguous. This rung cannot say whose standing the alias inherits,
    //                so it must not vouch. Fail CLOSED.
    //   0 owners  -> the thing being gated does not exist yet. That is the bootstrap
    //                shape, not a revocation, and refusing it locks out exactly the
    //                principal this PR exists to admit (capability.ts:53-55: "the
    //                bootstrap owner has no grant rows at all"). Return null so the
    //                caller's 'none' stands.
    if (found.length >= 2) return 'revoked'
    if (found.length === 0) return null
    return standingOf(found[0])
  } catch {
    // A lagging pot may not have org_settings. Absence of the alias table is not evidence
    // of standing either way, so say "not an alias" and let the caller's 'none' stand.
    return null
  }
}

export async function authorizeEnrollMint(
  env: Env,
  auth: AuthContext,
  squadId: string,
): Promise<{ ok: true } | { ok: false; reason: 'operator_principal_required' | 'principal_revoked' | 'squad_admin_required' }> {
  if (auth.boundAgentId) return { ok: false, reason: 'operator_principal_required' }
  // BOOTSTRAP-OWNER ADMISSION (mupot#1324 adversarial follow-up). An explicit OR
  // alongside the squad-admin bar below, not a replacement for it. `canOnSquad`
  // needs a memberId to load grant rows from, and the bootstrap owner — the case
  // capability.ts:50-52 documents as "no grant rows at all" — usually has no
  // `members` row either, so resolveEnrollMemberId returns null and canOnSquad is
  // evaluated against []. Before this, that principal got 403 squad_admin_required
  // from THIS route while POST /admin/agent-token/mint on the same app admitted
  // them via isOrgAdmin. Two mint surfaces disagreeing about who the owner is was
  // the defect the owner actually hit as "you don't have access" after enroll. A
  // squad admin still does not need an org role; that bar is unchanged below.
  const memberId = await resolveEnrollMemberId(env, auth)
  // ORDER MATTERS, and getting it wrong is how the first pass at this fix shipped a worse
  // hole than the one it closed. `isOrgAdmin` reads auth.capabilities, which the login
  // bridge fills via resolveCapabilities — a bare SELECT on `capabilities` with NO
  // members.status filter (mupot#1335). Admitting on it BEFORE the status gate let a
  // SUSPENDED org admin mint: it closed the suspended squad-admin class and opened the
  // higher-privilege one.
  //
  // Two distinctions this has to keep straight, and a grants-length proxy gets both wrong:
  //   - a MISSING members row is not a suspended one. memberId === null is the documented
  //     bootstrap-owner shape (capability.ts:50-52) — there is no identity to revoke, admit.
  //   - an ACTIVE member with NO capability rows is not suspended either. Reading standing
  //     as "grants.length > 0" would refuse a legacy role='owner' who holds no grant rows,
  //     which is precisely the principal isOrgAdmin exists to protect.
  // So read the status itself rather than any consequence of it.
  // isOrgAdmin's first branch reads auth.role, which comes from `users.role` — a table with
  // NO status column — so members.status has no authority over a users-role owner in any
  // code path. The gate therefore asks about the HUMAN behind the session, status-blind,
  // rather than about a member id the resolver already filtered.
  // A revoked human does not mint, on ANY authority plane. The previous version computed
  // `standing` and then consulted it only inside the isOrgAdmin branch, so the fall-through
  // squad-grant path discarded a 'revoked' verdict it had already calculated: the alias
  // resolver handed the session a DIFFERENT member's grants, resolveHumanStandingGrants
  // approved that member honestly, and the mint returned ok:true for a principal this
  // function had just judged revoked. loadEnrollView honoured the same verdict, so the
  // picker showed zero agents to the very session the mint admitted — the two halves
  // disagreeing, with the privileged half permissive.
  const standing = await humanStandingForSession(env, auth)
  // A DISTINCT reason, not squad_admin_required. The standing gate fires before grants are
  // resolved, so the squad-admin message ("ask an owner to grant you admin there") describes
  // a cause that was never read — and acting on it hands squad admin to a SUSPENDED account,
  // after which the reload still 403s and the operator escalates further. A revoked human
  // and an under-privileged one are different refusals and must not share a reason code on
  // an authz surface.
  if (standing === 'revoked') return { ok: false, reason: 'principal_revoked' }
  if (isOrgAdmin(auth)) return { ok: true }
  // resolveHumanStandingGrants, not raw resolveCapabilities: a member whose
  // members.status has moved to suspended gets [] here even when
  // resolveEnrollMemberId still resolves an id for them, because step 2 of
  // resolveHumanMemberId carries no status filter (mupot#1335). Closes the mint
  // side of that hole without touching the resolver, which is #1335's own fix.
  const grants = memberId ? await resolveHumanStandingGrants(env, memberId) : []
  if (!(await canOnSquad(env, grants, squadId, 'admin'))) {
    return { ok: false, reason: 'squad_admin_required' }
  }
  return { ok: true }
}

// ── per-member mint throttle ──────────────────────────────────────────────────
//
// A brake on a runaway loop, NOT an authorization boundary — CSRF (the
// dashboard-wide Origin check) and squad-admin authz are what actually stop an
// attacker. This only bounds how fast a principal who is already allowed to mint
// can do so, which matters because every mint is a live credential and the page
// is one form submit away from a held-down key.
//
// Keyed on the MEMBER, same reasoning as checkBootstrapSelfRateLimit: an
// IP-keyed limiter is bypassed by rotating IPs, but the member id comes from a
// verified Google identity and cannot be rotated at will. Independent budget
// from that limiter and from the OAuth door's B2 — three different actions, and
// sharing a counter would let one starve another.
//
// The ceiling is 10/hour rather than bootstrap_self's 5 because THIS page's
// stated purpose is enrolling several seats in one sitting (laptop, server,
// cloud) — 5 would refuse a legitimate first setup. 10 still stops a loop dead.
export const ENROLL_MINT_RL_MAX = 10
export const ENROLL_MINT_RL_TTL = 3600 // seconds (1 hour)

/** How long to ask the caller to wait when the counter itself is unreadable.
 *  Short on purpose: a KV blip should cost a minute, not an hour. */
export const ENROLL_MINT_RL_UNAVAILABLE_RETRY = 60 // seconds

export interface EnrollRateLimitResult {
  allowed: boolean
  retryAfter: number
  /** Why it was refused. `unavailable` means the counter could not be read or
   *  written, not that the ceiling was reached — the copy differs and so does
   *  the wait. */
  reason?: 'throttled' | 'unavailable'
}

/**
 * Consumed BEFORE the mint and before the agent is resolved: a refused or
 * malformed attempt is exactly the abuse shape worth throttling, so it burns
 * budget too.
 *
 * FAILS CLOSED on KV trouble, unlike its sibling limiters. The sibling posture
 * is defensible for a read or a bootstrap; it is not defensible here, because
 * every success on this route is a live credential. Failing open would switch
 * the 10/hour brake off precisely during an outage — the window where nobody is
 * watching the graphs — while leaving no trace that the ceiling was skipped.
 * The cost is a refused mint during a KV incident, which is recoverable; an
 * unbounded mint loop is not.
 *
 * Ruled by Athena, 2026-09-01 (PR #1254 caveat 1): "a credential-minting
 * surface must refuse on KV trouble ... fail-open turns the 10/hour brake off
 * during an outage while the authz gate still holds."
 */
export async function checkEnrollMintRateLimit(
  env: Env,
  memberId: string,
): Promise<EnrollRateLimitResult> {
  const key = `enroll-mint-rl:${memberId}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count >= ENROLL_MINT_RL_MAX) {
      return { allowed: false, retryAfter: ENROLL_MINT_RL_TTL, reason: 'throttled' }
    }
    await env.SESSIONS.put(key, String(count + 1), { expirationTtl: ENROLL_MINT_RL_TTL })
    return { allowed: true, retryAfter: 0 }
  } catch {
    return {
      allowed: false,
      retryAfter: ENROLL_MINT_RL_UNAVAILABLE_RETRY,
      reason: 'unavailable',
    }
  }
}

export function enrollThrottledBody(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return html`
<h1>Too many keys, too fast</h1>
<div class="card">
  <p style="margin:0 0 10px;font-size:14px">
    This account has coined ${ENROLL_MINT_RL_MAX} seat keys in the last hour, which is
    the ceiling. Nothing is wrong with your permissions — try again in about
    ${minutes} minute${minutes === 1 ? '' : 's'}.
  </p>
  <p style="margin:0;font-size:14px">
    If you are enrolling a large fleet, mint through
    <code class="inline">mint_agent_token</code> instead of this page; it is the
    same write path without the browser-shaped throttle.
  </p>
</div>
<p style="margin-top:16px"><a href="/enroll">← Back to enrollment</a></p>`
}

/** The fail-closed refusal. Distinct copy from the ceiling case so an operator
 *  reading a 429 can tell an outage from a busy hour without a log dive. */
export function enrollUnavailableBody(retryAfterSeconds: number) {
  return html`
<h1>Cannot coin a key right now</h1>
<div class="card">
  <p style="margin:0 0 10px;font-size:14px">
    The mint rate limit could not be checked, so this page refused rather than
    mint without a ceiling. Your permissions are fine and nothing was created.
    Try again in about ${retryAfterSeconds} seconds.
  </p>
  <p style="margin:0;font-size:14px">
    If this persists, the session store is unhealthy — say so when you report it,
    and use <code class="inline">mint_agent_token</code> in the meantime.
  </p>
</div>
<p style="margin-top:16px"><a href="/enroll">← Back to enrollment</a></p>`
}

export async function loadEnrollView(
  env: Env,
  auth: AuthContext,
  opts: { seat?: string | null; agent?: string | null } = {},
): Promise<EnrollView> {
  const seat = normalizeEnrollSeat(opts.seat)
  const principal = (auth.email && auth.email.trim().length > 0)
    ? auth.email.trim()
    : (auth.memberId ?? auth.userId)
  const memberId = await resolveEnrollMemberId(env, auth)

  // Bootstrap owner (mupot#1324): isOrgAdmin can hold with no `members` row, so a
  // null memberId here is not "unauthorized", it is "no member identity to resolve
  // grants from". Returning [] made the picker render zero agents for the very
  // principal who outranks every squad — the visible half of the same defect that
  // made the mint 403. An org admin sees the full active inventory; everyone else
  // still needs a resolved member.
  // The picker gets the SAME standing gate as the mint. Hardening only the mint left a
  // suspended squad admin able to enumerate the full agent inventory plus each live key's
  // label, channel and created_at through loadLiveKeysForAgents — a smaller hole than
  // minting, but the same principal and the same revocation that was supposed to end it.
  const standing = await humanStandingForSession(env, auth)
  if (standing === 'revoked') {
    return { principal, memberId, seat, preselectedAgent: null, agents: [] }
  }
  const orgAdminWithoutMember = !memberId && !auth.boundAgentId && isOrgAdmin(auth)
  if (!memberId && !orgAdminWithoutMember) {
    return { principal, memberId, seat, preselectedAgent: null, agents: [] }
  }

  const consentable = await listConsentableAgents(env, memberId)
  const liveByAgent = await loadLiveKeysForAgents(env, consentable.map((a) => a.id))
  const want = (opts.agent ?? '').trim()
  const preselectedAgent = want && consentable.some((a) => a.id === want || a.slug === want)
    ? (consentable.find((a) => a.id === want || a.slug === want)?.id ?? null)
    : null

  return {
    principal,
    memberId,
    seat,
    preselectedAgent,
    agents: consentable.map((a) => ({ ...a, liveKeys: liveByAgent.get(a.id) ?? [] })),
  }
}

/** Live (non-revoked, non-expired) keys — never selects token_hash. */
async function loadLiveKeysForAgents(
  env: Env,
  agentIds: string[],
): Promise<Map<string, EnrollLiveKey[]>> {
  const out = new Map<string, EnrollLiveKey[]>()
  if (agentIds.length === 0) return out

  const placeholders = agentIds.map((_, i) => `?${i + 3}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT t.agent_id AS agent_id, t.label AS label, t.channel AS channel, t.created_at AS created_at
       FROM member_tokens t
      WHERE t.tenant = ?1
        AND ${TOKEN_LIVE_PREDICATE('?2')}
        AND t.agent_id IN (${placeholders})
      ORDER BY t.created_at ASC`,
  )
    .bind(env.TENANT_SLUG, nowSqlUtc(), ...agentIds)
    .all<{ agent_id: string; label: string; channel: string; created_at: string }>()

  for (const row of rows.results ?? []) {
    const list = out.get(row.agent_id) ?? []
    list.push({ label: row.label, channel: row.channel, created_at: row.created_at })
    out.set(row.agent_id, list)
  }
  return out
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function enrollPageBody(view: EnrollView, error?: string) {
  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  const emptyState = `
<div class="card">
  <p style="margin:0;font-size:14px;color:var(--muted)">
    You may not act as any agent yet. This page uses the same rule as the
    <a href="/authorize">OAuth consent screen</a>: an agent is selectable only
    when it is active, has an identity binding, and you hold
    <code class="inline">admin</code> on its squad. Ask an org-admin to grant
    that, or open <a href="/authorize">/authorize</a> after they do.
  </p>
</div>`

  const agentCards = view.agents.map((a) => {
    const checked = view.preselectedAgent === a.id ? ' checked' : ''
    const keys = a.liveKeys.length === 0
      ? `<p style="margin:8px 0 0;font-size:13px;color:var(--muted)">No live key for this agent yet.</p>`
      : `<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">
          ${a.liveKeys.map((k) =>
            `<li><code class="inline">${esc(k.label || '(unlabelled)')}</code>
             · ${esc(k.channel)} · ${esc(k.created_at)}</li>`,
          ).join('')}
        </ul>`
    return `
    <label class="card" style="display:block;cursor:pointer;margin-bottom:10px">
      <input type="radio" name="agent_id" value="${esc(a.id)}" required${checked}
        style="margin-right:8px"/>
      <strong>${esc(a.name)}</strong>
      <code class="inline">${esc(a.slug)}</code>
      <span style="color:var(--muted);font-size:13px"> · ${esc(a.squad_name)}</span>
      ${keys}
    </label>`
  }).join('')

  return html`
<div class="crumbs"><a href="/">Overview</a> › Enroll seat</div>
<h1>Enroll a seat key</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px;margin-bottom:20px">
  Choose the agent this harness should act as, then coin a workspace-channel
  key labelled with this seat. One person may hold many keys (laptop, server,
  this cloud seat). If a live key for this seat already exists, pick it
  instead of minting a duplicate.
</p>

${honoRaw(errorHtml)}

<div class="card" style="margin-bottom:18px">
  <h2 style="margin-top:0">Who you are</h2>
  <p style="margin:0 0 12px;font-size:14px">
    Signed in as <strong>${esc(view.principal)}</strong>${honoRaw(
      view.memberId
        ? ` · member <code class="inline">${esc(view.memberId)}</code>`
        : '',
    )}
  </p>
  <form method="post" action="/enroll/mint" autocomplete="off">
    <label>
      Seat
      <input name="seat" value="${esc(view.seat)}" maxlength="64" required
        style="min-width:220px;margin-top:6px" />
    </label>
    <p style="font-size:12px;color:var(--muted);margin:6px 0 0">
      Shown on the key as its <code class="inline">label</code> and sent as
      <code class="inline">x-mupot-seat</code>. Default is
      <code class="inline">${esc(DEFAULT_ENROLL_SEAT)}</code> — correct it if
      this harness has a real name.
    </p>

    <h2 style="margin-top:24px">Choose an agent</h2>
    ${view.agents.length === 0
      ? honoRaw(emptyState)
      : honoRaw(`<div>${agentCards}</div>`)}

    ${view.agents.length === 0
      ? ''
      : honoRaw(`
    <div style="margin-top:16px">
      <button class="btn" type="submit">Coin a key for this seat</button>
      <a href="/members" class="btn secondary sm" style="margin-left:10px">Cancel</a>
    </div>`)}
  </form>
</div>`
}

/**
 * The 403 for a caller who may not mint on this agent's squad.
 *
 * Deliberately NOT orgAdminForbiddenBody: that copy says the action "requires
 * owner or admin at ORG scope" and that "a squad or department grant will not
 * help". Both are false here — this gate is canOnSquad(..., 'admin'), so a squad
 * grant is exactly what unblocks it. Pointing a refused user at an org-scope
 * grant they do not need is the failure #678 records: four round-trips and a
 * redundant grant for someone who already held enough. Name the real scope.
 */
export function enrollForbiddenBody(
  auth: AuthContext,
  agentName: string,
  squadName: string | null,
) {
  const s = describeOrgStanding(auth)
  const where = squadName ? `squad "${squadName}"` : `that agent's squad`
  return html`
<h1>Not allowed</h1>
<div class="card">
  <p style="margin:0 0 10px;font-size:14px">
    You are signed in as <strong>${esc(s.principal)}</strong> — org role
    <code class="inline">${esc(s.role)}</code>.
  </p>
  <p style="margin:0 0 10px;font-size:14px">
    Coining a seat key for <strong>${esc(agentName)}</strong> requires the
    <code class="inline">admin</code> capability on ${esc(where)} — the same bar
    <code class="inline">mint_agent_token</code> enforces. An org-scope grant
    also satisfies it, but it is not required: a squad-scope grant is enough.
  </p>
  <p style="margin:0;font-size:14px">
    Ask an owner or admin on ${esc(where)} to grant you
    <code class="inline">admin</code> there, then reload this page.
  </p>
</div>
<p style="margin-top:16px">
  <a href="/" style="margin-right:16px">← Back to overview</a>
  <a href="/agents">Agents</a>
</p>`
}

/** Show-once page after a successful seat mint. Reuses the agent-token ceremony
 *  (raw in <code class="token">, copy button, no-store is dashboard-wide) and
 *  adds the paste-ready snippet with x-mupot-seat. */
export function enrollMintedBody(
  agentName: string,
  agentSlug: string,
  squadName: string | null,
  raw: string,
  tokenId: string,
  capability: string,
  seat: string,
  snippet: string,
) {
  const scopeLabel = squadName ? `${esc(squadName)} / ${esc(agentName)}` : esc(agentName)
  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/enroll">Enroll seat</a> › Key coined</div>
<h1>Seat key coined</h1>
<div class="card">
  <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
    Bound to <strong>${honoRaw(scopeLabel)}</strong> (slug: <code class="inline">${honoRaw(esc(agentSlug))}</code>) ·
    Seat: <code class="inline">${honoRaw(esc(seat))}</code> ·
    Token ID: <code class="inline">${honoRaw(esc(tokenId))}</code> ·
    Squad grant: <code class="inline">${honoRaw(esc(capability))}</code>
  </p>
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Shown once only.</strong> Copy this token now — it cannot be retrieved again.
    Place it at <code class="inline">~/.fleet/agents/${honoRaw(esc(agentSlug))}.token</code> on the host.
    Never paste it in chat, bus messages, or version control.
  </div>
  <code class="token" id="rawToken">${honoRaw(esc(raw))}</code>
  <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
    <button class="btn secondary sm" onclick="copyToken()">Copy</button>
    <a href="/enroll?seat=${encodeURIComponent(seat)}" class="btn secondary sm">Mint another</a>
    <a href="/members" class="btn secondary sm">Done</a>
    <span id="copyFeedback" style="font-size:13px;color:var(--ok);display:none">Copied!</span>
  </div>
</div>

<div class="card" style="margin-top:18px">
  <h2 style="margin-top:0">Paste-ready MCP config</h2>
  <p style="font-size:14px;color:var(--muted);margin:0 0 12px">
    Replace <code class="inline">&lt;MEMBER_TOKEN&gt;</code> with the token above.
    The <code class="inline">x-mupot-seat</code> header is already set to this seat
    so the harness declares it from the first call.
  </p>
  <pre style="overflow:auto;font-size:13px" id="enrollSnippet">${honoRaw(esc(snippet))}</pre>
</div>
<script>
  function copyToken() {
    const text = document.getElementById('rawToken').textContent.trim();
    navigator.clipboard.writeText(text).then(function() {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline';
      setTimeout(function() { fb.style.display = 'none'; }, 2000);
    });
  }
</script>`
}
