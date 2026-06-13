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

export const brainPhysicsIngestApp = new Hono<{ Bindings: Env }>()

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
