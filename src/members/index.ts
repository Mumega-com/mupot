// mupot — members component. Humans as first-class network nodes.
//
// A Member is one person. They reach this pot through several channels — their
// own workspace over MCP, IM (Telegram via Hermes), or the web dashboard — all
// resolving to the SAME member_id + capabilities. "Having effect" = acting
// through any channel, gated by capability (the real, fine-grained RBAC).
//
// membersApp — HTTP surface mounted (by the Integrate phase) under its prefix:
//   POST   /invites                      create an invite        (admin on org/dept)
//   POST   /invites/:id/accept           redeem → mint member + capability + token
//   GET    /members                      list members            (member+)
//   GET    /members/:id                  read one member         (member+)
//   PATCH  /members/:id                  suspend / reactivate    (admin)
//   POST   /members/:id/tokens           mint a scoped token     (admin) → raw ONCE
//   DELETE /members/:id/tokens/:tid      revoke a token          (admin)
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
  MemberToken,
  CapabilityGrant,
  Capability,
  CapabilityScopeType,
  ConnectionChannel,
} from '../types'

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
// The FROZEN capability API — everyone codes against these exact signatures.
import { requireCapability, capabilityRank, actorMaxRankOnScope } from '../auth/capability'

// The validated invite payload, stashed by the parse middleware so the scope
// extractor (which runs inside requireCapability) can read the target department.
interface ParsedInvite {
  email: string
  department_id: string | null
  capability: Capability
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

const CHANNELS: readonly ConnectionChannel[] = ['workspace', 'im', 'dashboard']
function isChannel(v: unknown): v is ConnectionChannel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
}

const SCOPE_TYPES: readonly CapabilityScopeType[] = ['org', 'department', 'squad']
function isScopeType(v: unknown): v is CapabilityScopeType {
  return typeof v === 'string' && (SCOPE_TYPES as readonly string[]).includes(v)
}

/** SHA-256 hex of a raw token. Stored value; the raw is never persisted. */
async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Cryptographically-random opaque token (URL-safe hex). Shown once, never stored raw. */
function mintRawToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `mupot_${s}`
}

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". Map those to 409 rather than 500.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

interface InviteRow {
  id: string
  email: string
  department_id: string | null
  capability: Capability
  invited_by: string | null
  accepted_at: string | null
  created_at: string
}

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

membersApp.post('/invites/:id/accept', async (c) => {
  const inviteId = c.req.param('id')

  let body: AcceptInviteBody
  try {
    body = (await c.req.json()) as AcceptInviteBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isNonEmptyString(body.display_name)) return c.json({ error: 'invalid_display_name' }, 400)
  const displayName = body.display_name.trim()

  // telegram_chat_id is optional — present for IM-first members.
  let telegramChatId: string | null = null
  if (body.telegram_chat_id !== undefined && body.telegram_chat_id !== null) {
    if (!isNonEmptyString(body.telegram_chat_id)) {
      return c.json({ error: 'invalid_telegram_chat_id' }, 400)
    }
    telegramChatId = body.telegram_chat_id.trim()
  }

  const invite = await c.env.DB.prepare(
    'SELECT id, email, department_id, capability, invited_by, accepted_at, created_at FROM invites WHERE id = ? LIMIT 1',
  )
    .bind(inviteId)
    .first<InviteRow>()

  if (!invite) return c.json({ error: 'invite_not_found' }, 404)
  if (invite.accepted_at) return c.json({ error: 'invite_already_accepted' }, 409)

  // Mint the member. The email comes from the INVITE (server-trusted), never the
  // request body — the body only supplies the display name / IM handle.
  const member: Member = {
    id: crypto.randomUUID(),
    email: invite.email,
    display_name: displayName,
    telegram_chat_id: telegramChatId,
    status: 'active',
    created_at: new Date().toISOString(),
  }

  // The scope the invite's capability is granted on: org-wide when no department,
  // otherwise that department.
  const scopeType: CapabilityScopeType = invite.department_id ? 'department' : 'org'
  const scopeId: string | null = invite.department_id

  // Mint the workspace token now so we can hand it back exactly once.
  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const tokenId = crypto.randomUUID()
  const grantId = crypto.randomUUID()
  const acceptedAt = new Date().toISOString()

  // Atomic redemption: flip accepted_at ONLY if still unaccepted (single-use),
  // then create member + capability + token in the same batch. If the conditional
  // UPDATE changed zero rows, a concurrent accept won the race → 409.
  const claim = await c.env.DB.prepare(
    'UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL',
  )
    .bind(acceptedAt, inviteId)
    .run()

  // D1 exposes the affected-row count under meta.changes.
  if (!claim.meta || claim.meta.changes === 0) {
    return c.json({ error: 'invite_already_accepted' }, 409)
  }

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        member.id,
        member.email,
        member.display_name,
        member.telegram_chat_id,
        member.status,
        member.created_at,
      ),
      c.env.DB.prepare(
        'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
      ).bind(grantId, member.id, scopeType, scopeId, invite.capability),
      c.env.DB.prepare(
        'INSERT INTO member_tokens (id, member_id, token_hash, label, channel) VALUES (?, ?, ?, ?, ?)',
      ).bind(tokenId, member.id, tokenHash, 'workspace', 'workspace'),
    ])
  } catch (err) {
    // Roll the invite back so the person can retry (e.g. duplicate email collision
    // on members.email UNIQUE). The conditional claim above already serialized us.
    await c.env.DB.prepare('UPDATE invites SET accepted_at = NULL WHERE id = ?')
      .bind(inviteId)
      .run()
    if (isUniqueViolation(err)) return c.json({ error: 'member_already_exists' }, 409)
    throw err
  }

  // Return the RAW token EXACTLY ONCE. It is never stored or returned again.
  return c.json(
    {
      member_id: member.id,
      capability: { scope_type: scopeType, scope_id: scopeId, capability: invite.capability },
      token: {
        id: tokenId,
        label: 'workspace',
        channel: 'workspace' as ConnectionChannel,
        raw: rawToken,
      },
    },
    201,
  )
})

