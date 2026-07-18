// mupot — shared members service (token mint / revoke / list).
//
// This is the single token-lifecycle path. Both the JSON API (src/members) and the
// server-rendered dashboard (src/dashboard) call these instead of hand-writing the
// same SQL twice. Keeping mint/revoke here means the SECURITY DISCIPLINE lives in
// one place: tokens are stored HASHED, the raw is returned EXACTLY ONCE at mint and
// never logged or persisted, and revoke is idempotent (only flips live tokens).
//
// mintAgentBoundToken — the AGENT-BOUND mint path (shared between the MCP provision
// tool and the dashboard /admin/agent-token route).  It is the ONLY place the three-
// statement atomic batch (member envelope + escalation-guard capability + agent-weld
// token) is written, so no logic lives in two places.

import type { Env, MemberToken, ConnectionChannel, Capability, CapabilityGrant } from '../types'
import { assertBatchWritten } from '../lib/receipt'

type D1Statement = ReturnType<Env['DB']['prepare']>

const CHANNELS: readonly ConnectionChannel[] = ['workspace', 'im', 'dashboard']
export function isChannel(v: unknown): v is ConnectionChannel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
}

const AGENT_TOKEN_CAPABILITIES = ['observer', 'member'] as const
export type AgentTokenCapability = (typeof AGENT_TOKEN_CAPABILITIES)[number]

export function isAgentTokenCapability(v: unknown): v is AgentTokenCapability {
  return typeof v === 'string' && (AGENT_TOKEN_CAPABILITIES as readonly string[]).includes(v)
}

/** SHA-256 hex of a raw token. Stored value; the raw is never persisted.
 *  Exported for the one flow that mints inside a larger atomic D1 batch
 *  (invite accept) — everything else goes through mintMemberToken(). */
export async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Cryptographically-random opaque token (URL-safe hex). Shown once, never stored raw.
 *  Exported for the invite-accept atomic batch; everything else uses mintMemberToken(). */
export function mintRawToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `mupot_${s}`
}

export interface MintedToken {
  id: string
  member_id: string
  label: string
  channel: ConnectionChannel
  created_at: string
  /** The raw token — returned EXACTLY ONCE. Never persisted, never logged. */
  raw: string
}

/** Mint a scoped token for a member. Persists only the hash; returns the raw once.
 *  Caller MUST have already gated on admin (this layer does no authz). */
