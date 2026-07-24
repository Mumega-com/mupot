import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  capabilityRank,
  hasCapability,
  resolveCapabilities,
} from '../auth/capability'
import { requiredCanonicalOrigin } from './connect'
import { findAgentsByName } from '../org/service'
import type {
  AuthContext,
  Capability,
  CapabilityGrant,
  Env,
} from '../types'
import type { AgentAccessCapability } from '../members/agent-access'
import {
  cancelAgentConnectionRequest,
  provisionAgentConnection,
  type AgentConnectionActor,
  type AgentConnectionInput,
} from '../members/agent-connection'
import {
  loadAgentConnectionStatus,
  type AgentConnectionPublicStatus,
} from '../members/agent-connection-status'

export type AgentConnectionWizardAppEnv = {
  Bindings: Env
  Variables: {
    auth: AuthContext
    agentConnectionOperator: WizardOperator
  }
}

export interface AgentConnectionCandidate {
  id: string
  slug: string
  name: string
  role: string
  model: string
  status: string
  home_squad: {
    id: string
    name: string
    department_name: string | null
    immutable: true
  }
  connected: boolean
  live_tokens: Array<{
    id: string
    label: string
    created_at: string
    id_suffix: string
  }>
}

export interface AgentConnectionSquadChoice {
  id: string
  name: string
  department_name: string | null
  ceiling: Capability | null
}

export interface PendingAgentConnection {
  request_id: string
  target_key: string
  created_at: string
  expires_at: string
}

interface WizardOperator {
  actor: AgentConnectionActor
  auth: AuthContext
  grants: CapabilityGrant[]
}

const ACCESS_CAPABILITIES: readonly AgentAccessCapability[] = [
  'observer',
  'member',
  'lead',
  'admin',
]

const CAPABILITIES_DESC: readonly Capability[] = [
  'owner',
  'admin',
  'lead',
  'member',
  'observer',
]

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isAccessCapability(value: unknown): value is AgentAccessCapability {
  return typeof value === 'string'
    && (ACCESS_CAPABILITIES as readonly string[]).includes(value)
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statusCodeForError(error: string): 400 | 403 | 409 | 500 {
  if (
    error === 'forbidden'
    || error === 'capability_ceiling'
    || error === 'cannot_grant_above_own_rank'
  ) return 403
  if (
    error === 'request_id_conflict'
    || error === 'agent_setup_in_progress'
    || error === 'agent_already_connected'
    || error === 'credential_already_issued'
    || error === 'replace_token_not_found'
    || error === 'too_many_pending_agent_connections'
  ) return 409
  if (error === 'provisioning_failed' || error === 'receipt_failed') return 500
  return 400
}

async function resolveWizardOperator(
  env: Env,
  auth: AuthContext,
): Promise<WizardOperator | null> {
  if (
    auth.tenant !== env.TENANT_SLUG
    || auth.boundAgentId
    || !auth.userId
  ) return null

  const grants = auth.memberId
    ? await resolveCapabilities(env, auth.memberId)
    : []
  const legacyAdmin = auth.role === 'owner' || auth.role === 'admin'
  const currentOrgAdmin = hasCapability(grants, 'org', null, 'admin')
  if (!legacyAdmin && !currentOrgAdmin) return null

  return {
    auth,
    grants,
    actor: {
      kind: auth.memberId ? 'member' : 'user',
      id: auth.memberId ?? auth.userId,
      grants,
      ...(legacyAdmin ? { legacyOrgRole: auth.role as 'owner' | 'admin' } : {}),
    },
  }
}

interface CandidateHomeRow {
  name: string
  department_name: string | null
  member_id: string | null
}

interface CandidateTokenRow {
  id: string
  label: string
  created_at: string
}

export async function searchAgentConnectionCandidates(
  env: Env,
  query: string,
): Promise<AgentConnectionCandidate[]> {
  const matches = await findAgentsByName(env, query, { limit: 20 })
  return Promise.all(matches.map(async (agent) => {
    const home = await env.DB.prepare(
      `SELECT s.name,
              d.name AS department_name,
              b.member_id
         FROM squads s
         LEFT JOIN departments d ON d.id = s.department_id
         LEFT JOIN agent_member_bindings b
           ON b.tenant = ?
          AND b.agent_id = ?
        WHERE s.id = ?
        LIMIT 1`,
    ).bind(
      env.TENANT_SLUG,
      agent.id,
      agent.squad_id,
    ).first<CandidateHomeRow>()

    const tokens = home?.member_id
      ? await env.DB.prepare(
        `SELECT id, label, created_at
           FROM member_tokens
          WHERE tenant = ?
            AND agent_id = ?
            AND member_id = ?
            AND revoked_at IS NULL
          ORDER BY created_at ASC, id ASC`,
      ).bind(
        env.TENANT_SLUG,
        agent.id,
        home.member_id,
      ).all<CandidateTokenRow>()
      : { results: [] as CandidateTokenRow[] }

    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      model: agent.model,
      status: agent.status,
      home_squad: {
        id: agent.squad_id,
        name: home?.name ?? agent.squad_id,
        department_name: home?.department_name ?? null,
        immutable: true as const,
      },
      connected: Boolean(home?.member_id),
      live_tokens: (tokens.results ?? []).map((token) => ({
        id: token.id,
        label: token.label,
        created_at: token.created_at,
        id_suffix: token.id.slice(-4),
      })),
    }
  }))
}

