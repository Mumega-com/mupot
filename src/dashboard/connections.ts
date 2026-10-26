// src/dashboard/connections.ts — "Connections": the human dashboard view of the threads running through each connected
// app (ChatGPT, claude.ai, Grok, Cursor ...) and which agent each one is acting as. W2 (SEAT_ATTACH).
//
// SCOPE DISCIPLINE: UI over the EXISTING writers in src/members/seat-attach.ts (attachSeatToAgent, detachAttachment,
// decideAdmissionDirect, revokeAdmission). Nothing here has its own authority: every writer re-scopes to the signed-in
// human (their own seats, their own admissions) and re-resolves the agent inside the set that human administers.
//
// Every POST: same-origin (Origin must equal the request origin), then a REAL dashboard web session of an active human
// member (checkWebSession; an agent / bearer / OAuth caller has none). Actions that GRANT reach (attach, approve) need a
// FRESH session (re-authenticated within the step-up window, as /operators create does); actions that REDUCE it (detach, deny,
// revoke) need only the real session and keep working with the flag off.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { checkWebSession } from '../secure-moments/enrol-mint'
import { isAttachCeiling } from '../auth/attached-ceiling'
import {
  attachSeatToAgent, decideAdmissionDirect, detachAttachment, listAttachableAgents, loadConnections, renameThread, revokeAdmission, seatAttachEnabled, ATTACH_IDLE_DAYS,
} from '../members/seat-attach'
import { changeSeatAdmission, isSeatHoldAction, listObservedSeats, seatAdmissionStatus, SEAT_TRANSITIONS, wideningTransition } from '../members/seat-hold-release'
import { admissionIsPendingLive, loadAdmission } from '../members/seat-attach'
import { issueMomentLink } from '../secure-moments/issue'
import { listMemberPasskeys } from '../secure-moments/store'
import { secureMomentsStatus } from '../secure-moments/config'
import { presenceGate } from './presence'
import { vipLaneEnabled } from '../members/vip-lane'
import { pageHeader, sectionPanel, pill, emptyState, dataTable, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

function connectionsScript(): Html {
  return raw(`
    <script>
      (function () {
        var status = document.getElementById('cx-status');
        var lastBtn = null;
        document.addEventListener('click', function (ev) {
          var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
          if (b) lastBtn = b;
        }, true);
        // Errors show beside the clicked button (role=alert) AND in the top status line, which is scrolled into view + focused.
        function rowNote(t) {
          if (!lastBtn || !lastBtn.parentNode) return;
          var n = lastBtn.parentNode.querySelector('.cx-row-err');
          if (!n) { n = document.createElement('div'); n.className = 'cx-row-err'; n.setAttribute('role', 'alert'); lastBtn.parentNode.appendChild(n); }
          n.textContent = t;
        }
        function say(t) {
          if (!status) return;
          status.textContent = t;
          if (t && t !== 'saving…') {
            rowNote(t);
            status.setAttribute('tabindex', '-1');
            status.setAttribute('role', 'alert');
            if (status.scrollIntoView) status.scrollIntoView({ block: 'center' });
            status.focus();
          }
        }
        function reauthLink() {
          if (!status) return;
          status.textContent = '';
          rowNote('Confirm it is you first, then try again.');
          var a = document.createElement('a'); a.href = '/auth/reauth?return=/connections'; a.textContent = 'Confirm it is you first';
          status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.'));
        }
        async function post(url, body, confirmText) {
          if (confirmText && !window.confirm(confirmText)) return;
          say('saving…');
          try {
            var res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok) { window.location.reload(); return; }
            if (data.error === 'human_presence_required' && data.approve_url) { window.location.assign(data.approve_url); return; }
            if (data.error === 'human_presence_unavailable' || data.error === 'passkey_enrolment_required' || data.error === 'presence_grant_invalid' || data.error === 'too_many_pending') say(data.message || 'This needs your passkey.');
            else if (data.error === 'reauth_required') reauthLink();
            else if (data.error === 'attach_code_mismatch') say('That code does not match. A chat asked for this agent: use Admit on the Waiting for your decision card and type the code the chat showed you.');
            else if (data.error === 'approval_bound_to_other_chat') say('This agent is approved (or requested) for a different chat. Revoke or deny that first, then have this chat ask again.');
            else say('Could not do that (' + (data.error || res.status) + ').');
          } catch (e) { say('Network error — try again.'); }
        }
        var att = document.querySelectorAll('button[data-cx-attach]');
        for (var i = 0; i < att.length; i++) att[i].addEventListener('click', function (ev) {
          var seat = ev.currentTarget.getAttribute('data-cx-attach');
          var sel = document.querySelector('select[data-cx-agent="' + seat + '"]');
          if (!sel || !sel.value) { say('Pick an agent first.'); return; }
          var cs = document.querySelector('select[data-cx-ceiling="' + seat + '"]');
          post('/connections/attach', { seat_id: seat, agent_id: sel.value, ceiling: cs ? cs.value : 'member' });
        });
        var ap = document.querySelectorAll('button[data-cx-approve]');
        for (var a = 0; a < ap.length; a++) ap[a].addEventListener('click', function (ev) {
          var id = ev.currentTarget.getAttribute('data-cx-approve');
          var cs = document.querySelector('select[data-cx-aceiling="' + id + '"]');
          var ci = document.querySelector('input[data-cx-acode="' + id + '"]');
          if (ci && !ci.value.trim()) { say('Type the attach code the chat told you, from the card showing it.'); return; }
          post('/connections/admissions/' + encodeURIComponent(id) + '/approve', { ceiling: cs ? cs.value : 'member', attach_code: ci ? ci.value : undefined });
        });
        var rn = document.querySelectorAll('button[data-cx-rename]');
        for (var r = 0; r < rn.length; r++) rn[r].addEventListener('click', function (ev) {
          var seat = ev.currentTarget.getAttribute('data-cx-rename');
          var inp = document.querySelector('input[data-cx-label="' + seat + '"]');
          post('/connections/seats/' + encodeURIComponent(seat) + '/rename', { label: inp ? inp.value : '' });
        });
        var sw = document.querySelectorAll('button[data-cx-switch]');
        for (var k = 0; k < sw.length; k++) sw[k].addEventListener('click', function () {
          say('To switch: reconnect the app and choose "Many chats: each chat picks its agent". The old one-agent connection keeps working until you disconnect it in the app.');
        });
        var simple = [
          ['button[data-cx-detach]', 'data-cx-detach', function (id) { return '/connections/attachments/' + encodeURIComponent(id) + '/detach'; }, 'Detach this thread? It goes back to its own seat agent on its next request.'],
          ['button[data-cx-hold]', 'data-cx-hold', function (id) { return '/connections/seats/' + encodeURIComponent(id) + '/hold'; }, 'Hold this chat? It can then only read until you return it to observed or release it.'],
          ['button[data-cx-return]', 'data-cx-return', function (id) { return '/connections/seats/' + encodeURIComponent(id) + '/return'; }, null],
          ['button[data-cx-release]', 'data-cx-release', function (id) { return '/connections/seats/' + encodeURIComponent(id) + '/release'; }, 'Release this chat to trusted? The observed limits no longer apply to it.'],
          ['button[data-cx-deny]', 'data-cx-deny', function (id) { return '/connections/admissions/' + encodeURIComponent(id) + '/deny'; }, null],
          ['button[data-cx-revoke]', 'data-cx-revoke', function (id) { return '/connections/admissions/' + encodeURIComponent(id) + '/revoke'; }, 'Revoke this admission? Every thread attached through it goes back to its own seat agent on its next request.']
        ];
        simple.forEach(function (s) {
          var nodes = document.querySelectorAll(s[0]);
          for (var j = 0; j < nodes.length; j++) nodes[j].addEventListener('click', function (ev) {
            post(s[2](ev.currentTarget.getAttribute(s[1])), {}, s[3]);
          });
        });
      })();
    </script>`)
}

async function connectionsPageBody(env: Env, auth: AuthContext): Promise<Html> {
  const memberId = auth.memberId
  if (!memberId) return emptyState({ title: 'Sign in', detail: 'Connections are shown to a signed-in member.' })
  const enabled = seatAttachEnabled(env)
  // Flag off => never touch the 0220 tables (the page is always linked, and code may deploy before the migration).
  const { harnesses, admissions, bound } = enabled
    ? await loadConnections(env, memberId)
    : { harnesses: [], admissions: [], bound: [] }
  const agents = enabled ? await listAttachableAgents(env, memberId) : []

  const pending = admissions.filter((a) => a.status === 'pending')
  const live = admissions.filter((a) => a.status === 'live')
  const askingSeats = new Set(pending.filter((a) => a.has_code && a.requested_seat_id).map((a) => a.requested_seat_id))

  const pendingBody = pending.length === 0
    ? emptyState({ title: 'Nothing waiting', detail: 'When a thread asks to act as an agent you have not admitted yet, it appears here (and as a one-time passkey link it hands you).' })
    : dataTable({
      cols: [{ label: 'Attach code', width: '1fr' }, { label: 'Agent', width: '1.2fr' }, { label: 'App / chat', width: '1.4fr' }, { label: 'Asked', width: '1fr' }, { label: 'Decide', width: '1.8fr' }],
      rows: pending.map((a) => [
        a.has_code
          ? html`${pill('Code required', 'primary')} <span>Type the code the chat showed you.</span>`
          : html`${pill('no code (older request)', 'dim')}`,
        html`${a.agent_name}`,
        html`${a.harness_name}${a.seat_label ? html` · ${a.seat_label}` : ''}${a.seat_first_seen ? html` (first seen ${formatWhen(a.seat_first_seen)})` : ''}`,
        html`${formatWhen(a.created_at)}`,
        enabled
          ? html`${a.has_code ? html`<input data-cx-acode="${a.id}" placeholder="code" maxlength="12" size="6" autocomplete="off" aria-label="Attach code shown by the chat"> ` : ''}<select data-cx-aceiling="${a.id}"><option value="member">Member</option><option value="lead">Lead</option><option value="full">Full (agent's own standing)</option></select> <button class="btn" data-cx-approve="${a.id}">Admit</button> <button class="btn danger" data-cx-deny="${a.id}">Deny</button>`
          : html`${pill('Disabled', 'dim')}`,
      ]),
      empty: '',
    })

  const liveBody = live.length === 0
    ? emptyState({ title: 'No admissions yet', detail: 'Admitting an agent once lets every later thread from that app attach to it straight away.' })
    : dataTable({
      cols: [{ label: 'Agent', width: '1.2fr' }, { label: 'App', width: '1.2fr' }, { label: 'Level', width: '0.7fr' }, { label: 'Threads on it', width: '0.8fr' }, { label: '', width: '1fr' }],
      rows: live.map((a) => [
        html`${a.agent_name}`,
        html`${a.harness_name}`,
        html`${a.ceiling}`,
        html`${String(a.live_threads)}`,
        html`<button class="btn danger" data-cx-revoke="${a.id}">Revoke</button>`,
      ]),
      empty: '',
    })

  const harnessBlocks = harnesses.length === 0
    ? emptyState({ title: 'No connected apps', detail: 'Connect an app and choose "Many chats: each chat picks its agent"; its threads show up here.' })
    : html`${harnesses.map((h) => sectionPanel({
      title: `${h.client_name || h.kind} (${h.kind})`,
      body: h.seats.length === 0
        ? emptyState({ title: 'No live threads', detail: 'Threads appear as the app talks to this server.' })
        : dataTable({
          cols: [{ label: 'Connection', width: '1.4fr' }, { label: 'Acting as', width: '1.4fr' }, { label: 'Last used', width: '1fr' }, { label: 'Change', width: '2fr' }],
          rows: h.seats.map((s) => [
            html`<input data-cx-label="${s.seat_id}" value="${s.thread_label ?? ''}" placeholder="${s.connection_name ?? s.seat_label}" maxlength="64" style="width:14rem" aria-label="Connection name"> <button class="btn" data-cx-rename="${s.seat_id}">Name this connection</button> ${pill(s.source === 'auto' ? 'auto' : 'chosen', 'dim')}`,
            s.attached_agent_name
              ? html`${pill('Attached', 'primary')} ${s.attached_agent_name}`
              : html`${s.seat_agent_name} ${pill('own seat agent', 'dim')}`,
            html`${formatWhen(s.last_used_at ?? s.created_at)}`,
            s.attachment_id
              ? html`<button class="btn danger" data-cx-detach="${s.attachment_id}">Detach</button>`
              : enabled && agents.length > 0
                ? html`<select data-cx-agent="${s.seat_id}">${agents.map((a) => html`<option value="${a.id}">${a.name} (${a.squad_name})</option>`)}</select> <select data-cx-ceiling="${s.seat_id}"><option value="member">Member</option><option value="lead">Lead</option><option value="full">Full (agent's own standing)</option></select> <button class="btn" data-cx-attach="${s.seat_id}">Attach</button>${askingSeats.has(s.seat_id) ? html` <span class="ui-sub">This chat already asked for an agent: use Admit on the Waiting for your decision card and type the code the chat showed you.</span>` : ''}`
                : html`${pill(enabled ? 'No agent to attach' : 'Attach disabled', 'dim')}`,
          ]),
          empty: '',
        }),
    }))}`

  const observed = await listObservedSeats(env, memberId)
  const observedBlock = !vipLaneEnabled(env)
    ? ''
    : sectionPanel({
      title: 'Observed chats',
      body: observed.length === 0
        ? emptyState({ title: 'No observed chats', detail: 'A chat that joined a squad instantly shows up here, where you can hold it or release it to trusted.' })
        : dataTable({
          cols: [{ label: 'Chat', width: '1.4fr' }, { label: 'Acting as', width: '1.2fr' }, { label: 'State', width: '0.7fr' }, { label: 'Last used', width: '1fr' }, { label: '', width: '2fr' }],
          rows: observed.map((o) => [
            html`${o.label || o.seat_id}`,
            html`${o.agent_name}`,
            html`${pill(o.status, o.status === 'held' ? 'danger' : o.status === 'trusted' ? 'ok' : 'dim')}`,
            html`${formatWhen(o.last_used_at)}`,
            html`${o.status !== 'held' ? html`<button class="btn danger" data-cx-hold="${o.seat_id}">Hold</button>` : ''} ${o.status !== 'observed' ? html`<button class="btn" data-cx-return="${o.seat_id}">Return to observed</button>` : ''} ${o.status !== 'trusted' ? html`<button class="btn" data-cx-release="${o.seat_id}">Release to trusted</button>` : ''}`,
          ]),
          empty: '',
        }),
    })

  const boundBlock = enabled && bound.length > 0
    ? sectionPanel({
      title: 'Apps connected as one agent',
      body: dataTable({
        cols: [{ label: 'Acting as', width: '1.4fr' }, { label: 'Connected', width: '1fr' }, { label: '', width: '1.4fr' }],
        rows: bound.map((b) => [
          html`${pill('One agent', 'dim')} ${b.agent_name}`,
          html`${formatWhen(b.connected_at)}`,
          html`<button class="btn" data-cx-switch="${b.token_id}">Switch to many chats</button>`,
        ]),
        empty: '',
      }),
    })
    : ''

  return html`
    ${pageHeader({
      crumbs: 'Overview / Connections',
      title: 'Connections',
      sub: 'Each connection (a thread in a connected app), the name it goes by, and which agent it is acting as.',
    })}
    ${enabled ? '' : sectionPanel({ title: 'Attaching is off', body: emptyState({ title: 'Attach is not enabled on this pot', detail: 'Threads keep their own seat agents. You can still detach or revoke anything below.' }) })}
    ${sectionPanel({ title: 'Waiting for your decision', body: pendingBody })}
    ${observedBlock}
    ${harnessBlocks}
    ${sectionPanel({ title: 'Admitted agents', body: liveBody })}
    <p class="ui-sub">A level is chosen when an agent is admitted (Member, Lead, or Full = the agent's own standing, never more than yours). If the agent holds a review gate, an attached thread may also review (give approve or reject verdicts) on its behalf, never on work that is yours or the agent's own; detaching the thread or revoking the admission ends that. To change a level, revoke the admission and admit again. An attached thread unused for ${ATTACH_IDLE_DAYS} days is detached automatically when its app has no free thread slots.</p>
    ${boundBlock}
    <div class="status-line" id="cx-status"></div>
    ${connectionsScript()}
  `
}

const ATTACH_STATUS: Record<string, 400 | 403 | 404 | 409 | 429> = {
  seat_attach_disabled: 403,
  invalid_args: 400,
  agent_not_found: 404,
  agent_ambiguous: 409,
  agent_identity_unminted: 409,
  seat_not_found: 404,
  too_many_pending_admissions: 429,
  already_attached: 409,
  attach_refused: 409,
  attach_code_mismatch: 403,
  approval_bound_to_other_chat: 409,
  admission_scope_mismatch: 409,
}

export function makeConnectionsApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/connections', async (c) => {
    const body = await connectionsPageBody(c.env, c.get('auth'))
    return c.html(shell(c.env, 'Connections', body))
  })

  /** Shared POST preconditions. Returns the human member id, or the refusal response. */
  async function guard(c: import('hono').Context<AppEnv>, fresh: boolean): Promise<{ ok: true; memberId: string } | { ok: false; res: Response }> {
    c.header('Cache-Control', 'no-store')
    if (c.req.header('origin') !== new URL(c.req.url).origin) return { ok: false, res: c.json({ error: 'cross_origin' }, 403) }
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh })
    if (!session.ok) return { ok: false, res: c.json({ error: session.error }, session.status) }
    if (!auth.memberId) return { ok: false, res: c.json({ error: 'forbidden' }, 403) }
    return { ok: true, memberId: auth.memberId }
  }

  app.post('/connections/attach', async (c) => {
    const g = await guard(c, true)
    if (!g.ok) return g.res
    if (!seatAttachEnabled(c.env)) return c.json({ error: 'seat_attach_disabled' }, 403)
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await c.req.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return c.json({ error: 'bad_request' }, 400)
      body = parsed as Record<string, unknown> // as: just narrowed to a non-array object; each field is validated below
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    if (typeof body.seat_id !== 'string' || typeof body.agent_id !== 'string' || !body.seat_id.trim() || !body.agent_id.trim()) {
      return c.json({ error: 'bad_request' }, 400)
    }
    // Attaching a chat to an agent widens that chat's reach: it needs the member's passkey, not just this session. The typed
    // attach code is never stored in a grant, so a pending ask that needs the code is decided on its passkey page instead.
    const attachCeiling = isAttachCeiling(body.ceiling) ? body.ceiling : 'member'
    const attachSeat = body.seat_id.trim()
    const attachAgent = body.agent_id.trim()
    const denied = await presenceGate(c, shell, g.memberId, {
      kind: 'seat_attach', subjectId: attachSeat, params: { seat_id: attachSeat, agent_id: attachAgent, ceiling: attachCeiling },
      summary: `Let one of your chats act as agent ${attachAgent} at level ${attachCeiling}`,
      actionPath: '/connections/attach', encoding: 'json', returnPath: '/connections',
    })
    if (denied) return denied
    const r = await attachSeatToAgent(c.env, {
      humanMemberId: g.memberId, seatId: attachSeat, agentRef: attachAgent, via: 'dashboard', moveIfAttached: true, ceiling: attachCeiling, attachCode: undefined,
    })
    if (!r.ok) return c.json({ error: r.error }, ATTACH_STATUS[r.error] ?? 400)
    return c.json(r)
  })

  app.post('/connections/attachments/:id/detach', async (c) => {
    const g = await guard(c, false)
    if (!g.ok) return g.res
    const r = await detachAttachment(c.env, { attachmentId: c.req.param('id').trim(), humanMemberId: g.memberId })
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 404)
  })

  // A label only: a real web session is enough (it never grants reach), and it works with the flag off.
  app.post('/connections/seats/:id/rename', async (c) => {
    const g = await guard(c, false)
    if (!g.ok) return g.res
    const body: unknown = await c.req.json().catch(() => ({}))
    const label = typeof body === 'object' && body !== null && 'label' in body ? body.label : undefined
    const r = await renameThread(c.env, { humanMemberId: g.memberId, seatId: c.req.param('id').trim(), label })
    return r.ok ? c.json({ ok: true, label: r.label }) : c.json({ error: r.error }, r.error === 'invalid_args' ? 400 : 404)
  })

  // #2060: HUMAN-only hold / release of an observed seat. Real web session of the seat's own human (the writer scopes to
  // agent_seats.member_id = that human). Hold REDUCES reach (real session only, like detach); release and return-to-observed WIDEN it (fresh reauth,
  // like approve). No MCP tool reaches this. VIP_LANE off = 403.
  app.post('/connections/seats/:id/:action{hold|release|return}', async (c) => {
    const action = c.req.param('action')
    if (!isSeatHoldAction(action)) return c.json({ error: 'bad_request' }, 400)
    // Real session first; whether the session is FRESH is decided by the writer per (action, from-status): only transitions that widen
    // reach (release; held -> observed) need it. Hold, and trusted -> held / observed, reduce reach and work on a real session alone.
    const g = await guard(c, false)
    if (!g.ok) return g.res
    const seatId = c.req.param('id').trim()
    // A transition that WIDENS the chat's reach (release; held -> observed) needs the member's passkey, which also stands in for
    // the old fresh-sign-in step. Hold, and trusted -> observed, reduce reach and stay session-only.
    let fresh = false
    if (vipLaneEnabled(c.env)) {
      const from = await seatAdmissionStatus(c.env, g.memberId, seatId)
      if (from && wideningTransition(action, from)) {
        const denied = await presenceGate(c, shell, g.memberId, {
          kind: action === 'release' ? 'seat_release' : 'seat_return_from_held', subjectId: seatId, params: { action, seat_id: seatId },
          summary: action === 'release' ? 'Release one of your chats to trusted: the observed limits stop applying to it' : 'Return a held chat to observed: it can act again',
          actionPath: `/connections/seats/${encodeURIComponent(seatId)}/${action}`, encoding: 'json', returnPath: '/connections',
        })
        if (denied) return denied
        fresh = true
      }
    }
    const r = await changeSeatAdmission(c.env, { humanMemberId: g.memberId, seatId, action, fresh })
    if (r.ok) return c.json({ ok: true, from: r.from, to: r.to, allowed_from: SEAT_TRANSITIONS[action].from })
    return c.json({ error: r.error }, r.error === 'vip_lane_disabled' || r.error === 'member_ineligible' || r.error === 'reauth_required' ? 403 : r.error === 'seat_not_found' ? 404 : 409)
  })

  app.post('/connections/admissions/:id/approve', async (c) => {
    const g = await guard(c, true)
    if (!g.ok) return g.res
    if (!seatAttachEnabled(c.env)) return c.json({ error: 'seat_attach_disabled' }, 403)
    // Admitting a chat widens its reach. The decision is made on the secure host with the member's passkey (the existing seat_admit
    // moment, where the attach code is typed and the level chosen); this session, even freshly signed in, cannot make it.
    const adm = await loadAdmission(c.env, c.req.param('id').trim())
    if (!adm || adm.human_member_id !== g.memberId) return c.json({ error: 'admission_not_found' }, 404)
    if (!admissionIsPendingLive(adm, Date.now()) || !adm.expires_at) return c.json({ error: 'not_pending' }, 409)
    if (secureMomentsStatus(c.env).state !== 'on') {
      return c.json({ error: 'human_presence_unavailable', message: 'Admitting a chat needs your passkey, and passkeys are not available on this workspace. Ask the workspace owner to enable secure moments. Nothing was changed.' }, 403)
    }
    if ((await listMemberPasskeys(c.env, g.memberId)).length === 0) {
      return c.json({ error: 'passkey_enrolment_required', message: 'Admitting a chat needs your passkey, and you have none yet. Add one under My Account, then try again. Nothing was changed.' }, 403)
    }
    const link = await issueMomentLink(c.env, { kind: 'seat_admit', subjectId: adm.id, requesterAgentId: null, subjectExpiresAtIso: adm.expires_at })
    if (!link) return c.json({ error: 'human_presence_unavailable', message: 'The passkey page could not be prepared. Nothing was changed.' }, 403)
    return c.json({ error: 'human_presence_required', message: 'Admitting a chat needs your passkey. Approve it on the passkey page.', approve_url: link.url }, 403)
  })

  app.post('/connections/admissions/:id/deny', async (c) => {
    const g = await guard(c, false)
    if (!g.ok) return g.res
    const r = await decideAdmissionDirect(c.env, { admissionId: c.req.param('id').trim(), humanMemberId: g.memberId, decision: 'deny' })
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.error === 'admission_not_found' ? 404 : 409)
  })

  app.post('/connections/admissions/:id/revoke', async (c) => {
    const g = await guard(c, false)
    if (!g.ok) return g.res
    const r = await revokeAdmission(c.env, { admissionId: c.req.param('id').trim(), humanMemberId: g.memberId })
    return r.ok ? c.json({ ok: true, detached: r.detached }) : c.json({ error: r.error }, 404)
  })

  return app
}
