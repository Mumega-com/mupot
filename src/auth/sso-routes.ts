// src/auth/sso-routes.ts — Enterprise SSO Configuration & Domain Verification REST Endpoints.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import {
  getSsoConfig,
  setSsoConfig,
  isDomainAllowed,
  autoEnrollSsoMember,
  type SsoConfig,
} from './sso'

export const ssoApp = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()

/**
 * GET /api/auth/sso/config — Return current SSO configuration for this pot.
 */
ssoApp.get('/config', async (c) => {
  const config = await getSsoConfig(c.env)
  return c.json({
    ok: true,
    tenant: c.env.TENANT_SLUG,
    config,
  })
})

/**
 * POST /api/auth/sso/config — Update SSO domain whitelist and enforcement policies.
 */
ssoApp.post('/config', async (c) => {
  let body: Partial<SsoConfig>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const updated = await setSsoConfig(c.env, body)
  return c.json({ ok: true, config: updated })
})

/**
 * POST /api/auth/sso/validate — Validate an email or token domain against SSO policy.
 */
ssoApp.post('/validate', async (c) => {
  let body: { email?: unknown; provider?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!email || !email.includes('@')) {
    return c.json({ ok: false, error: 'email_required' }, 400)
  }

  const config = await getSsoConfig(c.env)
  const allowed = isDomainAllowed(email, config)

  return c.json({
    ok: true,
    email,
    allowed,
    enforce_sso: config.enforce_sso,
    idp_provider: config.idp_provider,
  })
})

/**
 * POST /api/auth/sso/enroll — Test / trigger auto-enrollment for an SSO profile.
 */
ssoApp.post('/enroll', async (c) => {
  let body: { email?: unknown; name?: unknown; provider?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!email) {
    return c.json({ ok: false, error: 'email_required' }, 400)
  }

  const result = await autoEnrollSsoMember(c.env, {
    email,
    name: typeof body.name === 'string' ? body.name : undefined,
    provider: typeof body.provider === 'string' ? body.provider : 'oauth',
  })

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 403)
  }

  return c.json({ ok: true, member: result })
})
