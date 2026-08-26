// src/platform/dispatcher.ts — Multi-tenant project sub-worker dynamic dispatch.
//
// Distinct from src/dispatcher.ts (Workers for Platforms ROOT: one pot per org).
// This layer routes a PROJECT preview onto `env.DISPATCHER`:
//   - hostname `https://<project>.mupot.mumega.com/...` when the label is not
//     THIS pot's TENANT_SLUG (so a colony pot can host project workers)
//   - path `/preview/:project_id/*` on any host
//
// A live, healthy project Worker is proxied through the dispatch namespace.
// Building / idle / failed / unbound workers get a fallback preview page
// instead of a blank 502 — the dashboard iframe always has something to show.

import type { Env, Project, ProjectDeployStatus } from '../types'
import { projectSelectSql } from '../projects/columns'
import { getProject } from '../projects/service'

export const DEFAULT_PREVIEW_ROOT_DOMAIN = 'mupot.mumega.com'

export const DISPATCH_LIMITS = {
  cpuMs: 30_000,
  subRequests: 50,
} as const

export interface DispatchUserWorker {
  fetch(request: Request): Promise<Response>
}

export interface DispatchNamespace {
  get(
    name: string,
    args?: Record<string, unknown>,
    options?: { limits?: { cpuMs?: number; subRequests?: number } },
  ): DispatchUserWorker
}

export type PreviewFallbackReason =
  | 'idle'
  | 'building'
  | 'failed'
  | 'unbound'
  | 'not_provisioned'
  | 'dispatcher_error'

export type DispatchTarget =
  | { kind: 'path'; projectId: string; remainder: string }
  | { kind: 'hostname'; slug: string; remainder: string }

export function previewIframePath(projectId: string, remainder = '/'): string {
  const suffix = remainder.startsWith('/') ? remainder : `/${remainder}`
  return `/preview/${encodeURIComponent(projectId)}${suffix === '/' ? '/' : suffix}`
}

export function matchPreviewPath(pathname: string): { projectId: string; remainder: string } | null {
  const match = pathname.match(/^\/preview\/([^/]+)(\/.*)?$/)
  if (!match) return null
  let projectId = match[1]
  try {
    projectId = decodeURIComponent(projectId)
  } catch {
    return null
  }
  if (!projectId) return null
  return { projectId, remainder: match[2] && match[2].length > 0 ? match[2] : '/' }
}

export function extractDispatchTarget(
  url: URL,
  tenantSlug?: string,
  rootDomain: string = DEFAULT_PREVIEW_ROOT_DOMAIN,
): DispatchTarget | null {
  const preview = matchPreviewPath(url.pathname)
  if (preview) return { kind: 'path', ...preview }

  const host = url.hostname.toLowerCase().split(':')[0] ?? ''
  const root = rootDomain.toLowerCase().split(':')[0] ?? DEFAULT_PREVIEW_ROOT_DOMAIN
  if (!host || host === root || host === `www.${root}`) return null
  if (!host.endsWith(`.${root}`)) return null

  const sub = host.slice(0, -(root.length + 1))
  const parts = sub.split('.').filter(Boolean)
  const slug = parts[parts.length - 1]
  if (!slug) return null
  const tenant = tenantSlug?.toLowerCase()
  if (tenant && slug === tenant) return null
  return { kind: 'hostname', slug, remainder: url.pathname || '/' }
}

export function scriptNameForProject(project: Pick<Project, 'slug' | 'worker_name'>): string {
  return project.worker_name || project.slug
}

export function fallbackReasonForStatus(status: ProjectDeployStatus | null | undefined): PreviewFallbackReason | null {
  if (status === 'healthy') return null
  if (status === 'queued' || status === 'deploying') return 'building'
  if (status === 'failed') return 'failed'
  return 'idle'
}

export function isWorkerReady(status: ProjectDeployStatus | null | undefined): boolean {
  return fallbackReasonForStatus(status) === null
}

