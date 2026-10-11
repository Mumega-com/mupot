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
  canonicalHost: string // lower-case host[:port]; a DEDICATED approval hostname, never a colony host
  maxJwtAgeSeconds: number
  /** Optional: the token's `amr` claim must contain at least one of these (lower-case). Empty = not enforced. */
  requiredAmr: string[]
}

const TEAM_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/

/** Normalise the operator-set team domain: accepts `team.cloudflareaccess.com` or `https://team...`. */
export function normalizeTeamHost(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return TEAM_HOST_RE.test(t) ? t : null
}

const DEFAULT_COLONY_HOST = 'mupot.mumega.com' // the same fallback src/index.ts uses for the root host

function hostnameOf(hostPort: string): string {
  return hostPort.replace(/:\d{1,5}$/, '')
}

/** Every host the colony itself answers on (PUBLIC_ORIGIN, or the built-in default when unset), lower-case, hostname only. */
export function colonyHostnames(env: Pick<Env, 'PUBLIC_ORIGIN'>): Set<string> {
  const out = new Set<string>([DEFAULT_COLONY_HOST])
  const raw = env.PUBLIC_ORIGIN?.trim()
  if (raw) {
    try {
      out.add(new URL(raw).hostname.toLowerCase())
    } catch {
      // malformed PUBLIC_ORIGIN: the default above still protects the built-in colony host
    }
  }
  return out
}

/** Strip leading/trailing dots without a backtracking regex. */
function trimDots(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '.') start++
  while (end > start && value[end - 1] === '.') end--
  return value.slice(start, end)
}

function isSameOrSubdomain(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`)
}

/**
 * The dedicated approval hostname if it is set, well-formed, and neither a colony host nor UNDER one (nor under the
 * pot host suffix); else null. A host under the colony domain is refused because tenant/project hostname routing
 * keys on the first label (an agent project named `approve` would own `approve.<colony>`), and because the Access
 * cookie is scoped to the domain and its subdomains.
 */
export function dedicatedApprovalHost(env: Pick<Env, 'ACCESS_CANONICAL_HOST' | 'PUBLIC_ORIGIN' | 'DEFAULT_POT_HOST_SUFFIX'>): string | null {
  const host = env.ACCESS_CANONICAL_HOST?.trim().toLowerCase().replace(/\.$/, '')
  if (!host || !HOST_RE.test(host)) return null
  const name = hostnameOf(host)
  for (const colony of colonyHostnames(env)) if (isSameOrSubdomain(name, colony)) return null
  const potSuffix = trimDots(env.DEFAULT_POT_HOST_SUFFIX?.trim().toLowerCase() ?? '')
  if (potSuffix && isSameOrSubdomain(name, potSuffix)) return null
  return host
}

export type AccessApproveStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; cfg: AccessApproveConfig }

/** Single source for "is the page usable": off, misconfigured (fail closed, with the reason), or on. */
export function accessApproveStatus(env: Env): AccessApproveStatus {
  if (!accessApproveEnabled(env)) return { state: 'off' }
  const raw = env.ACCESS_CANONICAL_HOST?.trim().toLowerCase()
  if (!raw) return { state: 'misconfigured', reason: 'ACCESS_CANONICAL_HOST is not set (the approval page needs its own dedicated hostname)' }
  if (!dedicatedApprovalHost(env)) {
    return { state: 'misconfigured', reason: 'ACCESS_CANONICAL_HOST is malformed, equals a colony host, or sits under the colony or pot host domain; it must be a dedicated hostname outside them' }
  }
  const cfg = loadAccessApproveConfig(env)
  if (!cfg) return { state: 'misconfigured', reason: 'ACCESS_TEAM_DOMAIN or ACCESS_AUD is missing or malformed' }
  return { state: 'on', cfg }
}

/** Null when any required variable is missing/malformed or the host is not dedicated (caller fails closed). */
export function loadAccessApproveConfig(env: Env): AccessApproveConfig | null {
  const teamHost = env.ACCESS_TEAM_DOMAIN ? normalizeTeamHost(env.ACCESS_TEAM_DOMAIN) : null
  const aud = env.ACCESS_AUD?.trim()
  const canonicalHost = dedicatedApprovalHost(env)
  if (!teamHost || !aud || !canonicalHost) return null
  const requiredAmr = (env.ACCESS_REQUIRED_AMR ?? '').split(',').map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  const rawAge = env.ACCESS_MAX_JWT_AGE_SECONDS ? Number(env.ACCESS_MAX_JWT_AGE_SECONDS) : DEFAULT_MAX_JWT_AGE_SECONDS
  const maxJwtAgeSeconds = Number.isFinite(rawAge) && rawAge >= 1 ? Math.min(Math.floor(rawAge), MAX_JWT_AGE_SECONDS) : DEFAULT_MAX_JWT_AGE_SECONDS
  return { teamHost, aud, canonicalHost, maxJwtAgeSeconds, requiredAmr }
}

/** The link an agent hands the human. Null while the feature is off or not fully configured. */
export function approveUrl(env: Env, kind: 'seed' | 'elevation', id: string): string | null {
  const status = accessApproveStatus(env)
  if (status.state !== 'on') return null
  const cfg = status.cfg
  return `https://${cfg.canonicalHost}/approve/${kind}/${encodeURIComponent(id)}`
}
