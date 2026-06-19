// mupot — reseller provisioning route (slice 1: the dry-run planner surface).
//
// POST /api/reseller/provision-plan — admin-gated. Returns the deterministic reseller-pot
// stand-up RECIPE (planResellerTenant). It is WRITE-FREE: it computes a plan and returns it;
// it never touches D1, never mints anything, never stands up a pot. The actual EXECUTE leg
// (create the CF account/repo/deploy + secrets + live customer mint) is Hadi-go ops and is a
// LATER slice — so this route explicitly refuses `dryRun:false` with 501 rather than pretend.
//
// Auth: requireAuth + owner/admin only. The recipe exposes internal provisioning structure,
// so it is admin-scoped even though it writes nothing (the service catalog itself is already
// public at /services; this adds the slug/tier/ops plan).

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import { planResellerTenant, type ResellerProvisionInput } from './provision'

const MAX_BODY_BYTES = 8192

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function isAdminPlus(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

export const resellerApp = new Hono<AppEnv>()

resellerApp.use('*', requireAuth)

resellerApp.post('/provision-plan', async (c) => {
  const auth = c.get('auth')
  if (!isAdminPlus(auth)) {
    return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  }

  // size-cap as a TRUE byte cap. Reject by declared Content-Length first (before reading the
  // body at all), then by the actual UTF-8 byte length — `raw.length` is a CHAR count, so a
  // multibyte payload could exceed the byte budget and slip past a length check.
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }

  let body: ResellerProvisionInput & { dryRun?: unknown }
  try {
    body = raw.length === 0 ? ({} as ResellerProvisionInput) : JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'invalid_body' }, 400)
  }

  // This slice only PLANS. POSITIVE allow-list: only an ABSENT dryRun or strict boolean `true`
  // is a plan request. ANYTHING else — false, "false", 0, null, {} — is read as "execute" and
  // refused loudly. The live stand-up (CF account/repo/deploy/secrets/customer mint) is Hadi-go
  // ops, never this endpoint. Hardened as an allow-list so the later live leg can't fail-open
  // here on a truthy-coercion footgun.
  if (body.dryRun !== undefined && body.dryRun !== true) {
    return c.json(
      {
        error: 'not_implemented',
        detail: 'live reseller stand-up is operator/Hadi-go ops, not this endpoint. This route plans only (dry-run).',
      },
      501,
    )
  }

  const result = planResellerTenant(body)
  if (!result.ok) {
    return c.json({ ok: false, reason: result.reason, detail: result.detail }, 422)
  }
  return c.json(result, 200)
})
