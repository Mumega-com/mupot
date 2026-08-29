// src/pots/routes.ts — HTTP API routes for Sovereign Multi-Tenant Pot Provisioning.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import { isOrgAdmin } from '../auth/capability'
import { orgAdminForbiddenPayload, ORG_ADMIN_REFUSAL_LINKS } from '../auth/refusal'
import { provisionSovereignPot, listSovereignPots } from './service'
import type { SovereignPotProvisionInput } from './types'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const potsApp = new Hono<AppEnv>()

potsApp.use('*', requireAuth)

// POST /api/pots/provision — Provision an isolated sovereign pot (D1, KV, WFP User Worker)
potsApp.post('/provision', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) {
    return c.json(orgAdminForbiddenPayload('Provisioning a sovereign tenant pot', auth, ORG_ADMIN_REFUSAL_LINKS), 403)
  }

  let body: SovereignPotProvisionInput
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400)
  }

  if (!body.slug || !body.brand_name || !body.admin_email) {
    return c.json(
      {
        error: 'missing_required_fields',
        message: 'Required fields: slug, brand_name, admin_email.',
      },
      400,
    )
  }

  try {
    const result = await provisionSovereignPot(c.env, body)
    return c.json({ ok: true, pot: result }, 201)
  } catch (err) {
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
    const accountId = c.env.SECRET_ENV_CF_ACCOUNT_ID
    const apiToken = c.env.SECRET_ENV_CF_API_TOKEN
    if (!accountId || !apiToken) {
      return c.json({ error: 'unconfigured', message: 'Cloudflare API credentials are not configured.' }, 503)
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
  const { checkSlugAvailability } = await import('./checkout')
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
