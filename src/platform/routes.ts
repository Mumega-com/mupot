// src/platform/routes.ts — HTTP surface for project sub-worker preview dispatch.
//
// Mounted on the pot Worker BEFORE the dashboard catch-all so `/preview/:id`
// is not swallowed by session HTML. The dashboard `/projects/:id` page embeds
// the same path in a split-view iframe (live preview | code/logs).

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { AuthContext, Env, Project, ProjectDeployment } from '../types'
import { requireAuth } from '../auth'
import {
  handlePlatformDispatch,
  previewIframePath,
} from './dispatcher'
import { githubRepoSlug } from '../projects/urls'
import { PROJECT_SANDBOX_QUICK_PROMPTS } from '../projects/provisioner'
import { copilotDeepChatMarkup, copilotRecipientSelectHtml } from '../dashboard/copilot'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const platformApp = new Hono<AppEnv>()

async function previewHandler(c: { req: { raw: Request }; env: Env }): Promise<Response> {
  const response = await handlePlatformDispatch(c.req.raw, c.env)
  return response ?? new Response(JSON.stringify({ error: 'preview_unroutable' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}

// AUTHENTICATION IS REQUIRED HERE (mupot#1305). This route dispatches into the
// `mupot-pots` dispatch namespace — the SAME namespace that holds sovereign tenant pots —
// using a script name that is member-supplied (`worker_name || slug`). Until this gate it
// was mounted with no auth middleware at all, and was confirmed reachable unauthenticated
// on production 2026-09-04:
//
//   GET https://mupot.mumega.com/preview/<uuid>/  ->  {"error":"project_not_found",...}
//
// i.e. a database lookup ran for an anonymous stranger, and for a project in `healthy`
// state the request would have been dispatched into that project's Worker.
//
// It also forwards credentials, and unlike the WFP hostname branch it cannot rely on the
// browser's own scoping to prevent that: `/preview/*` is SAME-ORIGIN on the colony, so the
// browser attaches the colony's host-only `mupot_session` cookie, and dispatchProjectRequest
// hands the request on with headers intact. The cookie being host-only is precisely why it
// IS sent here — the host is the colony.
//
// requireAuth answers 401 JSON rather than redirecting, so the dashboard's preview iframe
// fails cleanly instead of rendering login HTML into itself. That was the stated reason
// this route sits ahead of the dashboard catch-all, and it is preserved.
platformApp.use('/preview/:project_id', requireAuth)
platformApp.use('/preview/:project_id/*', requireAuth)
platformApp.all('/preview/:project_id', previewHandler)
platformApp.all('/preview/:project_id/*', previewHandler)

export interface ProjectPreviewSplitInput {
  project: Pick<Project, 'id' | 'name' | 'slug' | 'repo_url' | 'live_url' | 'worker_name' | 'deploy_status'>
  deployments?: ProjectDeployment[]
  flights?: { id: string; goal: string; status: string }[]
  prs?: { title: string; repo: string; pr_number: number }[]
}

export const SANDBOX_VIEWPORTS = [
  { id: 'desktop', label: '🖥️ Desktop' },
  { id: 'tablet', label: '📟 Tablet' },
  { id: 'mobile', label: '📱 Mobile' },
] as const

/** 768px / 375px at the 16px root — keep rem so the canvas stays relative. */
export const SANDBOX_TABLET_MAX_WIDTH = '48rem'
export const SANDBOX_MOBILE_MAX_WIDTH = '23.4375rem'

export function projectLivePreviewSplitHtml(input: ProjectPreviewSplitInput): HtmlEscapedString {
  const { project } = input
  const iframeSrc = previewIframePath(project.id)
  const repo = githubRepoSlug(project.repo_url)
  const deployments = input.deployments ?? []
  const flights = input.flights ?? []
  const prs = input.prs ?? []

  const logItems = deployments.length
    ? deployments.map((row) => html`<li>
        <span class="ui-mono-dim">${row.status}</span>
        <span>${row.commit_sha ? row.commit_sha.slice(0, 7) : 'pending'}</span>
        <span class="ui-panel-sub">${row.created_at}</span>
      </li>`)
    : [html`<li class="ui-panel-sub">No deploy receipts yet.</li>`]

  const codeItems = [
    repo
      ? html`<li><a class="ui-link" href="${project.repo_url ?? ''}">${repo}</a></li>`
      : html`<li class="ui-panel-sub">No repository bound.</li>`,
    project.live_url
      ? html`<li><a class="ui-link" href="${project.live_url}">${project.live_url}</a></li>`
      : html`<li class="ui-panel-sub">${project.worker_name || 'No live URL'}</li>`,
    ...prs.map((pr) => html`<li><a class="ui-link" href="https://github.com/${pr.repo}/pull/${String(pr.pr_number)}">${pr.title}</a></li>`),
    ...flights.map((flight) => html`<li>${flight.goal} <span class="ui-panel-sub">${flight.status}</span></li>`),
  ]

  const streamCards = [
    ...flights.map((flight) => html`<article class="sandbox-stream-card" data-flight-step data-status="${flight.status}">
      <div class="ui-panel-sub">Flight</div>
      <h3 class="ui-panel-title" style="margin:0;font-size:1rem;">${flight.goal}</h3>
      <p style="margin:0;">${flight.status}</p>
    </article>`),
    ...deployments.map((row) => html`<article class="sandbox-stream-card" data-deploy-step data-status="${row.status}">
      <div class="ui-panel-sub">Deployment</div>
      <h3 class="ui-panel-title" style="margin:0;font-size:1rem;">${row.commit_sha ? row.commit_sha.slice(0, 7) : 'pending'}</h3>
      <p style="margin:0;">${row.status}</p>
    </article>`),
  ]

  return html`<section
    aria-label="Live preview"
    class="project-preview-split"
    data-project-preview="${project.id}"
    data-sandbox-studio="${project.id}"
    data-viewport="desktop"
  >
    <style>
      .project-preview-split { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(16rem, 1fr); gap: 16px; padding: 16px 0; border-top: 1px solid var(--border); }
      .project-preview-split .pane { min-width: 0; overflow-wrap: anywhere; display: grid; gap: 8px; }
      .project-preview-split .preview-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
      .project-preview-split .viewport-toggles { display: flex; flex-wrap: wrap; gap: 6px; }
      .project-preview-split .viewport-toggles [aria-pressed="true"] {
        background: var(--primary-soft, #f7f1dd); color: var(--primary); border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
      }
      .project-preview-split .preview-frame-wrap { min-width: 0; display: flex; justify-content: center; }
      .project-preview-split iframe { width: 100%; min-height: 28rem; border: 1px solid var(--border); border-radius: 12px; background: #0f1419; transition: max-width .18s ease; }
      .project-preview-split[data-viewport="tablet"] iframe { max-width: ${SANDBOX_TABLET_MAX_WIDTH}; }
      .project-preview-split[data-viewport="mobile"] iframe { max-width: ${SANDBOX_MOBILE_MAX_WIDTH}; }
      .project-preview-split ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
      .project-preview-split .quick-prompts { display: flex; flex-wrap: wrap; gap: 6px; }
      .project-preview-split .sandbox-stream { display: grid; gap: 8px; }
      .project-preview-split .sandbox-stream-card {
        border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 4px; min-width: 0;
      }
      .project-preview-split .sandbox-copilot { min-height: 22rem; display: grid; gap: 8px; }
      @media (max-width: 54rem) { .project-preview-split { grid-template-columns: 1fr; } }
    </style>
    <div class="pane" data-preview-pane>
      <div class="preview-toolbar">
        <h2 class="ui-panel-title" style="margin:0;">Live preview</h2>
        <div class="viewport-toggles" role="group" aria-label="Device viewport">
          ${SANDBOX_VIEWPORTS.map((viewport) => html`<button
            type="button"
            class="btn secondary sm"
            data-viewport-toggle="${viewport.id}"
            aria-pressed="${viewport.id === 'desktop' ? 'true' : 'false'}"
          >${viewport.label}</button>`)}
          <button type="button" class="btn sm" data-preview-refresh>Refresh Preview</button>
          <a
            class="btn secondary sm"
            data-preview-external
            href="${project.live_url || iframeSrc}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open preview in a new tab"
            title="Open preview in a new tab"
          >↗</a>
          <span class="ui-panel-sub" data-viewport-size>Desktop · 100%</span>
        </div>
      </div>
      <p class="ui-panel-sub">Project sub-worker via <code>/preview/${project.id}/</code>. Building or idle workers render a fallback page.</p>
      <div class="preview-frame-wrap">
        <iframe
          src="${iframeSrc}"
          title="Project live preview"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="no-referrer"
          data-preview-iframe="${project.id}"
        ></iframe>
      </div>
    </div>
    <div class="pane" data-code-logs-pane data-sandbox-drawer>
      <h2 class="ui-panel-title" style="margin:0;">Co-Pilot</h2>
      <p class="ui-panel-sub" data-copilot-focus>
        ${repo
          ? html`Pre-focused on <a class="ui-link" href="${project.repo_url ?? ''}">${repo}</a>.`
          : html`No repository bound yet. Quick prompts still draft against this project.`}
      </p>
      <div class="quick-prompts" aria-label="Quick Prompts">
        ${PROJECT_SANDBOX_QUICK_PROMPTS.map((prompt) => html`<button type="button" class="btn secondary sm" data-quick-prompt="${prompt}">${prompt}</button>`)}
      </div>
      <div class="sandbox-copilot" data-project-copilot="${project.id}" data-project-repo="${project.repo_url ?? ''}">
        ${copilotRecipientSelectHtml('mupot-copilot-sandbox-recipient')}
        ${copilotDeepChatMarkup({
          projectId: project.id,
          projectRepo: project.repo_url ?? '',
        })}
      </div>
      <section aria-label="Flight & Deployment Stream" data-flight-stream>
        <h3 class="ui-panel-title" style="margin:0;">Flight & Deployment Stream</h3>
        <div class="sandbox-stream">
          ${streamCards.length
            ? streamCards
            : html`<article class="sandbox-stream-card" data-flight-step data-status="idle">
                <div class="ui-panel-sub">Flight</div>
                <p class="ui-panel-sub" style="margin:0;">No flight dispatched on this project yet.</p>
              </article>`}
        </div>
      </section>
      <div>
        <h2 class="ui-panel-title" style="margin:0;">Code / Logs</h2>
        <div>
          <div class="ui-panel-sub">Code</div>
          <ul>${codeItems}</ul>
        </div>
        <div>
          <div class="ui-panel-sub">Logs</div>
          <ul>${logItems}</ul>
        </div>
      </div>
    </div>
    <script>
      (function () {
        var root = document.querySelector('[data-sandbox-studio="${raw(project.id)}"]');
        if (!root) return;
        root.querySelectorAll('[data-viewport-toggle]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var next = btn.getAttribute('data-viewport-toggle') || 'desktop';
            root.setAttribute('data-viewport', next);
            root.querySelectorAll('[data-viewport-toggle]').forEach(function (other) {
              other.setAttribute('aria-pressed', other === btn ? 'true' : 'false');
            });
            var sizes = { desktop: 'Desktop · 100%', tablet: 'Tablet · 768px', mobile: 'Mobile · 375px' };
            var size = root.querySelector('[data-viewport-size]');
            if (size) size.textContent = sizes[next] || sizes.desktop;
          });
        });
        var refresh = root.querySelector('[data-preview-refresh]');
        if (refresh) {
          refresh.addEventListener('click', function () {
            var iframe = root.querySelector('iframe[data-preview-iframe]');
            if (iframe) iframe.src = iframe.getAttribute('src') || iframe.src;
          });
        }
        root.querySelectorAll('[data-quick-prompt]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var text = btn.getAttribute('data-quick-prompt') || '';
            var chat = root.querySelector('deep-chat');
            if (!chat || !text) return;
            if (typeof chat.submitUserMessage === 'function') chat.submitUserMessage({ text: text });
            else chat.setAttribute('data-pending-prompt', text);
          });
        });
      })();
    </script>
  </section>` as HtmlEscapedString
}
