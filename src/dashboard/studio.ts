// src/dashboard/studio.ts — Mupot Studio, the Lovable/Claude Design canvas.
//
// A full-bleed dark split-pane operator surface:
//   GET  /studio                 authenticated HTML canvas
//   POST /api/studio/dispatch    create a flight + task from a prompt
//   POST /api/studio/chat        always-on streaming Co-Pilot (SSE)
//
// PURE-ISH VIEW + thin write path. Auth is the dashboard session
// (`getAuthContext` / `c.get('auth')`) or a member-bearer token on the
// `/api/studio` mount. Writes reuse createTask + createFlight. When
// CURSOR_API_TOKEN is bound and the model is cursor-cloud, dispatch also
// launches a Cursor Cloud agent. Chat is always-on: admin/owner sessions
// get full tool-calling; member / guest sessions stay read-only.

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Context } from 'hono'
import { resolveCapabilities, holdsCapabilityFloor, isOrgAdmin } from '../auth/capability'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { createCursorAgent, resolveCursorApiToken } from '../cursor/client'
import { injectSevenAxisSeatDeclaration } from '../cursor/seat-identity'
import type { AuthContext, Env } from '../types'
import { createFlight, listFlights, type FlightRow } from '../flight/service'
import { createTask } from '../tasks/service'
import { peekSessionAuth } from '../auth'
import { MUPOT_FAVICON_32_PNG_B64, MUPOT_MARK_64_PNG_B64 } from './brand-assets'
import { readStudioChatPayload, streamStudioChat } from './copilot'
import type { StudioChatRole } from './studio-chat'

import { resolveTier } from '../billing/entitlement'
import { listPresence } from '../fleet/presence'
import { resolveConnector } from '../connectors/service'
import { introspectSupabaseSchema } from '../connectors/supabase'

export {
  STUDIO_CHAT_ADMIN_TOOLS,
  studioChatAuthorityFromAuth,
  buildStudioChatSystemPrompt,
  parseStudioChatInput,
  handleStudioChat,
} from './studio-chat'
export type { StudioChatAuthority, StudioChatRole } from './studio-chat'

export type StudioModel = 'cursor-cloud' | 'codex'

export interface StudioDispatchInput {
  prompt: string
  repoUrl?: string
  model?: string
}

export interface StudioDispatchOk {
  ok: true
  flight_id: string
  task_id: string | null
  model: StudioModel
  agent_id?: string | null
  run_id?: string | null
  agent_url?: string | null
  cursor_launched?: boolean
}

export interface StudioAgentCard {
  id: string
  slug: string
  name: string
  role: string
  model: string
  activeSeat?: string | null
  harness?: string | null
  provider?: string | null
  isLive?: boolean
}

export interface StudioTableSummary {
  name: string
  columnCount: number
  description?: string
}

export interface StudioViewData {
  brand: string
  tenant: string
  tier?: string
  operator: string
  branch: string
  flights: FlightRow[]
  agents?: StudioAgentCard[]
  supabaseTables?: StudioTableSummary[]
  hasSupabase?: boolean
  repoUrl?: string
  authorityRole?: StudioChatRole
}

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

/** Session principal already resolved by dashboard `requireAuth`. */
export function getAuthContext(c: Context<AppEnv>): AuthContext {
  return c.get('auth')
}

