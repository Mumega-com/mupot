// mupot — POST /api/brain/physics: coherence physics ingest endpoint (#138).
//
// The sovereign brain daemon (sovereign/coherence.py::measure_and_log) calls this
// after each C(t) measurement cycle to make the physics observable via the /brain
// dashboard panel. Observe-only end-to-end: the pot stores the snapshot and renders
// it; nothing here gates, mutates, or branches on the physics values.
//
// Auth: org-admin bearer token (same as the orient field-push and flight connector).
// The daemon runs as a machine principal; it mints and holds an admin member-token
// for the pot it reports to.
//
// Body: the JSON output of compute_physics() from sovereign/coherence.py —
//   { C, R, Psi, ARF, regime, raw_C, completed, failed, backlog, had_signal, ts }
//
// Storage: SESSIONS KV under key "brain:physics" (TTL 26h). SESSIONS is the right
// choice here: it already exists on every pot, the physics snapshot is a single
// JSON blob, and D1 is unnecessary for a single-key rolling value.
//
// Live-wire spec (for Hadi — not automated here):
//   In sovereign/coherence.py::measure_and_log(), after r.set(_PHYSICS_KEY, ...),
//   add an outbound HTTP POST:
//
//     import os, json, urllib.request
//     pot_url  = os.environ.get("MUPOT_URL", "")      # e.g. https://mumega.mupot.co
//     pot_token = os.environ.get("MUPOT_ADMIN_TOKEN", "")
//     if pot_url and pot_token:
//         req = urllib.request.Request(
//             f"{pot_url}/api/brain/physics",
//             data=json.dumps(phys).encode(),
//             headers={"Content-Type": "application/json", "Authorization": f"Bearer {pot_token}"},
//             method="POST",
//         )
//         try: urllib.request.urlopen(req, timeout=4)
//         except Exception as exc: logger.warning("[C(t)] pot POST failed: %s", exc)
//
//   Env vars to set on the sovereign VPS:
//     MUPOT_URL=https://<pot-domain>           (e.g. https://mumega.mupot.co)
//     MUPOT_ADMIN_TOKEN=<admin-member-token>   (minted at /admin/keys or /members)

import { Hono } from 'hono'
import type { Env } from '../types'
import { resolveOrgAdmin } from '../auth/member-bearer'
import { storePhysicsSnapshot } from './brain'
import { getHumanDirective } from '../brain/directive'

export const brainPhysicsIngestApp = new Hono<{ Bindings: Env }>()

// GET /api/brain/directive — read the owner-pinned directive for the next brain cycle.
brainPhysicsIngestApp.get('/directive', async (c) => {
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const directive = await getHumanDirective(c.env)
  return c.json({ ok: true, directive })
})

function consolidateThreshold(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined || raw.length === 0) return { value: 0.88 }
  const threshold = Number(raw)
  if (!Number.isFinite(threshold)) {
    return { error: 'invalid_threshold' }
  }
  return { value: threshold }
}

// POST /api/brain/consolidate — forward to the configured Mirror consolidate API.
// This route restores the nightly brain consolidation pipeline endpoint and keeps
// failures loud (non-2xx passthrough or explicit request failures), rather than
// silently returning 501 success-shaped placeholders.
brainPhysicsIngestApp.post('/consolidate', async (c) => {
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const mirrorUrl = c.env.MIRROR_URL?.trim()
  if (!mirrorUrl) {
    return c.json(
      { error: 'mirror_url_missing', detail: 'MIRROR_URL is required for brain consolidation' },
      503,
    )
  }

  const thresholdResult = consolidateThreshold(c.req.query('threshold'))
  if ('error' in thresholdResult) {
    return c.json({ error: thresholdResult.error }, 400)
  }

  const agent = c.req.query('agent')?.trim() ?? 'brain'
  const params = new URLSearchParams({ agent, threshold: String(thresholdResult.value) })

  const requestUrl = new URL('/consolidate', mirrorUrl)
  requestUrl.search = params.toString()

  const mirrorHeaders: Record<string, string> = {}
  if (c.env.MIRROR_TOKEN) {
    mirrorHeaders.Authorization = `Bearer ${c.env.MIRROR_TOKEN}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)

  try {
    const mirrorRes = await fetch(requestUrl, {
      method: 'POST',
      headers: mirrorHeaders,
      signal: controller.signal,
    })

    const responseBody = await mirrorRes.text()
    if (!mirrorRes.ok) {
      return new Response(responseBody || mirrorRes.statusText, {
        status: mirrorRes.status,
        headers: {
          'content-type': mirrorRes.headers.get('content-type') ?? 'text/plain',
        },
      })
    }

    try {
      return c.json(responseBody ? JSON.parse(responseBody) : {}, 200)
    } catch {
      return new Response(responseBody, {
        status: 200,
        headers: {
          'content-type': mirrorRes.headers.get('content-type') ?? 'text/plain',
        },
      })
    }
  } catch (error) {
    return c.json(
      {
        error: 'mirror_consolidate_request_failed',
        detail: error instanceof Error ? error.message : 'unknown_error',
      },
      502,
    )
  } finally {
    clearTimeout(timer)
  }
})

// POST /api/brain/physics — ingest a new physics snapshot from the sovereign daemon.
brainPhysicsIngestApp.post('/physics', async (c) => {
  // Auth: org-admin bearer token.
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const result = await storePhysicsSnapshot(c.env, body)
  if (!result.ok) return c.json({ error: result.error }, 422)

  return c.json({ ok: true, regime: result.physics.regime, C: result.physics.C, ts: result.physics.ts })
})
