import { isOrgAdmin } from '../auth/capability'
import type { AuthContext, Env, Project } from '../types'
import { isValidSlug } from '../org/service'
import type { CreateProjectInput, ProjectMutationError } from './service'
import { createProject } from './service'
import {
  isValidWorkerName,
  projectWorkerSubdomain,
  slugFromProjectName,
} from './urls'
import { CURSOR_SQUAD_SLUG } from './client-bootstrap'

export { slugFromProjectName, projectWorkerSubdomain, PROJECT_WORKER_SUBDOMAIN_ROOT } from './urls'

export const DEFAULT_PROJECT_WORKER_SQUAD = CURSOR_SQUAD_SLUG

export const PROJECT_WORKER_TEMPLATES = [
  { id: 'custom', label: 'Custom Repo' },
  { id: 'next-vite', label: 'Next.js / Vite' },
  { id: 'hono', label: 'Cloudflare Worker Hono' },
  { id: 'astro', label: 'Static Astro' },
] as const

export type ProjectWorkerTemplateId = (typeof PROJECT_WORKER_TEMPLATES)[number]['id']

export const PROJECT_SANDBOX_QUICK_PROMPTS = [
  'Add contact form',
  'Fix navbar layout',
  'Audit SEO tags',
] as const

export function isProjectWorkerTemplate(value: unknown): value is ProjectWorkerTemplateId {
  return typeof value === 'string'
    && PROJECT_WORKER_TEMPLATES.some((template) => template.id === value)
}

export function projectWorkerTemplateLabel(id: ProjectWorkerTemplateId): string {
  return PROJECT_WORKER_TEMPLATES.find((template) => template.id === id)?.label ?? 'Custom Repo'
}

export function canProvisionProjectWorker(auth: AuthContext): boolean {
  return isOrgAdmin(auth)
}

export async function resolveAssignedSquadId(
  env: Env,
  value: unknown,
): Promise<{ ok: true; value: string | null } | { ok: false; error: ProjectMutationError }> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null }
  }
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'squad_not_found' }
  const key = value.trim()
  const row = await env.DB.prepare(
    'SELECT id FROM squads WHERE id = ?1 OR slug = ?1 LIMIT 1',
  ).bind(key).first<{ id: string }>()
  if (!row) return { ok: false, error: 'squad_not_found' }
  return { ok: true, value: row.id }
}

export async function resolveDefaultProjectSquadId(env: Env): Promise<string | null> {
  const resolved = await resolveAssignedSquadId(env, DEFAULT_PROJECT_WORKER_SQUAD)
  return resolved.ok ? resolved.value : null
}

function templateDescription(template: ProjectWorkerTemplateId): string {
  if (template === 'custom') return ''
  return `Provisioned from ${projectWorkerTemplateLabel(template)} template.`
}

export type PrepareProjectWorkerError = ProjectMutationError | 'invalid_template'

export async function prepareProjectWorkerProvision(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ ok: true; value: CreateProjectInput } | { ok: false; error: PrepareProjectWorkerError }> {
  const template = body.template === undefined || body.template === ''
    ? 'custom'
    : body.template
  if (!isProjectWorkerTemplate(template)) return { ok: false, error: 'invalid_template' }

  const name = typeof body.name === 'string' ? body.name : ''
  const suppliedSlug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const slug = suppliedSlug || slugFromProjectName(name)
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid_slug' }

  const provisionerCreate = body.template !== undefined || body.worker_name !== undefined
    || body.assigned_squad_id !== undefined
  const suppliedWorker = typeof body.worker_name === 'string' ? body.worker_name.trim() : ''
  const workerName = suppliedWorker || (provisionerCreate ? slug : '')
  if (workerName && !isValidWorkerName(workerName)) return { ok: false, error: 'invalid_worker_name' }

  const wantsDefaultSquad = provisionerCreate && (
    body.assigned_squad_id === undefined
    || body.assigned_squad_id === ''
    || body.assigned_squad_id === DEFAULT_PROJECT_WORKER_SQUAD
  )
  const assigned = wantsDefaultSquad
    ? { ok: true as const, value: await resolveDefaultProjectSquadId(env) }
    : await resolveAssignedSquadId(env, body.assigned_squad_id)
  if (!assigned.ok) return assigned

  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description
    : templateDescription(template)

  return {
    ok: true,
    value: {
      slug,
      name,
      description,
      goal: body.goal,
      status: body.status,
      parent_project_id: body.parent_project_id,
      target_date: body.target_date,
      repo_url: body.repo_url,
      worker_name: workerName,
      // Preview subdomain is derived, not a live deploy — keep deploy_status idle.
      live_url: body.live_url,
      assigned_squad_id: assigned.value,
    },
  }
}

export interface ProvisionedProjectWorker {
  ok: true
  project: Project
  redirect_url: string
  preview_url: string
}

export async function provisionProjectWorker(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<
  | ProvisionedProjectWorker
  | { ok: false; error: PrepareProjectWorkerError | 'forbidden'; status: 400 | 403 | 404 | 409 }
> {
  if (!canProvisionProjectWorker(auth)) {
    return { ok: false, error: 'forbidden', status: 403 }
  }
  const prepared = await prepareProjectWorkerProvision(env, body)
  if (!prepared.ok) {
    const status = prepared.error === 'invalid_template'
      ? 400
      : prepared.error === 'squad_not_found' || prepared.error === 'parent_not_found' || prepared.error === 'project_not_found'
        ? 404
        : prepared.error === 'slug_taken' || prepared.error === 'receipt_failed'
          ? 409
          : 400
    return { ok: false, error: prepared.error, status }
  }
  const result = await createProject(env, prepared.value)
  if (!result.ok) {
    const status = result.error === 'squad_not_found' || result.error === 'parent_not_found' || result.error === 'project_not_found'
      ? 404
      : result.error === 'slug_taken' || result.error === 'receipt_failed'
        ? 409
        : 400
    return { ok: false, error: result.error, status }
  }
  return {
    ok: true,
    project: result.value,
    redirect_url: `/projects/${result.value.id}`,
    preview_url: projectWorkerSubdomain(result.value.slug),
  }
}
