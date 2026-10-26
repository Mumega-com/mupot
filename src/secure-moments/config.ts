// mupot — secure moments configuration. Feature flag OFF by default: unless SECURE_MOMENTS is '1' or 'true'
// every /m/* route answers 404 on every host and the request tools issue no secure link.
// Contract: docs/architecture/secure-moments.md.
import type { Env } from '../types'
import { dedicatedApprovalHost, dedicatedHost, hostsRelated } from '../access/config'

export function secureMomentsEnabled(env: Pick<Env, 'SECURE_MOMENTS'>): boolean {
  const v = env.SECURE_MOMENTS?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

type HostEnv = Pick<Env, 'SECURE_MOMENTS_HOST' | 'ACCESS_CANONICAL_HOST' | 'PUBLIC_ORIGIN' | 'DEFAULT_POT_HOST_SUFFIX'>

/**
 * The dedicated secure host if set, well-formed, outside every colony/pot host (the same rule as the Access
 * approval host) AND different from the Access approval host (two surfaces, two hosts); else null. The host
 * is also the WebAuthn RP ID, so it must name exactly one surface.
 */
export function dedicatedSecureHost(env: HostEnv): string | null {
  const host = dedicatedHost(env, env.SECURE_MOMENTS_HOST)
  if (!host) return null
  // The host is the WebAuthn RP ID and the exact origin we verify: a port belongs to neither, so a port is refused.
  if (/:\d{1,5}$/.test(host)) return null
  // Compare against the RAW normalised Access host as well as the validated one: a misconfigured Access host
  // must not become a way to share a host with the secure page.
  const rawAccess = env.ACCESS_CANONICAL_HOST?.trim().toLowerCase().replace(/\.$/, '')
  if (rawAccess && rawAccess === host) return null
  if (dedicatedApprovalHost(env) === host) return null
  // Neither may be a parent or child of the other: a cookie scoped to one would reach the other.
  if (rawAccess && hostsRelated(rawAccess, host)) return null
  return host
}

export type SecureMomentsStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; host: string }

/** Single source for "is the secure page usable": off, misconfigured (fail closed, with the reason), or on. */
export function secureMomentsStatus(env: Env): SecureMomentsStatus {
  if (!secureMomentsEnabled(env)) return { state: 'off' }
  if (!env.SECURE_MOMENTS_HOST?.trim()) {
    return { state: 'misconfigured', reason: 'SECURE_MOMENTS_HOST is not set (secure moments need their own dedicated hostname)' }
  }
  const host = dedicatedSecureHost(env)
  if (!host) {
    return { state: 'misconfigured', reason: 'SECURE_MOMENTS_HOST is malformed, carries a port, equals or sits under a colony host or the pot host domain, or equals ACCESS_CANONICAL_HOST; it must be a dedicated hostname outside them' }
  }
  return { state: 'on', host }
}

/** The origin a WebAuthn ceremony must report (exact match, no wildcard). */
export function secureOrigin(host: string): string {
  return `https://${host}`
}

/** The link an agent hands the human. Null while the feature is off or misconfigured. */
export function momentUrl(env: Env, momentId: string, token: string): string | null {
  const status = secureMomentsStatus(env)
  if (status.state !== 'on') return null
  return `${secureOrigin(status.host)}/m/${encodeURIComponent(momentId)}/${encodeURIComponent(token)}`
}

export function enrolUrl(env: Env, token: string): string | null {
  const status = secureMomentsStatus(env)
  if (status.state !== 'on') return null
  return `${secureOrigin(status.host)}/m/enrol/${encodeURIComponent(token)}`
}

/** The link a human opens to prove presence for one dashboard decision (src/approvals/human-presence.ts). Null while off. */
export function momentsPresenceUrl(env: Env, grantId: string, token: string): string | null {
  const status = secureMomentsStatus(env)
  if (status.state !== 'on') return null
  return `${secureOrigin(status.host)}/m/presence/${encodeURIComponent(grantId)}/${encodeURIComponent(token)}`
}
