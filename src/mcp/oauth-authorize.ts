// mupot — OAuth 2.1 authorize handler.
//
// Implements the Google IdP leg of the authorization flow (mupot.OAUTH_PROVIDER='google').
// Pattern ported from mumega's workers/mcp-dispatcher/src/oauth-authorize.ts with
// mupot-specific simplifications:
//   - No cross-pot identity call — sovereign per-pot: email → mupot's OWN members row.
//   - No tenant provision endpoint — mupot IS the tenant (TENANT_SLUG from env).
//   - No BYOA identity sync — mupot manages its own member_tokens.
//   - Google only (mupot [vars] OAUTH_PROVIDER='google').
//
// Design: Q1(a) — authorize-mints/resolves a member_tokens row:
//   On consent the flow finds-or-creates a `members` row by email, mints a
//   `member_tokens` row for it (channel='directory', agentId=null), and stores
//   {memberId, tokenId} as `props` in the OAuthProvider's completeAuthorization.
//   At /mcp, resolveExternalToken is called with the OAuth bearer — it reads the
//   props from KV and calls resolveCapabilities(env, memberId) fresh each request
//   (no frozen capabilities in props — C2).
//
// Auto-synthesized by the library: /.well-known/oauth-authorization-server,
//   /.well-known/oauth-protected-resource, /token, /register.
// This file handles: /authorize → Google redirect, /oauth/google-callback → render
// consent, /oauth/consent → complete (mupot#903b — agent-bound OAuth sessions, see
// the block above buildAuthContextFromProps and above handleOAuthAuthorize's
// /oauth/consent branch for the full design).

import type { Env, AuthContext, Capability, CapabilityGrant, CapabilityScopeType, ConnectionChannel } from '../types'
import { resolveCapabilities, canOnSquad, hasCapability, capabilityRank } from '../auth/capability'
import { sha256Hex, mintRawToken, resolveAgentMemberBinding } from '../members/service'

// ── OAuth props stored via completeAuthorization ─────────────────────────────
// Encrypted by the library; read back via resolveExternalToken.
// Never freeze capabilities into props — C2 requires live re-resolution each request.
export interface OAuthMemberProps {
  memberId: string
  tokenId: string
  email: string | null
  /**
   * Member-token channel. OAuthProvider-owned seats are `directory`; normal
   * mupot_ member API keys preserve their stored token channel, usually
   * `workspace`. Optional for backwards compatibility with older stored OAuth
   * grants; buildAuthContextFromProps re-reads the live token row before use.
   */
  channel?: ConnectionChannel
  /** The agent weld from member_tokens.agent_id, if this is an agent-bound key. */
  boundAgentId?: string | null
  /**
   * mupot#903b: the HUMAN who consented to bind this directory session to
   * `boundAgentId` — REQUIRED to be present (non-null) whenever boundAgentId is set
   * on a directory-channel token, because `memberId` above is the AGENT's own
   * dedicated member for that case (see mintDirectoryToken), not the human. null
   * for unbound directory sessions and every non-directory channel. Adversarial
   * review (2026-08-10, P0-1/P0-2): without this, capabilities could carry the
   * agent's raw grant unclamped against the human's own rank, and offboarding the
   * human would never affect a session already minted under the agent's identity.
   * See resolveConsentedAgentCapabilities.
   */
  consentedByMemberId?: string | null
}

const CONNECTION_CHANNELS: readonly ConnectionChannel[] = ['workspace', 'im', 'dashboard', 'directory']

function isConnectionChannel(v: unknown): v is ConnectionChannel {
  return typeof v === 'string' && (CONNECTION_CHANNELS as readonly string[]).includes(v)
}

// ── Google OAuth helpers ──────────────────────────────────────────────────────

function googleAuthorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function googleExchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ id: string; name: string; email: string; emailVerified: boolean }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenData.access_token) {
    throw new Error(`Google token exchange failed: ${tokenData.error ?? 'no access_token'}`)
  }

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const user = await userRes.json() as {
    id: string
    name: string
    email: string
    verified_email?: boolean
  }
  if (!user.id) throw new Error('Google userinfo returned no id')
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email ?? '',
    emailVerified: user.verified_email === true,
  }
}