export async function findProjectForDispatch(env: Env, target: DispatchTarget): Promise<Project | null> {
  if (target.kind === 'path') return getProject(env, target.projectId)
  const row = await env.DB.prepare(
    `SELECT ${projectSelectSql()} FROM projects WHERE slug = ?1 OR worker_name = ?1 LIMIT 1`,
  ).bind(target.slug).first<Project>()
  return row ?? null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FALLBACK_COPY: Record<PreviewFallbackReason, { title: string; body: string }> = {
  idle: {
    title: 'Worker idle',
    body: 'This project Worker has not been dispatched yet. The live preview will appear here once a healthy deploy lands.',
  },
  building: {
    title: 'Worker building',
    body: 'The project sub-worker is queued or deploying. This fallback stays up so the preview iframe is never blank.',
  },
  failed: {
    title: 'Worker failed',
    body: 'The last deploy did not land healthy. Dispatch a new feature flight to restore the live preview.',
  },
  unbound: {
    title: 'Dispatch namespace unbound',
    body: 'env.DISPATCHER is not bound on this pot. The project Worker cannot be reached until the Workers for Platforms namespace is attached.',
  },
  not_provisioned: {
    title: 'Worker not provisioned',
    body: 'No user Worker with this script name exists in the dispatch namespace yet.',
  },
  dispatcher_error: {
    title: 'Dispatcher error',
    body: 'The dispatch namespace rejected the fetch. The fallback preview is shown instead of a blank iframe.',
  },
}

export function renderFallbackPreview(input: {
  project: Pick<Project, 'id' | 'name' | 'slug' | 'worker_name' | 'deploy_status' | 'live_url' | 'repo_url'>
  reason: PreviewFallbackReason
  detail?: string
}): string {
  const copy = FALLBACK_COPY[input.reason]
  const script = scriptNameForProject(input.project)
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(copy.title)} — ${escapeHtml(input.project.name)}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1419; color: #e8eef4; }
    main { max-width: 36rem; padding: 32px 28px; border: 1px solid #2a3540; border-radius: 16px; background: #161d24; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    p { color: #9aa8b5; line-height: 1.5; }
    .meta { display: grid; gap: 4px; margin: 18px 0 0; font-size: .85rem; color: #7d8b97; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid #3a4a58; color: #c9d4de; font-size: .75rem; }
    .detail { font-family: ui-monospace, monospace; font-size: .8rem; color: #c9d4de; }
  </style>
</head>
<body>
  <main data-preview-fallback="${escapeHtml(input.reason)}" data-project-id="${escapeHtml(input.project.id)}">
    <span class="tag">${escapeHtml(input.project.deploy_status)}</span>
    <h1>${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.body)}</p>
    ${detail}
    <div class="meta">
      <div>Project: ${escapeHtml(input.project.name)} (${escapeHtml(input.project.slug)})</div>
      <div>Script: ${escapeHtml(script)}</div>
      ${input.project.live_url ? `<div>Live: ${escapeHtml(input.project.live_url)}</div>` : ''}
    </div>
  </main>
</body>
</html>`
}

export function fallbackPreviewResponse(
  project: Pick<Project, 'id' | 'name' | 'slug' | 'worker_name' | 'deploy_status' | 'live_url' | 'repo_url'>,
  reason: PreviewFallbackReason,
  detail?: string,
): Response {
  const status = reason === 'failed' ? 503 : reason === 'dispatcher_error' ? 502 : 200
  return new Response(renderFallbackPreview({ project, reason, detail }), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-mupot-preview': reason,
    },
  })
}

function rewriteForWorker(request: Request, remainder: string): Request {
  const url = new URL(request.url)
  url.pathname = remainder.startsWith('/') ? remainder : `/${remainder}`
  if (!url.pathname) url.pathname = '/'
  return new Request(url.toString(), request)
}

function isWorkerMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /not found|no user worker|unknown worker|does not exist/i.test(message)
}

export async function dispatchProjectRequest(
  request: Request,
  env: Env,
  project: Project,
  remainder: string,
): Promise<Response> {
  const reason = fallbackReasonForStatus(project.deploy_status)
  if (reason) return fallbackPreviewResponse(project, reason)

  if (!env.DISPATCHER) return fallbackPreviewResponse(project, 'unbound')

  const script = scriptNameForProject(project)
  let worker: DispatchUserWorker
  try {
    worker = env.DISPATCHER.get(script, {}, { limits: { ...DISPATCH_LIMITS } })
  } catch (err) {
    if (isWorkerMissing(err)) return fallbackPreviewResponse(project, 'not_provisioned')
    return fallbackPreviewResponse(
      project,
      'dispatcher_error',
      err instanceof Error ? err.message : String(err),
    )
  }

  try {
    return await worker.fetch(rewriteForWorker(request, remainder))
  } catch (err) {
    if (isWorkerMissing(err)) return fallbackPreviewResponse(project, 'not_provisioned')
    return fallbackPreviewResponse(
      project,
      'dispatcher_error',
      err instanceof Error ? err.message : String(err),
    )
  }
}

export async function handlePlatformDispatch(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const target = extractDispatchTarget(url, env.TENANT_SLUG, env.DEFAULT_POT_HOST_SUFFIX || DEFAULT_PREVIEW_ROOT_DOMAIN)
  if (!target) return null

  const project = await findProjectForDispatch(env, target)
  if (!project) {
    if (target.kind === 'hostname') return null
    return new Response(
      JSON.stringify({
        error: 'project_not_found',
        project_id: target.projectId,
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }

  return dispatchProjectRequest(request, env, project, target.remainder)
}

/** Hostname-only entry for the Worker fetch wrapper. Path `/preview/*` is left to Hono. */
export async function maybeHandleHostnameDispatch(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  if (matchPreviewPath(url.pathname)) return null
  const target = extractDispatchTarget(url, env.TENANT_SLUG, env.DEFAULT_POT_HOST_SUFFIX || DEFAULT_PREVIEW_ROOT_DOMAIN)
  if (!target || target.kind !== 'hostname') return null
  return handlePlatformDispatch(request, env)
}
