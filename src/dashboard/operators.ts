// src/dashboard/operators.ts — "Operators": the human dashboard surface for delegated operators (W0.2, mumega-com#1386).
//
// Before this page a delegation could only be created through the MCP tool operator_delegate, which needs a HUMAN
// principal holding admin that is not agent-bound. In practice the owner has no such MCP session (connectors are
// agent-bound, harness sessions hold zero capabilities), so nobody could create the first delegation.
//
// SCOPE DISCIPLINE: UI only, over the EXISTING writers. Create calls createDelegation, Revoke calls revokeDelegation,
// the list is listVisibleDelegations (the one copy of operator_list's visibility rule). No new authority path: the
// writers keep every check they had (human principal, admin over the scope, rank cap, agent must be minted).
//
// What this module ADDS, in order, on every POST:
//   1. same-origin (Origin header must equal the request origin; a missing Origin is refused too);
//   2. a REAL dashboard web session of an active human member (checkWebSession): a bearer / agent / OAuth caller has no
//      web session and gets 403 before any argument is read;
//   3. for CREATE only, a fresh session: re-authenticated within five minutes (the same rule as passkey enrolment,
//      shared through checkWebSession). Revoke needs only the real session: it reduces authority.
// A passkey step-up for a dashboard action has no reusable helper today (secure moments are bound to approval
// decisions), so the freshness rule is the bar, as the brief allows.
//
// FLAG OFF (DELEGATED_OPERATORS): the page still renders, says "Operators are disabled", offers no create form, create is
// refused, and revoke keeps working: the same asymmetry as operator_delegate / operator_revoke.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env } from '../types'
import { actorRankOnScopeFor, capabilityRank } from '../auth/capability'
import { checkWebSession } from '../secure-moments/enrol-mint'
import {
  createDelegation,
  delegatedOperatorsEnabled,
  listVisibleDelegations,
  revokeDelegation,
  type DelegationError,
  type DelegationRow,
} from '../operators/delegations'
import { loadAllAgents } from './agents-admin'
import { pageHeader, sectionPanel, pill, emptyState, dataTable, type Html } from './ui'

type ShellFn = (
  env: Env,
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) => HtmlEscapedString | Promise<HtmlEscapedString>

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function delegationErrorStatus(error: DelegationError): 400 | 403 | 404 | 409 {
  switch (error) {
    case 'invalid_scope_type':
    case 'invalid_scope_id':
    case 'invalid_max_grant':
      return 400
    case 'scope_not_found':
    case 'agent_not_found':
    case 'delegation_not_found':
      return 404
    case 'delegation_exists':
    case 'agent_inactive':
    case 'agent_identity_unminted':
      return 409
    default:
      return 403
  }
}

function formatWhen(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

interface ScopeOption {
  type: 'org' | 'department' | 'squad' | 'project'
  id: string | null
  label: string
}

/**
 * Scopes this viewer could actually delegate over: only those where their own rank is already admin or better (a display
 * convenience so the picker never offers a scope the writer is guaranteed to refuse; createDelegation re-checks it).
 * Home departments/squads are never delegable. A project is an org-admin act everywhere, so projects need org admin.
 */
async function loadDelegableScopes(env: Env, auth: AuthContext): Promise<ScopeOption[]> {
  const floor = capabilityRank('admin')
  const out: ScopeOption[] = []
  const orgAdmin = (await actorRankOnScopeFor(env, auth, 'org', null)) >= floor
  if (orgAdmin) out.push({ type: 'org', id: null, label: 'Whole org' })
  const depts = await env.DB.prepare("SELECT id, name FROM departments WHERE kind != 'home' ORDER BY name ASC LIMIT 200").all<{ id: string; name: string }>()
  for (const d of depts.results ?? []) {
    if (orgAdmin || (await actorRankOnScopeFor(env, auth, 'department', d.id)) >= floor) out.push({ type: 'department', id: d.id, label: `Department: ${d.name}` })
  }
  const squads = await env.DB.prepare("SELECT id, name FROM squads WHERE kind != 'home' ORDER BY name ASC LIMIT 200").all<{ id: string; name: string }>()
  for (const s of squads.results ?? []) {
    if (orgAdmin || (await actorRankOnScopeFor(env, auth, 'squad', s.id)) >= floor) out.push({ type: 'squad', id: s.id, label: `Squad: ${s.name}` })
  }
  if (orgAdmin) {
    const projects = await env.DB.prepare('SELECT id, name FROM projects ORDER BY name ASC LIMIT 200').all<{ id: string; name: string }>()
    for (const p of projects.results ?? []) out.push({ type: 'project', id: p.id, label: `Project: ${p.name}` })
  }
  return out
}

async function nameMap(env: Env, sql: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const rows = await env.DB.prepare(sql).bind(JSON.stringify(ids)).all<{ id: string; label: string | null }>()
  for (const r of rows.results ?? []) map.set(r.id, r.label ?? r.id)
  return map
}

async function scopeLabels(env: Env, rows: DelegationRow[]): Promise<Map<string, string>> {
  const pick = (t: string) => [...new Set(rows.filter((r) => r.scope_type === t && r.scope_id).map((r) => r.scope_id as string))] // as: filtered non-null on the line above
  const [d, s, p] = await Promise.all([
    nameMap(env, 'SELECT id, name AS label FROM departments WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))', pick('department')),
    nameMap(env, 'SELECT id, name AS label FROM squads WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))', pick('squad')),
    nameMap(env, 'SELECT id, name AS label FROM projects WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))', pick('project')),
  ])
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.scope_type === 'org') out.set(r.id, 'Whole org')
    else {
      const m = r.scope_type === 'department' ? d : r.scope_type === 'squad' ? s : p
      out.set(r.id, `${r.scope_type}: ${m.get(r.scope_id ?? '') ?? r.scope_id ?? ''}`)
    }
  }
  return out
}

