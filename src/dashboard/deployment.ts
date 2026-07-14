// mupot — dashboard /deployment: the pot's actual live deployment identity.
//
// Replaces the mislabeled SOVEREIGNTY "Deployment" nav item, which used to point at
// the first-run /setup wizard (onboarding, not deployment — see wizard.ts). This
// page answers "what is actually live right now" for an owner/admin:
//   - public API version (src/version.ts)
//   - the exact-SHA release identity (env.RELEASE_SHA), the same value the pot's
//     own GET /health reports as `commit` (src/health.ts) — reused here, not
//     re-derived, so the dashboard can never drift from what /health says
//   - tenant slug + liveness (env.TENANT_SLUG / publicHealth().ok)
//   - honest redeploy guidance (this is a self-hosted CF pot; redeploy is an owner
//     `wrangler deploy` operation, never a dashboard button — see CLAUDE.md "arms
//     never publish/deploy" discipline)
//
// Read-only. No writes, no migration, no real deploy trigger. Only public-safe
// deployment identity is rendered — never a secret/token/key value.
//
// Data: pure aggregation of already-public fields (publicHealth + org_settings
// onboarding flag). No new D1 tables, no new queries beyond the existing
// isOnboardingComplete() read the wizard/overview already perform.

import { html } from 'hono/html'
import type { Env } from '../types'
import { publicHealth } from '../health'
import { isOnboardingComplete } from './settings'

export interface DeploymentData {
  tenant: string
  version: string
  commit: string | null // 40-hex RELEASE_SHA, or null when unset/invalid (unstamped deploy)
  ok: boolean // liveness — the same `ok` GET /health reports
  onboarded: boolean
}

// ── load ──────────────────────────────────────────────────────────────────────

export async function loadDeployment(env: Env): Promise<DeploymentData> {
  const health = publicHealth(env.TENANT_SLUG, env.RELEASE_SHA)
  const onboarded = await isOnboardingComplete(env)
  return {
    tenant: health.tenant,
    version: health.version,
    commit: health.commit,
    ok: health.ok,
    onboarded,
  }
}

// ── view ──────────────────────────────────────────────────────────────────────

function shaBadge(commit: string | null) {
  if (commit) {
    return html`<code class="inline">${commit.slice(0, 12)}</code>
      <span class="tag" style="margin-left:6px">full: <code class="inline">${commit}</code></span>`
  }
  return html`<span class="tag" style="color:var(--warn);border-color:color-mix(in srgb, var(--warn) 45%, var(--border))">not stamped</span>`
}

export function deploymentBody(d: DeploymentData) {
  const onboardingNudge = !d.onboarded
    ? html`<div class="warn-box">
        <strong>First-run setup isn't finished.</strong> This pot is live and reachable, but the
        owner has not completed onboarding yet. <a href="/setup">Finish first-run setup →</a>
      </div>`
    : html``

  const shaWarning = !d.commit
    ? html`<div class="warn-box">
        <strong>Release SHA not set.</strong> <code class="inline">RELEASE_SHA</code> is unset or
        not a valid 40-character commit hash, which means this deploy was not stamped with an
        exact-commit identity. <code class="inline">GET /health</code> will report
        <code class="inline">commit: null</code> until a deploy sets it.
      </div>`
    : html``

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Deployment</p>
    <h1>Deployment</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      This is your sovereign deployment — what is actually live on this pot right now, straight
      from <code class="inline">GET /health</code>. This is not a control panel: nothing on this
      page writes anything or triggers a deploy.
    </p>

    ${onboardingNudge}
    ${shaWarning}

    <div class="card">
      <dl class="kv">
        <dt>Version</dt>
        <dd><code class="inline">${d.version}</code></dd>
        <dt>Commit</dt>
        <dd>${shaBadge(d.commit)}</dd>
        <dt>Tenant</dt>
        <dd><code class="inline">${d.tenant}</code></dd>
        <dt>Health</dt>
        <dd>${
          d.ok
            ? html`<span class="tag" style="color:var(--ok);border-color:color-mix(in srgb, var(--ok) 45%, var(--border))">● live</span>`
            : html`<span class="tag" style="color:var(--warn);border-color:color-mix(in srgb, var(--warn) 45%, var(--border))">● degraded</span>`
        } <span class="empty" style="padding:0">— this responded, so the worker is serving. For deep
          operator diagnostics (agents, tasks, integrations, schema) see <a href="/ops">Health</a>.</span></dd>
        <dt>Onboarding</dt>
        <dd>${
          d.onboarded
            ? html`<span class="tag" style="color:var(--ok);border-color:color-mix(in srgb, var(--ok) 45%, var(--border))">complete</span>`
            : html`<span class="tag">not finished · <a href="/setup">run setup</a></span>`
        }</dd>
      </dl>
    </div>

    <h2>Redeploy this pot</h2>
    <div class="card">
      <p class="empty" style="padding-top:0">
        This is a self-hosted, sovereign Cloudflare pot. Redeploying is an owner operation from
        your own machine or CI — there is no "deploy" button in this dashboard on purpose (a
        dashboard click should never be able to push a new build to production).
      </p>
      <pre class="snippet">npm run deploy
# or, equivalently:
npx wrangler deploy</pre>
      <p class="empty">
        For the full self-host / redeploy runbook (secrets, migrations, config), see
        <code class="inline">docs/SELF-HOST.md</code> and <code class="inline">docs/production-runbook.md</code>
        in this pot's repository.
      </p>
      <p class="empty">
        To make <code class="inline">GET /health</code> report an exact commit identity, deploy
        with <code class="inline">RELEASE_SHA</code> set to the commit you're shipping, e.g.
        <code class="inline">RELEASE_SHA=$(git rev-parse HEAD) npx wrangler deploy</code>.
      </p>
    </div>
  `
}
