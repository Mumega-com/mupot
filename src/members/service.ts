// mupot — shared members service (token mint / revoke / list).
//
// This is the single token-lifecycle path. Both the JSON API (src/members) and the
// server-rendered dashboard (src/dashboard) call these instead of hand-writing the
// same SQL twice. Keeping mint/revoke here means the SECURITY DISCIPLINE lives in
// one place: tokens are stored HASHED, the raw is returned EXACTLY ONCE at mint and
// never logged or persisted, and revoke is idempotent (only flips live tokens).

import type { Env, MemberToken, ConnectionChannel } from '../types'

const CHANNELS: readonly ConnectionChannel[] = ['workspace', 'im', 'dashboard']
export function isChannel(v: unknown): v is ConnectionChannel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
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

  await env.DB.prepare(
    'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(token.id, token.member_id, tokenHash, token.label, token.channel, token.created_at)
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

/** Live (non-revoked) tokens for every member — for the dashboard roster. The
 *  hash is NEVER selected. */
export async function loadLiveTokens(env: Env): Promise<PublicMemberToken[]> {
  const rows = await env.DB.prepare(
    'SELECT id, member_id, label, channel, created_at, revoked_at FROM member_tokens WHERE revoked_at IS NULL ORDER BY created_at ASC',
  ).all<PublicMemberToken>()
  return rows.results ?? []
}