interface SquadRow {
  id: string
  name: string
  department_id: string
  department_name: string | null
}

function legacyRank(auth: AuthContext): number {
  if (auth.role === 'owner') return capabilityRank('owner')
  if (auth.role === 'admin') return capabilityRank('admin')
  return 0
}

function ceilingForSquad(
  auth: AuthContext,
  grants: CapabilityGrant[],
  squad: SquadRow,
): Capability | null {
  const legacy = legacyRank(auth)
  for (const capability of CAPABILITIES_DESC) {
    if (
      legacy >= capabilityRank(capability)
      || hasCapability(
        grants,
        'squad',
        squad.id,
        capability,
        squad.department_id,
      )
    ) return capability
  }
  return null
}

async function loadSquadChoices(
  env: Env,
  operator: WizardOperator,
): Promise<AgentConnectionSquadChoice[]> {
  const result = await env.DB.prepare(
    `SELECT s.id,
            s.name,
            s.department_id,
            d.name AS department_name
       FROM squads s
       LEFT JOIN departments d ON d.id = s.department_id
      ORDER BY d.name ASC, s.name ASC`,
  ).all<SquadRow>()

  return (result.results ?? []).map((squad) => ({
    id: squad.id,
    name: squad.name,
    department_name: squad.department_name,
    ceiling: ceilingForSquad(operator.auth, operator.grants, squad),
  }))
}

async function loadPendingConnections(
  env: Env,
  actor: AgentConnectionActor,
): Promise<PendingAgentConnection[]> {
  const result = await env.DB.prepare(
    `SELECT request_id, target_key, created_at, expires_at
       FROM agent_connection_requests
      WHERE tenant = ?
        AND actor_kind = ?
        AND actor_id = ?
        AND status = 'pending'
      ORDER BY created_at ASC, request_id ASC`,
  ).bind(
    env.TENANT_SLUG,
    actor.kind,
    actor.id,
  ).all<PendingAgentConnection>()
  return result.results ?? []
}

function parseProvisionInput(
  value: unknown,
): AgentConnectionInput | null {
  if (!isObject(value) || !isString(value.request_id)) return null
  if (!isObject(value.target) || !isString(value.target.kind)) return null
  if (!Array.isArray(value.additional_access) || !isObject(value.credential)) {
    return null
  }

  let target: AgentConnectionInput['target']
  if (value.target.kind === 'existing') {
    if (!isString(value.target.agent_ref)) return null
    target = { kind: 'existing', agentRef: value.target.agent_ref }
  } else if (value.target.kind === 'new') {
    if (
      !isString(value.target.home_squad_id)
      || !isObject(value.target.agent)
      || !isString(value.target.agent.name)
      || !isString(value.target.agent.slug)
      || !isString(value.target.agent.role)
      || !isString(value.target.agent.model)
    ) return null
    target = {
      kind: 'new',
      homeSquadId: value.target.home_squad_id,
      agent: {
        name: value.target.agent.name,
        slug: value.target.agent.slug,
        role: value.target.agent.role,
        model: value.target.agent.model,
      },
    }
  } else {
    return null
  }

  const additionalAccess: AgentConnectionInput['additionalAccess'] = []
  for (const entry of value.additional_access) {
    if (
      !isObject(entry)
      || !isString(entry.squad_id)
      || !isAccessCapability(entry.capability)
    ) return null
    additionalAccess.push({
      squadId: entry.squad_id,
      capability: entry.capability,
    })
  }

  const action = value.credential.action
  const homeCapability = value.credential.home_capability
  if (
    action !== 'issue_if_missing'
    && action !== 'add'
    && action !== 'replace'
  ) return null
  if (
    !isString(value.credential.label)
    || (homeCapability !== 'observer' && homeCapability !== 'member')
  ) return null
  if (
    value.credential.replace_token_id !== undefined
    && !isString(value.credential.replace_token_id)
  ) return null

  return {
    requestId: value.request_id,
    target,
    additionalAccess,
    credential: {
      action,
      label: value.credential.label,
      homeCapability,
      ...(value.credential.replace_token_id !== undefined
        ? { replaceTokenId: value.credential.replace_token_id }
        : {}),
    },
  }
}