export function normalizeStudioModel(raw: string | undefined): StudioModel {
  const value = (raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (value === 'codex') return 'codex'
  return 'cursor-cloud'
}

export async function loadStudioData(env: Env, auth: AuthContext): Promise<StudioViewData> {
  const flights = await listFlights(env, 12)
  const tier = await resolveTier(env)

  let agents: StudioAgentCard[] = []
  try {
    const agentRows = await env.DB.prepare(
      'SELECT id, slug, name, role, model FROM agents WHERE status = "active" ORDER BY created_at ASC LIMIT 16'
    ).all<{ id: string; slug: string; name: string; role: string; model: string }>()

    const presenceList = await listPresence(env, Date.now())
    const presenceMap = new Map(presenceList.map((p) => [p.agent_id, p]))

    agents = (agentRows.results || []).map((a) => {
      const p = presenceMap.get(a.id)
      return {
        id: a.id,
        slug: a.slug,
        name: a.name,
        role: a.role,
        model: a.model,
        activeSeat: p?.label || null,
        harness: p?.harness || null,
        provider: p?.provider || null,
        isLive: !!p && (Date.now() - new Date(p.last_seen_at).getTime() < 300_000),
      }
    })
  } catch {
    agents = []
  }

  let supabaseTables: StudioTableSummary[] = []
  let hasSupabase = false
  try {
    const raw = await resolveConnector(env, 'pot', 'supabase')
    if (raw) {
      hasSupabase = true
      const parsed = JSON.parse(raw)
      if (parsed.url && parsed.apiKey) {
        const schema = await introspectSupabaseSchema(parsed)
        supabaseTables = schema.tables.map((t) => ({
          name: t.name,
          columnCount: t.columns.length,
          description: t.description,
        }))
      }
    }
  } catch {
    supabaseTables = []
  }

  return {
    brand: env.BRAND || 'Mupot',
    tenant: env.TENANT_SLUG || 'default',
    tier,
    operator: auth.email || auth.userId,
    branch: studioBranchLabel(env),
    flights,
    agents,
    supabaseTables,
    hasSupabase,
    authorityRole: isOrgAdmin(auth) ? 'admin' : 'member',
  }
}

export function studioBranchLabel(env: Env): string {
  const sha = env.RELEASE_SHA?.trim()
  if (sha) return sha.slice(0, 7)
  return 'main'
}

export async function dispatchStudioFlight(
  env: Env,
  auth: AuthContext,
  input: StudioDispatchInput,
): Promise<{ ok: true; result: StudioDispatchOk } | { ok: false; status: 400 | 409; error: string }> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { ok: false, status: 400, error: 'prompt_required' }

  const repoUrl = typeof input.repoUrl === 'string' ? input.repoUrl.trim() : ''
  if (repoUrl && !isSafeRepoUrl(repoUrl)) {
    return { ok: false, status: 400, error: 'invalid_repo_url' }
  }

  const model = normalizeStudioModel(input.model)
  const home = await resolveStudioHome(env, auth)
  if (!home) return { ok: false, status: 409, error: 'no_squad' }

  const title = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt
  const reservedFlightId = crypto.randomUUID()
  const launchedPrompt = model === 'cursor-cloud' ? injectSevenAxisSeatDeclaration(prompt, reservedFlightId) : prompt
  let cursor: { agent_id: string; run_id: string; agent_url: string } | null = null
  const token = model === 'cursor-cloud' ? resolveCursorApiToken(env) : null
  if (token && repoUrl) {
    try {
      const launched = await createCursorAgent(token, { name: title, repoUrl, prompt: launchedPrompt })
      cursor = {
        agent_id: launched.agent.id,
        run_id: launched.run.id,
        agent_url: launched.agent.url,
      }
    } catch {
      cursor = null
    }
  }

  const body = [
    launchedPrompt,
    '',
    `model: ${model}`,
    repoUrl ? `repo: ${repoUrl}` : null,
    `dispatched_by: ${auth.email || auth.userId}`,
    'source: mupot-studio',
    cursor ? `cursor_agent: ${cursor.agent_id}` : null,
    cursor ? `cursor_run: ${cursor.run_id}` : null,
    cursor ? `cursor_url: ${cursor.agent_url}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n')

  const task = await createTask(
    env,
    {
      squad_id: home.squadId,
      title,
      body,
      done_when: 'Studio canvas shows a reviewable preview and the flight can land.',
      assignee_agent_id: home.agentId === 'studio' ? null : home.agentId,
    },
    { skipEvent: true, skipMirror: true, actor: { kind: 'member', id: auth.memberId ?? auth.userId } },
  )

  const flightId = await createFlight(env, {
    agent: home.agentId,
    dispatched_by: auth.boundAgentId ?? home.agentId,
    goal: prompt,
    trigger_source: 'api',
    meta: {
      schema: 'mupot.flight.meta/v1',
      goal_id: `studio:${task.id}`,
      objective_id: 'studio-canvas',
      squad_ids: [home.squadId],
      task_ids: [task.id],
      done_when: ['Studio canvas shows a reviewable preview and the flight can land.'],
      artifact_refs: [
        ...(repoUrl ? [repoUrl] : []),
        ...(cursor ? [cursor.agent_url] : []),
      ],
      receipt_refs: [],
      confidentiality: 'internal',
      publication_target: 'none',
      parent_flight_id: null,
    },
  }, { id: reservedFlightId })

  return {
    ok: true,
    result: {
      ok: true,
      flight_id: flightId,
      task_id: task.id,
      model,
      agent_id: cursor?.agent_id ?? null,
      run_id: cursor?.run_id ?? null,
      agent_url: cursor?.agent_url ?? null,
      cursor_launched: cursor !== null,
    },
  }
}

export function studioPageHtml(data: StudioViewData): HtmlEscapedString | Promise<HtmlEscapedString> {
  const flights = data.flights.length
    ? data.flights.map((flight) => {
        const label = flight.goal.length > 72 ? `${flight.goal.slice(0, 69)}…` : flight.goal
        return html`
          <li class="studio-flight">
            <span class="studio-flight-status" data-status="${flight.status}">${flight.status}</span>
            <span class="studio-flight-goal">${label}</span>
            <span class="studio-flight-id">${shortId(flight.id)}</span>
          </li>`
      })
    : [html`<li class="studio-empty">No flights yet. Dispatch a prompt to open the first one.</li>`]

  const authorityRole: StudioChatRole = data.authorityRole === 'admin' ? 'admin' : 'member'
  const authorityLabel = authorityRole === 'admin' ? '[ 🛡️ Admin Authority ]' : '[ 👤 Member / Guest ]'
  const authorityClass = authorityRole === 'admin' ? 'studio-authority-admin' : 'studio-authority-member'

  return html`<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Studio · ${data.brand}</title>
    <link rel="icon" type="image/png" href="${raw(`data:image/png;base64,${MUPOT_FAVICON_32_PNG_B64}`)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>${raw(STUDIO_CSS)}</style>
  </head>
  <body class="studio-body">
    <a class="skip-link" href="#studio-prompt">Skip to prompt</a>
    <div class="studio" id="mupot-studio" data-tenant="${data.tenant}" data-studio-role="${authorityRole}">
      <header class="studio-top">
        <a class="studio-brand" href="/" aria-label="Back to dashboard">
          <img src="${raw(`data:image/png;base64,${MUPOT_MARK_64_PNG_B64}`)}" alt="" width="28" height="28" />
          <span>
            <strong>${data.brand} Studio</strong>
            <em>Interactive sovereign canvas</em>
          </span>
        </a>
        ${data.tier ? html`<span class="studio-tier-badge">⚡ ${data.tier.toUpperCase()} TIER</span>` : ''}
        <p class="studio-operator">Signed in as <b>${data.operator}</b></p>
        <span id="studio-authority-badge" class="studio-authority ${authorityClass}" data-studio-role="${authorityRole}">${authorityLabel}</span>
        <nav class="studio-top-links" aria-label="Studio shortcuts">
          <a href="/flights">Flights</a>
          <a href="/send">Work</a>
          <a href="/radar">Mission Control</a>
        </nav>
      </header>

      <div class="studio-split" role="group" aria-label="Studio split-pane canvas">
        <section class="studio-pane studio-pane-left" aria-label="Directive and dispatch">
          <div class="studio-card">
            <label class="studio-label" for="studio-prompt">Prompt directive</label>
            <textarea
              id="studio-prompt"
              class="studio-prompt"
              name="prompt"
              rows="6"
              maxlength="8000"
              required
              placeholder="Describe the surface to design, the agent to fly, and what done looks like…"
            ></textarea>
          </div>

          <div class="studio-card studio-row">
            <div>
              <label class="studio-label" for="studio-model">Model</label>
              <select id="studio-model" class="studio-model" name="model" aria-label="Model selector">
                <option value="cursor-cloud" selected>Cursor Cloud</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div>
              <label class="studio-label" for="studio-repo">Repo URL</label>
              <input id="studio-repo" class="studio-repo" type="url" name="repoUrl" placeholder="https://github.com/org/repo" value="${data.repoUrl ?? ''}" />
            </div>
          </div>

          <div class="studio-dispatch-bar">
            <button type="button" class="studio-dispatch" id="studio-dispatch">Dispatch flight</button>
            <p class="studio-dispatch-status" id="studio-dispatch-status" role="status" aria-live="polite"></p>
          </div>

          ${data.agents && data.agents.length ? html`
          <section class="studio-card studio-agent-radar" aria-labelledby="studio-radar-heading">
            <header class="studio-radar-header">
              <h2 id="studio-radar-heading">Active Workforce Radar</h2>
              <span class="studio-agent-count">${data.agents.length} Agents</span>
            </header>
            <div class="studio-agent-grid">
              ${data.agents.map((agent) => html`
                <div class="studio-agent-card ${agent.isLive ? 'is-live' : 'is-idle'}">
                  <div class="studio-agent-top">
                    <span class="studio-agent-dot" title="${agent.isLive ? 'Active 7-Axis Presence' : 'Standby'}"></span>
                    <strong class="studio-agent-name">${agent.name}</strong>
                    <span class="studio-agent-role ${agent.role === 'lead' ? 'is-lead' : 'is-member'}">${agent.role.toUpperCase()}</span>
                  </div>
                  <div class="studio-agent-details">
                    <span class="studio-agent-chip studio-chip-model">${agent.model || 'claude-3-7-sonnet'}</span>
                    <span class="studio-agent-chip studio-chip-seat">${agent.activeSeat || agent.slug}</span>
                    ${agent.harness ? html`<span class="studio-agent-chip studio-chip-harness">${agent.harness}</span>` : ''}
                  </div>
                </div>
              `)}
            </div>
          </section>` : ''}

          <section class="studio-card studio-copilot is-always-on" id="studio-copilot" data-always-on="true" aria-labelledby="studio-chat-heading">
            <header class="studio-copilot-head">
              <h2 id="studio-chat-heading">Agent chat history</h2>
              <span class="studio-authority ${authorityClass}" data-studio-role="${authorityRole}">${authorityLabel}</span>
            </header>
            <ol class="studio-chat" id="studio-chat" aria-live="polite">
              <li class="studio-msg studio-msg-system">
                <span class="studio-msg-who">Co-Pilot</span>
                <p>Always on. Ask me about this pot, or negotiate a flight. Athena and Kasra still hold the land gate.</p>
              </li>
            </ol>
            <div id="studio-launch-wrap" class="studio-launch-wrap" hidden>
              <button type="button" class="studio-launch-cloud-build" id="studio-launch-cloud-build">Launch Cloud Build</button>
            </div>
            <form id="studio-chat-form" class="studio-chat-composer">
              <label class="studio-label" for="studio-chat-input">Message the Co-Pilot</label>
              <textarea id="studio-chat-input" class="studio-chat-input" rows="3" maxlength="4000" placeholder="Ask the Co-Pilot…"></textarea>
              <button type="submit" class="studio-chat-send" id="studio-chat-send">Send</button>
            </form>
          </section>

          <section class="studio-card" aria-labelledby="studio-flights-heading">
            <h2 id="studio-flights-heading">Recent flights</h2>
            <ol class="studio-flights" id="studio-flights">${flights}</ol>
          </section>
        </section>

        <section class="studio-pane studio-pane-right" aria-label="Preview canvas">
          <div class="studio-canvas-toolbar" role="tablist" aria-label="Canvas tabs">
            <button type="button" class="studio-tab is-active" role="tab" aria-selected="true" data-tab="preview" id="tab-preview">Preview</button>
            <button type="button" class="studio-tab" role="tab" aria-selected="false" data-tab="database" id="tab-database">Data Tables ${data.supabaseTables && data.supabaseTables.length ? `(${data.supabaseTables.length})` : ''}</button>
            <button type="button" class="studio-tab" role="tab" aria-selected="false" data-tab="log" id="tab-log">Live log</button>
            <button type="button" class="studio-tab" role="tab" aria-selected="false" data-tab="diff" id="tab-diff">Diff viewer</button>
            <div class="studio-viewports" role="group" aria-label="Responsive viewport toggles">
              <button type="button" class="studio-viewport is-active" data-viewport="desktop" aria-pressed="true">Desktop</button>
              <button type="button" class="studio-viewport" data-viewport="tablet" aria-pressed="false">Tablet</button>
              <button type="button" class="studio-viewport" data-viewport="mobile" aria-pressed="false">Mobile</button>
            </div>
          </div>

          <div class="studio-stage" id="studio-stage" data-tab="preview">
            <div class="studio-canvas-frame" id="studio-canvas-frame" data-viewport="desktop">
              <div class="studio-canvas" id="studio-canvas" aria-label="Interactive Preview Canvas">
                <div class="studio-preview-hero">
                  <p class="studio-kicker">Preview canvas</p>
                  <h1>Design in the pot, land through the council.</h1>
                  <p>Desktop, tablet, and mobile frames share one live stage. Dispatch a flight to stream the agent log and open the diff.</p>
                </div>
              </div>
            </div>

            <div class="studio-database-view" id="studio-database-view" aria-label="Supabase Database Live Inspector">
              <div class="studio-db-toolbar">
                <div class="studio-db-left">
                  <label class="studio-label" for="studio-db-select">Table</label>
                  <select id="studio-db-select" class="studio-db-select">
                    ${data.supabaseTables && data.supabaseTables.length
                      ? data.supabaseTables.map((t) => html`<option value="${t.name}">${t.name} (${t.columnCount} cols)</option>`)
                      : html`<option value="">${data.hasSupabase ? 'No tables found' : 'No Supabase connector active'}</option>`}
                  </select>
                </div>
                <div class="studio-db-search-wrap">
                  <label class="studio-label" for="studio-db-search">Filter / Search</label>
                  <input type="text" id="studio-db-search" class="studio-db-search" placeholder="Search rows in active table…" />
                </div>
                <button type="button" class="studio-db-ask-agent" id="studio-db-ask-agent">✨ Ask Agent About Table</button>
              </div>
              <div class="studio-db-grid-wrap" id="studio-db-grid-wrap">
                <table class="studio-db-table" id="studio-db-table">
                  <thead id="studio-db-thead">
                    <tr><th>id</th><th>status</th><th>data</th><th>created_at</th></tr>
                  </thead>
                  <tbody id="studio-db-tbody">
                    <tr><td colspan="4" class="studio-db-empty">Select a table above or click Ask Agent to inspect live Supabase records.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <pre class="studio-log" id="studio-log" aria-label="Live agent execution log stream">[studio] waiting for dispatch…</pre>
            <pre class="studio-diff" id="studio-diff" aria-label="Diff viewer">// no diff yet — dispatch a flight to populate this tab</pre>
          </div>
        </section>
      </div>

      <footer class="studio-bar" aria-label="Studio action bar">
        <div class="studio-gate" aria-label="Synthetic Council Gate status">
          <span class="studio-gate-label">Synthetic Council Gate</span>
          <span class="studio-badge studio-badge-athena" title="Athena adversarial review">Athena review</span>
          <span class="studio-badge studio-badge-kasra" title="Kasra merge gate">Kasra review</span>
        </div>
        <p class="studio-branch">
          <span>Git branch</span>
          <code id="studio-branch">${data.branch}</code>
        </p>
        <button type="button" class="studio-land" id="studio-land" disabled>Land / Deploy</button>
      </footer>
    </div>
    <script>${raw(STUDIO_SCRIPT)}</script>
  </body>
</html>`
}

const STUDIO_CSS = `
  :root {
    --studio-bg: #0a0a0c;
    --studio-panel: #101014;
    --studio-raised: #16161c;
    --studio-line: rgba(255,255,255,.08);
    --studio-text: #f4f1ea;
    --studio-muted: #9aa3b2;
    --studio-gold: #d4a017;
    --studio-cyan: #22d3ee;
    --studio-magenta: #e879f9;
    --studio-ok: #3dd68c;
    --font-display: 'Instrument Serif', Georgia, serif;
    --font-body: 'Hanken Grotesk', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--studio-bg); color: var(--studio-text); }
  body.studio-body {
    font-family: var(--font-body);
    -webkit-font-smoothing: antialiased;
  }
  :focus-visible { outline: 2px solid var(--studio-cyan); outline-offset: 2px; }
  .skip-link {
    position: absolute; left: 12px; top: -40px; z-index: 20;
    background: var(--studio-cyan); color: #041016; padding: 8px 12px; border-radius: 8px;
  }
  .skip-link:focus { top: 12px; }
  .studio {
    min-height: 100vh; display: grid;
    grid-template-rows: auto 1fr auto;
    background:
      radial-gradient(1200px 500px at 10% -10%, rgba(232,121,249,.12), transparent 50%),
      radial-gradient(900px 400px at 90% 0%, rgba(34,211,238,.10), transparent 46%),
      var(--studio-bg);
  }
  .studio-top {
    display: flex; align-items: center; gap: 18px;
    padding: 14px 20px; border-bottom: 1px solid var(--studio-line);
  }
  .studio-brand { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
  .studio-brand img { border-radius: 8px; }
  .studio-brand strong { display: block; font-size: 15px; }
  .studio-brand em { display: block; font-style: normal; color: var(--studio-muted); font-size: 12px; }
  .studio-operator { margin: 0; color: var(--studio-muted); font-size: 13px; }
  .studio-authority {
    display: inline-flex; align-items: center; gap: 6px;
    border-radius: 999px; padding: 4px 10px; font: 700 11px var(--font-mono);
    letter-spacing: .02em; white-space: nowrap;
  }
  .studio-authority-admin { color: var(--studio-ok); background: rgba(61,214,140,.12); border: 1px solid rgba(61,214,140,.35); }
  .studio-authority-member { color: #7dd3fc; background: rgba(56,189,248,.12); border: 1px solid rgba(56,189,248,.35); }
  .studio-tier-badge {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(34, 197, 94, 0.12); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 999px; padding: 4px 10px; font: 700 11px var(--font-mono); letter-spacing: .04em;
  }
  .studio-agent-radar { border-color: rgba(34, 211, 238, 0.2); }
  .studio-radar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .studio-radar-header h2 { margin: 0; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--studio-muted); }
  .studio-agent-count { font: 600 11px var(--font-mono); color: var(--studio-cyan); }
  .studio-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .studio-agent-card {
    background: var(--studio-raised); border: 1px solid var(--studio-line);
    border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  }
  .studio-agent-card.is-live { border-color: rgba(34, 197, 94, 0.35); background: rgba(34, 197, 94, 0.03); }
  .studio-agent-top { display: flex; align-items: center; gap: 6px; }
  .studio-agent-dot { width: 7px; height: 7px; border-radius: 50%; background: #64748b; }
  .studio-agent-card.is-live .studio-agent-dot { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
  .studio-agent-name { font-size: 12px; font-weight: 600; color: var(--studio-ink); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .studio-agent-role {
    font: 700 9px var(--font-mono); padding: 1px 5px; border-radius: 4px; letter-spacing: .03em;
  }
  .studio-agent-role.is-lead { background: rgba(232, 121, 249, 0.18); color: var(--studio-magenta); }
  .studio-agent-role.is-member { background: rgba(56, 189, 248, 0.15); color: var(--studio-cyan); }
  .studio-agent-details { display: flex; flex-wrap: wrap; gap: 4px; }
  .studio-agent-chip {
    font: 10px var(--font-mono); color: var(--studio-muted); background: rgba(255, 255, 255, 0.04);
    padding: 1px 5px; border-radius: 4px;
  }
  .studio-top-links { margin-left: auto; display: flex; gap: 14px; }
  .studio-top-links a { color: var(--studio-cyan); text-decoration: none; font-size: 13px; }
  .studio-split { display: flex; min-height: 0; }
  .studio-pane { display: flex; flex-direction: column; gap: 12px; padding: 16px; min-width: 0; }
  .studio-pane-left { width: 40%; border-right: 1px solid var(--studio-line); overflow: auto; }
  .studio-pane-right { width: 60%; }
  .studio-card {
    background: var(--studio-panel);
    border: 1px solid var(--studio-line);
    border-radius: 14px;
    padding: 14px;
  }
  .studio-card h2 { margin: 0 0 10px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--studio-muted); }
  .studio-label { display: block; font-size: 12px; color: var(--studio-muted); margin-bottom: 6px; }
  .studio-prompt, .studio-repo, .studio-model {
    width: 100%; background: var(--studio-raised); color: var(--studio-text);
    border: 1px solid var(--studio-line); border-radius: 10px; padding: 10px 12px;
    font: 14px/1.45 var(--font-body);
  }
  .studio-prompt { resize: vertical; min-height: 120px; }
  .studio-row { display: grid; grid-template-columns: 160px 1fr; gap: 12px; }
  .studio-dispatch-bar { display: flex; align-items: center; gap: 12px; }
  .studio-dispatch, .studio-land {
    border: 0; border-radius: 999px; padding: 10px 16px; cursor: pointer;
    font: 600 13px var(--font-body); color: #061014;
    background: linear-gradient(135deg, var(--studio-cyan), #67e8f9);
  }
  .studio-dispatch:hover, .studio-land:hover:not(:disabled) { filter: brightness(1.08); }
  .studio-land:disabled { opacity: .45; cursor: not-allowed; }
  .studio-dispatch-status { margin: 0; color: var(--studio-muted); font-size: 13px; }
  .studio-copilot-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .studio-copilot-head h2 { margin: 0; }
  .studio-chat, .studio-flights { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .studio-chat { max-height: 320px; overflow: auto; }
  .studio-msg, .studio-flight {
    background: var(--studio-raised); border-radius: 10px; padding: 10px 12px;
  }
  .studio-msg-user { border-left: 3px solid var(--studio-cyan); }
  .studio-msg-copilot, .studio-msg-agent { border-left: 3px solid var(--studio-gold); }
  .studio-msg-who { font-size: 11px; color: var(--studio-cyan); font-family: var(--font-mono); }
  .studio-msg-copilot .studio-msg-who { color: var(--studio-gold); }
  .studio-msg p { margin: 4px 0 0; }
  .studio-chat-composer { display: grid; gap: 8px; margin-top: 12px; }
  .studio-chat-input {
    width: 100%; background: var(--studio-raised); color: var(--studio-text);
    border: 1px solid var(--studio-line); border-radius: 10px; padding: 10px 12px;
    font: 14px/1.45 var(--font-body); resize: vertical; min-height: 72px;
  }
  .studio-chat-send, .studio-launch-cloud-build {
    justify-self: start; border: 0; border-radius: 999px; padding: 8px 14px; cursor: pointer;
    font: 600 13px var(--font-body); color: #061014;
    background: linear-gradient(135deg, var(--studio-cyan), #67e8f9);
  }
  .studio-launch-wrap { margin: 10px 0 0; }
  .studio-launch-cloud-build { background: linear-gradient(135deg, var(--studio-gold), #f5d76e); }
  .studio-flight { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 13px; }
  .studio-flight-status {
    font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
    color: var(--studio-gold); border: 1px solid rgba(212,160,23,.35); border-radius: 999px; padding: 2px 7px;
  }
  .studio-flight-id { font-family: var(--font-mono); color: var(--studio-muted); font-size: 11px; }
  .studio-empty { color: var(--studio-muted); font-size: 13px; }
  .studio-canvas-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .studio-tab, .studio-viewport {
    background: transparent; color: var(--studio-muted);
    border: 1px solid var(--studio-line); border-radius: 999px;
    padding: 7px 12px; cursor: pointer; font: 600 12px var(--font-body);
  }
  .studio-tab.is-active, .studio-viewport.is-active {
    color: #061014; background: var(--studio-gold); border-color: var(--studio-gold);
  }
  .studio-viewports { margin-left: auto; display: flex; gap: 6px; }
  .studio-stage { flex: 1; min-height: 0; display: flex; }
  .studio-stage[data-tab="preview"] .studio-log,
  .studio-stage[data-tab="preview"] .studio-diff,
  .studio-stage[data-tab="preview"] .studio-database-view,
  .studio-stage[data-tab="log"] .studio-canvas-frame,
  .studio-stage[data-tab="log"] .studio-diff,
  .studio-stage[data-tab="log"] .studio-database-view,
  .studio-stage[data-tab="diff"] .studio-canvas-frame,
  .studio-stage[data-tab="diff"] .studio-log,
  .studio-stage[data-tab="diff"] .studio-database-view,
  .studio-stage[data-tab="database"] .studio-canvas-frame,
  .studio-stage[data-tab="database"] .studio-log,
  .studio-stage[data-tab="database"] .studio-diff { display: none; }
  .studio-stage[data-tab="database"] .studio-database-view { display: flex; }
  .studio-database-view {
    flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px;
    padding: 14px; background: var(--studio-panel); border: 1px solid var(--studio-line);
    border-radius: 14px; margin-top: 8px;
  }
  .studio-db-toolbar { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .studio-db-left { min-width: 180px; }
  .studio-db-select, .studio-db-search {
    background: var(--studio-raised); color: var(--studio-text); border: 1px solid var(--studio-line);
    border-radius: 8px; padding: 8px 10px; font: 13px var(--font-body); width: 100%;
  }
  .studio-db-search-wrap { flex: 1; min-width: 200px; }
  .studio-db-ask-agent {
    background: linear-gradient(135deg, var(--studio-magenta), #c084fc); color: #0a0a0c;
    border: 0; border-radius: 999px; padding: 8px 14px; font: 700 12px var(--font-body);
    cursor: pointer; height: 36px;
  }
  .studio-db-grid-wrap {
    flex: 1; overflow: auto; background: #070709; border: 1px solid var(--studio-line);
    border-radius: 10px;
  }
  .studio-db-table {
    width: 100%; border-collapse: collapse; font: 12px/1.5 var(--font-mono); color: #d7fbe8;
  }
  .studio-db-table th {
    background: #111116; color: var(--studio-cyan); text-align: left; padding: 8px 12px;
    border-bottom: 1px solid var(--studio-line); position: sticky; top: 0; z-index: 2;
  }
  .studio-db-table td {
    padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.04); max-width: 320px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .studio-db-empty { text-align: center; color: var(--studio-muted); padding: 32px !important; }
  .studio-canvas-frame {
    flex: 1; display: flex; justify-content: center; align-items: stretch;
    padding: 8px 0 0;
  }
  .studio-canvas {
    width: 100%; background: var(--studio-panel);
    border: 1px solid var(--studio-line); border-radius: 18px;
    overflow: hidden; transition: width .2s ease;
    box-shadow: 0 0 0 1px rgba(34,211,238,.08), 0 30px 80px rgba(0,0,0,.35);
  }
  .studio-canvas-frame[data-viewport="tablet"] .studio-canvas { width: min(768px, 100%); }
  .studio-canvas-frame[data-viewport="mobile"] .studio-canvas { width: min(390px, 100%); }
  .studio-preview-hero { padding: 48px 36px; }
  .studio-kicker { color: var(--studio-magenta); font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
  .studio-preview-hero h1 { font-family: var(--font-display); font-weight: 400; font-size: clamp(32px, 4vw, 52px); line-height: 1.05; margin: 8px 0 14px; }
  .studio-preview-hero p { color: var(--studio-muted); max-width: 36em; }
  .studio-log, .studio-diff {
    flex: 1; margin: 8px 0 0; padding: 16px;
    background: #070709; border: 1px solid var(--studio-line); border-radius: 14px;
    color: #d7fbe8; font: 12px/1.55 var(--font-mono); overflow: auto; white-space: pre-wrap;
  }
  .studio-bar {
    display: flex; align-items: center; gap: 16px;
    padding: 12px 20px; border-top: 1px solid var(--studio-line);
    background: rgba(10,10,12,.92); backdrop-filter: blur(12px);
  }
  .studio-gate { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .studio-gate-label { font-size: 12px; color: var(--studio-muted); }
  .studio-badge {
    border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700;
  }
  .studio-badge-athena { background: rgba(232,121,249,.16); color: var(--studio-magenta); }
  .studio-badge-kasra { background: rgba(212,160,23,.16); color: var(--studio-gold); }
  .studio-branch { margin: 0 auto 0 0; font-size: 12px; color: var(--studio-muted); }
  .studio-branch code { color: var(--studio-cyan); font-family: var(--font-mono); }
  @media (max-width: 960px) {
    .studio-split { flex-direction: column; }
    .studio-pane-left, .studio-pane-right { width: 100%; }
    .studio-row { grid-template-columns: 1fr; }
    .studio-viewports { margin-left: 0; }
  }
`

const STUDIO_SCRIPT = `
(function () {
  var promptEl = document.getElementById('studio-prompt');
  var modelEl = document.getElementById('studio-model');
  var repoEl = document.getElementById('studio-repo');
  var dispatchBtn = document.getElementById('studio-dispatch');
  var statusEl = document.getElementById('studio-dispatch-status');
  var chatEl = document.getElementById('studio-chat');
  var flightsEl = document.getElementById('studio-flights');
  var logEl = document.getElementById('studio-log');
  var diffEl = document.getElementById('studio-diff');
  var stage = document.getElementById('studio-stage');
  var frame = document.getElementById('studio-canvas-frame');
  var canvas = document.getElementById('studio-canvas');
  var landBtn = document.getElementById('studio-land');
  var chatInput = document.getElementById('studio-chat-input');
  var chatForm = document.getElementById('studio-chat-form');
  var chatSend = document.getElementById('studio-chat-send');
  var launchWrap = document.getElementById('studio-launch-wrap');
  var launchBtn = document.getElementById('studio-launch-cloud-build');
  var dbSelect = document.getElementById('studio-db-select');
  var dbThead = document.getElementById('studio-db-thead');
  var dbTbody = document.getElementById('studio-db-tbody');
  var dbAskBtn = document.getElementById('studio-db-ask-agent');
  var lastFlightId = null;
  var chatTurns = [];

  function appendChat(who, text, cls) {
    var li = document.createElement('li');
    li.className = 'studio-msg ' + (cls || '');
    li.innerHTML = '<span class="studio-msg-who"></span><p></p>';
    li.querySelector('.studio-msg-who').textContent = who;
    li.querySelector('p').textContent = text;
    chatEl.appendChild(li);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function appendLog(line) {
    logEl.textContent = (logEl.textContent ? logEl.textContent + '\n' : '') + line;
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setTab(name) {
    document.querySelectorAll('.studio-tab').forEach(function (btn) {
      var on = btn.getAttribute('data-tab') === name;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    stage.setAttribute('data-tab', name);
    if (name === 'database' && dbSelect && dbSelect.value) {
      loadTableData(dbSelect.value);
    }
  }

  async function loadTableData(tableName) {
    if (!tableName || !dbTbody) return;
    dbTbody.innerHTML = '<tr><td colspan="4" class="studio-db-empty">Loading records from ' + tableName + '…</td></tr>';
    try {
      var res = await fetch('/api/studio/database/query?table=' + encodeURIComponent(tableName) + '&limit=50');
      var json = await res.json();
      if (json.ok && json.data && json.data.length > 0) {
        var cols = Object.keys(json.data[0]);
        if (dbThead) {
          dbThead.innerHTML = '<tr>' + cols.map(function(c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
        }
        dbTbody.innerHTML = json.data.map(function(row) {
          return '<tr>' + cols.map(function(c) {
            var val = row[c];
            if (typeof val === 'object' && val !== null) val = JSON.stringify(val);
            return '<td>' + (val !== null && val !== undefined ? String(val) : '') + '</td>';
          }).join('') + '</tr>';
        }).join('');
      } else {
        dbTbody.innerHTML = '<tr><td colspan="4" class="studio-db-empty">No records found in ' + tableName + '.</td></tr>';
      }
    } catch (e) {
      dbTbody.innerHTML = '<tr><td colspan="4" class="studio-db-empty">Query failed. Check Supabase connector status.</td></tr>';
    }
  }

  if (dbSelect) {
    dbSelect.addEventListener('change', function() { loadTableData(dbSelect.value); });
  }
  if (dbAskBtn && dbSelect && promptEl) {
    dbAskBtn.addEventListener('click', function() {
      var t = dbSelect.value;
      if (t) {
        promptEl.value = 'Inspect table "' + t + '" in Supabase: analyze rows, summarize key metrics and anomalies, and prepare next actions.';
        promptEl.focus();
      }
    });
  }

  document.querySelectorAll('.studio-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { setTab(btn.getAttribute('data-tab')); });
  });
  document.querySelectorAll('.studio-viewport').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var viewport = btn.getAttribute('data-viewport');
      frame.setAttribute('data-viewport', viewport);
      document.querySelectorAll('.studio-viewport').forEach(function (other) {
        var on = other === btn;
        other.classList.toggle('is-active', on);
        other.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      appendLog('[studio] viewport → ' + viewport);
    });
  });

  dispatchBtn.addEventListener('click', async function () {
    var prompt = (promptEl.value || '').trim();
    if (!prompt) { statusEl.textContent = 'Prompt is required.'; return; }
    dispatchBtn.disabled = true;
    statusEl.textContent = 'Dispatching…';
    appendChat('You', prompt, 'studio-msg-user');
    appendLog('[studio] dispatch start · model=' + modelEl.value);
    try {
      var res = await fetch('/api/studio/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ prompt: prompt, repoUrl: repoEl.value || undefined, model: modelEl.value })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        statusEl.textContent = 'Dispatch failed' + (data.error ? ': ' + data.error : ' (' + res.status + ')');
        appendLog('[studio] error ' + (data.error || res.status));
        return;
      }
      lastFlightId = data.flight_id;
      statusEl.textContent = 'Flight ' + data.flight_id + ' created.';
      appendChat('Agent', 'Flight ' + data.flight_id + ' is on the spine. Athena/Kasra still hold land.', 'studio-msg-agent');
      appendLog('[agent] flight_id=' + data.flight_id);
      appendLog('[agent] opening preview + diff surface');
      var empty = flightsEl.querySelector('.studio-empty');
      if (empty) empty.remove();
      var li = document.createElement('li');
      li.className = 'studio-flight';
      li.innerHTML = '<span class="studio-flight-status">preflight</span><span class="studio-flight-goal"></span><span class="studio-flight-id"></span>';
      li.querySelector('.studio-flight-goal').textContent = prompt;
      li.querySelector('.studio-flight-id').textContent = String(data.flight_id).slice(0, 8);
      flightsEl.insertBefore(li, flightsEl.firstChild);
      diffEl.textContent = '--- a/studio\\n+++ b/studio\\n+ flight ' + data.flight_id + '\\n+ prompt: ' + prompt;
      landBtn.disabled = false;
      canvas.querySelector('h1').textContent = prompt;
    } catch (err) {
      statusEl.textContent = 'Dispatch failed — try again.';
      appendLog('[studio] network error');
    } finally {
      dispatchBtn.disabled = false;
    }
  });

  landBtn.addEventListener('click', function () {
    if (!lastFlightId) return;
    appendLog('[council] land requested for ' + lastFlightId + ' — waiting on Athena + Kasra');
    statusEl.textContent = 'Land / Deploy queued for council gate.';
    window.location.href = '/deployment';
  });

  function showLaunchCloudBuild() {
    if (launchWrap) launchWrap.hidden = false;
  }

  function applySseEvent(ev, state) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'token' && ev.text) {
      state.text += ev.text;
      state.bodyEl.textContent = state.text;
    }
    if (ev.type === 'proposal' && ev.action === 'launch_cloud_build') showLaunchCloudBuild();
    if (typeof ev.text === 'string' && ev.text.indexOf('[[studio:launch-cloud-build]]') !== -1) {
      showLaunchCloudBuild();
    }
  }

  async function streamCopilot(message) {
    appendChat('You', message, 'studio-msg-user');
    chatTurns.push({ role: 'user', content: message });
    var li = document.createElement('li');
    li.className = 'studio-msg studio-msg-copilot';
    li.innerHTML = '<span class="studio-msg-who"></span><p></p>';
    li.querySelector('.studio-msg-who').textContent = 'Co-Pilot';
    chatEl.appendChild(li);
    var bodyEl = li.querySelector('p');
    if (chatSend) chatSend.disabled = true;
    try {
      var response = await fetch('/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: message, messages: chatTurns })
      });
      if (!response.body || typeof response.body.getReader !== 'function') {
        bodyEl.textContent = 'Co-Pilot stream unavailable.';
        return;
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var state = { text: '', bodyEl: bodyEl };
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var parts = buf.split('\\n\\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var block = parts[i];
          var dataIdx = block.indexOf('data:');
          if (dataIdx === -1) {
            if (block.trim()) {
              state.text += block;
              bodyEl.textContent = state.text;
            }
            continue;
          }
          var payload = block.slice(dataIdx + 5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            applySseEvent(JSON.parse(payload), state);
          } catch (err) {
            state.text += payload;
            bodyEl.textContent = state.text;
          }
        }
        chatEl.scrollTop = chatEl.scrollHeight;
      }
      if (buf.trim()) {
        var tailIdx = buf.indexOf('data:');
        if (tailIdx !== -1) {
          try { applySseEvent(JSON.parse(buf.slice(tailIdx + 5).trim()), state); } catch (err) { /* ignore trailing partial */ }
        }
      }
      state.text = state.text.replace(/\\[\\[studio:launch-cloud-build\\]\\]/g, '').trim();
      bodyEl.textContent = state.text;
      if (/launch cloud build|flight proposal|cursor_dispatch/i.test(state.text)) showLaunchCloudBuild();
      chatTurns.push({ role: 'assistant', content: state.text });
    } catch (err) {
      bodyEl.textContent = 'Co-Pilot is offline. Try again.';
    } finally {
      if (chatSend) chatSend.disabled = false;
    }
  }

  if (chatForm) {
    chatForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msg = ((chatInput && chatInput.value) || '').trim();
      if (!msg) return;
      if (chatInput) chatInput.value = '';
      streamCopilot(msg);
    });
  }
  if (launchBtn) {
    launchBtn.addEventListener('click', function () {
      if (promptEl && !promptEl.value.trim() && chatTurns.length) {
        var lastUser = null;
        for (var i = chatTurns.length - 1; i >= 0; i--) {
          if (chatTurns[i].role === 'user') { lastUser = chatTurns[i].content; break; }
        }
        if (lastUser) promptEl.value = lastUser;
      }
      dispatchBtn.click();
    });
  }
})();
`

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function isSafeRepoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

async function resolveStudioHome(
  env: Env,
  auth: AuthContext,
): Promise<{ agentId: string; squadId: string } | null> {
  if (auth.boundAgentId) {
    const bound = await env.DB.prepare(
      `SELECT id, squad_id FROM agents WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
      .bind(auth.boundAgentId)
      .first<{ id: string; squad_id: string }>()
    if (bound) return { agentId: bound.id, squadId: bound.squad_id }
  }

  const agent = await env.DB.prepare(
    `SELECT id, squad_id FROM agents WHERE status = 'active' ORDER BY name LIMIT 1`,
  ).first<{ id: string; squad_id: string }>()
  if (agent) return { agentId: agent.id, squadId: agent.squad_id }

  const squad = await env.DB.prepare(`SELECT id FROM squads ORDER BY name LIMIT 1`).first<{ id: string }>()
  if (squad) return { agentId: 'studio', squadId: squad.id }
  return null
}

function sessionAuth(c: { get: (key: 'auth') => AuthContext | undefined }): AuthContext | null {
  try {
    return c.get('auth') ?? null
  } catch {
    return null
  }
}

async function resolveStudioApiAuth(c: {
  env: Env
  req: { header: (name: string) => string | undefined }
  get: (key: 'auth') => AuthContext | undefined
}): Promise<{ ok: true; auth: AuthContext } | { ok: false; status: 401 | 403; error: string }> {
  const existing = sessionAuth(c)
  if (existing) {
    if (isOrgAdmin(existing) || holdsCapabilityFloor(existing, 'member') || existing.role === 'admin' || existing.role === 'owner') {
      return { ok: true, auth: existing }
    }
    return { ok: false, status: 403, error: 'forbidden' }
  }

  const identity = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!identity) return { ok: false, status: 401, error: 'unauthorized' }
  const capabilities = await resolveCapabilities(c.env, identity.memberId)
  const auth: AuthContext = {
    userId: identity.memberId,
    email: identity.email,
    role: 'member',
    tenant: c.env.TENANT_SLUG,
    memberId: identity.memberId,
    channel: 'workspace',
    capabilities,
    boundAgentId: identity.boundAgentId,
    tokenId: identity.tokenId,
  }
  if (!isOrgAdmin(auth) && !holdsCapabilityFloor(auth, 'member')) {
    return { ok: false, status: 403, error: 'forbidden' }
  }
  return { ok: true, auth }
}

export const studioApp = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()

studioApp.post('/chat', async (c) => {
  let auth = c.get('auth')
  if (!auth) {
    try {
      auth = getAuthContext(c as Context<AppEnv>)
    } catch {
      auth = (await peekSessionAuth(c as any)) ?? undefined
    }
  }
  const parsed = await readStudioChatPayload(c.req.raw)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  return streamStudioChat(
    c.env,
    auth ?? ({ userId: 'guest', role: 'member', tenant: c.env.TENANT_SLUG || 'mumega' } as AuthContext),
    parsed.value,
  )
})

studioApp.post('/dispatch', async (c) => {
  const resolved = await resolveStudioApiAuth(c)
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status)

  let body: Record<string, unknown>
  try {
    body = await c.req.json() as Record<string, unknown>
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const prompt = typeof body.prompt === 'string'
    ? body.prompt
    : typeof body.name === 'string'
      ? body.name
      : ''
  const repoUrl = typeof body.repoUrl === 'string'
    ? body.repoUrl
    : typeof body.repo_url === 'string'
      ? body.repo_url
      : undefined
  const model = typeof body.model === 'string' ? body.model : undefined

  const result = await dispatchStudioFlight(c.env, resolved.auth, { prompt, repoUrl, model })
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status)
  return c.json(result.result)
})
