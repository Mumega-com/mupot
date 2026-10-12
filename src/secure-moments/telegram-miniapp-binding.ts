// mupot — which member is behind a signed Telegram user id. Kept apart from the store: the store is imported by the
// sign-out and identity-revoke levers (src/auth/*), and this file needs access/identity, which imports those.
import type { Env } from '../types'
import { memberIsActiveHuman } from '../access/identity'

export type TelegramMember = { ok: true; memberId: string } | { ok: false; reason: 'unbound' | 'ineligible' }

/**
 * The ONE binding the codebase has between a Telegram account and a member: members.telegram_chat_id (set only by
 * /account -> Connect Telegram, the invite bind and the pairing flow; never by an origin or by this module). A
 * private chat's id equals the user's id, which is the private-chat semantic #1425 relies on, so the signed user id
 * is compared to that column as-is. Unbound id => 'unbound'; a bound member that is archived/suspended/agent-welded
 * => 'ineligible' (the same memberIsActiveHuman rule as every other human channel).
 */
export async function resolveTelegramMember(env: Env, telegramUserId: string): Promise<TelegramMember> {
  const row = await env.DB.prepare('SELECT id FROM members WHERE tenant = ?1 AND telegram_chat_id = ?2 LIMIT 1')
    .bind(env.TENANT_SLUG, telegramUserId).first<{ id: string }>()
  if (!row) return { ok: false, reason: 'unbound' }
  if (!(await memberIsActiveHuman(env, row.id))) return { ok: false, reason: 'ineligible' }
  return { ok: true, memberId: row.id }
}


/** The bound private chat id of an ACTIVE HUMAN member, or null (unbound, ineligible: the same null, no oracle). */
export async function privateChatOf(env: Env, memberId: string): Promise<string | null> {
  if (!(await memberIsActiveHuman(env, memberId))) return null
  const row = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?1 AND tenant = ?2').bind(memberId, env.TENANT_SLUG)
    .first<{ telegram_chat_id: string | null }>()
  return row?.telegram_chat_id ?? null
}

