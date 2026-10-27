// src/dashboard/security-bar.ts — GET/POST /admin/security-bar: the Security Bar settings page.
//
// GET  any signed-in member: the level plus a YAML-style read view of every rule's effective value (floors are
//      marked read-only). The change forms render only for the owner.
// POST owner only (the SAME `isOwner` predicate the wizard and /admin/im-settings use):
//        { action: 'set',            level }   raise only; always allowed for the owner
//        { action: 'request_lower',  level }   needs a fresh re-auth (this page links /auth/reauth?return=/admin/security-bar)
//        { action: 'confirm_lower' }           second owner, or the same owner after the delay
// Lowering is two explicit calls; nothing here downgrades on a timer (src/policy/admin.ts).

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env } from '../types'
import { isOwner, type AppEnv } from './wizard'
import { pageHeader, sectionPanel, type Html } from './ui'
import { barView } from '../policy/bar'
import { confirmLower, raiseLevel, requestLower } from '../policy/admin'
import { LEVEL_RANK, POLICY_LEVELS, POLICY_RULES, isPolicyLevel, type PolicyLevel } from '../policy/registry'

type ShellFn = (env: Env, title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => HtmlEscapedString | Promise<HtmlEscapedString>

/** The YAML-style read view. Exported for tests: pure of HTML so it can be asserted as text. */
export function renderBarYaml(level: PolicyLevel, source: string, version: number | null): string {
  const lines: string[] = ['security_bar:', `  level: ${level}`, `  source: ${source}`, `  version: ${version ?? 'none'}`, 'rules:']
  for (const r of POLICY_RULES) {
    const effective = r.floor ? 'strict' : r.values[level]
    lines.push(`  ${r.id}:`)
    lines.push(`    floor: ${r.floor}${r.floor ? '  # read-only: the bar cannot change this' : ''}`)
    if (r.todo) lines.push(`    todo: ${r.todo}`)
    for (const l of POLICY_LEVELS) lines.push(`    ${l}: ${r.values[l]}`)
    lines.push(`    effective: ${effective}`)
  }
  return lines.join('\n')
}

/** Shared by the browser and tests so every outcome gives the owner a concrete next step. */
export function barResultMessage(data: { applied?: boolean; unchanged?: boolean; pending?: { needs_second_owner: boolean; effective_after: string }; error?: string; retry_after?: string }): string {
  if (data.unchanged) return 'Already at this level. Choose another level to change it.'
  if (data.applied) return 'Applied. Review the current level and rules below.'
  if (data.pending) return data.pending.needs_second_owner
    ? 'Lowering requested. Ask a different owner who held ownership before the request to sign in and confirm.'
    : 'Lowering requested. Reauthenticate and confirm after ' + data.pending.effective_after + '.'
  switch (data.error) {
    case 'delay_not_elapsed': return 'Wait until ' + data.retry_after + ', then reauthenticate and confirm the pending lowering.'
    case 'second_owner_required': return 'Ask a different owner who held ownership before the request to sign in and confirm.'
    case 'reauth_required': return 'Confirm it is you, then return and try again.'
    case 'conflict': return 'The level or request changed. Reload this page and retry.'
    case 'no_pending_request': return 'No pending lowering. Reload this page and request a lowering first.'
    case 'owner_required': return 'Sign in as an org owner to change the level.'
    case 'state_unreadable': return 'The current level could not be read. Retry after service is restored.'
    default: return 'Not applied: ' + (data.error || 'request failed') + '. Reload this page and retry.'
  }
}

export async function securityBarBody(env: Env, owner: boolean): Promise<Html> {
  const v = await barView(env)
  const yaml = renderBarYaml(v.level, v.source, v.version)
  const pending = v.pending_lower
  return html`
    ${pageHeader({ crumbs: 'Overview / Security bar', title: 'Security bar', sub: `Level: ${v.level}. Floors never change at any level.`, badge: v.level })}
    ${sectionPanel({
      title: 'Level',
      body: html`
        <p class="ui-sub">
          <b>onboarding</b>: opt in to friction relaxations; every relaxed use is logged. <b>operating</b>: all rules strict, exactly today's behaviour (also the default when no level is set).
          <b>under_attack</b>: strictest. Raising is immediate; lowering needs a fresh sign-in check plus a second owner (or a 24-hour wait).
        </p>
        ${pending
          ? html`<p class="ui-sub" id="bar-pending">Lowering to <b>${pending.target_level}</b> was requested by ${pending.requested_by}.
              ${pending.needs_second_owner ? 'A different owner must confirm.' : html`It can be confirmed after ${pending.effective_after}.`}</p>`
          : html``}
        ${owner
          ? html`<form id="form-bar" class="adminform">
              <label>Set level
                <select name="level">${POLICY_LEVELS.map((l) => html`<option value="${l}" ${l === v.level ? 'selected' : ''}>${l}</option>`)}</select>
              </label>
              <button type="submit" class="btn">Apply</button>
              ${pending ? html`<button type="button" class="btn" id="bar-confirm">Confirm pending lowering</button>` : html``}
            </form>
            <div class="status-line" id="bar-status"></div>
            <script>
              (function () {
                var form = document.getElementById('form-bar'); var status = document.getElementById('bar-status');
                var resultMessage = ${raw(barResultMessage.toString())};
                var rank = { onboarding: 0, operating: 1, under_attack: 2 }; var current = '${v.level}';
                async function send(payload) {
                  var res = await fetch('/admin/security-bar', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
                  var data = await res.json().catch(function () { return {}; });
                  if (res.ok) { status.textContent = resultMessage(data); status.className = 'status-line ok'; setTimeout(function () { location.reload(); }, 800); }
                  else if (data.error === 'reauth_required') { status.textContent = ''; var a = document.createElement('a'); a.href = '/auth/reauth?return=/admin/security-bar'; a.textContent = 'Confirm it is you first'; status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.')); }
                  else { status.textContent = resultMessage(data); status.className = 'status-line err'; }
                }
                form.addEventListener('submit', function (e) { e.preventDefault(); var level = form.querySelector('[name=level]').value; send({ action: rank[level] < rank[current] ? 'request_lower' : 'set', level: level }); });
                var c = document.getElementById('bar-confirm'); if (c) c.addEventListener('click', function () { send({ action: 'confirm_lower' }); });
              })();
            </script>`
          : html`<p class="ui-sub">Only the org owner can change the level.</p>`}
      `,
    })}
    ${sectionPanel({ title: 'Rules (read-only view)', body: html`<pre id="bar-yaml">${yaml}</pre>` })}
  `
}

export function makeSecurityBarApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/admin/security-bar', async (c) => {
    if (!c.get('auth')) return c.json({ error: 'unauthorized' }, 401)
    return c.html(shell(c.env, 'Security bar', await securityBarBody(c.env, await isOwner(c))))
  })

  app.post('/admin/security-bar', async (c) => {
    if (!(await isOwner(c))) return c.json({ error: 'forbidden', need: 'owner' }, 403)
    const auth = c.get('auth')
    let body: { action?: unknown; level?: unknown }
    try {
      body = (await c.req.json()) as { action?: unknown; level?: unknown } // untrusted JSON: every field is checked below
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    if (body.action === 'set' || body.action === 'request_lower') {
      if (!isPolicyLevel(body.level)) return c.json({ error: 'invalid_level' }, 400)
      const view = await barView(c.env)
      const current = view.level
      if (body.level === current && view.source !== 'malformed' && view.source !== 'read_failed') {
        return c.json({ ok: true, level: current, version: view.version, applied: false, unchanged: true })
      }
      // The server decides raise vs lower from the stored level; the client's action label never selects the weaker path.
      const out = LEVEL_RANK[body.level] >= LEVEL_RANK[current] ? await raiseLevel(c.env, auth, body.level) : await requestLower(c.env, auth, body.level)
      return out.ok ? c.json(out) : c.json({ error: out.error }, out.error === 'reauth_required' || out.error === 'owner_required' ? 403 : 409)
    }
    if (body.action === 'confirm_lower') {
      const out = await confirmLower(c.env, auth)
      return out.ok ? c.json(out) : c.json({ error: out.error, ...(out.retry_after ? { retry_after: out.retry_after } : {}) }, out.error === 'reauth_required' || out.error === 'owner_required' ? 403 : 409)
    }
    return c.json({ error: 'invalid_action' }, 400)
  })

  return app
}
