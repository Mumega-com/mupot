// mupot#1579 — web login for a Telegram-first member, by PROOF OF CONTROL.
//
// A member born through the Telegram door has a bound chat + an email + no login identity. The bound chat is a
// competing controller (src/members/exclusive-control.ts), so no web login may attach to that row by email or name
// match (that is the member-row-squatting lever). The one honest proof is the chat itself:
//
//   1. mintTelegramLoginLink — called ONLY from the authenticated private-chat `/login` command; the member is the one
//      whose members.telegram_chat_id equals the chat. One live link per member (a newer one supersedes).
//   2. the member opens the link in a browser, signs in with a provider (so there is a session identity), and confirms.
//   3. redeemTelegramLoginLink — ONE D1 batch: claim the link (single use, unexpired, chat still bound to the same
//      member, member still active, STILL no live identity, no live competing bearer — liveCompetingBearerSql, the same
//      clause #1551/#1963 use), then INSERT the identity anchored on the claim stamp. Nothing is linked unless the claim
//      landed; a replayed, expired or superseded link links nothing.
//
// The link authorises linking the identity the confirming SESSION carries — never an identity named in the request, and
// never one inferred from an email. Unverified-email providers (bootstrap, local-test) are refused.

import type { Env } from '../types'
import { nowSqlUtc } from './token-lifecycle'
import {
  liveCompetingBearerSql,
  notSupersededSql,
  PROVISIONING_EXEMPT_DIRECTORY_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_CHANNEL,
  PROVISIONING_EXEMPT_TOKEN_LABEL,
  UNVERIFIED_LOGIN_PROVIDERS,
} from '../members/exclusive-control'

export const TELEGRAM_LOGIN_LINK_TTL_SECONDS = 600

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** sha256 of a link token as it appears in the URL, or null when the shape is not a token we mint. */
export async function telegramLoginTokenHash(token: string): Promise<string | null> {
  return /^[0-9a-f]{64}$/.test(token) ? sha256Hex(token) : null
}

function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export type MintTelegramLoginLinkResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; error: 'not_bound' | 'already_has_login' | 'no_email' | 'agent_backed' }

/** Mint a link for the member whose bound chat is `chatId`. The caller must have authenticated the chat (the webhook). */
export async function mintTelegramLoginLink(
  env: Env,
  input: { memberId: string; chatId: string },
): Promise<MintTelegramLoginLinkResult> {
  const member = await env.DB.prepare(
    `SELECT id, email FROM members
      WHERE id = ?1 AND tenant = ?2 AND status = 'active' AND archived_at IS NULL AND telegram_chat_id = ?3`,
  ).bind(input.memberId, env.TENANT_SLUG, input.chatId).first<{ id: string; email: string | null }>()
  if (!member) return { ok: false, error: 'not_bound' }
  // The claim requires the confirming session's verified email to equal the member's, so a member with no email could
  // never confirm; refuse at mint instead of handing out a link that cannot work (and a bearer with no email bound).
  if (!member.email || member.email.trim() === '') return { ok: false, error: 'no_email' }
  // A member that backs an agent must never gain a human web login through this flow.
  const backing = await env.DB.prepare(
    `SELECT 1 AS present FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.memberId).first<{ present: number }>()
  if (backing) return { ok: false, error: 'agent_backed' }
  const identity = await env.DB.prepare(
    `SELECT 1 AS present FROM human_login_identities WHERE tenant = ?1 AND member_id = ?2 AND revoked_at IS NULL LIMIT 1`,
  ).bind(env.TENANT_SLUG, input.memberId).first<{ present: number }>()
  if (identity) return { ok: false, error: 'already_has_login' }

  const token = mintSecret()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + TELEGRAM_LOGIN_LINK_TTL_SECONDS * 1000).toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE telegram_login_links SET revoked_at = ?1
        WHERE tenant = ?2 AND member_id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).bind(now.toISOString(), env.TENANT_SLUG, input.memberId),
    env.DB.prepare(
      `INSERT INTO telegram_login_links (id, tenant, member_id, telegram_chat_id, token_hash, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, input.memberId, input.chatId, await sha256Hex(token), now.toISOString(), expiresAt),
  ])
  return { ok: true, token, expiresAt }
}

/** Server-known facts about who a link is for, for the confirm page. Never anything the Telegram user typed. */
export interface TelegramLoginLinkPreview {
  /** Member email with the local part masked (a.***@domain), or null when the member has none. */
  maskedEmail: string | null
  /** Last four characters of the bound Telegram chat id. */
  chatSuffix: string
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/** Read-only preview for the confirm page. Writes nothing; null for any link that could not be redeemed right now. */
export async function previewTelegramLoginLink(
  env: Env,
  tokenHash: string,
): Promise<TelegramLoginLinkPreview | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null
  const row = await env.DB.prepare(
    `SELECT m.email AS email, l.telegram_chat_id AS chat_id
       FROM telegram_login_links l
       JOIN members m ON m.id = l.member_id AND m.tenant = l.tenant
      WHERE l.token_hash = ?1 AND l.tenant = ?2 AND l.consumed_at IS NULL AND l.revoked_at IS NULL
        AND l.expires_at > ?3 AND m.status = 'active' AND m.telegram_chat_id = l.telegram_chat_id`,
  ).bind(tokenHash, env.TENANT_SLUG, new Date().toISOString()).first<{ email: string | null; chat_id: string }>()
  if (!row) return null
  return { maskedEmail: row.email ? maskEmail(row.email) : null, chatSuffix: row.chat_id.slice(-4) }
}

