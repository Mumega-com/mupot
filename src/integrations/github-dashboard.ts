// mupot — GitHub status card (A4). Renders the capability snapshot + connection state as
// an HTML page for the operator: is GitHub connected, what tier, kill-switch state, and which
// features are live. Pure presentation; reads only the snapshot + install presence (no secrets).

import { html, raw } from 'hono/html'
import type { GitHubTier, GitHubFeature } from './github-capabilities'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface GitHubStatusView {
  tier: GitHubTier
  enterpriseEnabled: boolean
  features: Array<{ feature: GitHubFeature; label: string; enterprise: boolean; minTier: GitHubTier; enabled: boolean }>
  connected: boolean
  installationId: string | null
}

/** GET /admin/github — the GitHub connection + capability card. */
export function githubStatusBody(view: GitHubStatusView) {
  const connectionCard = view.connected
    ? `<div class="card" style="border-left:3px solid #2ea043">
         <strong>✓ Connected</strong>
         <p style="color:var(--muted);font-size:14px;margin:6px 0 0">
           Installation <code>${esc(view.installationId ?? '—')}</code> · plan tier
           <span class="tag">${esc(view.tier)}</span>
         </p>
         <div style="margin-top:12px;display:flex;gap:8px">
           <a class="btn sm secondary" href="/admin/github/connect">Reconnect / change install</a>
         </div>
       </div>`
    : `<div class="card" style="border-left:3px solid #d29922">
         <strong>Not connected</strong>
         <p style="color:var(--muted);font-size:14px;margin:6px 0 0">
           Install the mupot GitHub App on your org so this pot can act on GitHub under its own
           scoped identity — mirror tasks to issues, author agent definitions, assign Copilot.
         </p>
         <div style="margin-top:12px">
           <a class="btn" href="/admin/github/connect">Connect GitHub</a>
         </div>
       </div>`

  const featureRows = view.features
    .map((f) => {
      const status = f.enabled
        ? `<span style="color:#2ea043">● enabled</span>`
        : `<span style="color:var(--muted)">○ off</span>`
      const ent = f.enterprise ? `<span class="tag">Enterprise</span>` : ''
      return (
        `<tr>` +
        `<td>${esc(f.label)} ${ent}</td>` +
        `<td class="muted">${esc(f.minTier)}+</td>` +
        `<td>${status}</td>` +
        `</tr>`
      )
    })
    .join('')

  const killNote = view.enterpriseEnabled
    ? `Enterprise features are <strong>ON</strong> (<code>GITHUB_ENTERPRISE_FEATURES</code>).`
    : `Enterprise features are <strong>off</strong> — set <code>GITHUB_ENTERPRISE_FEATURES=on</code> to enable (and they still require an Enterprise plan).`

  return html`
<div class="crumbs"><a href="/">Overview</a> › GitHub</div>
<h1>GitHub</h1>
<p style="color:var(--muted);font-size:14px;max-width:640px">
  The pot's GitHub presence. Connecting installs the mupot App on your org and lets the pot mint
  its own short-lived, scoped tokens — nothing long-lived is stored. Features unlock by your plan
  tier; Enterprise-only features are additionally behind a kill switch.
</p>

${raw(connectionCard)}

<h2>Capabilities</h2>
<p style="color:var(--muted);font-size:13px">${raw(killNote)}</p>
<div class="card">
  <table style="width:100%;border-collapse:collapse">
    <thead><tr><th style="text-align:left">Feature</th><th style="text-align:left">Min tier</th><th style="text-align:left">Status</th></tr></thead>
    <tbody>${raw(featureRows)}</tbody>
  </table>
</div>

<h2>Project intake</h2>
<div class="card">
  <p style="color:var(--muted);font-size:14px;margin:0 0 12px">
    Import items assigned to a Mupot agent from a GitHub Project. The import is idempotent; preview it first when changing a board mapping.
  </p>
  <form method="post" action="/admin/github/import-project" onsubmit="return ghImportProject(event)">
    <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <label>Organization
        <input type="text" name="owner" id="ghProjectOwner" value="Mumega-com" required
          style="font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </label>
      <label>Project number
        <input type="number" name="projectNumber" id="ghProjectNumber" min="1" required
          style="width:92px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </label>
      <label>Agent field
        <input type="text" name="agentField" id="ghProjectAgentField" value="Agent" required
          style="width:110px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </label>
      <button class="btn sm secondary" type="button" onclick="ghImportProject(null, true)">Preview</button>
      <button class="btn sm" type="submit">Import assigned items</button>
    </div>
  </form>
  <pre id="ghProjectOut" style="margin-top:12px;font-size:12px;color:var(--muted);white-space:pre-wrap"></pre>
</div>

<h2>Task pull request</h2>
<div class="card">
  <p style="color:var(--muted);font-size:14px;margin:0 0 12px">
    Publish one reviewed task result through the installed GitHub App. Mupot links the resulting pull request back to the task.
  </p>
  <form method="post" action="/admin/github/execute-task" onsubmit="return ghExecuteTask(event)">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px">
      <label>Task ID<input type="text" id="ghTaskId" required style="width:100%;box-sizing:border-box;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
      <label>Repository<input type="text" id="ghTaskRepo" placeholder="owner/repo" required style="width:100%;box-sizing:border-box;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
      <label>Branch<input type="text" id="ghTaskBranch" placeholder="mupot/task-evidence" required style="width:100%;box-sizing:border-box;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
      <label>Base branch<input type="text" id="ghTaskBase" value="main" required style="width:100%;box-sizing:border-box;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
      <label>File path<input type="text" id="ghTaskPath" placeholder="docs/evidence.md" required style="width:100%;box-sizing:border-box;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
      <label>Title<input type="text" id="ghTaskTitle" required style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></label>
    </div>
    <label style="display:block;margin-top:8px">Pull request body<textarea id="ghTaskBody" rows="3" style="width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></textarea></label>
    <label style="display:block;margin-top:8px">File content<textarea id="ghTaskContent" rows="10" required style="width:100%;box-sizing:border-box;margin-top:4px;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"></textarea></label>
    <button class="btn sm" type="submit" style="margin-top:8px">Create task pull request</button>
  </form>
  <pre id="ghTaskOut" style="margin-top:12px;font-size:12px;color:var(--muted);white-space:pre-wrap"></pre>
</div>

<h2>Sync the fleet to GitHub</h2>
<div class="card">
  <p style="color:var(--muted);font-size:14px;margin:0 0 12px">
    Write a <code>.github/agents/&lt;agent&gt;.agent.md</code> for every active pot agent into a repo,
    each wired to this pot's MCP endpoint. Dry-run previews without writing.
  </p>
  <form method="post" action="/admin/github/sync-fleet" onsubmit="return ghSyncFleet(event)">
    <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <label>Repo (owner/repo)
        <input type="text" name="repo" id="ghSyncRepo" placeholder="Mumega-com/mumega-com" required
          style="font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">
      </label>
      <button class="btn sm secondary" type="button" onclick="ghSyncFleet(null, true)">Dry-run</button>
      <button class="btn sm" type="submit">Sync</button>
    </div>
  </form>
  <pre id="ghSyncOut" style="margin-top:12px;font-size:12px;color:var(--muted);white-space:pre-wrap"></pre>
</div>

<script>
async function ghSyncFleet(ev, dry) {
  if (ev) ev.preventDefault();
  const repo = document.getElementById('ghSyncRepo').value.trim();
  const out = document.getElementById('ghSyncOut');
  if (!repo) { out.textContent = 'Enter a repo first.'; return false; }
  out.textContent = dry ? 'Dry-run…' : 'Syncing…';
  try {
    const res = await fetch('/admin/github/sync-fleet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, dryRun: !!dry }),
    });
    out.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (e) { out.textContent = 'Error: ' + e; }
  return false;
}

async function ghImportProject(ev, dry) {
  if (ev) ev.preventDefault();
  const owner = document.getElementById('ghProjectOwner').value.trim();
  const projectNumber = Number(document.getElementById('ghProjectNumber').value);
  const agentField = document.getElementById('ghProjectAgentField').value.trim();
  const out = document.getElementById('ghProjectOut');
  if (!owner || !Number.isInteger(projectNumber) || projectNumber < 1 || !agentField) { out.textContent = 'Enter an organization, project number, and agent field.'; return false; }
  out.textContent = dry ? 'Previewing…' : 'Importing…';
  try {
    const res = await fetch('/admin/github/import-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, projectNumber, agentField, dryRun: !!dry }),
    });
    out.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (e) { out.textContent = 'Error: ' + e; }
  return false;
}

async function ghExecuteTask(ev) {
  ev.preventDefault();
  const field = (id) => document.getElementById(id).value.trim();
  const taskId = field('ghTaskId');
  const repo = field('ghTaskRepo');
  const branchName = field('ghTaskBranch');
  const baseBranch = field('ghTaskBase');
  const path = field('ghTaskPath');
  const title = field('ghTaskTitle');
  const bodyText = document.getElementById('ghTaskBody').value;
  const content = document.getElementById('ghTaskContent').value;
  const out = document.getElementById('ghTaskOut');
  if (!taskId || !repo || !branchName || !baseBranch || !path || !title || !content) { out.textContent = 'Complete every required field.'; return false; }
  out.textContent = 'Creating pull request…';
  try {
    const res = await fetch('/admin/github/execute-task', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, repo, branchName, baseBranch, files: [{ path, content }], title, bodyText }),
    });
    out.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (e) { out.textContent = 'Error: ' + e; }
  return false;
}
</script>
`
}
