// mupot - secure drops (W2) configuration. Flag OFF by default and subordinate to secure moments: unless
// SECURE_DROP is '1' or 'true' AND secure moments are on and well-configured, the drop tools refuse before any
// read or write, the secure page serves no credential page or vendored script, and no row is ever created.
// Contract: docs/architecture/secure-moments.md ("W2: secure drops").
import type { Env } from '../types'
import { secureMomentsStatus } from '../secure-moments/config'

export function secureDropFlag(env: Pick<Env, 'SECURE_DROP'>): boolean {
  const v = env.SECURE_DROP?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export type SecureDropStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; host: string }

export function secureDropStatus(env: Env): SecureDropStatus {
  if (!secureDropFlag(env)) return { state: 'off' }
  const moments = secureMomentsStatus(env)
  if (moments.state === 'off') return { state: 'misconfigured', reason: 'SECURE_DROP needs SECURE_MOMENTS to be on' }
  if (moments.state === 'misconfigured') return { state: 'misconfigured', reason: `secure moments are misconfigured: ${moments.reason}` }
  return { state: 'on', host: moments.host }
}

/** Longest a request stays open (the moment never outlives it) and the default. */
export const DROP_TTL_DEFAULT_MINUTES = 60
export const DROP_TTL_MIN_MINUTES = 5
export const DROP_TTL_MAX_MINUTES = 24 * 60
/** How long sealed ciphertext waits for the host to pull it after the human provided it. */
export const DROP_RETAIN_MS = 24 * 60 * 60 * 1000
/** Open requests one agent may have at a time. */
export const DROP_MAX_OPEN_PER_AGENT = 10
/** Largest secret the page accepts (plaintext bytes); the stored ciphertext is this plus the 16-byte GCM tag. */
export const DROP_MAX_PLAINTEXT_BYTES = 8 * 1024
export const DROP_MAX_CIPHERTEXT_BYTES = DROP_MAX_PLAINTEXT_BYTES + 16
export const DROP_ENC_BYTES = 32