export type RedeemTelegramLoginLinkResult =
  | { ok: true; memberId: string }
  | { ok: false; error: 'invalid_link' | 'unverified_provider' | 'identity_unavailable' | 'service_error' }

/**
 * Consume the link and link the CONFIRMING session's identity to the link's member, atomically.
 * Every refusal is deliberately one of three coarse codes: the caller renders a generic page, so a stranger holding a
 * guessed token learns nothing about which member or which guard refused.
 */
export async function redeemTelegramLoginLink(
  env: Env,
  input: { tokenHash: string; provider: string; subject: string; verifiedEmail: string | null },
): Promise<RedeemTelegramLoginLinkResult> {
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) return { ok: false, error: 'invalid_link' }
  if ((UNVERIFIED_LOGIN_PROVIDERS as readonly string[]).includes(input.provider)) {
    return { ok: false, error: 'unverified_provider' }
  }
  const tenant = env.TENANT_SLUG
  const tokenHash = input.tokenHash

  // An identity row for this join key (live OR revoked) is never re-pointed at a Telegram member.
  const taken = await env.DB.prepare(
    `SELECT 1 AS present FROM human_login_identities WHERE tenant = ?1 AND provider = ?2 AND provider_subject = ?3 LIMIT 1`,
  ).bind(tenant, input.provider, input.subject).first<{ present: number }>()
  if (taken) return { ok: false, error: 'identity_unavailable' }

  const now = new Date().toISOString()
  // Unique per claim: the identity INSERT anchors on THIS value, so it can only land if THIS claim won.
  const stamp = `${now}#${crypto.randomUUID()}`
  const claim = env.DB.prepare(
    `UPDATE telegram_login_links SET consumed_at = ?1, consumed_provider = ?2, consumed_subject = ?3
      WHERE token_hash = ?4 AND tenant = ?5 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?6
        AND EXISTS (
          SELECT 1 FROM members m
           WHERE m.id = telegram_login_links.member_id AND m.tenant = ?5 AND m.status = 'active'
             AND m.archived_at IS NULL AND m.telegram_chat_id = telegram_login_links.telegram_chat_id
             -- The link is a bearer the chat relay can see, so the chat proof alone is not enough: the confirming
             -- session's IdP-verified email must equal the member's email, always. A member with no email gets no
             -- link at all (mintTelegramLoginLink 'no_email'), and a NULL here matches nothing.
             AND lower(m.email) = lower(?11)
             AND ${notSupersededSql('m')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_member_bindings b
           WHERE b.tenant = ?5 AND b.member_id = telegram_login_links.member_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM human_login_identities h
           WHERE h.tenant = ?5 AND h.member_id = telegram_login_links.member_id AND h.revoked_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 ${liveCompetingBearerSql({
            tenant: '?5', member: 'telegram_login_links.member_id', exemptLabel: '?7', exemptChannel: '?8',
            directoryChannel: '?9', now: '?10',
          })}
        )`,
  ).bind(
    stamp, input.provider, input.subject, tokenHash, tenant, now,
    PROVISIONING_EXEMPT_TOKEN_LABEL, PROVISIONING_EXEMPT_TOKEN_CHANNEL, PROVISIONING_EXEMPT_DIRECTORY_CHANNEL, nowSqlUtc(), input.verifiedEmail,
  )
  const link = env.DB.prepare(
    `INSERT INTO human_login_identities
       (id, tenant, provider, provider_subject, verified_email, member_id, linked_by_member_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, l.member_id, NULL, ?6
       FROM telegram_login_links l
      WHERE l.token_hash = ?7 AND l.tenant = ?2 AND l.consumed_at = ?8
        AND l.consumed_provider = ?3 AND l.consumed_subject = ?4`,
  ).bind(
    crypto.randomUUID(), tenant, input.provider, input.subject, input.verifiedEmail, now, tokenHash, stamp,
  )
  try {
    await env.DB.batch([claim, link])
  } catch (err) {
    // Only a UNIQUE(tenant, provider, subject) conflict is "identity unavailable" (the batch rolled back, so the link
    // is NOT consumed). Anything else (D1 down, schema drift) is a service fault the caller must surface as 503, never
    // fold into a refusal the member would read as "this link is bad".
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /UNIQUE constraint failed/i.test(msg) ? 'identity_unavailable' : 'service_error' }
  }
  const landed = await env.DB.prepare(
    `SELECT l.member_id AS member_id FROM telegram_login_links l
       JOIN human_login_identities h ON h.tenant = l.tenant AND h.member_id = l.member_id
        AND h.provider = ?3 AND h.provider_subject = ?4 AND h.revoked_at IS NULL
      WHERE l.token_hash = ?1 AND l.tenant = ?2 AND l.consumed_at = ?5`,
  ).bind(tokenHash, tenant, input.provider, input.subject, stamp).first<{ member_id: string }>()
  return landed ? { ok: true, memberId: landed.member_id } : { ok: false, error: 'invalid_link' }
}
