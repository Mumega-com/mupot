// src/pots/routes.ts — HTTP API routes for Sovereign Multi-Tenant Pot Provisioning.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import { csrf } from 'hono/csrf'
import { isOrgAdmin } from '../auth/capability'
import { orgAdminForbiddenPayload, ORG_ADMIN_REFUSAL_LINKS } from '../auth/refusal'
import { provisionSovereignPot, listSovereignPots, PotSlugTakenError, InvalidSlugError } from './service'
import { validateProvisionRequestBody } from './validate'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const potsApp = new Hono<AppEnv>()

// CSRF (2026-09-02, adversarial class finding): cookie-authenticated mutations on a
// top-level mount do not inherit dashboardApp's csrf(); SameSite=Lax is site-scoped
// (mumega.com) and does not stop a sibling *.mupot.mumega.com origin, and text/plain
// skips CORS preflight. hono/csrf guards the three CORS-simple content types only —
// its coverage depends on this Worker having NO cors() anywhere. Same convention as tasksApp.
potsApp.use('*', csrf())
potsApp.use('*', requireAuth)

// POST /api/pots/provision — Provision an isolated sovereign pot (D1, KV, WFP User Worker)
potsApp.post('/provision', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenPayload('Provisioning a sovereign tenant pot', auth, ORG_ADMIN_REFUSAL_LINKS), 403)
  }
  // mupot#1507 round-2 P2 (Athena condition v): a bound-agent session is refused at this
  // route, same `operator_principal_required` shape src/org/index.ts and src/mcp/provision.ts
  // already use — provisioning a sovereign pot is an operator action, not something an
  // agent's own weld token should be able to trigger on its own.
  if (auth.boundAgentId) {
    return c.json({ error: 'operator_principal_required' }, 403)
  }
  // The caller's OWN tenant must be this Worker's tenant — a cross-tenant auth context
  // reaching this route (e.g. a misrouted or forged session) must never provision on this
  // colony's behalf.
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'tenant_mismatch' }, 403)
  }

  let rawBody: unknown
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400)
  }

  // mupot#1507 round-2 P0-3: the EXACT same allow-list the MCP tool's `additionalProperties:
  // false` schema already enforces — see src/pots/validate.ts. Anything outside it
  // (`worker_js_code`, `cf_api_token`, `account_id` included) is refused, never silently
  // dropped or forwarded.
  const validated = validateProvisionRequestBody(rawBody)
  if (!validated.ok) {
    const status = validated.error === 'invalid_body' ? 400 : validated.error === 'missing_required_fields' ? 400 : 400
    return c.json({ error: validated.error, message: validated.message }, status)
  }

  if (!c.env.SECRET_ENV_CF_API_TOKEN) {
    return c.json(
      {
        error: 'unconfigured',
        message: 'Cloudflare API Token not configured for pot provisioning.',
      },
      503,
    )
  }

  try {
    const result = await provisionSovereignPot(c.env, {
      ...validated.value,
      // validateProvisionRequestBody keeps plan_tier as a plain trimmed string (it has
      // no opinion on the SovereignPotTier union); provisionSovereignPot's own
      // `input.plan_tier || 'enterprise'` fallback treats any non-recognized value the
      // same as absent, so a narrowing cast here is safe.
      plan_tier: validated.value.plan_tier as import('../pots/types').SovereignPotTier | undefined,
      minted_by_member_id: auth.memberId,
      caller_tenant: auth.tenant,
    })
    // 201 Created is a claim that the thing now exists. It does not, unless every step ran
    // and it was verified reachable. 202 Accepted is the honest code for "we started, and
    // here is exactly how far we got".
    return c.json({ ok: result.ok, pot: result }, result.ok ? 201 : 202)
  } catch (err) {
    if (err instanceof PotSlugTakenError) {
      return c.json({ error: err.code, message: err.message }, 409)
    }
    if (err instanceof InvalidSlugError) {
      return c.json({ error: err.code, message: err.message }, 400)
    }
    return c.json(
      {
        error: 'provisioning_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }
})

// GET /api/pots — List all provisioned sovereign customer pots in WFP dispatch namespace
potsApp.get('/', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenPayload('Listing sovereign tenant pots', auth, ORG_ADMIN_REFUSAL_LINKS), 403)
  }

  try {
    const accountId = c.env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
    const apiToken = c.env.SECRET_ENV_CF_API_TOKEN
    if (!apiToken) {
      return c.json({ error: 'unconfigured', message: 'Cloudflare API Token not configured for pot listing.' }, 503)
    }
    const list = await listSovereignPots({ accountId, apiToken })
    return c.json({ ok: true, pots: list })
  } catch (err) {
    return c.json(
      {
        error: 'list_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }
})

export const publicPotsApp = new Hono<{ Bindings: Env }>()

publicPotsApp.get('/slug-available', async (c) => {
  const slug = c.req.query('slug') || ''
  const { checkSlugAvailability } = await import('./service')
  const result = await checkSlugAvailability(c.env, slug)
  return c.json({ ok: true, result })
})

publicPotsApp.post('/checkout', async (c) => {
  let body: { slug?: string; brand?: string; tier?: any; owner_email?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  if (!body.slug || !body.owner_email) {
    return c.json({ ok: false, error: 'slug_and_owner_email_required' }, 400)
  }

  const { createPotCheckoutSession } = await import('./checkout')
  const origin = new URL(c.req.url).origin
  const result = await createPotCheckoutSession(c.env, {
    slug: body.slug,
    brand: body.brand || body.slug.toUpperCase(),
    tier: body.tier || 'starter',
    ownerEmail: body.owner_email,
    origin,
  })

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400)
  }

  return c.json({ ok: true, url: result.url, session_id: result.sessionId })
})