// ── Member find-or-create (sovereign-per-pot) ─────────────────────────────────
// Maps a verified email to a mupot members row. If no member exists for this
// email, one is created with status='active'. If one exists (suspended), it is
// still returned — the authn middleware blocks suspended principals anyway.
// This does NOT carry cross-pot identity; it is local to this pot's D1.
async function findOrCreateMember(
  env: Env,
  email: string,
  displayName: string,
): Promise<string> { // returns member_id
  const existing = await env.DB.prepare(
    'SELECT id FROM members WHERE email = ?1 LIMIT 1',
  ).bind(email).first<{ id: string }>()
  if (existing) return existing.id

  const memberId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
     VALUES (?1, ?2, ?3, NULL, 'active', datetime('now'), ?4)`,
  ).bind(memberId, email, displayName.trim().slice(0, 128) || email, env.TENANT_SLUG).run()

  // ── THE HALF THAT WAS MISSING (mupot#1121, 2026-08-17) ──────────────────────────────
  //
  // Until now this function created an IDENTITY and no ACCESS. The comment further down
  // this file records it as intentional — "C6 zero capabilities" — but the effect is that
  // a verified Google user lands with a members row, zero capability grants, and a 403 on
  // every capability-gated surface. Compare the INVITE path (src/members/index.ts:246),
  // which writes member + capability + token in a single batch. The gates were never the
  // problem; OAuth onboarding was half-implemented.
  //
  // grantSignupDefault reads the tenant's open onboarding door and applies the capability
  // the OWNER configured there. It FAILS CLOSED twice: no open door grants nothing, and an
  // open door with signup_capability NULL grants nothing. Both leave behaviour byte-for-byte
  // as it is today, so merging this cannot open a pot — someone has to set the value.
  //
  // The grant is written with its receipt in one batch, so it reviews, reverses and expires
  // through the same path as everything else that came through the door.
  //
  // Non-fatal by design: a login must not fail because the door lookup did. A user with no
  // capability sees today's behaviour; a hard failure here would lock out every login.
  try {
    const { grantSignupDefault } = await import('../onboarding/doors')
    await grantSignupDefault(env, memberId)
  } catch (err) {
    console.error('oauth: signup default grant failed (non-fatal, member still created)', {
      tenant: env.TENANT_SLUG,
      member_id: memberId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return memberId
}

// ── Token mint for OAuth seat ─────────────────────────────────────────────────
// Mints a member_tokens row for the OAuth seat.
// channel='directory' always — this is what marks the row as issued through the
// public OAuth door (rate-limited registration, consent record) regardless of which
// member it belongs to. agentId=NULL by default (pure human/operator principal, C6
// zero capabilities — unchanged default behaviour); memberId is then the human's own
// member row, exactly as before mupot#903b.
//
// mupot#903b: when the human has explicitly consented to bind the session to one
// agent (POST /oauth/consent, re-validated server-side via memberMayConsentToAgent —
// never trust the client's own claim), the CALLER passes agentId = the chosen agent's
// id AND memberId = that SAME agent's own dedicated member row (agent_member_bindings
// — see the `mintMemberId` derivation at the /oauth/consent call site). It must be the
// agent's own member, never the connecting human's: migration 0071's
// `member_tokens_agent_binding_insert` trigger aborts (`agent_identity_conflict`) any
// INSERT where agent_id IS NOT NULL and (tenant, agent_id, member_id) is not already a
// row in agent_member_bindings, and that table only ever pairs an agent with its own
// weld. This is the exact same identity shape mint_agent_token already uses for
// workspace-channel tokens — only channel differs here (stays 'directory').
//
// Setting member_tokens.agent_id here is what wires this token into deactivate_agent's
// existing revocation sweep (`UPDATE member_tokens SET revoked_at = ... WHERE agent_id
// = ?`, src/mcp/provision.ts) for free — deactivating the agent revokes THIS token too,
// no new code needed for that half of the invariant. The other half (live capability =
// the agent's own binding, zero if the agent is inactive) is enforced in
// buildAuthContextFromProps via resolveConsentedAgentCapabilities below.
async function mintDirectoryToken(
  env: Env,
  memberId: string,
  label: string,
  agentId: string | null = null,
): Promise<{ tokenId: string; tokenHash: string }> {
  const raw = mintRawToken()
  const tokenHash = await sha256Hex(raw)
  const tokenId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
     VALUES (?1, ?2, ?3, ?4, 'directory', datetime('now'), ?5, ?6)`,
  ).bind(tokenId, memberId, tokenHash, label, agentId, env.TENANT_SLUG).run()
  // Raw is intentionally discarded here — the OAuth access token IS the credential;
  // the member_tokens row exists purely for capability resolution and revocation.
  // The raw token is never returned to the caller (it is not the OAuth access token).
  return { tokenId, tokenHash }
}

// ── mupot#903b: consent-time agent selection + capability preview ─────────────
//
// SELECTION RULE (stated once, enforced at BOTH consent-render time — what the
// human is shown to choose from — and consent-submit time — re-validating the
// choice server-side, never trusting the posted agent_id as proof of eligibility):
//
//   A human (memberId) may bind their directory session to agent A iff:
//     1. A is not retired: `agents.status = 'active'`. Tightened relative to
//        resolveAgentRef's slug universe (which also allows 'paused') — a paused
//        agent's binding would resolve to zero capabilities anyway (see
//        resolveConsentedAgentCapabilities below), so offering it as a selectable
//        choice would be a confusing no-op. Excluded outright instead.
//     2. A already has a canonical `agent_member_bindings` row — i.e.
//        `mint_agent_token`/create-then-mint has run for A at least once
//        (src/members/service.ts prepareAgentBoundTokenMintForBinding). An unminted
//        agent has no dedicated member row and therefore no capability set to grant;
//        there is nothing to consent to. Fail closed: excluded, not offered as "zero".
//     3. the human holds `admin`-or-higher capability on A's squad_id, via
//        `canOnSquad` (src/auth/capability.ts) — the SAME primitive `connect
//        { agent_name }` uses for its (much weaker, session-local, non-welding)
//        agent-claim check, but NOT the same floor.
//
//        mupot#903b P0-3 (adversarial review, 2026-08-10, gate decision): this
//        floor was originally 'member', matching connect's floor. That was wrong.
//        `connect` never welds anything — it is `binding: 'session_local'`
//        (src/mcp/index.ts toolConnect) and explicitly tells a non-admin caller to
//        "ask an admin to call mint_agent_token" for anything durable. Consenting
//        HERE writes a REAL member_tokens.agent_id weld (mintDirectoryToken below)
//        — the SAME durable artifact mint_agent_token produces, and
//        mint_agent_token has required 'admin' since it was written, with the
//        rationale stated verbatim at its own gate (src/mcp/provision.ts): "Minting
//        a credential that IS an agent is an org-trust act -> admin, never
//        lead/member." Gating the weld itself at 'member' opened a second, weaker
//        door to the exact same artifact — proven live pre-fix: a human holding
//        only squad-a:member consented to agent-a and could then read + CONSUME
//        agent-a's own inbox messages and SEND on the bus under agent-a's
//        attribution (`inbox`/`send` gate on `auth.boundAgentId` alone, zero
//        capability check — src/mcp/index.ts), with isSelf/presence follow-ons
//        (unredacted orient/connect packets, dispatch-selection injection). This
//        PR does not touch the deeper "boundAgentId alone is enough for inbox/
//        send/isSelf/presence" design — see the note in P2-6 below — it closes
//        the ONE door among several that this PR itself created a second, easier
//        way through.
//
// WHAT THE SESSION ACTUALLY GETS (never the human's own STANDING grants elsewhere,
// never more than the agent holds, AND — since the 2026-08-10 adversarial review,
// P0-1 — never more than the CONSENTING HUMAN holds either): resolveConsentedAgentCapabilities
// resolves capabilities for the CHOSEN AGENT'S OWN dedicated member row
// (agent_member_bindings → a member record created solely for that agent at first
// mint, isolated from the human's own `capabilities` rows by construction — see
// src/members/service.ts), then CLAMPS each grant to min(agent's own rank, the
// consenting human's own live rank on that SAME scope) — setAgentSquadAccess still
// permits an agent-bound member up to 'admin' on a squad OTHER than its own home
// squad (the human's admin-floor grant covers only the CONSENTED agent's home
// squad, per scope, same as before P0-3), so the clamp remains load-bearing for
// multi-scope agents even with the raised floor — see section D's per-scope-drop
// test. Re-run on every live request (C2): an agent deactivated after consent
// immediately loses its grant here (defence in depth alongside the token-revocation
// side effect above), and — P0-2 — so does an OFFBOARDED (or merely DEMOTED BELOW
// ADMIN — P0-3) HUMAN: the consenting human's own status and continued eligibility
// (now 'admin', not 'member') are re-validated on every call too, not just the
// agent's, because the member_tokens row
// this all hangs off of belongs to the AGENT (see mintDirectoryToken below), so the
// ordinary token-liveness check alone never sees the human's side of this at all.

export interface ConsentableAgent {
  id: string
  slug: string
  name: string
  squad_id: string
  squad_name: string
  autonomy: string
  budget_cap_cents: number | null
  budget_window: string
  capabilities: CapabilityGrant[]
}

interface ConsentAgentRow {
  id: string
  slug: string
  name: string
  squad_id: string
  squad_name: string
  autonomy: string
  budget_cap_cents: number | null
  budget_window: string
}

const RANK_ORDER: readonly Capability[] = ['owner', 'admin', 'lead', 'member', 'observer']

/** The human's own live, status-independent rank on ONE scope (org/department/squad
 *  inheritance all honored — same semantics as hasCapability/canOnSquad, just
 *  returning the actual ceiling rank instead of a yes/no against a fixed `min`).
 *  0 = holds nothing there. Used only to CLAMP an agent's grant down to what the
 *  human backing the session can actually reach — never to grant anything itself. */
async function humanMaxRankOnScope(
  env: Env,
  humanGrants: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<number> {
  if (scopeType === 'squad' && scopeId) {
    // canOnSquad resolves department inheritance from D1; walk the ladder top-down
    // and stop at the first rank the human actually clears.
    for (const cap of RANK_ORDER) {
      if (await canOnSquad(env, humanGrants, scopeId, cap)) return capabilityRank(cap)
    }
    return 0
  }
  for (const cap of RANK_ORDER) {
    if (hasCapability(humanGrants, scopeType, scopeId, cap)) return capabilityRank(cap)
  }
  return 0
}

/** Live capabilities a directory session bound to `agentId`, consent-given by
 *  `consentingMemberId`, carries RIGHT NOW.
 *
 *  mupot#903b P0-1 (adversarial review, vertical escalation, 2026-08-10): the
 *  agent's own dedicated member can legitimately hold MORE than 'member' on its
 *  home squad — setAgentSquadAccess (src/members/index.ts) allows granting an
 *  agent-bound member observer/member/lead/admin. The consent-time eligibility
 *  gate (memberMayConsentToAgent) only ever required the HUMAN to hold
 *  'member'-or-higher — it never compared that to what the agent itself holds. A
 *  bare squad-member consenting to an agent that happens to hold squad 'admin'
 *  got that admin rank handed back verbatim: proven live (human=member, agent=
 *  admin) via invokeTool('create_agent') succeeding through the resulting
 *  session. Every grant returned here is now clamped to
 *  min(agent's own rank on that scope, the CONSENTING HUMAN's own live rank on
 *  that SAME scope) — never wider than either side. A scope the human holds
 *  NOTHING on drops the grant entirely rather than clamping to some default —
 *  "fail closed on a missing/ambiguous human grant" per the same review.
 *
 *  mupot#903b P0-2 (adversarial review, one-sided revocation, 2026-08-10):
 *  buildAuthContextFromProps already re-validates the AGENT every request (dead
 *  agent -> zero, below), but because the row's member_id is the agent's OWN
 *  dedicated member (required by 0071's trigger — see mintDirectoryToken), the
 *  member_tokens liveness check upstream only ever re-checks the AGENT's member
 *  row, never the HUMAN's. Offboarding the human (their member.status flips off
 *  'active', or their capability grant on this squad is revoked) previously left
 *  a session minted under the agent's identity fully live. `consentingMemberId`
 *  is re-validated HERE, live, on every call — status AND continued
 *  member-or-higher eligibility on the agent's squad, the exact rule
 *  memberMayConsentToAgent enforced at consent time, re-run every request.
 *
 *  `consentingMemberId` is REQUIRED, not optional: a bound session with no known
 *  consenting human (should never occur via /oauth/consent, which always stamps
 *  it — this guards a hypothetical future producer of a directory+agent_id row,
 *  e.g. resolveExternalToken's D1-only reconstruction, which has no such field to
 *  read) fails closed to [] rather than silently falling back to the agent's
 *  unclamped grant. */
export async function resolveConsentedAgentCapabilities(
  env: Env,
  agentId: string,
  consentingMemberId: string | null,
): Promise<CapabilityGrant[]> {
  if (!consentingMemberId) return []

  // Tenant-scoped via the agent_member_bindings join (agents/squads/departments
  // carry NO tenant column at all in this schema — mupot is one tenant per D1
  // database by construction — but agent_member_bindings, members, and
  // capabilities DO, and this codebase's convention is to scope through them
  // wherever available rather than lean on the org graph's implicit isolation).
  // This single query also folds in what used to be a separate
  // resolveAgentMemberBinding call — same tenant-scoped binding row either way.
  const row = await env.DB.prepare(
    `SELECT a.status AS status, a.squad_id AS squad_id, b.member_id AS bound_member_id
       FROM agents a
       JOIN agent_member_bindings b ON b.tenant = ?2 AND b.agent_id = a.id
      WHERE a.id = ?1
      LIMIT 1`,
  ).bind(agentId, env.TENANT_SLUG).first<{ status: string; squad_id: string; bound_member_id: string }>()
  // Defence in depth: even if some future path flips agents.status without going
  // through deactivate_agent's token-revocation sweep, capability resolution here
  // independently fails closed. 'paused' is deliberately excluded too — see the
  // selection-rule block above.
  if (!row || row.status !== 'active') return []
  const agentGrants = await resolveCapabilities(env, row.bound_member_id)

  // Re-validate the CONSENTING HUMAN, live, every call (P0-2). Floor is 'admin'
  // (P0-3) — the SAME bar mint_agent_token requires to create this class of weld
  // in the first place; a human demoted to 'member' (still eligible under the OLD
  // floor) must lose the session just as completely as one with zero access.
  const human = await env.DB.prepare(
    `SELECT status FROM members WHERE id = ?1 AND tenant = ?2`,
  ).bind(consentingMemberId, env.TENANT_SLUG).first<{ status: string }>()
  if (!human || human.status !== 'active') return []
  const humanGrants = await resolveCapabilities(env, consentingMemberId)
  if (!(await canOnSquad(env, humanGrants, row.squad_id, 'admin'))) return []

  // Clamp every grant to min(agent's own rank, human's own live rank) on that
  // SAME scope (P0-1). Never widen: a scope the human holds nothing on is
  // dropped, not defaulted to the agent's value or to 'observer'.
  //
  // Mutation-check note (2026-08-10, gate correction): the `effectiveRank <= 0`
  // line below is individually an EQUIVALENT MUTANT of the `!clampedCapability`
  // line right after it — RANK_ORDER contains no capability of rank 0
  // (observer=1..owner=5), so `.find(c => capabilityRank(c) === 0)` already
  // returns undefined and the SECOND guard alone drops the grant just as
  // completely. Verified directly: removing only the first line, leaving the
  // second untouched, passes all 65 tests in tests/agent-bound-oauth-consent.test.ts
  // unchanged. The fail-closed BEHAVIOUR (a zero-rank grant is dropped, not
  // defaulted) is real and IS covered — by the second line — this comment exists
  // so nobody reads a future refactor that touches only the first line as
  // removing live protection, and so this file does not misdescribe which line
  // a passing test actually depends on (see this PR's own mutation-table history
  // for why that distinction matters).
  const clamped: CapabilityGrant[] = []
  for (const g of agentGrants) {
    const humanRank = await humanMaxRankOnScope(env, humanGrants, g.scope_type, g.scope_id)
    const effectiveRank = Math.min(capabilityRank(g.capability), humanRank)
    if (effectiveRank <= 0) continue
    const clampedCapability = RANK_ORDER.find((c) => capabilityRank(c) === effectiveRank)
    if (!clampedCapability) continue
    clamped.push({ ...g, capability: clampedCapability })
  }
  return clamped
}

/** The consenting human's OWN live standing grants, status-gated — used ONLY for
 *  `latentCapabilities` on a bound session (never as ambient `capabilities`). Kept
 *  separate from resolveConsentedAgentCapabilities's clamped output: latentCapabilities
 *  is documented (src/types.ts) as "what this member ACTUALLY holds" for the
 *  explicit-named-act escape hatch (`connect`) — it must reflect the HUMAN's own
 *  grants, never the agent's raw unclamped set (that would reopen P0-1 through a
 *  second door: `connect`'s claimGrants falls back to latentCapabilities). */
async function resolveHumanStandingGrants(env: Env, memberId: string): Promise<CapabilityGrant[]> {
  const human = await env.DB.prepare(
    `SELECT status FROM members WHERE id = ?1 AND tenant = ?2`,
  ).bind(memberId, env.TENANT_SLUG).first<{ status: string }>()
  if (!human || human.status !== 'active') return []
  return resolveCapabilities(env, memberId)
}

/** Single-agent eligibility check — used to re-validate a POSTed agent_id server-side. */
async function resolveAgentForConsent(env: Env, agentId: string): Promise<ConsentAgentRow | null> {
  return env.DB.prepare(
    `SELECT a.id AS id, a.slug AS slug, a.name AS name, a.squad_id AS squad_id,
            sq.name AS squad_name, a.autonomy AS autonomy,
            a.budget_cap_cents AS budget_cap_cents, a.budget_window AS budget_window
       FROM agents a
       JOIN squads sq ON sq.id = a.squad_id
       JOIN agent_member_bindings b ON b.tenant = ?2 AND b.agent_id = a.id
      WHERE a.id = ?1 AND a.status = 'active'
      LIMIT 1`,
  ).bind(agentId, env.TENANT_SLUG).first<ConsentAgentRow>()
}

/** Re-validates a client-submitted agent_id against the SAME rule the consent
 *  screen was rendered with. Never trust the posted value as proof of eligibility.
 *  Floor is 'admin' (P0-3, adversarial review 2026-08-10) — matching
 *  mint_agent_token, the only other producer of a member_tokens.agent_id weld. */
export async function memberMayConsentToAgent(env: Env, memberId: string, agentId: string): Promise<boolean> {
  const agent = await resolveAgentForConsent(env, agentId)
  if (!agent) return false
  const humanGrants = await resolveCapabilities(env, memberId)
  return canOnSquad(env, humanGrants, agent.squad_id, 'admin')
}

/** The full selectable list for the consent screen, each with its capability preview
 *  — "a parameter that grants capability without showing it is a phishing surface".
 *  Floor is 'admin' (P0-3) — see memberMayConsentToAgent. */
export async function listConsentableAgents(env: Env, memberId: string): Promise<ConsentableAgent[]> {
  const humanGrants = await resolveCapabilities(env, memberId)
  const rows = await env.DB.prepare(
    `SELECT a.id AS id, a.slug AS slug, a.name AS name, a.squad_id AS squad_id,
            sq.name AS squad_name, a.autonomy AS autonomy,
            a.budget_cap_cents AS budget_cap_cents, a.budget_window AS budget_window
       FROM agents a
       JOIN squads sq ON sq.id = a.squad_id
       JOIN agent_member_bindings b ON b.tenant = ?1 AND b.agent_id = a.id
      WHERE a.status = 'active'
      ORDER BY sq.name ASC, a.name ASC`,
  ).bind(env.TENANT_SLUG).all<ConsentAgentRow>()

  const out: ConsentableAgent[] = []
  for (const row of rows.results ?? []) {
    if (!(await canOnSquad(env, humanGrants, row.squad_id, 'admin'))) continue
    // The preview shows the TRUE clamped result (P0-1) — `memberId` here IS the
    // viewing/consenting human, so this is honest about exactly what the session
    // would carry, never the agent's raw (possibly higher) grant.
    const capabilities = await resolveConsentedAgentCapabilities(env, row.id, memberId)
    out.push({ ...row, capabilities })
  }
  return out
}

/** Minimal, dependency-free HTML escaper — agent slug/name/squad name are
 *  admin-authored D1 content and must not be trusted as safe markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCapabilities(grants: CapabilityGrant[]): string {
  if (grants.length === 0) return 'none'
  return grants
    .map((g) => `${g.scope_type}${g.scope_id ? `:${g.scope_id}` : ''} → ${g.capability}`)
    .map(escapeHtml)
    .join(', ')
}

/** Defensive numeric coercion before interpolation (P2, adversarial review
 *  2026-08-10): SQLite has dynamic column typing — `agents.budget_cap_cents` being
 *  declared INTEGER does not guarantee every row actually holds a number. Confirm
 *  it really is a finite number before it ever reaches the template literal;
 *  anything else collapses to a fixed, harmless string rather than being
 *  interpolated raw and unescaped. */
function formatBudgetCap(cents: number | null): string {
  if (cents === null) return 'none'
  const n = Number(cents)
  if (!Number.isFinite(n)) return 'invalid'
  return `${n}¢`
}

// mupot#901 residual gap: a member with ZERO consentable agents (the exact
// first-run case — no agent exists yet that this human could bind to) used to
// see nothing but "continue unbound", with no indication that a self-serve
// path exists at all. bootstrap_self (mupot#925/#928) IS that path and is
// already live — a same-session tool call names an agent, mints its home
// squad, and grants the calling human squad:admin on it, which is exactly
// what clears THIS screen's own admin floor (P0-3) on a later visit. The gap
// was never in the mechanism, only in this screen's silence about it. This is
// pure copy on the empty-state branch — it does not touch selection, minting,
// or any of the P0-1/P0-2/P0-3 invariants proven in
// tests/agent-bound-oauth-consent.test.ts.
const EMPTY_STATE_HINT = `
<p class="empty-hint">No agent is available to bind this connection to yet. If you are
connecting an AI assistant (Claude Desktop, claude.ai, etc.), ask it to call the
<code>bootstrap_self</code> tool — pass the name you want to give your agent. That creates
a home for it and gives <em>you</em> admin on it immediately, no operator needed. Come back
to this screen afterward (reconnect / re-authorize) and your new agent will be listed
here to choose.</p>`

/** Renders the consent screen. The ONLY thing the user reads before a token is
 *  minted — every field a selectable agent would carry into the session is shown
 *  literally, not summarized (slug, name, squad, capabilities, autonomy, budget). */
function renderConsentPage(
  consentNonce: string,
  email: string,
  agents: ConsentableAgent[],
  // mupot#901 gate amendment (River): `agents` is [] in TWO states — the listing
  // succeeded and found none, or the listing THREW and fell back to []. The empty-
  // state hint asserts "no agent is available to bind to yet", which is a claim
  // about a board that, on the failure path, was never read. Render the claim only
  // when we actually know it. Defaults true so existing callers are unchanged.
  agentsListed = true,
): Response {
  const rows = agents.map((a) => `
        <label class="agent-option">
          <input type="radio" name="agent_id" value="${escapeHtml(a.id)}">
          <div>
            <div class="agent-title"><strong>${escapeHtml(a.name)}</strong> <code>${escapeHtml(a.slug)}</code></div>
            <div class="agent-meta">squad: ${escapeHtml(a.squad_name)} &middot; autonomy: ${escapeHtml(a.autonomy)} &middot; budget: ${formatBudgetCap(a.budget_cap_cents)} / ${escapeHtml(a.budget_window)}</div>
            <div class="agent-caps">capabilities this session would carry: ${formatCapabilities(a.capabilities)}</div>
          </div>
        </label>`).join('\n')

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Connect to mupot</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; }
  .agent-option { display: flex; gap: 0.75rem; align-items: flex-start; border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem; margin: 0.5rem 0; }
  .agent-meta, .agent-caps { font-size: 0.85rem; color: #444; }
  .agent-caps { font-family: monospace; }
  .empty-hint { font-size: 0.85rem; color: #444; background: #f5f5f5; border-radius: 8px; padding: 0.75rem; }
  .empty-hint code { font-family: monospace; }
  fieldset { border: none; padding: 0; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
</style>
</head>
<body>
<h1>Connect to mupot</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>. Choose what this connection can act as.</p>
${agentsListed && agents.length === 0 ? EMPTY_STATE_HINT : ''}
<form method="POST" action="/oauth/consent">
  <input type="hidden" name="consent_nonce" value="${escapeHtml(consentNonce)}">
  <fieldset>
    <label class="agent-option">
      <input type="radio" name="agent_id" value="" checked>
      <div>
        <div class="agent-title"><strong>No agent — continue unbound</strong></div>
        <div class="agent-meta">Default. Zero standing capabilities, exactly as today.</div>
      </div>
    </label>
${rows}
  </fieldset>
  <div class="actions">
    <button type="submit" name="action" value="continue">Continue</button>
    <button type="submit" name="action" value="decline">Decline</button>
  </div>
</form>
</body>
</html>`

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

// ── resolveExternalToken — called by OAuthProvider for non-owned bearers ──────
// C1: The OAuthProvider calls this when a bearer it doesn't recognize arrives at
// an apiRoute path. For mupot's member API keys (mupot_... prefix) this is
// the secondary door. We authenticate the bearer via the member_tokens hash lookup
// and return {props} on success, null on failure.
//
// NOTE: The primary door (OAuth-minted tokens owned by the provider) is handled
// BEFORE resolveExternalToken and never reaches this function. This function
// only runs for bearers the OAuthProvider's internal KV does NOT recognize.
export async function resolveExternalToken(
  env: Env,
  token: string,
): Promise<{ props: OAuthMemberProps } | null> {
  // Namespace non-overlap assertion (C4): OAuth tokens are issued as
  // "userId:grantId:secret" format (3 colon-separated segments). mupot member
  // keys always start with "mupot_" (64 hex chars after the prefix). These two
  // namespaces are structurally disjoint — an OAuth token will never pass sha256
  // lookup against member_tokens, and a mupot_ key is never stored in OAUTH_KV.
  const tokenHash = await sha256Hex(token)
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.email AS email, m.status AS status,
            t.id AS token_id, t.channel AS channel, t.agent_id AS bound_agent_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.token_hash = ?1
        AND t.tenant = ?2
        AND m.tenant = ?2
        AND t.revoked_at IS NULL
      LIMIT 1`,
  ).bind(tokenHash, env.TENANT_SLUG).first<{
    member_id: string
    email: string | null
    status: string
    token_id: string
    channel: ConnectionChannel | null
    bound_agent_id: string | null
  }>()

  if (!row || row.status !== 'active') return null

  return {
    props: {
      memberId: row.member_id,
      tokenId: row.token_id,
      email: row.email,
      channel: isConnectionChannel(row.channel) ? row.channel : 'workspace',
      boundAgentId: row.bound_agent_id ?? null,
      // mupot#903b: this secondary (member-API-key bearer) door reconstructs props
      // fresh from D1 columns alone — there is no encrypted-props store to read a
      // consenting human's id back out of, and member_tokens has no such column
      // (deliberately — see the OAuthMemberProps design comment). A directory-
      // channel + agent_id row should never actually be reachable through this
      // door (mintDirectoryToken's raw token is discarded, never handed out as a
      // bearer), but if one ever were, this null makes resolveConsentedAgentCapabilities
      // fail closed to [] rather than silently trust an agent's unclamped grant.
      consentedByMemberId: null,
    } satisfies OAuthMemberProps,
  }
}

// ── buildAuthContext — props → AuthContext (C2: live capability re-resolution) ─
// Called by McpOAuthApiHandler on every request. Capabilities are resolved fresh
// from D1 — never frozen into props (revocation propagates immediately).
// tenant is hardcoded from env.TENANT_SLUG (never from props) — C2.
//
// B1 — directory-channel capability ceiling (C6 hardening):
// The directory door (OAuth / ChatGPT / Claude connector) is a PUBLIC registration
// surface. Any verified Google account can reach it. A member who ALREADY has admin
// or owner grants (set via the workspace/dashboard door) must NOT inherit those grants
// through the public directory door — that would let any attacker who controls the
// member's Google account bypass the intended zero-capability default for OAuth seats.
//
// Fix: for channel='directory', effective capabilities = [] (zero), regardless of
// what resolveCapabilities returns for the underlying memberId.
//
// The member's grants are still resolved and logged (for audit / future ceiling
// configuration), but they are NOT surfaced to the caller. The empty array ensures
// the legacyRoleSatisfies escape in capability.ts remains unreachable (it only fires
// when capabilities is UNDEFINED, never for an empty array).
//
// An operator who wants their full grants uses the member-API-key door (channel=
// 'workspace'), not the public directory door. The directory door is deliberately
// minimal. If a configurable ceiling is introduced in future, replace [] with
// intersect(resolvedGrants, ceilingGrants).
//
// mupot#903b — agent-bound directory sessions (KEEPS B1's intent intact):
// [] is still the default for a directory seat. The ONE exception is a token whose
// `member_tokens.agent_id` was set through the EXPLICIT consent flow (POST
// /oauth/consent, re-validated server-side against memberMayConsentToAgent before
// mint — see mintDirectoryToken above). For THAT token, capabilities = the CHOSEN
// AGENT's own capability set (resolveConsentedAgentCapabilities — resolved via
// agent_member_bindings, a member row dedicated to the agent and created at its
// first mint_agent_token, structurally isolated from the connecting human's own
// `capabilities` rows). This is never the human's standing grants: there is no
// expression below that reads resolvedCapabilities (the human's own) into the
// directory branch. It is also never more than the agent itself holds: it IS the
// agent's own resolveCapabilities() result, re-resolved live on every request, so
// deactivating the agent (or narrowing its squad access) takes effect immediately —
// same C2 guarantee as every other channel.
export async function buildAuthContextFromProps(
  env: Env,
  props: OAuthMemberProps,
): Promise<AuthContext | null> {
  // Verify the referenced token is still live (not revoked since authorization).
  const tokenRow = await env.DB.prepare(
    `SELECT m.status AS status, m.email AS email, t.channel AS channel, t.agent_id AS bound_agent_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.id = ?1
        AND t.member_id = ?2
        AND t.tenant = ?3
        AND m.tenant = ?3
        AND t.revoked_at IS NULL
      LIMIT 1`,
  ).bind(props.tokenId, props.memberId, env.TENANT_SLUG).first<{
    status: string
    email: string | null
    channel?: ConnectionChannel | null
    bound_agent_id?: string | null
  }>()

  if (!tokenRow || tokenRow.status !== 'active') return null

  // Re-resolve capabilities every request (C2: revocation propagates immediately).
  // The resolved grants are NOT used for the directory channel — see B1 comment above —
  // but workspace/member API keys must preserve their live D1 grants.
  const resolvedCapabilities = await resolveCapabilities(env, props.memberId)

  const channel =
    isConnectionChannel(tokenRow.channel)
      ? tokenRow.channel
      : isConnectionChannel(props.channel)
        ? props.channel
        : 'directory'

  // mupot#903b: tokenRow.bound_agent_id is checked FIRST, regardless of channel — it
  // is the live DB truth (never props, which is client-influenced input echoed back
  // by the OAuth library). For a directory token that was never consent-bound (the
  // unaffected, unchanged default), tokenRow.bound_agent_id is NULL in D1 (see
  // mintDirectoryToken), so this still evaluates to exactly `null` for that case —
  // byte-for-byte the same result the old `channel === 'directory' ? null : ...`
  // ternary produced. For non-directory channels the expression is unchanged too:
  // `tokenRow.bound_agent_id ?? props.boundAgentId ?? null`, same as before.
  const boundAgentId =
    tokenRow.bound_agent_id ?? (channel === 'directory' ? null : props.boundAgentId ?? null)

  // B1: directory-channel capability ceiling = [] (zero) — UNLESS this token was
  // explicitly consent-bound to an agent (mupot#903b), in which case capabilities =
  // that agent's OWN capability set CLAMPED to the consenting human's own live rank
  // (P0-1) and re-validated against that same human's continued standing every
  // request (P0-2) — never the human's raw grants, never wider than the agent's own,
  // never wider than what the human backing the session currently holds. See the
  // design block above resolveConsentedAgentCapabilities.
  const capabilities: CapabilityGrant[] =
    channel === 'directory'
      ? boundAgentId
        ? await resolveConsentedAgentCapabilities(env, boundAgentId, props.consentedByMemberId ?? null)
        : []
      : resolvedCapabilities

  // mupot#903b P1 (adversarial review round 3, 2026-08-10): a consent-bound
  // session whose capabilities have gone to zero (agent deactivated, or the
  // consenting human demoted/offboarded — P0-2/P0-3) must not keep its IDENTITY
  // weld alive either. inbox / inbox_consumer_status (src/mcp/index.ts) gate on
  // `auth.boundAgentId` ALONE — zero capability check — and inbox defaults to
  // consumed:true, so a session that was correctly capability-zeroed but still
  // reported boundAgentId could keep draining a live agent's inbox (the real
  // agent never receives those messages) indefinitely, until someone manually
  // revokes the token. Capability-gated tools already died on the same request;
  // this is what makes the SESSION die with them, not just its ambient authority.
  // Deliberately uses `boundAgentId` (the raw, pre-exposure value) so this cannot
  // rot: whatever the capabilities computation just decided IS what gets nulled.
  const exposedBoundAgentId =
    channel === 'directory' && boundAgentId && capabilities.length === 0 ? null : boundAgentId

  return {
    userId: props.memberId,
    email: tokenRow.email ?? props.email,
    role: 'member', // coarse org-role; real authz is `capabilities`
    tenant: env.TENANT_SLUG, // environment-derived, never from props (C2)
    memberId: props.memberId,
    channel,
    capabilities, // always defined; empty only for directory — prevents legacyRoleSatisfies escape
    boundAgentId: exposedBoundAgentId, // null unless explicitly consent-bound (mupot#903b) AND still capability-live (P1)
    tokenId: props.tokenId, // live row was re-read above; never accepted from a tool argument
    // mupot#903b: carried through so resolveAuth's header re-derivation (src/mcp/
    // index.ts) can re-run the SAME resolveConsentedAgentCapabilities check rather
    // than trust this AuthContext's `capabilities` value verbatim from the internal
    // header — same "never trust the blob's capabilities claim" posture as every
    // other channel there.
    consentedByMemberId: channel === 'directory' ? (props.consentedByMemberId ?? null) : null,
    // LATENT capabilities: what this member actually holds, resolved but NOT active.
    //
    // The ceiling above is right about STANDING authority — an OAuth seat must never
    // silently act with an owner's grants. It was wrong about one thing: it assumed a
    // blocked operator has another door. The operator has no internal API path and reaches
    // mupot only through agentic harnesses (Claude Desktop, claude.ai, Codex, Cursor), all
    // of which arrive HERE. So "use the workspace door instead" was not advice, it was a
    // dead end — and the workaround it produced was worse than the risk it prevented: work
    // routed through a shared shell holding every credential on the host.
    //
    // Latent capabilities exist so an EXPLICIT, NAMED act can be authorized against what
    // the member truly holds, while ambient authority stays zero. `connect { agent_name }`
    // is that act: it names one agent, it is auditable, and it writes nothing. Silent
    // inheritance stays impossible; deliberate selection becomes possible.
    //
    // Anything reading `latentCapabilities` MUST be a read-only or explicitly-named
    // operation. Using it to satisfy an ambient capability check would reinstate exactly
    // the inheritance this ceiling exists to prevent. (#712)
    //
    // mupot#903b: for an UNBOUND directory seat, props.memberId IS the human, so
    // resolvedCapabilities (computed from props.memberId above) already IS the
    // human's own grants — unchanged from before this feature. For a BOUND seat,
    // props.memberId is the AGENT's own dedicated member (see mintDirectoryToken),
    // so resolvedCapabilities there is the AGENT's raw grant, not the human's —
    // using it here would leak the agent's full unclamped grant set through
    // `connect`'s claimGrants fallback, reopening P0-1 through a second door. The
    // human's identity for a bound seat lives in consentedByMemberId instead;
    // resolveHumanStandingGrants re-derives THEIR grants, live and status-gated.
    latentCapabilities:
      channel === 'directory'
        ? boundAgentId
          ? (props.consentedByMemberId ? await resolveHumanStandingGrants(env, props.consentedByMemberId) : [])
          : resolvedCapabilities
        : capabilities,
  }
}

// ── B2: Per-IP rate limiter for the OAuth registration path ───────────────────
// findOrCreateMember is reachable by ANY verified Google account — it writes a
// members row + member_tokens row. Without a guard an attacker can spam the
// callback to exhaust D1 write budget and pollute the member roster.
//
// Strategy: KV counter in SESSIONS namespace, key = `oauth-reg-rl:<ip>`.
// Window: 5 mints per hour per IP. On exceed: 429 + Retry-After: 3600.
// Fail-open on KV errors (network faults must not lock out legitimate users).
const OAUTH_REG_RL_MAX = 5
const OAUTH_REG_RL_TTL = 3600 // seconds (1 hour)

async function checkOAuthRegRateLimit(env: Env, ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = `oauth-reg-rl:${ip}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count >= OAUTH_REG_RL_MAX) {
      // KV TTL is set to OAUTH_REG_RL_TTL on first write; we conservatively return
      // the full window as Retry-After (no need to track exact expiry in the value).
      return { allowed: false, retryAfter: OAUTH_REG_RL_TTL }
    }
    // Increment; (re-)set TTL on every increment so the window rolls from first use.
    await env.SESSIONS.put(key, String(count + 1), { expirationTtl: OAUTH_REG_RL_TTL })
    return { allowed: true, retryAfter: 0 }
  } catch {
    // Fail-open: KV unavailability must not block legitimate auth flows.
    return { allowed: true, retryAfter: 0 }
  }
}

// ── B3: CSRF nonce cookie name ─────────────────────────────────────────────────
// The nonce is stored in SESSIONS KV (keyed `oauth-req:<nonce>`) AND echoed as a
// Secure;HttpOnly;SameSite=Lax cookie so the callback can verify that the request
// originated from the same browser that triggered /authorize. This prevents the
// classic OAuth login-CSRF attack where an attacker stitches their own Google
// identity to a victim's session by replaying a valid callback URL.
const CSRF_COOKIE_NAME = 'mupot_oauth_nonce'

// mupot#903b: a second, independent nonce/cookie pair for the consent step. Reusing
// CSRF_COOKIE_NAME would let a stale google-callback cookie (Path=/oauth/google-callback)
// satisfy the /oauth/consent check by accident once the browser sends both — a
// dedicated name + Path=/oauth/consent keeps the two CSRF checks from ever
// cross-satisfying each other.
const CONSENT_COOKIE_NAME = 'mupot_oauth_consent'
const CONSENT_TTL_SECONDS = 600

interface PendingConsent {
  stored: Record<string, unknown>
  memberId: string
  email: string
  /** Google's own subject id — preserved through to completeAuthorization's
   *  userId so the library's per-user grant identity is unchanged by adding the
   *  consent step in between (mupot#903b must not perturb pre-existing behaviour
   *  for the unbound path). */
  googleUserId: string
}

// ── Main authorize handler ────────────────────────────────────────────────────
// Mounted at /authorize, /oauth/google-callback, /oauth/consent in src/index.ts
// (before the dashboardApp catch-all).
// Handles: GET  /authorize            → redirect to Google (sets CSRF nonce cookie)
//          GET  /oauth/google-callback → exchange code, find-or-create member, render
//                                        the agent-selection CONSENT SCREEN (mupot#903b)
//          POST /oauth/consent         → re-validate the choice server-side, mint the
//                                        token (agent-bound or not), complete the OAuth
//                                        grant. Decline → no mint, no token, ever.
export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const redirectBase = `${url.protocol}//${url.host}`

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      JSON.stringify({ error: 'oauth_not_configured', error_description: 'Google client credentials not set. Deploy prerequisites: wrangler secret put GOOGLE_CLIENT_ID; wrangler secret put GOOGLE_CLIENT_SECRET' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // ── /authorize — parse the OAuth request, redirect to Google ──────────────
  if (url.pathname === '/authorize') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthProvider = (env as unknown as { OAUTH_PROVIDER: any }).OAUTH_PROVIDER

    let oauthReqInfo: Record<string, unknown>
    try {
      oauthReqInfo = await oauthProvider.parseAuthRequest(request) as Record<string, unknown>
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: String(err) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (!oauthReqInfo.clientId) {
      return new Response('Invalid OAuth request: missing client_id', { status: 400 })
    }

    const nonce = crypto.randomUUID()
    await env.SESSIONS.put(
      `oauth-req:${nonce}`,
      JSON.stringify(oauthReqInfo),
      { expirationTtl: 600 },
    )

    // B3: bind the nonce to the initiating browser via a Secure;HttpOnly;SameSite=Lax
    // cookie. The callback verifies this cookie matches the `state` param before
    // accepting the Google response — prevents login-CSRF.
    const redirectResponse = Response.redirect(
      googleAuthorizeUrl(
        env.GOOGLE_CLIENT_ID,
        nonce,
        `${redirectBase}/oauth/google-callback`,
      ),
      302,
    )
    const responseWithCookie = new Response(redirectResponse.body, redirectResponse)
    // The `secure` flag is omitted for localhost (http:) but applied for https:.
    const secure = url.protocol === 'https:'
    responseWithCookie.headers.set(
      'Set-Cookie',
      `${CSRF_COOKIE_NAME}=${nonce}; HttpOnly; SameSite=Lax; Path=/oauth/google-callback; Max-Age=600${secure ? '; Secure' : ''}`,
    )
    return responseWithCookie
  }

  // ── /oauth/google-callback — exchange code, find-or-create member ──────────
  if (url.pathname === '/oauth/google-callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      return new Response('Google auth denied', { status: 403 })
    }
    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 })
    }

    // B3: verify the CSRF nonce cookie matches the `state` param.
    // If the cookie is absent or mismatched, reject with 403 — the callback did
    // not originate from the browser that initiated /authorize.
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const cookieNonce = parseCookieValue(cookieHeader, CSRF_COOKIE_NAME)
    if (!cookieNonce || cookieNonce !== state) {
      return new Response('CSRF check failed: nonce mismatch', { status: 403 })
    }

    const stored = await env.SESSIONS.get(`oauth-req:${state}`, 'json') as Record<string, unknown> | null
    if (!stored) {
      return new Response('OAuth session expired or invalid state', { status: 400 })
    }
    await env.SESSIONS.delete(`oauth-req:${state}`)

    let googleUser: { id: string; name: string; email: string; emailVerified: boolean }
    try {
      googleUser = await googleExchangeCode(
        code,
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        `${redirectBase}/oauth/google-callback`,
      )
    } catch {
      return new Response('Google auth failed', { status: 502 })
    }

    // Only accept a verified Google email (sovereign-per-pot safety: unverified
    // emails could be spoofed across IdPs; mupot has no cross-pot escape to worry
    // about but the verification gate keeps the member surface clean).
    if (!googleUser.emailVerified) {
      return new Response(
        'Google account email is not verified. Please verify your email with Google and try again.',
        { status: 403 },
      )
    }

    // B2: per-IP rate limit on member mint. The CF-Connecting-IP header is set by
    // Cloudflare on every inbound Worker request; fall back to 'unknown' if absent
    // (local dev / test). The rate limiter uses SESSIONS KV (no new binding needed).
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const rl = await checkOAuthRegRateLimit(env, ip)
    if (!rl.allowed) {
      return new Response('Too many OAuth registrations from this IP. Please try again later.', {
        status: 429,
        headers: {
          'Retry-After': String(rl.retryAfter),
          'Content-Type': 'text/plain',
        },
      })
    }

    // Find-or-create the mupot member row for this verified email.
    let memberId: string
    try {
      memberId = await findOrCreateMember(env, googleUser.email, googleUser.name)
    } catch (err) {
      console.error('[oauth-authorize] member find-or-create failed:', err)
      return new Response('Member provisioning failed', { status: 500 })
    }

    // mupot#903b: STOP HERE — do not mint, do not completeAuthorization. Render the
    // consent screen and let the human explicitly choose (or decline). The Google
    // exchange is already done (`stored`/`memberId`/email are all we need to finish
    // later), so stash them under a fresh single-use nonce and hand the browser a
    // page, not a redirect.
    const consentNonce = crypto.randomUUID()
    const pending: PendingConsent = {
      stored, memberId, email: googleUser.email, googleUserId: googleUser.id,
    }
    await env.SESSIONS.put(
      `oauth-consent:${consentNonce}`,
      JSON.stringify(pending),
      { expirationTtl: CONSENT_TTL_SECONDS },
    )

    let agents: ConsentableAgent[]
    // Distinguishes "listed, found none" from "listing failed" — see renderConsentPage's
    // agentsListed param. Without this the empty-state hint states a fact about agents
    // on the one path where we never learned it.
    let agentsListed = true
    try {
      agents = await listConsentableAgents(env, memberId)
    } catch (err) {
      console.error('[oauth-authorize] listConsentableAgents failed:', err)
      // Fail closed on the LISTING, not on the flow: an admin/D1 hiccup here must not
      // block a legitimate unbound connection. Render the screen with no agent
      // choices — "continue unbound" (today's exact default) is still available.
      agents = []
      agentsListed = false
    }

    const page = renderConsentPage(consentNonce, googleUser.email, agents, agentsListed)
    // B3-style: bind the consent nonce to this browser. Clears the earlier
    // google-callback CSRF cookie (its job is done) and sets the consent one,
    // scoped to the /oauth/consent path only.
    const secure = url.protocol === 'https:'
    page.headers.append(
      'Set-Cookie',
      `${CSRF_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/oauth/google-callback; Max-Age=0`,
    )
    page.headers.append(
      'Set-Cookie',
      `${CONSENT_COOKIE_NAME}=${consentNonce}; HttpOnly; SameSite=Lax; Path=/oauth/consent; Max-Age=${CONSENT_TTL_SECONDS}${secure ? '; Secure' : ''}`,
    )
    return page
  }

  // ── /oauth/consent — re-validate the choice, mint, complete (mupot#903b) ───
  if (url.pathname === '/oauth/consent') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    const form = await request.formData()
    const consentNonce = String(form.get('consent_nonce') ?? '')
    const action = String(form.get('action') ?? '')
    const agentIdRaw = String(form.get('agent_id') ?? '').trim()

    if (!consentNonce) return new Response('Missing consent_nonce', { status: 400 })

    // CSRF: the cookie set when the consent page was rendered must match the
    // nonce the form posted back. Same defence as B3 above, second instance.
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const cookieNonce = parseCookieValue(cookieHeader, CONSENT_COOKIE_NAME)
    if (!cookieNonce || cookieNonce !== consentNonce) {
      return new Response('CSRF check failed: consent nonce mismatch', { status: 403 })
    }

    const pending = await env.SESSIONS.get(`oauth-consent:${consentNonce}`, 'json') as PendingConsent | null
    if (!pending) {
      return new Response('Consent session expired or invalid. Please sign in again.', { status: 400 })
    }
    // Single-use: consumed here regardless of outcome (continue, decline, or a
    // rejected agent_id) so a replayed POST can never re-run this step.
    await env.SESSIONS.delete(`oauth-consent:${consentNonce}`)

    const clearConsentCookie = `${CONSENT_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/oauth/consent; Max-Age=0`

    // Decline → NO mint, NO token, NO completeAuthorization. Ever. A declined
    // connection must never fall through to the unbound-default mint path below —
    // that would turn "I said no" into a silently-unbound token, exactly the
    // failure mode the hard requirement rules out.
    if (action !== 'continue') {
      const declined = new Response(
        'Connection declined. No token was issued.',
        { status: 200, headers: { 'Content-Type': 'text/plain' } },
      )
      declined.headers.set('Set-Cookie', clearConsentCookie)
      return declined
    }

    // Re-validate the posted agent_id against the SAME rule the screen was
    // rendered with (memberMayConsentToAgent === listConsentableAgents' per-row
    // check). The client's claim of eligibility is NEVER trusted — a tampered or
    // stale form field (agent deactivated between render and submit, human's own
    // squad access revoked in the interim, etc.) is rejected here, fail closed.
    //
    // mintMemberId — WHICH member row this member_tokens row belongs to. Defaults to
    // the human (pending.memberId): today's exact unbound behaviour, unchanged.
    //
    // For a consented bind, this can NEVER stay the human's member id. Migration 0071's
    // `member_tokens_agent_binding_insert` trigger requires that whenever agent_id IS
    // NOT NULL, (tenant, agent_id, member_id) already exists as a row in
    // agent_member_bindings — and that table pairs an agent ONLY with its own dedicated
    // member (the row created at its first mint_agent_token), never with an arbitrary
    // human. Setting member_id=<the human> with agent_id=<chosen agent> is not a
    // looser variant of the weld the schema allows — it is a DIFFERENT, unmodeled
    // relationship the trigger exists specifically to reject: RAISE(ABORT,
    // 'agent_identity_conflict') on every such INSERT, proven by running this against
    // real SQLite with the full migration chain applied (`agent_identity_conflict`
    // fired on 6 of this suite's tests before this fix). So a consent-bound session
    // mints under the AGENT's OWN member row — exactly the identity mint_agent_token
    // already uses for workspace-channel tokens — with channel staying 'directory' to
    // preserve OAuth-door provenance (rate-limited registration, this consent record).
    // capabilities still resolve correctly: resolveConsentedAgentCapabilities (below,
    // called from buildAuthContextFromProps) re-derives the SAME member id from
    // agent_member_bindings independently of what got minted here, so it stays the
    // authoritative, live source of truth rather than trusting the stored row.
    let boundAgentId: string | null = null
    let mintMemberId = pending.memberId
    if (agentIdRaw) {
      const eligible = await memberMayConsentToAgent(env, pending.memberId, agentIdRaw)
      if (!eligible) {
        const rejected = new Response(
          'The selected agent is no longer available for this connection. Please sign in again.',
          { status: 403, headers: { 'Content-Type': 'text/plain' } },
        )
        rejected.headers.set('Set-Cookie', clearConsentCookie)
        return rejected
      }
      // memberMayConsentToAgent already proved a binding row exists (its JOIN
      // agent_member_bindings requires one) — this is a live re-read of that same
      // fact, not a second trust decision. `binding.kind !== 'bound'` here would mean
      // the binding vanished between the two statements; agent_member_bindings has no
      // DELETE path while any member_tokens row references the agent (0071's
      // `agent_member_bindings_delete_requires_no_tokens` trigger) and this is the
      // FIRST token for this consent, so that race is not reachable — fail closed
      // anyway rather than assume it.
      const binding = await resolveAgentMemberBinding(env, agentIdRaw)
      if (binding.kind !== 'bound') {
        const rejected = new Response(
          'The selected agent is no longer available for this connection. Please sign in again.',
          { status: 403, headers: { 'Content-Type': 'text/plain' } },
        )
        rejected.headers.set('Set-Cookie', clearConsentCookie)
        return rejected
      }
      boundAgentId = agentIdRaw
      mintMemberId = binding.memberId
    }

    // mupot#903b P2-6 (adversarial review, 2026-08-10) — DECIDED, not overlooked:
    // setting boundAgentId here has two side effects beyond capability resolution,
    // both already true of every OTHER boundAgentId-bearing token (workspace welds
    // minted via mint_agent_token) and left consistent with them rather than
    // special-cased:
    //   1. src/mcp/provision.ts (mint_agent_token, list_agent_tokens,
    //      revoke_agent_token, provision_agent_connection) all reject with
    //      `operator_principal_required` once `auth.boundAgentId` is set — so
    //      consenting removes those four tools from THIS session. A human who binds
    //      their claude.ai connection to an agent trades "can provision other
    //      agents from this tab" for "acts as this one, honestly" — correct: a
    //      session scoped to one agent's capabilities should not ALSO retain the
    //      power to mint credentials for other agents, same as any workspace weld.
    //   2. src/mcp/presence.ts registers presence as `boundAgentId ?? memberId` —
    //      so a bound session shows up as the AGENT being present (feeding dispatch
    //      selection), not the human. Also correct: the whole point of consenting
    //      is that this connection acts AS that agent.
    // A human who wants to keep provisioning/administering agents from claude.ai
    // uses "continue unbound" instead — the default, unaffected path.
    //
    // RE-READ after P0-3 (gate decision, same review): this reasoning was written
    // while memberMayConsentToAgent's floor was still 'member', under which a bare
    // squad-member could reach both side effects above — "a bare member injects an
    // agent into dispatch selection" was a live consequence of the SAME bug P0-3
    // fixes, not a separate, independently-decided cost. With the floor raised to
    // 'admin' (matching mint_agent_token, the only other producer of this weld),
    // both side effects now require the SAME rank mint_agent_token already
    // requires to cause them directly — the ground this paragraph stands on is
    // firmer after P0-3, not weaker; it no longer needs to argue "member is an
    // acceptable price," only "admin choosing this is the same act as admin
    // choosing mint_agent_token."

    // Mint a directory-channel token for this OAuth seat (show-once raw discarded;
    // the OAuth access token is the credential the client holds). The token row
    // exists for capability resolution and revocation only. agent_id is set here
    // when (and only when) the human explicitly consented above; member_id is the
    // AGENT's own dedicated member for that same case (mintMemberId, see above) —
    // never the connecting human's member id.
    let tokenId: string
    try {
      const minted = await mintDirectoryToken(
        env,
        mintMemberId,
        `oauth:${pending.email.split('@')[0].slice(0, 32)}`,
        boundAgentId,
      )
      tokenId = minted.tokenId
    } catch (err) {
      console.error('[oauth-authorize] token mint failed:', err)
      return new Response('Token mint failed', { status: 500 })
    }

    // mupot#903b P1-3 (adversarial review): "human X consented to bind to agent A
    // at time T" was recorded nowhere — the KV pending-consent record is deleted on
    // use, and member_tokens' own member_id column holds the AGENT's identity for a
    // bound row, not the human's. Only for the BOUND path — there is nothing to
    // attest for "continue unbound" (today's exact default). Best-effort: a
    // receipt-write failure must not block a legitimate login (same posture as the
    // listConsentableAgents catch above) — logged, not fatal. The receipt itself is
    // append-only (migration 0091); this is the only write to it in the codebase.
    if (boundAgentId) {
      try {
        await env.DB.prepare(
          `INSERT INTO oauth_consent_receipts
             (id, tenant, token_id, consenting_member_id, agent_id, agent_member_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`,
        ).bind(crypto.randomUUID(), env.TENANT_SLUG, tokenId, pending.memberId, boundAgentId, mintMemberId).run()
      } catch (err) {
        console.error('[oauth-authorize] consent receipt write failed (non-fatal):', err)
      }
    }

    // Complete the OAuth authorization. The `props` are stored encrypted in
    // the OAuthProvider's KV and surfaced to the apiHandler (McpOAuthApiHandler)
    // via ctx.props on every authenticated request.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthProvider = (env as unknown as { OAUTH_PROVIDER: any }).OAUTH_PROVIDER
    let redirectTo: string
    try {
      const result = await oauthProvider.completeAuthorization({
        request: pending.stored,
        // Same shape as before the consent step existed — google-${id}, not a
        // synthetic value — so the library's per-user grant identity is unchanged.
        userId: `google-${pending.googleUserId}`,
        metadata: {
          google_email: pending.email,
          // Only verified emails ever reach the consent step (checked before the
          // pending-consent record is created) — always true here, same as before.
          google_email_verified: true,
        },
        scope: (pending.stored.scope as string[]) ?? ['mcp:read', 'mcp:write'],
        props: {
          // MUST match mintMemberId (the row's actual member_id) — buildAuthContextFromProps
          // looks the token up by `WHERE t.id = ?1 AND t.member_id = ?2`; pending.memberId
          // here (the human) would 404 that lookup for a consent-bound token.
          memberId: mintMemberId,
          tokenId,
          email: pending.email,
          channel: 'directory',
          boundAgentId,
          // mupot#903b P0-1/P0-2: the HUMAN, distinct from memberId (=mintMemberId,
          // the agent's own dedicated member for a bound seat). null for the unbound
          // path — pending.memberId there already equals mintMemberId (=pending.memberId,
          // the human), so there is no separate "consenting human" to record.
          consentedByMemberId: boundAgentId ? pending.memberId : null,
        } satisfies OAuthMemberProps,
      })
      redirectTo = result.redirectTo
    } catch (err) {
      console.error('[oauth-authorize] completeAuthorization failed:', err)
      return new Response('OAuth completion failed', { status: 500 })
    }

    const finalResponse = Response.redirect(redirectTo, 302)
    const finalWithClear = new Response(finalResponse.body, finalResponse)
    finalWithClear.headers.set('Set-Cookie', clearConsentCookie)
    return finalWithClear
  }

  return new Response('Not found', { status: 404 })
}

// ── Cookie parser (minimal; no external dep) ─────────────────────────────────
// Parses a single named cookie value from the `Cookie` request header.
// Returns null if the cookie is absent or its value is empty.
function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const k = trimmed.slice(0, eqIdx).trim()
    const v = trimmed.slice(eqIdx + 1).trim()
    if (k === name) return v.length > 0 ? v : null
  }
  return null
}
