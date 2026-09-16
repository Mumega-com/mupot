// src/dashboard/im-settings.ts — post-setup owner-only edit surface for
// org_settings.im_bot_username (mupot#1420 incident fix, 2026-09-16).
//
// WHY THIS FILE EXISTS: the setup wizard (src/dashboard/wizard.ts) seals its
// own mutating steps once onboarding is complete (`blockIfComplete`) — a
// deliberate F1 fix so the wizard can never replay/rewind substrate config
// after go-live. That means an owner who skipped the IM step's bot-username
// field, or whose gateway bot's @username only gets picked days later, has
// NO way to ever set it again — /setup/im 409s forever post-setup. This page
// is that "later" surface, the same way /admin/divisions and /admin/members
// are the post-setup edit surfaces for the wizard's structural steps.
//
// SCOPE: this page owns exactly ONE write — org_settings.im_bot_username,
// via the SAME setSetting() helper and the SAME IM_BOT_USERNAME_RE validation
// wizard.ts's /setup/im uses (imported from ./settings, not retyped — see
// feedback on shared predicates drifting between copies). It is DISPLAY
// ONLY: nothing in the Telegram bind/redeem/authz path reads this value (see
// SETTINGS_KEYS.imBotUsername's docstring and the src/types.ts
// TELEGRAM_BOT_TOKEN incident note for the full incident this setting
// replaces — a getMe call against the WRONG bot's token).
//
// AUTH: owner gate, reusing wizard.ts's exported `isOwner` predicate — the
// exact same rule the wizard's own /setup/im write already enforces (org
// role 'owner' OR a fine-grained org-scope 'owner' capability). Never a
// second copy of that check.

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env } from '../types'
import { isOwner, type AppEnv } from './wizard'
import { SETTINGS_KEYS, getSetting, setSetting, isValidBotUsername } from './settings'
import { pageHeader, sectionPanel, emptyState, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

function saveScript(): Html {
  return html`<script>
    (function () {
      var form = document.getElementById('form-im-bot-username');
      if (!form) return;
      var status = document.getElementById('im-bot-username-status');
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var input = form.querySelector('[name=bot_username]');
        var value = (input ? input.value : '').trim();
        status.textContent = 'Saving…';
        status.className = 'status-line';
        try {
          var res = await fetch('/admin/im-settings', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bot_username: value })
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok) {
            status.textContent = 'Saved.';
            status.className = 'status-line ok';
          } else {
            status.textContent = 'Failed: ' + (data.error || res.status);
            status.className = 'status-line err';
          }
        } catch (err) {
          status.textContent = 'Network error — try again.';
          status.className = 'status-line err';
        }
      });
    })();
  </script>`
}

// Exported (mirrors src/dashboard/account.ts's exported telegramSectionBody)
// so tests can exercise the read/render path without a full HTTP round trip.
export async function imSettingsBody(env: Env): Promise<Html> {
  const raw = await getSetting(env, SETTINGS_KEYS.imBotUsername)
  const current = isValidBotUsername(raw) ? raw : null

  return html`
    ${pageHeader({
      crumbs: 'Overview / IM settings',
      title: 'IM settings',
      sub: 'The bot your members actually talk to for decisions — display only, grants no authority.',
    })}
    ${sectionPanel({
      title: 'Decision bot username',
      body: html`
        <p class="ui-sub">
          The Telegram username of the DECISION-CHANNEL bot — the gateway bot a human messages for
          <code>/needs</code>, <code>/approve</code>, and <code>/reject</code>. This is usually a
          DIFFERENT bot than the one <code>TELEGRAM_BOT_TOKEN</code> sends notifications through — mupot
          does not hold the decision bot's token, so its username cannot be looked up automatically and
          must be set here. Used only to build the "Open in Telegram" link on
          <a href="/account">My Account</a>; nothing in the connect/bind flow reads it for authorization.
        </p>
        <form id="form-im-bot-username" class="adminform" autocomplete="off">
          <label>Bot @username
            <input name="bot_username" placeholder="kayhermes_mubot" value="${current ?? ''}" maxlength="33" />
          </label>
          <button type="submit" class="btn">Save</button>
        </form>
        <div class="status-line" id="im-bot-username-status"></div>
        ${current
          ? html`<p class="ui-sub" style="margin-top:8px;">Currently set to <code>@${current}</code>.</p>`
          : emptyState({
              title: 'Not set',
              detail: 'Members see a plain pairing code with no deep link until this is configured.',
            })}
      `,
    })}
    ${saveScript()}
  `
}

export function makeImSettingsApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/admin/im-settings', async (c) => {
    if (!(await isOwner(c))) {
      return c.html(shell(c.env, 'IM settings', await imSettingsForbiddenBody()), 403)
    }
    return c.html(shell(c.env, 'IM settings', await imSettingsBody(c.env)))
  })

  interface ImSettingsBody {
    bot_username?: unknown
  }
  app.post('/admin/im-settings', async (c) => {
    if (!(await isOwner(c))) {
      return c.json({ error: 'forbidden', need: 'owner' }, 403)
    }
    let body: ImSettingsBody
    try {
      body = (await c.req.json()) as ImSettingsBody
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    if (typeof body.bot_username !== 'string') {
      return c.json({ error: 'invalid_bot_username' }, 400)
    }
    const trimmed = body.bot_username.trim().replace(/^@/, '')
    // Empty is a valid, deliberate clear (the owner unsetting a prior value) —
    // only a NON-empty, malformed value is refused.
    if (trimmed.length > 0 && !isValidBotUsername(trimmed)) {
      return c.json({ error: 'invalid_bot_username' }, 400)
    }
    await setSetting(c.env, SETTINGS_KEYS.imBotUsername, trimmed)
    return c.json({ ok: true, bot_username: trimmed || null })
  })

  return app
}

function imSettingsForbiddenBody() {
  return html`
    ${pageHeader({ crumbs: 'Overview / IM settings', title: 'IM settings' })}
    ${emptyState({
      title: 'Owner only',
      detail: 'Only the org owner can change the decision bot username.',
      hint: 'Ask whoever completed setup to update it, or have them grant you the org owner capability.',
    })}
  `
}
