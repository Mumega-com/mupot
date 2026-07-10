import type { Env } from '../types'

export const SHARED_NONCE_WINDOWS_SEC = {
  'fleet-attach:v1': 300,
  'fleet-detach:v1': 300,
  'agent-inbox:v1': 300,
} as const

export type SharedNonceDomain = keyof typeof SHARED_NONCE_WINDOWS_SEC

export const SHARED_NONCE_RETENTION_SEC =
  2 * Math.max(...Object.values(SHARED_NONCE_WINDOWS_SEC))

export function sharedNonceWindowSec(domain: SharedNonceDomain): number {
  return SHARED_NONCE_WINDOWS_SEC[domain]
}

export function assertSharedNonceDomainWindow(domain: SharedNonceDomain, windowSec: number): void {
  const registered = sharedNonceWindowSec(domain)
  if (registered !== windowSec) {
    throw new Error(`shared nonce domain ${domain} window ${windowSec}s does not match registered ${registered}s`)
  }
}

export async function burnSharedAgentNonce(
  env: Env,
  opts: {
    domain: SharedNonceDomain
    windowSec: number
    agentId: string
    nonce: string
    now: number
  },
): Promise<boolean> {
  assertSharedNonceDomainWindow(opts.domain, opts.windowSec)

  await env.DB.prepare(`DELETE FROM agent_attach_nonces WHERE created_at < ?1`)
    .bind(opts.now - SHARED_NONCE_RETENTION_SEC)
    .run()

  const burn = await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_attach_nonces (nonce, agent_id, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(opts.nonce, opts.agentId, opts.now)
    .run()

  const changes = (burn.meta as { changes?: number }).changes ?? 0
  return changes > 0
}
