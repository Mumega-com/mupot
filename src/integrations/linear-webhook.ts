// mupot — Linear INBOUND webhook pieces (verify + parse + handle). Provider-specific; the route that calls
// them (integrations/board-webhook-routes.ts) knows no provider name.
//
// Linear signs the raw body: `Linear-Signature: <hex HMAC-SHA256(secret, rawBody)>`, and the JSON body carries
// `webhookTimestamp` (ms epoch). We reject a signature mismatch AND a timestamp outside a 60s window (Linear's
// own recommendation), on top of the delivery-id ledger in the route.
//
// What an inbound event may do (propose, never authorize):
//   - issue created  -> an UNASSIGNED task on the admin-configured defaultSquadId (importOneLinearIssue).
//   - issue state change -> an append-only note (board_inbound_observations). It never changes a task status,
//     never carries an approval, never writes a verdict.

import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import type {
  InboundBoardEvent,
  ProjectProviderBinding,
  WebhookOutcome,
  WebhookVerification,
} from '../projects/providers/port'
import { linkForItem } from '../projects/providers/board-links'
import { defaultSquadIdFromMeta, importOneLinearIssue } from './linear-issues'

const LINEAR_TIMESTAMP_WINDOW_MS = 60_000
const TEAM_KEY_RE = /^[A-Za-z0-9]{1,10}$/

interface LinearWebhookEnv {
  LINEAR_WEBHOOK_SECRET?: string
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyLinearWebhook(
  env: Env,
  rawBody: string,
  headers: Headers,
  now: number = Date.now(),
): Promise<WebhookVerification> {
  const secret = (env as unknown as LinearWebhookEnv).LINEAR_WEBHOOK_SECRET
  if (!secret) return { ok: false, reason: 'not_configured' }
  const provided = (headers.get('linear-signature') ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: 'invalid' }
  const expected = await hmacHex(secret, rawBody)
  if (!timingSafeEqual(expected, provided)) return { ok: false, reason: 'invalid' }
  // The signature is good; now the freshness of the signed timestamp (a captured delivery replayed later).
  let ts: unknown
  try {
    ts = (JSON.parse(rawBody) as { webhookTimestamp?: unknown }).webhookTimestamp
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts) || Math.abs(now - ts) > LINEAR_TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: 'stale' }
  }
  // Replay identity comes from AUTHENTICATED content only: the unsigned `linear-delivery` header is attacker-
  // controllable, so it must not decide whether a signed body is "new". Identical signed bytes are one delivery.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return { ok: true, deliveryId: `body:${hex}` }
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null
}

export function parseLinearWebhook(rawBody: string): { bindingExternalId: string; event: InboundBoardEvent } | null {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return null
  }
  if (body.type !== 'Issue') return null
  const data = body.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return null
  const team = data.team as { key?: unknown } | undefined
  const teamKey = typeof team?.key === 'string' && TEAM_KEY_RE.test(team.key) ? team.key : null
  const nativeId = str(data.id, 100)
  if (!teamKey || !nativeId) return null
  const number = typeof data.number === 'number' ? data.number : null
  const ref = str(data.identifier, 100) ?? (number !== null ? `${teamKey}-${number}` : null)
  if (!ref) return null
  const state = (data.state as { name?: unknown } | undefined)?.name
  const status = typeof state === 'string' ? state.slice(0, 100) : null

  if (body.action === 'create') {
    return {
      bindingExternalId: teamKey,
      event: {
        kind: 'item_created',
        item: {
          native_id: nativeId,
          ref,
          title: str(data.title, 200) ?? '(untitled)',
          url: str(data.url, 500),
          status,
        },
      },
    }
  }
  if (body.action === 'update') {
    const updatedFrom = body.updatedFrom as { stateId?: unknown } | undefined
    // Only a state change is of interest. Linear lists the previous values of changed fields in updatedFrom.
    if (!updatedFrom || typeof updatedFrom.stateId !== 'string') {
      return { bindingExternalId: teamKey, event: { kind: 'ignored' } }
    }
    return {
      bindingExternalId: teamKey,
      event: {
        kind: 'item_status_changed',
        item: { native_id: nativeId, ref, status },
        from_status: updatedFrom.stateId.slice(0, 100),
      },
    }
  }
  return { bindingExternalId: teamKey, event: { kind: 'ignored' } }
}

export async function handleLinearWebhook(
  env: Env,
  binding: ProjectProviderBinding,
  event: InboundBoardEvent,
): Promise<WebhookOutcome> {
  if (event.kind === 'item_created') {
    const squad = defaultSquadIdFromMeta(binding.meta_json)
    if (!squad) return { ok: true, imported: 0, detail: 'no_squad' }
    const status = await importOneLinearIssue(
      env,
      {
        id: event.item.native_id,
        identifier: event.item.ref,
        title: event.item.title,
        url: event.item.url,
        state: event.item.status,
        assigneeHint: null,
      },
      { teamKey: binding.external_id, defaultSquadId: squad, dryRun: false, projectId: binding.project_id },
    )
    return { ok: status !== 'error', imported: status === 'created' ? 1 : 0, detail: status }
  }
  if (event.kind === 'item_status_changed') {
    const link = await linkForItem(env, 'linear', event.item.native_id)
    // A note only attaches to a task of THIS binding's project: another project's item is not ours to annotate.
    if (!link || link.project_id !== binding.project_id) return { ok: true, noted: 0, detail: 'no_link' }
    await env.DB.prepare(
      `INSERT INTO board_inbound_observations (id, tenant, task_id, provider, item_native_id, from_status, to_status, observed_at)
       VALUES (?1, ?2, ?3, 'linear', ?4, ?5, ?6, ?7)`,
    )
      .bind(crypto.randomUUID(), env.TENANT_SLUG, link.task_id, event.item.native_id, event.from_status, event.item.status, new Date().toISOString())
      .run()
    return { ok: true, noted: 1 }
  }
  return { ok: true, detail: 'ignored' }
}
