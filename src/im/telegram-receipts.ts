import type { Env } from '../types'

/** Transport facts from the authenticated, validated Telegram envelope. */
export interface TelegramUpdateIdentity {
  update_id: string
  telegram_user_id: string
  request_digest: string
}

interface Receipt {
  telegram_user_id: string
  request_digest: string
  state: 'processing' | 'completed' | 'unknown'
  response_text: string | null
}

type Reservation =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; response_text: string }
  | { ok: false; error: 'update_conflict' | 'update_in_progress' }

/** One insert wins. Replays never replace the principal, digest, or result. */
export async function reserveTelegramUpdate(env: Env, identity: TelegramUpdateIdentity): Promise<Reservation> {
  const inserted = await env.DB.prepare(
    `INSERT INTO telegram_webhook_receipts
       (tenant, update_id, telegram_user_id, request_digest, state, created_at)
     VALUES (?1, ?2, ?3, ?4, 'processing', ?5)
     ON CONFLICT (tenant, update_id) DO NOTHING`,
  ).bind(env.TENANT_SLUG, identity.update_id, identity.telegram_user_id,
    identity.request_digest, new Date().toISOString()).run()
  if (inserted.meta.changes === 1) return { ok: true, duplicate: false }

  const receipt = await env.DB.prepare(
    `SELECT telegram_user_id, request_digest, state, response_text
       FROM telegram_webhook_receipts WHERE tenant = ?1 AND update_id = ?2`,
  ).bind(env.TENANT_SLUG, identity.update_id).first<Receipt>()
  if (!receipt) return { ok: false, error: 'update_in_progress' }
  if (receipt.request_digest !== identity.request_digest || receipt.telegram_user_id !== identity.telegram_user_id) {
    return { ok: false, error: 'update_conflict' }
  }
  if (receipt.state !== 'completed' || receipt.response_text === null) {
    // Interrupted or uncertain effects require reconciliation; never re-execute.
    return { ok: false, error: 'update_in_progress' }
  }
  return { ok: true, duplicate: true, response_text: receipt.response_text }
}

/** Complete only our reserved envelope. Redemption may already have atomically completed it. */
export async function completeTelegramUpdate(
  env: Env,
  identity: TelegramUpdateIdentity,
  responseText: string,
): Promise<string | null> {
  await env.DB.prepare(
    `UPDATE telegram_webhook_receipts
        SET state = 'completed', response_text = ?1, completed_at = ?2
      WHERE tenant = ?3 AND update_id = ?4 AND telegram_user_id = ?5
        AND request_digest = ?6 AND state = 'processing'`,
  ).bind(responseText, new Date().toISOString(), env.TENANT_SLUG, identity.update_id,
    identity.telegram_user_id, identity.request_digest).run()
  const receipt = await env.DB.prepare(
    `SELECT response_text FROM telegram_webhook_receipts
      WHERE tenant = ?1 AND update_id = ?2 AND telegram_user_id = ?3
        AND request_digest = ?4 AND state = 'completed'`,
  ).bind(env.TENANT_SLUG, identity.update_id, identity.telegram_user_id,
    identity.request_digest).first<{ response_text: string | null }>()
  return receipt?.response_text ?? null
}
