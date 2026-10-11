// mupot — Access approve page configuration. Feature flag OFF by default: unless
// ACCESS_APPROVE_ENABLED is '1' or 'true' every /approve/* route answers 404 and the request tools
// issue no approve_url. Contract: docs/architecture/access-approve-page.md.
import type { Env } from '../types'

export const DEFAULT_MAX_JWT_AGE_SECONDS = 60
export const MAX_JWT_AGE_SECONDS = 300

export function accessApproveEnabled(env: Pick<Env, 'ACCESS_APPROVE_ENABLED'>): boolean {
  const v = env.ACCESS_APPROVE_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export interface AccessApproveConfig {
  teamHost: string // <team>.cloudflareaccess.com
  aud: string
  canonicalHost: string // lower-case host[:port]
  maxJwtAgeSeconds: number
}

const TEAM_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/

/** Normalise the operator-set team domain: accepts `team.cloudflareaccess.com` or `https://team...`. */
export function normalizeTeamHost(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return TEAM_HOST_RE.test(t) ? t : null
}

/** Null when the flag is on but any required variable is missing/malformed (caller answers 503: fail closed). */
export function loadAccessApproveConfig(env: Env): AccessApproveConfig | null {
  const teamHost = env.ACCESS_TEAM_DOMAIN ? normalizeTeamHost(env.ACCESS_TEAM_DOMAIN) : null
  const aud = env.ACCESS_AUD?.trim()
  const canonicalHost = env.ACCESS_CANONICAL_HOST?.trim().toLowerCase()
  if (!teamHost || !aud || !canonicalHost || !HOST_RE.test(canonicalHost)) return null
  const rawAge = env.ACCESS_MAX_JWT_AGE_SECONDS ? Number(env.ACCESS_MAX_JWT_AGE_SECONDS) : DEFAULT_MAX_JWT_AGE_SECONDS
  const maxJwtAgeSeconds = Number.isFinite(rawAge) && rawAge >= 1 ? Math.min(Math.floor(rawAge), MAX_JWT_AGE_SECONDS) : DEFAULT_MAX_JWT_AGE_SECONDS
  return { teamHost, aud, canonicalHost, maxJwtAgeSeconds }
}

/** The link an agent hands the human. Null while the feature is off or not fully configured. */
export function approveUrl(env: Env, kind: 'seed' | 'elevation', id: string): string | null {
  if (!accessApproveEnabled(env)) return null
  const cfg = loadAccessApproveConfig(env)
  if (!cfg) return null
  return `https://${cfg.canonicalHost}/approve/${kind}/${encodeURIComponent(id)}`
}
