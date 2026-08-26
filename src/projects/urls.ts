/** Shared URL / worker-name checks for the project worker platform. */

const MAX_URL_LENGTH = 500
const WORKER_NAME_RE = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

export function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > MAX_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password
  } catch {
    return false
  }
}

export function isValidWorkerName(value: unknown): value is string {
  return typeof value === 'string' && WORKER_NAME_RE.test(value)
}

export function githubRepoSlug(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null
  try {
    const url = new URL(repoUrl)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  } catch {
    return null
  }
}

export function studioDispatchPath(repoUrl: string): string {
  return `/studio?repo=${encodeURIComponent(repoUrl)}`
}

export const PROJECT_WORKER_SUBDOMAIN_ROOT = 'mupot.mumega.com'

/** Lowercase hyphenated slug from a display name. Empty when nothing usable remains. */
export function slugFromProjectName(name: unknown): string {
  if (typeof name !== 'string') return ''
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug
}

export function projectWorkerSubdomain(slug: string): string {
  return `https://${slug}.${PROJECT_WORKER_SUBDOMAIN_ROOT}`
}
