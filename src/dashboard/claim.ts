// mupot — the claim link page and the agent-page "Own this agent" click.
//
// UI over src/members/claim.ts (which is UI over decideAdmissionDirect). No authority lives here. Every POST:
//   1. csrf(): dashboardApp already applies hono/csrf to every form POST; a non-form content type is refused 415 here.
//   2. a REAL dashboard web session of an active human (checkWebSession). An agent / bearer / OAuth caller has none.
//   3. a FRESH session (re-auth inside the step-up window). Claiming is a credential binding, so freshness is NOT weakened.
//      When the session is merely stale the person is sent through ONE redirect to the re-auth route and returns to the SAME
//      page, which then shows a single Confirm button. The intent is the page itself (the code in the URL, or the agent
//      id), so nothing is held server-side and nothing is lost; the write is never performed by a GET.
//   4. the member is ALWAYS the session member, never a form field.

import { attachIdentityCard } from './attach-identity'
import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { resolveAgentRef } from '../org/resolve'
import {
  claimUrl,
  claimsForAgent,
  confirmClaimByCode,
  confirmClaimOnAgentPage,
  lookupClaim,
  normalizeClaimCode,
  reissueClaim,
  reissueHarnessClaimApproval,
  type ClaimView,
  type ConfirmClaimResult,
} from '../members/claim'
import { seatAttachEnabled } from '../members/seat-attach'
import { pageHeader, sectionPanel, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function formatWhen(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown'
}

const REFUSAL_TEXT: Record<Exclude<ConfirmClaimResult, { ok: true }>['error'], string> = {
  seat_attach_disabled: 'Attaching a chat to an agent is not enabled on this pot.',
  claim_not_found: 'This claim link does not match a request of yours.',
  claim_not_pending: 'This claim was already used, has expired, or was closed. Nothing changed.',
  claim_changed: 'This request changed since the page loaded. Nothing was claimed; open the link again.',
  attach_refused: 'The claim could not be completed (the agent, your standing, or the app changed). Nothing was claimed.',
  attach_code_mismatch: 'This claim link does not match. Nothing was claimed.',
}
const REFUSAL_STATUS: Record<keyof typeof REFUSAL_TEXT, 403 | 404 | 409> = {
  seat_attach_disabled: 403,
  claim_not_found: 404,
  claim_not_pending: 409,
  claim_changed: 409,
  attach_refused: 409,
  attach_code_mismatch: 403,
}

/** The one-redirect return path. Same-origin relative; the re-auth route validates it again (safeReturnPath). */
export function reauthRedirectUrl(returnPath: string): string {
  return `/auth/reauth?return=${encodeURIComponent(returnPath)}`
}

function identityTable(v: ClaimView): Html {
  return html`${attachIdentityCard(v)}<dl class="kv">
    <dt>Agent</dt><dd><strong>${v.agentName}</strong>${v.agentSlug ? html` <code>${v.agentSlug}</code>` : ''}</dd>
    <dt>Connecting app</dt><dd>${v.harnessName || 'an app you connected'}${v.seatLabel ? html` · chat ${v.seatLabel}` : ''}</dd>
    <dt>Connected via</dt><dd>your sign-in (${v.signedInAs})</dd>
    <dt>Asked</dt><dd>${formatWhen(v.requestedAt)}</dd>
    <dt>Link valid until</dt><dd>${formatWhen(v.expiresAt)}</dd>
  </dl>`
}

/** What the agent page shows about this member's claims on this agent (also used by tests). */
export async function loadAgentClaimCard(
  env: Env,
  auth: AuthContext,
  agent: { id: string; name: string },
  opts: { resume: string | null; fresh: boolean },
): Promise<Html | null> {
  // Only a real human session sees the card; claims are the viewer's own, looked up by the session member.
  if (!seatAttachEnabled(env) || !auth.memberId || auth.boundAgentId || !auth.webSessionIdHash) return null
  const mine = await claimsForAgent(env, auth.memberId, agent.id)
  if (mine.pending.length === 0 && !mine.expired) return null
  const back = `/agents/${agent.id}?resume=claim`
  if (mine.pending.length > 0) {
    return sectionPanel({
      title: 'Own this agent',
      body: html`${mine.pending.map((c) => html`<form method="post" action="/agents/${agent.id}/claim" class="inline-form" data-claim-own>
        <p>A chat you connected is asking to act as <strong>${agent.name}</strong>. If that was you, one click claims it.</p>
        ${identityTable(c)}
        <input type="hidden" name="admission_id" value="${c.admissionId}">
        ${opts.fresh
          ? html`<button type="submit" class="btn">${opts.resume === 'claim' ? 'Confirm: own this agent' : 'Own this agent'}</button>`
          : html`<a class="btn" href="${reauthRedirectUrl(back)}">Sign in again to own this agent</a>
            <p class="ui-sub">Owning an agent binds a credential, so it needs a recent sign-in. You will come straight back to this page and see one Confirm button.</p>`}
      </form>`)}`,
    })
  }
  return sectionPanel({
    title: 'Own this agent',
    body: html`<form method="post" action="/agents/${agent.id}/claim/reissue" class="inline-form" data-claim-reissue>
      <p>The claim link for ${agent.name} expired before it was used. Issuing a new one does not change anything until you claim it.</p>
      ${mine.expired ? identityTable(mine.expired) : ''}
      <button type="submit" class="btn secondary">Issue a new claim link</button>
    </form>`,
  })
}

export function makeClaimApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  const page = (c: import('hono').Context<AppEnv>, title: string, body: Html, status: 200 | 403 | 404 | 409 | 415 = 200) =>
    c.html(shell(c.env, title, body), status)
  const note = (text: string, back?: { href: string; label: string }) =>
    html`<div class="card"><p>${text}</p>${back ? html`<p><a href="${back.href}">${back.label}</a></p>` : ''}</div>`

  // GET /claim/:code — the link the agent hands its human. Shows exactly what will be claimed; claims nothing.
  app.get('/claim/:code', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh: false })
    if (!session.ok) return page(c, 'Claim', note('Open this link in your browser, signed in as the person who connected the agent.'), 403)
    const code = normalizeClaimCode(c.req.param('code'))
    if (!code || !seatAttachEnabled(c.env)) return page(c, 'Claim', note('This claim link is not valid.'), 404)
    const found = await lookupClaim(c.env, session.memberId, code)
    if (found.state === 'not_found' || found.state === 'ambiguous') {
      return page(c, 'Claim', note('This claim link does not match a request of yours. Ask your agent for a new link.'), 404)
    }
    const v = found.view
    const here = `/claim/${code.slice(0, 2)}-${code.slice(2)}`
    if (found.state === 'already_claimed') {
      return page(c, 'Claim', html`${pageHeader({ crumbs: 'Overview / Claim', title: 'Already claimed' })}${sectionPanel({ body: html`${identityTable(v)}<p>This link was already used. <a href="/agents/${v.agentId}">Open ${v.agentName}</a>.</p>` })}`, 409)
    }
    if (found.state === 'closed') {
      return page(c, 'Claim', html`${pageHeader({ crumbs: 'Overview / Claim', title: 'Claim closed' })}${sectionPanel({ body: html`<p>This request was denied or revoked. Ask your agent to ask again.</p>` })}`, 409)
    }
    if (found.state === 'expired') {
      return page(c, 'Claim', html`${pageHeader({ crumbs: 'Overview / Claim', title: 'This link expired' })}${sectionPanel({ body: html`${identityTable(v)}<p>Nothing was claimed. <a class="btn" href="/agents/${v.agentId}">Issue a new claim link</a> from the agent's page; the agent shows the new link on its next boot_context.</p>` })}`, 409)
    }
    const fresh = (await checkWebSession(c.env, auth, { fresh: true })).ok
    return page(c, 'Claim', html`
      ${pageHeader({ crumbs: 'Overview / Claim', title: `Claim ${v.agentName}` })}
      ${sectionPanel({
        body: html`<form method="post" action="${here}" class="inline-form" data-claim-confirm>
          <p>This chat is asking to act as the agent below. Check that it is the one you expect.</p>
          ${identityTable(v)}
          <input type="hidden" name="admission_id" value="${v.admissionId}">
          <input type="hidden" name="agent_id" value="${v.agentId}">
          ${fresh
            ? html`<button type="submit" class="btn">Confirm</button>`
            : html`<a class="btn" href="${reauthRedirectUrl(here)}">Sign in again to confirm</a>
              <p class="ui-sub">A claim binds a credential, so it needs a recent sign-in. You will come straight back here and see one Confirm button.</p>`}
        </form>`,
      })}`)
  })

  async function formSession(c: import('hono').Context<AppEnv>, returnPath: string) {
    c.header('Cache-Control', 'no-store')
    const ctype = (c.req.header('content-type') ?? '').toLowerCase()
    if (!ctype.startsWith('application/x-www-form-urlencoded') && !ctype.startsWith('multipart/form-data')) {
      return { ok: false as const, res: page(c, 'Claim', note('Form submissions only.'), 415) }
    }
    const session = await checkWebSession(c.env, c.get('auth'), { fresh: true })
    if (!session.ok) {
      if (session.error === 'reauth_required') return { ok: false as const, res: c.redirect(reauthRedirectUrl(returnPath), 303) }
      return { ok: false as const, res: page(c, 'Claim', note(`This needs a signed-in human session (${session.error}).`), 403) }
    }
    return { ok: true as const, memberId: session.memberId }
  }

  // POST /claim/:code — Confirm. Member = session member; code from the URL; the admission + agent the page showed from the form.
  app.post('/claim/:code', async (c) => {
    const code = normalizeClaimCode(c.req.param('code'))
    if (!code) return page(c, 'Claim', note('This claim link is not valid.'), 404)
    const here = `/claim/${code.slice(0, 2)}-${code.slice(2)}`
    const s = await formSession(c, here)
    if (!s.ok) return s.res
    const form = await c.req.parseBody()
    const r = await confirmClaimByCode(c.env, { memberId: s.memberId, code, shownAdmissionId: form.admission_id, shownAgentId: form.agent_id })
    if (!r.ok) return page(c, 'Claim', note(REFUSAL_TEXT[r.error], { href: '/connections', label: 'Open Connections' }), REFUSAL_STATUS[r.error])
    return c.redirect(`/agents/${encodeURIComponent(r.agentId)}?claimed=${r.attached ? '1' : 'partial'}`, 303)
  })

  // POST /agents/:id/claim — agent-page approval. The server finds this member's pending ask for THIS agent and checks the displayed code.
  app.post('/agents/:id/claim', async (c) => {
    const resolved = await resolveAgentRef(c.env, c.req.param('id'))
    if (!resolved.ok) return page(c, 'Claim', note('Agent not found.'), 404)
    const agentId = resolved.value.id
    const s = await formSession(c, `/agents/${agentId}?resume=claim`)
    if (!s.ok) return s.res
    const form = await c.req.parseBody()
    const r = await confirmClaimOnAgentPage(c.env, { memberId: s.memberId, agentId, shownAdmissionId: form.admission_id, attachCode: form.attach_code })
    if (!r.ok) return page(c, 'Claim', note(REFUSAL_TEXT[r.error], { href: `/agents/${agentId}`, label: 'Back to the agent' }), REFUSAL_STATUS[r.error])
    return c.redirect(`/agents/${encodeURIComponent(agentId)}?claimed=${r.attached ? '1' : 'partial'}`, 303)
  })

  // POST /agents/:id/claim/passkey — an explicit fresh-human request may rotate a harness-wide approval link.
  app.post('/agents/:id/claim/passkey', async (c) => {
    const resolved = await resolveAgentRef(c.env, c.req.param('id'))
    if (!resolved.ok) return page(c, 'Claim', note('Agent not found.'), 404)
    const agentId = resolved.value.id
    const s = await formSession(c, `/agents/${agentId}?resume=claim`)
    if (!s.ok) return s.res
    const form = await c.req.parseBody()
    const r = await reissueHarnessClaimApproval(c.env, { memberId: s.memberId, agentId, shownAdmissionId: form.admission_id })
    if (!r.ok) return page(c, 'Claim', note(REFUSAL_TEXT[r.error], { href: `/agents/${agentId}`, label: 'Back to the agent' }), REFUSAL_STATUS[r.error])
    return c.redirect(r.url, 303)
  })

  // POST /agents/:id/claim/reissue — a fresh pending ask for the same agent/member/app/thread. Grants nothing, so a real
  // session is enough (like Deny / Detach), no step-up.
  app.post('/agents/:id/claim/reissue', async (c) => {
    c.header('Cache-Control', 'no-store')
    const ctype = (c.req.header('content-type') ?? '').toLowerCase()
    if (!ctype.startsWith('application/x-www-form-urlencoded') && !ctype.startsWith('multipart/form-data')) {
      return page(c, 'Claim', note('Form submissions only.'), 415)
    }
    const session = await checkWebSession(c.env, c.get('auth'), { fresh: false })
    if (!session.ok) return page(c, 'Claim', note(`This needs a signed-in human session (${session.error}).`), 403)
    const resolved = await resolveAgentRef(c.env, c.req.param('id'))
    if (!resolved.ok) return page(c, 'Claim', note('Agent not found.'), 404)
    const r = await reissueClaim(c.env, { memberId: session.memberId, agentId: resolved.value.id })
    if (!r.ok) {
      return page(c, 'Claim', note(r.error === 'nothing_to_reissue'
        ? 'There is no expired request to renew (the chat may be gone or already attached). Ask the agent to ask again.'
        : 'A new claim link could not be issued right now.', { href: `/agents/${resolved.value.id}`, label: 'Back to the agent' }), 409)
    }
    return c.redirect(`/agents/${encodeURIComponent(resolved.value.id)}?reissued=1`, 303)
  })

  return app
}

export { claimUrl }
