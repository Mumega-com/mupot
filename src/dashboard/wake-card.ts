// mupot — the "Set up wake" card on the agent page and its one write: Allow push from <host>.
//
// UI over src/members/wake-setup.ts (which decides from capability facts and writes through createSeatEventGrant). Every POST:
// csrf() (dashboardApp), a form content type, a REAL web session of an active human, and a FRESH one (the grant lets a host
// receive this agent's hints, so it is held to the same step-up bar as a claim). A stale session is redirected once through
// re-auth and returns to the agent page (resume=push) where the same button is the single Confirm. The member is always the
// session member; the form carries only the host id the page showed, which the server re-validates (owned, keyed, active).

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { resolveAgentRef } from '../org/resolve'
import { allowPushFromHost, loadWakeCard } from '../members/wake-setup'
import { reauthRedirectUrl } from './claim'
import { sectionPanel, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export async function loadAgentWakeCard(
  env: Env,
  auth: AuthContext,
  agent: { id: string; name: string },
  opts: { resume: string | null; fresh: boolean },
): Promise<Html | null> {
  if (!auth.memberId || auth.boundAgentId || !auth.webSessionIdHash) return null
  const card = await loadWakeCard(env, auth, auth.memberId, agent.id)
  if (!card.show) return null
  const back = `/agents/${agent.id}?resume=push`
  const lines: Html[] = []
  if (card.nudgeOnly) {
    lines.push(html`<p><strong>Nudge-only (by design).</strong> A chat is acting as ${agent.name}; it reads its inbox when the chat is open. There is nothing to set up.</p>`)
  }
  if (card.push?.state === 'on') {
    lines.push(html`<p><strong>Push is on</strong>${card.push.hostName ? html` from ${card.push.hostName}` : ''}.</p>`)
  } else if (card.push?.state === 'broken') {
    lines.push(html`<p><strong>Push needs repair.</strong> A grant exists${card.push.hostName ? html` for ${card.push.hostName}` : ''}, but the host can no longer receive this agent's hints (its key was removed, or it lost standing). Revoke the grant and set it up again.</p>`)
  } else if (card.push?.state === 'available') {
    lines.push(html`<form method="post" action="/agents/${agent.id}/wake-setup/push" class="inline-form" data-wake-push>
      <p>${card.push.hostName} is a host you own and it reports ${agent.name}. Allow it to receive ${agent.name}'s inbox hints (no message bodies) so the agent is woken instead of polled.</p>
      <input type="hidden" name="host_agent_id" value="${card.push.hostId}">
      ${opts.fresh
        ? html`<button type="submit" class="btn">${opts.resume === 'push' ? `Confirm: allow push from ${card.push.hostName}` : `Allow push from ${card.push.hostName}`}</button>`
        : html`<a class="btn" href="${reauthRedirectUrl(back)}">Sign in again to allow push</a>
          <p class="ui-sub">This lets a host receive the agent's hints, so it needs a recent sign-in. You will come straight back here and see one Confirm button.</p>`}
    </form>`)
  }
  if (card.webhook) {
    lines.push(card.webhook.configured
      ? html`<p><strong>Doorbell:</strong> set (key ending ${card.webhook.last4 ?? '····'}). Last delivery: ${card.webhook.lastOutcome ? `${card.webhook.lastOutcome}${card.webhook.lastAt ? ` at ${card.webhook.lastAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` : 'none yet'}. <a href="/doorbells">Manage doorbells</a></p>`
      : html`<p><strong>Doorbell:</strong> not set. If this agent can receive a webhook, <a href="/doorbells">add its doorbell</a>.</p>`)
  }
  if (lines.length === 0) {
    lines.push(html`<p>This agent polls its inbox; there is no push host or doorbell to set up here.</p>`)
  }
  return sectionPanel({ title: 'Set up wake', body: html`${lines}` })
}

export function makeWakeApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()
  const note = (text: string, back: string) => html`<div class="card"><p>${text}</p><p><a href="${back}">Back to the agent</a></p></div>`

  app.post('/agents/:id/wake-setup/push', async (c) => {
    c.header('Cache-Control', 'no-store')
    const page = (text: string, back: string, status: 400 | 403 | 404 | 409 | 415) => c.html(shell(c.env, 'Set up wake', note(text, back)), status)
    const ctype = (c.req.header('content-type') ?? '').toLowerCase()
    if (!ctype.startsWith('application/x-www-form-urlencoded') && !ctype.startsWith('multipart/form-data')) return page('Form submissions only.', '/', 415)
    const resolved = await resolveAgentRef(c.env, c.req.param('id'))
    if (!resolved.ok) return page('Agent not found.', '/', 404)
    const agentId = resolved.value.id
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh: true })
    if (!session.ok) {
      if (session.error === 'reauth_required') return c.redirect(reauthRedirectUrl(`/agents/${agentId}?resume=push`), 303)
      return page(`This needs a signed-in human session (${session.error}).`, `/agents/${agentId}`, 403)
    }
    const form = await c.req.parseBody()
    const r = await allowPushFromHost(c.env, auth, { memberId: session.memberId, agentId, hostAgentId: form.host_agent_id })
    if (!r.ok) {
      return page(r.error === 'not_enabled'
        ? 'Push is not enabled on this pot.'
        : r.error === 'invalid_args' ? 'That host is not valid.' : 'That host cannot be allowed for this agent from here (it must be a host you own, with a registered key, for an agent you claimed).', `/agents/${agentId}`, r.error === 'not_enabled' ? 409 : r.error === 'invalid_args' ? 400 : 403)
    }
    return c.redirect(`/agents/${encodeURIComponent(agentId)}`, 303)
  })

  return app
}
