// mupot — BYOA customer onboarding dashboard (add agent → pick harness → pack + token).
//
// Routes live in src/dashboard/index.ts. This module is PURE HTML + view helpers
// (no DB writes). The route handler calls createAgent / mintAgentBoundToken /
// registerAgentPublicKey — the same services MCP provision tools use.

import { html, raw as honoRaw } from 'hono/html'
import type { ByoaHarness } from '../byoa/catalog'
import { listShippableHarnesses } from '../byoa/catalog'
import type { SquadOption } from './agents-admin'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface ByoaOnboardView {
  squads: SquadOption[]
  harnesses: ByoaHarness[]
}

export function loadByoaOnboardView(squads: SquadOption[]): ByoaOnboardView {
  return { squads, harnesses: listShippableHarnesses() }
}

/** GET /agents/onboard — create agent + pick harness form. */
export function byoaOnboardPageBody(view: ByoaOnboardView, error?: string) {
  const { squads, harnesses } = view
  const squadOptions =
    squads.length === 0
      ? `<option value="">— create a squad first —</option>`
      : squads
          .map((s) => {
            const label = s.dept_name ? `${s.dept_name} / ${s.name}` : s.name
            return `<option value="${esc(s.id)}">${esc(label)}</option>`
          })
          .join('')

  const harnessOptions = harnesses
    .map(
      (h) =>
        `<option value="${esc(h.id)}" data-topology="${esc(h.topology)}" data-credential="${esc(h.credential)}">` +
        `${esc(h.label)} · topology ${esc(h.topology)}` +
        `</option>`,
    )
    .join('')

  const harnessHelp = harnesses
    .map(
      (h) =>
        `<li><strong>${esc(h.id)}</strong> (${esc(h.topology)}): ${esc(h.summary)}</li>`,
    )
    .join('')

  const errorHtml = error
    ? `<div class="warn-box"><strong>Error:</strong> ${esc(error)}</div>`
    : ''

  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/agents">Agents</a> › Bring your own agent</div>
<h1>Bring your own agent</h1>
<p style="color:var(--muted);font-size:14px;max-width:680px;margin-bottom:20px">
  Customer entry for BYOA: <strong>create agent → mint token / register key → least-privilege grant → download the harness pack</strong>.
  Codex Cloud is omitted (no public API). Claude Desktop is docs-only
  (<code class="inline">docs/byoa-claude-desktop.md</code>).
</p>

${honoRaw(errorHtml)}

<div class="card">
  <form method="post" action="/agents/onboard" autocomplete="off" id="byoa-onboard-form">
    <div class="adminform" style="flex-direction:column;align-items:stretch;gap:12px">
      <label>Name
        <input name="name" required placeholder="Dispatcher" maxlength="80" />
      </label>
      <label>Slug
        <input name="slug" required placeholder="dispatcher" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="48" />
      </label>
      <label>Squad
        <select name="squad_id" required>
          <option value="">— choose a squad —</option>
          ${honoRaw(squadOptions)}
        </select>
      </label>
      <label>Harness
        <select name="harness" required id="byoa-harness">
          <option value="">— pick a runtime —</option>
          ${honoRaw(harnessOptions)}
        </select>
      </label>
      <label>Squad grant (least privilege)
        <select name="capability">
          <option value="member">Member — write squad tasks / memory</option>
          <option value="observer">Observer — read-only on the squad</option>
        </select>
      </label>
      <label id="byoa-pubkey-wrap" style="display:none">
        Ed25519 public key <span style="font-size:12px;color:var(--muted)">(topology C — JWK <code class="inline">x</code>; optional now, or register later via MCP)</span>
        <input name="public_key" placeholder="base64url 32-byte x" maxlength="64" style="min-width:280px" />
      </label>
      <label>Token label <span style="font-size:12px;color:var(--muted)">(optional)</span>
        <input name="label" placeholder="byoa-main" maxlength="64" />
      </label>
      <div style="margin-top:8px">
        <button class="btn" type="submit" data-byoa-submit>Create agent + mint + pack</button>
        <a href="/agents" class="btn secondary sm" style="margin-left:10px">Cancel</a>
      </div>
    </div>
  </form>
</div>

<div class="card" style="margin-top:20px;padding:14px 18px">
  <h2 style="margin-top:0;font-size:15px">Supported harnesses</h2>
  <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.55">
    ${honoRaw(harnessHelp)}
  </ul>
  <p style="margin:12px 0 0;font-size:13px;color:var(--muted)">
    MCP mirror: <code class="inline">create_agent</code> →
    <code class="inline">mint_agent_token</code> /
    <code class="inline">register_agent_key</code> →
    <code class="inline">grant_agent_capability</code> →
    <code class="inline">get_harness_pack</code>.
  </p>
</div>
<script>
  (function () {
    var sel = document.getElementById('byoa-harness');
    var wrap = document.getElementById('byoa-pubkey-wrap');
    if (!sel || !wrap) return;
    function sync() {
      var opt = sel.options[sel.selectedIndex];
      var cred = opt && opt.getAttribute('data-credential');
      wrap.style.display = cred === 'ed25519_key' ? 'block' : 'none';
    }
    sel.addEventListener('change', sync);
    sync();
  })();
</script>`
}

export interface ByoaOnboardSuccess {
  agentName: string
  agentSlug: string
  agentId: string
  squadName: string | null
  harness: ByoaHarness
  rawToken: string
  tokenId: string
  capability: string
  keyStatus: string | null
  mcpEndpoint: string
}

/** Show-once success: token + pack files. */
export function byoaOnboardSuccessBody(s: ByoaOnboardSuccess) {
  const packFiles = s.harness.files
    .map((f) => {
      const id = `pack-${f.path.replace(/[^a-z0-9]+/gi, '-')}`
      return (
        `<div style="margin-top:14px">` +
        `<div style="font-size:13px;margin-bottom:6px"><strong>${esc(f.path)}</strong></div>` +
        `<pre class="token" id="${esc(id)}" style="white-space:pre-wrap;font-size:12px;max-height:220px;overflow:auto">${esc(f.content)}</pre>` +
        `</div>`
      )
    })
    .join('')

  const keyNote = s.keyStatus
    ? `<p style="font-size:13px;color:var(--muted)">Ed25519 key: <code class="inline">${esc(s.keyStatus)}</code></p>`
    : s.harness.credential === 'ed25519_key'
      ? `<p style="font-size:13px;color:var(--warn)">Topology C: generate a host key next and call <code class="inline">register_agent_key</code> with the public <code class="inline">x</code>.</p>`
      : ''

  return html`
<div class="crumbs"><a href="/">Overview</a> › <a href="/agents">Agents</a> › <a href="/agents/onboard">Bring your own agent</a> › Ready</div>
<h1>Agent ready · ${esc(s.harness.label)}</h1>
<div class="card" data-byoa-success data-harness="${esc(s.harness.id)}">
  <p style="font-size:14px;color:var(--muted);margin:0 0 12px">
    <strong>${esc(s.agentName)}</strong> (<code class="inline">${esc(s.agentSlug)}</code> ·
    <code class="inline">${esc(s.agentId)}</code>)
    ${s.squadName ? html` · squad ${esc(s.squadName)}` : html``}
    · grant <code class="inline">${esc(s.capability)}</code>
    · topology ${esc(s.harness.topology)}
  </p>
  <p style="font-size:13px;margin:0 0 12px">
    Flow complete: create_agent → mint_agent_token
    ${s.keyStatus ? html` → register_agent_key` : html``}
    → least-privilege grant → install pack <code class="inline">packs/${esc(s.harness.packDir)}/</code>.
  </p>
  ${honoRaw(keyNote)}
  <div class="warn-box" style="margin-bottom:14px">
    <strong>Token shown once.</strong> Copy now — it cannot be retrieved again.
    MCP endpoint: <code class="inline">${esc(s.mcpEndpoint)}</code>
  </div>
  <code class="token" id="rawToken">${esc(s.rawToken)}</code>
  <div style="margin-top:10px">
    <button class="btn secondary sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('rawToken').textContent.trim())">Copy token</button>
    <a class="btn secondary sm" href="/agents/onboard/packs/${esc(s.harness.id)}" style="margin-left:8px">Download pack JSON</a>
    <a class="btn secondary sm" href="/agents" style="margin-left:8px">Done</a>
  </div>
  <h2 style="margin-top:24px;font-size:15px">Install pack</h2>
  ${honoRaw(packFiles)}
</div>`
}
