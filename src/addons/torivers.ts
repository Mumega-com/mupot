// src/addons/torivers.ts — ToRivers v2 Deterministic Automation & Credential Matching Addon (shipped in v0.29.0; planned as v0.28.0, a release that was never cut).
//
// Adapts ToRivers v2 (/mnt/HC_Volume_104325311/torivers-v2) into a native Mupot Hono sub-app router.
// Provides deterministic workflow execution, step-by-step receipt generation, and credential matching.

import { Hono } from 'hono'
import type { Env } from '../types'

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

  if (authHeader !== expectedSecret) {
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

    const tenantSlug = c.env.TENANT_SLUG || 'default'

    // NOT IMPLEMENTED — and it says so, because the previous version did not.
    //
    // This handler never read a workflow DAG or an action identifier. It returned
    // `status: 'completed'` with `stepsExecuted: 3` and "Workflow executed successfully
    // with zero non-deterministic drift", and it INSERTed hardcoded prompt/completion
    // token counts (150/300) into `subagent_token_usage` — an accounting surface. Those
    // rows are indistinguishable at read time from measured usage, so every call quietly
    // added fabricated COGS to the ledger (mupot#1017, found by Athena's gate review).
    //
    // Same class as #656, refused at review on 2026-08-13 for writing a guessed 0.1 into
    // a column named `reported_cost` that feeds the spend ceiling. That one was caught
    // before landing. This one shipped in v0.28.0 (f8d5a55).
    //
    // The fix is deliberately NOT "return 200 with an `implemented: false` flag". A 2xx
    // means the workflow ran, and a success-shaped response that nobody reads carefully
    // is exactly how the fabrication survived review in the first place. 501 is the
    // honest answer: the endpoint is declared, the engine is not built.
    //
    // A missing row is a visible gap. A fabricated row is invisible corruption.
    //
    // G-1b (atlas §2.1) replaces this with a real AST/DAG runner. When it lands, the
    // receipt and the usage row come back — DERIVED from what actually executed, and
    // the test below must be updated deliberately rather than deleted.
    return c.json(
      {
        ok: false,
        error: 'not_implemented',
        detail:
          'The deterministic workflow engine is not built. This endpoint accepts and ' +
          'validates a request but executes nothing — see mupot#1017 / atlas G-1b.',
        workflowId: body.workflowId,
        tenantSlug,
      },
      501,
    )
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

    // NOT IMPLEMENTED — same class as /workflows/execute above, and refused the same way.
    //
    // This handler performed NO LOOKUP OF ANY KIND. It mapped over the caller's own
    // `requiredScopes` and returned `satisfied: true` for every one of them, plus
    // `allSatisfied: true` — so it answered YES to `admin.everything` exactly as
    // readily as to `github.repo`. A credentials check that cannot say no is not a
    // check; it is a rubber stamp with a 200 on it.
    //
    // Worse than the always-yes was the `vaultKeyId`. It was string-substituted out of
    // the scope name (`vault_${scope.replace('.','_')}_key`) — an identifier shaped
    // exactly like a real vault key reference, pointing at nothing. That value is the
    // kind that gets logged, persisted into a caller's config, quoted in an audit
    // trail, and believed. A fabricated identifier is worse than a missing one because
    // the missing one is visibly missing (mupot#1085).
    //
    // WHY NOT IMPLEMENT THE REAL LOOKUP. There is nothing to look up. The credential
    // vault (migrations/0023_connectors.sql, src/connectors/service.ts) stores
    // `connectors(id, tenant, type, label, encrypted_secret, meta, scope_type,
    // scope_id, ...)`. Its `type` vocabulary is telegram | instantly | ghl | apify |
    // mcpwp | custom | linear | github_app — there is no `google-oauth2` provider, no
    // OAuth-scope column, and no mapping anywhere in this repo from the catalog's
    // scope strings (`google.analytics`, `search.console`, `github.repo`,
    // `inkwell.cms`) to a connector row. `scope_type` in that table means squad|agent|
    // pot — grantee scope, not OAuth scope. The names collide; the concepts do not.
    // Implementing "the real lookup" would mean inventing the scope model first.
    //
    // WHY NOT DELETE THE ROUTE. Zero callers, verified: nothing in this repo and
    // nothing in the ToRivers v2 tree (/mnt/HC_Volume_104325311/torivers-v2 — its
    // packages/shared/src/credentials/matching.ts is a self-contained local module
    // that never calls the pot) issues this request. Deletion was the smaller fix and
    // was considered. It loses on one point: GET /marketplace/automations below still
    // advertises a `requiredScopes` array on every automation, so the matching contract
    // is published even though the engine behind it is not. A bare 404 tells an
    // integrator the endpoint is gone; a 501 tells them it is declared and unbuilt,
    // which is the true state. When the scope model lands, delete this block — not the
    // route — and the test below must be updated deliberately rather than removed.
    //
    // A missing answer is a visible gap. A fabricated YES is invisible corruption.
    return c.json(
      {
        ok: false,
        error: 'not_implemented',
        detail:
          'Credential scope matching is not built. No credential store in this pot ' +
          'records OAuth scopes, so no scope can be truthfully confirmed or denied — ' +
          'see mupot#1085. This endpoint previously confirmed every scope it was asked ' +
          'about and returned a fabricated key identifier; it now answers nothing.',
        requiredScopes: body.requiredScopes,
        tenantSlug: c.env.TENANT_SLUG || 'default',
      },
      501,
    )
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