function operatorsScript(): Html {
  return raw(`
    <script>
      (function () {
        var status = document.getElementById('op-status');
        function say(t) { if (status) status.textContent = t; }
        function reauthLink() {
          if (!status) return;
          status.textContent = '';
          var a = document.createElement('a'); a.href = '/auth/reauth'; a.textContent = 'Confirm it is you first';
          status.appendChild(a); status.appendChild(document.createTextNode(', then come back and try again.'));
        }
        var add = document.getElementById('op-create');
        if (add) add.addEventListener('click', async function () {
          var agent = document.getElementById('op-agent');
          var scope = document.getElementById('op-scope');
          var grant = document.getElementById('op-grant');
          if (!agent || !scope || !grant || !agent.value || !scope.value) { say('Pick an agent and a scope.'); return; }
          var parts = scope.value.split(':');
          var body = { agent_id: agent.value, scope_type: parts[0], max_grant: grant.value };
          if (parts.length > 1) body.scope_id = parts.slice(1).join(':');
          add.disabled = true; say('saving…');
          try {
            var res = await fetch('/operators/delegate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            var data = await res.json().catch(function () { return {}; });
            if (res.ok) { window.location.reload(); return; }
            if (data.error === 'reauth_required') reauthLink();
            else say('Could not create (' + (data.error || res.status) + ').');
          } catch (e) { say('Network error — try again.'); }
          add.disabled = false;
        });
        var rm = document.querySelectorAll('button[data-op-revoke]');
        for (var i = 0; i < rm.length; i++) rm[i].addEventListener('click', async function (ev) {
          if (!window.confirm('Revoke this operator delegation? It takes effect on the agent\\'s very next request.')) return;
          var id = ev.currentTarget.getAttribute('data-op-revoke');
          var res = await fetch('/operators/' + encodeURIComponent(id) + '/revoke', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok) window.location.reload(); else say('Could not revoke (' + (data.error || res.status) + ').');
        });
      })();
    </script>`)
}

async function createFormBody(env: Env, auth: AuthContext): Promise<Html> {
  const [agents, scopes] = await Promise.all([loadAllAgents(env, auth), loadDelegableScopes(env, auth)])
  const active = agents.filter((a) => a.status === 'active')
  if (scopes.length === 0) {
    return emptyState({
      title: 'No scope you can delegate over',
      detail: 'Making an agent an operator needs admin over the scope. Ask an org admin.',
    })
  }
  if (active.length === 0) {
    return emptyState({ title: 'No agents to choose from', detail: 'No active agent is visible to you.' })
  }
  return html`
    <p class="ui-sub">Let one agent organise structure (squads, projects, memberships) inside one scope, never above the level you choose. It takes effect on the agent's next request and you can revoke it at any time.</p>
    <label class="ui-sub" for="op-agent" style="display:block;margin-top:8px;">Agent</label>
    <select id="op-agent">
      ${active.map((a) => html`<option value="${a.id}">${a.name} (${a.squad_name})</option>`)}
    </select>
    <label class="ui-sub" for="op-scope" style="display:block;margin-top:8px;">Scope</label>
    <select id="op-scope">
      ${scopes.map((s) => html`<option value="${s.id ? `${s.type}:${s.id}` : s.type}">${s.label}</option>`)}
    </select>
    <label class="ui-sub" for="op-grant" style="display:block;margin-top:8px;">Highest rank it may grant</label>
    <select id="op-grant">
      <option value="member">member</option>
      <option value="lead">lead</option>
    </select>
    <button class="btn" id="op-create" style="margin-top:10px;">Make this agent an operator</button>
    <p class="ui-sub" style="margin-top:6px;">Creating an operator needs a recent sign-in (within 5 minutes); you will be asked to confirm it is you if yours is older.</p>
  `
}

