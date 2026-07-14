// mupot — first-run SETUP WIZARD (the easy-onboard centerpiece).
//
// GOAL (round 3): fork → `wrangler deploy` → log in → wizard → live, with NO
// bespoke surgery. This is the owner's guided path from an empty pot to a running
// org. It is SUBSTRATE only — it seeds STRUCTURE (org name/brand, departments,
// squads, invites, model provider, IM channel, first agent). It never touches a
// tenant's business content.
//
// wizardApp — mounted by src/dashboard/index.ts at '/setup' (under the '/' mount):
//   GET  /setup            the wizard (resumes at the saved step) OR a done-summary
//   POST /setup/brand      step 1 → write org_settings org_name + brand        (owner)
//   POST /setup/model      step 5 → write org_settings model_provider/name     (owner)
//   POST /setup/im         step 6 → write org_settings im_provider/channel      (owner)
//   POST /setup/seed-agent step 7 → create first agent from a template          (owner)
//   POST /setup/step       persist furthest-reached step (resume on refresh)    (owner)
//   POST /setup/complete   step 8 → set org_settings.onboarding_complete=true   (owner)
//
// The structural steps (2 departments, 3 squads, 4 invites) do NOT get new
// endpoints — the browser POSTs straight to the EXISTING RBAC-gated APIs
// (/api/org/departments, /api/org/departments/:id/squads, /api/members/invites).
// We never duplicate those writes here. The only writes this file owns are the
// org_settings substrate-config writes (no existing API covers them) and the
// onboarding-progress markers.
//
// AUTH: owner only. Identity is server-derived (the session → AuthContext); a
// caller can never assert "I am owner" in the body. The gate accepts an org-role
// 'owner' OR a fine-grained org-capability 'owner' (resolveCapabilities). The
// hard tenant guard runs in the parent dashboard mount (auth.tenant === slug).
//
// SECRETS: this repo is PUBLIC and the wizard must never take a secret through a
// form. Model + IM steps store only the NON-secret choice (provider/channel) in
// org_settings and instruct the owner to run `wrangler secret put …` for the
// actual credential. No token ever rides the request body into storage.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Context, MiddlewareHandler } from 'hono'
import type { Env, AuthContext } from '../types'

import { resolveCapabilities, hasCapability } from '../auth/capability'
import {
  SETTINGS_KEYS,
  getAllSettings,
  setSetting,
  setSettings,
  isOnboardingComplete,
  getOnboardingStep,
} from './settings'
import { AGENT_TEMPLATES, getTemplate } from '../org/templates'
import { createAgent } from '../org/service'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

// ── model + IM choices (the non-secret config the wizard persists) ─────────────

// Providers routed through the CF AI Gateway (each needs its provider key set as a
// secret), plus Workers AI (no external key — runs on the pot's own CF account).
const MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'workers-ai'] as const
type ModelProvider = (typeof MODEL_PROVIDERS)[number]
function isModelProvider(v: unknown): v is ModelProvider {
  return typeof v === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(v)
}

// 'workers-ai' is the only provider that needs NO AI_GATEWAY_TOKEN secret — it
// runs on the pot's own Cloudflare AI binding.
function providerNeedsGatewaySecret(p: ModelProvider): boolean {
  return p !== 'workers-ai'
}

const IM_PROVIDERS = ['telegram', 'none'] as const
type ImProvider = (typeof IM_PROVIDERS)[number]
function isImProvider(v: unknown): v is ImProvider {
  return typeof v === 'string' && (IM_PROVIDERS as readonly string[]).includes(v)
}

const TOTAL_STEPS = 7

// Stored brand/org shape (step 1). Small JSON blob in org_settings.
interface BrandSetting {
  org_name: string
  brand: string
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Owner gate: org role 'owner' OR a fine-grained org-scope 'owner' capability.
 *  Identity is server-derived — never read from the body or message text. */
async function isOwner(c: Context<AppEnv>): Promise<boolean> {
  const auth = c.get('auth')
  if (!auth) return false
  if (auth.role === 'owner') return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))
  return hasCapability(grants, 'org', null, 'owner')
}

/** Owner-only middleware for the wizard's own org_settings write endpoints. */
const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isOwner(c))) {
    return c.json({ error: 'forbidden', need: 'owner' }, 403)
  }
  await next()
}

// The wizard is a ONE-TIME first-run flow. Once onboarding is complete, its
// mutating steps are sealed (F1 fix: no replay/rewind of substrate config).
// Post-onboarding edits go through the admin pages, not the wizard.
const blockIfComplete: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (await isOnboardingComplete(c.env)) {
    return c.json({ error: 'onboarding_complete', hint: 'edit via the admin pages' }, 409)
  }
  await next()
}

/** Clamp a step number into [1, TOTAL_STEPS + 1] (the +1 = the final commit). */
function clampStep(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.trunc(n), 1), TOTAL_STEPS + 1)
}

// ── app ──────────────────────────────────────────────────────────────────────

export const wizardApp = new Hono<AppEnv>()

// NOTE: the parent dashboard mount ('/') already ran requireAuth + the hard tenant
// guard before delegating here, so c.get('auth') is populated and tenant-scoped.

// GET /setup — the wizard, or a done-summary once onboarding is complete.
wizardApp.get('/', async (c) => {
  const owner = await isOwner(c)
  if (!owner) {
    return c.html(
      wizardShell(
        c.env.BRAND,
        'Setup',
        notOwnerBody(),
      ),
      403,
    )
  }

  const auth = c.get('auth')
  const [done, settings] = await Promise.all([isOnboardingComplete(c.env), getAllSettings(c.env)])

  if (done) {
    // Non-destructive: do NOT re-run the wizard. Show what was configured and link
    // to the admin surfaces where each part is now editable.
    const brand = parseBrand(settings.get(SETTINGS_KEYS.orgName), settings.get(SETTINGS_KEYS.brand))
    return c.html(
      wizardShell(
        c.env.BRAND,
        'Setup · done',
        doneSummaryBody({
          orgName: brand.org_name || c.env.BRAND,
          brand: brand.brand || c.env.BRAND,
          modelProvider: settings.get(SETTINGS_KEYS.modelProvider) ?? null,
          modelName: settings.get(SETTINGS_KEYS.modelName) ?? null,
          imProvider: settings.get(SETTINGS_KEYS.imProvider) ?? null,
          imChannel: settings.get(SETTINGS_KEYS.imChannel) ?? null,
        }),
      ),
    )
  }

  // Resume at the furthest reached step (persisted across refreshes).
  const step = clampStep(await getOnboardingStep(c.env))
  const brand = parseBrand(settings.get(SETTINGS_KEYS.orgName), settings.get(SETTINGS_KEYS.brand))
  const prefill = {
    orgName: brand.org_name,
    brand: brand.brand,
    modelProvider: settings.get(SETTINGS_KEYS.modelProvider) ?? '',
    modelName: settings.get(SETTINGS_KEYS.modelName) ?? '',
    imProvider: settings.get(SETTINGS_KEYS.imProvider) ?? '',
    imChannel: settings.get(SETTINGS_KEYS.imChannel) ?? '',
  }
  return c.html(
    wizardShell(c.env.BRAND, 'Setup', wizardBody(c.env.BRAND, auth, step, prefill)),
  )
})

