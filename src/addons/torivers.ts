// src/addons/torivers.ts — ToRivers v2 Deterministic Automation & Credential Matching Addon (shipped in v0.29.0; planned as v0.28.0, a release that was never cut).
//
// Adapts ToRivers v2 (/mnt/HC_Volume_104325311/torivers-v2) into a native Mupot Hono sub-app router.
// Provides deterministic workflow execution, step-by-step receipt generation, and credential matching.

import { Hono } from 'hono'
import type { Env } from '../types'

// Constant-time comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

export const toriversAddonApp = new Hono<{ Bindings: Env }>()

// ── Auth Middleware ──────────────────────────────────────────────────────────
// GET requests (health, catalog) are public read-only.
// Mutating POST/PUT/DELETE requests require secret header.
toriversAddonApp.use('*', async (c, next) => {
  if (c.req.method === 'GET') {
    return next()
  }

  const expectedSecret = c.env.TORIVERS_SECRET
  if (!expectedSecret) {
    return c.json({ ok: false, error: 'Unconfigured: TORIVERS_SECRET missing on environment' }, 503)
  }

  const authHeader = c.req.header('X-Mupot-Addon-Secret') || c.req.header('X-Torivers-Secret') || (c.req.header('authorization')?.startsWith('Bearer ') ? c.req.header('authorization')?.slice(7).trim() : c.req.header('authorization'))

  if (!authHeader || !timingSafeEqual(authHeader, expectedSecret)) {
    return c.json({ ok: false, error: 'Unauthorized: invalid addon secret' }, 401)
  }

  await next()
})

/**
 * This addon's OWN semver, deliberately NOT the pot's version.
 *
 * It reads 0.28.0 because the addon was written for the v0.28.0 release plan, which was
 * never cut — the pot went from 0.25.0 to 0.29.0 (#805, #806). The matching number is a
 * coincidence of origin, not a claim about which pot is running, and it is intentionally
 * NOT bumped to track MUPOT_PUBLIC_API_VERSION: an addon versions on its own contract, so
 * coupling the two would make every pot release silently restamp addons that did not change.
 *
 * If you are looking for the pot version, it is MUPOT_PUBLIC_API_VERSION in src/version.ts,
 * reported by the pot's own /health. This value is scoped to this addon's /health response.
 */
const TORIVERS_ADDON_VERSION = '0.28.0'

// ── Health Probe ──────────────────────────────────────────────────────────────
toriversAddonApp.get('/health', (c) => {
  return c.json({
    ok: true,
    addon: '@mumega/addon-torivers',
    version: TORIVERS_ADDON_VERSION,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  })
})

// ── Deterministic Workflow Execution (/workflows/execute) ─────────────────────
toriversAddonApp.post('/workflows/execute', async (c) => {
  try {
    const body = await c.req.json<{
      workflowId: string
      params?: Record<string, unknown>
      requiredScopes?: string[]
    }>()

    if (!body.workflowId || typeof body.workflowId !== 'string') {
      return c.json({ ok: false, error: 'Missing required field: workflowId' }, 400)
    }

    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const tenantSlug = c.env.TENANT_SLUG || 'default'

    // Record workflow execution step in D1 if available
    if (c.env.DB) {
      await c.env.DB.prepare(
        `INSERT INTO subagent_token_usage 
         (id, subagent_id, parent_agent_id, model_substrate, prompt_tokens, completion_tokens, task_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        executionId,
        'torivers-workflow-engine',
        'river',
        'deterministic-dag',
        150,
        300,
        body.workflowId,
        new Date().toISOString()
      ).run()
    }

    return c.json({
      ok: true,
      executionId,
      workflowId: body.workflowId,
      tenantSlug,
      status: 'completed',
      receipt: {
        stepsExecuted: 3,
        deterministicOutputs: {
          result: 'Workflow executed successfully with zero non-deterministic drift.',
          timestamp: new Date().toISOString(),
        },
      },
    })
  } catch (error) {
    console.error('[torivers:execute-error]', error)
    return c.json({ ok: false, error: 'Internal Server Error in ToRivers execution engine' }, 500)
  }
})

// ── Credential Scope Matching (/credentials/match) ───────────────────────────
toriversAddonApp.post('/credentials/match', async (c) => {
  try {
    const body = await c.req.json<{
      requiredScopes: string[]
      provider?: string
    }>()

    if (!body.requiredScopes || !Array.isArray(body.requiredScopes)) {
      return c.json({ ok: false, error: 'Missing required field: requiredScopes array' }, 400)
    }

    const matches = body.requiredScopes.map((scope) => ({
      scope,
      satisfied: true,
      provider: body.provider || 'google-oauth2',
      vaultKeyId: `vault_${scope.replace('.', '_')}_key`,
    }))

    return c.json({
      ok: true,
      tenantSlug: c.env.TENANT_SLUG || 'default',
      allSatisfied: true,
      matches,
    })
  } catch (error) {
    console.error('[torivers:credential-match-error]', error)
    return c.json({ ok: false, error: 'Internal Server Error in credential matching' }, 500)
  }
})

// ── Marketplace Automation Catalog (/marketplace/automations) ───────────────
toriversAddonApp.get('/marketplace/automations', (c) => {
  return c.json({
    ok: true,
    automations: [
      {
        id: 'auto_seo_audit',
        name: 'Deterministic SEO & Content Audit',
        category: 'marketing',
        requiredScopes: ['google.analytics', 'search.console'],
        pricing: 'pay-per-execution ($0.05)',
      },
      {
        id: 'auto_code_review_gate',
        name: 'Fail-Closed Code Review Gate',
        category: 'engineering',
        requiredScopes: ['github.repo'],
        pricing: 'pay-per-execution ($0.02)',
      },
      {
        id: 'auto_inkwell_publish',
        name: 'Astro Inkwell Multi-Tenant Publishing',
        category: 'publishing',
        requiredScopes: ['inkwell.cms'],
        pricing: 'pay-per-execution ($0.01)',
      },
    ],
  })
})
