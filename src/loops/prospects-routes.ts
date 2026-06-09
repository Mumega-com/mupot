// mupot — prospect seed-import route (P4, #35).
//
// POST /api/prospects/import  — owner/admin only, CSRF + session gated.
// Body: { prospects: [{ email, org?, contact_name?, source?, consent_basis?, notes?, loop_id? }] }
// Bulk-queues published B2B contacts into the outreach queue; dedup is enforced by
// createProspect (active-unique on tenant+email). Returns per-row outcome counts.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { Env, AuthContext } from '../types'
import { requireAuth, requireRole } from '../auth'
import { createProspect } from './prospects'
import type { NewProspect } from './prospects'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

const MAX_IMPORT = 500

export const prospectsApp = new Hono<AppEnv>()

prospectsApp.use('*', csrf())
prospectsApp.use('*', requireAuth)
prospectsApp.use('*', requireRole('admin')) // owner + admin

prospectsApp.post('/import', async (c) => {
  let body: { prospects?: unknown }
  try {
    body = (await c.req.json()) as { prospects?: unknown }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!Array.isArray(body.prospects)) {
    return c.json({ error: 'prospects_must_be_array' }, 400)
  }
  if (body.prospects.length > MAX_IMPORT) {
    return c.json({ error: 'too_many', max: MAX_IMPORT }, 400)
  }

  let queued = 0
  let duplicate = 0
  let invalid = 0
  for (const raw of body.prospects) {
    if (!raw || typeof raw !== 'object') {
      invalid++
      continue
    }
    const r = await createProspect(c.env, raw as NewProspect)
    if (r.ok) queued++
    else if (r.error === 'duplicate_active') duplicate++
    else invalid++
  }

  return c.json({ ok: true, queued, duplicate, invalid })
})
