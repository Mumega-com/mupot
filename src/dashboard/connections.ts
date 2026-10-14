// src/dashboard/connections.ts — "Connections": the human dashboard view of the threads running through each connected
// app (ChatGPT, claude.ai, Grok, Cursor ...) and which agent each one is acting as. W2 (SEAT_ATTACH).
//
// SCOPE DISCIPLINE: UI over the EXISTING writers in src/members/seat-attach.ts (attachSeatToAgent, detachAttachment,
// decideAdmissionDirect, revokeAdmission). Nothing here has its own authority: every writer re-scopes to the signed-in
// human (their own seats, their own admissions) and re-resolves the agent inside the set that human administers.
//
// Every POST: same-origin (Origin must equal the request origin), then a REAL dashboard web session of an active human
// member (checkWebSession; an agent / bearer / OAuth caller has none). Actions that GRANT reach (attach, approve) need a
// FRESH session (re-authenticated within five minutes, as /operators create does); actions that REDUCE it (detach, deny,
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
        function say(t) { if (status) status.textContent = t; }
        function reauthLink() {
          if (!status) return;
          status.textContent = '';
          var a = document.createElement('a'); a.href = '/auth/reauth'; a.textContent = 'Confirm it is you first';
          status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.'));
        }
        async function post(url, body, confirmText) {
          if (confirmText && !window.confirm(confirmText)) return;
          say('saving…');
          try {
            var res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok) { window.location.reload(); return; }
            if (data.error === 'reauth_required') reauthLink();
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
          post('/connections/admissions/' + encodeURIComponent(id) + '/approve', { ceiling: cs ? cs.value : 'member' });
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

  const pendingBody = pending.length === 0
    ? emptyState({ title: 'Nothing waiting', detail: 'When a thread asks to act as an agent you have not admitted yet, it appears here (and as a one-time passkey link it hands you).' })
    : dataTable({
      cols: [{ label: 'Agent', width: '1.2fr' }, { label: 'App', width: '1.2fr' }, { label: 'Asked', width: '1fr' }, { label: 'Decide', width: '1.4fr' }],
      rows: pending.map((a) => [
        html`${a.agent_name}`,
        html`${a.harness_name}`,
        html`${formatWhen(a.created_at)}`,
        enabled
          ? html`<select data-cx-aceiling="${a.id}"><option value="member">Member</option><option value="lead">Lead</option><option value="full">Full (agent's own standing)</option></select> <button class="btn" data-cx-approve="${a.id}">Admit</button> <button class="btn danger" data-cx-deny="${a.id}">Deny</button>`
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
                ? html`<select data-cx-agent="${s.seat_id}">${agents.map((a) => html`<option value="${a.id}">${a.name} (${a.squad_name})</option>`)}</select> <select data-cx-ceiling="${s.seat_id}"><option value="member">Member</option><option value="lead">Lead</option><option value="full">Full (agent's own standing)</option></select> <button class="btn" data-cx-attach="${s.seat_id}">Attach</button>`
                : html`${pill(enabled ? 'No agent to attach' : 'Attach disabled', 'dim')}`,
          ]),
          empty: '',
        }),
    }))}`

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
    ${harnessBlocks}
    ${sectionPanel({ title: 'Admitted agents', body: liveBody })}
    <p class="ui-sub">A level is chosen when an agent is admitted (Member, Lead, or Full = the agent's own standing, never more than yours). Threads never hold the agent's approval gates. To change a level, revoke the admission and admit again. An attached thread unused for ${ATTACH_IDLE_DAYS} days is detached automatically when its app has no free thread slots.</p>
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
    const r = await attachSeatToAgent(c.env, {
      humanMemberId: g.memberId, seatId: body.seat_id.trim(), agentRef: body.agent_id.trim(), via: 'dashboard', moveIfAttached: true, ceiling: isAttachCeiling(body.ceiling) ? body.ceiling : 'member',
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

  app.post('/connections/admissions/:id/approve', async (c) => {
    const g = await guard(c, true)
    if (!g.ok) return g.res
    if (!seatAttachEnabled(c.env)) return c.json({ error: 'seat_attach_disabled' }, 403)
    const body: unknown = await c.req.json().catch(() => ({}))
    const rawCeiling = typeof body === 'object' && body !== null && 'ceiling' in body ? body.ceiling : undefined
    const r = await decideAdmissionDirect(c.env, { admissionId: c.req.param('id').trim(), humanMemberId: g.memberId, decision: 'approve', ceiling: isAttachCeiling(rawCeiling) ? rawCeiling : 'member' })
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.error === 'admission_not_found' ? 404 : 409)
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
