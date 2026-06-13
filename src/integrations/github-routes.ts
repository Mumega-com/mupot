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
import { createTask, syncTaskStatusFromIssue, syncCiResultToTask } from '../tasks/service'
import { syncGitHubProject } from './github-projects'

interface GitHubRouteEnv {
  GITHUB_WEBHOOK_SECRET?: string
  GITHUB_INBOUND_SQUAD_ID?: string
  GITHUB_LABEL_SQUAD_MAP?: string // B5: JSON { "<label>": "<squad_id>" }
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

/**
 * Parse the optional GITHUB_LABEL_SQUAD_MAP env — a JSON object `{ "<label>": "<squad_id>" }`
 * (B5). Returns {} on absent/invalid. Labels are matched case-insensitively.
 */
export function parseLabelSquadMap(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        out[k.trim().toLowerCase()] = v.trim()
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Pick the squad id for a set of issue labels from the map, or null if none match. */
export function squadForLabels(map: Record<string, string>, labels: string[]): string | null {
  for (const l of labels) {
    const hit = map[l.trim().toLowerCase()]
    if (hit) return hit
  }
  return null
}

/**
 * Resolve the squad an inbound work-unit lands on (B5). Priority:
 *   1. a label → squad mapping (GITHUB_LABEL_SQUAD_MAP) matching the event's labels
 *   2. GITHUB_INBOUND_SQUAD_ID (the default inbound squad)
 *   3. the oldest squad in the pot
 */
async function resolveInboundSquad(env: Env, labels: string[] = []): Promise<string | null> {
  if (labels.length > 0) {
    const mapped = squadForLabels(parseLabelSquadMap(githubRouteEnv(env).GITHUB_LABEL_SQUAD_MAP), labels)
    if (mapped) {
      // verify the mapped squad exists in this pot (config could be stale)
      const ok = await env.DB.prepare(`SELECT id FROM squads WHERE id = ?1 LIMIT 1`).bind(mapped).first<{ id: string }>()
      if (ok) return mapped
    }
  }
  const configured = githubRouteEnv(env).GITHUB_INBOUND_SQUAD_ID
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const row = await env.DB.prepare(`SELECT id FROM squads ORDER BY created_at ASC LIMIT 1`).first<{ id: string }>()
  return row?.id ?? null
}

/** Extract label names from an issue/PR payload (best-effort, bounded). */
function eventLabels(payload: Record<string, unknown>): string[] {
  const src = (payload.issue ?? payload.pull_request ?? {}) as { labels?: Array<{ name?: unknown }> }
  if (!Array.isArray(src.labels)) return []
  return src.labels
    .map((l) => (typeof l?.name === 'string' ? l.name : ''))
    .filter((n) => n.length > 0)
    .slice(0, 20)
}

/**
 * Map a verified GitHub event (type + payload) to a work-unit task title/body, or null
 * to ignore the event. Exported for unit testing. v1 records the events that matter to
 * an ops work unit: pull requests and CI runs.
 */
// Neutralize attacker-influenced PR/CI text before it lands in a task: a PR author is
// untrusted, and the field is reflected into the dashboard + (potentially) GitHub. Strip
// GitHub-special chars (@mentions, #refs, backticks) + break markdown links, and cap
// length. Defense-in-depth — the outbound mirror is also skipped for these tasks.
function safeField(s: unknown, max = 120): string {
  if (typeof s !== 'string') return ''
  return s.replace(/[@#`]/g, ' ').replace(/]\(/g, '] (').slice(0, max).trim()
}

const TITLE_MAX = 200

export function taskFromGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
): { title: string; body: string } | null {
  const repo = safeField((payload.repository as { full_name?: string })?.full_name, 80)
  const prefix = repo ? `[GH ${repo}]` : '[GH]'

  if (eventType === 'pull_request') {
    const action = typeof payload.action === 'string' ? payload.action.replace(/[^a-z_]/gi, '').slice(0, 20) : 'updated'
    const pr = (payload.pull_request ?? {}) as { number?: number; title?: string; html_url?: string; merged?: boolean }
    const num = Number.isInteger(pr.number) ? pr.number : '?'
    const state = pr.merged && action === 'closed' ? 'merged' : action
    return {
      title: `${prefix} PR #${num} ${state}: ${safeField(pr.title)}`.slice(0, TITLE_MAX).trim(),
      body: [safeField(pr.html_url, 300), `event: pull_request.${action}`].filter(Boolean).join('\n'),
    }
  }

  if (eventType === 'workflow_run') {
    const wr = (payload.workflow_run ?? {}) as { name?: string; conclusion?: string; head_branch?: string; html_url?: string; status?: string }
    if (wr.status && wr.status !== 'completed') return null // ignore in-progress noise
    const concl = safeField(wr.conclusion, 20) || 'completed'
    return {
      title: `${prefix} CI ${concl}: ${safeField(wr.name, 60)} (${safeField(wr.head_branch, 60)})`.slice(0, TITLE_MAX).trim(),
      body: [safeField(wr.html_url, 300), `event: workflow_run · conclusion: ${concl}`].filter(Boolean).join('\n'),
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
  // Size cap BEFORE HMAC/parse — bound work + avoid hashing a huge body (DoS guard).
  if (rawBody.length > 256 * 1024) return c.json({ error: 'payload_too_large' }, 413)

  const signatureHeader = c.req.header('x-hub-signature-256') ?? null
  const verify = await verifyGitHubWebhook(c.env, rawBody, signatureHeader)
  if (verify === 'not_configured') return c.json({ error: 'not_configured' }, 503)
  if (verify === 'invalid') return c.json({ error: 'unauthorized' }, 401)

  // Replay / idempotency guard: dedups GitHub REDELIVERIES (manual re-send reuses the same
  // x-github-delivery UUID) — NOT duplicate-content events (distinct real events get distinct
  // delivery ids, which is correct: they're distinct work). Best-effort; KV outage → process.
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

  // #23 — a Project board item changed: reconcile the configured board → pot tasks (real-time
  // complement to the cron). No-op unless GITHUB_SYNC_PROJECT is set; idempotent (KV-deduped).
  if (eventType === 'projects_v2_item') {
    const r = await syncGitHubProject(c.env)
    return c.json({ ok: true, sync: r })
  }

  // B3/B5 — `issues` events.
  if (eventType === 'issues') {
    const action = typeof payload.action === 'string' ? payload.action : ''
    // B3 status sync: close/reopen flips a mirrored task (no new task, no mirror-back).
    if (action === 'closed' || action === 'reopened') {
      const issue = (payload.issue ?? {}) as { html_url?: string }
      const issueUrl = typeof issue.html_url === 'string' ? issue.html_url : ''
      const { updated } = await syncTaskStatusFromIssue(c.env, issueUrl, action)
      return c.json({ ok: true, synced: updated, action })
    }
    // B5: a newly opened issue becomes a task, routed to a squad by its labels.
    if (action === 'opened') {
      const issue = (payload.issue ?? {}) as { number?: number; title?: string; html_url?: string }
      const repo = safeField((payload.repository as { full_name?: string })?.full_name, 80)
      const prefix = repo ? `[GH ${repo}]` : '[GH]'
      const num = Number.isInteger(issue.number) ? issue.number : '?'
      const squadId = await resolveInboundSquad(c.env, eventLabels(payload))
      if (!squadId) return c.json({ ok: true, skipped: true, reason: 'no_squad' })
      await createTask(
        c.env,
        {
          squad_id: squadId,
          title: `${prefix} issue #${num}: ${safeField(issue.title)}`.slice(0, TITLE_MAX).trim(),
          body: [safeField(issue.html_url, 300), 'event: issues.opened'].filter(Boolean).join('\n'),
          status: 'open',
        },
        { skipMirror: true },
      )
      return c.json({ ok: true, routed: squadId })
    }
    return c.json({ ok: true, ignored: `issues.${action}` })
  }

  // D3 — CI feedback: a completed workflow_run that references a PR linked to a task writes
  // the conclusion onto that task. A failing run on a task in `review` bumps it back to
  // `in_progress` (work to redo); success leaves it in review. No mirror-back.
  if (eventType === 'workflow_run') {
    const wr = (payload.workflow_run ?? {}) as {
      status?: string; conclusion?: string; pull_requests?: Array<{ number?: number }>
    }
    if (wr.status === 'completed' && Array.isArray(wr.pull_requests) && wr.pull_requests.length > 0) {
      const concl = safeField(wr.conclusion, 20) || 'completed'
      let linked = false
      for (const pr of wr.pull_requests) {
        if (!Number.isInteger(pr.number)) continue
        const res = await syncCiResultToTask(c.env, pr.number as number, concl)
        if (res.updated) linked = true
      }
      if (linked) return c.json({ ok: true, ci: concl })
      // not linked to a tracked task → fall through to record as a work-unit (existing behavior)
    }
  }

  const mapped = taskFromGitHubEvent(eventType, payload)
  if (!mapped) return c.json({ ok: true, ignored: eventType }) // ping / unhandled — ack, don't record

  const squadId = await resolveInboundSquad(c.env, eventLabels(payload))
  if (!squadId) return c.json({ ok: true, skipped: true, reason: 'no_squad' })

  // skipMirror: a GitHub-origin task must NOT be mirrored back out to a GitHub issue —
  // that reflects untrusted PR fields under our token + risks a feedback loop (P1).
  await createTask(c.env, { squad_id: squadId, title: mapped.title, body: mapped.body, status: 'open' }, { skipMirror: true })
  return c.json({ ok: true })
})
