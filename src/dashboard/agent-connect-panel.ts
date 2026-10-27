// src/dashboard/agent-connect-panel.ts — the agent page's guided "Connect a chat" checklist (live state for THIS agent, THIS viewer).
//
// UI over existing writers; no authority lives here. It lists only the viewer's OWN requests (claimsForAgent), chats (agent_seats.member_id)
// and attachments (human_member_id). Approve is the existing agent-page claim form (POST /agents/:id/claim: real session + fresh sign-in);
// Reject / Detach / Hold / Return / Release call the existing /connections routes (same checks as that page). Plain words only: "chat",
// "request" (no "admission" / "seat" in anything the human reads). The copy-to-agent text is for the AGENT, so it names tools.

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import { latestConnectionCheck } from '../members/connection-check'
import { claimsForAgent, type ClaimView } from '../members/claim'
import { seatAttachDesignatedEnabled, seatAttachEnabled } from '../members/seat-attach'
import { listObservedSeats, type ObservedSeatRow } from '../members/seat-hold-release'
import { vipLaneEnabled } from '../members/vip-lane'
import { mcpEndpoint, requiredCanonicalOrigin } from './connect'
import { pill, type Html } from './ui'
import { reauthRedirectUrl } from './claim'

export interface ConnectedChat { attachment_id: string; label: string; harness: string; since: string }

export interface AgentConnectView {
  endpoint: string | null
  /** True when this person already has a connected chat app on this pot (so the connector step is likely done). */
  connectorKnown: boolean
  pending: ClaimView[]
  connected: ConnectedChat[]
  /** Latest recorded connection check (send / receive / wake), or null. */
  lastCheck: { summary: string; at: string } | null
  observed: ObservedSeatRow[]
  vipOn: boolean
  /** Designation (SEAT_ATTACH_DESIGNATED): off = no permission step; otherwise whether THIS viewer is the designee. */
  designationOn: boolean
  allowedForViewer: boolean
}

/** ONE place for the words the human pastes into the chat: one line. Everything else (what to call, show the code and wait, mupot tools only,
 *  the onboarding packet, the connection check) comes from mupot itself: the observed_floor refusal, boot_context and attached_onboarding. */
export function agentConnectPrompt(p: { slug: string }): string {
  const slug = p.slug.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
  return `You are ${slug}. Use mupot: attach and check full-duplex communication.`
}

export async function loadAgentConnectView(env: Env, memberId: string, agent: { id: string; attach_designated_member_id?: string | null }): Promise<AgentConnectView | null> {
  if (!seatAttachEnabled(env)) return null
  const origin = requiredCanonicalOrigin(env)
  const claims = await claimsForAgent(env, memberId, agent.id).catch(() => ({ pending: [] as ClaimView[], expired: null }))
  const connected = (await env.DB.prepare(
    `SELECT t.id AS attachment_id, COALESCE(NULLIF(tl.label, ''), s.label_basename) AS label, h.client_name AS harness, t.created_at AS since
       FROM agent_seat_attachments t JOIN agent_seats s ON s.id = t.seat_id JOIN harnesses h ON h.id = t.harness_id
       LEFT JOIN agent_seat_thread_labels tl ON tl.tenant = t.tenant AND tl.seat_id = t.seat_id AND tl.human_member_id = t.human_member_id
      WHERE t.tenant = ?1 AND t.human_member_id = ?2 AND t.agent_id = ?3 AND t.detached_at IS NULL ORDER BY t.created_at DESC LIMIT 20`,
  ).bind(env.TENANT_SLUG, memberId, agent.id).all<ConnectedChat>().catch(() => null))?.results ?? []
  const anySeat = await env.DB.prepare(`SELECT 1 AS x FROM agent_seats WHERE tenant = ?1 AND member_id = ?2 AND retired_at IS NULL LIMIT 1`)
    .bind(env.TENANT_SLUG, memberId).first<{ x: number }>().catch(() => null)
  const observed = (await listObservedSeats(env, memberId)).filter((o) => o.status === 'observed' || o.status === 'held')
  return { endpoint: origin.ok ? mcpEndpoint(origin.origin) : null, connectorKnown: anySeat !== null, pending: claims.pending, connected, lastCheck: await latestConnectionCheck(env, agent.id, memberId), observed, vipOn: vipLaneEnabled(env), designationOn: seatAttachDesignatedEnabled(env), allowedForViewer: agent.attach_designated_member_id === memberId }
}