// ── global guards for the remaining (session-backed) routes ───────────────────

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
  department_id?: unknown
  capability?: unknown
}

// Creating an invite requires admin. When the invite targets a department, admin
// ON THAT DEPARTMENT suffices; otherwise org-level admin is required. We resolve
// the scope from the parsed body, then delegate the check to requireCapability.
const inviteScope = (c: Context): { type: CapabilityScopeType; id: string | null } => {
  // The frozen requireCapability types its scope arg as (c: Context) => …, so we
  // read our stashed variable through the typed view of the same context.
  const parsed = (c as Context<AppEnv>).get('inviteBody')
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

  if (!isEmail(body.email)) return c.json({ error: 'invalid_email' }, 400)

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

  const capability: Capability =
    body.capability === undefined ? 'member' : (body.capability as Capability)
  if (!isCapability(capability)) return c.json({ error: 'invalid_capability' }, 400)

  c.set('inviteBody', { email: body.email, department_id: departmentId, capability })
  await next()
}

membersApp.post(
  '/invites',
  parseInvite,
  requireCapability(inviteScope, 'admin'),
  async (c) => {
    // Validated + scoped by parseInvite; reuse the stashed body.
    const body = c.get('inviteBody')
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const auth = c.get('auth')

    // CEILING: cannot invite at a capability above your own rank on this scope
    // (a dept-admin must not mint an 'owner' on their department). P0 fix.
    {
      const { type: scopeType, id: scopeId } = inviteScope(c)
      if (capabilityRank(body.capability) > (await actorMaxRankOnScope(c, scopeType, scopeId))) {
        return c.json({ error: 'forbidden', reason: 'cannot_grant_above_own_rank' }, 403)
      }
    }

    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    // invited_by = the acting principal (member if present, else the web user id).
    const invitedBy = auth.memberId ?? auth.userId

    try {
      await c.env.DB.prepare(
        'INSERT INTO invites (id, email, department_id, capability, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, body.email, body.department_id, body.capability, invitedBy, createdAt)
        .run()
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'invite_exists' }, 409)
      throw err
    }

    return c.json(
      {
        invite: {
          id,
          email: body.email,
          department_id: body.department_id,
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
  const rows = await c.env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members ORDER BY created_at ASC, display_name ASC',
  ).all<Member>()
  return c.json({ members: rows.results ?? [] })
})

membersApp.get('/members/:id', requireCapability(orgScope, 'member'), async (c) => {
  const id = c.req.param('id')
  const member = await c.env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE id = ? LIMIT 1',
  )
    .bind(id)
    .first<Member>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)
  return c.json({ member })
})

// ── members (suspend / reactivate) ────────────────────────────────────────────

interface PatchMemberBody {
  status?: unknown
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

  const res = await c.env.DB.prepare('UPDATE members SET status = ? WHERE id = ?')
    .bind(status, id)
    .run()
  if (!res.meta || res.meta.changes === 0) return c.json({ error: 'member_not_found' }, 404)