async function exactExistingMatches(
  env: Env,
  input: AgentConnectionInput,
): Promise<string[]> {
  if (input.target.kind !== 'new') return []
  const name = String(input.target.agent.name ?? '').trim().normalize('NFC').toLowerCase()
  const slug = String(input.target.agent.slug ?? '').trim().normalize('NFC').toLowerCase()
  const searches = await Promise.all([
    searchAgentConnectionCandidates(env, name),
    slug === name ? Promise.resolve([]) : searchAgentConnectionCandidates(env, slug),
  ])
  return [...new Set(searches.flat()
    .filter((candidate) => (
      candidate.name.trim().normalize('NFC').toLowerCase() === name
      || candidate.slug.trim().normalize('NFC').toLowerCase() === slug
    ))
    .map((candidate) => candidate.id))]
}

async function actorRequestExists(
  env: Env,
  actor: AgentConnectionActor,
  requestId: string,
): Promise<boolean> {
  const normalized = requestId.trim()
  if (normalized.length < 1 || normalized.length > 128) return false
  return Boolean(await env.DB.prepare(
    `SELECT 1 AS present
       FROM agent_connection_requests
      WHERE tenant = ?
        AND actor_kind = ?
        AND actor_id = ?
        AND request_id = ?
      LIMIT 1`,
  ).bind(
    env.TENANT_SLUG,
    actor.kind,
    actor.id,
    normalized,
  ).first<{ present: number }>())
}

function wizardShell(brand: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · ${escapeHtml(brand)}</title>
  <style>
    :root{color-scheme:light dark;--bg:#f6f7f6;--card:#fff;--text:#171b19;--dim:#66706a;--line:#dfe4e0;--gold:#96780a;--ok:#168447;--bad:#b42318}
    @media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b22;--text:#e6edf3;--dim:#9aa7b5;--line:#2a3140;--gold:#d4a017}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
    main{max-width:980px;margin:0 auto;padding:32px 20px 64px}.crumb{color:var(--dim);font-size:13px}.crumb a{color:inherit}
    h1{font-size:34px;margin:10px 0 4px}h2{font-size:20px;margin:0 0 8px}h3{font-size:16px}
    .lede,.muted{color:var(--dim)}.steps{display:grid;gap:14px;margin-top:24px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
    .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}label{display:grid;gap:5px;font-weight:600}
    input,select,button,textarea{font:inherit}input,select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
    button,.btn{border:0;border-radius:8px;padding:10px 14px;background:var(--gold);color:#fff;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
    button.secondary,.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}button:disabled{opacity:.45;cursor:not-allowed}
    .actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}.candidate,.access-row{display:flex;gap:12px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:12px 0}
    .candidate:first-child,.access-row:first-child{border-top:0}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px;color:var(--dim)}
    .locked{border:1px dashed var(--line);padding:12px;border-radius:8px}.error{color:var(--bad);font-weight:650}.success{color:var(--ok);font-weight:650}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px}
    code{overflow-wrap:anywhere}.secret{font-family:ui-monospace,monospace;font-size:13px}.hidden{display:none!important}
    .receipt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.kv{display:grid;grid-template-columns:140px 1fr;gap:6px;border-top:1px solid var(--line);padding:8px 0}
  </style>