const when = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`

export interface DesignationState { allowLabel: string; /** Each control follows the shared authorization result (the POST re-checks every rule). */ canAllow: boolean; canStop: boolean; /** Back from the one sign-in redirect for an approval: the same button, labelled as the single remaining click. */ resumeClaim: boolean; /** Masked name of the current designee, or null. */ designeeText: string | null }

export function renderAgentConnectPanel(
  agent: { id: string; slug: string; name: string },
  v: AgentConnectView,
  des: DesignationState,
  fresh: boolean,
): Html {
  const prompt = agentConnectPrompt({ slug: agent.slug })
  const warn = html`<p class="ui-sub">Your ChatGPT/Claude/Codex chats can then ask to act as ${agent.name}; approve each request with the code shown below. Stopping ends all of them now.</p>`
  const allowForm = des.canAllow || des.canStop
    ? html`<form method="post" action="/agents/${agent.id}/designation" class="inline-form" data-attach-designation>
        ${des.canAllow ? html`<button type="submit" name="action" value="allow" class="btn">${des.allowLabel}</button>` : ''}
        ${des.designeeText && des.canStop ? html`<button type="submit" name="action" value="stop" class="btn secondary">Stop</button>` : ''}</form>`
    : v.allowedForViewer ? html`` : html`<p class="ui-sub">Only an org admin can allow this. Ask one to allow your chats for ${agent.name}.</p>`
  const step1 = !v.designationOn
    ? html`<li><strong>1. Allowed for you</strong> ${pill('done', 'ok')}</li>`
    : html`<li><strong>1. ${v.allowedForViewer ? 'Allowed for you' : `Allow your chats to become ${agent.name}`}</strong> ${v.allowedForViewer ? pill('done', 'ok') : ''}
        <p>Currently allowed: ${des.designeeText ?? 'nobody'}</p>${warn}${allowForm}</li>`
  const pending = v.pending.length === 0
    ? html`<p class="ui-sub" data-connect-none>No chat has asked yet. This updates when one does.</p>`
    : html`${v.pending.map((c) => html`<div class="card" data-connect-request>
        <p><strong>${c.harnessName || 'A chat app'}</strong>${c.seatLabel ? html` · chat ${c.seatLabel}` : ''} asked ${when(c.requestedAt)} to act as ${agent.name}.</p>
        <p>Approval code <code>${c.attachCode ?? 'unavailable'}</code></p>
        ${c.scope === 'harness'
          ? html`<form method="post" action="/agents/${agent.id}/claim/passkey" class="inline-form" data-claim-passkey>
              <input type="hidden" name="admission_id" value="${c.admissionId}">
              <p class="ui-sub">This request covers chats in this app and needs a passkey approval.</p>
              ${fresh ? html`<button type="submit" class="btn">Open passkey approval</button>` : html`<a class="btn" href="${reauthRedirectUrl(`/agents/${agent.id}?resume=claim`)}">Sign in again to open passkey approval</a>`}
              <button type="button" class="btn danger" data-cx-deny="${c.admissionId}">Reject</button>
            </form>`
          : html`<form method="post" action="/agents/${agent.id}/claim" class="inline-form" data-claim-own>
          <input type="hidden" name="admission_id" value="${c.admissionId}">
          <label>Enter the approval code
            <input name="attach_code" inputmode="text" autocomplete="off" maxlength="8" required aria-label="Approval code">
          </label>
          ${fresh
            ? html`<button type="submit" class="btn">${des.resumeClaim ? 'Confirm: Approve' : 'Approve'}</button>`
            : html`<a class="btn" href="${reauthRedirectUrl(`/agents/${agent.id}?resume=claim`)}">Sign in again to approve</a>`}
          <button type="button" class="btn danger" data-cx-deny="${c.admissionId}">Reject</button>
        </form>`}</div>`)}`
  const connected = v.connected.length === 0
    ? ''
    : html`<p data-connect-done><strong>Connected. Mupot takes it from here.</strong> It sends the agent its tasks and instructions directly; you do not need to relay anything.</p>
      <p data-connect-check>${v.lastCheck ? html`Last connection check (${when(v.lastCheck.at)}): ${v.lastCheck.summary}` : 'Connection check: the agent runs it first and reports back to you. This updates when it does.'}</p>
      <ul>${v.connected.map((c) => html`<li data-connect-attached>${c.label || 'A chat'} (${c.harness}) since ${when(c.since)}
        <button type="button" class="btn danger" data-cx-detach="${c.attachment_id}">Detach</button></li>`)}</ul>`
  const observed = v.observed.length === 0
    ? ''
    : html`<p class="ui-sub">Chats of yours that joined a squad first are limited until you let them through. They can still ask above.</p>
      <ul>${v.observed.map((o) => html`<li data-connect-limited>${o.label || 'A chat'} ${pill(o.status === 'held' ? 'on hold' : 'limited', o.status === 'held' ? 'danger' : 'dim')}
        ${o.status === 'held' && v.vipOn ? html`<button type="button" class="btn" data-cx-return="${o.seat_id}">Return</button>` : ''}
        <button type="button" class="btn" data-cx-release="${o.seat_id}">Release</button>
        ${o.status !== 'held' && v.vipOn ? html`<button type="button" class="btn danger" data-cx-hold="${o.seat_id}">Hold</button>` : ''}</li>`)}</ul>`
  return html`<section class="ui-panel" data-agent-connect>
    <h2>Connect a chat to ${agent.name}</h2>
    <ol class="connect-steps">
      ${step1}
      <li><strong>2. Copy this to your agent</strong>
        <p class="ui-sub">Paste this one line into your ChatGPT, Claude or Codex chat. It is the last thing you relay: mupot tells the agent the rest, and after you approve it talks to the agent directly.</p>
        ${v.connectorKnown || !v.endpoint ? '' : html`<p class="ui-sub">If the chat does not have mupot yet, add this connector first: <code>${v.endpoint}</code></p>`}
        <textarea readonly rows="2" id="connect-prompt" data-connect-prompt style="width:100%;font:1.05rem/1.4 monospace" aria-label="Text to copy to your agent">${prompt}</textarea>
        <button type="button" class="btn" id="connect-copy">Copy this to your agent</button> <span id="connect-copied" class="ui-sub" role="status"></span></li>
      <li><strong>3. Requests from your chats</strong>${pending}</li>
      <li><strong>4. Connected chats</strong>${connected === '' ? html`<p class="ui-sub">None yet.</p>` : connected}</li>
      ${v.observed.length === 0 ? '' : html`<li><strong>5. Limited chats</strong>${observed}</li>`}
    </ol>
    <div class="status-line" id="cx-status" role="status"></div>
    ${raw(`<script>(function(){
      var st=document.getElementById('cx-status');
      function say(t){if(st)st.textContent=t;}
      var cb=document.getElementById('connect-copy'),ta=document.getElementById('connect-prompt'),cd=document.getElementById('connect-copied');
      if(cb&&ta)cb.addEventListener('click',function(){ta.select();var ok=false;try{if(navigator.clipboard){navigator.clipboard.writeText(ta.value);ok=true;}else{ok=document.execCommand('copy');}}catch(e){}if(cd)cd.textContent=ok?'Copied.':'Select the text and copy it.';});
      function post(url,confirmText){if(confirmText&&!window.confirm(confirmText))return;say('saving…');
        fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().catch(function(){return {};}).then(function(d){
          if(r.ok){window.location.reload();return;}
          if(d.error==='reauth_required'){window.location.href='${reauthRedirectUrl(`/agents/${agent.id}`)}';return;}else{say('Could not do that ('+(d.error||r.status)+').');}});}).catch(function(){say('Network error. Try again.');});}
      [['data-cx-deny','/connections/admissions/','/deny',null],['data-cx-detach','/connections/attachments/','/detach','Detach this chat? It returns to its own identity. Approval for this chat alone is revoked. Approval for every chat of the app stays active; an observed chat needs Release before attaching again.'],
       ['data-cx-hold','/connections/seats/','/hold','Hold this chat? It can then only read.'],['data-cx-return','/connections/seats/','/return',null],
       ['data-cx-release','/connections/seats/','/release','Release this chat? The limits no longer apply to it.']].forEach(function(s){
        document.querySelectorAll('button['+s[0]+']').forEach(function(b){b.addEventListener('click',function(){post(s[1]+encodeURIComponent(b.getAttribute(s[0]))+s[2],s[3]);});});});
    })();</script>`)}
  </section>`
}
