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

import type { Env, MemberToken, ConnectionChannel } from '../types'
import { assertBatchWritten } from '../lib/receipt'

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
    member_id: memberId,
    label: label.trim(),
    channel,
    created_at: new Date().toISOString(),
    revoked_at: null,
  }

  // agent_id binds this token to an agent (the weld). NULL = a human/operator principal.
  await env.DB.prepare(
    'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(token.id, token.member_id, tokenHash, token.label, token.channel, token.created_at, agentId)
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
): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), tokenId, memberId)
    .run()
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
}

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
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id)
       VALUES (?, ?, ?, ?, 'workspace', ?, ?)`,
    ).bind(tokenId, memberId, tokenHash, safeLabel, createdAt, agent.id),
  ])
  // Receipt: all three rows MUST land. A partial mint (e.g. token row without its
  // capability row) would hand out a show-once token bound to a broken identity.
  assertBatchWritten(mintWrites, 'mint_agent_bound_token', 1)

  return { raw: rawToken, tokenId, memberId, createdAt, grantCapability }
}

/** Live (non-revoked) tokens for every member — for the dashboard roster. The
 *  hash is NEVER selected. */
export async function loadLiveTokens(env: Env): Promise<PublicMemberToken[]> {
  const rows = await env.DB.prepare(
    'SELECT id, member_id, label, channel, created_at, revoked_at FROM member_tokens WHERE revoked_at IS NULL ORDER BY created_at ASC',
  ).all<PublicMemberToken>()
  return rows.results ?? []
}