export async function mintMemberToken(
  env: Env,
  memberId: string,
  label: string,
  channel: ConnectionChannel,
  agentId: string | null = null,
): Promise<MintedToken> {
  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const token: Omit<MemberToken, 'token_hash'> = {
    id: crypto.randomUUID(),
    tenant: env.TENANT_SLUG,
    member_id: memberId,
    label: label.trim(),
    channel,
    created_at: new Date().toISOString(),
    revoked_at: null,
  }

  // agent_id binds this token to an agent (the weld). NULL = a human/operator principal.
  await env.DB.prepare(
    'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(token.id, token.member_id, tokenHash, token.label, token.channel, token.created_at, agentId, token.tenant)
    .run()

  return {
    id: token.id,
    member_id: token.member_id,
    label: token.label,
    channel: token.channel,
    created_at: token.created_at,
    raw: rawToken,
  }
}

/** Revoke a token, but only if it belongs to the member AND is still live.
 *  Returns true when a live token was revoked, false otherwise (idempotent). */
export async function revokeMemberToken(
  env: Env,
  memberId: string,
  tokenId: string,
  atomicWrites: D1Statement[] = [],
): Promise<boolean> {
  const update = env.DB.prepare(
    'UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND tenant = ? AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), tokenId, memberId, env.TENANT_SLUG)
  if (atomicWrites.length > 0) {
    const writes = await env.DB.batch([update, ...atomicWrites])
    assertBatchWritten(writes, 'revoke_member_token_atomic', 1)
    return true
  }
  const res = await update.run()
  return Boolean(res.meta && res.meta.changes > 0)
}

/** A token row WITHOUT its hash — safe to render (id, label, channel, lifecycle). */
export interface PublicMemberToken {
  id: string
  member_id: string
  label: string
  channel: ConnectionChannel
  created_at: string
  revoked_at: string | null
}

// ── agent-bound mint (shared) ─────────────────────────────────────────────────

/** The agent row shape mintAgentBoundToken needs (resolved from agents table). */
export interface AgentForMint {
  id: string
  squad_id: string
  slug: string
  name: string
}

/** What the agent-bound mint returns. raw is the show-once plaintext. */
export interface AgentMintResult {
  raw: string
  tokenId: string
  memberId: string
  createdAt: string
  grantCapability: AgentTokenCapability
  label: string
}

export type AgentMintReceipt = Omit<AgentMintResult, 'raw'>

/**
 * Atomically mint a DEDICATED member envelope + squad-scoped agent capability +
 * agent-weld token for `agent`.
 *
 * SECURITY INVARIANTS (same as the original mint_agent_token MCP tool):
 *   - THREE ROWS, ONE BATCH — all land or none do (no orphan credentials).
 *   - THE ESCALATION GUARD: the grant is hard-coded to scope_type='squad',
 *     scope_id=agent.squad_id, and capability <= 'member'.  Callers may lower it
 *     to 'observer', but can never widen it to lead/admin/owner or another scope.
 *   - THE WELD: member_tokens.agent_id = agent.id (binds the token to the agent).
 *   - Raw shown once; only the hash is stored. Never logged, never re-derivable.
 *
 * Caller MUST have already gated on org-admin (this layer does no authz).
 * Caller MUST have already resolved and validated `agent` from the pot's own D1.
 */
export async function mintAgentBoundToken(
  env: Env,
  agent: AgentForMint,
  label: string,
  grantCapability: AgentTokenCapability = 'member',
  atomicWrites?: (mint: AgentMintReceipt) => D1Statement[],
): Promise<AgentMintResult> {
  if (!isAgentTokenCapability(grantCapability)) {
    throw new Error('invalid agent token capability')
  }
  const memberId = crypto.randomUUID()
  const tokenId = crypto.randomUUID()
  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const createdAt = new Date().toISOString()
  const safeLabel = label.trim().slice(0, 64) || agent.slug
  const receipt: AgentMintReceipt = {
    tokenId,
    memberId,
    createdAt,
    grantCapability,
    label: safeLabel,
  }

  const mintWrites = await env.DB.batch([
    // 1) Dedicated member envelope for the agent (no email, no IM).
    env.DB.prepare(
      `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(memberId, null, agent.name, null, 'active', createdAt, env.TENANT_SLUG),
    // 2) THE ESCALATION GUARD: squad-scoped grant on the agent's OWN squad only.
    //    Hard-coded scope, with only observer/member allowed — never widened.
    env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES (?, ?, 'squad', ?, ?)`,
    ).bind(crypto.randomUUID(), memberId, agent.squad_id, grantCapability),
    // 3) THE WELD: bind token to the agent (agent_id set). Only the hash is stored.
    env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES (?, ?, ?, ?, 'workspace', ?, ?, ?)`,
    ).bind(tokenId, memberId, tokenHash, safeLabel, createdAt, agent.id, env.TENANT_SLUG),
    ...(atomicWrites?.(receipt) ?? []),
  ])
  // Receipt: all three rows MUST land. A partial mint (e.g. token row without its
  // capability row) would hand out a show-once token bound to a broken identity.
  assertBatchWritten(mintWrites, 'mint_agent_bound_token', 1)

  return { raw: rawToken, ...receipt }
}

/** Live (non-revoked) tokens for every member — for the dashboard roster. The
 *  hash is NEVER selected. */
export async function loadLiveTokens(env: Env): Promise<PublicMemberToken[]> {
  const rows = await env.DB.prepare(
    'SELECT id, member_id, label, channel, created_at, revoked_at FROM member_tokens WHERE tenant = ? AND revoked_at IS NULL ORDER BY created_at ASC',
  ).bind(env.TENANT_SLUG).all<PublicMemberToken>()
  return rows.results ?? []
}

/** Resolve the active member identity welded to an agent's live tokens. */
export async function resolveActiveAgentMember(
  env: Env,
  agentId: string,
): Promise<string | 'unminted' | 'ambiguous'> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT t.member_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.tenant = ?
        AND t.agent_id = ?
        AND t.revoked_at IS NULL
        AND m.tenant = ?
        AND m.status = 'active'
      ORDER BY t.member_id
      LIMIT 2`,
  )
    .bind(env.TENANT_SLUG, agentId, env.TENANT_SLUG)
    .all<{ member_id: string }>()

  const members = rows.results ?? []
  if (members.length === 0) return 'unminted'
  if (members.length === 1) return members[0].member_id
  return 'ambiguous'
}

export interface CapabilityGrantUpsertOutcome {
  grant: CapabilityGrant
  result: 'created' | 'updated' | 'unchanged'
}

export interface ActiveAgentCapabilityGrantInput {
  agentId: string
  expectedMemberId: string
  squadId: string
  capability: Capability
}

/**
 * Apply a squad grant only while the agent still has exactly the expected active
 * member binding. Identity validation, conflict handling, and outcome evidence
 * are evaluated by one SQLite statement.
 */
export async function upsertActiveAgentCapabilityGrant(
  env: Env,
  input: ActiveAgentCapabilityGrantInput,
): Promise<CapabilityGrantUpsertOutcome | null> {
  const createdId = crypto.randomUUID()
  const updatedId = crypto.randomUUID()
  const rows = await env.DB.prepare(
    `WITH active_identity AS MATERIALIZED (
       SELECT DISTINCT t.member_id
         FROM member_tokens t
         JOIN members m ON m.id = t.member_id
        WHERE t.tenant = ?1
          AND t.agent_id = ?2
          AND t.revoked_at IS NULL
          AND m.tenant = ?1
          AND m.status = 'active'
        ORDER BY t.member_id
        LIMIT 2
     ),
     prior_grant AS MATERIALIZED (
       SELECT id, capability
         FROM capabilities
        WHERE member_id = ?3
          AND scope_type = 'squad'
          AND scope_id = ?5
     )
     INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
     SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM prior_grant) THEN ?4
              WHEN (SELECT capability FROM prior_grant) = ?6 THEN (SELECT id FROM prior_grant)
              ELSE ?7
            END,
            member_id, 'squad', ?5, ?6
       FROM active_identity
      WHERE member_id = ?3
        AND (SELECT COUNT(*) FROM active_identity) = 1
     ON CONFLICT(member_id, scope_type, scope_id) DO UPDATE SET
       id = excluded.id,
       capability = excluded.capability
     RETURNING id, member_id, scope_type, scope_id, capability`,
  )
    .bind(
      env.TENANT_SLUG,
      input.agentId,
      input.expectedMemberId,
      createdId,
      input.squadId,
      input.capability,
      updatedId,
    )
    .all<CapabilityGrant & { id: string }>()

  const row = rows.results?.[0]
  if (!row) return null
  const result = row.id === createdId ? 'created' : row.id === updatedId ? 'updated' : 'unchanged'
  return {
    grant: {
      member_id: row.member_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      capability: row.capability,
    },
    result,
  }
}

/** Replace a member's grant on one scope and report the transaction's actual prior state. */
export async function upsertCapabilityGrant(
  env: Env,
  grant: CapabilityGrant,
): Promise<CapabilityGrantUpsertOutcome> {
  const deleteStmt = grant.scope_id === null
    ? env.DB.prepare(
        `DELETE FROM capabilities
          WHERE member_id = ? AND scope_type = ? AND scope_id IS NULL
        RETURNING capability`,
      ).bind(grant.member_id, grant.scope_type)
    : env.DB.prepare(
        `DELETE FROM capabilities
          WHERE member_id = ? AND scope_type = ? AND scope_id = ?
        RETURNING capability`,
      ).bind(grant.member_id, grant.scope_type, grant.scope_id)

  const writes = await env.DB.batch<{ capability: Capability }>([
    deleteStmt,
    env.DB.prepare(
      'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), grant.member_id, grant.scope_type, grant.scope_id, grant.capability),
  ])
  assertBatchWritten([writes[1]], 'upsert_capability_grant', 1)

  const existing = writes[0].results ?? []
  const result = existing.length === 0
    ? 'created'
    : existing.length === 1 && existing[0].capability === grant.capability
      ? 'unchanged'
      : 'updated'

  return { grant, result }
}
