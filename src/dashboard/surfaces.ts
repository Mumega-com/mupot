// mupot — surface panel dashboard views (Port 5).

import { html } from 'hono/html'
import type { Env } from '../types'
import { getSurfacePanel, listSurfacePanels } from '../surfaces/port'
import '../surfaces/hermes' // self-register Hermes panel

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function resolveExternalUrl(env: Env, envKey: string | undefined): string | null {
  if (!envKey) return null
  const secrets = env as unknown as Record<string, string | undefined>
  const raw = secrets[envKey]
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.toString()
  } catch {
    return null
  }
}

/** GET /surfaces — index of registered surface panels. */
export function surfacesIndexBody() {
  const panels = listSurfacePanels()
  const rows = panels.length === 0
    ? html`<p class="muted">No surface panels registered.</p>`
    : html`<ul class="surface-list">
        ${panels.map(
          (p) => html`<li><a href="${esc(p.path)}">${esc(p.title)}</a>
            <span class="muted">· ${esc(p.adapter)}</span></li>`,
        )}
      </ul>`

  return html`
    <style>
      .surface-wrap { max-width: 720px; margin: 0 auto; }
      .surface-lead { color: var(--muted); font-size: 14px; margin: 8px 0 20px; line-height: 1.45; }
      .surface-list { list-style: none; padding: 0; margin: 0; }
      .surface-list li { padding: 10px 0; border-bottom: 1px solid var(--border); }
      .muted { color: var(--muted); font-size: 12px; }
    </style>
    <div class="surface-wrap">
      <h1>Surfaces</h1>
      <p class="surface-lead">
        Dashboards mounted as mupot panels. Auth stays on the kernel; panels never become a second control plane.
      </p>
      ${rows}
    </div>
  `
}

/** GET /surfaces/:id — one panel (Hermes embeds HERMES_DASHBOARD_URL when set). */
export function surfacePanelBody(env: Env, panelId: string) {
  const panel = getSurfacePanel(panelId)
  if (!panel) {
    return html`
      <div class="surface-wrap">
        <h1>Surface not found</h1>
        <p class="muted">No panel registered as <code>${esc(panelId)}</code>.</p>
        <p><a href="/surfaces">← All surfaces</a></p>
      </div>
    `
  }

  const externalUrl = resolveExternalUrl(env, panel.externalUrlEnvKey)

  const embed = externalUrl
    ? html`<iframe
        class="surface-frame"
        title="${esc(panel.title)}"
        src="${esc(externalUrl)}"
        referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      ></iframe>`
    : html`<div class="surface-empty">
        <p>Hermes panel is mounted. Set <code>HERMES_DASHBOARD_URL</code> (https) as a Worker var/secret to embed the Hermes dashboard here.</p>
        <p class="muted">Until then this is a read-through shell — no second control plane, no ungated actions.</p>
      </div>`

  return html`
    <style>
      .surface-wrap { max-width: 1100px; margin: 0 auto; }
      .surface-lead { color: var(--muted); font-size: 14px; margin: 8px 0 16px; line-height: 1.45; }
      .surface-frame {
        width: 100%; height: min(78vh, 860px); border: 1px solid var(--border);
        border-radius: 12px; background: var(--surface);
      }
      .surface-empty {
        padding: 28px 24px; border: 1px dashed var(--border); border-radius: 12px;
        background: color-mix(in srgb, var(--surface) 90%, var(--accent) 10%);
        line-height: 1.5; font-size: 14px;
      }
      .muted { color: var(--muted); font-size: 12px; }
    </style>
    <div class="surface-wrap">
      <h1>${esc(panel.title)}</h1>
      <p class="surface-lead">
        Surface port · adapter <code>${esc(panel.adapter)}</code>
        · <a href="/surfaces">all panels</a>
      </p>
      ${embed}
    </div>
  `
}
