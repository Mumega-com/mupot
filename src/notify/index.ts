// mupot — notify kernel, slice 1: one outbox. policy -> route -> adapter -> delivery row.
//
// notify() never throws. If the store itself is unavailable it degrades to "send without dedupe/cap" (the behaviour
// before the kernel existed) rather than dropping a notification.
import type { Env } from '../types'
import { safeConsole } from '../lib/log'
import { carryChannels, PUSH_CHANNELS, type Channel } from './carry'
import { DEDUPE_WINDOW_MS, DEFAULT_RATE_CAP_PER_HOUR, RATE_WINDOW_MS, isRateCapped } from './policy'
import { DEFAULT_ADAPTERS, type ChannelAdapter } from './adapters'
import type { DeliveryOutcome, NotifyDelivery, NotifyEvent, NotifyResult, Recipient } from './types'

export { wasDelivered, OWNER_RECIPIENT } from './types'
export type { NotifyEvent, NotifyResult } from './types'

export interface NotifyOptions {
  now?: () => number
  adapters?: readonly ChannelAdapter[]
  rateCapPerHour?: number
}

const RATE_CAPPED = 'rate_capped'

/** Claim the dedupe window for (tenant, recipient, key). True = this caller owns the send. */
async function claimDedupe(env: Env, tenant: string, recipient: Recipient, key: string, nowMs: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO notif_dedupe (tenant, recipient, dedupe_key, window_start_ms) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (tenant, recipient, dedupe_key) DO UPDATE SET window_start_ms = ?4
     WHERE notif_dedupe.window_start_ms <= ?5`,
  ).bind(tenant, recipient, key, nowMs, nowMs - DEDUPE_WINDOW_MS).run()
  return (res.meta?.changes ?? 0) > 0
}

async function releaseDedupe(env: Env, tenant: string, recipient: Recipient, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM notif_dedupe WHERE tenant = ?1 AND recipient = ?2 AND dedupe_key = ?3')
    .bind(tenant, recipient, key).run()
}

async function recentPushCount(env: Env, tenant: string, recipient: Recipient, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - RATE_WINDOW_MS).toISOString()
  const pushList = [...PUSH_CHANNELS].map((c) => `'${c}'`).join(',') // constants from carry.ts, not input
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notif_delivery
     WHERE tenant = ?1 AND recipient = ?2 AND channel IN (${pushList})
       AND status IN ('sent','edited','acked') AND created_at >= ?3`,
  ).bind(tenant, recipient, cutoff).first<{ n: number }>()
  return row?.n ?? 0
}

async function recordDelivery(env: Env, eventId: string, tenant: string, d: NotifyDelivery, nowIso: string, o: DeliveryOutcome): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notif_delivery (id, event_id, tenant, recipient, channel, status, external_ref, error_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(crypto.randomUUID(), eventId, tenant, d.recipient, d.channel, d.status, o.external_ref ?? null, d.error_code ?? null, nowIso).run()
}

export async function notify(env: Env, event: NotifyEvent, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const nowMs = (opts.now ?? Date.now)()
  const nowIso = new Date(nowMs).toISOString()
  const adapters = opts.adapters ?? DEFAULT_ADAPTERS
  const cap = opts.rateCapPerHour ?? DEFAULT_RATE_CAP_PER_HOUR
  const result: NotifyResult = { event_id: null, deliveries: [], deduped: [], rate_capped: [] }

  // policy: which channels may carry this, and which of those have an adapter (route).
  const routed: Channel[] = carryChannels(event).filter((c) => adapters.some((a) => a.channel === c))
  if (routed.length === 0) return result

  // dedupe per recipient
  const live: Recipient[] = []
  let storeOk = true
  for (const r of event.recipients) {
    try {
      if (await claimDedupe(env, event.tenant, r, event.dedupe_key, nowMs)) live.push(r)
      else result.deduped.push(r)
    } catch (err) {
      storeOk = false
      safeConsole.error('notify: dedupe store unavailable, sending without it', String(err).slice(0, 200))
      live.push(r)
    }
  }
  if (live.length === 0) return result

  // event row (best effort: a failed write must not stop the send)
  const eventId = crypto.randomUUID()
  if (storeOk) {
    try {
      await env.DB.prepare(
        `INSERT INTO notif_event (id, tenant, type, severity, subject_ref, recipients_json, dedupe_key, action_class, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(eventId, event.tenant, event.type, event.severity, event.subject_ref, JSON.stringify(live),
        event.dedupe_key, event.action_class ?? null, nowIso).run()
      result.event_id = eventId
    } catch (err) {
      storeOk = false
      safeConsole.error('notify: event store unavailable', String(err).slice(0, 200))
    }
  }

  for (const recipient of live) {
    let capped = false
    if (storeOk && event.severity !== 'critical') {
      try {
        capped = isRateCapped(event.severity, await recentPushCount(env, event.tenant, recipient, nowMs), cap)
      } catch (err) {
        safeConsole.error('notify: rate count unavailable, not capping', String(err).slice(0, 200))
      }
    }
    if (capped) result.rate_capped.push(recipient)

    let pushAttempts = 0
    let pushSent = 0
    for (const channel of routed) {
      const adapter = adapters.find((a) => a.channel === channel)
      if (!adapter) continue
      const isPush = PUSH_CHANNELS.has(channel)
      const outcome: DeliveryOutcome = capped && isPush
        ? { status: 'failed', error_code: RATE_CAPPED }
        : await adapter.deliver(env, event, recipient)
      if (isPush && !(capped)) {
        pushAttempts += 1
        if (outcome.status === 'sent') pushSent += 1
      }
      const d: NotifyDelivery = {
        recipient, channel, status: outcome.status, ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
      }
      result.deliveries.push(d)
      if (storeOk) {
        try { await recordDelivery(env, eventId, event.tenant, d, nowIso, outcome) } catch (err) {
          safeConsole.error('notify: delivery row not written', String(err).slice(0, 200))
        }
      }
    }
    // Every push attempt failed: free the dedupe window so the caller's retry is not swallowed.
    if (storeOk && pushAttempts > 0 && pushSent === 0) {
      try { await releaseDedupe(env, event.tenant, recipient, event.dedupe_key) } catch { /* window expires on its own */ }
    }
  }
  return result
}