// POST /setup/brand — step 1. Persist org name + brand (substrate config).
interface BrandBody {
  org_name?: unknown
  brand?: unknown
}
wizardApp.post('/brand', requireOwner, blockIfComplete, async (c) => {
  let body: BrandBody
  try {
    body = (await c.req.json()) as BrandBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isNonEmptyString(body.org_name)) return c.json({ error: 'invalid_org_name' }, 400)
  // brand is optional — default it to the org name when blank.
  const brand =
    body.brand === undefined || body.brand === null || (typeof body.brand === 'string' && body.brand.trim() === '')
      ? body.org_name.trim()
      : body.brand
  if (!isNonEmptyString(brand)) return c.json({ error: 'invalid_brand' }, 400)

  const value: BrandSetting = { org_name: body.org_name.trim(), brand: brand.trim() }
  await setSettings(c.env, {
    [SETTINGS_KEYS.orgName]: value.org_name,
    [SETTINGS_KEYS.brand]: value.brand,
  })
  return c.json({ ok: true, org_name: value.org_name, brand: value.brand })
})

// POST /setup/model — step 5. Persist the chosen provider (+ optional model name).
// NEVER stores the secret — the owner is told to `wrangler secret put AI_GATEWAY_TOKEN`.
interface ModelBody {
  provider?: unknown
  model?: unknown
}
wizardApp.post('/model', requireOwner, blockIfComplete, async (c) => {
  let body: ModelBody
  try {
    body = (await c.req.json()) as ModelBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isModelProvider(body.provider)) return c.json({ error: 'invalid_provider' }, 400)
  const provider = body.provider

  // Optional explicit model id (e.g. "claude-3-5-sonnet", "@cf/meta/llama-3.3").
  let modelName = ''
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || body.model.length > 128) {
      return c.json({ error: 'invalid_model' }, 400)
    }
    modelName = body.model.trim()
  }

  await setSettings(c.env, {
    [SETTINGS_KEYS.modelProvider]: provider,
    [SETTINGS_KEYS.modelName]: modelName,
  })

  return c.json({
    ok: true,
    provider,
    model: modelName || null,
    // Tell the client whether a secret step is still required (NON-secret signal).
    needs_secret: providerNeedsGatewaySecret(provider),
    secret_hint: providerNeedsGatewaySecret(provider)
      ? 'wrangler secret put AI_GATEWAY_TOKEN'
      : null,
  })
})

// POST /setup/im — step 6. Persist the IM provider + chosen channel. NEVER stores
// the bot token — the owner is told to set it as a secret.
interface ImBody {
  provider?: unknown
  channel?: unknown
}
wizardApp.post('/im', requireOwner, blockIfComplete, async (c) => {
  let body: ImBody
  try {
    body = (await c.req.json()) as ImBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isImProvider(body.provider)) return c.json({ error: 'invalid_provider' }, 400)
  const provider = body.provider

  // channel: a chat/channel id the bot posts into. Required for telegram, ignored
  // (stored empty) for 'none'. We store ONLY the channel id, never the bot token.
  let channel = ''
  if (provider === 'telegram') {
    if (!isNonEmptyString(body.channel)) return c.json({ error: 'invalid_channel' }, 400)
    if (typeof body.channel === 'string' && body.channel.length > 128) {
      return c.json({ error: 'invalid_channel' }, 400)
    }
    channel = body.channel.trim()
  }

  await setSettings(c.env, {
    [SETTINGS_KEYS.imProvider]: provider,
    [SETTINGS_KEYS.imChannel]: channel,
  })

  return c.json({
    ok: true,
    provider,
    channel: channel || null,
    needs_secret: provider === 'telegram',
    secret_hint: provider === 'telegram' ? 'wrangler secret put TELEGRAM_BOT_TOKEN' : null,
  })
})

// POST /setup/seed-agent — step 7. Create the first agent from a chosen template.
//
// The owner picks a template key (or sends { skip: true } to skip). On a
// non-skip request we:
//   1. Resolve the first available squad from D1 (the wizard's structural steps
//      already created at least one, but we handle the empty case gracefully).
//   2. Derive a slug from the template name (lowercase, hyphens).
//   3. Call createAgent from ./service (the same path the org API uses).
//   4. A UNIQUE conflict (slug_taken) means the agent already exists — we treat
//      that as idempotent success so re-running the wizard step does not crash.
//
// Identity is server-derived; the owner cannot supply a different role in the body.
interface SeedAgentBody {
  template_key?: unknown
  skip?: unknown
}

// slugify mirrors the client-side helper in the wizard script — same logic.
function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

