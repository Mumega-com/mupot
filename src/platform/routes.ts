// src/platform/routes.ts — HTTP surface for project sub-worker preview dispatch.
//
// Mounted on the pot Worker BEFORE the dashboard catch-all so `/preview/:id`
// is not swallowed by session HTML. The dashboard `/projects/:id` page embeds
// the same path in a split-view iframe (live preview | code/logs).

import { Hono } from 'hono'
import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { Env, Project, ProjectDeployment } from '../types'
import {
  handlePlatformDispatch,
  previewIframePath,
} from './dispatcher'
import { githubRepoSlug } from '../projects/urls'

type AppEnv = { Bindings: Env }

export const platformApp = new Hono<AppEnv>()

async function previewHandler(c: { req: { raw: Request }; env: Env }): Promise<Response> {
  const response = await handlePlatformDispatch(c.req.raw, c.env)
  return response ?? new Response(JSON.stringify({ error: 'preview_unroutable' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}

platformApp.all('/preview/:project_id', previewHandler)
platformApp.all('/preview/:project_id/*', previewHandler)

export interface ProjectPreviewSplitInput {
  project: Pick<Project, 'id' | 'name' | 'slug' | 'repo_url' | 'live_url' | 'worker_name' | 'deploy_status'>
  deployments?: ProjectDeployment[]
  flights?: { id: string; goal: string; status: string }[]
  prs?: { title: string; repo: string; pr_number: number }[]
}

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

  return html`<section aria-label="Live preview" class="project-preview-split" data-project-preview="${project.id}">
    <style>
      .project-preview-split { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(16rem, 1fr); gap: 16px; padding: 16px 0; border-top: 1px solid var(--border); }
      .project-preview-split .pane { min-width: 0; overflow-wrap: anywhere; display: grid; gap: 8px; }
      .project-preview-split iframe { width: 100%; min-height: 28rem; border: 1px solid var(--border); border-radius: 12px; background: #0f1419; }
      .project-preview-split ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
      @media (max-width: 54rem) { .project-preview-split { grid-template-columns: 1fr; } }
    </style>
    <div class="pane" data-preview-pane>
      <h2 class="ui-panel-title" style="margin:0;">Live preview</h2>
      <p class="ui-panel-sub">Project sub-worker via <code>/preview/${project.id}/</code>. Building or idle workers render a fallback page.</p>
      <iframe
        src="${iframeSrc}"
        title="Project live preview"
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerpolicy="no-referrer"
        data-preview-iframe="${project.id}"
      ></iframe>
    </div>
    <div class="pane" data-code-logs-pane>
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
  </section>` as HtmlEscapedString
}