</head>
<body><main><div class="crumb"><a href="/agents">Agents</a> / Connect</div>${body}</main></body>
</html>`
}

function squadOptions(squads: AgentConnectionSquadChoice[]): string {
  return squads.map((squad) => {
    const label = squad.department_name
      ? `${squad.department_name} / ${squad.name}`
      : squad.name
    return `<option value="${escapeHtml(squad.id)}">${escapeHtml(label)} · ceiling ${escapeHtml(squad.ceiling ?? 'none')}</option>`
  }).join('')
}

function additionalAccessRows(squads: AgentConnectionSquadChoice[]): string {
  return squads.map((squad) => {
    const label = squad.department_name
      ? `${squad.department_name} / ${squad.name}`
      : squad.name
    const allowed = ACCESS_CAPABILITIES.filter((capability) => (
      squad.ceiling !== null
      && capabilityRank(capability) <= capabilityRank(squad.ceiling)
    ))
    return `<div class="access-row" data-access-row data-squad-id="${escapeHtml(squad.id)}">
      <label style="display:flex;grid-template-columns:auto 1fr;align-items:center;gap:8px;font-weight:500">
        <input type="checkbox" data-access-check style="width:auto" />
        <span>${escapeHtml(label)} <span class="pill">ceiling ${escapeHtml(squad.ceiling ?? 'none')}</span></span>
      </label>
      <select data-access-capability style="width:auto" ${allowed.length === 0 ? 'disabled' : ''}>
        ${allowed.map((capability) => `<option value="${capability}">${capability}</option>`).join('')}
      </select>
    </div>`
  }).join('')
}

export function renderAgentConnectionEntry(
  canManage: boolean,
  hasSquads: boolean,
): string {
  if (!canManage) return ''
  if (!hasSquads) {
    return '<div class="card" style="margin-top:20px"><p class="empty">Create a squad first, then create or connect an agent.</p></div>'
  }
  return `<div class="card" style="margin-top:20px">
    <h2 style="margin-top:0">Create or connect agent</h2>
    <p class="empty" style="margin-top:0">Resolve an existing identity or create one, assign access, issue an agent-bound credential, and verify messaging in one guided flow.</p>
    <a class="btn" href="/agents/connect">Create or connect agent</a>
  </div>`
}

export function renderAgentConnectionWizard(
  brand: string,
  squads: AgentConnectionSquadChoice[],
  pendingConnections: PendingAgentConnection[] = [],
): string {
  const options = squadOptions(squads)
  const access = additionalAccessRows(squads)
  const recovery = pendingConnections.length === 0
    ? ''
    : `<section class="card" id="pending-recovery">
      <h2>Abandoned setup recovery</h2>
      <p class="muted">These reservations belong to this operator. Cancel only a setup that is no longer running; committed credentials cannot be cancelled here.</p>
      ${pendingConnections.map((request) => (
        `<div class="candidate" data-pending-row="${escapeHtml(request.request_id)}">
          <div><code>${escapeHtml(request.request_id)}</code><br /><span class="muted">${escapeHtml(request.target_key)} · expires ${escapeHtml(request.expires_at)}</span></div>
          <button type="button" class="secondary" data-cancel-request="${escapeHtml(request.request_id)}">Cancel pending setup</button>
        </div>`
      )).join('')}
    </section>`
  const body = `
  <h1>Create or connect agent</h1>
  <p class="lede">Resolve one identity, synchronize its access, issue one agent-bound key, then prove messaging.</p>
  <div class="steps">
    ${recovery}
    <section class="card" id="step-agent">
      <h2>1 · Agent</h2>
      <p class="muted">Search before creating. Existing agents keep their immutable home squad.</p>
      <div class="row">
        <label>Search name or slug
          <input id="agent-search" autocomplete="off" placeholder="kasra" />
        </label>
      </div>
      <div class="actions"><button type="button" id="search-button">Search identities</button><span id="search-status"></span></div>
      <div id="search-results"></div>
      <div class="card" style="margin-top:14px">
        <h3>Create a new identity</h3>
        <div class="row">
          <label>Name<input id="new-name" autocomplete="off" /></label>
          <label>Slug<input id="new-slug" autocomplete="off" /></label>
          <label>Role<input id="new-role" value="member" /></label>
          <label>Runtime / model<input id="new-model" value="@cf/meta/llama-3.3-70b-instruct-fp8-fast" /></label>
          <label>Home squad<select id="new-home">${options}</select></label>
        </div>
        <div class="actions"><button type="button" class="secondary" id="choose-new">Resolve and choose new</button></div>
      </div>
      <p id="agent-choice" class="muted">No identity selected.</p>
    </section>

    <section class="card" id="step-access">
      <h2>2 · Access</h2>
      <div class="locked"><strong>Home squad · locked</strong><div id="home-summary" class="muted">Choose an agent first.</div></div>
      <h3>Optional additional squads</h3>
      <p class="muted">Every requested capability is capped by your current authority. One canonical identity is reused.</p>
      <div id="access-list">${access}</div>
    </section>

    <section class="card" id="step-credential">
      <h2>3 · Credential</h2>
      <div class="row">
        <label>Label<input id="credential-label" maxlength="64" value="Codex" /></label>
        <label>Home preset<select id="home-capability"><option value="member">member</option><option value="observer">observer</option></select></label>
        <label>Action<select id="credential-action"><option value="issue_if_missing">Issue first credential</option></select></label>
        <label id="replace-wrap" class="hidden">Credential to replace<select id="replace-token"></select></label>
      </div>
      <p class="muted">Revisiting this page never mints. A bound identity requires an explicit add or replace action.</p>
      <div class="actions"><button type="button" id="provision-button">Review and issue</button><span id="provision-status"></span></div>
    </section>

    <section class="card hidden" id="step-connect">
      <h2>4 · Connect</h2>
      <p class="success">Credential issued. The two values below are shown once.</p>
      <h3>Raw credential</h3><pre id="show-credential" class="secret"></pre>
      <button type="button" class="secondary" data-copy="show-credential">Copy credential</button>
      <h3>Claude Code · .mcp.json</h3><pre id="config-claude"></pre>
      <button type="button" class="secondary" data-copy="config-claude">Copy Claude config</button>
      <h3>Codex · ~/.codex/config.toml</h3><pre id="config-codex"></pre>
      <button type="button" class="secondary" data-copy="config-codex">Copy Codex config</button>
      <h3>Cursor · mcp.json</h3><pre id="config-cursor"></pre>
      <button type="button" class="secondary" data-copy="config-cursor">Copy Cursor config</button>
      <p><a id="receipt-link" class="btn secondary">Open non-secret receipt</a></p>
    </section>

    <section class="card hidden" id="step-verify">
      <h2>5 · Verify</h2>
      <p>After installing the key, call <code>verify_agent_connection</code> from that client.</p>
      <h3>Verification challenge · shown once</h3><pre id="show-challenge" class="secret"></pre>
      <button type="button" class="secondary" data-copy="show-challenge">Copy challenge</button>
      <h3>Tool arguments</h3><pre id="verify-arguments"></pre>
    </section>
  </div>
  <script>
  (() => {
    const state = { requestId: crypto.randomUUID(), target: null, candidate: null };
    const byId = (id) => document.getElementById(id);
    const text = (id, value) => { byId(id).textContent = value; };
    const fail = (id, value) => { const el = byId(id); el.className = 'error'; el.textContent = value; };
    const ok = (id, value) => { const el = byId(id); el.className = 'success'; el.textContent = value; };

    function chooseExisting(candidate) {
      state.candidate = candidate;
      state.target = { kind: 'existing', agent_ref: candidate.id };
      text('agent-choice', candidate.name + ' · ' + candidate.slug + ' · existing identity selected');
      text('home-summary', candidate.home_squad.name + ' · immutable');
      document.querySelectorAll('[data-access-row]').forEach((row) => {
        const home = row.dataset.squadId === candidate.home_squad.id;
        row.classList.toggle('hidden', home);
        if (home) row.querySelector('[data-access-check]').checked = false;
      });
      const action = byId('credential-action');
      action.textContent = '';
      if (candidate.connected) {
        for (const item of [['add','Issue additional credential'],['replace','Replace credential']]) {
          const option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; action.append(option);
        }
      } else {
        const option = document.createElement('option'); option.value = 'issue_if_missing'; option.textContent = 'Issue first credential'; action.append(option);
      }
      const replacement = byId('replace-token');
      replacement.textContent = '';
      for (const token of candidate.live_tokens) {
        const option = document.createElement('option'); option.value = token.id; option.textContent = token.label + ' · …' + token.id_suffix; replacement.append(option);
      }
      action.dispatchEvent(new Event('change'));
    }

    async function search(query) {
      const response = await fetch('/agents/connect/search?q=' + encodeURIComponent(query), { headers: { accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'search_failed');
      return body.candidates;
    }

    byId('search-button').addEventListener('click', async () => {
      const query = byId('agent-search').value.trim();
      if (!query) return fail('search-status', 'Enter a name or slug.');
      try {
        const candidates = await search(query);
        const host = byId('search-results'); host.textContent = '';
        for (const candidate of candidates) {
          const row = document.createElement('div'); row.className = 'candidate';
          const summary = document.createElement('div');
          summary.textContent = candidate.name + ' · ' + candidate.slug + ' · home ' + candidate.home_squad.name + (candidate.connected ? ' · connected' : ' · unminted');
          const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Use this identity';
          button.addEventListener('click', () => chooseExisting(candidate));
          row.append(summary, button); host.append(row);
        }
        ok('search-status', candidates.length ? candidates.length + ' candidate(s)' : 'No matching identity.');
      } catch (error) { fail('search-status', error instanceof Error ? error.message : 'search_failed'); }
    });

    byId('choose-new').addEventListener('click', async () => {
      const name = byId('new-name').value.trim();
      const slug = byId('new-slug').value.trim();
      if (!name || !slug) return fail('search-status', 'Name and slug are required.');
      try {
        const candidates = [...await search(name), ...await search(slug)];
        const exact = candidates.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() || candidate.slug.toLowerCase() === slug.toLowerCase());
        if (exact) {
          chooseExisting(exact);
          return fail('search-status', 'Existing identity selected; creation was blocked.');
        }
        const home = byId('new-home');
        state.candidate = null;
        state.target = {
          kind: 'new',
          home_squad_id: home.value,
          agent: { name, slug, role: byId('new-role').value, model: byId('new-model').value }
        };
        text('agent-choice', name + ' · ' + slug + ' · new identity');
        text('home-summary', home.options[home.selectedIndex].textContent + ' · immutable after creation');
        document.querySelectorAll('[data-access-row]').forEach((row) => {
          const isHome = row.dataset.squadId === home.value;
          row.classList.toggle('hidden', isHome);
          if (isHome) row.querySelector('[data-access-check]').checked = false;
        });
        const action = byId('credential-action'); action.innerHTML = '<option value="issue_if_missing">Issue first credential</option>';
        action.dispatchEvent(new Event('change'));
        ok('search-status', 'No exact identity match. New identity selected.');
      } catch (error) { fail('search-status', error instanceof Error ? error.message : 'resolve_failed'); }
    });

    byId('credential-action').addEventListener('change', () => {
      byId('replace-wrap').classList.toggle('hidden', byId('credential-action').value !== 'replace');
    });

    byId('provision-button').addEventListener('click', async () => {
      if (!state.target) return fail('provision-status', 'Choose an agent first.');
      const access = [...document.querySelectorAll('[data-access-row]')].flatMap((row) => {
        const check = row.querySelector('[data-access-check]');
        const capability = row.querySelector('[data-access-capability]');
        return check.checked ? [{ squad_id: row.dataset.squadId, capability: capability.value }] : [];
      });
      const action = byId('credential-action').value;
      const payload = {
        request_id: state.requestId,
        target: state.target,
        additional_access: access,
        credential: {
          action,
          label: byId('credential-label').value,
          home_capability: byId('home-capability').value,
          ...(action === 'replace' ? { replace_token_id: byId('replace-token').value } : {})
        }
      };
      try {
        const response = await fetch('/agents/connect/provision', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'provision_failed');
        if (body.status !== 'credential_issued') {
          ok('provision-status', body.status + ' · use the non-secret receipt');
          if (body.receipt_url) location.assign(body.receipt_url);
          return;
        }
        text('show-credential', body.show_once.credential);
        text('show-challenge', body.show_once.challenge);
        text('config-claude', body.configuration.claude_code);
        text('config-codex', body.configuration.codex);
        text('config-cursor', body.configuration.cursor);
        const args = { receipt_id: body.receipt.id, challenge: body.show_once.challenge };
        text('verify-arguments', JSON.stringify(args, null, 2));
        byId('receipt-link').href = body.receipt_url;
        byId('step-connect').classList.remove('hidden');
        byId('step-verify').classList.remove('hidden');
        ok('provision-status', 'Credential issued once.');
      } catch (error) { fail('provision-status', error instanceof Error ? error.message : 'provision_failed'); }
    });

    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(byId(button.dataset.copy).textContent);
        button.textContent = 'Copied';
      });
    });

    document.querySelectorAll('[data-cancel-request]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const response = await fetch('/agents/connect/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ request_id: button.dataset.cancelRequest })
        });
        if (response.ok) {
          document.querySelector('[data-pending-row="' + CSS.escape(button.dataset.cancelRequest) + '"]')?.remove();
          if (!document.querySelector('[data-pending-row]')) byId('pending-recovery')?.remove();
          return;
        }
        button.disabled = false;
        button.textContent = 'Could not cancel';
      });
    });
  })();
  </script>`
  return wizardShell(brand, 'Create or connect agent', body)
}

function verificationLabel(status: AgentConnectionPublicStatus): string {
  if (status.verification.status === 'pass') return 'Messaging verified'
  if (status.verification.status === 'fail') return 'Verification failed'
  if (status.verification.status === 'expired') return 'Verification expired'
  if (status.verification.client_connected_at) return 'Client connected'
  return 'Credential issued'
}

function accessList(status: AgentConnectionPublicStatus): string {
  if (status.current.access.length === 0) return '<p class="muted">No current access rows.</p>'
  return `<ul>${status.current.access.map((access) => (
    `<li><code>${escapeHtml(access.squad_id)}</code> · ${escapeHtml(access.member_capability ?? 'none')} · ${access.synchronized ? 'synchronized' : 'out of sync'}</li>`
  )).join('')}</ul>`
}

export function renderAgentConnectionReceipt(
  brand: string,
  status: AgentConnectionPublicStatus,
): string {
  const body = `
  <h1>Agent connection receipt</h1>
  <p class="${status.verification.status === 'pass' ? 'success' : 'muted'}" id="verification-label">${escapeHtml(verificationLabel(status))}</p>
  <div class="receipt-grid">
    <section class="card">
      <h2>Issuance record</h2>
      <div class="kv"><strong>Receipt</strong><code>${escapeHtml(status.receipt_id)}</code></div>
      <div class="kv"><strong>Request</strong><code>${escapeHtml(status.request_id)}</code></div>
      <div class="kv"><strong>Agent</strong><span>${escapeHtml(status.issuance.agent.slug)} · ${escapeHtml(status.issuance.agent.disposition)}</span></div>
      <div class="kv"><strong>Home</strong><code>${escapeHtml(status.issuance.home_squad_id)}</code></div>
      <div class="kv"><strong>Credential</strong><span>${escapeHtml(status.issuance.credential_action)} · token …${escapeHtml(status.issuance.token_id_suffix)}</span></div>
      <div class="kv"><strong>Endpoint</strong><code>${escapeHtml(status.issuance.endpoint)}</code></div>
      <div class="kv"><strong>Issued</strong><time>${escapeHtml(status.issuance.credential_issued_at)}</time></div>
    </section>
    <section class="card" id="current-state">
      <h2>Current state</h2>
      <div class="kv"><strong>Agent status</strong><span id="current-agent-status">${escapeHtml(status.current.agent_status ?? 'missing')}</span></div>
      <div class="kv"><strong>Token</strong><span id="current-token-status">${status.current.token_revoked ? 'revoked' : 'live'}</span></div>
      <div id="current-access">${accessList(status)}</div>
    </section>
    <section class="card">
      <h2>Verification</h2>
      <div class="kv"><strong>Status</strong><span id="verification-status">${escapeHtml(status.verification.status)}</span></div>
      <div class="kv"><strong>Attempts</strong><span id="verification-attempts">${escapeHtml(status.verification.attempts)}</span></div>
      <div class="kv"><strong>Connected</strong><span id="verification-connected">${escapeHtml(status.verification.client_connected_at ?? 'not yet')}</span></div>
      <div class="kv"><strong>Verified</strong><span id="verification-verified">${escapeHtml(status.verification.messaging_verified_at ?? 'not yet')}</span></div>
      <div class="kv"><strong>Blocker</strong><span id="verification-error">${escapeHtml(status.verification.error_code ?? 'none')}</span></div>
      <button type="button" class="secondary" id="refresh-status">Refresh status</button>
    </section>
  </div>
  <p><a href="/agents">Back to agents</a></p>
  <script>
  (() => {
    const receiptId = document.querySelector('.receipt-grid code').textContent;
    const terminal = ['pass', 'fail', 'expired'];
    let timer = null;
    const set = (id, value) => { document.getElementById(id).textContent = value == null ? 'not yet' : String(value); };
    async function refresh() {
      const response = await fetch('/api/agent-connections/' + encodeURIComponent(receiptId) + '/status', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const status = await response.json();
      set('verification-status', status.verification.status);
      set('verification-attempts', status.verification.attempts);
      set('verification-connected', status.verification.client_connected_at);
      set('verification-verified', status.verification.messaging_verified_at);
      set('verification-error', status.verification.error_code || 'none');
      set('current-agent-status', status.current.agent_status || 'missing');
      set('current-token-status', status.current.token_revoked ? 'revoked' : 'live');
      if (terminal.includes(status.verification.status) && timer !== null) clearInterval(timer);
    }
    document.getElementById('refresh-status').addEventListener('click', refresh);
    if (!terminal.includes(document.getElementById('verification-status').textContent)) timer = setInterval(refresh, 2500);
  })();
  </script>`
  return wizardShell(brand, 'Agent connection receipt', body)
}

export const agentConnectionWizardApp = new Hono<AgentConnectionWizardAppEnv>()

agentConnectionWizardApp.use('*', async (c, next) => {
  const auth = c.get('auth')
  if (!auth) return c.json({ error: 'forbidden' }, 403)
  const operator = await resolveWizardOperator(c.env, auth)
  if (!operator) return c.json({ error: 'forbidden', need: 'owner_or_admin' }, 403)
  c.set('agentConnectionOperator', operator)
  await next()
})

function operatorFromContext(
  c: Context<AgentConnectionWizardAppEnv>,
): WizardOperator {
  return c.get('agentConnectionOperator')
}

agentConnectionWizardApp.get('/', async (c) => {
  const operator = operatorFromContext(c)
  const [squads, pendingConnections] = await Promise.all([
    loadSquadChoices(c.env, operator),
    loadPendingConnections(c.env, operator.actor),
  ])
  return c.html(renderAgentConnectionWizard(
    c.env.BRAND || 'Mupot',
    squads,
    pendingConnections,
  ))
})

agentConnectionWizardApp.get('/search', async (c) => {
  const query = c.req.query('q')?.trim() ?? ''
  if (query.length < 1 || query.length > 128) {
    return c.json({ error: 'invalid_query' }, 400)
  }
  return c.json({
    candidates: await searchAgentConnectionCandidates(c.env, query),
  })
})

agentConnectionWizardApp.post('/provision', async (c) => {
  const rawBody = await c.req.json().catch(() => null)
  const input = parseProvisionInput(rawBody)
  if (!input) return c.json({ error: 'invalid_request' }, 400)

  const operator = operatorFromContext(c)
  // A stable request must reach the shared service's fingerprint-aware replay
  // path. After a successful new-agent request, the newly created identity is
  // necessarily an exact match; treating it as a fresh duplicate would break
  // safe network retry and could tempt an operator to mint again.
  if (!(await actorRequestExists(c.env, operator.actor, input.requestId))) {
    const existingMatches = await exactExistingMatches(c.env, input)
    if (existingMatches.length > 0) {
      return c.json({
        error: 'existing_agent_match',
        candidate_ids: existingMatches,
      }, 409)
    }
  }

  const outcome = await provisionAgentConnection(
    c.env,
    operator.actor,
    input,
  )
  const canonical = requiredCanonicalOrigin(c.env)
  if (!canonical.ok) {
    return c.json({ error: canonical.error }, 400)
  }

  if (outcome.status === 'credential_issued') {
    const receiptUrl = `${canonical.origin}/agents/connect/receipts/${encodeURIComponent(outcome.receipt.id)}`
    return c.json({
      status: outcome.status,
      show_once: {
        credential: outcome.credential.raw,
        challenge: outcome.verification.challenge,
      },
      verification_expires_at: outcome.verification.expiresAt,
      endpoint: outcome.endpoint,
      configuration: {
        claude_code: outcome.configuration.claudeCode,
        codex: outcome.configuration.codex,
        cursor: outcome.configuration.cursor,
      },
      receipt_url: receiptUrl,
      receipt: {
        id: outcome.receipt.id,
        request_id: outcome.receipt.request_id,
        agent_id: outcome.receipt.agent_id,
        agent_slug: outcome.receipt.agent_slug,
        agent_disposition: outcome.receipt.agent_disposition,
        home_squad_id: outcome.receipt.home_squad_id,
        additional_access: JSON.parse(outcome.receipt.additional_access_json) as unknown,
        token_id_suffix: outcome.receipt.token_id.slice(-4),
      },
    }, 201)
  }

  if (outcome.status === 'credential_already_issued') {
    return c.json({
      status: outcome.status,
      receipt_url: `${canonical.origin}/agents/connect/receipts/${encodeURIComponent(outcome.receipt.id)}`,
      receipt: { id: outcome.receipt.id },
    })
  }
  if (outcome.status === 'in_progress') {
    return c.json({ status: outcome.status }, 202)
  }
  return c.json(
    {
      error: outcome.error,
      ...(outcome.details ? { details: outcome.details } : {}),
    },
    statusCodeForError(outcome.error),
  )
})

agentConnectionWizardApp.post('/cancel', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!isObject(body) || !isString(body.request_id)) {
    return c.json({ error: 'invalid_request_id' }, 400)
  }
  const result = await cancelAgentConnectionRequest(
    c.env,
    operatorFromContext(c).actor,
    body.request_id,
  )
  if (result.ok) return c.json(result)
  return c.json(
    { error: result.error },
    result.error === 'invalid_request_id' ? 400 : 409,
  )
})

agentConnectionWizardApp.get('/receipts/:receiptId', async (c) => {
  const result = await loadAgentConnectionStatus(
    c.env,
    operatorFromContext(c).auth,
    c.req.param('receiptId'),
  )
  if (!result.ok) return c.json({ error: 'not_found' }, 404)
  return c.html(renderAgentConnectionReceipt(c.env.BRAND || 'Mupot', result.value))
})
