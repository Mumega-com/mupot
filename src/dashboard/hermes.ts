// mupot — Hermes surface panel (Port 3). Chat front-door on the pot dashboard.
//
// Mounted at GET /hermes. Cookie-authed members talk to Hermes-Sol here; the
// panel posts to POST /hermes/chat (same origin, CSRF-gated like other dashboard
// mutations). The member-bearer twin lives at POST /api/hermes/chat for the
// Hermes daemon.

import { html } from 'hono/html'
import type { HermesChatResult } from '../hermes/constant'

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function hermesPanelBody(
  result: HermesChatResult | null,
  error: string | null,
) {
  const replyBlock = result
    ? html`<div class="hermes-reply" data-tier="${result.route.tier}">
        <div class="hermes-meta">
          <span class="ui-pill">${result.route.tier}</span>
          <span class="muted">${esc(result.route.reason)}</span>
          ${result.taskId
            ? html`<span class="ui-pill">task ${esc(result.taskId.slice(0, 8))}</span>`
            : ''}
          ${result.wokeOpusAgentId
            ? html`<span class="ui-pill">woke opus</span>`
            : ''}
        </div>
        <pre class="hermes-text">${esc(result.reply)}</pre>
      </div>`
    : ''

  const errorBlock = error
    ? html`<p class="error" role="alert">${esc(error)}</p>`
    : ''

  return html`
    <style>
      .hermes-wrap { max-width: 720px; margin: 0 auto; }
      .hermes-lead { color: var(--muted); font-size: 14px; margin: 8px 0 20px; line-height: 1.45; }
      .hermes-form textarea {
        width: 100%; min-height: 110px; resize: vertical;
        background: var(--surface); color: var(--text);
        border: 1px solid var(--border); border-radius: 10px;
        padding: 12px 14px; font: inherit; line-height: 1.45;
      }
      .hermes-form .row { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
      .hermes-reply {
        margin-top: 22px; padding: 14px 16px; border-radius: 12px;
        border: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 88%, var(--accent) 12%);
      }
      .hermes-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
      .hermes-text {
        white-space: pre-wrap; word-break: break-word; margin: 0;
        font-family: var(--font-sans, inherit); font-size: 14.5px; line-height: 1.5;
      }
      .hermes-tiers { display: flex; gap: 14px; flex-wrap: wrap; margin: 0 0 18px; font-size: 12px; color: var(--muted); }
      .error { color: var(--danger, #c44); margin-top: 12px; }
      .muted { color: var(--muted); font-size: 12px; }
      .sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
      }
    </style>
    <div class="hermes-wrap">
      <h1>Hermes</h1>
      <p class="hermes-lead">
        Always-on chat front-door. Luna handles heartbeat; Sol reasons; hard calls wake Kasra (Opus).
      </p>
      <div class="hermes-tiers">
        <span>Luna · heartbeat</span>
        <span>Sol · reasoning / dispatch</span>
        <span>Opus · hard-call wake</span>
      </div>
      <form class="hermes-form" method="post" action="/hermes/chat">
        <label for="hermes-message" class="sr-only">Message</label>
        <textarea id="hermes-message" name="message" maxlength="4000" required placeholder="Talk to Hermes…"></textarea>
        <div class="row">
          <button type="submit" class="btn">Send</button>
          <span class="muted">Dispatches tasks · wakes Opus on hard calls</span>
        </div>
      </form>
      ${errorBlock}
      ${replyBlock}
    </div>
  `
}