wizardApp.post('/seed-agent', requireOwner, blockIfComplete, async (c) => {
  let body: SeedAgentBody
  try {
    body = (await c.req.json()) as SeedAgentBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Skip path — owner explicitly chose to skip; nothing is created.
  if (body.skip === true) {
    return c.json({ ok: true, skipped: true })
  }

  if (typeof body.template_key !== 'string' || body.template_key.trim().length === 0) {
    return c.json({ error: 'invalid_template_key' }, 400)
  }

  const template = getTemplate(body.template_key.trim())
  if (!template) {
    return c.json({ error: 'unknown_template' }, 400)
  }

  // Resolve the first squad — created during the structural steps. If none exist
  // yet (owner skipped steps 2–3), return a clear error rather than crashing.
  const squadRow = await c.env.DB.prepare(
    'SELECT id FROM squads ORDER BY created_at ASC LIMIT 1',
  ).first<{ id: string }>()

  if (!squadRow) {
    return c.json({ error: 'no_squad', hint: 'Create at least one squad in step 3 first.' }, 422)
  }

  const squadId = squadRow.id
  const slug = slugifyName(template.name)

  const result = await createAgent(c.env, squadId, {
    slug,
    name: template.name,
    role: template.role,
    okr: template.okr,
    kpi_target: template.kpi_target,
    effort: template.effort,
    autonomy: template.autonomy,
  })

  // Idempotency: a slug conflict means the agent was already seeded (e.g. the
  // owner clicked Save twice). Surface a friendly message, not a 5xx.
  if (!result.ok && result.error === 'slug_taken') {
    return c.json({ ok: true, already_exists: true, template_key: template.key })
  }

  if (!result.ok) {
    return c.json({ error: result.error }, 400)
  }

  return c.json({ ok: true, agent: result.value, template_key: template.key }, 201)
})

// POST /setup/step — persist the furthest-reached step so a refresh resumes there.
interface StepBody {
  step?: unknown
}
wizardApp.post('/step', requireOwner, blockIfComplete, async (c) => {
  let body: StepBody
  try {
    body = (await c.req.json()) as StepBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const n = typeof body.step === 'number' ? body.step : Number.parseInt(String(body.step), 10)
  if (!Number.isFinite(n)) return c.json({ error: 'invalid_step' }, 400)
  const step = clampStep(n)

  // Only ever advance the saved marker — never let a stale tab rewind progress.
  const current = await getOnboardingStep(c.env)
  const next = Math.max(current, step)
  await setSetting(c.env, SETTINGS_KEYS.onboardingStep, String(next))
  return c.json({ ok: true, step: next })
})

// POST /setup/complete — final step. Mark onboarding done (idempotent).
wizardApp.post('/complete', requireOwner, blockIfComplete, async (c) => {
  await setSettings(c.env, {
    [SETTINGS_KEYS.onboardingComplete]: 'true',
    [SETTINGS_KEYS.onboardingStep]: String(TOTAL_STEPS + 1),
  })
  return c.json({ ok: true, onboarding_complete: true })
})

// ── view helpers ───────────────────────────────────────────────────────────────

function parseBrand(orgName: string | undefined, brand: string | undefined): BrandSetting {
  return { org_name: orgName ?? '', brand: brand ?? '' }
}

// ── views ────────────────────────────────────────────────────────────────────

// THEME RESKIN (deployment-page fix, second half — see deployment.ts for the
// nav-label half): the wizard used to ship its own bespoke DARK-ONLY inline
// document shell that was never touched when the rest of the console was
// reskinned to "Console Light" — so an owner clicking the SOVEREIGNTY nav landed
// on a stale, wrong-theme dead end (worse: the nav pointed here at all, which is
// the bug deployment.ts's new /deployment page + nav change fix).
//
// First attempt was to import dashboard/index.ts's shared `shell()` directly so
// this page is byte-for-byte the same chrome as every other console page. That
// broke at runtime: index.ts does `dashboardApp.route('/setup', wizardApp)` at
// module top level, and wizard.ts importing `shell` back from index.ts closes an
// ES-module cycle — whichever module a caller imports FIRST ends up importing the
// other mid-evaluation, before its exports are initialized (proven by
// tests/wizard-seed-agent.test.ts, which imports wizard.ts directly: `wizardApp`
// resolves to `undefined` inside index.ts, and `dashboardApp.route()` throws).
// Fix: keep the wizard's shell self-contained (no cross-import), but reskin its
// tokens/fonts/header to be VISUALLY IDENTICAL to the shared shell — same palette
// values, same fonts, same theme-toggle key, so switching theme anywhere in the
// console is consistent everywhere. If a future refactor wants byte-identical
// chrome, extract `shell()` out of index.ts into its own module FIRST (so neither
// index.ts nor wizard.ts imports the other) — don't reintroduce this cycle.
function wizardShell(brand: string, title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · ${brand}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>
      /* Same token VALUES as dashboard/index.ts's shell() — kept in sync by hand
       * since this file can't import that one (see cycle note above). */
      :root {
        --bg: #f6f7f6; --surface: #fff; --text: #171b19; --text2: #454c48; --dim: #7a827d;
        --primary: #96780A; --primary-soft: #f7f1dd; --border: #e7e9e7; --hover: #f4f6f4;
        --surface2: #f4f6f4; --muted: #7a827d; --accent: #96780A; --accent2: #06b6d4;
        --ok: #16a34a; --warn: #ca8a04; --radius: 10px;
        --font-display: 'Instrument Serif', Georgia, serif;
        --font-body: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
        --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      [data-theme="dark"] {
        --bg: #0e1116; --surface: #161b22; --text: #e6edf3; --text2: #9aa7b5; --dim: #6b7685;
        --primary: #d4a017; --primary-soft: #2e2812; --border: #2a3140; --hover: #1c2230;
        --surface2: #1c2230; --muted: #9aa7b5; --accent: #d4a017; --accent2: #06b6d4;
        --ok: #3fb950; --warn: #d29922;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; background: var(--bg); color: var(--text);
        font-family: var(--font-body); font-size: 15px; line-height: 1.55;
        -webkit-font-smoothing: antialiased;
      }
      a { color: var(--primary); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header.top {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface);
        position: sticky; top: 0; z-index: 5;
      }
      header.top .brand { font-family: var(--font-display); font-size: 18px; color: var(--text); }
      header.top .brand b { color: var(--primary); font-weight: 400; }
      header.top nav { display: flex; align-items: center; gap: 16px; }
      header.top nav a { color: var(--muted); font-size: 14px; }
      header.top .theme-btn {
        width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 8px;
        background: transparent; cursor: pointer; display: flex; align-items: center;
        justify-content: center; color: var(--dim); font-size: 14px;
      }
      header.top .theme-btn:hover { background: var(--hover); color: var(--text); }
      main { max-width: 760px; margin: 0 auto; padding: 28px 24px 64px; }
      h1 { font-family: var(--font-display); font-weight: 400; font-size: 28px; margin: 0 0 4px; }
      h2 { font-size: 16px; margin: 0 0 12px; color: var(--text); }
      p.sub { color: var(--muted); font-size: 14px; margin: 0 0 20px; }
      .card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 20px 22px; margin: 16px 0;
      }
      .empty { color: var(--dim); font-size: 14px; }
      .kv { display: grid; grid-template-columns: 150px 1fr; gap: 8px 14px; font-size: 14px; }
      .kv dt { color: var(--muted); } .kv dd { margin: 0; }
      code {
        background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
        padding: 1px 6px; font-size: 13px; color: var(--text); font-family: var(--font-mono);
      }
      /* stepper */
      .stepper { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 22px; padding: 0; list-style: none; }
      .stepper li {
        font-size: 12px; color: var(--dim); border: 1px solid var(--border); border-radius: 999px;
        padding: 4px 12px; background: var(--surface);
      }
      .stepper li.active { color: #1b1402; background: var(--accent); border-color: var(--accent); font-weight: 600; }
      .stepper li.done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
      /* forms */
      form.wz { display: flex; flex-direction: column; gap: 14px; }
      label.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
      input, select, textarea {
        font: inherit; font-family: var(--font-body); padding: 9px 11px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg); color: var(--text); width: 100%;
      }
      textarea { min-height: 70px; resize: vertical; }
      .row { display: flex; flex-wrap: wrap; gap: 12px; }
      .row > label.fld { flex: 1; min-width: 160px; }
      .btn {
        appearance: none; cursor: pointer; font-family: var(--font-body); font-weight: 600;
        padding: 9px 18px; border-radius: 8px; border: 1px solid var(--primary);
        background: var(--primary); color: #fff;
      }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn.secondary { background: transparent; color: var(--primary); }
      .btn.ghost { background: transparent; color: var(--muted); border-color: var(--border); }
      .actions { display: flex; gap: 10px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
      .status-line { font-size: 13px; color: var(--muted); min-height: 18px; }
      .status-line.err { color: var(--warn); }
      .status-line.ok { color: var(--ok); }
      .list { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 0; }
      .pill {
        display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--surface2); font-size: 13px;
      }
      .pill .tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
      .hint { font-size: 13px; color: var(--dim); }
      .hint code { display: inline-block; margin-top: 2px; }
      .callout {
        border: 1px solid color-mix(in srgb, var(--accent2) 40%, var(--border));
        background: color-mix(in srgb, var(--accent2) 8%, var(--surface));
        border-radius: 8px; padding: 12px 14px; font-size: 13px; color: var(--muted); margin-top: 4px;
      }
      .step-panel[hidden] { display: none; }
    </style>
  </head>
  <body>
    <header class="top">
      <div class="brand"><b>${brand}</b> · setup</div>
      <nav>
        <a href="/">Overview</a>
        <a href="/auth/logout">Sign out</a>
        <button class="theme-btn" id="wz-theme-toggle" title="Toggle theme" aria-label="Toggle light/dark theme">
          <span id="wz-theme-icon">☀</span>
        </button>
      </nav>
    </header>
    <main>${body}</main>
    <script>
      (function () {
        // Same localStorage key + data-theme attribute as the main dashboard shell
        // (dashboard/index.ts), so a theme choice made anywhere in the console is
        // respected here too.
        var THEME_KEY = 'mupot-theme';
        var htmlEl = document.documentElement;
        var icon = document.getElementById('wz-theme-icon');
        function applyTheme(t) {
          if (t === 'dark') {
            htmlEl.setAttribute('data-theme', 'dark');
            if (icon) icon.textContent = '☾';
          } else {
            htmlEl.removeAttribute('data-theme');
            if (icon) icon.textContent = '☀';
          }
        }
        applyTheme(localStorage.getItem(THEME_KEY) || 'light');
        var btn = document.getElementById('wz-theme-toggle');
        if (btn) {
          btn.addEventListener('click', function () {
            var next = htmlEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            localStorage.setItem(THEME_KEY, next);
            applyTheme(next);
          });
        }
      })();
    </script>
  </body>
</html>`
}

function notOwnerBody() {
  return html`
    <h1>Setup</h1>
    <p class="sub">First-run setup is owner-only.</p>
    <div class="card">
      <p class="empty">You're signed in, but only the org <strong>owner</strong> can run the setup
        wizard. Ask whoever first logged in to this pot to complete onboarding, or have them grant you
        the org <code>owner</code> capability.</p>
      <p><a href="/">← Back to overview</a></p>
    </div>`
}

interface DoneSummary {
  orgName: string
  brand: string
  modelProvider: string | null
  modelName: string | null
  imProvider: string | null
  imChannel: string | null
}

function doneSummaryBody(s: DoneSummary) {
  return html`
    <h1>Setup complete</h1>
    <p class="sub">Your pot is configured. Edit any of this in the admin pages — re-running setup
      here is disabled so it can't clobber what you've built.</p>
    <div class="card">
      <dl class="kv">
        <dt>Organization</dt><dd>${s.orgName}</dd>
        <dt>Brand</dt><dd>${s.brand}</dd>
        <dt>Model provider</dt><dd>${s.modelProvider ?? html`<span class="empty">not set</span>`}${
          s.modelName ? html` · <code>${s.modelName}</code>` : html``
        }</dd>
        <dt>IM</dt><dd>${
          s.imProvider && s.imProvider !== 'none'
            ? html`${s.imProvider}${s.imChannel ? html` · channel <code>${s.imChannel}</code>` : html``}`
            : html`<span class="empty">not connected</span>`
        }</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Where to edit now</h2>
      <div class="list">
        <span class="pill">Org chart · departments &amp; squads → <a href="/admin/divisions">Divisions</a></span>
        <span class="pill">Team &amp; capabilities → <a href="/admin/members">Members</a></span>
        <span class="pill">Agents &amp; wake → <a href="/">Overview</a></span>
      </div>
      <p class="hint" style="margin-top:14px">Model and IM credentials are secrets — rotate them with
        <code>wrangler secret put …</code>, never through a form.</p>
    </div>`
}

interface Prefill {
  orgName: string
  brand: string
  modelProvider: string
  modelName: string
  imProvider: string
  imChannel: string
}

function stepper(current: number) {
  const labels = [
    'Org &amp; brand',
    'Departments',
    'Squads',
    'Invite team',
    'Model',
    'IM',
    'First agent',
  ]
  const items = labels
    .map((label, i) => {
      const n = i + 1
      const cls = n === current ? 'active' : n < current ? 'done' : ''
      return `<li class="${cls}" data-step="${n}">${n}. ${label}</li>`
    })
    .join('')
  return raw(`<ol class="stepper">${items}</ol>`)
}

function wizardBody(brand: string, auth: AuthContext, step: number, prefill: Prefill) {
  // The whole wizard is one document; steps are panels toggled client-side. The
  // server-rendered `step` decides which panel is visible on load (resume), and the
  // furthest-reached step is persisted to org_settings as the owner advances.
  const startStep = Math.min(step, TOTAL_STEPS)
  return html`
    <h1>Welcome to ${brand}</h1>
    <p class="sub">Signed in as ${auth.email ?? auth.userId} · owner. Six quick steps and your pot is
      live. Each step saves as you go — you can close this and pick up where you left off.</p>
    ${stepper(startStep)}

    ${stepBrandPanel(prefill)}
    ${stepDepartmentsPanel()}
    ${stepSquadsPanel()}
    ${stepInvitePanel()}
    ${stepModelPanel(prefill)}
    ${stepImPanel(prefill)}
    ${stepSeedAgentPanel()}

    ${wizardScript(startStep)}`
}

// Step 1 — org name + brand → org_settings (wizard /brand endpoint).
function stepBrandPanel(p: Prefill) {
  return html`
    <section class="step-panel" data-step="1">
      <div class="card">
        <h2>1 · Name your organization</h2>
        <p class="empty">This sets your dashboard brand. It's substrate config — you can change it
          later in admin.</p>
        <form class="wz" id="form-brand" autocomplete="off">
          <label class="fld">Organization name
            <input name="org_name" required placeholder="Acme Operations" value="${p.orgName}" />
          </label>
          <label class="fld">Brand (shown in the header — defaults to the org name)
            <input name="brand" placeholder="Acme" value="${p.brand}" />
          </label>
          <div class="actions">
            <button type="submit" class="btn">Save &amp; continue</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
      </div>
    </section>`
}

// Step 2 — departments → POST /api/org/departments (existing API).
function stepDepartmentsPanel() {
  return html`
    <section class="step-panel" data-step="2" hidden>
      <div class="card">
        <h2>2 · Create departments</h2>
        <p class="empty">The top level of your org chart — e.g. Car, House, Warehouse, Operations.
          Add a few; you can add more later.</p>
        <form class="wz" id="form-dept" autocomplete="off">
          <div class="row">
            <label class="fld">Name
              <input name="name" placeholder="Operations" />
            </label>
            <label class="fld">Slug (url id — lowercase, hyphens)
              <input name="slug" placeholder="operations" />
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn secondary">Add department</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="list" id="dept-list"></div>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="1">← Back</button>
          <button type="button" class="btn" data-next="3" id="dept-next" disabled>Continue</button>
        </div>
      </div>
    </section>`
}

// Step 3 — squads per department → POST /api/org/departments/:id/squads (existing API).
function stepSquadsPanel() {
  return html`
    <section class="step-panel" data-step="3" hidden>
      <div class="card">
        <h2>3 · Add squads</h2>
        <p class="empty">Squads live inside a department. Pick a department, then add its squads.</p>
        <form class="wz" id="form-squad" autocomplete="off">
          <label class="fld">Department
            <select name="department_id" id="squad-dept"></select>
          </label>
          <div class="row">
            <label class="fld">Squad name
              <input name="name" placeholder="Dispatch" />
            </label>
            <label class="fld">Slug
              <input name="slug" placeholder="dispatch" />
            </label>
          </div>
          <label class="fld">Charter (optional — the squad's mandate / culture)
            <textarea name="charter" placeholder="What this squad owns and how it operates."></textarea>
          </label>
          <div class="actions">
            <button type="submit" class="btn secondary">Add squad</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="list" id="squad-list"></div>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="2">← Back</button>
          <button type="button" class="btn" data-next="4">Continue</button>
        </div>
      </div>
    </section>`
}

// Step 4 — invite team → POST /api/members/invites (existing API).
function stepInvitePanel() {
  const capOptions = ['observer', 'member', 'lead', 'admin', 'owner']
    .map((c) => `<option value="${c}"${c === 'member' ? ' selected' : ''}>${c}</option>`)
    .join('')
  return html`
    <section class="step-panel" data-step="4" hidden>
      <div class="card">
        <h2>4 · Invite your team</h2>
        <p class="empty">An invite is redeemed once — first connect mints the member, their capability,
          and a workspace token (shown to them once). Scope a capability to a department, or leave it
          org-wide.</p>
        <form class="wz" id="form-invite" autocomplete="off">
          <label class="fld">Email
            <input name="email" type="email" placeholder="teammate@example.com" />
          </label>
          <div class="row">
            <label class="fld">Department (optional — org-wide if blank)
              <select name="department_id" id="invite-dept"><option value="">— org-wide —</option></select>
            </label>
            <label class="fld">Capability
              <select name="capability">${raw(capOptions)}</select>
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn secondary">Create invite</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="list" id="invite-list"></div>
        <p class="hint" style="margin-top:10px">No teammates yet? Skip — you can invite anyone later
          from the <a href="/admin/members">Members</a> page.</p>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="3">← Back</button>
          <button type="button" class="btn" data-next="5">Continue</button>
        </div>
      </div>
    </section>`
}

// Step 5 — connect model → org_settings (wizard /model endpoint). Secret stays out.
function stepModelPanel(p: Prefill) {
  const providers: { value: ModelProvider; label: string }[] = [
    { value: 'anthropic', label: 'Anthropic (via AI Gateway)' },
    { value: 'openai', label: 'OpenAI (via AI Gateway)' },
    { value: 'google', label: 'Google (via AI Gateway)' },
    { value: 'workers-ai', label: 'Workers AI (no external key)' },
  ]
  const opts = providers
    .map(
      (o) =>
        `<option value="${o.value}"${o.value === p.modelProvider ? ' selected' : ''}>${o.label}</option>`,
    )
    .join('')
  return html`
    <section class="step-panel" data-step="5" hidden>
      <div class="card">
        <h2>5 · Connect your model</h2>
        <p class="empty">Pick how your agents think. Anthropic / OpenAI / Google route through your
          Cloudflare AI Gateway; Workers AI runs on your own CF account with no external key.</p>
        <form class="wz" id="form-model" autocomplete="off">
          <label class="fld">Provider
            <select name="provider" id="model-provider">${raw(opts)}</select>
          </label>
          <label class="fld">Model id (optional — e.g. <code>claude-3-5-sonnet</code> or
            <code>@cf/meta/llama-3.3</code>)
            <input name="model" placeholder="leave blank for the provider default" value="${p.modelName}" />
          </label>
          <div class="callout" id="model-secret-hint" hidden>
            Set your gateway key as a secret (never through this form):<br />
            <code>wrangler secret put AI_GATEWAY_TOKEN</code>
          </div>
          <div class="actions">
            <button type="submit" class="btn secondary">Save provider</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="4">← Back</button>
          <button type="button" class="btn" data-next="6" id="model-next" disabled>Continue</button>
        </div>
      </div>
    </section>`
}

// Step 6 — connect IM → org_settings (wizard /im endpoint). Bot token stays a secret.
function stepImPanel(p: Prefill) {
  const providers: { value: ImProvider; label: string }[] = [
    { value: 'telegram', label: 'Telegram' },
    { value: 'none', label: 'Skip for now' },
  ]
  const opts = providers
    .map(
      (o) =>
        `<option value="${o.value}"${o.value === p.imProvider ? ' selected' : ''}>${o.label}</option>`,
    )
    .join('')
  return html`
    <section class="step-panel" data-step="6" hidden>
      <div class="card">
        <h2>6 · Connect a messenger</h2>
        <p class="empty">Optional. Connect Telegram so members can reach the pot over IM. We store only
          the channel you choose — the bot token is a secret you set yourself.</p>
        <form class="wz" id="form-im" autocomplete="off">
          <label class="fld">Provider
            <select name="provider" id="im-provider">${raw(opts)}</select>
          </label>
          <label class="fld" id="im-channel-wrap">Channel / chat id (where the bot posts)
            <input name="channel" placeholder="-1001234567890" value="${p.imChannel}" />
          </label>
          <div class="callout" id="im-token-note">
            Create a bot with <a href="https://t.me/botfather">@BotFather</a>, then set the token as a
            secret (never paste it here):<br />
            <code>wrangler secret put TELEGRAM_BOT_TOKEN</code>
          </div>
          <div class="actions">
            <button type="submit" class="btn secondary">Save channel</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="5">← Back</button>
          <button type="button" class="btn" id="im-next">Continue →</button>
        </div>
      </div>
    </section>`
}

// Step 7 — seed the first agent from a template (or skip). The browser POSTs to
// the wizard's /seed-agent endpoint which calls createAgent via service.ts.
function stepSeedAgentPanel() {
  // Build the option list from AGENT_TEMPLATES (server-side — zero client dep).
  const opts = AGENT_TEMPLATES.map(
    (t) =>
      `<option value="${t.key}">${t.name} — ${t.description}</option>`,
  ).join('')

  return html`
    <section class="step-panel" data-step="7" hidden>
      <div class="card">
        <h2>7 · Seed your first work unit</h2>
        <p class="empty">Pick a starter agent so your pot is never empty out of the box. You can
          edit every field from the agent admin panel after setup. Skip if you'd prefer to add agents
          manually.</p>
        <form class="wz" id="form-seed-agent" autocomplete="off">
          <label class="fld">Template
            <select name="template_key" id="seed-template">${raw(opts)}</select>
          </label>
          <div class="actions">
            <button type="submit" class="btn secondary" id="seed-btn">Create agent</button>
            <span class="status-line" data-status></span>
          </div>
        </form>
        <div class="callout" id="seed-done" hidden>
          Agent created — visible on your <a href="/">overview</a> right away. Ready to finish?
        </div>
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ghost" data-back="6">← Back</button>
          <button type="button" class="btn ghost" id="seed-skip">Skip →</button>
          <button type="button" class="btn" id="finish-btn" disabled>Finish setup →</button>
          <span class="status-line" id="finish-status"></span>
        </div>
      </div>
    </section>`
}

// ── client script ──────────────────────────────────────────────────────────────
// Drives the EXISTING APIs for structural steps and the wizard's own org_settings
// endpoints for config steps. All fetches are same-origin + credentialed (the
// HttpOnly session cookie rides along). Identity is never sent in the body.
function wizardScript(startStep: number) {
  return raw(`
    <script>
      (function () {
        var ORG_API = '/api/org';
        var MEMBERS_API = '/api/members';
        var SETUP_API = '/setup';
        var TOTAL = ${TOTAL_STEPS};
        var current = ${JSON.stringify(startStep)};

        function postJSON(url, method, body) {
          return fetch(url, {
            method: method || 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: body == null ? undefined : JSON.stringify(body)
          });
        }
        function getJSON(url) {
          return fetch(url, { credentials: 'same-origin' });
        }
        function setStatus(el, msg, kind) {
          if (!el) return;
          el.textContent = msg || '';
          el.className = 'status-line' + (kind ? ' ' + kind : '');
        }
        function panel(n) { return document.querySelector('.step-panel[data-step="' + n + '"]'); }
        function statusOf(form) { return form ? form.querySelector('[data-status]') : null; }

        // Auto-slug from a name field when the slug is left blank.
        function slugify(s) {
          return String(s || '').toLowerCase().trim()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        }

        function showStep(n) {
          n = Math.max(1, Math.min(TOTAL, n));
          current = n;
          for (var i = 1; i <= TOTAL; i++) {
            var p = panel(i);
            if (p) { if (i === n) p.removeAttribute('hidden'); else p.setAttribute('hidden', ''); }
          }
          // stepper
          document.querySelectorAll('.stepper li').forEach(function (li) {
            var s = Number(li.getAttribute('data-step'));
            li.className = s === n ? 'active' : (s < n ? 'done' : '');
          });
          // persist furthest-reached step (advance-only on the server)
          postJSON(SETUP_API + '/step', 'POST', { step: n }).catch(function () {});
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        // Wire generic back/next buttons.
        document.querySelectorAll('[data-next]').forEach(function (btn) {
          btn.addEventListener('click', function () { showStep(Number(btn.getAttribute('data-next'))); });
        });
        document.querySelectorAll('[data-back]').forEach(function (btn) {
          btn.addEventListener('click', function () { showStep(Number(btn.getAttribute('data-back'))); });
        });

        // ── shared state collected as we go ──
        var departments = [];

        function refreshDeptSelectors() {
          var selects = [document.getElementById('squad-dept'), document.getElementById('invite-dept')];
          selects.forEach(function (sel) {
            if (!sel) return;
            var keepBlank = sel.id === 'invite-dept';
            var prev = sel.value;
            sel.innerHTML = keepBlank ? '<option value="">— org-wide —</option>' : '';
            departments.forEach(function (d) {
              var o = document.createElement('option');
              o.value = d.id; o.textContent = d.name;
              sel.appendChild(o);
            });
            if (prev) sel.value = prev;
          });
        }
        function addPill(listEl, label, tag) {
          if (!listEl) return;
          // Built with DOM nodes + textContent only — never innerHTML — so a
          // tenant-supplied name/slug can never inject markup (no XSS surface).
          var div = document.createElement('div');
          div.className = 'pill';
          var nameEl = document.createElement('span');
          nameEl.textContent = label;
          div.appendChild(nameEl);
          if (tag) {
            var tagEl = document.createElement('span');
            tagEl.className = 'tag';
            tagEl.textContent = tag;
            div.appendChild(tagEl);
          }
          listEl.appendChild(div);
        }

        // ── step 1: brand ──
        var brandForm = document.getElementById('form-brand');
        if (brandForm) {
          brandForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(brandForm);
            var fd = new FormData(brandForm);
            var payload = { org_name: String(fd.get('org_name') || '').trim(), brand: String(fd.get('brand') || '').trim() };
            if (!payload.org_name) { setStatus(st, 'Org name is required.', 'err'); return; }
            setStatus(st, 'Saving…');
            try {
              var res = await postJSON(SETUP_API + '/brand', 'POST', payload);
              if (res.ok) { setStatus(st, 'Saved.', 'ok'); showStep(2); }
              else { var d = await res.json().catch(function(){return{};}); setStatus(st, 'Failed: ' + (d.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 2: departments ──
        var deptForm = document.getElementById('form-dept');
        var deptNext = document.getElementById('dept-next');
        if (deptForm) {
          deptForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(deptForm);
            var fd = new FormData(deptForm);
            var name = String(fd.get('name') || '').trim();
            var slug = String(fd.get('slug') || '').trim() || slugify(name);
            if (!name || !slug) { setStatus(st, 'Name (and a slug) required.', 'err'); return; }
            setStatus(st, 'Creating…');
            try {
              var res = await postJSON(ORG_API + '/departments', 'POST', { name: name, slug: slug });
              var data = await res.json().catch(function(){return{};});
              if (res.ok && data.department) {
                departments.push(data.department);
                addPill(document.getElementById('dept-list'), data.department.name, data.department.slug);
                refreshDeptSelectors();
                if (deptNext) deptNext.disabled = false;
                deptForm.reset();
                setStatus(st, 'Added.', 'ok');
              } else if (res.status === 403) { setStatus(st, 'Forbidden — owner/admin required.', 'err'); }
              else if (res.status === 409) { setStatus(st, 'That slug is taken.', 'err'); }
              else { setStatus(st, 'Failed: ' + (data.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 3: squads ──
        var squadForm = document.getElementById('form-squad');
        if (squadForm) {
          squadForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(squadForm);
            var fd = new FormData(squadForm);
            var deptId = String(fd.get('department_id') || '');
            var name = String(fd.get('name') || '').trim();
            var slug = String(fd.get('slug') || '').trim() || slugify(name);
            var charter = String(fd.get('charter') || '').trim();
            if (!deptId) { setStatus(st, 'Pick a department first.', 'err'); return; }
            if (!name || !slug) { setStatus(st, 'Squad name (and slug) required.', 'err'); return; }
            var body = { name: name, slug: slug };
            if (charter) body.charter = charter;
            setStatus(st, 'Creating…');
            try {
              var res = await postJSON(ORG_API + '/departments/' + encodeURIComponent(deptId) + '/squads', 'POST', body);
              var data = await res.json().catch(function(){return{};});
              if (res.ok && data.squad) {
                var deptName = (departments.find(function (d) { return d.id === deptId; }) || {}).name || '';
                addPill(document.getElementById('squad-list'), data.squad.name, deptName);
                squadForm.querySelector('[name=name]').value = '';
                squadForm.querySelector('[name=slug]').value = '';
                squadForm.querySelector('[name=charter]').value = '';
                setStatus(st, 'Added.', 'ok');
              } else if (res.status === 403) { setStatus(st, 'Forbidden — admin on that department required.', 'err'); }
              else if (res.status === 409) { setStatus(st, 'That slug is taken in this department.', 'err'); }
              else { setStatus(st, 'Failed: ' + (data.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 4: invites ──
        var inviteForm = document.getElementById('form-invite');
        if (inviteForm) {
          inviteForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(inviteForm);
            var fd = new FormData(inviteForm);
            var email = String(fd.get('email') || '').trim();
            var dept = String(fd.get('department_id') || '');
            var cap = String(fd.get('capability') || 'member');
            if (!email) { setStatus(st, 'Email is required.', 'err'); return; }
            var payload = { email: email, capability: cap };
            if (dept) payload.department_id = dept;
            setStatus(st, 'Creating invite…');
            try {
              var res = await postJSON(MEMBERS_API + '/invites', 'POST', payload);
              var data = await res.json().catch(function(){return{};});
              if (res.ok && data.invite) {
                addPill(document.getElementById('invite-list'), email, cap + (dept ? ' · scoped' : ' · org'));
                inviteForm.querySelector('[name=email]').value = '';
                setStatus(st, 'Invite created — share the accept link from Members.', 'ok');
              } else if (res.status === 403) { setStatus(st, 'Forbidden — admin on this scope required.', 'err'); }
              else { setStatus(st, 'Failed: ' + (data.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 5: model ──
        var modelForm = document.getElementById('form-model');
        var modelProvider = document.getElementById('model-provider');
        var modelSecretHint = document.getElementById('model-secret-hint');
        var modelNext = document.getElementById('model-next');
        function syncModelHint() {
          if (!modelProvider || !modelSecretHint) return;
          var needs = modelProvider.value !== 'workers-ai';
          if (needs) modelSecretHint.removeAttribute('hidden'); else modelSecretHint.setAttribute('hidden', '');
        }
        if (modelProvider) { modelProvider.addEventListener('change', syncModelHint); syncModelHint(); }
        if (modelForm) {
          modelForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(modelForm);
            var fd = new FormData(modelForm);
            var payload = { provider: String(fd.get('provider') || ''), model: String(fd.get('model') || '').trim() };
            setStatus(st, 'Saving…');
            try {
              var res = await postJSON(SETUP_API + '/model', 'POST', payload);
              var data = await res.json().catch(function(){return{};});
              if (res.ok) {
                setStatus(st, data.needs_secret ? 'Saved. Remember to set AI_GATEWAY_TOKEN as a secret.' : 'Saved.', 'ok');
                if (modelNext) modelNext.disabled = false;
              } else { setStatus(st, 'Failed: ' + (data.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 6: IM ──
        var imForm = document.getElementById('form-im');
        var imProvider = document.getElementById('im-provider');
        var imChannelWrap = document.getElementById('im-channel-wrap');
        var imTokenNote = document.getElementById('im-token-note');
        function syncImVisibility() {
          if (!imProvider) return;
          var isTg = imProvider.value === 'telegram';
          if (imChannelWrap) imChannelWrap.style.display = isTg ? '' : 'none';
          if (imTokenNote) imTokenNote.style.display = isTg ? '' : 'none';
        }
        if (imProvider) { imProvider.addEventListener('change', syncImVisibility); syncImVisibility(); }
        var imSaved = false;
        if (imForm) {
          imForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(imForm);
            var fd = new FormData(imForm);
            var provider = String(fd.get('provider') || 'none');
            var payload = { provider: provider };
            if (provider === 'telegram') payload.channel = String(fd.get('channel') || '').trim();
            setStatus(st, 'Saving…');
            try {
              var res = await postJSON(SETUP_API + '/im', 'POST', payload);
              var data = await res.json().catch(function(){return{};});
              if (res.ok) { imSaved = true; setStatus(st, data.needs_secret ? 'Saved. Set TELEGRAM_BOT_TOKEN as a secret.' : 'Saved.', 'ok'); }
              else { setStatus(st, 'Failed: ' + (data.error || res.status), 'err'); }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); }
          });
        }

        // ── step 7: seed agent + finish ──
        // When the owner navigates to step 7 (via im-next or resume), ensure the
        // IM setting is persisted (if they clicked Continue without saving it first).
        var imNextBtn = document.getElementById('im-next');
        if (imNextBtn) {
          imNextBtn.addEventListener('click', async function () {
            if (!imSaved && imForm) {
              var prov = imProvider ? imProvider.value : 'none';
              var b = { provider: prov };
              if (prov === 'telegram') {
                var ch = String(new FormData(imForm).get('channel') || '').trim();
                if (ch) b.channel = ch; else b.provider = 'none';
              }
              await postJSON(SETUP_API + '/im', 'POST', b).catch(function(){});
            }
            showStep(7);
          });
        }

        var seedForm = document.getElementById('form-seed-agent');
        var seedDone = document.getElementById('seed-done');
        var finishBtn = document.getElementById('finish-btn');
        var finishStatus = document.getElementById('finish-status');
        var seedSkip = document.getElementById('seed-skip');

        // Un-gate the Finish button once either seed or skip has been actioned.
        function unlockFinish() {
          if (finishBtn) finishBtn.disabled = false;
        }

        if (seedForm) {
          seedForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var st = statusOf(seedForm);
            var fd = new FormData(seedForm);
            var templateKey = String(fd.get('template_key') || '').trim();
            if (!templateKey) { setStatus(st, 'Pick a template first.', 'err'); return; }
            setStatus(st, 'Creating agent…');
            var seedBtn = document.getElementById('seed-btn');
            if (seedBtn) seedBtn.disabled = true;
            try {
              var res = await postJSON(SETUP_API + '/seed-agent', 'POST', { template_key: templateKey });
              var data = await res.json().catch(function(){return{};});
              if (res.ok) {
                setStatus(st, data.already_exists ? 'Agent already exists — good to go.' : 'Agent created.', 'ok');
                if (seedDone) seedDone.removeAttribute('hidden');
                unlockFinish();
              } else if (res.status === 422) {
                // no squad yet — let the owner skip and add agents manually.
                setStatus(st, 'No squad found — skip and add agents manually after setup.', 'err');
                if (seedBtn) seedBtn.disabled = false;
              } else {
                setStatus(st, 'Failed: ' + (data.error || res.status), 'err');
                if (seedBtn) seedBtn.disabled = false;
              }
            } catch (err) { setStatus(st, 'Request errored.', 'err'); if (seedBtn) seedBtn.disabled = false; }
          });
        }

        if (seedSkip) {
          seedSkip.addEventListener('click', async function () {
            seedSkip.disabled = true;
            await postJSON(SETUP_API + '/seed-agent', 'POST', { skip: true }).catch(function(){});
            unlockFinish();
          });
        }

        if (finishBtn) {
          finishBtn.addEventListener('click', async function () {
            finishBtn.disabled = true;
            setStatus(finishStatus, 'Finishing…');
            try {
              var res = await postJSON(SETUP_API + '/complete', 'POST', {});
              if (res.ok) { setStatus(finishStatus, 'Done — your pot is live.', 'ok'); setTimeout(function () { location.href = '/'; }, 700); }
              else { finishBtn.disabled = false; setStatus(finishStatus, 'Could not finish (' + res.status + ').', 'err'); }
            } catch (err) { finishBtn.disabled = false; setStatus(finishStatus, 'Request errored.', 'err'); }
          });
        }

        // ── load existing departments (resume) so steps 3 & 4 have selectors ──
        (async function () {
          try {
            var res = await getJSON(ORG_API + '/departments');
            if (res.ok) {
              var data = await res.json().catch(function(){return{};});
              departments = (data.departments || []);
              departments.forEach(function (d) { addPill(document.getElementById('dept-list'), d.name, d.slug); });
              refreshDeptSelectors();
              if (departments.length > 0 && deptNext) deptNext.disabled = false;
            }
          } catch (err) {}
          showStep(current);
        })();
      })();
    </script>`)
}
