import type { Env } from '../types'

const ED25519_PUBLIC_X_RE = /^[A-Za-z0-9_-]{43}$/

function canonicalPublicX(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}=`), (ch) => ch.charCodeAt(0))
    if (bytes.byteLength !== 32) return false
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value
  } catch {
    return false
  }
}

export async function isValidEd25519PublicX(value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || !ED25519_PUBLIC_X_RE.test(value) || !canonicalPublicX(value)) return false
  try {
    await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: value, ext: true },
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return true
  } catch {
    return false
  }
}

interface AgentKeyRow {
  pubkey: string
  algo: string
  member_id: string | null
}

export type RegisterAgentKeyResult =
  | { ok: true; status: 'registered' | 'bound' | 'already_registered'; memberId: string }
  | { ok: false; reason: 'identity_unminted' | 'identity_ambiguous' | 'key_conflict' }

async function loadKey(env: Env, agentId: string): Promise<AgentKeyRow | null> {
  return env.DB.prepare(
    `SELECT pubkey, algo, member_id
       FROM agent_keys
      WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(env.TENANT_SLUG, agentId).first<AgentKeyRow>()
}

/**
 * Register a host-held agent key against the agent's unique active token identity.
 * Existing different keys are never replaced implicitly; deliberate rotation needs
 * a separate owner ceremony.
 */
export async function registerAgentPublicKey(
  env: Env,
  runtimeAgentId: string,
  identityAgentId: string,
  publicKey: string,
  now = () => Math.floor(Date.now() / 1000),
): Promise<RegisterAgentKeyResult> {
  const identities = await env.DB.prepare(
    `SELECT DISTINCT t.member_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.tenant = ?1
        AND m.tenant = ?1
        AND t.agent_id = ?2
        AND t.revoked_at IS NULL
        AND m.status = 'active'
      ORDER BY t.member_id
      LIMIT 2`,
  ).bind(env.TENANT_SLUG, identityAgentId).all<{ member_id: string }>()

  const memberIds = [...new Set((identities.results ?? []).map((row) => row.member_id))]
  if (memberIds.length === 0) return { ok: false, reason: 'identity_unminted' }
  if (memberIds.length !== 1) return { ok: false, reason: 'identity_ambiguous' }
  const memberId = memberIds[0]

  const existing = await loadKey(env, runtimeAgentId)
  if (existing) {
    if (existing.algo !== 'Ed25519' || existing.pubkey !== publicKey) {
      return { ok: false, reason: 'key_conflict' }
    }
    if (existing.member_id === memberId) {
      return { ok: true, status: 'already_registered', memberId }
    }
    if (existing.member_id !== null) return { ok: false, reason: 'key_conflict' }

    const bound = await env.DB.prepare(
      `UPDATE agent_keys
          SET member_id = ?3
        WHERE tenant = ?1 AND agent_id = ?2 AND member_id IS NULL`,
    ).bind(env.TENANT_SLUG, runtimeAgentId, memberId).run()
    if ((bound.meta?.changes ?? 0) > 0) return { ok: true, status: 'bound', memberId }

    const raced = await loadKey(env, runtimeAgentId)
    return raced?.algo === 'Ed25519' && raced.pubkey === publicKey && raced.member_id === memberId
      ? { ok: true, status: 'already_registered', memberId }
      : { ok: false, reason: 'key_conflict' }
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
     VALUES (?1, ?2, ?3, 'Ed25519', ?4, ?5)
     ON CONFLICT(tenant, agent_id) DO NOTHING`,
  ).bind(env.TENANT_SLUG, runtimeAgentId, publicKey, memberId, now()).run()
  if ((inserted.meta?.changes ?? 0) > 0) return { ok: true, status: 'registered', memberId }

  const raced = await loadKey(env, runtimeAgentId)
  return raced?.algo === 'Ed25519' && raced.pubkey === publicKey && raced.member_id === memberId
    ? { ok: true, status: 'already_registered', memberId }
    : { ok: false, reason: 'key_conflict' }
}
