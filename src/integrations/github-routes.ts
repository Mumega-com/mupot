// mupot — GitHub inbound webhook (the GitHub weave).
//
// POST /api/integrations/github
//
// SECURITY SURFACE — unauthenticated by session; authenticated ONLY by the webhook
// secret (HMAC-SHA256 of the raw body, delivered as `x-hub-signature-256: sha256=<hex>`).
// Same fail-closed discipline as the GHL adapter:
//   - GITHUB_WEBHOOK_SECRET not set → 503 (never process an unverified webhook).
//   - bad/missing signature → 401, no body processing, no detail leaked.
//
// On a verified event, records a TASK (a work unit) on the pot — so the team's GitHub
// activity (PRs, CI runs) becomes visible, gated work units on the Fleet Console. This
// is INBOUND only (GitHub → pot); the pot needs no egress to receive it. (The OUTBOUND
// tasks↔issues mirror lives in tasks/service.ts and needs GITHUB_TOKEN.)

import { Hono } from 'hono'
import type { Env } from '../types'
import { createTask } from '../tasks/service'

interface GitHubRouteEnv {
  GITHUB_WEBHOOK_SECRET?: string
  GITHUB_INBOUND_SQUAD_ID?: string
}

function githubRouteEnv(env: Env): GitHubRouteEnv {
  // as unknown: GITHUB_* are optional extras not in the core Env shape (same adapter-
  // local pattern as the GHL adapter).
  return env as unknown as GitHubRouteEnv
}

// Constant-time comparison (no early-exit timing oracle).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

async function computeHmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verify the GitHub webhook signature (`x-hub-signature-256: sha256=<hex>`).
 * Exported for unit testing without Hono.
 */
export async function verifyGitHubWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<'not_configured' | 'invalid' | 'ok'> {
  const secret = githubRouteEnv(env).GITHUB_WEBHOOK_SECRET
  if (!secret || secret.length === 0) return 'not_configured'
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return 'invalid'
  const provided = signatureHeader.slice('sha256='.length).toLowerCase()
  const expected = await computeHmacHex(secret, rawBody)
  if (!timingSafeEqual(expected, provided)) return 'invalid'
  return 'ok'
}

async function resolveInboundSquad(env: Env): Promise<string | null> {
  const configured = githubRouteEnv(env).GITHUB_INBOUND_SQUAD_ID
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const row = await env.DB.prepare(`SELECT id FROM squads ORDER BY created_at ASC LIMIT 1`).first<{ id: string }>()
  return row?.id ?? null
}

/**
 * Map a verified GitHub event (type + payload) to a work-unit task title/body, or null
 * to ignore the event. Exported for unit testing. v1 records the events that matter to
 * an ops work unit: pull requests and CI runs.
 */
export function taskFromGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
): { title: string; body: string } | null {
  const repo = typeof (payload.repository as { full_name?: string })?.full_name === 'string'
    ? (payload.repository as { full_name: string }).full_name
    : ''
  const prefix = repo ? `[GH ${repo}]` : '[GH]'

  if (eventType === 'pull_request') {
    const action = typeof payload.action === 'string' ? payload.action : 'updated'
    const pr = (payload.pull_request ?? {}) as { number?: number; title?: string; html_url?: string; merged?: boolean }
    const state = pr.merged && action === 'closed' ? 'merged' : action
    return {
      title: `${prefix} PR #${pr.number ?? '?'} ${state}: ${pr.title ?? ''}`.trim(),
      body: [pr.html_url ?? '', `event: pull_request.${action}`].filter(Boolean).join('\n'),
    }
  }

  if (eventType === 'workflow_run') {
    const wr = (payload.workflow_run ?? {}) as { name?: string; conclusion?: string; head_branch?: string; html_url?: string; status?: string }
    // record completed runs (a CI failure is a defect = a work unit); ignore in-progress noise
    if (wr.status && wr.status !== 'completed') return null
    return {
      title: `${prefix} CI ${wr.conclusion ?? 'completed'}: ${wr.name ?? 'workflow'} (${wr.head_branch ?? ''})`.trim(),
      body: [wr.html_url ?? '', `event: workflow_run · conclusion: ${wr.conclusion ?? ''}`].filter(Boolean).join('\n'),
    }
  }

  // ping (webhook setup handshake) and other events: acknowledge, don't record.
  return null
}

export const githubInboundApp = new Hono<{ Bindings: Env }>()

githubInboundApp.post('/', async (c) => {
  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const signatureHeader = c.req.header('x-hub-signature-256') ?? null
  const verify = await verifyGitHubWebhook(c.env, rawBody, signatureHeader)
  if (verify === 'not_configured') return c.json({ error: 'not_configured' }, 503)
  if (verify === 'invalid') return c.json({ error: 'unauthorized' }, 401)

  // Replay / idempotency guard: GitHub stamps each delivery with a unique x-github-delivery
  // UUID; a redelivery of the SAME delivery reuses it. Record it in KV; a repeat is a no-op.
  const delivery = c.req.header('x-github-delivery') ?? signatureHeader
  const nonceKey = `ghnonce:${delivery}`
  try {
    if (await c.env.SESSIONS.get(nonceKey)) return c.json({ ok: true, duplicate: true })
    await c.env.SESSIONS.put(nonceKey, '1', { expirationTtl: 86400 })
  } catch {
    // KV unavailable — process rather than block a legitimate delivery
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const eventType = c.req.header('x-github-event') ?? 'unknown'
  const mapped = taskFromGitHubEvent(eventType, payload)
  if (!mapped) return c.json({ ok: true, ignored: eventType }) // ping / unhandled — ack, don't record

  const squadId = await resolveInboundSquad(c.env)
  if (!squadId) return c.json({ ok: true, skipped: true, reason: 'no_squad' })

  await createTask(c.env, { squad_id: squadId, title: mapped.title, body: mapped.body, status: 'open' })
  return c.json({ ok: true })
})
