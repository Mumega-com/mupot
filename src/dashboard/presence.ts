// src/dashboard/presence.ts — the dashboard half of "widening decisions need human presence".
//
// presenceGate() is the ONE call every authority-widening dashboard route makes, AFTER its own authorisation checks and
// BEFORE its write:
//   * `?presence_grant=<id>` present and redeemable for exactly this decision (member, kind, subject, parameter digest)
//     -> returns null and the route proceeds (the grant is consumed by that very call);
//   * otherwise nothing is written: a pending grant is filed and the caller gets 403 with the secure-host passkey link
//     (JSON for fetch routes, a page for form routes).
// GET /presence/:id is the return page: it re-posts the approved decision to its own route with the satisfied grant.
// Nothing here has authority; a session + fresh sign-in alone can never make presenceGate return null.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { loadPresenceGrant, type PresenceSpec, type PresenceValue } from '../approvals/human-presence'
import { PRESENCE_MESSAGES, presenceCheck, presenceGateJson } from '../approvals/gate'
import { pageHeader, sectionPanel, type Html } from './ui'

type ShellFn = (env: Env, title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => HtmlEscapedString | Promise<HtmlEscapedString>
type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
/**
 * Dashboard form/JSON routes: null = proceed, else the refusal Response (JSON for fetch routes, a page with the passkey link for
 * form routes). `shell` is only needed for form routes. `memberId` is the SESSION member, never a request field.
 */
export async function presenceGate(c: Context, shell: ShellFn | null, memberId: string | null | undefined, spec: PresenceSpec): Promise<Response | null> {
  if (spec.encoding === 'json' || shell === null) return presenceGateJson(c, memberId, spec)
  const o = await presenceCheck(c.env as Env, memberId, spec, c.req.query('presence_grant')) // as: every dashboard app is Bindings: Env
  if (o.proceed) return null
  c.header('Cache-Control', 'no-store')
  if (o.grantId) c.header('X-Presence-Grant', o.grantId)
  const message = PRESENCE_MESSAGES[o.error]
  const link = o.approveUrl
    ? html`<p><a class="btn" href="${o.approveUrl}">Approve with your passkey</a></p>`
    : o.error === 'passkey_enrolment_required' ? html`<p><a class="btn" href="/account">Open My Account</a></p>` : ''
  const page = html`${pageHeader({ crumbs: 'Overview / Approval', title: 'Your passkey is needed' })}
    ${sectionPanel({ body: html`<p>${message}</p><p class="ui-sub">${spec.summary}</p>${link}<p><a href="${spec.returnPath}">Back</a></p>` })}`
  return c.html(shell(c.env as Env, 'Your passkey is needed', page), o.status)
}

function fieldInputs(fields: Record<string, PresenceValue>): Html {
  return html`${Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [String(v)]).map((one) => html`<input type="hidden" name="${k}" value="${one}">`))}`
}

export function makePresenceApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  // The return page. A real human session of the grant's own member; the grant must be satisfied and live. It performs nothing
  // itself: the button posts the approved decision to its own route, which consumes the grant.
  app.get('/presence/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    const session = await checkWebSession(c.env, c.get('auth'), { fresh: false })
    const msg = (title: string, text: string, status: 200 | 403 | 404 | 409 = 200) =>
      c.html(shell(c.env, title, html`${pageHeader({ crumbs: 'Overview / Approval', title })}${sectionPanel({ body: html`<p>${text}</p>` })}`), status)
    if (!session.ok) return msg('Approval', `This needs a signed-in human session (${session.error}).`, 403)
    const g = await loadPresenceGrant(c.env, c.req.param('id'))
    if (!g || g.member_id !== session.memberId) return msg('Approval', 'There is no approval waiting here for you.', 404)
    if (g.status === 'consumed') return msg('Already applied', 'This approval was already used.', 409)
    if (g.status === 'pending') return msg('Waiting for your passkey', 'Your passkey has not confirmed this yet. Open the passkey page from the screen that sent you there, approve it, then come back.', 409)
    if (g.status !== 'satisfied' || Date.parse(g.expires_at) <= Date.now()) return msg('Approval expired', 'This approval expired. Start the decision again.', 409)
    let fields: Record<string, PresenceValue> = {}
    try {
      const parsed: unknown = JSON.parse(g.fields_json)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const isValue = (v: unknown): v is PresenceValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        fields = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, PresenceValue] => isValue(e[1])))
      }
    } catch { /* an unreadable field set applies nothing: the form below is simply empty and the route refuses it */ }
    const target = `${g.action_path}?presence_grant=${encodeURIComponent(g.id)}`
    const body = g.encoding === 'form'
      ? html`<form method="post" action="${target}" class="inline-form">${fieldInputs(fields)}<button type="submit" class="btn">Apply: ${g.summary}</button></form>`
      : html`<div><button type="button" class="btn" id="presence-apply">Apply: ${g.summary}</button><div class="status-line" id="presence-status"></div></div>
        ${raw(`<script>(function(){var b=document.getElementById('presence-apply'),s=document.getElementById('presence-status');
          var url=${JSON.stringify(target)},fields=${JSON.stringify(fields).replace(/</g, '\\u003c')},back=${JSON.stringify(g.return_path)};
          b.addEventListener('click',async function(){b.disabled=true;s.textContent='applying…';
            try{var r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(fields)});
              var d=await r.json().catch(function(){return {}});
              if(r.ok){if(d&&typeof d.url==='string'){window.location.assign(d.url);return}
                if(d&&typeof d.token==='string'){s.textContent='Copy this token now. It is shown once and is not stored: ';var pre=document.createElement('pre');pre.textContent=d.token;s.appendChild(pre);return}
                window.location.assign(back);return}
              s.textContent='Could not apply ('+(d.error||r.status)+').';b.disabled=false}
            catch(e){s.textContent='Network error — try again.';b.disabled=false}});})();</script>`)}`
    return c.html(shell(c.env, 'Apply your approval', html`${pageHeader({ crumbs: 'Overview / Approval', title: 'Passkey confirmed' })}
      ${sectionPanel({ body: html`<p>Your passkey confirmed this decision. Apply it now.</p>${body}` })}`))
  })

  return app
}
