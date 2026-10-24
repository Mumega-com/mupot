// src/dashboard/doorbells.ts — "Doorbells": the HUMAN registration path for an agent's outbound wake webhook
// (Grok Bot webhook routine). The bearer key is pasted here by a person; it never travels through MCP args or the bus.
//
// SCOPE DISCIPLINE: UI over the existing service (src/agents/webhook-doorbell.ts): set / clear / test ping. The
// service keeps every rule it had: https + public host + port 443, bearer AES-GCM under CONNECTOR_MASTER_KEY, the
// WEBHOOK_DOORBELL flag. What this module adds, on every POST (same bar as /operators):
//   1. same-origin (Origin must equal the request origin; a missing Origin is refused);
//   2. a REAL dashboard web session of an active human member (checkWebSession); an agent / bearer caller gets 403;
//   3. admin over THE AGENT'S SQUAD (org admin covers every squad), re-derived per request;
//   4. SET needs a fresh session (re-auth within five minutes: it stores a credential). Clear and Test need only the
//      real session (clearing reduces authority; a test ping sends a fixed non-secret body to a URL already stored).
// The key is write-only: it is never rendered, never returned, never logged; only the last four characters show.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { canOnSquadAuth } from '../auth/capability'
import { checkWebSession } from '../secure-moments/enrol-mint'
import {
  clearAgentWebhookDoorbell,
  listAgentWebhookDoorbells,
  sendDoorbellTestPing,
  setAgentWebhookDoorbell,
  webhookDoorbellEnabled,
} from '../agents/webhook-doorbell'
import { loadAllAgents } from './agents-admin'
import { pageHeader, sectionPanel, pill, emptyState, dataTable, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

/**
 * Admin over this squad right now: the SAME predicate as the MCP tools (canOnSquadAuth). A home (personal) squad grants
 * no standing to org/department/role planes, so an org admin cannot set, clear or test another member's personal agent.
 * Re-checked by every POST and by the page.
 */
async function canAdminSquad(env: Env, auth: AuthContext, squadId: string): Promise<boolean> {
  return canOnSquadAuth(env, auth, squadId, 'admin')
}

async function loadAgentSquad(env: Env, agentId: string): Promise<{ id: string; squad_id: string } | null> {
  const row = await env.DB.prepare('SELECT id, squad_id FROM agents WHERE id = ?1 LIMIT 1')
    .bind(agentId)
    .first<{ id: string; squad_id: string }>()
  return row ?? null
}

/** Plain-language reading of a delivery outcome for the Save / Send test ping UI. */
export function doorbellMessage(d: { outcome: string; http_status?: number; reason?: string }): string {
  if (d.outcome === 'no_doorbell') return 'No doorbell is saved for this agent yet.'
  if (d.outcome === 'disabled') return 'Doorbells are switched off for this pot (WEBHOOK_DOORBELL).'
  if (d.outcome === 'rate_limited') return 'Too many test pings; wait a few minutes and try again.'
  if (d.reason === 'timeout') return 'No answer within 3s.'
  if (d.outcome === 'skipped') return `Not sent (${d.reason ?? 'skipped'}).`
  const code = d.http_status
  if (code !== undefined) {
    if (code >= 200 && code < 300) return `Delivered (HTTP ${code}). Grok accepted the ping.`
    if (code === 401 || code === 403) return `Grok rejected the key (HTTP ${code}). Re-enter the sender key from the routine panel.`
    if (code === 404) return 'URL not found (HTTP 404). Copy it again from the routine panel.'
    if (code >= 300 && code < 400) return `URL redirects (HTTP ${code}). Paste the final URL.`
    return `Grok answered HTTP ${code}.`
  }
  return `Could not reach the URL (${d.reason ?? 'error'}).`
}

function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

function doorbellScript(): Html {
  return raw(`
    <script>
      (function () {
        var status = document.getElementById('db-status');
        function say(t) { if (status) status.textContent = t; }
        function reauthLink() {
          if (!status) return;
          status.textContent = '';
          var a = document.createElement('a'); a.href = '/auth/reauth?return=/doorbells'; a.textContent = 'Confirm it is you first';
          status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.'));
        }
        async function post(path, body) {
          var res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
          var data = await res.json().catch(function () { return {}; });
          return { ok: res.ok, status: res.status, data: data };
        }
        var save = document.getElementById('db-save');
        if (save) save.addEventListener('click', async function () {
          var agent = document.getElementById('db-agent');
          var url = document.getElementById('db-url');
          var key = document.getElementById('db-key');
          if (!agent || !url || !key || !agent.value || !url.value || !key.value) { say('Pick an agent, paste the URL and the key.'); return; }
          save.disabled = true; say('saving…');
          try {
            var r = await post('/doorbells/set', { agent_id: agent.value, webhook_url: url.value, bearer: key.value });
            key.value = '';
            if (r.ok) { window.location.href = '/doorbells?saved=' + encodeURIComponent(agent.value); return; }
            if (r.data.error === 'reauth_required') reauthLink();
            else say('Could not save (' + (r.data.error || r.status) + (r.data.detail ? ': ' + r.data.detail : '') + ').');
          } catch (e) { say('Network error — try again.'); }
          save.disabled = false;
        });
        var rm = document.querySelectorAll('button[data-db-clear]');
        for (var i = 0; i < rm.length; i++) rm[i].addEventListener('click', async function (ev) {
          if (!window.confirm('Remove this doorbell? The agent stops being woken by webhook.')) return;
          var r = await post('/doorbells/' + encodeURIComponent(ev.currentTarget.getAttribute('data-db-clear')) + '/clear');
          if (r.ok) window.location.reload(); else say('Could not remove (' + (r.data.error || r.status) + ').');
        });
        var tp = document.querySelectorAll('button[data-db-test]');
        for (var j = 0; j < tp.length; j++) tp[j].addEventListener('click', async function (ev) {
          var btn = ev.currentTarget; btn.disabled = true; say('sending test ping…');
          try {
            var r = await post('/doorbells/' + encodeURIComponent(btn.getAttribute('data-db-test')) + '/test');
            if (r.ok) say(r.data.message || ('Test ping: ' + r.data.outcome));
            else say('Test ping refused (' + (r.data.error || r.status) + ').');
          } catch (e) { say('Network error — try again.'); }
          btn.disabled = false;
        });
      })();
    </script>`)
}

async function pageBody(env: Env, auth: AuthContext, savedAgentId: string | null): Promise<Html> {
  const enabled = webhookDoorbellEnabled(env)
  // ONE query for every doorbell row of the pot (never one lookup per agent).
  const bells = await listAgentWebhookDoorbells(env)
  // Flag off: nothing can be registered, so the per-agent authz loop is pointless. It runs only when a row is left
  // behind to be removed, and then only over THOSE agents (typically none: zero statements beyond the one above).
  const visible = enabled || bells.size > 0 ? await loadAllAgents(env, auth) : []
  // Squad admin authz once per SQUAD, not once per agent.
  const squadAdmin = new Map<string, Promise<boolean>>()
  const canAdminCached = (squadId: string): Promise<boolean> => {
    let hit = squadAdmin.get(squadId)
    if (!hit) {
      hit = canAdminSquad(env, auth, squadId)
      squadAdmin.set(squadId, hit)
    }
    return hit
  }
  const manageable: typeof visible = []
  for (const a of enabled ? visible : visible.filter((v) => bells.has(v.id))) {
    if (await canAdminCached(a.squad_id)) manageable.push(a)
  }

  const rows = manageable.map((a) => ({ agent: a, bell: bells.get(a.id) ?? null }))

  const form = !enabled
    ? emptyState({
        title: 'Doorbells are disabled',
        detail: 'Webhook doorbells are not switched on for this pot (WEBHOOK_DOORBELL), so none can be registered or tested. Existing ones can still be removed below.',
      })
    : manageable.length === 0
      ? emptyState({ title: 'No agent you can manage', detail: 'A doorbell is registered by an admin over the agent\'s squad. Ask one.' })
      : html`
        <p class="ui-sub">In the Grok Bot routine panel, create a webhook routine and copy its public HTTPS URL, then choose the sender key. Paste both here. The key is stored encrypted, shown only as its last four characters, and can be removed at any time. The routine prompt should peek the pot: the ping carries ids only, never a message body.</p>
        <label class="ui-sub" for="db-agent" style="display:block;margin-top:8px;">Agent</label>
        <select id="db-agent">
          ${manageable.map((a) => html`<option value="${a.id}">${a.name} (${a.squad_name})</option>`)}
        </select>
        <label class="ui-sub" for="db-url" style="display:block;margin-top:8px;">Routine webhook URL (https)</label>
        <input id="db-url" type="url" autocomplete="off" spellcheck="false" style="width:100%;" />
        <label class="ui-sub" for="db-key" style="display:block;margin-top:8px;">Sender key (bearer)</label>
        <input id="db-key" type="password" autocomplete="off" spellcheck="false" style="width:100%;" />
        <button class="btn" id="db-save" style="margin-top:10px;">Save doorbell</button>
        <p class="ui-sub" style="margin-top:6px;">Saving needs a recent sign-in (within 5 minutes); you will be asked to confirm it is you if yours is older.</p>
      `

  const list = dataTable({
    cols: [
      { label: 'Agent', width: '1.2fr' },
      { label: 'Webhook', width: '2fr' },
      { label: 'Key', width: '0.6fr' },
      { label: 'Updated', width: '1fr' },
      { label: 'Actions', width: '1.4fr' },
    ],
    rows: rows.map(({ agent, bell }) => [
      html`${agent.name} <span class="ui-sub">(${agent.squad_name})</span>`,
      bell ? html`${bell.webhook_url}` : html`${pill('Not set', 'dim')}`,
      bell ? html`…${bell.auth_last4}` : html``,
      bell ? html`${formatWhen(bell.updated_at)}` : html``,
      bell
        ? html`<button class="btn" data-db-test="${agent.id}">Send test ping</button> <button class="btn danger" data-db-clear="${agent.id}">Remove</button>`
        : html``,
    ]),
    empty: 'No agents you can manage.',
  })

  return html`
    ${pageHeader({
      crumbs: 'Overview / Doorbells',
      title: 'Doorbells',
      sub: 'Wake an agent\'s Grok Bot routine by webhook when it gets mail or a task.',
    })}
    ${sectionPanel({ title: 'Register a doorbell', body: form })}
    ${sectionPanel({ title: 'Agents', body: list })}
    <div class="status-line" id="db-status">${savedAgentId ? 'Saved. Now press "Send test ping" on the agent below to check Grok accepts it.' : ''}</div>
    ${doorbellScript()}
  `
}

export function makeDoorbellsApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/doorbells', async (c) => {
    const body = await pageBody(c.env, c.get('auth'), c.req.query('saved') ?? null)
    return c.html(shell(c.env, 'Doorbells', body))
  })

  /** Shared preamble for every POST: origin, real web session, agent exists, admin over its squad. */
  async function guard(
    c: { req: { header(n: string): string | undefined; url: string }; env: Env; get(k: 'auth'): AuthContext },
    agentId: unknown,
    fresh: boolean,
  ): Promise<{ ok: true; memberId: string; agentId: string } | { ok: false; status: 400 | 403 | 404 | 409; error: string }> {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return { ok: false, status: 403, error: 'cross_origin' }
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh })
    if (!session.ok) return { ok: false, status: session.status, error: session.error }
    if (typeof agentId !== 'string' || agentId.trim().length === 0) return { ok: false, status: 400, error: 'bad_request' }
    const agent = await loadAgentSquad(c.env, agentId.trim())
    if (!agent) return { ok: false, status: 404, error: 'agent_not_found' }
    if (!(await canAdminSquad(c.env, auth, agent.squad_id))) return { ok: false, status: 403, error: 'forbidden' }
    return { ok: true, memberId: session.memberId, agentId: agent.id }
  }

  app.post('/doorbells/set', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await c.req.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return c.json({ error: 'bad_request' }, 400)
      body = parsed as Record<string, unknown> // as: just narrowed to a non-array object; each field is validated below / by the service
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    const g = await guard(c, body.agent_id, true)
    if (!g.ok) return c.json({ error: g.error }, g.status)
    if (typeof body.webhook_url !== 'string' || typeof body.bearer !== 'string') return c.json({ error: 'bad_request' }, 400)
    const result = await setAgentWebhookDoorbell(c.env, {
      agentId: g.agentId,
      webhookUrl: body.webhook_url,
      bearer: body.bearer,
      createdByMemberId: g.memberId,
    })
    if (!result.ok) {
      const status = result.error === 'doorbell_crypto_unavailable' ? 503 : result.error === 'webhook_doorbell_disabled' ? 403 : result.error === 'no_tenant' ? 500 : 400
      return c.json({ error: result.error, ...('detail' in result ? { detail: result.detail } : {}) }, status)
    }
    return c.json({ doorbell: result.doorbell })
  })

  // Clear reduces authority: a real web session is enough, and it works with the flag off.
  app.post('/doorbells/:agentId/clear', async (c) => {
    c.header('Cache-Control', 'no-store')
    const g = await guard(c, c.req.param('agentId'), false)
    if (!g.ok) return c.json({ error: g.error }, g.status)
    await clearAgentWebhookDoorbell(c.env, g.agentId)
    return c.json({ configured: false, agent_id: g.agentId })
  })

  app.post('/doorbells/:agentId/test', async (c) => {
    c.header('Cache-Control', 'no-store')
    const g = await guard(c, c.req.param('agentId'), false)
    if (!g.ok) return c.json({ error: g.error }, g.status)
    const delivery = await sendDoorbellTestPing(c.env, g.agentId)
    return c.json({ agent_id: g.agentId, ...delivery, message: doorbellMessage(delivery) })
  })

  return app
}
