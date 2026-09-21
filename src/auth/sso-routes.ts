// src/auth/sso-routes.ts — Enterprise SSO Configuration & Domain Verification REST Endpoints.

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env, AuthContext } from '../types'
// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from './index'
import { csrf } from 'hono/csrf'
import { requireOrgCapability } from './capability'
import {
  getSsoConfig,
  setSsoConfig,
  isDomainAllowed,
  autoEnrollSsoMember,
  SSO_ALLOWED_DEFAULT_ROLES,
} from './sso'

export const ssoApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// mupot#1454: POST /config used to pass req.json() straight into setSsoConfig,
// which spreads {...current, ...config} onto the stored blob with NO runtime
// check — the SsoConfig TS type said default_role was 'member'|'admin' (now
// narrowed further, see sso.ts), but a type is compile-time only; the actual
// runtime value was whatever the caller sent. An org admin (the only principal
// this route ever admitted, even before this fix) could set
// default_role:'admin' (or any other string) and then have POST /enroll mint
// an org-admin capability for an email they control the moment it logs in —
// no ceiling, no re-check. This schema is the enforcement: an unknown
// default_role is refused here so a bad value can never reach org_settings in
// the first place, and `.strict()` refuses any key this config does not
// declare. autoEnrollSsoMember (sso.ts) re-validates default_role again at
// enroll time against the SAME allowlist, in case a value written before this
// fix (or via direct D1 access) is already sitting in org_settings.
const SsoConfigBody = z
  .object({
    enabled: z.boolean().optional(),
    allowed_domains: z.array(z.string()).optional(),
    default_role: z.enum(SSO_ALLOWED_DEFAULT_ROLES).optional(),
    enforce_sso: z.boolean().optional(),
    idp_provider: z.enum(['google', 'saml', 'generic']).optional(),
  })
  .strict()

// P0 (2026-09-02): every route on this app was mounted at /api/auth/sso with no
// middleware and no inline check. Unauthenticated callers could read AND write
// sso_config (including default_role: 'admin') and auto-enroll an ACTIVE member
// with an org-level capability for any email — an unauthenticated org-admin
// takeover chain once that email logs in through OAuth. Live since #1231.
//
// Gate: every route requires an authenticated principal; config read/write and
// enrollment require org admin; domain validation requires org member. There are
// no in-repo callers of these routes, so nothing legitimate relied on the gap.
// CSRF (2026-09-02, adversarial class finding): cookie-authenticated mutations on a
// top-level mount do not inherit dashboardApp's csrf(); SameSite=Lax is site-scoped
// (mumega.com) and does not stop a sibling *.mupot.mumega.com origin, and text/plain
// skips CORS preflight. hono/csrf guards the three CORS-simple content types only —
// its coverage depends on this Worker having NO cors() anywhere. Same convention as tasksApp.
ssoApp.use('*', csrf())
ssoApp.use('*', requireAuth)

/**
 * GET /api/auth/sso/config — Return current SSO configuration for this pot.
 */
ssoApp.get('/config', requireOrgCapability('admin'), async (c) => {
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
ssoApp.post('/config', requireOrgCapability('admin'), async (c) => {
  let rawBody: unknown
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const parsed = SsoConfigBody.safeParse(rawBody)
  if (!parsed.success) {
    const invalidDefaultRole = parsed.error.issues.some((issue) => issue.path[0] === 'default_role')
    if (invalidDefaultRole) {
      return c.json({ ok: false, error: 'invalid_default_role' }, 400)
    }
    return c.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, 400)
  }

  const updated = await setSsoConfig(c.env, parsed.data)
  return c.json({ ok: true, config: updated })
})

/**
 * POST /api/auth/sso/validate — Validate an email or token domain against SSO policy.
 */
ssoApp.post('/validate', requireOrgCapability('member'), async (c) => {
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
ssoApp.post('/enroll', requireOrgCapability('admin'), async (c) => {
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