async function listBody(env: Env, auth: AuthContext): Promise<Html> {
  const rows = await listVisibleDelegations(env, auth, { includeRevoked: true })
  const agentNames = await nameMap(
    env,
    'SELECT id, name AS label FROM agents WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))',
    [...new Set(rows.map((r) => r.agent_id))],
  )
  const memberNames = await nameMap(
    env,
    'SELECT id, COALESCE(display_name, email) AS label FROM members WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))',
    [...new Set(rows.map((r) => r.delegator_member_id))],
  )
  const scopes = await scopeLabels(env, rows)
  return dataTable({
    cols: [
      { label: 'Agent', width: '1.2fr' },
      { label: 'Scope', width: '1.4fr' },
      { label: 'Max grant', width: '0.7fr' },
      { label: 'Delegator', width: '1fr' },
      { label: 'Created', width: '1fr' },
      { label: 'Status', width: '1.2fr' },
    ],
    rows: rows.map((r) => [
      html`${agentNames.get(r.agent_id) ?? r.agent_id}`,
      html`${scopes.get(r.id) ?? ''}`,
      html`${r.max_grant}`,
      html`${memberNames.get(r.delegator_member_id) ?? r.delegator_member_id}`,
      html`${formatWhen(r.created_at)}`,
      r.revoked_at
        ? html`${pill('Revoked', 'dim')} ${formatWhen(r.revoked_at)}`
        : html`${pill('Active', 'primary')} <button class="btn danger" data-op-revoke="${r.id}">Revoke</button>`,
    ]),
    empty: 'No operators yet.',
  })
}

async function operatorsPageBody(env: Env, auth: AuthContext): Promise<Html> {
  const enabled = delegatedOperatorsEnabled(env)
  const create = enabled
    ? await createFormBody(env, auth)
    : emptyState({
        title: 'Operators are disabled',
        detail: 'Delegated operators are not switched on for this pot, so no new operator can be made. Existing ones can still be revoked below.',
      })
  return html`
    ${pageHeader({
      crumbs: 'Overview / Operators',
      title: 'Operators',
      sub: 'Agents a person has allowed to organise structure inside one scope.',
    })}
    ${sectionPanel({ title: 'Make an agent an operator', body: create })}
    ${sectionPanel({ title: 'Delegations', body: await listBody(env, auth) })}
    <div class="status-line" id="op-status"></div>
    ${operatorsScript()}
  `
}

export function makeOperatorsApp(shell: ShellFn) {
  const app = new Hono<AppEnv>()

  app.get('/operators', async (c) => {
    const body = await operatorsPageBody(c.env, c.get('auth'))
    return c.html(shell(c.env, 'Operators', body))
  })

  app.post('/operators/delegate', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh: true })
    if (!session.ok) return c.json({ error: session.error }, session.status)
    if (!delegatedOperatorsEnabled(c.env)) return c.json({ error: 'delegated_operators_disabled' }, 403)
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await c.req.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return c.json({ error: 'bad_request' }, 400)
      body = parsed as Record<string, unknown> // as: just narrowed to a non-array object; each field is validated by createDelegation
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    if (typeof body.agent_id !== 'string' || body.agent_id.trim().length === 0) return c.json({ error: 'bad_request' }, 400)
    const result = await createDelegation(c.env, auth, {
      agentId: body.agent_id.trim(),
      scopeType: body.scope_type,
      scopeId: body.scope_id,
      maxGrant: body.max_grant,
    })
    if (!result.ok) return c.json({ error: result.error }, delegationErrorStatus(result.error))
    return c.json({ delegation: result.delegation })
  })

  // Revoke reduces authority: a real web session is enough (no fresh re-auth), and it works with the flag off.
  app.post('/operators/:id/revoke', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'cross_origin' }, 403)
    const auth = c.get('auth')
    const session = await checkWebSession(c.env, auth, { fresh: false })
    if (!session.ok) return c.json({ error: session.error }, session.status)
    const result = await revokeDelegation(c.env, auth, c.req.param('id').trim())
    if (!result.ok) return c.json({ error: result.error }, delegationErrorStatus(result.error))
    return c.json({ delegation: result.delegation })
  })

  return app
}