  return c.json({ member_id: id, status })
})

// ── tokens (mint / revoke) ────────────────────────────────────────────────────

interface MintTokenBody {
  label?: unknown
  channel?: unknown
}

membersApp.post('/members/:id/tokens', requireCapability(orgScope, 'admin'), async (c) => {
  const memberId = c.req.param('id')

  const member = await c.env.DB.prepare('SELECT id, status FROM members WHERE id = ? LIMIT 1')
    .bind(memberId)
    .first<{ id: string; status: Member['status'] }>()
  if (!member) return c.json({ error: 'member_not_found' }, 404)

  let body: MintTokenBody
  try {
    body = (await c.req.json()) as MintTokenBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const label = body.label === undefined ? '' : body.label
  if (typeof label !== 'string' || label.length > 64) return c.json({ error: 'invalid_label' }, 400)

  const channel: ConnectionChannel = body.channel === undefined ? 'workspace' : (body.channel as ConnectionChannel)
  if (!isChannel(channel)) return c.json({ error: 'invalid_channel' }, 400)

  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const token: Omit<MemberToken, 'token_hash'> = {
    id: crypto.randomUUID(),
    member_id: memberId,
    label: label.trim(),
    channel,
    created_at: new Date().toISOString(),
    revoked_at: null,
  }

  await c.env.DB.prepare(
    'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(token.id, token.member_id, tokenHash, token.label, token.channel, token.created_at)
    .run()

  // Raw token returned EXACTLY ONCE; only the hash is persisted.
  return c.json(
    {
      token: {
        id: token.id,
        member_id: token.member_id,
        label: token.label,
        channel: token.channel,
        created_at: token.created_at,
        raw: rawToken,
      },
    },
    201,
  )
})

membersApp.delete(
  '/members/:id/tokens/:tid',
  requireCapability(orgScope, 'admin'),
  async (c) => {
    const memberId = c.req.param('id')
    const tokenId = c.req.param('tid')

    // Revoke only if the token belongs to this member AND is not already revoked.
    const res = await c.env.DB.prepare(
      'UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL',
    )
      .bind(new Date().toISOString(), tokenId, memberId)
      .run()

    if (!res.meta || res.meta.changes === 0) {
      // Either no such token under this member, or already revoked.
      return c.json({ error: 'token_not_found_or_already_revoked' }, 404)
    }

    return c.json({ token_id: tokenId, revoked: true })
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

  const member = await c.env.DB.prepare('SELECT id FROM members WHERE id = ? LIMIT 1')
    .bind(memberId)
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
      `SELECT id FROM ${table} WHERE id = ? LIMIT 1`,
    )
      .bind(scopeId)
      .first<{ id: string }>()
    if (!exists) return c.json({ error: `${scopeType}_not_found` }, 404)
  }

  if (action === 'revoke') {
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

  // CEILING: cannot grant above your own rank on the target scope (an org-admin
  // must not grant org 'owner'). P1 fix.
  if (capabilityRank(capability) > (await actorMaxRankOnScope(c, scopeType, scopeId))) {
    return c.json({ error: 'forbidden', reason: 'cannot_grant_above_own_rank' }, 403)
  }

  const grant: CapabilityGrant = {
    member_id: memberId,
    scope_type: scopeType,
    scope_id: scopeId,
    capability,
  }

  // Re-grant should UPDATE the level, not create a duplicate. NB: SQLite treats
  // two NULLs as distinct in a UNIQUE index, so the schema's
  // UNIQUE(member_id, scope_type, scope_id) does NOT dedupe org-wide grants
  // (scope_id NULL). We therefore do an explicit delete-then-insert in one batch,
  // matching null scope_id with IS NULL — uniform behaviour for org and scoped
  // grants, and idempotent on re-grant. D1 is single-writer per DB so this batch
  // is serialized.
  const deleteStmt =
    scopeId === null
      ? c.env.DB.prepare(
          'DELETE FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id IS NULL',
        ).bind(grant.member_id, grant.scope_type)
      : c.env.DB.prepare(
          'DELETE FROM capabilities WHERE member_id = ? AND scope_type = ? AND scope_id = ?',
        ).bind(grant.member_id, grant.scope_type, grant.scope_id)

  await c.env.DB.batch([
    deleteStmt,
    c.env.DB.prepare(
      'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), grant.member_id, grant.scope_type, grant.scope_id, grant.capability),
  ])

  return c.json({ grant, action: 'grant' }, 201)
})
